/**
 * Selectors - Sélecteurs DOM confirmés pour omegleweb.io
 *
 * Tous les sélecteurs ci-dessous ont été confirmés via analyse DOM directe
 * de la page /chat (FlareSolverr + Cheerio + décodage chat.js obfusqué).
 * Mise à jour : 2026-04-08
 *
 * Channels WebSocket confirmés (wss://omegleweb.io:8443) :
 *   Emit  :  match({data:'text', params:{interests:[], preferSameCountry:bool}})
 *            disconnect()
 *            typing(bool)
 *            message({message:string})
 *            peopleOnline()
 *            challengeComplete({token:string})
 *   Receive: match, disconnect, typing, message, peerCountry, peerAFK,
 *            peerActive, requireTurnstile, challenge, challengeFailed,
 *            bannedIp, peopleOnline, heartbeat
 */

module.exports = {
  // Page d'accueil — bouton Text Chat (confirmé)
  textChatButton: [
    '#textbtn',               // <img id="textbtn">
    '#chattypetextcell img',  // fallback
  ],

  // Intérêts (page d'accueil, optionnel)
  interestsInput: [
    'input.newtopicinput',
    'input[type="text"]',
  ],

  // Bouton "I Agree" — déclenche initializeConnection() → ws.emit('match')
  agreeButton: [
    '#agree-btn',
  ],

  // Alias pour compatibilité avec bot.js (tryClick)
  acceptButton: [
    '#agree-btn',
  ],

  // Input de message (confirmé : placeholder "Type a message...")
  messageInput: [
    '#message-input',
  ],

  // Bouton d'envoi (confirmé)
  sendButton: [
    '#send-btn',
  ],

  // Bouton Skip (confirmé)
  skipButton: [
    '#skip-btn',
  ],

  // Zone de messages complète (confirmé)
  chatMessages: [
    '#messages',
    '#message-area',
  ],

  // Message reçu du stranger (confirmé : classe .strange)
  strangerMessage: [
    '.strange',
  ],

  // Message envoyé par soi (confirmé : classe .you)
  ownMessage: [
    '.you',
  ],

  // Indicateur "Stranger is typing..." (confirmé : div#typing)
  typingIndicator: [
    '#typing',
  ],

  // Statut connexion en cours (confirmé)
  connectingStatus: [
    '.message-status.connecting-status',
  ],

  // Statut recherche stranger (confirmé)
  lookingStatus: [
    '.message-status.looking-status',
    '.message-status.looking-status',
  ],

  // Conteneur Turnstile CAPTCHA (confirmé)
  turnstileContainer: [
    '#challenge-container',
    '#turnstileContainer',
  ],

  // Widget Turnstile intégré
  turnstileWidget: [
    '#turnstile-widget',
    'iframe[src*="challenges.cloudflare.com"]',
    'iframe[src*="turnstile"]',
  ],

  // Bouton "New Stranger" (après déconnexion)
  newStrangerButton: [
    '#newConnectBtn',
    'button.new-stranger-btn',
  ],
};
