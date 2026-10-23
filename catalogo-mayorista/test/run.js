'use strict';
/* Prueba completa en memoria (pg-mem) con Bsale y Drive simulados. No necesita Postgres ni internet. */
process.env.SESSION_SECRET = 'test-secret';
const http = require('http');
const os = require('os');
const path = require('path');
const { newDb } = require('pg-mem');
const db = require('../lib/db');
const auth = require('../lib/auth');
const { createApp } = require('../server');
const { makeClient, parseRin } = require('../lib/bsale');
const { formatRut } = require('../lib/rut');
const { makeDrive } = require('../lib/drive');

let fails = 0;
const ok = (c, m) => { console.log((c ? 'OK   ' : 'FALLA') + ' ' + m); if (!c) fails++; };

/* ---- Bsale simulado ---- */
const page = (all, url) => {
  const u = new URL(url); const off = Number(u.searchParams.get('offset') || 0), lim = Number(u.searchParams.get('limit') || 50);
  const items = all.slice(off, off + lim);
  return { count: all.length, limit: lim, offset: off, items, next: off + lim < all.length ? 'x' : undefined };
};
const state = { talca: { 1: 5, 2: 2, 3: 0, 5: 0 }, bodega: { 1: 2, 2: 0, 3: 0, 4: 7, 5: 0 } }; // en juegos: cada variante de Bsale ya es el juego x4 // 4: sin precio
function fakeBsale(url) {
  const p = new URL(url).pathname.replace('/v1', '');
  const stocks = (m, oid) => Object.entries(m).map(([v, q]) => ({ quantity: q, quantityAvailable: q, variant: { id: Number(v) }, office: { id: oid } }));
  const body = (() => {
    if (p === '/offices.json') return page([{ id: 1, name: 'Talca' }, { id: 2, name: 'Bodega Adicional' }, { id: 3, name: 'Casa Matriz' }, { id: 4, name: 'Talca Centro' }, { id: 5, name: 'Bodega Adicional Norte' }], url); // los dos últimos NO deben contarse
    if (p === '/stocks.json') { const o = new URL(url).searchParams.get('officeid'); return page(o === '1' ? stocks(state.talca, 1) : o === '2' ? stocks(state.bodega, 2) : stocks({ 1: 999 }, 3), url); }
    if (p === '/price_lists.json') return page([{ id: 7, name: 'Minorista', state: 0 }, { id: 9, name: 'Lista Mayorista', state: 0 }], url);
    if (p === '/price_lists/9/details.json') return page([
      { variant: { id: 1 }, variantValue: 50000, variantValueWithTaxes: 59500 },
      { variant: { id: 2 }, variantValue: 80000, variantValueWithTaxes: 95200 },
      { variant: { id: 3 }, variantValue: 70000, variantValueWithTaxes: 83300 }], url);
    if (p === '/product_types.json') return page([{ id: 5, name: 'Llantas' }], url);
    if (p === '/variants.json') return page([
      { id: 1, code: 'ab-205', description: '', product: { name: 'LLANTA ALEACION 16X7 5X114.3 ET40 NEGRO', productType: { id: 5 } } },
      { id: 2, code: 'ab-265', description: '17X7.5 6X139.7 ET25', product: { name: 'LLANTA ACERO', productType: { id: 5 } } },
      { id: 3, code: 'ab-agotado', description: '', product: { name: 'LLANTA AGOTADA 15X6 4X100', productType: { id: 5 } } },
      { id: 4, code: 'ab-sinprecio', description: '', product: { name: 'LLANTA SIN PRECIO', productType: { id: 5 } } },
      { id: 5, code: 'ab-sinstock', description: '', product: { name: 'LLANTA 14X5.5 4X100', productType: { id: 5 } } }], url);
    throw new Error('ruta no simulada ' + p);
  })();
  return { ok: true, status: 200, json: async () => body };
}
const bsale = {
  client: makeClient({ token: 't', pauseMs: 0, fetchImpl: async (url) => fakeBsale(url) }),
  opts: { offices: ['talca', 'bodega adicional'], priceListName: 'mayorista', priceMode: 'iva' },
};
const drive = {
  async buildIndex() { return new Map([['AB-205', [{ id: 'fileAAAAAAAA1', name: 'AB-205_1.jpg' }, { id: 'fileAAAAAAAA2', name: 'AB-205_2.jpg' }, { id: 'fileAAAAAAAA3', name: 'AB-205_3.jpg' }]], ['AB-265', [{ id: 'fileBBBBBBBB1', name: 'AB-265.jpg' }]]]); },
  async download() { return { buf: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), type: 'image/jpeg' }; },
};

function client(base) {
  return async (cookie, method, url, body) => {
    const r = await fetch(base + url, { method, headers: Object.assign({ cookie: cookie || '' }, body !== undefined ? { 'Content-Type': 'application/json' } : {}), body: body !== undefined ? JSON.stringify(body) : undefined });
    let j = null; const ct = r.headers.get('content-type') || '';
    if (ct.includes('json')) j = await r.json(); else await r.arrayBuffer();
    return { s: r.status, j, ck: (r.headers.get('set-cookie') || '').split(';')[0], ct };
  };
}

const PERFIL = { razon_social: 'Neumáticos Sur SpA', rut: '76.086.428-5', giro: 'Venta de neumáticos', direccion: 'Av. Principal 123', comuna: 'Talca', ciudad: 'Talca', region: 'Maule',
  telefono: '712345678', email_fact: 'facturas@sur.cl', contacto_nombre: 'Juan Pérez', whatsapp: '9 1234 5678', despacho_igual: true };

(async () => {
  // utilidades
  ok(formatRut('76086428-5') === '76.086.428-5' && formatRut('11.111.111-1') === '11.111.111-1' && !formatRut('11.111.111-2'), 'RUT: módulo 11');
  const q1 = parseRin('LLANTA ALEACION 16X7 5X114.3 ET40'), q2 = parseRin('Rin 7Jx17 5/112 ET-5'), q3 = parseRin('LLANTA ACERO 15 X 6 4X100/108'), q4 = parseRin('RIN ARO 14 NEGRO'), q5 = parseRin('LLANTA 17X8.5 6H139.7 ET20');
  ok(q1.aro === '16' && q1.ancho === '7' && q1.pcd === '5x114.3' && q1.et === '40' && q1.medida === '16x7 · 5x114.3 · ET40', 'rin: aro, ancho, PCD y ET desde el nombre');
  ok(q2.aro === '17' && q2.ancho === '7' && q2.pcd === '5x112' && q2.et === '-5', 'rin: 7Jx17 5/112 ET-5');
  ok(q3.aro === '15' && q3.pcd === '4x100/108' && q4.aro === '14' && !q4.pcd && q5.pcd === '6x139.7' && q5.aro === '17' && q5.ancho === '8.5', 'rin: PCD doble, solo aro, 6H139.7 y ancho 8.5');
  // Drive real: índice con archivos sueltos y subcarpetas (Google simulado)
  const rsa = require('crypto').generateKeyPairSync('rsa', { modulusLength: 2048 });
  const files = {
    ROOT: [{ id: 'f1', name: 'XY-1.jpg', mimeType: 'image/jpeg' }, { id: 'f2', name: 'XY-1_2.jpg', mimeType: 'image/jpeg' }, { id: 'f3', name: 'ZZ.png', mimeType: 'image/png' },
      { id: 'd1', name: 'CAR9', mimeType: 'application/vnd.google-apps.folder' }, { id: 'f9', name: 'notas.txt', mimeType: 'text/plain' }],
    d1: [{ id: 'g1', name: '2.jpg', mimeType: 'image/jpeg' }, { id: 'g2', name: '1.jpg', mimeType: 'image/jpeg' }],
  };
  const dr = makeDrive({ credentials: { client_email: 'x@y', private_key: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) }, folderId: 'ROOT',
    fetchImpl: async (url) => {
      if (String(url).includes('oauth2')) return { ok: true, json: async () => ({ access_token: 'tk', expires_in: 3600 }) };
      const parent = decodeURIComponent(String(url).match(/q=([^&]+)/)[1]).match(/'([^']+)' in parents/)[1];
      return { ok: true, json: async () => ({ files: files[parent] }) };
    } });
  const idx = await dr.buildIndex();
  ok(idx.get('XY-1').length === 2 && idx.get('ZZ').length === 1 && idx.get('CAR9').map((x) => x.id).join() === 'g2,g1' && !idx.get('NOTAS'), 'Drive: fotos por SKU (sueltas, _1/_2 y subcarpetas)');

  const mem = newDb(); const { Pool } = mem.adapters.createPg(); const pool = new Pool();
  await db.init(pool);
  // Google simulado para la carpeta pública (vista incrustada de Drive y descarga por enlace)
  const entry = (id, name, folder) => `<div class="flip-entry" id="entry-${id}" tabindex="0"><div class="flip-entry-info"><a href="https://drive.google.com/${folder ? 'drive/folders/' : 'file/d/'}${id}/${folder ? '' : 'view?usp=drive_web'}" target="_blank"><div class="flip-entry-title">${name}</div></a></div></div>`;
  const pubFolders = {
    PUBROOT0001: entry('pubfile0001', 'AB-205_1.jpg') + entry('pubfile0002', 'AB-205_2.JPG') + entry('pubfold0001', 'AB-265', true) + entry('pubfile0009', 'notas &amp; precios.txt'),
    pubfold0001: entry('pubfile0003', 'b.jpg') + entry('pubfile0004', 'a.jpg'),
    EMPTYROOT01: '<html><body>vacía</body></html>',
  };
  const publicFetch = async (url) => {
    const u = String(url);
    if (u.includes('embeddedfolderview')) { const id = decodeURIComponent(u.match(/id=([^&#]+)/)[1]); return pubFolders[id] ? { ok: true, status: 200, text: async () => '<html>' + pubFolders[id] + '</html>' } : { ok: false, status: 404, text: async () => '' }; }
    if (u.startsWith('https://lh3.googleusercontent.com/d/')) return { ok: true, status: 200, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]) };
    return { ok: false, status: 404, headers: { get: () => '' } };
  };
  const app = createApp(pool, { publicFetch, bsale, drive, cacheDir: path.join(os.tmpdir(), 'cat-test-' + process.pid) });
  const srv = http.createServer(app).listen(0); const base = 'http://127.0.0.1:' + srv.address().port;
  const call = client(base);

  ok((await call('', 'GET', '/health')).s === 200, 'health');
  ok((await call('', 'GET', '/api/productos')).s === 401, 'sin sesión no hay catálogo');
  await pool.query("INSERT INTO users(email,name,role,pass,must_change) VALUES('admin@x.cl','Admin','admin',$1,false)", [auth.hashPassword('claveadmin1')]);
  ok((await call('', 'POST', '/api/login', { email: 'admin@x.cl', password: 'mala' })).s === 401, 'login con clave mala falla');
  const a = await call('', 'POST', '/api/login', { email: 'ADMIN@x.cl', password: 'claveadmin1' }); const A = a.ck;
  ok(a.s === 200 && A, 'login administrador');

  // sincronización
  // solo cuentan Talca y Bodega Adicional (exactas), aunque existan otras con nombres parecidos y mucho stock
  const cat0 = await require('../lib/bsale').fetchCatalog(bsale.client, bsale.opts);
  ok(cat0.offices.join() === 'Talca,Bodega Adicional' && cat0.items.find((i) => i.sku === 'AB-205').stock === 7, 'el stock suma solo Talca y Bodega Adicional (no "Talca Centro" ni "Bodega Adicional Norte")');
  let amb = ''; try { await require('../lib/bsale').fetchCatalog(bsale.client, Object.assign({}, bsale.opts, { offices: ['bodega'] })); } catch (e) { amb = e.message; }
  ok(amb.includes('coincide con varias'), 'un nombre de sucursal ambiguo se rechaza en vez de sumar de más');
  state.talca[3] = -2; state.bodega[3] = 5;
  const neg = (await require('../lib/bsale').fetchCatalog(bsale.client, bsale.opts)).items.find((i) => i.sku === 'AB-AGOTADO');
  ok(neg.stock === 3 && neg.stockTalca === 0 && neg.stockBodega === 5, 'con saldo negativo en Talca el total se descuenta (3), sin pasar de lo que existe');
  state.talca[3] = 0; state.bodega[3] = 0;
  const sy = await app.doSync(true);
  ok(sy.ok && sy.productos === 5 && sy.conStock === 2 && sy.sucursales.length === 2 && sy.fotos === 4, 'sync: 5 productos, 2 visibles, 2 sucursales, 4 fotos ' + JSON.stringify(sy));
  const ap = (await call(A, 'GET', '/api/admin/productos')).j.items;
  ok(ap.find((p) => p.sku === 'AB-205').stock === 7 && ap.find((p) => p.sku === 'AB-265').stock === 2, 'stock = Talca + Bodega Adicional (5+2, 2+0); Casa Matriz no cuenta');
  ok(ap.find((p) => p.sku === 'AB-265').nombre === 'LLANTA ACERO 17X7.5 6X139.7 ET25' && ap.find((p) => p.sku === 'AB-265').medida === '17x7.5 · 6x139.7 · ET25', 'nombre = producto + variante, con su medida');

  // usuarios
  const mk = (b) => call(A, 'POST', '/api/admin/usuarios', b);
  ok((await mk({ email: 'v1@x.cl', nombre: 'Vendedor Uno', rol: 'vendedor', telefono: '+56 9 8765 4321' })).s === 200, 'crea vendedor 1');
  const v2 = await mk({ email: 'v2@x.cl', nombre: 'Vendedor Dos', rol: 'vendedor', telefono: '987654322' });
  ok(v2.s === 200, 'crea vendedor 2');
  const vend = (await call(A, 'GET', '/api/admin/vendedores')).j.items.sort((x, y) => x.nombre.localeCompare(y.nombre) * -1); // [Uno, Dos]
  ok((await mk({ email: 'm0@x.cl', nombre: 'Sin vendedor', rol: 'mayorista' })).s === 400, 'mayorista exige vendedor');
  ok((await mk({ email: 'v1@x.cl', nombre: 'Repetido', rol: 'vendedor' })).s === 409, 'correo repetido se rechaza');
  const m1 = await mk({ email: 'm1@x.cl', nombre: 'Cliente Uno', rol: 'mayorista', vendedorId: vend[0].id });
  const m2 = await mk({ email: 'm2@x.cl', nombre: 'Cliente Dos', rol: 'mayorista', vendedorId: vend[1].id });
  ok(m1.s === 200 && m1.j.claveTemporal.length >= 8, 'crea mayorista con clave temporal');
  const v1c = await mk({ email: 'v1b@x.cl', nombre: 'V1b', rol: 'vendedor' });
  const v1p = (await call('', 'POST', '/api/login', { email: 'v1@x.cl', password: 'x' })).s;
  ok(v1p === 401, 'clave temporal desconocida no entra');

  // primer ingreso del mayorista: clave -> datos -> catálogo
  const lg = await call('', 'POST', '/api/login', { email: 'm1@x.cl', password: m1.j.claveTemporal }); const M1 = lg.ck;
  ok(lg.s === 200, 'mayorista entra con la clave temporal');
  const me = (await call(M1, 'GET', '/api/me')).j;
  ok(me.rol === 'mayorista' && me.cambiarClave && !me.perfilCompleto && me.vendedor.nombre === 'Vendedor Uno', '/api/me pide cambiar clave y completar datos');
  ok((await call(M1, 'GET', '/api/productos')).s === 403, 'no ve el catálogo antes de cambiar la clave');
  ok((await call(M1, 'PUT', '/api/perfil', PERFIL)).s === 403, 'ni llena datos antes de cambiar la clave');
  ok((await call(M1, 'POST', '/api/clave', { actual: m1.j.claveTemporal, nueva: 'corta' })).s === 400, 'clave nueva muy corta se rechaza');
  ok((await call(M1, 'POST', '/api/clave', { actual: m1.j.claveTemporal, nueva: 'clavenueva123' })).s === 200, 'cambia su clave');
  const pr = await call(M1, 'GET', '/api/productos');
  ok(pr.s === 403 && pr.j.paso === 'perfil', 'sigue bloqueado hasta completar sus datos');
  const bad = await call(M1, 'PUT', '/api/perfil', Object.assign({}, PERFIL, { rut: '11.111.111-2', email_fact: 'no', whatsapp: '123' }));
  ok(bad.s === 400 && bad.j.campos.rut && bad.j.campos.email_fact && bad.j.campos.whatsapp, 'datos inválidos: marca RUT, correo y WhatsApp');
  ok((await call(M1, 'PUT', '/api/perfil', PERFIL)).s === 200, 'guarda facturación y dirección');
  const pf = (await call(M1, 'GET', '/api/perfil')).j;
  ok(pf.completo && pf.datos.rut === '76.086.428-5' && pf.datos.whatsapp === '+56912345678', 'queda guardado y formateado (RUT y WhatsApp)');
  ok((await call(M1, 'PUT', '/api/perfil', Object.assign({}, PERFIL, { direccion: 'Calle Nueva 456' }))).s === 200 && (await call(M1, 'GET', '/api/perfil')).j.datos.direccion === 'Calle Nueva 456', 'puede corregir sus datos después');

  // catálogo
  const cat = (await call(M1, 'GET', '/api/productos')).j;
  ok(cat.total === 2 && cat.items.every((p) => p.sku !== 'AB-AGOTADO' && p.sku !== 'AB-SINPRECIO'), 'catálogo: solo con stock y precio');
  const p205 = cat.items.find((p) => p.sku === 'AB-205');
  ok(p205.precio === 59500 && p205.max === 7 && p205.fotos.length === 3 && !('stock' in p205), 'precio del juego con IVA tal como viene de Bsale, tope = 7 juegos, 3 fotos y sin campo stock');
  ok(!JSON.stringify(cat).includes('"stock"'), 'la respuesta pública no trae stock');
  ok(cat.items.map((p) => p.aro).join() === '16,17' && cat.aros.map((a) => a.aro + ':' + a.n).join() === '16:1,17:1', 'catálogo separado y ordenado por aro (16, 17) con conteo');
  ok(p205.aro === '16' && p205.ancho === '7' && p205.pcd === '5x114.3' && p205.et === '40', 'ficha con aro, ancho, PCD y ET');
  ok((await call(M1, 'GET', '/api/productos?q=' + encodeURIComponent('5x114'))).j.total === 1, 'busca por PCD "5x114"');
  ok((await call(M1, 'GET', '/api/productos?aro=17')).j.items[0].sku === 'AB-265', 'filtra por aro');
  const fp = (await call(M1, 'GET', '/api/productos?pcd=' + encodeURIComponent('6x139.7'))).j;
  ok(fp.total === 1 && fp.pcds.join() === '5x114.3,6x139.7' && fp.aros.length === 1, 'filtra por PCD y los aros se recalculan');
  const foto = await call(M1, 'GET', p205.fotos[0].replace('', ''));
  ok(foto.s === 200 && foto.ct.includes('image/jpeg'), 'sirve la foto desde Drive (con sesión)');
  ok((await call('', 'GET', p205.fotos[0])).s === 401 && (await call(M1, 'GET', '/api/foto/archivoQueNoExiste1')).s === 404, 'foto sin sesión o fuera del catálogo: no');

  // pedidos
  const ped = (items, notas) => call(M1, 'POST', '/api/pedidos', { items, notas });
  ok((await ped([])).s === 400 && (await ped([{ sku: 'AB-205', qty: 0 }])).s === 400 && (await ped([{ sku: 'AB-205', qty: 1.5 }])).s === 400, 'pedido vacío o con cantidades raras se rechaza');
  const over = await ped([{ sku: 'AB-265', qty: 3 }]);
  ok(over.s === 409 && over.j.problemas[0].max === 2, 'no deja pedir más juegos que los disponibles');
  ok((await ped([{ sku: 'AB-AGOTADO', qty: 1 }])).s === 409 && (await ped([{ sku: 'AB-SINPRECIO', qty: 1 }])).s === 409, 'ni productos agotados o sin precio');
  const o1 = await ped([{ sku: 'ab-205', qty: 4 }, { sku: 'AB-205', qty: 1 }, { sku: 'AB-265', qty: 2 }], 'Despachar mañana');
  ok(o1.s === 200 && o1.j.pedido.codigo === 'P-00001' && o1.j.pedido.items.length === 2 && o1.j.pedido.juegos === 7 && o1.j.pedido.unidades === 28, 'crea el pedido (junta líneas repetidas)');
  ok(o1.j.pedido.cliente.razon_social === 'Neumáticos Sur SpA' && o1.j.pedido.total === 5 * 59500 + 2 * 95200, 'resumen con datos del cliente y total');
  ok(o1.j.whatsapp.startsWith('https://wa.me/56987654321?text=') && decodeURIComponent(o1.j.whatsapp).includes('AB-205 — LLANTA ALEACION 16X7 5X114.3 ET40 NEGRO × 5 juegos'), 'enlace de WhatsApp al vendedor con el resumen');
  const cat2 = (await call(M1, 'GET', '/api/productos')).j;
  ok(cat2.items.length === 1 && cat2.items[0].max === 2, 'el pedido reserva stock (agotó AB-265, quedan 2 juegos de AB-205)');
  // carreras: dos pedidos a la vez por lo último que queda
  const [r1, r2] = await Promise.all([ped([{ sku: 'AB-205', qty: 2 }]), ped([{ sku: 'AB-205', qty: 2 }])]);
  ok([r1.s, r2.s].sort().join() === '200,409', 'dos pedidos simultáneos: solo uno se lleva lo último');

  // visibilidad por vendedor
  const lgin = async (email, pw) => (await call('', 'POST', '/api/login', { email, password: pw })).ck;
  const tmpV = async (id) => (await call(A, 'POST', '/api/admin/usuarios/' + id + '/clave', {})).j.claveTemporal;
  const V1 = await lgin('v1@x.cl', await tmpV(vend[0].id));
  ok((await call(V1, 'GET', '/api/pedidos')).s === 403, 'vendedor nuevo debe cambiar su clave primero');
  const t1 = await tmpV(vend[0].id), V1b = await lgin('v1@x.cl', t1);
  ok((await call(V1b, 'POST', '/api/clave', { actual: t1, nueva: 'vendedor-uno-1' })).s === 200, 'vendedor 1 cambia su clave');
  const t2 = await tmpV(vend[1].id), V2b = await lgin('v2@x.cl', t2);
  await call(V2b, 'POST', '/api/clave', { actual: t2, nueva: 'vendedor-dos-2' });
  ok((await call(V1b, 'GET', '/api/pedidos')).j.items.length === 2, 'vendedor 1 ve los pedidos de su cliente');
  ok((await call(V2b, 'GET', '/api/pedidos')).j.items.length === 0, 'vendedor 2 NO ve pedidos de clientes ajenos');
  ok((await call(V2b, 'GET', '/api/pedidos/1')).s === 404 && (await call(V2b, 'PATCH', '/api/pedidos/1', { estado: 'confirmado' })).s === 404, 'vendedor 2 tampoco por id ni puede modificarlos');
  ok((await call(A, 'GET', '/api/pedidos')).j.items.length === 2, 'administrador ve todos');
  ok((await call(V1b, 'GET', '/api/admin/usuarios')).s === 403 && (await call(V1b, 'GET', '/api/admin/productos')).s === 403, 'vendedor no entra a administración ni ve stock');
  const rev = await call(V1b, 'PATCH', '/api/pedidos/1', { estado: 'revision', notaInterna: 'Llamar al cliente' });
  ok(rev.s === 200 && rev.j.pedido.estado === 'revision', 'vendedor cambia el estado del pedido');
  ok((await call(M1, 'POST', '/api/pedidos/1/cancelar', {})).s === 409, 'cliente no cancela un pedido ya en revisión');
  // otro mayorista
  const t = m2.j.claveTemporal; const M2 = await lgin('m2@x.cl', t);
  await call(M2, 'POST', '/api/clave', { actual: t, nueva: 'clavedos-123' });
  await call(M2, 'PUT', '/api/perfil', Object.assign({}, PERFIL, { razon_social: 'Otra Ltda', rut: '11.111.111-1' }));
  ok((await call(M2, 'GET', '/api/pedidos')).j.items.length === 0 && (await call(M2, 'GET', '/api/pedidos/1')).s === 404, 'un mayorista no ve pedidos de otro');
  state.talca[1] = 50; await app.doSync(false); // llega mercadería
  const o2 = await call(M2, 'POST', '/api/pedidos', { items: [{ sku: 'AB-205', qty: 1 }] });
  ok(o2.s === 200 && (await call(V2b, 'GET', '/api/pedidos')).j.items.length === 1 && (await call(V1b, 'GET', '/api/pedidos')).j.items.length === 2, 'el pedido de cliente 2 llega solo al vendedor 2');
  ok((await call(M2, 'POST', '/api/pedidos/' + o2.j.pedido.id + '/cancelar', {})).s === 200, 'cliente cancela un pedido nuevo');
  ok((await call(M1, 'GET', '/api/admin/usuarios')).s === 403, 'mayorista no entra a administración');
  const rs = (await call(V1b, 'GET', '/api/pedidos/resumen')).j;
  ok(rs.revision === 1 && rs.nuevo === 1, 'resumen de pedidos por estado del vendedor');

  // el stock se actualiza solo en la siguiente sincronización
  state.talca[2] = 20; state.bodega[3] = 3;
  await app.doSync(false);
  const ap2 = (await call(A, 'GET', '/api/admin/productos')).j.items;
  ok(ap2.find((p) => p.sku === 'AB-265').stock === 20 && ap2.find((p) => p.sku === 'AB-AGOTADO').stock === 3, 'la siguiente sync actualiza el stock');
  // ocultar producto
  ok((await call(A, 'PATCH', '/api/admin/productos/AB-265', { oculto: true })).s === 200 && (await call(M1, 'GET', '/api/productos?q=265')).j.total === 0, 'producto oculto desaparece del catálogo');
  await app.doSync(false);
  ok((await call(M1, 'GET', '/api/productos?q=265')).j.total === 0, 'y sigue oculto tras otra sync');
  // desactivar usuario
  await call(A, 'PATCH', '/api/admin/usuarios/' + (await pool.query("SELECT id FROM users WHERE email='m2@x.cl'")).rows[0].id, { activo: false });
  ok((await call(M2, 'GET', '/api/me')).s === 401, 'usuario desactivado pierde el acceso');

  // ---- stock por sucursal y traslados de Bodega Adicional a Talca ----
  const apx = (await call(A, 'GET', '/api/admin/productos')).j.items;
  ok(apx.find((p) => p.sku === 'AB-AGOTADO').talca === 0 && apx.find((p) => p.sku === 'AB-AGOTADO').bodega === 3 && apx.find((p) => p.sku === 'AB-265').talca === 20, 'el administrador ve el stock de Talca y de Bodega Adicional por separado');
  const cv = (await call(V1b, 'GET', '/api/productos?q=AB-AGOTADO')).j.items[0];
  ok(cv.stockTalca === 0 && cv.stockBodega === 3 && cv.max === 3, 'el vendedor ve el stock de ambas sucursales en el catálogo');
  ok(!JSON.stringify((await call(M1, 'GET', '/api/productos?q=AB-AGOTADO')).j).toLowerCase().includes('stock'), 'el mayorista no ve ningún stock');
  ok((await call(V1b, 'GET', '/api/admin/traslados')).s === 403 && (await call(M1, 'GET', '/api/admin/traslados')).s === 403, 'los traslados son solo del administrador');
  const row = async () => (await call(A, 'GET', '/api/admin/traslados')).j.items.find((i) => i.sku === 'AB-AGOTADO');
  let t0 = await row();
  ok(t0 && t0.talca === 0 && t0.bodega === 3 && t0.mover === 1 && t0.paraMinimo === 1 && t0.paraPedidos === 0, 'sin pedidos: igual hay que dejar 1 en Talca (Talca 0, Bodega 3 -> trasladar 1)');
  ok(!(await call(A, 'GET', '/api/admin/traslados')).j.items.some((i) => i.sku === 'AB-265' && i.mover > 0 && i.paraMinimo > 0 && i.talca >= i.pedidos + 1), 'no pide traslado donde Talca ya tiene lo suficiente');
  const pa = await call(M1, 'POST', '/api/pedidos', { items: [{ sku: 'AB-AGOTADO', qty: 2 }] });
  const dA = (await call(V1b, 'GET', '/api/pedidos/' + pa.j.pedido.id)).j.pedido;
  const dl = dA.traslado.lineas[0];
  ok(dA.traslado.total === 3 && dA.traslado.faltante === 0 && dA.traslado.faltanteReserva === 0 && dl.talca === 0 && dl.bodega === 3 && dl.paraPedido === 2 && dl.reserva === 1 && dl.trasladar === 3, 'el pedido avisa cuánto trasladar: pide 2 + 1 de reserva en Talca (Talca 0) = 3 desde Bodega Adicional');
  ok((await call(M1, 'GET', '/api/pedidos/' + pa.j.pedido.id)).j.pedido.traslado === undefined, 'el cliente no ve el aviso de traslado');
  const lista = (await call(V1b, 'GET', '/api/pedidos')).j.items.find((o) => o.id === pa.j.pedido.id);
  ok(lista.traslado.total === 3, 'la lista de pedidos también marca el traslado');
  t0 = await row();
  ok(t0.pedidos === 2 && t0.paraPedidos === 2 && t0.paraMinimo === 1 && t0.mover === 3 && t0.faltantePedidos === 0 && t0.codigos.length === 1, 'con 2 en pedidos: trasladar 2 + 1 de reserva en Talca = 3 (Bodega tiene 3)');
  await call(M1, 'POST', '/api/pedidos', { items: [{ sku: 'AB-AGOTADO', qty: 1 }] });
  t0 = await row();
  ok(t0.pedidos === 3 && t0.paraPedidos === 3 && t0.mover === 3 && t0.faltanteMinimo === 1 && t0.faltantePedidos === 0, 'con 3 en pedidos y solo 3 en Bodega: se priorizan los pedidos y falta 1 para la reserva de Talca');
  state.talca[3] = 2; state.bodega[3] = 1; await app.doSync(false); // se trasladaron 2
  t0 = await row();
  ok(t0.talca === 2 && t0.bodega === 1 && t0.paraPedidos === 1 && t0.paraMinimo === 0 && t0.mover === 1 && t0.faltantePedidos === 0 && t0.faltanteMinimo === 1, 'tras trasladar 2: Talca 2, pedidos 3 -> trasladar 1 y sigue faltando 1 de reserva');
  state.talca[3] = 3; state.bodega[3] = 0; await app.doSync(false);
  t0 = await row();
  ok(t0.paraPedidos === 0 && t0.faltantePedidos === 0 && t0.faltanteMinimo === 1 && t0.mover === 0, 'si Bodega queda en 0 y Talca justo alcanza para los pedidos, avisa que falta reserva');
  const dB = (await call(V1b, 'GET', '/api/pedidos/' + pa.j.pedido.id)).j.pedido;
  ok(dB.traslado.total === 0 && dB.traslado.faltante === 0, 'con Talca suficiente (pedido + 1 de reserva) ya no pide traslado');
  state.talca[3] = 2; state.bodega[3] = 0; await app.doSync(false); // Talca justo para el pedido, sin reserva ni Bodega
  const dC = (await call(V1b, 'GET', '/api/pedidos/' + pa.j.pedido.id)).j.pedido.traslado;
  ok(dC.total === 0 && dC.faltante === 0 && dC.faltanteReserva === 1 && dC.lineas[0].reserva === 0, 'si Talca alcanza para el pedido pero no queda 1 de reserva y Bodega no tiene: avisa solo lo de la reserva');
  state.talca[3] = 3; await app.doSync(false);
  const resTr = (await call(A, 'GET', '/api/admin/traslados')).j;
  ok(resTr.minimo === 1 && resTr.resumen.juegos === resTr.items.reduce((n, i) => n + i.mover, 0), 'resumen de traslados coherente');

  // ---- fotos desde un enlace de carpeta pública (sin cuenta de servicio) ----
  ok((await call(A, 'GET', '/api/admin/drive')).j.modo === 'cuenta', 'al inicio las fotos vienen de la cuenta de servicio');
  ok((await call(V1b, 'POST', '/api/admin/drive', { enlace: 'x' })).s === 403, 'solo el administrador cambia la carpeta de fotos');
  ok((await call(A, 'POST', '/api/admin/drive', { enlace: 'hola' })).s === 400, 'enlace que no es de Drive: se rechaza');
  const noPub = await call(A, 'POST', '/api/admin/drive', { enlace: 'https://drive.google.com/drive/folders/NOEXISTE1234567' });
  ok(noPub.s === 400 && noPub.j.error.includes('Cualquier persona con el enlace'), 'carpeta no pública: explica cómo compartirla');
  ok((await call(A, 'POST', '/api/admin/drive', { enlace: 'https://drive.google.com/drive/folders/EMPTYROOT01' })).s === 400, 'carpeta sin fotos: avisa');
  const pl = await call(A, 'POST', '/api/admin/drive', { enlace: 'https://drive.google.com/drive/u/0/folders/PUBROOT0001?usp=sharing' });
  ok(pl.s === 200 && pl.j.productosConFoto === 2, 'enlace público válido: encuentra las fotos por SKU (' + JSON.stringify(pl.j) + ')');
  for (let i = 0; i < 40 && (await call(A, 'GET', '/api/admin/sync')).j.enCurso; i++) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 300));
  const pc = (await call(A, 'GET', '/api/admin/productos')).j.items;
  ok(pc.find((p) => p.sku === 'AB-205').fotos === 2 && pc.find((p) => p.sku === 'AB-265').fotos === 2, 'tras sincronizar, los productos quedan con las fotos de esa carpeta');
  const cp = (await call(M1, 'GET', '/api/productos?q=AB-205')).j.items[0];
  const pfo = await call(M1, 'GET', cp.fotos[0]);
  ok(cp.fotos.length === 2 && pfo.s === 200 && pfo.ct.includes('image/jpeg'), 'la foto se sirve desde la carpeta pública');
  ok((await call(A, 'GET', '/api/admin/drive')).j.modo === 'enlace', 'queda guardado el modo «enlace»');
  ok((await call(A, 'DELETE', '/api/admin/drive', {})).s === 200 && (await call(A, 'GET', '/api/admin/drive')).j.modo === 'cuenta', 'quitar el enlace vuelve a la cuenta de servicio');

  srv.close(); await pool.end();
  console.log(fails ? '\n' + fails + ' prueba(s) fallaron' : '\nTodo bien');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
