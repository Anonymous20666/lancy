import { block, rt, richButton, encodeCallback } from '../rich.js';
import { States } from '../../core/stateMachine.js';
import { durationText, MusicError } from '../../music/model.js';
import { PANEL_ACTIONS } from '../../music/channelPanels.js';

const cut = (s, n = 60) => [...String(s || '')].slice(0, n).join('');

function isSafeHttpsUrl(raw) {
  try {
    const u = new URL(String(raw || ''));
    return u.protocol === 'https:' && !u.username && !u.password && u.hostname.includes('.') && !/^(?:127\.|10\.|192\.168\.|169\.254\.)/.test(u.hostname);
  } catch {
    return false;
  }
}

function appendLiveLog(b, ms) {
  if (Array.isArray(ms?.logLines) && ms.logLines.length) {
    b.blockquote(rt.text(`📡 Live Cinema Log\n${ms.logLines.slice(-8).join('\n')}`));
  }
}

/**
 * Modular Bot API 10.3 Movie & TV Series streaming UI + progressive resolver actions.
 */
export function createMovieUi({
  app,
  finish,
  card,
  isChannelCtx,
  reusableChannelSlotId,
  sendOrEditMenu,
  adoptChannelPlayerResult,
  clearChatSlot,
  temporary,
  menuMsgByChat,
  noticeMsgByChat,
  chatSlotKey,
  error
}) {
  const mvBtn = (ms, label, op, arg = '', opts = null) => {
    const data = encodeCallback('music', 'mv', ms.id, op, ...(arg !== '' && arg !== undefined && arg !== null ? [arg] : []));
    return opts ? richButton.callback(label, data, opts) : richButton.callback(label, data);
  };

  function getMusicButton(label, action, ...args) {
    return richButton.callback(label, encodeCallback('music', action, ...args));
  }

  function backToPlayerButton(ms) {
    if (ms.panelToken) {
      return richButton.callback(
        '◀ Back to Player',
        encodeCallback('music', 'pc', ms.panelToken, PANEL_ACTIONS.indexOf('player').toString(36))
      );
    }
    return getMusicButton('◀ Back to Player', 'openplayer');
  }

  function isGroupAdultAllowed(ctx) {
    const cid = Number(ctx?.chatId);
    if (!Number.isFinite(cid) || cid > 0) return true;
    return Boolean(app.db?.getSetting?.(`nsfw.groupEnabled.${cid}`, false));
  }

  function renderHub(ctx, ms) {
    const b = card('🎬 Lancy Music · Movie & Series Stream', 'HD VC Playback · Synced Subtitles · High-Capacity Downloads');
    b.blockquote(rt.text('Stream full movies & multi-season TV series into Voice Chat or download directly with paginated album slides.'));
    b.buttons([
      mvBtn(ms, '🔍 Search Movie / TV', 'ps', '', { style: 'success' }),
      mvBtn(ms, '🤖 AI Movie & Song', 'ai', '', { style: 'primary' })
    ]);
    b.buttons([
      mvBtn(ms, '🎲 Random Pick', 'rn', ''),
      mvBtn(ms, '🔥 Trending Now', 'tr', '0'),
      mvBtn(ms, '🍿 Categories', 'cg', '0')
    ]);
    const utilRow = [
      mvBtn(ms, '🎞 Cinema Queue', 'mq', ''),
      backToPlayerButton(ms)
    ];
    if (isGroupAdultAllowed(ctx)) {
      utilRow.push(richButton.callback('🔞 18+ Cinema', encodeCallback('nsfw', 'sub', 'real_videos')));
    }
    b.buttons(utilRow);
    b.details('💡 How Multi-Season TV & Album Slides Work', [
      block.paragraph(rt.text('1. Search any movie or series — tap ⬇ Download or ▶ Play / ➕ Queue.\n2. On series: tap [☑] to select episodes, or tap ☑ All Seasons to pick the entire show.\n3. Tap ⬇ Download Selected to get paginated album slides (◀ Prev / Next ▶).'))
    ], false);
    return finish(b);
  }

  function renderResults(ctx, ms) {
    const items = Array.isArray(ms.results) ? ms.results : [];
    const perPage = 5;
    const totalPages = Math.max(1, Math.ceil(items.length / perPage));
    ms.resultPage = Math.max(0, Math.min(Number(ms.resultPage) || 0, totalPages - 1));
    const slice = items.slice(ms.resultPage * perPage, (ms.resultPage + 1) * perPage);
    const title = ms.query ? `🎬 Results · ${cut(ms.query, 32)}` : (ms.categoryLabel ? `🍿 ${cut(ms.categoryLabel, 36)}` : '🔥 Trending Movies & Series');
    const b = card(title, `Page ${ms.resultPage + 1}/${totalPages} · ${items.length} titles`);

    if (!slice.length) {
      b.paragraph(rt.text('No matching movies or TV series found. Try a broader title, release year, or ask the AI Agent.'));
    } else {
      b.table(
        slice.map((item, idx) => [
          `${ms.resultPage * perPage + idx + 1}.`,
          `${item.type === 'tv' ? '📺 TV' : '🎬 Movie'} · ${cut(item.title, 34)}`,
          item.year ? String(item.year) : '—',
          item.rating ? `⭐ ${item.rating}` : '—'
        ]),
        { striped: true, bordered: true, compact: true }
      );
      const selectRow1 = [];
      const selectRow2 = [];
      slice.forEach((item, idx) => {
        const num = ms.resultPage * perPage + idx + 1;
        const icon = item.type === 'tv' ? '📺' : '🎬';
        const btn = mvBtn(ms, `${num}. ${icon} ${cut(item.title, 18)}`, 'pk', String(ms.resultPage * perPage + idx), idx === 0 ? { style: 'primary' } : null);
        if (idx < 2) selectRow1.push(btn);
        else selectRow2.push(btn);
      });
      if (selectRow1.length) b.buttons(selectRow1);
      if (selectRow2.length) b.buttons(selectRow2);
    }

    const nav = [];
    if (ms.resultPage > 0) nav.push(mvBtn(ms, '◀ Prev', 'rp', String(ms.resultPage - 1)));
    nav.push(mvBtn(ms, '🔍 New Search', 'ps', ''));
    if (ms.resultPage < totalPages - 1) nav.push(mvBtn(ms, 'Next ▶', 'rp', String(ms.resultPage + 1)));
    b.buttons(nav);

    b.buttons([
      mvBtn(ms, '🎲 Random', 'rn', ''),
      mvBtn(ms, '🤖 Ask AI', 'ai', ''),
      mvBtn(ms, '🏠 Hub', 'hb', '')
    ]);
    return finish(b);
  }

  function renderMovieDetail(ctx, ms) {
    const item = ms.mediaItem || {};
    const runtime = item.runtimeMinutes || item.runtime || null;
    const b = card(`🎬 ${cut(item.title || 'Movie', 52)}`, `${item.year || ''} ${item.rating ? `· ⭐ ${item.rating}` : ''} ${runtime ? `· ${runtime} min` : ''}`.trim());
    if (isSafeHttpsUrl(item.poster)) {
      b.photo(item.poster, cut(item.title, 90));
    }
    const meta = [
      ['Type', 'Full Feature Movie'],
      ['Year', item.year ? String(item.year) : 'Unknown'],
      ['Runtime', runtime ? `${runtime} min` : (item.runtimeSeconds ? durationText(item.runtimeSeconds) : 'Full feature')],
      ['Genres', item.genres?.length ? cut(item.genres.slice(0, 3).join(', '), 42) : 'Feature Film'],
      ['Subtitles', 'Screen Burn / Live Sync']
    ];
    b.table(meta, { striped: true, bordered: true, compact: true });
    if (item.overview) {
      b.expandableBlockquote(`Synopsis · ${cut(item.title, 48)}\n\n${cut(item.overview, 600)}`);
    }
    appendLiveLog(b, ms);
    if (ms.notice) b.paragraph(rt.italic(cut(ms.notice, 260)));

    b.buttons([
      mvBtn(ms, '⚡ Play Now', 'pm', '', { style: 'success' }),
      mvBtn(ms, '➕ Add to Queue', 'qm', '', { style: 'primary' })
    ]);
    b.buttons([
      mvBtn(ms, '⬇ Download Movie', 'dm', '', { style: 'success' }),
      mvBtn(ms, '🎞 Cinema Queue', 'mq', '')
    ]);
    const row2 = [];
    if (ms.results?.length) row2.push(mvBtn(ms, '◀ Results', 'rs', ''));
    row2.push(mvBtn(ms, '🏠 Hub', 'hb', ''));
    b.buttons(row2);
    return finish(b);
  }

  function renderTvSeason(ctx, ms) {
    const item = ms.mediaItem || {};
    const seasonNum = Number(ms.seasonNumber || 1);
    const episodes = Array.isArray(ms.episodes) ? ms.episodes : [];
    const perPage = 6;
    const totalPages = Math.max(1, Math.ceil(episodes.length / perPage));
    ms.epPage = Math.max(0, Math.min(Number(ms.epPage) || 0, totalPages - 1));
    const slice = episodes.slice(ms.epPage * perPage, (ms.epPage + 1) * perPage);
    const selectedSet = ms.selectedBySeason.get(seasonNum) || new Set();
    const totalSelected = app.movieSessions.totalSelectedCount(ms);
    const totalSeasons = ms.seasons?.length || 1;
    const seasonLabel = seasonNum === 0 ? 'Specials' : `Season ${seasonNum}`;

    const b = card(
      `📺 ${cut(item.title || 'Series', 48)}`,
      `${seasonLabel} of ${totalSeasons} · Page ${ms.epPage + 1}/${totalPages} · ${episodes.length} episodes`
    );
    if (isSafeHttpsUrl(item.poster) && ms.epPage === 0) {
      b.photo(item.poster, `${cut(item.title, 70)} · ${seasonLabel}`);
    }
    if (item.overview) {
      b.expandableBlockquote(`${cut(item.title, 48)} · ${item.year || ''} ${item.rating ? `⭐ ${item.rating}` : ''}\n\n${cut(item.overview, 500)}`);
    }

    if (!slice.length) {
      b.paragraph(rt.text(`No episode metadata found for ${seasonLabel}. Try choosing another season or searching another title.`));
    } else {
      b.list(
        slice.map(ep => {
          const epNum = Number(ep.episodeNumber || 0);
          const checked = selectedSet.has(epNum);
          const runtime = ep.runtimeMinutes ? ` (${ep.runtimeMinutes}m)` : '';
          return {
            is_checked: checked,
            blocks: [
              block.paragraph(
                rt.bold(`E${String(epNum).padStart(2, '0')}`),
                rt.text(` · ${cut(ep.title || `Episode ${epNum}`, 42)}${runtime}`)
              )
            ]
          };
        })
      );

      // Per-episode compact side-by-side row: [Toggle, ▶ Play, ➕ Queue, ⬇ Download]
      for (const ep of slice) {
        const epNum = Number(ep.episodeNumber || 0);
        const checked = selectedSet.has(epNum);
        b.buttons([
          mvBtn(ms, `${checked ? '☑' : '☐'} E${epNum}`, 'tg', `${seasonNum}-${epNum}`, checked ? { style: 'success' } : null),
          mvBtn(ms, '▶', 'pe', `${seasonNum}-${epNum}`, { style: 'primary' }),
          mvBtn(ms, '➕', 'qe', `${seasonNum}-${epNum}`),
          mvBtn(ms, '⬇', 'de', `${seasonNum}-${epNum}`, { style: 'success' })
        ]);
      }
    }

    b.buttons([
      mvBtn(ms, '☑ Page', 'sp', String(ms.epPage)),
      mvBtn(ms, `✅ All S${seasonNum}`, 'sa', String(seasonNum)),
      mvBtn(ms, '☑ All Seasons', 'sas', '', { style: 'primary' }),
      mvBtn(ms, '✕ Clear', 'cl', '')
    ]);

    const nav = [];
    if (ms.epPage > 0) nav.push(mvBtn(ms, '◀ Prev', 'ep', String(ms.epPage - 1)));
    nav.push(mvBtn(ms, `📚 Seasons (${totalSeasons})`, 'ss', '0', { style: 'primary' }));
    if (ms.epPage < totalPages - 1) nav.push(mvBtn(ms, 'Next ▶', 'ep', String(ms.epPage + 1)));
    b.buttons(nav);

    b.buttons([
      mvBtn(ms, `⚡ Play Selected (${totalSelected})`, 'px', '', { style: 'success' }),
      mvBtn(ms, `➕ Queue (${totalSelected})`, 'qx', '', { style: 'primary' })
    ]);
    b.buttons([
      mvBtn(ms, `⬇ Download Selected Slides (${totalSelected})`, 'dx', '', { style: 'success' })
    ]);

    appendLiveLog(b, ms);
    if (ms.notice) b.paragraph(rt.italic(cut(ms.notice, 260)));

    const tail = [];
    if (ms.results?.length) tail.push(mvBtn(ms, '◀ Results', 'rs', ''));
    tail.push(mvBtn(ms, '🏠 Hub', 'hb', ''));
    b.buttons(tail);
    return finish(b);
  }

  function renderSeasonPicker(ctx, ms) {
    const item = ms.mediaItem || {};
    const seasons = Array.isArray(ms.seasons) ? ms.seasons : [];
    const perPage = 12;
    const totalPages = Math.max(1, Math.ceil(seasons.length / perPage));
    ms.seasonPage = Math.max(0, Math.min(Number(ms.seasonPage) || 0, totalPages - 1));
    const slice = seasons.slice(ms.seasonPage * perPage, (ms.seasonPage + 1) * perPage);
    const totalSelected = app.movieSessions.totalSelectedCount(ms);

    const b = card(`📚 ${cut(item.title || 'Select Season', 46)}`, `${seasons.length} seasons available · Tap a season or select all`);
    b.table(
      slice.map(se => {
        const sNum = Number(se.seasonNumber || 0);
        const selCount = ms.selectedBySeason.get(sNum)?.size || 0;
        return [
          sNum === 0 ? 'Specials' : `Season ${sNum}`,
          `${se.episodeCount || '?'} eps`,
          selCount ? `✓ ${selCount} picked` : (se.airDate ? String(se.airDate).slice(0, 4) : '—')
        ];
      }),
      { striped: true, bordered: true, compact: true }
    );

    for (let i = 0; i < slice.length; i += 3) {
      b.buttons(
        slice.slice(i, i + 3).map(se => {
          const sNum = Number(se.seasonNumber || 0);
          const selCount = ms.selectedBySeason.get(sNum)?.size || 0;
          const active = sNum === Number(ms.seasonNumber);
          const lbl = `${sNum === 0 ? 'Specials' : `S${sNum}`}${se.episodeCount ? ` (${se.episodeCount})` : ''}${selCount ? ` ·✓${selCount}` : ''}`;
          return mvBtn(ms, lbl, 'so', String(sNum), active ? { style: 'success' } : null);
        })
      );
    }

    b.buttons([
      mvBtn(ms, '☑ Select All Seasons & All Episodes', 'sas', '', { style: 'success' })
    ]);
    if (totalSelected > 0) {
      b.buttons([
        mvBtn(ms, `⚡ Play All (${totalSelected})`, 'px', '', { style: 'success' }),
        mvBtn(ms, `➕ Queue (${totalSelected})`, 'qx', '', { style: 'primary' }),
        mvBtn(ms, `⬇ Slides (${totalSelected})`, 'dx', '', { style: 'success' })
      ]);
    }

    const nav = [];
    if (ms.seasonPage > 0) nav.push(mvBtn(ms, '◀ Prev Seasons', 'ss', String(ms.seasonPage - 1)));
    nav.push(mvBtn(ms, `◀ Back to S${ms.seasonNumber || 1}`, 'sv', ''));
    if (ms.seasonPage < totalPages - 1) nav.push(mvBtn(ms, 'Next Seasons ▶', 'ss', String(ms.seasonPage + 1)));
    b.buttons(nav);
    return finish(b);
  }

  function renderCategories(ctx, ms) {
    const cats = Array.isArray(ms.categories) ? ms.categories : [];
    const perPage = 8;
    const totalPages = Math.max(1, Math.ceil(cats.length / perPage));
    ms.catPage = Math.max(0, Math.min(Number(ms.catPage) || 0, totalPages - 1));
    const slice = cats.slice(ms.catPage * perPage, (ms.catPage + 1) * perPage);

    const b = card('🍿 Movie & Series Genres', `Page ${ms.catPage + 1}/${totalPages} · Pick a genre to browse`);
    for (let i = 0; i < slice.length; i += 2) {
      b.buttons(
        slice.slice(i, i + 2).map((cat, j) => mvBtn(ms, `🎬 ${cut(cat.name, 22)}`, 'cp', String(ms.catPage * perPage + i + j), { style: 'primary' }))
      );
    }
    const nav = [];
    if (ms.catPage > 0) nav.push(mvBtn(ms, '◀ Prev', 'cg', String(ms.catPage - 1)));
    nav.push(mvBtn(ms, '🎲 Surprise Me', 'rn', ''));
    if (ms.catPage < totalPages - 1) nav.push(mvBtn(ms, 'Next ▶', 'cg', String(ms.catPage + 1)));
    b.buttons(nav);
    b.buttons([mvBtn(ms, '🏠 Hub', 'hb', '')]);
    return finish(b);
  }

  function renderCurrentView(ctx, ms) {
    if (ms.view === 'results') return renderResults(ctx, ms);
    if (ms.view === 'movie') return renderMovieDetail(ctx, ms);
    if (ms.view === 'season') return renderTvSeason(ctx, ms);
    if (ms.view === 'seasons') return renderSeasonPicker(ctx, ms);
    if (ms.view === 'categories') return renderCategories(ctx, ms);
    return renderHub(ctx, ms);
  }

  async function cleanupSupersededCards(ctx, ms, keepId = null) {
    if (!ctx?.api?.deleteMessage) return;
    let activePlayerId = null;
    try {
      const dest = ms?.destination || app.music.destination(ctx);
      activePlayerId = dest ? app.musicQueueManager?.getSession?.(dest)?.screenMessageId : null;
    } catch {}
    const ids = new Set([
      ...(Array.isArray(ms?.activeCardIds) ? ms.activeCardIds : []),
      ...(ms?.messageId ? [ms.messageId] : []),
      ...(ms?.promptMessageId ? [ms.promptMessageId] : [])
    ]);
    for (const oldId of ids) {
      if (!oldId || oldId === keepId || oldId === activePlayerId) continue;
      await ctx.api.deleteMessage(ctx.chatId, oldId).catch(() => {});
    }
    if (keepId) ms.activeCardIds = [keepId];
  }

  async function upsertCard(ctx, ms, rich) {
    const isChan = isChannelCtx(ctx);
    const key = chatSlotKey(ctx);
    const editId = ms.messageId || (ctx.query && ctx.messageId) || (isChan ? reusableChannelSlotId(ctx) : null);

    if (editId && ctx.api?.editMessageRich) {
      try {
        const edited = await ctx.api.editMessageRich(ctx.chatId, editId, rich);
        ms.messageId = edited?.message_id || editId;
        app.movieSessions.registerMessage?.(ms, ms.messageId, 'card');
        if (ms.panelToken) app.music.channelPanels?.registerMessage?.(ms.panelToken, ms.messageId);
        if (isChan) {
          menuMsgByChat.set(key, { messageId: ms.messageId, token: ms.temporaryToken || null, api: ctx.api });
        }
        return ms.messageId;
      } catch (e) {
        if (/message is not modified/i.test(String(e?.description || e?.message || ''))) return editId;
      }
    }

    const sent = await ctx.api.sendRichMessage(ctx.chatId, rich);
    if (sent?.message_id) {
      ms.messageId = sent.message_id;
      app.movieSessions.registerMessage?.(ms, sent.message_id, 'card');
      await cleanupSupersededCards(ctx, ms, sent.message_id);
      if (ms.panelToken) app.music.channelPanels?.registerMessage?.(ms.panelToken, sent.message_id);
      if (isChan) {
        menuMsgByChat.set(key, { messageId: sent.message_id, token: ms.temporaryToken || null, api: ctx.api });
      }
    }
    return ms.messageId;
  }

  async function loadItemIntoSession(ms, item) {
    ms.mediaItem = item;
    ms.playback = null;
    ms.seasons = [];
    ms.episodes = [];
    ms.epPage = 0;
    ms.seasonPage = 0;
    ms.seasonNumber = 1;
    ms.episodeCache?.clear?.();
    ms.selectedBySeason?.clear?.();
    ms.dlManifest = null;
    ms.dlPage = 0;
    ms.notice = null;
    ms.logLines = null;
    if (item.type === 'tv') {
      const [detail, seasonsRes] = await Promise.all([
        app.movieApi.getTvShow(item.id).catch(() => null),
        app.movieApi.getTvSeasons(item.id).catch(() => null)
      ]);
      if (detail) {
        ms.mediaItem = { ...item, ...detail, type: 'tv' };
      }
      const list = seasonsRes?.seasons?.length
        ? seasonsRes.seasons
        : (detail?.seasons?.length ? detail.seasons : [{ seasonNumber: 1, name: 'Season 1', episodeCount: detail?.totalEpisodes || 0 }]);
      ms.seasons = list;
      // Default to Season 1 (first non-zero season when available)
      const firstSeason = list.find(s => Number(s.seasonNumber) > 0) || list[0];
      const sNum = Number(firstSeason?.seasonNumber || 1);
      ms.seasonNumber = sNum;
      ms.seasonName = firstSeason?.name || `Season ${sNum}`;
      ms.epPage = 0;
      const [epsRes, pb] = await Promise.all([
        app.movieApi.getTvSeasonEpisodes(item.id, sNum).catch(() => null),
        app.movieApi.getPlaybackInfo('tv', item.id, { season: sNum, episode: 1 }).catch(() => null)
      ]);
      ms.episodes = epsRes?.episodes || [];
      ms.playback = pb;
      ms.episodeCache.set(sNum, ms.episodes);
      ms.view = 'season';
    } else {
      const [detail, pb] = await Promise.all([
        app.movieApi.getMovie(item.id).catch(() => null),
        app.movieApi.getPlaybackInfo('movie', item.id).catch(() => null)
      ]);
      if (detail) {
        ms.mediaItem = { ...item, ...detail, type: 'movie' };
      }
      ms.playback = pb;
      ms.view = 'movie';
    }
  }

  async function createSessionForCtx(ctx, extra = {}) {
    let dest = null;
    try { dest = app.music.destination(ctx); } catch {}
    return app.movieSessions.create({
      chatId: ctx.chatId,
      userId: ctx.tgId,
      botKey: app.music?.botKey?.(ctx) || 'default',
      destination: dest,
      panelToken: ctx.musicPanel?.panelToken || null,
      channelMode: isChannelCtx(ctx),
      ...extra
    });
  }

  async function openHub(ctx) {
    await app.music.authorize(ctx, true, null, { allowDj: true });
    const prev = !ctx.query ? app.movieSessions.getLatestForChat(ctx.chatId) : null;
    const ms = await createSessionForCtx(ctx, { view: 'hub' });
    await upsertCard(ctx, ms, renderHub(ctx, ms));
    if (prev && prev.id !== ms.id && prev.messageId !== ms.messageId) {
      await cleanupSupersededCards(ctx, prev, ms.messageId);
    }
    return ms;
  }

  async function openMovieSearch(ctx, query, { random = false } = {}) {
    await app.music.authorize(ctx, true, null, { allowDj: true });
    const prev = !ctx.query ? app.movieSessions.getLatestForChat(ctx.chatId) : null;
    const ms = await createSessionForCtx(ctx);
    if (random) {
      const pick = await app.movieApi.pickRandom({});
      if (!pick) throw new MusicError('MOVIE_NOT_FOUND', 'No random movie was available right now. Try searching by title.');
      ms.results = [pick];
      await loadItemIntoSession(ms, pick);
      await upsertCard(ctx, ms, renderCurrentView(ctx, ms));
      if (prev && prev.id !== ms.id && prev.messageId !== ms.messageId) {
        await cleanupSupersededCards(ctx, prev, ms.messageId);
      }
      return ms;
    }
    const q = String(query || '').trim();
    if (!q) return openHub(ctx);
    const res = await app.movieApi.search(q, { limit: 20 });
    ms.query = q;
    ms.results = res?.results || [];
    ms.resultPage = 0;
    ms.view = 'results';
    await upsertCard(ctx, ms, renderResults(ctx, ms));
    if (prev && prev.id !== ms.id && prev.messageId !== ms.messageId) {
      await cleanupSupersededCards(ctx, prev, ms.messageId);
    }
    return ms;
  }

  async function startAiChat(ctx, initialText = '', { defaultDomain = 'auto' } = {}) {
    await app.music.authorize(ctx, true, null, { allowDj: true });
    const isChan = isChannelCtx(ctx);
    const group = Number(ctx.chatId) < 0 && !isChan;
    const stateKey = (isChan && Number(ctx.chatId) < 0) ? String(ctx.chatId) : ctx.tgId;
    const panelToken = ctx.musicPanel?.panelToken || null;
    const dest = app.music.destination(ctx);

    if (app.sm?.state?.(stateKey) === States.AI_MEDIA_CHAT) await app.sm.reset(stateKey);
    if (stateKey !== ctx.tgId && app.sm?.state?.(ctx.tgId) === States.AI_MEDIA_CHAT) await app.sm.reset(ctx.tgId);

    if (initialText && String(initialText).trim()) {
      return await handleAiTurn(ctx, String(initialText).trim(), { defaultDomain, panelToken, dest });
    }

    const intro = '🤖 AI Movie & Song Agent ready!\nAsk for any song mood, trending chart, movie recommendation, or TV series (e.g. "recommend a thriller movie", "play Breaking Bad", "trending Afrobeats", "surprise me"). Say "done" or tap Finish anytime.';
    const rich = finish(
      card('🤖 Lancy AI Agent', 'Movies · TV Series · Music · VC')
        .blockquote(rt.text(intro))
        .buttons([
          richButton.callback('🎬 Movie Hub', encodeCallback('music', 'mv', 'new', 'hb')),
          richButton.callback('🚪 Finish AI Chat', encodeCallback('music', 'aiclose', ''), { style: 'danger' })
        ])
    );

    let sent;
    if (isChan) {
      sent = await sendOrEditMenu(ctx, rich, { ttlMs: 300000 });
    } else if (group) {
      sent = await ctx.api.sendMessage(ctx.chatId, `${intro}\n\n(Reply to this message to chat)`, {
        reply_markup: { force_reply: true, selective: true },
        ...(ctx.message?.message_id ? { reply_to_message_id: ctx.message.message_id } : {})
      });
    } else {
      sent = await ctx.api.sendRichMessage(ctx.chatId, rich);
    }

    const temporaryToken = temporary.remember(ctx, sent, { ttlMs: 300000 });
    await app.sm.transition(stateKey, States.AI_MEDIA_CHAT, {
      chatId: ctx.chatId,
      timeoutMs: 300000,
      context: {
        stateKey,
        botKey: app.music.botKey(ctx),
        promptMessageId: sent?.message_id || null,
        temporaryToken,
        panelToken,
        destination: dest,
        defaultDomain,
        isChannelPrompt: isChan
      }
    });
    return sent;
  }

  async function handleAiTurn(ctx, text, { defaultDomain = 'auto', panelToken = null, dest = null } = {}) {
    let resolvedCtx = ctx;
    if (panelToken && !ctx.musicPanel) {
      const panel = await app.music.channelPanels?.resolve?.(ctx, panelToken, { requireMessage: false }).catch(() => null);
      if (panel) resolvedCtx = { ...ctx, musicPanel: panel };
    }
    const targetDest = dest || app.music.destination(resolvedCtx);
    const agent = app.mediaAgent;
    const res = agent
      ? await agent.chat({ ctx: resolvedCtx, chatId: targetDest || ctx.chatId, userId: ctx.tgId, text, defaultDomain })
      : { reply: 'AI Agent is currently unavailable.', action: null, concluded: false };

    const act = res.action;
    if (act?.name === 'search_movie' && act.query) {
      if (res.reply) await ctx.api.sendMessage(ctx.chatId, res.reply).catch(() => {});
      await openMovieSearch(resolvedCtx, act.query);
      return res;
    }
    if (act?.name === 'random_movie') {
      if (res.reply) await ctx.api.sendMessage(ctx.chatId, res.reply).catch(() => {});
      await openMovieSearch(resolvedCtx, '', { random: true });
      return res;
    }
    if (act?.name === 'trending_movies') {
      if (res.reply) await ctx.api.sendMessage(ctx.chatId, res.reply).catch(() => {});
      const ms = await createSessionForCtx(resolvedCtx);
      const tRes = await app.movieApi.trending({ page: 1 });
      ms.results = tRes?.results || [];
      ms.resultPage = 0;
      ms.view = 'results';
      await upsertCard(resolvedCtx, ms, renderResults(resolvedCtx, ms));
      return res;
    }
    if (act?.name === 'search_song' && act.query) {
      if (res.reply) await ctx.api.sendMessage(ctx.chatId, res.reply).catch(() => {});
      const djRes = await app.music.chatDjCommand(resolvedCtx, `play ${act.query}`);
      if (isChannelCtx(resolvedCtx)) await adoptChannelPlayerResult(resolvedCtx, djRes?.session);
      return res;
    }
    if (act?.name === 'vc_control') {
      const djRes = await app.music.chatDjCommand(resolvedCtx, text);
      if (isChannelCtx(resolvedCtx)) await adoptChannelPlayerResult(resolvedCtx, djRes?.session);
      if (djRes?.reply) await ctx.api.sendMessage(ctx.chatId, djRes.reply).catch(() => {});
      return res;
    }
    if (res.reply) {
      await ctx.api.sendMessage(ctx.chatId, res.reply, {
        ...(ctx.message?.message_id ? { reply_to_message_id: ctx.message.message_id } : {})
      }).catch(() => {});
    }
    return res;
  }

  async function streamResolvedItems(ctx, ms, descriptors, { playNow = false } = {}) {
    const dest = ms.destination || app.music.destination(ctx);
    const panel = ms.panelToken ? await app.music.channelPanels.resolve(ctx, ms.panelToken, { requireMessage: false }).catch(() => null) : ctx.musicPanel;
    const targetCtx = panel ? { ...ctx, musicPanel: panel } : ctx;
    await app.music.authorize(targetCtx, true, dest, { allowDj: true });
    const qm = app.musicQueueManager;
    const session = qm.getSession(dest);
    const generation = session.stopGeneration || 0;

    if (!descriptors.length) {
      if (ctx.query?.id && ctx.api?.answerCallbackQuery) {
        await ctx.api.answerCallbackQuery(ctx.query.id, { text: 'Select E1..E6, Select Page, or Select All first!', show_alert: false }).catch(() => {});
      }
      return;
    }

    const first = descriptors[0];
    if (ctx.query?.id && ctx.api?.answerCallbackQuery) {
      await ctx.api.answerCallbackQuery(ctx.query.id, {
        text: `⏳ Resolving HD stream + subtitles for ${first.episode ? `S${String(first.season).padStart(2, '0')}E${String(first.episode).padStart(2, '0')}` : cut(first.title, 26)}…`
      }).catch(() => {});
    }

    ms.logLines = [];
    let lastLogFlush = 0;
    let pendingLogTimer = null;
    let flushingLog = false;
    const labelItem = first.episode
      ? `S${String(first.season).padStart(2, '0')}E${String(first.episode).padStart(2, '0')}`
      : cut(first.title, 36);
    const flushLog = async () => {
      if (flushingLog) return;
      flushingLog = true;
      try {
        ms.notice = ms.logLines[ms.logLines.length - 1] || `⏳ Loading ${labelItem}…`;
        await upsertCard(targetCtx, ms, renderCurrentView(targetCtx, ms)).catch(() => {});
        lastLogFlush = Date.now();
      } finally {
        flushingLog = false;
      }
    };
    const pushLog = (msg, { force = false } = {}) => {
      const clean = String(msg || '').trim();
      if (!clean) return Promise.resolve();
      const stamp = new Date().toISOString().slice(11, 19);
      const entry = `[${stamp}] ${clean}`;
      if (ms.logLines[ms.logLines.length - 1] !== entry) {
        ms.logLines.push(entry);
        if (ms.logLines.length > 10) ms.logLines.shift();
      }
      const elapsed = Date.now() - lastLogFlush;
      if (force || elapsed >= 950) {
        if (pendingLogTimer) { clearTimeout(pendingLogTimer); pendingLogTimer = null; }
        return flushLog();
      }
      if (!pendingLogTimer) {
        pendingLogTimer = setTimeout(() => {
          pendingLogTimer = null;
          void flushLog();
        }, Math.max(150, 950 - elapsed));
        pendingLogTimer.unref?.();
      }
      return Promise.resolve();
    };

    try {
      await pushLog(`🔎 Starting stream resolution for ${labelItem}…`, { force: true });

      const resolvedFirst = await app.movieResolver.resolve(first, {
        onProgress: (line) => { void pushLog(line); }
      });
      if (!resolvedFirst?.ok || !resolvedFirst.track) {
        await pushLog(`❌ ${resolvedFirst?.reason || 'No playable full-length web stream found.'}`, { force: true });
        return;
      }

      const subTag = (resolvedFirst.subtitles?.filePath || resolvedFirst.subtitles?.found) ? ' · 💬 Subtitles ready' : '';
      await pushLog(`✅ Stream ready (${cut(resolvedFirst.track.artist || 'HD Feature', 36)})${subTag}`, { force: true });
      await pushLog('🎙️ Preparing Voice Chat Cinema deck…', { force: true });

      await app.music.prepare(targetCtx, dest);
      if ((qm.getSession(dest).stopGeneration || 0) !== generation) {
        throw new MusicError('ACTION_CANCELLED', 'Playback stopped before stream started.');
      }

      await qm.addMovies(dest, [resolvedFirst.track], { playNow });

      const remaining = descriptors.slice(1);
      const updatedSession = qm.getSession(dest);
      const switchedToCinema = updatedSession.activeDeck === 'movie';
      if (switchedToCinema) {
        await pushLog(
          `🎬 Streaming ${cut(resolvedFirst.track.title, 40)}${subTag}${remaining.length ? ` · Queuing ${remaining.length} more…` : ''}`,
          { force: true }
        );
        const searchCardId = ms.messageId;
        const canMorphSearchCard = Boolean(searchCardId && !updatedSession.screenMessageId && !panel?.screenMessageId && Number(targetCtx.chatId) === Number(ms.chatId));
        const p = await app.music.player({
          ...targetCtx,
          ...(canMorphSearchCard ? { reuseMessageId: searchCardId } : {}),
          forceNew: !canMorphSearchCard && !updatedSession.screenMessageId && !panel?.screenMessageId
        }, dest).catch(() => null);
        if (isChannelCtx(targetCtx)) await adoptChannelPlayerResult(targetCtx, p);
        const activePlayerMsgId = updatedSession.screenMessageId || panel?.screenMessageId || p?.screenMessageId;
        if (searchCardId && activePlayerMsgId && searchCardId !== activePlayerMsgId) {
          await cleanupSupersededCards(targetCtx, ms, activePlayerMsgId);
        }
      } else {
        await pushLog(
          `🎞 Added ${cut(resolvedFirst.track.title, 40)} to Cinema Queue (${updatedSession.movieUpcoming?.length || 1} queued) · Music stays live.`,
          { force: true }
        );
      }

      if (remaining.length) {
        void (async () => {
          for (const desc of remaining) {
            if ((qm.getSession(dest).stopGeneration || 0) !== generation) break;
            const r = await app.movieResolver.resolve(desc).catch(() => null);
            if ((qm.getSession(dest).stopGeneration || 0) !== generation) break;
            if (r?.ok && r.track) {
              try {
                qm.enqueueMovie(dest, r.track);
              } catch {
                break;
              }
            }
          }
          await qm.updatePlayerCard(dest).catch(() => {});
        })();
      }
    } finally {
      if (pendingLogTimer) {
        clearTimeout(pendingLogTimer);
        pendingLogTimer = null;
      }
    }
  }

  async function handleCallback(ctx, args = []) {
    const [sidRaw, op, arg = ''] = args;
    if (sidRaw === 'new') {
      return await openHub(ctx);
    }
    let ms = app.movieSessions.get(sidRaw)
      || (ctx.messageId ? app.movieSessions.getByMessage(ctx.chatId, ctx.messageId) : null)
      || app.movieSessions.getLatestForChat(ctx.chatId);
    if (!ms) {
      if (ctx.messageId) await ctx.api?.deleteMessage?.(ctx.chatId, ctx.messageId).catch(() => {});
      return await openHub({ ...ctx, query: null, messageId: null });
    }
    app.movieSessions.touch(ms);
    let resolvedCtx = ctx;
    if (ms.panelToken) {
      const panel = await app.music.channelPanels?.resolve?.(ctx, ms.panelToken, { requireMessage: false }).catch(() => null);
      if (panel) resolvedCtx = { ...ctx, musicPanel: panel };
    }
    await app.music.authorize(resolvedCtx, true, ms.destination || null, { allowDj: true });

    if (op === 'hb') {
      ms.view = 'hub';
      ms.notice = null;
      await upsertCard(resolvedCtx, ms, renderHub(resolvedCtx, ms));
      return true;
    }

    if (op === 'ps') {
      const isChan = isChannelCtx(resolvedCtx);
      const group = Number(resolvedCtx.chatId) < 0 && !isChan;
      const stateKey = (isChan && Number(resolvedCtx.chatId) < 0) ? String(resolvedCtx.chatId) : resolvedCtx.tgId;
      if (ctx.query?.id && ctx.api?.answerCallbackQuery) {
        await ctx.api.answerCallbackQuery(ctx.query.id, { text: '🔍 Send the movie or TV show title.' }).catch(() => {});
      }
      const promptText = `${group ? 'Reply to this message with' : 'Send'} a movie or TV series title (e.g. "Breaking Bad", "John Wick 4", "Inception"). /cancel closes search.`;
      const sent = await resolvedCtx.api.sendMessage(resolvedCtx.chatId, promptText, {
        ...(group || Number(resolvedCtx.chatId) > 0 ? { reply_markup: { force_reply: true, selective: true } } : {}),
        ...(ctx.messageId && group ? { reply_to_message_id: ctx.messageId } : {})
      });
      const temporaryToken = temporary.remember(resolvedCtx, sent, { ttlMs: 120000 });
      await app.sm.transition(stateKey, States.MUSIC_QUEUE_INPUT, {
        chatId: resolvedCtx.chatId,
        timeoutMs: 120000,
        context: {
          stateKey,
          mode: 'movie_search',
          movieSid: ms.id,
          botKey: app.music.botKey(resolvedCtx),
          promptMessageId: sent?.message_id || null,
          temporaryToken,
          panelToken: ms.panelToken || null,
          isChannelPrompt: isChan
        }
      });
      return true;
    }

    if (op === 'ai') {
      if (ctx.query?.id && ctx.api?.answerCallbackQuery) {
        await ctx.api.answerCallbackQuery(ctx.query.id, { text: '🤖 Opening AI Movie & Song Agent…' }).catch(() => {});
      }
      await startAiChat(resolvedCtx, '', { defaultDomain: 'movie' });
      return true;
    }

    if (op === 'rn') {
      if (ctx.query?.id && ctx.api?.answerCallbackQuery) {
        await ctx.api.answerCallbackQuery(ctx.query.id, { text: '🎲 Picking a random movie or series…' }).catch(() => {});
      }
      const pick = await app.movieApi.pickRandom({});
      if (!pick) throw new MusicError('MOVIE_NOT_FOUND', 'Random pick returned empty. Try Trending or Search.');
      if (!ms.results?.length) ms.results = [pick];
      await loadItemIntoSession(ms, pick);
      await upsertCard(resolvedCtx, ms, renderCurrentView(resolvedCtx, ms));
      return true;
    }

    if (op === 'tr') {
      if (ctx.query?.id && ctx.api?.answerCallbackQuery) {
        await ctx.api.answerCallbackQuery(ctx.query.id, { text: '🔥 Loading trending titles…' }).catch(() => {});
      }
      const res = await app.movieApi.trending({ page: 1 });
      ms.query = '';
      ms.categoryLabel = '';
      ms.results = res?.results || [];
      ms.resultPage = Math.max(0, Number(arg) || 0);
      ms.view = 'results';
      await upsertCard(resolvedCtx, ms, renderResults(resolvedCtx, ms));
      return true;
    }

    if (op === 'cg') {
      if (!ms.categories?.length) {
        ms.categories = await app.movieApi.categories().catch(() => []);
      }
      ms.catPage = Math.max(0, Number(arg) || 0);
      ms.view = 'categories';
      await upsertCard(resolvedCtx, ms, renderCategories(resolvedCtx, ms));
      return true;
    }

    if (op === 'cp') {
      const cat = ms.categories?.[Number(arg)];
      if (!cat) throw new MusicError('STALE_PLAYER', 'Category unavailable.');
      if (ctx.query?.id && ctx.api?.answerCallbackQuery) {
        await ctx.api.answerCallbackQuery(ctx.query.id, { text: `🍿 Loading ${cat.name}…` }).catch(() => {});
      }
      const res = await app.movieApi.browse({
        category: cat.id && isNaN(Number(cat.id)) ? cat.id : undefined,
        genreId: cat.genreId || (Number.isFinite(Number(cat.id)) ? Number(cat.id) : undefined),
        page: 1,
        limit: 20
      });
      ms.query = '';
      ms.categoryLabel = cat.name;
      ms.results = res?.results || [];
      ms.resultPage = 0;
      ms.view = 'results';
      await upsertCard(resolvedCtx, ms, renderResults(resolvedCtx, ms));
      return true;
    }

    if (op === 'rp') {
      ms.resultPage = Math.max(0, Number(arg) || 0);
      ms.view = 'results';
      await upsertCard(resolvedCtx, ms, renderResults(resolvedCtx, ms));
      return true;
    }

    if (op === 'rs') {
      ms.view = 'results';
      ms.notice = null;
      await upsertCard(resolvedCtx, ms, renderResults(resolvedCtx, ms));
      return true;
    }

    if (op === 'pk') {
      const picked = ms.results?.[Number(arg)];
      if (!picked) throw new MusicError('STALE_PLAYER', 'That title is no longer in this result list.');
      if (ctx.query?.id && ctx.api?.answerCallbackQuery) {
        await ctx.api.answerCallbackQuery(ctx.query.id, { text: `Loading ${cut(picked.title, 32)}…` }).catch(() => {});
      }
      await loadItemIntoSession(ms, picked);
      await upsertCard(resolvedCtx, ms, renderCurrentView(resolvedCtx, ms));
      return true;
    }

    if (op === 'tg') {
      const [sStr, eStr] = String(arg).split('-');
      const checked = app.movieSessions.toggleEpisode(ms, Number(sStr), Number(eStr));
      if (ctx.query?.id && ctx.api?.answerCallbackQuery) {
        await ctx.api.answerCallbackQuery(ctx.query.id, { text: `${checked ? '☑ Selected' : '☐ Deselected'} S${sStr}E${eStr} (${app.movieSessions.totalSelectedCount(ms)} total)` }).catch(() => {});
      }
      await upsertCard(resolvedCtx, ms, renderTvSeason(resolvedCtx, ms));
      return true;
    }

    if (op === 'sp') {
      const selected = app.movieSessions.selectPageEpisodes(ms, 6);
      const count = ms.selectedBySeason.get(ms.seasonNumber)?.size || 0;
      if (ctx.query?.id && ctx.api?.answerCallbackQuery) {
        await ctx.api.answerCallbackQuery(ctx.query.id, { text: selected ? `☑ Page selected (${count} in season)` : '☐ Page unselected' }).catch(() => {});
      }
      await upsertCard(resolvedCtx, ms, renderTvSeason(resolvedCtx, ms));
      return true;
    }

    if (op === 'sa') {
      const sNum = Number(arg || ms.seasonNumber || 1);
      if (sNum !== Number(ms.seasonNumber)) ms.seasonNumber = sNum;
      const selected = app.movieSessions.selectAllInSeason(ms);
      const count = ms.selectedBySeason.get(ms.seasonNumber)?.size || 0;
      if (ctx.query?.id && ctx.api?.answerCallbackQuery) {
        await ctx.api.answerCallbackQuery(ctx.query.id, { text: selected ? `✅ Selected all ${count} episodes of Season ${ms.seasonNumber}` : `☐ Cleared Season ${ms.seasonNumber}` }).catch(() => {});
      }
      await upsertCard(resolvedCtx, ms, renderTvSeason(resolvedCtx, ms));
      return true;
    }

    if (op === 'sas') {
      const item = ms.mediaItem || {};
      const validSeasons = (ms.seasons || []).filter((s) => Number(s.seasonNumber) >= 1);
      if (ctx.query?.id && ctx.api?.answerCallbackQuery) {
        await ctx.api.answerCallbackQuery(ctx.query.id, { text: `⏳ Fetching & selecting all ${validSeasons.length} seasons…` }).catch(() => {});
      }
      const fetchedMap = new Map(ms.episodeCache);
      const missing = validSeasons.filter((s) => !fetchedMap.has(Number(s.seasonNumber)));
      for (let i = 0; i < missing.length; i += 4) {
        await Promise.all(missing.slice(i, i + 4).map(async (s) => {
          const sNum = Number(s.seasonNumber);
          const epsRes = await app.movieApi.getTvSeasonEpisodes(item.id, sNum).catch(() => null);
          if (epsRes?.episodes?.length) fetchedMap.set(sNum, epsRes.episodes);
        }));
      }
      const summary = app.movieSessions.selectAllSeasonsAndEpisodes(ms, fetchedMap);
      ms.notice = summary.selected
        ? `✅ Selected ALL ${summary.seasonsCount} seasons (${summary.episodesCount} episodes total).`
        : '☐ Cleared all selected seasons & episodes.';
      if (ctx.query?.id && ctx.api?.answerCallbackQuery) {
        await ctx.api.answerCallbackQuery(ctx.query.id, { text: ms.notice }).catch(() => {});
      }
      await upsertCard(resolvedCtx, ms, ms.view === 'seasons' ? renderSeasonPicker(resolvedCtx, ms) : renderTvSeason(resolvedCtx, ms));
      return true;
    }

    if (op === 'mq') {
      const dest = ms.destination || app.music.destination(resolvedCtx);
      const s = app.musicQueueManager.getSession(dest);
      s.view = 'mqueue';
      const p = await app.music.player({ ...resolvedCtx, forceNew: !s.screenMessageId }, dest);
      if (isChannelCtx(resolvedCtx)) await adoptChannelPlayerResult(resolvedCtx, p);
      return true;
    }

    if (op === 'cl') {
      app.movieSessions.clearSelections(ms);
      if (ctx.query?.id && ctx.api?.answerCallbackQuery) {
        await ctx.api.answerCallbackQuery(ctx.query.id, { text: '✕ Cleared selected episodes' }).catch(() => {});
      }
      await upsertCard(resolvedCtx, ms, renderTvSeason(resolvedCtx, ms));
      return true;
    }

    if (op === 'ep') {
      ms.epPage = Math.max(0, Number(arg) || 0);
      ms.view = 'season';
      await upsertCard(resolvedCtx, ms, renderTvSeason(resolvedCtx, ms));
      return true;
    }

    if (op === 'ss') {
      ms.seasonPage = Math.max(0, Number(arg) || 0);
      ms.view = 'seasons';
      await upsertCard(resolvedCtx, ms, renderSeasonPicker(resolvedCtx, ms));
      return true;
    }

    if (op === 'sv') {
      ms.view = 'season';
      await upsertCard(resolvedCtx, ms, renderTvSeason(resolvedCtx, ms));
      return true;
    }

    if (op === 'so') {
      const sNum = Number(arg || 1);
      if (ctx.query?.id && ctx.api?.answerCallbackQuery) {
        await ctx.api.answerCallbackQuery(ctx.query.id, { text: `Loading ${sNum === 0 ? 'Specials' : `Season ${sNum}`}…` }).catch(() => {});
      }
      ms.seasonNumber = sNum;
      ms.epPage = 0;
      const cached = ms.episodeCache.get(sNum);
      let eps = cached;
      if (!eps) {
        const epsRes = await app.movieApi.getTvSeasonEpisodes(ms.mediaItem.id, sNum).catch(() => null);
        eps = epsRes?.episodes || [];
        ms.episodeCache.set(sNum, eps);
      }
      ms.episodes = eps;
      ms.view = 'season';
      await upsertCard(resolvedCtx, ms, renderTvSeason(resolvedCtx, ms));
      return true;
    }

    if (op === 'pm' || op === 'qm') {
      const item = ms.mediaItem;
      if (!item) throw new MusicError('STALE_PLAYER', 'Choose a movie first.');
      const desc = [{
        type: 'movie',
        id: item.id,
        title: item.title,
        year: item.year,
        runtime: item.runtimeMinutes || item.runtime,
        durationSeconds: item.runtimeSeconds || (item.runtimeMinutes ? Number(item.runtimeMinutes) * 60 : null) || null,
        artwork: item.poster || item.backdrop,
        imdbId: item.imdbId,
        webappUrl: ms.playback?.webappPlayerUrl || item.playUrl
      }];
      await streamResolvedItems(resolvedCtx, ms, desc, { playNow: op === 'pm' });
      return true;
    }

    if (op === 'dm') {
      const item = ms.mediaItem;
      if (!item) throw new MusicError('STALE_PLAYER', 'Choose a movie first.');
      if (!app.movieDownloader) throw new MusicError('UNAVAILABLE', 'Movie downloader is unavailable.');
      const desc = {
        type: 'movie',
        id: item.id,
        title: item.title,
        year: item.year,
        runtime: item.runtimeMinutes || item.runtime,
        durationSeconds: item.runtimeSeconds || (item.runtimeMinutes ? Number(item.runtimeMinutes) * 60 : null) || null,
        artwork: item.poster || item.backdrop,
        imdbId: item.imdbId
      };
      if (ctx.query?.id && ctx.api?.answerCallbackQuery) {
        await ctx.api.answerCallbackQuery(ctx.query.id, { text: `⬇️ Preparing download: ${cut(item.title, 36)}…` }).catch(() => {});
      }
      ms.logLines = [`⬇️ Starting download for ${cut(item.title, 40)}…`];
      await upsertCard(resolvedCtx, ms, renderCurrentView(resolvedCtx, ms));
      const res = await app.movieDownloader.sendSingleVideo(resolvedCtx, desc, {
        onProgress: (line) => {
          ms.logLines = [...(ms.logLines || []).slice(-7), line];
          ms.notice = line;
        }
      });
      ms.notice = res?.ok ? `✅ Sent "${cut(item.title, 36)}" to chat!` : `⚠️ ${res?.reason || 'Download unavailable'}`;
      await upsertCard(resolvedCtx, ms, renderCurrentView(resolvedCtx, ms));
      return true;
    }

    if (op === 'pe' || op === 'qe' || op === 'de') {
      const item = ms.mediaItem || {};
      const [sStr, eStr] = String(arg).split('-');
      const sNum = Number(sStr || ms.seasonNumber || 1);
      const eNum = Number(eStr || 1);
      const epList = ms.episodeCache.get(sNum) || ms.episodes || [];
      const ep = epList.find((x) => Number(x.episodeNumber) === eNum) || { seasonNumber: sNum, episodeNumber: eNum, title: `Episode ${eNum}` };
      const desc = {
        type: 'tv',
        id: item.id,
        title: item.title,
        year: item.year,
        season: sNum,
        episode: eNum,
        episodeTitle: ep.title,
        durationSeconds: ep.runtimeSeconds,
        artwork: ep.still || item.poster || item.backdrop,
        imdbId: item.imdbId,
        webappUrl: ms.playback?.webappPlayerUrl || item.playUrl
      };
      if (op === 'de') {
        if (!app.movieDownloader) throw new MusicError('UNAVAILABLE', 'Movie downloader is unavailable.');
        if (ctx.query?.id && ctx.api?.answerCallbackQuery) {
          await ctx.api.answerCallbackQuery(ctx.query.id, { text: `⬇️ Downloading S${String(sNum).padStart(2, '0')}E${String(eNum).padStart(2, '0')}…` }).catch(() => {});
        }
        ms.notice = `⬇️ Preparing S${String(sNum).padStart(2, '0')}E${String(eNum).padStart(2, '0')} for Telegram…`;
        await upsertCard(resolvedCtx, ms, renderTvSeason(resolvedCtx, ms));
        const res = await app.movieDownloader.sendSingleVideo(resolvedCtx, desc, {
          onProgress: (line) => { ms.notice = line; }
        });
        ms.notice = res?.ok ? `✅ Sent S${String(sNum).padStart(2, '0')}E${String(eNum).padStart(2, '0')} to chat!` : `⚠️ ${res?.reason || 'Episode download failed'}`;
        await upsertCard(resolvedCtx, ms, renderTvSeason(resolvedCtx, ms));
        return true;
      }
      await streamResolvedItems(resolvedCtx, ms, [desc], { playNow: op === 'pe' });
      return true;
    }

    if (op === 'dx' || op === 'dl' || op === 'ds') {
      const item = ms.mediaItem || {};
      if (!app.movieDownloader) throw new MusicError('UNAVAILABLE', 'Movie downloader is unavailable.');
      if (op === 'dx') {
        const selected = app.movieSessions.getSelectedEpisodes(ms, ms.episodeCache);
        if (!selected.length) {
          if (ctx.query?.id && ctx.api?.answerCallbackQuery) {
            await ctx.api.answerCallbackQuery(ctx.query.id, { text: 'Select at least 1 episode first (or tap ☑ All Seasons)!', show_alert: true }).catch(() => {});
          }
          return true;
        }
        const descriptors = selected.map((ep) => ({
          type: 'tv',
          id: item.id,
          title: item.title,
          year: item.year,
          season: ep.seasonNumber,
          episode: ep.episodeNumber,
          episodeTitle: ep.title,
          durationSeconds: ep.runtimeSeconds,
          artwork: ep.still || item.poster || item.backdrop,
          imdbId: item.imdbId
        }));
        app.movieSessions.setDownloadManifest(ms, descriptors, {
          pageSize: 4,
          title: item.title || 'Series Episodes',
          type: 'tv'
        });
      }
      const targetPage = op === 'dl' ? Math.max(0, Number(arg) || 0) : (ms.dlPage || 0);
      if (op === 'ds') {
        const manifest = ms.dlManifest;
        const pageSize = Number(manifest?.pageSize || 4);
        const p = Number(arg !== '' ? arg : (ms.dlPage || 0));
        const batch = (manifest?.items || []).slice(p * pageSize, (p + 1) * pageSize);
        if (!batch.length) throw new MusicError('STALE_PLAYER', 'No items found on this slide page.');
        await streamResolvedItems(resolvedCtx, ms, batch, { playNow: true });
        return true;
      }
      if (!ms.dlManifest?.items?.length) throw new MusicError('STALE_PLAYER', 'Select episodes again to generate slide album.');
      if (ctx.query?.id && ctx.api?.answerCallbackQuery) {
        await ctx.api.answerCallbackQuery(ctx.query.id, { text: `📦 Preparing Album Slide ${targetPage + 1}…` }).catch(() => {});
      }
      const res = await app.movieDownloader.deliverAlbumSlidePage(resolvedCtx, ms, targetPage, {
        buildNavCallback: (pNum) => encodeCallback('music', 'mv', ms.id, 'dl', String(pNum)),
        streamPageCallback: (pNum) => encodeCallback('music', 'mv', ms.id, 'ds', String(pNum)),
        backCallback: () => encodeCallback('music', 'mv', ms.id, 'sv'),
        onProgress: (line) => { ms.notice = line; }
      });
      if (!res?.ok) {
        ms.notice = `⚠️ ${res?.reason || 'Slide album failed'}`;
        await upsertCard(resolvedCtx, ms, renderCurrentView(resolvedCtx, ms));
      }
      return true;
    }

    if (op === 'px' || op === 'qx') {
      const item = ms.mediaItem || {};
      const selected = app.movieSessions.getSelectedEpisodes(ms, ms.episodeCache);
      const descriptors = selected.map((ep) => ({
        type: 'tv',
        id: item.id,
        title: item.title,
        year: item.year,
        season: ep.seasonNumber,
        episode: ep.episodeNumber,
        episodeTitle: ep.title,
        durationSeconds: ep.runtimeSeconds,
        artwork: ep.still || item.poster || item.backdrop,
        imdbId: item.imdbId,
        webappUrl: ms.playback?.webappPlayerUrl || item.playUrl
      }));
      await streamResolvedItems(resolvedCtx, ms, descriptors, { playNow: op === 'px' });
      return true;
    }

    throw new MusicError('STALE_PLAYER', 'That movie action is unavailable.');
  }

  return {
    openHub,
    openMovieSearch,
    startAiChat,
    handleAiTurn,
    handleCallback,
    renderHub,
    renderResults,
    renderMovieDetail,
    renderTvSeason,
    renderSeasonPicker,
    renderCategories
  };
}
