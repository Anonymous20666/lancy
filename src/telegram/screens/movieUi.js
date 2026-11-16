import { block, rt, richButton, encodeCallback } from '../rich.js';
import { ProgressTracker } from '../progress.js';
import { States } from '../../core/stateMachine.js';
import { durationText, MusicError, stripRemotePhotoBlocks } from '../../music/model.js';
import { PANEL_ACTIONS } from '../../music/channelPanels.js';
import { DOWNLOAD_QUALITY_PROFILES, estimateDownloadSizeMb, normalizeDownloadQuality, uploadLimitBytes } from '../../media/telegramLimits.js';
import { isBotSuperAdmin, isAnonymousGroupAdmin } from '../permissions.js';
import { defaultAdultCatalog, FEATURED_STUDIOS, isBlockedAdultText, formatDurationLabel } from '../../media/adultCatalog.js';

const cut = (s, n = 60) => [...String(s || '')].slice(0, n).join('');

function isSafeHttpsUrl(raw) {
  try {
    const u = new URL(String(raw || ''));
    return u.protocol === 'https:' && !u.username && !u.password && u.hostname.includes('.') && !/^(?:127\.|10\.|192\.168\.|169\.254\.)/.test(u.hostname);
  } catch {
    return false;
  }
}

function hasRichPhoto(rich) {
  if (!rich || typeof rich !== 'object') return false;
  if (rich.photo) return true;
  return Array.isArray(rich.blocks) && rich.blocks.some((bl) => bl?.type === 'photo' || bl?.type === 'slideshow' || bl?.type === 'collage');
}

function appendLiveLog(b, ms) {
  if (Array.isArray(ms?.logLines) && ms.logLines.length) {
    b.blockquote(rt.text(`📡 Live Cinema Log\n${ms.logLines.slice(-8).join('\n')}`));
  }
}

function appendNoticeIfDistinct(b, ms) {
  if (!ms?.notice) return;
  const lastLog = Array.isArray(ms.logLines) && ms.logLines.length ? ms.logLines[ms.logLines.length - 1] : '';
  if (lastLog && lastLog === ms.notice) return;
  b.paragraph(rt.italic(cut(ms.notice, 260)));
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

  function effectiveAdultChatId(ctx, ms = null) {
    return Number(ms?.destination ?? ctx?.musicPanel?.destination ?? ctx?.chatId);
  }

  function isGroupAdultAllowed(ctx, ms = null) {
    const cid = effectiveAdultChatId(ctx, ms);
    if (!Number.isFinite(cid) || cid > 0) return true;
    return Boolean(app.db?.getSetting?.(`nsfw.groupEnabled.${cid}`, false));
  }

  async function isChatAdminForAdult(ctx, cid) {
    if (!Number.isFinite(cid) || cid > 0) return true;
    let isAdmin = Boolean(
      (isChannelCtx(ctx) && ctx.channelAdminVerified) ||
      isAnonymousGroupAdmin(ctx.message || ctx.query?.message, cid) ||
      isBotSuperAdmin(app, ctx.tgId, { controller: ctx.controller })
    );
    if (!isAdmin && Number(ctx.tgId) > 0) {
      const m = await ctx.api?.getChatMember?.(cid, Number(ctx.tgId)).catch(() => null);
      isAdmin = ['creator', 'administrator'].includes(m?.status);
    }
    return isAdmin;
  }

  async function sendEphemeralNoticeOrAlert(ctx, title, body, { showAlert = true } = {}) {
    const cleanBody = String(body || '').trim();
    const canEphemeral = Boolean(
      ctx?.query?.id
      && typeof ctx?.api?.sendEphemeralRichNotice === 'function'
      && Number(ctx?.chatId) < 0
      && (ctx?.receiverUserId || ctx?.tgId)
    );
    if (canEphemeral) {
      try {
        const noticeCard = card(cut(title || 'Notice', 48), 'Private to you')
          .paragraph(rt.text(cut(cleanBody, 240)));
        await ctx.api.sendEphemeralRichNotice(
          ctx.chatId,
          { receiverUserId: ctx.receiverUserId || ctx.tgId, callbackQueryId: ctx.query.id },
          finish(noticeCard)
        );
        await ctx.api?.answerCallbackQuery?.(ctx.query.id, { text: cut(cleanBody, 120) }).catch(() => {});
        return true;
      } catch {
        // Fallback cleanly to Bot API answerCallbackQuery alert if ephemeral notice fails
      }
    }
    if (ctx?.query?.id && ctx?.api?.answerCallbackQuery) {
      await ctx.api.answerCallbackQuery(ctx.query.id, {
        text: cut(cleanBody, 190),
        show_alert: Boolean(showAlert)
      }).catch(() => {});
    }
    return false;
  }

  function adultItemToUnifiedResult(item, idx = 0) {
    if (!item) return null;
    const durText = item.duration || (item.durationSeconds ? formatDurationLabel(item.durationSeconds) : null);
    const metaDesc = [item.artist || item.studio || '', durText || '', '18+ Feature'].filter(Boolean).join(' · ');
    return {
      id: `xv:${item.sourceKey || 'xvideos'}:${item.id || idx}`,
      provider: item.sourceKey || 'xvideos',
      sourceProvider: '18+ Feature',
      sourceKey: item.sourceKey || 'xvideos',
      type: 'movie',
      isAdultCatalogItem: true,
      isAdultHint: true,
      adult: true,
      title: String(item.title || '18+ Feature').trim(),
      year: item.year ? Number(item.year) : null,
      durationSeconds: item.durationSeconds ? Number(item.durationSeconds) : null,
      duration: durText,
      runtimeMinutes: item.durationSeconds ? Math.max(1, Math.round(Number(item.durationSeconds) / 60)) : null,
      poster: item.thumbUrl || null,
      overview: metaDesc,
      genres: Array.isArray(item.categories) && item.categories.length ? item.categories.slice(0, 3) : ['18+ Feature'],
      rating: null,
      xvItem: item
    };
  }

  function mergeUnifiedSearchResults(query, movieResults = [], adultResults = [], { limit = 20 } = {}) {
    const cleanQTokens = String(query || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length >= 2);
    const scoreTitle = (title) => {
      const low = String(title || '').toLowerCase();
      if (!low || !cleanQTokens.length) return 0;
      const hits = cleanQTokens.filter((t) => low.includes(t)).length;
      const normTitle = low.replace(/[^a-z0-9]/g, '');
      const normQ = cleanQTokens.join('');
      return hits * 10 + (normTitle === normQ ? 30 : 0);
    };
    const seen = new Set();
    const outMovies = [];
    for (const m of (Array.isArray(movieResults) ? movieResults : [])) {
      if (!m?.id || !m?.title) continue;
      const k = `${m.type}:${m.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      outMovies.push(m);
    }
    const outAdult = [];
    for (let i = 0; i < (Array.isArray(adultResults) ? adultResults.length : 0); i++) {
      const rawAdult = adultResults[i];
      const durSec = Number(rawAdult?.durationSeconds || rawAdult?.durationSec || 0);
      if (durSec > 0 && durSec < 900) continue;
      if (/\b(?:trailers?|teasers?|previews?|promos?|samples?|clips?|excerpts?|snippets?|highlights?)\b/i.test(String(rawAdult?.title || ''))
        && !/\b(?:trailers?|teasers?|previews?|promos?|samples?|clips?|excerpts?|snippets?|highlights?)\b/i.test(String(query || ''))) {
        continue;
      }
      const norm = adultItemToUnifiedResult(rawAdult, i);
      if (!norm) continue;
      const k = norm.xvItem?.pageUrl || norm.id;
      if (seen.has(k)) continue;
      seen.add(k);
      outAdult.push(norm);
    }
    if (!outAdult.length) return outMovies.slice(0, limit);
    if (!outMovies.length) return outAdult.slice(0, limit);

    const bestMovieScore = Math.max(...outMovies.slice(0, 5).map((m) => scoreTitle(m.title)));
    const qualifyingAdult = outAdult.filter((a) => scoreTitle(a.title) >= Math.max(10, cleanQTokens.length * 10));
    const scoredAdultFallback = outAdult.filter((a) => scoreTitle(a.title) > 0);
    const bestAdultScore = qualifyingAdult.length
      ? Math.max(...qualifyingAdult.slice(0, 5).map((a) => scoreTitle(a.title)))
      : 0;

    // Never inject 0-score unrelated adult results into normal catalog searches.
    if (!qualifyingAdult.length) {
      if (bestMovieScore >= 10) return outMovies.slice(0, limit);
      return [...outMovies, ...scoredAdultFallback].slice(0, limit);
    }

    // Put stronger exact adult hits on page 1 ONLY when adult matches genuinely match query and exceed normal matches; otherwise interleave cleanly after top 2 normal results
    const blended = [];
    if (bestAdultScore > bestMovieScore && bestAdultScore >= 10) {
      blended.push(...qualifyingAdult.slice(0, 2), ...outMovies.slice(0, 4), ...scoredAdultFallback.filter((a) => !qualifyingAdult.slice(0, 2).includes(a)), ...outMovies.slice(4));
    } else {
      blended.push(...outMovies.slice(0, 2), ...qualifyingAdult.slice(0, 1), ...outMovies.slice(2, 6), ...scoredAdultFallback.filter((a) => !qualifyingAdult.slice(0, 1).includes(a)).slice(0, 2), ...outMovies.slice(6), ...scoredAdultFallback.slice(3));
    }
    return blended.slice(0, limit);
  }

  function isAgeGateRequired(ctx) {
    return app.settings?.get?.('nsfw.requireAgeGate') === true && !app.db?.getSetting?.(`nsfw.ageVerified.${ctx?.tgId}`, false);
  }

  function getCatalog() {
    return app.adultCatalog || defaultAdultCatalog;
  }

  function getXvQuality(ms) {
    return ['360p', '480p', '720p'].includes(ms?.xvQuality) ? ms.xvQuality : '480p';
  }

  function xvQualityHeight(q) {
    return q === '720p' ? 720 : q === '360p' ? 360 : 480;
  }

  function buildXvTrack(item, resolved = null, quality = '480p') {
    const variants = Array.isArray(resolved?.variants) && resolved.variants.length
      ? resolved.variants
      : (Array.isArray(item?.variants) ? item.variants : []);
    const targetH = xvQualityHeight(quality);
    let chosenUrl = resolved?.streamUrl || item?.streamUrl || item?.videoUrl || item?.fallbackUrls?.[0] || null;
    let chosenIsHls = Boolean(resolved?.isHls || item?.isHls);
    if (variants.length) {
      const sorted = [...variants]
        .filter((v) => v?.url)
        .sort((a, b) => {
          const ha = Number(a.height || parseInt(String(a.quality || '480').replace(/[^\d]/g, ''), 10) || 480);
          const hb = Number(b.height || parseInt(String(b.quality || '480').replace(/[^\d]/g, ''), 10) || 480);
          return (Math.abs(ha - targetH) + (a.isHls ? 50 : 0)) - (Math.abs(hb - targetH) + (b.isHls ? 50 : 0));
        });
      if (sorted[0]?.url) {
        chosenUrl = sorted[0].url;
        chosenIsHls = Boolean(sorted[0].isHls);
      }
    }
    const rawId = String(item?.id || `xv_${Date.now()}`).replace(/^(xv|ad):/i, '');
    const durSec = Number(resolved?.durationSeconds || item?.durationSeconds || item?.durationSec || 0) || 0;
    return {
      id: `xv:${rawId}`,
      type: 'xvideos',
      title: resolved?.fullTitle || resolved?.title || item?.title || 'XVideos Stream',
      artist: resolved?.artist || resolved?.uploader || item?.artist || 'XVideos',
      durationSec: durSec,
      durationSeconds: durSec,
      durationLabel: item?.duration || (durSec ? formatDurationLabel(durSec) : 'HD'),
      provider: 'movie',
      mediaType: 'video',
      isAdult: true,
      sourceKey: 'xvideos',
      streamUrl: chosenUrl,
      videoUrl: chosenUrl,
      isHls: chosenIsHls,
      variants,
      streamHeaders: resolved?.headers || item?.streamHeaders || item?.headers || { Referer: 'https://www.xvideos.com/' },
      fallbackUrls: [...new Set([...(resolved?.fallbackUrls || []), ...(item?.fallbackUrls || [])].filter(Boolean))],
      artwork: resolved?.thumbUrl || item?.thumbUrl || item?.poster || null,
      thumbnailUrl: resolved?.thumbUrl || item?.thumbUrl || item?.poster || null,
      pageUrl: item?.pageUrl || item?.url || null,
      categories: resolved?.categories || item?.categories || [],
      streamResolvedAt: Date.now(),
      resolution: quality,
      capabilities: { seek: true, video: true }
    };
  }

  function isDmDownloadMode(ctx, ms = null) {
    return Boolean(ctx && Number(ctx.chatId) > 0 && !isChannelCtx(ctx) && !ms?.panelToken && !ctx.musicPanel);
  }

  function getUserDownloadQuality(ctx, ms = null) {
    if (ms?.dlQuality) return normalizeDownloadQuality(ms.dlQuality);
    const uid = Number(ctx?.tgId || ms?.userId || 0);
    const saved = uid > 0 ? app.db?.getUserSetting?.(uid, 'movie.downloadQuality', null) : null;
    const norm = normalizeDownloadQuality(saved || '480p');
    if (ms) ms.dlQuality = norm;
    return norm;
  }

  function estimateQualityInfo(quality, { durationSeconds = 5400, itemCount = 1, variants = null } = {}) {
    const q = normalizeDownloadQuality(quality);
    const profile = DOWNLOAD_QUALITY_PROFILES[q];
    const variant = Array.isArray(variants)
      ? variants.find((v) => Math.abs((Number(v?.height) || 0) - profile.height) <= 80)
      : null;
    const limitBytes = app.movieDownloader?.getLimitBytes?.() || uploadLimitBytes();
    const est = estimateDownloadSizeMb({
      durationSeconds,
      quality: q,
      variantBytes: variant?.sizeBytes || null,
      limitBytes
    });
    const totalMb = itemCount > 1 ? est.displayMb * itemCount : est.displayMb;
    const sizeText = totalMb >= 1024 ? `~${(totalMb / 1024).toFixed(1)}GB` : (est.exceedsLimit && itemCount === 1 ? est.text : `~${totalMb}MB`);
    return { quality: q, label: profile.label, short: profile.short, mb: totalMb, text: sizeText };
  }

  function buildQualitySelectorRow(ms, activeQuality, { durationSeconds = 5400, itemCount = 1, variants = null } = {}) {
    return ['360p', '480p', '720p'].map((q) => {
      const info = estimateQualityInfo(q, { durationSeconds, itemCount, variants });
      const icon = q === '360p' ? '📱' : q === '480p' ? '🎬' : '💎';
      const active = q === activeQuality;
      return mvBtn(
        ms,
        `${icon} ${q}${active ? ' ✓' : ''} · ${info.text}`,
        'ql',
        q,
        active ? { style: 'primary' } : null
      );
    });
  }

  async function ensureMovieAuth(ctx, destOverride = null, ms = null) {
    if (isDmDownloadMode(ctx, ms) && !destOverride) {
      const allowed = ctx.controller?.isAllowed?.(ctx.tgId, { isGroup: false, isChannel: false });
      if (allowed && allowed.ok === false) {
        throw new MusicError('PERMISSION_DENIED', 'Use /movie inside your authorized bot chat or group.');
      }
      return Number(ctx.chatId);
    }
    return await app.music.authorize(ctx, true, destOverride, { allowDj: !isChannelCtx(ctx) });
  }

  function buildDownloadProgressCard(heading, subtitle, state = {}, elapsedMs = 0) {
    const sec = Math.max(0, Math.floor(elapsedMs / 1000));
    const b = card(cut(heading, 50), cut(subtitle, 60));
    const line = state.statusLine || 'Resolving HD stream for Telegram…';
    b.blockquote(rt.text(`${line}\n⏱ Elapsed: ${sec}s`));
    return finish(b);
  }

  function getMovieDeckStreamMode(ctx, ms) {
    let dest = ms?.destination || ctx?.musicPanel?.destination || null;
    if (!dest && Number(ctx?.chatId) < 0) dest = Number(ctx.chatId);
    if (!dest) {
      try { dest = app.music?.destination?.(ctx) || null; } catch { return 'rtmp'; }
    }
    if (!dest) return 'rtmp';
    return app.musicQueueManager?.getDeckStreamMode?.(dest, 'movie') || 'rtmp';
  }

  function renderAdultGroupLocked(ctx, ms) {
    const b = card('🔒 18+ XVideos Mode Locked in This Group', 'Admin Opt-In Required');
    b.blockquote(rt.text('18+ XVideos streaming is disabled by default in group chats. A group administrator can unlock it below, or members can use /movie inside private DM.'));
    b.buttons([
      mvBtn(ms, '🔓 Unlock XVideos (Admin)', 'xgt', '', { style: 'primary' }),
      mvBtn(ms, '🎬 Movies & TV', 'xm', 'movie')
    ]);
    return finish(b);
  }

  function renderAdultAgeGate(ms) {
    const b = card('🔞 Age Verification Required (18+)', 'Confirm age before accessing XVideos inside Movie Dash');
    b.blockquote(rt.text('This section includes explicit 18+ adult videos. Tap Confirm below to unlock 18+ browsing, streaming, and downloads for your account.'));
    b.buttons([
      mvBtn(ms, '🔞 I am 18+ · Unlock', 'xag', '', { style: 'success' }),
      mvBtn(ms, '🎬 Back to Movies & TV', 'xm', 'movie')
    ]);
    return finish(b);
  }

  function renderAdultBlockedQuery(ms) {
    const b = card('⛔ Search Blocked by Safety Filter', 'Zero-Tolerance Moderation');
    b.blockquote(rt.text('Your query matched restricted terms and cannot be searched.'));
    b.buttons([
      mvBtn(ms, '🔍 New XVideos Search', 'xs', '', { style: 'primary' }),
      mvBtn(ms, '🏠 XVideos Hub', 'hb', '')
    ]);
    return finish(b);
  }

  function getAdultSourceLabel(src = 'xvideos') {
    const k = String(src || 'xvideos').toLowerCase();
    if (k === 'adult_movies' || k === 'movies' || k === 'features') return '🎬 18+ Features';
    if (k === 'all') return '🌐 All 18+ Sources';
    if (k === 'eporner') return '📀 Eporner HD';
    if (k === 'pornhub') return '🟠 Pornhub';
    if (k === 'xhamster') return '🐹 xHamster';
    if (k === 'porntrex') return '🦖 PornTrex';
    if (k === 'fullxcinema') return '🎞 FullXCinema';
    if (k === 'pandamovies') return '🐼 PandaMovies';
    return '🔥 XVideos';
  }

  function renderXvHub(ctx, ms) {
    if (!isGroupAdultAllowed(ctx, ms)) return renderAdultGroupLocked(ctx, ms);
    if (isAgeGateRequired(ctx)) return renderAdultAgeGate(ms);
    const dmOnly = isDmDownloadMode(ctx, ms);
    const streamMode = getMovieDeckStreamMode(ctx, ms);
    const cid = effectiveAdultChatId(ctx, ms);
    const b = dmOnly
      ? card('🔥 Lancy Cinema · XVideos Studio & 18+ Features', 'Multi-Source 18+ Cinema · Pornstars · Studios & Parodies · HD MP4')
      : card('🔥 Lancy Cinema · XVideos Stream Studio', `${streamMode === 'rtmp' ? '🔒 RTMP Locked A/V' : '🎙 Interactive VC'} · 18+ Features · Queue`);
    b.blockquote(rt.text(
      dmOnly
        ? 'Search 18+ full features (erotic thrillers, parodies, FullXCinema, PandaMovies, Eporner, PornTrex, xHamster), browse 40 Categories, Featured & live Pornstars, Studios, choose 360p/480p/720p, and download MP4 or slides.'
        : 'Browse 18+ Full Feature Movies, Parodies, Categories, Stars, or Studios and stream straight into Voice Chat (RTMP Live or Interactive VC) or queue multiple titles.'
    ));
    b.buttons([
      mvBtn(ms, '🔍 Search XVideos / 18+', 'xs', '', { style: 'success' }),
      mvBtn(ms, '🎬 18+ Full Features', 'xft', '0', { style: 'primary' })
    ]);
    b.buttons([
      mvBtn(ms, '🔥 Trending Now', 'xt', '0', { style: 'primary' }),
      mvBtn(ms, '🏢 Studios & Parodies', 'xst', '0', { style: 'primary' })
    ]);
    b.buttons([
      mvBtn(ms, '📂 Categories', 'xc', '0', { style: 'primary' }),
      mvBtn(ms, '⭐ Artists & Stars', 'xa', '0', { style: 'primary' })
    ]);
    const activeSrc = ms.xvSource || 'xvideos';
    b.buttons([
      mvBtn(ms, `${activeSrc === 'all' ? '• ' : ''}🌐 All`, 'xsrc', 'all'),
      mvBtn(ms, `${activeSrc === 'adult_movies' ? '• ' : ''}🎬 Movies`, 'xsrc', 'adult_movies'),
      mvBtn(ms, `${activeSrc === 'xvideos' ? '• ' : ''}🔥 XV`, 'xsrc', 'xvideos'),
      mvBtn(ms, `${activeSrc === 'pornhub' ? '• ' : ''}🟠 PH`, 'xsrc', 'pornhub')
    ]);
    if (!dmOnly) {
      b.buttons([
        mvBtn(ms, streamMode === 'rtmp' ? '🔄 Mode · 🔒 RTMP Live' : '🔄 Mode · 🎙 Interactive VC', 'xpm', '', {
          style: streamMode === 'rtmp' ? 'success' : 'primary'
        }),
        mvBtn(ms, '🎞 Cinema Queue', 'mq', ''),
        backToPlayerButton(ms)
      ]);
    }
    if (Number.isFinite(cid) && cid < 0) {
      b.buttons([mvBtn(ms, '🔒 Lock XVideos in Group (Admin)', 'xgt', '')]);
    }
    const footer = [mvBtn(ms, '🎬 Movies & TV', 'xm', 'movie')];
    if (dmOnly) footer.push(richButton.callback('🏠 Dashboard', encodeCallback('dashboard', 'open')));
    b.buttons(footer);
    appendLiveLog(b, ms);
    appendNoticeIfDistinct(b, ms);
    return finish(b);
  }

  function renderXvResults(ctx, ms) {
    if (!isGroupAdultAllowed(ctx, ms)) return renderAdultGroupLocked(ctx, ms);
    if (isAgeGateRequired(ctx)) return renderAdultAgeGate(ms);
    const dmOnly = isDmDownloadMode(ctx, ms);
    const results = Array.isArray(ms.xvResults) ? ms.xvResults : [];
    const perPage = 5;
    const localPagesCount = Math.max(1, Math.ceil(results.length / perPage));
    const localPage = Math.max(0, Math.min(Number(ms.xvResPage || 0) % 3, localPagesCount - 1));
    const startIdx = localPage * perPage;
    const slice = results.slice(startIdx, startIdx + perPage);
    const sel = ms.xvSelected instanceof Set ? ms.xvSelected : new Set();

    const modeTitle = ms.xvMode === 'category'
      ? `📂 ${ms.xvCat || 'Category'}`
      : ms.xvMode === 'artist'
        ? `⭐ ${ms.xvArtist || 'Artist'}`
        : ms.xvMode === 'studio' || ms.xvStudio
          ? `🏢 ${ms.xvStudio || 'Studio'}`
          : ms.xvMode === 'search' && ms.xvQuery
            ? `🔍 "${cut(ms.xvQuery, 26)}"`
            : '🔥 Trending Now';
    const activeSrc = ms.xvSource || 'xvideos';
    const b = card(
      `${getAdultSourceLabel(activeSrc)} · ${modeTitle}`,
      `Page ${(ms.xvResPage || 0) + 1} · Sort: ${ms.xvSort || 'relevance'} · Dur: ${ms.xvDur || 'all'} · ${sel.size} checked`
    );

    if (!slice.length) {
      b.paragraph(rt.italic('No matching 18+ results on this page. Try switching Source above (All / Movies / PornTrex / xHamster) or searching again.'));
    } else {
      b.table(
        slice.map((item, idx) => {
          const gIdx = startIdx + idx;
          const checked = sel.has(gIdx) ? '☑' : '☐';
          const tag = item.sourceKey === 'fullxcinema' ? '🎞 '
            : item.sourceKey === 'pandamovies' ? '🐼 '
            : item.sourceKey === 'xhamster' ? '🐹 '
            : item.sourceKey === 'porntrex' ? '🦖 '
            : item.sourceKey === 'pornhub' ? '🟠 '
            : item.sourceKey === 'eporner' ? '🎬 '
            : '';
          return [
            `${checked} ${gIdx + 1}`,
            `${tag}${cut(item.title || 'Untitled', 32)}`,
            item.duration || formatDurationLabel(item.durationSeconds || 0, 'HD'),
            cut(item.artist || item.source || '18+', 16)
          ];
        }),
        { striped: true, bordered: true, compact: true }
      );
      b.buttons(slice.map((_, idx) => {
        const gIdx = startIdx + idx;
        return mvBtn(ms, `${sel.has(gIdx) ? '☑' : '☐'} #${gIdx + 1}`, 'xk', String(gIdx), sel.has(gIdx) ? { style: 'success' } : null);
      }));
      b.buttons(slice.map((_, idx) => {
        const gIdx = startIdx + idx;
        return mvBtn(ms, `🔎 ${gIdx + 1}`, 'xo', String(gIdx), { style: 'primary' });
      }));
    }

    // Source Switcher row
    b.buttons([
      mvBtn(ms, `${activeSrc === 'all' ? '• ' : ''}🌐 All`, 'xsrc', 'all'),
      mvBtn(ms, `${activeSrc === 'adult_movies' ? '• ' : ''}🎬 Movies`, 'xsrc', 'adult_movies'),
      mvBtn(ms, `${activeSrc === 'xvideos' ? '• ' : ''}🔥 XV`, 'xsrc', 'xvideos'),
      mvBtn(ms, `${activeSrc === 'pornhub' ? '• ' : ''}🟠 PH`, 'xsrc', 'pornhub'),
      mvBtn(ms, `${activeSrc === 'xhamster' ? '• ' : ''}🐹 xH`, 'xsrc', 'xhamster'),
      mvBtn(ms, `${activeSrc === 'porntrex' ? '• ' : ''}🦖 PT`, 'xsrc', 'porntrex')
    ]);

    const sorts = [
      ['relevance', 'Relevance'],
      ['views', 'Views'],
      ['rating', 'Rating']
    ];
    b.buttons(sorts.map(([k, lbl]) => mvBtn(ms, `${(ms.xvSort || 'relevance') === k ? '• ' : ''}${lbl}`, 'xso', k)));

    const durs = [
      ['all', 'All'],
      ['short', '1-3m'],
      ['medium', '3-10m'],
      ['long', '10-20m'],
      ['full', '20m+'],
      ['movie', '45m+ Movie']
    ];
    b.buttons(durs.map(([k, lbl]) => mvBtn(ms, `${(ms.xvDur || 'all') === k ? '• ' : ''}${lbl}`, 'xd', k)));

    const pageIndices = slice.map((_, idx) => startIdx + idx);
    const pageAllSelected = pageIndices.length > 0 && pageIndices.every((idx) => sel.has(idx));
    const bulkRow = [mvBtn(ms, pageAllSelected ? '☐ Uncheck Page' : '☑ Check Page', 'xqa', '')];
    if (sel.size > 0) {
      if (!dmOnly) {
        bulkRow.push(mvBtn(ms, `⚡ Play (${sel.size})`, 'xpl', 'now', { style: 'success' }));
        bulkRow.push(mvBtn(ms, `➕ Queue (${sel.size})`, 'xpl', 'q', { style: 'primary' }));
      }
      bulkRow.push(mvBtn(ms, `⬇ Slides (${sel.size})`, 'xdl', 'sl', { style: 'success' }));
    }
    b.buttons(bulkRow);

    const hasNextLocal = localPage < localPagesCount - 1;
    const hasNextApi = results.length >= 15 && (Number(ms.xvApiPage || 0) + 1) < Math.max(1, Number(ms.xvTotalPages || 1));
    const navRow = [];
    if ((Number(ms.xvResPage) || 0) > 0) navRow.push(mvBtn(ms, '◀ Prev', 'xp', String(Number(ms.xvResPage) - 1)));
    navRow.push(mvBtn(ms, '🔍 Search', 'xs', ''));
    if (hasNextLocal || hasNextApi) navRow.push(mvBtn(ms, 'Next ▶', 'xp', String((Number(ms.xvResPage) || 0) + 1)));
    b.buttons(navRow);

    b.buttons([
      mvBtn(ms, '📂 Cats', 'xc', '0'),
      mvBtn(ms, '⭐ Artists', 'xa', '0'),
      mvBtn(ms, '🏢 Studios', 'xst', '0'),
      mvBtn(ms, '🏠 Hub', 'hb', '')
    ]);
    appendLiveLog(b, ms);
    appendNoticeIfDistinct(b, ms);
    return finish(b);
  }

  function renderXvDetail(ctx, ms) {
    if (!isGroupAdultAllowed(ctx, ms)) return renderAdultGroupLocked(ctx, ms);
    if (isAgeGateRequired(ctx)) return renderAdultAgeGate(ms);
    const dmOnly = isDmDownloadMode(ctx, ms);
    const cid = effectiveAdultChatId(ctx, ms);
    const item = (ms.xvResults || [])[Number(ms.xvCurrentIdx || 0)] || ms.mediaItem || {};
    const resolved = ms.xvResolved || null;
    const q = getXvQuality(ms);
    const variants = Array.isArray(resolved?.variants) ? resolved.variants : (Array.isArray(item.variants) ? item.variants : []);
    const durSec = Number(resolved?.durationSeconds || item.durationSeconds || 0);
    const streamMode = getMovieDeckStreamMode(ctx, ms);

    const b = card(
      `🔥 ${cut(resolved?.fullTitle || item.title || 'XVideos Stream', 48)}`,
      `${cut(resolved?.artist || item.artist || 'XVideos', 24)} · ${formatDurationLabel(durSec, item.duration || 'HD')} · ${q}`
    );
    // Group safety: attach photo preview in private DMs only; never expose unblurred adult artwork in groups/channels
    const thumb = resolved?.thumbUrl || item.thumbUrl || item.poster || null;
    if (Number.isFinite(cid) && cid > 0 && isSafeHttpsUrl(thumb)) {
      b.photo(thumb, cut(item.title || 'XVideos Preview', 90));
    }

    const sizeForHeight = (h) => {
      const match = variants.find((v) => Number(v.height) === h && Number(v.sizeBytes) > 0);
      return match?.sizeBytes ? ` (${Math.max(1, Math.round(match.sizeBytes / (1024 * 1024)))}MB)` : '';
    };
    const meta = [
      ['Source', 'XVideos'],
      ['Creator', cut(resolved?.artist || item.artist || 'Creator', 36)],
      ['Duration', formatDurationLabel(durSec, item.duration || 'HD')],
      ['Quality', `${q}${sizeForHeight(xvQualityHeight(q))}`]
    ];
    if (!dmOnly) {
      meta.push(['VC Engine', streamMode === 'rtmp' ? '🔒 RTMP Live (Locked A/V)' : '🎙 Interactive VC (WebRTC)']);
    }
    b.table(meta, { striped: true, bordered: true, compact: true });

    b.buttons(['360p', '480p', '720p'].map((tier) => {
      const sz = sizeForHeight(xvQualityHeight(tier));
      const active = q === tier;
      return mvBtn(ms, `${active ? '✓ ' : ''}${tier}${sz}`, 'xq', tier, active ? { style: 'success' } : null);
    }));

    if (dmOnly) {
      b.buttons([
        mvBtn(ms, `⬇ Download ${q} MP4`, 'xdl', 'cur', { style: 'success' })
      ]);
    } else {
      b.buttons([
        mvBtn(ms, '⚡ Play in VC', 'xpl', 'cur', { style: 'success' }),
        mvBtn(ms, '➕ Add to Queue', 'xpl', 'curq', { style: 'primary' })
      ]);
      b.buttons([
        mvBtn(ms, streamMode === 'rtmp' ? '🔄 Mode · 🔒 RTMP Live' : '🔄 Mode · 🎙 Interactive VC', 'xpm', ''),
        mvBtn(ms, `⬇ Download ${q} MP4`, 'xdl', 'cur', { style: 'primary' })
      ]);
    }

    const tail = [];
    if (Array.isArray(ms.xvResults) && ms.xvResults.length) tail.push(mvBtn(ms, '◀ Results', 'xrv', ''));
    if (!dmOnly) tail.push(mvBtn(ms, '🎞 Queue', 'mq', ''));
    tail.push(mvBtn(ms, '🏠 Hub', 'hb', ''));
    b.buttons(tail);
    appendLiveLog(b, ms);
    appendNoticeIfDistinct(b, ms);
    return finish(b);
  }

  function renderXvCats(ctx, ms) {
    const catPage = getCatalog().getCategories({ page: Number(ms.xvCatPage || 0), perPage: 12 });
    ms.xvCatPage = catPage.page;
    const b = card('📂 XVideos Categories', `Page ${catPage.page + 1}/${catPage.totalPages} · ${catPage.total} categories`);
    b.paragraph(rt.italic('Tap any category to browse XVideos HD streams & downloads.'));
    for (let i = 0; i < catPage.items.length; i += 3) {
      b.buttons(catPage.items.slice(i, i + 3).map((c) => mvBtn(ms, c.label || c.id, 'xcc', c.id, { style: 'primary' })));
    }
    const nav = [];
    if (catPage.page > 0) nav.push(mvBtn(ms, '◀ Prev', 'xcp', String(catPage.page - 1)));
    nav.push(mvBtn(ms, '🔍 Search', 'xs', ''));
    if (catPage.page < catPage.totalPages - 1) nav.push(mvBtn(ms, 'Next ▶', 'xcp', String(catPage.page + 1)));
    b.buttons(nav);
    b.buttons([mvBtn(ms, '⭐ Artists', 'xa', '0'), mvBtn(ms, '🏠 Hub', 'hb', '')]);
    return finish(b);
  }

  function renderXvArtists(ctx, ms) {
    const list = Array.isArray(ms.xvArtists) ? ms.xvArtists : [];
    const totalPages = Math.max(1, Number(ms.xvArtistsTotalPages || 1));
    const page = Math.max(0, Math.min(Number(ms.xvArtistPage || 0), totalPages - 1));
    ms.xvArtistPage = page;
    const b = card('⭐ Featured & Verified Pornstars / Artists', `Page ${page + 1}/${totalPages} · Tap any star to view movies & scenes`);
    b.buttons([mvBtn(ms, '🔍 Search Any Star Name', 'xas', '', { style: 'success' })]);
    if (!list.length) {
      b.paragraph(rt.italic('No artists loaded. Tap Search Any Star Name above to look up any pornstar filmography.'));
    } else {
      for (let i = 0; i < list.length; i += 3) {
        b.buttons(list.slice(i, i + 3).map((a, subIdx) => {
          const suffix = a.movieCount ? ` (${a.movieCount})` : '';
          return mvBtn(ms, `⭐ ${cut(a.name, 16)}${suffix}`, 'xac', String(i + subIdx), { style: 'primary' });
        }));
      }
    }
    const nav = [];
    if (page > 0) nav.push(mvBtn(ms, '◀ Prev', 'xap', String(page - 1)));
    nav.push(mvBtn(ms, '🔍 Search', 'xs', ''));
    if (page < totalPages - 1) nav.push(mvBtn(ms, 'Next ▶', 'xap', String(page + 1)));
    b.buttons(nav);
    b.buttons([mvBtn(ms, '📂 Categories', 'xc', '0'), mvBtn(ms, '🏢 Studios', 'xst', '0'), mvBtn(ms, '🏠 Hub', 'hb', '')]);
    return finish(b);
  }

  function renderXvStudios(ctx, ms) {
    const list = Array.isArray(ms.xvStudios) && ms.xvStudios.length ? ms.xvStudios : FEATURED_STUDIOS.slice(0, 12);
    const totalPages = Math.max(1, Number(ms.xvStudiosTotalPages || 1));
    const page = Math.max(0, Math.min(Number(ms.xvStudioPage || 0), totalPages - 1));
    ms.xvStudioPage = page;
    const b = card('🏢 18+ Studios & Feature Producers', `Page ${page + 1}/${totalPages} · Tap a studio for full feature films`);
    b.buttons([mvBtn(ms, '🔍 Search Studio Name', 'xsp', '', { style: 'success' })]);
    for (let i = 0; i < list.length; i += 3) {
      b.buttons(list.slice(i, i + 3).map((st, subIdx) => {
        const suffix = st.movieCount ? ` (${st.movieCount})` : '';
        return mvBtn(ms, `🏢 ${cut(st.name, 16)}${suffix}`, 'xsc', String(i + subIdx), { style: 'primary' });
      }));
    }
    const nav = [];
    if (page > 0) nav.push(mvBtn(ms, '◀ Prev', 'xst', String(page - 1)));
    nav.push(mvBtn(ms, '🎬 All Features', 'xft', '0'));
    if (page < totalPages - 1) nav.push(mvBtn(ms, 'Next ▶', 'xst', String(page + 1)));
    b.buttons(nav);
    b.buttons([mvBtn(ms, '⭐ Artists', 'xa', '0'), mvBtn(ms, '📂 Categories', 'xc', '0'), mvBtn(ms, '🏠 Hub', 'hb', '')]);
    return finish(b);
  }

  function renderHub(ctx, ms) {
    if (ms?.sourceMode === 'xvideos') return renderXvHub(ctx, ms);
    const dmOnly = isDmDownloadMode(ctx, ms);
    const cid = effectiveAdultChatId(ctx, ms);
    const b = dmOnly
      ? card('🎬 Lancy Cinema · Movie & Series Downloads', 'Direct HD MP4 & Clean Paginated Slides · Zero Chat Clutter')
      : card('🎬 Lancy Music · Movie & Series Stream', 'HD VC Playback · Synced Subtitles · High-Capacity Downloads');
    b.blockquote(rt.text(
      dmOnly
        ? 'Search any movie or multi-season TV series and download full HD MP4 files or clean paginated album slides (◀ Prev / Next ▶).'
        : 'Stream full movies & multi-season TV series into Voice Chat or download directly with paginated album slides.'
    ));
    b.buttons([
      mvBtn(ms, '🔍 Search Movie / TV', 'ps', '', { style: 'success' }),
      mvBtn(ms, '🤖 AI Movie & Song', 'ai', '', { style: 'primary' })
    ]);
    b.buttons([
      mvBtn(ms, '🎲 Random Pick', 'rn', ''),
      mvBtn(ms, '🔥 Trending Now', 'tr', '0'),
      mvBtn(ms, '🍿 Categories', 'cg', '0')
    ]);
    const utilRow = dmOnly
      ? [richButton.callback('🏠 Dashboard', encodeCallback('dashboard', 'open'))]
      : [
        mvBtn(ms, '🎞 Cinema Queue', 'mq', ''),
        backToPlayerButton(ms)
      ];
    if (isGroupAdultAllowed(ctx, ms)) {
      utilRow.push(mvBtn(ms, '🔥 XVideos Mode', 'xm', 'xvideos', { style: 'primary' }));
    } else if (Number.isFinite(cid) && cid < 0) {
      utilRow.push(mvBtn(ms, '🔓 Unlock XVideos (Admin)', 'xgt', ''));
    }
    b.buttons(utilRow);
    b.details('💡 How Multi-Season TV & Album Slides Work', [
      block.paragraph(rt.text('1. Search any movie or series — pick episodes or whole seasons.\n2. Tap ⬇ Download Slides to browse clean 1-slide batches (◀ Prev / Next ▶ without flooding chat).\n3. Tap 💾 Keep Slide on any slide you want saved permanently in chat.'))
    ], false);
    return finish(b);
  }

  function renderResults(ctx, ms) {
    const items = Array.isArray(ms.results) ? ms.results : [];
    const dmOnly = isDmDownloadMode(ctx, ms);
    const adultAllowed = isGroupAdultAllowed(ctx, ms);
    const perPage = 4;
    const totalPages = Math.max(1, Math.ceil(items.length / perPage));
    ms.resultPage = Math.max(0, Math.min(Number(ms.resultPage) || 0, totalPages - 1));
    const startIdx = ms.resultPage * perPage;
    const slice = items.slice(startIdx, startIdx + perPage);
    const title = ms.query ? `🎬 Results · ${cut(ms.query, 40)}` : (ms.categoryLabel ? `🍿 ${cut(ms.categoryLabel, 40)}` : '🔥 Trending Movies & Series');
    const b = card(
      title,
      `Page ${ms.resultPage + 1}/${totalPages} · ${items.length} titles · ${dmOnly ? 'Tap Episodes / Download / Info' : 'Stream · Episodes · Download'}`
    );

    if (!slice.length) {
      b.pullquote(
        rt.italic('No matching titles found on normal or expanded indexes. Tap 🔍 Search Again, 🔥 XVideos / 18+, or ask 🤖 Ask AI.'),
        rt.text('Lancy Cinema Search')
      );
    } else {
      slice.forEach((item, idx) => {
        const gIdx = startIdx + idx;
        const num = gIdx + 1;
        const isTv = item.type === 'tv';
        const isAdult = Boolean(item.isAdultCatalogItem || item.isAdultHint || item.adult);
        const icon = isAdult ? '🔞' : (isTv ? '📺' : '🎬');
        const seasonCount = Number(
          item.totalSeasons
          || (Array.isArray(item.seasons) ? item.seasons.filter((s) => Number(s.seasonNumber) >= 1).length : 0)
          || 0
        );
        const epCount = Number(item.totalEpisodes || 0);
        const typeBadge = isAdult
          ? '18+ Feature'
          : (isTv
            ? (seasonCount > 0 ? `Series · ${seasonCount} ${seasonCount === 1 ? 'Season' : 'Seasons'}` : (epCount > 0 ? `Series · ${epCount} Eps` : 'TV Series'))
            : 'Movie');
        const metaParts = [typeBadge];
        if (item.year) metaParts.push(String(item.year));
        if (item.duration) metaParts.push(String(item.duration));
        else if (item.runtimeMinutes) metaParts.push(`${item.runtimeMinutes}m`);
        if (item.rating) metaParts.push(`⭐ ${item.rating}`);
        if (Array.isArray(item.genres) && item.genres.length) {
          metaParts.push(cut(item.genres.slice(0, 2).join(', '), 24));
        }

        b.heading(`${num}. ${icon} ${cut(item.title, 84)}`, 3);
        const snippet = item.overview
          ? cut(item.overview, 155)
          : (isAdult
            ? 'Verified 18+ full feature / scene · Instant VC stream & spoiler-safe MP4 download.'
            : (isTv
              ? 'TV series · Tap 📺 Episodes to browse every season and episode, or play S01E01 now.'
              : 'HD full-length feature · Stream to Voice Chat or download MP4 directly.'));
        b.pullquote(rt.italic(snippet), rt.text(metaParts.join(' · ')));

        if (dmOnly) {
          b.buttons([
            mvBtn(ms, '💾 Download', 'dmi', String(gIdx), { style: 'success' }),
            mvBtn(ms, isTv ? '📺 Episodes' : 'ℹ️ Full Info', 'pk', String(gIdx), { style: isTv ? 'primary' : 'link' })
          ]);
        } else if (isTv) {
          b.buttons([
            mvBtn(ms, '⚡ Play Ep 1', 'pmi', String(gIdx), { style: 'success' }),
            mvBtn(ms, '📺 Episodes', 'pk', String(gIdx), { style: 'primary' })
          ]);
          b.buttons([
            mvBtn(ms, '➕ Queue', 'qmi', String(gIdx)),
            mvBtn(ms, '💾 Download', 'dmi', String(gIdx), { style: 'primary' })
          ]);
        } else {
          b.buttons([
            mvBtn(ms, '⚡ Play Now', 'pmi', String(gIdx), { style: 'success' }),
            mvBtn(ms, '➕ Queue', 'qmi', String(gIdx), { style: 'primary' }),
            mvBtn(ms, '💾 Download', 'dmi', String(gIdx), { style: 'primary' }),
            mvBtn(ms, 'ℹ️', 'pk', String(gIdx), { style: 'link' })
          ]);
        }

        if (idx < slice.length - 1) {
          b.divider();
        }
      });
    }

    appendLiveLog(b, ms);
    appendNoticeIfDistinct(b, ms);

    const nav = [];
    if (ms.resultPage > 0) nav.push(mvBtn(ms, '◀ Prev', 'rp', String(ms.resultPage - 1)));
    nav.push(mvBtn(ms, `✨ ${ms.resultPage + 1}/${totalPages}`, 'rp', String(ms.resultPage), { style: 'link' }));
    if (ms.resultPage < totalPages - 1) nav.push(mvBtn(ms, 'More ⏩', 'rp', String(ms.resultPage + 1), { style: 'primary' }));
    b.buttons(nav);

    b.buttons([
      mvBtn(ms, '🔍 Search Again', 'ps', '', { style: 'primary' }),
      mvBtn(ms, '🔞 XVideos / 18+', 'xfu', '', { style: adultAllowed ? 'primary' : 'link' }),
      mvBtn(ms, '🗑️ Cancel', 'xca', '', { style: 'danger' })
    ]);

    b.buttons([
      mvBtn(ms, '🎲 Random', 'rn', '', { style: 'link' }),
      mvBtn(ms, '🤖 Ask AI', 'ai', '', { style: 'link' }),
      mvBtn(ms, '🏠 Hub', 'hb', '', { style: 'link' })
    ]);

    b.footer(`Lancy Cinema · ${dmOnly ? 'DM Direct MP4' : 'GC/VC Live Sync'} · Unified Normal + 18+ Ready`);
    return finish(b);
  }

  function renderMovieDetail(ctx, ms) {
    const item = ms.mediaItem || {};
    const dmOnly = isDmDownloadMode(ctx, ms);
    const runtime = item.runtimeMinutes || item.runtime || null;
    const b = card(`🎬 ${cut(item.title || 'Movie', 52)}`, `${item.year || ''} ${item.rating ? `· ⭐ ${item.rating}` : ''} ${runtime ? `· ${runtime} min` : ''}`.trim());
    if (isSafeHttpsUrl(item.poster)) {
      b.photo(item.poster, cut(item.title, 90));
    }
    const dlQuality = getUserDownloadQuality(ctx, ms);
    const estDur = Number(item.runtimeSeconds || (runtime ? Number(runtime) * 60 : 5400));
    const variants = ms.playback?.variants || item.variants || null;
    const estInfo = estimateQualityInfo(dlQuality, { durationSeconds: estDur, itemCount: 1, variants });
    const meta = [
      ['Type', 'Full Feature Movie'],
      ['Year', item.year ? String(item.year) : 'Unknown'],
      ['Runtime', runtime ? `${runtime} min` : (item.runtimeSeconds ? durationText(item.runtimeSeconds) : 'Full feature')],
      ['Genres', item.genres?.length ? cut(item.genres.slice(0, 3).join(', '), 42) : 'Feature Film'],
      [dmOnly ? 'Delivery' : 'Subtitles', dmOnly ? 'Direct Telegram MP4' : 'Screen Burn / Live Sync'],
      ['📦 Quality', `${estInfo.label} (${estInfo.text})`]
    ];
    b.table(meta, { striped: true, bordered: true, compact: true });
    if (item.overview) {
      b.expandableBlockquote(`Synopsis · ${cut(item.title, 48)}\n\n${cut(item.overview, 600)}`);
    }
    appendLiveLog(b, ms);
    appendNoticeIfDistinct(b, ms);

    if (dmOnly) {
      b.buttons(buildQualitySelectorRow(ms, dlQuality, { durationSeconds: estDur, itemCount: 1, variants }));
      b.buttons([
        mvBtn(ms, `⬇ Download Movie (${dlQuality} · ${estInfo.text})`, 'dm', '', { style: 'success' })
      ]);
    } else {
      b.buttons([
        mvBtn(ms, '⚡ Play Now', 'pm', '', { style: 'success' }),
        mvBtn(ms, '➕ Add to Queue', 'qm', '', { style: 'primary' })
      ]);
      b.buttons(buildQualitySelectorRow(ms, dlQuality, { durationSeconds: estDur, itemCount: 1, variants }));
      b.buttons([
        mvBtn(ms, `⬇ Download (${dlQuality} · ${estInfo.text})`, 'dm', '', { style: 'success' }),
        mvBtn(ms, '🎞 Cinema Queue', 'mq', '')
      ]);
    }
    const row2 = [];
    if (ms.results?.length) row2.push(mvBtn(ms, '◀ Results', 'rs', ''));
    row2.push(mvBtn(ms, '🏠 Hub', 'hb', ''));
    b.buttons(row2);
    return finish(b);
  }

  function renderTvSeason(ctx, ms) {
    const item = ms.mediaItem || {};
    const dmOnly = isDmDownloadMode(ctx, ms);
    const seasonNum = ms.seasonNumber == null ? 1 : Number(ms.seasonNumber);
    const episodes = Array.isArray(ms.episodes) ? ms.episodes : [];
    const seasons = Array.isArray(ms.seasons) ? ms.seasons : [];
    const perPage = 6;
    const totalPages = Math.max(1, Math.ceil(episodes.length / perPage));
    ms.epPage = Math.max(0, Math.min(Number(ms.epPage) || 0, totalPages - 1));
    const slice = episodes.slice(ms.epPage * perPage, (ms.epPage + 1) * perPage);
    const selectedSet = ms.selectedBySeason.get(seasonNum) || new Set();
    const totalSelected = app.movieSessions.totalSelectedCount(ms);
    const totalSeasons = seasons.filter((s) => Number(s.seasonNumber) >= 1).length || seasons.length || 1;
    const seasonLabel = seasonNum === 0 ? 'Specials' : `Season ${seasonNum}`;
    const shortSeasonTag = seasonNum === 0 ? 'Specials' : `S${seasonNum}`;

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
          const rtMin = ep.runtimeMinutes || (ep.runtimeSeconds ? Math.round(Number(ep.runtimeSeconds) / 60) : null);
          const runtime = rtMin ? ` (${rtMin}m)` : '';
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

      if (dmOnly) {
        for (let i = 0; i < slice.length; i += 3) {
          b.buttons(
            slice.slice(i, i + 3).map(ep => {
              const epNum = Number(ep.episodeNumber || 0);
              const checked = selectedSet.has(epNum);
              return mvBtn(ms, `${checked ? '☑' : '☐'} E${epNum}`, 'tg', `${seasonNum}-${epNum}`, checked ? { style: 'success' } : null);
            })
          );
        }
      } else {
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
    }

    if (seasons.length > 1) {
      const pillWindow = seasons.length <= 8
        ? seasons
        : (() => {
            const activeIdx = Math.max(0, seasons.findIndex((se) => Number(se.seasonNumber) === seasonNum));
            const start = Math.max(0, Math.min(activeIdx - 2, seasons.length - 8));
            return seasons.slice(start, start + 8);
          })();
      for (let i = 0; i < pillWindow.length; i += 4) {
        b.buttons(
          pillWindow.slice(i, i + 4).map((se) => {
            const sN = se.seasonNumber == null ? 1 : Number(se.seasonNumber);
            const active = sN === seasonNum;
            const sLbl = sN === 0 ? 'Specials' : `S${sN}`;
            const selCnt = ms.selectedBySeason.get(sN)?.size || 0;
            const btnText = `${active ? '• ' : ''}${sLbl}${selCnt ? `✓${selCnt}` : ''}`;
            return mvBtn(ms, btnText, 'so', String(sN), active ? { style: 'success' } : null);
          })
        );
      }
    }

    b.buttons([
      mvBtn(ms, '☑ Page', 'sp', String(ms.epPage)),
      mvBtn(ms, `✅ All ${shortSeasonTag}`, 'sa', String(seasonNum)),
      mvBtn(ms, '☑ All Seasons', 'sas', '', { style: 'primary' }),
      mvBtn(ms, '✕ Clear', 'cl', '')
    ]);

    const nav = [];
    if (ms.epPage > 0) nav.push(mvBtn(ms, '◀ Prev', 'ep', String(ms.epPage - 1)));
    nav.push(mvBtn(ms, `📚 Seasons (${seasons.length || totalSeasons})`, 'ss', '0', { style: 'primary' }));
    if (ms.epPage < totalPages - 1) nav.push(mvBtn(ms, 'Next ▶', 'ep', String(ms.epPage + 1)));
    b.buttons(nav);

    if (!dmOnly) {
      b.buttons([
        mvBtn(ms, `⚡ Play Selected (${totalSelected})`, 'px', '', { style: 'success' }),
        mvBtn(ms, `➕ Queue (${totalSelected})`, 'qx', '', { style: 'primary' })
      ]);
    }
    const dlQuality = getUserDownloadQuality(ctx, ms);
    const epDur = Number(episodes[0]?.runtimeSeconds || (episodes[0]?.runtimeMinutes ? Number(episodes[0].runtimeMinutes) * 60 : 2700));
    const dlCount = totalSelected > 0 ? totalSelected : Math.max(1, episodes.length);
    b.buttons(buildQualitySelectorRow(ms, dlQuality, { durationSeconds: epDur, itemCount: dlCount }));
    b.buttons([
      mvBtn(
        ms,
        totalSelected > 0 ? `⬇ Download Slides (${totalSelected} · ${dlQuality})` : `⬇ Download ${seasonLabel} Slides (${dlQuality})`,
        totalSelected > 0 ? 'dx' : 'dsx',
        totalSelected > 0 ? '' : String(seasonNum),
        { style: 'success' }
      )
    ]);

    appendLiveLog(b, ms);
    appendNoticeIfDistinct(b, ms);

    const tail = [];
    if (ms.results?.length) tail.push(mvBtn(ms, '◀ Results', 'rs', ''));
    tail.push(mvBtn(ms, '🏠 Hub', 'hb', ''));
    b.buttons(tail);
    return finish(b);
  }

  function renderSeasonPicker(ctx, ms) {
    const item = ms.mediaItem || {};
    const dmOnly = isDmDownloadMode(ctx, ms);
    const seasons = Array.isArray(ms.seasons) ? ms.seasons : [];
    const activeSeasonNum = ms.seasonNumber == null ? 1 : Number(ms.seasonNumber);
    const perPage = 12;
    const totalPages = Math.max(1, Math.ceil(seasons.length / perPage));
    ms.seasonPage = Math.max(0, Math.min(Number(ms.seasonPage) || 0, totalPages - 1));
    const slice = seasons.slice(ms.seasonPage * perPage, (ms.seasonPage + 1) * perPage);
    const totalSelected = app.movieSessions.totalSelectedCount(ms);

    const b = card(`📚 ${cut(item.title || 'Select Season', 46)}`, `${seasons.length} seasons available · Tap a season or select all`);
    b.table(
      slice.map(se => {
        const sNum = se.seasonNumber == null ? 0 : Number(se.seasonNumber);
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
          const sNum = se.seasonNumber == null ? 0 : Number(se.seasonNumber);
          const selCount = ms.selectedBySeason.get(sNum)?.size || 0;
          const active = sNum === activeSeasonNum;
          const lbl = `${sNum === 0 ? 'Specials' : `S${sNum}`}${se.episodeCount ? ` (${se.episodeCount})` : ''}${selCount ? ` ·✓${selCount}` : ''}`;
          return mvBtn(ms, lbl, 'so', String(sNum), active ? { style: 'success' } : null);
        })
      );
    }

    const dlQuality = getUserDownloadQuality(ctx, ms);
    const curSe = seasons.find((se) => Number(se.seasonNumber) === activeSeasonNum);
    const estCount = totalSelected > 0 ? totalSelected : Math.max(1, Number(curSe?.episodeCount || ms.episodes?.length || 6));
    b.buttons([
      mvBtn(ms, '☑ Select All Seasons & All Episodes', 'sas', '', { style: 'success' })
    ]);
    b.buttons(buildQualitySelectorRow(ms, dlQuality, { durationSeconds: 2700, itemCount: estCount }));
    const activeSeasonTitle = activeSeasonNum === 0 ? 'Specials' : `Season ${activeSeasonNum}`;
    const activeSeasonShort = activeSeasonNum === 0 ? 'Specials' : `S${activeSeasonNum}`;
    if (dmOnly) {
      const dlSeasonBtn = mvBtn(ms, `📦 Download ${activeSeasonTitle} (${dlQuality})`, 'dsx', String(activeSeasonNum), { style: 'success' });
      const dlRow = [dlSeasonBtn];
      if (totalSelected > 0) dlRow.push(mvBtn(ms, `⬇ Slides (${totalSelected} · ${dlQuality})`, 'dx', '', { style: 'primary' }));
      b.buttons(dlRow);
    } else if (totalSelected > 0) {
      b.buttons([
        mvBtn(ms, `⚡ Play All (${totalSelected})`, 'px', '', { style: 'success' }),
        mvBtn(ms, `➕ Queue (${totalSelected})`, 'qx', '', { style: 'primary' }),
        mvBtn(ms, `⬇ Slides (${totalSelected} · ${dlQuality})`, 'dx', '', { style: 'success' })
      ]);
    }

    const nav = [];
    if (ms.seasonPage > 0) nav.push(mvBtn(ms, '◀ Prev Seasons', 'ss', String(ms.seasonPage - 1)));
    nav.push(mvBtn(ms, `◀ Back to ${activeSeasonShort}`, 'sv', ''));
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
    if (ms.view === 'xv_results') return renderXvResults(ctx, ms);
    if (ms.view === 'xv_detail') return renderXvDetail(ctx, ms);
    if (ms.view === 'xv_cats') return renderXvCats(ctx, ms);
    if (ms.view === 'xv_artists') return renderXvArtists(ctx, ms);
    if (ms.view === 'xv_studios') return renderXvStudios(ctx, ms);
    if (ms.view === 'results') return renderResults(ctx, ms);
    if (ms.view === 'movie') return renderMovieDetail(ctx, ms);
    if (ms.view === 'season') return renderTvSeason(ctx, ms);
    if (ms.view === 'seasons') return renderSeasonPicker(ctx, ms);
    if (ms.view === 'categories') return renderCategories(ctx, ms);
    return renderHub(ctx, ms);
  }

  function getSameChatActivePlayerId(ctx, ms) {
    try {
      const dest = ms?.destination || app.music.destination(ctx);
      if (!dest) return null;
      const qmS = app.musicQueueManager?.getSession?.(dest);
      if (!qmS?.screenMessageId) return null;
      const playerChat = qmS.playerChatId || dest;
      if (Number(playerChat) !== Number(ctx?.chatId)) return null;
      return qmS.screenMessageId;
    } catch {
      return null;
    }
  }

  function touchPanelOverlay(ctx, ms, view = 'movie') {
    const token = ms?.panelToken || ctx?.musicPanel?.panelToken;
    if (!token) return;
    const panel = ctx?.musicPanel || app.music?.channelPanels?.panels?.get?.(token) || null;
    if (panel) {
      panel.overlayView = view;
      panel.overlayAt = Date.now();
      panel.lastRender = null;
    }
  }

  async function cleanupSupersededCards(ctx, ms, keepId = null) {
    if (!ctx?.api?.deleteMessage) return;
    const activePlayerId = getSameChatActivePlayerId(ctx, ms);
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
    else ms.activeCardIds = [];
    ms.promptMessageId = null;
  }

  async function upsertCard(ctx, ms, rich, opts = {}) {
    const isChan = isChannelCtx(ctx);
    const key = chatSlotKey(ctx);
    const activePlayerId = getSameChatActivePlayerId(ctx, ms);
    const forceNewCard = Boolean(opts?.forceNewCard);
    const pendingReplyId = opts?.replyToMessageId ?? ms._pendingReplyToId ?? null;
    touchPanelOverlay(ctx, ms, 'movie');

    let editId = forceNewCard
      ? null
      : (
        ms.messageId
        || (ctx.query && ctx.messageId)
        || (ms.panelToken ? ctx.musicPanel?.screenMessageId : null)
        || (isChan ? reusableChannelSlotId(ctx) : null)
      );

    // Keep an active Group/Channel Playing Card intact when launching Movie Search alongside playback.
    if (!ms.panelToken && activePlayerId && editId && Number(editId) === Number(activePlayerId)) {
      editId = null;
    }
    if (!ms.panelToken && activePlayerId && ms.messageId && Number(ms.messageId) === Number(activePlayerId)) {
      ms.messageId = null;
    }

    const nextHasPhoto = hasRichPhoto(rich);
    const sameMediaKind = ms.messageHasPhoto == null || ms.messageHasPhoto === nextHasPhoto;

    if (editId && ctx.api?.editMessageRich && sameMediaKind) {
      try {
        const edited = await ctx.api.editMessageRich(ctx.chatId, editId, rich);
        ms.messageId = edited?.message_id || editId;
        ms.messageHasPhoto = nextHasPhoto;
        ms._pendingReplyToId = null;
        app.movieSessions.registerMessage?.(ms, ms.messageId, 'card');
        if (ms.panelToken) app.music.channelPanels?.registerMessage?.(ms.panelToken, ms.messageId);
        if (isChan) {
          menuMsgByChat.set(key, { messageId: ms.messageId, token: ms.temporaryToken || null, api: ctx.api });
        }
        return ms.messageId;
      } catch (e) {
        if (/message is not modified/i.test(String(e?.description || e?.message || ''))) return editId;
        const msgStr = String(e?.description || e?.message || '');
        if (hasRichPhoto(rich) && /wrong type of the web page content|failed to get http url content|wrong file identifier|media_empty|webpage_media_empty|photo_invalid_dimensions|wrong_file_id/i.test(msgStr)) {
          try {
            const stripped = stripRemotePhotoBlocks(rich);
            const editedNoPhoto = await ctx.api.editMessageRich(ctx.chatId, editId, stripped);
            ms.messageId = editedNoPhoto?.message_id || editId;
            ms.messageHasPhoto = hasRichPhoto(stripped);
            ms._pendingReplyToId = null;
            app.movieSessions.registerMessage?.(ms, ms.messageId, 'card');
            if (ms.panelToken) app.music.channelPanels?.registerMessage?.(ms.panelToken, ms.messageId);
            if (isChan) {
              menuMsgByChat.set(key, { messageId: ms.messageId, token: ms.temporaryToken || null, api: ctx.api });
            }
            return ms.messageId;
          } catch {}
        }
      }
    }

    const replyTarget = pendingReplyId || ms.replyToMessageId || null;
    const sendExtra = replyTarget && (!editId || forceNewCard)
      ? { reply_parameters: { message_id: Number(replyTarget), allow_sending_without_reply: true } }
      : {};
    let sent;
    let sentRich = rich;
    try {
      sent = await ctx.api.sendRichMessage(ctx.chatId, rich, sendExtra);
    } catch (e) {
      const msgStr = String(e?.description || e?.message || '');
      if (hasRichPhoto(rich) && /wrong type of the web page content|failed to get http url content|wrong file identifier|media_empty|webpage_media_empty|photo_invalid_dimensions|wrong_file_id/i.test(msgStr)) {
        sentRich = stripRemotePhotoBlocks(rich);
        sent = await ctx.api.sendRichMessage(ctx.chatId, sentRich, sendExtra);
      } else {
        throw e;
      }
    }
    if (sent?.message_id) {
      ms.messageId = sent.message_id;
      ms.messageHasPhoto = hasRichPhoto(sentRich);
      ms._pendingReplyToId = null;
      app.movieSessions.registerMessage?.(ms, sent.message_id, 'card');
      await cleanupSupersededCards(ctx, ms, sent.message_id);
      if (ms.panelToken) app.music.channelPanels?.registerMessage?.(ms.panelToken, sent.message_id);
      if (isChan) {
        menuMsgByChat.set(key, { messageId: sent.message_id, token: ms.temporaryToken || null, api: ctx.api });
      }
    }
    return ms.messageId;
  }

  function tmdbRouteFields(item, extra = null) {
    return {
      tmdbId: extra?.tmdbId ?? item?.tmdbId ?? null,
      franchiseTmdbId: extra?.franchiseTmdbId ?? item?.franchiseTmdbId ?? null,
      franchiseTitle: extra?.franchiseTitle ?? item?.franchiseTitle ?? null,
      franchiseSeasonNumber: extra?.franchiseSeasonNumber ?? item?.franchiseSeasonNumber ?? null,
      franchiseSeasonName: extra?.franchiseSeasonName ?? item?.franchiseSeasonName ?? null
    };
  }

  async function loadItemIntoSession(ms, item) {
    app.movieSessions.clearSlideMessages?.(ms);
    if (item?.isAdultCatalogItem && item?.xvItem) {
      ms.xvResults = [item.xvItem];
      await loadXvDetailIntoSession(ms, 0);
      return;
    }
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
        ms.mediaItem = {
          ...item,
          ...detail,
          type: 'tv',
          imdbId: detail.imdbId || item.imdbId || null,
          ...tmdbRouteFields(item, detail),
          downloadUrls: detail.downloadUrls?.length ? detail.downloadUrls : (item.downloadUrls || [])
        };
      }
      const list = seasonsRes?.seasons?.length
        ? seasonsRes.seasons
        : (detail?.seasons?.length ? detail.seasons : [{ seasonNumber: 1, name: 'Season 1', episodeCount: detail?.totalEpisodes || 0 }]);
      ms.seasons = list;
      // Default to Season 1 (first non-zero season when available), preserving Season 0 when only Specials exist
      const firstSeason = list.find(s => Number(s.seasonNumber) > 0) || list[0];
      const sNum = firstSeason?.seasonNumber == null ? 1 : Number(firstSeason.seasonNumber);
      ms.seasonNumber = sNum;
      ms.seasonName = firstSeason?.name || (sNum === 0 ? 'Specials' : `Season ${sNum}`);
      ms.epPage = 0;
      const [epsRes, pb] = await Promise.all([
        app.movieApi.getTvSeasonEpisodes(item.id, sNum).catch(() => null),
        app.movieApi.getPlaybackInfo('tv', item.id, { season: sNum, episode: 1 }).catch(() => null)
      ]);
      ms.episodes = epsRes?.episodes || [];
      ms.playback = pb;
      if (pb && (pb.tmdbId || pb.franchiseTmdbId) && ms.mediaItem) {
        ms.mediaItem = {
          ...ms.mediaItem,
          ...tmdbRouteFields(ms.mediaItem, pb)
        };
      }
      ms.episodeCache.set(sNum, ms.episodes);
      ms.view = 'season';
    } else {
      const [detail, pb] = await Promise.all([
        app.movieApi.getMovie(item.id).catch(() => null),
        app.movieApi.getPlaybackInfo('movie', item.id).catch(() => null)
      ]);
      if (detail) {
        ms.mediaItem = {
          ...item,
          ...detail,
          type: 'movie',
          imdbId: detail.imdbId || item.imdbId || null,
          ...tmdbRouteFields(item, detail),
          downloadUrls: detail.downloadUrls?.length ? detail.downloadUrls : (item.downloadUrls || [])
        };
      }
      ms.playback = pb;
      if (pb && (pb.tmdbId || pb.franchiseTmdbId) && ms.mediaItem) {
        ms.mediaItem = {
          ...ms.mediaItem,
          ...tmdbRouteFields(ms.mediaItem, pb)
        };
      }
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

  async function openHub(ctx, { sourceMode = 'movie', xvSource = null, xvDur = null, xvStudio = null } = {}) {
    await ensureMovieAuth(ctx, null, null);
    const prev = app.movieSessions.getLatestForChat(ctx.chatId);
    const ms = await createSessionForCtx(ctx, {
      view: 'hub',
      sourceMode: sourceMode === 'xvideos' ? 'xvideos' : 'movie',
      ...(xvSource ? { xvSource } : {}),
      ...(xvDur ? { xvDur } : {}),
      ...(xvStudio ? { xvStudio } : {})
    });
    await upsertCard(ctx, ms, renderHub(ctx, ms));
    if (prev && prev.id !== ms.id && prev.messageId !== ms.messageId) {
      await cleanupSupersededCards(ctx, prev, ms.messageId);
    }
    return ms;
  }

  async function executeXvSearch(ctx, ms, { rawUrl = null, apiPage = null, resPage = 0, preserveSelection = false } = {}) {
    if (!isGroupAdultAllowed(ctx, ms)) {
      ms.view = 'hub';
      await upsertCard(ctx, ms, renderAdultGroupLocked(ctx, ms));
      return ms;
    }
    if (isAgeGateRequired(ctx)) {
      ms.view = 'hub';
      await upsertCard(ctx, ms, renderAdultAgeGate(ms));
      return ms;
    }
    if (isBlockedAdultText(ms.xvQuery) || isBlockedAdultText(ms.xvStudio)) {
      await upsertCard(ctx, ms, renderAdultBlockedQuery(ms));
      return ms;
    }
    ms.sourceMode = 'xvideos';
    if (rawUrl) {
      const q = getXvQuality(ms);
      const resolved = await getCatalog().resolveStream(rawUrl, { preferredHeight: xvQualityHeight(q), probeSize: true }).catch(() => null);
      if (!resolved?.streamUrl) throw new MusicError('MOVIE_NOT_FOUND', 'Could not extract an XVideos stream from that URL.');
      const urlId = (String(rawUrl).match(/\/video\.?([a-z0-9]+)/i) || [])[1] || String(Date.now());
      const item = {
        id: urlId,
        title: resolved.fullTitle || resolved.title || 'XVideos Stream',
        artist: resolved.artist || resolved.uploader || 'XVideos',
        durationSeconds: resolved.durationSeconds || 0,
        duration: resolved.durationSeconds ? formatDurationLabel(resolved.durationSeconds) : 'HD',
        thumbUrl: resolved.thumbUrl || null,
        pageUrl: rawUrl,
        sourceKey: 'xvideos',
        variants: resolved.variants || [],
        streamUrl: resolved.streamUrl,
        videoUrl: resolved.streamUrl,
        headers: resolved.headers || { Referer: 'https://www.xvideos.com/' }
      };
      ms.xvResults = [item];
      ms.xvCurrentIdx = 0;
      ms.xvResolved = resolved;
      ms.xvSelected = new Set();
      ms.view = 'xv_detail';
      await upsertCard(ctx, ms, renderXvDetail(ctx, ms));
      return ms;
    }
    const targetApiPage = apiPage != null ? Math.max(0, Number(apiPage) || 0) : Number(ms.xvApiPage || 0);
    const catalog = getCatalog();
    const activeSrc = ms.xvSource || 'xvideos';
    const searchOpts = {
      source: activeSrc,
      query: ms.xvMode === 'trending' ? '' : (ms.xvQuery || ''),
      page: targetApiPage,
      limit: 15,
      sort: ms.xvSort || 'relevance',
      durationFilter: ms.xvDur || 'all',
      category: ms.xvMode === 'category' ? (ms.xvCat || null) : null,
      artist: ms.xvMode === 'artist' ? (ms.xvArtist || null) : null,
      studio: ms.xvStudio || null,
      lazy: true
    };
    const useLegacyXvOnly = activeSrc === 'xvideos' && !ms.xvStudio && ms.xvDur !== 'movie';
    const res = (useLegacyXvOnly || typeof catalog.search !== 'function')
      ? await catalog.searchXvideos(searchOpts)
      : await catalog.search(searchOpts);
    ms.xvApiPage = targetApiPage;
    ms.xvResults = Array.isArray(res?.results) ? res.results : [];
    ms.xvTotalPages = Math.max(1, Number(res?.totalPages || 1));
    const maxLocalPages = Math.max(1, Math.ceil(ms.xvResults.length / 5));
    const safeLocal = Math.min(Number(resPage || 0) % 3, maxLocalPages - 1);
    ms.xvResPage = Math.max(0, targetApiPage * 3 + Math.max(0, safeLocal));
    if (!preserveSelection) ms.xvSelected = new Set();
    ms.view = 'xv_results';
    ms.notice = null;
    ms.logLines = null;
    await upsertCard(ctx, ms, renderXvResults(ctx, ms));
    return ms;
  }

  async function loadXvDetailIntoSession(ms, idx) {
    const item = ms.xvResults?.[idx];
    if (!item) throw new MusicError('STALE_PLAYER', 'That XVideos title is no longer in the result list.');
    ms.xvCurrentIdx = idx;
    ms.xvResolved = null;
    ms.notice = null;
    ms.logLines = null;
    const q = getXvQuality(ms);
    const resolved = await getCatalog().resolveStream(item, {
      preferredHeight: xvQualityHeight(q),
      probeSize: true
    }).catch(() => null);
    if (resolved) ms.xvResolved = resolved;
    ms.view = 'xv_detail';
    return item;
  }

  async function promptSearchInput(resolvedCtx, ms, isXv = false, { promptKind = null } = {}) {
    const isChan = isChannelCtx(resolvedCtx);
    const group = Number(resolvedCtx.chatId) < 0 && !isChan;
    const stateKey = (isChan && Number(resolvedCtx.chatId) < 0) ? String(resolvedCtx.chatId) : resolvedCtx.tgId;
    if (resolvedCtx.query?.id && resolvedCtx.api?.answerCallbackQuery) {
      await resolvedCtx.api.answerCallbackQuery(resolvedCtx.query.id, {
        text: promptKind === 'xv_artist'
          ? '⭐ Send a pornstar or artist name.'
          : (promptKind === 'xv_studio'
            ? '🏢 Send an 18+ studio name.'
            : (isXv ? '🔍 Send an 18+ movie, star, parody, or URL.' : '🔍 Send the movie or TV show title.'))
      }).catch(() => {});
    }
    const prefix = group ? 'Reply to this message with' : 'Send';
    const promptText = promptKind === 'xv_artist'
      ? `${prefix} a pornstar / artist name (e.g. "Jesse Jane", "Kira Noir", "Kayley Gunner"). /cancel closes search.`
      : (promptKind === 'xv_studio'
        ? `${prefix} an 18+ studio name (e.g. "Digital Playground", "Wicked", "Adult Time", "Lust Cinema"). /cancel closes search.`
        : (isXv
          ? `${prefix} an 18+ movie title, pornstar name, parody, or video URL. /cancel closes search.`
          : `${prefix} a movie or TV series title (e.g. "Breaking Bad", "John Wick 4", "Inception"). /cancel closes search.`));
    let sent = null;
    if (isChan && typeof resolvedCtx.api?.sendRichMessage === 'function') {
      const promptCard = card(isXv ? '🔍 18+ Studio · Search' : '🔍 Lancy Cinema · Search', isXv ? 'Post a movie, star, or link in this channel' : 'Post the movie or TV series title in this channel')
        .paragraph(rt.text(promptText))
        .buttons([[richButton.callback('✕ Cancel Search', encodeCallback('nav', 'cancelprompt'), { style: 'danger' })]]);
      sent = await sendOrEditMenu(resolvedCtx, finish(promptCard), { ttlMs: 120000 }).catch(() => null);
    } else {
      sent = await resolvedCtx.api.sendMessage(resolvedCtx.chatId, promptText, {
        ...(group || Number(resolvedCtx.chatId) > 0 ? { reply_markup: { force_reply: true, selective: true } } : {}),
        ...((ms.messageId || resolvedCtx.messageId) && group ? { reply_to_message_id: ms.messageId || resolvedCtx.messageId } : {})
      });
    }
    if (sent?.message_id) {
      ms.promptMessageId = sent.message_id;
      app.movieSessions.touch?.(ms);
    }
    const temporaryToken = temporary.remember(resolvedCtx, sent, { ttlMs: 120000 });
    await app.sm.transition(stateKey, States.MUSIC_QUEUE_INPUT, {
      chatId: resolvedCtx.chatId,
      timeoutMs: 120000,
      context: {
        stateKey,
        mode: 'movie_search',
        sourceMode: isXv ? 'xvideos' : 'movie',
        promptKind: promptKind || null,
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

  async function openMovieSearch(ctx, query, { random = false, movieSid = null, sourceMode = null, xvSource = null, xvDur = null, promptKind = null, originMessageId = null, forceNewCard = false } = {}) {
    await ensureMovieAuth(ctx, null, null);
    const prev = app.movieSessions.getLatestForChat(ctx.chatId);
    const existing = movieSid ? app.movieSessions.get(movieSid) : null;
    const reuseExisting = Boolean(existing && Number(existing.chatId) === Number(ctx.chatId));
    const q = String(query || '').trim();
    const isXvUrl = /^https?:\/\/(?:www\.)?(?:xvideos|pornhub|eporner|xhamster|porntrex|fullxcinema|pandamovies)\./i.test(q);
    const effSource = sourceMode || (reuseExisting ? existing.sourceMode : null) || (isXvUrl ? 'xvideos' : 'movie');
    const resolvedOriginMsgId = originMessageId ?? ctx?.directMessageId ?? ctx?.message?.message_id ?? null;
    const ms = reuseExisting
      ? existing
      : await createSessionForCtx(ctx, {
        sourceMode: effSource === 'xvideos' ? 'xvideos' : 'movie',
        originMessageId: resolvedOriginMsgId,
        replyToMessageId: resolvedOriginMsgId,
        receiverUserId: Number(ctx.tgId) || null,
        ...(xvSource ? { xvSource } : {}),
        ...(xvDur ? { xvDur } : {})
      });
    if (resolvedOriginMsgId) {
      ms.originMessageId = resolvedOriginMsgId;
      ms.replyToMessageId = resolvedOriginMsgId;
    }
    if (forceNewCard || resolvedOriginMsgId) {
      ms._pendingReplyToId = resolvedOriginMsgId || ms.replyToMessageId || null;
      if (!ctx?.reuseMessageId) ms.messageId = null;
    }
    if (effSource === 'xvideos') ms.sourceMode = 'xvideos';
    if (xvSource) ms.xvSource = xvSource;
    if (xvDur) ms.xvDur = xvDur;

    if (random) {
      const pick = await app.movieApi.pickRandom({});
      if (!pick) throw new MusicError('MOVIE_NOT_FOUND', 'No random movie was available right now. Try searching by title.');
      ms.results = [pick];
      await loadItemIntoSession(ms, pick);
      await upsertCard(ctx, ms, renderCurrentView(ctx, ms));
      if (!reuseExisting && prev && prev.id !== ms.id && prev.messageId !== ms.messageId) {
        await cleanupSupersededCards(ctx, prev, ms.messageId);
      }
      return ms;
    }
    if (!q) return reuseExisting ? (ms.view = 'hub', await upsertCard(ctx, ms, renderHub(ctx, ms)), ms) : openHub(ctx, { sourceMode: effSource, xvSource, xvDur });

    if (promptKind === 'xv_artist' && q) {
      const artRes = await getCatalog().getArtists({ query: q, page: 0, perPage: 12 });
      ms.sourceMode = 'xvideos';
      ms.xvArtists = Array.isArray(artRes?.items) ? artRes.items : [];
      ms.xvArtistPage = 0;
      ms.xvArtistsTotalPages = artRes?.totalPages || 1;
      if (ms.xvArtists.length === 1) {
        const star = ms.xvArtists[0];
        ms.xvMode = 'artist';
        ms.xvArtist = (star.xvType && star.xvSlug && (ms.xvSource || 'xvideos') === 'xvideos')
          ? `${star.xvType}/${star.xvSlug}`
          : star.name;
        ms.xvQuery = '';
        ms.xvCat = '';
        ms.xvStudio = '';
        ms.xvApiPage = 0;
        if (!ms.xvSource || ms.xvSource === 'xvideos') ms.xvSource = 'all';
        await executeXvSearch(ctx, ms, { apiPage: 0, resPage: 0 });
      } else {
        ms.view = 'xv_artists';
        await upsertCard(ctx, ms, renderXvArtists(ctx, ms));
      }
      return ms;
    }

    if (promptKind === 'xv_studio' && q) {
      const stRes = typeof getCatalog().getStudios === 'function'
        ? await getCatalog().getStudios({ query: q, page: 0, perPage: 12 })
        : { items: FEATURED_STUDIOS.filter((s) => s.name.toLowerCase().includes(q.toLowerCase())), totalPages: 1 };
      ms.sourceMode = 'xvideos';
      ms.xvStudios = Array.isArray(stRes?.items) ? stRes.items : [];
      ms.xvStudioPage = 0;
      ms.xvStudiosTotalPages = stRes?.totalPages || 1;
      if (ms.xvStudios.length === 1) {
        ms.xvMode = 'studio';
        ms.xvStudio = ms.xvStudios[0].name;
        ms.xvSource = 'adult_movies';
        ms.xvQuery = '';
        ms.xvCat = '';
        ms.xvArtist = '';
        ms.xvApiPage = 0;
        await executeXvSearch(ctx, ms, { apiPage: 0, resPage: 0 });
      } else {
        ms.view = 'xv_studios';
        await upsertCard(ctx, ms, renderXvStudios(ctx, ms));
      }
      return ms;
    }

    if (effSource === 'xvideos') {
      ms.xvQuery = isXvUrl ? '' : q;
      ms.xvMode = 'search';
      ms.xvCat = '';
      ms.xvArtist = '';
      ms.xvStudio = '';
      ms.xvApiPage = 0;
      await executeXvSearch(ctx, ms, { rawUrl: isXvUrl ? q : null, resPage: 0 });
      if (!reuseExisting && prev && prev.id !== ms.id && prev.messageId !== ms.messageId) {
        await cleanupSupersededCards(ctx, prev, ms.messageId);
      }
      return ms;
    }

    const adultAllowed = isGroupAdultAllowed(ctx, ms);
    const catalog = getCatalog();
    const canSearchAdult = Boolean(adultAllowed && !isAgeGateRequired(ctx) && catalog && typeof catalog.search === 'function');
    const [res, xvUnifiedRes] = await Promise.all([
      app.movieApi.search(q, {
        limit: 18,
        includeAdultFallback: adultAllowed
      }).catch(() => ({ results: [] })),
      canSearchAdult
        ? catalog.search({ source: 'all', query: q, page: 0, limit: 8, durationFilter: 'movie', minMinutes: 15, lazy: true }).catch(() => ({ results: [] }))
        : Promise.resolve({ results: [] })
    ]);
    ms.query = q;
    ms.sourceMode = 'movie';
    ms.mediaItem = null;
    ms.playback = null;
    ms.seasons = [];
    ms.episodes = [];
    ms.epPage = 0;
    ms.seasonPage = 0;
    ms.seasonNumber = 1;
    ms.seasonName = 'Season 1';
    ms.episodeCache?.clear?.();
    ms.selectedBySeason?.clear?.();
    ms.dlManifest = null;
    ms.dlPage = 0;
    ms.results = mergeUnifiedSearchResults(q, res?.results || [], xvUnifiedRes?.results || [], { limit: 20 });
    ms.resultPage = 0;
    ms.view = 'results';
    ms.notice = null;
    ms.logLines = null;
    await upsertCard(ctx, ms, renderResults(ctx, ms), {
      forceNewCard: Boolean((forceNewCard || resolvedOriginMsgId) && !ctx?.reuseMessageId),
      replyToMessageId: resolvedOriginMsgId
    });
    if (!reuseExisting && prev && prev.id !== ms.id && prev.messageId !== ms.messageId) {
      await cleanupSupersededCards(ctx, prev, ms.messageId);
    }
    return ms;
  }

  async function startAiChat(ctx, initialText = '', { defaultDomain = 'auto' } = {}) {
    await ensureMovieAuth(ctx, null, null);
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
    const chanMode = isChannelCtx(resolvedCtx);
    const sendAiNotice = async (textToSend, extra = {}) => {
      if (!textToSend) return null;
      if (chanMode) {
        const aiCard = card('✨ Lancy AI', 'Channel Companion')
          .paragraph(rt.text(textToSend))
          .buttons([[
            richButton.callback('🎬 Movies', encodeCallback('music', 'moviehub'), { style: 'primary' }),
            richButton.callback('🗑️ Close', encodeCallback('music', 'cancelprompt'), { style: 'danger' })
          ]]);
        return await sendOrEditMenu(resolvedCtx, finish(aiCard), { ttlMs: 120000 }).catch(() => null);
      }
      return await ctx.api.sendMessage(ctx.chatId, textToSend, extra).catch(() => null);
    };
    if (act?.name === 'search_movie' && act.query) {
      if (res.reply && !chanMode) await sendAiNotice(res.reply);
      await openMovieSearch(resolvedCtx, act.query);
      return res;
    }
    if (act?.name === 'random_movie') {
      if (res.reply && !chanMode) await sendAiNotice(res.reply);
      await openMovieSearch(resolvedCtx, '', { random: true });
      return res;
    }
    if (act?.name === 'trending_movies') {
      if (res.reply && !chanMode) await sendAiNotice(res.reply);
      const ms = await createSessionForCtx(resolvedCtx);
      const tRes = await app.movieApi.trending({ page: 1 });
      ms.results = tRes?.results || [];
      ms.resultPage = 0;
      ms.view = 'results';
      await upsertCard(resolvedCtx, ms, renderResults(resolvedCtx, ms));
      return res;
    }
    if (act?.name === 'search_song' && act.query) {
      if (res.reply && !chanMode) await sendAiNotice(res.reply);
      const djRes = await app.music.chatDjCommand(resolvedCtx, `play ${act.query}`);
      if (chanMode) await adoptChannelPlayerResult(resolvedCtx, djRes?.session);
      return res;
    }
    if (act?.name === 'vc_control') {
      const djRes = await app.music.chatDjCommand(resolvedCtx, text);
      if (chanMode) await adoptChannelPlayerResult(resolvedCtx, djRes?.session);
      if (djRes?.reply) await sendAiNotice(djRes.reply);
      return res;
    }
    if (res.reply) {
      await sendAiNotice(res.reply, {
        ...(!chanMode && ctx.message?.message_id ? { reply_to_message_id: ctx.message.message_id } : {})
      });
    }
    return res;
  }

  async function streamResolvedItems(ctx, ms, descriptors, { playNow = false } = {}) {
    const dest = ms.destination || app.music.destination(ctx);
    const panel = ms.panelToken ? await app.music.channelPanels.resolve(ctx, ms.panelToken, { requireMessage: false }).catch(() => null) : ctx.musicPanel;
    const targetCtx = panel ? { ...ctx, musicPanel: panel } : ctx;
    await app.music.authorize(targetCtx, true, dest, { allowDj: !isChannelCtx(targetCtx) });
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
    let activeFlushPromise = null;
    let flushQueued = false;
    const labelItem = first.episode
      ? `S${String(first.season).padStart(2, '0')}E${String(first.episode).padStart(2, '0')}`
      : cut(first.title, 36);
    const flushLog = async () => {
      flushQueued = true;
      if (activeFlushPromise) return activeFlushPromise;
      activeFlushPromise = (async () => {
        try {
          while (flushQueued) {
            flushQueued = false;
            ms.notice = ms.logLines[ms.logLines.length - 1] || `⏳ Loading ${labelItem}…`;
            await upsertCard(targetCtx, ms, renderCurrentView(targetCtx, ms)).catch(() => {});
            lastLogFlush = Date.now();
          }
        } finally {
          activeFlushPromise = null;
        }
      })();
      return activeFlushPromise;
    };
    const pushLog = (msg, { force = false } = {}) => {
      const clean = String(msg || '').trim();
      if (!clean) return Promise.resolve();
      const stamp = new Date().toISOString().slice(11, 19);
      const entry = `[${stamp}] ${clean}`;
      const prevBody = String(ms.logLines[ms.logLines.length - 1] || '').replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, '');
      if (prevBody !== clean) {
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

      const allowAdultFeatures = isGroupAdultAllowed(targetCtx, ms);
      const resolvedFirst = await app.movieResolver.resolve(first, {
        allowAdultFeatures,
        onProgress: (line) => { void pushLog(line); }
      });
      if (!resolvedFirst?.ok || !resolvedFirst.track) {
        if (pendingLogTimer) { clearTimeout(pendingLogTimer); pendingLogTimer = null; }
        const lastEntry = String(ms.logLines[ms.logLines.length - 1] || '');
        if (/\]\s*❌\s/.test(lastEntry)) {
          await flushLog();
        } else {
          await pushLog(`❌ ${resolvedFirst?.reason || 'No playable full-length web stream found.'}`, { force: true });
        }
        return;
      }

      const subTag = (resolvedFirst.subtitles?.filePath || resolvedFirst.subtitles?.found) ? ' · 💬 Subtitles ready' : '';
      const audioTag = resolvedFirst.track?.dubOnlyWarning
        ? ' · ⚠️ Dub only available'
        : (resolvedFirst.track?.audioLanguage ? ` · 🔊 ${String(resolvedFirst.track.audioLanguage).toUpperCase()} Original` : '');
      const srcCount = 1 + (Array.isArray(resolvedFirst.fallbackStreams) ? resolvedFirst.fallbackStreams.length : 0);
      const srcTag = srcCount > 1 ? ` · 📡 Source 1/${srcCount}` : '';
      await pushLog(`✅ Stream ready (${cut(resolvedFirst.track.artist || 'HD Feature', 36)})${audioTag}${subTag}${srcTag}`, { force: true });
      await pushLog('🎙️ Preparing Voice Chat Cinema deck…', { force: true });

      const requesterName = targetCtx.user?.first_name || targetCtx.user?.username || 'Member';
      const enrichTrack = (tr, desc) => ({
        ...tr,
        requester: tr.requester || requesterName,
        mediaKind: tr.mediaKind ?? (desc?.type === 'tv' ? 'tv' : 'movie'),
        ...tmdbRouteFields(desc, tr),
        imdbId: tr.imdbId ?? desc?.imdbId ?? null,
        activeSourceIndex: Number.isInteger(tr.activeSourceIndex) ? tr.activeSourceIndex : 0,
        sourceCount: Number(tr.sourceCount || (1 + (Array.isArray(tr.fallbackStreams) ? tr.fallbackStreams.length : 0))),
        year: tr.year ?? desc?.year ?? null,
        rating: tr.rating ?? desc?.rating ?? null,
        genres: tr.genres ?? desc?.genres ?? null,
        overview: tr.overview ?? desc?.overview ?? null,
        originalTitle: tr.originalTitle ?? desc?.originalTitle ?? null,
        originalLanguage: tr.originalLanguage ?? desc?.originalLanguage ?? null,
        preferredAudioLang: tr.preferredAudioLang ?? desc?.originalLanguage ?? null,
        audioLanguage: tr.audioLanguage || null,
        audioIsDub: Boolean(tr.audioIsDub),
        dubOnlyWarning: tr.dubOnlyWarning || ((tr.dubOnly || tr.audioIsDub) ? '⚠️ Dub Only Available' : null),
        subtitlesLabel: tr.subtitlesLabel || null,
        ...(desc?.type === 'tv'
          ? {
              seriesId: tr.seriesId ?? desc.seriesId ?? desc.id ?? null,
              season: tr.season ?? tr.seasonNumber ?? desc.season ?? null,
              seasonNumber: tr.seasonNumber ?? tr.season ?? desc.season ?? null,
              episode: tr.episode ?? tr.episodeNumber ?? desc.episode ?? null,
              episodeNumber: tr.episodeNumber ?? tr.episode ?? desc.episode ?? null,
              episodeTitle: tr.episodeTitle ?? desc.episodeTitle ?? null
            }
          : {})
      });

      const preSess = qm.getSession(dest);
      if (playNow || !['playing', 'paused', 'buffering'].includes(preSess.status)) {
        preSess.activeDeck = 'movie';
        preSess.streamMode = qm.getDeckStreamMode?.(dest, 'movie') || 'rtmp';
      }
      await app.music.prepare(targetCtx, dest);
      if ((qm.getSession(dest).stopGeneration || 0) !== generation) {
        throw new MusicError('ACTION_CANCELLED', 'Playback stopped before stream started.');
      }

      const firstTrack = enrichTrack(resolvedFirst.track, first);
      await qm.addMovies(dest, [firstTrack], { playNow });

      const remaining = descriptors.slice(1);
      const updatedSession = qm.getSession(dest);
      const switchedToCinema = updatedSession.activeDeck === 'movie';
      if (switchedToCinema) {
        if (panel) {
          panel.overlayView = null;
          panel.overlayAt = 0;
          panel.lastRender = null;
        }
        await presentQueuedCinema(targetCtx, ms, {
          dest,
          panel,
          qm,
          firstTitle: resolvedFirst.track.title,
          subTag,
          remainingCount: remaining.length,
          pushLog
        });
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
            const r = await app.movieResolver.resolve(desc, { allowAdultFeatures }).catch(() => null);
            if ((qm.getSession(dest).stopGeneration || 0) !== generation) break;
            if (r?.ok && r.track) {
              try {
                qm.enqueueMovie(dest, enrichTrack(r.track, desc));
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

  async function presentQueuedCinema(targetCtx, ms, { dest, panel, qm, firstTitle, subTag = '', remainingCount = 0, pushLog = null }) {
    const updatedSession = qm.getSession(dest);
    if (panel) {
      panel.overlayView = null;
      panel.overlayAt = 0;
      panel.lastRender = null;
    }
    if (pushLog) {
      await pushLog(
        `🎬 Streaming ${cut(firstTitle, 40)}${subTag}${remainingCount ? ` · Queuing ${remainingCount} more…` : ''}`,
        { force: true }
      );
    }
    const searchCardId = ms.messageId;
    const hasLivePlayerInChat = Boolean(
      (updatedSession.screenMessageId && Number(updatedSession.playerChatId || targetCtx.chatId) === Number(targetCtx.chatId) && !updatedSession.callEnded && ['playing', 'paused', 'buffering'].includes(updatedSession.status)) ||
      (panel?.screenMessageId && Number(panel?.chatId || targetCtx.chatId) === Number(targetCtx.chatId))
    );
    const canMorphSearchCard = Boolean(
      searchCardId &&
      !hasLivePlayerInChat &&
      Number(targetCtx.chatId) === Number(ms.chatId) &&
      searchCardId !== updatedSession.screenMessageId &&
      !isChannelCtx(targetCtx)
    );
    const p = await app.music.player({
      ...targetCtx,
      ...(canMorphSearchCard ? { reuseMessageId: searchCardId } : {}),
      forceNew: canMorphSearchCard || !hasLivePlayerInChat
    }, dest).catch((err) => {
      app.logger?.warn?.('presentQueuedCinema failed', err?.message || err);
      return null;
    });
    if (isChannelCtx(targetCtx)) await adoptChannelPlayerResult(targetCtx, p);
    const activePlayerMsgId = updatedSession.screenMessageId || panel?.screenMessageId || p?.screenMessageId;
    if (activePlayerMsgId && ms.messageId === activePlayerMsgId) {
      ms.messageId = null;
    }
    if (Array.isArray(ms.activeCardIds) && activePlayerMsgId) {
      ms.activeCardIds = ms.activeCardIds.filter((cid) => Number(cid) !== Number(activePlayerMsgId));
    }
    if (searchCardId && activePlayerMsgId && searchCardId !== activePlayerMsgId) {
      await cleanupSupersededCards(targetCtx, ms, activePlayerMsgId);
    }
  }

  async function streamXvItems(ctx, ms, rawItems, { playNow = true } = {}) {
    if (!isGroupAdultAllowed(ctx, ms)) {
      ms.view = 'hub';
      await upsertCard(ctx, ms, renderAdultGroupLocked(ctx, ms));
      return;
    }
    if (isAgeGateRequired(ctx)) {
      ms.view = 'hub';
      await upsertCard(ctx, ms, renderAdultAgeGate(ms));
      return;
    }
    if (!Array.isArray(rawItems) || !rawItems.length) {
      if (ctx.query?.id) await ctx.api?.answerCallbackQuery?.(ctx.query.id, { text: 'Check at least one video first.' }).catch(() => {});
      return;
    }
    const dest = ms.destination || app.music.destination(ctx);
    const panel = ms.panelToken ? await app.music.channelPanels?.resolve?.(ctx, ms.panelToken, { requireMessage: false }).catch(() => null) : ctx.musicPanel;
    const targetCtx = panel ? { ...ctx, musicPanel: panel } : ctx;
    await app.music.authorize(targetCtx, true, dest, { allowDj: !isChannelCtx(targetCtx) });
    const qm = app.musicQueueManager;
    const session = qm.getSession(dest);
    const generation = session.stopGeneration || 0;
    const q = getXvQuality(ms);
    const requesterName = targetCtx.user?.first_name || targetCtx.user?.username || 'Member';

    const first = rawItems[0];
    if (ctx.query?.id) {
      await ctx.api?.answerCallbackQuery?.(ctx.query.id, { text: `⏳ Resolving XVideos (${q}) for ${cut(first.title, 26)}…` }).catch(() => {});
    }
    ms.logLines = [`🔎 Resolving XVideos stream (${q}) for ${cut(first.title, 34)}…`];
    ms.notice = ms.logLines[0];
    await upsertCard(targetCtx, ms, renderCurrentView(targetCtx, ms)).catch(() => {});

    const curDetailItem = (ms.xvResults || [])[Number(ms.xvCurrentIdx || 0)];
    const resolvedFirst = await getCatalog().resolveStream(first, { preferredHeight: xvQualityHeight(q), probeSize: false }).catch(() => null);
    const firstTrack = buildXvTrack(first, resolvedFirst || (curDetailItem === first ? ms.xvResolved : null), q);
    firstTrack.requester = requesterName;
    if (!firstTrack.streamUrl && !firstTrack.pageUrl) {
      throw new MusicError('NO_SOURCE', 'Could not extract a playable XVideos stream URL.');
    }

    const preSess = qm.getSession(dest);
    if (playNow || !['playing', 'paused', 'buffering'].includes(preSess.status)) {
      preSess.activeDeck = 'movie';
      preSess.streamMode = qm.getDeckStreamMode?.(dest, 'movie') || 'rtmp';
    }
    await app.music.prepare(targetCtx, dest);
    if ((qm.getSession(dest).stopGeneration || 0) !== generation) {
      throw new MusicError('ACTION_CANCELLED', 'Playback stopped before stream started.');
    }

    await qm.addMovies(dest, [firstTrack], { playNow });
    const remaining = rawItems.slice(1);
    const updatedSession = qm.getSession(dest);
    if (updatedSession.activeDeck === 'movie') {
      await presentQueuedCinema(targetCtx, ms, {
        dest,
        panel,
        qm,
        firstTitle: firstTrack.title,
        remainingCount: remaining.length
      });
    } else {
      ms.notice = `🎞 Added ${cut(firstTrack.title, 36)} to Cinema Queue (${updatedSession.movieUpcoming?.length || 1} queued) · Music stays live.`;
      await upsertCard(targetCtx, ms, renderCurrentView(targetCtx, ms)).catch(() => {});
    }

    if (remaining.length) {
      void (async () => {
        for (const it of remaining) {
          if ((qm.getSession(dest).stopGeneration || 0) !== generation) break;
          const r = await getCatalog().resolveStream(it, { preferredHeight: xvQualityHeight(q), probeSize: false }).catch(() => null);
          if ((qm.getSession(dest).stopGeneration || 0) !== generation) break;
          const tr = buildXvTrack(it, r, q);
          tr.requester = requesterName;
          if (tr.streamUrl || tr.pageUrl) {
            try {
              qm.enqueueMovie(dest, tr);
            } catch {
              break;
            }
          }
        }
        await qm.updatePlayerCard(dest).catch(() => {});
      })();
    }
  }

  async function handleCallback(ctx, args = []) {
    const [sidRaw, op, arg = ''] = args;
    if (isChannelCtx(ctx) && Number(ctx.chatId) < 0 && !ctx.channelAdminVerified) {
      await ensureMovieAuth(ctx, Number(ctx.chatId), null);
    }
    if (sidRaw === 'new') {
      return await openHub(ctx, { sourceMode: op === 'xv' ? 'xvideos' : 'movie' });
    }
    let ms = app.movieSessions.get(sidRaw)
      || (ctx.messageId ? app.movieSessions.getByMessage(ctx.chatId, ctx.messageId) : null)
      || app.movieSessions.getLatestForChat(ctx.chatId);
    if (!ms) {
      await ensureMovieAuth(ctx, null, null);
      if (ctx.messageId) await ctx.api?.deleteMessage?.(ctx.chatId, ctx.messageId).catch(() => {});
      return await openHub({ ...ctx, query: null, messageId: null });
    }
    app.movieSessions.touch(ms);
    let resolvedCtx = ctx;
    if (ms.panelToken) {
      const panel = await app.music.channelPanels?.resolve?.(ctx, ms.panelToken, { requireMessage: false }).catch(() => null);
      if (panel) {
        resolvedCtx = { ...ctx, musicPanel: panel };
        touchPanelOverlay(resolvedCtx, ms, 'movie');
      }
    }
    await ensureMovieAuth(resolvedCtx, ms.destination || null, ms);

    if (op === 'hb') {
      ms.view = 'hub';
      ms.notice = null;
      await upsertCard(resolvedCtx, ms, renderHub(resolvedCtx, ms));
      return true;
    }

    if (op === 'ps' || op === 'xs') {
      const isXv = op === 'xs' || ms.sourceMode === 'xvideos';
      if (isXv) {
        if (!isGroupAdultAllowed(resolvedCtx, ms)) {
          ms.view = 'hub';
          await upsertCard(resolvedCtx, ms, renderAdultGroupLocked(resolvedCtx, ms));
          return true;
        }
        if (isAgeGateRequired(resolvedCtx)) {
          ms.view = 'hub';
          await upsertCard(resolvedCtx, ms, renderAdultAgeGate(ms));
          return true;
        }
        ms.sourceMode = 'xvideos';
      }
      return await promptSearchInput(resolvedCtx, ms, isXv);
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
      const res = await app.movieApi.trending({ page: 1, forceRefresh: true });
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
      const sNum = arg !== '' && arg != null ? Number(arg) : Number(ms.seasonNumber ?? 1);
      if (sNum !== Number(ms.seasonNumber)) {
        ms.seasonNumber = sNum;
        ms.seasonName = (ms.seasons || []).find((s) => Number(s.seasonNumber) === sNum)?.name || (sNum === 0 ? 'Specials' : `Season ${sNum}`);
      }
      const selected = app.movieSessions.selectAllInSeason(ms);
      const count = ms.selectedBySeason.get(ms.seasonNumber)?.size || 0;
      const sLabel = ms.seasonNumber === 0 ? 'Specials' : `Season ${ms.seasonNumber}`;
      if (ctx.query?.id && ctx.api?.answerCallbackQuery) {
        await ctx.api.answerCallbackQuery(ctx.query.id, { text: selected ? `✅ Selected all ${count} episodes of ${sLabel}` : `☐ Cleared ${sLabel}` }).catch(() => {});
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
      const sNum = arg !== '' && arg != null ? Number(arg) : Number(ms.seasonNumber ?? 1);
      if (ctx.query?.id && ctx.api?.answerCallbackQuery) {
        await ctx.api.answerCallbackQuery(ctx.query.id, { text: `Loading ${sNum === 0 ? 'Specials' : `Season ${sNum}`}…` }).catch(() => {});
      }
      ms.seasonNumber = sNum;
      ms.seasonName = (ms.seasons || []).find((s) => Number(s.seasonNumber) === sNum)?.name || (sNum === 0 ? 'Specials' : `Season ${sNum}`);
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
        ...tmdbRouteFields(item, ms.playback),
        title: item.title,
        originalTitle: item.originalTitle || null,
        originalLanguage: item.originalLanguage || item.language || ms.playback?.originalLanguage || null,
        year: item.year,
        releaseDate: item.releaseDate || null,
        runtime: item.runtimeMinutes || item.runtime,
        durationSeconds: item.runtimeSeconds || (item.runtimeMinutes ? Number(item.runtimeMinutes) * 60 : null) || null,
        artwork: item.poster || item.backdrop,
        imdbId: item.imdbId || null,
        rating: item.rating || null,
        genres: Array.isArray(item.genres) ? item.genres : null,
        overview: item.overview || null,
        isAdultHint: Boolean(item.isAdultHint || item.adult),
        downloadUrls: Array.isArray(item.downloadUrls) ? item.downloadUrls : [],
        webappUrl: ms.playback?.webappPlayerUrl || item.playUrl,
        playback: ms.playback || null
      }];
      await streamResolvedItems(resolvedCtx, ms, desc, { playNow: op === 'pm' });
      return true;
    }

    if (op === 'pmi' || op === 'qmi') {
      const idx = Number(arg);
      const item = ms.results?.[idx];
      if (!item) throw new MusicError('STALE_PLAYER', 'That title is no longer in this result list.');
      if (item.isAdultCatalogItem && item.xvItem) {
        await streamXvItems(resolvedCtx, ms, [item.xvItem], { playNow: op === 'pmi' });
        return true;
      }
      const isTv = item.type === 'tv';
      let epMeta = null;
      if (isTv) {
        const epsRes = await app.movieApi.getTvSeasonEpisodes(item.id, 1).catch(() => null);
        epMeta = epsRes?.episodes?.[0] || null;
      }
      const desc = [{
        type: isTv ? 'tv' : 'movie',
        id: item.id,
        ...tmdbRouteFields(item),
        title: item.title,
        originalTitle: item.originalTitle || null,
        originalLanguage: item.originalLanguage || item.language || null,
        year: item.year,
        releaseDate: item.releaseDate || null,
        ...(isTv ? { season: 1, episode: Number(epMeta?.episodeNumber || 1), episodeTitle: epMeta?.title || 'Episode 1' } : {}),
        runtime: epMeta?.runtimeMinutes || item.runtimeMinutes || item.runtime || null,
        durationSeconds: epMeta?.runtimeSeconds || item.runtimeSeconds || (item.runtimeMinutes ? Number(item.runtimeMinutes) * 60 : null) || null,
        artwork: epMeta?.still || item.poster || item.backdrop || null,
        imdbId: item.imdbId || null,
        rating: item.rating || null,
        genres: Array.isArray(item.genres) ? item.genres : null,
        overview: epMeta?.overview || item.overview || null,
        isAdultHint: Boolean(item.isAdultHint || item.adult),
        downloadUrls: Array.isArray(item.downloadUrls) ? item.downloadUrls : []
      }];
      await streamResolvedItems(resolvedCtx, ms, desc, { playNow: op === 'pmi' });
      return true;
    }

    if (op === 'ql') {
      const nextQ = normalizeDownloadQuality(arg || '480p');
      ms.dlQuality = nextQ;
      const uid = Number(resolvedCtx.tgId || ms.userId || 0);
      if (uid > 0) app.db?.setUserSetting?.(uid, 'movie.downloadQuality', nextQ);
      if (ctx.query?.id && ctx.api?.answerCallbackQuery) {
        await ctx.api.answerCallbackQuery(ctx.query.id, {
          text: `📦 Download quality set to ${DOWNLOAD_QUALITY_PROFILES[nextQ].label}`
        }).catch(() => {});
      }
      await upsertCard(resolvedCtx, ms, renderCurrentView(resolvedCtx, ms));
      return true;
    }

    const runSingleDownloadWithProgress = async (desc, { heading, subtitle, initialLine, renderOnDone, spoiler = false }) => {
      const dlQuality = getUserDownloadQuality(resolvedCtx, ms);
      const useTracker = !app.movieDownloader.hasCachedVideo?.(desc, dlQuality) && typeof resolvedCtx.api?.sendRichMessage === 'function';
      const tracker = useTracker
        ? new ProgressTracker({ api: resolvedCtx.api, chatId: resolvedCtx.chatId, heartbeatMs: 2000, action: 'upload_video' })
        : null;
      if (tracker) {
        await tracker.live(
          (state, { elapsedMs }) => buildDownloadProgressCard(heading, subtitle, state, elapsedMs),
          { statusLine: initialLine }
        ).catch(() => {});
      }
      try {
        return await app.movieDownloader.sendSingleVideo(resolvedCtx, desc, {
          quality: dlQuality,
          spoiler: Boolean(spoiler),
          allowAdultFeatures: isGroupAdultAllowed(resolvedCtx, ms),
          onProgress: (line) => {
            ms.logLines = [...(ms.logLines || []).slice(-7), line];
            ms.notice = line;
            tracker?.set({ statusLine: line });
          }
        });
      } finally {
        await tracker?.cleanup?.().catch(() => {});
        if (renderOnDone) renderOnDone();
      }
    };

    if (op === 'dm') {
      const item = ms.mediaItem;
      if (!item) throw new MusicError('STALE_PLAYER', 'Choose a movie first.');
      if (!app.movieDownloader) throw new MusicError('UNAVAILABLE', 'Movie downloader is unavailable.');
      const desc = {
        type: 'movie',
        id: item.id,
        ...tmdbRouteFields(item, ms.playback),
        title: item.title,
        originalTitle: item.originalTitle || null,
        originalLanguage: item.originalLanguage || item.language || ms.playback?.originalLanguage || null,
        year: item.year,
        releaseDate: item.releaseDate || null,
        runtime: item.runtimeMinutes || item.runtime,
        durationSeconds: item.runtimeSeconds || (item.runtimeMinutes ? Number(item.runtimeMinutes) * 60 : null) || null,
        artwork: item.poster || item.backdrop,
        imdbId: item.imdbId || null,
        isAdultHint: Boolean(item.isAdultHint || item.adult),
        downloadUrls: Array.isArray(item.downloadUrls) ? item.downloadUrls : []
      };
      if (ctx.query?.id && ctx.api?.answerCallbackQuery) {
        await ctx.api.answerCallbackQuery(ctx.query.id, { text: `⬇️ Preparing download: ${cut(item.title, 36)}…` }).catch(() => {});
      }
      ms.logLines = [`⬇️ Starting download for ${cut(item.title, 40)}…`];
      await upsertCard(resolvedCtx, ms, renderCurrentView(resolvedCtx, ms));
      const res = await runSingleDownloadWithProgress(desc, {
        heading: `⬇️ ${cut(item.title, 44)}`,
        subtitle: `${item.year || ''} · Direct HD MP4 Download`,
        initialLine: `⬇️ Preparing ${cut(item.title, 38)} for Telegram…`
      });
      ms.notice = res?.ok ? `✅ Sent "${cut(item.title, 36)}" to chat!` : `⚠️ ${res?.reason || 'Download unavailable'}`;
      await upsertCard(resolvedCtx, ms, renderCurrentView(resolvedCtx, ms));
      return true;
    }

    if (op === 'dmi') {
      const idx = Number(arg);
      const item = ms.results?.[idx];
      if (!item) throw new MusicError('STALE_PLAYER', 'That title is no longer in this result list.');
      if (!app.movieDownloader) throw new MusicError('UNAVAILABLE', 'Movie downloader is unavailable.');
      if (item.isAdultCatalogItem && item.xvItem) {
        if (!isGroupAdultAllowed(resolvedCtx, ms)) {
          await sendEphemeralNoticeOrAlert(resolvedCtx, '🔒 Group Admin Only', 'Only a group administrator can unlock 18+ downloads in this chat.');
          return true;
        }
        if (isAgeGateRequired(resolvedCtx)) {
          await upsertCard(resolvedCtx, ms, renderAdultAgeGate(ms));
          return true;
        }
        const q = getXvQuality(ms);
        const spoiler = effectiveAdultChatId(resolvedCtx, ms) < 0;
        if (ctx.query?.id) await ctx.api?.answerCallbackQuery?.(ctx.query.id, { text: `⬇️ Preparing ${q} MP4: ${cut(item.title, 30)}…` }).catch(() => {});
        ms.logLines = [`⬇️ Preparing 18+ MP4 for ${cut(item.title, 38)}…`];
        await upsertCard(resolvedCtx, ms, renderCurrentView(resolvedCtx, ms));
        const resolved = await getCatalog().resolveStream(item.xvItem, { preferredHeight: xvQualityHeight(q), probeSize: false }).catch(() => null);
        const track = buildXvTrack(item.xvItem, resolved, q);
        if (!track.streamUrl) throw new MusicError('NO_SOURCE', 'Could not resolve downloadable MP4 stream.');
        const res = await runSingleDownloadWithProgress(track, {
          heading: `⬇️ ${cut(track.title, 44)}`,
          subtitle: `XVideos · ${q} MP4`,
          initialLine: `⬇️ Preparing ${q} MP4 for Telegram…`,
          spoiler
        });
        ms.notice = res?.ok ? `✅ Sent "${cut(track.title, 34)}" (${q}) to chat!` : `⚠️ ${res?.reason || 'Download unavailable'}`;
        await upsertCard(resolvedCtx, ms, renderCurrentView(resolvedCtx, ms));
        return true;
      }

      const isTv = item.type === 'tv';
      const desc = {
        type: isTv ? 'tv' : 'movie',
        id: item.id,
        ...tmdbRouteFields(item),
        ...(isTv ? { seriesId: item.id } : {}),
        title: item.title,
        originalTitle: item.originalTitle || null,
        originalLanguage: item.originalLanguage || item.language || null,
        year: item.year,
        releaseDate: item.releaseDate || null,
        ...(isTv ? { season: 1, episode: 1 } : {}),
        runtime: item.runtimeMinutes || item.runtime || null,
        durationSeconds: item.runtimeSeconds || (item.runtimeMinutes ? Number(item.runtimeMinutes) * 60 : null) || null,
        artwork: item.poster || item.backdrop || null,
        imdbId: item.imdbId || null,
        isAdultHint: Boolean(item.isAdultHint || item.adult),
        downloadUrls: Array.isArray(item.downloadUrls) ? item.downloadUrls : []
      };
      if (ctx.query?.id && ctx.api?.answerCallbackQuery) {
        await ctx.api.answerCallbackQuery(ctx.query.id, { text: `⬇️ Preparing download: ${cut(item.title, 36)}…` }).catch(() => {});
      }
      ms.logLines = [`⬇️ Starting download for ${cut(item.title, 40)}…`];
      await upsertCard(resolvedCtx, ms, renderCurrentView(resolvedCtx, ms));
      const res = await runSingleDownloadWithProgress(desc, {
        heading: `⬇️ ${cut(item.title, 44)}`,
        subtitle: `${item.year || ''} · ${isTv ? 'S01E01 MP4 Download' : 'Direct HD MP4 Download'}`,
        initialLine: `⬇️ Preparing ${cut(item.title, 38)} for Telegram…`
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
        ...tmdbRouteFields(item, ms.playback),
        seriesId: item.id,
        title: item.title,
        originalTitle: item.originalTitle || null,
        originalLanguage: item.originalLanguage || item.language || ms.playback?.originalLanguage || null,
        year: item.year,
        releaseDate: ep.airDate || item.releaseDate || null,
        season: sNum,
        episode: eNum,
        episodeTitle: ep.title,
        durationSeconds: ep.runtimeSeconds,
        artwork: ep.still || item.poster || item.backdrop,
        imdbId: item.imdbId,
        isAdultHint: Boolean(item.isAdultHint || item.adult),
        downloadUrls: Array.isArray(ep.downloadUrls) && ep.downloadUrls.length ? ep.downloadUrls : (Array.isArray(item.downloadUrls) ? item.downloadUrls : []),
        rating: item.rating || null,
        genres: Array.isArray(item.genres) ? item.genres : null,
        overview: ep.overview || item.overview || null,
        webappUrl: ms.playback?.webappPlayerUrl || item.playUrl,
        playback: ms.playback || null
      };
      if (op === 'de') {
        if (!app.movieDownloader) throw new MusicError('UNAVAILABLE', 'Movie downloader is unavailable.');
        const epTag = `S${String(sNum).padStart(2, '0')}E${String(eNum).padStart(2, '0')}`;
        if (ctx.query?.id && ctx.api?.answerCallbackQuery) {
          await ctx.api.answerCallbackQuery(ctx.query.id, { text: `⬇️ Downloading ${epTag}…` }).catch(() => {});
        }
        ms.notice = `⬇️ Preparing ${epTag} for Telegram…`;
        await upsertCard(resolvedCtx, ms, renderTvSeason(resolvedCtx, ms));
        const res = await runSingleDownloadWithProgress(desc, {
          heading: `⬇️ ${cut(item.title || 'Series', 36)} · ${epTag}`,
          subtitle: cut(ep.title || epTag, 48),
          initialLine: `⬇️ Preparing ${epTag} for Telegram…`
        });
        ms.notice = res?.ok ? `✅ Sent ${epTag} to chat!` : `⚠️ ${res?.reason || 'Episode download failed'}`;
        await upsertCard(resolvedCtx, ms, renderTvSeason(resolvedCtx, ms));
        return true;
      }
      await streamResolvedItems(resolvedCtx, ms, [desc], { playNow: op === 'pe' });
      return true;
    }

    if (op === 'dk') {
      const keptPage = Math.max(0, Number(arg !== '' ? arg : (ms.dlPage || 0)));
      if (!Array.isArray(ms.dlKeptPages)) ms.dlKeptPages = [];
      if (!ms.dlKeptPages.includes(keptPage)) ms.dlKeptPages.push(keptPage);
      if (!Array.isArray(ms.dlKeptMessageIds)) ms.dlKeptMessageIds = [];
      const toKeep = [ms.dlMessageId, ctx.messageId, ...(ms.dlMediaMessageIds || [])]
        .map(Number)
        .filter(Number.isFinite);
      for (const mid of toKeep) {
        if (!ms.dlKeptMessageIds.includes(mid)) ms.dlKeptMessageIds.push(mid);
        ctx.controller?.markMediaDeliveryMessage?.(mid);
        app.telegram?.markMediaDeliveryMessage?.(mid);
      }
      app.movieSessions.saveSession?.(ms);
      const targetMsgId = ctx.messageId || ms.dlMessageId;
      const existingRows = ctx.query?.message?.reply_markup?.inline_keyboard;
      if (targetMsgId && Array.isArray(existingRows) && typeof resolvedCtx.api?.editMessageReplyMarkup === 'function') {
        const updatedRows = existingRows.map((row) =>
          row.map((btn) => {
            if (typeof btn?.callback_data === 'string' && btn.callback_data.includes(':dk:')) {
              return { ...btn, text: '✅ Kept in Chat', style: 'success' };
            }
            return btn;
          })
        );
        await resolvedCtx.api.editMessageReplyMarkup(resolvedCtx.chatId, targetMsgId, { inline_keyboard: updatedRows }).catch(() => {});
      }
      if (ctx.query?.id && ctx.api?.answerCallbackQuery) {
        await ctx.api.answerCallbackQuery(ctx.query.id, { text: '💾 Slide kept permanently in chat! Future slides won’t remove it.' }).catch(() => {});
      }
      return true;
    }

    if (op === 'dx' || op === 'dsx' || op === 'dl' || op === 'ds') {
      const item = ms.mediaItem || {};
      if (!app.movieDownloader) throw new MusicError('UNAVAILABLE', 'Movie downloader is unavailable.');
      if (op === 'dx' || op === 'dsx') {
        let selected = [];
        let manifestTitle = item.title || 'Series Episodes';
        if (op === 'dsx') {
          const targetSeason = (arg !== '' && arg != null) ? Math.max(0, Number(arg)) : Math.max(0, Number(ms.seasonNumber ?? 1));
          let eps = ms.episodeCache.get(targetSeason);
          if (!Array.isArray(eps) || !eps.length) {
            const sRes = typeof app.movieApi?.getTvSeasonEpisodes === 'function'
              ? await app.movieApi.getTvSeasonEpisodes(item.id, targetSeason).catch(() => null)
              : (typeof app.movieApi?.season === 'function' ? await app.movieApi.season(item.id, targetSeason).catch(() => null) : null);
            eps = Array.isArray(sRes?.episodes) ? sRes.episodes : [];
            if (!eps.length && Number(targetSeason) === Number(ms.seasonNumber) && Array.isArray(ms.episodes) && ms.episodes.length) {
              eps = ms.episodes;
            }
            if (!eps.length) {
              const seasonMeta = (ms.seasons || item.seasons || []).find((s) => Number(s.seasonNumber) === targetSeason);
              const fallbackCount = Math.min(50, Math.max(0, Number(seasonMeta?.episodeCount || 0)));
              if (fallbackCount > 0) {
                eps = Array.from({ length: fallbackCount }, (_, idx) => ({
                  seriesId: item.id,
                  seasonNumber: targetSeason,
                  episodeNumber: idx + 1,
                  title: `Episode ${idx + 1}`
                }));
              }
            }
            if (eps.length) ms.episodeCache.set(targetSeason, eps);
          }
          if (!eps.length) throw new MusicError('MOVIE_NOT_FOUND', `No episodes found for ${targetSeason === 0 ? 'Specials' : `Season ${targetSeason}`}.`);
          selected = eps.map((ep) => ({
            ...ep,
            seasonNumber: Number(ep.seasonNumber ?? targetSeason),
            episodeNumber: Number(ep.episodeNumber || 0)
          }));
          manifestTitle = `${item.title || 'Series'} · ${targetSeason === 0 ? 'Specials' : `S${targetSeason}`}`;
          ms.dlPage = 0;
        } else {
          selected = app.movieSessions.getSelectedEpisodes(ms, ms.episodeCache);
          if (!selected.length) {
            if (ctx.query?.id && ctx.api?.answerCallbackQuery) {
              await ctx.api.answerCallbackQuery(ctx.query.id, { text: 'Select at least 1 episode first (or tap ☑ All Seasons)!', show_alert: true }).catch(() => {});
            }
            return true;
          }
        }
        const descriptors = selected.map((ep) => ({
          type: 'tv',
          id: item.id,
          ...tmdbRouteFields(item, ms.playback),
          seriesId: item.id,
          title: item.title,
          originalTitle: item.originalTitle || null,
          originalLanguage: item.originalLanguage || item.language || ms.playback?.originalLanguage || null,
          year: item.year,
          releaseDate: ep.airDate || item.releaseDate || null,
          season: ep.seasonNumber,
          episode: ep.episodeNumber,
          episodeTitle: ep.title,
          durationSeconds: ep.runtimeSeconds,
          artwork: ep.still || item.poster || item.backdrop,
          imdbId: item.imdbId,
          isAdultHint: Boolean(item.isAdultHint || item.adult),
          downloadUrls: Array.isArray(ep.downloadUrls) && ep.downloadUrls.length ? ep.downloadUrls : (Array.isArray(item.downloadUrls) ? item.downloadUrls : [])
        }));
        app.movieSessions.setDownloadManifest(ms, descriptors, {
          pageSize: 4,
          title: manifestTitle,
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
      const dmOnly = isDmDownloadMode(resolvedCtx, ms);
      const res = await app.movieDownloader.deliverAlbumSlidePage(resolvedCtx, ms, targetPage, {
        quality: getUserDownloadQuality(resolvedCtx, ms),
        buildNavCallback: (pNum) => encodeCallback('music', 'mv', ms.id, 'dl', String(pNum)),
        streamPageCallback: dmOnly ? null : ((pNum) => encodeCallback('music', 'mv', ms.id, 'ds', String(pNum))),
        keepCallback: (pNum) => encodeCallback('music', 'mv', ms.id, 'dk', String(pNum)),
        isKept: Boolean(ms.dlKeptPages?.includes?.(targetPage)),
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
        ...tmdbRouteFields(item, ms.playback),
        seriesId: item.id,
        title: item.title,
        originalTitle: item.originalTitle || null,
        originalLanguage: item.originalLanguage || item.language || ms.playback?.originalLanguage || null,
        year: item.year,
        releaseDate: ep.airDate || item.releaseDate || null,
        season: ep.seasonNumber,
        episode: ep.episodeNumber,
        episodeTitle: ep.title,
        durationSeconds: ep.runtimeSeconds,
        artwork: ep.still || item.poster || item.backdrop,
        imdbId: item.imdbId,
        isAdultHint: Boolean(item.isAdultHint || item.adult),
        downloadUrls: Array.isArray(ep.downloadUrls) && ep.downloadUrls.length ? ep.downloadUrls : (Array.isArray(item.downloadUrls) ? item.downloadUrls : []),
        rating: item.rating || null,
        genres: Array.isArray(item.genres) ? item.genres : null,
        overview: ep.overview || item.overview || null,
        webappUrl: ms.playback?.webappPlayerUrl || item.playUrl,
        playback: ms.playback || null
      }));
      await streamResolvedItems(resolvedCtx, ms, descriptors, { playNow: op === 'px' });
      return true;
    }

    if (op === 'xm') {
      ms.sourceMode = arg === 'xvideos' ? 'xvideos' : 'movie';
      ms.view = 'hub';
      ms.notice = null;
      ms.logLines = null;
      await upsertCard(resolvedCtx, ms, renderHub(resolvedCtx, ms));
      return true;
    }

    if (op === 'xag') {
      app.db?.setSetting?.(`nsfw.ageVerified.${resolvedCtx.tgId}`, true);
      ms.sourceMode = 'xvideos';
      ms.view = 'hub';
      ms.notice = '🔞 18+ mode unlocked.';
      if (ctx.query?.id) await ctx.api?.answerCallbackQuery?.(ctx.query.id, { text: '🔞 18+ verified.' }).catch(() => {});
      await upsertCard(resolvedCtx, ms, renderHub(resolvedCtx, ms));
      return true;
    }

    if (op === 'xca') {
      if (ctx.query?.id && ctx.api?.answerCallbackQuery) {
        await ctx.api.answerCallbackQuery(ctx.query.id, { text: '✕ Movie search closed.' }).catch(() => {});
      }
      await cleanupSupersededCards(resolvedCtx, ms, null);
      if (ms.ephemeralMessageId && typeof resolvedCtx.api?.deleteEphemeralMessage === 'function') {
        await resolvedCtx.api.deleteEphemeralMessage(resolvedCtx.chatId, ms.receiverUserId || resolvedCtx.tgId, ms.ephemeralMessageId).catch(() => {});
      }
      ms.messageId = null;
      ms.promptMessageId = null;
      ms.ephemeralMessageId = null;
      ms.view = 'hub';
      app.movieSessions.touch?.(ms);
      return true;
    }

    if (op === 'xfu') {
      const cid = effectiveAdultChatId(resolvedCtx, ms);
      if (!isGroupAdultAllowed(resolvedCtx, ms)) {
        const isAdmin = await isChatAdminForAdult(resolvedCtx, cid);
        if (!isAdmin) {
          await sendEphemeralNoticeOrAlert(
            resolvedCtx,
            '🔒 Group Admin Required',
            'Only a group administrator can unlock 🔥 XVideos / 18+ mode in this group chat.'
          );
          return true;
        }
        if (Number.isFinite(cid) && cid < 0) {
          app.db?.setSetting?.(`nsfw.groupEnabled.${cid}`, true);
        }
      }
      if (isAgeGateRequired(resolvedCtx)) {
        await upsertCard(resolvedCtx, ms, renderAdultAgeGate(ms));
        return true;
      }
      ms.sourceMode = 'xvideos';
      ms.xvSource = 'all';
      ms.xvCat = '';
      ms.xvArtist = '';
      ms.xvStudio = '';
      ms.xvApiPage = 0;
      ms.xvDur = 'all';
      if (ms.query) {
        ms.xvMode = 'search';
        ms.xvQuery = ms.query;
        if (ctx.query?.id) {
          await ctx.api?.answerCallbackQuery?.(ctx.query.id, { text: `🔥 Switching to XVideos / 18+ for "${cut(ms.query, 24)}"…` }).catch(() => {});
        }
        await executeXvSearch(resolvedCtx, ms, { apiPage: 0, resPage: 0 });
      } else {
        ms.view = 'hub';
        if (ctx.query?.id) {
          await ctx.api?.answerCallbackQuery?.(ctx.query.id, { text: '🔥 XVideos / 18+ unlocked!' }).catch(() => {});
        }
        await upsertCard(resolvedCtx, ms, renderXvHub(resolvedCtx, ms));
      }
      return true;
    }

    if (op === 'xgt') {
      const cid = effectiveAdultChatId(resolvedCtx, ms);
      if (!Number.isFinite(cid) || cid > 0) {
        if (ctx.query?.id) await ctx.api?.answerCallbackQuery?.(ctx.query.id, { text: 'Group 18+ lock applies to groups/channels only.' }).catch(() => {});
        return true;
      }
      const isAdmin = await isChatAdminForAdult(resolvedCtx, cid);
      if (!isAdmin) {
        await sendEphemeralNoticeOrAlert(
          resolvedCtx,
          '🔒 Group Admin Required',
          '🔒 Only group administrators can change 18+ XVideos access in this group.'
        );
        return true;
      }
      const next = !isGroupAdultAllowed(resolvedCtx, ms);
      app.db?.setSetting?.(`nsfw.groupEnabled.${cid}`, next);
      if (!next && ms.sourceMode === 'xvideos') {
        ms.sourceMode = 'movie';
        ms.view = 'hub';
      }
      ms.notice = next ? '🔓 XVideos Mode enabled in this group.' : '🔒 XVideos Mode locked in this group.';
      if (ctx.query?.id) await ctx.api?.answerCallbackQuery?.(ctx.query.id, { text: ms.notice }).catch(() => {});
      await upsertCard(resolvedCtx, ms, renderCurrentView(resolvedCtx, ms));
      return true;
    }

    if (op === 'xsrc') {
      if (!isGroupAdultAllowed(resolvedCtx, ms)) {
        await upsertCard(resolvedCtx, ms, renderAdultGroupLocked(resolvedCtx, ms));
        return true;
      }
      const allowedSrc = ['all', 'adult_movies', 'eporner', 'pornhub', 'xvideos', 'xhamster', 'porntrex', 'fullxcinema', 'pandamovies'];
      const nextSrc = allowedSrc.includes(arg) ? arg : 'all';
      ms.sourceMode = 'xvideos';
      ms.xvSource = nextSrc;
      ms.xvApiPage = 0;
      if (ctx.query?.id) await ctx.api?.answerCallbackQuery?.(ctx.query.id, { text: `Source: ${getAdultSourceLabel(nextSrc)}` }).catch(() => {});
      if (ms.view === 'xv_results') {
        await executeXvSearch(resolvedCtx, ms, { apiPage: 0, resPage: 0 });
      } else {
        await upsertCard(resolvedCtx, ms, renderXvHub(resolvedCtx, ms));
      }
      return true;
    }

    if (op === 'xft' || op === 'xfa') {
      if (!isGroupAdultAllowed(resolvedCtx, ms)) {
        await upsertCard(resolvedCtx, ms, renderAdultGroupLocked(resolvedCtx, ms));
        return true;
      }
      if (isAgeGateRequired(resolvedCtx)) {
        await upsertCard(resolvedCtx, ms, renderAdultAgeGate(ms));
        return true;
      }
      ms.sourceMode = 'xvideos';
      ms.xvSource = 'adult_movies';
      ms.xvCat = '';
      ms.xvArtist = '';
      ms.xvStudio = '';
      ms.xvApiPage = 0;
      if (op === 'xfa' && ms.query) {
        ms.xvMode = 'search';
        ms.xvQuery = ms.query;
        ms.xvDur = 'all';
      } else {
        ms.xvMode = 'trending';
        ms.xvQuery = '';
        ms.xvDur = 'movie';
      }
      if (ctx.query?.id) {
        await ctx.api?.answerCallbackQuery?.(ctx.query.id, { text: op === 'xfa' ? `🔞 Searching 18+ Features for "${cut(ms.xvQuery, 24)}"…` : '🎬 Loading 18+ Full Features…' }).catch(() => {});
      }
      await executeXvSearch(resolvedCtx, ms, { apiPage: 0, resPage: Math.max(0, Number(arg) || 0) });
      return true;
    }

    if (op === 'xas' || op === 'xsp') {
      if (!isGroupAdultAllowed(resolvedCtx, ms)) {
        await upsertCard(resolvedCtx, ms, renderAdultGroupLocked(resolvedCtx, ms));
        return true;
      }
      if (isAgeGateRequired(resolvedCtx)) {
        await upsertCard(resolvedCtx, ms, renderAdultAgeGate(ms));
        return true;
      }
      ms.sourceMode = 'xvideos';
      return await promptSearchInput(resolvedCtx, ms, true, { promptKind: op === 'xas' ? 'xv_artist' : 'xv_studio' });
    }

    if (op === 'xst') {
      if (!isGroupAdultAllowed(resolvedCtx, ms)) {
        await upsertCard(resolvedCtx, ms, renderAdultGroupLocked(resolvedCtx, ms));
        return true;
      }
      if (isAgeGateRequired(resolvedCtx)) {
        await upsertCard(resolvedCtx, ms, renderAdultAgeGate(ms));
        return true;
      }
      const reqPage = Math.max(0, Number(arg) || 0);
      const catalog = getCatalog();
      const stRes = typeof catalog.getStudios === 'function'
        ? await catalog.getStudios({ page: reqPage, perPage: 12 })
        : {
          items: FEATURED_STUDIOS.slice(reqPage * 12, (reqPage + 1) * 12),
          page: reqPage,
          totalPages: Math.max(1, Math.ceil(FEATURED_STUDIOS.length / 12))
        };
      ms.sourceMode = 'xvideos';
      ms.xvStudios = Array.isArray(stRes?.items) ? stRes.items : [];
      ms.xvStudioPage = stRes?.page ?? reqPage;
      ms.xvStudiosTotalPages = stRes?.totalPages || 1;
      ms.view = 'xv_studios';
      await upsertCard(resolvedCtx, ms, renderXvStudios(resolvedCtx, ms));
      return true;
    }

    if (op === 'xsc') {
      const idx = Number(arg);
      const list = Array.isArray(ms.xvStudios) && ms.xvStudios.length ? ms.xvStudios : FEATURED_STUDIOS;
      const stObj = list[idx] || null;
      const studioName = stObj?.name || String(arg || '');
      ms.sourceMode = 'xvideos';
      ms.xvSource = 'adult_movies';
      ms.xvMode = 'studio';
      ms.xvStudio = studioName;
      ms.xvQuery = '';
      ms.xvCat = '';
      ms.xvArtist = '';
      ms.xvApiPage = 0;
      if (ctx.query?.id) await ctx.api?.answerCallbackQuery?.(ctx.query.id, { text: `🏢 Loading ${studioName} features…` }).catch(() => {});
      await executeXvSearch(resolvedCtx, ms, { apiPage: 0, resPage: 0 });
      return true;
    }

    if (op === 'xt') {
      ms.sourceMode = 'xvideos';
      ms.xvMode = 'trending';
      ms.xvQuery = '';
      ms.xvCat = '';
      ms.xvArtist = '';
      ms.xvStudio = '';
      ms.xvApiPage = 0;
      if (ctx.query?.id) await ctx.api?.answerCallbackQuery?.(ctx.query.id, { text: `🔥 Loading Trending (${getAdultSourceLabel(ms.xvSource || 'xvideos')})…` }).catch(() => {});
      await executeXvSearch(resolvedCtx, ms, { apiPage: 0, resPage: Math.max(0, Number(arg) || 0) });
      return true;
    }

    if (op === 'xc' || op === 'xcp') {
      if (!isGroupAdultAllowed(resolvedCtx, ms)) {
        await upsertCard(resolvedCtx, ms, renderAdultGroupLocked(resolvedCtx, ms));
        return true;
      }
      if (isAgeGateRequired(resolvedCtx)) {
        await upsertCard(resolvedCtx, ms, renderAdultAgeGate(ms));
        return true;
      }
      ms.sourceMode = 'xvideos';
      ms.xvCatPage = Math.max(0, Number(arg) || 0);
      ms.view = 'xv_cats';
      await upsertCard(resolvedCtx, ms, renderXvCats(resolvedCtx, ms));
      return true;
    }

    if (op === 'xcc') {
      const cats = getCatalog().getCategories({ page: 0, perPage: 100 }).items || [];
      const catObj = cats.find((c) => c.id === arg) || { id: arg, label: arg };
      ms.sourceMode = 'xvideos';
      ms.xvMode = 'category';
      ms.xvCat = catObj.id;
      ms.xvQuery = '';
      ms.xvArtist = '';
      ms.xvStudio = '';
      ms.xvApiPage = 0;
      if (ctx.query?.id) await ctx.api?.answerCallbackQuery?.(ctx.query.id, { text: `📂 Loading ${catObj.label || catObj.id}…` }).catch(() => {});
      await executeXvSearch(resolvedCtx, ms, { apiPage: 0, resPage: 0 });
      return true;
    }

    if (op === 'xa' || op === 'xap') {
      if (!isGroupAdultAllowed(resolvedCtx, ms)) {
        await upsertCard(resolvedCtx, ms, renderAdultGroupLocked(resolvedCtx, ms));
        return true;
      }
      if (isAgeGateRequired(resolvedCtx)) {
        await upsertCard(resolvedCtx, ms, renderAdultAgeGate(ms));
        return true;
      }
      const reqPage = Math.max(0, Number(arg) || 0);
      const artRes = await getCatalog().getArtists({ page: reqPage, perPage: 12 });
      ms.sourceMode = 'xvideos';
      ms.xvArtists = Array.isArray(artRes?.items) ? artRes.items : [];
      ms.xvArtistPage = artRes?.page ?? reqPage;
      ms.xvArtistsTotalPages = artRes?.totalPages || 1;
      ms.view = 'xv_artists';
      await upsertCard(resolvedCtx, ms, renderXvArtists(resolvedCtx, ms));
      return true;
    }

    if (op === 'xac') {
      const idx = Number(arg);
      const artistObj = Array.isArray(ms.xvArtists) ? ms.xvArtists[idx] : null;
      const artistTarget = artistObj
        ? (artistObj.xvType && artistObj.xvSlug && (ms.xvSource || 'xvideos') === 'xvideos'
          ? `${artistObj.xvType}/${artistObj.xvSlug}`
          : artistObj.name)
        : String(arg || '');
      ms.sourceMode = 'xvideos';
      ms.xvMode = 'artist';
      ms.xvArtist = artistTarget;
      ms.xvQuery = '';
      ms.xvCat = '';
      ms.xvStudio = '';
      ms.xvApiPage = 0;
      if (ctx.query?.id) await ctx.api?.answerCallbackQuery?.(ctx.query.id, { text: `⭐ Loading ${artistObj?.name || artistTarget}…` }).catch(() => {});
      await executeXvSearch(resolvedCtx, ms, { apiPage: 0, resPage: 0 });
      return true;
    }

    if (op === 'xso' || op === 'xd') {
      if (op === 'xso') {
        ms.xvSort = ['relevance', 'views', 'rating'].includes(arg) ? arg : 'relevance';
      } else {
        ms.xvDur = ['all', 'short', 'medium', 'long', 'full', 'movie'].includes(arg) ? arg : 'all';
      }
      ms.xvApiPage = 0;
      if (ctx.query?.id) {
        await ctx.api?.answerCallbackQuery?.(ctx.query.id, { text: op === 'xso' ? `Sort: ${ms.xvSort}` : `Duration: ${ms.xvDur}` }).catch(() => {});
      }
      await executeXvSearch(resolvedCtx, ms, { apiPage: 0, resPage: 0 });
      return true;
    }

    if (op === 'xp') {
      const targetUiPage = Math.max(0, Number(arg) || 0);
      const targetApiPage = Math.floor(targetUiPage / 3);
      if (targetApiPage !== Number(ms.xvApiPage || 0)) {
        await executeXvSearch(resolvedCtx, ms, { apiPage: targetApiPage, resPage: targetUiPage, preserveSelection: false });
      } else {
        ms.xvResPage = targetUiPage;
        ms.view = 'xv_results';
        await upsertCard(resolvedCtx, ms, renderXvResults(resolvedCtx, ms));
      }
      return true;
    }

    if (op === 'xk') {
      const idx = Number(arg);
      if (!(ms.xvSelected instanceof Set)) ms.xvSelected = new Set();
      if (ms.xvSelected.has(idx)) ms.xvSelected.delete(idx);
      else ms.xvSelected.add(idx);
      if (ctx.query?.id) {
        await ctx.api?.answerCallbackQuery?.(ctx.query.id, {
          text: `${ms.xvSelected.has(idx) ? '☑ Checked' : '☐ Unchecked'} #${idx + 1} (${ms.xvSelected.size} selected)`
        }).catch(() => {});
      }
      await upsertCard(resolvedCtx, ms, renderXvResults(resolvedCtx, ms));
      return true;
    }

    if (op === 'xqa') {
      if (!(ms.xvSelected instanceof Set)) ms.xvSelected = new Set();
      const results = Array.isArray(ms.xvResults) ? ms.xvResults : [];
      const localPagesCount = Math.max(1, Math.ceil(results.length / 5));
      const localPage = Math.max(0, Math.min(Number(ms.xvResPage || 0) % 3, localPagesCount - 1));
      const start = localPage * 5;
      const pageIndices = results.slice(start, start + 5).map((_, i) => start + i);
      const allSelected = pageIndices.length > 0 && pageIndices.every((idx) => ms.xvSelected.has(idx));
      if (allSelected) pageIndices.forEach((idx) => ms.xvSelected.delete(idx));
      else pageIndices.forEach((idx) => ms.xvSelected.add(idx));
      if (ctx.query?.id) {
        await ctx.api?.answerCallbackQuery?.(ctx.query.id, {
          text: allSelected ? '☐ Page unchecked' : `☑ Page selected (${ms.xvSelected.size} total)`
        }).catch(() => {});
      }
      await upsertCard(resolvedCtx, ms, renderXvResults(resolvedCtx, ms));
      return true;
    }

    if (op === 'xo') {
      const idx = Number(arg);
      if (ctx.query?.id) await ctx.api?.answerCallbackQuery?.(ctx.query.id, { text: '🔎 Loading XVideos details & sizes…' }).catch(() => {});
      await loadXvDetailIntoSession(ms, idx);
      await upsertCard(resolvedCtx, ms, renderXvDetail(resolvedCtx, ms));
      return true;
    }

    if (op === 'xrv') {
      ms.view = 'xv_results';
      ms.notice = null;
      await upsertCard(resolvedCtx, ms, renderXvResults(resolvedCtx, ms));
      return true;
    }

    if (op === 'xq') {
      const q = ['360p', '480p', '720p'].includes(arg) ? arg : '480p';
      ms.xvQuality = q;
      if (Array.isArray(ms.xvResolved?.variants) && ms.xvResolved.variants.length) {
        const targetH = xvQualityHeight(q);
        const best = [...ms.xvResolved.variants].sort((a, b) => {
          const ha = Number(a.height || parseInt(String(a.quality || '480').replace(/[^\d]/g, ''), 10) || 480);
          const hb = Number(b.height || parseInt(String(b.quality || '480').replace(/[^\d]/g, ''), 10) || 480);
          return (Math.abs(ha - targetH) + (a.isHls ? 50 : 0)) - (Math.abs(hb - targetH) + (b.isHls ? 50 : 0));
        })[0];
        if (best?.url) {
          ms.xvResolved.streamUrl = best.url;
          ms.xvResolved.isHls = Boolean(best.isHls);
        }
      }
      if (ctx.query?.id) await ctx.api?.answerCallbackQuery?.(ctx.query.id, { text: `Quality: ${q}` }).catch(() => {});
      await upsertCard(resolvedCtx, ms, renderXvDetail(resolvedCtx, ms));
      return true;
    }

    if (op === 'xpm') {
      const dest = ms.destination || app.music?.destination?.(resolvedCtx);
      const qm = app.musicQueueManager;
      const cur = qm?.getDeckStreamMode?.(dest, 'movie') || 'rtmp';
      const nextMode = cur === 'rtmp' ? 'interactive' : 'rtmp';
      app.db?.setSetting?.(`music.streamMode.movie.${dest}`, nextMode);
      if (qm) {
        const qSess = qm.getSession?.(dest);
        if (qSess) {
          qSess.movieStreamMode = nextMode;
          const movieActive = qSess.activeDeck === 'movie' || qSess.currentTrack?.provider === 'movie';
          if (movieActive && typeof qm.setStreamMode === 'function') {
            await qm.setStreamMode(dest, nextMode).catch(() => {});
          } else if (!['playing', 'paused', 'buffering'].includes(qSess.status)) {
            qSess.streamMode = nextMode;
            qSess.activeDeck = 'movie';
          }
        }
      }
      const modeLabel = nextMode === 'rtmp' ? '🔒 RTMP Live (Locked A/V)' : '🎙 Interactive VC (WebRTC)';
      ms.notice = `🔄 Cinema VC Engine set to ${modeLabel}`;
      if (ctx.query?.id) await ctx.api?.answerCallbackQuery?.(ctx.query.id, { text: ms.notice }).catch(() => {});
      await upsertCard(resolvedCtx, ms, renderCurrentView(resolvedCtx, ms));
      return true;
    }

    if (op === 'xpl') {
      if (arg === 'cur' || arg === 'curq') {
        const item = (ms.xvResults || [])[Number(ms.xvCurrentIdx || 0)];
        if (!item) throw new MusicError('STALE_PLAYER', 'Choose an XVideos title first.');
        await streamXvItems(resolvedCtx, ms, [item], { playNow: arg === 'cur' });
      } else {
        const indices = [...(ms.xvSelected instanceof Set ? ms.xvSelected : [])].sort((a, b) => a - b);
        const items = indices.map((i) => ms.xvResults?.[i]).filter(Boolean);
        await streamXvItems(resolvedCtx, ms, items, { playNow: arg !== 'q' });
      }
      return true;
    }

    if (op === 'xdl') {
      if (!isGroupAdultAllowed(resolvedCtx, ms)) {
        await upsertCard(resolvedCtx, ms, renderAdultGroupLocked(resolvedCtx, ms));
        return true;
      }
      if (isAgeGateRequired(resolvedCtx)) {
        await upsertCard(resolvedCtx, ms, renderAdultAgeGate(ms));
        return true;
      }
      if (!app.movieDownloader) throw new MusicError('UNAVAILABLE', 'Movie downloader is unavailable.');
      const q = getXvQuality(ms);
      const spoiler = effectiveAdultChatId(resolvedCtx, ms) < 0;

      if (arg === 'cur') {
        const item = (ms.xvResults || [])[Number(ms.xvCurrentIdx || 0)];
        if (!item) throw new MusicError('STALE_PLAYER', 'Choose an XVideos title first.');
        if (ctx.query?.id) await ctx.api?.answerCallbackQuery?.(ctx.query.id, { text: `⬇️ Preparing ${q} MP4 download…` }).catch(() => {});
        const resolved = await getCatalog().resolveStream(item, { preferredHeight: xvQualityHeight(q), probeSize: false }).catch(() => null);
        const track = buildXvTrack(item, resolved || ms.xvResolved, q);
        if (!track.streamUrl) throw new MusicError('NO_SOURCE', 'Could not resolve downloadable MP4 stream.');
        const useTracker = !app.movieDownloader.hasCachedVideo?.(track, q) && typeof resolvedCtx.api?.sendRichMessage === 'function';
        const tracker = useTracker
          ? new ProgressTracker({ api: resolvedCtx.api, chatId: resolvedCtx.chatId, heartbeatMs: 2000, action: 'upload_video' })
          : null;
        if (tracker) {
          await tracker.live(
            (state, { elapsedMs }) => buildDownloadProgressCard(`⬇️ ${cut(track.title, 44)}`, `XVideos · ${q} MP4`, state, elapsedMs),
            { statusLine: `⬇️ Preparing ${q} MP4 for Telegram…` }
          ).catch(() => {});
        }
        let res;
        try {
          res = await app.movieDownloader.sendSingleVideo(resolvedCtx, track, {
            quality: q,
            spoiler,
            allowAdultFeatures: isGroupAdultAllowed(resolvedCtx, ms),
            onProgress: (line) => {
              ms.logLines = [...(ms.logLines || []).slice(-7), line];
              ms.notice = line;
              tracker?.set({ statusLine: line });
            }
          });
        } finally {
          await tracker?.cleanup?.().catch(() => {});
        }
        ms.notice = res?.ok ? `✅ Sent "${cut(track.title, 34)}" (${q}) to chat!` : `⚠️ ${res?.reason || 'Download unavailable'}`;
        await upsertCard(resolvedCtx, ms, renderXvDetail(resolvedCtx, ms));
        return true;
      }

      const slidePage = arg.startsWith('p:') ? Math.max(0, Number(arg.slice(2)) || 0) : 0;
      if (ctx.query?.id) await ctx.api?.answerCallbackQuery?.(ctx.query.id, { text: `📦 Preparing XVideos Slide ${slidePage + 1}…` }).catch(() => {});
      if (arg === 'sl' || !ms.dlManifest?.items?.length) {
        const results = Array.isArray(ms.xvResults) ? ms.xvResults : [];
        const selIndices = ms.xvSelected instanceof Set && ms.xvSelected.size
          ? [...ms.xvSelected].sort((a, b) => a - b)
          : results.slice((Number(ms.xvResPage || 0) % 3) * 5, (Number(ms.xvResPage || 0) % 3) * 5 + 5).map((_, i) => (Number(ms.xvResPage || 0) % 3) * 5 + i);
        const tracks = [];
        for (const idx of selIndices) {
          const it = results[idx];
          if (!it) continue;
          const r = await getCatalog().resolveStream(it, { preferredHeight: xvQualityHeight(q), probeSize: false }).catch(() => null);
          const tr = buildXvTrack(it, r, q);
          if (tr.streamUrl) tracks.push(tr);
        }
        if (!tracks.length) throw new MusicError('NO_SOURCE', 'Could not resolve any XVideos MP4 streams for slides.');
        ms.dlManifest = {
          title: `🔥 XVideos · ${cut(ms.xvQuery || ms.xvCat || ms.xvArtist || 'Trending', 32)}`,
          pageSize: 4,
          items: tracks
        };
      }
      const res = await app.movieDownloader.deliverAlbumSlidePage(resolvedCtx, ms, slidePage, {
        quality: q,
        spoiler,
        buildNavCallback: (pNum) => encodeCallback('music', 'mv', ms.id, 'xdl', `p:${pNum}`),
        keepCallback: (pNum) => encodeCallback('music', 'mv', ms.id, 'dk', String(pNum)),
        isKept: Boolean(ms.dlKeptPages?.includes?.(slidePage)),
        backCallback: () => encodeCallback('music', 'mv', ms.id, 'xrv'),
        onProgress: (line) => { ms.notice = line; }
      });
      if (!res?.ok) {
        ms.notice = `⚠️ ${res?.reason || 'Slide album failed'}`;
        await upsertCard(resolvedCtx, ms, renderCurrentView(resolvedCtx, ms));
      }
      return true;
    }

    throw new MusicError('STALE_PLAYER', 'That movie action is unavailable.');
  }

  return {
    openHub,
    openMovieSearch,
    executeXvSearch,
    startAiChat,
    handleAiTurn,
    handleCallback,
    renderHub,
    renderXvHub,
    renderXvResults,
    renderXvDetail,
    renderXvCats,
    renderXvArtists,
    renderResults,
    renderMovieDetail,
    renderTvSeason,
    renderSeasonPicker,
    renderCategories
  };
}
