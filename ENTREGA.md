# Entrega: Control de Flota de Vehículos NDM

Documento para quien integre esta app a **NDM Gestión** (Next.js + PostgreSQL).

## 1. Qué hace y quién la usa

App interna de **Neumáticos del Maule / Repuestos del Maule** para controlar una flota de **9 vehículos**. Se usa principalmente desde el celular.

Funciones:
- **Vehículo:** ficha con kilometraje, mantenciones (pendientes e historial), papeles (revisión técnica, permiso de circulación, extintor), pauta de mantención y accesorios.
- **Checklist de inspección** (25 puntos en 6 secciones: Bueno / Regular / Malo, con notas y hasta 3 fotos por punto, ruta realizada, chofer y peoneta). Los puntos «Malo» y los testigos encendidos del tablero pasan a pendientes del vehículo.
- **Stock de filtros y aceite** por vehículo y lista manual de «Otros repuestos». El stock baja al anotar trabajos en el historial y sube al ingresar compras.
- **Toda la flota:** resumen de todos los vehículos.
- **Alertas por correo:** mantención (faltan 1.000 km o menos), revisión técnica (aviso, urgente y correo diario a las 8:00 hora de Chile) y permiso de circulación. Además llega un correo inmediato cuando un checklist trae puntos en mal estado, con detalles o testigos encendidos.
- **Instalable como app y con checklist sin señal:** el checklist se guarda en el celular y se envía solo al volver la conexión.
- **Manual de uso del checklist** en PDF (`manual/manual-checklist.pdf`), accesible desde un botón en la pantalla del checklist.

Quién la usa:
- **Choferes:** solo llenan el checklist.
- **Editor y administrador (oficina):** ven y editan todo.
- **Administrador:** además gestiona usuarios.

## 2. Tecnología

- **Node.js 20 o superior** (se desarrolló y probó con Node 22).
- **Express 4** (servidor y API), **pg** (Postgres) y **nodemailer** (correo por SMTP). Son las únicas 3 dependencias (`package.json`).
- **Interfaz sin framework ni build:** HTML + CSS + JavaScript puro en un solo archivo (`public/index.html`). No usa React ni Next.js, y no se compila.
- Eventos en vivo por SSE (`/api/events`), service worker (`public/sw.js`) y manifiesto PWA.
- Despliegue original: **Railway** (`railway.json`, builder Nixpacks, health check en `/health`).

## 3. Instalar y ejecutar

Requisitos: Node 20+ y un Postgres accesible.

```bash
npm install
cp .env.example .env     # completa DATABASE_URL, SESSION_SECRET, ADMIN_*
# cargar las variables del .env en el entorno (la app NO lee .env sola) y luego:
npm start                # producción: node server.js
npm run dev              # desarrollo, con recarga automática
```

- **Puerto:** el de la variable `PORT`; si no está definida, **3000**.
- La app **crea sola las tablas** y carga los datos iniciales de los 9 vehículos (carpeta `seed/`) la primera vez que arranca. También crea el primer administrador con `ADMIN_USER` / `ADMIN_PASSWORD` si no hay ningún usuario.
- **Pruebas:** con el servidor andando, `BASE=http://localhost:3000 ADMIN_USER=... ADMIN_PASSWORD=... npm test` (`scripts/smoke-test.js`). Crea y borra un chofer de prueba.
- **Ojo:** la app no usa `dotenv`; las variables deben estar en el entorno del proceso (por ejemplo `export $(grep -v '^#' .env | xargs)` o las variables del hosting).

## 4. Base de datos

**PostgreSQL** (variable `DATABASE_URL`). No usa SQLite, Excel ni Google Sheets. Todos los datos viven ahí. Solo hay dos tablas (`lib/store.js`):

| Tabla | Para qué |
|---|---|
| `docs(col text, id text, data jsonb, updated_at)` con clave primaria `(col, id)` | Todos los datos de negocio, como documentos JSON |
| `users(username, name, role, pass, created_at)` | Usuarios y sus claves (hash scrypt) |

Colecciones dentro de `docs` (columna `col`):
- `vehicles`: un documento por vehículo (nombre, patente, papeles, `pending`, `history`, `stock`, etc.).
- `kmlog`: `{entries:[{id,d,km,nota}]}` por vehículo.
- `checklists`: vid, fecha, km, chofer, peoneta, ruta, items, notas, obs y fotos.
- `fotos`: imágenes JPEG en base64 (~100 KB cada una), ligadas a un checklist.
- `settings`: documentos `alerts` (correos y reglas), `personal` (nombres de chofer/peoneta), `rutas` (lista de rutas), `repuestos` (otros repuestos) y `alertState` (estado interno de alertas enviadas).

El modelo completo está en `CLAUDE.md`, sección «Modelo de datos». **Datos iniciales:** `seed/` (JSON de los 9 vehículos y su kilometraje).

Para integrarla con NDM Gestión se puede usar la misma base (otro esquema o las mismas dos tablas) o migrar los documentos a tablas propias. **Importante:** el límite de un documento es 256 KB y los datos no tienen esquema relacional.

## 5. APIs externas y variables de entorno

**APIs externas:** ninguna de negocio. **No usa BSALE** ni otro sistema. Lo único externo es el envío de correo de alertas, por **Brevo** (API HTTPS) o por **SMTP**.

**Variables de entorno** (solo nombres; ver `.env.example`):

| Variable | Obligatoria | Para qué |
|---|---|---|
| `DATABASE_URL` | Sí | Conexión a Postgres |
| `SESSION_SECRET` | Sí en producción | Firma de las sesiones |
| `ADMIN_USER`, `ADMIN_NAME`, `ADMIN_PASSWORD` | Para el primer arranque | Crean el primer administrador |
| `PORT` | No | Puerto (por defecto 3000) |
| `NODE_ENV` | No | `production` exige `SESSION_SECRET` |
| `TZ` | No | Zona horaria (se usó `America/Santiago`) |
| `PGSSL` | No | `require` si la base exige SSL |
| `BREVO_API_KEY` | No | Envío de correo por Brevo (si existe, se usa en vez de SMTP) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` | No | Envío por SMTP |
| `MAIL_FROM` | Con correo | Remitente (también acepta `BREVO_SENDER`) |
| `ALERT_EMAIL` | No | Destinatarios por defecto, separados por coma |
| `ALERT_CHECK_MINUTES` | No | Cada cuánto revisa alertas (por defecto 60) |
| `BASE`, `BREVO_API_URL` | Solo pruebas | URL del servidor de prueba y de un Brevo falso |

Sin variables de correo todo funciona, pero las alertas solo se ven en pantalla.

## 6. Login, usuarios y roles

- Ingreso en `/login.html` con **usuario y clave**. Claves guardadas con hash **scrypt** con sal.
- **Sesión:** cookie firmada `ndm_s` (HttpOnly, SameSite=Lax, 30 días; `Secure` si va por HTTPS). Hay límite de 10 intentos fallidos por IP cada 15 minutos.
- **Roles** (`lib/auth.js`):

| Rol | Qué puede |
|---|---|
| `admin` | Todo, y gestiona usuarios en `/admin.html` (crear, cambiar clave o rol, borrar) |
| `editor` | Lee y edita todos los datos y envía alertas; no gestiona usuarios |
| `chofer` | No escribe directo en ninguna colección. Solo guarda checklist con `POST /api/checklist`. Lee lo mínimo: nombre y patente de los vehículos, su último km, nombres, rutas y avisos breves de mantención/documentos. No ve papeles, fechas ni historial. Entra directo a `/#checklist` |

- Los permisos se aplican **en el servidor**, no solo en la pantalla.
- **Para integrarla en NDM Gestión:** este login es propio y no se comparte con otro sistema. Habría que reemplazar `loadUser` y `needUser` en `server.js` por la sesión de NDM Gestión, o dejar la app como servicio aparte detrás del mismo dominio. Los tres roles se deben mapear a los de NDM Gestión.

## 7. Estructura de carpetas

```
server.js              Servidor Express: login, API, SSE, usuarios, páginas, arranque
lib/
  store.js             Acceso a Postgres y creación de tablas
  auth.js              Claves, sesiones y permisos por rol (canWrite)
  checklist.js         Guarda un checklist completo (fotos, km, pendientes, nombres, ruta)
  alerts.js            Reglas de alertas, correos (Brevo/SMTP) y aviso por checklist
  seed.js              Carga inicial desde seed/
public/
  index.html           Toda la interfaz (pantallas, CSS y lógica del navegador)
  login.html           Ingreso
  admin.html           Gestión de usuarios (solo admin)
  shim.js              Capa de datos del navegador (habla con /api; copia local para uso sin señal)
  sw.js                Service worker (abrir la app sin señal)
  manifest.webmanifest, icon-*.png, apple-touch-icon.png, logo.png   App instalable
manual/manual-checklist.pdf   Manual de uso del checklist
seed/                  Datos iniciales (9 vehículos, kilometraje, nombres)
scripts/smoke-test.js  Prueba automática de permisos y datos
README.md              Guía de despliegue en Railway y de correo
CLAUDE.md              Contexto técnico detallado y reglas de negocio
railway.json           Configuración de Railway
```

**Pantallas:** todas en `public/index.html` (pestañas Vehículo, Checklist, Stock Filtros y Repuestos, Toda la flota, Alertas y correo), más `login.html` y `admin.html`.

**Rutas de API** (`server.js`):

| Ruta | Quién | Qué hace |
|---|---|---|
| `POST /api/login`, `POST /api/logout`, `GET /api/me` | Todos | Sesión |
| `GET /api/col/:col`, `GET/PUT/PATCH/DELETE /api/doc/:col/:id` | Con sesión; el chofer solo lee lo permitido | Leer y escribir documentos |
| `POST /api/checklist` | Todos los roles | Guardar un checklist (idempotente con `clientId`) |
| `GET /api/events` | Con sesión | Cambios en vivo (SSE) |
| `GET /api/alerts/status`, `POST /api/alerts/send` | admin, editor | Estado y envío manual de alertas |
| `GET/POST /api/users`, `PATCH/DELETE /api/users/:u` | admin | Usuarios |
| `GET /health` | Público | Revisa la conexión a la base |
| `GET /manual-checklist.pdf` | Con sesión | Manual de uso |

## 8. Reglas de negocio importantes

Las alertas están escritas **dos veces**: en `lib/alerts.js` (servidor) y en `public/index.html` (pantalla). Si se cambia una regla hay que cambiarla en ambos lados. Lo mismo vale para los nombres de los puntos del checklist (`CHK_NOMBRES` en `lib/alerts.js`). El detalle de todas las reglas está en `CLAUDE.md`.

## 9. Notas para la integración

- Los textos de pantalla están en **español de Chile**.
- El proceso del servidor también hace trabajo en segundo plano: revisa alertas cada hora (`schedule()` en `lib/alerts.js`) y manda el correo diario de revisión técnica a las 8:00. Debe quedar **siempre encendido**; no sirve en un entorno serverless.
- Las fotos van en base64 dentro de Postgres. Si NDM Gestión tiene un almacén de archivos, conviene migrarlas.
- Los datos reales están en la base de producción (Railway); este zip no los incluye, solo los datos iniciales de `seed/`.
