'use strict';
const { formatRut } = require('./rut');
const { emailOk, waNumber } = require('./util');

const REGIONES = ['Arica y Parinacota', 'Tarapacá', 'Antofagasta', 'Atacama', 'Coquimbo', 'Valparaíso', 'Metropolitana de Santiago',
  "O'Higgins", 'Maule', 'Ñuble', 'Biobío', 'La Araucanía', 'Los Ríos', 'Los Lagos', 'Aysén', 'Magallanes'];

const txt = (v, max = 160) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

// Devuelve { data, errors } con los datos de facturación y despacho del cliente mayorista
function cleanProfile(b) {
  b = b || {};
  const errors = {};
  const d = {
    razon_social: txt(b.razon_social), rut: '', giro: txt(b.giro),
    direccion: txt(b.direccion), comuna: txt(b.comuna, 80), ciudad: txt(b.ciudad, 80), region: txt(b.region, 80),
    telefono: txt(b.telefono, 30), email_fact: txt(b.email_fact, 120).toLowerCase(),
    contacto_nombre: txt(b.contacto_nombre, 100), whatsapp: txt(b.whatsapp, 30),
    despacho_igual: b.despacho_igual !== false,
    despacho_direccion: '', despacho_comuna: '', despacho_ciudad: '',
    obs: txt(b.obs, 300),
  };
  const need = (k, msg) => { if (!d[k]) errors[k] = msg; };
  need('razon_social', 'Escribe la razón social');
  const rut = formatRut(b.rut);
  if (!rut) errors.rut = 'El RUT no es válido'; else d.rut = rut;
  need('giro', 'Escribe el giro');
  need('direccion', 'Escribe la dirección');
  need('comuna', 'Escribe la comuna');
  need('ciudad', 'Escribe la ciudad');
  if (!REGIONES.includes(d.region)) errors.region = 'Elige la región';
  need('telefono', 'Escribe un teléfono');
  if (!emailOk(d.email_fact)) errors.email_fact = 'Escribe un correo válido para enviar las facturas';
  need('contacto_nombre', 'Escribe el nombre de quien hace los pedidos');
  if (!waNumber(d.whatsapp)) errors.whatsapp = 'Escribe un celular válido (ej. 9 1234 5678)';
  else d.whatsapp = '+' + waNumber(d.whatsapp);
  if (!d.despacho_igual) {
    d.despacho_direccion = txt(b.despacho_direccion); d.despacho_comuna = txt(b.despacho_comuna, 80); d.despacho_ciudad = txt(b.despacho_ciudad, 80);
    if (!d.despacho_direccion) errors.despacho_direccion = 'Escribe la dirección de despacho';
    if (!d.despacho_comuna) errors.despacho_comuna = 'Escribe la comuna de despacho';
  }
  return { data: d, errors, ok: !Object.keys(errors).length };
}

module.exports = { cleanProfile, REGIONES };
