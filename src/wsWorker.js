const WebSocket = require('ws');
const { HttpsProxyAgent } = require('https-proxy-agent');
const config = require('./config');
const logger = require('./logger');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const NO_PROXY = process.env.NO_PROXY === '1';

// WS Worker: pure Node.js WebSocket connection — no browser.
// Replicates the socket.js protocol exactly (JSON {channel, data}).
// Each worker uses its own sticky proxy session → unique residential IP.
class WsWorker {
  constructor(credentials, id) {
    this.credentials = credentials;  // {cookieString, userAgent, session}
    this.id = id;
    this.ws = null;
    this.channels = new Map();
    this.running = false;
    this.chatCount = 0;
    this.successCount = 0;
    this.status = 'idle'; // idle | connecting | running | banned | dead
  }

  // ── Protocol helpers (mirrors socket.js) ─────────────────────
  _emit(channel, data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ channel, data }));
    }
  }

  _register(channel, handler) {
    this.channels.set(channel, handler);
  }

  _propagate(channel, data) {
    const h = this.channels.get(channel);
    if (h) h(data);
  }

  // ── Connect via sticky proxy ──────────────────────────────────
  async _connect() {
    const { cookieString, userAgent, session } = this.credentials;
    const wsOptions = {
      headers: {
        Cookie: cookieString,
        Origin: 'https://omegleweb.io',
        'User-Agent': userAgent,
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
    };
    if (!NO_PROXY) {
      wsOptions.agent = new HttpsProxyAgent(session.url);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('WS_CONNECT_TIMEOUT')),
        30000
      );

      this.ws = new WebSocket('wss://omegleweb.io:8443/', wsOptions);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        logger.info(`[W${this.id}] WS connected (session ${session.id})`);
        this.ws.on('message', raw => {
          try {
            const { channel, data } = JSON.parse(raw.toString());
            this._propagate(channel, data);
          } catch {}
        });
        resolve();
      });

      this.ws.on('error', e => {
        clearTimeout(timeout);
        reject(new Error(`WS_ERROR: ${e.message}`));
      });

      this.ws.on('close', () => {
        if (this.status === 'running') {
          logger.warn(`[W${this.id}] WS closed unexpectedly`);
          this.status = 'dead';
          this.running = false;
        }
      });
    });
  }

  // ── Wait for a specific channel message (one-shot) ────────────
  _waitFor(channel, timeout = 60000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.channels.delete(channel);
        reject(new Error(`TIMEOUT_${channel}`));
      }, timeout);

      this._register(channel, data => {
        clearTimeout(timer);
        this.channels.delete(channel);
        resolve(data);
      });
    });
  }

  // ── Typing simulation ─────────────────────────────────────────
  _typingDuration(text) {
    return Math.min(800 + text.length * 40, 4000);
  }

  async _sendWithTyping(text) {
    const duration = this._typingDuration(text);
    this._emit('typing', true);
    await sleep(duration);
    this._emit('typing', false);
    this._emit('message', text);
    logger.info(`[W${this.id}] Sent: "${text.substring(0, 60)}"`);
  }

  // ── Main chat loop ────────────────────────────────────────────
  async _chatLoop() {
    // Permanent ban handler
    this._register('banned_ip', () => {
      logger.warn(`[W${this.id}] IP BANNED — stopping`);
      this.status = 'banned';
      this.running = false;
    });

    // Consume noisy channels
    this._register('peopleOnline', () => {});
    this._register('selfCountry', () => {});
    this._register('typing', () => {});
    this._register('peerCountry', () => {});
    this._register('peerAFK', () => {});
    this._register('peerActive', () => {});

    while (this.running) {
      this.chatCount++;
      logger.info(`[W${this.id}] Chat #${this.chatCount} — matching...`);

      // Register 'connected' handler BEFORE emitting match
      const connectedPromise = this._waitFor('connected', config.timing.matchTimeout);

      this._emit('peopleOnline');
      this._emit('match', {
        data: 'text',
        params: { interests: [], preferSameCountry: false },
      });

      try {
        await connectedPromise;
      } catch {
        if (!this.running) break;
        logger.warn(`[W${this.id}] Match timeout, retrying...`);
        continue;
      }

      if (!this.running) break;
      logger.info(`[W${this.id}] Stranger connected!`);

      // Pick random greeting + split promo (site name never complete in one message)
      const greeting = config.greetings[Math.floor(Math.random() * config.greetings.length)];
      const [part1, part2] = config.getPromoSplit();

      await this._sendWithTyping(greeting);
      await sleep(config.timing.betweenMessagesDelay);
      await this._sendWithTyping(part1);
      if (part2) {
        await sleep(config.timing.betweenMessagesDelay);
        await this._sendWithTyping(part2);
      }

      this.successCount++;
      logger.info(`[W${this.id}] Messages sent (total: ${this.successCount})`);

      await sleep(config.timing.afterMessageDelay);

      // Disconnect — chat.js auto-reconnects on server side
      this._emit('disconnect');

      // Register disconnect handler to consume it
      this._register('disconnect', () => {});

      await sleep(config.timing.betweenChatsDelay);
    }
  }

  // ── Public API ────────────────────────────────────────────────
  async start() {
    this.status = 'connecting';
    await this._connect();
    this.status = 'running';
    this.running = true;

    // Heartbeat every 30s (mirrors socket.js)
    const heartbeat = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this._emit('heartbeat', { timestamp: Date.now() });
      } else {
        clearInterval(heartbeat);
      }
    }, 30000);

    try {
      await this._chatLoop();
    } finally {
      clearInterval(heartbeat);
    }
  }

  stop() {
    this.running = false;
    this.status = 'dead';
    try { this.ws && this.ws.close(); } catch {}
  }
}

module.exports = WsWorker;
