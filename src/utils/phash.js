/**
 * Perceptual image hashing (pHash) — detects the same image across
 * resizes, recompressions and minor encoding changes.
 *
 * Pipeline: grayscale -> resize to 32x32 -> DCT-II -> keep top-left 8x8
 * (excluding DC) -> median threshold -> 64-bit hash as hex.
 *
 * Input is raw grayscale pixels from sharp (see media/convert.js).
 */

const PHASH_SIZE = 32;   // working grid
const PHASH_KEEP = 8;    // kept coefficients per axis

/** 2D DCT-II of a size x size matrix (naive O(n^4) is fine at 32x32). */
function dct2(matrix) {
  const n = matrix.length;
  const out = Array.from({ length: n }, () => new Array(n).fill(0));
  const cos = (k, i) => Math.cos(((2 * i + 1) * k * Math.PI) / (2 * n));
  for (let u = 0; u < n; u++) {
    for (let v = 0; v < n; v++) {
      let sum = 0;
      for (let x = 0; x < n; x++) {
        for (let y = 0; y < n; y++) {
          sum += matrix[x][y] * cos(u, x) * cos(v, y);
        }
      }
      const cu = u === 0 ? 1 / Math.SQRT2 : 1;
      const cv = v === 0 ? 1 / Math.SQRT2 : 1;
      out[u][v] = 0.25 * cu * cv * sum;
    }
  }
  return out;
}

/**
 * Compute a 64-bit perceptual hash from raw 8-bit grayscale pixels.
 * @param {Uint8Array|Buffer} grayPixels length must be size*size
 * @param {number} size width/height of the square grayscale image
 * @returns {string} 16-char hex hash
 */
export function phashFromGray(grayPixels, size = PHASH_SIZE) {
  if (grayPixels.length !== size * size) {
    throw new Error(`phashFromGray: expected ${size * size} pixels, got ${grayPixels.length}`);
  }
  const matrix = [];
  for (let x = 0; x < size; x++) {
    const row = new Array(size);
    for (let y = 0; y < size; y++) row[y] = grayPixels[x * size + y];
    matrix.push(row);
  }
  const dct = dct2(matrix);
  // Collect low-frequency coefficients (skip DC at [0][0]).
  const coeffs = [];
  for (let u = 0; u < PHASH_KEEP; u++) {
    for (let v = 0; v < PHASH_KEEP; v++) {
      if (u === 0 && v === 0) continue;
      coeffs.push(dct[u][v]);
    }
  }
  const sorted = [...coeffs].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  let bits = 0n;
  for (let i = 0; i < coeffs.length; i++) {
    bits = (bits << 1n) | (coeffs[i] > median ? 1n : 0n);
  }
  return bits.toString(16).padStart(16, '0');
}

/** Hamming distance between two 64-bit hex hashes. */
export function hammingDistance(hashA, hashB) {
  if (!/^[0-9a-f]{16}$/i.test(hashA) || !/^[0-9a-f]{16}$/i.test(hashB)) return Infinity;
  let a = BigInt(`0x${hashA}`);
  let b = BigInt(`0x${hashB}`);
  let x = a ^ b;
  let dist = 0;
  while (x > 0n) {
    dist += Number(x & 1n);
    x >>= 1n;
  }
  return dist;
}

/** True when two images are perceptually near-identical. */
export function isPerceptualDuplicate(hashA, hashB, { threshold = 6 } = {}) {
  return hammingDistance(hashA, hashB) <= threshold;
}

/**
 * Normalized media fingerprint: combines perceptual hash with a coarse
 * brightness signature so different photos rarely collide.
 * Returns a string like "ph:<hash>".
 */
export function mediaFingerprint(phash) {
  return `ph:${phash}`;
}
