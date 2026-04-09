require('dotenv').config();

// Auto-detect Chrome: env override → puppeteer bundled → system Chrome (Mac/Linux)
function detectChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  try {
    // puppeteer auto-downloads a compatible Chrome at install time
    return require('puppeteer').executablePath();
  } catch {}
  // Fallback: system Chrome on Mac
  const { execSync } = require('child_process');
  try { execSync('which "Google Chrome"'); return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; } catch {}
  return '/usr/bin/google-chrome';
}

module.exports = {
  target: {
    url: process.env.TARGET_URL || 'https://omegleweb.io',
  },

  browser: {
    chromePath: detectChrome(),
    headless: false,
    viewport: { width: 1280, height: 800 },
    protocolTimeout: 300000,
  },

  greetings: ['sup', 'hi', 'hey', 'heyyy', 'hii', 'yo', 'f', 'F', 'hey :)', 'hi :)'],

  promos: [
    'everyone here is male lol.. omefree.com has way more girls just saying',
    'omefree.com > this 😭',
    'ngl omefree.com is way better for actually meeting people',
    'this site is dead rn.. omefree.com is where everyone moved to',
  ],

  timing: {
    cfMaxAttempts: 25,             // CF bypass attempts
    cfPollInterval: 3000,          // ms between CF checks
    wsReadyTimeout: 90000,         // wait for #agree-btn
    matchTimeout: 60000,           // wait for stranger match
    betweenMessagesDelay: 1200,    // delay between greeting and promo
    afterMessageDelay: 3000,       // wait after promo before skip
    betweenChatsDelay: 2000,       // wait between chat cycles
    turnstileSolveTimeout: 30000,  // turnstile challenge timeout
    serverDownRetryDelay: 60000,   // wait when 502 detected
  },

  bot: {
    maxChatsPerSession: parseInt(process.env.MAX_CHATS, 10) || 0,  // 0 = illimité
    maxRetries: 10,          // erreurs consécutives avant restart session
    maxSessionRetries: 999,  // redémarrages max (quasi-illimité)
  },
};
