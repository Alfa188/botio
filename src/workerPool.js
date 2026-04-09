const { generateSession } = require('./proxyManager');
const ChatBot = require('./chatbot');
const logger = require('./logger');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const NO_PROXY = process.env.NO_PROXY === '1';

// WorkerPool maintains N concurrent Chrome ChatBot instances.
// Each bot gets its own Chrome + proxy session (unique residential IP).
// The server tracks "agreed" state per-WS-session, so each worker must
// run its own full browser (CF bypass → agree → chat loop).
class WorkerPool {
  constructor(size) {
    this.size = size;
    this.bots = new Map();  // id → { bot, status, successCount }
    this.running = false;
    this.nextId = 1;
  }

  // Spawn one ChatBot worker with its own Chrome + proxy
  async _spawnWorker(id) {
    logger.info(`[Pool] Spawning worker ${id}...`);

    const proxyUrl = NO_PROXY ? null : generateSession().url;
    const bot = new ChatBot(proxyUrl);
    const entry = { bot, status: 'starting', successCount: 0 };
    this.bots.set(id, entry);

    // Run the bot in background
    (async () => {
      try {
        entry.status = 'running';
        await bot.run();
        entry.status = 'stopped';
      } catch (e) {
        logger.error(`[W${id}] Crashed: ${e.message}`);
        entry.status = 'dead';
      }
    })();

    logger.info(`[Pool] Worker ${id} started`);
    return entry;
  }

  // Start pool: spawn all workers staggered, then monitor
  async start() {
    this.running = true;
    logger.info(`[Pool] Starting ${this.size} workers...`);

    // Spawn initial workers staggered (8s gap — each needs Chrome + CF bypass)
    for (let i = 0; i < this.size; i++) {
      const id = this.nextId++;
      this._spawnWorker(id).catch(e => logger.error(`[Pool] Spawn ${id} error: ${e.message}`));
      if (i < this.size - 1) await sleep(8000);
    }

    // Stats log every 60s
    setInterval(() => {
      const alive = [...this.bots.values()].filter(e => e.status === 'running').length;
      const total = [...this.bots.values()].reduce((s, e) => s + (e.bot.successCount || 0), 0);
      logger.info(`[Pool] Workers alive: ${alive}/${this.size} | Total messages sent: ${total}`);
    }, 60000);

    // Monitor loop: replace dead workers every 15s
    while (this.running) {
      await sleep(15000);

      for (const [id, entry] of this.bots.entries()) {
        if (entry.status === 'dead' || entry.status === 'stopped') {
          logger.info(`[Pool] Worker ${id} is ${entry.status} — replacing`);
          this.bots.delete(id);
          const newId = this.nextId++;
          sleep(3000).then(() =>
            this._spawnWorker(newId).catch(e =>
              logger.error(`[Pool] Replace ${newId} error: ${e.message}`)
            )
          );
        }
      }
    }
  }

  stopAll() {
    this.running = false;
    for (const entry of this.bots.values()) {
      try { entry.bot.bm.close(); } catch {}
    }
    logger.info('[Pool] All workers stopped');
  }
}

module.exports = WorkerPool;
