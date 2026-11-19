const CATEGORY_DEFS = [
  { keys: ['romance', 'romantic', 'love story', 'love stories', 'romcom', 'rom-com'], category: 'romance', genreId: 10749, label: 'Romance & Drama' },
  { keys: ['action'], category: 'action', genreId: 28, label: 'Action & High Octane' },
  { keys: ['comedy', 'comedies', 'funny'], category: 'comedy', genreId: 35, label: 'Comedy & Entertainment' },
  { keys: ['horror', 'scary'], category: 'horror', genreId: 27, label: 'Horror & Supernatural' },
  { keys: ['sci-fi', 'scifi', 'science fiction'], category: 'scifi', genreId: 878, label: 'Sci-Fi & Cyberpunk' },
  { keys: ['thriller', 'thrillers', 'crime', 'mystery'], category: 'thriller', genreId: 53, label: 'Crime, Mystery & Thrillers' },
  { keys: ['drama', 'dramas'], category: null, genreId: 18, label: 'Drama' },
  { keys: ['animation', 'animated', 'cartoon', 'cartoons'], category: null, genreId: 16, label: 'Animation' },
  { keys: ['adventure'], category: null, genreId: 12, label: 'Adventure' },
  { keys: ['fantasy'], category: null, genreId: 14, label: 'Fantasy' },
  { keys: ['war'], category: null, genreId: 10752, label: 'War & History' },
  { keys: ['western'], category: null, genreId: 37, label: 'Western' },
  { keys: ['documentary', 'documentaries'], category: 'documentary', genreId: 99, label: 'Documentaries & Real Life' },
  { keys: ['family', 'kids'], category: 'family', genreId: 10751, label: 'Family & Kids' },
  { keys: ['anime'], category: 'anime', genreId: 16, label: 'Anime Movies & Series' },
  { keys: ['donghua'], category: 'donghua', genreId: 16, label: 'Chinese Donghua Animation' },
  { keys: ['korean', 'kdrama', 'k-drama', 'kdramas', 'k-dramas'], category: 'korean', genreId: null, label: 'Korean Cinema & K-Drama' },
  { keys: ['nollywood'], category: 'nollywood', genreId: null, label: 'Nollywood & African Cinema' },
  { keys: ['bollywood'], category: 'bollywood', genreId: null, label: 'Bollywood & Indian Cinema' },
  { keys: ['hollywood'], category: 'hollywood', genreId: null, label: 'Hollywood & Western' },
  { keys: ['chinese', 'wuxia'], category: 'chinese', genreId: null, label: 'Chinese Cinema & Wuxia' },
  { keys: ['classics', 'classic'], category: 'classics', genreId: null, label: 'Golden Age Classics' }
];

const CATEGORY_MAP = new Map();
for (const def of CATEGORY_DEFS) {
  for (const k of def.keys) CATEGORY_MAP.set(k, def);
}

const LEAD_CMD_RE = /^(?:(?:please|can\s+you|could\s+you|would\s+you|help(?:\s+me)?)\s+)*(?:give|find|get|show|send|bring|recommend|suggest|search(?:\s+for)?|look(?:\s+for)?|stream|watch|play|put\s+on|open|load)(?:\s+for)?(?:\s+me)?\s+(?:(?:the|some|any|a|good|best|top|latest|new|popular)\s+)*(?:(?:movies?|films?|series|tv\s*shows?|shows?|cinema)\s+(?:like|about|called|named|titled)\s+)?/i;
const STRAY_ME_GENRE_RE = /^me\s+(?:(?:some|any|a|good|best|top|latest|new|popular)\s+)*([a-z][a-z\s-]{1,28}?)\s*(?:movies?|films?|series|tv\s*shows?|shows?|cinema)?$/i;
const MEDIA_SUFFIX_RE = /\s*(?:\b(?:full\s+)?(?:movies?|films?|tv\s*shows?|series|shows?|cinema)\b(?:\s+(?:in|on)\s+vc)?|\b(?:in|on)\s+vc\b|\bplease\b|\bfor\s+me\b)+\s*$/gi;

export function lookupMovieCategory(raw) {
  const key = String(raw || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return CATEGORY_MAP.get(key) || null;
}

/**
 * Extracts explicit season/episode markers (e.g. "S02E02", "S2 E2", "Season 2 Episode 2", "Ep 5")
 * and returns `{ title, season, episode }`.
 */
export function extractSeasonEpisodeHint(raw) {
  let s = String(raw || '').trim();
  if (!s) return { title: '', season: null, episode: null };
  let season = null;
  let episode = null;

  const seMatch = s.match(/(?:^|\s)[[(]?\bS(\d{1,2})[\s._-]*E(?:P)?(\d{1,3})\b[\])]?(?=\s|$)/i);
  if (seMatch) {
    season = Number(seMatch[1]);
    episode = Number(seMatch[2]);
    s = s.replace(seMatch[0], ' ');
  } else {
    const longSeMatch = s.match(/\bseason[\s:-]*(\d{1,2})[\s,:-]*(?:episode|ep)[\s:-]*(\d{1,3})\b/i);
    if (longSeMatch) {
      season = Number(longSeMatch[1]);
      episode = Number(longSeMatch[2]);
      s = s.replace(longSeMatch[0], ' ');
    } else {
      const seasonOnly = s.match(/\bseason[\s:-]*(\d{1,2})\b/i);
      const epOnly = s.match(/\b(?:episode|ep)[\s.:#-]*(\d{1,3})\b/i);
      if (seasonOnly) {
        season = Number(seasonOnly[1]);
        s = s.replace(seasonOnly[0], ' ');
      }
      if (epOnly) {
        episode = Number(epOnly[1]);
        s = s.replace(epOnly[0], ' ');
      }
    }
  }

  const cleanTitle = s.replace(/\s+/g, ' ').replace(/^[\s:,-]+|[\s:,-]+$/g, '').trim();
  return {
    title: cleanTitle || String(raw || '').trim(),
    season: Number.isFinite(season) && season >= 0 ? season : null,
    episode: Number.isFinite(episode) && episode >= 1 ? episode : null
  };
}

/**
 * Normalizes conversational movie prompts ("give me Romance movies", "me Romance movies")
 * into either a structured genre/category browse intent or a clean title search string.
 */
export function parseMovieSearchIntent(raw) {
  const original = String(raw || '').trim();
  if (!original) return { kind: 'empty', query: '' };

  const wantsTv = /\b(?:tv\s*shows?|series|shows?|k-?dramas?|kdramas?)\b/i.test(original);
  let cleaned = original;

  const strayMe = cleaned.match(STRAY_ME_GENRE_RE);
  if (strayMe) {
    const candidateCat = lookupMovieCategory(strayMe[1]);
    if (candidateCat) {
      return {
        kind: 'category',
        category: candidateCat.category,
        genreId: candidateCat.genreId,
        label: candidateCat.label,
        type: (wantsTv || candidateCat.category === 'korean') && candidateCat.genreId !== 10749 ? 'tv' : 'movie'
      };
    }
  }

  if (LEAD_CMD_RE.test(cleaned)) {
    const stripped = cleaned
      .replace(LEAD_CMD_RE, '')
      .replace(/\b(?:movies?|films?|tv\s*shows?|series|shows?)\s*$/i, '')
      .replace(/\b(?:in|on)\s+vc\b/gi, '')
      .replace(/\bplease\b/gi, '')
      .trim();
    if (stripped.length >= 2) cleaned = stripped;
  }

  const catSource = cleaned
    .replace(MEDIA_SUFFIX_RE, '')
    .replace(/^(?:some|any|good|best|top|latest|new|popular)\s+/i, '')
    .trim();
  const catMatch = lookupMovieCategory(catSource);
  if (catMatch) {
    return {
      kind: 'category',
      category: catMatch.category,
      genreId: catMatch.genreId,
      label: catMatch.label,
      type: wantsTv ? 'tv' : 'movie'
    };
  }

  const epHint = extractSeasonEpisodeHint(cleaned);
  if ((epHint.season != null || epHint.episode != null) && epHint.title && epHint.title.length >= 2) {
    return {
      kind: 'search',
      query: epHint.title,
      season: epHint.season,
      episode: epHint.episode
    };
  }

  return { kind: 'search', query: cleaned, season: null, episode: null };
}
