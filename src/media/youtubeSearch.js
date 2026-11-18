export function parseCompactCount(text) {
  const raw = String(text || '').replace(/,/g, '').trim();
  if (!raw) return 0;
  const m = raw.match(/(\d+(?:\.\d+)?)\s*([kmb])?/i);
  if (!m) return 0;
  const num = Number(m[1]);
  if (!Number.isFinite(num)) return 0;
  const unit = (m[2] || '').toLowerCase();
  const mult = unit === 'b' ? 1e9 : unit === 'm' ? 1e6 : unit === 'k' ? 1e3 : 1;
  return Math.round(num * mult);
}

export function parsePublishedAgeDays(text) {
  const raw = String(text || '').toLowerCase();
  if (!raw) return null;
  const m = raw.match(/(\d+)\s*(second|minute|hour|day|week|month|year)s?\s+ago/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  switch (m[2]) {
    case 'second':
    case 'minute': return 0;
    case 'hour': return Number((n / 24).toFixed(2));
    case 'day': return n;
    case 'week': return n * 7;
    case 'month': return n * 30;
    case 'year': return n * 365;
    default: return null;
  }
}

export const NON_MUSIC_TITLE_RE = /\b(breaking\s*news|news\s*(?:update|report|bulletin|live|hour|today|night|channel|room|at\s*\d+|brief|coverage|digest|anchor|desk|headline)|full\s*news|headline\s*news|top\s*stories|press\s*conference|white\s*house|parliament|senate|congress|supreme\s*court|election\s*results?|presidential\s*debate|impeachment|arraigned|efcc|ndlea|police\s*(?:arrest|bodycam|report|chase|shooting)|suspect\s*arrested|court\s*(?:hearing|trial|footage|room|update)|courtroom|sentenc(?:ed|ing)|verdict|indict(?:ed|ment)|mugshot|autopsy|coroner|case\s*update|jail\s*call|leaked\s*(?:call|footage|video|audio)|weather\s*forecast|stock\s*market|crypto\s*news|sports?\s*news|match\s*highlights|post[\s-]*match|pre[\s-]*match|transfer\s*news|full\s*documentary|crime\s*documentary|true\s*crime|the\s*story\s*of|rise\s*and\s*fall|what\s*really\s*happened|memorial\s*service|funeral|full\s*episode|season\s*\d+\s*episode|s\d+e\d+|movie\s*trailer|official\s*trailer|teaser\s*trailer|full\s*movie|nollywood|bollywood\s*movie|sermon|sunday\s*service|bible\s*study|morning\s*devotion|unboxing|tech\s*review|gameplay\s*walkthrough|podcast|full\s*interview|sit[\s-]*down\s*interview)\b/i;

export const NEWS_CHANNEL_RE = /\b(bbc\s*news|cnn|arise\s*news|channels\s*television|channels\s*tv|tvc\s*news|ait\s*live|nta\s*news|sky\s*news|fox\s*news|msnbc|cnbc|nbc\s*news|abc\s*news|cbs\s*news|al\s*jazeera|reuters|associated\s*press|dw\s*news|france\s*24|wion|ndtv|india\s*today|times\s*now|citizen\s*tv|ktn\s*news|ntv\s*kenya|sabc\s*news|enca|joy\s*news|citi\s*tube|utv\s*ghana|bloomberg|financial\s*times|wall\s*street\s*journal|washington\s*post|new\s*york\s*times|guardian\s*news|telegraph|daily\s*mail|tmz|inside\s*edition|law\s*&\s*crime|court\s*tv|espn|sky\s*sports|supersport|bein\s*sports|dazn|dj\s*akademiks|akademiks\s*tv|vladtv|djvlad|no\s*jumper|say\s*cheese|trap\s*lore\s*ross|domislive|the\s*shade\s*room|complex\s*news|genius\s*news|hollywood\s*unlocked|hiphopdx|hotnewhiphop\s*news|breakfast\s*club|joe\s*budden|patrick\s*cc|explore\s*with\s*us)\b/i;

const MUSIC_TALK_SPAM_RE = /\b(reaction|reacts\s*to|interview|podcast|review|explained|tutorial|breakdown|tier\s*list|top\s*10|ranking|documentary|ai\s*cover|ai\s*version|type\s*beat|karaoke|1\s*hour|2\s*hours|\d+\s*hours|megamix|full\s*album)\b/i;

export function isNonMusicOrNews(title, author = '', query = '') {
  const q = String(query || '').toLowerCase();
  if (/\b(news|documentary|trailer|sermon|podcast|interview)\b/i.test(q)) return false;
  const t = String(title || '');
  const a = String(author || '');
  if (NON_MUSIC_TITLE_RE.test(t) || NEWS_CHANNEL_RE.test(a) || NEWS_CHANNEL_RE.test(t)) return true;
  if (MUSIC_TALK_SPAM_RE.test(t) && !/\b(reaction|interview|podcast|review|explained|tutorial|documentary|ai\s*cover|type\s*beat|karaoke|full\s*album|megamix)\b/i.test(q)) {
    return true;
  }
  return false;
}

/**
 * Fast & Wide YouTube InnerTube Video & Music Search
 * Queries InnerTube regional + global catalogs concurrently (<150ms) with zero heavy browser emulation.
 */
async function fetchInnerTubePage(query, gl = 'US', sp = null) {
  const body = {
    context: {
      client: {
        clientName: 'WEB',
        clientVersion: '2.20240726.00.00',
        hl: 'en',
        gl: String(gl || 'US').toUpperCase()
      }
    },
    query
  };
  if (sp) body.params = sp;

  const res = await fetch('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(1700)
  });
  if (!res.ok) return [];
  const data = await res.json();
  const videos = [];
  const seen = new Set();

  function walk(node) {
    if (!node || typeof node !== 'object') return;
    const shelfTitle = node.shelfRenderer?.title?.simpleText || node.shelfRenderer?.title?.runs?.[0]?.text || node.richShelfRenderer?.title?.simpleText || node.richShelfRenderer?.title?.runs?.[0]?.text || '';
    if (shelfTitle && /\b(breaking\s*news|top\s*news|news|shorts)\b/i.test(shelfTitle)) return;
    if (node.videoId && (node.title || node.headline)) {
      const vid = String(node.videoId).replace(/^shorts-lockup-/, '').replace(/^shorts-shelf-item-/, '');
      if (vid.length === 11 && !seen.has(vid)) {
        seen.add(vid);
        const title = node.title?.runs?.[0]?.text || node.title?.simpleText || node.headline?.simpleText || '';
        const isLive = Boolean(
          node.badges?.some(b => /live/i.test(b?.metadataBadgeRenderer?.label || b?.label || '')) ||
          node.thumbnailOverlays?.some(o => o?.thumbnailOverlayTimeStatusRenderer?.style === 'LIVE') ||
          /watching/i.test(node.viewCountText?.runs?.[0]?.text || node.viewCountText?.simpleText || '') ||
          /\b(24\/7|\blive\s*(now|stream)?\b)/i.test(title)
        );
        const isArtistChannel = Boolean(
          node.ownerBadges?.some(b => /ARTIST/i.test(b?.metadataBadgeRenderer?.style || '') || /artist/i.test(b?.metadataBadgeRenderer?.tooltip || ''))
        );
        const duration = isLive ? 'LIVE' : (node.lengthText?.simpleText || 'HD');
        const views = node.viewCountText?.simpleText || node.shortViewCountText?.simpleText || '';
        const viewCount = parseCompactCount(views);
        const publishedText = node.publishedTimeText?.simpleText || node.publishedTimeText?.runs?.[0]?.text || '';
        const publishedAgeDays = parsePublishedAgeDays(publishedText);
        const rawAuthor = node.ownerText?.runs?.[0]?.text || node.shortBylineText?.runs?.[0]?.text || 'Music';
        const author = String(rawAuthor).split(/\s+\.\s+\d/)[0].trim() || 'Music';
        const thumb = node.thumbnail?.thumbnails?.pop()?.url || `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;
        if (title && !isNonMusicOrNews(title, author, query)) {
          videos.push({ videoId: vid, title, duration, views, viewCount, publishedText, publishedAgeDays, author, thumb, isLive, isArtistChannel });
        }
      }
    } else if (node.shortsLockupViewModel) {
      const vm = node.shortsLockupViewModel;
      let vid = String(vm.entityId || '').replace(/^shorts-lockup-/, '').replace(/^shorts-shelf-item-/, '');
      if (!vid && vm.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId) {
        vid = vm.onTap.innertubeCommand.reelWatchEndpoint.videoId;
      }
      if (vid && vid.length === 11 && !seen.has(vid)) {
        seen.add(vid);
        const title = vm.overlayMetadata?.primaryText?.content || '';
        const views = vm.overlayMetadata?.secondaryText?.content || '';
        const thumb = vm.thumbnail?.sources?.pop()?.url || `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;
        if (title) {
          videos.push({ videoId: vid, title, duration: 'Short', views, viewCount: parseCompactCount(views), publishedText: '', publishedAgeDays: null, author: 'Shorts', thumb });
        }
      }
    }
    for (const k of Object.keys(node)) {
      walk(node[k]);
    }
  }

  walk(data);
  return videos;
}

async function settleInnerTubeFast(tasks, { softMs = 950, minItems = 5 } = {}) {
  if (!tasks.length) return [];
  const results = new Array(tasks.length).fill(null);
  let settledCount = 0;
  let softElapsed = false;

  const uniqueCount = () => {
    const seen = new Set();
    for (const list of results) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (item?.videoId) seen.add(item.videoId);
      }
    }
    return seen.size;
  };

  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(softTimer);
      resolve();
    };
    const maybeFinish = () => {
      if (settledCount >= tasks.length || (softElapsed && uniqueCount() >= minItems)) {
        finish();
      }
    };
    const softTimer = setTimeout(() => {
      softElapsed = true;
      maybeFinish();
    }, softMs);
    softTimer.unref?.();

    tasks.forEach((p, idx) => {
      Promise.resolve(p)
        .then((val) => { results[idx] = Array.isArray(val) ? val : []; })
        .catch(() => { results[idx] = []; })
        .finally(() => {
          settledCount += 1;
          maybeFinish();
        });
    });
  });

  const merged = [];
  const seen = new Set();
  for (const list of results) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (item?.videoId && !seen.has(item.videoId)) {
        seen.add(item.videoId);
        merged.push(item);
      }
    }
  }
  return merged;
}

export async function searchYouTubeFast(query, gl = 'US', { wide = true, radio = false, filterDuration = null, video = false } = {}) {
  const clean = String(query || '').replace(/[—–]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return [];

  try {
    const isTikTokOrClip = /\b(tiktok|shorts|reel|reels|clip|compilation|edit|dance)\b/i.test(clean);
    const isAmbientOrSleep = /\b(sleep|relax|chill|ambient|zen|meditation|koto|guzheng|flute|instrumental|study|lo-fi|lofi|bgm|piano)\b/i.test(clean);
    const useDurationFilter = filterDuration === 'medium' || radio || isAmbientOrSleep;
    const sp = useDurationFilter ? 'EgIYAw%3D%3D' : null;
    const altGl = String(gl || 'US').toUpperCase() === 'NG' ? 'US' : 'NG';

    const tasks = [];
    if (video && !isTikTokOrClip) {
      const hasVideoWord = /\b(official\s*(music\s*)?video|\bmv\b|\bm\/v\b)\b/i.test(clean);
      const needsMusicCtx = radio && !/\b(songs?|music|hits?|track|official)\b/i.test(clean);
      const mvQuery = hasVideoWord ? clean : (needsMusicCtx ? `${clean} hits official music video` : `${clean} official music video`);
      if (!radio && !hasVideoWord) {
        // Prefer Official Music Video first, plus exact song/audio fallback so audio-only/visualizer releases are never missed and news never appears
        const hasSongContext = /\b(by|ft|feat|song|music|audio|video|remix)\b/i.test(clean) || clean.trim().split(/\s+/).length >= 3;
        tasks.push(fetchInnerTubePage(mvQuery, gl, sp));
        tasks.push(fetchInnerTubePage(hasSongContext ? clean : `${clean} song`, gl, sp));
        if (wide) {
          tasks.push(fetchInnerTubePage(`${clean} official audio`, gl, sp));
          tasks.push(fetchInnerTubePage(mvQuery, altGl, sp));
        }
      } else {
        tasks.push(fetchInnerTubePage(mvQuery, gl, sp));
        if (wide) {
          tasks.push(fetchInnerTubePage(mvQuery, altGl, sp));
          if (radio && !/\b(trending|classic|throwback|old|top)\b/i.test(clean)) {
            tasks.push(fetchInnerTubePage(`${clean} trending hits official music video`, altGl, sp));
          } else if (!hasVideoWord) {
            tasks.push(fetchInnerTubePage(clean, gl, sp));
          }
        }
      }
    } else {
      tasks.push(fetchInnerTubePage(clean, gl, sp));
      if (wide) {
        tasks.push(fetchInnerTubePage(clean, altGl, sp));
        if (!isTikTokOrClip && !/\b(song|audio|official|lyrics|track)\b/i.test(clean)) {
          tasks.push(fetchInnerTubePage(`${clean} official audio`, gl, sp));
        }
      }
    }

    const merged = await settleInnerTubeFast(tasks, { softMs: 950, minItems: 5 });
    if (merged.length > 0) return merged;
  } catch {}

  try {
    const { yts } = await import('btch-downloader');
    const res = await yts(clean);
    const vids = res?.result?.videos || res?.result?.all || [];
    return vids.map((v) => ({
      videoId: v.videoId || (v.url ? v.url.split('v=')[1] : ''),
      title: v.title || clean,
      duration: v.timestamp || v.duration?.timestamp || 'HD',
      views: v.views ? String(v.views) : '',
      viewCount: Number(v.views) || 0,
      publishedText: v.ago || '',
      publishedAgeDays: parsePublishedAgeDays(v.ago || ''),
      author: v.author?.name || 'Music',
      thumb: v.thumbnail || v.image || ''
    })).filter((v) => Boolean(v.videoId) && !isNonMusicOrNews(v.title, v.author, clean));
  } catch {
    return [];
  }
}
