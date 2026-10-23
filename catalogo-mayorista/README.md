# Catálogo mayorista de llantas (rines)

Proyecto independiente (vive en esta carpeta para poder moverlo a su propio repositorio sin cambios). Node + Express + Postgres, interfaz en un solo `public/index.html`.

## Qué hace

- **Bsale → catálogo automático.** Cada `SYNC_MINUTES` (15 por defecto) suma el stock de las sucursales **Talca** y **Bodega Adicional** y trae el precio de la lista **Mayorista**, más nombre y categoría. Solo se muestran productos con stock y precio.
- **Separado por aro.** «Llantas» = rines. El catálogo se agrupa por diámetro de aro (14", 15", 16"…) con fichas de aro arriba (con la cantidad de modelos) y filtros por tipo y por PCD (pernos). Cada ficha muestra ancho, PCD y ET. Esos datos se leen del **nombre del producto en Bsale** (`lib/bsale.js → parseRin`): conviene escribirlos como `16X7 5X114.3 ET40` (también entiende `7Jx16`, `5/112`, `6H139.7`, `4X100/108`). Lo que no se pueda leer queda en «Otras».
- **Fotos desde Google Drive** por SKU (hasta 3). El servidor las descarga con una cuenta de servicio y las guarda en `CACHE_DIR`; el navegador nunca ve Drive.
- **Stock oculto.** La API pública no entrega el stock: solo `max`, el tope que el cliente puede elegir (stock − lo ya reservado por pedidos nuevos o en revisión). El servidor vuelve a validar al enviar el pedido, uno a la vez.
- **Usuarios y roles.** El administrador crea usuarios y entrega una clave temporal.
  - *Mayorista*: en su primer ingreso cambia la clave y completa facturación, contacto y despacho (RUT validado). Queda guardado y lo puede corregir en «Mis datos». Está asociado a **un vendedor**.
  - *Vendedor*: ve y gestiona (en revisión / confirmar / rechazar, nota interna) **solo** los pedidos de sus clientes.
  - *Administrador*: ve todo, crea usuarios, reasigna vendedores, oculta productos, ve el stock real y fuerza la sincronización.
- **Pedido previo.** Carrito → «Enviar pedido» → resumen con SKU, nombre, cantidad y datos del cliente. Al terminar, el cliente decide si avisa a su vendedor por **WhatsApp** (botón que abre `wa.me` con el resumen ya escrito). El vendedor además ve el pedido (con contador de nuevos) en su panel.

## Nota de venta en Bsale
Cuando el vendedor o vendedora **confirma** un pedido, la plataforma crea la **nota de venta** en Bsale (si `BSALE_NV=on`): busca al cliente por RUT (lo crea con sus datos de facturación si no existe), emite el documento en la sucursal `BSALE_NV_OFFICE` con cada SKU, cantidad (juegos) y **precio neto** de la lista Mayorista, y guarda el N° en el pedido. Reglas:
- Si Bsale rechaza el documento, el pedido **no queda confirmado**: se muestra el error y se puede reintentar sin duplicar (un pedido tiene como máximo una nota).
- Una vez creada la nota, el pedido no se puede rechazar ni volver atrás desde la plataforma: se anula en Bsale.
- Hasta que la sincronización refleje el descuento de stock de Bsale (se lanza sola unos segundos después), el pedido confirmado sigue apartado, para no vender dos veces.
- Con `BSALE_NV` vacío, confirmar solo cambia el estado (no se toca Bsale). Es el valor por defecto para no emitir documentos por accidente.
- El stock se descuenta de **una sola sucursal** (`BSALE_NV_OFFICE`), aunque el catálogo sume Talca + Bodega Adicional. Pendiente definir qué hacer si una sucursal no alcanza.
- No se probó contra el Bsale real: los campos del documento siguen su documentación pública y hay que revisarlos con una primera nota de prueba.

## Variables de entorno

Ver `.env.example`. Obligatorias en producción: `DATABASE_URL`, `SESSION_SECRET`, `BSALE_TOKEN`. Para crear el primer administrador: `ADMIN_EMAIL` + `ADMIN_PASSWORD` (solo funciona si no hay usuarios).

### Bsale
- `BSALE_TOKEN`: access_token de la API.
- `BSALE_OFFICES=Talca,Bodega Adicional`: nombres de sucursal (sin importar tildes ni mayúsculas). Si no encuentra alguna, lo avisa en «Bsale y fotos».
- `BSALE_PRICE_LIST=Mayorista` (o `BSALE_PRICE_LIST_ID`). `PRICE_MODE=iva|neto`: por defecto toma el precio **con IVA incluido** de la lista.
- **Precio y cantidad por juego.** En Bsale cada variante ya es el **juego x4**: su precio (con IVA incluido) es el del juego y su stock está en juegos, así que **1 = 4 unidades**. El cliente pide en juegos y el tope es el stock de Bsale menos lo apartado. Los pedidos guardan juegos y el precio por juego del momento; `JUEGO_UNIDADES` (4) solo se usa para mostrar «N juegos (M unidades)».
- El SKU es el **código de la variante** en Bsale.

### Google Drive
1. En Google Cloud crea una *cuenta de servicio*, habilita la API de Drive y descarga su clave JSON.
2. Comparte la carpeta de fotos con el correo de esa cuenta (lector).
3. `DRIVE_FOLDER_ID` = id de la carpeta (lo que va después de `/folders/` en la URL). `GOOGLE_SERVICE_ACCOUNT_JSON` = el JSON (o en base64).
4. Nombres de archivo: `SKU.jpg`, `SKU_1.jpg`, `SKU-2.png`, `SKU (3).jpg`, o una subcarpeta con el nombre del SKU. Conviene que pesen menos de ~500 KB.

## Despliegue en Railway
Crea un servicio nuevo con **Root Directory = `catalogo-mayorista`** (o muévelo a su propio repo), agrega Postgres y las variables. Las tablas se crean solas. El caché de fotos es de disco efímero: se vuelve a llenar solo.

## Probar
- `npm test`: prueba completa en memoria (Bsale y Drive simulados), sin Postgres ni internet.
- `node scripts/demo.js`: levanta una demostración en `localhost:3100` (`admin@demo.cl`, `vendedor@demo.cl`, `cliente@demo.cl`, clave `demo1234`).

## Límites conocidos / ideas
- Corre en **una sola instancia** (el bloqueo de pedidos y la tarea de sincronización viven en el proceso).
- El stock reservado deja de contar cuando el vendedor confirma o rechaza; mientras no se emita el documento en Bsale puede haber un desfase corto.
- Aviso automático (sin que el cliente toque nada): se puede agregar correo (Brevo) o WhatsApp Cloud API al crear el pedido; el punto de enganche es `POST /api/pedidos` en `server.js`.
- No se probó contra la API real de Bsale ni de Drive (no hay credenciales aquí): los formatos de respuesta se simularon según su documentación. La primera sincronización real conviene revisarla en «Bsale y fotos».
