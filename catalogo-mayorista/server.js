'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const db = require('./lib/db');
const auth = require('./lib/auth');
const { makeClient } = require('./lib/bsale');
const { makeDrive, loadCredentials } = require('./lib/drive');
const { runSync, getKv, state: syncState } = require('./lib/sync');
const { cleanProfile, REGIONES } = require('./lib/profile');
const { emailOk, waNumber, matches, clp } = require('./lib/util');

const ROLES = ['admin', 'vendedor', 'mayorista'];
const ESTADOS = ['nuevo', 'revision', 'confirmado', 'rechazado', 'cancelado'];
const PENDIENTES = ['nuevo', 'revision']; // pedidos que "reservan" stock
const MAX_LINEAS = 100, MAX_QTY = 9999;
// En Bsale cada variante ya es un juego (4 llantas): su precio es por juego y su stock está en juegos.
// JUEGO_UNIDADES solo sirve para mostrar cuántas llantas trae el pedido.
const JUEGO = Math.max(1, parseInt(process.env.JUEGO_UNIDADES, 10) || 4);
const precioJuego = (p) => Math.round(p);

function createApp(pool, opts = {}) {
  const app = express();
  const empresa = process.env.EMPRESA || 'Repuestos del Maule';
  const cacheDir = path.resolve(opts.cacheDir || process.env.CACHE_DIR || './cache');
  const q = (t, p) => pool.query(t, p);
  let drive = opts.drive || null;
  let bsale = opts.bsale || null;
  let orderLock = Promise.resolve(); // un pedido a la vez (evita pasarse del stock)

  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '200kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    if (req.method !== 'GET' && req.method !== 'HEAD' && !req.is('json')) return res.status(415).json({ error: 'Se esperaba JSON' });
    next();
  });
  app.get('/health', async (req, res) => { try { await q('select 1'); res.json({ ok: true }); } catch (e) { res.status(500).json({ ok: false }); } });

  /* ---------- sesión ---------- */
  const attempts = new Map();
  const tooMany = (key) => { const a = attempts.get(key); return a && a.n >= 8 && Date.now() - a.t < 15 * 60000; };
  const fail = (key) => { const a = attempts.get(key); attempts.set(key, a && Date.now() - a.t < 15 * 60000 ? { n: a.n + 1, t: a.t } : { n: 1, t: Date.now() }); };

  async function loadUser(req, res, next) {
    const uid = auth.uidOf(req);
    if (!uid) return res.status(401).json({ error: 'Inicia sesión' });
    const r = await q('SELECT u.*, c.completed AS perfil_ok FROM users u LEFT JOIN customers c ON c.user_id=u.id WHERE u.id=$1', [uid]);
    const u = r.rows[0];
    if (!u || !u.active) { auth.clearSession(res); return res.status(401).json({ error: 'Inicia sesión' }); }
    req.user = u;
    next();
  }
  // Mientras no cambie su clave (y, si es mayorista, no complete sus datos) solo puede hacer eso
  const gate = (req, res, next) => {
    const u = req.user;
    if (u.must_change) return res.status(403).json({ error: 'Primero cambia tu clave', paso: 'clave' });
    if (u.role === 'mayorista' && !u.perfil_ok) return res.status(403).json({ error: 'Primero completa tus datos', paso: 'perfil' });
    next();
  };
  const only = (...roles) => (req, res, next) => (roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Sin permiso' }));
  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => { console.error(e); res.status(500).json({ error: 'Error del servidor' }); });

  app.post('/api/login', wrap(async (req, res) => {
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    const pw = String((req.body || {}).password || '');
    const key = req.ip + '|' + email;
    if (tooMany(key)) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
    const r = await q('SELECT * FROM users WHERE email=$1', [email]);
    const u = r.rows[0];
    if (!u || !u.active || !auth.verifyPassword(pw, u.pass)) { fail(key); return res.status(401).json({ error: 'Correo o clave incorrectos' }); }
    attempts.delete(key);
    auth.setSession(req, res, u.id);
    res.json({ ok: true });
  }));
  app.post('/api/logout', (req, res) => { auth.clearSession(res); res.json({ ok: true }); });

  async function meInfo(u) {
    const out = { id: u.id, nombre: u.name, email: u.email, rol: u.role, telefono: u.phone, cambiarClave: u.must_change, empresa, juego: JUEGO };
    if (u.role === 'mayorista') {
      out.perfilCompleto = !!u.perfil_ok;
      const s = u.seller_id ? (await q('SELECT name, phone FROM users WHERE id=$1', [u.seller_id])).rows[0] : null;
      out.vendedor = s ? { nombre: s.name, telefono: s.phone } : null;
    }
    return out;
  }
  app.get('/api/me', loadUser, wrap(async (req, res) => res.json(await meInfo(req.user))));

  app.post('/api/clave', loadUser, wrap(async (req, res) => {
    const { actual, nueva } = req.body || {};
    if (!auth.verifyPassword(String(actual || ''), req.user.pass)) return res.status(400).json({ error: 'La clave actual no coincide' });
    if (typeof nueva !== 'string' || nueva.length < 8) return res.status(400).json({ error: 'La clave nueva debe tener al menos 8 caracteres' });
    if (nueva === actual) return res.status(400).json({ error: 'Elige una clave distinta a la actual' });
    await q('UPDATE users SET pass=$1, must_change=false WHERE id=$2', [auth.hashPassword(nueva), req.user.id]);
    res.json({ ok: true });
  }));

  /* ---------- datos del cliente (facturación y despacho) ---------- */
  app.get('/api/perfil', loadUser, only('mayorista'), wrap(async (req, res) => {
    const r = await q('SELECT data, completed FROM customers WHERE user_id=$1', [req.user.id]);
    res.json({ datos: r.rows[0] ? r.rows[0].data : {}, completo: !!(r.rows[0] && r.rows[0].completed), regiones: REGIONES });
  }));
  app.put('/api/perfil', loadUser, only('mayorista'), wrap(async (req, res) => {
    if (req.user.must_change) return res.status(403).json({ error: 'Primero cambia tu clave', paso: 'clave' });
    const c = cleanProfile(req.body);
    if (!c.ok) return res.status(400).json({ error: 'Revisa los datos marcados', campos: c.errors });
    await q(`INSERT INTO customers(user_id,data,completed,updated_at) VALUES($1,$2,true,now())
             ON CONFLICT (user_id) DO UPDATE SET data=EXCLUDED.data, completed=true, updated_at=now()`, [req.user.id, JSON.stringify(c.data)]);
    res.json({ ok: true });
  }));

  /* ---------- catálogo ---------- */
  async function reservedMap() {
    const r = await q(`SELECT i.sku, SUM(i.qty) AS n FROM order_items i JOIN orders o ON o.id=i.order_id
                       WHERE o.estado IN ('nuevo','revision') GROUP BY i.sku`);
    return new Map(r.rows.map((x) => [x.sku, Number(x.n)])); // juegos apartados por pedidos nuevos o en revisión
  }
  // El stock real nunca sale del servidor: solo "max", el tope que se puede pedir.
  // Orden: por diámetro de aro (el catálogo se muestra separado por aro) y luego por nombre.
  const aroNum = (p) => (p.aro ? Number(p.aro) : 999);
  async function visibleProducts() {
    const [rows, res] = await Promise.all([
      q('SELECT sku,name,category,medida,aro,ancho,pcd,et,price,stock FROM products WHERE hidden=false AND stock>0 AND price>0'),
      reservedMap(),
    ]);
    return rows.rows.map((p) => Object.assign(p, { max: Math.min(MAX_QTY, p.stock - (res.get(p.sku) || 0)) })).filter((p) => p.max > 0)
      .sort((a, b) => aroNum(a) - aroNum(b) || a.name.localeCompare(b.name, 'es', { numeric: true }));
  }
  app.get('/api/productos', loadUser, gate, wrap(async (req, res) => {
    const { q: busca = '', cat = '', aro = '', pcd = '' } = req.query;
    const page = Math.max(1, parseInt(req.query.pagina, 10) || 1), per = 24;
    const all = await visibleProducts();
    const cats = [...new Set(all.map((p) => p.category).filter(Boolean))].sort();
    const pcds = [...new Set(all.map((p) => p.pcd).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es', { numeric: true }));
    const base = all.filter((p) => (!cat || p.category === cat) && (!pcd || p.pcd === pcd) && matches(p.sku + ' ' + p.name + ' ' + p.medida, String(busca)));
    // cuántos modelos hay en cada aro con los demás filtros aplicados (para las fichas de aro)
    const count = new Map(); base.forEach((p) => count.set(p.aro, (count.get(p.aro) || 0) + 1));
    const aros = [...count].map(([a, n]) => ({ aro: a, n })).sort((x, y) => (x.aro ? Number(x.aro) : 999) - (y.aro ? Number(y.aro) : 999));
    const list = base.filter((p) => !aro || p.aro === (aro === 'otros' ? '' : aro));
    const slice = list.slice((page - 1) * per, page * per);
    const ph = slice.length ? (await q(`SELECT sku,file_id FROM photos WHERE sku IN (${slice.map((_, i) => '$' + (i + 1)).join(',')}) ORDER BY sku,pos`, slice.map((p) => p.sku))).rows : [];
    const items = slice.map((p) => ({
      sku: p.sku, nombre: p.name, categoria: p.category, medida: p.medida, aro: p.aro, ancho: p.ancho, pcd: p.pcd, et: p.et,
      precio: precioJuego(p.price), max: p.max,
      fotos: ph.filter((x) => x.sku === p.sku).map((x) => '/api/foto/' + x.file_id),
    }));
    res.json({ items, total: list.length, pagina: page, paginas: Math.max(1, Math.ceil(list.length / per)), categorias: cats, pcds, aros });
  }));

  // Foto de Drive (solo las que están en el catálogo y con sesión iniciada), guardada en disco para no llamar a Google cada vez
  app.get('/api/foto/:id', loadUser, wrap(async (req, res) => {
    const id = String(req.params.id);
    if (!/^[A-Za-z0-9_-]{10,100}$/.test(id)) return res.status(404).end();
    if (!(await q('SELECT 1 FROM photos WHERE file_id=$1', [id])).rows[0]) return res.status(404).end();
    const file = path.join(cacheDir, id);
    let buf;
    try { buf = await fs.promises.readFile(file); } catch (e) {
      if (!drive) return res.status(404).end();
      try { buf = (await drive.download(id)).buf; } catch (err) { return res.status(502).end(); }
      try { await fs.promises.mkdir(cacheDir, { recursive: true }); await fs.promises.writeFile(file, buf); } catch (e2) { /* sin caché */ }
    }
    const type = buf[0] === 0x89 ? 'image/png' : buf.slice(0, 4).toString() === 'RIFF' ? 'image/webp' : 'image/jpeg';
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(buf);
  }));

  /* ---------- pedidos ---------- */
  function waLink(order, seller) {
    const n = waNumber(seller && seller.phone);
    if (!n) return '';
    const c = order.cliente || {};
    const lines = order.items.map((i) => `• ${i.sku} — ${i.name} × ${i.qty} ${i.qty === 1 ? 'juego' : 'juegos'}`).join('\n');
    const msg = `Hola ${seller.name}, soy ${c.contacto_nombre || c.razon_social}${c.razon_social ? ' (' + c.razon_social + ')' : ''}.\nAcabo de enviar el pedido ${order.codigo} en el catálogo:\n${lines}\nTotal referencial: ${clp(order.total)} IVA incluido.`;
    return 'https://wa.me/' + n + '?text=' + encodeURIComponent(msg);
  }
  const code = (id) => 'P-' + String(id).padStart(5, '0');
  async function loadOrder(id) {
    const o = (await q('SELECT o.*, s.name AS seller_name, s.phone AS seller_phone FROM orders o LEFT JOIN users s ON s.id=o.seller_id WHERE o.id=$1', [id])).rows[0];
    if (!o) return null;
    return shape(o, (await q('SELECT sku,name,qty,price FROM order_items WHERE order_id=$1 ORDER BY id', [id])).rows);
  }
  function shape(o, items) {
    const its = items.map((i) => ({ sku: i.sku, name: i.name, qty: i.qty, precio: Math.round(i.price), subtotal: Math.round(i.price * i.qty) }));
    return {
      id: o.id, codigo: code(o.id), estado: o.estado, fecha: o.created_at, actualizado: o.updated_at, notas: o.notes, notaInterna: o.internal_note,
      cliente: o.customer, vendedor: { id: o.seller_id, nombre: o.seller_name, telefono: o.seller_phone },
      items: its, juegos: its.reduce((s, i) => s + i.qty, 0), unidades: its.reduce((s, i) => s + i.qty, 0) * JUEGO, total: its.reduce((s, i) => s + i.subtotal, 0),
    };
  }
  // Cada rol ve solo lo suyo: admin todo · vendedor los de sus clientes · mayorista los propios
  function scope(u, alias = 'o') {
    if (u.role === 'admin') return { sql: 'true', params: [] };
    if (u.role === 'vendedor') return { sql: `${alias}.seller_id=$1`, params: [u.id] };
    return { sql: `${alias}.customer_id=$1`, params: [u.id] };
  }
  async function ordersFor(u, extraSql, extraParams) {
    const sc = scope(u);
    const params = sc.params.concat(extraParams || []);
    const rows = (await q(`SELECT o.*, s.name AS seller_name, s.phone AS seller_phone FROM orders o LEFT JOIN users s ON s.id=o.seller_id
                           WHERE ${sc.sql}${extraSql ? ' AND ' + extraSql.replace(/\$(\d+)/g, (m, n) => '$' + (Number(n) + sc.params.length)) : ''} ORDER BY o.id DESC LIMIT 300`, params)).rows;
    if (!rows.length) return [];
    const its = (await q(`SELECT order_id,sku,name,qty,price FROM order_items WHERE order_id IN (${rows.map((_, i) => '$' + (i + 1)).join(',')}) ORDER BY id`, rows.map((r) => r.id))).rows;
    return rows.map((o) => shape(o, its.filter((i) => i.order_id === o.id)));
  }

  app.post('/api/pedidos', loadUser, gate, only('mayorista'), wrap(async (req, res) => {
    const u = req.user;
    const seller = u.seller_id ? (await q('SELECT id,name,phone FROM users WHERE id=$1 AND active=true', [u.seller_id])).rows[0] : null;
    if (!seller) return res.status(409).json({ error: 'Aún no tienes un vendedor asignado. Avísale a ' + empresa + '.' });
    const raw = Array.isArray((req.body || {}).items) ? req.body.items : [];
    const want = new Map();
    for (const it of raw) {
      const sku = String(it && it.sku || '').trim().toUpperCase(), n = Number(it && it.qty);
      if (!sku || !Number.isInteger(n) || n < 1 || n > MAX_QTY) return res.status(400).json({ error: 'Cantidad no válida en ' + (sku || 'un producto') });
      want.set(sku, (want.get(sku) || 0) + n);
    }
    if (!want.size) return res.status(400).json({ error: 'El pedido está vacío' });
    if (want.size > MAX_LINEAS) return res.status(400).json({ error: 'Máximo ' + MAX_LINEAS + ' productos por pedido' });
    const notes = String((req.body || {}).notas || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    const cust = (await q('SELECT data FROM customers WHERE user_id=$1', [u.id])).rows[0].data;
    const cliente = Object.assign({}, cust, { nombre_usuario: u.name, email: u.email });

    // un pedido a la vez: revisa el stock y lo guarda sin que otro se cuele en el medio
    const job = orderLock.then(async () => {
      const skus = [...want.keys()];
      const prods = (await q(`SELECT sku,name,price,stock,hidden FROM products WHERE sku IN (${skus.map((_, i) => '$' + (i + 1)).join(',')})`, skus)).rows;
      const resv = await reservedMap();
      const problemas = [];
      for (const sku of skus) {
        const p = prods.find((x) => x.sku === sku);
        const max = p && !p.hidden && p.price > 0 ? p.stock - (resv.get(sku) || 0) : 0;
        if (!p || max <= 0) problemas.push({ sku, nombre: p ? p.name : sku, max: 0 });
        else if (want.get(sku) > max) problemas.push({ sku, nombre: p.name, max });
      }
      if (problemas.length) return { problemas };
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const o = (await client.query('INSERT INTO orders(customer_id,seller_id,notes,customer) VALUES($1,$2,$3,$4) RETURNING id', [u.id, seller.id, notes, JSON.stringify(cliente)])).rows[0];
        for (const sku of skus) {
          const p = prods.find((x) => x.sku === sku);
          await client.query('INSERT INTO order_items(order_id,sku,name,qty,price) VALUES($1,$2,$3,$4,$5)', [o.id, sku, p.name, want.get(sku), precioJuego(p.price)]); // qty en juegos, precio por juego
        }
        await client.query('COMMIT');
        return { id: o.id };
      } catch (e) { try { await client.query('ROLLBACK'); } catch (x) { /* nada */ } throw e; } finally { client.release(); }
    });
    orderLock = job.catch(() => {});
    const r = await job;
    if (r.problemas) return res.status(409).json({ error: 'Algunos productos ya no tienen esa cantidad disponible', problemas: r.problemas });
    const order = await loadOrder(r.id);
    res.json({ ok: true, pedido: order, whatsapp: waLink(order, seller) });
  }));

  app.get('/api/pedidos', loadUser, gate, wrap(async (req, res) => {
    const estado = ESTADOS.includes(req.query.estado) ? req.query.estado : '';
    res.json({ items: await ordersFor(req.user, estado ? 'o.estado=$1' : '', estado ? [estado] : []) });
  }));
  app.get('/api/pedidos/resumen', loadUser, gate, wrap(async (req, res) => {
    const sc = scope(req.user);
    const r = await q(`SELECT estado, COUNT(*) AS n FROM orders o WHERE ${sc.sql} GROUP BY estado`, sc.params);
    const out = {}; r.rows.forEach((x) => { out[x.estado] = Number(x.n); });
    res.json(out);
  }));
  app.get('/api/pedidos/:id', loadUser, gate, wrap(async (req, res) => {
    const l = await ordersFor(req.user, 'o.id=$1', [parseInt(req.params.id, 10) || 0]);
    if (!l[0]) return res.status(404).json({ error: 'Pedido no encontrado' });
    const seller = { name: l[0].vendedor.nombre, phone: l[0].vendedor.telefono };
    res.json({ pedido: l[0], whatsapp: req.user.role === 'mayorista' ? waLink(l[0], seller) : '' });
  }));
  app.patch('/api/pedidos/:id', loadUser, gate, only('admin', 'vendedor'), wrap(async (req, res) => {
    const l = await ordersFor(req.user, 'o.id=$1', [parseInt(req.params.id, 10) || 0]);
    if (!l[0]) return res.status(404).json({ error: 'Pedido no encontrado' });
    const b = req.body || {};
    const sets = [], p = [];
    if (b.estado !== undefined) {
      if (!['revision', 'confirmado', 'rechazado'].includes(b.estado)) return res.status(400).json({ error: 'Estado no válido' });
      if (l[0].estado === 'cancelado') return res.status(409).json({ error: 'El cliente canceló este pedido' });
      p.push(b.estado); sets.push('estado=$' + p.length);
    }
    if (b.notaInterna !== undefined) { p.push(String(b.notaInterna).slice(0, 500)); sets.push('internal_note=$' + p.length); }
    if (!sets.length) return res.status(400).json({ error: 'Nada que cambiar' });
    p.push(l[0].id);
    await q(`UPDATE orders SET ${sets.join(',')}, updated_at=now() WHERE id=$${p.length}`, p);
    res.json({ ok: true, pedido: await loadOrder(l[0].id) });
  }));
  app.post('/api/pedidos/:id/cancelar', loadUser, gate, only('mayorista'), wrap(async (req, res) => {
    const l = await ordersFor(req.user, 'o.id=$1', [parseInt(req.params.id, 10) || 0]);
    if (!l[0]) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (l[0].estado !== 'nuevo') return res.status(409).json({ error: 'Solo se puede cancelar un pedido que aún no está en revisión. Habla con tu vendedor.' });
    await q("UPDATE orders SET estado='cancelado', updated_at=now() WHERE id=$1", [l[0].id]);
    res.json({ ok: true });
  }));

  /* ---------- administración ---------- */
  const admin = [loadUser, gate, only('admin')];
  const userRow = (u) => ({ id: u.id, email: u.email, nombre: u.name, rol: u.role, telefono: u.phone, activo: u.active, vendedorId: u.seller_id, vendedor: u.seller_name || null,
    cambiarClave: u.must_change, perfilCompleto: u.role === 'mayorista' ? !!u.perfil_ok : null, razonSocial: u.razon || null, creado: u.created_at });
  app.get('/api/admin/usuarios', ...admin, wrap(async (req, res) => {
    const r = await q(`SELECT u.*, s.name AS seller_name, c.completed AS perfil_ok, c.data->>'razon_social' AS razon
                       FROM users u LEFT JOIN users s ON s.id=u.seller_id LEFT JOIN customers c ON c.user_id=u.id ORDER BY u.role, u.name`);
    res.json({ items: r.rows.map(userRow) });
  }));
  app.post('/api/admin/usuarios', ...admin, wrap(async (req, res) => {
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase(), name = String(b.nombre || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (!emailOk(email)) return res.status(400).json({ error: 'Correo no válido' });
    if (!name) return res.status(400).json({ error: 'Escribe el nombre' });
    if (!ROLES.includes(b.rol)) return res.status(400).json({ error: 'Rol no válido' });
    let sellerId = null;
    if (b.rol === 'mayorista') {
      sellerId = parseInt(b.vendedorId, 10) || 0;
      const s = (await q("SELECT 1 FROM users WHERE id=$1 AND role='vendedor' AND active=true", [sellerId])).rows[0];
      if (!s) return res.status(400).json({ error: 'Elige el vendedor de este cliente' });
    }
    if ((await q('SELECT 1 FROM users WHERE email=$1', [email])).rows[0]) return res.status(409).json({ error: 'Ya existe un usuario con ese correo' });
    const tmp = auth.tempPassword();
    const r = await q('INSERT INTO users(email,name,role,pass,phone,seller_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
      [email, name, b.rol, auth.hashPassword(tmp), String(b.telefono || '').slice(0, 30), sellerId]);
    res.json({ ok: true, id: r.rows[0].id, claveTemporal: tmp });
  }));
  app.patch('/api/admin/usuarios/:id', ...admin, wrap(async (req, res) => {
    const id = parseInt(req.params.id, 10) || 0, b = req.body || {};
    const u = (await q('SELECT * FROM users WHERE id=$1', [id])).rows[0];
    if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
    const sets = [], p = [];
    const set = (col, v) => { p.push(v); sets.push(col + '=$' + p.length); };
    if (b.nombre !== undefined) { const n = String(b.nombre).trim().slice(0, 100); if (!n) return res.status(400).json({ error: 'Escribe el nombre' }); set('name', n); }
    if (b.telefono !== undefined) set('phone', String(b.telefono).slice(0, 30));
    if (b.activo !== undefined) {
      if (id === req.user.id && !b.activo) return res.status(400).json({ error: 'No puedes desactivarte a ti mismo' });
      set('active', !!b.activo);
    }
    if (b.vendedorId !== undefined && u.role === 'mayorista') {
      const sid = parseInt(b.vendedorId, 10) || 0;
      if (!(await q("SELECT 1 FROM users WHERE id=$1 AND role='vendedor' AND active=true", [sid])).rows[0]) return res.status(400).json({ error: 'Vendedor no válido' });
      set('seller_id', sid);
    }
    if (!sets.length) return res.status(400).json({ error: 'Nada que cambiar' });
    p.push(id);
    await q(`UPDATE users SET ${sets.join(',')} WHERE id=$${p.length}`, p);
    res.json({ ok: true });
  }));
  app.post('/api/admin/usuarios/:id/clave', ...admin, wrap(async (req, res) => {
    const id = parseInt(req.params.id, 10) || 0;
    if (!(await q('SELECT 1 FROM users WHERE id=$1', [id])).rows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });
    const tmp = auth.tempPassword();
    await q('UPDATE users SET pass=$1, must_change=true WHERE id=$2', [auth.hashPassword(tmp), id]);
    res.json({ ok: true, claveTemporal: tmp });
  }));

  // Vendedores activos (para el selector al crear un cliente)
  app.get('/api/admin/vendedores', ...admin, wrap(async (req, res) => {
    res.json({ items: (await q("SELECT id,name FROM users WHERE role='vendedor' AND active=true ORDER BY name")).rows.map((x) => ({ id: x.id, nombre: x.name })) });
  }));

  // Productos: aquí sí se ve el stock real (solo administrador) y se puede ocultar un producto
  app.get('/api/admin/productos', ...admin, wrap(async (req, res) => {
    const resv = await reservedMap();
    const ph = new Map((await q('SELECT sku, COUNT(*) AS n FROM photos GROUP BY sku')).rows.map((x) => [x.sku, Number(x.n)]));
    let rows = (await q('SELECT sku,name,category,medida,price,stock,hidden FROM products ORDER BY name')).rows;
    const f = String(req.query.q || '');
    if (f) rows = rows.filter((p) => matches(p.sku + ' ' + p.name, f));
    const total = rows.length;
    res.json({ total, items: rows.slice(0, 200).map((p) => ({ sku: p.sku, nombre: p.name, categoria: p.category, medida: p.medida, precio: precioJuego(p.price), stock: p.stock, reservado: resv.get(p.sku) || 0, oculto: p.hidden, fotos: ph.get(p.sku) || 0 })) });
  }));
  app.patch('/api/admin/productos/:sku', ...admin, wrap(async (req, res) => {
    const r = await q('UPDATE products SET hidden=$1 WHERE sku=$2', [!!(req.body || {}).oculto, String(req.params.sku).toUpperCase()]);
    if (!r.rowCount) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json({ ok: true });
  }));

  async function doSync(forcePhotos) { return runSync(pool, { bsale, drive, forcePhotos }); }
  app.get('/api/admin/sync', ...admin, wrap(async (req, res) => {
    res.json({ enCurso: syncState.running, ultima: syncState.last || await getKv(pool, 'lastSync'), bsale: !!bsale, drive: !!drive });
  }));
  app.post('/api/admin/sync', ...admin, wrap(async (req, res) => {
    if (!bsale) return res.status(409).json({ error: 'Falta configurar BSALE_TOKEN' });
    if (syncState.running) return res.status(409).json({ error: 'Ya hay una sincronización en curso' });
    doSync(true).catch((e) => console.error('sync', e));
    res.json({ ok: true });
  }));

  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
  app.use(express.static(path.join(__dirname, 'public'), { index: false, maxAge: 0 }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'No existe' }));
  app.doSync = doSync;
  app.setSources = (s) => { if ('bsale' in s) bsale = s.bsale; if ('drive' in s) drive = s.drive; };
  return app;
}

/* Fuentes reales a partir de las variables de entorno */
function sourcesFromEnv() {
  const out = { bsale: null, drive: null };
  if (process.env.BSALE_TOKEN) {
    out.bsale = {
      client: makeClient({ token: process.env.BSALE_TOKEN }),
      opts: {
        offices: (process.env.BSALE_OFFICES || 'Talca,Bodega Adicional').split(',').map((s) => s.trim()).filter(Boolean),
        priceListId: process.env.BSALE_PRICE_LIST_ID ? Number(process.env.BSALE_PRICE_LIST_ID) : null,
        priceListName: process.env.BSALE_PRICE_LIST || 'Mayorista',
        priceMode: process.env.PRICE_MODE === 'neto' ? 'neto' : 'iva', // por defecto, con IVA incluido
      },
    };
  } else console.warn('BSALE_TOKEN no definido: el catálogo no se sincroniza.');
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON && process.env.DRIVE_FOLDER_ID) {
    try { out.drive = makeDrive({ credentials: loadCredentials(process.env.GOOGLE_SERVICE_ACCOUNT_JSON), folderId: process.env.DRIVE_FOLDER_ID }); } catch (e) { console.error('Drive:', e.message); }
  } else console.warn('Drive no configurado: los productos se verán sin fotos.');
  return out;
}

async function bootstrapAdmin(pool) {
  const n = Number((await pool.query('SELECT COUNT(*) AS n FROM users')).rows[0].n);
  if (n) return;
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase(), pw = process.env.ADMIN_PASSWORD;
  if (!email || !pw) { console.warn('No hay usuarios. Define ADMIN_EMAIL y ADMIN_PASSWORD para crear el primer administrador.'); return; }
  await pool.query("INSERT INTO users(email,name,role,pass,must_change) VALUES($1,'Administrador','admin',$2,false)", [email, auth.hashPassword(pw)]);
  console.log('Administrador creado:', email);
}

if (require.main === module) {
  (async () => {
    const pool = db.makePool();
    await db.init(pool);
    await bootstrapAdmin(pool);
    const app = createApp(pool, sourcesFromEnv());
    const port = process.env.PORT || 3000;
    app.listen(port, () => console.log('Catálogo mayorista en el puerto ' + port));
    const mins = Math.max(5, Number(process.env.SYNC_MINUTES) || 15);
    const tick = () => app.doSync(false).then((r) => { if (r && !r.ok) console.error('Sync falló:', r.error); }).catch((e) => console.error('Sync', e));
    setTimeout(() => app.doSync(true).catch((e) => console.error('Sync', e)), 3000);
    setInterval(tick, mins * 60000);
  })().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { createApp, bootstrapAdmin };
