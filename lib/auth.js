'use strict';
const crypto = require('crypto');

const SECRET = process.env.SESSION_SECRET || (() => {
  if (process.env.NODE_ENV === 'production') {
    console.error('Falta SESSION_SECRET en producción. Define un texto largo y aleatorio.');
    process.exit(1);
  }
  console.warn('SESSION_SECRET no definido: usando uno temporal (las sesiones se pierden al reiniciar).');
  return crypto.randomBytes(32).toString('hex');
})();
const COOKIE = 'ndm_s';
const DAYS = 30;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return 's1$' + salt.toString('hex') + '$' + hash.toString('hex');
}
function verifyPassword(pw, stored) {
  try {
    const [v, saltHex, hashHex] = String(stored).split('$');
    if (v !== 's1') return false;
    const expect = Buffer.from(hashHex, 'hex');
    const got = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), expect.length);
    return crypto.timingSafeEqual(expect, got);
  } catch (e) { return false; }
}
const sign = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
function makeToken(username) {
  const body = Buffer.from(JSON.stringify({ u: username, exp: Date.now() + DAYS * 864e5 })).toString('base64url');
  return body + '.' + sign(body);
}
function readToken(tok) {
  if (!tok || tok.indexOf('.') < 0) return null;
  const [body, sig] = tok.split('.');
  const good = sign(body);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try {
    const o = JSON.parse(Buffer.from(body, 'base64url').toString());
    return o.exp > Date.now() ? o.u : null;
  } catch (e) { return null; }
}
function parseCookies(req) {
  const o = {};
  String(req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return o;
}
function setSession(req, res, username) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `${COOKIE}=${makeToken(username)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DAYS * 86400}${secure ? '; Secure' : ''}`);
}
function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
const tokenOf = (req) => readToken(parseCookies(req)[COOKIE]);

/* ---- permisos por rol ----
   admin  : todo, y gestiona usuarios
   editor : todo en los datos
   chofer : no escribe directamente en ninguna colección. Solo guarda un checklist
            (con sus fotos, kilometraje y pendientes) por POST /api/checklist, y solo lee lo mínimo
            para llenarlo (ver server.js → forChofer). */
const COLS = new Set(['vehicles', 'kmlog', 'checklists', 'fotos', 'settings']);
function canWrite(role, col, id, op) {
  if (col === 'settings' && id === 'alertState') return false; // lo maneja el servidor
  return role === 'admin' || role === 'editor';
}

module.exports = { hashPassword, verifyPassword, setSession, clearSession, tokenOf, canWrite, COLS };
