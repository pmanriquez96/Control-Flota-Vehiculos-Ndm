'use strict';
const fs = require('fs');
const path = require('path');
const store = require('./store');

/* Carga los datos iniciales (los 9 vehículos del Excel) solo si todavía no hay vehículos. */
async function seedIfEmpty() {
  if ((await store.count('vehicles')) > 0) return false;
  const dir = path.join(__dirname, '..', 'seed');
  const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    let m;
    if ((m = f.match(/^veh_(.+)\.json$/))) { await store.set('vehicles', m[1], read(f)); n++; }
    else if ((m = f.match(/^km_(.+)\.json$/))) await store.set('kmlog', m[1], read(f));
  }
  const alerts = read('settings.json');
  if (process.env.ALERT_EMAIL) alerts.email = process.env.ALERT_EMAIL;
  if (!(await store.get('settings', 'alerts'))) await store.set('settings', 'alerts', alerts);
  if (!(await store.get('settings', 'personal'))) await store.set('settings', 'personal', read('personal.json'));
  console.log(`Datos iniciales cargados: ${n} vehículos.`);
  return true;
}
module.exports = { seedIfEmpty };
