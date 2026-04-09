const puppeteer = require('rebrowser-puppeteer-core');
const config = require('./config');
const logger = require('./logger');

class BrowserManager {
  constructor() {
    this.browser = null;
    this.page = null;
  }

  async launch() {
    logger.info('Launching browser...');
    this.browser = await puppeteer.launch({
      headless: config.browser.headless,
      executablePath: config.browser.chromePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--window-size=1280,800',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--disable-infobars',
        '--disable-extensions',
      ],
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
