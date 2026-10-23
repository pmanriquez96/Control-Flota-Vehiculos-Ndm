'use strict';
const { norm } = require('./bsale');

const emailOk = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || '').trim());

// Teléfono chileno -> solo dígitos con 56 al comienzo ("" si no parece un número)
function waNumber(s) {
  let d = String(s || '').replace(/\D/g, '');
  if (d.startsWith('0056')) d = d.slice(2);
  if (d.length === 9) d = '56' + d;
  if (d.length === 8) d = '569' + d;
  return /^56\d{9}$/.test(d) ? d : '';
}

// Para buscar "205 55 16" dentro de "205/55R16"
const squash = (s) => norm(s).replace(/[^a-z0-9]/g, '');
function matches(haystack, query) {
  const toks = norm(query).split(/\s+/).map((t) => t.replace(/[^a-z0-9]/g, '')).filter(Boolean);
  if (!toks.length) return true;
  const h = squash(haystack);
  return toks.every((t) => h.includes(t));
}

const clp = (n) => '$' + Math.round(n).toLocaleString('es-CL');

module.exports = { emailOk, waNumber, matches, clp };
