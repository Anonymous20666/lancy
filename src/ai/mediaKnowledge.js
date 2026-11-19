/**
 * Live Current Media, Music, Video & Stories/Dark-Romance Knowledge Service.
 *
 * Uses fast, public, no-key-required real APIs alongside Lancy's internal catalogs:
 *  - Apple iTunes Search API (current songs, artists, release dates, music videos)
 *  - TVMaze API (current TV series, seasons, casts, air dates, full summaries)
 *  - Wikipedia Search + Extracts API (movie/novel plots, folklore, artists, biographies)
 *  - OpenLibrary Search, Subjects & Works API (dark romance novels, fiction, tropes, descriptions)
 */
import { searchYouTubeFast } from '../media/youtubeSearch.js';

function cleanText(raw = '') {
  return String(raw || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const GENRE_SUBJECT_MAP = {
  dark_romance: 'dark_romance',
  'dark romance': 'dark_romance',
  romance: 'romance',
  mafia: 'mafia',
  thriller: 'thrillers',
  horror: 'horror',
  fantasy: 'fantasy',
  mystery: 'mystery',
  folklore: 'folklore',
  scifi: 'science_fiction',
  'sci-fi': 'science_fiction'
};

export async function searchItunesMusic(query, { limit = 4 } = {}) {
  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&limit=${limit}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(3500) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || []).map((r) => ({
      title: r.trackName,
      artist: r.artistName,
      album: r.collectionName,
      genre: r.primaryGenreName,
      releaseDate: String(r.releaseDate || '').slice(0, 10),
      url: r.trackViewUrl || null
    }));
  } catch {
    return [];
  }
}

export async function searchTvMaze(query, { limit = 3 } = {}) {
  try {
    const url = `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(3500) });
    if (!res.ok) return [];
    const data = await res.json();
    return (Array.isArray(data) ? data : []).slice(0, limit).map((item) => {
      const s = item?.show || {};
      return {
        title: s.name,
        genres: Array.isArray(s.genres) ? s.genres : [],
        status: s.status || null,
        premiered: s.premiered || null,
        ended: s.ended || null,
        network: s.network?.name || s.webChannel?.name || null,
        summary: cleanText(s.summary || '').slice(0, 480),
        url: s.url || null
      };
    });
  } catch {
    return [];
  }
}

export async function lookupOpenLibraryStories({ query = '', genre = '', limit = 4 } = {}) {
  const cleanQ = String(query || '').trim();
  const cleanG = String(genre || '').trim().toLowerCase();
  const subjectSlug = GENRE_SUBJECT_MAP[cleanG] || GENRE_SUBJECT_MAP[cleanQ.toLowerCase()] || '';

  try {
    let docs = [];
    if (subjectSlug && (!cleanQ || cleanQ.toLowerCase() === cleanG || cleanQ.toLowerCase() === subjectSlug.replace(/_/g, ' '))) {
      const subRes = await fetch(`https://openlibrary.org/subjects/${encodeURIComponent(subjectSlug)}.json?limit=${limit}`, {
        headers: { 'User-Agent': 'LancyBot/2.0' },
        signal: AbortSignal.timeout(4500)
      });
      if (subRes.ok) {
        const subData = await subRes.json();
        docs = (subData.works || []).map((w) => ({
          key: w.key,
          title: w.title,
          authors: (w.authors || []).map((a) => a.name).filter(Boolean),
          year: w.first_publish_year || null,
          subjects: (w.subject || []).slice(0, 5)
        }));
      }
    }

    if (!docs.length) {
      const qTerm = cleanQ || cleanG || 'dark romance';
      const sRes = await fetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(qTerm)}&limit=${limit}`, {
        headers: { 'User-Agent': 'LancyBot/2.0' },
        signal: AbortSignal.timeout(4500)
      });
      if (sRes.ok) {
        const sData = await sRes.json();
        docs = (sData.docs || []).slice(0, limit).map((d) => ({
          key: d.key,
          title: d.title,
          authors: Array.isArray(d.author_name) ? d.author_name.slice(0, 2) : [],
          year: d.first_publish_year || null,
          subjects: Array.isArray(d.subject) ? d.subject.slice(0, 5) : [],
          firstSentence: Array.isArray(d.first_sentence) ? d.first_sentence[0] : (d.first_sentence || null)
        }));
      }
    }

    // Fetch rich work synopsis/description for top work if key present
    if (docs[0]?.key) {
      const wRes = await fetch(`https://openlibrary.org${docs[0].key}.json`, {
        headers: { 'User-Agent': 'LancyBot/2.0' },
        signal: AbortSignal.timeout(3500)
      }).catch(() => null);
      if (wRes?.ok) {
        const wData = await wRes.json().catch(() => null);
        const desc = typeof wData?.description === 'string'
          ? wData.description
          : (wData?.description?.value || '');
        if (desc) docs[0].synopsis = cleanText(desc).slice(0, 1200);
      }
    }

    return docs.map((d) => ({
      ...d,
      url: d.key ? `https://openlibrary.org${d.key}` : null
    }));
  } catch {
    return [];
  }
}

export async function lookupCurrentMediaAndStories({ query = '', kind = 'all', genre = '', browser = null, app = null } = {}) {
  const cleanQ = String(query || '').trim();
  const cleanKind = String(kind || 'all').toLowerCase();

  const tasks = {
    itunes: (cleanKind === 'all' || cleanKind === 'music') && cleanQ
      ? searchItunesMusic(cleanQ, { limit: 3 })
      : Promise.resolve([]),
    youtube: (cleanKind === 'all' || cleanKind === 'video' || cleanKind === 'music') && cleanQ
      ? searchYouTubeFast(cleanQ, { limit: 3 }).catch(() => [])
      : Promise.resolve([]),
    tvmaze: (cleanKind === 'all' || cleanKind === 'movie' || cleanKind === 'tv') && cleanQ
      ? searchTvMaze(cleanQ, { limit: 3 })
      : Promise.resolve([]),
    moviesLocal: (cleanKind === 'all' || cleanKind === 'movie' || cleanKind === 'tv') && cleanQ && typeof app?.movieApi?.search === 'function'
      ? app.movieApi.search(cleanQ, { type: 'multi', limit: 3 }).catch(() => null)
      : Promise.resolve(null),
    stories: (cleanKind === 'story' || cleanKind === 'novel' || cleanKind === 'all' || genre)
      ? lookupOpenLibraryStories({ query: cleanQ, genre, limit: 4 })
      : Promise.resolve([]),
    wiki: browser && cleanQ
      ? browser.searchWikipedia(`${cleanQ}${genre ? ` ${genre}` : ''}`, { maxResults: 3, extractChars: 1400 }).catch(() => [])
      : Promise.resolve([])
  };

  const settled = await Promise.all(Object.values(tasks));
  const [itunes, youtube, tvmaze, moviesLocal, stories, wiki] = settled;
  const localMovies = Array.isArray(moviesLocal?.results) ? moviesLocal.results : (Array.isArray(moviesLocal) ? moviesLocal : []);

  return {
    music: itunes,
    videos: (youtube || []).slice(0, 3).map((v) => ({ title: v.title, channel: v.author || v.channel || null, duration: v.duration || null, url: v.url || null })),
    series: tvmaze,
    movies: localMovies.slice(0, 3).map((m) => ({ title: m.title, year: m.year || null, overview: cleanText(m.overview || m.description || '').slice(0, 360) })),
    stories,
    wiki
  };
}
