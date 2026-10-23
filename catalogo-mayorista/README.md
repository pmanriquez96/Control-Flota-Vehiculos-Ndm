# Catálogo mayorista de llantas (rines)

Proyecto independiente (vive en esta carpeta para poder moverlo a su propio repositorio sin cambios). Node + Express + Postgres, interfaz en un solo `public/index.html`.

## Qué hace

- **Bsale → catálogo automático.** Cada `SYNC_MINUTES` (15 por defecto) suma el stock de las sucursales **Talca** y **Bodega Adicional** y trae el precio de la lista **Mayorista**, más nombre y categoría. Solo se muestran productos con stock y precio.
- **Separado por aro.** «Llantas» = rines. El catálogo se agrupa por diámetro de aro (14", 15", 16"…) con fichas de aro arriba (con la cantidad de modelos) y filtros por tipo y por PCD (pernos). Cada ficha muestra ancho, PCD y ET. Esos datos se leen del **nombre del producto en Bsale** (`lib/bsale.js → parseRin`): conviene escribirlos como `16X7 5X114.3 ET40` (también entiende `7Jx16`, `5/112`, `6H139.7`, `4X100/108`). Lo que no se pueda leer queda en «Otras».
- **Stock por sucursal y traslados.** Vendedores y administradores ven, en cada producto del catálogo, el stock de **Talca** y de **Bodega Adicional** (el cliente nunca lo ve). En el detalle de un pedido nuevo o en revisión aparece el aviso de cuánto **trasladar desde Bodega Adicional a Talca**: lo que falta para el pedido **más 1 de reserva** para que Talca quede con al menos 1 de ese SKU (si Bodega no alcanza para el pedido o para la reserva, lo avisa por separado). La lista de pedidos marca los que necesitan traslado. El administrador tiene la sección **Traslados**: lista, por SKU, lo que hay que mover de Bodega Adicional a Talca para atender los pedidos pendientes **más** lo necesario para que Talca conserve siempre al menos 1 juego de cada SKU (`TALCA_MINIMO`, 1 por defecto), porque de Talca se despacha y se emiten los documentos. Primero van los pedidos y después la reserva mínima; si Bodega no alcanza, lo marca. Tiene botón para copiar la lista. La sucursal principal es la primera de `BSALE_OFFICES` (o `BSALE_MAIN_OFFICE`).
- **Fotos desde Google Drive** por SKU (hasta 3). El servidor las descarga con una cuenta de servicio y las guarda en `CACHE_DIR`; el navegador nunca ve Drive.
- **Stock oculto.** La API pública no entrega el stock: solo `max`, el tope que el cliente puede elegir (stock − lo ya reservado por pedidos nuevos o en revisión). El servidor vuelve a validar al enviar el pedido, uno a la vez.
- **Usuarios y roles.** El administrador crea usuarios y entrega una clave temporal.
  - *Mayorista*: en su primer ingreso cambia la clave y completa facturación, contacto y despacho (RUT validado). Queda guardado y lo puede corregir en «Mis datos». Está asociado a **un vendedor**.
  - *Vendedor*: ve y gestiona (en revisión / confirmar / rechazar, nota interna) **solo** los pedidos de sus clientes.
  - *Administrador*: ve todo, crea usuarios, reasigna vendedores, oculta productos, ve el stock real y fuerza la sincronización.
- **Pedido previo.** Carrito → «Enviar pedido» → resumen con SKU, nombre, cantidad y datos del cliente. Al terminar, el cliente decide si avisa a su vendedor por **WhatsApp** (botón que abre `wa.me` con el resumen ya escrito). El vendedor además ve el pedido (con contador de nuevos) en su panel.

## Variables de entorno

Ver `.env.example`. Obligatorias en producción: `DATABASE_URL`, `SESSION_SECRET`, `BSALE_TOKEN`. Para crear el primer administrador: `ADMIN_EMAIL` + `ADMIN_PASSWORD` (solo funciona si no hay usuarios).

### Bsale
- `BSALE_TOKEN`: access_token de la API.
- `BSALE_OFFICES=Talca,Bodega Adicional`: nombres de sucursal (sin importar tildes ni mayúsculas). Si no encuentra alguna, lo avisa en «Bsale y fotos».
- `BSALE_PRICE_LIST=Mayorista` (o `BSALE_PRICE_LIST_ID`). `PRICE_MODE=iva|neto`: por defecto toma el precio **con IVA incluido** de la lista.
- **Precio y cantidad por juego.** En Bsale cada variante ya es el **juego x4**: su precio (con IVA incluido) es el del juego y su stock está en juegos, así que **1 = 4 unidades**. El cliente pide en juegos y el tope es el stock de Bsale menos lo apartado. Los pedidos guardan juegos y el precio por juego del momento; `JUEGO_UNIDADES` (4) solo se usa para mostrar «N juegos (M unidades)».
- El SKU es el **código de la variante** en Bsale.

### Google Drive
Hay dos formas de conectar las fotos; si ambas están, **gana el enlace**.

**A. Pegar el enlace de la carpeta (la más simple).** En la pantalla de administrador «Bsale y fotos» se pega el enlace de la carpeta y se presiona «Guardar y buscar fotos». La carpeta debe estar compartida como **«Cualquier persona con el enlace» · Lector** (quien tenga el enlace podría ver las fotos). No requiere Google Cloud ni variables de entorno. Se lee la vista pública de la carpeta que usa Drive para incrustarla y las fotos se bajan por su enlace público; es una vía no oficial, así que si Google cambia esa vista habrá que ajustarla. Para algo más robusto y privado, usar la opción B.

**B. Cuenta de servicio (privada y oficial).**
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
