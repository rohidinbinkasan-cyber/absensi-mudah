// api/gallery/list.js
// Galeri bersama berbasis Vercel Blob (store: absensi-mudah-blob).
//  - GET /api/gallery/list?type=poto|video  (publik) -> daftar media, terbaru di atas
// Hanya fungsi list — tanpa auth, tanpa env var khusus. Auth & upload/hapus diurus
// backend PC (yang punya JWT_SECRET + BLOB_READ_WRITE_TOKEN di .env masing-masing).
import { list, issueSignedToken, presignUrl } from '@vercel/blob';

const IMG_EXT = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'avif', 'bmp'];
const VID_EXT = ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v', '3gp'];
const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  gif: 'image/gif', heic: 'image/heic', avif: 'image/avif', bmp: 'image/bmp',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  avi: 'video/x-msvideo', m4v: 'video/mp4', '3gp': 'video/3gpp',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const unb64 = (s) => { try { return Buffer.from(s, 'base64url').toString('utf8'); } catch (e) { return ''; } };

// pathname: galeri/<ts>_<rand>~<meta-b64url><.ext> — metadata disisipkan di nama file
function parsePathname(p) {
  const m = String(p || '').match(/^galeri\/(\d+)_([a-z0-9]+)~([A-Za-z0-9_-]+)(\.[a-zA-Z0-9]+)?$/);
  if (!m) return { filename: '', judul: '', kelas: '', tanggal: '' };
  let meta = {};
  try { meta = JSON.parse(unb64(m[3]) || '{}'); } catch (e) { meta = {}; }
  return { filename: meta.f || '', judul: meta.j || '', kelas: meta.k || '', tanggal: meta.t || '' };
}

const extOf = (p) => String(p || '').split('.').pop().toLowerCase();

export function OPTIONS() {
  return new Response('ok', { status: 204, headers: CORS });
}

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const isVid = url.searchParams.get('type') === 'video';
    const { blobs } = await list({ prefix: 'galeri/', limit: 1000 });

    // Satu delegation token untuk seluruh folder galeri (get, 7 hari).
    let token = null;
    try {
      token = await issueSignedToken({ pathname: '*', operations: ['get'], validUntil: Date.now() + 7 * 24 * 3600 * 1000 });
    } catch (e) {
      console.error('[gallery/list] token:', e && e.message ? e.message : e);
    }

    const items = [];
    for (const b of blobs || []) {
      const ext = extOf(b.pathname);
      if (isVid && VID_EXT.indexOf(ext) === -1) continue;
      if (!isVid && IMG_EXT.indexOf(ext) === -1) continue;
      const meta = parsePathname(b.pathname);
      let readable = b.url;
      if (token) {
        try {
          const { presignedUrl } = await presignUrl(token, { operation: 'get', pathname: b.pathname, access: 'private' });
          readable = presignedUrl;
        } catch (e) { /* pakai URL asli bila presign gagal */ }
      }
      items.push({
        id: b.pathname,
        pathname: b.pathname,
        url: readable,
        mime: MIME[ext] || 'application/octet-stream',
        size: b.size || 0,
        uploadedAt: b.uploadedAt ? new Date(b.uploadedAt).toISOString() : '',
        filename: meta.filename || b.pathname.split('/').pop() || 'file',
        judul: meta.judul || meta.filename || '',
        kelas: meta.kelas || '',
        tanggal: meta.tanggal || '',
      });
    }
    items.sort((a, b2) => (a.uploadedAt < b2.uploadedAt ? 1 : a.uploadedAt > b2.uploadedAt ? -1 : 0));
    return new Response(JSON.stringify(items), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=30', ...CORS },
    });
  } catch (e) {
    console.error('[gallery/list]', e && e.stack ? e.stack : String(e));
    return new Response(JSON.stringify({ error: 'Gagal memuat galeri: ' + String((e && e.message) || e) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
    });
  }
}