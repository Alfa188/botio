const puppeteer = require('rebrowser-puppeteer-core');
const ProxyChain = require('proxy-chain');
const config = require('./config');
const logger = require('./logger');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const NO_PROXY = process.env.NO_PROXY === '1';

// Launch Chrome (via sticky proxy or direct), solve Cloudflare Turnstile,
// extract cf_clearance + cookies + userAgent for the WS worker.
async function getCredentials(session) {
  const via = NO_PROXY ? 'direct' : `${session.host}:${session.port}`;
  logger.info(`[CF:${session.id}] Launching Chrome via ${via}`);

  // proxy-chain: create a local anonymous proxy → forwards to Geonode with credentials.
  // Chrome connects to localhost (no 407 challenge → no CDP hang).
  let localProxyUrl = null;
  if (!NO_PROXY) {
    localProxyUrl = await ProxyChain.anonymizeProxy(session.url);
    logger.info(`[CF:${session.id}] Local proxy: ${localProxyUrl}`);
  }

  const chromeArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage',
  ];
  if (!NO_PROXY) chromeArgs.push(`--proxy-server=${localProxyUrl}`);

  const browser = await puppeteer.launch({
    executablePath: config.browser.chromePath,
    headless: false,
    args: chromeArgs,
    timeout: 60000,
    protocolTimeout: 60000,
  });
  logger.info(`[CF:${session.id}] Chrome launched`);

  try {
    const pages = await browser.pages();
    logger.info(`[CF:${session.id}] Got ${pages.length} pages`);
    const page = pages[0] || await browser.newPage();
    logger.info(`[CF:${session.id}] Page ready`);

    page.setDefaultTimeout(30000);
    await page.setViewport({ width: 1280, height: 800 });

    // Prevent configureChat() from redirecting to / when sessionStorage is empty
    await page.evaluateOnNewDocument(() => {
      sessionStorage.setItem('userAgreement', 'true');
    });

    logger.info(`[CF:${session.id}] Navigating...`);

    // Non-blocking goto — CF challenge stalls domcontentloaded event
    page.goto(config.target.url + '/chat?interests=', {
      timeout: 120000,
      waitUntil: 'domcontentloaded',
    }).catch(() => {});

    // — exact same CF bypass loop as chatbot.js —
    for (let i = 1; i <= config.timing.cfMaxAttempts; i++) {
      await sleep(config.timing.cfPollInterval);

      let title = '';
      try {
        title = await Promise.race([page.title(), sleep(4000).then(() => '')]);
      } catch (e) { continue; }

      if (title.includes('502') || title.includes('Bad Gateway')) {
        throw new Error('SERVER_502');
      }

      const isCF = title.includes('moment') || title.includes('Just') ||
                   title.includes('Checking') || title.length === 0;
      if (!isCF) {
        logger.info(`[CF:${session.id}] Bypassed on attempt ${i}: "${title}"`);
        break;
      }

      logger.info(`[CF:${session.id}] Attempt ${i}/${config.timing.cfMaxAttempts}: title="${title}" url="${page.url()}"`);

      // Click Turnstile challenge frame
      let frameClicked = false;
      try {
        for (const f of page.frames()) {
          const url = f.url();
          if (url.includes('challenges.cloudflare.com') || url.includes('turnstile')) {
            await Promise.race([f.click('body'), sleep(5000)]);
            frameClicked = true;
            break;
          }
        }
      } catch (e) {
        logger.warn(`[CF:${session.id}] CF click error: ${e.message}`);
      }
      if (!frameClicked) logger.info(`[CF:${session.id}] No CF frame found on attempt ${i}`);
    }

    // Confirm agree-btn is visible (WS connected)
    logger.info(`[CF:${session.id}] Waiting for #agree-btn...`);
    await page.waitForSelector('#agree-btn', { timeout: config.timing.wsReadyTimeout });
    await sleep(2000); // wait for WS to fully init before clicking

    // Click agree button + wait for match to start (same retry logic as chatbot.js)
    // This sets server-side session state required by the WS server.
    logger.info(`[CF:${session.id}] Clicking agree-btn to register session...`);
    for (let i = 1; i <= 8; i++) {
      try { await page.click('#agree-btn'); } catch {}
      // Wait up to 6s for starMsg to disappear (match initiated)
      const started = await (async () => {
        const end = Date.now() + 6000;
        while (Date.now() < end) {
          try {
            const gone = await page.evaluate(() => {
              const msgs = document.querySelector('#messages');
              if (!msgs) return false;
              return !msgs.innerHTML.includes('starMsg') && msgs.innerHTML.length > 0;
            });
            if (gone) return true;
          } catch {}
          await sleep(400);
        }
        return false;
      })();
      if (started) {
        logger.info(`[CF:${session.id}] Match initiated on agree click ${i}`);
        break;
      }
      logger.info(`[CF:${session.id}] Agree click ${i} no effect, retrying...`);
      await sleep(1500);
    }

    await sleep(500); // let cookies settle

    // Extract all cookies + user-agent AFTER agree click (includes server session state)
    const cookies = await page.cookies();
    const userAgent = await page.evaluate(() => navigator.userAgent);
    const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    logger.info(`[CF:${session.id}] Got ${cookies.length} cookies, UA length: ${userAgent.length}`);
    return { cookieString, userAgent, session };

  } finally {
    await browser.close();
    if (localProxyUrl) {
      await ProxyChain.closeAnonymizedProxy(localProxyUrl, true).catch(() => {});
    }
  }
}

module.exports = { getCredentials };
