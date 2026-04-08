#!/usr/bin/env node
/**
 * Diagnostic ciblé — teste les hypothèses restantes :
 *   1. WS via proxy résidentiel SANS cookies
 *   2. WS port 443 au lieu de 8443
 *   3. WS avec ciphers Chrome (TLS fingerprint)
 *   4. WS via proxy + ciphers Chrome
 */
require('dotenv').config();

const WebSocket = require('ws');
const { HttpsProxyAgent } = require('https-proxy-agent');
const https = require('https');
const http = require('http');
const tls = require('tls');
const CfSolver = require('./src/cf-solver');
const ProxyManager = require('./src/proxy');

const TARGET_URL = process.env.TARGET_URL || 'https://omegleweb.io';
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Chrome 131 cipher suites (JA3 fingerprint match)
const CHROME_CIPHERS = [
  'TLS_AES_128_GCM_SHA256',
  'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256',
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-CHACHA20-POLY1305',
  'ECDHE-RSA-CHACHA20-POLY1305',
  'ECDHE-RSA-AES128-SHA',
  'ECDHE-RSA-AES256-SHA',
  'AES128-GCM-SHA256',
  'AES256-GCM-SHA384',
  'AES128-SHA',
  'AES256-SHA',
].join(':');

function separator(title) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${'═'.repeat(60)}`);
}

async function run() {
  const pm = new ProxyManager();
  const cf = new CfSolver();
  const proxy = pm.getSharedProxy();

  console.log('Proxy:', proxy ? proxy.url.replace(/:[^:]+@/, ':***@') : 'NULL');

  // Get direct cookies for reference
  separator('PREP: FlareSolverr direct → cookies');
  let directCookieHeader = '', directUA = CHROME_UA;
  try {
    const sol = await cf.getSolution(TARGET_URL, null);
    directCookieHeader = sol.cookies.map(c => `${c.name}=${c.value}`).join('; ');
    directUA = sol.userAgent;
    console.log(`${sol.cookies.length} cookies, cf_clearance: ${sol.cookies.some(c => c.name === 'cf_clearance') ? '✓' : '✗'}`);
  } catch (e) {
    console.log('Erreur:', e.message);
  }

  // ═══════════════════════════════════════════
  // TEST A: WS via proxy SANS cookies (résidentiel = pas de CF challenge)
  // ═══════════════════════════════════════════
  separator('TEST A: WS via proxy + SANS cookies');
  if (proxy) {
    try {
      const r = await testWs('wss://omegleweb.io:8443', {
        headers: { 'User-Agent': CHROME_UA, 'Origin': TARGET_URL, 'Referer': `${TARGET_URL}/chat` },
        agent: new HttpsProxyAgent(proxy.url),
      });
      console.log('✓', r);
    } catch (e) {
      console.log('✗', extractErr(e));
    }
  }

  // ═══════════════════════════════════════════
  // TEST B: WS via proxy + SANS cookies + port 443
  // ═══════════════════════════════════════════
  separator('TEST B: WS via proxy + port 443 (wss://omegleweb.io/)');
  if (proxy) {
    try {
      const r = await testWs('wss://omegleweb.io/', {
        headers: { 'User-Agent': CHROME_UA, 'Origin': TARGET_URL, 'Referer': `${TARGET_URL}/chat` },
        agent: new HttpsProxyAgent(proxy.url),
      });
      console.log('✓', r);
    } catch (e) {
      console.log('✗', extractErr(e));
    }
  }

  // ═══════════════════════════════════════════
  // TEST C: WS via proxy + SANS cookies + /ws path
  // ═══════════════════════════════════════════
  separator('TEST C: WS via proxy + wss://omegleweb.io/ws');
  if (proxy) {
    try {
      const r = await testWs('wss://omegleweb.io/ws', {
        headers: { 'User-Agent': CHROME_UA, 'Origin': TARGET_URL, 'Referer': `${TARGET_URL}/chat` },
        agent: new HttpsProxyAgent(proxy.url),
      });
      console.log('✓', r);
    } catch (e) {
      console.log('✗', extractErr(e));
    }
  }

  // ═══════════════════════════════════════════
  // TEST D: WS DIRECT + cookies + Chrome ciphers
  // ═══════════════════════════════════════════
  separator('TEST D: WS direct + cookies + Chrome TLS ciphers');
  if (directCookieHeader) {
    try {
      const agent = new https.Agent({
        ciphers: CHROME_CIPHERS,
        honorCipherOrder: false,
        minVersion: 'TLSv1.2',
        maxVersion: 'TLSv1.3',
        rejectUnauthorized: false,
      });
      const r = await testWs('wss://omegleweb.io:8443', {
        headers: { 'Cookie': directCookieHeader, 'User-Agent': directUA, 'Origin': TARGET_URL, 'Referer': `${TARGET_URL}/chat` },
        agent,
      });
      console.log('✓', r);
    } catch (e) {
      console.log('✗', extractErr(e));
    }
  }

  // ═══════════════════════════════════════════
  // TEST E: WS via proxy + Chrome ciphers + sans cookies
  // ═══════════════════════════════════════════
  separator('TEST E: WS via proxy + Chrome ciphers + sans cookies');
  if (proxy) {
    try {
      // HttpsProxyAgent with custom TLS options
      const agent = new HttpsProxyAgent(proxy.url, {
        ciphers: CHROME_CIPHERS,
        honorCipherOrder: false,
        minVersion: 'TLSv1.2',
        rejectUnauthorized: false,
      });
      const r = await testWs('wss://omegleweb.io:8443', {
        headers: { 'User-Agent': CHROME_UA, 'Origin': TARGET_URL, 'Referer': `${TARGET_URL}/chat` },
        agent,
      });
      console.log('✓', r);
    } catch (e) {
      console.log('✗', extractErr(e));
    }
  }

  // ═══════════════════════════════════════════
  // TEST F: WS via proxy + cookies + Chrome ciphers (tout combiné)
  // ═══════════════════════════════════════════
  separator('TEST F: WS via proxy + cookies directs + Chrome ciphers');
  if (proxy && directCookieHeader) {
    try {
      const agent = new HttpsProxyAgent(proxy.url, {
        ciphers: CHROME_CIPHERS,
        honorCipherOrder: false,
        minVersion: 'TLSv1.2',
        rejectUnauthorized: false,
      });
      const r = await testWs('wss://omegleweb.io:8443', {
        headers: { 'Cookie': directCookieHeader, 'User-Agent': directUA, 'Origin': TARGET_URL, 'Referer': `${TARGET_URL}/chat` },
        agent,
      });
      console.log('✓', r);
    } catch (e) {
      console.log('✗', extractErr(e));
    }
  }

  // ═══════════════════════════════════════════
  // TEST G: HTTPS request direct au port 8443 (pas WS, juste HTTP GET)
  // ═══════════════════════════════════════════
  separator('TEST G: HTTPS GET (pas WS) au port 8443');
  try {
    const r = await httpGet('https://omegleweb.io:8443/', {
      'User-Agent': CHROME_UA,
      'Cookie': directCookieHeader,
    });
    console.log('HTTP', r.status, '- body:', r.body.substring(0, 100));
  } catch (e) {
    console.log('✗', e.message);
  }

  // ═══════════════════════════════════════════
  // TEST H: HTTPS GET port 8443 via proxy
  // ═══════════════════════════════════════════
  separator('TEST H: HTTPS GET port 8443 via proxy');
  if (proxy) {
    try {
      const agent = new HttpsProxyAgent(proxy.url);
      const r = await httpGet('https://omegleweb.io:8443/', {
        'User-Agent': CHROME_UA,
      }, agent);
      console.log('HTTP', r.status, '- body:', r.body.substring(0, 100));
    } catch (e) {
      console.log('✗', e.message);
    }
  }

  // ═══════════════════════════════════════════
  // TEST I: curl-style — vérifier si le port 8443 est réellement ouvert
  // ═══════════════════════════════════════════
  separator('TEST I: TCP connection au port 8443');
  try {
    const r = await tcpTest('omegleweb.io', 8443);
    console.log('✓ TCP port 8443 accessible -', r);
  } catch (e) {
    console.log('✗', e.message);
  }

  // ═══════════════════════════════════════════
  separator('RÉSUMÉ');
  console.log(`
  Si TEST A ✓ → simple: pas besoin de cf_clearance via proxy résidentiel
  Si TEST B/C ✓ → WS sur port 443 au lieu de 8443
  Si TEST D ✓ → Chrome ciphers suffisent, pas besoin de proxy
  Si TEST E/F ✓ → Chrome ciphers + proxy = solution
  Si TEST G/H → 200 = port 8443 accessible en HTTP, 403 = CF bloque
  Si TOUT ✗ → Besoin de Puppeteer pour le WS (vrai browser)
  `);
}

function testWs(url, options) {
  return new Promise((resolve, reject) => {
    options.handshakeTimeout = 15000;
    if (!options.rejectUnauthorized) options.rejectUnauthorized = false;
    const ws = new WebSocket(url, options);
    const tm = setTimeout(() => { ws.terminate(); reject(new Error('timeout 15s')); }, 15000);
    ws.on('open', () => {
      clearTimeout(tm);
      const msgs = [];
      ws.on('message', (raw) => {
        msgs.push(raw.toString().substring(0, 60));
        if (msgs.length >= 2) { ws.close(); resolve('OPEN + ' + msgs.join(' | ')); }
      });
      setTimeout(() => { ws.close(); resolve('OPEN' + (msgs.length ? ' + ' + msgs.join(' | ') : '')); }, 3000);
    });
    ws.on('error', (err) => { clearTimeout(tm); reject(err); });
    ws.on('unexpected-response', (req, res) => {
      clearTimeout(tm);
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => reject(new Error(`HTTP ${res.statusCode}`)));
    });
  });
}

function httpGet(url, headers, agent) {
  return new Promise((resolve, reject) => {
    const opts = { headers, timeout: 15000, rejectUnauthorized: false };
    if (agent) opts.agent = agent;
    const req = https.get(url, opts, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function tcpTest(host, port) {
  return new Promise((resolve, reject) => {
    const net = require('net');
    const sock = net.connect(port, host, () => {
      resolve(`connected in ${Date.now() - start}ms`);
      sock.destroy();
    });
    const start = Date.now();
    sock.setTimeout(10000);
    sock.on('error', reject);
    sock.on('timeout', () => { sock.destroy(); reject(new Error('TCP timeout')); });
  });
}

function extractErr(e) {
  const m = e.message.match(/HTTP (\d+)/);
  return m ? `HTTP ${m[1]}` : e.message.substring(0, 100);
}

run().catch(e => console.error('FATAL:', e));
