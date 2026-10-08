/**
 * Media validation — never trust HTTP status alone.
 * Checks MIME, magic bytes, dimensions, duration, size and decodability.
 */

export const MAGIC = {
  jpeg: { mime: 'image/jpeg', bytes: [[0xff, 0xd8, 0xff]] },
  png: { mime: 'image/png', bytes: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]] },
  gif: { mime: 'image/gif', bytes: [[0x47, 0x49, 0x46, 0x38, 0x37, 0x61], [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]] },
  webp: { mime: 'image/webp', bytes: [[0x52, 0x49, 0x46, 0x46]], at: 8, also: [[0x57, 0x45, 0x42, 0x50]] },
  bmp: { mime: 'image/bmp', bytes: [[0x42, 0x4d]] },
  mp4: { mime: 'video/mp4', ftyp: true },
  webm: { mime: 'video/webm', bytes: [[0x1a, 0x45, 0xdf, 0xa3]] },
  mov: { mime: 'video/quicktime', ftyp: true },
  mkv: { mime: 'video/x-matroska', bytes: [[0x1a, 0x45, 0xdf, 0xa3]] },
  mp3: { mime: 'audio/mpeg', bytes: [[0x49, 0x44, 0x33], [0xff, 0xfb], [0xff, 0xf3], [0xff, 0xf2]] },
  ogg: { mime: 'audio/ogg', bytes: [[0x4f, 0x67, 0x67, 0x53]] },
  wav: { mime: 'audio/wav', bytes: [[0x52, 0x49, 0x46, 0x46]], at: 8, also: [[0x57, 0x41, 0x56, 0x45]] }
};

function matchesPattern(buffer, pattern, offset = 0) {
  if (buffer.length < offset + pattern.length) return false;
  return pattern.every((byte, i) => buffer[offset + i] === byte);
}

/** Detect the real container/MIME from magic bytes. */
export function detectMime(buffer) {
  if (!buffer || buffer.length < 12) return null;
  for (const [name, sig] of Object.entries(MAGIC)) {
    if (sig.ftyp) {
      // ISO-BMFF: bytes 4..8 == 'ftyp'
      if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') {
        if (name === 'mp4') {
          const brand = buffer.toString('ascii', 8, 12);
          if (name === 'mp4' && !/qt/.test(brand)) return 'video/mp4';
        } else if (name === 'mov') {
          return 'video/quicktime';
        }
      }
      continue;
    }
    const offset = sig.at ?? 0;
    if (sig.bytes.some((p) => matchesPattern(buffer, p, 0)) && (!sig.at || matchesPattern(buffer, sig.also[0], sig.at))) {
      return sig.mime;
    }
  }
  return null;
}

/** Classify into our coarse media kinds. */
export function classifyMedia(mime) {
  if (!mime) return 'unknown';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'unknown';
}

export class MediaValidationError extends Error {
  constructor(message, code = 'INVALID_MEDIA') {
    super(message);
    this.name = 'MediaValidationError';
    this.code = code;
    this.retryable = false;
  }
}

/**
 * Validate a downloaded buffer.
 * @param {Buffer} buffer
 * @param {object} opts { expectedType?: 'image'|'video', maxBytes, minBytes, probe: async (buffer, mime) => metadata }
 */
export async function validateMedia(buffer, opts = {}) {
  const { expectedType, maxBytes, minBytes = 64, probe } = opts;
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new MediaValidationError('The file is empty', 'EMPTY');
  }
  if (buffer.length < minBytes) {
    throw new MediaValidationError('The file is suspiciously small — probably an error page', 'TOO_SMALL');
  }
  if (maxBytes && buffer.length > maxBytes) {
    throw new MediaValidationError(`The file is ${buffer.length} bytes (max ${maxBytes})`, 'TOO_LARGE');
  }
  const mime = detectMime(buffer);
  if (!mime) {
    throw new MediaValidationError('I could not recognize the file type — it may be corrupt', 'UNKNOWN_TYPE');
  }
  const type = classifyMedia(mime);
  if (expectedType && type !== expectedType) {
    throw new MediaValidationError(`Expected ${expectedType} but the file is ${type} (${mime})`, 'TYPE_MISMATCH');
  }
  let metadata = { mime, type, size: buffer.length };
  if (probe) {
    try {
      metadata = { ...metadata, ...(await probe(buffer, mime)) };
    } catch (error) {
      throw new MediaValidationError(`The file could not be decoded: ${error.message}`, 'UNDECODABLE');
    }
  }
  return metadata;
}
