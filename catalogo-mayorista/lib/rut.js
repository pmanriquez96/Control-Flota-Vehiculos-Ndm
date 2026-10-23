'use strict';
// RUT chileno: módulo 11. Devuelve "12.345.678-5" o null si no es válido.
function cleanRut(s) { return String(s || '').replace(/[^0-9kK]/g, '').toUpperCase(); }
function dv(num) {
  let sum = 0, mul = 2;
  for (let i = num.length - 1; i >= 0; i--) { sum += Number(num[i]) * mul; mul = mul === 7 ? 2 : mul + 1; }
  const r = 11 - (sum % 11);
  return r === 11 ? '0' : r === 10 ? 'K' : String(r);
}
function formatRut(s) {
  const c = cleanRut(s);
  if (c.length < 2) return null;
  const body = c.slice(0, -1), d = c.slice(-1);
  if (!/^\d{6,9}$/.test(body) || dv(body) !== d) return null;
  return body.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + '-' + d;
}
module.exports = { formatRut };
