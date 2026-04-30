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

// ─────────────────────────────────────────────────────────────────────────────
// Promo messages – rotation constante sur 5 liens pour éviter les bans.
// Chaque appel à getPromoSplit() avance d'un cran dans la liste (round-robin)
// ET choisit un template différent, donc lien + texte changent ensemble.
// ─────────────────────────────────────────────────────────────────────────────

const _promoLinks = [
  'https://rb.gy/veav64',
  'https://rb.gy/1p9xzh',
  'https://rb.gy/fvr8pm',
  'https://rb.gy/gv2t19',
];

const _promoTemplates = [
  (l) => `everyone here is just guys lol found a better site with actual girls → ${l}`,
  (l) => `ngl this place is dead, everyone moved here → ${l}`,
  (l) => `if u wanna actually meet new people try this instead ${l} way better`,
  (l) => `bro this site is cooked 😭 found smth way better → ${l}`,
  (l) => `less creeps, more real convos, way more girls : ${l} just saying`,
  (l) => `my friend showed me this and its 10x better than here ${l}`,
  (l) => `if ur tired of skipping try this ${l} actually good`,
  (l) => `dont waste time here tbh ${l} hits different 🙏`,
];

let _linkIndex = 0;
let _templateIndex = 0;

function getPromoSplit() {
  // Indices indépendants : 8 templates × 4 liens = 32 combinaisons uniques
  const link = _promoLinks[_linkIndex % _promoLinks.length];
  const template = _promoTemplates[_templateIndex % _promoTemplates.length];
  _linkIndex = (_linkIndex + 1) % _promoLinks.length;
  _templateIndex = (_templateIndex + 1) % _promoTemplates.length;
  return [template(link), null];
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

  getPromoSplit,

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
