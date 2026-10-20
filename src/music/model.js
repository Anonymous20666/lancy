import { createHash, randomUUID } from 'node:crypto';

/** Canonical track. Capabilities are false until an adapter verifies them. */
export function normalizeTrack(raw, provider = raw.provider || 'legacy') {
  const providerId = String(raw.providerId || raw.videoId || raw.id || createHash('sha256').update(String(raw.sourceRef || raw.streamUrl || raw.filePath || raw.title)).digest('hex').slice(0, 20));
  let durationSeconds = Number(raw.durationSeconds ?? raw.duration);
  if (typeof raw.duration === 'string' && /^\d+:\d+(?::\d+)?$/.test(raw.duration)) durationSeconds = raw.duration.split(':').reduce((n, p) => n * 60 + Number(p), 0);
  return {
    ...raw, id: `${provider}:${providerId}`, provider, providerId,
    title: String(raw.title || 'Untitled').slice(0, 240),
    artist: raw.artist || raw.author || null, album: raw.album || null,
    durationSeconds: Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : null,
    artwork: raw.artwork || raw.thumb || null,
    sourceRef: raw.sourceRef || null, mediaType: raw.mediaType || 'audio',
    availability: raw.availability || 'unresolved',
    capabilities: { stream: false, download: false, seek: false, video: false, ...raw.capabilities },
  };
}
export function queueEntry(track) { return { ...normalizeTrack(track), entryId: randomUUID() }; }
export function durationText(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.floor(seconds); return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
export { KeyedLock } from '../utils/asyncLock.js';
export class MusicError extends Error {
  constructor(code, message) { super(message); this.name = 'MusicError'; this.code = code; }
}
