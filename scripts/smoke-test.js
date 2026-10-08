/* Prueba rápida del servidor ya iniciado.
   Uso:  BASE=http://localhost:3000 ADMIN_USER=admin ADMIN_PASSWORD=... node scripts/smoke-test.js
   Crea (y borra al final) un usuario chofer de prueba. */
const BASE = process.env.BASE || 'http://localhost:3000';
const AU = process.env.ADMIN_USER || 'admin', AP = process.env.ADMIN_PASSWORD;
let fails = 0;
const ok = (c, m) => { console.log((c ? 'OK   ' : 'FALLA') + ' ' + m); if (!c) fails++; };

async function call(cookie, method, url, body) {
  const r = await fetch(BASE + url, { method, headers: Object.assign({ cookie: cookie || '' }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { s: r.status, j, ck: (r.headers.get('set-cookie') || '').split(';')[0] };
}
(async () => {
  if (!AP) { console.error('Falta ADMIN_PASSWORD'); process.exit(2); }
  ok((await call('', 'GET', '/health')).s === 200, 'health');
  ok((await call('', 'GET', '/api/col/vehicles')).s === 401, 'sin sesión no lee datos');
  ok((await call('', 'POST', '/api/login', { username: AU, password: 'incorrecta' })).s === 401, 'login con clave mala falla');
  const a = await call('', 'POST', '/api/login', { username: AU, password: AP });
  ok(a.s === 200 && a.ck, 'login administrador'); const A = a.ck;
  const v = await call(A, 'GET', '/api/col/vehicles');
  ok(v.s === 200 && v.j.length >= 1, 'lee vehículos (' + (v.j && v.j.length) + ')');
  ok((await call(A, 'PATCH', '/api/doc/vehicles/zzz', { data: { a: 1 } })).s === 404, 'update de documento inexistente = 404');
  await call(A, 'DELETE', '/api/users/chofer.test');
  ok((await call(A, 'POST', '/api/users', { username: 'chofer.test', name: 'Chofer Prueba', role: 'chofer', password: 'clavechofer1' })).s === 200, 'crea chofer');
  const c = await call('', 'POST', '/api/login', { username: 'chofer.test', password: 'clavechofer1' }); const C = c.ck;
  ok(c.s === 200 && c.j.role === 'chofer', 'login chofer');
  const id = v.j[0].id;
  ok((await call(C, 'PATCH', '/api/doc/vehicles/' + id, { data: { nextKm: 1 } })).s === 403, 'chofer NO puede editar el vehículo');
  ok((await call(C, 'PATCH', '/api/doc/vehicles/' + id, { data: { pending: v.j[0].data.pending || [] } })).s === 200, 'chofer puede agregar pendientes');
  ok((await call(C, 'PUT', '/api/doc/kmlog/' + id, { data: { entries: (await call(C, 'GET', '/api/doc/kmlog/' + id)).j.data.entries } })).s === 200, 'chofer puede guardar kilometraje');
  ok((await call(C, 'PUT', '/api/doc/checklists/ctest', { data: { vid: id, fecha: '2026-01-01' } })).s === 200, 'chofer puede guardar un checklist');
  ok((await call(C, 'DELETE', '/api/doc/checklists/ctest')).s === 403, 'chofer NO puede borrar checklists');
  ok((await call(C, 'GET', '/api/users')).s === 403, 'chofer NO ve usuarios');
  ok((await call(C, 'PUT', '/api/doc/settings/alertState', { data: { sent: {} } })).s === 403, 'nadie escribe alertState');
  ok((await call(A, 'DELETE', '/api/doc/checklists/ctest')).s === 200, 'administrador borra el checklist de prueba');
  ok((await call(A, 'GET', '/api/alerts/status')).s === 200, 'estado de alertas');
  ok((await call(A, 'DELETE', '/api/users/chofer.test')).s === 200, 'borra el chofer de prueba');
  ok((await call(A, 'DELETE', '/api/users/' + AU)).s === 400, 'no se puede borrar a sí mismo');
  console.log(fails ? '\n' + fails + ' prueba(s) fallaron' : '\nTodo en orden');
  process.exit(fails ? 1 : 0);
})();
