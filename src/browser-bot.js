/**
 * BrowserBot — Bot Puppeteer pour omegleweb.io
 *
 * Utilise un vrai navigateur Chrome (Puppeteer + stealth plugin) pour contourner
 * le fingerprinting TLS/JA3 de Cloudflare qui bloque toutes les connexions
 * WebSocket non-browser sur le port 8443.
 *
 * Approche :
 *   1. Puppeteer stealth + proxy résidentiel Geonode
 *   2. Navigation vers /chat → CF se résout automatiquement (vrai browser)
 *   3. Monkey-patch WebSocket pour intercepter les messages côté Node.js
 *   4. Bot logic : greeting → 8s → promo → 1.5s → skip → loop
 *
 * Chaque instance lance son propre Chrome avec une session proxy unique
 * (= IP résidentielle différente par bot).
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const logger = require('./logger');
const ProxyManager = require('./proxy');
const { GREETINGS, PROMO_MESSAGES, pickRandom } = require('./messages');

class BrowserBot {
  constructor(config = {}, sharedMatchIds = null, botIndex = 0) {
    this.config = {
      targetUrl: config.targetUrl || process.env.TARGET_URL || 'https://omegleweb.io',
      maxConversations: parseInt(config.maxConversations) || 50,
    };

    this.proxyManager = new ProxyManager();
    this._sharedMatchIds = sharedMatchIds || new Set();
    this._botIndex = botIndex;
    this._tag = `[Bot#${botIndex + 1}]`;

    this.browser = null;
    this.page = null;
    this.running = false;
    this.isMatched = false;
    this.wsReady = false;
    this.conversationCount = 0;
    this._currentMatchId = null;

    // Promise resolvers for async flow control
    this._matchResolve = null;
    this._disconnectResolve = null;

    this.stats = {
      totalConversations: 0,
      totalMessagesSent: 0,
      totalPromosDelivered: 0,
      totalChallenges: 0,
      startTime: null,
    };
  }

  // ─────────────────────────────────────────────
  // MAIN LOOP
  // ─────────────────────────────────────────────

  async run() {
    this.running = true;
    this.stats.startTime = Date.now();
    this._log('info', 'Démarrage...');

    try {
      await this._launch();
      await this._navigate();

      // After "I Agree", the page auto-sends match → first round just waits
      let firstRound = true;

      while (this.running && this.conversationCount < this.config.maxConversations) {
        if (!firstRound) {
          await this._nextStranger();
        }
        firstRound = false;

        const matched = await this._waitForMatch(90000);
        if (!matched) {
          if (!this.running) break;
          this._log('warn', 'Match timeout — retry...');
          continue;
        }

        await this._runConversation();
        await this._delay(2000 + Math.random() * 2000);
      }
    } catch (err) {
      this._log('error', `Erreur fatale: ${err.message}`);
    } finally {
      await this._cleanup();
      this._printStats();
    }
  }

  stop() {
    this._log('info', 'Arrêt...');
    this.running = false;
    if (this._matchResolve) this._matchResolve(false);
    if (this._disconnectResolve) this._disconnectResolve();
  }

  // ─────────────────────────────────────────────
  // BROWSER SETUP
  // ─────────────────────────────────────────────

  async _launch() {
    const proxy = this.proxyManager.getProxy();
    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--window-size=1280,800',
    ];

    if (proxy) {
      launchArgs.push(`--proxy-server=http://${proxy.host}:${proxy.port}`);
      this._log('info', `Proxy: ${proxy.host}:${proxy.port} [session: ${proxy.sessionId}]`);
    }

    this.browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: launchArgs,
      defaultViewport: { width: 1280, height: 800 },
    });

    this.page = await this.browser.newPage();

    // Proxy authentication
    if (proxy) {
      await this.page.authenticate({
        username: proxy.username,
        password: proxy.password,
      });
    }

    await this.page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );

    // Auto-dismiss dialogs
    this.page.on('dialog', async (d) => {
      try { await d.accept(); } catch {}
    });

    // Inject WS interceptor BEFORE page loads
    await this._setupWsInterceptor();

    this._log('info', 'Chrome lancé ✓');
  }

  async _setupWsInterceptor() {
    // Expose Node.js callbacks to the page (persists across navigations)
    await this.page.exposeFunction('__onWsOpen', (url) => {
      this._log('info', `WS ouvert → ${url}`);
      this.wsReady = true;
    });

    await this.page.exposeFunction('__onWsMsg', (raw) => {
      this._handleWsMessage(raw);
    });

    await this.page.exposeFunction('__onWsClose', (code) => {
      this._log('warn', `WS fermé (code: ${code})`);
      this.wsReady = false;
    });

    // Monkey-patch WebSocket constructor before page JS runs
    await this.page.evaluateOnNewDocument(() => {
      const _WS = window.WebSocket;
      window.__ws = null;

      window.WebSocket = function (url, protocols) {
        const ws = protocols ? new _WS(url, protocols) : new _WS(url);
        window.__ws = ws;

        ws.addEventListener('open', () => window.__onWsOpen(url));
        ws.addEventListener('message', (e) => window.__onWsMsg(e.data));
        ws.addEventListener('close', (e) => window.__onWsClose(e.code));

        return ws;
      };

      // Preserve WebSocket API surface so page JS works normally
      window.WebSocket.prototype = _WS.prototype;
      window.WebSocket.CONNECTING = 0;
      window.WebSocket.OPEN = 1;
      window.WebSocket.CLOSING = 2;
      window.WebSocket.CLOSED = 3;
    });
  }

  async _navigate() {
    const chatUrl = `${this.config.targetUrl}/chat`;
    this._log('info', `Navigation → ${chatUrl}`);

    await this.page.goto(chatUrl, { waitUntil: 'load', timeout: 60000 });

    // Wait for Cloudflare challenge to auto-resolve (real browser handles it)
    this._log('info', 'Résolution CF...');
    let cfResolved = false;
    for (let i = 0; i < 45; i++) {
      await this._delay(2000);
      const title = await this.page.title().catch(() => '');
      if (
        title &&
        !title.includes('moment') &&
        !title.includes('Just a moment') &&
        !title.includes('Attention')
      ) {
        this._log('info', `CF résolu ✓ (${(i + 1) * 2}s) — page: "${title}"`);
        cfResolved = true;
        break;
      }
    }
    if (!cfResolved) throw new Error('CF challenge timeout (90s)');

    // Let the page fully initialize
    await this._delay(3000);

    // Click "I Agree" to trigger initializeConnection() → WS creation + match
    try {
      await this.page.waitForSelector('#agree-btn', { timeout: 15000 });
      await this.page.click('#agree-btn');
      this._log('info', '"I Agree" cliqué ✓');
    } catch {
      this._log('warn', '#agree-btn introuvable — chat peut-être déjà actif');
    }

    // Wait for the WS to open (page's chat.js creates it after I Agree)
    for (let i = 0; i < 30; i++) {
      if (this.wsReady) break;
      await this._delay(1000);
    }
    if (!this.wsReady) throw new Error('WebSocket jamais ouvert après 30s');

    this._log('info', 'Chat prêt ✓');
  }

  // ─────────────────────────────────────────────
  // WS MESSAGE HANDLING
  // ─────────────────────────────────────────────

  _handleWsMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    const { channel, data } = msg;

    switch (channel) {
      case 'connected':
        this._onConnected(data);
        break;
      case 'match':
        this._onMatch(data);
        break;
      case 'message':
        this._onMessage(data);
        break;
      case 'disconnect':
        this._onPeerDisconnect();
        break;
      case 'requireTurnstile':
      case 'challenge':
        this._onChallenge();
        break;
      case 'banned_ip':
        this._log('error', 'IP bannie !');
        this.running = false;
        if (this._matchResolve) {
          this._matchResolve(false);
          this._matchResolve = null;
        }
        break;
      case 'peerCountry':
        if (data) this._log('info', `Pays: ${data.countryName || data.country || '?'}`);
        break;
      case 'peopleOnline':
        if (data && data.count) this._log('debug', `En ligne: ${data.count}`);
        break;
      // Silently ignore: heartbeat, typing, peerAFK, peerActive, selfCountry
    }
  }

  _onConnected(data) {
    if (this.isMatched) return;

    const matchId = data && (data.matchId || data.match_id || data.id);
    if (matchId) {
      if (this._sharedMatchIds.has(matchId)) {
        this._log('warn', 'Auto-match bot-à-bot détecté — skip');
        this._wsEmit('disconnect');
        return;
      }
      this._sharedMatchIds.add(matchId);
      this._currentMatchId = matchId;
    }

    this.isMatched = true;
    this.conversationCount++;
    this.stats.totalConversations++;
    this._log('info', `=== Conversation #${this.conversationCount} ===`);

    if (this._matchResolve) {
      this._matchResolve(true);
      this._matchResolve = null;
    }
  }

  _onMatch(data) {
    if (data && (data.status === 'WAITING' || data.waiting)) return;
    if (data && (data.matched || data.connected || data.connectedToStranger)) {
      this._onConnected(data);
    }
  }

  _onMessage(data) {
    if (!this.isMatched) return;
    const text = typeof data === 'string' ? data : (data && data.message) || '';
    if (!text) return;

    this._log('info', `Stranger: ${text}`);

    // Bot-to-bot detection
    if (text.toLowerCase().includes('omefree.com')) {
      this._log('info', 'Bot détecté — skip');
      this.isMatched = false;
      this._cleanupMatchId();
      this._wsEmit('disconnect');
      if (this._disconnectResolve) {
        this._disconnectResolve();
        this._disconnectResolve = null;
      }
    }
  }

  _onPeerDisconnect() {
    if (!this.isMatched) return;
    this._log('info', 'Stranger déconnecté');
    this.isMatched = false;
    this._cleanupMatchId();
    if (this._disconnectResolve) {
      this._disconnectResolve();
      this._disconnectResolve = null;
    }
  }

  _onChallenge() {
    this.stats.totalChallenges++;
    this._log('warn', `Challenge CF #${this.stats.totalChallenges} — browser tentera de résoudre`);
    // Real browser + stealth plugin should handle Turnstile automatically
  }

  // ─────────────────────────────────────────────
  // CONVERSATION FLOW
  // ─────────────────────────────────────────────

  _waitForMatch(timeoutMs = 90000) {
    if (this.isMatched) return Promise.resolve(true);
    return new Promise((resolve) => {
      this._matchResolve = resolve;
      const timer = setTimeout(() => {
        if (this._matchResolve === resolve) {
          this._matchResolve = null;
          resolve(false);
        }
      }, timeoutMs);

      // Guard: if already matched by the time the promise executor runs
      if (this.isMatched) {
        clearTimeout(timer);
        this._matchResolve = null;
        resolve(true);
      }
    });
  }

  async _runConversation() {
    const disconnectPromise = new Promise((resolve) => {
      this._disconnectResolve = resolve;
    });

    await Promise.race([this._conversationFlow(), disconnectPromise]);
    this._disconnectResolve = null;
  }

  async _conversationFlow() {
    if (!this.isMatched) return;

    // 1. Small delay then greeting
    await this._delay(1500 + Math.random() * 1500);
    if (!this.isMatched) return;

    await this._sendMessage(pickRandom(GREETINGS));

    // 2. Wait 8 seconds
    await this._delay(8000);
    if (!this.isMatched) return;

    // 3. Promo
    await this._sendMessage(pickRandom(PROMO_MESSAGES));
    this.stats.totalPromosDelivered++;

    // 4. Wait 1.5s then disconnect
    await this._delay(1500);
    if (!this.isMatched) return;

    this._log('info', 'Promo envoyée ✓ — skip');
    this.isMatched = false;
    this._cleanupMatchId();
    await this._wsEmit('disconnect');
  }

  async _nextStranger() {
    this.isMatched = false;
    this._cleanupMatchId();

    // Try clicking skip button (keeps page state consistent)
    const clicked = await this.page.evaluate(() => {
      const skip = document.querySelector('#skip-btn');
      if (skip) {
        skip.click();
        return 'skip';
      }
      // Fallback: any button with relevant text
      const btns = document.querySelectorAll('button');
      for (const btn of btns) {
        const t = (btn.textContent || '').toLowerCase();
        if (t.includes('new') || t.includes('next') || t.includes('start') || t.includes('chat again')) {
          btn.click();
          return t.trim();
        }
      }
      return null;
    }).catch(() => null);

    if (clicked) {
      this._log('debug', `Bouton cliqué: ${clicked}`);
      await this._delay(500);
      return;
    }

    // Fallback: direct WS commands
    this._log('debug', 'Skip via WS (pas de bouton)');
    await this._wsEmit('disconnect');
    await this._delay(300);
    await this._wsEmit('match', {
      data: 'text',
      params: { interests: [], preferSameCountry: false },
    });
  }

  async _sendMessage(text) {
    if (!this.isMatched || !this.wsReady) return;

    // Simulate typing delay
    const typingDelay = Math.min(4000, 800 + text.length * 40);
    await this._wsEmit('typing', true);
    await this._delay(typingDelay);

    if (!this.isMatched || !this.wsReady) return;

    this._log('info', `Bot: ${text}`);
    await this._wsEmit('message', text);
    this.stats.totalMessagesSent++;

    await this._delay(200);
    await this._wsEmit('typing', false);
  }

  async _wsEmit(channel, data) {
    try {
      await this.page.evaluate(
        (ch, d) => {
          if (window.__ws && window.__ws.readyState === 1) {
            window.__ws.send(JSON.stringify({ channel: ch, data: d }));
          }
        },
        channel,
        data === undefined ? null : data
      );
    } catch (err) {
      this._log('error', `WS emit error: ${err.message}`);
    }
  }

  // ─────────────────────────────────────────────
  // UTILITIES
  // ─────────────────────────────────────────────

  _cleanupMatchId() {
    if (this._currentMatchId) {
      this._sharedMatchIds.delete(this._currentMatchId);
      this._currentMatchId = null;
    }
  }

  async _cleanup() {
    try {
      if (this.browser) await this.browser.close();
    } catch {}
    this.browser = null;
    this.page = null;
  }

  _printStats() {
    const elapsed = Math.round((Date.now() - (this.stats.startTime || Date.now())) / 1000);
    this._log('info', `=== STATS === ${elapsed}s | Conv: ${this.stats.totalConversations} | Promos: ${this.stats.totalPromosDelivered} | Msgs: ${this.stats.totalMessagesSent} | Challenges: ${this.stats.totalChallenges}`);
  }

  _log(level, msg) {
    logger[level](`${this._tag} ${msg}`);
  }

  _delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
}

module.exports = BrowserBot;
