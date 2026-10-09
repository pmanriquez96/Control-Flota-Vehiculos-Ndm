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
  const km0 = (await call(A, 'GET', '/api/doc/kmlog/' + id)).j.data;
  // el chofer no escribe directamente en ninguna colección
  ok((await call(C, 'PATCH', '/api/doc/vehicles/' + id, { data: { nextKm: 1 } })).s === 403, 'chofer NO puede editar el vehículo');
  ok((await call(C, 'PATCH', '/api/doc/vehicles/' + id, { data: { pending: [] } })).s === 403, 'chofer NO puede tocar los pendientes directamente');
  ok((await call(C, 'PUT', '/api/doc/kmlog/' + id, { data: { entries: [] } })).s === 403, 'chofer NO puede reescribir el kilometraje');
  ok((await call(C, 'PUT', '/api/doc/checklists/ctest', { data: { vid: id, fecha: '2026-01-01' } })).s === 403, 'chofer NO escribe checklists directo');
  ok((await call(C, 'PUT', '/api/doc/settings/personal', { data: { names: ['x'] } })).s === 403, 'chofer NO edita la lista de nombres directo');
  // y solo lee lo mínimo
  const cv = await call(C, 'GET', '/api/col/vehicles');
  ok(cv.s === 200 && cv.j.length === v.j.length && cv.j.every((r) => Object.keys(r.data).every((k) => ['nombre', 'patente', 'order'].includes(k))), 'chofer ve vehículos solo con nombre y patente');
  const ck = await call(C, 'GET', '/api/col/kmlog');
  ok(ck.s === 200 && ck.j.every((r) => r.data.entries.length <= 1), 'chofer ve solo el último kilometraje');
  ok((await call(C, 'GET', '/api/col/checklists')).j.length === 0, 'chofer NO ve checklists guardados');
  ok((await call(C, 'GET', '/api/doc/settings/alerts')).s === 403, 'chofer NO ve la configuración de alertas');
  ok((await call(C, 'GET', '/api/doc/settings/repuestos')).s === 403, 'chofer NO ve otros repuestos');
  ok((await call(C, 'GET', '/api/alerts/status')).s === 403, 'chofer NO ve el estado de correo');
  // guardar un checklist completo (único modo de escribir del chofer)
  const base = { vid: id, fecha: '2026-01-02', km: 999999, chofer: 'Chofer Prueba', peoneta: '', items: { lbaja: 'bueno', ndel: 'malo', ctab: [] }, notas: { ndel: 'prueba' }, obs: 'prueba', pendientes: ['Neumáticos delanteros (prueba)'], guardarNombres: false, fotos: { ndel: ['data:image/jpeg;base64,/9j/4AAQSkZJRg=='] } };
  ok((await call(C, 'POST', '/api/checklist', Object.assign({}, base, { km: -5 }))).s === 400, 'checklist con km inválido se rechaza');
  ok((await call(C, 'POST', '/api/checklist', Object.assign({}, base, { chofer: '' }))).s === 400, 'checklist sin chofer se rechaza');
  ok((await call(C, 'POST', '/api/checklist', Object.assign({}, base, { vid: 'no-existe' }))).s === 400, 'checklist de vehículo inexistente se rechaza');
  const sv = await call(C, 'POST', '/api/checklist', base);
  ok(sv.s === 200 && sv.j.id, 'chofer guarda un checklist');
  const saved = (await call(A, 'GET', '/api/doc/checklists/' + sv.j.id)).j.data;
  ok(saved.chofer === 'Chofer Prueba' && saved.resp === undefined && saved.fotos && saved.fotos.ndel.length === 1, 'el checklist quedó guardado con su foto y sin responsable');
  const km1 = (await call(A, 'GET', '/api/doc/kmlog/' + id)).j.data;
  ok(km1.entries.length === km0.entries.length + 1 && km1.entries[km1.entries.length - 1].km === 999999, 'se registró el kilometraje del checklist');
  const veh1 = (await call(A, 'GET', '/api/doc/vehicles/' + id)).j.data;
  ok(veh1.pending.length === (v.j[0].data.pending || []).length + 1, 'el punto malo pasó a pendientes');
  ok((await call(C, 'DELETE', '/api/doc/checklists/' + sv.j.id)).s === 403, 'chofer NO puede borrar checklists');
  // limpieza
  await call(A, 'DELETE', '/api/doc/checklists/' + sv.j.id);
  await call(A, 'DELETE', '/api/doc/fotos/' + saved.fotos.ndel[0]);
  await call(A, 'PUT', '/api/doc/kmlog/' + id, { data: km0 });
  await call(A, 'PATCH', '/api/doc/vehicles/' + id, { data: { pending: v.j[0].data.pending || [] } });
  // varios correos y otros repuestos (administrador)
  const al0 = (await call(A, 'GET', '/api/doc/settings/alerts')).j;
  ok((await call(A, 'PUT', '/api/doc/settings/alerts', { data: Object.assign({}, al0.data || {}, { emails: ['uno@prueba.cl', 'dos@prueba.cl'], email: '' }) })).s === 200, 'guarda varios correos');
  const st = await call(A, 'GET', '/api/alerts/status');
  ok(st.s === 200 && st.j.to === 'uno@prueba.cl, dos@prueba.cl', 'el servidor usa todos los correos');
  if (al0.data) await call(A, 'PUT', '/api/doc/settings/alerts', { data: al0.data }); else await call(A, 'DELETE', '/api/doc/settings/alerts');
  ok((await call(A, 'PUT', '/api/doc/settings/repuestos', { data: { items: [{ id: 'r1', nombre: 'Prueba', cant: 2, unid: 'unidades', nota: '' }] } })).s === 200, 'administrador guarda otros repuestos');
  ok((await call(C, 'PUT', '/api/doc/settings/repuestos', { data: { items: [] } })).s === 403, 'chofer NO edita otros repuestos');
  await call(A, 'DELETE', '/api/doc/settings/repuestos');
  ok((await call(C, 'GET', '/api/users')).s === 403, 'chofer NO ve usuarios');
  ok((await call(A, 'PUT', '/api/doc/settings/alertState', { data: { sent: {} } })).s === 403, 'nadie escribe alertState');
  ok((await call(A, 'GET', '/api/alerts/status')).s === 200, 'estado de alertas');
  ok((await call(A, 'DELETE', '/api/users/chofer.test')).s === 200, 'borra el chofer de prueba');
  ok((await call(A, 'DELETE', '/api/users/' + AU)).s === 400, 'no se puede borrar a sí mismo');
  console.log(fails ? '\n' + fails + ' prueba(s) fallaron' : '\nTodo en orden');
  process.exit(fails ? 1 : 0);
})();
