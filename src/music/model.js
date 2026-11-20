import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';

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
  let strippedAny = false;
  const filtered = [];
  for (const b of rich.blocks) {
    if (b?.type === 'photo') {
      const ref = String(b.photo?.media || b.photo?.url || b.url || b.media || '');
      if (/^https?:\/\//i.test(ref)) {
        strippedAny = true;
        continue;
      }
    }
    if ((b?.type === 'slideshow' || b?.type === 'collage') && Array.isArray(b.blocks)) {
      const inner = b.blocks.filter((sb) => {
        if (sb?.type !== 'photo') return true;
        const ref = String(sb.photo?.media || sb.photo?.url || sb.url || sb.media || '');
        if (/^https?:\/\//i.test(ref)) {
          strippedAny = true;
          return false;
        }
        return true;
      });
      if (inner.length === 0) {
        strippedAny = true;
        continue;
      }
      if (inner.length < b.blocks.length) {
        filtered.push({ ...b, blocks: inner });
        continue;
      }
    }
    filtered.push(b);
  }
  return strippedAny ? { ...rich, blocks: filtered } : null;
}
export function stripRichVideoBlocks(rich) {
  if (!rich || !Array.isArray(rich.blocks)) return null;
  const filtered = rich.blocks.filter((b) => b?.type !== 'video' && b?.type !== 'animation');
  return filtered.length < rich.blocks.length ? { ...rich, blocks: filtered } : null;
}
export function stripAllMediaBlocks(rich) {
  if (!rich || !Array.isArray(rich.blocks)) return null;
  const filtered = rich.blocks.filter((b) => !['photo', 'video', 'animation', 'audio', 'document', 'slideshow', 'collage'].includes(b?.type));
  return filtered.length < rich.blocks.length ? { ...rich, blocks: filtered } : null;
}
export function isRemotePhotoError(err) {
  return /wrong type of the web page|failed to get http url|photo_invalid|webpage_curl|webpage_media_empty|wrong file identifier|media_empty|invalid file id|wrong_file_id|photo_ext_invalid|image_process_failed|media_invalid|file_reference|photo_save_file_invalid|there is no text in the message|file_parts_invalid|wrong parameter|media_caption_too_long/i.test(
    String(err?.description || err?.message || '')
  );
}
export function hasRichPhotoPayload(rich) {
  if (!rich || typeof rich !== 'object') return false;
  if (rich.photo) return true;
  return Array.isArray(rich.blocks) && rich.blocks.some((b) => b?.type === 'photo' || b?.type === 'slideshow' || b?.type === 'collage');
}
export function hasRichVideoPayload(rich) {
  if (!rich || typeof rich !== 'object') return false;
  if (rich.video || rich.animation) return true;
  if (!Array.isArray(rich.blocks)) return false;
  return rich.blocks.some((b) => (
    b?.type === 'video'
    || b?.type === 'animation'
    || ((b?.type === 'slideshow' || b?.type === 'collage') && Array.isArray(b.blocks) && b.blocks.some((sb) => sb?.type === 'video' || sb?.type === 'animation'))
  ));
}
export function hasRichMediaPayload(rich) {
  if (!rich || typeof rich !== 'object') return false;
  return hasRichPhotoPayload(rich) || hasRichVideoPayload(rich) || Boolean(
    Array.isArray(rich.blocks) && rich.blocks.some((b) => ['audio', 'document'].includes(b?.type))
  );
}
export function didEditStripMedia(origRich, editedMsg) {
  if (!origRich || !editedMsg || typeof editedMsg !== 'object') return false;
  const blocks = editedMsg.rich_message?.blocks;
  if (!Array.isArray(blocks)) return false; // Minimal mocks without rich_message are treated as ok
  const wantedPhoto = hasRichPhotoPayload(origRich);
  const wantedVideo = hasRichVideoPayload(origRich);
  const wantedAudio = Array.isArray(origRich.blocks) && origRich.blocks.some((b) => b?.type === 'audio');
  const gotPhoto = Boolean(editedMsg.photo || blocks.some((b) => ['photo', 'slideshow', 'collage'].includes(b?.type)));
  const gotVideo = Boolean(editedMsg.video || editedMsg.animation || blocks.some((b) => (
    b?.type === 'video'
    || b?.type === 'animation'
    || ((b?.type === 'slideshow' || b?.type === 'collage') && Array.isArray(b.blocks) && b.blocks.some((sb) => sb?.type === 'video' || sb?.type === 'animation'))
  )));
  const gotAudio = Boolean(editedMsg.audio || blocks.some((b) => b?.type === 'audio'));
  if (wantedPhoto && !gotPhoto) return true;
  if (wantedVideo && !gotVideo) return true;
  if (wantedAudio && !gotAudio) return true;
  return false;
}
export function hasRichCustomEmoji(rich) {
  if (!rich || typeof rich !== 'object') return false;
  const walk = (node, depth = 0) => {
    if (!node || depth > 12) return false;
    if (Array.isArray(node)) {
      for (const item of node) {
        if (walk(item, depth + 1)) return true;
      }
      return false;
    }
    if (typeof node !== 'object') return false;
    if (node.type === 'custom_emoji' && node.custom_emoji_id) return true;
    if (node.icon_custom_emoji_id) return true;
    for (const key of Object.keys(node)) {
      const val = node[key];
      if (val && typeof val === 'object' && walk(val, depth + 1)) return true;
    }
    return false;
  };
  return Array.isArray(rich.blocks) ? walk(rich.blocks, 0) : walk(rich, 0);
}
export function didEditStripCustomEmojis(origRich, editedMsg) {
  if (!origRich || !editedMsg || typeof editedMsg !== 'object') return false;
  if (!hasRichCustomEmoji(origRich)) return false;
  const hasInspectablePayload = Boolean(
    Array.isArray(editedMsg.rich_message?.blocks)
    || typeof editedMsg.text === 'string'
    || typeof editedMsg.caption === 'string'
    || Array.isArray(editedMsg.entities)
    || Array.isArray(editedMsg.caption_entities)
  );
  if (!hasInspectablePayload) return false;
  const survivedRich = hasRichCustomEmoji(editedMsg.rich_message);
  const survivedEntities = Array.isArray(editedMsg.entities)
    && editedMsg.entities.some((e) => e?.type === 'custom_emoji' && e?.custom_emoji_id);
  const survivedCaptionEntities = Array.isArray(editedMsg.caption_entities)
    && editedMsg.caption_entities.some((e) => e?.type === 'custom_emoji' && e?.custom_emoji_id);
  return !(survivedRich || survivedEntities || survivedCaptionEntities);
}
export function extractRichPhotoUrl(rich) {
  if (!rich || !Array.isArray(rich.blocks)) return null;
  for (const b of rich.blocks) {
    if (b?.type === 'photo') {
      const ref = String(b.photo?.media || b.photo?.url || b.url || b.media || '');
      if (/^https?:\/\//i.test(ref)) return ref;
    }
    if ((b?.type === 'slideshow' || b?.type === 'collage') && Array.isArray(b.blocks)) {
      for (const sb of b.blocks) {
        if (sb?.type !== 'photo') continue;
        const ref = String(sb.photo?.media || sb.photo?.url || sb.url || sb.media || '');
        if (/^https?:\/\//i.test(ref)) return ref;
      }
    }
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
  const pickFromBlock = (b) => {
    if (!b || typeof b !== 'object') return null;
    if (b.type === 'photo') {
      if (Array.isArray(b.photo) && b.photo.length) {
        return b.photo[b.photo.length - 1]?.file_id || null;
      }
      if (Array.isArray(b.photo?.photo) && b.photo.photo.length) {
        return b.photo.photo[b.photo.photo.length - 1]?.file_id || null;
      }
      const fid = b.photo?.file_id
        || b.photo?.photo?.file_id
        || b.file_id
        || (typeof b.photo?.media === 'string' && !/^https?:|^attach:/i.test(b.photo.media) ? b.photo.media : null);
      if (fid) return fid;
    }
    if ((b.type === 'slideshow' || b.type === 'collage') && Array.isArray(b.blocks)) {
      for (const inner of b.blocks) {
        const fid = pickFromBlock(inner);
        if (fid) return fid;
      }
    }
    return null;
  };
  const blocks = sent.rich_message?.blocks;
  if (Array.isArray(blocks)) {
    for (const b of blocks) {
      const fid = pickFromBlock(b);
      if (fid) return fid;
    }
  }
  return null;
}
export function extractSentVideoFileId(sent) {
  if (!sent || typeof sent !== 'object') return null;
  if (sent.video?.file_id) return sent.video.file_id;
  if (sent.animation?.file_id) return sent.animation.file_id;
  const blocks = sent.rich_message?.blocks;
  if (Array.isArray(blocks)) {
    for (const b of blocks) {
      if (b?.type === 'video' || b?.type === 'animation') {
        const mediaObj = b.video || b.animation;
        const fid = mediaObj?.file_id
          || mediaObj?.video?.file_id
          || (typeof mediaObj?.media === 'string' && !/^https?:|^attach:/i.test(mediaObj.media) ? mediaObj.media : null);
        if (fid) return fid;
      }
    }
  }
  return null;
}

const PREVIEW_JPEG_CACHE = new Map();
function expandPhotoCandidateUrls(primaryUrl, fallbackUrls = []) {
  const candidates = [];
  const push = (u) => {
    const s = String(u || '').trim();
    if (/^https?:\/\//i.test(s) && !candidates.includes(s)) candidates.push(s);
  };
  push(primaryUrl);
  const ytMatch = String(primaryUrl || '').match(/^https?:\/\/i\.ytimg\.com\/vi(?:_webp)?\/([A-Za-z0-9_-]{11})\/(maxresdefault|sddefault|hq720|hqdefault|mqdefault)\.(?:jpg|webp)/i);
  if (ytMatch) {
    const vid = ytMatch[1];
    push(`https://i.ytimg.com/vi/${vid}/hq720.jpg`);
    push(`https://i.ytimg.com/vi/${vid}/hqdefault.jpg`);
    push(`https://i.ytimg.com/vi/${vid}/mqdefault.jpg`);
  }
  for (const fb of (Array.isArray(fallbackUrls) ? fallbackUrls : [])) {
    push(fb);
  }
  return candidates;
}

export async function downloadRemotePhotoAsJpeg(url, { fallbackUrls = [], headers = null } = {}) {
  const candidates = expandPhotoCandidateUrls(url, fallbackUrls);
  const now = Date.now();
  for (const cand of candidates) {
    const hit = PREVIEW_JPEG_CACHE.get(cand);
    if (hit && hit.expiresAt > now && hit.buffer?.length) {
      return { buffer: hit.buffer, filename: 'artwork.jpg', contentType: 'image/jpeg' };
    }
    try {
      const res = await fetch(cand, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          ...(headers || {})
        },
        signal: AbortSignal.timeout(7000)
      });
      if (!res?.ok) continue;
      const arr = new Uint8Array(await res.arrayBuffer());
      if (!arr.length || arr.length > 10 * 1024 * 1024) continue;
      const rawBuf = Buffer.from(arr);
      const meta = await sharp(rawBuf, { failOn: 'none', animated: false }).metadata();
      const width = Number(meta?.width || 0);
      const height = Number(meta?.height || 0);
      if (width < 8 || height < 8) continue;
      const aspectRatio = width / height;
      let pipeline = sharp(rawBuf, { failOn: 'none', animated: false }).rotate();
      if (aspectRatio > 8 || aspectRatio < 1 / 8) {
        const targetW = Math.min(1280, Math.max(320, width));
        const targetH = Math.min(1280, Math.max(320, Math.round(targetW / Math.max(0.25, Math.min(4, aspectRatio)))));
        pipeline = pipeline.resize(targetW, targetH, { fit: 'contain', background: '#0b1021' });
      } else {
        pipeline = pipeline.resize(1280, 1280, { fit: 'inside', withoutEnlargement: true });
      }
      const norm = await pipeline
        .toColorspace('srgb')
        .flatten({ background: '#0b1021' })
        .jpeg({ quality: 88, mozjpeg: false })
        .toBuffer();
      if (!norm.length) continue;
      PREVIEW_JPEG_CACHE.set(cand, { buffer: norm, expiresAt: now + 600_000 });
      if (PREVIEW_JPEG_CACHE.size > 80) {
        const oldestKey = PREVIEW_JPEG_CACHE.keys().next().value;
        if (oldestKey) PREVIEW_JPEG_CACHE.delete(oldestKey);
      }
      return { buffer: norm, filename: 'artwork.jpg', contentType: 'image/jpeg' };
    } catch {}
  }
  return null;
}

export async function sendRichWithPhotoFallback(api, chatId, rich, extra = {}, files = null, { fallbackArtworkUrls = [], headers = null } = {}) {
  try {
    const sent = await api.sendRichMessage(chatId, rich, extra, files);
    return { sent, hasPhoto: hasRichPhotoPayload(rich), hasVideo: hasRichVideoPayload(rich) };
  } catch (err) {
    if (!hasRichMediaPayload(rich) && !files) throw err;
    const isMediaErr = isRemotePhotoError(err) || /video|animation|file|media|photo|document/i.test(String(err?.description || err?.message || ''));
    if (!isMediaErr) throw err;

    let workRich = rich;
    let workFiles = files ? { ...files } : null;

    // 1. Try downloading remote HTTP photo(s) as Telegram-safe RGB JPEG attachments (while preserving existing files!)
    const blocks = Array.isArray(workRich.blocks) ? workRich.blocks : [];
    const idx = blocks.findIndex((b) => b?.type === 'photo' && /^https?:\/\//i.test(String(b.photo?.media || b.photo?.url || b.url || b.media || '')));
    if (idx >= 0) {
      const targetBlock = blocks[idx];
      const url = String(targetBlock.photo?.media || targetBlock.photo?.url || targetBlock.url || targetBlock.media || '');
      const uploaded = await downloadRemotePhotoAsJpeg(url, { fallbackUrls: fallbackArtworkUrls, headers }).catch(() => null);
      if (uploaded?.buffer?.length) {
        const nextBlocks = blocks.map((b, i) => (
          i === idx
            ? { ...b, photo: { ...(typeof b.photo === 'object' && b.photo ? b.photo : { type: 'photo' }), type: 'photo', media: 'attach://artwork_photo' } }
            : b
        ));
        workRich = { ...workRich, blocks: nextBlocks };
        workFiles = workFiles ? { ...workFiles, artwork_photo: uploaded } : { artwork_photo: uploaded };
        try {
          const sent = await api.sendRichMessage(chatId, workRich, extra, workFiles);
          return { sent, hasPhoto: true, hasVideo: hasRichVideoPayload(workRich) };
        } catch {}
      }
    }

    // 2. If a combined trailer/video + photo card failed on the video block, preserve the photo card without video!
    if (hasRichVideoPayload(workRich)) {
      const noVideoRich = stripRichVideoBlocks(workRich);
      if (noVideoRich) {
        const filesWithoutVideo = workFiles ? { ...workFiles } : null;
        if (filesWithoutVideo) {
          delete filesWithoutVideo.trailer_video;
          for (const k of Object.keys(filesWithoutVideo)) {
            if (/video/i.test(k) && JSON.stringify(noVideoRich).indexOf(`attach://${k}`) === -1) {
              delete filesWithoutVideo[k];
            }
          }
        }
        const safeFiles = filesWithoutVideo && Object.keys(filesWithoutVideo).length ? filesWithoutVideo : null;
        try {
          const sent = await api.sendRichMessage(chatId, noVideoRich, extra, safeFiles);
          return { sent, hasPhoto: hasRichPhotoPayload(noVideoRich), hasVideo: false };
        } catch {}
      }
    }

    // 3. Final safety net: strip remote photo URLs (or unrenderable media) so the interactive card still delivers cleanly.
    const noPhoto = stripRemotePhotoBlocks(workRich);
    if (noPhoto) {
      try {
        const sent = await api.sendRichMessage(chatId, noPhoto, extra, files);
        return { sent, hasPhoto: false, hasVideo: hasRichVideoPayload(noPhoto) };
      } catch {}
    }

    const noMedia = stripAllMediaBlocks(rich);
    if (noMedia) {
      const sent = await api.sendRichMessage(chatId, noMedia, extra, null);
      return { sent, hasPhoto: false, hasVideo: false };
    }
    throw err;
  }
}

export async function editOrSendRichWithFallback(api, chatId, targetMsgId, rich, extra = {}, files = null, { deleteReplaced = true, fallbackArtworkUrls = [], headers = null, preserveCustomEmojis = true } = {}) {
  const sendExtra = extra && typeof extra === 'object' ? { ...extra } : {};
  const {
    reply_parameters: _rp,
    reply_to_message_id: _rtmi,
    allow_sending_without_reply: _aswr,
    ...editExtra
  } = sendExtra;
  const wantMedia = hasRichMediaPayload(rich);
  let lastEditErr = null;

  if (targetMsgId && typeof api?.editMessageRich === 'function') {
    try {
      const edited = await api.editMessageRich(chatId, targetMsgId, rich, editExtra, files);
      if (wantMedia && didEditStripMedia(rich, edited)) {
        throw Object.assign(new Error('Telegram editMessageText stripped media blocks from preview card'), { code: 'MEDIA_STRIPPED_ON_EDIT' });
      }
      if (preserveCustomEmojis && Number(chatId) < 0 && didEditStripCustomEmojis(rich, edited)) {
        throw Object.assign(new Error('Telegram editMessageText stripped custom emojis from rich card'), { code: 'CUSTOM_EMOJI_STRIPPED_ON_EDIT' });
      }
      return {
        sent: edited?.message_id ? edited : { message_id: targetMsgId, ...(edited || {}) },
        edited: true,
        didReplace: false,
        hasPhoto: hasRichPhotoPayload(rich),
        hasVideo: hasRichVideoPayload(rich)
      };
    } catch (err) {
      const desc = String(err?.description || err?.message || '');
      if (/message is not modified/i.test(desc)) {
        return {
          sent: { message_id: targetMsgId },
          edited: true,
          didReplace: false,
          hasPhoto: hasRichPhotoPayload(rich),
          hasVideo: hasRichVideoPayload(rich)
        };
      }
      lastEditErr = err;
    }
  }

  // Fallback to fresh sendRichWithPhotoFallback (cleanly upgrades text->photo, photo->video, normalizes remote artwork, or restores stripped custom emojis)
  if (typeof api?.sendRichMessage === 'function') {
    const fallbackSendExtra = { ...sendExtra };
    if (Number(chatId) < 0 && !fallbackSendExtra.reply_parameters) {
      const anchor = Number(fallbackSendExtra.reply_to_message_id || targetMsgId || 0) || null;
      if (anchor) {
        fallbackSendExtra.reply_parameters = { message_id: anchor, allow_sending_without_reply: true };
      }
    }
    delete fallbackSendExtra.reply_to_message_id;
    delete fallbackSendExtra.allow_sending_without_reply;
    const out = await sendRichWithPhotoFallback(api, chatId, rich, fallbackSendExtra, files, { fallbackArtworkUrls, headers });
    const sentId = out?.sent?.message_id || null;
    if (deleteReplaced && targetMsgId && sentId && Number(sentId) !== Number(targetMsgId) && typeof api?.deleteMessage === 'function') {
      await api.deleteMessage(chatId, targetMsgId).catch(() => {});
    }
    return {
      sent: out.sent,
      edited: false,
      didReplace: Boolean(sentId),
      hasPhoto: Boolean(out.hasPhoto),
      hasVideo: Boolean(out.hasVideo)
    };
  }

  if (lastEditErr) throw lastEditErr;
  return { sent: null, edited: false, didReplace: false, hasPhoto: false, hasVideo: false };
}
