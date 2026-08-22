// lib/http.js
// Helper respons HTTP untuk fungsi serverless Vercel (Web Request/Response).
import { verifyToken } from './jwt.js';

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Idempotency-Key, X-Filename, X-Judul, X-Kelas, X-Tanggal, X-Mime',
};

/** JSON response dengan cache-control no-store (data selalu segar). */
export function json(res, status, data, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      ...CORS,
      ...extraHeaders,
    },
  });
}

export function ok(res, data = { ok: true }) {
  return json(res, 200, data);
}

export function bad(res, message, status = 400) {
  return json(res, status, { error: message });
}

export async function readJson(req) {
  try {
    return await req.json();
  } catch (e) {
    return null;
  }
}

export function handleOpts() {
  return new Response('ok', { status: 204, headers: CORS });
}

/**
 * Ekstrak dan verifikasi token Bearer dari request.
 * @returns {object|null} payload JWT bila sah, selain itu null
 */
export function authFrom(req) {
  const h = req.headers.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return null;
  try {
    return verifyToken(token, process.env.JWT_SECRET);
  } catch (e) {
    return null;
  }
}