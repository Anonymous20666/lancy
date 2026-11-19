import sharp from 'sharp';
import { RichMessageBuilder, rt, richButton, encodeCallback, inlineKeyboard } from '../rich.js';
import { navButtons, banner, ACCENT, SPARK } from '../ui.js';
import { States } from '../../core/stateMachine.js';
import { sleep } from '../../utils/time.js';
import { logger } from '../../core/logger.js';
import {
  toMathBold,
  toMathBoldItalic,
  buildAestheticStickerCaption,
  renderChannelPackCardCaption,
  FONT_STYLES
} from '../../captions/engine.js';
import { TemplateStore } from '../../captions/templates.js';
import { isVideoBuffer } from '../../media/convert.js';
import { isTgsBuffer } from '../../media/validate.js';
import { toHdMediaFromEmoji } from '../../stickers/emojiConverter.js';
import {
  listVerifiedAdminChannels,
  isBotSuperAdmin,
  verifyChannelAdmin,
  verifyBotCanPostInChannel,
  canAccessChannelInMenu
} from '../permissions.js';
export { buildAestheticStickerCaption };

/**
 * Escapes XML/SVG special characters safely.
 */
function escapeXml(unsafe = '') {
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Renders an ultra-crisp 1000x560 bespoke sticker announcement banner.
 */
export async function renderChannelBanner({
  title = 'Sticker Pack',
  count = 30,
  stickerType = 'static',
  sampleBuffer = null,
  creator = 'Lancy'
} = {}) {
  const cleanTitle = escapeXml(String(title).toUpperCase().slice(0, 32));
  const cleanCreator = escapeXml(String(creator).slice(0, 20));
  const typeLabel = String(stickerType).toUpperCase();

  const svg = `
  <svg width="1000" height="560" viewBox="0 0 1000 560" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#110d1c"/>
        <stop offset="45%" stop-color="#1f1433"/>
        <stop offset="100%" stop-color="#120c22"/>
      </linearGradient>
      <linearGradient id="glow" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#ff79c6"/>
        <stop offset="50%" stop-color="#bd93f9"/>
        <stop offset="100%" stop-color="#8be9fd"/>
      </linearGradient>
      <linearGradient id="cardGrad" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stop-color="#2a1e45" stop-opacity="0.85"/>
        <stop offset="100%" stop-color="#18102b" stop-opacity="0.95"/>
      </linearGradient>
      <filter id="shadow" x="-10%" y="-10%" width="120%" height="120%">
        <feDropShadow dx="0" dy="12" stdDeviation="16" flood-color="#000000" flood-opacity="0.6"/>
      </filter>
      <filter id="blurNeon" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="22" result="blur"/>
      </filter>
    </defs>

    <!-- Background Base -->
    <rect width="1000" height="560" fill="url(#bg)"/>

    <!-- Subtle Ambient Neon Glow Orbs -->
    <circle cx="200" cy="120" r="140" fill="#ff79c6" opacity="0.14" filter="url(#blurNeon)"/>
    <circle cx="820" cy="380" r="160" fill="#bd93f9" opacity="0.18" filter="url(#blurNeon)"/>

    <!-- Outer Decorative Border -->
    <rect x="20" y="20" width="960" height="520" rx="28" fill="none" stroke="url(#glow)" stroke-width="2.5" opacity="0.7"/>

    <!-- Inner Elevated Content Box -->
    <rect x="50" y="50" width="900" height="460" rx="22" fill="url(#cardGrad)" stroke="#3e2d5c" stroke-width="1.5" filter="url(#shadow)"/>

    <!-- Studio Header Badge -->
    <rect x="85" y="80" width="310" height="38" rx="19" fill="#1b122c" stroke="#ff79c6" stroke-width="1.2"/>
    <text x="240" y="104" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="14" font-weight="bold" fill="#ff99dc" letter-spacing="2">
      ✦ LANCY STICKER STUDIO ✦
    </text>

    <!-- Pack Title -->
    <text x="85" y="195" font-family="DejaVu Sans, sans-serif" font-size="44" font-weight="bold" fill="#ffffff" filter="url(#shadow)">
      ${cleanTitle}
    </text>

    <!-- Subtitle / Aesthetics -->
    <text x="85" y="240" font-family="DejaVu Sans, sans-serif" font-size="20" fill="#c3b1e1">
      Official Telegram Collection ♡
    </text>

    <!-- Metadata Badges (Count & Type) -->
    <rect x="85" y="280" width="180" height="44" rx="22" fill="#2d1d49" stroke="#bd93f9" stroke-width="1.2"/>
    <text x="175" y="308" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="16" font-weight="bold" fill="#8be9fd">
      📦 ${count} STICKERS
    </text>

    <rect x="280" y="280" width="140" height="44" rx="22" fill="#2d1d49" stroke="#bd93f9" stroke-width="1.2"/>
    <text x="350" y="308" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="16" font-weight="bold" fill="#f1fa8c">
      ✨ ${typeLabel}
    </text>

    <!-- Bottom Highlights -->
    <text x="85" y="390" font-family="DejaVu Sans, sans-serif" font-size="16" fill="#ded4f0">
      • Crystal clear resolution • Instant 1-tap installation
    </text>
    <text x="85" y="425" font-family="DejaVu Sans, sans-serif" font-size="16" fill="#ded4f0">
      • Created with @${cleanCreator} for Telegram chats
    </text>

    <!-- Right Side Sticker Preview Frame -->
    <rect x="610" y="85" width="300" height="380" rx="20" fill="#171026" stroke="url(#glow)" stroke-width="2"/>
    <text x="760" y="445" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="14" font-weight="bold" fill="#ff79c6" letter-spacing="1">
      TAP TO ADD FULL PACK ♡
    </text>
  </svg>
  `;

  let baseImg = sharp(Buffer.from(svg));

  if (sampleBuffer && Buffer.isBuffer(sampleBuffer)) {
    try {
      const resizedSample = await sharp(sampleBuffer, { failOn: 'none', page: 0 })
        .resize(260, 260, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();

      baseImg = baseImg.composite([
        {
          input: resizedSample,
          top: 135,
          left: 630
        }
      ]);
    } catch {}
  }

  return await baseImg.png().toBuffer();
}

/**
 * Normalizes pack fields whether from raw DB row or decorated PackService object.
 */
export function normalizePack(p) {
  if (!p || typeof p !== 'object') return null;
  const shortName = p.shortName || p.tg_short_name || p.name || '';
  const rawKind = p.stickerKind || p.sticker_kind || p.sticker_type_kind || '';
  const linkStr = String(p.link || '');
  const stickerKind = (
    rawKind === 'custom_emoji'
    || p.sticker_type === 'custom_emoji'
    || p.stickerType === 'custom_emoji'
    || linkStr.includes('/addemoji/')
  ) ? 'custom_emoji' : (rawKind || 'regular');
  const title = p.title || p.tg_title || p.query || (stickerKind === 'custom_emoji' ? 'Custom Emoji Pack' : 'Sticker Pack');
  const linkPrefix = stickerKind === 'custom_emoji' ? 'https://t.me/addemoji/' : 'https://t.me/addstickers/';
  const link = (linkStr && !(stickerKind === 'custom_emoji' && linkStr.includes('/addstickers/')))
    ? linkStr
    : (shortName ? `${linkPrefix}${shortName}` : '');
  const count = Number(p.count ?? p.stickerCount ?? 0);
  const stickerType = p.stickerType || p.sticker_type || 'static';
  const query = p.query || title;
  return {
    ...p,
    id: p.id,
    shortName,
    tg_short_name: shortName,
    name: shortName,
    title,
    tg_title: title,
    link,
    count,
    stickerKind,
    sticker_kind: stickerKind,
    stickerType,
    sticker_type: stickerType,
    query
  };
}

function escapeHtml(unsafe = '') {
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatChannelCaptionHtml(rawText, quoteMode = 'quote') {
  const safe = escapeHtml(String(rawText || '').trim());
  if (!safe) return '';
  // Telegram captions allow max 1024 parsed characters; keep comfortably under with room for blockquote tags
  const clamped = safe.length > 980 ? `${safe.slice(0, 977)}...` : safe;
  if (quoteMode === 'plain') return clamped;
  if (quoteMode === 'expandable') return `<blockquote expandable>${clamped}</blockquote>`;
  return `<blockquote>${clamped}</blockquote>`;
}

function parseChannelTokens(rawText = '') {
  return String(rawText)
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const linkMatch = s.match(/t\.me\/([A-Za-z0-9_]+)/i);
      return linkMatch ? `@${linkMatch[1]}` : s;
    });
}

function getFontLabel(fontId) {
  return FONT_STYLES.find((f) => f.id === fontId)?.label || 'Serif Italic';
}

/**
 * Picks up to 2 sample stickers/emojis prioritizing items with custom_emoji_id
 * when requested, and mixed video + static variety.
 */
function pickTwoSamples(stickers = [], { requireCustomEmojiId = false } = {}) {
  if (!Array.isArray(stickers) || !stickers.length) return [];
  const pool = requireCustomEmojiId
    ? stickers.filter((st) => Boolean(st?.custom_emoji_id))
    : stickers;
  const source = pool.length > 0 ? pool : stickers;
  const chosen = [];
  const seen = new Set();
  const pushUnique = (st) => {
    const key = st?.custom_emoji_id || st?.file_unique_id || st?.file_id;
    if (!key || seen.has(key)) return;
    seen.add(key);
    chosen.push(st);
  };
  const firstVideo = source.find((st) => st?.is_video || st?.type === 'video');
  const firstStatic = source.find((st) => !st?.is_video && st?.type !== 'video');
  if (firstVideo) pushUnique(firstVideo);
  if (firstStatic && chosen.length < 2) pushUnique(firstStatic);
  for (const st of source) {
    if (chosen.length >= 2) break;
    pushUnique(st);
  }
  return chosen.slice(0, 2);
}

/**
 * Recursively collects all custom_emoji_id values present in a returned Telegram Message
 * (entities, caption_entities, or rich_message blocks/nodes).
 */
export function extractCustomEmojiIdsFromResponse(msg) {
  const found = [];
  const seen = new Set();
  const addId = (val) => {
    const s = val != null ? String(val).trim() : '';
    if (s && !seen.has(s)) {
      seen.add(s);
      found.push(s);
    }
  };

  const scanEntities = (list) => {
    if (!Array.isArray(list)) return;
    for (const ent of list) {
      if (ent?.type === 'custom_emoji' && ent.custom_emoji_id) {
        addId(ent.custom_emoji_id);
      }
    }
  };

  if (!msg || typeof msg !== 'object') return found;
  scanEntities(msg.entities);
  scanEntities(msg.caption_entities);

  const walkRich = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 12) return;
    if (Array.isArray(node)) {
      for (const item of node) walkRich(item, depth + 1);
      return;
    }
    if (node.type === 'custom_emoji' && node.custom_emoji_id) {
      addId(node.custom_emoji_id);
    }
    for (const val of Object.values(node)) {
      if (val && typeof val === 'object') walkRich(val, depth + 1);
    }
  };

  if (msg.rich_message) walkRich(msg.rich_message);
  return found;
}

/**
 * Verifies whether a sent Telegram Message preserved the expected custom_emoji_id(s).
 * Distinguishes stripped entities (inspectable payload present without custom_emoji)
 * from minimal stubs that return only { message_id }.
 */
export function inspectCustomEmojiDelivery(msg, expectedIds = []) {
  const expected = [...new Set(expectedIds.map((x) => String(x || '').trim()).filter(Boolean))];
  const presentIds = extractCustomEmojiIdsFromResponse(msg);
  const presentSet = new Set(presentIds);
  const confirmedIds = expected.filter((id) => presentSet.has(id));
  const missingIds = expected.filter((id) => !presentSet.has(id));

  if (!msg || typeof msg !== 'object') {
    return { status: 'unconfirmed', verified: null, confirmedIds: [], missingIds: expected };
  }

  const hasInspectablePayload = (
    'entities' in msg
    || 'caption_entities' in msg
    || 'rich_message' in msg
    || 'text' in msg
    || 'caption' in msg
  );

  if (expected.length === 0) {
    return {
      status: presentIds.length > 0 ? 'verified' : 'unconfirmed',
      verified: presentIds.length > 0 ? true : null,
      confirmedIds: presentIds,
      missingIds: []
    };
  }

  if (confirmedIds.length === expected.length) {
    return { status: 'verified', verified: true, confirmedIds, missingIds: [] };
  }
  if (confirmedIds.length > 0) {
    return { status: 'partial', verified: true, confirmedIds, missingIds };
  }
  if (hasInspectablePayload) {
    return { status: 'stripped', verified: false, confirmedIds: [], missingIds: expected };
  }
  return { status: 'unconfirmed', verified: null, confirmedIds: [], missingIds: expected };
}

/**
 * Builds one unified Rich Message pack broadcast card with attached hero media,
 * formatted blockquote caption, and styled inline buttons inside the card itself.
 */
export function buildChannelPackRichCard({
  pack,
  rawCaption = '',
  quoteMode = 'quote',
  heroAttachmentName = null,
  heroMediaKind = null,
  channelUsername = null,
  includeSecondaryCta = true,
  useCustomEmojis = true
} = {}) {
  const p = normalizePack(pack) || {};
  const b = new RichMessageBuilder();

  if (heroAttachmentName) {
    if (heroMediaKind === 'video') {
      b.video(`attach://${heroAttachmentName}`);
    } else {
      b.photo(`attach://${heroAttachmentName}`);
    }
  }

  const cleanCaption = String(rawCaption || '').trim();
  if (cleanCaption) {
    let effectiveMode = quoteMode || 'quote';
    let inner = cleanCaption;
    const expMatch = inner.match(/^<blockquote\s+expandable>([\s\S]*)<\/blockquote>$/i);
    const quoteMatch = inner.match(/^<blockquote>([\s\S]*)<\/blockquote>$/i);
    if (expMatch) {
      effectiveMode = 'expandable';
      inner = expMatch[1].trim();
    } else if (quoteMatch) {
      if (effectiveMode === 'plain') effectiveMode = 'quote';
      inner = quoteMatch[1].trim();
    }

    const richContent = /<\/?(b|strong|i|em|u|ins|s|strike|del|code|tg-spoiler|spoiler|a|tg-emoji)\b/i.test(inner)
      ? rt.html(inner)
      : inner;

    if (effectiveMode === 'expandable') {
      b.expandableBlockquote(richContent);
    } else if (effectiveMode === 'plain') {
      b.paragraph(richContent);
    } else {
      b.blockquote(richContent);
    }
  }

  if (p.link) {
    b.buttons([
      richButton.url(
        p.stickerKind === 'custom_emoji' ? '✨ Add Custom Emojis 🌸' : '➕ Add Sticker Pack 🌸',
        p.link,
        { style: 'success' }
      )
    ]);

    if (includeSecondaryCta) {
      const shareText = `${p.title || 'Pack'} ✨`;
      const ctaRow = [
        richButton.url(
          '💌 Share Pack',
          `https://t.me/share/url?url=${encodeURIComponent(p.link)}&text=${encodeURIComponent(shareText)}`,
          { style: 'primary' }
        )
      ];
      if (channelUsername) {
        const cleanUser = String(channelUsername).replace(/^@/, '').trim();
        if (cleanUser) {
          ctaRow.push(richButton.url('🦋 Follow', `https://t.me/${cleanUser}`, { style: 'primary' }));
        }
      }
      b.buttons(ctaRow);
    }
  }

  b.validate();
  return b.toJSON({ useCustomEmojis });
}

/**
 * Prepares HD hero media for channel broadcast:
 * - Video emojis/stickers -> 720x720 H.264 MP4
 * - Static emojis/stickers -> 1280x1280 HD JPEG (no black alpha recompression)
 * - Banner fallback -> 1280x720 HD JPEG
 */
export async function prepareChannelHeroMedia({
  pack,
  heroVideoRawBuf = null,
  sampleBuf = null,
  botUser = 'Lancy_easy_bot',
  configuredFfmpeg = ''
} = {}) {
  const p = normalizePack(pack) || {};

  if (heroVideoRawBuf && Buffer.isBuffer(heroVideoRawBuf)) {
    const hdVid = await toHdMediaFromEmoji(heroVideoRawBuf, {
      outputFormat: 'mp4',
      targetSize: 720,
      configuredFfmpeg
    }).catch(() => null);

    if (hdVid?.buffer && hdVid.mediaKind === 'video') {
      return {
        buffer: hdVid.buffer,
        mediaKind: 'video',
        filename: hdVid.filename || 'hd_emoji.mp4',
        contentType: 'video/mp4',
        width: hdVid.width || 720,
        height: hdVid.height || 720,
        resolutionLabel: `${hdVid.width || 720}×${hdVid.height || 720} HD MP4`
      };
    }

    if (isVideoBuffer(heroVideoRawBuf)) {
      return {
        buffer: heroVideoRawBuf,
        mediaKind: 'video',
        filename: 'emoji_drop.mp4',
        contentType: 'video/mp4',
        width: null,
        height: null,
        resolutionLabel: 'HD Video MP4'
      };
    }
  }

  const staticSource = sampleBuf && Buffer.isBuffer(sampleBuf) && !isTgsBuffer(sampleBuf)
    ? sampleBuf
    : null;

  if (staticSource) {
    const hdPhoto = await toHdMediaFromEmoji(staticSource, {
      outputFormat: 'photo',
      targetSize: 1280,
      configuredFfmpeg
    }).catch(() => null);

    if (hdPhoto?.buffer && hdPhoto.mediaKind === 'photo') {
      return {
        buffer: hdPhoto.buffer,
        mediaKind: 'photo',
        filename: hdPhoto.filename || 'hd_emoji.jpg',
        contentType: 'image/jpeg',
        width: hdPhoto.width || 1280,
        height: hdPhoto.height || 1280,
        resolutionLabel: `${hdPhoto.width || 1280}×${hdPhoto.height || 1280} HD JPEG`
      };
    }

    try {
      const sharpJpg = await sharp(staticSource, { failOn: 'none', page: 0 })
        .flatten({ background: '#ffffff' })
        .resize(1280, 1280, { fit: 'contain', kernel: sharp.kernel.lanczos3, background: '#ffffff' })
        .sharpen({ sigma: 0.7 })
        .jpeg({ quality: 96, mozjpeg: true })
        .toBuffer();
      return {
        buffer: sharpJpg,
        mediaKind: 'photo',
        filename: 'hd_emoji.jpg',
        contentType: 'image/jpeg',
        width: 1280,
        height: 1280,
        resolutionLabel: '1280×1280 HD JPEG'
      };
    } catch {}

    const legacyPng = await prepareStickerPhotoBuffer(staticSource).catch(() => null);
    if (legacyPng) {
      return {
        buffer: legacyPng,
        mediaKind: 'photo',
        filename: 'pack_preview.png',
        contentType: 'image/png',
        width: 800,
        height: 800,
        resolutionLabel: '800×800 PNG'
      };
    }
  }

  const bannerPng = await renderChannelBanner({
    title: p.title,
    count: p.count,
    stickerType: p.stickerType,
    sampleBuffer: staticSource,
    creator: botUser
  }).catch(() => null);

  if (bannerPng) {
    try {
      const hdBannerJpg = await sharp(bannerPng)
        .resize(1280, 720, { fit: 'cover', kernel: sharp.kernel.lanczos3 })
        .sharpen({ sigma: 0.7 })
        .jpeg({ quality: 96, mozjpeg: true })
        .toBuffer();
      return {
        buffer: hdBannerJpg,
        mediaKind: 'photo',
        filename: 'hd_banner.jpg',
        contentType: 'image/jpeg',
        width: 1280,
        height: 720,
        resolutionLabel: '1280×720 HD Banner JPEG'
      };
    } catch {
      return {
        buffer: bannerPng,
        mediaKind: 'photo',
        filename: 'banner.png',
        contentType: 'image/png',
        width: 1000,
        height: 560,
        resolutionLabel: '1000×560 Banner PNG'
      };
    }
  }

  return null;
}

/**
 * Sends sample custom emojis via Rich Message (custom_emoji nodes) first and inspects the
 * returned Telegram message for preserved custom_emoji entities/nodes. If stripped by
 * Telegram, cleans up and tries HTML <tg-emoji> fallback, reporting exact verification state.
 * Never falls back to sendSticker for custom_emoji packs.
 */
export async function sendVerifiedCustomEmojiSamples({
  api,
  channelId,
  samples = [],
  useRichMessage = true,
  log = null
} = {}) {
  let customSamples = samples.filter((s) => s?.custom_emoji_id).slice(0, 2);
  if (!customSamples.length) {
    return {
      sentCount: 0,
      expectedCount: Math.min(2, samples.length),
      verifiedCount: 0,
      customVerified: false,
      status: 'missing_custom_emoji_id',
      transport: null,
      messageIds: []
    };
  }

  const expectedIds = customSamples.map((s) => String(s.custom_emoji_id));
  if (typeof api?.getCustomEmojiStickers === 'function') {
    try {
      const liveStickers = await api.getCustomEmojiStickers(expectedIds);
      if (Array.isArray(liveStickers) && liveStickers.length) {
        const liveById = new Map(
          liveStickers
            .filter((st) => st?.custom_emoji_id)
            .map((st) => [String(st.custom_emoji_id), st])
        );
        customSamples = customSamples.map((s) => {
          const live = liveById.get(String(s.custom_emoji_id));
          if (!live) return s;
          return {
            ...s,
            emoji: live.emoji || s.emoji || '✨',
            file_id: live.file_id || s.file_id || null,
            file_unique_id: live.file_unique_id || s.file_unique_id || null
          };
        });
      }
    } catch (hydrateErr) {
      log?.warn?.({ err: hydrateErr?.message, expectedIds }, 'getCustomEmojiStickers hydration failed, using stored fallback emoji');
    }
  }

  const sampleLineHtml = customSamples
    .map((s) => `<tg-emoji emoji-id="${escapeHtml(s.custom_emoji_id)}">${escapeHtml(s.emoji || '✨')}</tg-emoji>`)
    .join('   ');

  if (useRichMessage && typeof api?.sendRichMessage === 'function') {
    try {
      const bSample = new RichMessageBuilder();
      const nodes = [];
      customSamples.forEach((s, idx) => {
        if (idx > 0) nodes.push('   ');
        nodes.push(rt.customEmoji(s.emoji || '✨', String(s.custom_emoji_id)));
      });
      bSample.paragraph(nodes);
      bSample.validate();
      const msg1 = await api.sendRichMessage(channelId, bSample.toJSON({ useCustomEmojis: false }));
      const check1 = inspectCustomEmojiDelivery(msg1, expectedIds);

      if (check1.status === 'verified' || check1.status === 'partial') {
        return {
          sentCount: customSamples.length,
          expectedCount: customSamples.length,
          verifiedCount: check1.confirmedIds.length,
          customVerified: true,
          status: check1.status,
          transport: 'rich_message',
          messageIds: msg1?.message_id ? [msg1.message_id] : []
        };
      }
      if (check1.status === 'unconfirmed') {
        return {
          sentCount: customSamples.length,
          expectedCount: customSamples.length,
          verifiedCount: 0,
          customVerified: null,
          status: 'unconfirmed',
          transport: 'rich_message',
          messageIds: msg1?.message_id ? [msg1.message_id] : []
        };
      }

      if (msg1?.message_id && typeof api?.deleteMessage === 'function') {
        await api.deleteMessage(channelId, msg1.message_id).catch(() => {});
      }

      if (typeof api?.sendMessage !== 'function') {
        return {
          sentCount: 0,
          expectedCount: customSamples.length,
          verifiedCount: 0,
          customVerified: false,
          status: 'stripped',
          deletedStripped: Boolean(msg1?.message_id && typeof api?.deleteMessage === 'function'),
          reason: 'telegram_channel_requires_fragment_username',
          transport: 'rich_message',
          messageIds: []
        };
      }

      log?.warn?.({ channelId, expectedIds }, 'sendRichMessage sample stripped custom_emoji, trying <tg-emoji> HTML fallback');
    } catch (richSampleErr) {
      log?.warn?.({ err: richSampleErr?.message, channelId }, 'sendRichMessage custom emoji drop failed, trying <tg-emoji> HTML fallback');
    }
  }

  if (typeof api?.sendMessage === 'function') {
    const msg2 = await api.sendMessage(channelId, sampleLineHtml, { parse_mode: 'HTML' });
    const check2 = inspectCustomEmojiDelivery(msg2, expectedIds);
    if (check2.status === 'stripped') {
      let deletedStripped = false;
      if (msg2?.message_id && typeof api?.deleteMessage === 'function') {
        try {
          await api.deleteMessage(channelId, msg2.message_id);
          deletedStripped = true;
        } catch {
          deletedStripped = false;
        }
      }
      log?.warn?.({ channelId, expectedIds, deletedStripped }, 'Telegram stripped <tg-emoji> in channel (bot needs Fragment collectible username)');
      return {
        sentCount: 0,
        expectedCount: customSamples.length,
        verifiedCount: 0,
        customVerified: false,
        status: 'stripped',
        deletedStripped,
        reason: 'telegram_channel_requires_fragment_username',
        transport: 'html_tg_emoji',
        messageIds: []
      };
    }
    return {
      sentCount: customSamples.length,
      expectedCount: customSamples.length,
      verifiedCount: check2.confirmedIds.length,
      customVerified: check2.verified,
      status: check2.status,
      transport: 'html_tg_emoji',
      messageIds: msg2?.message_id ? [msg2.message_id] : []
    };
  }

  return {
    sentCount: 0,
    expectedCount: customSamples.length,
    verifiedCount: 0,
    customVerified: false,
    status: 'no_transport',
    transport: null,
    messageIds: []
  };
}

/**
 * Publishes one unified pack card (Rich Message with inline styled buttons inside the card,
 * falling back to sendVideo/sendAnimation/sendPhoto + inlineKeyboard only if sendRichMessage
 * is unavailable or unsupported) followed by sample custom_emoji / sticker drops.
 */
export async function publishChannelPackDrop({
  api,
  channelId,
  channelUsername = null,
  pack,
  heroMedia = null,
  rawCaption = '',
  captionIsHtml = false,
  quoteMode = 'quote',
  includeSecondaryCta = true,
  sampleStickers = [],
  maxSamples = 2,
  interMessageDelayMs = 450,
  sampleDelayMs = 300,
  log = null
} = {}) {
  const p = normalizePack(pack);
  if (!p) throw new Error('Pack is required for channel publish');

  let usedRichMessage = false;
  let cardMessage = null;

  const hasRichApi = typeof api?.sendRichMessage === 'function';
  if (hasRichApi) {
    const heroAttachKey = heroMedia?.buffer
      ? (heroMedia.mediaKind === 'video' ? 'hero_video' : 'hero_photo')
      : null;
    const files = heroAttachKey ? {
      [heroAttachKey]: {
        buffer: heroMedia.buffer,
        filename: heroMedia.filename,
        contentType: heroMedia.contentType
      }
    } : null;

    const richPayload = buildChannelPackRichCard({
      pack: p,
      rawCaption,
      quoteMode,
      heroAttachmentName: heroAttachKey,
      heroMediaKind: heroMedia?.mediaKind || null,
      channelUsername,
      includeSecondaryCta
    });

    try {
      cardMessage = await api.sendRichMessage(channelId, richPayload, {}, files);
      usedRichMessage = true;
    } catch (richErr) {
      const msg = String(richErr?.description || richErr?.message || '').toLowerCase();
      if (/not enough rights|need administrator|chat not found|kicked|blocked|chat_write_forbidden|user_banned_in_channel/i.test(msg)) {
        throw richErr;
      }
      log?.warn?.({ err: richErr?.message, channelId }, 'sendRichMessage pack card failed, falling back to legacy media send');
    }
  }

  if (!usedRichMessage) {
    const keyboardRows = [];
    if (p.link) {
      keyboardRows.push([{
        text: p.stickerKind === 'custom_emoji' ? '✨ Add Custom Emojis 🌸' : '➕ Add Sticker Pack 🌸',
        url: p.link,
        style: 'success'
      }]);
      if (includeSecondaryCta) {
        const ctaRow = [{
          text: '💌 Share Pack',
          url: `https://t.me/share/url?url=${encodeURIComponent(p.link)}&text=${encodeURIComponent(`${p.title} ✨`)}`,
          style: 'primary'
        }];
        if (channelUsername) {
          ctaRow.push({
            text: '🦋 Follow',
            url: `https://t.me/${String(channelUsername).replace(/^@/, '').trim()}`,
            style: 'primary'
          });
        }
        keyboardRows.push(ctaRow);
      }
    }

    const formattedCaption = captionIsHtml
      ? (/^<blockquote\b/i.test(String(rawCaption || '').trim())
        ? String(rawCaption || '').trim()
        : `<blockquote>${String(rawCaption || '').trim()}</blockquote>`)
      : formatChannelCaptionHtml(rawCaption, quoteMode);

    const mediaPayload = {
      caption: formattedCaption,
      parse_mode: 'HTML',
      ...(keyboardRows.length ? { reply_markup: inlineKeyboard(keyboardRows) } : {})
    };

    if (heroMedia?.buffer && heroMedia.mediaKind === 'video') {
      let vidSent = false;
      if (typeof api?.sendVideo === 'function') {
        try {
          cardMessage = await api.sendVideo(channelId, heroMedia.buffer, {
            ...mediaPayload,
            filename: heroMedia.filename || 'hd_emoji.mp4',
            contentType: heroMedia.contentType || 'video/mp4',
            supports_streaming: true,
            ...(heroMedia.width ? { width: heroMedia.width } : {}),
            ...(heroMedia.height ? { height: heroMedia.height } : {})
          });
          vidSent = true;
        } catch (vidErr) {
          log?.warn?.({ err: vidErr?.message, channelId }, 'fallback sendVideo failed, trying sendAnimation');
        }
      }
      if (!vidSent && typeof api?.sendAnimation === 'function') {
        cardMessage = await api.sendAnimation(channelId, heroMedia.buffer, {
          ...mediaPayload,
          filename: heroMedia.filename || 'hd_emoji.mp4',
          contentType: heroMedia.contentType || 'video/mp4',
          ...(heroMedia.width ? { width: heroMedia.width } : {}),
          ...(heroMedia.height ? { height: heroMedia.height } : {})
        });
        vidSent = true;
      }
    } else if (heroMedia?.buffer && typeof api?.sendPhoto === 'function') {
      cardMessage = await api.sendPhoto(channelId, heroMedia.buffer, {
        ...mediaPayload,
        filename: heroMedia.filename || 'hd_emoji.jpg',
        contentType: heroMedia.contentType || 'image/jpeg'
      });
    } else if (typeof api?.sendMessage === 'function') {
      cardMessage = await api.sendMessage(channelId, formattedCaption, {
        parse_mode: 'HTML',
        reply_markup: mediaPayload.reply_markup
      });
    }
  }

  if (interMessageDelayMs > 0) await sleep(interMessageDelayMs);

  let samplesSent = 0;
  let customEmojiDrop = null;

  if (p.stickerKind === 'custom_emoji') {
    const picked = pickTwoSamples(sampleStickers, { requireCustomEmojiId: true }).slice(0, maxSamples);
    customEmojiDrop = await sendVerifiedCustomEmojiSamples({
      api,
      channelId,
      samples: picked,
      useRichMessage: hasRichApi,
      log
    });
    samplesSent = customEmojiDrop.sentCount;
  } else {
    const toDrop = sampleStickers.slice(0, maxSamples);
    for (const st of toDrop) {
      if (!st?.file_id || typeof api?.sendSticker !== 'function') continue;
      try {
        await api.sendSticker(channelId, st.file_id);
        samplesSent += 1;
      } catch (stErr) {
        log?.warn?.({ err: stErr?.message, channelId }, 'sample sticker send skipped');
      }
      if (sampleDelayMs > 0) await sleep(sampleDelayMs);
    }
  }

  return {
    ok: true,
    usedRichMessage,
    cardMessage,
    samplesSent,
    customEmojiDrop
  };
}

/**
 * Extracts a clean character name from title or query.
 */
export function extractCharacterName(raw = '') {
  return String(raw || '')
    .replace(/^ᥫ᭡[^\s-]+\s*-\s*/, '')
    .replace(/^(?:lancy\s*-\s*)/i, '')
    .replace(/\s*(?:custom\s*emojis?|emojis?|stickers?|collection|wa\s*import|part\s*\d+|pack)/gi, '')
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .trim() || 'Stickers';
}

/**
 * Aesthetic character-tailored fallback descriptions.
 */
export function getFallbackCharacterDescription(characterName = '', stickerKind = 'regular') {
  const lower = String(characterName || '').toLowerCase();
  if (lower.includes('tanjiro') || lower.includes('demon') || lower.includes('kamado') || lower.includes('kimetsu') || lower.includes('slayer')) {
    return 'A fresh demon-slayer pack filled with funny\nreactions, emotional moments, battles & vibes. ⚔️🔥';
  }
  if (lower.includes('toji')) {
    return 'Cold-blooded sorcerer killer aura, swagger smirks, and unhinged combat energy. 🗡️⚡';
  }
  if (lower.includes('escanor')) {
    return 'Peak Lion Sin of Pride majesty, unyielding solar arrogance, and untouchable strength. ☀️🦁';
  }
  if (lower.includes('gojo')) {
    return 'The limitless honored one, smug blindfolded smirks, and peak domain swagger. 🤞🏼✨';
  }
  if (lower.includes('sukuna')) {
    return 'Cursed king malevolence, four-eyed smirks, and demonic slaughter moods. 🩸🔥';
  }
  if (lower.includes('anime') || lower.includes('manga')) {
    return 'Peak anime aura featuring iconic reactions, cocky smirks, and expressive moods. 🫶🏼💫';
  }
  if (lower.includes('cat') || lower.includes('kitty') || lower.includes('cute')) {
    return 'Soft pastel aesthetics, heartwarming reactions, and darling cozy moments. 🐾🌸';
  }
  if (stickerKind === 'custom_emoji') {
    return 'Upgrade your chats with adorable\nanimated emojis, expressive reactions,\nand dreamy aesthetics. 🌷💗';
  }
  return 'Upgrade your chats with expressive\nstickers, iconic moods,\nand dreamy aesthetics. 🌷💗';
}

/**
 * Converts a sticker WebP/image buffer into a crisp 800x800 PNG photo buffer for Telegram.
 */
export async function prepareStickerPhotoBuffer(sampleBuf) {
  if (!sampleBuf || !Buffer.isBuffer(sampleBuf)) return null;
  try {
    return await sharp(sampleBuf, { failOn: 'none', page: 0 })
      .resize(800, 800, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .png({ quality: 100 })
      .toBuffer();
  } catch {
    try {
      return await sharp(sampleBuf, { failOn: 'none', page: 0 }).png().toBuffer();
    } catch {
      return null;
    }
  }
}

/**
 * Telegram Channel Post Screen — wizard to select packs (Custom Emoji & Sticker),
 * multi-select verified channels (main & clone bots), customize designs/fonts/AI vibe,
 * and broadcast a single unified card + 2 sample emojis/stickers.
 */
export function createChannelPostScreen({ app }) {
  const id = 'channel_post';
  const log = logger().child({ screen: 'channel-post' });

  const selections = new Map();

  function getTemplateStore(userId) {
    return new TemplateStore(app.db, { userId: Number(userId) });
  }

  function getSelection(tgId) {
    const key = String(tgId);
    let sel = selections.get(key);
    if (!sel) {
      const store = getTemplateStore(tgId);
      sel = {
        packId: null,
        pack: null,
        packFilter: 'all', // 'all' | 'custom_emoji' | 'regular'
        channelIds: [],
        channelId: null,
        channel: null,
        templateName: store.getDefaultName() || 'bloom_crating',
        fontStyle: 'math_bold_italic',
        quoteMode: 'quote', // 'quote' | 'expandable' | 'plain'
        aiDescription: null,
        aiTagline: null,
        aiVibes: '100%',
        customTemplateText: null,
        caption: null,
        lastAiPrompt: null,
        templateListCache: [],
        page: 0
      };
      selections.set(key, sel);
    }
    return sel;
  }

  function clearSelection(tgId) {
    selections.delete(String(tgId));
  }

  function getSelectedChannels(sel) {
    const ids = sel.channelIds?.length
      ? sel.channelIds
      : (sel.channelId ? [sel.channelId] : []);
    const out = [];
    for (const cid of ids) {
      const row = app.db?.getTelegramChannel?.(cid)
        || (sel.channel && Number(sel.channel.channel_id) === Number(cid) ? sel.channel : null);
      if (row) out.push(row);
    }
    return out;
  }

  function buildEffectiveCaption(tgId, sel, botUser) {
    if (sel.caption) return sel.caption;
    const p = normalizePack(sel.pack);
    if (!p) return '';
    const store = getTemplateStore(tgId);
    const charName = extractCharacterName(p.query || p.title);
    const desc = sel.aiDescription || getFallbackCharacterDescription(charName, p.stickerKind);
    return renderChannelPackCardCaption({
      title: p.title,
      character: charName,
      count: p.count,
      packsCount: 1,
      stickerKind: p.stickerKind,
      description: desc,
      tagline: sel.aiTagline || '',
      vibes: sel.aiVibes || '100%',
      creatorLabel: botUser ? `${botUser}` : 'lancy aesthetic',
      templateName: sel.templateName || 'bloom_crating',
      fontStyle: sel.fontStyle || 'math_bold_italic',
      templateStore: store,
      customTemplateText: sel.customTemplateText || null
    });
  }

  async function editOrSend(ctx, rich, files = null) {
    if (typeof ctx?.editScreen === 'function') {
      return ctx.editScreen(rich, {}, files);
    }
    const api = ctx?.api || ctx?.bot?.api || app.telegram?.api;
    const chatId = ctx?.chat?.id ?? ctx?.chatId ?? ctx?.from?.id ?? ctx?.tgId;
    const messageId = ctx?.message?.message_id ?? ctx?.messageId ?? ctx?.sm?.context?.(ctx?.tgId)?.screenMessageId;
    if (messageId && chatId) {
      try {
        return await api.editMessageRich(chatId, messageId, rich, {}, files);
      } catch (err) {
        if (!/message is not modified/i.test(err?.message)) {
          return await api.sendRichMessage(chatId, rich, {}, files);
        }
        return;
      }
    }
    if (chatId) {
      return await api.sendRichMessage(chatId, rich, {}, files);
    }
  }

  // ── Step 1: Pack Picker ────────────────────────────────────────────────
  async function renderPackPicker(ctx) {
    const tgId = String(ctx.tgId);
    const userId = Number(tgId);
    const sel = getSelection(tgId);
    const limit = 6;
    const offset = (sel.page || 0) * limit;

    let allRows = [];
    if (app.db?.all) {
      if (sel.packFilter === 'custom_emoji') {
        allRows = app.db.all(
          "SELECT * FROM sticker_packs WHERE user_id = ? AND sticker_kind = 'custom_emoji' ORDER BY modified_at DESC",
          userId
        );
      } else if (sel.packFilter === 'regular') {
        allRows = app.db.all(
          "SELECT * FROM sticker_packs WHERE user_id = ? AND COALESCE(sticker_kind, 'regular') != 'custom_emoji' ORDER BY modified_at DESC",
          userId
        );
      } else {
        allRows = app.db.all(
          'SELECT * FROM sticker_packs WHERE user_id = ? ORDER BY modified_at DESC',
          userId
        );
      }
    }
    if (!allRows.length && app.packs?.listPacks) {
      const listed = app.packs.listPacks(userId, { limit: 50, offset: 0 });
      allRows = (listed?.packs || []).filter((raw) => {
        const k = raw.stickerKind || raw.sticker_kind || 'regular';
        if (sel.packFilter === 'custom_emoji') return k === 'custom_emoji';
        if (sel.packFilter === 'regular') return k !== 'custom_emoji';
        return true;
      });
    }
    if (!allRows.length && offset === 0 && app.db?.all) {
      const globalSql = sel.packFilter === 'custom_emoji'
        ? "SELECT * FROM sticker_packs WHERE sticker_kind = 'custom_emoji' ORDER BY modified_at DESC LIMIT 20"
        : (sel.packFilter === 'regular'
          ? "SELECT * FROM sticker_packs WHERE COALESCE(sticker_kind, 'regular') != 'custom_emoji' ORDER BY modified_at DESC LIMIT 20"
          : 'SELECT * FROM sticker_packs ORDER BY modified_at DESC LIMIT 20');
      allRows = app.db.all(globalSql);
    }

    const total = allRows.length;
    const packs = allRows.slice(offset, offset + limit);

    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '𓆩♡𓆪 POST TO TELEGRAM CHANNEL 𓆩♡𓆪',
      'step 1 of 3 — pick emoji or sticker pack ♡'
    ])));
    b.divider();

    b.buttons([
      richButton.callback(sel.packFilter === 'all' ? '🔘 All' : 'All', encodeCallback(id, 'filter_kind', 'all')),
      richButton.callback(sel.packFilter === 'custom_emoji' ? '🔘 ✨ Emojis' : '✨ Emojis', encodeCallback(id, 'filter_kind', 'custom_emoji')),
      richButton.callback(sel.packFilter === 'regular' ? '🔘 🎀 Stickers' : '🎀 Stickers', encodeCallback(id, 'filter_kind', 'regular'))
    ]);

    if (!packs.length) {
      b.paragraph(rt.italic('no matching packs found yet!'));
      b.paragraph(rt.text('create an emoji or sticker pack first using Custom Emoji Studio or TG Stickers ♡'));
      b.divider();
      b.buttons([
        richButton.callback('✨ Custom Emojis', encodeCallback('cemoji', 'open'), { style: 'primary' }),
        richButton.callback('🎀 TG Stickers', encodeCallback('stickers', 'open'), { style: 'primary' })
      ]);
      b.buttons(navButtons(id, { back: true, home: true }));
      b.validate();
      return editOrSend(ctx, b.toJSON());
    }

    b.paragraph(rt.italic('choose the pack to broadcast to your channel(s):'));

    for (const rawP of packs) {
      const p = normalizePack(rawP);
      const isSelected = sel.packId === p.id;
      const radio = isSelected ? '🔘' : '⚪';
      const badge = p.stickerKind === 'custom_emoji' ? '✨' : '🎀';
      const label = `${radio} ${badge} ${p.title} (${p.count ?? 0})`;
      b.buttons([
        richButton.callback(label, encodeCallback(id, 'select_pack', p.id), {
          style: isSelected ? 'success' : 'primary'
        })
      ]);
    }

    const pageButtons = [];
    if (offset > 0) pageButtons.push(richButton.callback('« Prev', encodeCallback(id, 'page_prev')));
    if (offset + limit < total) pageButtons.push(richButton.callback('Next »', encodeCallback(id, 'page_next')));
    if (pageButtons.length > 0) b.buttons(pageButtons);

    b.divider();
    if (sel.pack) {
      b.buttons([
        richButton.callback('Next: Select Channel(s) ➔', encodeCallback(id, 'to_channels'), { style: 'success' })
      ]);
    }

    b.buttons([
      richButton.callback('✨ Emojis', encodeCallback('cemoji', 'open')),
      richButton.callback('🎀 Stickers', encodeCallback('stickers', 'open')),
      richButton.callback('🏠 Home', encodeCallback('dashboard', 'open'))
    ]);
    b.validate();
    return editOrSend(ctx, b.toJSON());
  }

  // ── Step 2: Multi-Select Channel Picker ───────────────────────────────
  async function renderChannelPicker(ctx, { notice = null } = {}) {
    const tgId = String(ctx.tgId);
    const userId = Number(tgId);
    const sel = getSelection(tgId);
    const api = ctx.api || app.telegram?.api;
    const botUser = ctx?.bot?.botUsername || api?.me?.username || app.telegram?.botUsername || 'Lancy_easy_bot';

    const b = new RichMessageBuilder();
    b.bannerHeader([
      '𓆩♡𓆪 SELECT TELEGRAM CHANNELS 𓆩♡𓆪',
      'step 2 of 3 — tap to multi-select verified targets'
    ], { size: 1 });

    if (sel.pack) {
      const np = normalizePack(sel.pack);
      const noun = np.stickerKind === 'custom_emoji' ? 'emojis' : 'stickers';
      b.paragraph(rt.concat(
        rt.bold('Selected Pack: '),
        rt.text(`${np.stickerKind === 'custom_emoji' ? '✨' : '🎀'} ${np.title} (${np.count} ${noun})`)
      ));
    }

    if (notice) {
      b.quote(notice);
    }

    const channels = await listVerifiedAdminChannels({
      db: app.db,
      api,
      settings: app.settings,
      controller: ctx.controller,
      userId
    });

    const accessibleSet = new Set(channels.map((c) => Number(c.channel_id)));
    sel.channelIds = (sel.channelIds || []).filter((cid) => accessibleSet.has(Number(cid)));

    if (!channels.length) {
      b.paragraph(rt.bold('ℹ️ No connected channels found yet!'));
      b.quote(rt.concat(
        rt.bold(`To connect channel(s) for @${botUser}:\n`),
        rt.text(`1. Add @${botUser} as an `), rt.bold('Administrator'), rt.text(' with "Post Messages" permission.\n'),
        rt.text('2. Tap "➕ Add Channel(s)" below and send one or more @usernames / channel IDs, or forward posts from your channels! ♡')
      ));
    } else {
      const countSelected = sel.channelIds.length;
      b.paragraph(rt.italic(`tap to toggle targets (${countSelected}/${channels.length} selected for @${botUser}):`));
      for (const ch of channels) {
        const isSelected = sel.channelIds.some((cid) => Number(cid) === Number(ch.channel_id));
        const check = isSelected ? '☑️' : '⬜';
        const botTag = ch.botVerified === true ? '✓' : (ch.botVerified === false ? '⚠️' : '•');
        const tag = ch.username ? `@${ch.username}` : `ID:${ch.channel_id}`;
        const label = `${check} ${botTag} ${ch.title} (${tag})`;
        b.buttons([
          richButton.callback(label.slice(0, 60), encodeCallback(id, 'select_channel', ch.channel_id), {
            style: isSelected ? 'success' : 'primary'
          })
        ]);
      }
      b.buttons([
        richButton.callback('☑️ Select All', encodeCallback(id, 'select_all_ch')),
        richButton.callback('⬜ Clear', encodeCallback(id, 'clear_ch')),
        richButton.callback(`🛡 Verify @${botUser.slice(0, 14)}`, encodeCallback(id, 'verify_all_ch'))
      ]);
    }

    b.divider();
    b.buttons([
      richButton.callback('➕ Add Channel(s)', encodeCallback(id, 'add_channel'), { style: 'primary' }),
      richButton.callback('🔄 Refresh', encodeCallback(id, 'refresh_channels'))
    ]);

    if (sel.channelIds.length > 0) {
      b.buttons([
        richButton.callback(`Next: Design & Preview (${sel.channelIds.length}) ➔`, encodeCallback(id, 'to_preview'), { style: 'success' })
      ]);
    }

    b.buttons([
      richButton.callback('📡 Broadcast Any Content (Media / Album / GCs)', encodeCallback('broadcast', 'open'), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('« Change Pack', encodeCallback(id, 'to_packs')),
      richButton.callback('🏠 Home', encodeCallback('dashboard', 'open'))
    ]);
    b.validate();
    return editOrSend(ctx, b.toJSON());
  }

  // ── Step 3: Design / Font / AI Preview Designer ───────────────────────
  async function renderPreview(ctx, { statusNote = null } = {}) {
    const tgId = String(ctx.tgId);
    const sel = getSelection(tgId);
    const api = ctx?.api || app.telegram?.api;
    const botUser = ctx?.bot?.botUsername || ctx?.bot?.username || api?.me?.username || app.telegram?.botUsername || 'Lancy_easy_bot';

    const p = normalizePack(sel.pack);
    const selectedChannels = getSelectedChannels(sel);
    const noun = p?.stickerKind === 'custom_emoji' ? 'custom emojis' : 'stickers';

    const hasVideo = p?.stickerType === 'video'
      || Boolean(app.db?.get?.("SELECT id FROM sticker_items WHERE pack_id = ? AND (type = 'video' OR item_format = 'video') LIMIT 1", p?.id));
    const heroLabel = hasVideo ? '🎬 Video/MP4 Emoji First' : '🖼 Static Emoji/Sticker Pic';

    if (!sel.caption && !sel.aiDescription && p) {
      const charName = extractCharacterName(p.query || p.title);
      let aiDesc = '';
      try {
        aiDesc = await app.captions?.generateAbout?.(charName, { aiService: app.ai });
      } catch {}
      if (!aiDesc || aiDesc.includes('A fresh pack filled with')) {
        aiDesc = getFallbackCharacterDescription(charName, p.stickerKind);
      }
      sel.aiDescription = aiDesc;
    }

    const renderedCaption = buildEffectiveCaption(tgId, sel, botUser);

    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '𓆩♡𓆪 CARD STUDIO & PREVIEW 𓆩♡𓆪',
      'step 3 of 3 — design, style with AI & publish ♡'
    ])));
    b.divider();

    const chListSummary = selectedChannels.length
      ? selectedChannels.map((c) => c.username ? `@${c.username}` : c.title).join(', ')
      : 'None selected';

    b.paragraph(rt.concat(
      rt.bold('📦 Pack: '), rt.text(`${p?.title ?? 'Pack'} (${p?.count ?? 0} ${noun})\n`),
      rt.bold(`📢 Channels (${selectedChannels.length}): `), rt.text(`${chListSummary.slice(0, 120)}\n`),
      rt.bold('🎥 Media: '), rt.text(`${heroLabel}  •  +2 sample drop\n`),
      rt.bold('🎨 Style: '), rt.text(`${sel.customTemplateText ? '✨ AI Custom' : sel.templateName}  |  🔤 ${getFontLabel(sel.fontStyle)}`)
    ));

    if (statusNote) {
      b.paragraph(rt.bold(statusNote));
    }

    b.divider();
    b.heading('💬 LIVE SINGLE-CARD PREVIEW', 3);
    b.blockquote(renderedCaption || 'No caption set');

    b.divider();
    b.buttons([
      richButton.callback(`🚀 POST TO ${selectedChannels.length || 1} CHANNEL${selectedChannels.length > 1 ? 'S' : ''}`, encodeCallback(id, 'post_confirm'), { style: 'success' })
    ]);
    b.buttons([
      richButton.callback(`🎨 Design: ${sel.templateName.slice(0, 12)}`, encodeCallback(id, 'open_designs'), { style: 'primary' }),
      richButton.callback('🔤 Font', encodeCallback(id, 'cycle_font'), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('✨ AI Redesign', encodeCallback(id, 'ai_redesign'), { style: 'primary' }),
      richButton.callback('🪄 AI Prompt', encodeCallback(id, 'ai_prompt'), { style: 'primary' })
    ]);
    const quoteLabel = sel.quoteMode === 'expandable' ? 'Expandable' : (sel.quoteMode === 'plain' ? 'Plain' : 'Quote');
    b.buttons([
      richButton.callback(`💬 Box: ${quoteLabel}`, encodeCallback(id, 'cycle_quote')),
      richButton.callback('💾 Save Design', encodeCallback(id, 'save_template'))
    ]);
    b.buttons([
      richButton.callback('✎ Edit Caption', encodeCallback(id, 'edit_caption')),
      richButton.callback('🏷 Reset', encodeCallback(id, 'reset_caption'))
    ]);
    b.buttons([
      richButton.callback('« Channels', encodeCallback(id, 'to_channels')),
      richButton.callback('« Packs', encodeCallback(id, 'to_packs')),
      richButton.callback('✕ Cancel', encodeCallback(id, 'cancel'), { style: 'danger' })
    ]);
    b.validate();
    return editOrSend(ctx, b.toJSON());
  }

  // ── Unlimited Design / Template Picker ─────────────────────────────────
  async function renderDesignPicker(ctx) {
    const tgId = String(ctx.tgId);
    const sel = getSelection(tgId);
    const store = getTemplateStore(tgId);
    const allTemplates = store.list();
    sel.templateListCache = allTemplates.map((t) => t.name);

    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '🎨 CARD DESIGNS & TEMPLATES',
      'unlimited built-in + custom AI templates ♡'
    ])));
    b.divider();
    b.paragraph(rt.italic('tap any design below to preview it live:'));

    for (let i = 0; i < Math.min(allTemplates.length, 16); i++) {
      const t = allTemplates[i];
      const active = sel.templateName === t.name && !sel.customTemplateText;
      const badge = t.builtin ? '✨' : '💾';
      const defMark = t.is_default ? ' ★' : '';
      const label = `${active ? '🔘' : '⚪'} ${badge} ${t.name}${defMark}`;
      b.buttons([
        richButton.callback(label.slice(0, 44), encodeCallback(id, 'sel_tmpl', String(i)), {
          style: active ? 'success' : 'primary'
        }),
        ...(t.builtin ? [] : [richButton.callback('🗑', encodeCallback(id, 'del_tmpl', String(i)), { style: 'danger' })])
      ]);
    }

    b.divider();
    b.buttons([
      richButton.callback('✨ AI Craft New Design', encodeCallback(id, 'ai_prompt'), { style: 'primary' }),
      richButton.callback('💾 Save Current Design', encodeCallback(id, 'save_template'))
    ]);
    b.buttons([
      richButton.callback('« Back to Preview', encodeCallback(id, 'to_preview'))
    ]);
    b.validate();
    return editOrSend(ctx, b.toJSON());
  }

  // ── AI Card Stylist (with deterministic fallback if AI disabled) ──────
  async function applyAiRedesign(tgId, sel, { customPrompt = '' } = {}) {
    const p = normalizePack(sel.pack);
    const charName = extractCharacterName(p?.query || p?.title || 'Lancy');
    const isCustomEmoji = p?.stickerKind === 'custom_emoji';
    const userGoal = String(customPrompt || '').trim() || 'refresh vibe, aesthetic box layout, emojis & description';

    if (app.ai) {
      try {
        const prompt = `Design a sleek Telegram channel post card in clean JSON for a ${isCustomEmoji ? 'Custom Emoji' : 'Sticker'} pack titled "${p?.title || charName}".
User styling request: "${userGoal}".
Keep output crisp, high aesthetic, under 650 chars total. You may use box borders (╭─╮ │ ╰─╯ ┌ ├ └ ꒰ა ໒꒱) and variable tokens {{styled_title}}, {{kind_label}}, {{stickers}}, {{packs}}, {{vibes}}, {{description}}, {{footer_smallcaps}}.
Available fontStyle values: math_bold_italic, math_bold, sans_bold, small_caps, script, fraktur, monospace, fullwidth.
Respond with valid JSON ONLY:
{
  "fontStyle": "math_bold_italic",
  "tagline": "short cute 5-8 word vibe line without emojis",
  "description": "2 concise aesthetic sentences with 2 fitting emojis",
  "vibes": "100%",
  "template": "optional full layout string using tokens above, or null"
}`;
        const res = await Promise.race([
          app.ai.generate({
            task: 'description',
            text: prompt,
            context: { query: p?.title || charName, mode: 'channel_card' },
            maxTokens: 320
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('AI timeout')), 7000))
        ]);
        const raw = typeof res === 'object' && res !== null ? (res.text ?? '') : String(res ?? '');
        const match = raw.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          if (parsed.fontStyle && FONT_STYLES.some((f) => f.id === parsed.fontStyle)) {
            sel.fontStyle = parsed.fontStyle;
          }
          if (parsed.tagline && String(parsed.tagline).trim().length > 3) {
            sel.aiTagline = String(parsed.tagline).trim().slice(0, 90);
          }
          if (parsed.description && String(parsed.description).trim().length > 8) {
            sel.aiDescription = String(parsed.description).trim().slice(0, 260);
          }
          if (parsed.vibes) {
            sel.aiVibes = String(parsed.vibes).trim().slice(0, 20);
          }
          if (parsed.template && typeof parsed.template === 'string' && parsed.template.trim().length > 20) {
            sel.customTemplateText = parsed.template.trim();
          } else {
            sel.customTemplateText = null;
          }
          sel.caption = null;
          sel.lastAiPrompt = customPrompt || 'AI Redesign';
          return { usedAi: true };
        }
      } catch (err) {
        log.debug({ err: err?.message }, 'AI card redesign fell back to curated preset rotation');
      }
    }

    const lower = `${charName} ${customPrompt}`.toLowerCase();
    let nextTemplate = sel.templateName;
    let nextFont = sel.fontStyle;
    let nextTagline = sel.aiTagline;
    let nextDesc = sel.aiDescription;

    if (/goth|dark|demon|vamp|black|menac|toji|sukuna/.test(lower)) {
      nextTemplate = 'dark_luxe';
      nextFont = 'fraktur';
      nextTagline = 'dark aura, crisp reactions & untouchable energy';
      nextDesc = 'Sharp dark-luxe reactions and cold main-character energy built for every chat. 🖤🗡️';
    } else if (/cyber|neon|y2k|pixel|glitch|tech/.test(lower)) {
      nextTemplate = 'y2k_pixel';
      nextFont = 'monospace';
      nextTagline = 'y2k glow, neon moods & digital magic';
      nextDesc = 'Retro-futuristic animated flair, hyper-crisp reactions, and electric chat vibes. ⚡👾';
    } else if (/minimal|clean|simple|white/.test(lower)) {
      nextTemplate = 'minimal_pill';
      nextFont = 'small_caps';
      nextTagline = 'pure minimal aesthetics & effortless charm';
      nextDesc = 'Clean, curated essentials made to keep every reply effortless and stylish. 🤍✨';
    } else if (/angel|ribbon|coquette|bow|pearl|pink/.test(lower)) {
      nextTemplate = 'angelic_ribbon';
      nextFont = 'script';
      nextTagline = 'dreamy ribbons, soft sparkle & sweet aesthetics';
      nextDesc = 'Delicate pastel magic, lovable animated moods, and pure coquette charm. 🎀🌷';
    } else {
      const cycle = ['bloom_crating', 'angelic_ribbon', 'minimal_pill', 'dark_luxe', 'y2k_pixel', 'blossom', 'cyber'];
      const idx = cycle.indexOf(sel.templateName);
      nextTemplate = cycle[(idx + 1) % cycle.length];
      const fIdx = FONT_STYLES.findIndex((f) => f.id === sel.fontStyle);
      nextFont = FONT_STYLES[(fIdx + 1) % FONT_STYLES.length].id;
      nextTagline = customPrompt
        ? `${customPrompt.slice(0, 48)} vibes & pure magic`
        : 'curated expressions, crisp art & dreamy chat magic';
      nextDesc = `Stand out in every conversation with hand-picked ${charName} reactions & moods. 🌸✨`;
    }

    sel.templateName = nextTemplate;
    sel.fontStyle = nextFont;
    sel.aiTagline = nextTagline;
    sel.aiDescription = nextDesc;
    sel.customTemplateText = null;
    sel.caption = null;
    sel.lastAiPrompt = customPrompt || 'Curated AI Remix';
    return { usedAi: false };
  }

  // ── Step 4: Single Clean Card + 2-Emoji Drop Broadcast ─────────────────
  async function executeChannelPublish(ctx) {
    const tgId = String(ctx.tgId);
    const sel = getSelection(tgId);
    const api = ctx?.api || app.telegram?.api;
    const chatId = ctx.chatId || ctx.tgId;
    const p = normalizePack(sel.pack);
    const selectedChannels = getSelectedChannels(sel);

    if (!p || !selectedChannels.length) {
      await api.sendMessage(chatId, '<blockquote>✕ Please select both a pack and at least one target channel first ♡</blockquote>', { parse_mode: 'HTML' }).catch(() => {});
      return;
    }

    const bProg = new RichMessageBuilder();
    bProg.paragraph(rt.bold(banner([
      '𓆩♡𓆪 PUBLISHING TO CHANNELS 𓆩♡𓆪',
      `broadcasting to ${selectedChannels.length} channel(s)... ♡`
    ])));
    bProg.divider();
    bProg.paragraph(rt.italic('⏳ Preparing hero emoji/sticker media and 2 sample drops... please wait ♡'));
    bProg.validate();
    await editOrSend(ctx, bProg.toJSON());

    const meInfo = api?.me || await api.getMe().catch(() => null);
    const botUser = ctx?.bot?.botUsername || ctx?.bot?.username || meInfo?.username || app.telegram?.botUsername || 'Lancy_easy_bot';

    try {
      const setName = p.shortName || p.tg_short_name || p.name;
      let set = null;
      let sampleStickers = [];
      let sampleBuf = null;
      let heroVideoRawBuf = null;

      const downloadByFileId = async (fileId) => {
        const fInfo = await api.getFile(fileId).catch(() => null);
        if (!fInfo?.file_path) return null;
        return await api.downloadFile(fInfo.file_path).catch(() => null);
      };

      try {
        if (setName) {
          set = await api.getStickerSet(setName);
        }
        if (set?.stickers?.length) {
          if (!p.count || p.count === 0) {
            p.count = set.stickers.length;
            try {
              app.db.run('UPDATE sticker_packs SET count = ? WHERE id = ?', set.stickers.length, p.id);
            } catch {}
          }
          if (set.sticker_type === 'custom_emoji') {
            p.stickerKind = 'custom_emoji';
            p.sticker_kind = 'custom_emoji';
            p.link = `https://t.me/addemoji/${set.name || setName}`;
            app.customEmojiRegistry?.registerPackSet?.(set, { userId: Number(tgId), source: 'pack' });
            if (p.id && app.db?.run) {
              try {
                for (const st of set.stickers) {
                  if (st?.custom_emoji_id && st?.file_id) {
                    app.db.run(
                      "UPDATE sticker_items SET custom_emoji_id = ? WHERE pack_id = ? AND file_id = ? AND (custom_emoji_id IS NULL OR custom_emoji_id = '')",
                      String(st.custom_emoji_id),
                      p.id,
                      st.file_id
                    );
                  }
                }
              } catch {}
            }
          }

          sampleStickers = pickTwoSamples(set.stickers, { requireCustomEmojiId: p.stickerKind === 'custom_emoji' });
          const firstVid = set.stickers.find((st) => st.is_video && !st.is_animated);
          const firstStatic = set.stickers.find((st) => !st.is_video && !st.is_animated);
          const heroSource = firstVid || firstStatic || set.stickers[0];

          const targetFileId = (!heroSource?.is_animated && heroSource?.file_id)
            ? heroSource.file_id
            : (heroSource?.thumbnail?.file_id || heroSource?.thumb?.file_id || heroSource?.file_id);

          if (firstVid?.file_id) {
            const downloadedVid = await downloadByFileId(firstVid.file_id);
            if (downloadedVid) {
              if (isVideoBuffer(downloadedVid)) {
                heroVideoRawBuf = downloadedVid;
              } else if (!sampleBuf) {
                sampleBuf = downloadedVid;
              }
            }
          }
          if (!heroVideoRawBuf && !sampleBuf && targetFileId) {
            sampleBuf = await downloadByFileId(targetFileId);
          }
        }
      } catch (setErr) {
        log.warn({ err: setErr?.message, setName }, 'could not fetch full sticker set info');
      }

      if (!heroVideoRawBuf && app.packs?.getPackHeroMedia) {
        const heroRes = await app.packs.getPackHeroMedia(p, {
          download: (fileId) => downloadByFileId(fileId)
        }).catch(() => null);
        if (heroRes?.isVideo && heroRes?.buffer && isVideoBuffer(heroRes.buffer)) {
          heroVideoRawBuf = heroRes.buffer;
        } else if (!sampleBuf && heroRes?.buffer) {
          sampleBuf = heroRes.buffer;
        }
      }

      if (!heroVideoRawBuf && !sampleBuf && app.packs?.getStickerBytes) {
        sampleBuf = await app.packs.getStickerBytes(p, 0, {
          download: (fileId) => downloadByFileId(fileId)
        }).catch(() => null);
      }

      if (!sampleStickers.length && p.id && app.db?.all) {
        sampleStickers = pickTwoSamples(
          app.db.all(
            'SELECT file_id, emoji, type, custom_emoji_id, item_format FROM sticker_items WHERE pack_id = ? ORDER BY position ASC LIMIT 100',
            p.id
          ),
          { requireCustomEmojiId: p.stickerKind === 'custom_emoji' }
        );
      }

      const heroMedia = await prepareChannelHeroMedia({
        pack: p,
        heroVideoRawBuf,
        sampleBuf,
        botUser,
        configuredFfmpeg: app.settings?.get?.('media.ffmpegPath') ?? ''
      });

      const rawCaption = buildEffectiveCaption(tgId, sel, botUser);

      const results = [];
      for (const ch of selectedChannels) {
        const channelResult = {
          channel: ch,
          ok: false,
          samplesSent: 0,
          usedRichMessage: false,
          customEmojiDrop: null,
          error: null
        };
        try {
          if (api?.getChat && api?.getChatMember) {
            const preCheck = await verifyBotCanPostInChannel(api, ch.channel_id);
            if (preCheck?.botId) {
              app.db?.recordBotChannelVerification?.({
                bot_id: preCheck.botId,
                channel_id: ch.channel_id,
                bot_username: preCheck.botUsername,
                is_admin: preCheck.isAdmin ? 1 : 0,
                can_post: preCheck.canPost ? 1 : 0
              });
            }
            if (!preCheck?.ok) {
              if (preCheck?.botId) {
                app.db?.markBotChannelUnavailable?.(preCheck.botId, ch.channel_id, { bot_username: preCheck.botUsername });
              }
              throw new Error(
                preCheck?.reason === 'missing_post_permission'
                  ? 'Bot lacks "Post Messages" admin permission in this channel'
                  : 'Bot is not an Administrator in this channel'
              );
            }
          }
          const dropRes = await publishChannelPackDrop({
            api,
            channelId: ch.channel_id,
            channelUsername: ch.username,
            pack: p,
            heroMedia,
            rawCaption,
            quoteMode: sel.quoteMode || 'quote',
            sampleStickers,
            maxSamples: 2,
            log
          });
          channelResult.ok = true;
          channelResult.samplesSent = dropRes.samplesSent;
          channelResult.usedRichMessage = dropRes.usedRichMessage;
          channelResult.customEmojiDrop = dropRes.customEmojiDrop;
        } catch (chErr) {
          channelResult.error = chErr?.message || 'Broadcast failed';
          log.warn({ err: channelResult.error, channelId: ch.channel_id }, 'channel publish failed for target');
        }
        results.push(channelResult);
      }

      const succeeded = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok);
      const richCount = succeeded.filter((r) => r.usedRichMessage).length;

      const bDone = new RichMessageBuilder();
      bDone.paragraph(rt.bold(banner([
        succeeded.length ? '🎉 BROADCAST COMPLETE! 🎉' : '⚠️ BROADCAST FAILED',
        `${succeeded.length}/${results.length} channel(s) updated ♡`
      ])));
      bDone.divider();

      const heroDesc = heroMedia
        ? `${heroMedia.mediaKind === 'video' ? '🎬' : '🖼'} ${heroMedia.resolutionLabel} (${richCount ? 'RichCard • buttons inside' : 'inline card'})`
        : '📝 Text Card';

      const lines = [
        rt.bold('Pack: '), rt.text(`${p.title}\n`),
        rt.bold('Hero Media: '), rt.text(`${heroDesc}\n`),
        rt.bold('Results:\n')
      ];
      for (const r of results) {
        const tag = r.channel.username ? `@${r.channel.username}` : r.channel.title;
        if (r.ok) {
          let dropNote = `${r.samplesSent} sample drop`;
          if (p.stickerKind === 'custom_emoji' && r.customEmojiDrop) {
            const d = r.customEmojiDrop;
            if (d.customVerified === true) {
              dropNote = `✅ ${d.verifiedCount}/${d.expectedCount} custom emoji verified (${d.transport})`;
            } else if (d.customVerified === false) {
              dropNote = d.status === 'stripped'
                ? `⚠️ Telegram stripped custom_emoji in channel (bot needs Fragment collectible username${d.deletedStripped ? ' — plain drop removed' : ''})`
                : `⚠️ custom_emoji ${d.status} (${d.verifiedCount}/${d.expectedCount} verified)`;
            } else {
              dropNote = `${d.sentCount} custom emoji sent (unconfirmed)`;
            }
          }
          lines.push(rt.text(`• ✅ ${tag} — ${r.usedRichMessage ? 'RichCard' : 'Card'} + ${dropNote}\n`));
        } else {
          lines.push(rt.text(`• ✕ ${tag} — ${r.error}\n`));
        }
      }
      bDone.paragraph(rt.concat(...lines));
      bDone.divider();

      const doneButtons = [];
      const firstPub = succeeded.find((r) => r.channel.username)?.channel;
      if (firstPub?.username) {
        doneButtons.push(richButton.url('📢 View Channel', `https://t.me/${firstPub.username}`));
      }
      doneButtons.push(richButton.callback('📢 Post Another', encodeCallback(id, 'open')));
      bDone.buttons(doneButtons);
      bDone.buttons([
        richButton.callback('🏠 Home', encodeCallback('dashboard', 'open'))
      ]);
      bDone.validate();
      await editOrSend(ctx, bDone.toJSON());

      if (!failed.length) clearSelection(tgId);
    } catch (publishErr) {
      log.error({ err: publishErr }, 'failed to post pack to channels');
      const bErr = new RichMessageBuilder();
      bErr.paragraph(rt.bold(banner([
        '✕ PUBLISHING FAILED',
        'could not prepare broadcast ♡'
      ])));
      bErr.divider();
      bErr.quote(rt.concat(
        rt.text('Error: '), rt.italic(publishErr.message || 'Unknown error'), rt.text('\n\n'),
        rt.text('Ensure this bot is Administrator with "Post Messages" enabled in the selected channels! ♡')
      ));
      bErr.divider();
      bErr.buttons([
        richButton.callback('🔄 Try Again', encodeCallback(id, 'to_preview')),
        richButton.callback('« Change Channels', encodeCallback(id, 'to_channels'))
      ]);
      bErr.validate();
      await editOrSend(ctx, bErr.toJSON());
    }
  }

  // ── State Machine Handlers (scoped via registerStateHandlers for clones!) ──
  function registerStateHandlers(sm) {
    if (!sm) return;

    sm.register(States.TG_CHANNEL_INPUT, {
      onMessage: async (sctx, message) => {
        const forwardedChat = message.forward_origin?.chat || message.forward_from_chat || null;
        const rawText = (message.text ?? message.caption ?? '').trim();
        const inputs = forwardedChat?.id
          ? [String(forwardedChat.id)]
          : parseChannelTokens(rawText);

        if (!inputs.length) return false;

        const tgId = String(sctx.tgId);
        const sel = getSelection(tgId);
        const api = sctx?.api || app.telegram?.api;
        const targetChatId = message.chat?.id || sctx.chatId || sctx.tgId;
        const added = [];
        const rejected = [];

        for (const input of inputs.slice(0, 12)) {
          try {
            const check = await verifyBotCanPostInChannel(api, forwardedChat || input);
            if (!check.ok) {
              const botTag = check.botUsername ? `@${check.botUsername}` : 'this bot';
              const title = check.chat?.title || input;
              if (check.reason === 'not_a_channel') {
                rejected.push(`• <b>${escapeHtml(title)}</b> — not a Telegram channel`);
              } else if (check.reason === 'missing_post_permission') {
                rejected.push(`• <b>${escapeHtml(title)}</b> — enable "Post Messages" permission for ${escapeHtml(botTag)}`);
              } else {
                rejected.push(`• <b>${escapeHtml(title)}</b> — make ${escapeHtml(botTag)} an Administrator first`);
              }
              continue;
            }

            const chat = check.chat;
            const callerIsSuperAdmin = isBotSuperAdmin(app.settings || app, Number(tgId), { controller: sctx.controller });
            if (!callerIsSuperAdmin) {
              const callerAdminOk = await verifyChannelAdmin({
                chatId: chat.id,
                fromUser: message.from || sctx.message?.from || { id: Number(tgId) },
                api,
                isOwner: (uid) => sctx.controller?.isOwner?.(uid) ?? false
              });
              if (!callerAdminOk) {
                rejected.push(`• <b>${escapeHtml(chat.title || input)}</b> — only channel admins can link it`);
                continue;
              }
            }

            app.db.recordTelegramChannel({
              channel_id: chat.id,
              title: chat.title || 'Untitled Channel',
              username: chat.username || null,
              can_post: 1,
              added_by: Number(tgId)
            });
            app.db.recordBotChannelVerification?.({
              bot_id: check.botId,
              channel_id: chat.id,
              bot_username: check.botUsername,
              is_admin: 1,
              can_post: 1
            });

            if (!sel.channelIds.some((cid) => Number(cid) === Number(chat.id))) {
              sel.channelIds.push(Number(chat.id));
            }
            sel.channelId = Number(chat.id);
            sel.channel = app.db.getTelegramChannel(chat.id);
            added.push(`✓ <b>${escapeHtml(chat.title || input)}</b>${chat.username ? ` (@${escapeHtml(chat.username)})` : ''}`);
          } catch (err) {
            rejected.push(`• <b>${escapeHtml(input)}</b> — ${escapeHtml(err?.message || 'not found')}`);
          }
        }

        if (!added.length && rejected.length) {
          await api.sendMessage(
            targetChatId,
            `<blockquote>✕ Could not connect channel(s):\n${rejected.join('\n')}\n\nFix permissions and send again, or tap Cancel ♡</blockquote>`,
            { parse_mode: 'HTML' }
          ).catch(() => {});
          return true;
        }

        const summaryParts = [];
        if (added.length) summaryParts.push(`Connected (${added.length}):\n${added.join('\n')}`);
        if (rejected.length) summaryParts.push(`Skipped (${rejected.length}):\n${rejected.join('\n')}`);
        await sm.reset(tgId, { reason: 'channel-connected' });
        await renderChannelPicker(
          { ...sctx, tgId, api, chatId: targetChatId },
          { notice: summaryParts.join('\n\n').replace(/<[^>]+>/g, '') }
        );
        return true;
      },
      onTimeout: async (sctx) => {
        const api = sctx?.api || app.telegram?.api;
        await api.sendMessage(sctx.chatId, '<blockquote>♡ Channel input timed out ♡</blockquote>', { parse_mode: 'HTML' }).catch(() => {});
      }
    });

    sm.register(States.TG_CHANNEL_CAPTION_INPUT, {
      onMessage: async (sctx, message) => {
        const text = (message.text ?? message.caption ?? '').trim();
        if (!text) return false;
        const tgId = String(sctx.tgId);
        const sel = getSelection(tgId);
        const api = sctx?.api || app.telegram?.api;
        const targetChatId = message.chat?.id || sctx.chatId || sctx.tgId;
        sel.caption = text;
        await sm.reset(tgId, { reason: 'caption-saved' });
        await renderPreview({ ...sctx, tgId, api, chatId: targetChatId }, { statusNote: '✓ Custom caption updated!' });
        return true;
      },
      onTimeout: async (sctx) => {
        const api = sctx?.api || app.telegram?.api;
        await api.sendMessage(sctx.chatId, '<blockquote>♡ Caption input timed out ♡</blockquote>', { parse_mode: 'HTML' }).catch(() => {});
      }
    });

    sm.register(States.TG_CHANNEL_AI_PROMPT, {
      onMessage: async (sctx, message) => {
        const text = (message.text ?? message.caption ?? '').trim();
        if (!text) return false;
        const tgId = String(sctx.tgId);
        const sel = getSelection(tgId);
        const api = sctx?.api || app.telegram?.api;
        const targetChatId = message.chat?.id || sctx.chatId || sctx.tgId;
        const res = await applyAiRedesign(tgId, sel, { customPrompt: text });
        await sm.reset(tgId, { reason: 'ai-card-styled' });
        await renderPreview(
          { ...sctx, tgId, api, chatId: targetChatId },
          { statusNote: res.usedAi ? '✨ AI crafted your new card design!' : '✨ Aesthetic theme styled from your prompt!' }
        );
        return true;
      },
      onTimeout: async (sctx) => {
        const api = sctx?.api || app.telegram?.api;
        await api.sendMessage(sctx.chatId, '<blockquote>♡ AI styling input timed out ♡</blockquote>', { parse_mode: 'HTML' }).catch(() => {});
      }
    });

    sm.register(States.TG_CHANNEL_TEMPLATE_NAME, {
      onMessage: async (sctx, message) => {
        const name = (message.text ?? '').trim().slice(0, 48);
        if (!name) return false;
        const tgId = String(sctx.tgId);
        const sel = getSelection(tgId);
        const api = sctx?.api || app.telegram?.api;
        const targetChatId = message.chat?.id || sctx.chatId || sctx.tgId;
        const store = getTemplateStore(tgId);
        const bodyToSave = sel.customTemplateText || sel.caption || store.get(sel.templateName) || buildEffectiveCaption(tgId, sel, api?.me?.username);
        store.save(name, bodyToSave, { isDefault: false });
        sel.templateName = name;
        sel.customTemplateText = null;
        sel.caption = null;
        await sm.reset(tgId, { reason: 'template-saved' });
        await renderPreview({ ...sctx, tgId, api, chatId: targetChatId }, { statusNote: `💾 Saved template "${name}"!` });
        return true;
      },
      onTimeout: async (sctx) => {
        const api = sctx?.api || app.telegram?.api;
        await api.sendMessage(sctx.chatId, '<blockquote>♡ Template name input timed out ♡</blockquote>', { parse_mode: 'HTML' }).catch(() => {});
      }
    });
  }

  if (app.sm) {
    registerStateHandlers(app.sm);
  }

  // ── Screen Interface ───────────────────────────────────────────────────
  return {
    id,
    registerStateHandlers,
    async open(ctx) {
      const tgId = String(ctx.tgId);
      const sel = getSelection(tgId);
      sel.page = 0;
      await renderPackPicker(ctx);
    },
    async openWithPack(ctx, rawPack) {
      const tgId = String(ctx.tgId);
      const sel = getSelection(tgId);
      const np = normalizePack(rawPack);
      sel.packId = np?.id ?? null;
      sel.pack = np;
      sel.caption = null;
      sel.aiDescription = null;
      sel.aiTagline = null;
      sel.customTemplateText = null;
      return renderChannelPicker(ctx);
    },
    async handle(ctx, action, args = []) {
      const tgId = String(ctx.tgId);
      const sel = getSelection(tgId);
      const sm = ctx.sm || app.sm;

      switch (action) {
        case 'open':
        case 'to_packs':
          return renderPackPicker(ctx);

        case 'filter_kind':
          sel.packFilter = args[0] || 'all';
          sel.page = 0;
          return renderPackPicker(ctx);

        case 'page_prev':
          sel.page = Math.max(0, (sel.page || 0) - 1);
          return renderPackPicker(ctx);

        case 'page_next':
          sel.page = (sel.page || 0) + 1;
          return renderPackPicker(ctx);

        case 'pack': {
          const packId = Number(args[0]);
          sel.packId = packId;
          const rawPack = app.packs?.getPack?.(Number(tgId), packId) || app.db.get('SELECT * FROM sticker_packs WHERE id = ?', packId);
          sel.pack = normalizePack(rawPack);
          sel.caption = null;
          sel.aiDescription = null;
          sel.aiTagline = null;
          return renderChannelPicker(ctx);
        }

        case 'select_pack': {
          const packId = Number(args[0]);
          sel.packId = packId;
          const rawPack = app.packs?.getPack?.(Number(tgId), packId) || app.db.get('SELECT * FROM sticker_packs WHERE id = ?', packId);
          sel.pack = normalizePack(rawPack);
          sel.caption = null;
          sel.aiDescription = null;
          sel.aiTagline = null;
          return renderPackPicker(ctx);
        }

        case 'to_channels':
        case 'refresh_channels':
          return renderChannelPicker(ctx);

        case 'select_channel': {
          const channelId = Number(args[0]);
          const api = ctx.api || app.telegram?.api;
          const callerOk = await canAccessChannelInMenu({
            db: app.db,
            api,
            settings: app.settings,
            controller: ctx.controller,
            userId: Number(tgId),
            channelId,
            fromUser: ctx.query?.from || ctx.message?.from || { id: Number(tgId) }
          });
          if (!callerOk) {
            if (ctx.query?.id) {
              await api?.answerCallbackQuery?.(ctx.query.id, {
                text: '🔒 Only channel administrators or Bot Super Admins can select this channel.',
                showAlert: true
              })?.catch?.(() => {});
            }
            return renderChannelPicker(ctx);
          }
          const idx = sel.channelIds.findIndex((cid) => Number(cid) === channelId);
          if (idx >= 0) {
            sel.channelIds.splice(idx, 1);
          } else {
            sel.channelIds.push(channelId);
          }
          sel.channelId = sel.channelIds[0] ?? null;
          sel.channel = sel.channelId ? app.db.getTelegramChannel(sel.channelId) : null;
          return renderChannelPicker(ctx);
        }

        case 'select_all_ch': {
          const api = ctx.api || app.telegram?.api;
          const channels = await listVerifiedAdminChannels({
            db: app.db,
            api,
            settings: app.settings,
            controller: ctx.controller,
            userId: Number(tgId)
          });
          sel.channelIds = channels.map((c) => Number(c.channel_id));
          sel.channelId = sel.channelIds[0] ?? null;
          sel.channel = channels[0] ?? null;
          return renderChannelPicker(ctx);
        }

        case 'clear_ch':
          sel.channelIds = [];
          sel.channelId = null;
          sel.channel = null;
          return renderChannelPicker(ctx);

        case 'verify_all_ch': {
          const api = ctx.api || app.telegram?.api;
          const channels = await listVerifiedAdminChannels({
            db: app.db,
            api,
            settings: app.settings,
            controller: ctx.controller,
            userId: Number(tgId)
          });
          let okCount = 0;
          let failCount = 0;
          for (const ch of channels) {
            const check = await verifyBotCanPostInChannel(api, ch.channel_id).catch(() => ({ ok: false }));
            if (check?.botId) {
              app.db.recordBotChannelVerification?.({
                bot_id: check.botId,
                channel_id: ch.channel_id,
                bot_username: check.botUsername,
                is_admin: check.isAdmin ? 1 : 0,
                can_post: check.canPost ? 1 : 0
              });
            }
            if (check?.ok) okCount++;
            else failCount++;
          }
          return renderChannelPicker(ctx, {
            notice: `🛡 Bot check complete: ${okCount} ready, ${failCount} missing admin/post rights.`
          });
        }

        case 'add_channel': {
          await sm?.transition?.(tgId, States.TG_CHANNEL_INPUT, {
            chatId: ctx.chatId,
            screenMessageId: ctx.messageId
          });
          const botUser = ctx?.bot?.botUsername || ctx?.api?.me?.username || app.telegram?.botUsername || 'this bot';
          const b = new RichMessageBuilder();
          b.paragraph(rt.bold(banner([
            '𓆩♡𓆪 ADD TELEGRAM CHANNELS 𓆩♡𓆪',
            'multi-channel + bot admin verification ♡'
          ])));
          b.divider();
          b.quote(rt.concat(
            rt.bold('📢 Send one or more channel @usernames, links, or IDs — or forward any post from your channels!\n\n'),
            rt.text('Multiple example:\n'), rt.code('@ChannelOne @ChannelTwo -1001234567890'), rt.text('\n\n'),
            rt.italic(`⚠️ Make sure @${botUser} is already an Administrator with "Post Messages" enabled in each channel! ♡`)
          ));
          b.divider();
          b.buttons([
            richButton.callback('« Cancel', encodeCallback(id, 'to_channels'))
          ]);
          b.validate();
          return editOrSend(ctx, b.toJSON());
        }

        case 'to_preview':
          return renderPreview(ctx);

        case 'open_designs':
          return renderDesignPicker(ctx);

        case 'sel_tmpl': {
          const idx = Number(args[0]);
          const list = sel.templateListCache?.length ? sel.templateListCache : getTemplateStore(tgId).list().map((t) => t.name);
          const name = list[idx];
          if (name) {
            sel.templateName = name;
            sel.customTemplateText = null;
            sel.caption = null;
          }
          return renderPreview(ctx, { statusNote: `🎨 Design set to ${sel.templateName}` });
        }

        case 'del_tmpl': {
          const idx = Number(args[0]);
          const name = sel.templateListCache?.[idx];
          if (name) getTemplateStore(tgId).delete(name);
          if (sel.templateName === name) sel.templateName = 'bloom_crating';
          return renderDesignPicker(ctx);
        }

        case 'cycle_font': {
          const idx = FONT_STYLES.findIndex((f) => f.id === sel.fontStyle);
          const next = FONT_STYLES[(idx + 1) % FONT_STYLES.length];
          sel.fontStyle = next.id;
          sel.caption = null;
          return renderPreview(ctx, { statusNote: `🔤 Font: ${next.label}` });
        }

        case 'cycle_quote': {
          const order = ['quote', 'expandable', 'plain'];
          const idx = order.indexOf(sel.quoteMode || 'quote');
          sel.quoteMode = order[(idx + 1) % order.length];
          return renderPreview(ctx, { statusNote: `💬 Card Container: ${sel.quoteMode}` });
        }

        case 'ai_redesign': {
          const res = await applyAiRedesign(tgId, sel);
          return renderPreview(ctx, {
            statusNote: res.usedAi ? '✨ AI redesigned your card!' : '✨ Restyled to a fresh aesthetic preset!'
          });
        }

        case 'ai_prompt': {
          await sm?.transition?.(tgId, States.TG_CHANNEL_AI_PROMPT, {
            chatId: ctx.chatId,
            screenMessageId: ctx.messageId
          });
          const b = new RichMessageBuilder();
          b.paragraph(rt.bold(banner([
            '🪄 AI CARD STYLIST',
            'describe the exact vibe or layout you want ♡'
          ])));
          b.divider();
          b.quote(rt.concat(
            rt.bold('Tell Lancy AI how to design this card:\n\n'),
            rt.text('Examples:\n• "soft coquette pink ribbon with cute vibe"\n• "dark goth vampire aesthetic with crimson aura"\n• "minimalist clean monochrome card"\n\n'),
            rt.italic(ctx.isGroup ? '💬 Reply to this card or tag @bot with your vibe!' : '💬 Send your aesthetic prompt below!')
          ));
          b.divider();
          b.buttons([
            richButton.callback('« Cancel', encodeCallback(id, 'to_preview'))
          ]);
          b.validate();
          return editOrSend(ctx, b.toJSON());
        }

        case 'save_template': {
          await sm?.transition?.(tgId, States.TG_CHANNEL_TEMPLATE_NAME, {
            chatId: ctx.chatId,
            screenMessageId: ctx.messageId
          });
          const b = new RichMessageBuilder();
          b.paragraph(rt.bold(banner([
            '💾 SAVE CARD TEMPLATE',
            'reuse across unlimited future drops ♡'
          ])));
          b.divider();
          b.quote('Send a short name for this design template (e.g. "Coquette Pink" or "Cyber Glow"):');
          b.divider();
          b.buttons([
            richButton.callback('« Cancel', encodeCallback(id, 'to_preview'))
          ]);
          b.validate();
          return editOrSend(ctx, b.toJSON());
        }

        case 'edit_caption': {
          await sm?.transition?.(tgId, States.TG_CHANNEL_CAPTION_INPUT, {
            chatId: ctx.chatId,
            screenMessageId: ctx.messageId
          });
          const b = new RichMessageBuilder();
          b.paragraph(rt.bold(banner([
            '𓆩♡𓆪 EDIT CAPTION 𓆩♡𓆪',
            'type custom caption ♡'
          ])));
          b.divider();
          b.paragraph(rt.text('Type and send the full custom caption text you want for the channel card below:'));
          b.divider();
          b.buttons([
            richButton.callback('« Cancel', encodeCallback(id, 'to_preview'))
          ]);
          b.validate();
          return editOrSend(ctx, b.toJSON());
        }

        case 'reset_caption': {
          sel.caption = null;
          sel.customTemplateText = null;
          sel.aiDescription = null;
          sel.aiTagline = null;
          sel.templateName = getTemplateStore(tgId).getDefaultName() || 'bloom_crating';
          sel.fontStyle = 'math_bold_italic';
          sel.quoteMode = 'quote';
          return renderPreview(ctx, { statusNote: '🔄 Card design reset to default' });
        }

        case 'post_confirm':
          return executeChannelPublish(ctx);

        case 'cancel':
          clearSelection(tgId);
          return ctx.screens.get('stickers')?.open(ctx) ?? ctx.screens.get('dashboard')?.open(ctx);

        default:
          return renderPackPicker(ctx);
      }
    }
  };
}
