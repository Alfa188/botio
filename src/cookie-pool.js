/**
 * CookiePool — Cache de cookies CF partagé entre toutes les instances WsBot.
 *
 * Problème résolu :
 *   Sans ce pool, chaque instance WsBot appelle FlareSolverr indépendamment.
 *   FlareSolverr ne traite qu'une requête à la fois (1 Chrome interne).
 *   10 bots = 10 × 30s = 5 min de warm-up en file d'attente.
 *
 * Solution :
 *   Ce module est un singleton (require() cacheé par Node).
 *   Toutes les instances dans le MÊME processus partagent les cookies.
 *   Pour plusieurs PROCESSUS, le cache est persisté sur disque (pool-cache.json).
 *   TTL = 20 min (cf_clearance dure ~30 min, on prend une marge).
 *
 * Usage :
 *   const cookiePool = require('./cookie-pool');
 *   const { cookieHeader, userAgent } = await cookiePool.get(cfSolver, targetUrl);
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const CACHE_FILE = path.join(__dirname, '..', 'logs', 'pool-cache.json');
const TTL_MS = 20 * 60 * 1000; // 20 minutes

class CookiePool {
  constructor() {
    // Cache en mémoire (partagé entre toutes les instances du même processus)
    this._cache = null;         // { cookieHeader, userAgent, expiresAt }
    this._pending = null;       // Promise en cours si une résolution est déjà en flight
  }

  /**
   * Retourne { cookieHeader, userAgent } valides.
   * Si le cache est valide (mémoire ou disque), le retourne directement.
   * Sinon, résout via FlareSolverr (une seule résolution simultanée).
   *
   * @param {CfSolver} cfSolver
   * @param {string} targetUrl
   * @param {object|null} proxy - { url: 'http://user:pass@host:port' }
   */
  async get(cfSolver, targetUrl, proxy = null) {
    // 1. Cache mémoire
    if (this._cache && Date.now() < this._cache.expiresAt) {
      logger.debug('CookiePool: hit mémoire');
      return { cookieHeader: this._cache.cookieHeader, userAgent: this._cache.userAgent };
    }

    // 2. Cache disque (pour partage inter-processus)
    const fromDisk = this._readDiskCache();
    if (fromDisk) {
      this._cache = fromDisk;
      logger.debug('CookiePool: hit disque');
      return { cookieHeader: fromDisk.cookieHeader, userAgent: fromDisk.userAgent };
    }

    // 3. Pas de cache valide — une seule résolution en flight à la fois
    if (this._pending) {
      logger.debug('CookiePool: attente résolution déjà en cours...');
      return this._pending;
    }

    this._pending = this._resolve(cfSolver, targetUrl, proxy)
      .finally(() => { this._pending = null; });

    return this._pending;
  }

  /**
   * Force le renouvellement des cookies (après Turnstile, ban, etc.)
   */
  invalidate() {
    logger.info('CookiePool: invalidation du cache');
    this._cache = null;
    this._deleteDiskCache();
  }

  /**
   * Résout les cookies via FlareSolverr et met à jour le cache.
   */
  async _resolve(cfSolver, targetUrl, proxy = null) {
    logger.info('CookiePool: résolution CF via FlareSolverr...');
    const solution = await cfSolver.getSolution(targetUrl, proxy);

    if (!solution.cookies || solution.cookies.length === 0) {
      logger.warn('CookiePool: 0 cookies retournés par FlareSolverr');
    }

    const cookieHeader = solution.cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const userAgent = solution.userAgent ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

    const entry = {
      cookieHeader,
      userAgent,
      expiresAt: Date.now() + TTL_MS,
    };

    this._cache = entry;
    this._writeDiskCache(entry);

    logger.info(`CookiePool: ${solution.cookies.length} cookies mis en cache (TTL 20 min) ✓`);
    return { cookieHeader, userAgent };
  }

  _readDiskCache() {
    try {
      if (!fs.existsSync(CACHE_FILE)) return null;
      const raw = fs.readFileSync(CACHE_FILE, 'utf8');
      const entry = JSON.parse(raw);
      if (Date.now() >= entry.expiresAt) {
        this._deleteDiskCache();
        return null;
      }
      return entry;
    } catch {
      return null;
    }
  }

  _writeDiskCache(entry) {
    try {
      const dir = path.dirname(CACHE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify(entry), 'utf8');
    } catch (e) {
      logger.warn(`CookiePool: échec écriture cache disque: ${e.message}`);
    }
  }

  _deleteDiskCache() {
    try {
      if (fs.existsSync(CACHE_FILE)) fs.unlinkSync(CACHE_FILE);
    } catch {}
  }
}

// Singleton : une seule instance par processus Node
module.exports = new CookiePool();
