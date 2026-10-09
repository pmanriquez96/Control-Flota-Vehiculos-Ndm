/* Service worker de Flota NDM: deja la página disponible aunque no haya señal.
   - Páginas y scripts (/, login, shim): primero la red; si falla, la última copia guardada.
   - Imágenes (logo, íconos): se guardan la primera vez.
   - Los datos (/api) no pasan por aquí: los maneja shim.js. */
const CACHE = 'ndm-v1';

self.addEventListener('install', (e) => {
  self.skipWaiting();
  // guarda la página de inmediato (el usuario ya inició sesión), para poder abrirla sin señal desde la primera vez
  e.waitUntil(caches.open(CACHE).then((c) => fetch('/', { credentials: 'same-origin' }).then((r) => { if (r.ok && !r.redirected) return c.put('/', r); }).catch(() => {})));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

/* La red va primero para lo que cambia con cada actualización (así nadie se queda con una versión vieja). */
const NET_FIRST = new Set(['/shim.js', '/login.html', '/manifest.webmanifest']);
const IMAGES = new Set(['/logo.png', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/apple-touch-icon.png']);

function networkFirst(req, key, fallback) {
  return fetch(req).then((res) => {
    if (res.ok && !res.redirected) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(key, copy)); }
    return res;
  }).catch(() => caches.match(key).then((r) => r || fallback || Response.error()));
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html')) {
    e.respondWith(networkFirst(req, '/', new Response('Sin conexión. Abre la página una vez con señal para poder usarla sin conexión.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } })));
  } else if (NET_FIRST.has(url.pathname)) {
    e.respondWith(networkFirst(req, req));
  } else if (IMAGES.has(url.pathname)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; })));
  }
});
