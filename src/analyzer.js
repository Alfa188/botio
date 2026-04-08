/**
 * DOM Analyzer — Sans navigateur (zero Puppeteer)
 *
 * Flux :
 *   1. FlareSolverr résout le challenge Cloudflare → retourne HTML brut
 *   2. Cheerio parse le HTML (comme jQuery côté serveur)
 *   3. On extrait : boutons, inputs, structure DOM, WebSocket URLs, etc.
 *   4. Résultat sauvegardé dans logs/ pour configurer les sélecteurs CSS
 *
 * Coût serveur : ~0 (juste HTTP → FlareSolverr, pas de Chrome par instance)
 */

const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const CfSolver = require('./cf-solver');
const ProxyManager = require('./proxy');

class DomAnalyzer {
  constructor() {
    this.solver = new CfSolver();
    this.proxyManager = new ProxyManager();
    this.logsDir = path.join(__dirname, '..', 'logs');

    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }
  }

  /**
   * Analyse le DOM d'une URL et retourne tous les éléments interactifs
   */
  async analyze(url = process.env.TARGET_URL || 'https://omegleweb.io') {
    // Vérifier FlareSolverr
    logger.info('Vérification de FlareSolverr...');
    const healthy = await this.solver.healthCheck();
    if (!healthy) {
      throw new Error(
        `FlareSolverr inaccessible à ${this.solver.baseUrl}\n` +
        `Lance-le avec : docker run -d -p 8191:8191 ghcr.io/flaresolverr/flaresolverr:latest`
      );
    }
    logger.info('FlareSolverr OK ✓');

    const proxy = this.proxyManager.getProxy();
    if (proxy) {
      logger.info(`Proxy : ${this.proxyManager.toString()}`);
    } else {
      logger.warn('Aucun proxy configuré — connexion directe (GEONODE_USERNAME manquant)');
    }

    // Pages à analyser
    // Note: /text retourne un 502 (page chargée dynamiquement via JS, pas une route SSR)
    const pages = [url];
    const results = {};

    for (const pageUrl of pages) {
      logger.info(`\nAnalyse : ${pageUrl}`);
      try {
        const pageResult = await this.analyzePage(pageUrl, proxy);
        results[pageUrl] = pageResult;
      } catch (err) {
        logger.error(`Erreur sur ${pageUrl}: ${err.message}`);
        results[pageUrl] = { error: err.message };
      }
    }

    // Sauvegarder les résultats
    this.saveResults(results);

    return results;
  }

  /**
   * Analyse une page spécifique
   */
  async analyzePage(url, proxy) {
    logger.info('Résolution Cloudflare via FlareSolverr...');
    const { html, cookies, userAgent, status, finalUrl } = await this.solver.getPageHtml(url, proxy);

    logger.info(`Status HTTP: ${status} — URL finale: ${finalUrl}`);

    const $ = cheerio.load(html);

    // --- Boutons et liens cliquables ---
    const buttons = [];
    $('button, a[href], [role="button"], input[type="submit"], input[type="button"]').each((_, el) => {
      const $el = $(el);
      const entry = {
        tag: el.tagName.toLowerCase(),
        text: $el.text().trim().replace(/\s+/g, ' ').substring(0, 150),
        id: $el.attr('id') || '',
        classes: $el.attr('class') || '',
        href: $el.attr('href') || '',
        dataAttrs: {},
      };
      // Récupérer les data-* attributes
      Object.keys(el.attribs || {})
        .filter((k) => k.startsWith('data-'))
        .forEach((k) => {
          entry.dataAttrs[k] = el.attribs[k];
        });
      if (entry.text || entry.id || entry.classes) {
        buttons.push(entry);
      }
    });

    // --- Champs de saisie ---
    const inputs = [];
    $('input, textarea, [contenteditable="true"]').each((_, el) => {
      const $el = $(el);
      inputs.push({
        tag: el.tagName.toLowerCase(),
        type: $el.attr('type') || 'text',
        id: $el.attr('id') || '',
        name: $el.attr('name') || '',
        placeholder: $el.attr('placeholder') || '',
        classes: $el.attr('class') || '',
        required: $el.attr('required') !== undefined,
        dataAttrs: Object.fromEntries(
          Object.keys(el.attribs || {})
            .filter((k) => k.startsWith('data-'))
            .map((k) => [k, el.attribs[k]])
        ),
      });
    });

    // --- Divs / sections avec des IDs ou classes significatives ---
    const containers = [];
    $('[id], [class]').each((_, el) => {
      const $el = $(el);
      const id = $el.attr('id') || '';
      const cls = ($el.attr('class') || '').substring(0, 100);
      const keywords = /chat|message|send|stranger|talk|connect|text|video|room|stream|log/i;
      if (keywords.test(id) || keywords.test(cls)) {
        containers.push({
          tag: el.tagName.toLowerCase(),
          id,
          classes: cls,
          childCount: $el.children().length,
        });
      }
    });

    // --- Scripts inline (pour trouver les URLs WebSocket / API) ---
    const scriptUrls = [];
    const wsUrls = [];
    const apiEndpoints = [];

    $('script').each((_, el) => {
      const src = $(el).attr('src');
      if (src) scriptUrls.push(src);

      const content = $(el).html() || '';
      // WebSocket URLs
      const wsMatches = content.match(/(wss?:\/\/[^\s"'`]+)/g) || [];
      wsUrls.push(...wsMatches);
      // API endpoints
      const apiMatches = content.match(/["'`](\/api\/[^\s"'`]+)["'`]/g) || [];
      apiMatches.forEach((m) => apiEndpoints.push(m.replace(/["'`]/g, '')));
    });

    // --- Meta / titre ---
    const meta = {
      title: $('title').text().trim(),
      description: $('meta[name="description"]').attr('content') || '',
      framework: detectFramework($, html),
    };

    return {
      url,
      finalUrl,
      status,
      userAgent,
      cookies: cookies.map((c) => c.name),
      meta,
      buttons,
      inputs,
      containers,
      scripts: { external: scriptUrls, webSockets: [...new Set(wsUrls)], apiEndpoints: [...new Set(apiEndpoints)] },
      rawHtmlSize: html.length,
    };
  }

  /**
   * Sauvegarde les résultats d'analyse
   */
  saveResults(results) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    // JSON complet
    const jsonPath = path.join(this.logsDir, `dom-analysis-${timestamp}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));
    logger.info(`\nRésultats JSON : ${jsonPath}`);

    // Rapport lisible
    const reportLines = ['=== DOM ANALYSIS REPORT ===', `Date: ${new Date().toISOString()}`, ''];

    for (const [url, data] of Object.entries(results)) {
      reportLines.push(`\n## ${url}`);

      if (data.error) {
        reportLines.push(`  ERREUR: ${data.error}`);
        continue;
      }

      reportLines.push(`  Titre   : ${data.meta.title}`);
      reportLines.push(`  Status  : ${data.status}`);
      reportLines.push(`  URL fin : ${data.finalUrl}`);
      reportLines.push(`  Framework: ${data.meta.framework}`);
      reportLines.push(`  Cookies  : ${data.cookies.join(', ')}`);
      reportLines.push(`  HTML size: ${Math.round(data.rawHtmlSize / 1024)}KB`);

      reportLines.push('\n  --- BOUTONS ---');
      data.buttons.forEach((b, i) => {
        const selector = b.id ? `#${b.id}` : b.classes ? `.${b.classes.split(' ')[0]}` : b.tag;
        reportLines.push(`  [${i}] <${b.tag}> selector="${selector}" text="${b.text.substring(0, 60)}" href="${b.href}"`);
        if (Object.keys(b.dataAttrs).length) {
          reportLines.push(`       data-attrs: ${JSON.stringify(b.dataAttrs)}`);
        }
      });

      reportLines.push('\n  --- INPUTS ---');
      data.inputs.forEach((inp, i) => {
        const selector = inp.id ? `#${inp.id}` : inp.name ? `[name="${inp.name}"]` : `${inp.tag}[type="${inp.type}"]`;
        reportLines.push(`  [${i}] selector="${selector}" placeholder="${inp.placeholder}"`);
      });

      reportLines.push('\n  --- CONTENEURS CHAT (mots-clés détectés) ---');
      data.containers.forEach((c, i) => {
        const selector = c.id ? `#${c.id}` : `.${c.classes.split(' ')[0]}`;
        reportLines.push(`  [${i}] <${c.tag}> selector="${selector}" children=${c.childCount}`);
      });

      if (data.scripts.webSockets.length) {
        reportLines.push('\n  --- WEBSOCKET URLS ---');
        data.scripts.webSockets.forEach((ws) => reportLines.push(`  ${ws}`));
      }

      if (data.scripts.apiEndpoints.length) {
        reportLines.push('\n  --- API ENDPOINTS ---');
        data.scripts.apiEndpoints.forEach((ep) => reportLines.push(`  ${ep}`));
      }
    }

    // Suggestion de sélecteurs
    reportLines.push('\n\n=== SÉLECTEURS SUGGÉRÉS ===');
    reportLines.push('Copie ces valeurs dans src/selectors.js :\n');
    reportLines.push('(Analyse les entrées ci-dessus pour choisir les plus pertinents)');

    const reportPath = path.join(this.logsDir, 'dom-report.txt');
    fs.writeFileSync(reportPath, reportLines.join('\n'));
    logger.info(`Rapport texte  : ${reportPath}`);

    this.printSummary(results);
  }

  printSummary(results) {
    logger.info('\n========== RÉSUMÉ ==========');
    for (const [url, data] of Object.entries(results)) {
      if (data.error) {
        logger.error(`${url} → ERREUR: ${data.error}`);
        continue;
      }
      logger.info(`${url}`);
      logger.info(`  titre    : "${data.meta.title}"`);
      logger.info(`  framework: ${data.meta.framework}`);
      logger.info(`  boutons  : ${data.buttons.length}`);
      logger.info(`  inputs   : ${data.inputs.length}`);
      logger.info(`  ws urls  : ${data.scripts.webSockets.length}`);
      logger.info(`  cookies CF: ${data.cookies.join(', ')}`);
    }
    logger.info('=============================');
    logger.info('→ Consulte logs/dom-report.txt pour les détails');
  }
}

/**
 * Détecte le framework front-end utilisé
 */
function detectFramework($, html) {
  if (html.includes('__nuxt') || html.includes('_nuxt')) return 'Nuxt.js (Vue)';
  if (html.includes('__next') || html.includes('_next')) return 'Next.js (React)';
  if (html.includes('ng-version') || html.includes('ng-app')) return 'Angular';
  if (html.includes('data-reactroot') || html.includes('react')) return 'React';
  if (html.includes('data-v-') || html.includes('vue')) return 'Vue.js';
  if (html.includes('svelte')) return 'Svelte';
  if ($('script[src*="socket.io"]').length > 0) return 'Socket.IO (vanilla)';
  return 'Inconnu / SSR';
}

module.exports = DomAnalyzer;
