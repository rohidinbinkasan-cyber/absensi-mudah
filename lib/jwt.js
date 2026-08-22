// lib/jwt.js
// JWT HS256 ringan tanpa dependensi eksternal (crypto bawaan Node).
// Format identik dengan token jsonwebtoken agar kompatibel dengan klien lama.
import crypto from 'crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/**
 * Terbitkan token JWT (HS256).
 * @param {object} payload klaim khusus aplikasi
 * @param {string} secret JWT_SECRET
 * @param {number} expiresInSec waktu berlaku (default 2 jam)
 * @returns {string}
 */
export function signToken(payload, secret, expiresInSec = 7200) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + expiresInSec };
  const h = b64url(Buffer.from(JSON.stringify(header), 'utf8'));
  const b = b64url(Buffer.from(JSON.stringify(body), 'utf8'));
  const sig = crypto.createHmac('sha256', secret).update(`${h}.${b}`).digest('base64url');
  return `${h}.${b}.${sig}`;
}

/**
 * Verifikasi token JWT; melempar Error bila tidak sah / kedaluwarsa.
 * @returns {object} payload token
 */
export function verifyToken(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('token tidak valid');
  const [h, b, sig] = parts;
  const expect = crypto.createHmac('sha256', secret).update(`${h}.${b}`).digest('base64url');
  const a = Buffer.from(expect);
  const c = Buffer.from(sig);
  if (a.length !== c.length || !crypto.timingSafeEqual(a, c)) throw new Error('signature tidak valid');
  const body = JSON.parse(Buffer.from(b, 'base64url').toString('utf8'));
  if (body.exp && body.exp * 1000 < Date.now()) throw new Error('token kedaluwarsa');
  return body;
}