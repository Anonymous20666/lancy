import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { MusicError, KeyedLock } from './model.js';

// Accept only an audio reference, never a photo/video thumbnail's file_id.
export function audioFileId(message) {
  function audio(value) {
    if (!value || typeof value !== 'object') return null;
    if (typeof value.file_id === 'string') return value.file_id;
    if (typeof value.media === 'string' && /^[\w-]{10,1024}$/.test(value.media)) return value.media;
    return audio(value.audio) || audio(value.media) || audio(value.file);
  }
  if (message?.audio) { const id = audio(message.audio); if (id) return id; }
  function blocks(items) {
    if (!Array.isArray(items)) return null;
    for (const item of items || []) {
      if (item.type === 'audio') { const id = audio(item.audio || item); if (id) return id; }
      const nested = blocks(item.blocks || item.items);
      if (nested) return nested;
    }
    return null;
  }
  return blocks(message?.rich_message?.blocks);
}

export function audioInput(track, media) {
  return { media, title: track.title, ...(track.artist ? { performer: track.artist } : {}),
    ...(Number.isFinite(track.durationSeconds) ? { duration: Math.floor(track.durationSeconds) } : {}) };
}
export async function audioUpload(media) {
  const filename = `${String(media.track.title || 'track').replace(/[^\p{L}\p{N}\s._-]/gu, '').slice(0, 80) || 'track'}.mp3`;
  return { music_full_audio: { buffer: await readFile(media.filePath), filename, contentType: 'audio/mpeg' } };
}

/** Full recordings only. A Telegram audio widget also exposes a downloadable file,
 * so a streaming-only cache is NEVER used as an upload permission shortcut. */
export class FullTrackPreviews {
  constructor({ app, maxEntries = 100, ttlMs = 21600000, maxJobs = 2 }) {
    this.app = app; this.maxEntries = maxEntries; this.ttlMs = ttlMs;
    this.cache = new Map(); this.jobs = new Set(); this.pending = new Map(); this.maxJobs = maxJobs; this.closed = false;
    this.apiIds = new WeakMap(); this.uploads = new KeyedLock();
  }
  key(api, track) {
    if (!this.apiIds.has(api)) this.apiIds.set(api, randomUUID());
    return `${api.me?.id || this.apiIds.get(api)}:${track.id}`;
  }
  remember(api, track, fileId) {
    if (!fileId) return;
    for (const [key, value] of this.cache) if (Date.now() >= value.expires) this.cache.delete(key);
    const key = this.key(api, track); this.cache.delete(key);
    while (this.cache.size >= this.maxEntries) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(key, { fileId, expires: Date.now() + this.ttlMs });
  }
  cached(api, track) {
    const value = this.cache.get(this.key(api, track));
    return value && Date.now() < value.expires ? value.fileId : null;
  }
  current(s, request) {
    return !this.closed && !this.app.musicQueueManager?.closed && (!s.panelToken || s.panelActive) && s.fullPreview?.request === request &&
      s.fullPreview.trackId === s.currentTrack?.id && s.fullPreview.playbackId === s.playbackId && ['playing', 'paused'].includes(s.status);
  }
  schedule(s) {
    if (this.closed || this.app.musicQueueManager?.closed || !s.api || !s.screenMessageId ||
        s.view !== 'player' || !['playing', 'paused'].includes(s.status) || !s.currentTrack) return;
    const track = s.currentTrack;
    if (this.pending.has(s.chatId)) return;
    if (s.fullPreview?.trackId === track.id && s.fullPreview.playbackId === s.playbackId) return;
    const request = randomUUID();
    s.fullPreview = { request, trackId: track.id, playbackId: s.playbackId, status: 'pending' };
    if (!['youtube', 'audius'].includes(track.provider) || (track.provider === 'audius' && track.downloadable !== true)) {
      s.fullPreview.status = 'unavailable';
      s.fullPreview.reason = 'This source does not permit a full audio-file preview. Voice-chat streaming is separate.';
      return;
    }
    if (this.jobs.size >= this.maxJobs) {
      s.fullPreview.status = 'unavailable'; s.fullPreview.reason = 'Full preview is busy. Retry from More; VC playback is unaffected.'; return;
    }
    const job = this.load(s, track, request).catch(() => {}).finally(() => {
      this.jobs.delete(job); this.pending.delete(s.chatId);
      if (!this.closed && !this.app.musicQueueManager?.closed) void this.app.musicQueueManager.updatePlayerCard(s.chatId).catch(() => {});
    });
    this.pending.set(s.chatId, job); this.jobs.add(job);
  }
  async load(s, track, request) {
    let media;
    try {
      // Recheck download rights even if an audio file/file_id is already cached.
      media = await this.app.musicLibrary.acquire(track, { download: true });
      if (media.track.id !== track.id) throw new MusicError('TRACK_MISMATCH', 'The provider returned a different recording.');
      if (!this.current(s, request)) return;
      if (s.view !== 'player') { s.fullPreview = null; return; }
      await this.uploads.run(this.key(s.api, track), async () => {
        if (!this.current(s, request)) return;
        if (s.view !== 'player') { s.fullPreview = null; return; }
        const fileId = this.cached(s.api, track);
        if (fileId) s.fullPreview = { ...s.fullPreview, status: 'ready', fileId, track: media.track };
        else {
          const published = await this.app.musicQueueManager.updatePlayerCard(s.chatId, { preview: { request, media }, panelToken: s.panelToken || null });
          if (!published && this.current(s, request)) {
            if (s.view !== 'player') s.fullPreview = null;
            else s.fullPreview = { ...s.fullPreview, status: 'unavailable', reason: 'Full preview is temporarily unavailable. Retry from More; VC playback is unaffected.' };
          }
        }
      });
    } catch (error) {
      if (this.current(s, request)) {
        const wait=Number(error.parameters?.retry_after || error.retryAfter || 0);
        if(wait>0)s.editAfter=Date.now()+wait*1000;
        s.fullPreview = { ...s.fullPreview, status: 'unavailable', reason: error instanceof MusicError ? error.message : 'Full audio preview could not be prepared. VC playback is unaffected.' };
      }
    } finally {
      media?.release();
      if (this.current(s, request)) await this.app.musicQueueManager.updatePlayerCard(s.chatId).catch(() => {});
    }
  }
  async shutdown() { this.closed = true; await Promise.allSettled([...this.jobs]); this.cache.clear(); }
}
