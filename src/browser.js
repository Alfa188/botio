const puppeteer = require('rebrowser-puppeteer-core');
const ProxyChain = require('proxy-chain');
const config = require('./config');
const logger = require('./logger');

class BrowserManager {
  constructor(proxyUrl = null) {
    this.browser = null;
    this.page = null;
    this._proxyUrl = proxyUrl;       // e.g. "http://user:pass@host:port"
    this._localProxy = null;         // anonymized proxy-chain URL
  }

  async launch() {
    logger.info('Launching browser...');

    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=1280,800',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-infobars',
      '--disable-extensions',
    ];

    if (this._proxyUrl) {
      // proxy-chain: local anonymous proxy removes auth challenge (avoids CDP hang)
      // Test connectivity first to give a clear error if credentials are wrong
      try {
        this._localProxy = await ProxyChain.anonymizeProxy(this._proxyUrl);
        // Quick TCP test to confirm local proxy started
        await new Promise((resolve, reject) => {
          const net = require('net');
          const url = new URL(this._localProxy);
          const sock = net.createConnection({ host: url.hostname, port: parseInt(url.port) }, resolve);
          sock.on('error', reject);
          setTimeout(() => { sock.destroy(); resolve(); }, 1000);
        });
        args.push(`--proxy-server=${this._localProxy}`);
        logger.info(`Using proxy: ${this._localProxy}`);
      } catch (e) {
        logger.warn(`Proxy setup failed (${e.message}) — falling back to direct connection`);
        this._localProxy = null;
      }
    }

    this.browser = await puppeteer.launch({
      headless: config.browser.headless,
      executablePath: config.browser.chromePath,
      args,
      protocolTimeout: config.browser.protocolTimeout,
    });

    const pages = await this.browser.pages();
    this.page = pages[0] || await this.browser.newPage();
    await this.page.setViewport(config.browser.viewport);

    this.page.on('error', (err) => logger.error('Page crash: ' + err.message));
    this.page.on('close', () => logger.warn('Page closed unexpectedly'));

    logger.info('Browser launched');
    return this.page;
  }

  async close() {
    try {
      if (this.browser) {
        await this.browser.close();
        logger.info('Browser closed');
      }
    } catch (e) {
      logger.warn('Browser close error: ' + e.message);
    }
    this.browser = null;
    this.page = null;
    if (this._localProxy) {
      await ProxyChain.closeAnonymizedProxy(this._localProxy, true).catch(() => {});
      this._localProxy = null;
    }
  }

  isAlive() {
    try {
      return this.browser && this.page && !this.page.isClosed();
    } catch (e) {
      return false;
    }
  }
}

module.exports = BrowserManager;
