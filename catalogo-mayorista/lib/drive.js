'use strict';
/* Fotos desde Google Drive con una cuenta de servicio (solo lectura).
   La carpeta de Drive debe estar compartida con el correo de la cuenta de servicio.
   Formatos aceptados: archivos sueltos  SKU.jpg, SKU_1.jpg, SKU-2.jpg, SKU (3).jpg
                    o una subcarpeta por SKU con sus fotos dentro. Se usan las primeras 3. */
const crypto = require('crypto');

const API = 'https://www.googleapis.com/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';

function loadCredentials(raw) {
  if (!raw) return null;
  let s = raw.trim();
  if (!s.startsWith('{')) s = Buffer.from(s, 'base64').toString();
  const j = JSON.parse(s);
  if (!j.client_email || !j.private_key) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON sin client_email o private_key');
  return j;
}

function makeDrive({ credentials, folderId, fetchImpl }) {
  const f = fetchImpl || fetch;
  let tok = null, tokExp = 0;

  async function token() {
    if (tok && Date.now() < tokExp - 60000) return tok;
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const head = b64({ alg: 'RS256', typ: 'JWT' });
    const claim = b64({ iss: credentials.client_email, scope: 'https://www.googleapis.com/auth/drive.readonly', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
    const sig = crypto.createSign('RSA-SHA256').update(head + '.' + claim).sign(credentials.private_key).toString('base64url');
    const r = await f('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + head + '.' + claim + '.' + sig,
    });
    if (!r.ok) throw new Error('Google OAuth ' + r.status);
    const j = await r.json();
    tok = j.access_token; tokExp = Date.now() + (j.expires_in || 3600) * 1000;
    return tok;
  }
  async function authed(url) {
    const r = await f(url, { headers: { Authorization: 'Bearer ' + await token() } });
    if (!r.ok) throw new Error('Drive ' + r.status);
    return r;
  }
  async function listChildren(parent) {
    const out = [];
    let pageToken = '';
    do {
      const q = encodeURIComponent(`'${parent}' in parents and trashed=false`);
      const url = `${API}/files?q=${q}&pageSize=1000&fields=${encodeURIComponent('nextPageToken,files(id,name,mimeType)')}&supportsAllDrives=true&includeItemsFromAllDrives=true` + (pageToken ? '&pageToken=' + pageToken : '');
      const j = await (await authed(url)).json();
      out.push(...(j.files || []));
      pageToken = j.nextPageToken || '';
    } while (pageToken);
    return out;
  }

  const isImg = (x) => /^image\//.test(x.mimeType || '') || /\.(jpe?g|png|webp)$/i.test(x.name || '');
  const stripExt = (n) => n.replace(/\.[A-Za-z0-9]{2,5}$/, '');
  const keyOf = (n) => stripExt(n).trim().toUpperCase();

  // Devuelve Map<SKU, [{id,name}]> con hasta 3 fotos por SKU
  async function buildIndex() {
    const root = await listChildren(folderId);
    const index = new Map();
    const add = (key, file) => {
      if (!key) return;
      const arr = index.get(key) || [];
      if (!arr.some((x) => x.id === file.id)) arr.push({ id: file.id, name: file.name });
      index.set(key, arr);
    };
    for (const x of root.filter((r) => r.mimeType !== FOLDER && isImg(r))) {
      const k = keyOf(x.name);
      add(k, x);
      // SKU_1, SKU-2, SKU 3, SKU (1)
      const base = k.replace(/\s*\(\s*[1-3]\s*\)$/, '').replace(/[\s_-]+[1-3]$/, '');
      if (base !== k) add(base, x);
    }
    const folders = root.filter((r) => r.mimeType === FOLDER);
    for (let i = 0; i < folders.length; i += 5) {
      await Promise.all(folders.slice(i, i + 5).map(async (fo) => {
        const kids = (await listChildren(fo.id)).filter((r) => r.mimeType !== FOLDER && isImg(r));
        kids.forEach((x) => add(fo.name.trim().toUpperCase(), x));
      }));
    }
    for (const [k, arr] of index) index.set(k, arr.sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true })).slice(0, 3));
    return index;
  }

  async function download(fileId) {
    const r = await authed(`${API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`);
    return { buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') || 'image/jpeg' };
  }

  return { buildIndex, download };
}

module.exports = { makeDrive, loadCredentials };
