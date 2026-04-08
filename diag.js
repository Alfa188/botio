#!/usr/bin/env node
/**
 * Diagnostic approfondi — teste CHAQUE hypothèse de manière isolée.
 * Usage: node diag.js
 */
require('dotenv').config();

const WebSocket = require('ws');
const { HttpsProxyAgent } = require('https-proxy-agent');
const http = require('http');
const CfSolver = require('./src/cf-solver');
const ProxyManager = require('./src/proxy');

const TARGET_URL = process.env.TARGET_URL || 'https://omegleweb.io';
const WS_URL = process.env.WS_URL || 'wss://omegleweb.io:8443';

function separator(title) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${'─'.repeat(60)}`);
}

async function run() {
  const pm = new ProxyManager();
  const cf = new CfSolver();

  // ═══════════════════════════════════════════
  // TEST 1: Config
  // ═══════════════════════════════════════════
  separator('TEST 1: Configuration');
  const proxy = pm.getSharedProxy();
  console.log('Proxy shared:', proxy ? proxy.url.replace(/:[^:]+@/, ':***@') : 'NULL');
  console.log('PORT env:', process.env.GEONODE_PORT);
  console.log('SESSION_TYPE env:', process.env.GEONODE_SESSION_TYPE);

  // ═══════════════════════════════════════════
  // TEST 2: Proxy IP (port .env)
  // ═══════════════════════════════════════════
  separator('TEST 2: IP via proxy port ' + pm.port);
  try {
    const ip = await testProxyIP(proxy);
    console.log('✓', ip);
  } catch (e) {
    console.log('✗', e.message);
  }

  // ═══════════════════════════════════════════
  // TEST 3: FlareSolverr
  // ═══════════════════════════════════════════
  separator('TEST 3: FlareSolverr health');
  const healthy = await cf.healthCheck();
  console.log(healthy ? '✓ OK' : '✗ DOWN');
  if (!healthy) return;

  // ═══════════════════════════════════════════
  // TEST 4: FlareSolverr DIRECT → quels cookies exactement ?
  // ═══════════════════════════════════════════
  separator('TEST 4: FlareSolverr DIRECT (IP Hetzner)');
  let directSol;
  try {
    directSol = await cf.getSolution(TARGET_URL, null);
    console.log(`Status: ${directSol.status}`);
    console.log(`Cookies (${directSol.cookies.length}):`);
    directSol.cookies.forEach(c => console.log(`  ${c.name} = ${c.value.substring(0, 40)}...`));
    console.log(`cf_clearance: ${directSol.cookies.some(c => c.name === 'cf_clearance') ? '✓ PRESENT' : '✗ ABSENT'}`);
    const title = (directSol.response || '').match(/<title>(.*?)<\/title>/)?.[1] || 'N/A';
    console.log(`Page title: "${title}"`);
    console.log(`Challenge page: ${(directSol.response || '').includes('Just a moment') ? 'OUI ✗' : 'NON ✓'}`);
  } catch (e) {
    console.log('✗ Erreur:', e.message);
  }

  // ═══════════════════════════════════════════
  // TEST 5: FlareSolverr + PROXY port .env
  // ═══════════════════════════════════════════
  separator('TEST 5: FlareSolverr + proxy (port ' + pm.port + ')');
  let proxySol;
  try {
    proxySol = await cf.getSolution(TARGET_URL, proxy);
    console.log(`Status: ${proxySol.status}`);
    console.log(`Cookies (${proxySol.cookies.length}):`);
    proxySol.cookies.forEach(c => console.log(`  ${c.name} = ${c.value.substring(0, 40)}...`));
    console.log(`cf_clearance: ${proxySol.cookies.some(c => c.name === 'cf_clearance') ? '✓ PRESENT' : '✗ ABSENT'}`);
    const title = (proxySol.response || '').match(/<title>(.*?)<\/title>/)?.[1] || 'N/A';
    console.log(`Page title: "${title}"`);
    console.log(`Challenge page: ${(proxySol.response || '').includes('Just a moment') ? 'OUI ✗' : 'NON ✓'}`);
  } catch (e) {
    console.log('✗ Erreur:', e.message);
  }

  // ═══════════════════════════════════════════
  // TEST 6: FlareSolverr + PROXY port 9000 (rotating)
  // ═══════════════════════════════════════════
  separator('TEST 6: FlareSolverr + proxy port 9000 (rotating)');
  const user9000 = `geonode_${pm.username}-type-residential`;
  const proxy9000 = {
    url: `http://${encodeURIComponent(user9000)}:${encodeURIComponent(pm.password)}@${pm.host}:9000`,
  };
  let sol9000;
  try {
    const ip9000 = await testProxyIP({ url: proxy9000.url });
    console.log('IP port 9000:', ip9000);
    sol9000 = await cf.getSolution(TARGET_URL, proxy9000);
    console.log(`Cookies (${sol9000.cookies.length}):`);
    sol9000.cookies.forEach(c => console.log(`  ${c.name} = ${c.value.substring(0, 40)}...`));
    console.log(`cf_clearance: ${sol9000.cookies.some(c => c.name === 'cf_clearance') ? '✓ PRESENT' : '✗ ABSENT'}`);
    const title = (sol9000.response || '').match(/<title>(.*?)<\/title>/)?.[1] || 'N/A';
    console.log(`Page title: "${title}"`);
  } catch (e) {
    console.log('✗ Erreur:', e.message.substring(0, 150));
  }

  // ═══════════════════════════════════════════
  // TEST 7-10: WS avec différentes combinaisons cookies+proxy
  // ═══════════════════════════════════════════
  const scenarios = [];

  if (directSol && directSol.cookies.length > 0) {
    const ch = directSol.cookies.map(c => `${c.name}=${c.value}`).join('; ');
    scenarios.push({ name: 'WS direct + cookies directs (même IP Hetzner)', cookieHeader: ch, ua: directSol.userAgent, agent: null });
    if (proxy) {
      scenarios.push({ name: 'WS via proxy + cookies directs (IP mismatch)', cookieHeader: ch, ua: directSol.userAgent, agent: new HttpsProxyAgent(proxy.url) });
    }
  }

  if (proxySol && proxySol.cookies.length > 0) {
    const ch = proxySol.cookies.map(c => `${c.name}=${c.value}`).join('; ');
    if (proxy) {
      scenarios.push({ name: 'WS via proxy + cookies proxy (même IP)', cookieHeader: ch, ua: proxySol.userAgent, agent: new HttpsProxyAgent(proxy.url) });
    }
    scenarios.push({ name: 'WS direct + cookies proxy (IP mismatch)', cookieHeader: ch, ua: proxySol.userAgent, agent: null });
  }

  if (sol9000 && sol9000.cookies.length > 0) {
    const ch = sol9000.cookies.map(c => `${c.name}=${c.value}`).join('; ');
    scenarios.push({ name: 'WS via port 9000 + cookies port 9000', cookieHeader: ch, ua: sol9000.userAgent, agent: new HttpsProxyAgent(proxy9000.url) });
  }

  // WS sans cookies (baseline)
  scenarios.push({ name: 'WS sans cookies (baseline)', cookieHeader: '', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', agent: null });

  let testN = 7;
  for (const s of scenarios) {
    separator(`TEST ${testN}: ${s.name}`);
    try {
      const opts = {
        headers: {
          'User-Agent': s.ua,
          'Origin': TARGET_URL,
          'Referer': `${TARGET_URL}/chat`,
        },
        handshakeTimeout: 15000,
        rejectUnauthorized: false,
      };
      if (s.cookieHeader) opts.headers['Cookie'] = s.cookieHeader;
      if (s.agent) opts.agent = s.agent;

      const r = await testWsConnection(WS_URL, opts);
      console.log('✓', r);
    } catch (e) {
      // Extraire le code HTTP si disponible
      const m = e.message.match(/HTTP (\d+)/);
      console.log(`✗ ${m ? 'HTTP ' + m[1] : e.message.substring(0, 120)}`);
    }
    testN++;
  }

  // ═══════════════════════════════════════════
  // RÉSUMÉ
  // ═══════════════════════════════════════════
  separator('RÉSUMÉ');
  console.log(`
  Scénarios possibles:

  A) cf_clearance manquant dans les cookies
     → Regarder TEST 4/5/6: est-ce que cf_clearance est PRESENT ?

  B) IP mismatch (cookies liés à une IP, WS depuis autre IP)
     → Comparer les tests WS "même IP" vs "IP mismatch"

  C) TLS fingerprint Node.js ≠ Chrome (JA3 hash)
     → Si TEST "même IP + mêmes cookies" échoue aussi = TLS issue
     → Solution: utiliser un vrai browser (Puppeteer WS)

  D) Proxy bloque le tunnel CONNECT vers port 8443
     → Si port 9000 fonctionne mais pas port 10000 = port issue

  E) omegleweb.io bloque TOUT WS non-browser
     → Si AUCUN test ne passe = besoin d'un vrai browser

  F) FlareSolverr ne résout pas CF via proxy
     → 0 cookies = CF challenge non résolu via proxy
  `);
}

function testProxyIP(proxy) {
  return new Promise((resolve, reject) => {
    const url = new URL(proxy.url);
    const req = http.get({
      host: url.hostname, port: url.port,
      path: 'http://ip-api.com/json',
      headers: {
        'Proxy-Authorization': 'Basic ' + Buffer.from(
          `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`
        ).toString('base64'),
      },
      timeout: 15000,
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          resolve(`${j.query} (${j.country}, ${j.city}, ${j.isp})`);
        } catch { resolve(d.substring(0, 80)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function testWsConnection(url, options) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    const tm = setTimeout(() => { ws.terminate(); reject(new Error('timeout 15s')); }, 15000);
    ws.on('open', () => {
      clearTimeout(tm);
      const msgs = [];
      ws.on('message', (raw) => {
        msgs.push(raw.toString().substring(0, 80));
        if (msgs.length >= 3) { ws.close(); resolve('OPEN + ' + msgs.join(' | ')); }
      });
      setTimeout(() => { ws.close(); resolve('OPEN' + (msgs.length ? ' + ' + msgs.join(' | ') : '')); }, 3000);
    });
    ws.on('error', (err) => { clearTimeout(tm); reject(err); });
    ws.on('unexpected-response', (req, res) => {
      clearTimeout(tm);
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${body.substring(0, 120)}`)));
    });
  });
}

run().catch(e => console.error('FATAL:', e));
