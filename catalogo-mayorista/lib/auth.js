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
const COOKIE = 'cat_s';
const DAYS = 14;

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
function makeToken(uid) {
  const body = Buffer.from(JSON.stringify({ u: uid, exp: Date.now() + DAYS * 864e5 })).toString('base64url');
  return body + '.' + sign(body);
}
function readToken(tok) {
  if (!tok || tok.indexOf('.') < 0) return null;
  const [body, sig] = tok.split('.');
  const good = sign(body);
  if (!sig || sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
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
function setSession(req, res, uid) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `${COOKIE}=${makeToken(uid)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DAYS * 86400}${secure ? '; Secure' : ''}`);
}
function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
const uidOf = (req) => readToken(parseCookies(req)[COOKIE]);

// Clave temporal legible (sin 0/O/1/l/I)
function tempPassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (const b of crypto.randomBytes(8)) s += abc[b % abc.length];
  return s;
}

module.exports = { hashPassword, verifyPassword, setSession, clearSession, uidOf, tempPassword };
