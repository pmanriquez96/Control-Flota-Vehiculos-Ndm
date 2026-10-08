'use strict';
/* Misma lógica de alertas que usa la página (public/index.html: mantSt, dueSt, buildAlerts),
   pero calculada en el servidor para poder enviar el correo sin que nadie tenga la página abierta.
   Si cambias las reglas en la página, cámbialas también aquí. */
const nodemailer = require('nodemailer');
const store = require('./store');

const MES3 = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const fmt = (n) => (n == null || n === '' ? '—' : Number(n).toLocaleString('es-CL'));
const mlab = (m) => { if (!m) return 'Sin fecha'; const p = m.split('-'); return MES3[+p[1] - 1] + ' ' + p[0]; };

function todayParts() {
  const s = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date());
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d, date: new Date(y, m - 1, d), str: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` };
}

function curKm(km) {
  const e = (km && km.entries) || [];
  let best = null;
  e.forEach((x) => { if (!best || x.d >= best.d) best = x; });
  return best;
}
function mantSt(v, km, thr) {
  const c = curKm(km);
  if (!v.nextKm) return { s: 'none' };
  if (!c) return { s: 'none' };
  const rem = v.nextKm - c.km;
  if (rem < 0) return { s: 'bad', rem, c };
  if (rem <= thr) return { s: 'warn', rem, c };
  return { s: 'ok', rem, c };
}
function dueSt(m, dia, t) {
  if (!m) return { s: 'none' };
  const p = m.split('-').map(Number), y = p[0], mo = p[1];
  const end = dia ? new Date(y, mo - 1, dia) : new Date(y, mo, 0);
  const lastPrev = new Date(y, mo - 1, 0);
  const start = new Date(lastPrev.getFullYear(), lastPrev.getMonth(), lastPrev.getDate() - 6);
  const lab = (dia ? dia + ' ' : '') + mlab(m);
  if (t > end) return { s: 'bad', lab };
  if (t >= start) return { s: 'warn', lab };
  return { s: 'ok', lab };
}

async function buildAlerts() {
  const cfg = Object.assign({ email: '', mantOn: true, mantKm: 1000, rtOn: true, permOn: true }, await store.get('settings', 'alerts'));
  const thr = Number(cfg.mantKm) || 1000;
  const t = todayParts().date;
  const vehicles = await store.list('vehicles');
  const kms = Object.fromEntries((await store.list('kmlog')).map((r) => [r.id, r.data]));
  const out = [];
  vehicles.sort((a, b) => (a.data.order || 0) - (b.data.order || 0)).forEach(({ id, data: v }) => {
    const ms = mantSt(v, kms[id], thr);
    if (cfg.mantOn && (ms.s === 'warn' || ms.s === 'bad')) {
      out.push({ key: `mant|${id}|${ms.s}`, v, kind: 'Mantención', s: ms.s,
        txt: ms.s === 'bad'
          ? `pasó el kilometraje de la próxima mantención por ${fmt(-ms.rem)} km (actual ${fmt(ms.c.km)} km, próxima ${fmt(v.nextKm)} km)`
          : `faltan ${fmt(ms.rem)} km (actual ${fmt(ms.c.km)} km, próxima ${fmt(v.nextKm)} km)` });
    }
    [['rt', 'Revisión técnica', v.rt, v.rtDia, 'rtOn'], ['perm', 'Permiso de circulación', v.permiso, null, 'permOn']].forEach((x) => {
      const st = dueSt(x[2], x[3], t);
      if (cfg[x[4]] && (st.s === 'warn' || st.s === 'bad')) {
        out.push({ key: `${x[0]}|${id}|${x[2]}|${st.s}`, v, kind: x[1], s: st.s, txt: (st.s === 'bad' ? 'vencida desde ' : 'vence ') + st.lab });
      }
    });
  });
  out.sort((a, b) => (a.s === 'bad' ? 0 : 1) - (b.s === 'bad' ? 0 : 1));
  return { cfg, alerts: out };
}

function message(alerts) {
  const d = todayParts().str.split('-').reverse().join('-');
  const lines = alerts.map((a) => `• ${a.kind.toUpperCase()} – ${a.v.nombre} (${a.v.patente}): ${a.txt}.`);
  return {
    subject: `Alertas de flota NDM – ${d} (${alerts.length})`,
    text: alerts.length ? `Hola,\n\nEstas son las alertas de la flota al ${d}:\n\n${lines.join('\n')}\n\nRegistro Vehículos NDM` : `Sin alertas activas al ${d}.`,
  };
}

function transporter() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  const port = Number(process.env.SMTP_PORT) || 465;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST, port,
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE !== 'false' : port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}
const mailReady = () => !!transporter();

async function sendMail(to, subject, text) {
  const tr = transporter();
  if (!tr) throw new Error('El correo no está configurado en el servidor (faltan variables SMTP_*).');
  await tr.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text });
}

/* Revisa las alertas y envía correo solo cuando hay alguna nueva
   (o cada 7 días mientras sigan activas). */
let running = false;
async function check({ force = false } = {}) {
  if (running) return { skipped: true };
  running = true;
  try {
    const { cfg, alerts } = await buildAlerts();
    const to = cfg.email || process.env.ALERT_EMAIL || '';
    const state = (await store.get('settings', 'alertState')) || { sent: {} };
    const nowMs = Date.now(), WEEK = 7 * 864e5;
    const active = Object.fromEntries(alerts.map((a) => [a.key, true]));
    const sent = {};
    Object.keys(state.sent || {}).forEach((k) => { if (active[k]) sent[k] = state.sent[k]; });
    const due = alerts.filter((a) => !sent[a.key] || nowMs - sent[a.key] > WEEK);
    const res = { alerts: alerts.length, pending: due.length, sent: false, to, mail: mailReady() };
    if ((due.length || (force && alerts.length)) && to && mailReady()) {
      const m = message(alerts);
      await sendMail(to, m.subject, m.text);
      alerts.forEach((a) => { sent[a.key] = nowMs; });
      res.sent = true;
    }
    await store.set('settings', 'alertState', { sent, checkedAt: nowMs });
    return res;
  } finally { running = false; }
}

let timer = null;
function schedule() {
  const every = Math.max(5, Number(process.env.ALERT_CHECK_MINUTES) || 60) * 60000;
  setTimeout(() => check().catch((e) => console.error('alertas:', e.message)), 15000);
  setInterval(() => check().catch((e) => console.error('alertas:', e.message)), every);
}
/* Para revisar poco después de registrar kilometraje o editar papeles */
function checkSoon() {
  clearTimeout(timer);
  timer = setTimeout(() => check().catch((e) => console.error('alertas:', e.message)), 20000);
}

module.exports = { check, checkSoon, schedule, buildAlerts, message, sendMail, mailReady };
