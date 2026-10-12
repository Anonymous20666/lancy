import sharp from 'sharp';
import { RichMessageBuilder, rt, richButton, encodeCallback } from '../rich.js';
import { navButtons, banner, ACCENT, SPARK } from '../ui.js';
import { States } from '../../core/stateMachine.js';
import { sleep } from '../../utils/time.js';
import { sanitizeWhatsAppPackName } from '../../whatsapp/publisher.js';
import { logger } from '../../core/logger.js';

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
    const chatId = ctx?.chat?.id ?? ctx?.chatId ?? ctx?.from?.id ?? ctx?.tgId;
    const messageId = ctx?.message?.message_id ?? ctx?.messageId ?? ctx?.sm?.context?.(ctx?.tgId)?.screenMessageId;
    if (messageId && chatId) {
      try {
        return await app.telegram.api.editMessageRich(chatId, messageId, rich, {}, files);
      } catch (err) {
        if (!/message is not modified/i.test(err?.message)) {
          return await app.telegram.api.sendRichMessage(chatId, rich, {}, files);
        }
        return;
      }
    }
    if (chatId) {
      return await app.telegram.api.sendRichMessage(chatId, rich, {}, files);
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

    for (const p of packs) {
      const isSelected = sel.packId === p.id;
      const radio = isSelected ? '🔘' : '⚪';
      const label = `${radio} ${p.tg_title || p.query || 'Pack'} (${p.count ?? 0})`;
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
      b.paragraph(rt.text('To post to a channel:\n1. Make sure you added this bot as an <b>Administrator</b> in your channel.\n2. Tap "➕ Add Channel" below or forward a post from the channel! ♡'));
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
    const botUser = app.telegram?.botUsername || 'Lancy_easy_bot';

    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '𓆩♡𓆪 READY TO POST 𓆩♡𓆪',
      'step 3 of 3 — review & publish ♡'
    ])));
    b.divider();

    const p = sel.pack;
    const ch = sel.channel;

    b.heading('📦 STICKER PACK', 3);
    b.paragraph(rt.concat(rt.bold('Title: '), rt.text(p?.tg_title ?? 'Sticker Pack')));
    b.paragraph(rt.concat(rt.bold('Total Stickers: '), rt.text(`${p?.count ?? 0} (${(p?.sticker_type ?? 'static').toUpperCase()})`)));
    if (p?.link) {
      b.paragraph(rt.concat(rt.bold('Install Link: '), rt.text(p.link)));
    }

    b.divider();
    b.heading('📢 TARGET CHANNEL', 3);
    b.paragraph(rt.concat(rt.bold('Channel: '), rt.text(`${ch?.title ?? 'Channel'} (${ch?.username ? '@' + ch.username : ch?.channel_id})`)));

    b.divider();
    b.heading('✨ PUBLISH SEQUENCE', 3);
    b.paragraph(rt.text('1️⃣ 🖼 High-res Banner Photo with aesthetic caption\n2️⃣ 🎨 First 3 to 5 sample stickers from the pack\n3️⃣ 🎁 Official pack card with 1-tap "➕ Add Sticker Pack" button'));

    // Default caption if not custom
    if (!sel.caption) {
      sel.caption = `✦ <b>${p?.tg_title ?? 'Sticker Pack'}</b> ✦\n📦 <b>${p?.count ?? 0} Stickers</b> • ${(p?.sticker_type ?? 'static').toUpperCase()}\n🔗 <a href="${p?.link}">Add to Telegram</a>\n🌸 Created with @${botUser} ♡`;
    }

    b.divider();
    b.heading('💬 CAPTION PREVIEW', 3);
    b.blockquote(sel.caption);

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
    const chatId = ctx.chatId;
    const p = sel.pack;
    const ch = sel.channel;

    if (!p || !ch) {
      await app.telegram.api.sendMessage(chatId, '<blockquote>✕ Please select both a sticker pack and target channel first ♡</blockquote>', { parse_mode: 'HTML' }).catch(() => {});
      return;
    }

    // Feedback in-place that publishing is executing
    const bProg = new RichMessageBuilder();
    bProg.paragraph(rt.bold(banner([
      '𓆩♡𓆪 PUBLISHING TO CHANNEL 𓆩♡𓆪',
      `sending to ${ch.title}... ♡`
    ])));
    bProg.divider();
    bProg.paragraph(rt.italic('⏳ Generating visual banner card and uploading sample stickers... please wait ♡'));
    bProg.validate();
    await editOrSend(ctx, bProg.toJSON());

    const botUser = app.telegram?.botUsername || 'Lancy_easy_bot';

    try {
      // 1. Fetch sticker set to retrieve stickers & sample
      const setName = p.tg_short_name || p.name;
      let set = null;
      let sampleStickers = [];
      let sampleBuf = null;

      try {
        set = await app.telegram.api.getStickerSet(setName);
        if (set?.stickers?.length) {
          sampleStickers = set.stickers.slice(0, Math.min(5, Math.max(3, set.stickers.length)));
          // Download the first sticker to composite on banner
          if (sampleStickers[0]?.file_id) {
            const fInfo = await app.telegram.api.getFile(sampleStickers[0].file_id);
            if (fInfo?.file_path) {
              sampleBuf = await app.telegram.api.downloadFile(fInfo.file_path).catch(() => null);
            }
          }
        }
      } catch (setErr) {
        log.warn({ err: setErr?.message, setName }, 'could not fetch full sticker set info');
      }

      // 2. Render 1000x560 Banner Photo
      const bannerBuffer = await renderChannelBanner({
        title: p.tg_title,
        count: p.count,
        stickerType: p.sticker_type || 'static',
        sampleBuffer: sampleBuf,
        creator: botUser
      });

      // 3. Post Phase 1: Banner Photo with Caption
      const bannerCaption = sel.caption || `✦ <b>${p.tg_title}</b> ✦\n📦 <b>${p.count} Stickers</b> • ${(p.sticker_type || 'static').toUpperCase()}\n🔗 <a href="${p.link}">Add to Telegram</a>\n🌸 Created with @${botUser} ♡`;
      await app.telegram.api.sendPhoto(ch.channel_id, bannerBuffer, {
        caption: `<blockquote>${bannerCaption}</blockquote>`,
        parse_mode: 'HTML'
      });
      await sleep(750);

      // 4. Post Phase 2: First 3 to 5 Sample Stickers
      let sentSampleCount = 0;
      for (const st of sampleStickers) {
        if (!st?.file_id) continue;
        await app.telegram.api.sendSticker(ch.channel_id, st.file_id).catch((err) => {
          log.warn({ err: err?.message, channelId: ch.channel_id }, 'sample sticker send skipped');
        });
        sentSampleCount += 1;
        await sleep(600);
      }

      // 5. Post Phase 3: Official Pack Card with direct button
      const finalMsg = `<blockquote>✨ <b>Click below to add the complete sticker pack to Telegram!</b>\n👉 <a href="${p.link}">${p.tg_title}</a>\n\n🌸 Created with @${botUser} ♡</blockquote>`;
      await app.telegram.api.sendMessage(ch.channel_id, finalMsg, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '➕ Add Sticker Pack 🌸', url: p.link }]
          ]
        }
      });

      // 6. Victory Card for User
      const bDone = new RichMessageBuilder();
      bDone.paragraph(rt.bold(banner([
        '🎉 SUCCESSFULLY POSTED! 🎉',
        'broadcast completed ♡'
      ])));
      bDone.divider();
      bDone.paragraph(rt.concat(
        rt.bold('Pack: '), rt.text(`${p.tg_title}\n`),
        rt.bold('Channel: '), rt.text(`${ch.title} (${ch.username ? '@' + ch.username : ch.channel_id})\n`),
        rt.bold('Delivered: '), rt.text(`1 Banner card, ${sentSampleCount} sample stickers, and 1 pack card ♡`)
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
      bErr.paragraph(rt.text(`Telegram returned: <i>${escapeXml(publishErr.message || 'Unknown error')}</i>\n\nPlease ensure the bot is still an Administrator in <b>${escapeXml(ch.title)}</b> with "Post Messages" permission enabled! ♡`));
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

        try {
          const chat = await app.telegram.api.getChat(input);
          if (!chat?.id) throw new Error('Channel not found');

          const me = await app.telegram.api.getMe();
          const member = await app.telegram.api.getChatMember(chat.id, me.id);

          const isAdmin = member.status === 'administrator' || member.status === 'creator';
          if (!isAdmin) {
            await app.telegram.api.sendMessage(
              sctx.chatId,
              `<blockquote>✕ The bot is not an administrator in <b>${escapeXml(chat.title || input)}</b>!\nPlease make the bot an admin with "Post Messages" permission, then send the @username again ♡</blockquote>`,
              { parse_mode: 'HTML' }
            );
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
          await renderChannelPicker({ ...sctx, tgId });
          return true;
        } catch (err) {
          await app.telegram.api.sendMessage(
            sctx.chatId,
            `<blockquote>✕ Could not connect channel: <i>${escapeXml(err.message || 'Invalid channel')}</i>\nPlease check the username or channel ID and try again ♡</blockquote>`,
            { parse_mode: 'HTML' }
          );
          return true;
        }
      },
      onTimeout: async (sctx) => {
        await app.telegram.api.sendMessage(sctx.chatId, '<blockquote>♡ Channel input timed out ♡</blockquote>', { parse_mode: 'HTML' }).catch(() => {});
      }
    });

    // 2. Custom Caption input handler
    app.sm.register(States.TG_CHANNEL_CAPTION_INPUT, {
      onMessage: async (sctx, message) => {
        const text = (message.text ?? message.caption ?? '').trim();
        if (!text) return false;
        const tgId = String(sctx.tgId);
        const sel = getSelection(tgId);
        sel.caption = text;
        await app.sm.reset(tgId, { reason: 'caption-saved' });
        await renderPreview({ ...sctx, tgId });
        return true;
      },
      onTimeout: async (sctx) => {
        await app.telegram.api.sendMessage(sctx.chatId, '<blockquote>♡ Caption input timed out ♡</blockquote>', { parse_mode: 'HTML' }).catch(() => {});
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

        case 'select_pack': {
          const packId = Number(args[0]);
          sel.packId = packId;
          sel.pack = app.packs.getPack(Number(tgId), packId) || app.db.get('SELECT * FROM sticker_packs WHERE id = ?', packId);
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
          b.paragraph(rt.text(
            '📢 <b>Send the channel @username, channel ID, or forward any post from your channel here!</b>\n\n' +
            'Example: <code>@MyAestheticChannel</code> or <code>-1001234567890</code>\n\n' +
            '⚠️ <i>Make sure the bot has already been added to the channel as an Administrator!</i> ♡'
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
