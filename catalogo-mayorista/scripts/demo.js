'use strict';
/* Demostración local sin Postgres, Bsale ni Drive: datos de ejemplo en memoria.
   Uso: node scripts/demo.js   (puerto 3100)
   Usuarios: admin@demo.cl / vendedor@demo.cl / cliente@demo.cl — clave "demo1234" (el cliente parte con su primer ingreso). */
process.env.SESSION_SECRET = 'demo';
const { newDb } = require('pg-mem');
const db = require('../lib/db');
const auth = require('../lib/auth');
const { createApp } = require('../server');

(async () => {
  const pool = new (newDb().adapters.createPg().Pool)();
  await db.init(pool);
  const ins = (e, n, r, p, extra) => pool.query('INSERT INTO users(email,name,role,pass,phone,seller_id,must_change) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id', [e, n, r, auth.hashPassword('demo1234'), p, extra || null, r === 'mayorista']);
  await ins('admin@demo.cl', 'Administrador', 'admin', '');
  const v = (await ins('vendedor@demo.cl', 'María Soto', 'vendedor', '+56 9 8765 4321')).rows[0].id;
  await ins('cliente@demo.cl', 'Cliente Demo', 'mayorista', '', v);
  const P = [['LL-2055516', 'LLANTA 205/55R16 91V CINTURATO', 'Llantas', '205/55R16', '16', 78900, 24], ['LL-2656517', 'LLANTA 265/65R17 112T DUELER', 'Llantas', '265/65R17', '17', 139900, 8],
    ['LL-1956515', 'LLANTA 195/65R15 91H ENERGY', 'Llantas', '195/65R15', '15', 59900, 40], ['LL-2254518', 'LLANTA 225/45R18 95W PILOT', 'Llantas', '225/45R18', '18', 164900, 3]];
  for (const p of P) await pool.query('INSERT INTO products(sku,name,category,medida,aro,price,stock) VALUES($1,$2,$3,$4,$5,$6,$7)', p);
  const app = createApp(pool, {});
  app.listen(3100, () => console.log('Demo en http://localhost:3100'));
})();
