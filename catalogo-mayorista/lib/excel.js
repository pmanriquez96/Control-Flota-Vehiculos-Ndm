'use strict';
const ExcelJS = require('exceljs');

const TEAL = 'FF0A6165', SOFT = 'FFE4F1F1', GRAY = 'FF5D6F72';
const CLP = '"$"#,##0';
const ESTADO = { nuevo: 'Nuevo', revision: 'En revisión', confirmado: 'Confirmado', rechazado: 'Rechazado', cancelado: 'Cancelado' };

// Pedido (tal como lo entrega shape() en server.js) -> archivo .xlsx. El precio es por juego, con IVA incluido.
async function buildOrderXlsx(o, { empresa, juego }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = empresa; wb.created = new Date();
  const ws = wb.addWorksheet('Pedido', { pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }, views: [{ showGridLines: false }] });
  ws.columns = [{ width: 18 }, { width: 52 }, { width: 10 }, { width: 11 }, { width: 18 }, { width: 18 }];

  const c = o.cliente || {};
  const fecha = new Date(o.fecha);
  const title = ws.addRow([empresa + ' · Pedido ' + o.codigo]);
  ws.mergeCells(title.number, 1, title.number, 6);
  title.font = { bold: true, size: 15, color: { argb: 'FFFFFFFF' } };
  title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TEAL } };
  title.height = 26; title.alignment = { vertical: 'middle' };
  ws.addRow([]);

  const info = (k, v) => {
    const r = ws.addRow([k, v == null ? '' : v]);
    ws.mergeCells(r.number, 2, r.number, 6);
    r.getCell(1).font = { bold: true, color: { argb: GRAY } };
    r.getCell(2).alignment = { horizontal: 'left', wrapText: true, vertical: 'top' };
    return r;
  };
  info('Fecha', fecha);
  ws.lastRow.getCell(2).numFmt = 'dd-mm-yyyy hh:mm';
  info('Estado', ESTADO[o.estado] || o.estado);
  info('Vendedor', (o.vendedor && o.vendedor.nombre) || '');
  ws.addRow([]);
  const h1 = ws.addRow(['Cliente']); h1.font = { bold: true, size: 12, color: { argb: TEAL } };
  info('Razón social', c.razon_social);
  info('RUT', c.rut);
  info('Giro', c.giro);
  info('Dirección', [c.direccion, c.comuna, c.ciudad, c.region].filter(Boolean).join(', '));
  info('Despacho', c.despacho_igual === false ? [c.despacho_direccion, c.despacho_comuna, c.despacho_ciudad].filter(Boolean).join(', ') : 'Misma dirección de facturación');
  info('Contacto', [c.contacto_nombre, c.whatsapp, c.telefono].filter(Boolean).join(' · '));
  info('Correo facturas', c.email_fact);
  if (o.notas) info('Observaciones', o.notas);
  ws.addRow([]);

  const head = ws.addRow(['SKU', 'Producto', 'Juegos', 'Unidades', 'Precio juego (IVA incl.)', 'Subtotal (IVA incl.)']);
  head.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TEAL } };
    cell.alignment = { vertical: 'middle', horizontal: cell.col >= 3 ? 'right' : 'left', wrapText: true };
  });
  head.height = 30;
  const first = head.number + 1;
  o.items.forEach((i) => {
    const r = ws.addRow([i.sku, i.name, i.qty, null, i.precio, null]);
    const n = r.number;
    r.getCell(4).value = { formula: `C${n}*${juego}`, result: i.qty * juego };
    r.getCell(6).value = { formula: `C${n}*E${n}`, result: i.subtotal };
    r.getCell(5).numFmt = CLP; r.getCell(6).numFmt = CLP;
    r.getCell(2).alignment = { wrapText: true, vertical: 'top' };
    r.eachCell((cell) => { cell.border = { bottom: { style: 'thin', color: { argb: 'FFD6E2E3' } } }; });
  });
  const last = first + o.items.length - 1;
  const tot = ws.addRow(['Total', '', null, null, '', null]);
  tot.getCell(3).value = { formula: `SUM(C${first}:C${last})`, result: o.juegos };
  tot.getCell(4).value = { formula: `SUM(D${first}:D${last})`, result: o.unidades };
  tot.getCell(6).value = { formula: `SUM(F${first}:F${last})`, result: o.total };
  tot.getCell(6).numFmt = CLP;
  tot.eachCell({ includeEmpty: true }, (cell) => {
    cell.font = { bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SOFT } };
  });
  ws.addRow([]);
  const nota = ws.addRow(['Pedido previo: precios con IVA incluido; la disponibilidad y el valor final los confirma su vendedor. Cada juego equivale a ' + juego + ' unidades.']);
  ws.mergeCells(nota.number, 1, nota.number, 6);
  nota.font = { italic: true, size: 9, color: { argb: GRAY } };
  nota.alignment = { wrapText: true, vertical: 'top' }; nota.height = 26;

  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { buildOrderXlsx };
