'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const store = require('./lib/store');
const auth = require('./lib/auth');
const alerts = require('./lib/alerts');
const checklist = require('./lib/checklist');
const { seedIfEmpty } = require('./lib/seed');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use('/api/checklist', express.json({ limit: '25mb' })); // trae las fotos del checklist
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

const PUB = path.join(__dirname, 'public');
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

/* ---------- sesión ---------- */
async function loadUser(req, res, next) {
  const u = auth.tokenOf(req);
  req.user = u ? await store.getUser(u) : null;
  next();
}
app.use(wrap(loadUser));
const needUser = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'No autenticado' }));
const needRole = (...roles) => (req, res, next) => (req.user && roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Sin permiso' }));

/* ---------- salud ---------- */
app.get('/health', wrap(async (req, res) => { await store.ping(); res.json({ ok: true }); }));

/* ---------- login ---------- */
const attempts = new Map();
function throttled(ip) {
  const now = Date.now(), a = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60000);
  attempts.set(ip, a);
  return a.length >= 10;
}
app.post('/api/login', wrap(async (req, res) => {
  const ip = req.ip;
  if (throttled(ip)) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
  const username = String((req.body && req.body.username) || '').trim().toLowerCase();
  const password = String((req.body && req.body.password) || '');
  const u = username ? await store.getUser(username) : null;
  if (!u || !auth.verifyPassword(password, u.pass)) {
    attempts.get(ip).push(Date.now());
    return res.status(401).json({ error: 'Usuario o clave incorrectos' });
  }
  auth.setSession(req, res, u.username);
  res.json({ ok: true, role: u.role, name: u.name });
}));
app.post('/api/logout', (req, res) => { auth.clearSession(res); res.json({ ok: true }); });
app.get('/api/me', needUser, (req, res) => res.json({ username: req.user.username, name: req.user.name, role: req.user.role }));

/* ---------- datos (equivale a la base de datos que usa la página) ---------- */
const clients = new Set();
function broadcast(col, id) {
  const msg = `data: ${JSON.stringify({ col, id })}\n\n`;
  clients.forEach((r) => r.write(msg));
}
function validate(req, res) {
  const { col, id } = req.params;
  if (!auth.COLS.has(col) || !/^[\w.-]{1,80}$/.test(id || 'x')) { res.status(400).json({ error: 'Ruta inválida' }); return false; }
  return true;
}
/* El chofer solo lee lo mínimo para llenar el checklist: nombre y patente de los vehículos, su último
   kilometraje y la lista de nombres. Nada más (ni papeles, ni historial, ni otros checklists). */
function forChofer(col, id, data) {
  if (col === 'vehicles') return { nombre: data.nombre, patente: data.patente, order: data.order };
  if (col === 'kmlog') {
    let last = null; ((data && data.entries) || []).forEach((x) => { if (!last || x.d >= last.d) last = x; });
    return { entries: last ? [last] : [] };
  }
  if (col === 'settings' && id === 'personal') return data;
  return undefined;
}
app.get('/api/col/:col', needUser, wrap(async (req, res) => {
  if (!auth.COLS.has(req.params.col)) return res.status(400).json({ error: 'Ruta inválida' });
  const rows = await store.list(req.params.col);
  if (req.user.role !== 'chofer') return res.json(rows);
  res.json(rows.map((r) => ({ id: r.id, data: forChofer(req.params.col, r.id, r.data) })).filter((r) => r.data !== undefined));
}));
app.get('/api/doc/:col/:id', needUser, wrap(async (req, res) => {
  if (!validate(req, res)) return;
  const chofer = req.user.role === 'chofer';
  if (chofer && forChofer(req.params.col, req.params.id, {}) === undefined) return res.status(403).json({ error: 'Sin permiso' });
  let d = await store.get(req.params.col, req.params.id);
  if (chofer && d != null) d = forChofer(req.params.col, req.params.id, d);
  if (d == null) return res.status(404).json({ error: 'No existe' });
  res.json({ data: d });
}));
function bodyData(req, res) {
  const d = req.body && req.body.data;
  if (!d || typeof d !== 'object' || Array.isArray(d)) { res.status(400).json({ error: 'Datos inválidos' }); return null; }
  if (JSON.stringify(d).length > 256 * 1024) { res.status(413).json({ error: 'Documento demasiado grande' }); return null; }
  return d;
}
const touchAlerts = (col) => { if (col === 'kmlog' || col === 'vehicles' || col === 'settings') alerts.checkSoon(); };

app.put('/api/doc/:col/:id', needUser, wrap(async (req, res) => {
  if (!validate(req, res)) return;
  const { col, id } = req.params;
  if (!auth.canWrite(req.user.role, col, id, 'set')) return res.status(403).json({ error: 'Sin permiso' });
  const d = bodyData(req, res); if (!d) return;
  await store.set(col, id, d); broadcast(col, id); touchAlerts(col); res.json({ ok: true });
}));
app.patch('/api/doc/:col/:id', needUser, wrap(async (req, res) => {
  if (!validate(req, res)) return;
  const { col, id } = req.params;
  const d = bodyData(req, res); if (!d) return;
  if (!auth.canWrite(req.user.role, col, id, 'update', Object.keys(d))) return res.status(403).json({ error: 'Sin permiso' });
  if (!(await store.merge(col, id, d))) return res.status(404).json({ error: 'No existe' });
  broadcast(col, id); touchAlerts(col); res.json({ ok: true });
}));
app.delete('/api/doc/:col/:id', needUser, wrap(async (req, res) => {
  if (!validate(req, res)) return;
  const { col, id } = req.params;
  if (!auth.canWrite(req.user.role, col, id, 'delete')) return res.status(403).json({ error: 'Sin permiso' });
  await store.del(col, id); broadcast(col, id); res.json({ ok: true });
}));

/* Guardar un checklist completo (documento, fotos, kilometraje, pendientes y nombres). Lo puede usar cualquier rol. */
app.post('/api/checklist', needUser, wrap(async (req, res) => {
  try {
    const r = await checklist.save(req.body, broadcast);
    alerts.checkSoon(); res.json(Object.assign({ ok: true }, r));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    throw e;
  }
}));

app.get('/api/events', needUser, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  clients.add(res);
  const ka = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ka); clients.delete(res); });
});

/* ---------- alertas por correo ---------- */
app.get('/api/alerts/status', needUser, needRole('admin', 'editor'), wrap(async (req, res) => {
  const { cfg, alerts: al } = await alerts.buildAlerts();
  res.json({ mail: alerts.mailReady(), to: alerts.recipients(cfg).join(', '), active: al.length });
}));
app.post('/api/alerts/send', needUser, needRole('admin', 'editor'), wrap(async (req, res) => {
  const { cfg, alerts: al } = await alerts.buildAlerts();
  const to = alerts.recipients(cfg);
  if (!to.length) return res.status(400).json({ error: 'Falta al menos un correo que reciba las alertas (pestaña Alertas).' });
  if (!alerts.mailReady()) return res.status(400).json({ error: 'El servidor aún no tiene configurado el envío de correo (variable BREVO_API_KEY o SMTP_* en Railway).' });
  const m = alerts.message(al);
  try { await alerts.sendMail(to, m.subject, m.text); } catch (e) { return res.status(502).json({ error: 'No se pudo enviar: ' + e.message }); }
  res.json({ ok: true, to: to.join(', '), alerts: al.length });
}));

/* ---------- usuarios (solo administrador) ---------- */
const ROLES = ['admin', 'editor', 'chofer'];
const validUser = (u) => /^[a-z0-9._-]{3,40}$/.test(u);
app.get('/api/users', needUser, needRole('admin'), wrap(async (req, res) => res.json(await store.listUsers())));
app.post('/api/users', needUser, needRole('admin'), wrap(async (req, res) => {
  const b = req.body || {};
  const username = String(b.username || '').trim().toLowerCase(), name = String(b.name || '').trim(), role = b.role, pw = String(b.password || '');
  if (!validUser(username)) return res.status(400).json({ error: 'Usuario: 3 a 40 caracteres, solo letras minúsculas, números, punto, guion.' });
  if (!name) return res.status(400).json({ error: 'Falta el nombre.' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Rol inválido.' });
  if (pw.length < 8) return res.status(400).json({ error: 'La clave debe tener al menos 8 caracteres.' });
  if (await store.getUser(username)) return res.status(409).json({ error: 'Ese usuario ya existe.' });
  await store.createUser(username, name, role, auth.hashPassword(pw));
  res.json({ ok: true });
}));
app.patch('/api/users/:u', needUser, needRole('admin'), wrap(async (req, res) => {
  const u = req.params.u, b = req.body || {}, f = {};
  const cur = await store.getUser(u); if (!cur) return res.status(404).json({ error: 'No existe.' });
  if (b.name != null) { if (!String(b.name).trim()) return res.status(400).json({ error: 'Nombre vacío.' }); f.name = String(b.name).trim(); }
  if (b.role != null) {
    if (!ROLES.includes(b.role)) return res.status(400).json({ error: 'Rol inválido.' });
    if (cur.role === 'admin' && b.role !== 'admin' && (await store.countAdmins()) <= 1) return res.status(400).json({ error: 'Debe quedar al menos un administrador.' });
    f.role = b.role;
  }
  if (b.password != null) { if (String(b.password).length < 8) return res.status(400).json({ error: 'La clave debe tener al menos 8 caracteres.' }); f.pass = auth.hashPassword(String(b.password)); }
  await store.updateUser(u, f); res.json({ ok: true });
}));
app.delete('/api/users/:u', needUser, needRole('admin'), wrap(async (req, res) => {
  const cur = await store.getUser(req.params.u); if (!cur) return res.status(404).json({ error: 'No existe.' });
  if (cur.username === req.user.username) return res.status(400).json({ error: 'No puedes borrar tu propio usuario.' });
  if (cur.role === 'admin' && (await store.countAdmins()) <= 1) return res.status(400).json({ error: 'Debe quedar al menos un administrador.' });
  await store.deleteUser(cur.username); res.json({ ok: true });
}));

/* ---------- páginas ---------- */
const sendPage = (file) => (req, res) => res.sendFile(path.join(PUB, file));
app.get(['/', '/index.html'], (req, res) => (req.user ? sendPage('index.html')(req, res) : res.redirect('/login.html')));
app.get('/admin.html', (req, res) => (req.user && req.user.role === 'admin' ? sendPage('admin.html')(req, res) : res.redirect('/')));
app.get('/login.html', sendPage('login.html'));
app.use(express.static(PUB, { index: false, extensions: [], setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=300') }));
app.use('/api', (req, res) => res.status(404).json({ error: 'No existe' }));

app.use((err, req, res, next) => { // eslint-disable-line
  console.error(err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Error del servidor' });
});

async function bootstrapAdmin() {
  if ((await store.countUsers()) > 0) return;
  const username = (process.env.ADMIN_USER || 'admin').toLowerCase();
  let pw = process.env.ADMIN_PASSWORD;
  if (!pw) {
    pw = crypto.randomBytes(9).toString('base64url');
    console.log(`\n>>> No hay ADMIN_PASSWORD. Se creó el usuario "${username}" con la clave temporal: ${pw}\n>>> Entra y cámbiala en /admin.html\n`);
  }
  await store.createUser(username, process.env.ADMIN_NAME || 'Administrador', 'admin', auth.hashPassword(pw));
  console.log(`Usuario administrador creado: ${username}`);
}

(async () => {
  await store.init();
  await bootstrapAdmin();
  await seedIfEmpty();
  alerts.schedule();
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`NDM Flota escuchando en el puerto ${port}`));
})().catch((e) => { console.error('No se pudo iniciar:', e); process.exit(1); });

module.exports = app;
