'use strict';
const { Pool } = require('pg');

function makePool() {
  if (!process.env.DATABASE_URL) {
    console.error('Falta DATABASE_URL. Define la conexión a Postgres (ver .env.example).');
    process.exit(1);
  }
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : false,
    max: 8,
  });
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id serial PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  role text NOT NULL,
  pass text NOT NULL,
  phone text NOT NULL DEFAULT '',
  seller_id int,
  active boolean NOT NULL DEFAULT true,
  must_change boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS customers (
  user_id int PRIMARY KEY,
  data jsonb NOT NULL,
  completed boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS products (
  sku text PRIMARY KEY,
  variant_id int,
  name text NOT NULL DEFAULT '',
  category text NOT NULL DEFAULT '',
  medida text NOT NULL DEFAULT '',
  aro text NOT NULL DEFAULT '',
  ancho text NOT NULL DEFAULT '',
  pcd text NOT NULL DEFAULT '',
  et text NOT NULL DEFAULT '',
  price double precision NOT NULL DEFAULT 0,
  stock int NOT NULL DEFAULT 0,
  stock_talca int NOT NULL DEFAULT 0,
  stock_bodega int NOT NULL DEFAULT 0,
  hidden boolean NOT NULL DEFAULT false,
  synced_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS photos (
  file_id text PRIMARY KEY,
  sku text NOT NULL,
  pos int NOT NULL DEFAULT 0,
  name text NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS orders (
  id serial PRIMARY KEY,
  customer_id int NOT NULL,
  seller_id int NOT NULL,
  estado text NOT NULL DEFAULT 'nuevo',
  notes text NOT NULL DEFAULT '',
  internal_note text NOT NULL DEFAULT '',
  customer jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS order_items (
  id serial PRIMARY KEY,
  order_id int NOT NULL,
  sku text NOT NULL,
  name text NOT NULL,
  qty int NOT NULL,
  price double precision NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS kv (
  k text PRIMARY KEY,
  v jsonb NOT NULL
);`;

// Columnas agregadas después de la primera versión (para bases que ya existían)
const MIGRATIONS = [
  'ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_talca int NOT NULL DEFAULT 0',
  'ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_bodega int NOT NULL DEFAULT 0',
];
async function init(pool) {
  await pool.query(SCHEMA);
  for (const m of MIGRATIONS) await pool.query(m);
}

// Transacción en una sola conexión (pool.query puede usar conexiones distintas)
async function withTx(pool, fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (x) { /* ignorar */ }
    throw e;
  } finally { c.release(); }
}

module.exports = { makePool, init, withTx };
