'use strict';
const { fetchCatalog } = require('./bsale');
const { withTx } = require('./db');

const state = { running: false, last: null };

async function setKv(pool, k, v) {
  await pool.query('INSERT INTO kv(k,v) VALUES($1,$2) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v', [k, JSON.stringify(v)]);
}
async function getKv(pool, k) {
  const r = await pool.query('SELECT v FROM kv WHERE k=$1', [k]);
  return r.rows[0] ? r.rows[0].v : null;
}

/* Sincroniza productos (Bsale) y, si hay Drive, el índice de fotos.
   bsale: { client, opts } · drive: { buildIndex } | null */
async function runSync(pool, { bsale, drive, forcePhotos }) {
  if (state.running) return { ok: false, error: 'Ya hay una sincronización en curso' };
  state.running = true;
  const started = new Date();
  const res = { ok: true, at: started.toISOString(), productos: 0, conStock: 0, fotos: null, avisos: [] };
  try {
    if (bsale) {
      const cat = await fetchCatalog(bsale.client, Object.assign({ log: (m) => res.avisos.push(m) }, bsale.opts));
      const stamp = new Date(started.getTime());
      await withTx(pool, async (c) => {
        for (const p of cat.items) {
          await c.query(
            `INSERT INTO products(sku,variant_id,name,category,medida,aro,ancho,pcd,et,price,stock,stock_talca,stock_bodega,synced_at)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
             ON CONFLICT (sku) DO UPDATE SET variant_id=EXCLUDED.variant_id,name=EXCLUDED.name,category=EXCLUDED.category,
               medida=EXCLUDED.medida,aro=EXCLUDED.aro,ancho=EXCLUDED.ancho,pcd=EXCLUDED.pcd,et=EXCLUDED.et,
               price=EXCLUDED.price,stock=EXCLUDED.stock,stock_talca=EXCLUDED.stock_talca,stock_bodega=EXCLUDED.stock_bodega,synced_at=EXCLUDED.synced_at`,
            [p.sku, p.variantId, p.name, p.category, p.medida, p.aro, p.ancho, p.pcd, p.et, p.price, p.stock, p.stockTalca, p.stockBodega, stamp]);
        }
        // lo que ya no vino en Bsale queda sin stock
        await c.query('UPDATE products SET stock=0, stock_talca=0, stock_bodega=0 WHERE synced_at < $1', [stamp]);
      });
      res.productos = cat.items.length;
      res.conStock = cat.items.filter((p) => p.stock > 0 && p.price > 0).length;
      res.sucursales = cat.offices;
      res.sucursalPrincipal = cat.mainOffice;
      res.listaPrecios = cat.priceListId;
    }
    if (drive) {
      const prev = await getKv(pool, 'photosAt');
      const stale = !prev || Date.now() - new Date(prev).getTime() > 55 * 60000;
      if (forcePhotos || stale) {
        try {
          const index = await drive.buildIndex();
          const skus = (await pool.query('SELECT sku FROM products')).rows.map((r) => r.sku);
          let n = 0;
          await withTx(pool, async (c) => {
            await c.query('DELETE FROM photos');
            for (const sku of skus) {
              const list = index.get(sku) || [];
              for (let i = 0; i < list.length; i++) {
                await c.query('INSERT INTO photos(file_id,sku,pos,name) VALUES($1,$2,$3,$4) ON CONFLICT (file_id) DO NOTHING', [list[i].id, sku, i, list[i].name]);
                n++;
              }
            }
          });
          res.fotos = n;
          await setKv(pool, 'photosAt', new Date().toISOString());
        } catch (e) { res.avisos.push('Fotos: ' + e.message); }
      }
    }
  } catch (e) {
    res.ok = false; res.error = e.message;
  } finally {
    state.running = false;
    res.ms = Date.now() - started.getTime();
    state.last = res;
    try { await setKv(pool, 'lastSync', res); } catch (e) { /* ignorar */ }
  }
  return res;
}

module.exports = { runSync, getKv, setKv, state };
