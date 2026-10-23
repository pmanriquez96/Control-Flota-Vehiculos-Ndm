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
// Una sucursal por cada nombre pedido: coincidencia exacta; solo si no hay exacta, una que lo contenga.
// Si un nombre calza con varias sucursales se detiene, para no sumar stock de sucursales que no corresponden.
function pickOffices(offices, wanted) {
  const out = [];
  for (const w of wanted.map(norm).filter(Boolean)) {
    const exact = offices.filter((o) => norm(o.name) === w);
    const hit = exact.length ? exact : offices.filter((o) => norm(o.name).includes(w));
    if (hit.length > 1) throw new Error('El nombre de sucursal "' + w + '" coincide con varias (' + hit.map((o) => o.name).join(', ') + '). Escríbelo igual que en Bsale.');
    if (hit[0] && !out.includes(hit[0])) out.push(hit[0]);
  }
  return out;
}

// Datos del rin que vienen en el nombre: "LLANTA ALEACION 16X7 5X114.3 ET40" -> aro 16, ancho 7, PCD 5x114.3, ET 40
function parseRin(name) {
  let s = ' ' + String(name).toUpperCase().replace(/,/g, '.') + ' ';
  const out = { aro: '', ancho: '', pcd: '', et: '' };
  // PCD: pernos x distancia (5X114.3, 4X100, 5/112, 6H139.7, 5X100/114.3)
  const re = /(?<![\d.])([3-8])\s*(?:X|\/|H)\s*(\d{2,3}(?:\.\d{1,2})?)(?:\s*\/\s*(\d{2,3}(?:\.\d{1,2})?))?(?![\d])/g;
  let m;
  while ((m = re.exec(s))) {
    if (Number(m[2]) >= 98 && Number(m[2]) <= 180) {
      out.pcd = m[1] + 'x' + m[2] + (m[3] ? '/' + m[3] : '');
      s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length);
      break;
    }
  }
  const et = s.match(/\bET\s?(-?\d{1,3})\b/);
  if (et) out.et = et[1];
  // Aro y ancho: "16X7", "7JX16", "17X7.5": el mayor (12 a 26) es el aro y el otro el ancho (4 a 14)
  const d = s.match(/(?<![\d.])(\d{1,2}(?:\.\d)?)\s*J?\s*X\s*(\d{1,2}(?:\.\d)?)(?![\d])/);
  if (d) {
    const a = Number(d[1]), b = Number(d[2]), hi = Math.max(a, b), lo = Math.min(a, b);
    if (hi >= 12 && hi <= 26 && lo >= 4 && lo <= 14) { out.aro = String(hi); out.ancho = String(lo); }
  }
  if (!out.aro) { const r = s.match(/\b(?:ARO|RIN|R)\s?(\d{2})\b/); if (r) out.aro = r[1]; }
  out.medida = [out.aro && out.ancho ? out.aro + 'x' + out.ancho : out.aro ? 'Aro ' + out.aro : '', out.pcd, out.et ? 'ET' + out.et : ''].filter(Boolean).join(' · ');
  return out;
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
  // Se guarda por separado la sucursal principal (de donde se despacha y se emiten los documentos: Talca)
  // y el resto (Bodega Adicional); el catálogo usa la suma.
  const main = pickOffices(chosen, [opts.mainOffice || wantedOffices[0]])[0] || chosen[0];
  // Solo cuentan estas sucursales. El total es la suma real (un saldo negativo en una resta de la otra, para no vender de más);
  // cada sucursal se muestra por separado sin negativos.
  const stock = new Map(), stockMain = new Map(), stockOther = new Map();
  for (const o of chosen) {
    const rows = await client.all('/stocks.json?officeid=' + o.id);
    for (const s of rows) {
      const vid = s.variant && s.variant.id;
      if (!vid) continue;
      const q = Number(s.quantityAvailable != null ? s.quantityAvailable : s.quantity) || 0;
      stock.set(vid, (stock.get(vid) || 0) + q);
      const m = o.id === main.id ? stockMain : stockOther;
      m.set(vid, (m.get(vid) || 0) + q);
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
    const pm = parseRin(name);
    items.push({
      sku, variantId: v.id, name, category: types.get(typeId) || '',
      medida: pm.medida, aro: pm.aro, ancho: pm.ancho, pcd: pm.pcd, et: pm.et,
      price: price.get(v.id) || 0,
      stock: Math.max(0, Math.floor(stock.get(v.id) || 0)),
      stockTalca: Math.max(0, Math.floor(stockMain.get(v.id) || 0)),
      stockBodega: Math.max(0, Math.floor(stockOther.get(v.id) || 0)),
    });
  }
  return { items, offices: chosen.map((o) => o.name), mainOffice: main.name, priceListId: plId };
}

/* Stock actualizado solo de algunas variantes (por ejemplo, las de un pedido), sin esperar la sincronización completa.
   Devuelve Map<variantId, {talca, bodega, total}> con las mismas reglas que fetchCatalog. */
async function fetchStockFor(client, opts, variantIds) {
  const offices = await client.all('/offices.json');
  const chosen = pickOffices(offices, opts.offices);
  if (!chosen.length) throw new Error('No encontré las sucursales en Bsale');
  const main = pickOffices(chosen, [opts.mainOffice || opts.offices[0]])[0] || chosen[0];
  const out = new Map(variantIds.map((v) => [v, { talca: 0, bodega: 0, raw: 0 }]));
  for (const vid of variantIds) {
    for (const o of chosen) {
      const rows = await client.all('/stocks.json?variantid=' + vid + '&officeid=' + o.id);
      for (const s of rows) {
        if (s.variant && s.variant.id && s.variant.id !== vid) continue;
        const q = Number(s.quantityAvailable != null ? s.quantityAvailable : s.quantity) || 0;
        const r = out.get(vid);
        r.raw += q;
        if (o.id === main.id) r.talca += q; else r.bodega += q;
      }
    }
  }
  const res = new Map();
  for (const [vid, r] of out) res.set(vid, { talca: Math.max(0, Math.floor(r.talca)), bodega: Math.max(0, Math.floor(r.bodega)), total: Math.max(0, Math.floor(r.raw)) });
  return res;
}

module.exports = { makeClient, fetchCatalog, fetchStockFor, pickOffices, parseRin, norm };
