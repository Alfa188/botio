require('dotenv').config();

const HOST = process.env.PROXY_HOST || 'proxy.geonode.io';
const PORT = parseInt(process.env.PROXY_PORT || '9001');
// PROXY_USER should be just the API key, e.g. "geonode_H6SiyhkU7c"
// Strip any legacy suffix if present
const API_KEY = (process.env.PROXY_USER || '').replace(/-type-\w+/g, '').replace(/-session-.*/, '');
const PASS = process.env.PROXY_PASS || '';

let counter = 0;

function generateSession() {
  counter++;
  const id = `botio${Date.now()}${counter}`;
  // Rotating proxy: just use the API key (no -session- suffix).
  // Each new TCP connection to Geonode gets a fresh residential IP.
  return {
    id,
    host: HOST,
    port: PORT,
    user: API_KEY,
    pass: PASS,
    url: `http://${encodeURIComponent(API_KEY)}:${encodeURIComponent(PASS)}@${HOST}:${PORT}`,
  };
}

module.exports = { generateSession };
