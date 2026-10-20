import crypto from 'node:crypto';

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// No 0/O/1/I so a PIN read aloud or shown on a projector is hard to misread.
const PIN_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function generatePin() {
  let out = '';
  for (let i = 0; i < 6; i++) out += PIN_CHARS[crypto.randomInt(PIN_CHARS.length)];
  return out;
}
export const PIN_REGEX = /^[A-Z0-9]{6}$/;
export const normalizePin = (s) => String(s ?? '').trim().toUpperCase();
