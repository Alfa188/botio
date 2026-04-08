/**
 * BotIO - Bot de promotion pour OmeFree sur omegleweb.io
 *
 * Utilise Puppeteer avec le plugin stealth pour simuler un navigateur réel.
 * Interagit avec le text chat de omegleweb.io pour promouvoir omefree.com
 * de manière naturelle et empathique.
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');
const selectors = require('./selectors');
const CfSolver = require('./cf-solver');
const ProxyManager = require('./proxy');
const {
  GREETINGS,
  GREETING_RESPONSES,
  GENERIC_RESPONSES,
  TRANSITION_MESSAGES,
  PROMO_MESSAGES,
  CLOSING_MESSAGES,
  LONELINESS_RESPONSES,
  NEGATIVE_RESPONSES,
  QUESTION_RESPONSES,
  pickRandom,
  detectContext,
} = require('./messages');

puppeteer.use(StealthPlugin());

class OmegleBot {
  constructor(config) {
    this.config = {
      targetUrl: config.targetUrl || 'https://omegleweb.io',
      headless: config.headless !== undefined ? config.headless : false,
      minTypingDelay: config.minTypingDelay || 1500,
      maxTypingDelay: config.maxTypingDelay || 4000,
      messagesBeforePromo: config.messagesBeforePromo || 3,
      delayBetweenConversations: config.delayBetweenConversations || 5000,
      maxConversations: config.maxConversations || 50,
    };

    this.browser = null;
    this.page = null;
    this.conversationCount = 0;
    this.messageCount = 0;
    this.promoSent = false;
    this.isConnected = false;
    this.running = false;
    this.lastMessages = [];

    // Services
    this.cfSolver = new CfSolver();
    this.proxyManager = new ProxyManager();

    // Stats
    this.stats = {
      totalConversations: 0,
      totalMessagesSent: 0,
      totalPromosDelivered: 0,
      startTime: null,
    };
  }

  /**
   * Initialise le navigateur
   */
  async init() {
    logger.info('Initialisation du navigateur...');

    const screenshotDir = path.join(__dirname, '..', 'screenshots');
    const logDir = path.join(__dirname, '..', 'logs');
    if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

    // 1. Vérifier FlareSolverr
    const cfHealthy = await this.cfSolver.healthCheck();
    if (!cfHealthy) {
      logger.warn(`FlareSolverr inaccessible à ${this.cfSolver.baseUrl} — CF sera résolu par Puppeteer directement (plus lent)`);
    } else {
      logger.info('FlareSolverr OK ✓');
    }

    // 2. Récupérer proxy Geonode
    const proxy = this.proxyManager.getProxy();
    if (proxy) {
      logger.info(`Proxy : ${this.proxyManager.toString()}`);
    } else {
      logger.warn('Aucun proxy configuré (GEONODE_USERNAME manquant)');
    }

    // 3. Pré-résoudre Cloudflare via FlareSolverr (zéro coût pour Puppeteer)
    let cfCookies = [];
    let cfUserAgent = null;
    if (cfHealthy) {
      try {
        logger.info('Pré-résolution CF via FlareSolverr...');
        const cfResult = await this.cfSolver.getPuppeteerCookies(this.config.targetUrl, proxy);
        cfCookies = cfResult.cookies;
        cfUserAgent = cfResult.userAgent;
        logger.info(`CF résolu — ${cfCookies.length} cookies obtenus ✓`);
      } catch (err) {
        logger.warn(`FlareSolverr echec: ${err.message} — Puppeteer tentera directement`);
      }
    }

    // 4. Lancer Puppeteer avec args proxy
    const proxyArgs = this.proxyManager.getPuppeteerArgs();
    this.browser = await puppeteer.launch({
      headless: this.config.headless ? 'new' : false,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-web-security',
        '--window-size=1280,800',
        ...proxyArgs,
      ],
      defaultViewport: { width: 1280, height: 800 },
    });

    this.page = await this.browser.newPage();

    // 5. Authentification proxy si nécessaire
    const proxyCredentials = this.proxyManager.getPuppeteerCredentials();
    if (proxyCredentials) {
      await this.page.authenticate(proxyCredentials);
    }

    // 6. Injecter le User-Agent CF (cohérent avec les cookies)
    await this.page.setUserAgent(
      cfUserAgent ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // 7. Pré-injecter les cookies CF (évite le challenge au chargement)
    if (cfCookies.length > 0) {
      await this.page.setCookie(...cfCookies);
      logger.info('Cookies CF injectés dans Puppeteer ✓');
    }

    // Gérer les dialogues (alerts, confirms)
    this.page.on('dialog', async (dialog) => {
      logger.debug(`Dialog détecté: ${dialog.type()} - ${dialog.message()}`);
      await dialog.accept();
    });

    logger.info('Navigateur initialisé avec succès');
  }

  /**
   * Navigue vers la page cible
   */
  async navigateToTarget() {
    // Naviguer directement vers /chat (route confirmée, évite les redirections)
    const chatUrl = `${this.config.targetUrl}/chat`;
    logger.info(`Navigation vers ${chatUrl}...`);

    await this.page.goto(chatUrl, {
      waitUntil: 'load',
      timeout: 60000,
    });

    // Attendre que le JS challenge Cloudflare se résolve (peut prendre 10-15s)
    logger.info('Attente du chargement (Cloudflare)...');
    await this.delay(12000);

    // Si toujours sur la page CF, attendre encore
    const title = await this.page.title();
    if (title.includes('moment') || title.includes('Just a moment') || title.includes('Attention')) {
      logger.warn('CF challenge encore actif, attente supplémentaire (15s)...');
      await this.delay(15000);
    }

    // Prendre un screenshot pour debug
    await this.screenshot('01-landing-page');

    // Cliquer sur #agree-btn pour lancer initializeConnection() → ws.emit('match')
    await this.tryClick(selectors.agreeButton || selectors.acceptButton, 'bouton I Agree');

    await this.delay(2000);
    await this.screenshot('02-after-agree');
  }

  /**
   * Mode deep-discover — analyse le DOM à chaque étape du flow chat
   * 1. Page d'accueil → 2. Après clic #textbtn → 3. Chat actif → 4. Connecté
   */
  async deepDiscover() {
    logger.info('=== MODE DEEP-DISCOVER ===');

    await this.navigateToTarget();

    // Dump DOM étape 1 : page d'accueil
    logger.info('\n[ÉTAPE 1] Page d\'accueil');
    await this._dumpDom('step1-homepage');

    // Cliquer sur #textbtn (bouton Text Chat confirmé)
    logger.info('\n[ÉTAPE 2] Clic sur #textbtn...');
    try {
      await this.page.click('#textbtn');
      logger.info('#textbtn cliqué ✓');
    } catch (e) {
      logger.warn(`#textbtn non trouvé: ${e.message} — fallback sur img[alt="Text chat"]`);
      try {
        await this.page.click('img[alt="Text chat"]');
      } catch (e2) {
        logger.error(`Fallback aussi échoué: ${e2.message}`);
      }
    }

    await this.delay(4000);
    await this.screenshot('step2-after-textbtn');
    await this._dumpDom('step2-after-textbtn');

    // Chercher un bouton Start/Connect et cliquer
    logger.info('\n[ÉTAPE 3] Recherche du bouton Start/Connect...');
    const startSels = [
      '#textbtn', 'button', 'input[type="submit"]', 'input[type="button"]',
      'a[href="javascript:"]', '[onclick]',
    ];

    const allClickables = await this.page.evaluate(() => {
      const els = document.querySelectorAll('button, input[type="submit"], input[type="button"], a[href="javascript:"], [onclick]');
      return Array.from(els).map(el => ({
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || el.value || el.alt || '').trim().substring(0, 80),
        id: el.id,
        classes: el.className,
        type: el.type || '',
        onclick: (el.getAttribute('onclick') || '').substring(0, 80),
      })).filter(el => el.text || el.id || el.onclick);
    });

    logger.info(`Éléments cliquables trouvés: ${allClickables.length}`);
    allClickables.forEach((el, i) => {
      logger.info(`  [${i}] <${el.tag}> id="${el.id}" text="${el.text}" class="${el.classes.substring(0,50)}" onclick="${el.onclick}"`);
    });

    // Essayer de cliquer sur tout bouton qui ressemble à "Start"
    const startClicked = await this.page.evaluate(() => {
      const keywords = ['start', 'connect', 'find', 'new chat', 'text', 'go', 'begin'];
      const els = document.querySelectorAll('button, input[type="submit"], input[type="button"], [onclick]');
      for (const el of els) {
        const text = (el.textContent || el.value || '').toLowerCase().trim();
        if (keywords.some(kw => text.includes(kw))) {
          el.click();
          return `clicked: <${el.tagName}> text="${el.textContent.trim().substring(0,50)}"`;
        }
      }
      return null;
    });

    if (startClicked) {
      logger.info(`Start cliqué → ${startClicked}`);
    } else {
      logger.warn('Aucun bouton Start trouvé — peut-être déjà en attente de connexion');
    }

    await this.delay(5000);
    await this.screenshot('step3-after-start');
    await this._dumpDom('step3-after-start');

    // Attendre la connexion (30s) et surveiller les changements DOM
    logger.info('\n[ÉTAPE 4] Attente de connexion (30s)...');
    let bodyText = '';
    for (let i = 0; i < 30; i++) {
      const currentBody = await this.page.evaluate(() => document.body.textContent.toLowerCase());
      if (currentBody !== bodyText) {
        bodyText = currentBody;
        if (currentBody.includes('stranger') || currentBody.includes('connected') ||
            currentBody.includes('you\'re now') || currentBody.includes('looking for')) {
          logger.info(`→ Changement détecté à ${i}s: ${currentBody.substring(0, 120).replace(/\s+/g, ' ')}`);
          await this.screenshot(`step4-connection-${i}s`);
          await this._dumpDom(`step4-connection-${i}s`);
        }
      }
      await this.delay(1000);
    }

    // Dump final après connexion
    logger.info('\n[ÉTAPE 5] Dump DOM final (état connecté)');
    await this.screenshot('step5-final');
    await this._dumpDom('step5-final');

    // Analyser l'URL finale et les WebSockets JS
    const wsData = await this.page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script'));
      const wsUrls = [];
      scripts.forEach(s => {
        const m = (s.textContent || '').match(/(wss?:\/\/[^\s"'`]+)/g);
        if (m) wsUrls.push(...m);
      });
      return {
        url: window.location.href,
        title: document.title,
        wsUrls: [...new Set(wsUrls)],
      };
    });
    logger.info(`\nURL finale: ${wsData.url}`);
    logger.info(`WebSocket URLs: ${wsData.wsUrls.join(', ') || 'aucune'}`);

    logger.info('\n=== FIN DEEP-DISCOVER ===');
    logger.info('→ Consulter logs/deep-discover-*.json et screenshots/step*.png');
  }

  /**
   * Dump complet du DOM : tous les éléments interactifs + structure
   */
  async _dumpDom(label) {
    const fs = require('fs');
    const path = require('path');

    const data = await this.page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll(
        'button, input[type="submit"], input[type="button"], input[type="text"], input[type="search"], textarea, [onclick], [role="button"]'
      )).map(el => ({
        tag: el.tagName.toLowerCase(),
        id: el.id,
        classes: el.className,
        text: (el.textContent || el.value || el.placeholder || el.alt || '').trim().substring(0, 100),
        type: el.type || '',
        placeholder: el.placeholder || '',
        onclick: (el.getAttribute('onclick') || '').substring(0, 100),
        visible: el.offsetParent !== null,
        rect: (() => { try { const r = el.getBoundingClientRect(); return {x: r.x, y: r.y, w: r.width, h: r.height}; } catch { return null; } })(),
      }));

      // Tous les divs/sections avec ID ou classe potentiellement liée au chat
      const containers = Array.from(document.querySelectorAll('[id], [class]')).filter(el => {
        const s = (el.id + ' ' + el.className).toLowerCase();
        return /chat|message|log|stranger|talk|connect|input|send|box|wrap|convers|status|room/.test(s);
      }).map(el => ({
        tag: el.tagName.toLowerCase(),
        id: el.id,
        classes: el.className.substring(0, 100),
        children: el.children.length,
        text: el.textContent.trim().substring(0, 80),
        visible: el.offsetParent !== null,
      }));

      // Structure arborescente légère (3 niveaux depuis body)
      function tree(el, depth) {
        if (depth > 3) return null;
        const node = {
          tag: el.tagName.toLowerCase(),
          id: el.id || undefined,
          cls: (el.className || '').substring(0, 60) || undefined,
          children: [],
        };
        for (const child of el.children) {
          const sub = tree(child, depth + 1);
          if (sub) node.children.push(sub);
        }
        if (!node.id && !node.cls && node.children.length === 0) return null;
        return node;
      }

      return {
        url: window.location.href,
        title: document.title,
        bodyText: document.body.textContent.trim().substring(0, 500).replace(/\s+/g, ' '),
        buttons,
        containers,
        tree: tree(document.body, 0),
      };
    });

    const logDir = path.join(__dirname, '..', 'logs');
    const outPath = path.join(logDir, `deep-discover-${label}.json`);
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2));

    logger.info(`  DOM dump → logs/deep-discover-${label}.json`);
    logger.info(`  URL: ${data.url} | title: "${data.title}"`);
    logger.info(`  Éléments interactifs: ${data.buttons.length} | Conteneurs chat: ${data.containers.length}`);
    logger.info(`  Corps page: "${data.bodyText.substring(0, 150)}"`);

    if (data.containers.length > 0) {
      logger.info('  Conteneurs chat:');
      data.containers.forEach((c, i) => {
        logger.info(`    [${i}] <${c.tag}> id="${c.id}" class="${c.classes.substring(0,50)}" children=${c.children} visible=${c.visible}`);
      });
    }
  }

  /**
   * Mode découverte - analyse le DOM et fait des screenshots
   * Utile pour identifier les sélecteurs corrects
   */
  async discover() {
    logger.info('=== MODE DÉCOUVERTE ===');

    await this.navigateToTarget();

    // Log le titre de la page
    const title = await this.page.title();
    logger.info(`Titre de la page: ${title}`);

    // Log l'URL actuelle
    logger.info(`URL actuelle: ${this.page.url()}`);

    // Chercher tous les boutons
    const buttons = await this.page.evaluate(() => {
      const btns = document.querySelectorAll('button, a, [role="button"]');
      return Array.from(btns).map((btn) => ({
        tag: btn.tagName,
        text: btn.textContent.trim().substring(0, 100),
        classes: btn.className,
        id: btn.id,
        href: btn.href || '',
      }));
    });
    logger.info(`Boutons trouvés (${buttons.length}):`);
    buttons.forEach((btn, i) => {
      logger.info(`  [${i}] <${btn.tag}> text="${btn.text}" class="${btn.classes}" id="${btn.id}" href="${btn.href}"`);
    });

    // Chercher les inputs
    const inputs = await this.page.evaluate(() => {
      const inps = document.querySelectorAll('input, textarea');
      return Array.from(inps).map((inp) => ({
        tag: inp.tagName,
        type: inp.type,
        placeholder: inp.placeholder,
        classes: inp.className,
        id: inp.id,
      }));
    });
    logger.info(`Inputs trouvés (${inputs.length}):`);
    inputs.forEach((inp, i) => {
      logger.info(`  [${i}] <${inp.tag}> type="${inp.type}" placeholder="${inp.placeholder}" class="${inp.classes}" id="${inp.id}"`);
    });

    // Log la structure générale
    const structure = await this.page.evaluate(() => {
      function getStructure(el, depth = 0) {
        if (depth > 3) return '';
        const indent = '  '.repeat(depth);
        let result = `${indent}<${el.tagName.toLowerCase()}`;
        if (el.id) result += ` id="${el.id}"`;
        if (el.className && typeof el.className === 'string')
          result += ` class="${el.className.substring(0, 80)}"`;
        result += '>\n';
        for (const child of el.children) {
          result += getStructure(child, depth + 1);
        }
        return result;
      }
      return getStructure(document.body);
    });

    const structFile = path.join(__dirname, '..', 'logs', 'dom-structure.txt');
    fs.writeFileSync(structFile, structure);
    logger.info(`Structure DOM sauvegardée dans ${structFile}`);

    await this.screenshot('discovery-final');
    logger.info('=== FIN MODE DÉCOUVERTE ===');
    logger.info('Inspectez les screenshots et logs/dom-structure.txt pour identifier les sélecteurs');
  }

  /**
   * Lance le bot en mode chat
   */
  async run() {
    this.running = true;
    this.stats.startTime = new Date();

    logger.info('Démarrage du bot...');

    await this.navigateToTarget();

    // Essayer d'accéder au text chat
    await this.tryClick(selectors.textChatButton, 'bouton text chat');
    await this.delay(3000);
    await this.screenshot('03-text-chat-page');

    // Boucle principale
    while (this.running && this.conversationCount < this.config.maxConversations) {
      try {
        await this.startNewConversation();
      } catch (error) {
        logger.error(`Erreur dans la conversation: ${error.message}`);
        await this.screenshot(`error-conv-${this.conversationCount}`);
        await this.delay(this.config.delayBetweenConversations);
      }
    }

    this.printStats();
    logger.info('Bot arrêté.');
  }

  /**
   * Démarre une nouvelle conversation
   */
  async startNewConversation() {
    this.conversationCount++;
    this.messageCount = 0;
    this.promoSent = false;
    this.lastMessages = [];

    logger.info(`--- Conversation #${this.conversationCount} ---`);

    // Cliquer sur Start / New Chat
    const started = await this.tryClick(selectors.startButton, 'bouton start');
    if (!started) {
      // Essayer le bouton next aussi
      await this.tryClick(selectors.nextButton, 'bouton next');
    }

    // Attendre la connexion avec un partenaire
    logger.info('Attente de connexion avec un partenaire...');
    const connected = await this.waitForConnection(30000);

    if (!connected) {
      logger.warn('Pas de connexion établie, on passe au suivant...');
      return;
    }

    this.isConnected = true;
    logger.info('Partenaire connecté!');
    this.stats.totalConversations++;

    // Attendre un peu puis envoyer un message d'ouverture
    await this.delay(this.randomDelay(1000, 2000));
    await this.sendMessage(pickRandom(GREETINGS));

    // Boucle de conversation
    await this.conversationLoop();

    // Attendre avant la prochaine conversation
    logger.info(`Attente ${this.config.delayBetweenConversations}ms avant la prochaine conversation...`);
    await this.delay(this.config.delayBetweenConversations);
  }

  /**
   * Boucle principale d'une conversation
   */
  async conversationLoop() {
    const maxDuration = 120000; // 2 minutes max par conversation
    const startTime = Date.now();

    while (this.isConnected && Date.now() - startTime < maxDuration) {
      // Vérifier si le partenaire s'est déconnecté
      const disconnected = await this.checkDisconnection();
      if (disconnected) {
        logger.info('Le partenaire s\'est déconnecté.');
        this.isConnected = false;
        break;
      }

      // Lire les nouveaux messages
      const newMessages = await this.getNewMessages();

      if (newMessages.length > 0) {
        for (const msg of newMessages) {
          logger.info(`Stranger: ${msg}`);
          await this.handleStrangerMessage(msg);
        }
      }

      // Vérifier si c'est le moment de promouvoir
      if (!this.promoSent && this.messageCount >= this.config.messagesBeforePromo) {
        await this.sendPromotion();
      }

      await this.delay(2000);
    }

    // Si on n'a pas encore envoyé la promo et qu'on est toujours connecté
    if (!this.promoSent && this.isConnected) {
      await this.sendPromotion();
    }

    // Message de clôture si toujours connecté
    if (this.isConnected) {
      await this.sendMessage(pickRandom(CLOSING_MESSAGES));
      await this.delay(2000);
    }
  }

  /**
   * Traite un message du partenaire
   */
  async handleStrangerMessage(message) {
    const context = detectContext(message);
    await this.delay(this.randomDelay(this.config.minTypingDelay, this.config.maxTypingDelay));

    let response;

    switch (context) {
      case 'negative':
        response = pickRandom(NEGATIVE_RESPONSES);
        await this.sendMessage(response);
        this.isConnected = false; // On arrête la conversation
        return;

      case 'loneliness':
        response = pickRandom(LONELINESS_RESPONSES);
        this.promoSent = true;
        this.stats.totalPromosDelivered++;
        break;

      case 'greeting':
        response = pickRandom(GREETING_RESPONSES);
        break;

      case 'question':
        response = pickRandom(QUESTION_RESPONSES);
        break;

      default:
        response = pickRandom(GENERIC_RESPONSES);
        break;
    }

    await this.sendMessage(response);
  }

  /**
   * Envoie le message promotionnel
   */
  async sendPromotion() {
    if (this.promoSent) return;

    // D'abord un message de transition
    await this.sendMessage(pickRandom(TRANSITION_MESSAGES));
    await this.delay(this.randomDelay(2000, 4000));

    // Puis le message promo
    await this.sendMessage(pickRandom(PROMO_MESSAGES));
    this.promoSent = true;
    this.stats.totalPromosDelivered++;

    logger.info('Message promotionnel envoyé!');
  }

  /**
   * Envoie un message dans le chat
   */
  async sendMessage(text) {
    try {
      // Trouver le champ de saisie
      const inputSelector = await this.findElement(selectors.messageInput);
      if (!inputSelector) {
        logger.warn('Champ de saisie non trouvé');
        return false;
      }

      // Cliquer sur le champ
      await this.page.click(inputSelector);
      await this.delay(200);

      // Taper le message avec un délai réaliste entre les caractères
      await this.page.type(inputSelector, text, {
        delay: this.randomDelay(30, 80),
      });

      // Trouver et cliquer sur le bouton envoyer, ou utiliser Enter
      const sendClicked = await this.tryClick(selectors.sendButton, null);
      if (!sendClicked) {
        await this.page.keyboard.press('Enter');
      }

      this.messageCount++;
      this.stats.totalMessagesSent++;
      this.lastMessages.push({ from: 'bot', text });
      logger.info(`Bot: ${text}`);

      return true;
    } catch (error) {
      logger.error(`Erreur envoi message: ${error.message}`);
      return false;
    }
  }

  /**
   * Récupère les nouveaux messages du partenaire
   */
  async getNewMessages() {
    try {
      const messages = await this.page.evaluate((selectorList) => {
        for (const sel of selectorList) {
          try {
            const elements = document.querySelectorAll(sel);
            if (elements.length > 0) {
              return Array.from(elements).map((el) => el.textContent.trim());
            }
          } catch {}
        }
        return [];
      }, selectors.strangerMessage);

      // Filtrer les messages déjà vus
      const knownMessages = this.lastMessages
        .filter((m) => m.from === 'stranger')
        .map((m) => m.text);

      const newMessages = messages.filter((m) => m && !knownMessages.includes(m));

      for (const msg of newMessages) {
        this.lastMessages.push({ from: 'stranger', text: msg });
      }

      return newMessages;
    } catch {
      return [];
    }
  }

  /**
   * Attend qu'un partenaire soit connecté
   */
  async waitForConnection(timeout) {
    const start = Date.now();

    while (Date.now() - start < timeout) {
      try {
        const connected = await this.page.evaluate((indicators) => {
          const body = document.body.textContent.toLowerCase();
          const keywords = ['connected', 'stranger', 'you are now chatting', 'chat started'];
          return keywords.some((kw) => body.includes(kw));
        }, selectors.connectedIndicator);

        if (connected) return true;
      } catch {}

      await this.delay(1000);
    }

    return false;
  }

  /**
   * Vérifie si le partenaire s'est déconnecté
   */
  async checkDisconnection() {
    try {
      return await this.page.evaluate(() => {
        const body = document.body.textContent.toLowerCase();
        const keywords = ['disconnected', 'has left', 'stranger has disconnected', 'chat ended'];
        return keywords.some((kw) => body.includes(kw));
      });
    } catch {
      return false;
    }
  }

  /**
   * Tente de cliquer sur un élément en essayant plusieurs sélecteurs
   */
  async tryClick(selectorList, description) {
    for (const selector of selectorList) {
      try {
        // Essayer d'abord les sélecteurs CSS standards
        if (!selector.includes(':has-text')) {
          const element = await this.page.$(selector);
          if (element) {
            await element.click();
            if (description) logger.debug(`Cliqué: ${description} (${selector})`);
            return true;
          }
        } else {
          // Pour les sélecteurs :has-text, faire une recherche manuelle
          const textToFind = selector.match(/:has-text\("(.+?)"\)/)?.[1];
          if (textToFind) {
            const clicked = await this.page.evaluate((text) => {
              const elements = document.querySelectorAll('button, a, [role="button"], input[type="submit"]');
              for (const el of elements) {
                if (el.textContent.toLowerCase().includes(text.toLowerCase())) {
                  el.click();
                  return true;
                }
              }
              return false;
            }, textToFind);
            if (clicked) {
              if (description) logger.debug(`Cliqué: ${description} (text: ${textToFind})`);
              return true;
            }
          }
        }
      } catch {}
    }

    if (description) logger.debug(`Non trouvé: ${description}`);
    return false;
  }

  /**
   * Trouve le premier élément correspondant dans une liste de sélecteurs
   */
  async findElement(selectorList) {
    for (const selector of selectorList) {
      try {
        if (!selector.includes(':has-text')) {
          const element = await this.page.$(selector);
          if (element) return selector;
        }
      } catch {}
    }
    return null;
  }

  /**
   * Prend un screenshot
   */
  async screenshot(name) {
    try {
      const screenshotPath = path.join(__dirname, '..', 'screenshots', `${name}.png`);
      await this.page.screenshot({ path: screenshotPath, fullPage: true });
      logger.debug(`Screenshot: ${screenshotPath}`);
    } catch (error) {
      logger.debug(`Erreur screenshot: ${error.message}`);
    }
  }

  /**
   * Affiche les statistiques
   */
  printStats() {
    const duration = this.stats.startTime
      ? Math.round((Date.now() - this.stats.startTime) / 1000 / 60)
      : 0;

    logger.info('=== STATISTIQUES ===');
    logger.info(`Durée: ${duration} minutes`);
    logger.info(`Conversations: ${this.stats.totalConversations}`);
    logger.info(`Messages envoyés: ${this.stats.totalMessagesSent}`);
    logger.info(`Promos délivrées: ${this.stats.totalPromosDelivered}`);
    logger.info('====================');
  }

  /**
   * Utilitaires
   */
  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  randomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /**
   * Arrêt propre
   */
  async stop() {
    this.running = false;
    logger.info('Arrêt du bot...');
    this.printStats();
    if (this.browser) {
      await this.browser.close();
    }
  }
}

module.exports = OmegleBot;
