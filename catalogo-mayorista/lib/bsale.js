'use strict';
/* Cliente de la API de Bsale (https://api.bsale.io/v1, cabecera access_token).
   Devuelve, por SKU, el stock sumado de las sucursales pedidas, el precio de la lista elegida y el nombre. */
const BASE = process.env.BSALE_URL || 'https://api.bsale.io/v1';
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeClient({ token, fetchImpl, pauseMs } = {}) {
  const f = fetchImpl || fetch;
  const pause = pauseMs == null ? 150 : pauseMs; // Bsale limita las consultas por segundo
  async function get(path, tries = 4) {
    const url = path.startsWith('http') ? path : BASE + path;
    for (let i = 0; i < tries; i++) {
      const r = await f(url, { headers: { access_token: token, Accept: 'application/json' } });
      if (r.ok) { if (pause) await sleep(pause); return r.json(); }
      if ((r.status === 429 || r.status >= 500) && i < tries - 1) { await sleep(1000 * (i + 1)); continue; }
      throw new Error('Bsale ' + r.status + ' en ' + path.split('?')[0]);
    }
  }
  // Recorre todas las páginas (limit máx. 50)
  async function all(path, sep) {
    const out = [];
    let offset = 0;
    for (;;) {
      const j = await get(path + (path.includes('?') ? '&' : '?') + 'limit=50&offset=' + offset);
      const items = (j && j.items) || [];
      out.push(...items);
      if (!j || !j.next || items.length < 1) break;
      offset += 50;
    }
    return out;
  }
  return { get, all };
}

// "Talca,Bodega Adicional" -> coincide con el nombre de la sucursal sin importar tildes ni mayúsculas
function pickOffices(offices, wanted) {
  const w = wanted.map(norm).filter(Boolean);
  return offices.filter((o) => w.some((x) => norm(o.name) === x) ).concat(
    offices.filter((o) => !w.some((x) => norm(o.name) === x) && w.some((x) => norm(o.name).includes(x)))
  );
}

// Medida "205/55R16" -> {medida, aro}
function parseMedida(name) {
  const m = String(name).match(/(\d{3})\s*[\/xX]\s*(\d{2,3}(?:[.,]\d)?)\s*(?:Z?R|ZR|-)?\s*(\d{2}(?:[.,]\d)?)/);
  if (m) return { medida: `${m[1]}/${m[2]}R${m[3]}`.replace(',', '.'), aro: m[3].replace(',', '.') };
  const a = String(name).match(/\bR\s?(\d{2})\b/i);
  return { medida: '', aro: a ? a[1] : '' };
}

async function fetchCatalog(client, opts) {
  const { offices: wantedOffices, priceListId, priceListName, priceMode } = opts;
  const log = opts.log || (() => {});

  // 1) sucursales
  const offices = await client.all('/offices.json');
  const chosen = pickOffices(offices, wantedOffices);
  if (!chosen.length) throw new Error('No encontré las sucursales (' + wantedOffices.join(', ') + ') en Bsale. Disponibles: ' + offices.map((o) => o.name).join(', '));
  if (chosen.length < wantedOffices.length) log('Aviso: solo se encontraron ' + chosen.map((o) => o.name).join(', '));

  // 2) stock por variante, sumando sucursales
  const stock = new Map();
  for (const o of chosen) {
    const rows = await client.all('/stocks.json?officeid=' + o.id);
    for (const s of rows) {
      const vid = s.variant && s.variant.id;
      if (!vid) continue;
      const q = Number(s.quantityAvailable != null ? s.quantityAvailable : s.quantity) || 0;
      stock.set(vid, (stock.get(vid) || 0) + q);
    }
  }

  // 3) lista de precios
  let plId = priceListId;
  if (!plId) {
    const lists = await client.all('/price_lists.json');
    const hit = lists.find((l) => l.state === 0 && norm(l.name).includes(norm(priceListName))) || lists.find((l) => norm(l.name).includes(norm(priceListName)));
    if (!hit) throw new Error('No encontré la lista de precios "' + priceListName + '". Disponibles: ' + lists.map((l) => l.name).join(', '));
    plId = hit.id;
  }
  const price = new Map();
  for (const d of await client.all('/price_lists/' + plId + '/details.json')) {
    const vid = d.variant && d.variant.id;
    if (!vid) continue;
    const p = priceMode === 'iva' ? d.variantValueWithTaxes : d.variantValue;
    price.set(vid, Number(p) || 0);
  }

  // 4) nombres (variantes activas con su producto) y tipo de producto como categoría
  let types = new Map();
  try { (await client.all('/product_types.json')).forEach((t) => types.set(t.id, t.name)); } catch (e) { log('Sin categorías: ' + e.message); }
  const variants = await client.all('/variants.json?state=0&expand=[product]');

  const items = [];
  for (const v of variants) {
    const sku = String(v.code || '').trim().toUpperCase();
    if (!sku) continue;
    const prod = v.product || {};
    let name = String(prod.name || '').trim();
    const desc = String(v.description || '').trim();
    if (desc && !norm(name).includes(norm(desc))) name = (name + ' ' + desc).trim();
    if (!name) name = sku;
    const typeId = prod.productType && prod.productType.id;
    const pm = parseMedida(name);
    items.push({
      sku, variantId: v.id, name, category: types.get(typeId) || '',
      medida: pm.medida, aro: pm.aro,
      price: price.get(v.id) || 0,
      stock: Math.max(0, Math.floor(stock.get(v.id) || 0)),
    });
  }
  return { items, offices: chosen.map((o) => o.name), priceListId: plId };
}

module.exports = { makeClient, fetchCatalog, pickOffices, parseMedida, norm };
