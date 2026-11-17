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
    artwork: raw.artwork || raw.poster || raw.backdrop || raw.thumbnailUrl || raw.thumb || null,
    sourceRef: raw.sourceRef || null, mediaType: raw.mediaType || 'audio',
    availability: raw.availability || 'unresolved',
    capabilities: { stream: false, download: false, seek: provider === 'movie', video: provider === 'movie', ...raw.capabilities },
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
export function stripRemotePhotoBlocks(rich) {
  if (!rich || !Array.isArray(rich.blocks)) return null;
  const filtered = rich.blocks.filter((b) => {
    if (b?.type !== 'photo') return true;
    const ref = String(b.photo?.media || b.photo?.url || b.url || b.media || '');
    return !/^https?:\/\//i.test(ref);
  });
  return filtered.length < rich.blocks.length ? { ...rich, blocks: filtered } : null;
}
export function isRemotePhotoError(err) {
  return /wrong type of the web page|failed to get http url|photo_invalid|webpage_curl|wrong file identifier|media_empty|invalid file id|photo_ext_invalid|there is no text in the message/i.test(
    String(err?.description || err?.message || '')
  );
}
export function hasRichPhotoPayload(rich) {
  if (!rich || typeof rich !== 'object') return false;
  if (rich.photo) return true;
  return Array.isArray(rich.blocks) && rich.blocks.some((b) => b?.type === 'photo' || b?.type === 'slideshow' || b?.type === 'collage');
}
export function extractRichPhotoUrl(rich) {
  if (!rich || !Array.isArray(rich.blocks)) return null;
  for (const b of rich.blocks) {
    if (b?.type !== 'photo') continue;
    const ref = String(b.photo?.media || b.photo?.url || b.url || b.media || '');
    if (/^https?:\/\//i.test(ref)) return ref;
  }
  return null;
}
export function replaceRichPhotoMedia(rich, replacementMedia) {
  if (!rich || !Array.isArray(rich.blocks) || !replacementMedia) return rich;
  let replaced = false;
  const nextBlocks = rich.blocks.map((b) => {
    if (!replaced && b?.type === 'photo') {
      const ref = String(b.photo?.media || b.photo?.url || b.url || b.media || '');
      if (/^https?:\/\//i.test(ref)) {
        replaced = true;
        return { ...b, photo: { ...(typeof b.photo === 'object' && b.photo ? b.photo : { type: 'photo' }), type: 'photo', media: replacementMedia } };
      }
    }
    return b;
  });
  return replaced ? { ...rich, blocks: nextBlocks } : rich;
}
export function extractSentPhotoFileId(sent) {
  if (!sent || typeof sent !== 'object') return null;
  if (Array.isArray(sent.photo) && sent.photo.length) {
    return sent.photo[sent.photo.length - 1]?.file_id || null;
  }
  const blocks = sent.rich_message?.blocks;
  if (Array.isArray(blocks)) {
    for (const b of blocks) {
      if (b?.type === 'photo') {
        const fid = b.photo?.file_id || (typeof b.photo?.media === 'string' && !/^https?:|^attach:/i.test(b.photo.media) ? b.photo.media : null);
        if (fid) return fid;
      }
    }
  }
  return null;
}
async function downloadRemotePhotoAsJpeg(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LancyBot/10.3)', Accept: 'image/*,*/*;q=0.8' },
    signal: AbortSignal.timeout(6000)
  });
  if (!res?.ok) return null;
  const arr = new Uint8Array(await res.arrayBuffer());
  if (!arr.length || arr.length > 5 * 1024 * 1024) return null;
  let buf = Buffer.from(arr);
  let ct = String(res.headers.get('content-type') || '').toLowerCase();
  const isWebp = /webp/.test(ct) || (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP');
  if (isWebp) {
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const { writeFile, readFile, unlink } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');
      const uid = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const inP = join(tmpdir(), `lancy-img-${uid}.webp`);
      const outP = join(tmpdir(), `lancy-img-${uid}.jpg`);
      await writeFile(inP, buf);
      try {
        await promisify(execFile)('/usr/bin/ffmpeg', ['-y', '-loglevel', 'error', '-i', inP, '-vframes', '1', '-q:v', '3', outP], { timeout: 5000 });
        buf = await readFile(outP);
        ct = 'image/jpeg';
      } finally {
        await Promise.allSettled([unlink(inP), unlink(outP)]);
      }
    } catch {}
  }
  const ext = /png/.test(ct) ? 'png' : (/webp/.test(ct) ? 'webp' : 'jpg');
  return { buffer: buf, filename: `artwork.${ext}`, contentType: ct && ct.startsWith('image/') ? ct : 'image/jpeg' };
}
export async function sendRichWithPhotoFallback(api, chatId, rich, extra = {}, files = null) {
  try {
    const sent = await api.sendRichMessage(chatId, rich, extra, files);
    return { sent, hasPhoto: hasRichPhotoPayload(rich) };
  } catch (err) {
    if (files || !hasRichPhotoPayload(rich) || !isRemotePhotoError(err)) throw err;
    const blocks = Array.isArray(rich.blocks) ? rich.blocks : [];
    const idx = blocks.findIndex((b) => b?.type === 'photo' && /^https?:\/\//i.test(String(b.photo?.media || b.photo?.url || b.url || b.media || '')));
    if (idx >= 0) {
      const targetBlock = blocks[idx];
      const url = String(targetBlock.photo?.media || targetBlock.photo?.url || targetBlock.url || targetBlock.media || '');
      const uploaded = await downloadRemotePhotoAsJpeg(url).catch(() => null);
      if (uploaded?.buffer?.length) {
        const nextBlocks = blocks.map((b, i) => (
          i === idx
            ? { ...b, photo: { ...(typeof b.photo === 'object' && b.photo ? b.photo : { type: 'photo' }), type: 'photo', media: 'attach://artwork_photo' } }
            : b
        ));
        try {
          const sent = await api.sendRichMessage(chatId, { ...rich, blocks: nextBlocks }, extra, { artwork_photo: uploaded });
          return { sent, hasPhoto: true };
        } catch {}
      }
    }
    const noPhoto = stripRemotePhotoBlocks(rich);
    if (!noPhoto) throw err;
    const sent = await api.sendRichMessage(chatId, noPhoto, extra);
    return { sent, hasPhoto: false };
  }
}
