import { RichMessageBuilder, rt, richButton, encodeCallback } from '../rich.js';
import { navButtons, kvTable, packCard, ACCENT, SPARK } from '../ui.js';
import { States } from '../../core/stateMachine.js';
import { ProgressTracker } from '../progress.js';
import { resolveLimits } from '../../stickers/limits.js';
import { LancyError } from '../../core/errors.js';
import { formatDateTime, truncate } from '../../utils/text.js';

/**
 * TG Stickers screen + pack creation flows.
 *
 *   TG Stickers → Pinterest → Sticker → count → source → deep search →
 *   live conversion/creation progress → completion card
 *
 *   TG Stickers → Add Sticker (manual) → count → collect images →
 *   partial-collection handling → convert → completion card
 *
 *   My Packs → paginated cards → Add Stickers / Open / Details
 */
export function createStickersScreen({ app }) {
  const id = 'stickers';
    const manualCollectors = new Map(); // tgId -> { wanted, collected: [{fileId, sha256}], messageIds: [] }

  // ── Menu ────────────────────────────────────────────────────────────────
  function renderMenu(ctx) {
    const b = new RichMessageBuilder();
    b.heading(`${SPARK} TG STICKERS`, 1);
    b.paragraph(rt.italic('turn beautiful media into Telegram sticker packs ♡'));
    b.divider();
    b.buttons([
      richButton.callback('✦ Pinterest → Sticker', encodeCallback(id, 'p2s'), { style: 'primary' }),
      richButton.callback('🖼 Manual Image Selection', encodeCallback(id, 'manual'))
    ]);
    b.buttons([
      richButton.callback('➕ Add to Existing Pack', encodeCallback(id, 'addExisting')),
      richButton.callback('📚 My Packs', encodeCallback(id, 'packs'))
    ]);
    b.divider();
    b.buttons(navButtons(id, { back: false, home: true }));
    const limits = resolveLimits(ctx.settings, 'static');
    b.footer(rt.italic(`telegram packs hold up to ${limits.perSet} stickers ♡`));
    b.validate();
    return b.toJSON();
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

  async function openMenu(ctx) {
    await editOrSend(ctx, renderMenu(ctx));
  }

  // ── Pinterest → Sticker ─────────────────────────────────────────────────
  async function startPinterestToSticker(ctx) {
    const limits = resolveLimits(ctx.settings, 'static');
    const max = limits.perSet;
    const b = new RichMessageBuilder();
    b.heading(`${SPARK} PINTEREST → STICKER`, 1);
    b.paragraph(rt.italic('how many stickers should your pack have? ♡'));
    b.divider();
    b.table(kvTable([
      ['Telegram limit', `${max} per pack`],
      ['Default', String(ctx.settings.get('stickers.defaultStickerAmount') ?? 30)]
    ]), { compact: true });
    b.divider();
    const presets = [10, 20, 30, 40, 50, 60, 90, 120].filter((n) => n <= max);
    for (let i = 0; i < presets.length; i += 4) {
      b.buttons(presets.slice(i, i + 4).map((n) =>
        richButton.callback(String(n), encodeCallback(id, 'p2sCount', n))));
    }
    b.buttons([richButton.callback('✎ Custom', encodeCallback(id, 'p2sCustom'))]);
    b.divider();
    b.buttons(navButtons(id, { home: true }));
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  async function askSource(ctx, count) {
    await ctx.sm.transition(ctx.tgId, States.STICKER_COUNT_SELECTION, {
      context: { flow: 'p2s', count, stage: 'source' },
      chatId: ctx.chatId,
      screenMessageId: ctx.messageId
    });
    const recent = app.pinterest.recentSearches(Number(ctx.tgId), 1)[0];
    const b = new RichMessageBuilder();
    b.heading('✦ MAKE YOUR PACK', 2);
    b.table(kvTable([
      ['Stickers', String(count)],
      ['Source', 'Pinterest']
    ]), { compact: true });
    b.divider();
    b.paragraph(rt.italic('where should the media come from? ♡'));
    b.buttons([
      richButton.callback('♡ Search Pinterest', encodeCallback(id, 'p2sSource', 'search'), { style: 'primary' })
    ]);
    if (recent) {
      b.buttons([richButton.callback(`✦ Use recent: "${truncate(recent.query, 24)}"`, encodeCallback(id, 'p2sSource', 'recent', recent.id))]);
    }
    b.buttons([richButton.callback('✕ Cancel', encodeCallback(id, 'cancel'), { style: 'danger' })]);
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  async function askQueryForPack(ctx, count) {
    await ctx.sm.transition(ctx.tgId, States.PINTEREST_SEARCH, {
      context: { flow: 'p2s', count, mode: 'mixed', packFlow: true },
      chatId: ctx.chatId,
      screenMessageId: ctx.messageId
    });
    const b = new RichMessageBuilder();
    b.heading('✦ MAKE YOUR PACK', 2);
    b.table(kvTable([['Stickers', String(count)]]), { compact: true });
    b.divider();
    b.paragraph(rt.italic('what should I search on Pinterest? ♡'));
    b.paragraph(rt.text('example: '), rt.code('gojo satoru'));
    b.divider();
    b.buttons(navButtons(id, { cancel: true, home: true }));
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  /**
   * The pack creation pipeline: deep search → dedupe → convert →
   * createNewStickerSet → addStickerToSet → DB. ONE live progress message.
   */
  async function createPackFromSearch(sctx, query) {
    const { count } = sctx.context;
    const userId = Number(sctx.tgId);
    const api = app.telegram.api;
    const chatId = sctx.chatId;
    const settings = app.settings;

    const tracker = new ProgressTracker({ api, chatId });
    await tracker.start(packProgressRich({ stage: 'searching', count, query }));

    try {
      // 1. Deep search (deduped, ranked).
      const search = await app.queues.add('pinterest', {
        type: 'pinterest-search',
        userId,
        payload: { query, count },
        run: async (job, qctx) => app.pinterest.search({
          userId, query, mode: 'mixed', depth: settings.get('pinterest.searchDepth') ?? 'deep',
          signal: qctx.signal,
          onProgress: (p) => tracker.update(packProgressRich({ stage: p.stage ?? 'searching', count, query, ...p }))
        })
      }, { attempts: 2 });

      const unique = search.results.slice(0, count);
      if (unique.length === 0) {
        throw new LancyError('♡ I could not find any usable media for that search.', { code: 'NO_RESULTS' });
      }

      // 2. Convert + create with live progress.
      await sctx.transition(States.PACK_CREATION, {
        context: { ...sctx.context, searchId: search.searchId, packQuery: query },
        chatId
      });

      const result = await app.queues.add('stickers', {
        type: 'create-pack',
        userId,
        payload: { query, count: unique.length },
        run: async (job, qctx) => {
          // Progress: converting → creating → adding.
          const onProgress = (info) => {
            if (info.stage === 'converting') {
              tracker.update(packProgressRich({ stage: 'converting', count, query, done: info.done, total: info.total, found: search.results.length, unique: unique.length }));
            } else if (info.stage === 'creating') {
              tracker.update(packProgressRich({ stage: 'creating', count, query, found: search.results.length, unique: unique.length }));
            } else if (info.stage === 'adding') {
              tracker.update(packProgressRich({ stage: 'adding', count, query, done: info.done, total: info.total, found: search.results.length, unique: unique.length }));
            }
          };
          const pack = await app.packs.createPackFromMedia({
            userId,
            query,
            descriptors: unique,
            stickerType: 'static',
            onProgress
          });
          return pack;
        }
      }, { attempts: 1, signal: undefined });

      // 3. Mark delivered (no-duplicate guarantee) + persist.
      app.pinterest.markResultsDelivered(userId, search.searchId, unique);
      app.db.audit(userId, 'pack.created', { packId: result.packId, query, count: result.count });

      await sctx.transition(States.IDLE, { context: {}, chatId, pushHistory: false });
      await tracker.finish(completionRich(settings, result, { duplicates: search.stats.duplicatesFound, query }));
    } catch (error) {
      await tracker.finish(packErrorRich(error));
      await sctx.reset({ reason: 'pack-failed' });
    }
  }

  // ── Manual image selection ──────────────────────────────────────────────
  async function startManual(ctx) {
    const b = new RichMessageBuilder();
    b.heading('🖼 MANUAL IMAGE SELECTION', 1);
    b.paragraph(rt.italic('how many stickers do you want? ♡'));
    b.divider();
    const limits = resolveLimits(ctx.settings, 'static');
    for (let i = 0; i < [10, 20, 30, 50, 100, 120].filter((n) => n <= limits.perSet).length; i += 3) {
      const row = [10, 20, 30, 50, 100, 120].filter((n) => n <= limits.perSet).slice(i, i + 3);
      b.buttons(row.map((n) => richButton.callback(String(n), encodeCallback(id, 'manualCount', n))));
    }
    b.buttons([richButton.callback('✎ Custom', encodeCallback(id, 'manualCustom'))]);
    b.divider();
    b.buttons(navButtons(id, { home: true }));
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  async function beginCollection(ctx, count) {
    manualCollectors.set(ctx.tgId, { wanted: count, collected: [], messageIds: [] });
    await ctx.sm.transition(ctx.tgId, States.MANUAL_STICKER_COLLECTION, {
      context: { wanted: count, collected: [] },
      chatId: ctx.chatId,
      screenMessageId: ctx.messageId
    });
    const b = new RichMessageBuilder();
    b.heading('🖼 SEND YOUR IMAGES', 2);
    b.table(kvTable([
      ['Needed', String(count)],
      ['Collected', '0']
    ]), { compact: true });
    b.divider();
    b.paragraph(rt.concat(rt.bold(`Perfect ♡ Send me ${count} images.`), rt.text('\nI will wait — take your time ♡')));
    b.divider();
    b.buttons([
      richButton.callback('✓ Convert What I Sent', encodeCallback(id, 'manualConvert')),
      richButton.callback('✕ Cancel', encodeCallback(id, 'cancel'), { style: 'danger' })
    ]);
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  async function onManualPhoto(sctx, message) {
    const collector = manualCollectors.get(sctx.tgId);
    if (!collector) return false;
    const photo = message.photo?.[message.photo.length - 1];
    const fileId = photo?.file_id ?? message.document?.file_id;
    if (!fileId) return false;
    if (collector.collected.length >= collector.wanted) {
      await app.telegram.api.sendMessage(sctx.chatId, `♡ I already have ${collector.wanted} — press "Convert What I Sent" ♡`).catch(() => {});
      return true;
    }
    collector.collected.push({ fileId, messageId: message.message_id });
    collector.messageIds.push(message.message_id);
    sctx.update({ collectedCount: collector.collected.length });

    if (collector.collected.length >= collector.wanted) {
      await app.telegram.api.sendMessage(sctx.chatId, `♡ Got all ${collector.wanted} images — converting now ♡`).catch(() => {});
      await convertManual(sctx);
      return true;
    }

    // Gentle inline counter — no spam: only update on milestones.
    const remaining = collector.wanted - collector.collected.length;
    const b = new RichMessageBuilder();
    b.paragraph(rt.concat(rt.bold(`╭────────────────────────────╮\n│ ♡ I have ${collector.collected.length} / ${collector.wanted} images     │\n│                            │\n│ ${remaining} more ${remaining === 1 ? 'is' : 'are'} needed.         │\n╰────────────────────────────╯`)));
    b.buttons([
      richButton.callback('✓ Convert These', encodeCallback(id, 'manualConvert')),
      richButton.callback('✕ Cancel', encodeCallback(id, 'cancel'), { style: 'danger' })
    ]);
    await app.telegram.api.sendRichMessage(sctx.chatId, b.toJSON()).catch(() => {});
    return true;
  }

  async function convertManual(sctx) {
    const collector = manualCollectors.get(sctx.tgId);
    if (!collector || collector.collected.length === 0) return;
    const userId = Number(sctx.tgId);
    const api = app.telegram.api;
    const chatId = sctx.chatId;

    const tracker = new ProgressTracker({ api, chatId });
    await tracker.start(packProgressRich({ stage: 'converting', count: collector.collected.length, query: 'manual selection' }));

    try {
      // Download each image, validate, dedupe, convert.
      const descriptors = [];
      for (let i = 0; i < collector.collected.length; i++) {
        const { fileId } = collector.collected[i];
        const buffer = await app.stickerService.downloadSticker(fileId);
        const descriptor = await app.media.process({
          url: null, pinId: `manual-${userId}-${i}`, mediaUrl: `tgfile://${fileId}`, typeHint: 'image'
        }, { userId }).catch(async () => {
          // process() downloads from URL; for Telegram files we validate directly.
          const { validateMedia } = await import('../../media/validate.js');
          const { probeImage, hashBundle } = await import('../../media/convert.js');
          const validation = await validateMedia(buffer, { expectedType: 'image', probe: probeImage });
          const { sha256, phash } = await hashBundle(buffer);
          const verdict = app.media.dedup.check(userId, { sha256, phash, mediaUrl: `tgfile://${fileId}` });
          app.media.cache.store(buffer, { mime: validation.mime, width: validation.width, height: validation.height, type: 'image' });
          return {
            pinId: `manual-${userId}-${i}`,
            mediaUrl: `tgfile://${fileId}`,
            type: 'image',
            sha256, phash,
            mime: validation.mime,
            width: validation.width,
            height: validation.height,
            size: validation.size,
            duplicate: verdict.duplicate,
            buffer
          };
        });
        if (!descriptor.duplicate) descriptors.push(descriptor);
        await tracker.update(packProgressRich({ stage: 'converting', count: collector.collected.length, query: 'manual selection', done: i + 1, total: collector.collected.length }));
      }

      if (descriptors.length === 0) {
        throw new LancyError('♡ All of those images were ones I already gave you — send different ones ♡', { code: 'ALL_DUPES' });
      }

      const result = await app.queues.add('stickers', {
        type: 'create-pack',
        userId,
        payload: { source: 'manual', count: descriptors.length },
        run: async (job, qctx) => app.packs.createPackFromMedia({
          userId,
          query: 'manual selection',
          descriptors,
          stickerType: 'static',
          onProgress: (info) => {
            if (info.stage === 'converting') tracker.update(packProgressRich({ stage: 'converting', count: descriptors.length, query: 'manual selection', done: info.done, total: info.total }));
            else if (info.stage === 'adding') tracker.update(packProgressRich({ stage: 'adding', count: descriptors.length, query: 'manual selection', done: info.done, total: info.total }));
          }
        })
      }, { attempts: 1 });

      app.db.audit(userId, 'pack.created', { packId: result.packId, source: 'manual', count: result.count });
      await sctx.transition(States.IDLE, { context: {}, chatId, pushHistory: false });
      await tracker.finish(completionRich(app.settings, result, { duplicates: collector.collected.length - descriptors.length, query: 'manual selection' }));
    } catch (error) {
      await tracker.finish(packErrorRich(error));
      await sctx.reset({ reason: 'manual-failed' });
    } finally {
      // Clean up temporary collection state.
      manualCollectors.delete(sctx.tgId);
    }
  }

  // ── My Packs ─────────────────────────────────────────────────────────────
  async function showPacks(ctx, page = 0) {
    const pageSize = ctx.settings.get('telegram.paginationSize') ?? 5;
    const { packs, total } = app.packs.listPacks(Number(ctx.tgId), { limit: pageSize, offset: page * pageSize });
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const b = new RichMessageBuilder();
    b.heading('📚 MY PACKS', 1);
    b.paragraph(rt.italic(`${total} pack${total === 1 ? '' : 's'} • page ${page + 1}/${totalPages}`));
    b.divider();
    if (!packs.length) {
      b.paragraph(rt.italic('no packs yet ♡ make one from Pinterest or your own images.'));
    }
    for (const pack of packs) {
      const card = packCard(pack, { timeZone: ctx.settings.get('general.timezone') });
      b.raw(card.blocks);
      b.buttons([
        richButton.callback('➕ Add Stickers', encodeCallback(id, 'packAdd', pack.id)),
        richButton.url('♡ Open', pack.link),
        richButton.callback('ℹ Details', encodeCallback(id, 'packDetails', pack.id))
      ]);
      b.divider();
    }
    const navRow = [];
    if (page > 0) navRow.push(richButton.callback('← Prev', encodeCallback(id, 'packsPage', page - 1)));
    if (page < totalPages - 1) navRow.push(richButton.callback('Next →', encodeCallback(id, 'packsPage', page + 1)));
    if (navRow.length) b.buttons(navRow);
    b.buttons(navButtons(id, { home: true }));
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  async function showPackDetails(ctx, packId) {
    const pack = app.packs.getPack(Number(ctx.tgId), Number(packId));
    if (!pack) return ctx.reply('♡ That pack is gone.');
    const b = new RichMessageBuilder();
    b.heading(`${SPARK} PACK DETAILS`, 2);
    b.table(kvTable([
      ['Name', pack.title],
      ['Short name', pack.shortName],
      ['Created', formatDateTime(new Date(pack.createdAt), ctx.settings.get('general.timezone'))],
      ['Modified', formatDateTime(new Date(pack.modifiedAt), ctx.settings.get('general.timezone'))],
      ['Search', pack.query ?? '—'],
      ['Stickers', String(pack.count)],
      ['Type', pack.stickerType],
      ['Source', pack.source],
      ['Link', pack.link]
    ]), { compact: true });
    b.divider();
    b.buttons([
      richButton.callback('➕ Add Stickers', encodeCallback(id, 'packAdd', pack.id)),
      richButton.url('♡ Open Pack', pack.link),
      richButton.callback('← Back', encodeCallback(id, 'packs'))
    ]);
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  // ── State machine handlers ──────────────────────────────────────────────
  function registerStateHandlers(sm) {
    // Pinterest → Sticker: query input reuses PINTEREST_SEARCH, but the
    // completion is routed back here via the packFlow flag.
    sm.register(States.PINTEREST_SEARCH, {
      onMessage: async (sctx, message) => {
        if (!sctx.context.packFlow) return false; // pinterest screen owns it
        const query = (message.text ?? '').trim();
        if (!query) return false;
        await createPackFromSearch(sctx, query);
        return true;
      }
    });

    sm.register(States.MANUAL_STICKER_COLLECTION, {
      onMessage: async (sctx, message) => {
        if (message.photo || (message.document?.mime_type?.startsWith('image/'))) {
          return onManualPhoto(sctx, message);
        }
        if (message.text) {
          await app.telegram.api.sendMessage(sctx.chatId, '♡ Send me images — or press "Convert These" / "Cancel" ♡').catch(() => {});
          return true;
        }
        return false;
      },
      onTimeout: async (sctx) => {
        manualCollectors.delete(sctx.tgId);
        await app.telegram.api.sendMessage(sctx.chatId, '♡ image collection timed out — your images were cleared ♡').catch(() => {});
      },
      onCleanup: (sctx) => {
        manualCollectors.delete(sctx.tgId);
      }
    });
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
        case 'p2s':
          return startPinterestToSticker(ctx);
        case 'p2sCount':
          return askSource(ctx, Number(args[0]));
        case 'p2sCustom':
          return askCustomCount(ctx, 'p2s');
        case 'p2sSource': {
          const count = ctx.sm.context(ctx.tgId).count;
          if (args[0] === 'search') return askQueryForPack(ctx, count);
          if (args[0] === 'recent' && args[1]) {
            const row = app.pinterest.db.get('SELECT * FROM pinterest_searches WHERE id = ? AND user_id = ?', Number(args[1]), Number(ctx.tgId));
            if (!row) return ctx.reply('♡ That search is gone — search again ♡');
            await ctx.sm.transition(ctx.tgId, States.PINTEREST_SEARCH, {
              context: { flow: 'p2s', count, mode: row.mode, packFlow: true },
              chatId: ctx.chatId,
              screenMessageId: ctx.messageId
            });
            return createPackFromSearch(ctx.sm.ctxFor(ctx.tgId), row.query);
          }
          return askSource(ctx, count);
        }
        case 'manual':
          return startManual(ctx);
        case 'manualCount':
          return beginCollection(ctx, Number(args[0]));
        case 'manualCustom':
          return askCustomCount(ctx, 'manual');
        case 'manualConvert': {
          const sctx = ctx.sm.ctxFor(ctx.tgId);
          if (ctx.sm.state(ctx.tgId) !== States.MANUAL_STICKER_COLLECTION) return;
          return convertManual(sctx);
        }
        case 'packs':
          return showPacks(ctx, 0);
        case 'packsPage':
          return showPacks(ctx, Number(args[0]));
        case 'packDetails':
          return showPackDetails(ctx, args[0]);
        case 'packAdd':
          return ctx.reply('♡ "Add Stickers" needs new media — use Pinterest → Sticker or Manual Selection, then pick this pack ♡');
        case 'addExisting':
          return showPacks(ctx, 0);
        case 'fromSearch': {
          // Hand-off from Pinterest results: prefill count with result count.
          const searchId = Number(args[0]);
          const row = app.pinterest.db.get('SELECT * FROM pinterest_searches WHERE id = ? AND user_id = ?', searchId, Number(ctx.tgId));
          if (!row) return ctx.reply('♡ That search is gone — run it again ♡');
          await ctx.sm.transition(ctx.tgId, States.PINTEREST_SEARCH, {
            context: { flow: 'p2s', count: ctx.settings.get('stickers.defaultStickerAmount') ?? 30, mode: row.mode, packFlow: true, searchId },
            chatId: ctx.chatId,
            screenMessageId: ctx.messageId
          });
          return createPackFromSearch(ctx.sm.ctxFor(ctx.tgId), row.query);
        }
        case 'back':
          return ctx.sm.back(ctx.tgId).then(() => openMenu(ctx));
        case 'cancel':
          await ctx.sm.cancel(ctx.tgId);
          return openMenu(ctx);
        case 'noop':
          return;
        default:
          return openMenu(ctx);
      }
    }
  };

  async function askCustomCount(ctx, flow) {
    await ctx.sm.transition(ctx.tgId, States.STICKER_COUNT_SELECTION, {
      context: { flow, stage: 'custom' },
      chatId: ctx.chatId,
      screenMessageId: ctx.messageId
    });
    const b = new RichMessageBuilder();
    b.heading('✎ CUSTOM AMOUNT', 2);
    b.paragraph(rt.italic('send me the exact number of stickers ♡'));
    b.divider();
    b.buttons(navButtons(id, { cancel: true }));
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }
}

// ── Shared renderers ─────────────────────────────────────────────────────────

const STAGE_LINES = {
  searching: '♡ Searching Pinterest…',
  validating: '♡ Picking the HD versions…',
  converting: '♡ Turning them into stickers…',
  creating: '♡ Giving your pack some personality…',
  adding: '♡ Almost ready, pretty ♡'
};

function packProgressRich({ stage, count, query, done = 0, total = 0, found = 0, unique = 0 }) {
  const b = new RichMessageBuilder();
  b.paragraph(rt.bold('╭────────────────────────────╮\n│      ✦ MAKING YOUR PACK ✦  │\n╰────────────────────────────╯'));
  b.divider();
  b.table([
    [
      { text: 'Search', align: 'left', valign: 'middle' },
      { text: rt.bold(truncate(query ?? '', 28)), align: 'left', valign: 'middle' }
    ],
    [
      { text: 'Stickers', align: 'left', valign: 'middle' },
      { text: rt.bold(String(count)), align: 'left', valign: 'middle' }
    ]
  ], { compact: true });
  b.divider();
  const line = STAGE_LINES[stage] ?? '♡ Working…';
  const ratio = total > 0 ? done / total : (stage === 'searching' ? 0.2 : stage === 'creating' ? 0.85 : 0.5);
  const bar = `${'█'.repeat(Math.round(ratio * 12))}${'░'.repeat(12 - Math.round(ratio * 12))} ${Math.round(ratio * 100)}%`;
  b.paragraph(rt.concat(rt.italic(line), rt.text(`\n${bar}`)));
  if (found > 0 || unique > 0) {
    b.paragraph(rt.text(`\nfound: ${found} • unique: ${unique} • ready: ${done}/${total || count}`));
  }
  b.footer(rt.italic('one message, live updates ♡'));
  b.validate();
  return b.toJSON();
}

function completionRich(settings, pack, { duplicates = 0, query = '' } = {}) {
  const b = new RichMessageBuilder();
  b.paragraph(rt.bold('╭────────────────────────────╮\n│       ♡ PACK READY ♡       │\n╰────────────────────────────╯'));
  b.divider();
  b.heading(`${SPARK} ${pack.title}`, 2);
  b.table([
    [
      { text: 'Pack name', align: 'left', valign: 'middle' },
      { text: rt.bold(pack.title), align: 'left', valign: 'middle' }
    ],
    [
      { text: 'Stickers', align: 'left', valign: 'middle' },
      { text: rt.bold(String(pack.count)), align: 'left', valign: 'middle' }
    ],
    [
      { text: 'Search', align: 'left', valign: 'middle' },
      { text: truncate(query || 'manual selection', 30), align: 'left', valign: 'middle' }
    ],
    [
      { text: 'Created', align: 'left', valign: 'middle' },
      { text: formatDateTime(new Date(), settings.get('general.timezone')), align: 'left', valign: 'middle' }
    ],
    [
      { text: 'Duplicates removed', align: 'left', valign: 'middle' },
      { text: String(duplicates), align: 'left', valign: 'middle' }
    ],
    [
      { text: 'Source', align: 'left', valign: 'middle' },
      { text: 'Pinterest', align: 'left', valign: 'middle' }
    ]
  ], { compact: true });
  b.divider();
  b.buttons([
    richButton.url('♡ Open Pack', pack.link),
    richButton.callback('♡ WhatsApp', encodeCallback('whatsapp', 'publishPack', pack.packId))
  ]);
  b.buttons([
    richButton.callback('✦ Create Another', encodeCallback(id, 'p2s')),
    richButton.callback('✓ Done', encodeCallback('dashboard', 'open'))
  ]);
  b.footer(rt.italic(`pack id: ${pack.shortName}`));
  b.validate();
  return b.toJSON();
}

function packErrorRich(error) {
  const b = new RichMessageBuilder();
  b.heading('♡ PACK FAILED', 2);
  b.paragraph(rt.italic(String(error?.userMessage ?? error?.message ?? 'something went wrong')));
  b.divider();
  b.buttons([
    richButton.callback('♡ Try Again', encodeCallback('stickers', 'p2s')),
    richButton.callback('✦ Home', encodeCallback('dashboard', 'open'))
  ]);
  b.validate();
  return b.toJSON();
}
