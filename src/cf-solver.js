/**
 * FlareSolverr Client
 *
 * FlareSolverr est un service auto-hébergé (Docker) qui résout les challenges
 * Cloudflare en arrière-plan. Il retourne les cookies CF + le HTML complet.
 *
 * Avantages vs Puppeteer direct :
 *  - Un seul service partagé pour les 15 instances bot
 *  - Les cookies résolus sont injectés dans Puppeteer → pas de re-résolution
 *  - Pour l'analyse DOM : zéro Puppeteer, juste HTTP + cheerio
 *
 * Docs : https://github.com/FlareSolverr/FlareSolverr
 */

const axios = require('axios');
const logger = require('./logger');

class CfSolver {
  constructor(baseUrl) {
    this.baseUrl = (baseUrl || process.env.FLARESOLVERR_URL || 'http://localhost:8191').replace(/\/$/, '');
    this.sessionCache = new Map(); // cache cookiespar proxy session
  }

  /**
   * Résout le challenge CF et retourne la solution complète.
   * @param {string} url - URL cible
   * @param {object|null} proxy - { url: 'http://user:pass@host:port' }
   * @returns {object} solution - { url, status, cookies, userAgent, response (html) }
   */
  async getSolution(url, proxy = null) {
    const payload = {
      cmd: 'request.get',
      url,
      maxTimeout: 90000,
    };

    if (proxy) {
      payload.proxy = { url: proxy.url };
    }

    logger.debug(`FlareSolverr → ${url}${proxy ? ` via proxy` : ''}`);

    const response = await axios.post(`${this.baseUrl}/v1`, payload, {
      timeout: 100000,
      headers: { 'Content-Type': 'application/json' },
    });

    if (response.data.status !== 'ok') {
      throw new Error(`FlareSolverr erreur: ${response.data.message}`);
    }

    const solution = response.data.solution;
    logger.debug(`CF résolu — status HTTP: ${solution.status}, cookies: ${solution.cookies.length}`);
    return solution;
  }

  /**
   * Retourne les cookies Cloudflare au format Puppeteer.
   * Utilise un cache pour éviter de re-résoudre à chaque démarrage d'instance.
   * @param {string} url
   * @param {object|null} proxy
   * @returns {{ cookies: Array, userAgent: string }}
   */
  async getPuppeteerCookies(url, proxy = null) {
    const cacheKey = proxy ? proxy.url : 'direct';

    if (this.sessionCache.has(cacheKey)) {
      const cached = this.sessionCache.get(cacheKey);
      const age = Date.now() - cached.timestamp;
      // Les cookies CF durent ~30 min, on renouvelle à 25 min pour marge
      if (age < 25 * 60 * 1000) {
        logger.debug('CF cookies servis depuis le cache');
        return { cookies: cached.cookies, userAgent: cached.userAgent };
      }
    }

    const solution = await this.getSolution(url, proxy);

    // Normaliser les cookies au format Puppeteer
    const cookies = solution.cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain || new URL(url).hostname,
      path: c.path || '/',
      httpOnly: c.httpOnly || false,
      secure: c.secure || false,
      sameSite: c.sameSite || 'Lax',
    }));

    this.sessionCache.set(cacheKey, {
      cookies,
      userAgent: solution.userAgent,
      timestamp: Date.now(),
    });

    return { cookies, userAgent: solution.userAgent };
  }

  /**
   * Retourne le HTML brut de la page après résolution CF.
   * Utilisé par l'analyseur DOM (pas besoin de Puppeteer).
   * @param {string} url
   * @param {object|null} proxy
   * @returns {{ html: string, cookies: Array, userAgent: string, status: number }}
   */
  async getPageHtml(url, proxy = null) {
    const solution = await this.getSolution(url, proxy);
    return {
      html: solution.response,
      cookies: solution.cookies,
      userAgent: solution.userAgent,
      status: solution.status,
      finalUrl: solution.url,
    };
  }

  /**
   * Vérifie que FlareSolverr est accessible
   */
  async healthCheck() {
    try {
      const res = await axios.get(`${this.baseUrl}/health`, { timeout: 5000 });
      return res.data.status === 'ok';
    } catch {
      return false;
    }
  }
}

module.exports = CfSolver;
