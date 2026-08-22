// scripts/migrate.js
// Migrasi data lama ke MongoDB Atlas (dijalankan SEKALI di PC/server).
//
// Sumber:
//   1. localstorage-dump.json — hasil ekstrak localStorage Chrome (mda_*).
//   2. legacy-extract.json   — ekstrak SQLite server (users + files/galeri).
//
// Pemakaian:
//   node scripts/migrate.js --dump <file.json> --legacy <file.json> --uri "mongodb+srv://..."
//   (atau set env MONGODB_URI)
//
// Idempoten: setiap koleksi dikosongkan lalu diisi ulang dari sumber.
import { MongoClient } from 'mongodb';
import fs from 'fs';
import path from 'path';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i];
  if (k && k.startsWith('--')) args[k.slice(2)] = process.argv[i + 1];
}

const DUMP_PATH = args.dump || 'C:\\Users\\USER\\AppData\\Local\\Temp\\opencode\\localstorage-dump.json';
const LEGACY_PATH = args.legacy || 'C:\\Users\\USER\\AppData\\Local\\Temp\\opencode\\legacy-extract.json';
const URI = args.uri || process.env.MONGODB_URI;

const dump = JSON.parse(fs.readFileSync(DUMP_PATH, 'utf8'));
const legacy = fs.existsSync(LEGACY_PATH)
  ? JSON.parse(fs.readFileSync(LEGACY_PATH, 'utf8'))
  : { users: [], files: [], settings: [] };

// Pilih nilai terbaik per kunci di antara semua origin (paling panjang).
const best = {};
for (const kv of Object.values(dump)) {
  if (!kv || typeof kv !== 'object') continue;
  for (const [k, v] of Object.entries(kv)) {
    if (typeof v !== 'string') continue;
    if (!best[k] || v.length > best[k].length) best[k] = v;
  }
}

const parse = (k, fallback) => {
  try { return JSON.parse(best[k] || 'null'); } catch (e) { return fallback; }
};

const students = parse('mda_students', []) || [];
const classes = parse('mda_classes', []) || [];
const attendance = parse('mda_attendance', {}) || {};
const dates = Object.keys(attendance);
const teachers = parse('mda_teachers', []) || [];
const profile = parse('mda_profile', {}) || {};
const settings = parse('mda_settings', {}) || {};
const statusConfig = parse('mda_statusConfig', []) || [];
const finance = parse('mda_finance', []) || [];
const rekening = parse('mda_rekening', {}) || {};
const slides = parse('mda_slides', []) || [];
const musik_settings = parse('mda_musik_settings', null);
const musik_meta = parse('mda_musik_meta', null);
const fileTemplate = best['mda_fileTemplate'] || '';

const pathnameMeta = (p) => {
  const m = String(p || '').match(/^galeri\/(\d+)_([a-z0-9]+)~([A-Za-z0-9_-]+)(\.[a-zA-Z0-9]+)?$/);
  if (!m) return { filename: '', judul: '', kelas: '', tanggal: '', ts: 0 };
  let meta = {};
  try { meta = JSON.parse(Buffer.from(m[3], 'base64url').toString('utf8') || '{}'); } catch (e) { meta = {}; }
  return { filename: meta.f || '', judul: meta.j || '', kelas: meta.k || '', tanggal: meta.t || '', ts: Number(m[1]) || 0 };
};

const galeri = [];
for (const f of legacy.files || []) {
  if (!f.pathname) continue;
  const meta = pathnameMeta(f.pathname);
  galeri.push({
    _id: f.pathname,
    pathname: f.pathname,
    filename: f.filename || meta.filename || '',
    mime: f.mime || '',
    size: Number(f.size) || 0,
    judul: f.judul || meta.judul || '',
    kelas: meta.kelas || '',
    tanggal: meta.tanggal || '',
    createdAt: meta.ts || Date.now(),
    url: '',
  });
}

const guru = [];
const admin = (legacy.users || []).find((u) => String(u.role) === 'admin');
if (admin && admin.password_hash) {
  guru.push({
    _id: String(admin.username).toLowerCase(),
    username: String(admin.username).toLowerCase(),
    name: admin.name || 'Administrator',
    role: 'admin',
    passHash: admin.password_hash,
    ver: 1,
  });
}
for (const t of teachers) {
  if (!t.username) continue;
  guru.push({
    _id: String(t.username).toLowerCase(),
    username: String(t.username).toLowerCase(),
    name: t.name || t.username,
    role: 'guru',
    passHash: t.passHash || '',
    ver: 1,
  });
}

if (args.dry) {
  console.log('DRY-RUN (tanpa koneksi):');
  console.log('  santri =', students.length, '| kelas =', classes.length, '| absensi =', dates.length, 'tanggal | galeri =', galeri.length, '| akun =', guru.map((g) => g.username + '(' + g.role + ')').join(', '));
  console.log('  profil:', Object.keys(profile).join(',') || '(kosong)', '| teachers:', teachers.map((t) => t.username).join(',') || '(kosong)', '| finance:', finance.length, '| statusConfig:', statusConfig.length);
  process.exit(0);
}

if (!URI) {
  console.error('MONGODB_URI belum diisi. Pakai --uri atau env MONGODB_URI.');
  process.exit(1);
}

async function main() {
  const client = new MongoClient(URI, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  const db = client.db('absensi_madin');
  console.log('Terhubung ke MongoDB Atlas.');

  const santriCol = db.collection('santri');
  await santriCol.deleteMany({});
  if (students.length) {
    await santriCol.insertMany(students.map((s) => ({ ...s, _id: String(s.id) })));
  }
  console.log('santri:', students.length);

  const kelasCol = db.collection('kelas');
  await kelasCol.deleteMany({});
  if (classes.length) {
    await kelasCol.insertMany(classes.map((c) => ({ ...c, _id: String(c.id) })));
  }
  console.log('kelas:', classes.length);

  const absCol = db.collection('absensi');
  await absCol.deleteMany({});
  if (dates.length) {
    await absCol.insertMany(dates.map((date) => ({ _id: date, date, byClass: attendance[date] || {} })));
  }
  console.log('absensi (tanggal):', dates.length);

  const galCol = db.collection('galeri');
  await galCol.deleteMany({});
  if (galeri.length) await galCol.insertMany(galeri);
  console.log('galeri:', galeri.length);

  const metaCol = db.collection('meta');
  await metaCol.deleteMany({});
  await metaCol.insertOne({
    _id: 'app',
    profile,
    teachers,
    settings,
    statusConfig,
    finance,
    rekening,
    slides,
    ...(musik_settings === null ? {} : { musik_settings }),
    ...(musik_meta === null ? {} : { musik_meta }),
    ...(fileTemplate ? { fileTemplate } : {}),
  });
  console.log('meta: 1 dokumen (profil/guru/pengaturan/keuangan/dll)');

  const guruCol = db.collection('guru');
  await guruCol.deleteMany({});
  if (guru.length) await guruCol.insertMany(guru);
  console.log('guru (akun login):', guru.length);

  console.log('\nRINGKASAN:');
  console.log('  santri =', students.length, '| kelas =', classes.length, '| absensi =', dates.length, 'tanggal | galeri =', galeri.length, '| akun =', guru.map((g) => g.username + '(' + g.role + ')').join(', '));
  await client.close();
}

main().catch((e) => {
  console.error('MIGRASI GAGAL:', e && e.stack ? e.stack : e);
  process.exit(1);
});