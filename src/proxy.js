/**
 * Geonode Residential Proxy Manager
 *
 * Geonode proxies résidentiels — sessions sticky par instance.
 * Chaque instance bot maintient la même IP pour la durée de sa session,
 * ce qui est critique pour les cookies CF (liés à l'IP).
 *
 * Format de session sticky Geonode :
 *   user: geonode_USERNAME-session-SESSIONID-country-US
 *   pass: PASSWORD
 *   host: premium.residential.proxies.geonode.com
 *   port: 9001 (HTTP) ou 9003 (SOCKS5)
 *
 * Docs : https://geonode.com/faq/docs/residential-proxies/
 */

const crypto = require('crypto');

class ProxyManager {
  constructor(config = {}) {
    this.username = config.username || process.env.GEONODE_USERNAME || '';
    this.password = config.password || process.env.GEONODE_PASSWORD || '';
    this.host = config.host || process.env.GEONODE_HOST || 'proxy.geonode.io';
    this.port = config.port || process.env.GEONODE_PORT || '9000';
    this.country = config.country || process.env.GEONODE_COUNTRY || 'US';

    // sticky = session fixe (même IP sur toute la session), rotating = IP change à chaque req
    // Sur Geonode résidentiel port 9000 :
    //   rotating   → geonode_USERNAME-type-residential
    //   sticky     → geonode_USERNAME-session-SESSIONID-country-COUNTRY
    this.sessionType = process.env.GEONODE_SESSION_TYPE || 'sticky';

    // ID de session unique par instance (persistent pour la durée de vie du process)
    this.sessionId = process.env.INSTANCE_ID || crypto.randomBytes(6).toString('hex');
  }

  /**
   * Retourne la config proxy pour cette instance bot.
   * La session sticky garantit la même IP sur toute la durée de la session.
   */
  getProxy() {
    if (!this.username || !this.password) {
      return null;
    }

    const user = this.sessionType === 'rotating'
      ? `geonode_${this.username}-type-residential`
      : `geonode_${this.username}-session-${this.sessionId}-country-${this.country}`;

    return {
      url: `http://${encodeURIComponent(user)}:${encodeURIComponent(this.password)}@${this.host}:${this.port}`,
      host: this.host,
      port: parseInt(this.port),
      username: user,
      password: this.password,
      sessionId: this.sessionId,
    };
  }

  /**
   * Retourne les args Puppeteer pour configurer le proxy
   */
  getPuppeteerArgs() {
    const proxy = this.getProxy();
    if (!proxy) return [];
    return [`--proxy-server=http://${proxy.host}:${proxy.port}`];
  }

  /**
   * Retourne les credentials pour page.authenticate() dans Puppeteer
   */
  getPuppeteerCredentials() {
    const proxy = this.getProxy();
    if (!proxy) return null;
    return {
      username: proxy.username,
      password: proxy.password,
    };
  }

  /**
   * Retourne une config proxy avec session fixe partagée entre tous les bots.
   * Tous les bots (et FlareSolverr) utilisent le même exit IP Geonode.
   * Critique pour que cf_clearance et les connexions WS aient la même IP.
   */
  getSharedProxy() {
    if (!this.username || !this.password) return null;
    const user = `geonode_${this.username}-session-botio-shared-0-country-${this.country}`;
    return {
      url: `http://${encodeURIComponent(user)}:${encodeURIComponent(this.password)}@${this.host}:${this.port}`,
      host: this.host,
      port: parseInt(this.port),
      username: user,
      password: this.password,
      sessionId: 'botio-shared-0',
    };
  }

  toString() {
    const proxy = this.getProxy();
    if (!proxy) return 'direct (pas de proxy)';
    return `${proxy.host}:${proxy.port} [session: ${proxy.sessionId}]`;
  }

  isConfigured() {
    return !!(this.username && this.password);
  }
}

module.exports = ProxyManager;
