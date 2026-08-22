// scripts/run-seed.cjs
// Migrasi data lama ke MongoDB Atlas via endpoint /api/_seed di runtime Vercel
// (connection string Atlas terdekripsi otomatis di sana).
// Payload dikirim langsung di body, dikompres gzip + base64 agar muat limit 4.5MB.
//
// Pemakaian:
//   node scripts/run-seed.cjs <SEED_TOKEN> [baseURL] [dumpPath] [legacyPath]
const zlib = require('zlib');
const fs = require('fs');

const SEED_TOKEN = process.argv[2];
const BASE = process.argv[3] || 'https://absensi-mudah.vercel.app';
const DUMP = process.argv[4] || 'E:\\Absensi-Madin\\.data\\localstorage-dump.json';
const LEGACY = process.argv[5] || 'C:\\Users\\USER\\AppData\\Local\\Temp\\opencode\\legacy-extract.json';

if (!SEED_TOKEN) {
  console.error('Pemakaian: node scripts/run-seed.cjs <SEED_TOKEN> [baseURL]');
  process.exit(1);
}

async function main() {
  const dump = JSON.parse(fs.readFileSync(DUMP, 'utf8'));
  const legacy = fs.existsSync(LEGACY) ? JSON.parse(fs.readFileSync(LEGACY, 'utf8')) : { users: [], files: [] };

  // Pilih nilai terbaik per kunci (paling lengkap) dari semua origin — jauh lebih ringkas.
  const best = {};
  for (const kv of Object.values(dump || {})) {
    if (!kv || typeof kv !== 'object') continue;
    for (const [k, v] of Object.entries(kv)) {
      if (typeof v !== 'string') continue;
      if (!best[k] || v.length > best[k].length) best[k] = v;
    }
  }

  const payload = { dump: best, legacy };
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(payload))).toString('base64');
  console.log('Payload gzip:', gz.length, 'char base64 (~' + Math.round(gz.length / 1024) + ' KB).');

  const res = await fetch(BASE + '/api/_seed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + SEED_TOKEN },
    body: JSON.stringify({ gz }),
  });
  const txt = await res.text();
  console.log('HTTP', res.status);
  console.log(txt.slice(0, 3000));
  if (!res.ok) throw new Error('seed HTTP ' + res.status);
}

main().catch((e) => {
  console.error('GAGAL:', e && e.stack ? e.stack : e);
  process.exit(1);
});