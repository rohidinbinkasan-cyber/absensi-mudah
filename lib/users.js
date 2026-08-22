// lib/users.js
// Autentikasi berbasis koleksi `guru`: admin (bcrypt) + guru (sha256).
// Guru diambil dari daftar pengajar (mda_teachers) yang dicerminkan ke
// koleksi `guru` saat migrasi/sinkronisasi.
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** Verifikasi password terhadap hash (mendukung bcrypt maupun sha256). */
export async function verifyPassword(plain, passHash) {
  if (!passHash) return false;
  if (String(passHash).startsWith('$2')) {
    try {
      return await bcrypt.compare(String(plain), String(passHash));
    } catch (e) {
      return false;
    }
  }
  return sha(String(plain)) === String(passHash);
}

/** Hash sha256 (dipakai untuk akun guru lokal). */
export function hashSha256(plain) {
  return sha(plain);
}

/**
 * Daftar id kelas yang diampu seorang guru, dicocokkan lewat nama
 * (kelas menyimpan nama guru pengampu, bukan id pengguna).
 * @param {import('mongodb').Db} db
 * @param {string} teacherName nama guru dari akun
 * @returns {Promise<string[]>}
 */
export async function classIdsForGuru(db, teacherName) {
  const kls = await db.collection('kelas').find({}).project({ id: 1, teacher: 1 }).toArray();
  const n = String(teacherName || '').trim().toLowerCase();
  if (!n) return [];
  return kls
    .filter((k) => {
      const t = String(k.teacher || '').trim().toLowerCase();
      if (!t) return false;
      return t === n || t.includes(n) || n.includes(t);
    })
    .map((k) => k.id);
}

/**
 * Cari akun (admin/guru) di koleksi `guru`.
 * @returns {Promise<object|null>} dokumen guru ({_id, username, name, role, passHash})
 */
export async function findUser(db, username) {
  if (!username) return null;
  return db.collection('guru').findOne({ _id: String(username).toLowerCase() });
}