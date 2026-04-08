#!/usr/bin/env node
/**
 * Diagnostic script — teste chaque étape de la chaîne de connexion.
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

async function run() {
  const pm = new ProxyManager();
  const cf = new CfSolver();

  console.log('\n=== ÉTAPE 1: Config proxy ===');
  const proxy = pm.getSharedProxy();
  if (!proxy) {
    console.log('❌ Proxy NON configuré (GEONODE_USERNAME/PASSWORD manquants)');
    return;
  }
  console.log(`✓ Proxy URL: ${proxy.url.replace(/:[^:]+@/, ':***@')}`);
  console.log(`  Host: ${proxy.host}:${proxy.port}`);
  console.log(`  User: ${proxy.username}`);
  console.log(`  Session: ${proxy.sessionId}`);

  console.log('\n=== ÉTAPE 2: Test proxy (IP check) ===');
  try {
    const ip = await testProxyIP(proxy);
    console.log(`✓ IP via proxy: ${ip}`);
  } catch (e) {
    console.log(`❌ Proxy inaccessible: ${e.message}`);
    return;
  }

  console.log('\n=== ÉTAPE 3: FlareSolverr health ===');
  const healthy = await cf.healthCheck();
  console.log(healthy ? '✓ FlareSolverr OK' : '❌ FlareSolverr inaccessible');
  if (!healthy) return;

  console.log('\n=== ÉTAPE 4: FlareSolverr + proxy → cookies CF ===');
  let cookies, userAgent;
  try {
    const solution = await cf.getSolution(TARGET_URL, proxy);
    cookies = solution.cookies;
    userAgent = solution.userAgent;
    console.log(`✓ ${cookies.length} cookies obtenus`);
    cookies.forEach(c => console.log(`  ${c.name} = ${c.value.substring(0, 30)}...`));
    console.log(`  UA: ${userAgent.substring(0, 60)}...`);
  } catch (e) {
    console.log(`❌ FlareSolverr erreur: ${e.message}`);
    return;
  }

  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const hasCfClearance = cookies.some(c => c.name === 'cf_clearance');
  console.log(`  cf_clearance présent: ${hasCfClearance ? '✓' : '❌ MANQUANT'}`);

  console.log('\n=== ÉTAPE 5: Connexion WS via proxy ===');
  try {
    const agent = new HttpsProxyAgent(proxy.url);
    const result = await testWsConnection(WS_URL, {
      headers: {
        'Cookie': cookieHeader,
        'User-Agent': userAgent,
        'Origin': TARGET_URL,
        'Referer': `${TARGET_URL}/chat`,
      },
      agent,
      handshakeTimeout: 15000,
      rejectUnauthorized: false,
    });
    console.log(`✓ WS connecté ! Réponse: ${result}`);
  } catch (e) {
    console.log(`❌ WS échoué: ${e.message}`);

    // Test sans proxy pour comparer
    console.log('\n=== ÉTAPE 5b: Connexion WS SANS proxy (comparaison) ===');
    try {
      const result = await testWsConnection(WS_URL, {
        headers: {
          'Cookie': cookieHeader,
          'User-Agent': userAgent,
          'Origin': TARGET_URL,
          'Referer': `${TARGET_URL}/chat`,
        },
        handshakeTimeout: 15000,
        rejectUnauthorized: false,
      });
      console.log(`✓ WS sans proxy connecté: ${result}`);
      console.log('  → Le proxy bloque le WS tunnel sur port 8443');
    } catch (e2) {
      console.log(`❌ WS sans proxy aussi échoué: ${e2.message}`);
      console.log('  → Problème de cookies ou IP CF');
    }

    // Test FlareSolverr SANS proxy pour comparer
    console.log('\n=== ÉTAPE 5c: FlareSolverr SANS proxy (comparaison) ===');
    try {
      const solution2 = await cf.getSolution(TARGET_URL, null);
      const cookies2 = solution2.cookies;
      const cookieHeader2 = cookies2.map(c => `${c.name}=${c.value}`).join('; ');
      console.log(`  ${cookies2.length} cookies sans proxy`);

      const result2 = await testWsConnection(WS_URL, {
        headers: {
          'Cookie': cookieHeader2,
          'User-Agent': solution2.userAgent,
          'Origin': TARGET_URL,
          'Referer': `${TARGET_URL}/chat`,
        },
        handshakeTimeout: 15000,
        rejectUnauthorized: false,
      });
      console.log(`✓ WS direct (sans proxy) connecté: ${result2}`);
      console.log('  → IP Hetzner directe FONCTIONNE — le proxy est le problème');
    } catch (e3) {
      console.log(`❌ WS direct aussi échoué: ${e3.message}`);
      console.log('  → CF bloque toutes les connexions WS depuis un datacenter');
    }
  }

  console.log('\n=== DIAGNOSTIC TERMINÉ ===\n');
}

function testProxyIP(proxy) {
  return new Promise((resolve, reject) => {
    const proxyUrl = new URL(proxy.url);
    const reqOptions = {
      host: proxyUrl.hostname,
      port: proxyUrl.port,
      path: 'http://ip-api.com/json',
      headers: {
        'Proxy-Authorization': 'Basic ' + Buffer.from(
          `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`
        ).toString('base64'),
      },
      timeout: 15000,
    };

    const req = http.get(reqOptions, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(`${json.query} (${json.country}, ${json.city}, ISP: ${json.isp})`);
        } catch {
          resolve(data.substring(0, 100));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Proxy timeout')); });
  });
}

function testWsConnection(url, options) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error('WS timeout (15s)'));
    }, 15000);

    ws.on('open', () => {
      clearTimeout(timeout);
      resolve('WebSocket OPEN');
      // Écouter brièvement pour un message
      ws.on('message', (raw) => {
        console.log(`  WS msg reçu: ${raw.toString().substring(0, 100)}`);
      });
      setTimeout(() => ws.close(), 3000);
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    ws.on('unexpected-response', (req, res) => {
      clearTimeout(timeout);
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        reject(new Error(`HTTP ${res.statusCode}: ${body.substring(0, 200)}`));
      });
    });
  });
}

run().catch(e => console.error('FATAL:', e));
