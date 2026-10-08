'use strict';
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('Falta DATABASE_URL. Define la conexión a Postgres (ver .env.example).');
  process.exit(1);
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : false,
  max: 8,
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS docs (
      col text NOT NULL,
      id text NOT NULL,
      data jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (col, id)
    );
    CREATE TABLE IF NOT EXISTS users (
      username text PRIMARY KEY,
      name text NOT NULL,
      role text NOT NULL CHECK (role IN ('admin','editor','chofer')),
      pass text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );`);
}

const q = (text, params) => pool.query(text, params);

module.exports = {
  pool, init,
  ping: () => q('select 1'),
  async list(col) { return (await q('select id, data from docs where col=$1 order by id', [col])).rows; },
  async get(col, id) { const r = await q('select data from docs where col=$1 and id=$2', [col, id]); return r.rows[0] ? r.rows[0].data : null; },
  async set(col, id, data) {
    await q(`insert into docs(col,id,data) values($1,$2,$3)
             on conflict (col,id) do update set data=excluded.data, updated_at=now()`, [col, id, data]);
  },
  // Mezcla campos de primer nivel. Devuelve false si el documento no existe.
  async merge(col, id, patch) {
    const r = await q('update docs set data = data || $3::jsonb, updated_at=now() where col=$1 and id=$2', [col, id, JSON.stringify(patch)]);
    return r.rowCount > 0;
  },
  async del(col, id) { await q('delete from docs where col=$1 and id=$2', [col, id]); },
  async count(col) { return Number((await q('select count(*) from docs where col=$1', [col])).rows[0].count); },

  async getUser(u) { return (await q('select username,name,role,pass from users where username=$1', [u])).rows[0] || null; },
  async listUsers() { return (await q('select username,name,role,created_at from users order by created_at')).rows; },
  async countUsers() { return Number((await q('select count(*) from users')).rows[0].count); },
  async createUser(username, name, role, pass) { await q('insert into users(username,name,role,pass) values($1,$2,$3,$4)', [username, name, role, pass]); },
  async updateUser(username, f) {
    const sets = [], vals = [username];
    for (const k of ['name', 'role', 'pass']) if (f[k] != null) { vals.push(f[k]); sets.push(`${k}=$${vals.length}`); }
    if (!sets.length) return false;
    return (await q(`update users set ${sets.join(',')} where username=$1`, vals)).rowCount > 0;
  },
  async deleteUser(u) { return (await q('delete from users where username=$1', [u])).rowCount > 0; },
  async countAdmins() { return Number((await q("select count(*) from users where role='admin'")).rows[0].count); },
};
