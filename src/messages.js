/**
 * Messages du bot OmeFree
 *
 * Flow : greeting → 8s → promo → skip
 */

// Salutations initiales (1 choisie aléatoirement)
const GREETINGS = [
  'sup',
  'hi',
  'hey',
  'heyyy',
  'hii',
  'yo',
  'f',
  'F',
  'hey :)',
  'hi :)',
];

// Messages promo (1 choisi aléatoirement)
const PROMO_MESSAGES = [
  'everyone here is male lol.. omefree.com has way more girls just saying',
  'omefree.com > this 😭',
  'ngl omefree.com is way better for actually meeting people',
  'this site is dead rn.. omefree.com is where everyone moved to',
];

/**
 * Retourne un élément aléatoire d'un tableau
 */
function pickRandom(array) {
  return array[Math.floor(Math.random() * array.length)];
}

module.exports = {
  GREETINGS,
  PROMO_MESSAGES,
  pickRandom,
};
