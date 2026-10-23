'use strict';
/* Demostración local sin Postgres, Bsale ni Drive: datos de ejemplo en memoria.
   Uso: node scripts/demo.js   (puerto 3100; cada producto es un juego x4, precio con IVA incluido)
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
  const P = [['RN-1475100', 'LLANTA ACERO 14X5.5 4X100 ET38', 'Acero', '14x5.5 · 4x100 · ET38', '14', '5.5', '4x100', '38', 32920, 40],
    ['RN-1575100', 'LLANTA ALEACION 15X6 4X100 ET40 NEGRO', 'Aleación', '15x6 · 4x100 · ET40', '15', '6', '4x100', '40', 54920, 24],
    ['RN-16711443', 'LLANTA ALEACION 16X7 5X114.3 ET40 GRAFITO', 'Aleación', '16x7 · 5x114.3 · ET40', '16', '7', '5x114.3', '40', 69920, 16],
    ['RN-17751143', 'LLANTA ALEACION 17X7.5 5X114.3 ET38 NEGRO MATE', 'Aleación', '17x7.5 · 5x114.3 · ET38', '17', '7.5', '5x114.3', '38', 89920, 8],
    ['RN-17751397', 'LLANTA ACERO REFORZADA 17X7.5 6X139.7 ET25', 'Acero', '17x7.5 · 6x139.7 · ET25', '17', '7.5', '6x139.7', '25', 74920, 12],
    ['RN-18851143', 'LLANTA ALEACION 18X8.5 5X114.3 ET35 DIAMANTADA', 'Aleación', '18x8.5 · 5x114.3 · ET35', '18', '8.5', '5x114.3', '35', 119920, 3]];
  for (const p of P) await pool.query('INSERT INTO products(sku,name,category,medida,aro,ancho,pcd,et,price,stock) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', p);
  const app = createApp(pool, {});
  app.listen(3100, () => console.log('Demo en http://localhost:3100'));
})();
