#!/usr/bin/env node

/**
 * BotIO - Point d'entrée principal
 *
 * Usage:
 *   node index.js           → Bot Puppeteer (mode legacy)
 *   node index.js --ws      → Bot WebSocket direct (recommandé)
 *   node index.js --discover       → Analyse DOM statique
 *   node index.js --deep-discover  → Analyse DOM Puppeteer
 *   node index.js --help           → Aide
 */

require('dotenv').config();

const OmegleBot = require('./src/bot');
const DomAnalyzer = require('./src/analyzer');
const logger = require('./src/logger');

const args = process.argv.slice(2);

const config = {
  targetUrl: process.env.TARGET_URL || 'https://omegleweb.io',
  headless: process.env.HEADLESS === 'true',
  minTypingDelay: parseInt(process.env.MIN_TYPING_DELAY) || 1500,
  maxTypingDelay: parseInt(process.env.MAX_TYPING_DELAY) || 4000,
  messagesBeforePromo: parseInt(process.env.MESSAGES_BEFORE_PROMO) || 3,
  delayBetweenConversations: parseInt(process.env.DELAY_BETWEEN_CONVERSATIONS) || 5000,
  maxConversations: parseInt(process.env.MAX_CONVERSATIONS) || 50,
};

async function main() {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║           BotIO - Promotion Bot for OmeFree               ║
╠═══════════════════════════════════════════════════════════╣
║                                                           ║
║  MODES :                                                  ║
║    node index.js --ws           Bot WebSocket (RECOMMANDÉ)║
║    node index.js --ws --workers 5  5 bots en parallèle   ║
║    node index.js                Bot Puppeteer (legacy)    ║
║    node index.js --discover     Analyse DOM (CF+Cheerio)  ║
║    node index.js --deep-discover Analyse DOM Puppeteer    ║
║    node index.js --help         Cette aide                ║
║                                                           ║
║  --ws (WebSocket direct) :                                ║
║    → FlareSolverr résout CF → cookies injectés            ║
║    → WS natif wss://omegleweb.io:8443                     ║
║    → Protocole JSON {channel, data}                       ║
║    → Pas de Puppeteer → impossible d'être détecté headless║
║                                                           ║
║  Channels WS confirmés :                                  ║
║    EMIT: match, message, typing, disconnect, peopleOnline ║
║    RECV: match, message, typing, disconnect, peerCountry  ║
║          requireTurnstile, banned_ip, heartbeat           ║
║                                                           ║
║  Configuration: fichier .env                              ║
║  Logs: dossier logs/                                      ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
    `);
    return;
  }

  // ─── Mode WebSocket (recommandé) ───
  if (args.includes('--ws')) {
    // Nombre de bots parallèles : --workers N (défaut 1)
    const workersIdx = args.indexOf('--workers');
    const numWorkers = workersIdx >= 0 ? Math.max(1, parseInt(args[workersIdx + 1]) || 1) : 1;

    const WsBot = require('./src/ws-client');
    const cookiePool = require('./src/cookie-pool');
    const CfSolver = require('./src/cf-solver');

    logger.info(`Démarrage de ${numWorkers} bot(s) WebSocket en parallèle...`);

    // Préchauffer le pool de cookies une seule fois pour tous les workers
    const cfSolver = new CfSolver();
    const cfHealthy = await cfSolver.healthCheck();
    if (!cfHealthy) {
      logger.error(`FlareSolverr inaccessible — impossible de démarrer`);
      process.exit(1);
    }

    logger.info('Récupération des cookies CF (partagés entre tous les bots)...');
    const { cookieHeader } = await cookiePool.get(cfSolver, config.targetUrl);
    logger.info(`CF résolu ✓ — Lancement de ${numWorkers} bot(s)...`);

    // Set partagé pour détecter les auto-matchs bot-à-bot
    const sharedMatchIds = new Set();

    // Lancer tous les bots en parallèle avec 3s d'écart (évite les auto-matchs)
    const bots = Array.from({ length: numWorkers }, (_, i) => {
      const botConfig = {
        ...config,
        maxConversations: Math.ceil(config.maxConversations / numWorkers),
      };
      const bot = new WsBot(botConfig, sharedMatchIds, i);
      const startDelay = i * 3000; // 3s d'écart entre chaque bot
      return new Promise(resolve => setTimeout(resolve, startDelay))
        .then(() => {
          logger.info(`Bot #${i + 1} démarré`);
          return bot.run();
        })
        .catch(err => logger.error(`Bot #${i + 1} erreur: ${err.message}`));
    });

    const gracefulShutdown = () => {
      logger.info('Signal d\'arrêt reçu...');
      // Les bots s'auto-stoppent sur SIGINT via running=false
      setTimeout(() => process.exit(0), 3000);
    };
    process.on('SIGINT', gracefulShutdown);
    process.on('SIGTERM', gracefulShutdown);

    await Promise.allSettled(bots);
    logger.info('Tous les bots terminés.');
    return;
  }

  // ─── Modes Puppeteer / static ───
  const bot = new OmegleBot(config);

  const gracefulShutdown = async () => {
    logger.info('Signal d\'arrêt reçu...');
    await bot.stop();
    process.exit(0);
  };
  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);

  try {
    if (args.includes('--discover')) {
      logger.info('Mode DÉCOUVERTE DOM (sans navigateur)...');
      const analyzer = new DomAnalyzer();
      await analyzer.analyze(process.env.TARGET_URL || 'https://omegleweb.io');
    } else if (args.includes('--deep-discover')) {
      logger.info('Mode DEEP-DISCOVER DOM (Puppeteer + proxy)...');
      await bot.init();
      await bot.deepDiscover();
    } else {
      await bot.init();
      logger.info('Mode CHAT Puppeteer...');
      await bot.run();
    }
  } catch (error) {
    logger.error(`Erreur fatale: ${error.message}`);
    logger.error(error.stack);
  } finally {
    if (!args.includes('--discover')) {
      await bot.stop();
    }
  }
}

main();
