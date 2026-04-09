const logger = require('./src/logger');

// MODE=pool  → N parallel Chrome bots, each with own proxy (scales to 20-40 sessions)
// MODE=single → single Chrome bot (default, no proxy required)
const MODE = process.env.MODE || 'single';
const WORKERS = parseInt(process.env.WORKERS || '5');

let shutdown;

if (MODE === 'pool') {
  const WorkerPool = require('./src/workerPool');
  const pool = new WorkerPool(WORKERS);
  shutdown = () => pool.stopAll();
  logger.info(`Starting in POOL mode — ${WORKERS} workers`);
  pool.start().catch(err => {
    logger.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
} else {
  const ChatBot = require('./src/chatbot');
  const bot = new ChatBot();
  shutdown = () => bot.stop();
  logger.info('Starting in SINGLE mode');
  bot.run().catch(err => {
    logger.error(`Fatal error: ${err.message}`);
    process.exit(1);
  });
}

process.on('SIGINT', () => { logger.info('SIGINT — shutting down...'); shutdown(); process.exit(0); });
process.on('SIGTERM', () => { logger.info('SIGTERM — shutting down...'); shutdown(); process.exit(0); });
process.on('unhandledRejection', err => logger.error(`Unhandled rejection: ${err.message}`));
