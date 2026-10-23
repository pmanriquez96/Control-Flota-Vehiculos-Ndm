# Catálogo mayorista (Claude Code)

Proyecto aparte del control de flota; textos de pantalla en español de Chile. Ver README.md.
- `lib/bsale.js` (sucursales Talca + Bodega Adicional, lista Mayorista), `lib/drive.js` (fotos por SKU), `lib/sync.js` (upsert y fotos), `lib/profile.js` (datos del cliente), `server.js` (API y permisos), `public/index.html` (toda la interfaz).
- Regla clave: el stock real nunca sale en `/api/productos`, solo `max`. Los pedidos se limitan por rol en `scope()`.
- `npm test` corre todo en memoria con pg-mem.
