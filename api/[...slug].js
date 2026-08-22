// rev 2026-08-21a
// api/[...slug].js
// Satu fungsi serverless yang menangani SELURUH API aplikasi (MongoDB Atlas).
// Dipakai karena paket Hobby Vercel membatasi maksimal 12 fungsi; dengan
// catch-all ini hanya 1 fungsi untuk semua endpoint data + auth + galeri.
//
// Rute:
//   POST /api/auth/login, GET /api/auth/me, POST /api/auth/change-password
//   GET|PUT /api/m/santri, PUT|DELETE /api/m/santri/:id
//   GET|PUT /api/m/kelas,  PUT|DELETE /api/m/kelas/:id
//   GET|PUT /api/m/absensi
//   GET|PUT /api/m/meta
//   GET|DELETE /api/galeri  (DELETE body {pathname})
//   GET|POST|DELETE /api/files  (POST = upload ke Blob; DELETE body {pathname})
//   DELETE /api/files/:pathname
//   POST /api/admin/backup (unduh JSON seluruh data), GET /api/admin/backup/status
//   GET /api/audit-logs
//   POST /api/_seed (migrasi sekali pakai, butuh SEED_TOKEN)
import { put, del, get, list, issueSignedToken, presignUrl } from '@vercel/blob';
import zlib from 'zlib';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { mongoDb } from '../lib/mongo.js';
import { signToken } from '../lib/jwt.js';
import { json, bad, readJson, authFrom, handleOpts } from '../lib/http.js';
import { findUser, verifyPassword, classIdsForGuru, hashSha256 } from '../lib/users.js';

export const config = { runtime: 'nodejs' };

export function OPTIONS() {
  return handleOpts();
}

const seg = (req) => {
  const url = new URL(req.url);
  const q = url.searchParams.get('seg');
  if (q) return q.split('/').filter(Boolean);
  return String(url.pathname).replace(/^\/api\/?/, '').split('/').filter(Boolean);
};

const roleAdmin = (auth) => auth && auth.role === 'admin';

// ---------- auth ----------
async function hLogin(req) {
  const body = await readJson(req);
  const username = String((body && body.username) || '').trim();
  const password = String((body && body.password) || '');
  if (!username || !password) return bad(req, 'Username dan password wajib diisi.');
  const db = await mongoDb();
  const user = await findUser(db, username);
  if (!user || !(await verifyPassword(password, user.passHash))) return bad(req, 'Username atau password salah', 401);
  let classIds = null;
  if (user.role === 'guru') classIds = await classIdsForGuru(db, user.name);
  const token = signToken({ sub: String(user._id), role: user.role, ver: Number(user.ver || 1) }, process.env.JWT_SECRET);
  return json(req, 200, {
    token,
    user: { id: String(user._id), name: user.name || '', username: user.username, role: user.role, classIds },
  });
}

async function hMe(req) {
  const auth = authFrom(req);
  if (!auth) return bad(req, 'Sesi tidak valid. Silakan masuk kembali.', 401);
  const db = await mongoDb();
  const u = await db.collection('guru').findOne({ _id: String(auth.sub) });
  if (!u) return bad(req, 'Akun tidak ditemukan.', 404);
  return json(req, 200, { id: String(u._id), role: u.role, name: u.name || '' });
}

async function hChangePassword(req) {
  const auth = authFrom(req);
  if (!auth) return bad(req, 'Sesi tidak valid. Silakan masuk kembali.', 401);
  const body = await readJson(req);
  const cur = String((body && body.currentPassword) || '');
  const np = String((body && body.newPassword) || '');
  if (!cur || np.length < 4) return bad(req, 'Kata sandi baru minimal 4 karakter.');
  const db = await mongoDb();
  const u = await findUser(db, String(auth.sub));
  if (!u) return bad(req, 'Akun tidak ditemukan.', 404);
  if (!(await verifyPassword(cur, u.passHash))) return bad(req, 'Kata sandi lama salah.', 400);
  const newHash = u.role === 'admin' ? await bcrypt.hash(np, 12) : hashSha256(np);
  await db.collection('guru').updateOne({ _id: u._id }, { $set: { passHash: newHash, ver: Number(u.ver || 1) + 1 } });
  const meta = await db.collection('meta').findOne({ _id: 'app' });
  if (meta && Array.isArray(meta.teachers)) {
    const teachers = meta.teachers.map((t) =>
      String(t.username).toLowerCase() === String(u._id).toLowerCase() ? { ...t, passHash: newHash } : t
    );
    await db.collection('meta').updateOne({ _id: 'app' }, { $set: { teachers } });
  }
  return json(req, 200, { ok: true });
}

// ---------- koleksi m (native shape) ----------
async function bulkUpsert(req, colName) {
  const auth = authFrom(req);
  if (!auth) return bad(req, 'Sesi tidak valid. Silakan masuk kembali.', 401);
  const body = await readJson(req);
  const docs = Array.isArray(body && body.data) ? body.data : [];
  if (!docs.length) return json(req, 200, { ok: true, updated: 0 });
  const db = await mongoDb();
  const col = db.collection(colName);
  const ops = docs.map((d) => ({
    replaceOne: { filter: { _id: String(d.id) }, replacement: { ...d, _id: String(d.id) }, upsert: true },
  }));
  const res = await col.bulkWrite(ops, { ordered: false });
  return json(req, 200, { ok: true, updated: res.upsertedCount + res.modifiedCount });
}

async function hSantriList(req) {
  const auth = authFrom(req);
  if (!auth) return bad(req, 'Sesi tidak valid. Silakan masuk kembali.', 401);
  const db = await mongoDb();
  const rows = await db.collection('santri').find({}).sort({ name: 1 }).toArray();
  return json(req, 200, { data: rows });
}

async function hKelasList(req) {
  const auth = authFrom(req);
  if (!auth) return bad(req, 'Sesi tidak valid. Silakan masuk kembali.', 401);
  const db = await mongoDb();
  const rows = await db.collection('kelas').find({}).sort({ name: 1 }).toArray();
  return json(req, 200, { data: rows });
}

async function hDocUpsert(req, colName) {
  const auth = authFrom(req);
  if (!auth) return bad(req, 'Sesi tidak valid. Silakan masuk kembali.', 401);
  const id = String(new URL(req.url).pathname).split('/').pop() || '';
  if (!id) return bad(req, 'ID wajib diisi.', 400);
  const body = await readJson(req);
  if (!body) return bad(req, 'Data kosong.', 400);
  const db = await mongoDb();
  await db.collection(colName).replaceOne({ _id: String(id) }, { ...body, _id: String(id) }, { upsert: true });
  return json(req, 200, { ok: true });
}

async function hDocDelete(req, colName) {
  const auth = authFrom(req);
  if (!auth) return bad(req, 'Sesi tidak valid. Silakan masuk kembali.', 401);
  const id = String(new URL(req.url).pathname).split('/').pop() || '';
  if (!id) return bad(req, 'ID wajib diisi.', 400);
  const db = await mongoDb();
  await db.collection(colName).deleteOne({ _id: String(id) });
  return json(req, 200, { ok: true });
}

async function hAbsensiGet(req) {
  const auth = authFrom(req);
  if (!auth) return bad(req, 'Sesi tidak valid. Silakan masuk kembali.', 401);
  const db = await mongoDb();
  const rows = await db.collection('absensi').find({}).toArray();
  const merged = {};
  for (const r of rows) merged[r.date] = r.byClass || {};
  return json(req, 200, { data: merged });
}

async function hAbsensiPut(req) {
  const auth = authFrom(req);
  if (!auth) return bad(req, 'Sesi tidak valid. Silakan masuk kembali.', 401);
  const body = await readJson(req);
  const data = (body && body.data) || {};
  const dates = Object.keys(data);
  if (!dates.length) return json(req, 200, { ok: true, updated: 0 });
  const db = await mongoDb();
  const col = db.collection('absensi');
  let updated = 0;
  for (const date of dates) {
    const byClass = data[date] || {};
    const prev = await col.findOne({ _id: date });
    const merged = prev ? { ...(prev.byClass || {}), ...byClass } : byClass;
    const res = await col.replaceOne({ _id: date }, { _id: date, date, byClass: merged }, { upsert: true });
    updated += (res.modifiedCount || 0) + (res.upsertedCount || 0);
  }
  return json(req, 200, { ok: true, updated });
}

const META_FIELDS = ['profile', 'teachers', 'settings', 'statusConfig', 'finance', 'rekening', 'slides', 'musik_settings', 'musik_meta', 'fileTemplate'];

async function hMetaGet(req) {
  const auth = authFrom(req);
  if (!auth) return bad(req, 'Sesi tidak valid. Silakan masuk kembali.', 401);
  const db = await mongoDb();
  const doc = await db.collection('meta').findOne({ _id: 'app' });
  const data = {};
  for (const f of META_FIELDS) if (doc && doc[f] !== undefined) data[f] = doc[f];
  return json(req, 200, { data });
}

async function hMetaPut(req) {
  const auth = authFrom(req);
  if (!auth) return bad(req, 'Sesi tidak valid. Silakan masuk kembali.', 401);
  const body = await readJson(req);
  const data = (body && body.data) || {};
  if (typeof data !== 'object' || Array.isArray(data)) return bad(req, 'Data tidak valid.', 400);
  const db = await mongoDb();
  const update = {};
  for (const [k, v] of Object.entries(data)) if (k !== '_id') update[k] = v;
  await db.collection('meta').updateOne({ _id: 'app' }, { $set: update }, { upsert: true });
  if (Array.isArray(update.teachers)) {
    const g = db.collection('guru');
    const seen = new Set();
    for (const t of update.teachers) {
      const username = String(t.username || '').trim().toLowerCase();
      if (!username) continue;
      seen.add(username);
      await g.updateOne(
        { _id: username },
        { $set: { _id: username, username, name: t.name || '', passHash: t.passHash || '', role: 'guru' } },
        { upsert: true }
      );
    }
    const all = await g.find({ role: 'guru' }).toArray();
    for (const u of all) if (!seen.has(u._id)) await g.deleteOne({ _id: u._id });
  }
  return json(req, 200, { ok: true });
}

// ---------- galeri & files ----------
async function hGaleriList(req) {
  const db = await mongoDb();
  const rows = await db.collection('galeri').find({}).sort({ createdAt: -1 }).toArray();
  return json(req, 200, { data: rows });
}

async function hGaleriDelete(req) {
  const auth = authFrom(req);
  if (!auth) return bad(req, 'Sesi tidak valid. Silakan masuk kembali.', 401);
  const body = await readJson(req);
  const pathname = String((body && body.pathname) || '').trim();
  if (!pathname.startsWith('galeri/')) return bad(req, 'Path tidak valid.', 400);
  const db = await mongoDb();
  await db.collection('galeri').deleteOne({ _id: pathname });
  try { await del(pathname); } catch (e) { console.error('[del blob]', e && e.message ? e.message : e); }
  return json(req, 200, { ok: true });
}

const MAX_UPLOAD = 200 * 1024 * 1024;
const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp', 'image/heic', 'image/heif', 'image/avif'];
const VIDEO_MIMES = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska', 'video/3gpp', 'video/3gpp2'];
const AUDIO_MIMES = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/aac', 'audio/x-m4a', 'audio/m4a', 'audio/mp4', 'audio/flac', 'audio/x-flac', 'audio/webm', 'audio/amr'];

function headerDecode(value) {
  const raw = String(value || '');
  try { return decodeURIComponent(raw); } catch (e) { return raw; }
}

function buildPathname({ filename, judul, kelas, tanggal, mime }) {
  const m = String(filename || '').match(/\.[a-zA-Z0-9]+$/);
  const ext = m ? m[0].slice(0, 10).toLowerCase() : '';
  const safeExt = ext || (String(mime).startsWith('video/') ? '.mp4' : '.jpg');
  const ts = Date.now();
  const rand = crypto.randomBytes(4).toString('hex');
  const meta = Buffer.from(JSON.stringify({
    f: String(filename || '').slice(0, 80),
    j: String(judul || '').slice(0, 120),
    k: String(kelas || '').slice(0, 40),
    t: String(tanggal || '').slice(0, 10),
  }), 'utf8').toString('base64url');
  return `galeri/${ts}_${rand}~${meta}${safeExt}`;
}

async function hFilesUpload(req) {
  const auth = authFrom(req);
  if (!auth) return bad(req, 'Sesi tidak valid. Silakan masuk kembali.', 401);
  const buf = Buffer.from(await req.arrayBuffer());
  if (!buf.length) return bad(req, 'Tidak ada data file.');
  const mime = String(req.headers.get('x-mime') || '').toLowerCase();
  const isImg = IMAGE_MIMES.includes(mime);
  const isVid = VIDEO_MIMES.includes(mime);
  if (!isImg && !isVid) return bad(req, 'Hanya foto (image/*) dan video (video/*) yang diperbolehkan.');
  if (buf.length > MAX_UPLOAD) return bad(req, 'File terlalu besar (maksimal 200MB).', 413);
  const filename = headerDecode(req.headers.get('x-filename')).slice(0, 255);
  const judul = headerDecode(req.headers.get('x-judul')).trim().slice(0, 255) || '';
  const kelas = headerDecode(req.headers.get('x-kelas')).trim().slice(0, 40) || '';
  const tanggal = headerDecode(req.headers.get('x-tanggal')).trim().slice(0, 10) || '';
  const pathname = buildPathname({ filename, judul, kelas, tanggal, mime });
  const blob = await put(pathname, buf, { contentType: mime, access: 'private', addRandomSuffix: false });
  const db = await mongoDb();
  const doc = {
    _id: pathname, pathname, filename, mime, size: blob.size || buf.length,
    judul, kelas, tanggal, createdAt: Date.now(), url: blob.url || '',
  };
  await db.collection('galeri').replaceOne({ _id: pathname }, doc, { upsert: true });
  return json(req, 201, { id: pathname, url: blob.url || '', pathname, source: 'cloud' });
}

async function hFilesDelete(req) {
  const auth = authFrom(req);
  if (!auth) return bad(req, 'Sesi tidak valid. Silakan masuk kembali.', 401);
  let pathname = '';
  const body = await readJson(req);
  if (body && typeof body === 'object' && body.pathname) pathname = String(body.pathname);
  if (!pathname) pathname = String(new URL(req.url).pathname).split('/').pop() || '';
  if (!pathname.startsWith('galeri/')) return bad(req, 'Path tidak valid.', 400);
  const db = await mongoDb();
  await db.collection('galeri').deleteOne({ _id: pathname });
  try { await del(pathname); } catch (e) { console.error('[del blob]', e && e.message ? e.message : e); }
  return json(req, 200, { ok: true });
}

// ---------- musik bersama (MP3 di Blob, daftar publik) ----------
async function hMusikList(req) {
  const db = await mongoDb();
  const rows = await db.collection('musik').find({}).sort({ createdAt: 1 }).toArray();
  let token = null;
  try {
    token = await issueSignedToken({ pathname: '*', operations: ['get'], validUntil: Date.now() + 7 * 24 * 3600 * 1000 });
  } catch (e) { console.error('[musik/list] token:', e && e.message ? e.message : e); }
  const items = [];
  for (const r of rows) {
    let readable = r.url || '';
    if (token && r.pathname) {
      try {
        const { presignedUrl } = await presignUrl(token, { operation: 'get', pathname: r.pathname, access: 'private' });
        readable = presignedUrl;
      } catch (e) { /* pakai URL asli bila presign gagal */ }
    }
    items.push({ id: r.pathname, pathname: r.pathname, name: r.name || '', size: r.size || 0, mime: r.mime || 'audio/mpeg', createdAt: r.createdAt || 0, url: readable });
  }
  return json(req, 200, { data: items });
}

async function hMusikUpload(req) {
  const auth = authFrom(req);
  if (!auth) return bad(req, 'Sesi tidak valid. Silakan masuk kembali.', 401);
  const buf = Buffer.from(await req.arrayBuffer());
  if (!buf.length) return bad(req, 'Tidak ada data file.');
  const mime = String(req.headers.get('x-mime') || '').toLowerCase();
  const isAudio = AUDIO_MIMES.includes(mime) || String(mime).startsWith('audio/');
  if (!isAudio) return bad(req, 'Hanya file audio (MP3/dll) yang diperbolehkan.');
  if (buf.length > MAX_UPLOAD) return bad(req, 'File terlalu besar (maksimal 200MB).', 413);
  const name = headerDecode(req.headers.get('x-filename')).slice(0, 120) || ('Lagu-' + Date.now());
  const extMatch = String(name).match(/\.[a-zA-Z0-9]+$/);
  const ext = extMatch ? extMatch[0].slice(0, 6).toLowerCase() : '.mp3';
  const ts = Date.now();
  const rand = crypto.randomBytes(4).toString('hex');
  const metaB64 = Buffer.from(JSON.stringify({ n: name }), 'utf8').toString('base64url');
  const pathname = `musik/${ts}_${rand}~${metaB64}${ext}`;
  const blob = await put(pathname, buf, { contentType: mime || 'audio/mpeg', access: 'private', addRandomSuffix: false });
  const db = await mongoDb();
  const doc = { _id: pathname, pathname, name, size: blob.size || buf.length, mime: mime || 'audio/mpeg', createdAt: Date.now(), url: blob.url || '' };
  await db.collection('musik').replaceOne({ _id: pathname }, doc, { upsert: true });
  return json(req, 201, { id: pathname, pathname, name, size: doc.size, source: 'cloud' });
}

async function hMusikDelete(req) {
  const auth = authFrom(req);
  if (!auth) return bad(req, 'Sesi tidak valid. Silakan masuk kembali.', 401);
  const body = await readJson(req);
  let id = (body && typeof body === 'object' && body.pathname) ? String(body.pathname) : '';
  if (!id) id = seg(req)[1] || '';
  if (!id.startsWith('musik/')) return bad(req, 'Path tidak valid.', 400);
  const db = await mongoDb();
  await db.collection('musik').deleteOne({ _id: id });
  try { await del(id); } catch (e) { console.error('[del musik]', e && e.message ? e.message : e); }
  return json(req, 200, { ok: true });
}

// ---------- admin & audit ----------
async function hBackup(req) {
  const auth = authFrom(req);
  if (!auth || !roleAdmin(auth)) return bad(req, 'Akses ditolak. Diperlukan admin.', 403);
  const db = await mongoDb();
  const out = {};
  for (const c of ['santri', 'kelas', 'absensi', 'galeri', 'meta', 'guru']) {
    out[c] = await db.collection(c).find({}).toArray();
  }
  const filename = `absensi-backup-${new Date().toISOString().slice(0, 10)}.json`;
  return new Response(JSON.stringify({ exportedAt: new Date().toISOString(), db: out }, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

async function hBackupStatus(req) {
  const auth = authFrom(req);
  if (!auth) return bad(req, 'Sesi tidak valid. Silakan masuk kembali.', 401);
  const db = await mongoDb();
  const counts = {
    santri: await db.collection('santri').countDocuments(),
    absensi: await db.collection('absensi').countDocuments(),
    galeri: await db.collection('galeri').countDocuments(),
  };
  return json(req, 200, { enabled: true, mirrorEnabled: false, lastBackup: null, lastMirrorSync: null, db: 'mongodb-atlas', counts });
}

async function hAuditLogs(req) {
  const auth = authFrom(req);
  if (!auth) return bad(req, 'Sesi tidak valid. Silakan masuk kembali.', 401);
  return json(req, 200, { total: 0, data: [] });
}

// ---------- galeri publik (Blob, tanpa auth) ----------
const IMG_EXT = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'avif', 'bmp'];
const VID_EXT = ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v', '3gp'];
const GALLERY_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  gif: 'image/gif', heic: 'image/heic', avif: 'image/avif', bmp: 'image/bmp',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  avi: 'video/x-msvideo', m4v: 'video/mp4', '3gp': 'video/3gpp',
};
const unb64 = (s) => { try { return Buffer.from(s, 'base64url').toString('utf8'); } catch (e) { return ''; } };
const extOf = (p) => String(p || '').split('.').pop().toLowerCase();

async function hGalleryList(req) {
  try {
    const url = new URL(req.url);
    const isVid = url.searchParams.get('type') === 'video';
    const { blobs } = await list({ prefix: 'galeri/', limit: 1000 });
    let token = null;
    try {
      token = await issueSignedToken({ pathname: '*', operations: ['get'], validUntil: Date.now() + 7 * 24 * 3600 * 1000 });
    } catch (e) { console.error('[gallery/list] token:', e && e.message ? e.message : e); }
    const items = [];
    for (const b of blobs || []) {
      const ext = extOf(b.pathname);
      if (isVid && VID_EXT.indexOf(ext) === -1) continue;
      if (!isVid && IMG_EXT.indexOf(ext) === -1) continue;
      const meta = pathnameMeta(b.pathname);
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
        mime: GALLERY_MIME[ext] || 'application/octet-stream',
        size: b.size || 0,
        uploadedAt: b.uploadedAt ? new Date(b.uploadedAt).toISOString() : '',
        filename: meta.filename || b.pathname.split('/').pop() || 'file',
        judul: meta.judul || meta.filename || '',
        kelas: meta.kelas || '',
        tanggal: meta.tanggal || '',
      });
    }
    items.sort((a, b2) => (a.uploadedAt < b2.uploadedAt ? 1 : a.uploadedAt > b2.uploadedAt ? -1 : 0));
    return json(req, 200, items, { 'Cache-Control': 'public, max-age=30' });
  } catch (e) {
    console.error('[gallery/list]', e && e.stack ? e.stack : String(e));
    return bad(req, 'Gagal memuat galeri: ' + String((e && e.message) || e), 500);
  }
}

// ---------- seed ----------
const pathnameMeta = (p) => {
  const m = String(p || '').match(/^galeri\/(\d+)_([a-z0-9]+)~([A-Za-z0-9_-]+)(\.[a-zA-Z0-9]+)?$/);
  if (!m) return { filename: '', judul: '', kelas: '', tanggal: '', ts: 0 };
  let meta = {};
  try { meta = JSON.parse(Buffer.from(m[3], 'base64url').toString('utf8') || '{}'); } catch (e) { meta = {}; }
  return { filename: meta.f || '', judul: meta.j || '', kelas: meta.k || '', tanggal: meta.t || '', ts: Number(m[1]) || 0 };
};

function bestOf(dump) {
  const best = {};
  for (const [k, v] of Object.entries(dump || {})) {
    if (typeof v === 'string') {
      if (!best[k] || v.length > best[k].length) best[k] = v;
    } else if (v && typeof v === 'object') {
      for (const [k2, v2] of Object.entries(v)) {
        if (typeof v2 !== 'string') continue;
        if (!best[k2] || v2.length > best[k2].length) best[k2] = v2;
      }
    }
  }
  return best;
}

const parse = (best, k, fallback) => {
  try { return JSON.parse(best[k] || 'null'); } catch (e) { return fallback; }
};

async function hSeed(req) {
  const expected = process.env.SEED_TOKEN;
  const auth = req.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!expected || token !== expected) return bad(req, 'Akses ditolak.', 403);
  const body = await readJson(req);
  let payload = null;
  if (body && body.data && typeof body.data === 'object') payload = body.data;
  else if (body && body.data && typeof body.data === 'string') {
    // body.data berisi JSON (string) langsung
    payload = JSON.parse(body.data);
  } else if (body && body.gz) {
    payload = JSON.parse(zlib.gunzipSync(Buffer.from(String(body.gz), 'base64')).toString('utf8'));
  } else if (body && body.blobPath) {
    const res = await get(body.blobPath, { access: 'private', token: process.env.BLOB_READ_WRITE_TOKEN });
    if (!res || res.statusCode !== 200 || !res.stream) throw new Error('Gagal membaca blob seed (status ' + (res && res.statusCode) + ')');
    payload = JSON.parse(await new Response(res.stream).text());
  } else return bad(req, 'Kirim body { data } atau { blobPath }.', 400);

  const { dump = {}, legacy = {} } = payload || {};
  const best = bestOf(dump);
  const students = parse(best, 'mda_students', []) || [];
  const classes = parse(best, 'mda_classes', []) || [];
  const attendance = parse(best, 'mda_attendance', {}) || {};
  const teachers = parse(best, 'mda_teachers', []) || [];
  const profile = parse(best, 'mda_profile', {}) || {};
  const settings = parse(best, 'mda_settings', {}) || {};
  const statusConfig = parse(best, 'mda_statusConfig', []) || [];
  const finance = parse(best, 'mda_finance', []) || [];
  const rekening = parse(best, 'mda_rekening', {}) || {};
  const slides = parse(best, 'mda_slides', []) || [];
  const musik_settings = parse(best, 'mda_musik_settings', null);
  const musik_meta = parse(best, 'mda_musik_meta', null);
  const fileTemplate = best['mda_fileTemplate'] || '';

  const galeri = [];
  for (const f of legacy.files || []) {
    if (!f.pathname) continue;
    const meta = pathnameMeta(f.pathname);
    galeri.push({
      _id: f.pathname, pathname: f.pathname, filename: f.filename || meta.filename || '',
      mime: f.mime || '', size: Number(f.size) || 0, judul: f.judul || meta.judul || '',
      kelas: meta.kelas || '', tanggal: meta.tanggal || '', createdAt: meta.ts || Date.now(), url: '',
    });
  }

  const guru = [];
  const admin = (legacy.users || []).find((u) => String(u.role) === 'admin');
  if (admin && admin.password_hash) {
    guru.push({ _id: String(admin.username).toLowerCase(), username: String(admin.username).toLowerCase(), name: admin.name || 'Administrator', role: 'admin', passHash: admin.password_hash, ver: 1 });
  }
  for (const t of teachers) {
    if (!t.username) continue;
    guru.push({ _id: String(t.username).toLowerCase(), username: String(t.username).toLowerCase(), name: t.name || t.username, role: 'guru', passHash: t.passHash || '', ver: 1 });
  }

  const db = await mongoDb();
  await db.collection('santri').deleteMany({});
  if (students.length) await db.collection('santri').insertMany(students.map((s) => ({ ...s, _id: String(s.id) })));
  await db.collection('kelas').deleteMany({});
  if (classes.length) await db.collection('kelas').insertMany(classes.map((c) => ({ ...c, _id: String(c.id) })));
  await db.collection('absensi').deleteMany({});
  const dates = Object.keys(attendance);
  if (dates.length) await db.collection('absensi').insertMany(dates.map((date) => ({ _id: date, date, byClass: attendance[date] || {} })));
  await db.collection('galeri').deleteMany({});
  if (galeri.length) await db.collection('galeri').insertMany(galeri);
  await db.collection('meta').deleteMany({});
  await db.collection('meta').insertOne({
    _id: 'app', profile, teachers, settings, statusConfig, finance, rekening, slides,
    ...(musik_settings === null ? {} : { musik_settings }),
    ...(musik_meta === null ? {} : { musik_meta }),
    ...(fileTemplate ? { fileTemplate } : {}),
  });
  await db.collection('guru').deleteMany({});
  if (guru.length) await db.collection('guru').insertMany(guru);

  return json(req, 200, {
    ok: true,
    result: { santri: students.length, kelas: classes.length, absensi: dates.length, galeri: galeri.length, guru: guru.map((g) => g.username + '(' + g.role + ')') },
  });
}

// ---------- router ----------
export async function GET(req) {
  try {
    const s = seg(req);
    if (s[0] === 'auth' && s[1] === 'me') return await hMe(req);
    if (s[0] === 'm' && s[1] === 'santri' && !s[2]) return await hSantriList(req);
    if (s[0] === 'm' && s[1] === 'kelas' && !s[2]) return await hKelasList(req);
    if (s[0] === 'm' && s[1] === 'absensi' && !s[2]) return await hAbsensiGet(req);
    if (s[0] === 'm' && s[1] === 'meta' && !s[2]) return await hMetaGet(req);
    if (s[0] === 'gallery' && s[1] === 'list') return await hGalleryList(req);
    if (s[0] === 'galeri' && !s[1]) return await hGaleriList(req);
    if (s[0] === 'musik' && !s[1]) return await hMusikList(req);
    if (s[0] === 'files' && !s[1]) return await hGaleriList(req);
    if (s[0] === 'admin' && s[1] === 'backup' && s[2] === 'status') return await hBackupStatus(req);
    if (s[0] === 'audit-logs') return await hAuditLogs(req);
    return bad(req, 'Tidak ditemukan.', 404);
  } catch (e) {
    console.error('[api GET]', e && e.stack ? e.stack : String(e));
    return bad(req, 'Gagal terhubung ke database.', 503);
  }
}

export async function POST(req) {
  try {
    const s = seg(req);
    if (s[0] === 'auth' && s[1] === 'login') return await hLogin(req);
    if (s[0] === 'auth' && s[1] === 'change-password') return await hChangePassword(req);
    if (s[0] === 'files' && !s[1]) return await hFilesUpload(req);
    if (s[0] === 'musik' && !s[1]) return await hMusikUpload(req);
    if (s[0] === 'admin' && s[1] === 'backup' && !s[2]) return await hBackup(req);
    if (s[0] === '_seed') return await hSeed(req);
    return bad(req, 'Tidak ditemukan.', 404);
  } catch (e) {
    console.error('[api POST]', e && e.stack ? e.stack : String(e));
    return bad(req, 'Gagal terhubung ke database.', 503);
  }
}

export async function PUT(req) {
  try {
    const s = seg(req);
    if (s[0] === 'm' && s[1] === 'santri') {
      if (!s[2]) return await bulkUpsert(req, 'santri');
      return await hDocUpsert(req, 'santri');
    }
    if (s[0] === 'm' && s[1] === 'kelas') {
      if (!s[2]) return await bulkUpsert(req, 'kelas');
      return await hDocUpsert(req, 'kelas');
    }
    if (s[0] === 'm' && s[1] === 'absensi' && !s[2]) return await hAbsensiPut(req);
    if (s[0] === 'm' && s[1] === 'meta' && !s[2]) return await hMetaPut(req);
    return bad(req, 'Tidak ditemukan.', 404);
  } catch (e) {
    console.error('[api PUT]', e && e.stack ? e.stack : String(e));
    return bad(req, 'Gagal terhubung ke database.', 503);
  }
}

export async function DELETE(req) {
  try {
    const s = seg(req);
    if (s[0] === 'm' && s[1] === 'santri' && s[2]) return await hDocDelete(req, 'santri');
    if (s[0] === 'm' && s[1] === 'kelas' && s[2]) return await hDocDelete(req, 'kelas');
    if (s[0] === 'galeri' && !s[1]) return await hGaleriDelete(req);
    if (s[0] === 'files') return await hFilesDelete(req);
    if (s[0] === 'musik' && s[1]) return await hMusikDelete(req);
    return bad(req, 'Tidak ditemukan.', 404);
  } catch (e) {
    console.error('[api DELETE]', e && e.stack ? e.stack : String(e));
    return bad(req, 'Gagal terhubung ke database.', 503);
  }
}