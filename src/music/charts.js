const DEFAULT_CACHE_TTL_MS = 20 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 3200;

const CACHE = new Map();

function cleanField(value, maxLen = 90) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function normKey(artist, title) {
  const norm = (s) => String(s || '')
    .toLowerCase()
    .replace(/\((?:feat\.|ft\.|with|official)[^)]*\)/gi, '')
    .replace(/\[(?:feat\.|ft\.|with|official)[^\]]*\]/gi, '')
    .replace(/[^a-z0-9]/g, '');
  return `${norm(artist)}::${norm(title)}`;
}

async function defaultFetchJson(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: {
        'user-agent': 'LancySpotifyDJ/1.0 (+https://t.me)',
        accept: 'application/json'
      }
    });
    if (!res.ok) throw new Error(`HTTP_${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const SPAM_CHART_RE = /\.(?:wav|mp3|flac|aac|ogg|m4a)\b|\b(?:instrumental|pistas|karaoke|type\s+beat|beat\s+only|slowed\s*\+?\s*reverb|8d\s+audio|sped\s+up|nightcore|loopable)\b/i;

export function parseDeezerTracks(payload, source = 'deezer-chart', { minPopularity = 0 } = {}) {
  const list = Array.isArray(payload?.data) ? payload.data : [];
  return list
    .map((item, idx) => {
      const title = cleanField(item?.title_short || item?.title, 80);
      const artist = cleanField(item?.artist?.name, 60);
      if (!title || !artist) return null;
      if (SPAM_CHART_RE.test(title) || SPAM_CHART_RE.test(artist) || title.length > 65) return null;
      const rank = Number.isFinite(Number(item?.position)) ? Number(item.position) : idx + 1;
      const popularity = Number(item?.rank || 0);
      if (minPopularity > 0 && popularity < minPopularity) return null;
      return {
        title,
        artist,
        album: cleanField(item?.album?.title, 70),
        artwork: item?.album?.cover_medium || item?.album?.cover || null,
        durationSeconds: Number.isFinite(Number(item?.duration)) ? Number(item.duration) : null,
        rank,
        popularity,
        genre: '',
        source
      };
    })
    .filter(Boolean);
}

export function parseAppleRssTracks(payload, source = 'apple-us') {
  const list = Array.isArray(payload?.feed?.results) ? payload.feed.results : [];
  return list
    .map((item, idx) => {
      const title = cleanField(item?.name, 80);
      const artist = cleanField(item?.artistName, 60);
      if (!title || !artist) return null;
      if (SPAM_CHART_RE.test(title) || SPAM_CHART_RE.test(artist) || title.length > 65) return null;
      const genres = Array.isArray(item?.genres) ? item.genres.map(g => cleanField(g?.name, 30)).filter(Boolean) : [];
      return {
        title,
        artist,
        album: '',
        artwork: item?.artworkUrl100 || null,
        durationSeconds: null,
        rank: idx + 1,
        popularity: Math.max(1000, 1_000_000 - idx * 25_000),
        genre: genres[0] || '',
        source
      };
    })
    .filter(Boolean);
}

export function parseItunesRssTracks(payload, source = 'itunes-rss') {
  const raw = payload?.feed?.entry;
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((item, idx) => {
      const title = cleanField(item?.['im:name']?.label, 80);
      const artist = cleanField(item?.['im:artist']?.label, 60);
      if (!title || !artist) return null;
      if (SPAM_CHART_RE.test(title) || SPAM_CHART_RE.test(artist) || title.length > 65) return null;
      const imgs = Array.isArray(item?.['im:image']) ? item['im:image'] : [];
      return {
        title,
        artist,
        album: cleanField(item?.['im:collection']?.['im:name']?.label, 70),
        artwork: imgs.at(-1)?.label || imgs[0]?.label || null,
        durationSeconds: null,
        rank: idx + 1,
        popularity: Math.max(1000, 950_000 - idx * 25_000),
        genre: cleanField(item?.category?.attributes?.label, 30),
        source
      };
    })
    .filter(Boolean);
}

export function parseItunesSearchTracks(payload, source = 'itunes-search') {
  const list = Array.isArray(payload?.results) ? [...payload.results] : [];
  list.sort((a, b) => String(b?.releaseDate || '').localeCompare(String(a?.releaseDate || '')));
  return list
    .map((item, idx) => {
      const title = cleanField(item?.trackName, 80);
      const artist = cleanField(item?.artistName, 60);
      if (!title || !artist) return null;
      if (SPAM_CHART_RE.test(title) || SPAM_CHART_RE.test(artist) || title.length > 65) return null;
      const secs = Number(item?.trackTimeMillis) > 0 ? Math.round(Number(item.trackTimeMillis) / 1000) : null;
      return {
        title,
        artist,
        album: cleanField(item?.collectionName, 70),
        artwork: item?.artworkUrl100 || null,
        durationSeconds: secs,
        rank: idx + 1,
        popularity: Math.max(1000, 750_000 - idx * 20_000),
        genre: cleanField(item?.primaryGenreName, 30),
        source
      };
    })
    .filter(Boolean);
}

function deezerGenreChartId(genre = '') {
  const g = String(genre || '').toLowerCase();
  if (/\b(hip\s*hop|rap|trap|drill)\b/i.test(g)) return 116;
  if (/\br&b\b/i.test(g)) return 165;
  if (/\bsoul|funk\b/i.test(g)) return 169;
  if (/\bpop\b/i.test(g) && !/afropop/i.test(g)) return 132;
  if (/\b(dance|house|edm|techno|trance|phonk|dubstep|electro)\b/i.test(g)) return 113;
  if (/\b(reggae|dancehall)\b/i.test(g)) return 144;
  if (/\b(rock|indie|alternative)\b/i.test(g)) return 152;
  if (/\bcountry\b/i.test(g)) return 84;
  if (/\bjazz\b/i.test(g)) return 129;
  if (/\bmetal|punk\b/i.test(g)) return 464;
  if (/\b(latin|reggaeton|salsa|bachata)\b/i.test(g)) return 197;
  return null;
}

function genreHints(genre = '') {
  const g = String(genre || '').toLowerCase();
  const hints = [];
  if (/\b(afro[a-z]*|amapiano|highlife|fuji|naija|burna|wizkid|davido|rema|asake|tems|ayra)\b/i.test(g)) hints.push('ng');
  if (/\b(uk|drill|grime|garage|central cee)\b/i.test(g)) hints.push('gb');
  if (/\b(k-?pop|bts|blackpink|jennie|newjeans|stray kids)\b/i.test(g)) hints.push('kr');
  if (/\b(latin|reggaeton|bad bunny|karol g|salsa|bachata)\b/i.test(g)) hints.push('mx');
  return hints;
}

function parseSourceList(list, cleanGenre, preferredPriority = 0) {
  const basePriority = Number(preferredPriority) || 0;
  return list.map(item => {
    const tagMatch = cleanGenre && String(item.genre || '').toLowerCase().includes(cleanGenre.toLowerCase());
    return {
      ...item,
      genrePriority: Math.max(basePriority, tagMatch ? 1 : 0)
    };
  });
}

function dedupeChartItems(lists) {
  const map = new Map();
  for (const list of lists) {
    for (const item of list) {
      if (!item?.title || !item?.artist) continue;
      const key = normKey(item.artist, item.title);
      if (!key || key === '::') continue;
      const existing = map.get(key);
      if (!existing) {
        map.set(key, { ...item });
      } else {
        existing.popularity = Math.max(existing.popularity || 0, item.popularity || 0) + 150_000;
        existing.rank = Math.min(existing.rank || 999, item.rank || 999);
        if ((item.genrePriority || 0) > (existing.genrePriority || 0)) {
          existing.genrePriority = item.genrePriority || 0;
          existing.source = item.source;
        }
        if (!existing.artwork && item.artwork) existing.artwork = item.artwork;
        if (!existing.genre && item.genre) existing.genre = item.genre;
      }
    }
  }
  return [...map.values()].sort((a, b) => {
    const gpDiff = (b.genrePriority || 0) - (a.genrePriority || 0);
    if (gpDiff !== 0) return gpDiff;
    const rankDiff = (a.rank || 999) - (b.rank || 999);
    if (rankDiff !== 0) return rankDiff;
    return (b.popularity || 0) - (a.popularity || 0);
  });
}

async function settleTasksFast(tasks, { softMs = 950, hardMs = 2300, requirePriority = false } = {}) {
  const lists = [];
  let remaining = tasks.length;
  if (!remaining) return lists;
  return await new Promise((resolve) => {
    let settled = false;
    let softTimer = null;
    let hardTimer = null;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(softTimer);
      clearTimeout(hardTimer);
      resolve([...lists]);
    };
    const hasUsable = () => lists.some(l => Array.isArray(l) && l.length > 0);
    const hasPriorityHit = () => lists.some(l => Array.isArray(l) && l.some(x => (x?.genrePriority || 0) >= 1));

    hardTimer = setTimeout(done, hardMs);
    hardTimer.unref?.();
    softTimer = setTimeout(() => {
      if (hasUsable() && (!requirePriority || hasPriorityHit())) done();
    }, softMs);
    softTimer.unref?.();

    for (const p of tasks) {
      Promise.resolve(p).then((val) => {
        if (Array.isArray(val) && val.length) lists.push(val);
      }).catch(() => {}).finally(() => {
        remaining -= 1;
        if (remaining <= 0) done();
      });
    }
  });
}

/**
 * Fetch and cache real, current charting songs & artists across Deezer, Apple Music RSS & iTunes.
 * Settles early on fast feeds so channels never stall on slow upstream nodes.
 */
export async function getTrendingCharts({
  genre = '',
  limit = 15,
  fetcher = defaultFetchJson,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  skipCache = false
} = {}) {
  const cleanGenre = cleanField(genre, 60);
  const isSpecificGenre = Boolean(cleanGenre && !/^(late night studio mix|trending|top hits|global hits|general|spotify mix|all)$/i.test(cleanGenre));
  const cacheKey = isSpecificGenre ? cleanGenre.toLowerCase() : '__global__';
  const now = Date.now();
  const cached = CACHE.get(cacheKey);
  if (!skipCache && cached && now < cached.expiresAt) {
    return cached.items.slice(0, limit);
  }

  try {
    const hintedRegions = isSpecificGenre ? genreHints(cleanGenre) : [];
    const regions = [...new Set(['us', ...hintedRegions])];
    const tasks = [
      fetcher('https://api.deezer.com/chart/0/tracks?limit=25')
        .then(d => parseSourceList(parseDeezerTracks(d, 'deezer-global'), cleanGenre, 0)),
      ...regions.map(region =>
        fetcher(`https://rss.marketingtools.apple.com/api/v2/${region}/music/most-played/25/songs.json`)
          .then(d => parseSourceList(
            parseAppleRssTracks(d, `apple-${region}`),
            cleanGenre,
            hintedRegions.includes(region) ? 3 : 0
          ))
      ),
      ...hintedRegions.map(region =>
        fetcher(`https://itunes.apple.com/${region}/rss/topsongs/limit=25/json`)
          .then(d => parseSourceList(parseItunesRssTracks(d, `itunes-rss-${region}`), cleanGenre, 2))
      )
    ];

    const genreChartId = isSpecificGenre ? deezerGenreChartId(cleanGenre) : null;
    if (genreChartId) {
      tasks.unshift(
        fetcher(`https://api.deezer.com/chart/${genreChartId}/tracks?limit=25`)
          .then(d => parseSourceList(parseDeezerTracks(d, `deezer-chart-${genreChartId}`), cleanGenre, 3))
      );
    } else if (isSpecificGenre) {
      tasks.unshift(
        fetcher(`https://api.deezer.com/search?q=${encodeURIComponent(cleanGenre)}&order=RANKING&limit=20`)
          .then(d => parseSourceList(
            parseDeezerTracks(d, `deezer-${cleanGenre.toLowerCase()}`, { minPopularity: 250000 }),
            cleanGenre,
            1
          )),
        fetcher(`https://itunes.apple.com/search?term=${encodeURIComponent(cleanGenre)}&entity=song&limit=15&country=${hintedRegions[0] || 'us'}`)
          .then(d => parseSourceList(
            parseItunesSearchTracks(d, `itunes-${cleanGenre.toLowerCase()}`),
            cleanGenre,
            1
          ))
      );
    }

    const allLists = await settleTasksFast(tasks, {
      softMs: isSpecificGenre ? 1650 : 950,
      hardMs: 2400,
      requirePriority: isSpecificGenre
    });
    let merged = dedupeChartItems(allLists);

    void Promise.allSettled(tasks).then((settled) => {
      const fullLists = settled.filter(s => s.status === 'fulfilled').map(s => s.value);
      const fullMerged = dedupeChartItems(fullLists);
      const upgradedPriority = (fullMerged[0]?.genrePriority || 0) > (merged[0]?.genrePriority || 0);
      if (fullMerged.length > merged.length || upgradedPriority) {
        CACHE.set(cacheKey, { items: fullMerged, expiresAt: Date.now() + cacheTtlMs });
      }
    }).catch(() => {});

    if (!merged.length && cached?.items?.length) {
      return cached.items.slice(0, limit);
    }

    if (merged.length) {
      CACHE.set(cacheKey, { items: merged, expiresAt: now + cacheTtlMs });
    }
    return merged.slice(0, limit);
  } catch {
    return cached?.items?.slice(0, limit) || [];
  }
}

function normStr(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s*-\s*topic$/i, '')
    .replace(/[^a-z0-9]/g, '');
}

const PURE_GENRE_OR_MOOD_RE = /^(?:afrobeats?|afropop|afro[\s-]*fusion|afro[\s-]*house|amapiano|highlife|fuji|gospel|hip[\s-]*hop|rap|trap|drill|r&b|rnb|soul|pop|dance\s*pop|k-?pop|j-?pop|latin(?:\s*pop)?|reggaeton|dancehall|reggae|rock|alternative(?:\s*rock)?|indie(?:\s*rock)?|metal|punk|jazz|blues|funk|disco|house|deep\s*house|techno|trance|edm|dubstep|drum\s*and\s*bass|uk\s*garage|lo-?fi|chillhop|ambient|classical|piano|instrumental|acoustic|country|folk|world\s*music|bossa\s*nova|sad\s*songs?|love\s*songs?|heartbreak|workout|party|sleep|study|gaming|throwbacks?|phonk|soundtracks?|global(?:\s*top)?|top\s*hits|trending|all)$/i;
const GENERIC_PHRASE_RE = /\b(?:studio\s*mix|late\s*night|sunset|sunrise|midnight|groove|session|chill(?:\s*mix|\s*vibes)?|workout|party\s*mix|study\s*beats|sleep\s*music|gaming\s*mix|meditation|relaxing|soundtrack|throwback|hot\s*\d+|top\s*\d+|chart|trending|lofi|lo-fi|vibes?)\b/i;

export function stripArtistSearchNoise(query = '') {
  return cleanField(query, 80)
    .replace(/\b(?:all\s*songs?|a\s*to\s*z|full\s*catalog|discography|top\s*hits|best\s*songs?|songs?|tracks?|playlist|radio|mix|music)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isLikelyArtistQuery(query = '', knownCategories = []) {
  const clean = cleanField(query, 80);
  if (!clean || clean.length < 2) return false;
  const lower = clean.toLowerCase();
  if (Array.isArray(knownCategories) && knownCategories.some(c => String(c || '').toLowerCase() === lower)) return false;
  if (GENERIC_PHRASE_RE.test(clean) || PURE_GENRE_OR_MOOD_RE.test(clean)) return false;
  const stripped = stripArtistSearchNoise(clean);
  if (!stripped || stripped.length < 2) return false;
  if (PURE_GENRE_OR_MOOD_RE.test(stripped)) return false;
  if (Array.isArray(knownCategories) && knownCategories.some(c => String(c || '').toLowerCase() === stripped.toLowerCase())) return false;
  return stripped.split(' ').length <= 4;
}

export async function getArtistCatalogAndRelated(
  artistQuery,
  { fetcher = defaultFetchJson, limit = 60, cacheTtlMs = DEFAULT_CACHE_TTL_MS, useCache = fetcher === defaultFetchJson, knownCategories = [] } = {}
) {
  const candidate = stripArtistSearchNoise(artistQuery) || cleanField(artistQuery, 80);
  const candNorm = normStr(candidate);
  if (!candNorm || !isLikelyArtistQuery(candidate, knownCategories)) {
    return { found: false, artist: '', genre: '', tracks: [], relatedArtists: [] };
  }

  const cacheKey = `artist:${candNorm}`;
  const now = Date.now();
  const cached = useCache ? CACHE.get(cacheKey) : null;
  if (cached && cached.expiresAt > now) {
    return {
      ...cached.value,
      tracks: (cached.value.tracks || []).slice(0, limit)
    };
  }

  try {
    const [dzSearchRes, itunesRes] = await Promise.allSettled([
      fetcher(`https://api.deezer.com/search/artist?q=${encodeURIComponent(candidate)}&limit=5`, 2200),
      fetcher(`https://itunes.apple.com/search?term=${encodeURIComponent(candidate)}&entity=song&attribute=artistTerm&limit=60`, 2400)
    ]);

    const dzArtists = dzSearchRes.status === 'fulfilled' && Array.isArray(dzSearchRes.value?.data)
      ? dzSearchRes.value.data
      : [];

    let matchedDzArtist = null;
    let bestScore = -1;
    for (const a of dzArtists) {
      const aNorm = normStr(a?.name);
      if (!aNorm) continue;
      const fans = Number(a?.nb_fan || 0);
      let score = -1;
      if (aNorm === candNorm) score = 1_000_000_000 + fans;
      else if ((aNorm.startsWith(candNorm) || candNorm.startsWith(aNorm)) && fans >= 1000) score = 100_000_000 + fans;
      else if ((aNorm.includes(candNorm) || candNorm.includes(aNorm)) && fans >= 5000) score = 10_000_000 + fans;
      if (score > bestScore) {
        bestScore = score;
        matchedDzArtist = a;
      }
    }

    let dzTopTracks = [];
    let dzRelated = [];
    if (matchedDzArtist?.id) {
      const [topRes, relRes] = await Promise.allSettled([
        fetcher(`https://api.deezer.com/artist/${matchedDzArtist.id}/top?limit=50`, 2200),
        fetcher(`https://api.deezer.com/artist/${matchedDzArtist.id}/related?limit=25`, 2200)
      ]);
      if (topRes.status === 'fulfilled') dzTopTracks = parseDeezerTracks(topRes.value, 'deezer-artist-top');
      if (relRes.status === 'fulfilled' && Array.isArray(relRes.value?.data)) {
        dzRelated = relRes.value.data
          .map(r => ({
            name: cleanField(r?.name, 60),
            fanCount: Number(r?.nb_fan || 0)
          }))
          .filter(r => r.name && normStr(r.name) !== candNorm);
      }
    }

    const rawItunes = itunesRes.status === 'fulfilled' ? parseItunesSearchTracks(itunesRes.value, 'itunes-artist-catalog') : [];
    const targetNorm = normStr(matchedDzArtist?.name || candidate);
    const matchesTargetArtist = (artistName = '') => {
      const tokens = String(artistName || '')
        .split(/[,&]|feat\.?|ft\./i)
        .map(normStr)
        .filter(Boolean);
      const full = normStr(artistName);
      return Boolean(targetNorm && (full === targetNorm || tokens.includes(targetNorm)));
    };
    const matchingItunes = rawItunes.filter(t => matchesTargetArtist(t.artist));

    if (!matchedDzArtist && matchingItunes.length < 2) {
      return { found: false, artist: '', genre: '', tracks: [], relatedArtists: [] };
    }

    const canonicalArtist = cleanField(matchedDzArtist?.name || matchingItunes[0]?.artist || candidate, 60);
    const canonNorm = normStr(canonicalArtist);

    // Dominant genre from iTunes catalog metadata
    const genreCounts = new Map();
    for (const item of matchingItunes) {
      const g = cleanField(item.genre, 40);
      if (!g || /^music$/i.test(g)) continue;
      genreCounts.set(g, (genreCounts.get(g) || 0) + 1);
    }
    const sortedGenres = [...genreCounts.entries()].sort((a, b) => b[1] - a[1]);
    let genre = sortedGenres[0]?.[0] || '';
    if (!genre) {
      const hints = genreHints(canonicalArtist);
      if (hints.includes('ng')) genre = 'Afrobeats';
      else if (hints.includes('gb')) genre = 'UK Rap';
      else if (hints.includes('kr')) genre = 'K-Pop';
      else if (hints.includes('mx')) genre = 'Latin';
    }

    // Order artist catalog: Top hits first (Deezer ranked #1..50), then deep catalog from iTunes without duplicates
    const combinedDz = dzTopTracks
      .filter(t => matchesTargetArtist(t.artist))
      .map((t, idx) => ({ ...t, genrePriority: 2, rank: idx + 1 }));
    const combinedIt = matchingItunes.map((t, idx) => ({ ...t, genrePriority: 1, rank: 100 + idx }));
    const tracks = dedupeChartItems([combinedDz, combinedIt]);

    // Related artists: Deezer "Fans Also Like" + genre chart peers fallback
    const relatedMap = new Map();
    for (const r of dzRelated) {
      const rn = normStr(r.name);
      if (!rn || rn === canonNorm || relatedMap.has(rn)) continue;
      relatedMap.set(rn, { name: r.name, fanCount: r.fanCount, genre });
    }
    if (relatedMap.size < 2 && genre) {
      const genrePeers = await getTrendingCharts({ genre, limit: 15, fetcher, skipCache: !useCache }).catch(() => []);
      for (const item of genrePeers.filter(x => (x?.genrePriority || 0) >= 1)) {
        const peerName = cleanField(String(item.artist || '').split(/[,&]|feat\.?|ft\./i)[0], 60);
        const pn = normStr(peerName);
        if (!pn || pn === canonNorm || relatedMap.has(pn)) continue;
        relatedMap.set(pn, { name: peerName, fanCount: 0, genre: item.genre || genre });
        if (relatedMap.size >= 15) break;
      }
    }

    const relatedArtists = [...relatedMap.values()].slice(0, 20);
    const result = {
      found: Boolean(canonicalArtist && (tracks.length || relatedArtists.length)),
      artist: canonicalArtist,
      genre,
      tracks,
      relatedArtists
    };
    if (useCache && result.found) {
      CACHE.set(cacheKey, { value: result, expiresAt: Date.now() + cacheTtlMs });
    }
    return {
      ...result,
      tracks: result.tracks.slice(0, limit)
    };
  } catch {
    return { found: false, artist: '', genre: '', tracks: [], relatedArtists: [] };
  }
}

export function formatTrendingForPrompt(items = [], maxItems = 10) {
  const slice = (items || []).slice(0, maxItems);
  if (!slice.length) return '';
  return slice.map((item, idx) => `${idx + 1}. ${item.artist} - ${item.title}`).join('\n');
}

export function clearChartsCache() {
  CACHE.clear();
}
