'use strict';
/* Guarda un checklist completo en el servidor (documento, fotos, kilometraje, pendientes y nombres).
   Lo usan todos los roles; es la única forma en que un chofer escribe datos. */
const crypto = require('crypto');
const store = require('./store');

const uid = (p) => p + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
const isStr = (x, max) => typeof x === 'string' && x.length <= max;
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

let chain = Promise.resolve(); // un checklist a la vez, para no pisar kilometraje ni pendientes
const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

function clean(b) {
  if (!b || typeof b !== 'object') throw bad('Datos inválidos');
  if (!isStr(b.vid, 80) || !/^[\w.-]+$/.test(b.vid)) throw bad('Vehículo inválido');
  if (!isStr(b.fecha, 10) || !/^\d{4}-\d{2}-\d{2}$/.test(b.fecha)) throw bad('Fecha inválida');
  const km = Number(b.km);
  if (!Number.isInteger(km) || km < 0 || km > 9999999) throw bad('Kilometraje inválido');
  const chofer = isStr(b.chofer, 80) ? b.chofer.trim() : '';
  if (!chofer) throw bad('Falta el nombre del chofer');
  const peoneta = isStr(b.peoneta, 80) ? b.peoneta.trim() : '';

  const items = {}, notas = {}, fotos = {};
  const bi = b.items && typeof b.items === 'object' && !Array.isArray(b.items) ? b.items : {};
  Object.keys(bi).slice(0, 80).forEach((k) => {
    if (!/^[a-z0-9]{2,20}$/.test(k)) return;
    const v = bi[k];
    if (Array.isArray(v)) items[k] = v.filter((x) => isStr(x, 20)).slice(0, 8);
    else if (v === null || ['bueno', 'regular', 'malo'].includes(v)) items[k] = v;
  });
  const bn = b.notas && typeof b.notas === 'object' && !Array.isArray(b.notas) ? b.notas : {};
  Object.keys(bn).slice(0, 80).forEach((k) => { if (/^[a-z0-9]{2,20}$/.test(k) && isStr(bn[k], 300) && bn[k].trim()) notas[k] = bn[k].trim(); });
  const bf = b.fotos && typeof b.fotos === 'object' && !Array.isArray(b.fotos) ? b.fotos : {};
  let total = 0;
  Object.keys(bf).forEach((k) => {
    if (!/^[a-z0-9]{2,20}$/.test(k) || !Array.isArray(bf[k])) return;
    const L = bf[k].filter((d) => isStr(d, 300000) && d.startsWith('data:image/jpeg;base64,')).slice(0, 3);
    total += L.length; if (total > 60) throw bad('Demasiadas fotos');
    if (L.length) fotos[k] = L;
  });
  const pendientes = (Array.isArray(b.pendientes) ? b.pendientes : []).filter((x) => isStr(x, 300) && x.trim()).slice(0, 40).map((x) => x.trim());
  const clientId = isStr(b.clientId, 40) && /^[a-z0-9]{8,40}$/.test(b.clientId) ? b.clientId : '';
  return { clientId, vid: b.vid, fecha: b.fecha, km, chofer, peoneta, items, notas, fotos, obs: isStr(b.obs, 2000) ? b.obs.trim() : '', pendientes, guardarNombres: !!b.guardarNombres };
}

async function save(body, notify) {
  const c = clean(body);
  return serial(async () => {
    const veh = await store.get('vehicles', c.vid);
    if (!veh) throw bad('El vehículo no existe');
    /* Si el celular reenvía un checklist que ya llegó (se cortó la señal justo al responder), no se duplica. */
    const cid = c.clientId ? 'c' + c.clientId : uid('c');
    if (c.clientId && (await store.get('checklists', cid))) return { id: cid, pendientes: 0, repetido: true };
    const fotoIds = {};
    for (const key of Object.keys(c.fotos)) {
      fotoIds[key] = [];
      for (const d of c.fotos[key]) {
        const pid = uid('f');
        await store.set('fotos', pid, { cid, vid: c.vid, key, d });
        notify('fotos', pid); fotoIds[key].push(pid);
      }
    }
    const doc = { vid: c.vid, fecha: c.fecha, km: c.km, chofer: c.chofer, peoneta: c.peoneta, items: c.items, notas: c.notas, obs: c.obs, at: Date.now() };
    if (Object.keys(fotoIds).length) doc.fotos = fotoIds;
    await store.set('checklists', cid, doc); notify('checklists', cid);

    // kilometraje: mismo criterio que la página (último registro = fecha más reciente)
    const kd = (await store.get('kmlog', c.vid)) || { entries: [] };
    const entries = Array.isArray(kd.entries) ? kd.entries : [];
    let last = null; entries.forEach((x) => { if (!last || x.d >= last.d) last = x; });
    if (!last || last.km !== c.km || last.d !== c.fecha) {
      entries.push({ id: uid('k'), d: c.fecha, km: c.km, nota: 'Checklist · ' + c.chofer });
      await store.set('kmlog', c.vid, { entries }); notify('kmlog', c.vid);
    }
    if (c.pendientes.length) {
      const f = c.fecha.split('-').reverse().join('-');
      const pending = (veh.pending || []).concat(c.pendientes.map((t) => ({ id: uid('p'), text: 'Checklist ' + f + ': ' + t })));
      await store.merge('vehicles', c.vid, { pending }); notify('vehicles', c.vid);
    }
    if (c.guardarNombres) {
      const pe = (await store.get('settings', 'personal')) || { names: [] };
      const names = Array.isArray(pe.names) ? pe.names : [];
      const nuevos = [c.chofer, c.peoneta].filter((n, i, a) => n && !names.includes(n) && a.indexOf(n) === i);
      if (nuevos.length) { await store.set('settings', 'personal', { names: names.concat(nuevos) }); notify('settings', 'personal'); }
    }
    return { id: cid, pendientes: c.pendientes.length };
  });
}

module.exports = { save };
