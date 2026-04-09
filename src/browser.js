const puppeteer = require('rebrowser-puppeteer-core');
const ProxyChain = require('proxy-chain');
const config = require('./config');
const logger = require('./logger');

class BrowserManager {
  constructor(proxyUrl = null) {
    this.browser = null;
    this.page = null;
    this._proxyUrl = proxyUrl;   // e.g. "http://user:pass@host:port"
    this._localProxy = null;     // anonymized proxy-chain URL
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
      // proxy-chain creates a local anon proxy (removes auth challenge from Chrome).
      // We test CONNECT before launching Chrome so we never get ERR_NO_SUPPORTED_PROXIES.
      try {
        this._localProxy = await ProxyChain.anonymizeProxy(this._proxyUrl);
        await this._testProxy(this._localProxy);
        args.push(`--proxy-server=${this._localProxy}`);
        logger.info(`Using proxy: ${this._localProxy}`);
      } catch (e) {
        logger.warn(`Proxy unreachable (${e.message}) — launching direct`);
        if (this._localProxy) {
          await ProxyChain.closeAnonymizedProxy(this._localProxy, true).catch(() => {});
          this._localProxy = null;
        }
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

  // Verify proxy can tunnel HTTPS via HTTP CONNECT before Chrome uses it
  async _testProxy(localProxyUrl) {
    return new Promise((resolve, reject) => {
      const net = require('net');
      const url = new URL(localProxyUrl);
      const sock = net.createConnection({ host: url.hostname, port: parseInt(url.port) }, () => {
        sock.write('CONNECT omegleweb.io:443 HTTP/1.1\r\nHost: omegleweb.io:443\r\n\r\n');
        sock.once('data', (data) => {
          const res = data.toString();
          sock.destroy();
          if (res.includes('200')) resolve();
          else reject(new Error(`Proxy CONNECT failed: ${res.split('\r\n')[0]}`));
        });
      });
      sock.on('error', reject);
      setTimeout(() => { sock.destroy(); reject(new Error('Proxy test timeout')); }, 8000);
    });
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
