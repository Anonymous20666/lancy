import { RichMessageBuilder, rt, richButton, encodeCallback, block } from '../rich.js';
import { navButtons, kvTable, banner } from '../ui.js';
import { States } from '../../core/stateMachine.js';
import { ProgressTracker } from '../progress.js';
import {
  searchNsfw,
  searchXvideos,
  searchAdultMovies,
  resolveXvideosStream,
  isBlockedNsfwQuery,
  NSFW_CATEGORIES,
  CATEGORY_SUGGESTIONS
} from '../../wallpaper/nsfwSearch.js';
import { truncate } from '../../utils/text.js';
import { checkChatMediaPermissions, formatMediaRestrictedNotice } from '../permissions.js';
import { optimizePreviewImage } from '../../media/convert.js';
import { logger } from '../../core/logger.js';

const log = logger().child({ module: 'nsfw-screen' });

/**
 * Infer required Referer header for adult CDNs so HD MP4 streams never return 403.
 */
function buildMediaHeaders(url = '', itemHeaders = null) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    ...(itemHeaders || {})
  };
  if (!headers.Referer) {
    if (/eporner\.com/i.test(url)) headers.Referer = 'https://www.eporner.com/';
    else if (/redgifs\.com/i.test(url)) headers.Referer = 'https://www.redgifs.com/';
    else if (/xvideos/i.test(url)) headers.Referer = 'https://www.xvideos.com/';
    else if (/yande\.re/i.test(url)) headers.Referer = 'https://yande.re/';
    else if (/konachan\.com/i.test(url)) headers.Referer = 'https://konachan.com/';
  }
  return headers;
}

/**
 * Fetch HD buffers for preview slideshow (1080p/720p full playable MP4 videos with audio & 4K/HD photos).
 */
async function fetchPreviewBuffers(items, max = 10) {
  const previewBlocks = [];
  const mediaFiles = {};
  let idx = 0;

  const MAX_VIDEO_BYTES = 48 * 1024 * 1024; // 48 MB Telegram Bot API upload safety cap
  const topItems = (items || []).slice(0, max);

  const promises = topItems.map(async (it) => {
    const isVideo = it.type === 'video';
    // For videos, try full HD video streams in order (videoUrl -> mediaUrl -> fallbackUrls)
    const candidateUrls = isVideo
      ? [...new Set([it.videoUrl, it.mediaUrl, it.media_url, ...(Array.isArray(it.fallbackUrls) ? it.fallbackUrls : [])].filter(Boolean))]
      : [...new Set([it.mediaUrl, it.media_url, it.thumbUrl].filter(Boolean))];

    if (candidateUrls.length === 0) return null;

    for (const targetUrl of candidateUrls) {
      try {
        const res = await fetch(targetUrl, {
          headers: buildMediaHeaders(targetUrl, it.headers),
          signal: AbortSignal.timeout(isVideo ? 16000 : 8500)
        });
        if (!res.ok) continue;

        const contentLength = Number(res.headers?.get?.('content-length') || 0);
        if (isVideo && contentLength > MAX_VIDEO_BYTES && candidateUrls.length > 1) {
          // Stream exceeds 48 MB; step down to next resolution in fallbackUrls (e.g. 720p / 480p)
          try { await res.body?.cancel?.(); } catch {}
          continue;
        }

        const arrayBuf = await res.arrayBuffer();
        const rawBuf = Buffer.from(arrayBuf);
        if (rawBuf.length < 50) continue;
        if (isVideo && rawBuf.length > MAX_VIDEO_BYTES && candidateUrls.length > 1) {
          continue;
        }

        if (isVideo) {
          const isImage = (rawBuf[0] === 0xff && rawBuf[1] === 0xd8) ||
                          (rawBuf[0] === 0x89 && rawBuf[1] === 0x50) ||
                          (rawBuf[0] === 0x47 && rawBuf[1] === 0x49 && rawBuf[2] === 0x46);

          if (isImage) {
            // If this candidate URL was an image, try the next candidate URL before settling for photo
            if (targetUrl !== candidateUrls[candidateUrls.length - 1]) continue;
            const optBuf = await optimizePreviewImage(rawBuf, { maxDimension: 1600, quality: 90 });
            return { type: 'photo', buffer: optBuf, mime: 'image/jpeg' };
          }

          // Genuine playable HD MP4 video with audio!
          return { type: 'video', buffer: rawBuf, mime: 'video/mp4' };
        }

        // Crisp 1600px HD optimization for 4K wallpapers
        const optBuf = await optimizePreviewImage(rawBuf, { maxDimension: 1600, quality: 90 });
        return { type: 'photo', buffer: optBuf, mime: 'image/jpeg' };
      } catch {
        // Try next candidate URL
      }
    }

    // Final fallback: If all video stream URLs failed, try its preview thumbnail as photo
    if (isVideo && it.thumbUrl && !candidateUrls.includes(it.thumbUrl)) {
      try {
        const tRes = await fetch(it.thumbUrl, {
          headers: buildMediaHeaders(it.thumbUrl, it.headers),
          signal: AbortSignal.timeout(5000)
        });
        if (tRes.ok) {
          const tBuf = Buffer.from(await tRes.arrayBuffer());
          const optBuf = await optimizePreviewImage(tBuf, { maxDimension: 1600, quality: 90 });
          return { type: 'photo', buffer: optBuf, mime: 'image/jpeg' };
        }
      } catch {}
    }
    return null;
  });

  const loaded = await Promise.all(promises);
  for (const item of loaded) {
    if (!item) continue;
    const field = `${item.type}_${idx}`;
    mediaFiles[field] = {
      buffer: item.buffer,
      filename: `${field}.${item.type === 'video' ? 'mp4' : 'jpg'}`,
      contentType: item.mime
    };
    previewBlocks.push({ type: item.type, ref: `attach://${field}` });
    idx++;
  }
  return { previewBlocks, mediaFiles };
}

export function createNsfwScreen({ app }) {
  const id = 'nsfw';
  const activeSearches = new Map(); // tgId -> AbortController
  const adultCinemaSessions = new Map(); // sid -> { sid, mode, category, query, page, apiPage, sort, items, selectedIds, msgId, createdAt }

  function rememberAdultSession(session) {
    adultCinemaSessions.set(session.sid, session);
    if (adultCinemaSessions.size > 200) {
      const oldestKey = adultCinemaSessions.keys().next().value;
      adultCinemaSessions.delete(oldestKey);
    }
    return session;
  }

  function getAdultSession(sid) {
    return sid ? adultCinemaSessions.get(String(sid)) || null : null;
  }

  async function ensureAdultStreamResolved(item) {
    if (!item) return null;
    if (item._fullResolved && (item.videoUrl || item.hlsUrl)) return item;
    if (item.pageUrl && /xvideos\./i.test(item.pageUrl)) {
      const resolved = await resolveXvideosStream(item.pageUrl).catch(() => null);
      if (resolved?.streamUrl) {
        item.videoUrl = resolved.streamUrl;
        item.hlsUrl = resolved.hlsUrl || item.hlsUrl || null;
        item.fallbackUrls = [...new Set([...(resolved.fallbackUrls || []), ...(item.fallbackUrls || [])])];
        item.headers = resolved.headers || item.headers;
        item.streamHeaders = resolved.headers || item.streamHeaders;
      }
      item._fullResolved = true;
    } else if (item.videoUrl || item.mediaUrl) {
      item._fullResolved = true;
    }
    return item;
  }

  function buildAdultTrack(item, mode = 'adult_movies') {
    const streamUrl = item.videoUrl || item.hlsUrl || item.fallbackUrls?.[0] || item.mediaUrl;
    return {
      id: String(item.id || `adult_${Date.now()}`),
      title: item.title || (mode === 'xvideos' ? '18+ Stream' : '18+ Feature Film'),
      artist: mode === 'xvideos' ? '18+ Stream' : '18+ Cinema',
      durationSec: Number(item.durationSec) || 0,
      durationLabel: item.duration || '',
      provider: 'movie',
      mediaType: 'video',
      isAdult: true,
      streamUrl,
      videoUrl: streamUrl,
      streamHeaders: item.streamHeaders || item.headers || {},
      fallbackUrls: item.fallbackUrls || [],
      thumbnailUrl: item.thumbUrl || null,
      pageUrl: item.pageUrl || null,
      resolution: item.quality || 'HD'
    };
  }

  async function fetchThumbnailSlides(items = []) {
    const previewBlocks = [];
    const mediaFiles = {};
    const fetched = await Promise.all(
      items.slice(0, 5).map(async (it, i) => {
        const url = it.thumbUrl;
        if (!url || !url.startsWith('http')) return null;
        try {
          const res = await fetch(url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
              ...(it.headers || {})
            },
            signal: AbortSignal.timeout(3000)
          });
          if (!res.ok) return null;
          let buf = Buffer.from(await res.arrayBuffer());
          if (!buf.length || buf.length < 400) return null;
          try {
            buf = await optimizePreviewImage(buf, { maxWidth: 960, quality: 75 });
          } catch {}
          return { i, buf };
        } catch {
          return null;
        }
      })
    );
    for (const r of fetched) {
      if (!r) continue;
      const key = `ac_th_${r.i}.jpg`;
      mediaFiles[key] = { buffer: r.buf, filename: key, contentType: 'image/jpeg' };
      previewBlocks.push(block.photo(`attach://${key}`));
    }
    return { previewBlocks, mediaFiles };
  }

  function isGroupChat(ctx) {
    return Boolean(ctx.isGroup || ctx.message?.chat?.type === 'group' || ctx.message?.chat?.type === 'supergroup' || Number(ctx.chatId) < 0);
  }

  function isGroupNsfwAllowed(ctx) {
    if (!isGroupChat(ctx)) return true;
    return app.db?.getSetting?.(`nsfw.groupEnabled.${ctx.chatId}`, true) !== false;
  }

  function isAgeGateRequired(ctx) {
    return app.settings?.get?.('nsfw.requireAgeGate') === true && !app.db?.getSetting?.(`nsfw.ageVerified.${ctx.tgId}`, false);
  }

  function renderAgeGate() {
    const b = new RichMessageBuilder();
    b.header('🔞 AGE VERIFICATION REQUIRED', 1);
    b.paragraph('This studio contains explicit 18+ adult and anime content. Confirm that you are at least 18 years old to proceed.');
    b.divider();
    b.buttons([
      richButton.callback('🔞 I am 18+ — Enter Studio', encodeCallback(id, 'confirmAge'), { style: 'success' }),
      richButton.callback('✦ Home', encodeCallback('dashboard', 'open'), { style: 'primary' })
    ]);
    b.validate();
    return b.toJSON();
  }

  function renderGroupLocked() {
    const b = new RichMessageBuilder();
    b.header('🔒 18+ STUDIO LOCKED IN THIS GROUP', 1);
    b.paragraph('A group administrator has disabled 18+ content in this group chat. You can still use /nsfw in private DM with the bot, or a group admin can re-enable it with /nsfw on.');
    b.divider();
    b.buttons([
      richButton.callback('🔓 Unlock 18+ (Admin Only)', encodeCallback(id, 'toggleGroup'), { style: 'primary' }),
      richButton.callback('✦ Home', encodeCallback('dashboard', 'open'), { style: 'primary' })
    ]);
    b.validate();
    return b.toJSON();
  }

  async function toggleGroupNsfw(ctx, explicitState = null) {
    const api = ctx.api || app.telegram?.api;
    if (!isGroupChat(ctx)) {
      await api?.sendMessage?.(ctx.chatId, 'ℹ️ Group 18+ lock applies to group chats only.').catch(() => {});
      return false;
    }
    const member = await api?.getChatMember?.(ctx.chatId, Number(ctx.tgId)).catch(() => null);
    const isAdmin = ['creator', 'administrator'].includes(member?.status) || (app.settings?.get?.('general.ownerIds') || []).map(String).includes(String(ctx.tgId));
    if (!isAdmin) {
      if (ctx.query?.id) await api?.answerCallbackQuery?.(ctx.query.id, { text: 'Only group administrators can change 18+ group settings.', show_alert: true }).catch(() => {});
      else await api?.sendMessage?.(ctx.chatId, '🔒 Only verified group administrators can toggle 18+ access in this group.').catch(() => {});
      return false;
    }
    const current = isGroupNsfwAllowed(ctx);
    const next = explicitState !== null ? Boolean(explicitState) : !current;
    app.db?.setSetting?.(`nsfw.groupEnabled.${ctx.chatId}`, next);
    if (ctx.query?.id) {
      await api?.answerCallbackQuery?.(ctx.query.id, { text: next ? '🔓 18+ Studio enabled in this group.' : '🔒 18+ Studio locked in this group.' }).catch(() => {});
      await editOrSend(ctx, next ? renderMenu(ctx) : renderGroupLocked());
    } else {
      await api?.sendMessage?.(ctx.chatId, next ? '🔓 18+ Studio is now enabled in this group (with auto-spoiler protection).' : '🔒 18+ Studio is now locked in this group.').catch(() => {});
    }
    return next;
  }

  // ── Main Menu ─────────────────────────────────────────────────────────────
  function renderMenu(ctx) {
    const isGroup = isGroupChat(ctx);
    const b = new RichMessageBuilder();
    b.header('𓆩♡𓆪 18+ ADULT & HENTAI STUDIO 𓆩♡𓆪', 1);
    b.paragraph(rt.italic('₊˚⊹♡ anime hentai, 4K adult wallpapers, aesthetic explicit art & videos ˙ᵕ˙'));
    b.divider();

    b.table(kvTable([
      ['🌸 Hentai Wallpapers', 'Censored / Ecchi & Uncensored 4K'],
      ['🎬 Hentai Videos', 'Animated clips, spicy loops & full videos'],
      ['📸 Adult Wallpapers', '4K glamour, boudoir, sensual models & art'],
      ['🎥 Adult Videos', 'Video clips / previews & full streaming'],
      ['👥 Group Protection', isGroup ? 'Auto-Spoiler Enabled (Masked)' : 'Direct Delivery']
    ]), { compact: true });
    b.divider();

    // Studio Submenu Launchers
    b.buttons([
      richButton.callback('🌸 Hentai Wallpapers', encodeCallback(id, 'sub', 'hentai_wallpapers'), { style: 'primary' }),
      richButton.callback('🎬 Hentai Videos', encodeCallback(id, 'sub', 'hentai_videos'), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('📸 Adult Wallpapers (4K)', encodeCallback(id, 'sub', 'real_wallpapers'), { style: 'primary' }),
      richButton.callback('🎥 Adult Videos', encodeCallback(id, 'sub', 'real_videos'), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🎬 18+ Adult Movies (Full Features)', encodeCallback(id, 'sub', 'adult_movies'), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🔥 XVideos Streaming & Download', encodeCallback(id, 'sub', 'xvideos'), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🎲 Random Spicy Pick', encodeCallback(id, 'random', 'all'), { style: 'primary' }),
      richButton.callback('🔍 Universal 18+ Search', encodeCallback(id, 'searchPrompt', 'all'), { style: 'primary' })
    ]);
    if (isGroup) {
      b.buttons([
        richButton.callback(isGroupNsfwAllowed(ctx) ? '🔒 Lock 18+ in Group (Admin)' : '🔓 Unlock 18+ in Group (Admin)', encodeCallback(id, 'toggleGroup'), { style: 'primary' })
      ]);
    }
    b.divider();
    b.buttons(navButtons(id, { back: false, home: true }));
    b.footer(rt.italic('୨୧ multi-source adult engine • Wallhaven 4K, Yande.re, Nekobot & Spankbang ♡'));
    b.validate();
    return b.toJSON();
  }

  // ── Submenu 1: Hentai Wallpapers ──────────────────────────────────────────
  function renderHentaiWallpapersMenu(ctx) {
    const b = new RichMessageBuilder();
    b.header('𓆩♡𓆪 HENTAI WALLPAPERS 𓆩♡𓆪', 1);
    b.paragraph(rt.italic('₊˚⊹♡ choose your desired spice level for high-res anime wallpapers ♡ ˙ᵕ˙'));
    b.divider();

    b.buttons([
      richButton.callback('🌸 Censored / Ecchi (Soft & Aesthetic)', encodeCallback(id, 'cat', NSFW_CATEGORIES.HENTAI_CENSORED), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🔞 Uncensored (R-18 Explicit 4K)', encodeCallback(id, 'cat', NSFW_CATEGORIES.HENTAI_UNCENSORED), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🎲 Random Hentai Pick', encodeCallback(id, 'random', NSFW_CATEGORIES.HENTAI_UNCENSORED), { style: 'primary' })
    ]);
    b.divider();

    b.paragraph(rt.bold('✨ Trending Anime Characters:'));
    b.buttons([
      richButton.callback('🌸 Tifa', encodeCallback(id, 'askCountDirect', 'tifa', NSFW_CATEGORIES.HENTAI_UNCENSORED), { style: 'primary' }),
      richButton.callback('🌸 Makima', encodeCallback(id, 'askCountDirect', 'makima', NSFW_CATEGORIES.HENTAI_UNCENSORED), { style: 'primary' }),
      richButton.callback('🌸 Genshin', encodeCallback(id, 'askCountDirect', 'genshin', NSFW_CATEGORIES.HENTAI_UNCENSORED), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🌸 Tsunade', encodeCallback(id, 'askCountDirect', 'tsunade', NSFW_CATEGORIES.HENTAI_UNCENSORED), { style: 'primary' }),
      richButton.callback('🌸 Yor Forger', encodeCallback(id, 'askCountDirect', 'yor_forger', NSFW_CATEGORIES.HENTAI_UNCENSORED), { style: 'primary' }),
      richButton.callback('🌸 2B', encodeCallback(id, 'askCountDirect', '2b', NSFW_CATEGORIES.HENTAI_UNCENSORED), { style: 'primary' })
    ]);
    b.divider();

    b.buttons([
      richButton.callback('« Back to 18+ Menu', encodeCallback(id, 'menu'), { style: 'primary' }),
      richButton.callback('✦ Home', encodeCallback('dashboard', 'open'), { style: 'primary' })
    ]);
    b.validate();
    return b.toJSON();
  }

  // ── Submenu 2: Hentai Videos ──────────────────────────────────────────────
  function renderHentaiVideosMenu(ctx) {
    const b = new RichMessageBuilder();
    b.header('𓆩♡𓆪 HENTAI VIDEOS & CLIPS 𓆩♡𓆪', 1);
    b.paragraph(rt.italic('₊˚⊹♡ animated clips, spicy loops, and full streaming anime videos ♡ ˙ᵕ˙'));
    b.divider();

    b.buttons([
      richButton.callback('💋 Animated Clips & Loops (GIF/MP4)', encodeCallback(id, 'cat', NSFW_CATEGORIES.HENTAI_CLIPS), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🎞 Full Hentai Videos & Episodes', encodeCallback(id, 'cat', NSFW_CATEGORIES.HENTAI_FULL_VIDEOS), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🎲 Random Hentai Video Pick', encodeCallback(id, 'random', NSFW_CATEGORIES.HENTAI_FULL_VIDEOS), { style: 'primary' })
    ]);
    b.divider();

    b.paragraph(rt.bold('✨ Popular Video Searches:'));
    b.buttons([
      richButton.callback('🎞 Genshin', encodeCallback(id, 'askCountDirect', 'genshin', NSFW_CATEGORIES.HENTAI_FULL_VIDEOS), { style: 'primary' }),
      richButton.callback('🎞 Tifa 3D', encodeCallback(id, 'askCountDirect', 'tifa 3d', NSFW_CATEGORIES.HENTAI_FULL_VIDEOS), { style: 'primary' }),
      richButton.callback('🎞 OverFlow', encodeCallback(id, 'askCountDirect', 'overflow', NSFW_CATEGORIES.HENTAI_FULL_VIDEOS), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('💋 Blowjob Loop', encodeCallback(id, 'askCountDirect', 'blowjob', NSFW_CATEGORIES.HENTAI_CLIPS), { style: 'primary' }),
      richButton.callback('💋 Ecchi Dance', encodeCallback(id, 'askCountDirect', 'dance', NSFW_CATEGORIES.HENTAI_CLIPS), { style: 'primary' })
    ]);
    b.divider();

    b.buttons([
      richButton.callback('« Back to 18+ Menu', encodeCallback(id, 'menu'), { style: 'primary' }),
      richButton.callback('✦ Home', encodeCallback('dashboard', 'open'), { style: 'primary' })
    ]);
    b.validate();
    return b.toJSON();
  }

  // ── Submenu 3: Real Adult Wallpapers (NO censored wallpaper side!) ────────
  function renderRealWallpapersMenu(ctx) {
    const b = new RichMessageBuilder();
    b.header('𓆩♡𓆪 REAL ADULT 4K WALLPAPERS 𓆩♡𓆪', 1);
    b.paragraph(rt.italic('₊˚⊹♡ 4K glamour, aesthetic boudoir, sensual models & explicit adult photography ♡ ˙ᵕ˙'));
    b.divider();

    b.buttons([
      richButton.callback('🔍 Search 4K Wallpapers', encodeCallback(id, 'cat', NSFW_CATEGORIES.REAL_WALLPAPERS), { style: 'primary' }),
      richButton.callback('🎲 Random 4K Adult Pick', encodeCallback(id, 'random', NSFW_CATEGORIES.REAL_WALLPAPERS), { style: 'primary' })
    ]);
    b.divider();

    b.paragraph(rt.bold('📸 Explore Models & Aesthetic Styles:'));
    b.buttons([
      richButton.callback('📸 Asian Model', encodeCallback(id, 'askCountDirect', 'asian model', NSFW_CATEGORIES.REAL_WALLPAPERS), { style: 'primary' }),
      richButton.callback('📸 Latina', encodeCallback(id, 'askCountDirect', 'latina', NSFW_CATEGORIES.REAL_WALLPAPERS), { style: 'primary' }),
      richButton.callback('📸 Blonde', encodeCallback(id, 'askCountDirect', 'blonde', NSFW_CATEGORIES.REAL_WALLPAPERS), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('📸 Brunette', encodeCallback(id, 'askCountDirect', 'brunette', NSFW_CATEGORIES.REAL_WALLPAPERS), { style: 'primary' }),
      richButton.callback('📸 Glamour', encodeCallback(id, 'askCountDirect', 'glamour', NSFW_CATEGORIES.REAL_WALLPAPERS), { style: 'primary' }),
      richButton.callback('📸 Boudoir', encodeCallback(id, 'askCountDirect', 'boudoir', NSFW_CATEGORIES.REAL_WALLPAPERS), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('📸 Baddie', encodeCallback(id, 'askCountDirect', 'baddie', NSFW_CATEGORIES.REAL_WALLPAPERS), { style: 'primary' }),
      richButton.callback('📸 Fitness', encodeCallback(id, 'askCountDirect', 'fitness model', NSFW_CATEGORIES.REAL_WALLPAPERS), { style: 'primary' }),
      richButton.callback('📸 Aesthetic', encodeCallback(id, 'askCountDirect', 'aesthetic model', NSFW_CATEGORIES.REAL_WALLPAPERS), { style: 'primary' })
    ]);
    b.divider();

    b.buttons([
      richButton.callback('« Back to 18+ Menu', encodeCallback(id, 'menu'), { style: 'primary' }),
      richButton.callback('✦ Home', encodeCallback('dashboard', 'open'), { style: 'primary' })
    ]);
    b.validate();
    return b.toJSON();
  }

  // ── Submenu 4: Real Adult Videos (Clips + Full Videos) ─────────────────────
  function renderRealVideosMenu(ctx) {
    const b = new RichMessageBuilder();
    b.header('𓆩♡𓆪 REAL ADULT VIDEOS & CLIPS 𓆩♡𓆪', 1);
    b.paragraph(rt.italic('₊˚⊹♡ direct playable MP4 previews, video clips, and full streaming videos ♡ ˙ᵕ˙'));
    b.divider();

    b.buttons([
      richButton.callback('🎬 Video Clips & Previews (Fast MP4)', encodeCallback(id, 'cat', NSFW_CATEGORIES.REAL_CLIPS), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🎞 Full Adult Videos & Streams', encodeCallback(id, 'cat', NSFW_CATEGORIES.REAL_FULL_VIDEOS), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🍿 18+ Adult Movies Studio', encodeCallback(id, 'sub', 'adult_movies'), { style: 'primary' }),
      richButton.callback('🔥 XVideos Hub', encodeCallback(id, 'sub', 'xvideos'), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🎲 Random Spicy Video Pick', encodeCallback(id, 'random', NSFW_CATEGORIES.REAL_CLIPS), { style: 'primary' })
    ]);
    b.divider();

    b.paragraph(rt.bold('✨ Trending Video Categories:'));
    b.buttons([
      richButton.callback('🎬 Asian Clip', encodeCallback(id, 'askCountDirect', 'asian', NSFW_CATEGORIES.REAL_CLIPS), { style: 'primary' }),
      richButton.callback('🎬 Latina Clip', encodeCallback(id, 'askCountDirect', 'latina', NSFW_CATEGORIES.REAL_CLIPS), { style: 'primary' }),
      richButton.callback('🎬 Glamour Teaser', encodeCallback(id, 'askCountDirect', 'glamour', NSFW_CATEGORIES.REAL_CLIPS), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🎞 Baddie Full', encodeCallback(id, 'askCountDirect', 'baddie', NSFW_CATEGORIES.REAL_FULL_VIDEOS), { style: 'primary' }),
      richButton.callback('🎞 Brunette Full', encodeCallback(id, 'askCountDirect', 'brunette', NSFW_CATEGORIES.REAL_FULL_VIDEOS), { style: 'primary' })
    ]);
    b.divider();

    b.buttons([
      richButton.callback('« Back to 18+ Menu', encodeCallback(id, 'menu'), { style: 'primary' }),
      richButton.callback('✦ Home', encodeCallback('dashboard', 'open'), { style: 'primary' })
    ]);
    b.validate();
    return b.toJSON();
  }

  async function editOrSend(ctx, rich, files = null) {
    if (ctx.editScreen) return ctx.editScreen(rich, {}, files);
    const tgId = String(ctx.tgId);
    const chatId = ctx.chatId ?? Number(tgId);
    const sm = ctx.sm ?? ctx.machine;
    const targetMsgId = ctx.messageId ?? ctx.screenMessageId ?? sm?.for(tgId)?.screenMessageId ?? sm?.context?.(tgId)?.screenMessageId;
    const api = ctx.api || app.telegram.api;
    if (targetMsgId) {
      const res = await api.editMessageRich(chatId, targetMsgId, rich, {}, files).catch(() => null);
      if (res) return res;
    }
    const sent = await api.sendRichMessage(chatId, rich, {}, files);
    if (targetMsgId && sent?.message_id && sent.message_id !== targetMsgId) {
      await api.deleteMessage(chatId, targetMsgId).catch(() => {});
    }
    return sent;
  }

  async function openMenu(ctx) {
    if (isGroupChat(ctx) && !isGroupNsfwAllowed(ctx)) return editOrSend(ctx, renderGroupLocked());
    if (isAgeGateRequired(ctx)) return editOrSend(ctx, renderAgeGate());
    await editOrSend(ctx, renderMenu(ctx));
  }

  // ── Step 1: Ask Query ─────────────────────────────────────────────────────
  async function askQuery(ctx, category = 'all') {
    const screenMsgId = ctx.messageId ?? ctx.query?.message?.message_id ?? ctx.screenMessageId;
    const tgId = String(ctx.tgId);
    const sm = ctx.sm ?? ctx.machine;
    if (ctx.transition) {
      await ctx.transition(States.NSFW_SEARCH_INPUT, {
        context: { category, stage: 'query', screenMessageId: screenMsgId },
        chatId: ctx.chatId,
        screenMessageId: screenMsgId
      });
    } else if (sm) {
      await sm.transition(tgId, States.NSFW_SEARCH_INPUT, {
        context: { category, stage: 'query', screenMessageId: screenMsgId },
        chatId: ctx.chatId,
        screenMessageId: screenMsgId
      });
    }

    const categoryLabels = {
      [NSFW_CATEGORIES.HENTAI_CENSORED]: 'Censored / Ecchi Anime Wallpapers',
      [NSFW_CATEGORIES.HENTAI_UNCENSORED]: 'Uncensored Hentai 4K Wallpapers',
      [NSFW_CATEGORIES.HENTAI_CLIPS]: 'Animated Hentai Clips & Loops',
      [NSFW_CATEGORIES.HENTAI_FULL_VIDEOS]: 'Hentai Videos & Episodes',
      [NSFW_CATEGORIES.REAL_WALLPAPERS]: 'Real Adult 4K Wallpapers',
      [NSFW_CATEGORIES.REAL_CLIPS]: 'Real Adult Video Clips & Previews',
      [NSFW_CATEGORIES.REAL_FULL_VIDEOS]: 'Full Adult Videos',
      [NSFW_CATEGORIES.ADULT_MOVIES]: '18+ Adult Feature Movies',
      [NSFW_CATEGORIES.XVIDEOS_VIDEO]: 'XVideos Streaming & Download',
      all: '18+ Adult & Hentai Studio'
    };

    const categoryExamples = {
      [NSFW_CATEGORIES.REAL_WALLPAPERS]: ['asian model', 'brunette', 'blonde', 'latina', 'glamour', 'boudoir', 'baddie'],
      [NSFW_CATEGORIES.REAL_CLIPS]: ['asian', 'latina', 'brunette', 'teaser', 'glamour'],
      [NSFW_CATEGORIES.REAL_FULL_VIDEOS]: ['asian', 'latina', 'blonde', 'baddie', 'brunette'],
      [NSFW_CATEGORIES.ADULT_MOVIES]: ['romantic', 'passionate', 'couples', 'full movie', 'brunette'],
      [NSFW_CATEGORIES.XVIDEOS_VIDEO]: ['trending', 'asian', 'latina', 'brunette', 'blonde', 'amateur'],
      [NSFW_CATEGORIES.HENTAI_UNCENSORED]: ['tifa', 'tsunade', 'genshin', 'makima', 'yor forger', '2b', 'marin'],
      [NSFW_CATEGORIES.HENTAI_CENSORED]: ['waifu', 'swimsuit', 'lingerie', 'genshin', 'honkai', 'anime girl'],
      [NSFW_CATEGORIES.HENTAI_CLIPS]: ['blowjob', 'fuck', 'anal', 'cum', 'dance'],
      [NSFW_CATEGORIES.HENTAI_FULL_VIDEOS]: ['genshin', 'tifa 3d', 'overflow', 'naruto', 'cosplay'],
      all: ['tifa', 'asian model', 'genshin', 'blonde', 'waifu', 'latina']
    };

    const examples = categoryExamples[category] || categoryExamples.all;
    const exampleParts = [rt.text('examples: ')];
    examples.forEach((ex, i) => {
      if (i > 0) exampleParts.push(rt.text(', '));
      exampleParts.push(rt.code(ex));
    });

    const b = new RichMessageBuilder();
    b.header(`🔞 SEARCH ${categoryLabels[category]?.toUpperCase() || '18+ STUDIO'}`, 1);
    b.paragraph(rt.italic('tell me what to search for ♡'));
    b.paragraph(rt.concat(...exampleParts));
    b.divider();

    // Quick suggestion buttons on query prompt
    const suggestions = CATEGORY_SUGGESTIONS[category] || CATEGORY_SUGGESTIONS.all;
    if (suggestions && suggestions.length >= 3) {
      b.paragraph(rt.bold('✨ Quick Pick or Tap Below:'));
      b.buttons(suggestions.slice(0, 3).map(s =>
        richButton.callback(s, encodeCallback(id, 'askCountDirect', s.replace(/^[^\w]+/, '').trim(), category), { style: 'primary' })
      ));
    }

    b.buttons([
      richButton.callback('🎲 Random Pick Instead', encodeCallback(id, 'random', category), { style: 'primary' })
    ]);
    b.buttons(navButtons(id, { cancel: true, home: true }));
    b.validate();

    const sent = await editOrSend(ctx, b.toJSON());
    const effectiveMsgId = sent?.message_id || screenMsgId;
    if (effectiveMsgId) {
      ctx.messageId = effectiveMsgId;
      ctx.screenMessageId = effectiveMsgId;
      if (ctx.update) {
        ctx.update({ category, stage: 'query', screenMessageId: effectiveMsgId });
      } else if (sm) {
        sm.update(tgId, { category, stage: 'query', screenMessageId: effectiveMsgId });
      }
      ctx.controller?.userScreenMessage?.set(tgId, { chatId: ctx.chatId, messageId: effectiveMsgId });
      app.telegram?.controller?.userScreenMessage?.set(tgId, { chatId: ctx.chatId, messageId: effectiveMsgId });
    }
  }

  // ── Step 2: Ask Count Selection (Exact Pinterest UX) ──────────────────────
  async function askCount(ctx, query, category = 'all', opts = {}) {
    const isVideo = category.includes('video') || category.includes('clip');
    const tgId = String(ctx.tgId);
    const sm = ctx.sm ?? ctx.machine;
    const replyToMessageId = opts.replyToMessageId ?? null;
    const screenMsgId = ctx.messageId ?? ctx.screenMessageId ?? sm?.for(tgId)?.screenMessageId ?? sm?.context?.(tgId)?.screenMessageId;

    if (ctx.transition) {
      await ctx.transition(States.NSFW_SEARCH_INPUT, {
        context: { category, query, stage: 'count', screenMessageId: screenMsgId },
        chatId: ctx.chatId,
        screenMessageId: screenMsgId
      });
    } else if (sm) {
      await sm.transition(tgId, States.NSFW_SEARCH_INPUT, {
        context: { category, query, stage: 'count', screenMessageId: screenMsgId },
        chatId: ctx.chatId,
        screenMessageId: screenMsgId
      });
    }

    const b = new RichMessageBuilder();
    b.heading(isVideo ? '🎬 VIDEO RESULT COUNT' : '✨ 18+ RESULT COUNT', 2);
    b.paragraph(rt.italic(`how many aesthetic picks should I find for "${truncate(query, 24)}"? ♡`));
    b.divider();
    b.table(kvTable([
      ['Query', truncate(query, 24)],
      ['Category', category],
      ['Quality', '4K / HD Quality Guaranteed']
    ]), { compact: true });
    b.divider();

    if (isVideo) {
      b.buttons([
        richButton.callback('5', encodeCallback(id, 'runCount', '5', category, query), { style: 'primary' }),
        richButton.callback('10', encodeCallback(id, 'runCount', '10', category, query), { style: 'primary' }),
        richButton.callback('15', encodeCallback(id, 'runCount', '15', category, query), { style: 'primary' }),
        richButton.callback('20', encodeCallback(id, 'runCount', '20', category, query), { style: 'primary' })
      ]);
      b.buttons([
        richButton.callback('🎬 More Videos (+10)', encodeCallback(id, 'runCount', '30', category, query), { style: 'primary' })
      ]);
    } else {
      b.buttons([
        richButton.callback('10', encodeCallback(id, 'runCount', '10', category, query), { style: 'primary' }),
        richButton.callback('20', encodeCallback(id, 'runCount', '20', category, query), { style: 'primary' }),
        richButton.callback('30', encodeCallback(id, 'runCount', '30', category, query), { style: 'primary' }),
        richButton.callback('50', encodeCallback(id, 'runCount', '50', category, query), { style: 'primary' })
      ]);
      b.buttons([
        richButton.callback('60', encodeCallback(id, 'runCount', '60', category, query), { style: 'primary' }),
        richButton.callback('80', encodeCallback(id, 'runCount', '80', category, query), { style: 'primary' }),
        richButton.callback('100', encodeCallback(id, 'runCount', '100', category, query), { style: 'primary' })
      ]);
    }
    b.buttons([
      richButton.callback('♾️ Continuous Exploration', encodeCallback(id, 'runCount', 'continuous', category, query), { style: 'primary' }),
      richButton.callback('✎ Custom Count', encodeCallback(id, 'customCount', category, query), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('« Back', encodeCallback(id, 'cat', category), { style: 'primary' })
    ]);
    b.divider();
    b.buttons(navButtons(id, { back: false, home: true }));
    b.validate();

    const api = ctx.api || app.telegram.api;
    const chatId = ctx.chatId ?? Number(tgId);
    let sent;
    if (replyToMessageId) {
      sent = await api.sendRichMessage(chatId, b.toJSON(), {
        reply_parameters: { message_id: replyToMessageId },
        reply_to_message_id: replyToMessageId
      });
    } else {
      sent = await editOrSend(ctx, b.toJSON());
    }

    const effectiveMsgId = sent?.message_id || screenMsgId;
    if (effectiveMsgId) {
      ctx.messageId = effectiveMsgId;
      ctx.screenMessageId = effectiveMsgId;
      if (ctx.transition) {
        await ctx.transition(States.NSFW_SEARCH_INPUT, {
          context: { category, query, stage: 'count', screenMessageId: effectiveMsgId },
          chatId,
          screenMessageId: effectiveMsgId
        });
      } else if (sm) {
        await sm.transition(tgId, States.NSFW_SEARCH_INPUT, {
          context: { category, query, stage: 'count', screenMessageId: effectiveMsgId },
          chatId,
          screenMessageId: effectiveMsgId
        });
      }
      if (ctx.update) {
        ctx.update({ category, query, stage: 'count', screenMessageId: effectiveMsgId });
      } else if (sm) {
        sm.update(tgId, { category, query, stage: 'count', screenMessageId: effectiveMsgId });
      }
      ctx.controller?.userScreenMessage?.set(tgId, { chatId, messageId: effectiveMsgId });
      app.telegram?.controller?.userScreenMessage?.set(tgId, { chatId, messageId: effectiveMsgId });
      ctx.db?.run?.(
        'UPDATE user_states SET screen_message_id = ? WHERE tg_id = ?',
        effectiveMsgId, Number(tgId)
      );
    }
  }

  async function askCustomCount(ctx, category = 'all', query = '') {
    const tgId = String(ctx.tgId);
    const sm = ctx.sm ?? ctx.machine;
    const screenMsgId = ctx.messageId ?? ctx.screenMessageId ?? sm?.for(tgId)?.screenMessageId ?? sm?.context?.(tgId)?.screenMessageId;
    if (ctx.transition) {
      await ctx.transition(States.NSFW_SEARCH_INPUT, {
        context: { category, query, stage: 'count', screenMessageId: screenMsgId },
        chatId: ctx.chatId,
        screenMessageId: screenMsgId
      });
    } else if (sm) {
      await sm.transition(tgId, States.NSFW_SEARCH_INPUT, {
        context: { category, query, stage: 'count', screenMessageId: screenMsgId },
        chatId: ctx.chatId,
        screenMessageId: screenMsgId
      });
    }
    const b = new RichMessageBuilder();
    b.heading('✎ CUSTOM RESULT COUNT', 2);
    b.paragraph(rt.italic(`send me the number of 18+ results you want for "${truncate(query, 24)}" (e.g. 50, 80, 100) ♡`));
    b.divider();
    b.buttons(navButtons(id, { cancel: true }));
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  // ── Step 3: Render Clean Pinterest-Style Results ─────────────────────────
  function renderResultsRich({ searchId, query, category, isContinuous, requestedGoal, totalImages, previewAttachments = [], startOffset = 0, currentOffset = 10 }) {
    const b = new RichMessageBuilder();
    const total = Math.max(Number(totalImages) || 0, previewAttachments.length);

    const bannerLines = isContinuous
      ? ['𓆩♡𓆪 CONTINUOUS SEARCH 𓆩♡𓆪', 'infinite exploration • duplicate-free spicy picks ˙ᵕ˙']
      : ['𓆩♡𓆪 18+ SEARCH COMPLETED 𓆩♡𓆪', `found: ${total} HD picks`];
    b.paragraph(rt.bold(banner(bannerLines)));
    b.divider();

    // The slideshow AT THE TOP IS the result! (Scrollable 10 HD slides)
    if (previewAttachments && previewAttachments.length >= 1) {
      const slideItems = previewAttachments.map((item) => {
        if (typeof item === 'string') return block.photo(item);
        if (item.type === 'video') return block.video(item.ref);
        return block.photo(item.ref ?? item);
      });
      b.slideshow(slideItems);
      b.divider();
    }

    // Clean, short metadata table (NO raw filenames/tags dump table!)
    b.table([
      [
        { text: 'ʕ•ᴥ•ʔ Query', align: 'left', valign: 'middle' },
        { text: rt.bold(truncate(query || 'Spicy Top Picks', 24)), align: 'right', valign: 'middle' }
      ],
      [
        { text: isContinuous ? '˙ᵕ˙ Mode' : '˙ᵕ˙ Results', align: 'left', valign: 'middle' },
        { text: rt.bold(isContinuous ? 'Continuous Exploration ♾️' : `${total} HD Picks`), align: 'right', valign: 'middle' }
      ],
      [
        { text: '🔞 Category', align: 'left', valign: 'middle' },
        { text: rt.bold(category), align: 'right', valign: 'middle' }
      ]
    ], { compact: true });
    b.divider();

    const previewCount = previewAttachments.length;
    const start = Math.max(0, Number(startOffset) || 0);
    const end = Math.min(total, start + (previewCount || 10));

    b.paragraph(rt.concat(
      rt.bold('₊˚⊹♡ scroll slideshow above to browse HD picks!'),
      rt.text(`\nʕ•ᴥ•ʔ showing ${start + 1}–${end} of ${total} picks ♡`)
    ));

    // In-place pagination buttons
    const hasPrev = start > 0;
    const hasNext = isContinuous ? (total > currentOffset || total >= 10) : (total > currentOffset);

    const prevOffset = Math.max(0, start - 10);
    const prevBatchSize = start - prevOffset;
    const nextOffset = currentOffset;
    const nextBatchSize = Math.min(10, total - nextOffset);

    if (hasPrev && hasNext) {
      const prevRange = `(${prevOffset + 1}–${prevOffset + prevBatchSize})`;
      const nextRange = isContinuous ? '(Explore More) →' : `(${nextOffset + 1}–${nextOffset + nextBatchSize}) →`;
      const prevLabel = `← Prev ${prevRange}`;
      const nextLabel = isContinuous ? '♾️ Next Picks (Explore More) →' : `Next ${nextRange}`;
      b.buttons([
        richButton.callback(prevLabel, encodeCallback(id, 'moreAlbum', String(searchId), String(prevOffset), category), { style: 'primary' }),
        richButton.callback(nextLabel, encodeCallback(id, 'moreAlbum', String(searchId), String(nextOffset), category), { style: 'primary' })
      ]);
    } else if (hasNext) {
      const nextRange = isContinuous ? '(Explore More) →' : `(${nextOffset + 1}–${nextOffset + nextBatchSize}) →`;
      const nextLabel = isContinuous ? '♾️ Next Picks (Explore More) →' : `🖼 Next ${nextBatchSize} Picks ${nextRange}`;
      b.buttons([
        richButton.callback(nextLabel, encodeCallback(id, 'moreAlbum', String(searchId), String(nextOffset), category), { style: 'primary' })
      ]);
    } else if (hasPrev) {
      const prevRange = `(${prevOffset + 1}–${prevOffset + prevBatchSize})`;
      b.buttons([
        richButton.callback(`← 🖼 Prev ${prevBatchSize} Picks ${prevRange}`, encodeCallback(id, 'moreAlbum', String(searchId), String(prevOffset), category), { style: 'primary' })
      ]);
    }

    // Smart search suggestion buttons in pagination (tagged from_media)
    const suggestions = CATEGORY_SUGGESTIONS[category] || CATEGORY_SUGGESTIONS.all;
    if (suggestions && suggestions.length >= 3) {
      const filtered = suggestions.filter(s => s.toLowerCase() !== (query || '').toLowerCase()).slice(0, 3);
      if (filtered.length > 0) {
        b.buttons(filtered.map(s =>
          richButton.callback(s, encodeCallback(id, 'askCountDirect', s.replace(/^[^\w]+/, '').trim(), category, 'from_media'), { style: 'primary' })
        ));
      }
    }

    // Action buttons (tagged with from_media so navigating away never overwrites media results!)
    b.buttons([
      richButton.callback('✨ Make Sticker Pack', encodeCallback('stickers', 'fromSearch', String(searchId), 'from_media'), { style: 'primary' }),
      richButton.callback('🎲 Random Spicy Pick', encodeCallback(id, 'random', category, 'from_media'), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🔞 18+ Studio Menu', encodeCallback(id, 'menu', 'from_media'), { style: 'primary' }),
      richButton.callback('✦ Home', encodeCallback('dashboard', 'open', 'from_media'), { style: 'primary' })
    ]);
    b.footer(rt.italic('୨୧ 18+ adult studio • multi-source HD delivery ♡'));
    b.validate();
    return b.toJSON();
  }

  function progressRich({ stage, category = 'all', query, goal = 20, elapsedMs = 0, ...p }) {
    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '𓆩♡𓆪 SEARCHING 18+ STUDIO 𓆩♡𓆪',
      `"${truncate(query || 'Spicy Top Picks', 24)}"`
    ])));
    b.divider();
    b.table([
      [
        { text: 'ʕ•ᴥ•ʔ Query', align: 'left', valign: 'middle' },
        { text: rt.bold(truncate(query || 'Spicy Top Picks', 28)), align: 'right', valign: 'middle' }
      ],
      [
        { text: '🔞 Category', align: 'left', valign: 'middle' },
        { text: rt.bold(category), align: 'right', valign: 'middle' }
      ],
      [
        { text: '୨୧ Target', align: 'left', valign: 'middle' },
        { text: rt.bold(typeof goal === 'string' ? goal : `${goal} picks`), align: 'right', valign: 'middle' }
      ]
    ], { compact: true });
    b.divider();

    // Dynamic elapsed timer + ETA for responsive, lively feedback
    const elapsedSec = Math.floor(elapsedMs / 1000);
    const numericGoal = typeof goal === 'number' ? goal : 20;
    const isVideo = category.includes('video') || category.includes('clip');
    const totalWaitSec = Math.max(isVideo ? 18 : 10, Math.round(numericGoal * (isVideo ? 3.5 : 0.3)));
    const countdownSec = Math.max(0, totalWaitSec - elapsedSec);
    const waitDurationText = totalWaitSec >= 60 ? `Wait ~${Math.ceil(totalWaitSec / 60)}min` : `Wait ${totalWaitSec}s`;
    const countdownText = countdownSec > 0 ? `${countdownSec}s remaining` : 'finishing up...';
    const timeHeader = `⏳ ${waitDurationText} • ⏱ Countdown: ${countdownText} (elapsed ${String(elapsedSec).padStart(2, '0')}s)`;

    let stepLabel = 'Connecting to sources...';
    if (stage === 'searching') {
      stepLabel = 'Searching Eporner 1080p HD, RedGifs 4K, Konachan & Wallhaven...';
    } else if (stage === 'validating') {
      stepLabel = `Validating HD streams (${p.valid ?? 0}/${numericGoal} picks)`;
    } else if (stage === 'done') {
      stepLabel = `Ready! Found ${p.results ?? 0} aesthetic picks`;
    }

    const miniLog = `${timeHeader}\n˙ᵕ˙ ${stepLabel} ♡`;
    b.paragraph(miniLog);
    b.footer(rt.italic('୨୧ live updates in-place • no waiting in the dark ˙ᵕ˙'));
    b.validate();
    return b.toJSON();
  }

  // ── Step 4: Run Search with Chosen Goal / Count ───────────────────────────
  async function runSearch(ctx, query = '', category = 'all', targetGoal = 10, opts = {}) {
    const rawGoal = targetGoal ?? opts.goal ?? 10;
    const isContinuous = rawGoal === 'continuous';
    const goal = isContinuous ? 10 : (Number(rawGoal) > 0 ? Number(rawGoal) : 20);

    const tgId = String(ctx.tgId);
    const userId = Number(ctx.tgId);
    const api = ctx.api || app.telegram.api;
    const chatId = ctx.chatId ?? Number(tgId);
    const isGroup = Boolean(ctx.isGroup || ctx.message?.chat?.type === 'group' || ctx.message?.chat?.type === 'supergroup' || Number(chatId) < 0);
    const replyToId = opts.replyToMessageId || ctx.message?.message_id || null;

    if (isGroup && !isGroupNsfwAllowed(ctx)) {
      return editOrSend(ctx, renderGroupLocked());
    }
    if (isAgeGateRequired(ctx)) {
      return editOrSend(ctx, renderAgeGate());
    }
    if (isBlockedNsfwQuery(query)) {
      const b = new RichMessageBuilder();
      b.header('⚠️ QUERY BLOCKED BY SAFETY FILTER', 1);
      b.paragraph('Your search query contains prohibited terms. Queries involving minors or non-consensual content are strictly blocked.');
      b.buttons(navButtons(id, { back: true, home: true }));
      b.validate();
      return editOrSend(ctx, b.toJSON());
    }

    // Delete user input message to keep chat totally clean & un-spammy in DM
    if (!isGroup && ctx.message?.message_id && app.settings?.get?.('telegram.messageCleanup')) {
      await api.deleteMessage(chatId, ctx.message.message_id).catch(() => {});
    }

    // Check media permissions in groups
    if (isGroup && api) {
      const caps = await checkChatMediaPermissions(api, chatId);
      if (!caps.canSendPhotos && !caps.canSendVideos) {
        const botUser = app.telegram?.botUsername || 'Lancy_easy_bot';
        const notice = formatMediaRestrictedNotice({
          botUsername: botUser,
          url: null,
          mediaType: '18+ media',
          actionTitle: 'Search in Private DM'
        });
        await api.sendMessage(chatId, notice.text, {
          parse_mode: 'HTML',
          reply_markup: notice.reply_markup
        }).catch(() => {});
        return;
      }
    }

    let releaseSlot = null;
    if (ctx.controller?.acquireUserTaskSlot) {
      releaseSlot = await ctx.controller.acquireUserTaskSlot(tgId, chatId, replyToId, isGroup);
      if (!releaseSlot) return;
    }

    const controller = new AbortController();
    activeSearches.set(tgId, controller);

    // Reuse existing screen message so it updates in-place with ticking heartbeat timer
    const targetMsgId = ctx.screenMessageId || ctx.query?.message?.message_id || ctx.sm?.context?.(tgId)?.screenMessageId || null;
    const tracker = new ProgressTracker({ api, chatId, messageId: targetMsgId, heartbeatMs: 2000 });

    await tracker.live((state, { elapsedMs }) => progressRich({
      ...state,
      elapsedMs,
      category,
      query,
      goal: isContinuous ? 'Continuous ♾️' : `${goal} picks`
    }), {
      stage: 'searching', category, query, goal: isContinuous ? 'Continuous ♾️' : `${goal} picks`
    });

    try {
      const searchRes = await searchNsfw({
        query,
        category,
        page: 0,
        limit: Math.min(goal, 50),
        signal: controller.signal
      });

      const items = searchRes.results || [];

      if (!items.length) {
        const b = new RichMessageBuilder();
        b.heading('🔞 NO RESULTS FOUND', 2);
        b.paragraph(rt.italic(`could not find any adult results for "${truncate(query, 24)}" ♡`));
        b.paragraph(rt.text('try another term, or browse trending spicy picks!'));
        b.divider();
        b.buttons([
          richButton.callback('🎲 Random Spicy Pick', encodeCallback(id, 'random', category, 'from_media'), { style: 'primary' }),
          richButton.callback('🔞 18+ Studio Menu', encodeCallback(id, 'menu', 'from_media'), { style: 'primary' })
        ]);
        b.buttons([
          richButton.callback('🔍 Try Another Search', encodeCallback(id, 'cat', category, 'from_media'), { style: 'primary' }),
          richButton.callback('✦ Home', encodeCallback('dashboard', 'open', 'from_media'), { style: 'primary' })
        ]);
        b.validate();
        await tracker.finish(b.toJSON());
        return { message_id: tracker.messageId };
      }

      // Record in DB for sticker pack creation & pagination
      let searchDbId = Date.now();
      try {
        if (app.pinterest?.db) {
          const ins = app.pinterest.db.run(
            'INSERT INTO pinterest_searches (user_id, query, normalized_query, mode, depth, result_count) VALUES (?, ?, ?, ?, ?, ?)',
            userId, query || 'nsfw spicy', (query || 'nsfw').toLowerCase(), 'nsfw', isContinuous ? 'continuous' : 'deep', items.length
          );
          if (ins?.lastInsertRowid) {
            searchDbId = Number(ins.lastInsertRowid);
            for (const it of items) {
              app.pinterest.db.run(
                `INSERT INTO pinterest_media (search_id, user_id, media_url, type, width, height, quality_score, status, is_duplicate)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'valid', 0)`,
                searchDbId, userId, it.videoUrl || it.mediaUrl, it.type, it.width || 1920, it.height || 1080, 95
              );
            }
          }
        }
      } catch (dbErr) {
        log.debug({ err: dbErr?.message }, 'failed to record nsfw search in db');
      }

      // Fetch first 10 items in HD for the slideshow
      const { previewBlocks, mediaFiles } = await fetchPreviewBuffers(items, 10);
      const rich = renderResultsRich({
        searchId: searchDbId,
        query,
        category: searchRes.category || category,
        isContinuous,
        requestedGoal: goal,
        totalImages: items.length,
        previewAttachments: previewBlocks,
        startOffset: 0,
        currentOffset: Math.min(10, items.length)
      });

      const files = previewBlocks.length > 0 ? mediaFiles : null;
      await tracker.finish(rich, files);

      if (tracker.messageId) {
        app.telegram?.markMediaDeliveryMessage?.(tracker.messageId);
        app.telegram?.userScreenMessage?.set?.(tgId, { chatId, messageId: tracker.messageId });
        ctx.sm?.update?.(tgId, { screenMessageId: tracker.messageId });
        return { message_id: tracker.messageId };
      }
    } catch (err) {
      log.error({ err: err?.message, query }, 'nsfw search failed');
      const b = new RichMessageBuilder();
      b.heading('🔞 SEARCH FAILED', 2);
      b.paragraph(rt.bold(`something went wrong: ${err?.message || 'timeout'}`));
      b.divider();
      b.buttons([
        richButton.callback('↺ Try Again', encodeCallback(id, 'cat', category, 'from_media'), { style: 'primary' }),
        richButton.callback('✦ Home', encodeCallback('dashboard', 'open', 'from_media'), { style: 'primary' })
      ]);
      b.validate();
      await tracker.finish(b.toJSON());
      return { message_id: tracker.messageId };
    } finally {
      activeSearches.delete(tgId);
      releaseSlot?.();
    }
  }

  // ── Step 5: In-Place Pagination Album Swapping ────────────────────────────
  async function showMoreAlbum(ctx, searchId, offset = 0, category = 'all') {
    const api = ctx.api || app.telegram.api;
    const chatId = ctx.chatId ?? Number(ctx.tgId);
    const numOffset = Math.max(0, Number(offset) || 0);
    const searchDbId = Number(searchId);

    let nextMedia = app.pinterest?.db?.all?.(
      `SELECT * FROM pinterest_media WHERE search_id = ? AND status = 'valid' AND is_duplicate = 0
       ORDER BY quality_score DESC, id ASC LIMIT 10 OFFSET ?`,
      searchDbId, numOffset
    ) || [];

    let totalMediaRow = app.pinterest?.db?.get?.(
      `SELECT COUNT(*) as count FROM pinterest_media WHERE search_id = ? AND status = 'valid' AND is_duplicate = 0`,
      searchDbId
    );
    let totalMedia = totalMediaRow?.count ?? 0;

    const searchRow = app.pinterest?.db?.get?.(
      'SELECT * FROM pinterest_searches WHERE id = ?',
      searchDbId
    );

    const isContinuous = searchRow?.depth === 'continuous';
    if (!nextMedia.length && isContinuous && searchRow?.query) {
      try {
        const expansion = await searchNsfw({
          query: searchRow.query,
          category,
          page: Math.floor(numOffset / 10),
          limit: 10
        });
        if (expansion?.results?.length) {
          for (const it of expansion.results) {
            app.pinterest.db.run(
              `INSERT INTO pinterest_media (search_id, user_id, media_url, type, width, height, quality_score, status, is_duplicate)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'valid', 0)`,
              searchDbId, searchRow.user_id, it.videoUrl || it.mediaUrl, it.type, it.width || 1920, it.height || 1080, 95
            );
          }
          nextMedia = app.pinterest.db.all(
            `SELECT * FROM pinterest_media WHERE search_id = ? AND status = 'valid' AND is_duplicate = 0
             ORDER BY quality_score DESC, id ASC LIMIT 10 OFFSET ?`,
            searchDbId, numOffset
          );
          totalMediaRow = app.pinterest.db.get(
            `SELECT COUNT(*) as count FROM pinterest_media WHERE search_id = ? AND status = 'valid' AND is_duplicate = 0`,
            searchDbId
          );
          totalMedia = totalMediaRow?.count ?? 0;
        }
      } catch {}
    }

    if (!nextMedia.length) {
      const b = new RichMessageBuilder();
      b.heading('🖼 ALL PICKS VIEWED', 2);
      b.paragraph(rt.italic('all spicy picks in this search have already been browsed ♡'));
      b.divider();
      const endButtons = [];
      if (numOffset > 0) {
        const prevOffset = Math.max(0, numOffset - 10);
        endButtons.push(richButton.callback('← Prev Picks', encodeCallback(id, 'moreAlbum', String(searchId), String(prevOffset), category), { style: 'primary' }));
      }
      endButtons.push(richButton.callback('« Back to 18+ Menu', encodeCallback(id, 'menu', 'from_media'), { style: 'primary' }));
      b.buttons(endButtons);
      b.buttons([
        richButton.callback('🔍 New Search', encodeCallback(id, 'cat', category, 'from_media'), { style: 'primary' })
      ]);
      b.buttons(navButtons(id, { home: true, fromMedia: true }));
      b.validate();
      await editOrSend(ctx, b.toJSON());
      return;
    }

    // Download next 10 HD slides
    const { previewBlocks, mediaFiles } = await fetchPreviewBuffers(nextMedia, 10);
    const nextOffset = numOffset + nextMedia.length;
    const rich = renderResultsRich({
      searchId: searchDbId,
      query: searchRow?.query || '',
      category,
      isContinuous,
      requestedGoal: searchRow?.result_count,
      totalImages: totalMedia,
      previewAttachments: previewBlocks,
      startOffset: numOffset,
      currentOffset: nextOffset
    });
    const files = previewBlocks.length > 0 ? mediaFiles : null;

    // Pinterest clean replacement pattern:
    const targetMsgId = ctx.query?.message?.message_id || ctx.messageId || ctx.screenMessageId || ctx.sm?.context?.(ctx.tgId)?.screenMessageId;
    if (targetMsgId) {
      try {
        await api.editMessageRich(chatId, targetMsgId, rich, {}, files);
        return { message_id: targetMsgId };
      } catch (err) {
        const errMsg = String(err?.description ?? err?.message);
        if (/not modified/i.test(errMsg)) return { message_id: targetMsgId };
        // Edit in-place failed (e.g. Telegram Bot API rejects editing media attachments in-place)
        // Clean replacement: send the new card and delete the old card so only ONE message exists!
        const cardMsg = await api.sendRichMessage(chatId, rich, {}, files);
        if (cardMsg?.message_id) {
          if (targetMsgId && cardMsg.message_id !== targetMsgId) {
            await api.deleteMessage(chatId, targetMsgId).catch(() => {});
          }
          app.telegram?.markMediaDeliveryMessage?.(cardMsg.message_id);
          app.telegram?.userScreenMessage?.set(ctx.tgId, { chatId, messageId: cardMsg.message_id });
          ctx.sm?.update?.(ctx.tgId, { screenMessageId: cardMsg.message_id });
        }
        return cardMsg;
      }
    } else {
      const cardMsg = await api.sendRichMessage(chatId, rich, {}, files);
      if (cardMsg?.message_id) {
        app.telegram?.markMediaDeliveryMessage?.(cardMsg.message_id);
        app.telegram?.userScreenMessage?.set(ctx.tgId, { chatId, messageId: cardMsg.message_id });
        ctx.sm?.update?.(ctx.tgId, { screenMessageId: cardMsg.message_id });
      }
      return cardMsg;
    }
  }

  function renderAdultMoviesMenu(ctx) {
    const b = new RichMessageBuilder();
    b.header('🎬 18+ ADULT MOVIES STUDIO', 1);
    b.paragraph(rt.italic('full-length 18+ HD feature films — stream in VC, add to queue, or download directly (separate from SFW movies)'));
    b.divider();

    b.buttons([
      richButton.callback('🔍 Search 18+ Adult Movies', encodeCallback(id, 'cat', NSFW_CATEGORIES.ADULT_MOVIES), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🎲 Random Adult Feature', encodeCallback(id, 'random', NSFW_CATEGORIES.ADULT_MOVIES), { style: 'primary' })
    ]);
    b.divider();

    b.paragraph(rt.bold('🍿 Popular 18+ Feature Tags:'));
    b.buttons([
      richButton.callback('❤️ Romantic 18+', encodeCallback(id, 'amRun', 'romantic'), { style: 'primary' }),
      richButton.callback('🔥 Passionate', encodeCallback(id, 'amRun', 'passionate'), { style: 'primary' }),
      richButton.callback('💑 Couples', encodeCallback(id, 'amRun', 'couples'), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🎬 Full Storyline', encodeCallback(id, 'amRun', 'full movie'), { style: 'primary' }),
      richButton.callback('💋 Brunette HD', encodeCallback(id, 'amRun', 'brunette'), { style: 'primary' }),
      richButton.callback('💋 Asian HD', encodeCallback(id, 'amRun', 'asian'), { style: 'primary' })
    ]);
    b.divider();

    b.buttons([
      richButton.callback('🔥 Switch to XVideos', encodeCallback(id, 'sub', 'xvideos'), { style: 'primary' }),
      richButton.callback('« 18+ Menu', encodeCallback(id, 'menu')),
      richButton.callback('✦ Home', encodeCallback('dashboard', 'open'))
    ]);
    b.validate();
    return b.toJSON();
  }

  function renderXvideosMenu(ctx) {
    const b = new RichMessageBuilder();
    b.header('🔥 XVIDEOS STREAM & DOWNLOAD', 1);
    b.paragraph(rt.italic('dedicated XVideos hub — browse trending, sort by views/rating, stream in VC, or download HD MP4'));
    b.divider();

    b.buttons([
      richButton.callback('🔍 Search XVideos', encodeCallback(id, 'cat', NSFW_CATEGORIES.XVIDEOS_VIDEO), { style: 'primary' }),
      richButton.callback('🔥 Trending Now', encodeCallback(id, 'xvRun', 'trending'), { style: 'success' })
    ]);
    b.buttons([
      richButton.callback('🎲 Random XVideos Pick', encodeCallback(id, 'random', NSFW_CATEGORIES.XVIDEOS_VIDEO), { style: 'primary' })
    ]);
    b.divider();

    b.paragraph(rt.bold('✨ Quick XVideos Categories:'));
    b.buttons([
      richButton.callback('🔥 Asian', encodeCallback(id, 'xvRun', 'asian'), { style: 'primary' }),
      richButton.callback('🔥 Latina', encodeCallback(id, 'xvRun', 'latina'), { style: 'primary' }),
      richButton.callback('🔥 Brunette', encodeCallback(id, 'xvRun', 'brunette'), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🔥 Blonde', encodeCallback(id, 'xvRun', 'blonde'), { style: 'primary' }),
      richButton.callback('🔥 Amateur', encodeCallback(id, 'xvRun', 'amateur'), { style: 'primary' }),
      richButton.callback('🔥 Cosplay', encodeCallback(id, 'xvRun', 'cosplay'), { style: 'primary' })
    ]);
    b.divider();

    b.buttons([
      richButton.callback('🎬 18+ Adult Movies', encodeCallback(id, 'sub', 'adult_movies'), { style: 'primary' }),
      richButton.callback('« 18+ Menu', encodeCallback(id, 'menu')),
      richButton.callback('✦ Home', encodeCallback('dashboard', 'open'))
    ]);
    b.validate();
    return b.toJSON();
  }

  async function upsertAdultScreen(ctx, rich, files = null, session = null) {
    const api = ctx.api || app.telegram.api;
    const chatId = ctx.chatId ?? Number(ctx.tgId);
    const targetMsgId = ctx.query?.message?.message_id || session?.msgId || ctx.messageId || ctx.screenMessageId || ctx.sm?.context?.(ctx.tgId)?.screenMessageId || null;
    if (targetMsgId && !files && typeof api.editMessageRich === 'function') {
      try {
        await api.editMessageRich(chatId, targetMsgId, rich);
        if (session) session.msgId = targetMsgId;
        return { message_id: targetMsgId };
      } catch (err) {
        if (/not modified/i.test(String(err?.description ?? err?.message))) return { message_id: targetMsgId };
      }
    }
    if (targetMsgId && files && typeof api.editMessageRich === 'function') {
      try {
        await api.editMessageRich(chatId, targetMsgId, rich, {}, files);
        if (session) session.msgId = targetMsgId;
        return { message_id: targetMsgId };
      } catch (err) {
        if (/not modified/i.test(String(err?.description ?? err?.message))) return { message_id: targetMsgId };
      }
    }
    const sent = await api.sendRichMessage(chatId, rich, {}, files);
    if (sent?.message_id) {
      if (targetMsgId && sent.message_id !== targetMsgId) {
        await api.deleteMessage(chatId, targetMsgId).catch(() => {});
      }
      if (session) session.msgId = sent.message_id;
      app.telegram?.markMediaDeliveryMessage?.(sent.message_id);
      app.telegram?.userScreenMessage?.set(ctx.tgId, { chatId, messageId: sent.message_id });
      ctx.sm?.update?.(ctx.tgId, { screenMessageId: sent.message_id });
    }
    return sent;
  }

  async function renderAndShowAdultCinemaPage(ctx, session, uiPage = 0) {
    const isGroup = isGroupChat(ctx);
    const PER_PAGE = 5;
    let totalItems = session.items.length;
    let totalPages = Math.max(1, Math.ceil(totalItems / PER_PAGE));
    let safePage = Math.max(0, Number(uiPage) || 0);

    // Lazy-fetch next backend page when user paginates beyond buffered items
    if (safePage * PER_PAGE >= totalItems && totalItems >= 12) {
      const nextApiPage = (session.apiPage || 0) + 1;
      const more = session.mode === 'xvideos'
        ? await searchXvideos({ query: session.query, page: nextApiPage, limit: 15, sort: session.sort || 'relevance' }).catch(() => ({ results: [] }))
        : await searchAdultMovies({ query: session.query, page: nextApiPage, limit: 15 }).catch(() => ({ results: [] }));
      const existingIds = new Set(session.items.map(it => it.id));
      const added = (more?.results || []).filter(it => it?.id && !existingIds.has(it.id));
      if (added.length) {
        session.apiPage = nextApiPage;
        session.items.push(...added);
        totalItems = session.items.length;
        totalPages = Math.max(1, Math.ceil(totalItems / PER_PAGE));
      }
    }

    safePage = Math.min(safePage, Math.max(0, totalPages - 1));
    session.page = safePage;
    const start = safePage * PER_PAGE;
    const slice = session.items.slice(start, start + PER_PAGE);

    let previewBlocks = [];
    let mediaFiles = null;
    if (!isGroup && slice.length) {
      const fetched = await fetchThumbnailSlides(slice);
      if (fetched.previewBlocks.length) {
        previewBlocks = fetched.previewBlocks;
        mediaFiles = fetched.mediaFiles;
      }
    }

    const titlePrefix = session.mode === 'xvideos' ? '🔥 XVIDEOS' : '🎬 18+ ADULT MOVIES';
    const b = new RichMessageBuilder();
    b.bannerHeader([
      `${titlePrefix} · "${truncate(session.query || 'trending', 24)}"`,
      `Page ${safePage + 1}/${totalPages} · ${totalItems} titles${session.mode === 'xvideos' ? ` · Sort: ${session.sort || 'relevance'}` : ''}`
    ], { size: 2 });

    if (previewBlocks.length > 1) {
      b.slideshow(previewBlocks);
      b.divider();
    } else if (previewBlocks.length === 1) {
      b.image(previewBlocks[0].url);
      b.divider();
    }

    const rows = slice.map((item, i) => {
      const absIdx = start + i;
      const checked = session.selectedIds.has(absIdx) ? '☑' : '☐';
      return [
        `${checked} ${absIdx + 1}.`,
        truncate(item.title || '18+ Video', 38),
        String(item.duration || 'HD').slice(0, 14)
      ];
    });
    if (rows.length) {
      b.table(rows, { striped: true, bordered: true, compact: true });
    }

    const selectedCount = session.selectedIds.size;
    if (isGroup) {
      b.paragraph(rt.italic('ℹ️ Group safety active: downloads use Telegram spoiler blur.'));
    } else {
      b.paragraph(rt.italic(`Selected: ${selectedCount} · Tap ▶ VC, ➕ Q, ⬇ MP4 or multi-select for Slide Album`));
    }

    slice.forEach((item, i) => {
      const absIdx = start + i;
      const num = absIdx + 1;
      const mark = session.selectedIds.has(absIdx) ? '☑' : '☐';
      b.buttons([
        richButton.callback(`${mark} #${num}`, encodeCallback(id, 'acTg', session.sid, String(absIdx))),
        richButton.callback('▶ VC', encodeCallback(id, 'acPl', session.sid, String(absIdx)), { style: 'success' }),
        richButton.callback('➕ Q', encodeCallback(id, 'acQu', session.sid, String(absIdx)), { style: 'primary' }),
        richButton.callback('⬇ MP4', encodeCallback(id, 'acDl', session.sid, String(absIdx)))
      ]);
    });

    b.buttons([
      richButton.callback('☑ Page', encodeCallback(id, 'acAp', session.sid, String(safePage))),
      richButton.callback('⬇ Slide Album', encodeCallback(id, 'acSl', session.sid, '0'), { style: 'primary' }),
      richButton.callback('➕ Queue Sel', encodeCallback(id, 'acQa', session.sid))
    ]);

    const navRow = [];
    if (safePage > 0) {
      navRow.push(richButton.callback('◀ Prev', encodeCallback(id, 'acPg', session.sid, String(safePage - 1)), { style: 'primary' }));
    }
    navRow.push(richButton.callback(`${safePage + 1}/${totalPages}`, encodeCallback(id, 'noop')));
    if (safePage < totalPages - 1 || totalItems >= 12) {
      navRow.push(richButton.callback('Next ▶', encodeCallback(id, 'acPg', session.sid, String(safePage + 1)), { style: 'primary' }));
    }
    b.buttons(navRow);

    if (session.mode === 'xvideos') {
      b.buttons([
        richButton.callback(session.sort === 'relevance' ? '• Rel' : '🔍 Rel', encodeCallback(id, 'xvSo', session.sid, 'relevance')),
        richButton.callback(session.sort === 'views' ? '• Views' : '🔥 Views', encodeCallback(id, 'xvSo', session.sid, 'views')),
        richButton.callback(session.sort === 'rating' ? '• Top' : '⭐ Top', encodeCallback(id, 'xvSo', session.sid, 'rating'))
      ]);
    }

    b.buttons([
      richButton.callback('🔍 Search', encodeCallback(id, 'cat', session.category)),
      richButton.callback('« 18+ Menu', encodeCallback(id, 'menu')),
      richButton.callback('✦ Home', encodeCallback('dashboard', 'open'))
    ]);
    b.validate();
    return upsertAdultScreen(ctx, b.toJSON(), mediaFiles, session);
  }

  async function runAdultCinemaSearch(ctx, category, query = '', { page = 0, sort = 'relevance' } = {}) {
    if (isGroupChat(ctx) && !isGroupNsfwAllowed(ctx)) return editOrSend(ctx, renderGroupLocked());
    if (isAgeGateRequired(ctx)) return editOrSend(ctx, renderAgeGate());

    const cleanQ = String(query || '').trim();
    if (isBlockedNsfwQuery(cleanQ)) {
      const b = new RichMessageBuilder();
      b.header('⚠️ QUERY BLOCKED BY SAFETY FILTER', 1);
      b.paragraph('Your search query contains prohibited terms. Queries involving minors or non-consensual content are strictly blocked.');
      b.buttons(navButtons(id, { back: true, home: true }));
      b.validate();
      return editOrSend(ctx, b.toJSON());
    }

    const mode = category === NSFW_CATEGORIES.XVIDEOS_VIDEO ? 'xvideos' : 'adult_movies';
    const isGroup = isGroupChat(ctx);
    const api = ctx.api || app.telegram.api;
    const chatId = ctx.chatId ?? Number(ctx.tgId);

    if (!isGroup && ctx.message?.message_id && app.settings?.get?.('telegram.messageCleanup')) {
      await api.deleteMessage(chatId, ctx.message.message_id).catch(() => {});
    }

    const targetMsgId = ctx.screenMessageId || ctx.query?.message?.message_id || ctx.sm?.context?.(ctx.tgId)?.screenMessageId || null;
    const tracker = new ProgressTracker({ api, chatId, messageId: targetMsgId, heartbeatMs: 2000 });
    await tracker.live((state, { elapsedMs }) => progressRich({
      ...state,
      elapsedMs,
      category,
      query: cleanQ || 'trending',
      goal: '15 HD titles'
    }), { stage: 'searching', category, query: cleanQ || 'trending', goal: '15 HD titles' });

    const res = mode === 'xvideos'
      ? await searchXvideos({ query: cleanQ, page, limit: 15, sort })
      : await searchAdultMovies({ query: cleanQ, page, limit: 15 });

    const items = res?.results || [];
    if (!items.length) {
      const b = new RichMessageBuilder();
      b.heading(mode === 'xvideos' ? '🔥 NO XVIDEOS RESULTS' : '🎬 NO 18+ MOVIES FOUND', 2);
      b.paragraph(rt.italic(`nothing matched "${truncate(cleanQ || 'trending', 24)}" — try a different keyword.`));
      b.buttons([
        richButton.callback('🔍 Try Another Search', encodeCallback(id, 'cat', category), { style: 'primary' }),
        richButton.callback('« 18+ Menu', encodeCallback(id, 'menu'))
      ]);
      b.validate();
      await tracker.finish(b.toJSON());
      return { message_id: tracker.messageId };
    }

    const sid = `${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 4)}`;
    const session = rememberAdultSession({
      sid,
      mode,
      category,
      query: cleanQ || 'trending',
      page: 0,
      apiPage: page,
      sort,
      items,
      selectedIds: new Set(),
      msgId: tracker.messageId || targetMsgId || null,
      chatId,
      createdAt: Date.now()
    });
    if (tracker.messageId) ctx.screenMessageId = tracker.messageId;
    return renderAndShowAdultCinemaPage(ctx, session, 0);
  }

  async function answerCb(ctx, text = '', alert = false) {
    if (!ctx.query?.id) return;
    const api = ctx.api || app.telegram?.api;
    await api?.answerCallbackQuery?.(ctx.query.id, { text: String(text || '').slice(0, 190), show_alert: alert }).catch(() => {});
  }

  async function handleAdultPlayOrQueue(ctx, sid, idx, { playNow = true } = {}) {
    if (isGroupChat(ctx) && !isGroupNsfwAllowed(ctx)) return editOrSend(ctx, renderGroupLocked());
    if (isAgeGateRequired(ctx)) return editOrSend(ctx, renderAgeGate());

    const session = getAdultSession(sid);
    const item = session?.items?.[idx];
    if (!session || !item) return answerCb(ctx, 'Session expired — search again.', true);

    const qm = app.musicQueueManager || app.music?.queue;
    if (!app.music || !qm) return answerCb(ctx, '⚠️ VC cinema player is unavailable right now.', true);

    await answerCb(ctx, playNow ? '⏳ Loading stream into VC…' : '⏳ Adding to VC queue…');
    try {
      const dest = app.music.destination(ctx);
      await app.music.authorize(ctx, true, dest, { allowDj: true });
      await app.music.prepare(ctx, dest);
      await ensureAdultStreamResolved(item);
      const track = buildAdultTrack(item, session.mode);
      if (!track.streamUrl) throw new Error('Playable stream URL could not be resolved.');

      await qm.addMovies(dest, [track], { playNow });
      const updated = qm.getSession(dest);
      if (playNow && updated.activeDeck === 'movie') {
        const canMorph = Boolean(session.msgId && !updated.screenMessageId && Number(ctx.chatId) === Number(session.chatId));
        await app.music.player({
          ...ctx,
          ...(canMorph ? { reuseMessageId: session.msgId } : {}),
          forceNew: !canMorph && !updated.screenMessageId
        }, dest).catch(() => null);
      }
      return { ok: true, track };
    } catch (err) {
      await (ctx.api || app.telegram?.api)?.sendMessage?.(ctx.chatId, `⚠️ ${err?.message || 'Failed to stream video to VC.'}`).catch(() => {});
      return { ok: false };
    }
  }

  async function handleAdultQueueSelected(ctx, sid) {
    if (isGroupChat(ctx) && !isGroupNsfwAllowed(ctx)) return editOrSend(ctx, renderGroupLocked());
    if (isAgeGateRequired(ctx)) return editOrSend(ctx, renderAgeGate());

    const session = getAdultSession(sid);
    if (!session?.items?.length) return answerCb(ctx, 'Session expired — search again.', true);

    const qm = app.musicQueueManager || app.music?.queue;
    if (!app.music || !qm) return answerCb(ctx, '⚠️ VC queue is unavailable.', true);

    const indices = session.selectedIds.size
      ? [...session.selectedIds].sort((a, b) => a - b)
      : session.items.slice(session.page * 5, session.page * 5 + 5).map((_, i) => session.page * 5 + i);

    await answerCb(ctx, `⏳ Queueing ${indices.length} title(s) to VC…`);
    try {
      const dest = app.music.destination(ctx);
      await app.music.authorize(ctx, true, dest, { allowDj: true });
      await app.music.prepare(ctx, dest);
      const tracks = [];
      for (const idx of indices) {
        const it = session.items[idx];
        if (!it) continue;
        await ensureAdultStreamResolved(it);
        const tr = buildAdultTrack(it, session.mode);
        if (tr.streamUrl) tracks.push(tr);
      }
      if (!tracks.length) throw new Error('No playable streams resolved.');
      await qm.addMovies(dest, tracks, { playNow: false });
      const s = qm.getSession(dest);
      s.view = 'mqueue';
      await app.music.player({ ...ctx, forceNew: !s.screenMessageId }, dest).catch(() => null);
      return { ok: true, count: tracks.length };
    } catch (err) {
      await (ctx.api || app.telegram?.api)?.sendMessage?.(ctx.chatId, `⚠️ ${err?.message || 'Could not queue titles.'}`).catch(() => {});
      return { ok: false };
    }
  }

  async function handleAdultDownloadSingle(ctx, sid, idx) {
    if (isGroupChat(ctx) && !isGroupNsfwAllowed(ctx)) return editOrSend(ctx, renderGroupLocked());
    if (isAgeGateRequired(ctx)) return editOrSend(ctx, renderAgeGate());

    const session = getAdultSession(sid);
    const item = session?.items?.[idx];
    if (!session || !item) return answerCb(ctx, 'Session expired — search again.', true);
    if (!app.movieDownloader) return answerCb(ctx, '⚠️ Downloader module unavailable.', true);

    await answerCb(ctx, '⬇️ Preparing MP4 upload…');
    try {
      await ensureAdultStreamResolved(item);
      const track = buildAdultTrack(item, session.mode);
      const res = await app.movieDownloader.sendSingleVideo(ctx, track, {
        spoiler: isGroupChat(ctx)
      });
      if (!res?.ok) {
        await (ctx.api || app.telegram?.api)?.sendMessage?.(ctx.chatId, `⚠️ Download failed: ${res?.reason || 'stream unavailable'}`).catch(() => {});
      }
      return res;
    } catch (err) {
      await (ctx.api || app.telegram?.api)?.sendMessage?.(ctx.chatId, `⚠️ ${err?.message || 'Download failed.'}`).catch(() => {});
      return { ok: false };
    }
  }

  async function handleAdultDownloadSlides(ctx, sid, slidePage = 0) {
    if (isGroupChat(ctx) && !isGroupNsfwAllowed(ctx)) return editOrSend(ctx, renderGroupLocked());
    if (isAgeGateRequired(ctx)) return editOrSend(ctx, renderAgeGate());

    const session = getAdultSession(sid);
    if (!session?.items?.length) return answerCb(ctx, 'Session expired — search again.', true);
    if (!app.movieDownloader) return answerCb(ctx, '⚠️ Downloader module unavailable.', true);

    await answerCb(ctx, '🎞 Preparing paginated video slide album…');
    try {
      if (!session.dlManifest || slidePage === 0) {
        const indices = session.selectedIds.size
          ? [...session.selectedIds].sort((a, b) => a - b)
          : session.items.slice(session.page * 5, session.page * 5 + 5).map((_, i) => session.page * 5 + i);
        const tracks = [];
        for (const idx of indices) {
          const it = session.items[idx];
          if (!it) continue;
          await ensureAdultStreamResolved(it);
          const tr = buildAdultTrack(it, session.mode);
          if (tr.streamUrl) tracks.push(tr);
        }
        session.dlManifest = {
          title: `${session.mode === 'xvideos' ? 'XVideos' : '18+ Cinema'} · ${session.query}`,
          pageSize: 4,
          items: tracks
        };
      }
      const res = await app.movieDownloader.deliverAlbumSlidePage(ctx, session, slidePage, {
        buildNavCallback: (p) => encodeCallback(id, 'acSl', session.sid, String(p)),
        backCallback: () => encodeCallback(id, 'acPg', session.sid, String(session.page || 0)),
        spoiler: isGroupChat(ctx)
      });
      if (!res?.ok) {
        await (ctx.api || app.telegram?.api)?.sendMessage?.(ctx.chatId, `⚠️ Slide upload failed: ${res?.reason || 'stream unavailable'}`).catch(() => {});
      }
      return res;
    } catch (err) {
      await (ctx.api || app.telegram?.api)?.sendMessage?.(ctx.chatId, `⚠️ ${err?.message || 'Slide album failed.'}`).catch(() => {});
      return { ok: false };
    }
  }

  function registerStateHandlers(sm) {
    sm.register(States.NSFW_SEARCH_INPUT, {
      onMessage: async (sctx, message) => {
        const text = (message.text ?? '').trim();
        if (!text) return false;

        const isGroup = Boolean(sctx.isGroup || message.chat?.type === 'group' || message.chat?.type === 'supergroup' || (sctx.chatId && Number(sctx.chatId) < 0));

        if (sctx.context?.stage === 'count') {
          const effectiveQuery = sctx.context?.query || sctx.query;
          const effectiveCategory = sctx.context?.category || 'all';
          if (/\b(continuous|infinite|explore|unlimited)\b/i.test(text)) {
            if (!isGroup && message.message_id) {
              await (sctx.api || app.telegram.api).deleteMessage(sctx.chatId, message.message_id).catch(() => {});
            }
            sctx.screenMessageId = sctx.context?.screenMessageId || sctx.screenMessageId;
            await runSearch(sctx, effectiveQuery, effectiveCategory, 'continuous');
            return true;
          }
          const parsed = parseInt(text, 10);
          if (!isNaN(parsed) && parsed > 0) {
            const capped = Math.min(200, parsed);
            if (!isGroup && message.message_id) {
              await (sctx.api || app.telegram.api).deleteMessage(sctx.chatId, message.message_id).catch(() => {});
            }
            sctx.screenMessageId = sctx.context?.screenMessageId || sctx.screenMessageId;
            await runSearch(sctx, effectiveQuery, effectiveCategory, capped);
            return true;
          }
        }

        if (isGroup) {
          // In group chat: delete bot's prompt message so outdated message higher up in GC is removed
          const botPromptMsgId = message.reply_to_message?.message_id || sctx.screenMessageId || sctx.context?.screenMessageId;
          if (botPromptMsgId) {
            await (sctx.api || app.telegram.api).deleteMessage(sctx.chatId, botPromptMsgId).catch(() => {});
          }
          const activeCat = sctx.context?.category || 'all';
          if (activeCat === NSFW_CATEGORIES.XVIDEOS_VIDEO || activeCat === NSFW_CATEGORIES.ADULT_MOVIES) {
            await runAdultCinemaSearch(sctx, activeCat, text);
            return true;
          }
          // Do NOT delete the user's message; quote it for the amount selection card
          await askCount(sctx, text, activeCat, { replyToMessageId: message.message_id });
        } else {
          // In private chat: delete user's message to maintain clean in-place screen
          if (message.message_id) {
            await (sctx.api || app.telegram.api).deleteMessage(sctx.chatId, message.message_id).catch(() => {});
          }
          const activeCat = sctx.context?.category || 'all';
          if (activeCat === NSFW_CATEGORIES.XVIDEOS_VIDEO || activeCat === NSFW_CATEGORIES.ADULT_MOVIES) {
            sctx.screenMessageId = sctx.context?.screenMessageId || sctx.screenMessageId;
            await runAdultCinemaSearch(sctx, activeCat, text);
            return true;
          }
          await askCount(sctx, text, activeCat);
        }
        return true;
      },
      onTimeout: async (sctx) => {
        await (sctx.api || app.telegram.api).sendMessage(sctx.chatId, '♡ 18+ search timed out — send a new query whenever you are ready.').catch(() => {});
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
    toggleGroupNsfw,
    async executeSearch(ctx, query, category = 'all', page = 0) {
      const q = String(query || '').trim().toLowerCase();
      if (q === 'off' || q === 'lock' || q === 'disable') return toggleGroupNsfw(ctx, false);
      if (q === 'on' || q === 'unlock' || q === 'enable') return toggleGroupNsfw(ctx, true);
      if (category === NSFW_CATEGORIES.XVIDEOS_VIDEO || category === NSFW_CATEGORIES.ADULT_MOVIES) {
        return runAdultCinemaSearch(ctx, category, query, { page });
      }
      return runSearch(ctx, query, category, 10);
    },
    async executeAdultMoviesSearch(ctx, query = '') {
      return runAdultCinemaSearch(ctx, NSFW_CATEGORIES.ADULT_MOVIES, query);
    },
    async executeXvideosSearch(ctx, query = '') {
      return runAdultCinemaSearch(ctx, NSFW_CATEGORIES.XVIDEOS_VIDEO, query);
    },
    async openAdultMovies(ctx) {
      await ctx.sm?.reset?.(ctx.tgId, { reason: 'navigate' });
      if (isGroupChat(ctx) && !isGroupNsfwAllowed(ctx)) return editOrSend(ctx, renderGroupLocked());
      if (isAgeGateRequired(ctx)) return editOrSend(ctx, renderAgeGate());
      await editOrSend(ctx, renderAdultMoviesMenu(ctx));
    },
    async openXvideosHub(ctx) {
      await ctx.sm?.reset?.(ctx.tgId, { reason: 'navigate' });
      if (isGroupChat(ctx) && !isGroupNsfwAllowed(ctx)) return editOrSend(ctx, renderGroupLocked());
      if (isAgeGateRequired(ctx)) return editOrSend(ctx, renderAgeGate());
      await editOrSend(ctx, renderXvideosMenu(ctx));
    },
    async open(ctx) {
      await ctx.sm?.reset?.(ctx.tgId, { reason: 'navigate' });
      await openMenu(ctx);
    },
    async handle(ctx, action, args) {
      switch (action) {
        case 'confirmAge':
          app.db?.setSetting?.(`nsfw.ageVerified.${ctx.tgId}`, true);
          if (ctx.query?.id) await (ctx.api || app.telegram?.api)?.answerCallbackQuery?.(ctx.query.id, { text: '🔞 Age verified!' }).catch(() => {});
          return openMenu(ctx);
        case 'toggleGroup':
          return toggleGroupNsfw(ctx);
        case 'open':
        case 'menu':
          return openMenu(ctx);
        case 'sub': {
          const subCategory = args[0] || '';
          if (isGroupChat(ctx) && !isGroupNsfwAllowed(ctx)) return editOrSend(ctx, renderGroupLocked());
          if (isAgeGateRequired(ctx)) return editOrSend(ctx, renderAgeGate());
          if (subCategory === 'hentai_wallpapers') {
            return editOrSend(ctx, renderHentaiWallpapersMenu(ctx));
          } else if (subCategory === 'hentai_videos') {
            return editOrSend(ctx, renderHentaiVideosMenu(ctx));
          } else if (subCategory === 'real_wallpapers') {
            return editOrSend(ctx, renderRealWallpapersMenu(ctx));
          } else if (subCategory === 'real_videos') {
            return editOrSend(ctx, renderRealVideosMenu(ctx));
          } else if (subCategory === 'adult_movies') {
            return editOrSend(ctx, renderAdultMoviesMenu(ctx));
          } else if (subCategory === 'xvideos') {
            return editOrSend(ctx, renderXvideosMenu(ctx));
          }
          return openMenu(ctx);
        }
        case 'cat':
        case 'searchPrompt': {
          const category = args[0] || 'all';
          if (isGroupChat(ctx) && !isGroupNsfwAllowed(ctx)) return editOrSend(ctx, renderGroupLocked());
          if (isAgeGateRequired(ctx)) return editOrSend(ctx, renderAgeGate());
          return askQuery(ctx, category);
        }
        case 'customCount': {
          const category = args[0] || 'all';
          const query = args[1] || ctx.sm?.context?.(ctx.tgId)?.query || '';
          return askCustomCount(ctx, category, query);
        }
        case 'askCountDirect': {
          const query = args[0] || '';
          const category = args[1] || 'all';
          ctx.screenMessageId = ctx.query?.message?.message_id || ctx.messageId;
          if (category === NSFW_CATEGORIES.XVIDEOS_VIDEO || category === NSFW_CATEGORIES.ADULT_MOVIES) {
            return runAdultCinemaSearch(ctx, category, query);
          }
          return askCount(ctx, query, category);
        }
        case 'xvRun': {
          const q = args[0] || 'trending';
          ctx.screenMessageId = ctx.query?.message?.message_id || ctx.messageId;
          return runAdultCinemaSearch(ctx, NSFW_CATEGORIES.XVIDEOS_VIDEO, q);
        }
        case 'amRun': {
          const q = args[0] || 'full movie';
          ctx.screenMessageId = ctx.query?.message?.message_id || ctx.messageId;
          return runAdultCinemaSearch(ctx, NSFW_CATEGORIES.ADULT_MOVIES, q);
        }
        case 'xvSo': {
          const [sid, sort] = args;
          const session = getAdultSession(sid);
          if (!session) return answerCb(ctx, 'Session expired — search again.', true);
          ctx.screenMessageId = ctx.query?.message?.message_id || session.msgId || ctx.messageId;
          return runAdultCinemaSearch(ctx, NSFW_CATEGORIES.XVIDEOS_VIDEO, session.query, { sort: sort || 'relevance' });
        }
        case 'acPg': {
          if (isGroupChat(ctx) && !isGroupNsfwAllowed(ctx)) return editOrSend(ctx, renderGroupLocked());
          if (isAgeGateRequired(ctx)) return editOrSend(ctx, renderAgeGate());
          const [sid, pg] = args;
          const session = getAdultSession(sid);
          if (!session) return answerCb(ctx, 'Session expired — search again.', true);
          await answerCb(ctx);
          return renderAndShowAdultCinemaPage(ctx, session, Number(pg) || 0);
        }
        case 'acTg': {
          const [sid, idxStr] = args;
          const session = getAdultSession(sid);
          if (!session) return answerCb(ctx, 'Session expired — search again.', true);
          const idx = Number(idxStr);
          if (session.selectedIds.has(idx)) session.selectedIds.delete(idx);
          else session.selectedIds.add(idx);
          await answerCb(ctx);
          return renderAndShowAdultCinemaPage(ctx, session, session.page);
        }
        case 'acAp': {
          const [sid, pg] = args;
          const session = getAdultSession(sid);
          if (!session) return answerCb(ctx, 'Session expired — search again.', true);
          const page = Number(pg) ?? session.page ?? 0;
          const start = page * 5;
          const end = Math.min(session.items.length, start + 5);
          const allSelected = end > start && Array.from({ length: end - start }, (_, k) => start + k).every(i => session.selectedIds.has(i));
          for (let i = start; i < end; i++) {
            if (allSelected) session.selectedIds.delete(i);
            else session.selectedIds.add(i);
          }
          await answerCb(ctx);
          return renderAndShowAdultCinemaPage(ctx, session, page);
        }
        case 'acPl':
          return handleAdultPlayOrQueue(ctx, args[0], Number(args[1]), { playNow: true });
        case 'acQu':
          return handleAdultPlayOrQueue(ctx, args[0], Number(args[1]), { playNow: false });
        case 'acQa':
          return handleAdultQueueSelected(ctx, args[0]);
        case 'acDl':
          return handleAdultDownloadSingle(ctx, args[0], Number(args[1]));
        case 'acSl':
          return handleAdultDownloadSlides(ctx, args[0], Number(args[1]) || 0);
        case 'noop':
          return answerCb(ctx);
        case 'runCount': {
          const goal = args[0] || '10';
          const category = args[1] || 'all';
          const query = args[2] || ctx.sm?.context?.(ctx.tgId)?.query || '';
          ctx.screenMessageId = ctx.query?.message?.message_id || ctx.messageId;
          return runSearch(ctx, query, category, goal);
        }
        case 'moreAlbum': {
          const searchId = args[0];
          const offset = parseInt(args[1], 10) || 0;
          const category = args[2] || 'all';
          const clickerName = ctx.query?.from?.first_name || 'User';
          if (ctx.query?.id) {
            await ctx.api.answerCallbackQuery(ctx.query.id, {
              text: `👤 ${clickerName} browsing picks ${offset + 1}–${offset + 10} ♡`
            }).catch(() => {});
          }
          return showMoreAlbum(ctx, searchId, offset, category);
        }
        case 'random': {
          const cat = args[0] || 'all';
          if (cat === NSFW_CATEGORIES.ADULT_MOVIES) {
            const pool = CATEGORY_SUGGESTIONS[NSFW_CATEGORIES.ADULT_MOVIES];
            return runAdultCinemaSearch(ctx, cat, pool[Math.floor(Math.random() * pool.length)]);
          }
          if (cat === NSFW_CATEGORIES.XVIDEOS_VIDEO) {
            const pool = CATEGORY_SUGGESTIONS[NSFW_CATEGORIES.XVIDEOS_VIDEO];
            return runAdultCinemaSearch(ctx, cat, pool[Math.floor(Math.random() * pool.length)]);
          }
          const randomPools = {
            [NSFW_CATEGORIES.REAL_WALLPAPERS]: ['asian model', 'brunette', 'blonde', 'latina', 'glamour', 'boudoir', 'baddie', 'fitness model'],
            [NSFW_CATEGORIES.REAL_CLIPS]: ['asian clip', 'latina clip', 'teaser', 'glamour preview'],
            [NSFW_CATEGORIES.REAL_FULL_VIDEOS]: ['asian', 'latina', 'blonde', 'baddie', 'brunette'],
            [NSFW_CATEGORIES.HENTAI_UNCENSORED]: ['tifa', 'tsunade', 'raiden_shogun', 'makima', 'yor_forger', 'marin_kitagawa', '2b', 'yae_miko', 'r34'],
            [NSFW_CATEGORIES.HENTAI_CENSORED]: ['waifu', 'swimsuit', 'lingerie', 'genshin_impact', 'honkai_star_rail', 'anime_girl'],
            [NSFW_CATEGORIES.HENTAI_CLIPS]: ['blowjob', 'fuck', 'anal', 'cum', 'dance'],
            [NSFW_CATEGORIES.HENTAI_FULL_VIDEOS]: ['genshin hentai', 'tifa 3d', 'overflow', 'naruto hentai'],
            all: ['tifa', 'asian model', 'genshin', 'blonde', 'tsunade', 'brunette', 'latina', 'waifu']
          };
          const pool = randomPools[cat] || randomPools.all;
          const pick = pool[Math.floor(Math.random() * pool.length)];
          return runSearch(ctx, pick, cat, 10);
        }
        case 'back':
        case 'cancel':
          activeSearches.get(ctx.tgId)?.abort();
          await ctx.sm?.cancel?.(ctx.tgId);
          return openMenu(ctx);
        default:
          return openMenu(ctx);
      }
    }
  };
}
