# Contexto del proyecto (para Claude Code)

App interna de **Neumáticos del Maule (NDM)** / Repuestos del Maule para controlar la flota de 9 vehículos. Se construyó primero como página de Claude (artifact) y esta carpeta es su versión para Railway (Node + Postgres). Responder y escribir textos de pantalla **siempre en español de Chile**, tono simple (los choferes la usan desde el celular).

## Cómo está armado

- `public/index.html`: toda la interfaz en un solo archivo (HTML + CSS + JS sin librerías). Guarda datos mediante `window.claude.use('db')`, que en esta versión provee `public/shim.js` hablando con `/api/...`. **No cambiar esa interfaz de datos** salvo que se reescriba también el shim: colecciones `vehicles`, `kmlog`, `checklists`, `fotos` y documentos `settings/alerts`, `settings/personal`, `settings/alertState`.
- `server.js` + `lib/`: Express, Postgres (tabla `docs(col,id,data jsonb)` y `users`), sesiones con cookie firmada, eventos en vivo por SSE (`/api/events`).
- Roles (`lib/auth.js → canWrite`): admin, editor, chofer. El chofer solo escribe kilometraje, checklists, fotos, lista de nombres y pendientes de un vehículo.
- Alertas (`lib/alerts.js`): replica las reglas de `mantSt`, `dueSt` y `buildAlerts` de `public/index.html`. **Si se cambia una regla, cambiarla en ambos lados.**

## Modelo de datos

- `vehicles/{id}`: nombre, patente, order, rt (AAAA-MM), rtDia, permiso (AAAA-MM), extintor, nextKm, muni, rut, pago, notas, `pending` [{id,text}], `history` [{id,month,km,text,usos,managed,desc}], `pauta` [{k,v}], `accesorios` {}, `stock` {aire,comb,faceite,polen,aceite}, `aceiteUnidad`, `aceiteUso`.
- `kmlog/{vehId}`: `{entries:[{id,d,km,nota}]}`.
- `checklists/{id}`: vid, fecha, km, chofer, peoneta, resp, items, notas, obs, fotos {clave:[idFoto]}.
- `fotos/{id}`: `{cid,vid,key,d}` con `d` = imagen JPEG en base64 reducida (~100 KB). Se carga solo al abrir el detalle de un checklist.
- Un documento no puede pasar de 256 KB. No hay arreglos dentro de arreglos.

## Reglas de negocio ya decididas

- Alerta de mantención: faltan 1.000 km o menos (configurable). Revisión técnica y permiso: desde los últimos 7 días del mes anterior al vencimiento.
- Registrar km (barra azul arriba o checklist) agrega una entrada a `kmlog`. Si el km es menor al último, pide confirmar.
- Historial de mantenciones descuenta stock solo de lo que el texto menciona (filtro de aire, combustible, aceite, polen, aceite de motor en **bidones**). Un cambio de aceite descuenta también un filtro de aceite.
- Checklist: Bueno / Regular / Malo; los "Malo" y los testigos encendidos del tablero pasan a pendientes del vehículo. Sección Documentación sin la palabra "vigente". No incluye frenos, aire acondicionado, caja de carga, puertas, balizas, faros auxiliares ni agua de limpiaparabrisas / AdBlue.
- Pantalla solo del checklist: `/#checklist`. El chofer entra directo ahí al iniciar sesión.
- Seguro (anterior / próximo) fue eliminado de Papeles (quedan campos viejos en los datos iniciales, sin uso).

## Pendientes / ideas

- Configurar el envío de correo (variables `SMTP_*`, ver README). Hoy sin SMTP solo se ven alertas en pantalla.
- Hacer más estricta la interfaz según rol (hoy el servidor bloquea lo no permitido, pero un chofer en la pestaña de vehículo ve botones de edición que le responderán "sin permiso").
- Probar el checklist con fotos en el celular real de un chofer (cámara trasera directa).
- Copias de seguridad de Postgres en Railway.

## Cómo probar

`npm test` con el servidor andando (ver README). Para revisar la pantalla se usó Playwright con Chromium.
