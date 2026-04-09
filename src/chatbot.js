const config = require('./config');
const logger = require('./logger');
const BrowserManager = require('./browser');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class ChatBot {
  constructor() {
    this.bm = new BrowserManager();
    this.page = null;
    this.chatCount = 0;
    this.successCount = 0;
    this.running = false;
  }

  // ──────────────────────────────────────────────
  // STEP 1: Navigate to /chat + Cloudflare bypass
  // ──────────────────────────────────────────────
  async initPage() {
    logger.info('Navigating to /chat ...');

    // Set sessionStorage BEFORE page scripts run.
    // chat.js configureChat() checks sessionStorage('userAgreement') === 'true'
    // and redirects to '/' if not set. This prevents that redirect.
    await this.page.evaluateOnNewDocument(() => {
      sessionStorage.setItem('userAgreement', 'true');
    });

    // Non-blocking goto — CF challenge may stall load event
    this.page.goto(config.target.url + '/chat?interests=', {
      timeout: 120000,
      waitUntil: 'domcontentloaded',
    }).catch(() => {});

    for (let i = 1; i <= config.timing.cfMaxAttempts; i++) {
      await sleep(config.timing.cfPollInterval);

      let title = '';
      try { title = await this.page.title(); } catch (e) { continue; }

      // 502 = backend down
      if (title.includes('502') || title.includes('Bad Gateway')) {
        throw new Error('SERVER_502');
      }

      // CF cleared when title no longer contains CF challenge text
      const isCF = title.includes('moment') || title.includes('Just') ||
                    title.includes('Checking') || title.length === 0;
      if (!isCF) {
        logger.info(`CF bypassed on attempt ${i}: "${title}"`);
        return;
      }

      logger.info(`CF attempt ${i}/${config.timing.cfMaxAttempts}: "${title}"`);

      // Click Turnstile challenge frame
      try {
        for (const f of this.page.frames()) {
          const url = f.url();
          if (url.includes('challenges.cloudflare.com') || url.includes('turnstile')) {
            await Promise.race([f.click('body'), sleep(5000)]);
            break;
          }
        }
      } catch (e) {
        logger.warn('CF click error: ' + e.message);
      }
    }
    throw new Error('Cloudflare bypass failed after ' + config.timing.cfMaxAttempts + ' attempts');
  }

  // ──────────────────────────────────────────────────────────
  // STEP 2: Wait for DOM to be ready (chat.js loaded).
  //   WS is created at page load and connects async (~4s).
  //   configureChat() registers agree-btn listener after WS opens.
  //   clickAgreeAndMatch() handles WS timing via retry loop.
  // ──────────────────────────────────────────────────────────
  async waitForReady() {
    logger.info('Waiting for #agree-btn...');
    try {
      await this.page.waitForSelector('#agree-btn', { timeout: 30000 });
      logger.info('#agree-btn found. Waiting 2s for JS init...');
      await sleep(2000);
    } catch (e) {
      throw new Error('Chat page timeout — #agree-btn never appeared');
    }
  }

  // ──────────────────────────────────────────────────────
  // STEP 3: Click "I Agree" → start match.
  // Due to a race condition (event listener registered async),
  // the first click may be a no-op. Retry until #messages
  // changes from initial "Welcome" state to "Looking..." or
  // any active matching state.
  // ──────────────────────────────────────────────────────
  async clickAgreeAndMatch() {
    const MAX_CLICKS = 8;
    for (let i = 1; i <= MAX_CLICKS; i++) {
      logger.info(`Clicking agree (attempt ${i})...`);
      try { await this.page.click('#agree-btn'); } catch (e) { /* button might be hidden */ }

      // Wait up to 8s for messages to leave the initial welcome state
      const triggered = await this._waitForMatchStart(8000);
      if (triggered) {
        logger.info('Match initiated on attempt ' + i);
        return;
      }
      logger.warn('Agree click had no effect, retrying in 2s...');
      await sleep(2000);
    }
    throw new Error('AGREE_FAILED — match never initiated after ' + MAX_CLICKS + ' clicks');
  }

  // Check if #messages has left the initial welcome state
  async _waitForMatchStart(timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const changed = await Promise.race([
          this.page.evaluate(() => {
            const msgs = document.querySelector('#messages');
            if (!msgs) return false;
            const html = msgs.innerHTML;
            // Initial welcome state contains "starMsg" div
            // Once initializeConnection() runs, it replaces innerHTML with "Looking..."
            return !html.includes('starMsg') && html.length > 0;
          }),
          new Promise((_, rej) => setTimeout(() => rej('timeout'), 3000)),
        ]);
        if (changed) return true;
      } catch (e) {}
      await sleep(500);
    }
    return false;
  }

  // ──────────────────────────────────────────
  // STEP 4: Wait for stranger to connect
  // ──────────────────────────────────────────
  async waitForStranger() {
    const start = Date.now();
    logger.info('Waiting for stranger...');

    while (Date.now() - start < config.timing.matchTimeout) {
      try {
        const status = await this.page.evaluate(() => {
          const msgs = document.querySelector('#messages');
          if (!msgs) return 'waiting';
          const text = msgs.innerText || '';
          if (text.includes("You're now talking to a random stranger"))
            return 'connected';
          if (text.includes('challenge') || text.includes('Verification') || text.includes('verify'))
            return 'challenge';
          if (text.includes('banned') || text.includes('Banned'))
            return 'banned';
          if (text.includes('Connection lost'))
            return 'error';
          return 'waiting';
        });

        if (status === 'connected') {
          logger.info('Stranger connected!');
          return 'connected';
        }
        if (status === 'challenge') {
          logger.info('Turnstile challenge detected');
          await this.solveTurnstileChallenge();
        }
        if (status === 'banned') {
          logger.error('IP banned');
          return 'banned';
        }
        if (status === 'error') {
          return 'error';
        }
      } catch (e) {
        // page might have navigated or crashed
        if (!this.bm.isAlive()) return 'crash';
      }
      await sleep(1000);
    }
    logger.warn('Match timeout after ' + config.timing.matchTimeout + 'ms');
    return 'timeout';
  }

  // ──────────────────────────────────────────────
  // Turnstile in-chat challenge solver
  // ──────────────────────────────────────────────
  async solveTurnstileChallenge() {
    const start = Date.now();
    while (Date.now() - start < config.timing.turnstileSolveTimeout) {
      // Click any Turnstile iframe
      try {
        for (const f of this.page.frames()) {
          const url = f.url();
          if (url.includes('challenges.cloudflare.com') || url.includes('turnstile')) {
            await Promise.race([f.click('body'), sleep(5000)]);
            logger.info('Clicked Turnstile challenge frame');
            await sleep(3000);
          }
        }
      } catch (e) {}

      // Check if solved
      try {
        const solved = await this.page.evaluate(() => {
          const text = document.querySelector('#messages')?.innerText || '';
          return text.includes('Verification successful') ||
                 text.includes('Challenge completed') ||
                 text.includes("You're now talking to");
        });
        if (solved) {
          logger.info('Challenge solved!');
          return true;
        }
      } catch (e) {}
      await sleep(2000);
    }
    logger.warn('Turnstile challenge timeout');
    return false;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // STEP 5: Send greeting then promo, each with typing simulation.
  //   Typing duration = min(800 + len*40, 4000) ms.
  //   ControlLeft keydown triggers chat.js → ws.emit('typing', true)
  //   without inserting any character in the input.
  //   Enter keydown triggers chat.js → typing:false + sendBtn.click()
  // ────────────────────────────────────────────────────────────────────────────
  _typingDuration(text) {
    return Math.min(800 + text.length * 40, 4000);
  }

  async _sendWithTyping(message) {
    const duration = this._typingDuration(message);
    logger.info(`Typing (${duration}ms): "${message.substring(0, 50)}"`);

    await this.page.focus('#message-input');

    // ControlLeft fires keydown without inserting a character.
    // chat.js: any non-Enter keydown → ws.emit('typing', true)
    await this.page.keyboard.down('ControlLeft');
    await sleep(duration);
    await this.page.keyboard.up('ControlLeft');

    // Set message value directly (avoids MooTools dispatchEvent issue)
    await this.page.evaluate((msg) => {
      document.querySelector('#message-input').value = msg;
    }, message);

    // Enter: chat.js sends typing:false + calls sendBtn.click()
    await this.page.keyboard.press('Enter');
    logger.info(`Sent: "${message.substring(0, 60)}"`);
  }

  async sendMessage() {
    const greeting = config.greetings[Math.floor(Math.random() * config.greetings.length)];
    const promo = config.promos[Math.floor(Math.random() * config.promos.length)];
    logger.info(`Chat #${this.chatCount}: greeting="${greeting}"`);

    await this._sendWithTyping(greeting);
    await sleep(config.timing.betweenMessagesDelay);
    await this._sendWithTyping(promo);

    this.successCount++;
    logger.info(`Messages sent! (Total: ${this.successCount})`);
  }

  // ──────────────────────────────────────────
  // Skip: disconnect + auto-reconnect
  // chat.js: first click = confirm, second = skip
  // After skip, chat.js calls initializeConnectionSilent()
  // which automatically finds next stranger
  // ──────────────────────────────────────────
  async skipToNext() {
    logger.info('Skipping to next stranger...');
    try {
      await this.page.click('#skip-btn');
      await sleep(600);
      await this.page.click('#skip-btn');
    } catch (e) {
      logger.warn('Skip click error: ' + e.message);
    }
  }

  // ──────────────────────────────────────────────
  // Single chat cycle
  // ──────────────────────────────────────────────
  async runSingleChat() {
    this.chatCount++;
    logger.info(`--- Chat #${this.chatCount} ---`);

    const result = await this.waitForStranger();

    switch (result) {
      case 'connected':
        try {
          await this.sendMessage();
          await sleep(config.timing.afterMessageDelay);
        } catch (e) {
          logger.warn('Send failed: ' + e.message);
        }
        await this.skipToNext();
        break;

      case 'banned':
        throw new Error('BOT_BANNED');

      case 'crash':
        throw new Error('BROWSER_CRASH');

      default:
        // timeout, error — skip and retry
        logger.warn(`No connection (${result}), skipping...`);
        await this.skipToNext();
    }

    await sleep(config.timing.betweenChatsDelay);
  }

  // ──────────────────────────────────────────────
  // Full session initialization (browser + CF + ready + agree)
  // ──────────────────────────────────────────────
  async initSession() {
    this.page = await this.bm.launch();
    await this.initPage();
    await this.waitForReady();
    await this.clickAgreeAndMatch();
    logger.info('Session initialized — entering chat loop');
  }

  // ──────────────────────────────────────────────
  // Main bot loop with session-level retries
  // ──────────────────────────────────────────────
  async run() {
    this.running = true;
    const { maxChatsPerSession, maxRetries, maxSessionRetries } = config.bot;

    logger.info('=== BotIO starting ===');
    logger.info('Target: ' + config.target.url);
    logger.info('Max chats per session: ' + maxChatsPerSession);

    let sessionRetries = 0;

    for (let session = 1; session <= maxSessionRetries && this.running; session++) {
      logger.info(`--- Session ${session} ---`);

      try {
        await this.initSession();
      } catch (e) {
        await this.bm.close();

        if (e.message === 'SERVER_502') {
          logger.warn('Server 502 — waiting before retry...');
          await sleep(config.timing.serverDownRetryDelay);
          continue;
        }

        sessionRetries++;
        logger.error(`Session init failed (${sessionRetries}/${maxSessionRetries}): ${e.message}`);
        if (sessionRetries >= maxSessionRetries) {
          logger.error('Max session retries exhausted');
          break;
        }
        await sleep(10000);
        continue;
      }

      // Chat loop within a session
      let chatRetries = 0;
      while (this.running && this.chatCount < maxChatsPerSession) {
        try {
          if (!this.bm.isAlive()) throw new Error('BROWSER_CRASH');
          await this.runSingleChat();
          chatRetries = 0;
        } catch (e) {
          if (e.message === 'BOT_BANNED') {
            logger.error('Bot banned — stopping completely');
            this.running = false;
            break;
          }

          chatRetries++;
          logger.error(`Chat error (${chatRetries}/${maxRetries}): ${e.message}`);

          if (chatRetries >= maxRetries || e.message === 'BROWSER_CRASH') {
            logger.warn('Restarting session...');
            break; // breaks inner loop → outer loop starts new session
          }
          await sleep(5000);
        }
      }

      await this.bm.close();

      if (this.chatCount >= maxChatsPerSession) {
        logger.info('Max chats reached');
        break;
      }

      await sleep(config.timing.betweenChatsDelay);
    }

    logger.info('=== BotIO finished ===');
    logger.info(`Total chats: ${this.chatCount}, Messages sent: ${this.successCount}`);
  }

  async stop() {
    this.running = false;
    logger.info('Bot stopping...');
    await this.bm.close();
  }
}

module.exports = ChatBot;
