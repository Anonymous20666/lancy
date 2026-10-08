import { createHash, randomBytes } from 'node:crypto';

export function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function sha256Base64(buffer) {
  return createHash('sha256').update(buffer).digest('base64');
}

/** Stable fingerprint string for a media buffer (sha256 hex). */
export function fingerprint(buffer) {
  return sha256Hex(buffer);
}

export function randomToken(bytes = 16) {
  return randomBytes(bytes).toString('hex');
}

/** Constant-time-ish equality for hex digests. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
