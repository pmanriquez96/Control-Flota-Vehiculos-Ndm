# Contexto del proyecto (para Claude Code)

App interna de **Neumáticos del Maule (NDM)** / Repuestos del Maule para controlar la flota de 9 vehículos. Se construyó primero como página de Claude (artifact) y esta carpeta es su versión para Railway (Node + Postgres). Responder y escribir textos de pantalla **siempre en español de Chile**, tono simple (los choferes la usan desde el celular).

## Cómo está armado

- `public/index.html`: toda la interfaz en un solo archivo (HTML + CSS + JS sin librerías). Guarda datos mediante `window.claude.use('db')`, que en esta versión provee `public/shim.js` hablando con `/api/...`. **No cambiar esa interfaz de datos** salvo que se reescriba también el shim: colecciones `vehicles`, `kmlog`, `checklists`, `fotos` y documentos `settings/alerts`, `settings/personal`, `settings/alertState`.
- `server.js` + `lib/`: Express, Postgres (tabla `docs(col,id,data jsonb)` y `users`), sesiones con cookie firmada, eventos en vivo por SSE (`/api/events`).
- Roles (`lib/auth.js → canWrite`): admin, editor, chofer. El chofer **no escribe directo** en ninguna colección: guarda todo con `POST /api/checklist` (`lib/checklist.js`: checklist, fotos, kilometraje, pendientes y nombres) y solo *lee* lo mínimo (`forChofer` en `server.js`: nombre y patente de los vehículos, su último km y la lista de nombres). En la pantalla el chofer ve solo el formulario del checklist.
- Pestañas: Vehículo, Checklist, **Stock Filtros y Repuestos** (arriba el stock de filtros y aceite por vehículo; abajo «Otros repuestos», lista manual en el documento `settings/repuestos` = `{items:[{id,nombre,cant,unid,nota}]}`), Toda la flota, Alertas y correo. Arriba del inicio van lado a lado (mitad y mitad, cuadros separados) «Registrar kilometraje» —con el último km y la próxima mantención al fondo del cuadro, uno sobre el otro— y «Últimos checklists» (5 de toda la flota, con «Ver más»). El botón «Ir al checklist» despliega la lista de vehículos.
- Correos de alertas: `settings/alerts.emails` (arreglo; `email` es el campo antiguo y se migra solo). `recipients()` en `lib/alerts.js` también acepta `ALERT_EMAIL` con varios separados por coma.
- Alertas (`lib/alerts.js`): replica las reglas de `mantSt`, `dueSt` y `buildAlerts` de `public/index.html`. **Si se cambia una regla, cambiarla en ambos lados.**

## Modelo de datos

- `vehicles/{id}`: nombre, patente, order, rt (AAAA-MM), rtDia, permiso (AAAA-MM), extintor, nextKm, muni, rut, pago, notas, `pending` [{id,text}], `history` [{id,month,km,text,usos,managed,desc}], `pauta` [{k,v}], `accesorios` {}, `stock` {aire,comb,faceite,polen,aceite}, `aceiteUnidad`, `aceiteUso`.
- `kmlog/{vehId}`: `{entries:[{id,d,km,nota}]}`.
- `checklists/{id}`: vid, fecha, km, chofer, peoneta, items, notas, obs, fotos {clave:[idFoto]}. (`resp`, el responsable de la inspección, se eliminó; los checklists antiguos pueden traerlo y no se muestra.)
- `fotos/{id}`: `{cid,vid,key,d}` con `d` = imagen JPEG en base64 reducida (~100 KB). Se carga solo al abrir el detalle de un checklist. El detalle muestra una galería con **todas** las fotos del checklist, cada una con el nombre del punto (`fotosGaleria`), sin importar la sección.
- Un documento no puede pasar de 256 KB. No hay arreglos dentro de arreglos.

## Reglas de negocio ya decididas

- Alerta de mantención: faltan 1.000 km o menos (configurable). Revisión técnica y permiso: desde los últimos 7 días del mes anterior al vencimiento.
- Registrar km (barra azul arriba o checklist) agrega una entrada a `kmlog`. Si el km es menor al último, pide confirmar.
- Historial de mantenciones descuenta stock solo de lo que el texto menciona (filtro de aire, combustible, aceite, polen, aceite de motor en **bidones**). Un cambio de aceite descuenta también un filtro de aceite.
- Checklist: Bueno / Regular / Malo; los "Malo" y los testigos encendidos del tablero pasan a pendientes del vehículo. Sección Documentación sin la palabra "vigente". No incluye frenos, aire acondicionado, caja de carga, puertas, balizas, faros auxiliares, agua de limpiaparabrisas / AdBlue, batería y bornes, correas y mangueras ni cinturones de seguridad. «Limpiaparabrisas» se llama **Plumillas**.
- Pantalla solo del checklist: `/#checklist`. El chofer entra directo ahí al iniciar sesión.
- Seguro (anterior / próximo) fue eliminado de Papeles (quedan campos viejos en los datos iniciales, sin uso).

## Pendientes / ideas

- Configurar el envío de correo (ver README). Railway bloquea SMTP en algunos planes («Connection timeout»): se agregó Brevo por HTTPS (`BREVO_API_KEY` + `MAIL_FROM`, `sendBrevo` en `lib/alerts.js`); si existe, se usa en vez de SMTP. Sin ninguno de los dos solo se ven alertas en pantalla.
- La interfaz del editor aún muestra todo lo que ve el admin (solo `/admin.html` es exclusivo del admin).
- Probar el checklist con fotos en el celular real de un chofer (cámara trasera directa).
- Copias de seguridad de Postgres en Railway.

## Cómo probar

`npm test` con el servidor andando (ver README). Para revisar la pantalla se usó Playwright con Chromium.
