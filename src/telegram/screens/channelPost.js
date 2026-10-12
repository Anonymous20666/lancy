import sharp from 'sharp';
import { RichMessageBuilder, rt, richButton, encodeCallback } from '../rich.js';
import { navButtons, banner, ACCENT, SPARK } from '../ui.js';
import { States } from '../../core/stateMachine.js';
import { sleep } from '../../utils/time.js';
import { logger } from '../../core/logger.js';
import { toMathBold, toMathBoldItalic, buildAestheticStickerCaption } from '../../captions/engine.js';
import { toLoopingPreviewVideo } from '../../media/convert.js';
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
  const title = p.title || p.tg_title || p.query || 'Sticker Pack';
  const link = p.link || (shortName ? `https://t.me/addstickers/${shortName}` : '');
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
    stickerType,
    sticker_type: stickerType,
    query
  };
}

/**
 * Extracts a clean character name from title or query.
 */
export function extractCharacterName(raw = '') {
  return String(raw || '')
    .replace(/^ᥫ᭡[^\s-]+\s*-\s*/, '')
    .replace(/^(?:lancy\s*-\s*)/i, '')
    .replace(/\s*(?:stickers?|collection|wa\s*import|part\s*\d+|pack)/gi, '')
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .trim() || 'Stickers';
}

/**
 * Aesthetic character-tailored fallback descriptions.
 */
export function getFallbackCharacterDescription(characterName = '') {
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
  return 'Curated aesthetic collection featuring expressive moods, iconic reactions, and chat vibes. 🤍✨';
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
 * Telegram Channel Post Screen — wizard to select packs and publish to Telegram channels.
 */
export function createChannelPostScreen({ app }) {
  const id = 'channel_post';
  const log = logger().child({ screen: 'channel-post' });

  // In-memory per-user wizard selection state
  const selections = new Map();

  function getSelection(tgId) {
    const key = String(tgId);
    let sel = selections.get(key);
    if (!sel) {
      sel = {
        packId: null,
        pack: null,
        channelId: null,
        channel: null,
        caption: null,
        page: 0
      };
      selections.set(key, sel);
    }
    return sel;
  }

  function clearSelection(tgId) {
    selections.delete(String(tgId));
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
    const limit = 5;
    const offset = (sel.page || 0) * limit;

    let { packs, total } = app.packs.listPacks(userId, { limit, offset });
    if (!packs.length && offset === 0) {
      // Check if any packs exist globally if user hasn't made any
      const anyRows = app.db.all('SELECT * FROM sticker_packs ORDER BY modified_at DESC LIMIT 5');
      if (anyRows.length) {
        packs = anyRows;
        total = anyRows.length;
      }
    }

    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '𓆩♡𓆪 POST TO TELEGRAM CHANNEL 𓆩♡𓆪',
      'step 1 of 3 — pick sticker pack ♡'
    ])));
    b.divider();

    if (!packs.length) {
      b.paragraph(rt.italic('no sticker packs found yet!'));
      b.paragraph(rt.text('create a sticker pack first using TG Stickers or Pinterest Studio ♡'));
      b.divider();
      b.buttons([
        richButton.callback('🎀 Open TG Stickers', encodeCallback('stickers', 'open'), { style: 'primary' })
      ]);
      b.buttons(navButtons(id, { back: true, home: true }));
      b.validate();
      return editOrSend(ctx, b.toJSON());
    }

    b.paragraph(rt.italic('choose the sticker pack you want to post to your channel:'));

    for (const rawP of packs) {
      const p = normalizePack(rawP);
      const isSelected = sel.packId === p.id;
      const radio = isSelected ? '🔘' : '⚪';
      const label = `${radio} ${p.title} (${p.count ?? 0})`;
      b.buttons([
        richButton.callback(label, encodeCallback(id, 'select_pack', p.id), {
          style: isSelected ? 'success' : 'primary'
        })
      ]);
    }

    // Pagination
    const pageButtons = [];
    if (offset > 0) {
      pageButtons.push(richButton.callback('« Prev', encodeCallback(id, 'page_prev')));
    }
    if (offset + limit < total) {
      pageButtons.push(richButton.callback('Next »', encodeCallback(id, 'page_next')));
    }
    if (pageButtons.length > 0) {
      b.buttons(pageButtons);
    }

    b.divider();
    if (sel.pack) {
      b.buttons([
        richButton.callback('Next: Select Channel ➔', encodeCallback(id, 'to_channels'), { style: 'success' })
      ]);
    }

    b.buttons([
      richButton.callback('« TG Stickers', encodeCallback('stickers', 'open')),
      richButton.callback('🏠 Home', encodeCallback('dashboard', 'open'))
    ]);
    b.validate();
    return editOrSend(ctx, b.toJSON());
  }

  // ── Step 2: Channel Picker ─────────────────────────────────────────────
  async function renderChannelPicker(ctx) {
    const tgId = String(ctx.tgId);
    const userId = Number(tgId);
    const sel = getSelection(tgId);

    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '𓆩♡𓆪 SELECT TELEGRAM CHANNEL 𓆩♡𓆪',
      'step 2 of 3 — pick target channel ♡'
    ])));
    b.divider();

    if (sel.pack) {
      b.paragraph(rt.concat(
        rt.bold('Selected Pack: '),
        rt.text(`${sel.pack.tg_title} (${sel.pack.count} stickers)`)
      ));
      b.spacer();
    }

    const channels = app.db.getTelegramChannels(userId);

    if (!channels.length) {
      b.paragraph(rt.bold('ℹ️ No connected channels found yet!'));
      b.quote(rt.concat(
        rt.bold('To post to a channel:\n'),
        rt.text('1. Add this bot as an '), rt.bold('Administrator'), rt.text(' in your channel.\n'),
        rt.text('2. Tap "➕ Add Channel" below or forward a post from your channel! ♡')
      ));
    } else {
      b.paragraph(rt.italic('choose which channel to broadcast to:'));
      for (const ch of channels) {
        const isSelected = sel.channelId === ch.channel_id;
        const radio = isSelected ? '🔘' : '⚪';
        const tag = ch.username ? `@${ch.username}` : `ID: ${ch.channel_id}`;
        const label = `${radio} 📢 ${ch.title} (${tag})`;
        b.buttons([
          richButton.callback(label, encodeCallback(id, 'select_channel', ch.channel_id), {
            style: isSelected ? 'success' : 'primary'
          })
        ]);
      }
    }

    b.divider();
    b.buttons([
      richButton.callback('➕ Add Channel', encodeCallback(id, 'add_channel'), { style: 'primary' }),
      richButton.callback('🔄 Refresh', encodeCallback(id, 'refresh_channels'))
    ]);

    if (sel.channel) {
      b.buttons([
        richButton.callback('Next: Preview ➔', encodeCallback(id, 'to_preview'), { style: 'success' })
      ]);
    }

    b.buttons([
      richButton.callback('« Change Pack', encodeCallback(id, 'to_packs')),
      richButton.callback('🏠 Home', encodeCallback('dashboard', 'open'))
    ]);
    b.validate();
    return editOrSend(ctx, b.toJSON());
  }

  // ── Step 3: Preview Card ───────────────────────────────────────────────
  async function renderPreview(ctx) {
    const tgId = String(ctx.tgId);
    const sel = getSelection(tgId);
    const botUser = ctx?.bot?.botUsername || ctx?.bot?.username || app.telegram?.botUsername || 'Lancy_easy_bot';

    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '𓆩♡𓆪 READY TO POST 𓆩♡𓆪',
      'step 3 of 3 — review & publish ♡'
    ])));
    b.divider();

    const p = normalizePack(sel.pack);
    const ch = sel.channel;

    b.heading('📦 STICKER PACK', 3);
    b.paragraph(rt.concat(rt.bold('Title: '), rt.text(p?.title ?? 'Sticker Pack')));
    b.paragraph(rt.concat(rt.bold('Total Stickers: '), rt.text(`${p?.count ?? 0} (${(p?.stickerType ?? 'static').toUpperCase()})`)));
    if (p?.link) {
      b.paragraph(rt.concat(rt.bold('Install Link: '), rt.text(p.link)));
    }

    b.divider();
    b.heading('📢 TARGET CHANNEL', 3);
    b.paragraph(rt.concat(rt.bold('Channel: '), rt.text(`${ch?.title ?? 'Channel'} (${ch?.username ? '@' + ch.username : ch?.channel_id})`)));

    b.divider();
    b.heading('✨ PUBLISH SEQUENCE', 3);
    const hasVideo = p?.stickerType === 'video'
      || Boolean(app.db?.get?.("SELECT id FROM sticker_items WHERE pack_id = ? AND type = 'video' LIMIT 1", p?.id))
      || false;
    const heroLabel = hasVideo ? '🎬 Sticker Drop Video' : '🖼 Sticker Drop Photo';
    b.paragraph(rt.text(`1️⃣ ${heroLabel} with AI character blockquote caption\n2️⃣ 🎨 First 3 to 5 sample stickers from the pack\n3️⃣ 🎁 Official pack card with green "➕ Add Sticker Pack 🌸" button`));

    // Default caption if not custom: generate lean character-aware aesthetic card caption
    if (!sel.caption && p) {
      const characterName = extractCharacterName(p.query || p.title);
      let aiDesc = '';
      try {
        aiDesc = await app.captions?.generateAbout?.(characterName, { aiService: app.ai });
      } catch {}
      if (!aiDesc || aiDesc.includes('A fresh pack filled with')) {
        aiDesc = getFallbackCharacterDescription(characterName);
      }
      sel.caption = buildAestheticStickerCaption({
        title: p.title,
        character: characterName,
        count: p.count,
        packsCount: 1,
        description: aiDesc,
        botUser
      });
    }

    b.divider();
    b.heading('💬 CAPTION PREVIEW', 3);
    b.blockquote(sel.caption || 'No caption set');

    b.divider();
    b.buttons([
      richButton.callback('🚀 POST NOW', encodeCallback(id, 'post_confirm'), { style: 'success' })
    ]);
    b.buttons([
      richButton.callback('✎ Edit Caption', encodeCallback(id, 'edit_caption')),
      richButton.callback('🏷 Reset Caption', encodeCallback(id, 'reset_caption'))
    ]);
    b.buttons([
      richButton.callback('« Change Channel', encodeCallback(id, 'to_channels')),
      richButton.callback('« Change Pack', encodeCallback(id, 'to_packs'))
    ]);
    b.buttons([
      richButton.callback('✕ Cancel', encodeCallback(id, 'cancel'), { style: 'danger' })
    ]);
    b.validate();
    return editOrSend(ctx, b.toJSON());
  }

  // ── Step 4: Execute Channel Publish ───────────────────────────────────
  async function executeChannelPublish(ctx) {
    const tgId = String(ctx.tgId);
    const sel = getSelection(tgId);
    const api = ctx?.api || app.telegram?.api;
    const chatId = ctx.chatId || ctx.tgId;
    const p = normalizePack(sel.pack);
    const ch = sel.channel;

    if (!p || !ch) {
      await api.sendMessage(chatId, '<blockquote>✕ Please select both a sticker pack and target channel first ♡</blockquote>', { parse_mode: 'HTML' }).catch(() => {});
      return;
    }

    // Feedback in-place that publishing is executing
    const bProg = new RichMessageBuilder();
    bProg.paragraph(rt.bold(banner([
      '𓆩♡𓆪 PUBLISHING TO CHANNEL 𓆩♡𓆪',
      `sending to ${ch.title}... ♡`
    ])));
    bProg.divider();
    bProg.paragraph(rt.italic('⏳ Preparing sticker drop media and uploading sample stickers... please wait ♡'));
    bProg.validate();
    await editOrSend(ctx, bProg.toJSON());

    const botUser = ctx?.bot?.botUsername || ctx?.bot?.username || (await api.getMe().catch(() => null))?.username || app.telegram?.botUsername || 'Lancy_easy_bot';

    try {
      // 1. Fetch sticker set to retrieve stickers & sample
      const setName = p.shortName || p.tg_short_name || p.name;
      let set = null;
      let sampleStickers = [];
      let sampleBuf = null;
      let heroVideoBuf = null;

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
          sampleStickers = set.stickers.slice(0, Math.min(5, Math.max(3, set.stickers.length)));

          // If the pack contains video stickers, pick one of the videos as the hero preview!
          const videoSticker = set.stickers.find((st) => st.is_video);
          if (videoSticker?.file_id) {
            const fInfo = await api.getFile(videoSticker.file_id).catch(() => null);
            if (fInfo?.file_path) {
              const webmBuf = await api.downloadFile(fInfo.file_path).catch(() => null);
              if (webmBuf) {
                heroVideoBuf = await toLoopingPreviewVideo(webmBuf, {
                  configuredFfmpeg: app.settings?.get('media.ffmpegPath') ?? ''
                }).catch(() => null);
              }
            }
          }

          // Also download the first sticker buffer for static preview/fallback
          const firstSticker = sampleStickers[0];
          const targetFileId = firstSticker?.is_animated && (firstSticker.thumbnail || firstSticker.thumb)
            ? (firstSticker.thumbnail || firstSticker.thumb).file_id
            : firstSticker?.file_id;

          if (targetFileId) {
            const fInfo = await api.getFile(targetFileId);
            if (fInfo?.file_path) {
              sampleBuf = await api.downloadFile(fInfo.file_path).catch(() => null);
            }
          }
        }
      } catch (setErr) {
        log.warn({ err: setErr?.message, setName }, 'could not fetch full sticker set info');
      }

      // Check pack service getPackHeroMedia if hero video was not found via Telegram set
      if (!heroVideoBuf && app.packs?.getPackHeroMedia) {
        const heroRes = await app.packs.getPackHeroMedia(p, {
          download: (fileId) => api.getFile(fileId).then((f) => api.downloadFile(f.file_path)).catch(() => null)
        }).catch(() => null);
        if (heroRes?.isVideo && heroRes?.buffer) {
          heroVideoBuf = heroRes.buffer;
        } else if (!sampleBuf && heroRes?.buffer) {
          sampleBuf = heroRes.buffer;
        }
      }

      // Fallback if sampleBuf not found via API download:
      if (!sampleBuf && app.packs?.getStickerBytes) {
        sampleBuf = await app.packs.getStickerBytes(p, 0, {
          download: (fileId) => api.getFile(fileId).then((f) => api.downloadFile(f.file_path)).catch(() => null)
        }).catch(() => null);
      }

      // 2. Prepare Sticker Drop Photo buffer from the actual sticker
      let stickerPhotoBuf = null;
      if (sampleBuf) {
        stickerPhotoBuf = await prepareStickerPhotoBuffer(sampleBuf).catch(() => null);
      }
      if (!stickerPhotoBuf) {
        // Fallback to banner only if sticker extraction failed completely
        stickerPhotoBuf = await renderChannelBanner({
          title: p.title,
          count: p.count,
          stickerType: p.stickerType,
          sampleBuffer: sampleBuf,
          creator: botUser
        }).catch(() => null);
      }

      // 3. Prepare AI Character Description and Aesthetic Card Caption
      const characterName = extractCharacterName(p.query || p.title);
      let aiDesc = '';
      if (!sel.caption) {
        try {
          aiDesc = await app.captions?.generateAbout?.(characterName, { aiService: app.ai });
        } catch {}
        if (!aiDesc || aiDesc.includes('A fresh pack filled with')) {
          aiDesc = getFallbackCharacterDescription(characterName);
        }
      }

      const dropCaption = sel.caption || buildAestheticStickerCaption({
        title: p.title,
        character: characterName,
        count: p.count,
        packsCount: 1,
        description: aiDesc,
        botUser
      });

      // 4. Post Phase 1: Sticker Hero Media (Video or Photo) with Lean Blockquote Caption + Green Success Button
      const formattedCaption = dropCaption.startsWith('<blockquote>')
        ? dropCaption
        : `<blockquote>${dropCaption}</blockquote>`;
      const mediaPayload = {
        caption: formattedCaption,
        parse_mode: 'HTML'
      };
      if (p.link) {
        mediaPayload.reply_markup = {
          inline_keyboard: [
            [{ text: '➕ Add Sticker Pack 🌸', url: p.link, style: 'success' }]
          ]
        };
      }

      let heroSent = false;
      if (heroVideoBuf) {
        // When pack contains video, use the video as the media with the aesthetic caption!
        try {
          if (typeof api.sendAnimation === 'function') {
            await api.sendAnimation(ch.channel_id, heroVideoBuf, {
              ...mediaPayload,
              filename: 'sticker_drop.mp4',
              contentType: 'video/mp4'
            });
            heroSent = true;
          }
        } catch (animErr) {
          log.warn({ err: animErr?.message }, 'sendAnimation failed, trying sendVideo');
        }

        if (!heroSent && typeof api.sendVideo === 'function') {
          try {
            await api.sendVideo(ch.channel_id, heroVideoBuf, {
              ...mediaPayload,
              filename: 'sticker_drop.mp4',
              contentType: 'video/mp4'
            });
            heroSent = true;
          } catch (vidErr) {
            log.warn({ err: vidErr?.message }, 'sendVideo failed');
          }
        }
      }

      if (!heroSent) {
        if (stickerPhotoBuf) {
          await api.sendPhoto(ch.channel_id, stickerPhotoBuf, {
            ...mediaPayload,
            filename: 'sticker.png',
            contentType: 'image/png'
          });
        } else {
          await api.sendMessage(ch.channel_id, formattedCaption, {
            parse_mode: 'HTML',
            reply_markup: mediaPayload.reply_markup
          });
        }
      }
      await sleep(750);

      // 5. Post Phase 2: First 3 to 5 Sample Stickers
      let sentSampleCount = 0;
      for (const st of sampleStickers) {
        if (!st?.file_id) continue;
        await api.sendSticker(ch.channel_id, st.file_id).catch((err) => {
          log.warn({ err: err?.message, channelId: ch.channel_id }, 'sample sticker send skipped');
        });
        sentSampleCount += 1;
        await sleep(600);
      }

      // 6. Post Phase 3: Official Pack Card with Green Success Button
      const finalMsg = `<blockquote>✨ <b>Click below to add the complete sticker pack to Telegram!</b>\n👉 <a href="${p.link}">${p.title}</a>\n\n🌸 Created with @${botUser} ♡</blockquote>`;
      await api.sendMessage(ch.channel_id, finalMsg, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '➕ Add Sticker Pack 🌸', url: p.link, style: 'success' }]
          ]
        }
      });

      // 7. Victory Card for User
      const bDone = new RichMessageBuilder();
      bDone.paragraph(rt.bold(banner([
        '🎉 SUCCESSFULLY POSTED! 🎉',
        'broadcast completed ♡'
      ])));
      bDone.divider();
      bDone.paragraph(rt.concat(
        rt.bold('Pack: '), rt.text(`${p.title}\n`),
        rt.bold('Channel: '), rt.text(`${ch.title} (${ch.username ? '@' + ch.username : ch.channel_id})\n`),
        rt.bold('Delivered: '), rt.text(`1 Sticker drop photo, ${sentSampleCount} sample stickers, and 1 pack card ♡`)
      ));
      bDone.divider();

      const doneButtons = [];
      if (ch.username) {
        doneButtons.push(richButton.url('📢 View in Channel', `https://t.me/${ch.username}`));
      }
      doneButtons.push(richButton.callback('📢 Post Another', encodeCallback(id, 'open')));
      bDone.buttons(doneButtons);
      bDone.buttons([
        richButton.callback('🏠 Home', encodeCallback('dashboard', 'open'))
      ]);
      bDone.validate();
      await editOrSend(ctx, bDone.toJSON());

      clearSelection(tgId);
    } catch (publishErr) {
      log.error({ err: publishErr, channelId: ch.channel_id }, 'failed to post sticker pack to channel');
      const bErr = new RichMessageBuilder();
      bErr.paragraph(rt.bold(banner([
        '✕ PUBLISHING FAILED',
        'could not post to channel ♡'
      ])));
      bErr.divider();
      bErr.quote(rt.concat(
        rt.text('Telegram returned: '), rt.italic(publishErr.message || 'Unknown error'), rt.text('\n\n'),
        rt.text('Please ensure the bot is still an Administrator in '), rt.bold(ch.title), rt.text(' with "Post Messages" permission enabled! ♡')
      ));
      bErr.divider();
      bErr.buttons([
        richButton.callback('🔄 Try Again', encodeCallback(id, 'to_preview')),
        richButton.callback('« Change Channel', encodeCallback(id, 'to_channels'))
      ]);
      bErr.validate();
      await editOrSend(ctx, bErr.toJSON());
    }
  }

  // ── State Machine Handlers ─────────────────────────────────────────────
  if (app.sm) {
    // 1. Add Channel input handler
    app.sm.register(States.TG_CHANNEL_INPUT, {
      onMessage: async (sctx, message) => {
        let input = (message.text ?? '').trim();
        if (message.forward_from_chat?.id) {
          input = String(message.forward_from_chat.id);
        }

        if (!input) return false;

        const tgId = String(sctx.tgId);
        const sel = getSelection(tgId);
        const api = sctx?.api || app.telegram?.api;
        const targetChatId = message.chat?.id || sctx.chatId || sctx.tgId;

        try {
          const chat = await api.getChat(input);
          if (!chat?.id) throw new Error('Channel not found');

          const me = await api.getMe();
          const member = await api.getChatMember(chat.id, me.id);

          const isAdmin = member.status === 'administrator' || member.status === 'creator';
          if (!isAdmin) {
            await api.sendMessage(
              targetChatId,
              `<blockquote>✕ The bot is not an administrator in <b>${escapeXml(chat.title || input)}</b>!\nPlease make the bot an admin with "Post Messages" permission, then send the @username again ♡</blockquote>`,
              { parse_mode: 'HTML' }
            ).catch(() => {});
            return true;
          }

          app.db.recordTelegramChannel({
            channel_id: chat.id,
            title: chat.title || 'Untitled Channel',
            username: chat.username || null,
            can_post: 1,
            added_by: Number(tgId)
          });

          sel.channelId = chat.id;
          sel.channel = app.db.getTelegramChannel(chat.id);

          await app.sm.reset(tgId, { reason: 'channel-connected' });
          await renderChannelPicker({ ...sctx, tgId, api, chatId: targetChatId });
          return true;
        } catch (err) {
          await api.sendMessage(
            targetChatId,
            `<blockquote>✕ Could not connect channel: <i>${escapeXml(err.message || 'Invalid channel')}</i>\nPlease check the username or channel ID and try again ♡</blockquote>`,
            { parse_mode: 'HTML' }
          ).catch(() => {});
          return true;
        }
      },
      onTimeout: async (sctx) => {
        const api = sctx?.api || app.telegram?.api;
        await api.sendMessage(sctx.chatId, '<blockquote>♡ Channel input timed out ♡</blockquote>', { parse_mode: 'HTML' }).catch(() => {});
      }
    });

    // 2. Custom Caption input handler
    app.sm.register(States.TG_CHANNEL_CAPTION_INPUT, {
      onMessage: async (sctx, message) => {
        const text = (message.text ?? message.caption ?? '').trim();
        if (!text) return false;
        const tgId = String(sctx.tgId);
        const sel = getSelection(tgId);
        const api = sctx?.api || app.telegram?.api;
        const targetChatId = message.chat?.id || sctx.chatId || sctx.tgId;
        sel.caption = text;
        await app.sm.reset(tgId, { reason: 'caption-saved' });
        await renderPreview({ ...sctx, tgId, api, chatId: targetChatId });
        return true;
      },
      onTimeout: async (sctx) => {
        const api = sctx?.api || app.telegram?.api;
        await api.sendMessage(sctx.chatId, '<blockquote>♡ Caption input timed out ♡</blockquote>', { parse_mode: 'HTML' }).catch(() => {});
      }
    });
  }

  // ── Screen Interface ───────────────────────────────────────────────────
  return {
    id,
    async open(ctx) {
      const tgId = String(ctx.tgId);
      const sel = getSelection(tgId);
      sel.page = 0;
      await renderPackPicker(ctx);
    },
    async handle(ctx, action, args = []) {
      const tgId = String(ctx.tgId);
      const sel = getSelection(tgId);

      switch (action) {
        case 'open':
        case 'to_packs':
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
          const rawPack = app.packs.getPack(Number(tgId), packId) || app.db.get('SELECT * FROM sticker_packs WHERE id = ?', packId);
          sel.pack = normalizePack(rawPack);
          return renderChannelPicker(ctx);
        }

        case 'select_pack': {
          const packId = Number(args[0]);
          sel.packId = packId;
          const rawPack = app.packs.getPack(Number(tgId), packId) || app.db.get('SELECT * FROM sticker_packs WHERE id = ?', packId);
          sel.pack = normalizePack(rawPack);
          return renderPackPicker(ctx);
        }

        case 'to_channels':
        case 'refresh_channels':
          return renderChannelPicker(ctx);

        case 'select_channel': {
          const channelId = Number(args[0]);
          sel.channelId = channelId;
          sel.channel = app.db.getTelegramChannel(channelId);
          return renderChannelPicker(ctx);
        }

        case 'add_channel': {
          await app.sm.transition(tgId, States.TG_CHANNEL_INPUT, {
            chatId: ctx.chatId,
            screenMessageId: ctx.messageId
          });
          const b = new RichMessageBuilder();
          b.paragraph(rt.bold(banner([
            '𓆩♡𓆪 ADD TELEGRAM CHANNEL 𓆩♡𓆪',
            'connect destination channel ♡'
          ])));
          b.divider();
          b.quote(rt.concat(
            rt.bold('📢 Send the channel @username, channel ID, or forward any post from your channel here!\n\n'),
            rt.text('Example: '), rt.code('@MyAestheticChannel'), rt.text(' or '), rt.code('-1001234567890'), rt.text('\n\n'),
            rt.italic('⚠️ Make sure the bot has already been added to the channel as an Administrator! ♡')
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

        case 'edit_caption': {
          await app.sm.transition(tgId, States.TG_CHANNEL_CAPTION_INPUT, {
            chatId: ctx.chatId,
            screenMessageId: ctx.messageId
          });
          const b = new RichMessageBuilder();
          b.paragraph(rt.bold(banner([
            '𓆩♡𓆪 EDIT CAPTION 𓆩♡𓆪',
            'type custom caption ♡'
          ])));
          b.divider();
          b.paragraph(rt.text('Type and send the new caption you want for the channel banner post below:'));
          b.divider();
          b.buttons([
            richButton.callback('« Cancel', encodeCallback(id, 'to_preview'))
          ]);
          b.validate();
          return editOrSend(ctx, b.toJSON());
        }

        case 'reset_caption': {
          sel.caption = null;
          return renderPreview(ctx);
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
