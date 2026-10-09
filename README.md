# Registro de vehículos NDM

Página para controlar la flota de Neumáticos del Maule: kilometraje, mantenciones (pendientes e historial), papeles (revisión técnica, permiso, extintor), checklist de inspección con fotos, stock de filtros y aceite, y alertas por correo.

Funciona con **Node + Postgres** y está preparada para **Railway**.

## Qué trae

- Login con tres roles: **Administrador** (todo y usuarios), **Editor** (edita todos los datos) y **Chofer** (solo ve y llena el checklist con fotos: no ve vehículos, papeles, alertas ni checklists anteriores, y no puede editar nada más; entra directo a la pantalla del checklist).
- Los 9 vehículos del Excel se cargan solos la primera vez que arranca (carpeta `seed/`).
- Alertas por correo automáticas: el servidor revisa cada hora y envía solo cuando aparece una alerta nueva (mantención a 1.000 km o menos, revisión técnica y permiso en la última semana del mes anterior). También revisa poco después de registrar un kilometraje.
- Página de usuarios en `/admin.html`.

## Publicar en Railway (paso a paso)

1. **GitHub:** crea un repositorio privado y sube esta carpeta (sin `node_modules` ni `.env`, ya están en `.gitignore`).
2. **Railway:** en railway.com crea un proyecto con **Deploy from GitHub repo** y elige el repositorio.
3. **Base de datos:** en el mismo proyecto, **New → Database → Add PostgreSQL**.
4. **Variables:** en el servicio de la app, pestaña **Variables**, agrega:

   | Variable | Valor |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (referencia al Postgres del proyecto) |
   | `SESSION_SECRET` | un texto largo y aleatorio (≥ 32 caracteres) |
   | `ADMIN_USER` | por ejemplo `ernesto` |
   | `ADMIN_NAME` | tu nombre |
   | `ADMIN_PASSWORD` | una clave segura (solo se usa para crear el primer administrador) |
   | `NODE_ENV` | `production` |
   | `TZ` | `America/Santiago` |

5. **Dominio:** en **Settings → Networking → Generate Domain** (o conecta uno propio, por ejemplo `flota.repuestosdelmaule.cl`).
6. Entra a la dirección, ingresa con el administrador y crea los usuarios de los choferes en `/admin.html`.
7. Abre la página desde un celular de chofer y haz un checklist de prueba con foto.

Railway hace el despliegue solo cada vez que subes cambios a GitHub. La app crea las tablas y carga los datos iniciales al arrancar.

## Correo de alertas (cuando tengas los datos)

Sin estas variables todo funciona, pero las alertas solo se ven en pantalla. Agrega en Railway:

| Variable | Gmail / Google Workspace | Correo corporativo |
|---|---|---|
| `SMTP_HOST` | `smtp.gmail.com` | el que te indique tu proveedor |
| `SMTP_PORT` | `465` | `465` o `587` |
| `SMTP_SECURE` | `true` | `true` si el puerto es 465, `false` si es 587 |
| `SMTP_USER` | tu correo completo | usuario SMTP |
| `SMTP_PASS` | **contraseña de aplicación** (no la clave normal) | clave SMTP |
| `MAIL_FROM` | `"Flota NDM <tucorreo@dominio.cl>"` | igual |

Contraseña de aplicación de Google: cuenta de Google → Seguridad → verificación en dos pasos activada → **Contraseñas de aplicaciones**. (En Google Workspace el administrador debe permitirlo.)

Luego, en la página, pestaña **Alertas y correo**, agrega los correos que reciben las alertas (puedes poner varios) y usa **Enviar las alertas ahora** para probar.

## Trabajar en tu computador

```bash
npm install
cp .env.example .env      # completa DATABASE_URL y el resto
# necesitas un Postgres local (por ejemplo con Docker: docker run -e POSTGRES_PASSWORD=ndm -p 5432:5432 postgres:16)
export $(grep -v '^#' .env | xargs)   # o usa tu forma habitual de cargar variables
npm run dev
```

Prueba rápida de permisos y datos (con el servidor andando): `BASE=http://localhost:3000 ADMIN_PASSWORD=... npm test`

## Copias de seguridad

Los datos viven en el Postgres de Railway. Activa las copias de seguridad del servicio de Postgres y, de vez en cuando, exporta con `pg_dump` usando la URL pública de la base.

## Estructura

```
server.js            servidor Express (login, datos, alertas, usuarios)
lib/store.js         acceso a Postgres
lib/auth.js          claves, sesiones y permisos por rol
lib/alerts.js        reglas de alertas y envío de correo (a varios destinatarios)
lib/checklist.js     guarda un checklist completo (único modo en que escribe un chofer)
lib/seed.js          carga inicial desde seed/
public/index.html    la página (todo el código de pantalla)
public/shim.js       conecta la página con el servidor
public/login.html    ingreso
public/admin.html    usuarios
seed/                datos iniciales de los 9 vehículos
```
