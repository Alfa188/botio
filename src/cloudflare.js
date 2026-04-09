const config = require('./config');
const logger = require('./logger');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class CloudflareBypass {
  /**
   * Wait for Cloudflare challenge to resolve on the current page.
   * @param {import('puppeteer-core').Page} page
   * @returns {Promise<boolean>} true if bypassed
   */
  async waitForClearance(page) {
    const { cfWaitMax, cfPollInterval } = config.timing;
    const maxAttempts = Math.ceil(cfWaitMax / cfPollInterval);

    logger.info('Waiting for Cloudflare clearance...');

    for (let i = 0; i < maxAttempts; i++) {
      await sleep(cfPollInterval);

      const title = await page.title().catch(() => 'error');

      if (!title.includes('moment') && !title.includes('Just') && !title.includes('Cloudflare')) {
        logger.info(`Cloudflare cleared after ${(i + 1) * cfPollInterval / 1000}s`);
        return true;
      }

      // Try clicking Turnstile checkbox in iframe
      if (i % 3 === 2) {
        await this._tryClickTurnstile(page);
      }

      logger.debug(`CF wait: ${(i + 1) * cfPollInterval / 1000}s - "${title}"`);
    }

    logger.error('Failed to bypass Cloudflare after max wait time');
    return false;
  }

  async _tryClickTurnstile(page) {
    try {
      const frames = page.frames();
      for (const frame of frames) {
        if (frame.url().includes('turnstile') || frame.url().includes('challenge')) {
          await frame.click('body').catch(() => {});
          await frame.click('input[type="checkbox"]').catch(() => {});
        }
      }
    } catch (e) {
      // Ignore
    }
  }
}

module.exports = CloudflareBypass;
