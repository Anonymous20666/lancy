import { RichMessageBuilder, rt, richButton, encodeCallback } from '../rich.js';
import { navButtons, kvTable, statusDot, ACCENT, SPARK } from '../ui.js';
import { States } from '../../core/stateMachine.js';
import { ProgressTracker } from '../progress.js';
import { normalizeWhatsAppNumber, PhoneNumberError } from '../../utils/phone.js';
import { splitIntoPacks, physicalPackName, splitSummary } from '../../whatsapp/split.js';
import { formatDateTime, truncate, pluralize } from '../../utils/text.js';
import { LancyError } from '../../core/errors.js';

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
    b.heading(`${SPARK} WHATSAPP`, 1);
    if (!sessions.length) {
      b.paragraph(rt.italic('no WhatsApp numbers are connected yet ♡'));
      b.divider();
      b.buttons([richButton.callback('♡ Pair Number', encodeCallback(id, 'pair'), { style: 'primary' })]);
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
            ? richButton.callback('✦ Sticker Posting', encodeCallback(id, 'post', s.sessionId), { style: 'primary' })
            : richButton.callback('↻ Reconnect', encodeCallback(id, 'reconnect', s.sessionId))
        ]);
        b.divider();
      }
      b.buttons([richButton.callback('♡ Pair Number', encodeCallback(id, 'pair'))]);
    }
    b.buttons(navButtons(id, { back: false, home: true }));
    b.footer(rt.italic('telegram is the control center — whatsapp only receives the output ♡'));
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  async function editOrSend(ctx, rich, files = null) {
    if (ctx.messageId && ctx.message) {
      await ctx.api.editMessageRich(ctx.chatId, ctx.messageId, rich, {}, files).catch(async (error) => {
        if (/not modified|message to edit not found/i.test(String(error?.description ?? error?.message))) return;
        await ctx.api.sendRichMessage(ctx.chatId, rich, {}, files);
      });
    } else {
      await ctx.api.sendRichMessage(ctx.chatId, rich, {}, files);
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
      const code = await app.whatsapp.requestPairing(session.sessionId, normalized.e164);
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
      richButton.callback('✦ Sticker Posting', encodeCallback(id, 'post', sessionId), { style: 'primary' }),
      richButton.callback('🖼 Images', encodeCallback(id, 'media', sessionId, 'image')),
      richButton.callback('🎬 Videos', encodeCallback(id, 'media', sessionId, 'video'))
    ]);
    b.buttons([
      richButton.callback('🗂 Albums', encodeCallback(id, 'media', sessionId, 'album')),
      richButton.callback('📣 Channels', encodeCallback(id, 'channels', sessionId)),
      richButton.callback('⚙ Session Settings', encodeCallback(id, 'sessionSettings', sessionId))
    ]);
    b.buttons([
      richButton.callback('↻ Reconnect', encodeCallback(id, 'reconnect', sessionId)),
      richButton.callback('♡ Logout', encodeCallback(id, 'logout', sessionId), { style: 'danger' })
    ]);
    b.divider();
    b.buttons(navButtons(id, { home: true }));
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  // ── Sticker posting flow ────────────────────────────────────────────────
  function getSelection(tgId) {
    if (!selections.has(tgId)) {
      selections.set(tgId, { sessionId: null, packs: [], captionMode: null, caption: null, channels: [] });
    }
    return selections.get(tgId);
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
    sel.caption = null;
    sel.captionMode = null;
    sel.channels = [];
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
        checked ? '✕ Remove' : '♡ Select',
        encodeCallback(id, 'togglePack', pack.id, page)
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
      ...(done ? [richButton.callback('♡ Continue', encodeCallback(id, 'toCaption'), { style: 'primary' })] : []),
      richButton.callback('✦ Create New Pack', encodeCallback('stickers', 'open')),
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
    b.buttons([
      richButton.callback('♡ Use Default', encodeCallback(id, 'captionMode', 'default'), { style: 'primary' }),
      richButton.callback('✦ AI Generate', encodeCallback(id, 'captionMode', 'ai'))
    ]);
    b.buttons([
      richButton.callback('✎ Edit', encodeCallback(id, 'captionMode', 'edit')),
      richButton.callback('♡ Custom', encodeCallback(id, 'captionMode', 'custom'))
    ]);
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
    const vars = {
      query: sel.packs[0]?.query ?? '',
      title: sel.packs[0]?.title ?? 'Sticker Pack',
      stickers: totals.stickers,
      packs: totals.packs,
      packName: sel.packs.map((p) => p.title).join(' + '),
      telegramLink: sel.packs[0]?.link ?? '',
      sessionName: app.whatsapp.describe(app.whatsapp.get(sel.sessionId))?.name ?? ''
    };
    const rendered = caption ?? app.captions.renderDefault(vars);
    return rt.concat(
      rt.italic('preview:\n'),
      rt.text('──────────────\n'),
      rt.text(truncate(rendered, 600))
    );
  }

  async function showChannelSelection(ctx, sessionId) {
    await ctx.sm.transition(ctx.tgId, States.WA_CHANNEL_SELECTION, {
      context: { sessionId },
      chatId: ctx.chatId,
      screenMessageId: ctx.messageId
    });
    const sel = getSelection(ctx.tgId);

    // Discover channels for this session.
    let channels = [];
    try {
      const session = app.whatsapp.get(sessionId);
      channels = await app.channels.discover(session);
    } catch (error) {
      app.logger?.warn({ err: error }, 'channel discovery failed');
    }

    const b = new RichMessageBuilder();
    b.heading('📣 CHANNELS', 1);
    b.paragraph(rt.italic('where should the packs go? select one or more ♡'));
    b.divider();
    if (!channels.length) {
      b.paragraph(rt.italic('no channels found for this session — the packs will go to your own DM ♡'));
    }
    for (const ch of channels) {
      const checked = sel.channels.includes(ch.jid);
      const perm = ch.canPublish === 'yes' ? 'can post ✓' : ch.canPublish === 'no' ? 'no permission' : 'unknown — will verify';
      b.paragraph(rt.concat(
        rt.bold(`${checked ? '☑' : '☐'} ${ch.name ?? ch.jid}`),
        rt.text(`\n${ch.jid} • ${perm}`)
      ));
      b.buttons([richButton.callback(checked ? '✕ Remove' : '♡ Select', encodeCallback(id, 'toggleChannel', ch.jid))]);
    }
    b.divider();
    b.table(kvTable([['Selected', `${sel.channels.length} channel${sel.channels.length === 1 ? '' : 's'}`]]), { compact: true });
    b.divider();
    b.buttons([
      ...(sel.channels.length ? [richButton.callback('♡ Continue', encodeCallback(id, 'toPreview'), { style: 'primary' })] : []),
      richButton.callback('✕ Cancel', encodeCallback(id, 'cancel'), { style: 'danger' })
    ]);
    b.footer(rt.italic('permissions are revalidated right before publishing ♡'));
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  // ── Final preview ───────────────────────────────────────────────────────
  async function showFinalPreview(ctx) {
    const sel = getSelection(ctx.tgId);
    await ctx.sm.transition(ctx.tgId, States.WA_FINAL_PREVIEW, {
      context: { sessionId: sel.sessionId },
      chatId: ctx.chatId,
      screenMessageId: ctx.messageId
    });

    const limit = ctx.settings.get('whatsapp.physicalStickerPackLimit') ?? 60;
    const session = app.whatsapp.get(sel.sessionId);
    const b = new RichMessageBuilder();
    b.paragraph(rt.bold('╭────────────────────────────╮\n│     ✦ PUBLISH PREVIEW ✦    │\n╰────────────────────────────╯'));
    b.divider();

    for (const pack of sel.packs) {
      const splits = splitIntoPacks(pack.count, limit);
      b.heading(`${SPARK} ${pack.title}`, 3);
      b.table(kvTable([
        ['Stickers', String(pack.count)],
        ['WhatsApp packs', String(splits.length).padStart(2, '0')],
        ...splits.map((s, i) => [`Pack ${String(i + 1).padStart(2, '0')}`, `${s.count} stickers`])
      ]), { compact: true });
    }
    b.divider();

    const vars = {
      query: sel.packs[0]?.query ?? '',
      title: sel.packs[0]?.title ?? 'Sticker Pack',
      stickers: sel.packs.reduce((n, p) => n + p.count, 0),
      packs: sel.packs.reduce((n, p) => n + splitIntoPacks(p.count, limit).length, 0),
      packName: sel.packs.map((p) => p.title).join(' + '),
      telegramLink: sel.packs[0]?.link ?? '',
      sessionName: app.whatsapp.describe(session)?.name ?? ''
    };
    const caption = sel.caption ?? app.captions.renderDefault(vars);

    b.heading('✦ CAPTION', 3);
    b.blockquote(caption);
    b.divider();
    b.heading('✦ DESTINATION', 3);
    if (!sel.channels.length) {
      b.paragraph(rt.text('☑ your own DM (no channels selected)'));
    } else {
      for (const jid of sel.channels) {
        const cached = app.channels.cached(sel.sessionId).find((c) => c.channel_jid === jid);
        b.paragraph(rt.text(`☑ ${cached?.name ?? jid}`));
      }
    }
    b.paragraph(rt.concat(rt.bold('Session: '), rt.text(app.whatsapp.describe(session)?.name ?? '—')));
    b.divider();
    b.buttons([
      richButton.callback('✎ Edit Caption', encodeCallback(id, 'toCaption')),
      richButton.callback('✦ Change Packs', encodeCallback(id, 'toPacks'))
    ]);
    b.buttons([
      richButton.callback('📣 Change Channels', encodeCallback(id, 'toChannels')),
      richButton.callback('✦ Change Session', encodeCallback(id, 'open')),
      richButton.callback('✕ Cancel', encodeCallback(id, 'cancel'), { style: 'danger' })
    ]);
    b.buttons([
      richButton.callback('♡ POST', encodeCallback(id, 'post_confirm'), { style: 'success' })
    ]);
    b.footer(rt.italic('nothing is published until you press POST ♡'));
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  // ── POST: run the publish job ───────────────────────────────────────────
  async function executePublish(sctx) {
    const sel = selections.get(sctx.tgId);
    if (!sel?.packs?.length) return;
    const session = app.whatsapp.get(sel.sessionId);
    if (!session?.isOnline) {
      await app.telegram.api.sendMessage(sctx.chatId, '♡ That session went offline — reconnect it and try again ♡');
      return;
    }
    const userId = Number(sctx.tgId);
    const limit = app.settings.get('whatsapp.physicalStickerPackLimit') ?? 60;
    const targets = sel.channels.length ? sel.channels : [session.jid]; // own DM fallback

    const plan = app.publisher.buildPlan({
      userId,
      packs: sel.packs,
      sessionId: sel.sessionId,
      channelJids: targets,
      caption: sel.caption ?? null
    });

    await sctx.transition(States.WA_PUBLISHING, {
      context: { sessionId: sel.sessionId, publicationId: null },
      chatId: sctx.chatId
    });

    const tracker = new ProgressTracker({ api: app.telegram.api, chatId: sctx.chatId });
    await tracker.start(publishingRich(plan, { stage: 'preparing' }));

    try {
      const results = await app.queues.add('whatsapp', {
        type: 'wa-publish',
        userId,
        payload: { sessionId: sel.sessionId, packs: plan.totals },
        run: async (job, qctx) => app.publisher.publish({
          plan: { ...plan, userId },
          session,
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
      await sctx.transition(States.IDLE, { context: {}, chatId: sctx.chatId, pushHistory: false });
      await tracker.finish(publishedRich(results));
    } catch (error) {
      await tracker.finish(publishErrorRich(error));
      await sctx.reset({ reason: 'publish-failed' });
    } finally {
      selections.delete(sctx.tgId);
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
      app.logger?.warn({ err: error }, 'channel discovery failed');
    }
    const b = new RichMessageBuilder();
    b.heading('📣 CHANNELS', 1);
    if (!channels.length) {
      b.paragraph(rt.italic('no channels found for this session ♡'));
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
        const sel = selections.get(sctx.tgId);
        if (!sel) return false;
        sel.caption = message.text;
        sel.captionMode = 'custom';
        await showChannelSelection(sctxToScreenCtx(sctx), sctx.context.sessionId ?? sel.sessionId);
        return true;
      }
    });
  }

  function sctxToScreenCtx(sctx) {
    return {
      tgId: sctx.tgId,
      chatId: sctx.chatId,
      messageId: sctx.screenMessageId,
      message: sctx.screenMessageId ? { message_id: sctx.screenMessageId } : null,
      sm: sctx.machine,
      api: app.telegram.api,
      settings: app.settings,
      db: app.db,
      reply: (text) => app.telegram.api.sendMessage(sctx.chatId, text)
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
          await app.whatsapp.logoutSession(args[0], { deleteCreds: false });
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
          return showPackSelection(ctx, Number(args[1] ?? 0));
        }
        case 'packPage':
          return showPackSelection(ctx, Number(args[0]));
        case 'toCaption':
          return showCaptionMenu(ctx);
        case 'captionMode': {
          const sel = getSelection(ctx.tgId);
          const mode = args[0];
          if (mode === 'default') {
            sel.caption = null;
            sel.captionMode = 'default';
            return showChannelSelection(ctx, sel.sessionId);
          }
          if (mode === 'ai') {
            await ctx.reply('♡ let me write something cute…');
            const totals = sel.packs.reduce((acc, p) => {
              const s = splitSummary(p.count, ctx.settings.get('whatsapp.physicalStickerPackLimit') ?? 60);
              acc.stickers += p.count; acc.packs += s.packs;
              return acc;
            }, { stickers: 0, packs: 0 });
            try {
              const { text } = await app.ai.caption({
                query: sel.packs[0]?.query ?? '',
                stickers: totals.stickers,
                packs: totals.packs
              });
              sel.caption = text;
              sel.captionMode = 'ai';
            } catch (error) {
              app.logger?.warn({ err: error }, 'ai caption failed — using default');
              sel.caption = null;
              sel.captionMode = 'default';
            }
            return showChannelSelection(ctx, sel.sessionId);
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
          return showChannelSelection(ctx, sel.sessionId);
        }
        case 'toPreview':
          return showFinalPreview(ctx);
        case 'toPacks':
          return showPackSelection(ctx, 0);
        case 'post_confirm': {
          const sctx = ctx.sm.ctxFor(ctx.tgId);
          return executePublish(sctx);
        }
        case 'channels':
          return showChannels(ctx, args[0]);
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
        case 'media':
          return ctx.reply('♡ Media sending (images/videos/albums) is available inside a session — this is the control center ♡');
        case 'sessionSettings':
          return ctx.reply('♡ Session settings live in Settings → WhatsApp ♡');
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

function pairingCodeRich(number, name, code) {
  const b = new RichMessageBuilder();
  b.paragraph(rt.bold('╭────────────────────────────╮\n│      ♡ PAIRING LANCY       │\n╰────────────────────────────╯'));
  b.divider();
  b.table(kvTable([
    ['Number', number.formatted],
    ['Session', name],
    ['Pairing code', code]
  ]), { compact: true });
  b.divider();
  b.paragraph(rt.italic('on your phone: WhatsApp → Linked devices → Link with phone number → enter the code ♡'));
  b.paragraph(rt.italic('I am waiting for the connection…'));
  b.footer(rt.italic('the code expires — I will tell you if we run out of time ♡'));
  b.validate();
  return b.toJSON();
}

function pairingErrorRich(error) {
  const b = new RichMessageBuilder();
  b.heading('♡ PAIRING FAILED', 2);
  b.paragraph(rt.italic(String(error?.userMessage ?? error?.message ?? 'something went wrong')));
  b.divider();
  b.buttons([
    richButton.callback('♡ Try Again', encodeCallback('whatsapp', 'pair')),
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
    richButton.callback('♡ Try Again', encodeCallback('whatsapp', 'pair')),
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
  b.table(kvTable([
    ['Stickers', String(results.totals.stickers)],
    ['WhatsApp packs', String(results.totals.physicalPacks)],
    ['Channels', String(results.totals.destinations)],
    ['Successful', `${results.totals.succeeded}/${results.totals.succeeded + results.totals.failed}`],
    ['Failed', String(results.totals.failed)]
  ]), { compact: true });
  b.divider();
  for (const target of results.targets) {
    b.paragraph(rt.concat(
      rt.text(target.status === 'sent' ? '🟢' : target.status === 'skipped' ? '🟡' : '🔴'),
      rt.text(` ${target.name ?? target.jid} — ${target.status}${target.error ? ` (${target.error})` : ''}`)
    ));
  }
  b.divider();
  b.buttons([
    richButton.callback('✦ Publish Another', encodeCallback('whatsapp', 'open')),
    richButton.callback('✓ Done', encodeCallback('dashboard', 'open'))
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
    richButton.callback('♡ Retry', encodeCallback('whatsapp', 'open')),
    richButton.callback('✦ Home', encodeCallback('dashboard', 'open'))
  ]);
  b.validate();
  return b.toJSON();
}
