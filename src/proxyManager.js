require('dotenv').config();

const HOST = process.env.PROXY_HOST || 'proxy.geonode.io';
const PORT = parseInt(process.env.PROXY_PORT || '9001');
const USER_BASE = process.env.PROXY_USER || '';
const PASS = process.env.PROXY_PASS || '';

let counter = 0;

function generateSession() {
  counter++;
  // Geonode sticky session: append -session-XXXX to the username
  // Each unique session ID maps to a unique residential IP
  const id = `botio${Date.now()}${counter}`;
  const user = `${USER_BASE}-session-${id}`;
  return {
    id,
    host: HOST,
    port: PORT,
    user,
    pass: PASS,
    url: `http://${encodeURIComponent(user)}:${encodeURIComponent(PASS)}@${HOST}:${PORT}`,
  };
}

module.exports = { generateSession };
