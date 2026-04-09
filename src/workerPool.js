const { getCredentials } = require('./cfRefresher');
const { generateSession } = require('./proxyManager');
const WsWorker = require('./wsWorker');
const logger = require('./logger');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// WorkerPool maintains N concurrent WS workers.
// Each worker gets its own sticky proxy session (unique IP).
// Chrome is only used during initialization — closed immediately after.
// Dead/banned workers are replaced automatically.
class WorkerPool {
  constructor(size) {
    this.size = size;
    this.workers = new Map(); // id → WsWorker
    this.running = false;
    this.nextId = 1;
    this.totalSent = 0;
  }

  // Spawn one worker: get CF credentials → launch WS worker
  async _spawnWorker(id) {
    logger.info(`[Pool] Spawning worker ${id}...`);
    const session = generateSession();

    let credentials;
    try {
      credentials = await getCredentials(session);
    } catch (e) {
      logger.error(`[Pool] Worker ${id} CF init failed: ${e.message}`);
      return null;
    }

    const worker = new WsWorker(credentials, id);
    this.workers.set(id, worker);

    // Run in background — monitor via status field
    worker.start().catch(e => {
      logger.error(`[W${id}] Crashed: ${e.message}`);
      worker.status = 'dead';
    });

    logger.info(`[Pool] Worker ${id} started (session ${session.id})`);
    return worker;
  }

  // Start pool: spawn all workers with a stagger, then monitor
  async start() {
    this.running = true;
    logger.info(`[Pool] Starting ${this.size} workers...`);

    // Spawn initial workers staggered (avoid hammering CF + proxy)
    for (let i = 0; i < this.size; i++) {
      const id = this.nextId++;
      this._spawnWorker(id).catch(e => logger.error(`[Pool] Spawn ${id} error: ${e.message}`));
      // Stagger: 4s between each Chrome launch
      if (i < this.size - 1) await sleep(4000);
    }

    // Stats log every 60s
    setInterval(() => {
      const alive = [...this.workers.values()].filter(w => w.status === 'running').length;
      const total = [...this.workers.values()].reduce((s, w) => s + w.successCount, 0);
      logger.info(`[Pool] Workers alive: ${alive}/${this.size} | Total messages sent: ${total}`);
    }, 60000);

    // Monitor loop: replace dead/banned workers every 10s
    while (this.running) {
      await sleep(10000);

      for (const [id, worker] of this.workers.entries()) {
        if (worker.status === 'banned' || worker.status === 'dead') {
          logger.info(`[Pool] Worker ${id} is ${worker.status} — replacing`);
          worker.stop();
          this.workers.delete(id);

          const newId = this.nextId++;
          // Spawn replacement without blocking the monitor
          sleep(2000).then(() =>
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
    for (const worker of this.workers.values()) worker.stop();
    logger.info('[Pool] All workers stopped');
  }
}

module.exports = WorkerPool;
