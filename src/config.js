require('dotenv').config();

module.exports = {
  target: {
    url: process.env.TARGET_URL || 'https://omegleweb.io',
  },

  browser: {
    chromePath: process.env.CHROME_PATH || '/home/codespace/.cache/puppeteer/chrome/linux-146.0.7680.153/chrome-linux64/chrome',
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
    maxChatsPerSession: parseInt(process.env.MAX_CHATS, 10) || 100,
    maxRetries: 3,
    maxSessionRetries: 10,       // full session restarts
  },
};
