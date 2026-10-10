import { RichMessageBuilder, rt, richButton, encodeCallback } from '../rich.js';
import { navButtons, kvTable, statusDot, banner, ACCENT, SPARK } from '../ui.js';
import { States } from '../../core/stateMachine.js';
import { ProgressTracker } from '../progress.js';
import { normalizeWhatsAppNumber, PhoneNumberError } from '../../utils/phone.js';
import { splitIntoPacks, physicalPackName, splitSummary } from '../../whatsapp/split.js';
import { sanitizeWhatsAppPackName } from '../../whatsapp/publisher.js';
import { formatDateTime, truncate, pluralize } from '../../utils/text.js';
import { LancyError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';

/**
 * WhatsApp screen — pairing, session management and the whole publish flow:
 *
 *   Session → Sticker Posting → multi-select packs → caption
 *     → multi-select channels → FINAL PREVIEW → POST → live progress → done
 *
 * WhatsApp itself stays quiet: only connection notices and results.
 */
export function createWhatsAppScreen({ app }) {
  const id = 'whatsapp';
  const selections = new Map(); // tgId -> publish flow selection state

  // ── Menu ────────────────────────────────────────────────────────────────
  async function openMenu(ctx) {
    const sessions = app.whatsapp.listForUser(Number(ctx.tgId));
    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '𓆩♡𓆪 WHATSAPP SESSIONS 𓆩♡𓆪',
      'pairing & channel publisher ♡'
    ])));
    b.divider();
    if (!sessions.length) {
      b.paragraph(rt.italic('no WhatsApp numbers are connected yet ♡'));
      b.divider();
      b.buttons([richButton.callback('📱 Pair Number', encodeCallback(id, 'pair'), { style: 'primary' })]);
    } else {
      b.paragraph(rt.italic('your sessions ♡'));
      b.divider();
      for (const s of sessions) {
        b.paragraph(rt.concat(
          rt.bold(`${statusDot(s.status)} ${s.name}`),
          rt.text(`\n${s.phone ?? s.jid ?? '—'} • ${s.status}`)
        ));
        b.buttons([
          richButton.callback('⚙ Manage', encodeCallback(id, 'session', s.sessionId)),
          s.status === 'online'
            ? richButton.callback('✨ Sticker Posting', encodeCallback(id, 'post', s.sessionId), { style: 'primary' })
            : richButton.callback('↻ Reconnect', encodeCallback(id, 'reconnect', s.sessionId))
        ]);
        b.divider();
      }
      b.buttons([richButton.callback('📱 Pair Number', encodeCallback(id, 'pair'))]);
    }
    b.buttons(navButtons(id, { back: false, home: true }));
    b.footer(rt.italic('telegram is the control center — whatsapp only receives the output ♡'));
    b.validate();
    await editOrSend(ctx, b.toJSON());
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

  // ── Pairing flow ────────────────────────────────────────────────────────
  async function startPairing(ctx) {
    await ctx.sm.transition(ctx.tgId, States.WA_PAIR_NAME, {
      context: { step: 'name' },
      chatId: ctx.chatId,
      screenMessageId: ctx.messageId
    });
    const b = new RichMessageBuilder();
    b.heading('♡ PAIR A NUMBER', 1);
    b.paragraph(rt.italic('step 1 of 2 — give this session a cute name ♡'));
    b.paragraph(rt.text('example: '), rt.code('Lancy Main'));
    b.divider();
    b.buttons(navButtons(id, { cancel: true, home: true }));
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  async function onPairName(sctx, name) {
    await sctx.transition(States.WA_PAIR_NUMBER, {
      context: { name },
      chatId: sctx.chatId
    });
    const b = new RichMessageBuilder();
    b.heading('♡ PAIR A NUMBER', 1);
    b.table(kvTable([['Session', name]]), { compact: true });
    b.divider();
    b.paragraph(rt.italic('step 2 of 2 — send the WhatsApp number ♡'));
    b.paragraph(rt.text('I accept '), rt.code('+234 801 234 5678'), rt.text(', '), rt.code('234-801-234-5678'), rt.text(', '), rt.code('2348012345678'));
    b.divider();
    b.buttons(navButtons(id, { cancel: true }));
    b.validate();
    await app.telegram.api.editMessageRich(sctx.chatId, sctx.screenMessageId, b.toJSON()).catch(() => {});
  }

  async function onPairNumber(sctx, text) {
    let normalized;
    try {
      normalized = normalizeWhatsAppNumber(text);
    } catch (error) {
      if (error instanceof PhoneNumberError) {
        await app.telegram.api.sendMessage(sctx.chatId, `♡ ${error.message}`);
        return;
      }
      throw error;
    }

    const { name } = sctx.context;
    const userId = Number(sctx.tgId);
    const session = await app.whatsapp.createSession({ userId, name, phone: normalized.e164 });

    await sctx.transition(States.WA_PAIRING, {
      context: { sessionId: session.sessionId, phone: normalized },
      chatId: sctx.chatId
    });

    // Live pairing screen.
    const b = new RichMessageBuilder();
    b.paragraph(rt.bold('╭────────────────────────────╮\n│      ♡ PAIRING LANCY       │\n╰────────────────────────────╯'));
    b.divider();
    b.table(kvTable([
      ['Number', normalized.formatted],
      ['Session', name]
    ]), { compact: true });
    b.divider();
    b.paragraph(rt.concat(rt.italic('requesting a pairing code…'), rt.text('\n♡ one moment ♡')));
    b.buttons([richButton.callback('✕ Cancel', encodeCallback(id, 'cancel'), { style: 'danger' })]);
    b.validate();
    const tracker = new ProgressTracker({ api: app.telegram.api, chatId: sctx.chatId });
    await tracker.start(b.toJSON());

    try {
      const customCode = app.settings.get('whatsapp.customPairingCode') ?? 'LANCYBOT';
      const code = await app.whatsapp.requestPairing(session.sessionId, normalized.e164, customCode);
      await tracker.finish(pairingCodeRich(normalized, name, code));
    } catch (error) {
      await tracker.finish(pairingErrorRich(error));
      return;
    }

    // Wait for the session to come online (or timeout), then confirm.
    const timeoutMs = (app.settings.get('whatsapp.pairingTimeoutSeconds') ?? 120) * 1000;
    const online = await waitForOnline(session.sessionId, timeoutMs);
    if (online) {
      await sctx.transition(States.IDLE, { context: {}, chatId: sctx.chatId, pushHistory: false });
      await tracker.finish(connectedRich(normalized, name, session.sessionId));
      app.db.audit(userId, 'wa.session.paired', { sessionId: session.sessionId, phone: normalized.e164 });
      // Minimal self-DM on WhatsApp — no spam.
      if (app.settings.get('whatsapp.sendToOwnDmOnConnect') ?? true) {
        try {
          await session.sendText(session.jid, `♡ Lancy connected successfully.\n\nSession: ${name}\nControl center: Telegram`);
        } catch { /* non-fatal */ }
      }
    } else {
      await tracker.finish(pairingTimeoutRich(normalized, name));
    }
  }

  function waitForOnline(sessionId, timeoutMs) {
    return new Promise((resolve) => {
      const session = app.whatsapp.get(sessionId);
      if (!session) return resolve(false);
      if (session.isOnline) return resolve(true);
      const timer = setTimeout(() => {
        session.off('online', onOnline);
        resolve(false);
      }, timeoutMs);
      const onOnline = () => {
        clearTimeout(timer);
        resolve(true);
      };
      session.on('online', onOnline);
    });
  }

  // ── Session menu ────────────────────────────────────────────────────────
  async function showSession(ctx, sessionId) {
    const session = app.whatsapp.get(sessionId);
    if (!session) return ctx.reply('♡ That session is gone.');
    const d = app.whatsapp.describe(session);
    const b = new RichMessageBuilder();
    b.heading(`${statusDot(d.status)} ${d.name}`, 1);
    b.table(kvTable([
      ['Status', d.status],
      ['Number', d.phone ?? '—'],
      ['JID', d.jid ?? '—'],
      ['Last connected', d.lastConnected ? formatDateTime(new Date(d.lastConnected), ctx.settings.get('general.timezone')) : '—'],
      ['Last disconnect', d.lastDisconnect ? formatDateTime(new Date(d.lastDisconnect), ctx.settings.get('general.timezone')) : '—'],
      ['Packs published', String(d.stats.packsPublished ?? 0)]
    ]), { compact: true });
    b.divider();
    b.buttons([
      richButton.callback('✨ Sticker Posting', encodeCallback(id, 'post', sessionId), { style: 'primary' }),
      richButton.callback('📣 Channels', encodeCallback(id, 'channels', sessionId))
    ]);
    b.buttons([
      richButton.callback('↻ Reconnect', encodeCallback(id, 'reconnect', sessionId)),
      richButton.callback('🚪 Logout', encodeCallback(id, 'logout', sessionId), { style: 'danger' })
    ]);
    b.divider();
    b.buttons(navButtons(id, { home: true }));
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  // ── Sticker posting flow ────────────────────────────────────────────────
  function getSelection(tgId) {
    const key = String(tgId);
    if (!selections.has(key)) {
      let restored = null;
      try {
        const row = app.db?.get?.('SELECT value_json FROM bot_settings WHERE key = ?', `wa_sel_${key}`);
        if (row?.value_json) restored = JSON.parse(row.value_json);
      } catch {}

      const smRecord = app.sm?.for?.(key);
      const smContext = smRecord?.context?.selection || smRecord?.context;

      selections.set(key, {
        sessionId: restored?.sessionId ?? smContext?.sessionId ?? null,
        packs: restored?.packs ?? smContext?.packs ?? [],
        captionMode: restored?.captionMode ?? smContext?.captionMode ?? null,
        caption: restored?.caption ?? smContext?.caption ?? null,
        channels: restored?.channels ?? smContext?.channels ?? [],
        customPackName: restored?.customPackName ?? smContext?.customPackName ?? null
      });
    }
    const sel = selections.get(key);
    if (!sel.sessionId) {
      const ctxState = app.sm?.ctxFor?.(key);
      if (ctxState?.context?.sessionId) {
        sel.sessionId = ctxState.context.sessionId;
      } else {
        const online = app.whatsapp.listForUser(Number(key)).find((s) => s.status === 'online');
        if (online) sel.sessionId = online.sessionId;
      }
    }
    if ((!sel.channels || sel.channels.length === 0) && sel.sessionId) {
      try {
        const rows = app.db?.all?.('SELECT channel_jid FROM wa_channels WHERE session_id = ?', sel.sessionId);
        if (rows?.length > 0) {
          sel.channels = rows.map((r) => r.channel_jid);
        }
      } catch {}
    }
    return sel;
  }

  function saveSelection(tgId, sel) {
    const key = String(tgId);
    if (!key || !sel) return;
    selections.set(key, sel);
    try {
      app.db?.run?.(
        'INSERT OR REPLACE INTO bot_settings (key, value_json) VALUES (?, ?)',
        `wa_sel_${key}`,
        JSON.stringify(sel)
      );
    } catch {}
  }

  async function startPosting(ctx, sessionId) {
    const session = app.whatsapp.get(sessionId);
    if (!session) return ctx.reply('♡ That session is gone.');
    if (!session.isOnline) {
      return ctx.reply('♡ That session is not connected — reconnect it first ♡');
    }
    const sel = getSelection(ctx.tgId);
    sel.sessionId = sessionId;
    sel.packs = [];
    sel.customPackName = null;
    sel.caption = null;
    sel.captionMode = null;
    sel.channels = [];
    saveSelection(ctx.tgId, sel);
    await ctx.sm.transition(ctx.tgId, States.WA_PACK_SELECTION, {
      context: { sessionId },
      chatId: ctx.chatId,
      screenMessageId: ctx.messageId
    });
    await showPackSelection(ctx, 0);
  }

  async function showPackSelection(ctx, page = 0) {
    const sel = getSelection(ctx.tgId);
    const pageSize = ctx.settings.get('telegram.paginationSize') ?? 5;
    const { packs, total } = app.packs.listPacks(Number(ctx.tgId), { limit: 1000, offset: 0 });
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const pagePacks = packs.slice(page * pageSize, (page + 1) * pageSize);

    const b = new RichMessageBuilder();
    b.heading('✦ STICKER POSTING', 1);
    b.table(kvTable([
      ['Session', app.whatsapp.describe(app.whatsapp.get(sel.sessionId)).name],
      ['Selected', `${sel.packs.length} pack${sel.packs.length === 1 ? '' : 's'}`]
    ]), { compact: true });
    b.divider();
    if (!packs.length) {
      b.paragraph(rt.italic('you have no packs yet ♡ create one first.'));
      b.buttons([richButton.callback('✦ Create a Pack', encodeCallback('stickers', 'open'))]);
    }
    for (const pack of pagePacks) {
      const checked = sel.packs.some((p) => p.id === pack.id);
      const summary = splitSummary(pack.count, ctx.settings.get('whatsapp.physicalStickerPackLimit') ?? 60);
      b.paragraph(rt.concat(
        rt.bold(`${checked ? '☑' : '☐'} ${pack.title}`),
        rt.text(`\n${pack.count} stickers • ${summary.packs} whatsapp pack${summary.packs === 1 ? '' : 's'} • ${pack.query ?? 'manual'}`)
      ));
      b.buttons([richButton.callback(
        checked ? '✕ Remove' : '◻ Select',
        encodeCallback(id, 'togglePack', pack.id, page),
        { style: checked ? 'danger' : 'primary' }
      )]);
    }
    if (totalPages > 1) {
      const row = [];
      if (page > 0) row.push(richButton.callback('← Prev', encodeCallback(id, 'packPage', page - 1)));
      if (page < totalPages - 1) row.push(richButton.callback('Next →', encodeCallback(id, 'packPage', page + 1)));
      b.buttons(row);
    }
    b.divider();
    const done = sel.packs.length > 0;
    b.buttons([
      ...(done ? [richButton.callback('→ Continue', encodeCallback(id, 'toCaption'), { style: 'primary' })] : []),
      richButton.callback('✨ Create New Pack', encodeCallback('stickers', 'open')),
      richButton.callback('✕ Cancel', encodeCallback(id, 'cancel'), { style: 'danger' })
    ]);
    b.footer(rt.italic(`each pack is posted separately — never merged ♡`));
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  async function showCaptionMenu(ctx) {
    const sel = getSelection(ctx.tgId);
    await ctx.sm.transition(ctx.tgId, States.WA_CAPTION_EDITOR, {
      context: { sessionId: sel.sessionId },
      chatId: ctx.chatId,
      screenMessageId: ctx.messageId
    });
    const preview = renderCaptionPreview(ctx, sel, sel.caption ?? null);
    const b = new RichMessageBuilder();
    b.heading('✦ ABOUT / CAPTION', 1);
    b.paragraph(rt.italic('how should the caption look? ♡'));
    b.divider();
    b.paragraph(preview);
    b.divider();
    if (sel.caption) {
      b.buttons([
        richButton.callback('→ Next: Choose Channels', encodeCallback(id, 'toChannels'), { style: 'primary' }),
        richButton.callback('↻ Re-roll AI', encodeCallback(id, 'captionMode', 'ai'))
      ]);
      b.buttons([
        richButton.callback('📋 Use Default', encodeCallback(id, 'captionMode', 'default')),
        richButton.callback('✎ Edit Caption', encodeCallback(id, 'captionMode', 'edit'))
      ]);
    } else {
      b.buttons([
        richButton.callback('🪄 AI Generate Aura', encodeCallback(id, 'captionMode', 'ai'), { style: 'primary' }),
        richButton.callback('📋 Use Default', encodeCallback(id, 'captionMode', 'default'))
      ]);
      b.buttons([
        richButton.callback('✎ Edit Caption', encodeCallback(id, 'captionMode', 'edit')),
        richButton.callback('✎ Custom Caption', encodeCallback(id, 'captionMode', 'custom'))
      ]);
    }
    b.divider();
    b.buttons(navButtons(id, { back: true, cancel: true }));
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  function renderCaptionPreview(ctx, sel, caption) {
    const totals = sel.packs.reduce((acc, p) => {
      const s = splitSummary(p.count, ctx.settings.get('whatsapp.physicalStickerPackLimit') ?? 60);
      acc.stickers += p.count;
      acc.packs += s.packs;
      return acc;
    }, { stickers: 0, packs: 0 });
    const baseTitle = sel.customPackName ?? (sel.packs[0]?.title ?? 'Sticker Pack');
    const vars = {
      query: sel.packs[0]?.query ?? '',
      title: baseTitle,
      stickers: totals.stickers,
      packs: totals.packs,
      packName: sel.customPackName ?? sel.packs.map((p) => p.title).join(' + '),
      telegramLink: sel.packs[0]?.link ?? '',
      sessionName: app.whatsapp.describe(app.whatsapp.get(sel.sessionId))?.name ?? ''
    };
    const rendered = caption ?? app.captions.renderDefault(vars);
    return rt.concat(
      rt.bold('✦ FIRST TEXT DROP (Channel Teaser Story & Announcement):\n'),
      rt.text('────────────────────────────────────────\n'),
      rt.text(truncate(rendered, 600))
    );
  }

  async function showChannelSelection(ctx, sessionId) {
    const sel = getSelection(ctx.tgId);
    sessionId = sessionId ?? sel.sessionId ?? ctx.sm.ctxFor(ctx.tgId)?.context?.sessionId;
    if (!sessionId) {
      const online = app.whatsapp.listForUser(Number(ctx.tgId)).find((s) => s.status === 'online');
      sessionId = online?.sessionId ?? null;
    }
    if (sessionId) sel.sessionId = sessionId;

    await ctx.sm.transition(ctx.tgId, States.WA_CHANNEL_SELECTION, {
      context: { sessionId: sel.sessionId },
      chatId: ctx.chatId,
      screenMessageId: ctx.messageId
    });

    // Discover channels for this session.
    let channels = [];
    try {
      const session = app.whatsapp.get(sel.sessionId);
      if (session && app.channels?.discover) {
        channels = await app.channels.discover(session);
      }
    } catch (error) {
      (app.log ?? app.logger)?.warn({ err: error }, 'channel discovery failed');
      channels = app.channels?.cached?.(sel.sessionId) ?? [];
    }

    const b = new RichMessageBuilder();
    b.heading('📣 CHANNELS', 1);
    b.paragraph(rt.italic('where should the packs go? select one or more ♡'));
    b.divider();
    if (!channels.length) {
      b.paragraph(rt.italic('no channels found yet — add your channel by link below or send to DM ♡'));
    }
    for (const ch of channels) {
      const checked = sel.channels.includes(ch.jid);
      const perm = ch.canPublish === 'yes' ? 'can post ✓' : ch.canPublish === 'no' ? 'no permission' : 'unknown — will verify';
      b.paragraph(rt.concat(
        rt.bold(`${checked ? '☑' : '☐'} ${ch.name ?? ch.jid}`),
        rt.text(`\n${ch.jid} • ${perm}`)
      ));
      b.buttons([richButton.callback(checked ? '✕ Remove' : '◻ Select', encodeCallback(id, 'toggleChannel', ch.jid), { style: checked ? 'danger' : 'primary' })]);
    }
    b.divider();
    b.buttons([
      richButton.callback('➕ Add Channel by Link', encodeCallback(id, 'addChannel', sel.sessionId), { style: 'primary' }),
      richButton.callback('🔄 Refresh Channels', encodeCallback(id, 'refreshChannels', sel.sessionId))
    ]);
    b.divider();
    b.table(kvTable([['Selected', `${sel.channels.length} channel${sel.channels.length === 1 ? '' : 's'}`]]), { compact: true });
    b.divider();
    b.buttons([
      richButton.callback(
        sel.channels.length > 0 ? `→ Continue (${sel.channels.length} selected)` : '→ Continue (Send to DM)',
        encodeCallback(id, 'toPreview'),
        { style: 'primary' }
      ),
      richButton.callback('✕ Cancel', encodeCallback(id, 'cancel'), { style: 'danger' })
    ]);
    b.footer(rt.italic('permissions are revalidated right before publishing ♡'));
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  // ── Final preview ───────────────────────────────────────────────────────
  async function showFinalPreview(ctx) {
    const sel = getSelection(ctx.tgId);
    if (!sel.sessionId) {
      const online = app.whatsapp.listForUser(Number(ctx.tgId)).find((s) => s.status === 'online');
      if (online) sel.sessionId = online.sessionId;
    }
    if (!sel.packs.length) {
      const { packs: userPacks } = app.packs.listPacks(Number(ctx.tgId), { limit: 1, offset: 0 });
      if (userPacks.length > 0) {
        sel.packs = [userPacks[0]];
      } else {
        await ctx.reply('♡ No sticker packs found — create a pack first ♡');
        return showPackSelection(ctx, 0);
      }
    }

    await ctx.sm.transition(ctx.tgId, States.WA_FINAL_PREVIEW, {
      context: { sessionId: sel.sessionId, selection: sel },
      chatId: ctx.chatId,
      screenMessageId: ctx.messageId
    });
    saveSelection(ctx.tgId, sel);

    const limit = Math.min(60, Math.max(1, Number(ctx.settings.get('whatsapp.physicalStickerPackLimit') ?? 60)));
    const session = app.whatsapp.get(sel.sessionId);
    const sessionDesc = app.whatsapp.describe(session);
    const b = new RichMessageBuilder();
    b.paragraph(rt.bold('╭────────────────────────────╮\n│     ✦ PUBLISH PREVIEW ✦    │\n╰────────────────────────────╯'));
    b.divider();

    for (const pack of sel.packs) {
      const packCount = Number(pack.count ?? pack.stickerCount ?? 0);
      const splits = splitIntoPacks(packCount, limit);
      const baseTitle = sanitizeWhatsAppPackName(sel.customPackName ?? (pack.title ?? pack.name ?? 'Sticker Pack'));
      b.heading(`${SPARK} ${baseTitle}`, 3);
      b.table(kvTable([
        ['Pack Name', baseTitle],
        ['Stickers', String(packCount)],
        ['WhatsApp packs', String(splits.length).padStart(2, '0')],
        ...splits.map((s, i) => [`Pack ${String(i + 1).padStart(2, '0')}`, `${s.count} stickers`])
      ]), { compact: true });
    }
    b.divider();

    if (sel.packs.length > 1) {
      b.heading('✦ PER-PACK CAPTION PREVIEWS', 3);
      for (let idx = 0; idx < sel.packs.length; idx++) {
        const p = sel.packs[idx];
        const pTitle = sanitizeWhatsAppPackName(p.title ?? p.name ?? 'Sticker Pack');
        const pChar = (p.query || pTitle || 'Stickers')
          .replace(/^ᥫ᭡[^\s-]+\s*-\s*/, '')
          .replace(/\s*(?:stickers?|collection|wa\s*import|part\s*\d+)/gi, '')
          .trim() || 'Stickers';
        const pCount = Number(p.count ?? p.stickerCount ?? 0);
        const pSplits = splitIntoPacks(pCount, limit);
        const pVars = {
          query: p.query ?? pChar,
          title: pTitle,
          character: pChar,
          stickers: pCount,
          packs: pSplits.length,
          packName: pTitle,
          telegramLink: p.link ?? '',
          sessionName: sessionDesc.name ?? ''
        };
        const pCaption = app.captions.renderDefault(pVars);
        b.paragraph(rt.concat(rt.bold(`Pack ${idx + 1}: `), rt.text(`${pTitle} (${pCount} stickers)`)));
        b.blockquote(pCaption);
      }
    } else {
      const packObj = sel.packs[0];
      const characterName = (packObj?.query || sel.customPackName || packObj?.title || 'Stickers')
        .replace(/^ᥫ᭡[^\s-]+\s*-\s*/, '')
        .replace(/\s*(?:stickers?|collection|wa\s*import|part\s*\d+)/gi, '')
        .trim() || 'Stickers';

      let aiDescription = null;
      if (app.settings?.get('captions.aiAutoCaption') && !sel.caption) {
        try {
          aiDescription = await app.captions.generateAbout(characterName, { aiService: app.ai });
        } catch {}
      }

      const vars = {
        query: characterName,
        title: characterName,
        character: characterName,
        stickers: sel.packs.reduce((n, p) => n + Number(p.count ?? p.stickerCount ?? 0), 0),
        packs: sel.packs.reduce((n, p) => n + splitIntoPacks(Number(p.count ?? p.stickerCount ?? 0), limit).length, 0),
        packName: sel.customPackName ?? sel.packs.map((p) => p.title).join(' + '),
        telegramLink: sel.packs[0]?.link ?? '',
        sessionName: sessionDesc.name ?? '',
        ...(aiDescription ? { description: aiDescription } : {})
      };
      const caption = sel.caption ?? app.captions.renderDefault(vars);
      sel.caption = caption;

      b.heading('✦ CAPTION', 3);
      b.blockquote(caption);
    }
    b.divider();
    b.heading('✦ DESTINATION', 3);
    if (!sel.channels.length) {
      b.paragraph(rt.text('☑ your own DM (no channels selected)'));
    } else {
      const cachedList = sel.sessionId ? (app.channels?.cached?.(sel.sessionId) ?? []) : [];
      for (const jid of sel.channels) {
        const cached = cachedList.find((c) => c.channel_jid === jid);
        b.paragraph(rt.text(`☑ ${cached?.name ?? jid}`));
      }
    }
    b.paragraph(rt.concat(rt.bold('Session: '), rt.text(sessionDesc.name ?? '—')));
    b.divider();
    b.buttons([
      richButton.callback('🏷 Pack Name', encodeCallback(id, 'editPackName'), { style: 'primary' }),
      richButton.callback('✎ Edit Caption', encodeCallback(id, 'toCaption')),
      richButton.callback('✦ Change Packs', encodeCallback(id, 'toPacks'))
    ]);
    b.buttons([
      richButton.callback('📣 Change Channels', encodeCallback(id, 'toChannels')),
      richButton.callback('✦ Change Session', encodeCallback(id, 'open')),
      richButton.callback('✕ Cancel', encodeCallback(id, 'cancel'), { style: 'danger' })
    ]);
    b.buttons([
      richButton.callback('🚀 POST', encodeCallback(id, 'post_confirm'), { style: 'success' })
    ]);
    b.footer(rt.italic('nothing is published until you press POST ♡'));
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  // ── POST: run the publish job ───────────────────────────────────────────
  async function executePublish(ctx) {
    const tgId = String(ctx.tgId);
    const userId = Number(tgId);
    const chatId = ctx.chatId;
    const messageId = ctx.messageId;
    const sel = getSelection(tgId);

    if (!sel.sessionId) {
      const online = app.whatsapp.listForUser(userId).find((s) => s.status === 'online');
      if (online) sel.sessionId = online.sessionId;
    }
    if (!sel.packs?.length) {
      const { packs: userPacks } = app.packs.listPacks(userId, { limit: 1, offset: 0 });
      if (userPacks?.length > 0) {
        sel.packs = [userPacks[0]];
      } else {
        const anyPacks = app.db?.all?.('SELECT * FROM sticker_packs ORDER BY id DESC LIMIT 1') ?? [];
        if (anyPacks.length > 0) sel.packs = anyPacks;
      }
      saveSelection(tgId, sel);
    }
    if (!sel.packs?.length) {
      await app.telegram.api.sendMessage(chatId, '♡ No sticker pack found to publish — please select or create a pack first ♡').catch(() => {});
      return;
    }
    const session = app.whatsapp.get(sel.sessionId);
    if (!session || !session.isOnline) {
      await app.telegram.api.sendMessage(chatId, '♡ That session is offline — please reconnect it and try again ♡').catch(() => {});
      return;
    }
    const limit = Math.min(60, Math.max(1, Number(ctx.settings?.get('whatsapp.physicalStickerPackLimit') ?? app.settings?.get('whatsapp.physicalStickerPackLimit') ?? 60)));
    const targets = sel.channels?.length ? sel.channels : [session.jid]; // own DM fallback

    if (sel.packs.length === 1 && !sel.caption) {
      const sessionDesc = app.whatsapp.describe(session);
      const vars = {
        query: sel.packs[0]?.query ?? '',
        title: sel.customPackName ?? (sel.packs[0]?.title ?? 'Sticker Pack'),
        stickers: Number(sel.packs[0]?.count ?? sel.packs[0]?.stickerCount ?? 0),
        packs: splitIntoPacks(Number(sel.packs[0]?.count ?? sel.packs[0]?.stickerCount ?? 0), limit).length,
        packName: sel.customPackName ?? (sel.packs[0]?.title ?? 'Sticker Pack'),
        telegramLink: sel.packs[0]?.link ?? '',
        sessionName: sessionDesc.name ?? ''
      };
      sel.caption = app.captions.renderDefault(vars);
    }

    const plan = app.publisher.buildPlan({
      userId,
      packs: sel.packs,
      sessionId: sel.sessionId,
      channelJids: targets,
      caption: sel.packs.length > 1 ? null : sel.caption,
      customPackName: sel.customPackName ?? null,
      limit
    });

    await ctx.sm.transition(tgId, States.WA_PUBLISHING, {
      context: { sessionId: sel.sessionId, publicationId: null, selection: sel },
      chatId,
      screenMessageId: messageId
    });

    const tracker = new ProgressTracker({ api: app.telegram.api, chatId, messageId });
    await tracker.start(publishingRich(plan, { stage: 'preparing' }));

    try {
      const results = await app.queues.add('whatsapp', {
        type: 'wa-publish',
        userId,
        payload: { sessionId: sel.sessionId, packs: plan.totals },
        run: async (job, qctx) => app.publisher.publish({
          plan: { ...plan, userId },
          session,
          telegramApi: app.telegram.api,
          signal: qctx.signal,
          getStickerBytes: async (packId, index) => {
            const pack = await app.packs.getPack(userId, packId);
            return app.packs.getStickerBytes(pack, index, {
              download: (fileId) => app.stickerService.downloadSticker(fileId)
            });
          },
          onProgress: (p) => tracker.update(publishingRich(plan, p))
        })
      }, { attempts: 1 });

      app.db.audit(userId, 'wa.published', { publicationId: results.publicationId, status: results.status, totals: results.totals });
      await ctx.sm.transition(tgId, States.IDLE, { context: {}, chatId, pushHistory: false });
      await tracker.finish(publishedRich(results));
      selections.delete(tgId);
      try {
        app.db.run('DELETE FROM bot_settings WHERE key = ?', `wa_sel_${tgId}`);
      } catch {}
    } catch (error) {
      (app.log ?? logger())?.error?.({ err: error, tgId }, 'sticker publish failed');
      await tracker.finish(publishErrorRich(error)).catch(() => {});
      await app.telegram.api.sendMessage(chatId, `✕ Publish failed: ${error.message || 'Unknown error'}\n\nPlease try again ♡`).catch(() => {});
      await ctx.sm.reset(tgId, { reason: 'publish-failed' });
    }
  }

  // ── Channels screen ─────────────────────────────────────────────────────
  async function showChannels(ctx, sessionId) {
    const session = app.whatsapp.get(sessionId);
    if (!session?.isOnline) return ctx.reply('♡ Connect the session first ♡');
    let channels = [];
    try {
      channels = await app.channels.discover(session);
    } catch (error) {
      (app.log ?? app.logger)?.warn({ err: error }, 'channel discovery failed');
      channels = app.channels.cached(sessionId) ?? [];
    }
    const b = new RichMessageBuilder();
    b.heading('📣 CHANNELS', 1);
    if (!channels.length) {
      b.paragraph(rt.italic('no channels found for this session yet ♡'));
    }
    for (const ch of channels) {
      const perm = ch.canPublish === 'yes' ? '✓ can publish' : ch.canPublish === 'no' ? '✕ no permission' : '? unknown — verified at publish time';
      b.table(kvTable([
        ['Name', ch.name ?? '—'],
        ['ID', ch.jid],
        ['Status', ch.status ?? '—'],
        ['This session', perm]
      ]), { compact: true });
      b.divider();
    }
    b.buttons([
      richButton.callback('➕ Add Channel by Link', encodeCallback(id, 'addChannel', sessionId), { style: 'primary' }),
      richButton.callback('🔄 Refresh', encodeCallback(id, 'channels', sessionId))
    ]);
    b.buttons(navButtons(id, { home: true }));
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  // ── State machine handlers ──────────────────────────────────────────────
  function registerStateHandlers(sm) {
    sm.register(States.WA_PAIR_NAME, {
      onMessage: async (sctx, message) => {
        const name = (message.text ?? '').trim();
        if (!name) return false;
        await onPairName(sctx, name);
        return true;
      },
      onTimeout: async (sctx) => {
        await app.telegram.api.sendMessage(sctx.chatId, '♡ pairing timed out — start again whenever ♡').catch(() => {});
      }
    });

    sm.register(States.WA_PAIR_NUMBER, {
      onMessage: async (sctx, message) => {
        if (!message.text) return false;
        await onPairNumber(sctx, message.text);
        return true;
      },
      onTimeout: async (sctx) => {
        await app.telegram.api.sendMessage(sctx.chatId, '♡ pairing timed out — start again whenever ♡').catch(() => {});
      }
    });

    sm.register(States.WA_CAPTION_EDITOR, {
      onMessage: async (sctx, message) => {
        if (!message.text) return false;
        const sel = getSelection(sctx.tgId);
        if (message.message_id) {
          await app.telegram.api.deleteMessage(sctx.chatId, message.message_id).catch(() => {});
        }
        sel.caption = message.text;
        sel.captionMode = 'custom';
        saveSelection(sctx.tgId, sel);
        await sctx.reset({ reason: 'custom-caption' });
        await showChannelSelection(sctxToScreenCtx(sctx), sctx.context.sessionId ?? sel.sessionId);
        return true;
      }
    });

    sm.register(States.WA_PACK_NAME_EDITOR, {
      onMessage: async (sctx, message) => {
        const text = (message.text ?? '').trim();
        if (!text) return false;
        const sel = getSelection(sctx.tgId);
        if (message.message_id) {
          await app.telegram.api.deleteMessage(sctx.chatId, message.message_id).catch(() => {});
        }
        sel.customPackName = text;
        saveSelection(sctx.tgId, sel);
        await sctx.reset({ reason: 'custom-pack-name' });
        await showFinalPreview(sctxToScreenCtx(sctx));
        return true;
      },
      onTimeout: async (sctx) => {
        await app.telegram.api.sendMessage(sctx.chatId, '♡ pack name input timed out ♡').catch(() => {});
      }
    });

    sm.register(States.WA_CHANNEL_INPUT, {
      onMessage: async (sctx, message) => {
        const text = (message.text ?? '').trim();
        if (!text) return false;
        const sel = getSelection(sctx.tgId);
        const sessionId = sctx.context.sessionId ?? sel.sessionId;
        const session = app.whatsapp.get(sessionId);
        if (!session) {
          await app.telegram.api.sendMessage(sctx.chatId, '♡ WhatsApp session not found.');
          return false;
        }

        if (message.message_id) {
          await app.telegram.api.deleteMessage(sctx.chatId, message.message_id).catch(() => {});
        }

        try {
          const channel = await app.channels.resolveChannel(session, text);
          if (!sel.channels.includes(channel.jid)) {
            sel.channels.push(channel.jid);
          }
          const permStr = channel.canPublish === 'yes' ? 'can post ✓' : channel.canPublish === 'no' ? 'follower only' : 'will verify at send';
          await app.telegram.api.sendMessage(
            sctx.chatId,
            `✓ Channel added: "${channel.name}" (${permStr})\nID: ${channel.jid}`
          );
        } catch (error) {
          await app.telegram.api.sendMessage(
            sctx.chatId,
            `✕ Could not resolve channel: ${error.message}\nMake sure the link or JID is correct, or tap Cancel.`
          );
        }

        await sctx.reset({ reason: 'channel-added' });
        await showChannelSelection(sctxToScreenCtx(sctx), sessionId);
        return true;
      },
      onTimeout: async (sctx) => {
        await app.telegram.api.sendMessage(sctx.chatId, '♡ channel input timed out ♡').catch(() => {});
      }
    });
  }

  function sctxToScreenCtx(sctx) {
    if (app.telegram?.createContext) {
      return app.telegram.createContext(sctx.tgId, {
        chatId: sctx.chatId,
        messageId: sctx.screenMessageId
      });
    }
    const screenMsgId = sctx.screenMessageId ?? app.telegram?.userScreenMessage?.get(sctx.tgId)?.messageId;
    return {
      tgId: sctx.tgId,
      chatId: sctx.chatId,
      messageId: screenMsgId,
      message: screenMsgId ? { message_id: screenMsgId } : null,
      sm: sctx.machine,
      api: app.telegram.api,
      settings: {
        get: (path, fallback) => app.settings?.getForUser ? app.settings.getForUser(Number(sctx.tgId), path, fallback) : app.settings?.get(path, fallback),
        set: (path, value) => app.settings?.setForUser ? app.settings.setForUser(Number(sctx.tgId), path, value) : app.settings?.set(path, value),
        getAll: () => app.settings?.getAllForUser ? app.settings.getAllForUser(Number(sctx.tgId)) : app.settings?.getAll()
      },
      db: app.db,
      reply: (text) => app.telegram.api.sendMessage(sctx.chatId, text),
      editScreen: async (rich, extra = {}, files = null) => {
        if (screenMsgId) {
          try {
            return await app.telegram.api.editMessageRich(sctx.chatId, screenMsgId, rich, extra, files);
          } catch {}
          await app.telegram.api.deleteMessage(sctx.chatId, screenMsgId).catch(() => {});
        }
        const sent = await app.telegram.api.sendRichMessage(sctx.chatId, rich, extra, files);
        if (sent?.message_id) {
          app.telegram?.userScreenMessage?.set(sctx.tgId, { chatId: sctx.chatId, messageId: sent.message_id });
          sctx.machine?.update(sctx.tgId, { screenMessageId: sent.message_id });
        }
        return sent;
      }
    };
  }

  return {
    id,
    registerStateHandlers,
    async open(ctx) {
      await ctx.sm.reset(ctx.tgId, { reason: 'navigate' });
      await openMenu(ctx);
    },
    async handle(ctx, action, args) {
      switch (action) {
        case 'open':
          return this.open(ctx);
        case 'pair':
          return startPairing(ctx);
        case 'session':
          return showSession(ctx, args[0]);
        case 'reconnect': {
          const session = app.whatsapp.get(args[0]);
          if (!session) return ctx.reply('♡ That session is gone.');
          await app.whatsapp.startSession(args[0]).catch(() => {});
          return showSession(ctx, args[0]);
        }
        case 'logout': {
          await app.whatsapp.logoutSession(args[0], { deleteCreds: true });
          return openMenu(ctx);
        }
        case 'post':
          return startPosting(ctx, args[0]);
        case 'togglePack': {
          const sel = getSelection(ctx.tgId);
          const packId = Number(args[0]);
          const pack = app.packs.getPack(Number(ctx.tgId), packId);
          if (!pack) return;
          const idx = sel.packs.findIndex((p) => p.id === packId);
          if (idx >= 0) sel.packs.splice(idx, 1);
          else sel.packs.push(pack);
          saveSelection(ctx.tgId, sel);
          return showPackSelection(ctx, Number(args[1] ?? 0));
        }
        case 'packPage':
          return showPackSelection(ctx, Number(args[0]));
        case 'toCaption':
          return showCaptionMenu(ctx);
        case 'toChannels': {
          const sel = getSelection(ctx.tgId);
          return showChannelSelection(ctx, sel.sessionId);
        }
        case 'captionMode': {
          const sel = getSelection(ctx.tgId);
          const mode = args[0];
          if (mode === 'default') {
            sel.caption = null;
            sel.captionMode = 'default';
            return showChannelSelection(ctx, sel.sessionId);
          }
          if (mode === 'ai') {
            const character = (sel.packs[0]?.query || sel.customPackName || sel.packs[0]?.title || 'Stickers')
              .replace(/^ᥫ᭡[^\s-]+\s*-\s*/, '')
              .replace(/\s*(?:stickers?|collection|wa\s*import|part\s*\d+)/gi, '')
              .trim() || 'Stickers';

            const totals = sel.packs.reduce((acc, p) => {
              const s = splitSummary(p.count, ctx.settings.get('whatsapp.physicalStickerPackLimit') ?? 60);
              acc.stickers += p.count; acc.packs += s.packs;
              return acc;
            }, { stickers: 0, packs: 0 });

            const aura = await app.captions.generateAuraCaption({
              character,
              stickers: totals.stickers,
              packs: totals.packs,
              aiService: app.ai
            });

            sel.caption = aura.caption;
            sel.captionMode = 'ai';
            return showCaptionMenu(ctx);
          }
          if (mode === 'edit' || mode === 'custom') {
            sel.captionMode = mode;
            await ctx.sm.transition(ctx.tgId, States.WA_CAPTION_EDITOR, {
              context: { sessionId: sel.sessionId },
              chatId: ctx.chatId,
              screenMessageId: ctx.messageId
            });
            const b = new RichMessageBuilder();
            b.heading('✎ CAPTION', 2);
            b.paragraph(rt.italic(mode === 'edit' && sel.caption ? 'send the new caption ♡' : 'send your custom caption ♡'));
            if (sel.caption) {
              b.divider();
              b.paragraph(rt.concat(rt.italic('current:\n'), rt.text(truncate(sel.caption, 400))));
            }
            b.divider();
            b.buttons(navButtons(id, { cancel: true }));
            b.validate();
            return editOrSend(ctx, b.toJSON());
          }
          return showCaptionMenu(ctx);
        }
        case 'toChannels':
          return showChannelSelection(ctx, getSelection(ctx.tgId).sessionId);
        case 'toggleChannel': {
          const sel = getSelection(ctx.tgId);
          const jid = args[0];
          const idx = sel.channels.indexOf(jid);
          if (idx >= 0) sel.channels.splice(idx, 1);
          else sel.channels.push(jid);
          saveSelection(ctx.tgId, sel);
          return showChannelSelection(ctx, sel.sessionId);
        }
        case 'editPackName': {
          const sel = getSelection(ctx.tgId);
          saveSelection(ctx.tgId, sel);
          await ctx.sm.transition(ctx.tgId, States.WA_PACK_NAME_EDITOR, {
            context: { sessionId: sel.sessionId, selection: sel },
            chatId: ctx.chatId,
            screenMessageId: ctx.messageId
          });
          const b = new RichMessageBuilder();
          b.heading('🏷 PACK NAME', 2);
          b.paragraph(rt.italic('send the custom name you want WhatsApp to display for this sticker pack ♡'));
          b.paragraph(rt.text('example: '), rt.code('Toji Aesthetic Pack'));
          b.divider();
          b.buttons(navButtons(id, { cancel: true }));
          b.validate();
          return editOrSend(ctx, b.toJSON());
        }
        case 'toPreview':
          return showFinalPreview(ctx);
        case 'toPacks':
          return showPackSelection(ctx, 0);
        case 'post_confirm': {
          return executePublish(ctx);
        }
        case 'channels':
          return showChannels(ctx, args[0]);
        case 'addChannel': {
          const sessionId = args[0] ?? getSelection(ctx.tgId).sessionId;
          await ctx.sm.transition(ctx.tgId, States.WA_CHANNEL_INPUT, {
            context: { sessionId },
            chatId: ctx.chatId,
            screenMessageId: ctx.messageId
          });
          const b = new RichMessageBuilder();
          b.heading('➕ ADD WHATSAPP CHANNEL', 2);
          b.paragraph(rt.bold('Send your channel invite link or channel JID:'));
          b.paragraph(rt.concat(
            rt.text('• e.g. '), rt.code('https://whatsapp.com/channel/0029VaABC123'),
            rt.text('\n• or direct JID: '), rt.code('1203631234567890@newsletter')
          ));
          b.divider();
          b.buttons([
            richButton.callback('« Back to Channels', encodeCallback(id, 'refreshChannels', sessionId), { style: 'primary' }),
            richButton.callback('✕ Cancel', encodeCallback(id, 'cancel'), { style: 'danger' })
          ]);
          b.validate();
          return editOrSend(ctx, b.toJSON());
        }
        case 'refreshChannels': {
          const sessionId = args[0] ?? getSelection(ctx.tgId).sessionId;
          return showChannelSelection(ctx, sessionId);
        }
        case 'publishPack': {
          // Hand-off from the sticker completion screen: pre-select the pack.
          const pack = app.packs.getPack(Number(ctx.tgId), Number(args[0]));
          if (!pack) return ctx.reply('♡ That pack is gone.');
          const sessions = app.whatsapp.listForUser(Number(ctx.tgId));
          const online = sessions.find((s) => s.status === 'online');
          if (!online) {
            await ctx.reply('♡ No WhatsApp session is connected — pair one first ♡');
            return openMenu(ctx);
          }
          const sel = getSelection(ctx.tgId);
          sel.sessionId = online.sessionId;
          sel.packs = [pack];
          sel.caption = null;
          sel.channels = [];
          return showCaptionMenu(ctx);
        }
        case 'back':
          return ctx.sm.back(ctx.tgId).then(() => openMenu(ctx));
        case 'cancel':
          await ctx.sm.cancel(ctx.tgId);
          selections.delete(ctx.tgId);
          return openMenu(ctx);
        case 'noop':
          return;
        default:
          return openMenu(ctx);
      }
    }
  };
}

// ── Pairing / publishing renderers ───────────────────────────────────────────

export function pairingCodeRich(number, name, code) {
  const rawCode = String(code);
  const formattedCode = (rawCode.length === 8 && !rawCode.includes('-'))
    ? `${rawCode.slice(0, 4)}-${rawCode.slice(4)}`
    : rawCode;

  const b = new RichMessageBuilder();
  b.paragraph(rt.bold('╭────────────────────────────╮\n│      ♡ PAIRING LANCY       │\n╰────────────────────────────╯'));
  b.divider();
  b.table(kvTable([
    ['Number', number.formatted],
    ['Session', name],
    ['Pairing code', formattedCode]
  ]), { compact: true });
  b.divider();
  b.paragraph(rt.bold('✦ HOW TO ENTER THE CODE ON YOUR PHONE:'));
  b.paragraph(rt.concat(
    rt.text('1. Open WhatsApp on your primary phone 📱\n'),
    rt.text('2. Tap Settings ⚙️ (or ⋮ three dots) → Linked Devices\n'),
    rt.text('3. Tap "Link a Device"\n'),
    rt.text('4. Tap "Link with phone number instead" at the bottom\n'),
    rt.text('5. Enter or paste your pairing code: '),
    rt.code(formattedCode),
    rt.text(' (or '),
    rt.code(rawCode),
    rt.text(')\n'),
    rt.text('6. Confirm to link Lancy to WhatsApp ♡')
  ));
  b.divider();
  b.buttons([
    richButton.copy(`📋 Copy Code (${rawCode})`, rawCode, { style: 'primary' }),
    richButton.callback('✕ Cancel', encodeCallback('whatsapp', 'cancel'), { style: 'danger' })
  ]);
  b.paragraph(rt.italic('waiting for WhatsApp connection handshake…'));
  b.footer(rt.italic('the code expires in 2 minutes — enter it on your phone promptly ♡'));
  b.validate();
  return b.toJSON();
}

function pairingErrorRich(error) {
  const b = new RichMessageBuilder();
  b.heading('♡ PAIRING FAILED', 2);
  b.paragraph(rt.italic(String(error?.userMessage ?? error?.message ?? 'something went wrong')));
  b.divider();
  b.buttons([
    richButton.callback('↺ Try Again', encodeCallback('whatsapp', 'pair')),
    richButton.callback('✦ Home', encodeCallback('dashboard', 'open'))
  ]);
  b.validate();
  return b.toJSON();
}

function pairingTimeoutRich(number, name) {
  const b = new RichMessageBuilder();
  b.heading('♡ PAIRING TIMED OUT', 2);
  b.paragraph(rt.italic('the pairing window closed before the number connected ♡'));
  b.divider();
  b.buttons([
    richButton.callback('↺ Try Again', encodeCallback('whatsapp', 'pair')),
    richButton.callback('✦ Home', encodeCallback('dashboard', 'open'))
  ]);
  b.validate();
  return b.toJSON();
}

function connectedRich(number, name, sessionId) {
  const b = new RichMessageBuilder();
  b.paragraph(rt.bold('╭────────────────────────────╮\n│      ♡ CONNECTED ♡         │\n╰────────────────────────────╯'));
  b.divider();
  b.table(kvTable([
    ['Session', name],
    ['Number', number.formatted],
    ['Status', 'online 🟢']
  ]), { compact: true });
  b.divider();
  b.paragraph(rt.italic('credentials are saved securely — this session will reconnect by itself ♡'));
  b.buttons([
    richButton.callback('✦ Sticker Posting', encodeCallback('whatsapp', 'post', sessionId), { style: 'primary' }),
    richButton.callback('✦ Dashboard', encodeCallback('dashboard', 'open'))
  ]);
  b.validate();
  return b.toJSON();
}

function publishingRich(plan, progress) {
  const b = new RichMessageBuilder();
  b.paragraph(rt.bold('╭────────────────────────────╮\n│       ✦ PUBLISHING ✦       │\n╰────────────────────────────╯'));
  b.divider();
  b.table(kvTable([
    ['Stickers', String(plan.totals.stickers)],
    ['WhatsApp packs', String(plan.totals.physicalPacks).padStart(2, '0')],
    ['Channels', String(plan.channelJids.length)]
  ]), { compact: true });
  b.divider();
  if (progress?.stage === 'sending' && progress.pack) {
    const ratio = progress.total ? progress.physical / progress.total : 0;
    const bar = `${'█'.repeat(Math.round(ratio * 10))}${'░'.repeat(10 - Math.round(ratio * 10))} ${Math.round(ratio * 100)}%`;
    b.paragraph(rt.concat(
      rt.italic(`♡ Sending ${progress.pack}`),
      rt.text(`\npack ${progress.physical}/${progress.total} → ${truncate(progress.channelName ?? progress.channel ?? '', 24)}\n${bar}`)
    ));
  } else if (progress?.stage === 'validating') {
    b.paragraph(rt.italic('♡ checking channel permissions…'));
  } else if (progress?.stage === 'caption') {
    b.paragraph(rt.italic(`♡ Publishing caption → ${truncate(progress.channelName ?? progress.channel ?? '', 24)}`));
  } else {
    b.paragraph(rt.italic('♡ Preparing your packs…'));
  }
  b.footer(rt.italic('one message, live updates ♡'));
  b.validate();
  return b.toJSON();
}

function publishedRich(results) {
  const b = new RichMessageBuilder();
  b.paragraph(rt.bold('╭────────────────────────────╮\n│       ♡ PUBLISHED ♡        │\n╰────────────────────────────╯'));
  b.divider();
  const totals = results?.totals ?? {};
  const succeeded = totals.succeeded ?? 0;
  const failed = totals.failed ?? 0;
  b.table(kvTable([
    ['Stickers', String(totals.stickers ?? 0)],
    ['WhatsApp packs', String(totals.physicalPacks ?? 0)],
    ['Channels', String(totals.destinations ?? (results?.targets?.length ?? 0))],
    ['Successful', `${succeeded}/${succeeded + failed}`],
    ['Failed', String(failed)]
  ]), { compact: true });
  b.divider();
  for (const target of (results?.targets ?? [])) {
    b.paragraph(rt.concat(
      rt.text(target.status === 'sent' ? '🟢' : target.status === 'skipped' ? '🟡' : '🔴'),
      rt.text(` ${target.name ?? target.jid} — ${target.status}${target.error ? ` (${target.error})` : ''}`)
    ));
  }
  b.divider();
  b.buttons([
    richButton.callback('✦ Publish Another', encodeCallback('whatsapp', 'open')),
    richButton.callback('✓ Done', encodeCallback('dashboard', 'open'), { style: 'success' })
  ]);
  b.validate();
  return b.toJSON();
}

function publishErrorRich(error) {
  const b = new RichMessageBuilder();
  b.heading('♡ PUBLISHING FAILED', 2);
  b.paragraph(rt.italic(String(error?.userMessage ?? error?.message ?? 'something went wrong')));
  b.divider();
  b.buttons([
    richButton.callback('↺ Retry', encodeCallback('whatsapp', 'open')),
    richButton.callback('✦ Home', encodeCallback('dashboard', 'open'))
  ]);
  b.validate();
  return b.toJSON();
}
