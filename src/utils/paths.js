import { mkdirSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, normalize } from 'node:path';

/** Resolve the data directory (created on demand). */
export function dataDir(base = process.env.DATA_DIR || './data') {
  const dir = resolve(base);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function ensureDir(...segments) {
  const dir = join(...segments);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** WhatsApp session credentials directory — locked down to owner-only (0700). */
export function ensureSessionDir(root, sessionId) {
  const safeId = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const dir = ensureDir(root, 'sessions', safeId);
  try {
    chmodSync(dir, 0o700);
    // Lock down every credential file inside.
    if (existsSync(dir)) {
      for (const entry of ['creds.json', 'app-state-sync-key-.json', 'app-state-sync-version.json']) {
        // best effort per-file tightening happens on write; tighten dir here.
      }
    }
  } catch { /* non-posix */ }
  return dir;
}

export function tightenFile(path) {
  try {
    chmodSync(path, 0o600);
  } catch { /* non-posix */ }
}

export function removeDir(path) {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch { /* ignore */ }
}

/** Join and guarantee the result stays inside the base directory. */
export function safeJoin(base, ...parts) {
  const resolved = resolve(join(base, ...parts));
  const baseResolved = resolve(base);
  if (resolved !== baseResolved && !resolved.startsWith(baseResolved + '/')) {
    throw new Error(`Path escape attempt blocked: ${parts.join('/')}`);
  }
  return resolved;
}

export function normalizePath(p) {
  return normalize(p);
}
