/**
 * WsBot - Bot WebSocket direct pour omegleweb.io
 *
 * Connecte directement au WebSocket de omegleweb.io en utilisant les
 * cookies CF obtenus via FlareSolverr, sans passer par Puppeteer.
 *
 * Protocole WS : wss://omegleweb.io:8443
 * Format msg   : JSON {channel: string, data: any}
 *
 * Channels EMIT :
 *   match({data:'text', params:{interests:[], preferSameCountry:bool}})
 *   message(string)
 *   typing(bool)
 *   disconnect()
 *   peopleOnline()
 *   challengeComplete({token:string})
 *
 * Channels REÇUS :
 *   match       → stranger trouvé  (ou en attente)
 *   message     → message du stranger
 *   typing      → stranger en train d'écrire
 *   disconnect  → stranger déconnecté
 *   peerCountry → pays du stranger {country, countryName}
 *   peerAFK     → stranger inactif
 *   peerActive  → stranger revenu
 *   requireTurnstile → CAPTCHA requis (→ skip)
 *   challenge   → challenge CF requis
 *   challengeFailed → challenge échoué
 *   banned_ip   → IP bannie
 *   peopleOnline → {count}
 *   heartbeat   → heartbeat serveur
 */

const WebSocket = require('ws');
const { HttpsProxyAgent } = require('https-proxy-agent');
const logger = require('./logger');
const CfSolver = require('./cf-solver');
const ProxyManager = require('./proxy');
const cookiePool = require('./cookie-pool');
const {
  GREETINGS,
  PROMO_MESSAGES,
  pickRandom,
} = require('./messages');

const DEFAULT_WS_URL = 'wss://omegleweb.io:8443';
const DEFAULT_TARGET_URL = 'https://omegleweb.io';
const HEARTBEAT_INTERVAL_MS = 30000;
const PEOPLE_ONLINE_INTERVAL_MS = 10000;
const RECONNECT_DELAYS_MS = [2000, 5000, 15000, 30000, 60000]; // backoff exponentiel

class WsBot {
  /**
   * @param {object} config
   * @param {Set}    [sharedMatchIds] - Set partagé entre tous les bots du même processus
   *                                    pour détecter les auto-matchs bot-à-bot.
   * @param {number} [botIndex]       - Index du bot (0-based), utilisé pour le démarrage échelonné.
   */
  constructor(config = {}, sharedMatchIds = null, botIndex = 0) {
    this.config = {
      targetUrl: config.targetUrl || process.env.TARGET_URL || DEFAULT_TARGET_URL,
      wsUrl: config.wsUrl || process.env.WS_URL || DEFAULT_WS_URL,
      messagesBeforePromo: parseInt(config.messagesBeforePromo) || 3,
      delayBetweenConversations: parseInt(config.delayBetweenConversations) || 5000,
      maxConversations: parseInt(config.maxConversations) || 50,
      minTypingDelay: parseInt(config.minTypingDelay) || 1500,
      maxTypingDelay: parseInt(config.maxTypingDelay) || 4000,
      interests: config.interests || [],
      preferSameCountry: config.preferSameCountry || false,
    };

    this.cfSolver = new CfSolver();
    this.proxyManager = new ProxyManager();

    // Partagé entre tous les bots du même processus — détecte les auto-matchs
    this._sharedMatchIds = sharedMatchIds || new Set();
    this._botIndex = botIndex;

    this.ws = null;
    this.wsReady = false;
    this.cookieHeader = '';
    this.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    this.flareSolverrSessionId = null;
    this._currentMatchId = null;
    this._reconnectAttempts = 0;

    // État de la conversation courante
    this.isMatched = false;
    this.messageCount = 0;
    this.promoSent = false;
    this.awaitingReply = false;
    this.lastReceivedMessages = [];
    this.conversationCount = 0;
    this.running = false;

    // Timers
    this._heartbeatTimer = null;
    this._peopleOnlineTimer = null;
    this._typingTimer = null;

    // Stats globales
    this.stats = {
      totalConversations: 0,
      totalMessagesSent: 0,
      totalPromosDelivered: 0,
      totalChallenges: 0,
      totalBanned: 0,
      startTime: null,
    };
  }

  // ─────────────────────────────────────────────
  // INITIALISATION
  // ─────────────────────────────────────────────

  /**
   * Récupère les cookies CF via FlareSolverr et initialise l'en-tête Cookie.
   * Utilise une session persistante pour minimiser les re-résolutions.
   */
  async _initCfCookies() {
    const cfHealthy = await this.cfSolver.healthCheck();
    if (!cfHealthy) {
      throw new Error(`FlareSolverr inaccessible à ${this.cfSolver.baseUrl}`);
    }

    // Pool partagé — une seule résolution FlareSolverr même pour N bots simultanés
    // Le proxy partagé garantit que cf_clearance et les WS ont la même IP (résidentielle)
    const sharedProxy = this.proxyManager.getSharedProxy();
    const { cookieHeader, userAgent } = await cookiePool.get(
      this.cfSolver, this.config.targetUrl, sharedProxy
    );
    this._sharedProxy = sharedProxy;

    this.cookieHeader = cookieHeader;
    this.userAgent = userAgent || this.userAgent;
    logger.debug(`Cookie header: ${this.cookieHeader.substring(0, 80)}...`);
  }

  // ─────────────────────────────────────────────
  // WEBSOCKET — CONNEXION ET PROTOCOLE
  // ─────────────────────────────────────────────

  /**
   * Ouvre une connexion WebSocket à omegleweb.io:8443.
   * Retourne un Promise qui se résout quand le WS est prêt.
   */
  _connectWs() {
    return new Promise((resolve, reject) => {
      logger.info(`Connexion WS → ${this.config.wsUrl}`);

      const wsOptions = {
        headers: {
          'Cookie': this.cookieHeader,
          'User-Agent': this.userAgent,
          'Origin': this.config.targetUrl,
          'Referer': `${this.config.targetUrl}/chat`,
        },
        handshakeTimeout: 15000,
        rejectUnauthorized: false,
      };

      // Proxy résidentiel Geonode — masque l'IP datacenter Hetzner
      if (this._sharedProxy) {
        wsOptions.agent = new HttpsProxyAgent(this._sharedProxy.url);
      }

      this.ws = new WebSocket(this.config.wsUrl, wsOptions);
      this.wsReady = false;

      const timeout = setTimeout(() => {
        reject(new Error('WS connexion timeout (15s)'));
        try { this.ws.terminate(); } catch {}
      }, 20000);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        this.wsReady = true;
        logger.info('WebSocket connecté ✓');
        this._startHeartbeat();
        this._startPeopleOnlinePolling();
        resolve();
      });

      this.ws.on('message', (raw) => {
        this._handleMessage(raw.toString());
      });

      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        logger.error(`WS erreur: ${err.message}`);
        if (!this.wsReady) reject(err);
      });

      this.ws.on('close', (code, reason) => {
        this.wsReady = false;
        this._stopTimers();
        logger.info(`WS fermé — code: ${code}, raison: ${reason || '(none)'}`);
        // Reconnexion automatique avec backoff exponentiel (sauf arrêt volontaire)
        if (this.running && code !== 1000) {
          this._scheduleReconnect();
        }
      });
    });
  }

  /**
   * Planifie une reconnexion avec backoff exponentiel.
   */
  _scheduleReconnect() {
    const delay = RECONNECT_DELAYS_MS[Math.min(this._reconnectAttempts, RECONNECT_DELAYS_MS.length - 1)];
    this._reconnectAttempts++;
    logger.warn(`Reconnexion dans ${delay / 1000}s... (tentative #${this._reconnectAttempts})`);
    setTimeout(async () => {
      if (!this.running) return;
      try {
        await this._initCfCookies();
        await this._connectWs();
        this._reconnectAttempts = 0; // reset après succès
        this._findStranger();
      } catch (err) {
        logger.error(`Reconnexion échouée: ${err.message}`);
        if (this.running) this._scheduleReconnect();
      }
    }, delay);
  }

  /**
   * Ferme la connexion WS proprement.
   */
  _closeWs() {
    this._stopTimers();
    if (this.ws && this.wsReady) {
      try {
        this.ws.close(1000, 'Bot closing');
      } catch {}
    }
    this.ws = null;
    this.wsReady = false;
  }

  /**
   * Envoie un message WS encodé en JSON {channel, data}.
   */
  _emit(channel, data) {
    if (!this.wsReady || !this.ws) {
      logger.warn(`WS non prêt — emit ignoré: ${channel}`);
      return;
    }
    const payload = JSON.stringify({ channel, data });
    logger.debug(`WS EMIT → ${channel}: ${payload.substring(0, 120)}`);
    try {
      this.ws.send(payload);
    } catch (err) {
      logger.error(`WS send erreur: ${err.message}`);
    }
  }

  /**
   * Traite les messages entrants du serveur.
   */
  _handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      logger.warn(`WS message non-JSON: ${raw.substring(0, 100)}`);
      return;
    }

    const { channel, data } = msg;
    logger.debug(`WS RCV ← ${channel}: ${JSON.stringify(data).substring(0, 120)}`);

    switch (channel) {
      case 'heartbeat':
        // Silencieux
        break;

      case 'peopleOnline':
        if (data && data.count !== undefined) {
          logger.info(`Personnes en ligne: ${data.count}`);
        }
        break;

      case 'connected':
        // Serveur : stranger trouvé et connecté
        this._onConnected(data);
        break;

      case 'match':
        // Serveur : réponse au match (waiting / matched)
        this._onMatch(data);
        break;

      case 'message':
        this._onMessage(data);
        break;

      case 'typing':
        if (data === true) {
          logger.debug('Stranger est en train d\'écrire...');
        }
        break;

      case 'selfCountry':
        if (data) {
          logger.debug(`Notre pays détecté: ${data.countryName || data.country || 'inconnu'}`);
        }
        break;

      case 'peerCountry':
        if (data) {
          logger.info(`Stranger depuis: ${data.countryName || data.country || 'inconnu'}`);
        }
        break;

      case 'peerAFK':
        logger.info('Stranger inactif (AFK)');
        break;

      case 'peerActive':
        logger.info('Stranger revenu (actif)');
        break;

      case 'disconnect':
        this._onPeerDisconnect(data);
        break;

      case 'requireTurnstile':
        this._onRequireTurnstile(data);
        break;

      case 'challenge':
        this._onChallenge(data);
        break;

      case 'challengeFailed':
        logger.warn('Challenge échoué — abandon de la session');
        this.stats.totalChallenges++;
        this._emit('disconnect');
        this.isMatched = false;
        break;

      case 'banned_ip':
        logger.error(`IP bannie ! ${JSON.stringify(data)}`);
        this.stats.totalBanned++;
        this.running = false;
        break;

      default:
        logger.debug(`WS channel inconnu: ${channel}`);
    }
  }

  // ─────────────────────────────────────────────
  // TIMERS
  // ─────────────────────────────────────────────

  _startHeartbeat() {
    this._heartbeatTimer = setInterval(() => {
      this._emit('heartbeat', { timestamp: Date.now() });
    }, HEARTBEAT_INTERVAL_MS);
  }

  _startPeopleOnlinePolling() {
    this._peopleOnlineTimer = setInterval(() => {
      this._emit('peopleOnline');
    }, PEOPLE_ONLINE_INTERVAL_MS);
    // Immédiatement aussi
    this._emit('peopleOnline');
  }

  _stopTimers() {
    if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
    if (this._peopleOnlineTimer) { clearInterval(this._peopleOnlineTimer); this._peopleOnlineTimer = null; }
    if (this._typingTimer) { clearTimeout(this._typingTimer); this._typingTimer = null; }
  }

  // ─────────────────────────────────────────────
  // LOGIQUE DE MATCHING
  // ─────────────────────────────────────────────

  /**
   * Lance la recherche d'un stranger.
   */
  _findStranger() {
    logger.info('Recherche d\'un stranger...');
    this.isMatched = false;
    this.messageCount = 0;
    this.promoSent = false;
    this.awaitingReply = false;
    this.lastReceivedMessages = [];

    this._emit('match', {
      data: 'text',
      params: {
        interests: this.config.interests,
        preferSameCountry: this.config.preferSameCountry,
      },
    });
  }

  /**
   * Handler : serveur confirme la connexion avec un stranger.
   * Channel : 'connected' (envoyé par le serveur quand un pair est trouvé)
   */
  _onConnected(data) {
    if (this.isMatched) return;

    // Extraire le matchId si fourni par le serveur
    const matchId = (data && (data.matchId || data.match_id || data.id)) || null;

    // Détection auto-match bot-à-bot via le Set partagé
    if (matchId) {
      if (this._sharedMatchIds.has(matchId)) {
        logger.warn(`Auto-match détecté (matchId=${matchId}) — skip`);
        this._emit('disconnect');
        setTimeout(() => this._findStranger(), 500);
        return;
      }
      this._sharedMatchIds.add(matchId);
      this._currentMatchId = matchId;
    }

    this.isMatched = true;
    this.stats.totalConversations++;
    this.conversationCount++;
    logger.info(`=== Conversation #${this.conversationCount} — Stranger trouvé ! ===`);
    setTimeout(() => this._startConversation(), 3000);
  }

  /**
   * Handler : réponse au channel 'match' (peut indiquer WAITING ou état intermédiaire).
   */
  _onMatch(data) {
    // Le serveur peut envoyer match avec un statut WAITING avant 'connected'
    if (data && (data.status === 'WAITING' || data.waiting)) {
      logger.debug('En attente de match...');
      return;
    }
    // Certaines versions envoient match avec connected:true directement
    if (data && (data.matched || data.connected || data.connectedToStranger)) {
      this._onConnected(data);
      return;
    }
    logger.debug(`match event: ${JSON.stringify(data)}`);
  }

  /**
   * Séquence fixe : greeting → 8s → promo → 1.5s → skip
   */
  async _startConversation() {
    if (!this.isMatched) return;

    // 1. Greeting
    await this._sendMessage(pickRandom(GREETINGS));

    // 2. Attendre 8 secondes
    await this._delay(8000);
    if (!this.isMatched) return; // stranger peut avoir disconnecté

    // 3. Promo
    await this._sendMessage(pickRandom(PROMO_MESSAGES));
    this.stats.totalPromosDelivered++;

    // 4. Attendre 1.5s puis skip
    await this._delay(1500);
    await this._skipOrFinish('promo_done');
  }

  /**
   * Handler : message reçu du stranger.
   * On ne répond pas — on détecte uniquement les autres bots.
   */
  async _onMessage(data) {
    if (!this.isMatched) return;
    const text = typeof data === 'string' ? data : (data && data.message) || '';
    if (!text) return;

    logger.info(`Stranger: ${text}`);

    // Détection bot-à-bot : skip immédiat
    if (text.toLowerCase().includes('omefree.com')) {
      logger.info('Bot détecté (omefree.com dans le message) — skip immédiat');
      this.isMatched = false;
      this._emit('disconnect');
      await this._delay(500);
      if (this.running && this.conversationCount < this.config.maxConversations) {
        this._findStranger();
      } else {
        this.running = false;
      }
    }
    // Sinon : ignorer (le script de conversation tourne indépendamment via _startConversation)
  }

  /**
   * Déconnecte le stranger courant et cherche le prochain.
   */
  async _skipOrFinish(reason) {
    logger.info(`Skip (raison: ${reason})`);
    this.isMatched = false;
    // Libérer le matchId du Set partagé
    if (this._currentMatchId) {
      this._sharedMatchIds.delete(this._currentMatchId);
      this._currentMatchId = null;
    }
    this._emit('disconnect');

    if (this.running && this.conversationCount < this.config.maxConversations) {
      await this._delay(this.config.delayBetweenConversations);
      this._findStranger();
    } else {
      logger.info('Limite de conversations atteinte ou arrêt demandé.');
      this.running = false;
    }
  }

  /**
   * Handler : le stranger a déconnecté.
   */
  async _onPeerDisconnect(data) {
    if (!this.isMatched) return;
    logger.info('Stranger déconnecté.');
    this.isMatched = false;
    // Libérer le matchId
    if (this._currentMatchId) {
      this._sharedMatchIds.delete(this._currentMatchId);
      this._currentMatchId = null;
    }

    if (this.running && this.conversationCount < this.config.maxConversations) {
      await this._delay(1500 + Math.random() * 1000);
      this._findStranger();
    } else {
      this.running = false;
    }
  }

  // ─────────────────────────────────────────────
  // CAPTCHA / CHALLENGE
  // ─────────────────────────────────────────────

  /**
   * Le serveur demande un Turnstile CAPTCHA.
   * Sans navigateur → impossible de résoudre → reconnecter via nouvelles cookies.
   */
  _onRequireTurnstile(data) {
    this.stats.totalChallenges++;
    logger.warn(`Turnstile requis (total: ${this.stats.totalChallenges}) — reconnexion après délai...`);
    this._emit('disconnect');
    this.isMatched = false;

    if (this.running && this.conversationCount < this.config.maxConversations) {
      setTimeout(async () => {
        logger.info('Reconnexion WS après Turnstile...');
        this._closeWs();
        await this._delay(3000);
        try {
          cookiePool.invalidate(); // forcer renouvellement
          await this._initCfCookies();
          await this._connectWs();
          this._findStranger();
        } catch (err) {
          logger.error(`Reconnexion échouée: ${err.message}`);
          this.running = false;
        }
      }, 5000);
    }
  }

  /**
   * Challenge CF générique.
   */
  _onChallenge(data) {
    this.stats.totalChallenges++;
    logger.warn(`Challenge CF reçu: ${JSON.stringify(data)}`);
    // Même traitement que requireTurnstile
    this._onRequireTurnstile(data);
  }

  // ─────────────────────────────────────────────
  // ENVOI DE MESSAGES
  // ─────────────────────────────────────────────

  /**
   * Simule la frappe et envoie un message.
   * Typing delay = min(4000ms, 800ms + longueur × 40ms)
   */
  async _sendMessage(text) {
    if (!this.isMatched || !this.wsReady) return;

    const typingDelay = Math.min(4000, 800 + text.length * 40);

    this._emit('typing', true);
    await this._delay(typingDelay);

    if (!this.isMatched || !this.wsReady) return;

    logger.info(`Bot: ${text}`);
    this._emit('message', text);
    this.stats.totalMessagesSent++;

    await this._delay(200);
    this._emit('typing', false);
  }

  // ─────────────────────────────────────────────
  // BOUCLE PRINCIPALE
  // ─────────────────────────────────────────────

  /**
   * Lance le bot complet : init CF, connexion WS, boucle de conversations.
   */
  async run() {
    this.running = true;
    this.stats.startTime = Date.now();

    logger.info('=== WsBot démarré ===');
    logger.info(`Cible WS: ${this.config.wsUrl}`);
    logger.info(`Max conversations: ${this.config.maxConversations}`);

    try {
      // 1. Obtenir les cookies CF
      await this._initCfCookies();

      // 2. Connexion WS
      await this._connectWs();

      // 3. Lancer la recherche initiale
      this._findStranger();

      // 4. Maintenir la boucle jusqu'à arrêt
      await new Promise((resolve) => {
        const checkInterval = setInterval(() => {
          if (!this.running || !this.wsReady) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 1000);
      });

    } catch (err) {
      logger.error(`WsBot erreur fatale: ${err.message}`);
    } finally {
      this._closeWs();
      this._printStats();
    }
  }

  /**
   * Arrête proprement le bot.
   */
  stop() {
    logger.info('Arrêt WsBot demandé...');
    this.running = false;
    if (this.isMatched) {
      this._emit('disconnect');
    }
    this._closeWs();
  }

  /**
   * Affiche les statistiques finales.
   */
  _printStats() {
    const elapsed = Math.round((Date.now() - this.stats.startTime) / 1000);
    logger.info('=== STATISTIQUES ===');
    logger.info(`Durée totale    : ${elapsed}s`);
    logger.info(`Conversations   : ${this.stats.totalConversations}`);
    logger.info(`Messages envoyés: ${this.stats.totalMessagesSent}`);
    logger.info(`Promos délivrées: ${this.stats.totalPromosDelivered}`);
    logger.info(`Challenges CF   : ${this.stats.totalChallenges}`);
    logger.info(`Bans IP         : ${this.stats.totalBanned}`);
    logger.info('====================');
  }

  _delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}

module.exports = WsBot;
