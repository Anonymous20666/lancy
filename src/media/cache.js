import { existsSync, mkdirSync, statSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir } from '../utils/paths.js';
import { sha256Hex } from '../utils/hash.js';

/**
 * Content-addressed media cache. Files are stored by SHA-256, so the same
 * media is downloaded/processed once no matter how many URLs point to it.
 */
export class MediaCache {
  constructor(root) {
    this.root = ensureDir(root);
    this.metaFile = join(this.root, 'index.json');
    this.index = this.#loadIndex();
  }

  #loadIndex() {
    try {
      if (existsSync(this.metaFile)) return JSON.parse(readFileSync(this.metaFile, 'utf8'));
    } catch { /* rebuild */ }
    return {};
  }

  #saveIndex() {
    writeFileSync(this.metaFile, JSON.stringify(this.index));
  }

  pathFor(sha256) {
    return join(this.root, sha256.slice(0, 2), sha256.slice(2));
  }

  has(sha256) {
    return !!this.index[sha256] && existsSync(this.pathFor(sha256));
  }

  /** Store a buffer; returns its sha256. */
  store(buffer, meta = {}) {
    const sha = sha256Hex(buffer);
    const path = this.pathFor(sha);
    ensureDir(join(this.root, sha.slice(0, 2)));
    if (!existsSync(path)) writeFileSync(path, buffer);
    this.index[sha] = {
      ...(this.index[sha] ?? {}),
      ...meta,
      sha256: sha,
      size: buffer.length,
      storedAt: new Date().toISOString()
    };
    this.#saveIndex();
    return sha;
  }

  read(sha256) {
    const path = this.pathFor(sha256);
    if (!existsSync(path)) return null;
    this.index[sha256] = { ...(this.index[sha256] ?? {}), lastReadAt: new Date().toISOString(), sha256 };
    this.#saveIndex();
    return readFileSync(path);
  }

  meta(sha256) {
    return this.index[sha256] ?? null;
  }

  pin(sha256) {
    if (this.index[sha256]) {
      this.index[sha256].pinned = true;
      this.#saveIndex();
    }
  }

  unpin(sha256) {
    if (this.index[sha256]) {
      this.index[sha256].pinned = false;
      this.#saveIndex();
    }
  }

  /** Remove entries older than ttlMinutes that are not pinned. */
  cleanup(ttlMinutes = 1440) {
    const cutoff = Date.now() - ttlMinutes * 60 * 1000;
    let removed = 0;
    for (const [sha, entry] of Object.entries(this.index)) {
      const ts = Date.parse(entry.storedAt ?? 0);
      if (!entry.pinned && ts < cutoff) {
        const path = this.pathFor(sha);
        rmSync(path, { force: true });
        delete this.index[sha];
        removed++;
      }
    }
    if (removed) this.#saveIndex();
    return removed;
  }

  stats() {
    const files = this.#allFiles();
    const totalBytes = files.reduce((sum, f) => {
      try { return sum + statSync(join(this.root, f)).size; } catch { return sum; }
    }, 0);
    return { entries: Object.keys(this.index).length, files: files.length, totalBytes };
  }

  #allFiles() {
    try {
      return readdirSync(this.root, { recursive: true }).filter((f) => String(f) !== 'index.json');
    } catch {
      return [];
    }
  }
}
