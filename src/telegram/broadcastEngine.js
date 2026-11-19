import { RichMessageBuilder, rt, block, richButton, inlineKeyboard } from './rich.js';
import { enhanceHtmlWithCustomEmojis } from './customEmoji.js';
import { buildSystemShowcaseCard, buildShowcaseHtmlFallback } from './showcaseCard.js';
import { escapeHtml } from '../media/lyrics.js';
import { logger } from '../core/logger.js';

const log = logger().child({ module: 'broadcastEngine' });

/**
 * Normalize string to valid UTF-16 (replacing lone surrogates) and truncate safely by
 * Unicode code points so surrogate pairs (emojis, fancy script/math fonts) are never split.
 */
export function safeUtf8(str = '') {
  const s = String(str ?? '');
  return typeof s.toWellFormed === 'function' ? s.toWellFormed() : s;
}

export function safeTruncate(str = '', maxCodePoints = 30) {
  const clean = safeUtf8(str);
  const chars = [...clean];
  if (chars.length <= maxCodePoints) return clean;
  return chars.slice(0, maxCodePoints).join('');
}

/**
 * Convert plain text + Telegram UTF-16 `entities` into safe Telegram HTML,
 * preserving bold, italic, underline, strikethrough, spoilers, code blocks,
 * blockquotes, links, mentions, and custom emojis (`<tg-emoji>`).
 */
export function utf16EntitiesToHtml(text = '', entities = []) {
  const str = String(text || '');
  if (!str) return '';
  if (!Array.isArray(entities) || entities.length === 0) {
    return escapeHtml(str);
  }

  const eventsByPos = new Map();
  const pushAt = (pos, evt) => {
    const clamped = Math.max(0, Math.min(str.length, Number(pos) || 0));
    let arr = eventsByPos.get(clamped);
    if (!arr) {
      arr = [];
      eventsByPos.set(clamped, arr);
    }
    arr.push(evt);
  };

  entities.forEach((ent, idx) => {
    if (!ent || !Number.isFinite(ent.offset) || !Number.isFinite(ent.length) || ent.length <= 0) return;
    let open = '';
    let close = '';
    switch (ent.type) {
      case 'bold': open = '<b>'; close = '</b>'; break;
      case 'italic': open = '<i>'; close = '</i>'; break;
      case 'underline': open = '<u>'; close = '</u>'; break;
      case 'strikethrough': open = '<s>'; close = '</s>'; break;
      case 'spoiler': open = '<tg-spoiler>'; close = '</tg-spoiler>'; break;
      case 'code': open = '<code>'; close = '</code>'; break;
      case 'pre':
        open = ent.language
          ? `<pre><code class="language-${escapeHtml(String(ent.language))}">`
          : '<pre>';
        close = ent.language ? '</code></pre>' : '</pre>';
        break;
      case 'blockquote': open = '<blockquote>'; close = '</blockquote>'; break;
      case 'expandable_blockquote': open = '<blockquote expandable>'; close = '</blockquote>'; break;
      case 'text_link':
        if (ent.url) {
          open = `<a href="${escapeHtml(String(ent.url))}">`;
          close = '</a>';
        }
        break;
      case 'text_mention':
        if (ent.user?.id) {
          open = `<a href="tg://user?id=${Number(ent.user.id)}">`;
          close = '</a>';
        }
        break;
      case 'custom_emoji':
        if (ent.custom_emoji_id) {
          open = `<tg-emoji emoji-id="${escapeHtml(String(ent.custom_emoji_id))}">`;
          close = '</tg-emoji>';
        }
        break;
      default:
        break;
    }
    if (!open || !close) return;
    const start = ent.offset;
    const end = ent.offset + ent.length;
    pushAt(start, { kind: 'open', tag: open, len: ent.length, idx });
    pushAt(end, { kind: 'close', tag: close, len: ent.length, idx });
  });

  if (eventsByPos.size === 0) return escapeHtml(str);

  const positions = [...eventsByPos.keys()].sort((a, b) => a - b);
  let out = '';
  let cursor = 0;

  for (const pos of positions) {
    if (pos > cursor) {
      out += escapeHtml(str.slice(cursor, pos));
      cursor = pos;
    }
    const evts = eventsByPos.get(pos);
    // Close inner tags before outer tags; open outer tags before inner tags.
    const closes = evts.filter((e) => e.kind === 'close').sort((a, b) => a.len - b.len || b.idx - a.idx);
    const opens = evts.filter((e) => e.kind === 'open').sort((a, b) => b.len - a.len || a.idx - b.idx);
    for (const c of closes) out += c.tag;
    for (const o of opens) out += o.tag;
  }
  if (cursor < str.length) {
    out += escapeHtml(str.slice(cursor));
  }
  return out;
}

/**
 * Extract a structured broadcast item from any incoming Telegram message
 * (formatted text, photo, video, animation/GIF, audio, voice, document, sticker, or poll).
 */
export function extractBroadcastItemFromMessage(message, { sourceApi = null, sourceBotId = null } = {}) {
  if (!message || typeof message !== 'object') return null;

  const botIdStr = sourceBotId != null
    ? String(sourceBotId)
    : (sourceApi?.me?.id != null ? String(sourceApi.me.id) : null);

  const rawText = message.text ?? '';
  const rawCaption = message.caption ?? '';
  const textHtml = rawText ? utf16EntitiesToHtml(rawText, message.entities) : '';
  const captionHtml = rawCaption ? utf16EntitiesToHtml(rawCaption, message.caption_entities) : '';
  const mediaGroupId = message.media_group_id ? String(message.media_group_id) : null;

  const base = {
    sourceApi,
    sourceBotId: botIdStr,
    mediaGroupId,
    caption: rawCaption,
    captionHtml,
    captionEntities: Array.isArray(message.caption_entities) ? message.caption_entities : null
  };

  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1];
    return {
      ...base,
      kind: 'photo',
      fileId: largest.file_id,
      fileUniqueId: largest.file_unique_id || null,
      filename: 'photo.jpg',
      contentType: 'image/jpeg',
      width: largest.width,
      height: largest.height
    };
  }

  if (message.video?.file_id) {
    return {
      ...base,
      kind: 'video',
      fileId: message.video.file_id,
      fileUniqueId: message.video.file_unique_id || null,
      filename: message.video.file_name || 'video.mp4',
      contentType: message.video.mime_type || 'video/mp4',
      duration: message.video.duration,
      width: message.video.width,
      height: message.video.height
    };
  }

  if (message.animation?.file_id) {
    return {
      ...base,
      kind: 'animation',
      fileId: message.animation.file_id,
      fileUniqueId: message.animation.file_unique_id || null,
      filename: message.animation.file_name || 'animation.mp4',
      contentType: message.animation.mime_type || 'video/mp4',
      duration: message.animation.duration,
      width: message.animation.width,
      height: message.animation.height
    };
  }

  if (message.audio?.file_id) {
    return {
      ...base,
      kind: 'audio',
      fileId: message.audio.file_id,
      fileUniqueId: message.audio.file_unique_id || null,
      filename: message.audio.file_name || `${message.audio.title || 'audio'}.mp3`,
      contentType: message.audio.mime_type || 'audio/mpeg',
      duration: message.audio.duration,
      performer: message.audio.performer || null,
      title: message.audio.title || null
    };
  }

  if (message.voice?.file_id) {
    return {
      ...base,
      kind: 'voice',
      fileId: message.voice.file_id,
      fileUniqueId: message.voice.file_unique_id || null,
      filename: 'voice.ogg',
      contentType: message.voice.mime_type || 'audio/ogg',
      duration: message.voice.duration
    };
  }

  if (message.document?.file_id) {
    return {
      ...base,
      kind: 'document',
      fileId: message.document.file_id,
      fileUniqueId: message.document.file_unique_id || null,
      filename: message.document.file_name || 'file.bin',
      contentType: message.document.mime_type || 'application/octet-stream'
    };
  }

  if (message.sticker?.file_id) {
    return {
      ...base,
      kind: 'sticker',
      fileId: message.sticker.file_id,
      fileUniqueId: message.sticker.file_unique_id || null,
      emoji: message.sticker.emoji || '',
      isVideo: Boolean(message.sticker.is_video),
      isAnimated: Boolean(message.sticker.is_animated),
      filename: message.sticker.is_animated ? 'sticker.tgs' : (message.sticker.is_video ? 'sticker.webm' : 'sticker.webp'),
      contentType: message.sticker.is_animated ? 'application/x-tgsticker' : (message.sticker.is_video ? 'video/webm' : 'image/webp')
    };
  }

  if (message.poll?.question) {
    return {
      sourceApi,
      sourceBotId: botIdStr,
      kind: 'poll',
      question: message.poll.question,
      options: (message.poll.options || []).map((o) => o?.text || String(o)),
      isAnonymous: message.poll.is_anonymous !== false,
      allowsMultipleAnswers: Boolean(message.poll.allows_multiple_answers),
      pollType: message.poll.type || 'regular',
      correctOptionId: message.poll.correct_option_id,
      explanation: message.poll.explanation || null
    };
  }

  if (rawText.trim()) {
    return {
      sourceApi,
      sourceBotId: botIdStr,
      kind: 'text',
      text: rawText,
      html: textHtml,
      entities: Array.isArray(message.entities) ? message.entities : null
    };
  }

  return null;
}

/**
 * Parse custom button lines entered by a user:
 *   "Watch Now | https://t.me/mychannel"
 *   "Channel | https://t.me/a ; Group | https://t.me/b"  (multiple on same row)
 *   "Copy Promo | copy:SAVE20"
 *   "Share Inline | inline:showcase"
 */
export function parseBroadcastButtonLines(input = '') {
  const lines = String(input || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rows = [];
  for (const line of lines.slice(0, 6)) {
    const cols = line.split(/\s*[;|]\s*(?=[^|]*?(?:https?:\/\/|tg:\/\/|copy:|inline:|switch:))/i);
    // Fallback simple split by ';' when user puts 2 buttons per row separated by ';'
    const chunks = line.includes(';') ? line.split(';').map((s) => s.trim()).filter(Boolean) : [line];
    const row = [];
    for (const chunk of chunks.slice(0, 4)) {
      const m = chunk.match(/^(.+?)\s*(?:\||->|=>)\s*(.+)$/);
      if (!m) continue;
      const label = safeTruncate(m[1].trim(), 48);
      const target = m[2].trim();
      if (!label || !target) continue;
      if (/^copy:/i.test(target)) {
        const copyVal = target.replace(/^copy:/i, '').trim();
        if (copyVal) row.push({ label, kind: 'copy', value: copyVal });
      } else if (/^(?:inline|switch):/i.test(target)) {
        const qVal = target.replace(/^(?:inline|switch):/i, '').trim();
        row.push({ label, kind: 'inline', value: qVal });
      } else if (/^(?:https?:\/\/|tg:\/\/)/i.test(target)) {
        row.push({ label, kind: 'url', value: target });
      } else if (/^@[A-Za-z0-9_]{3,}/.test(target)) {
        row.push({ label, kind: 'url', value: `https://t.me/${target.replace(/^@/, '')}` });
      }
    }
    if (row.length) rows.push(row);
    void cols;
  }
  return rows;
}

export function materializeRichButtonRows(buttonRows = []) {
  if (!Array.isArray(buttonRows) || !buttonRows.length) return [];
  return buttonRows.map((row) =>
    (Array.isArray(row) ? row : []).map((b) => {
      if (b.kind === 'copy') return richButton.copy(b.label, b.value, { style: 'primary' });
      if (b.kind === 'inline') return richButton.switchInline(b.label, b.value, { style: 'primary' });
      return richButton.url(b.label, b.value, { style: 'success' });
    })
  ).filter((r) => r.length > 0);
}

export function materializeInlineKeyboardRows(buttonRows = []) {
  if (!Array.isArray(buttonRows) || !buttonRows.length) return null;
  const rows = buttonRows.map((row) =>
    (Array.isArray(row) ? row : []).map((b) => {
      if (b.kind === 'copy') return { text: b.label, copy_text: { text: b.value }, style: 'primary' };
      if (b.kind === 'inline') return { text: b.label, switch_inline_query: b.value, style: 'primary' };
      return { text: b.label, url: b.value, style: 'success' };
    })
  ).filter((r) => r.length > 0);
  return rows.length ? inlineKeyboard(rows) : null;
}

function getAlbumFamily(kind) {
  if (kind === 'photo' || kind === 'video') return 'visual';
  if (kind === 'audio') return 'audio';
  if (kind === 'document') return 'document';
  return null;
}

/**
 * Group adjacent compatible broadcast items into Telegram media-group batches (2..10 items)
 * or single messages, honoring Telegram's media_group type compatibility rules:
 * - visual (`photo` / `video`) can mix in 2..10 batches
 * - `audio` can batch only with `audio`
 * - `document` can batch only with `document`
 * - `text`, `animation`, `voice`, `sticker`, `poll` always send as standalone items
 */
export function groupBroadcastItems(items = []) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!list.length) return [];

  const batches = [];
  let currentGroup = [];
  let currentFamily = null;
  let currentGroupKey = null;

  const flushGroup = () => {
    if (!currentGroup.length) return;
    while (currentGroup.length > 0) {
      const slice = currentGroup.splice(0, 10);
      if (slice.length >= 2) {
        batches.push({ type: 'album', family: currentFamily, items: slice });
      } else {
        batches.push({ type: 'single', item: slice[0] });
      }
    }
    currentFamily = null;
    currentGroupKey = null;
  };

  for (const item of list) {
    const family = getAlbumFamily(item.kind);
    if (!family) {
      flushGroup();
      batches.push({ type: 'single', item });
      continue;
    }

    const itemGroupKey = item.mediaGroupId || `__auto_${family}`;
    const sameBatch = currentGroup.length > 0
      && currentFamily === family
      && (
        // Explicit different mediaGroupIds stay distinct albums; items without mediaGroupId merge with adjacent same-family items
        itemGroupKey === currentGroupKey
        || (!item.mediaGroupId && currentGroupKey === `__auto_${family}`)
      );

    if (!sameBatch) {
      flushGroup();
      currentFamily = family;
      currentGroupKey = itemGroupKey;
    }
    currentGroup.push(item);
  }
  flushGroup();

  return batches;
}

/**
 * Resolve a file buffer or native file_id for `targetBotId`.
 * When sending across different bots (Main <-> Clone), Telegram requires re-uploading the bytes
 * because `file_id` values are scoped per bot token. Downloaded buffers are shared in `bufferCache`.
 */
export async function resolveMediaPayload(item, { targetBotId = null, targetApi = null, bufferCache = new Map() } = {}) {
  if (!item) return null;
  if (Buffer.isBuffer(item.buffer)) {
    return {
      isBuffer: true,
      value: item.buffer,
      filename: item.filename || 'media.bin',
      contentType: item.contentType || 'application/octet-stream'
    };
  }

  const sameBot = item.sourceBotId != null && targetBotId != null && String(item.sourceBotId) === String(targetBotId);
  if (sameBot && item.fileId) {
    return { isBuffer: false, value: item.fileId };
  }

  if (item.fileId && bufferCache.has(item.fileId)) {
    const cached = bufferCache.get(item.fileId);
    return {
      isBuffer: true,
      value: cached,
      filename: item.filename || 'media.bin',
      contentType: item.contentType || 'application/octet-stream'
    };
  }

  const dlApi = item.sourceApi || targetApi;
  if (item.fileId && dlApi?.getFile && dlApi?.downloadFile) {
    const fileMeta = await dlApi.getFile(item.fileId);
    if (!fileMeta?.file_path) {
      throw new Error('Could not resolve source file path for cross-bot transfer');
    }
    const buf = await dlApi.downloadFile(fileMeta.file_path);
    if (Buffer.isBuffer(buf) && buf.length > 0) {
      bufferCache.set(item.fileId, buf);
      return {
        isBuffer: true,
        value: buf,
        filename: item.filename || 'media.bin',
        contentType: item.contentType || 'application/octet-stream'
      };
    }
  }

  if (item.fileId) {
    return { isBuffer: false, value: item.fileId };
  }
  throw new Error(`No media source available for ${item.kind}`);
}

async function withFloodRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    const retryAfter = Number(err?.parameters?.retry_after || 0);
    if (Number(err?.errorCode) === 429 && retryAfter > 0 && retryAfter <= 10) {
      await new Promise((r) => setTimeout(r, retryAfter * 1000 + 150));
      return await fn();
    }
    throw err;
  }
}

function maybeUpgradeCustomHtml(html, { autoCustomEmoji = true, registry = null } = {}) {
  if (!html || !autoCustomEmoji) return html;
  return enhanceHtmlWithCustomEmojis(html, { registry });
}

function buildHtmlRichMessage(bodyHtml, { headerHtml = '', footerText = '', richCard = false, buttonRows = [] } = {}) {
  const b = new RichMessageBuilder();
  if (headerHtml) b.paragraph(rt.html(headerHtml));
  if (richCard) b.quote(rt.html(bodyHtml));
  else b.paragraph(rt.html(bodyHtml));
  if (footerText) b.footer(rt.italic(safeUtf8(footerText)));
  for (const row of materializeRichButtonRows(buttonRows)) {
    b.buttons(row);
  }
  b.validate();
  return b.toJSON({ useCustomEmojis: true });
}

async function sendShowcaseBroadcast(api, chatId, item, { buttonRows = [] } = {}) {
  const botUsername = api?.me?.username || item.botUsername || 'pappy_agent';
  const botName = api?.me?.first_name || item.botName || 'Lancy';
  const extraRichBtns = materializeRichButtonRows(buttonRows);
  const richCard = buildSystemShowcaseCard({
    botName,
    botUsername,
    includeCta: true,
    extraButtons: extraRichBtns
  });
  if (typeof api.sendRichMessage === 'function') {
    try {
      return await withFloodRetry(() => api.sendRichMessage(chatId, richCard));
    } catch {
      // Fall back to formatted HTML blockquote + inline buttons below
    }
  }
  const fallbackHtml = buildShowcaseHtmlFallback({ botName, botUsername });
  const fallbackBtns = [
    [{ label: `🚀 Open @${botUsername}`, kind: 'url', value: `https://t.me/${String(botUsername).replace(/^@/, '')}` }],
    ...buttonRows
  ];
  const markup = materializeInlineKeyboardRows(fallbackBtns);
  return await withFloodRetry(() => api.sendMessage(chatId, fallbackHtml, {
    parse_mode: 'HTML',
    ...(markup ? { reply_markup: markup } : {})
  }));
}

async function sendTextWithOptionalRich(api, chatId, item, {
  richCard = false,
  headerHtml = '',
  footerText = '',
  buttonRows = [],
  autoCustomEmoji = true,
  customEmojiRegistry = null
} = {}) {
  const baseBody = item.html || escapeHtml(item.text || '');
  const bodyHtml = maybeUpgradeCustomHtml(baseBody, { autoCustomEmoji, registry: customEmojiRegistry });
  const parts = [];
  if (headerHtml) parts.push(headerHtml);
  parts.push(bodyHtml);
  if (footerText) parts.push(`<i>${escapeHtml(footerText)}</i>`);
  const fullHtml = parts.join('\n\n');
  const markup = materializeInlineKeyboardRows(buttonRows);

  if ((richCard || buttonRows.length > 0) && typeof api.sendRichMessage === 'function') {
    try {
      const richPayload = buildHtmlRichMessage(bodyHtml, { headerHtml, footerText, richCard, buttonRows });
      return await withFloodRetry(() => api.sendRichMessage(chatId, richPayload));
    } catch {
      // Fall through cleanly to HTML message + inline_keyboard
    }
  }

  const formatted = richCard && !/^<blockquote/i.test(bodyHtml.trim())
    ? `${headerHtml ? `${headerHtml}\n\n` : ''}<blockquote>${bodyHtml}</blockquote>${footerText ? `\n\n<i>${escapeHtml(footerText)}</i>` : ''}`
    : fullHtml;

  return await withFloodRetry(() => api.sendMessage(chatId, formatted, {
    parse_mode: 'HTML',
    ...(markup ? { reply_markup: markup } : {})
  }));
}

async function sendSingleBroadcastItem(api, targetBotId, chatId, item, {
  richCard = false,
  headerHtml = '',
  footerText = '',
  buttonRows = [],
  autoCustomEmoji = true,
  customEmojiRegistry = null,
  bufferCache = new Map()
} = {}) {
  if (item.kind === 'showcase') {
    return sendShowcaseBroadcast(api, chatId, item, { buttonRows });
  }
  if (item.kind === 'text') {
    return sendTextWithOptionalRich(api, chatId, item, {
      richCard, headerHtml, footerText, buttonRows, autoCustomEmoji, customEmojiRegistry
    });
  }

  if (item.kind === 'poll') {
    if (typeof api.sendPoll !== 'function') {
      throw new Error('Poll broadcasting is not supported by this bot API client');
    }
    const extra = {
      is_anonymous: item.isAnonymous !== false,
      allows_multiple_answers: Boolean(item.allowsMultipleAnswers)
    };
    if (item.pollType === 'quiz' && Number.isInteger(item.correctOptionId)) {
      extra.type = 'quiz';
      extra.correct_option_id = item.correctOptionId;
      if (item.explanation) extra.explanation = item.explanation;
    }
    return await withFloodRetry(() => api.sendPoll(chatId, item.question, item.options, extra));
  }

  const resolved = await resolveMediaPayload(item, { targetBotId, targetApi: api, bufferCache });
  const rawBaseCaption = item.captionHtml || escapeHtml(item.caption || '');
  const rawCaption = maybeUpgradeCustomHtml(rawBaseCaption, { autoCustomEmoji, registry: customEmojiRegistry });
  const captionParts = [];
  if (headerHtml) captionParts.push(headerHtml);
  if (rawCaption) captionParts.push(rawCaption);
  if (footerText) captionParts.push(`<i>${escapeHtml(footerText)}</i>`);
  let finalCaption = captionParts.join('\n\n');
  if (richCard && rawCaption && !/^<blockquote/i.test(rawCaption.trim())) {
    finalCaption = `${headerHtml ? `${headerHtml}\n\n` : ''}<blockquote>${rawCaption}</blockquote>${footerText ? `\n\n<i>${escapeHtml(footerText)}</i>` : ''}`;
  }
  const markup = materializeInlineKeyboardRows(buttonRows);
  const captionExtra = {
    ...(finalCaption ? { caption: safeTruncate(finalCaption, 1024), parse_mode: 'HTML' } : {}),
    ...(markup ? { reply_markup: markup } : {})
  };

  // Send single media inside unified Bot API 10.3 Rich Card when richCard or attached buttons are used
  if ((richCard || buttonRows.length > 0) && ['photo', 'video', 'audio', 'document', 'animation'].includes(item.kind) && typeof api.sendRichMessage === 'function') {
    try {
      const b = new RichMessageBuilder();
      const attachField = `${item.kind}_media`;
      const mediaRef = resolved.isBuffer ? `attach://${attachField}` : resolved.value;
      const files = resolved.isBuffer
        ? { [attachField]: { buffer: resolved.value, filename: resolved.filename, contentType: resolved.contentType } }
        : null;
      if (item.kind === 'photo') b.photo(mediaRef);
      else if (item.kind === 'video') b.video(mediaRef);
      else if (item.kind === 'animation') b.animation(mediaRef);
      else if (item.kind === 'document') b.document(mediaRef);
      else if (item.kind === 'audio') {
        b.audio({
          media: mediaRef,
          ...(item.title ? { title: item.title } : {}),
          ...(item.performer ? { performer: item.performer } : {}),
          ...(item.duration ? { duration: item.duration } : {})
        });
      }
      if (rawCaption) b.quote(rt.html(rawCaption));
      if (footerText) b.footer(rt.italic(safeUtf8(footerText)));
      for (const row of materializeRichButtonRows(buttonRows)) b.buttons(row);
      b.validate();
      return await withFloodRetry(() => api.sendRichMessage(chatId, b.toJSON({ useCustomEmojis: autoCustomEmoji }), {}, files));
    } catch {
      // Fall through cleanly to native media method + caption + inline_keyboard
    }
  }
  switch (item.kind) {
    case 'photo':
      return await withFloodRetry(() => api.sendPhoto(chatId, resolved.value, {
        ...captionExtra,
        filename: resolved.filename,
        contentType: resolved.contentType
      }));

    case 'video':
      return await withFloodRetry(() => api.sendVideo(chatId, resolved.value, {
        ...captionExtra,
        supports_streaming: true,
        ...(item.duration ? { duration: item.duration } : {}),
        ...(item.width ? { width: item.width } : {}),
        ...(item.height ? { height: item.height } : {}),
        filename: resolved.filename,
        contentType: resolved.contentType
      }));

    case 'animation':
      return await withFloodRetry(() => api.sendAnimation(chatId, resolved.value, {
        ...captionExtra,
        ...(item.duration ? { duration: item.duration } : {}),
        ...(item.width ? { width: item.width } : {}),
        ...(item.height ? { height: item.height } : {}),
        filename: resolved.filename,
        contentType: resolved.contentType
      }));

    case 'audio':
      return await withFloodRetry(() => api.sendAudio(chatId, resolved.value, {
        ...captionExtra,
        ...(item.duration ? { duration: item.duration } : {}),
        ...(item.performer ? { performer: item.performer } : {}),
        ...(item.title ? { title: item.title } : {}),
        filename: resolved.filename,
        contentType: resolved.contentType
      }));

    case 'voice':
      if (typeof api.sendVoice === 'function') {
        return await withFloodRetry(() => api.sendVoice(chatId, resolved.value, {
          ...captionExtra,
          ...(item.duration ? { duration: item.duration } : {}),
          filename: resolved.filename,
          contentType: resolved.contentType
        }));
      }
      return await withFloodRetry(() => api.call('sendVoice', {
        chat_id: chatId,
        voice: resolved.isBuffer ? 'attach://voice' : resolved.value,
        ...captionExtra
      }, resolved.isBuffer ? { files: { voice: { buffer: resolved.value, filename: resolved.filename, contentType: resolved.contentType } } } : undefined));

    case 'document':
      return await withFloodRetry(() => api.sendDocument(chatId, resolved.value, {
        ...captionExtra,
        filename: resolved.filename,
        contentType: resolved.contentType
      }));

    case 'sticker':
      return await withFloodRetry(() => api.sendSticker(
        chatId,
        resolved.isBuffer
          ? { buffer: resolved.value, filename: resolved.filename, contentType: resolved.contentType }
          : resolved.value,
        {
          is_video: item.isVideo,
          is_animated: item.isAnimated
        }
      ));

    default:
      throw new Error(`Unsupported broadcast item kind: ${item.kind}`);
  }
}

async function sendAlbumBroadcastBatch(api, targetBotId, chatId, batch, {
  richCard = false,
  slideMode = false,
  headerHtml = '',
  footerText = '',
  buttonRows = [],
  autoCustomEmoji = true,
  customEmojiRegistry = null,
  bufferCache = new Map()
} = {}) {
  const files = {};
  let hasFiles = false;
  const resolvedItems = [];

  for (let i = 0; i < batch.items.length; i++) {
    const item = batch.items[i];
    const resolved = await resolveMediaPayload(item, { targetBotId, targetApi: api, bufferCache });
    const attachKey = `album_${i}`;
    let mediaRef = resolved.value;
    if (resolved.isBuffer) {
      files[attachKey] = {
        buffer: resolved.value,
        filename: resolved.filename,
        contentType: resolved.contentType
      };
      mediaRef = `attach://${attachKey}`;
      hasFiles = true;
    }
    const rawCap = item.captionHtml || escapeHtml(item.caption || '');
    const upgradedCap = maybeUpgradeCustomHtml(rawCap, { autoCustomEmoji, registry: customEmojiRegistry });
    resolvedItems.push({ item, resolved, mediaRef, upgradedCap });
  }

  // Bot API 10.3 Rich Slideshow mode: 1..10 items in a single swipeable slide card with attached caption & buttons!
  if ((slideMode || (richCard && buttonRows.length > 0)) && typeof api.sendRichMessage === 'function') {
    try {
      const b = new RichMessageBuilder();
      if (headerHtml) b.paragraph(rt.html(headerHtml));
      const slideBlocks = [];
      let leadCaption = '';
      for (const { item, mediaRef, upgradedCap } of resolvedItems) {
        if (!leadCaption && upgradedCap) leadCaption = upgradedCap;
        if (item.kind === 'video') slideBlocks.push(block.video(mediaRef, upgradedCap ? rt.html(upgradedCap) : undefined));
        else if (item.kind === 'photo') slideBlocks.push(block.photo(mediaRef, upgradedCap ? rt.html(upgradedCap) : undefined));
        else if (item.kind === 'document') slideBlocks.push(block.document(mediaRef));
        else if (item.kind === 'audio') {
          slideBlocks.push(block.audio({
            media: mediaRef,
            ...(item.title ? { title: item.title } : {}),
            ...(item.performer ? { performer: item.performer } : {}),
            ...(item.duration ? { duration: item.duration } : {})
          }));
        }
      }
      if (slideBlocks.length) {
        b.slideshow(slideBlocks);
      }
      if (leadCaption) b.quote(rt.html(leadCaption));
      if (footerText) b.footer(rt.italic(safeUtf8(footerText)));
      for (const row of materializeRichButtonRows(buttonRows)) b.buttons(row);
      b.validate();
      return await withFloodRetry(() => api.sendRichMessage(chatId, b.toJSON({ useCustomEmojis: autoCustomEmoji }), {}, hasFiles ? files : null));
    } catch {
      // Fall through cleanly to native sendMediaGroup + button card if needed
    }
  }

  const mediaList = resolvedItems.map(({ item, mediaRef, upgradedCap }, i) => {
    const entry = {
      type: item.kind,
      media: mediaRef
    };
    const isFirst = i === 0;
    const capParts = [];
    if (isFirst && headerHtml) capParts.push(headerHtml);
    if (upgradedCap) capParts.push(upgradedCap);
    if (isFirst && footerText) capParts.push(`<i>${escapeHtml(footerText)}</i>`);
    if (capParts.length > 0) {
      const joined = safeUtf8(capParts.join('\n\n'));
      entry.caption = (richCard && isFirst && !/^<blockquote/i.test(joined.trim()))
        ? safeTruncate(`<blockquote>${joined}</blockquote>`, 1024)
        : safeTruncate(joined, 1024);
      entry.parse_mode = 'HTML';
    }
    if (item.kind === 'video') {
      entry.supports_streaming = true;
      if (item.duration) entry.duration = item.duration;
      if (item.width) entry.width = item.width;
      if (item.height) entry.height = item.height;
    } else if (item.kind === 'audio') {
      if (item.duration) entry.duration = item.duration;
      if (item.performer) entry.performer = item.performer;
      if (item.title) entry.title = item.title;
    }
    return entry;
  });

  const albumRes = await withFloodRetry(() => api.sendMediaGroup(chatId, mediaList, {}, hasFiles ? files : null));
  const markup = materializeInlineKeyboardRows(buttonRows);
  if (markup) {
    await withFloodRetry(() => api.sendMessage(chatId, '👇', { reply_markup: markup })).catch(() => {});
  }
  return albumRes;
}

/**
 * Deliver a complete broadcast payload (1+ items, including mixed albums, 10-item slideshows, audio, rich text, stickers, polls, showcase card)
 * to a single Telegram destination (`channel`, `group`, `supergroup`, or `private` user chat).
 */
export async function deliverBroadcastToTarget({
  targetApi,
  targetBotId = null,
  chatId,
  items = [],
  richCard = false,
  slideMode = false,
  headerHtml = '',
  footerText = '',
  buttonRows = [],
  autoCustomEmoji = true,
  customEmojiRegistry = null,
  bufferCache = new Map()
} = {}) {
  if (!targetApi || !chatId) throw new Error('targetApi and chatId are required');
  const resolvedBotId = targetBotId != null
    ? String(targetBotId)
    : (targetApi.me?.id != null ? String(targetApi.me.id) : null);

  const batches = groupBroadcastItems(items);
  if (!batches.length) throw new Error('Broadcast payload is empty');

  const sentResults = [];
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const applyWrapper = i === 0;
    const isLast = i === batches.length - 1;
    const opts = {
      richCard,
      slideMode,
      headerHtml: applyWrapper ? headerHtml : '',
      footerText: isLast ? footerText : '',
      buttonRows: isLast ? buttonRows : [],
      autoCustomEmoji,
      customEmojiRegistry,
      bufferCache
    };
    if (batch.type === 'album') {
      const res = await sendAlbumBroadcastBatch(targetApi, resolvedBotId, chatId, batch, opts);
      sentResults.push(res);
    } else {
      const res = await sendSingleBroadcastItem(targetApi, resolvedBotId, chatId, batch.item, opts);
      sentResults.push(res);
    }
  }

  return { ok: true, batchesSent: batches.length, sentResults };
}

/**
 * Pick the sending bot API & botId for a target channel/GC given a chosen sender selection:
 * - `'auto'`: prefer Main Bot if verified for this target, otherwise first verified Clone Bot.
 * - specific `botId`: must be verified for this target (or returns `null` if unavailable).
 */
export function resolveSenderBotForTarget(target, selectedSenderBotId = 'auto', bots = []) {
  const verified = Array.isArray(target?.verifiedBots) ? target.verifiedBots : [];
  if (!verified.length) return null;
  if (!selectedSenderBotId || selectedSenderBotId === 'auto') {
    const main = verified.find((b) => b.isMain);
    if (main) return main;
    return verified[0];
  }
  const match = verified.find((b) => String(b.botId) === String(selectedSenderBotId));
  if (match) return match;
  // Also match by cloneRowId in case UI passed `clone:<rowId>`
  const byRow = verified.find((b) => b.cloneRowId != null && String(b.cloneRowId) === String(selectedSenderBotId));
  return byRow || null;
}

export function summarizeBroadcastItems(items = []) {
  if (!items.length) return 'Empty draft — send any content below';
  const counts = {};
  for (const it of items) {
    counts[it.kind] = (counts[it.kind] || 0) + 1;
  }
  const batches = groupBroadcastItems(items);
  const albumCount = batches.filter((b) => b.type === 'album').length;
  const labels = [];
  if (counts.showcase) labels.push(`${counts.showcase} A–Z Showcase Card`);
  if (counts.text) labels.push(`${counts.text} Text`);
  if (counts.photo) labels.push(`${counts.photo} Photo${counts.photo > 1 ? 's' : ''}`);
  if (counts.video) labels.push(`${counts.video} Video${counts.video > 1 ? 's' : ''}`);
  if (counts.audio) labels.push(`${counts.audio} Audio${counts.audio > 1 ? 's' : ''}`);
  if (counts.voice) labels.push(`${counts.voice} Voice`);
  if (counts.animation) labels.push(`${counts.animation} GIF`);
  if (counts.document) labels.push(`${counts.document} Doc${counts.document > 1 ? 's' : ''}`);
  if (counts.sticker) labels.push(`${counts.sticker} Sticker`);
  if (counts.poll) labels.push(`${counts.poll} Poll`);
  const albumNote = albumCount ? ` • ${albumCount} Album${albumCount > 1 ? 's' : ''}` : '';
  return `${labels.join(' + ')}${albumNote}`;
}

export { log as broadcastEngineLog };
