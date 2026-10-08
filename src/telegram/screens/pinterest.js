import { RichMessageBuilder, rt, richButton, encodeCallback } from '../rich.js';
import { navButtons, kvTable, ACCENT, SPARK } from '../ui.js';
import { States } from '../../core/stateMachine.js';
import { ProgressTracker } from '../progress.js';
import { SEARCH_MODES } from '../../pinterest/search.js';
import { truncate } from '../../utils/text.js';

/**
 * Pinterest screen + deep search flow.
 *
 * Menu → Search → (query) → ONE live progress Rich Message → results with
 * previews → "Make Sticker Pack" hands off to the stickers flow.
 *
 * Callback routing: the TelegramController routes by screen prefix to this
 * module; text input is routed by the state machine (PINTEREST_SEARCH).
 */
export function createPinterestScreen({ app }) {
  const id = 'pinterest';
  const activeSearches = new Map(); // tgId -> AbortController

  // ── Menu ────────────────────────────────────────────────────────────────
  function renderMenu(ctx) {
    const b = new RichMessageBuilder();
    b.heading(`${SPARK} PINTEREST`, 1);
    b.paragraph(rt.italic('deep, duplicate-free searches ♡ pick a mode:'));
    b.divider();
    b.buttons([
      richButton.callback('♡ Search', encodeCallback(id, 'search')),
      richButton.callback('✦ Random', encodeCallback(id, 'mode', 'random'))
    ]);
    b.buttons([
      richButton.callback('⊞ Mixed', encodeCallback(id, 'mode', 'mixed')),
      richButton.callback('🖼 Images Only', encodeCallback(id, 'mode', 'images')),
      richButton.callback('🎬 Videos Only', encodeCallback(id, 'mode', 'videos'))
    ]);
    b.buttons([
      richButton.callback('🕘 Search History', encodeCallback(id, 'history')),
      richButton.callback('★ Saved Results', encodeCallback(id, 'history'))
    ]);
    b.divider();
    b.buttons(navButtons(id, { back: false, home: true }));
    b.footer(rt.italic(`depth: ${ctx.settings.get('pinterest.searchDepth')} • duplicates are always filtered ♡`));
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

  // ── Search flow ─────────────────────────────────────────────────────────
  async function askQuery(ctx, mode) {
    await ctx.sm.transition(ctx.tgId, States.PINTEREST_SEARCH, {
      context: { mode },
      chatId: ctx.chatId,
      screenMessageId: ctx.messageId
    });
    const b = new RichMessageBuilder();
    b.heading(`${SPARK} PINTEREST SEARCH`, 1);
    b.paragraph(rt.concat(rt.text('mode: '), rt.bold(mode), rt.text(`  •  depth: ${ctx.settings.get('pinterest.searchDepth')}`)));
    b.divider();
    b.paragraph(rt.italic('tell me what to search for ♡'));
    b.paragraph(rt.text('example: '), rt.code('gojo satoru'));
    b.divider();
    b.buttons(navButtons(id, { cancel: true, home: true }));
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  async function runSearch(sctx, query) {
    const mode = sctx.context.mode ?? 'mixed';
    const depth = app.settings.get('pinterest.searchDepth') ?? 'deep';
    const userId = Number(sctx.tgId);
    const api = app.telegram.api;
    const chatId = sctx.chatId;

    const tracker = new ProgressTracker({ api, chatId });
    await tracker.start(progressRich({ stage: 'searching', mode, depth, query }));

    const controller = new AbortController();
    activeSearches.set(sctx.tgId, controller);

    try {
      const result = await app.queues.add('pinterest', {
        type: 'pinterest-search',
        userId,
        payload: { query, mode, depth },
        run: async (job, qctx) => app.pinterest.search({
          userId,
          query,
          mode,
          depth,
          signal: AbortSignal.any([controller.signal, qctx.signal].filter(Boolean)),
          onProgress: (p) => {
            void tracker.update(progressRich({ stage: p.stage ?? 'searching', mode, depth, query, ...p }));
          }
        })
      }, { attempts: 2 });

      await sctx.transition(States.PINTEREST_RESULTS, {
        context: {
          searchId: result.searchId,
          query,
          mode,
          depth,
          stats: result.stats,
          screenMessageId: tracker.messageId
        },
        chatId
      });
      await tracker.finish(resultsRich(result));
    } catch (error) {
      await tracker.finish(errorRich(error));
      if (error?.name === 'AbortError' || /cancelled/i.test(String(error?.message))) {
        await sctx.reset({ reason: 'cancelled' });
        await openMenu({ api, chatId, messageId: null, message: null, sm: sctx.machine, tgId: sctx.tgId, settings: app.settings }).catch(() => {});
      }
    } finally {
      activeSearches.delete(sctx.tgId);
    }
  }

  // ── Results ─────────────────────────────────────────────────────────────
  async function showResults(ctx) {
    const { searchId, query, mode, stats, screenMessageId } = ctx.sm.context(ctx.tgId);
    const rows = app.pinterest.db.all(
      `SELECT * FROM pinterest_media WHERE search_id = ? AND status = 'valid' AND is_duplicate = 0
       ORDER BY quality_score DESC LIMIT 60`,
      searchId
    );
    const b = new RichMessageBuilder();
    b.heading(`${SPARK} RESULTS`, 1);
    b.table(kvTable([
      ['Query', query],
      ['Mode', mode],
      ['Unique results', String(rows.length)],
      ['Duplicates removed', String(stats?.duplicatesFound ?? 0)],
      ['Pages searched', String(stats?.pagesFetched ?? 0)]
    ]), { compact: true });
    b.divider();

    // Preview up to 6 image results as photo blocks (attach:// uploads).
    const previews = rows.slice(0, 6).filter((r) => r.type === 'image' && r.sha256);
    const files = {};
    let i = 0;
    for (const p of previews) {
      const buffer = app.media.cache.read(p.sha256);
      if (buffer) {
        const name = `preview_${i++}`;
        files[name] = { buffer, filename: `${name}.jpg`, contentType: p.mime ?? 'image/jpeg' };
        b.photo(`attach://${name}`);
      }
    }
    if (i > 0) b.divider();

    b.heading(`${ACCENT} top picks`, 3);
    b.table(rows.slice(0, 8).map((r, idx) => [
      { text: `#${idx + 1}`, align: 'left', valign: 'middle' },
      { text: r.type === 'video' ? '🎬' : '🖼', align: 'left', valign: 'middle' },
      { text: truncate(r.media_url, 40), align: 'left', valign: 'middle' },
      { text: r.width && r.height ? `${r.width}×${r.height}` : '—', align: 'right', valign: 'middle' }
    ]), { compact: true });
    b.divider();
    b.buttons([
      richButton.callback('✦ Make Sticker Pack', encodeCallback('stickers', 'fromSearch', searchId), { style: 'primary' }),
      richButton.callback('🕘 New Search', encodeCallback(id, 'search'))
    ]);
    b.buttons(navButtons(id, { home: true, cancel: true }));
    b.footer(rt.italic('every result is unique — SHA-256 + perceptual hashing ♡'));
    b.validate();

    const rich = b.toJSON();
    const chatId = ctx.chatId;
    if (screenMessageId) {
      await ctx.api.editMessageRich(chatId, screenMessageId, rich, {}, files).catch(async (error) => {
        if (/not modified|not found/i.test(String(error?.description ?? error?.message))) return;
        await ctx.api.sendRichMessage(chatId, rich, {}, files);
      });
    } else if (ctx.messageId && ctx.message) {
      await ctx.editScreen(rich, files);
    } else {
      await ctx.api.sendRichMessage(chatId, rich, {}, files);
    }
  }

  // ── History ─────────────────────────────────────────────────────────────
  async function showHistory(ctx) {
    const rows = app.pinterest.recentSearches(Number(ctx.tgId), 10);
    const b = new RichMessageBuilder();
    b.heading('🕘 SEARCH HISTORY', 2);
    b.divider();
    if (!rows.length) {
      b.paragraph(rt.italic('no searches yet ♡'));
    } else {
      b.table(rows.map((r) => [
        { text: r.query, align: 'left', valign: 'middle' },
        { text: r.mode, align: 'left', valign: 'middle' },
        { text: String(r.result_count), align: 'right', valign: 'middle' },
        { text: r.created_at.slice(0, 10), align: 'right', valign: 'middle' }
      ]), { compact: true });
      b.spacer();
      b.paragraph(rt.italic('tap a search to run it again:'));
      for (const r of rows.slice(0, 6)) {
        b.buttons([richButton.callback(`♡ ${truncate(r.query, 24)}`, encodeCallback(id, 'reuse', r.id))]);
      }
    }
    b.divider();
    b.buttons(navButtons(id, { home: true }));
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  async function reuseSearch(ctx, searchId) {
    const row = app.pinterest.db.get(
      'SELECT * FROM pinterest_searches WHERE id = ? AND user_id = ?',
      Number(searchId), Number(ctx.tgId)
    );
    if (!row) {
      await ctx.reply('♡ That search is gone — try a new one.');
      return;
    }
    await ctx.sm.transition(ctx.tgId, States.PINTEREST_SEARCH, {
      context: { mode: row.mode },
      chatId: ctx.chatId,
      screenMessageId: ctx.messageId
    });
    await runSearch(ctx.sm.ctxFor(ctx.tgId), row.query);
  }

  // ── State machine handlers ──────────────────────────────────────────────
  function registerStateHandlers(sm) {
    sm.register(States.PINTEREST_SEARCH, {
      onMessage: async (sctx, message) => {
        const query = (message.text ?? '').trim();
        if (!query) return false;
        if (!message.text) return false; // photos etc. are not queries here
        await app.telegram.api.sendMessage(sctx.chatId, `♡ searching for "${truncate(query, 40)}"… one moment ♡`).catch(() => {});
        await runSearch(sctx, query);
        return true;
      },
      onTimeout: async (sctx) => {
        await app.telegram.api.sendMessage(sctx.chatId, '♡ search timed out — send a new query whenever you are ready.').catch(() => {});
      },
      onCleanup: (sctx) => {
        activeSearches.get(sctx.tgId)?.abort();
        activeSearches.delete(sctx.tgId);
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
        case 'search':
          return askQuery(ctx, 'mixed');
        case 'mode': {
          const mode = args[0] ?? 'mixed';
          if (!SEARCH_MODES.includes(mode)) return;
          return askQuery(ctx, mode);
        }
        case 'results':
          return showResults(ctx);
        case 'history':
          return showHistory(ctx);
        case 'reuse':
          return reuseSearch(ctx, args[0]);
        case 'back':
        case 'cancel':
          activeSearches.get(ctx.tgId)?.abort();
          await ctx.sm.cancel(ctx.tgId);
          return openMenu(ctx);
        case 'noop':
          return;
        default:
          return openMenu(ctx);
      }
    }
  };
}

// ── Progress / results / error renderers ────────────────────────────────────

function progressRich({ stage, mode, depth, query, ...p }) {
  const b = new RichMessageBuilder();
  b.paragraph(rt.bold('╭──────────────────────────────╮\n│      ✦ SEARCHING ✦           │\n╰──────────────────────────────╯'));
  b.divider();
  b.table([
    [
      { text: 'Query', align: 'left', valign: 'middle' },
      { text: rt.bold(truncate(query ?? '', 30)), align: 'left', valign: 'middle' }
    ],
    [
      { text: 'Mode', align: 'left', valign: 'middle' },
      { text: rt.bold(mode ?? 'mixed'), align: 'left', valign: 'middle' }
    ],
    [
      { text: 'Depth', align: 'left', valign: 'middle' },
      { text: rt.bold(depth ?? 'deep'), align: 'left', valign: 'middle' }
    ]
  ], { compact: true });
  b.divider();
  if (stage === 'searching') {
    b.paragraph(rt.concat(rt.italic('♡ finding the good ones…'), rt.text(`\npages: ${p.pagesFetched ?? 0} • found: ${p.collected ?? 0}`)));
  } else if (stage === 'validating') {
    b.paragraph(rt.concat(rt.italic('♡ removing twins & checking quality…'), rt.text(`\nchecked: ${p.processed ?? 0}/${p.total ?? 0} • unique: ${p.valid ?? 0}`)));
  } else {
    b.paragraph(rt.italic('♡ almost there…'));
  }
  b.footer(rt.italic('one message, live updates ♡'));
  b.validate();
  return b.toJSON();
}

function resultsRich(result) {
  const b = new RichMessageBuilder();
  b.heading('✦ SEARCH COMPLETE', 1);
  b.table([
    [
      { text: 'Query', align: 'left', valign: 'middle' },
      { text: rt.bold(result.query), align: 'left', valign: 'middle' }
    ],
    [
      { text: 'Mode', align: 'left', valign: 'middle' },
      { text: rt.bold(result.mode), align: 'left', valign: 'middle' }
    ],
    [
      { text: 'Unique results', align: 'left', valign: 'middle' },
      { text: rt.bold(String(result.results.length)), align: 'left', valign: 'middle' }
    ],
    [
      { text: 'Duplicates removed', align: 'left', valign: 'middle' },
      { text: rt.bold(String(result.stats.duplicatesFound)), align: 'left', valign: 'middle' }
    ]
  ], { compact: true });
  b.divider();
  b.paragraph(rt.italic('previews are one tap away ♡'));
  b.buttons([richButton.callback('✦ See Results', encodeCallback('pinterest', 'results'))]);
  b.validate();
  return b.toJSON();
}

function errorRich(error) {
  const b = new RichMessageBuilder();
  b.heading('♡ SEARCH FAILED', 2);
  b.paragraph(rt.italic(String(error?.userMessage ?? error?.message ?? 'something went wrong')));
  b.divider();
  b.buttons([
    richButton.callback('♡ Try Again', encodeCallback('pinterest', 'search')),
    richButton.callback('✦ Home', encodeCallback('dashboard', 'open'))
  ]);
  b.validate();
  return b.toJSON();
}
