// lib/mongo.js
// Koneksi MongoDB Atlas dengan client global (di-cache) agar tidak membuat
// koneksi baru per-request (kuota gratis Atlas membatasi ~500 koneksi
// bersamaan). Satu client + satu database untuk seluruh runtime.
import { MongoClient } from 'mongodb';

let client = null;
let db = null;

/**
 * Ambil handle database MongoDB (lazy, di-cache global).
 * Wajib env MONGODB_URI terisi di project Vercel.
 * @returns {Promise<import('mongodb').Db>}
 */
export async function mongoDb() {
  if (db) return db;
  // Nama env bisa MONGODB_URI (manual) atau absensimudah_MONGODB_URI
  // (hasil integrasi Vercel Marketplace — terdekripsi otomatis saat runtime).
  const uri = process.env.MONGODB_URI || process.env.absensimudah_MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI belum terisi di environment Vercel');
  if (!client) {
    client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
      maxPoolSize: 10,
    });
    await client.connect();
  }
  db = client.db('absensi_madin');
  return db;
}

/** Koleksi yang dipakai aplikasi. */
export const COLLECTIONS = {
  santri: 'santri',
  kelas: 'kelas',
  absensi: 'absensi',
  galeri: 'galeri',
  meta: 'meta',
  guru: 'guru',
  audit: 'audit',
};