/* Hace que la página funcione igual que dentro de Claude: ofrece window.claude.use('db')
   (colecciones y documentos con onSnapshot) hablando con el servidor (/api/...). */
(function () {
  'use strict';
  window.NDM_SERVER = true;

  /* Copia local de lo mínimo para abrir la página sin señal (vehículos, último km, nombres y usuario). */
  var CACHEABLE = /^\/api\/(me|col\/(vehicles|kmlog)|doc\/settings\/personal)$/;
  function cget(u) { try { var s = localStorage.getItem('ndm_c:' + u); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
  function cput(u, j) { try { var s = JSON.stringify(j); if (s.length < 1500000) localStorage.setItem('ndm_c:' + u, s); } catch (e) {} }
  function cclear() { try { Object.keys(localStorage).filter(function (k) { return k.indexOf('ndm_c:') === 0; }).forEach(function (k) { localStorage.removeItem(k); }); } catch (e) {} }

  function api(method, url, body) {
    return fetch(url, {
      method: method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    }).catch(function () { return null; }).then(function (r) {
      if (!r) { // sin conexión: si hay copia local, se usa
        var c = method === 'GET' && CACHEABLE.test(url) ? cget(url) : null;
        if (c !== null) return c;
        throw { code: 'unavailable', message: 'Sin conexión' };
      }
      if (r.status === 401) { location.href = '/login.html'; return new Promise(function () {}); }
      if (r.ok) return r.json().then(function (j) { if (method === 'GET' && CACHEABLE.test(url)) cput(url, j); return j; });
      return r.json().catch(function () { return {}; }).then(function (j) {
        var code = r.status === 403 ? 'permission_denied' : r.status === 404 ? 'invalid_argument' : r.status === 413 ? 'quota_exceeded' : 'unavailable';
        throw { code: code, message: j.error || '' };
      });
    });
  }

  var colL = {}, docL = {}, timers = {};
  function snapOfRows(rows) {
    return { docs: rows.map(function (r) { return { id: r.id, exists: true, data: function () { return r.data; } }; }) };
  }
  function refreshCol(c) {
    var L = colL[c]; if (!L || !L.length) return;
    api('GET', '/api/col/' + c).then(function (rows) {
      var s = snapOfRows(rows); L.slice().forEach(function (h) { h.cb(s); });
    }, function (e) { L.slice().forEach(function (h) { if (h.eb) h.eb(e); }); });
  }
  function refreshDoc(p) {
    var L = docL[p]; if (!L || !L.length) return;
    api('GET', '/api/doc/' + p).then(function (j) { return { exists: true, data: function () { return j.data; } }; },
      function (e) { if (e && e.code === 'invalid_argument') return { exists: false, data: function () { return undefined; } }; throw e; })
      .then(function (s) { L.slice().forEach(function (h) { h.cb(s); }); },
        function (e) { L.slice().forEach(function (h) { if (h.eb) h.eb(e); }); });
  }
  function later(key, fn) { clearTimeout(timers[key]); timers[key] = setTimeout(fn, 120); }

  function collection(c) {
    return {
      onSnapshot: function (cb, eb) {
        var h = { cb: cb, eb: eb }; (colL[c] = colL[c] || []).push(h);
        api('GET', '/api/col/' + c).then(function (rows) { cb(snapOfRows(rows)); }, function (e) { if (eb) eb(e); });
        return function () { var i = colL[c].indexOf(h); if (i >= 0) colL[c].splice(i, 1); };
      }
    };
  }
  function doc(p) {
    var parts = p.split('/'), col = parts[0], id = parts[1];
    return {
      onSnapshot: function (cb, eb) {
        var h = { cb: cb, eb: eb }; (docL[p] = docL[p] || []).push(h);
        refreshDoc.call(null, p);
        return function () { var i = docL[p].indexOf(h); if (i >= 0) docL[p].splice(i, 1); };
      },
      get: function () {
        return api('GET', '/api/doc/' + p).then(function (j) { return { exists: true, data: function () { return j.data; } }; },
          function (e) { if (e && e.code === 'invalid_argument') return { exists: false, data: function () { return undefined; } }; throw e; });
      },
      set: function (d) { return api('PUT', '/api/doc/' + p, { data: d }); },
      update: function (d) { return api('PATCH', '/api/doc/' + p, { data: d }); },
      delete: function () { return api('DELETE', '/api/doc/' + p); }
    };
  }
  var DB = { collection: collection, doc: doc };
  window.claude = { use: function (n) { return Promise.resolve(n === 'db' ? DB : null); } };

  /* cambios en vivo desde el servidor */
  function connect() {
    if (!window.EventSource) return;
    var es = new EventSource('/api/events');
    es.onmessage = function (ev) {
      try {
        var m = JSON.parse(ev.data);
        if (colL[m.col] && colL[m.col].length) later('c:' + m.col, function () { refreshCol(m.col); });
        var p = m.col + '/' + m.id;
        if (docL[p] && docL[p].length) later('d:' + p, function () { refreshDoc(p); });
      } catch (e) {}
    };
    es.onopen = function () { Object.keys(colL).forEach(refreshCol); Object.keys(docL).forEach(refreshDoc); };
  }
  connect();
  setInterval(function () { if (document.visibilityState === 'visible') { Object.keys(colL).forEach(refreshCol); Object.keys(docL).forEach(refreshDoc); } }, 60000);

  /* quién es el usuario (la página lo usa para mostrar solo lo que le corresponde) */
  var meP = api('GET', '/api/me');
  window.NDM_ME_P = meP.then(function (me) { window.NDM_ME = me; return me; }, function () { return null; });

  /* barra con el usuario y salir */
  document.addEventListener('DOMContentLoaded', function () {
    meP.then(function (me) {
      var bar = document.createElement('div');
      bar.style.cssText = 'max-width:1200px;margin:8px auto 24px;padding:0 16px;text-align:right;font:14px/1.4 system-ui,sans-serif;color:#667';
      var span = document.createElement('span'); span.textContent = me.name + ' · ' + ({ admin: 'Administrador', editor: 'Editor', chofer: 'Chofer' }[me.role] || me.role) + ' · ';
      bar.appendChild(span);
      if (me.role === 'admin') { var a = document.createElement('a'); a.href = '/admin.html'; a.textContent = 'Usuarios'; a.style.marginRight = '10px'; bar.appendChild(a); }
      var out = document.createElement('a'); out.href = '#'; out.textContent = 'Salir';
      out.onclick = function (e) { e.preventDefault(); cclear(); api('POST', '/api/logout').then(function () { location.href = '/login.html'; }, function () { location.href = '/login.html'; }); };
      bar.appendChild(out);
      document.body.appendChild(bar);
    }, function () {});
  });
})();
