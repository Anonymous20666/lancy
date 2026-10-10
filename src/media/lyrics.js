import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../core/logger.js';

const execFileAsync = promisify(execFile);
const log = logger().child({ module: 'media:lyrics' });

/**
 * Clean track title and artist for accurate lyrics matching
 */
export function cleanSongMetadata(rawTitle, rawArtist = '') {
  let raw = String(rawTitle || '').trim();
  let artist = String(rawArtist || '').trim();

  // 1. Remove trailing ellipsis or dots (e.g. from UI truncation)
  raw = raw.replace(/[…\.]+\s*$/, '').trim();

  // 2. Remove unclosed opening brackets/parentheses at the end (e.g. "(Extended Versi", "[Official")
  raw = raw.replace(/\s*[([{][^)\]}]*$/, '').trim();

  // 3. Strip featured artists in brackets first: (feat. ...) or [feat. ...]
  raw = raw.replace(/\s*[([{\-]\s*(?:feat\.?|ft\.?)\s+.*?[)\]}]/gi, '');

  // 4. Strip common tags like (Official Video), (Official Audio), (Audio), (Remastered), etc.
  raw = raw.replace(/\s*[([{\-]\s*(?:official\s*(?:music\s*)?(?:video|audio)|video|audio|extended(?:\s*version)?|lyric(?:s)?(?:\s*video)?|visualizer|remix|mv|hd|hq|4k|explicit|clean|remaster(?:ed)?|live)[^)\]}]*[)\]}]/gi, '');
  raw = raw.replace(/\s*\|\s*.*$/g, '');

  // 5. If raw title is "Artist - Song Title" or "Song Title - Artist" (handles Unicode dashes -, –, —)
  if (/[-–—]/.test(raw)) {
    const parts = raw.split(/\s+[-–—]\s+/);
    if (parts.length >= 2) {
      const left = parts[0].trim();
      const right = parts.slice(1).join(' - ').trim();

      if (artist && left.toLowerCase() === artist.toLowerCase()) {
        raw = right;
      } else if (artist && right.toLowerCase() === artist.toLowerCase()) {
        raw = left;
      } else if (!artist) {
        artist = left;
        raw = right;
      } else {
        // Left is usually recording artist, right is actual song title
        artist = left;
        raw = right;
      }
    }
  }

  // Clean trailing feat/ft and tags from title
  let title = raw
    .replace(/\s*[([{\-]\s*(?:feat\.?|ft\.?)\s+.*?[)\]}]/gi, '')
    .replace(/\s*[([{\-]\s*(?:official\s*(?:music\s*)?(?:video|audio)|video|audio|extended(?:\s*version)?|lyric(?:s)?(?:\s*video)?|visualizer|remix|mv|hd|hq|4k|explicit|clean|remaster(?:ed)?|live)[^)\]}]*[)\]}]/gi, '')
    .replace(/\s*\b(?:feat\.?|ft\.?)\s+.*$/i, '')
    .trim();

  // Clean artist
  artist = artist
    .replace(/\s*-\s*topic$/i, '')
    .replace(/\s*vevo$/i, '')
    .replace(/\s*\b(?:feat\.?|ft\.?)\s+.*$/i, '')
    .split(/[,&/]/)[0]
    .trim();

  return { title: title || raw, artist };
}

/**
 * Strip synced LRC timestamp tags [mm:ss.xx]
 */
export function stripLrcTimestamps(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/^\[\d{2}:\d{2}(?:\.\d{2,3})?\]\s*/gm, '')
    .trim();
}

/**
 * Fetch and extract complete lyrics from AZLyrics page
 */
export async function fetchAzLyrics(url) {
  if (!url || !url.includes('azlyrics.com')) return null;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return null;
    const html = await res.text();
    const marker = '<!-- Usage of azlyrics';
    const idx = html.indexOf(marker);
    if (idx !== -1) {
      const after = html.slice(idx);
      const commentEnd = after.indexOf('-->');
      const divEnd = after.indexOf('</div>');
      if (commentEnd !== -1 && divEnd !== -1) {
        const raw = after.slice(commentEnd + 3, divEnd);
        return raw.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
      }
    }
  } catch (err) {
    log.debug({ err: err.message, url }, 'AZLyrics fetch failed');
  }
  return null;
}

/**
 * Smart Reverse Lyrics Search Engine:
 * Given a snippet of lyrics or words from a verse, identify the song title and artist
 */
export async function searchSongByLyrics(snippet) {
  if (!snippet || typeof snippet !== 'string') return null;
  const cleanSnippet = snippet
    .replace(/[\r\n]+/g, ' ')
    .replace(/[^\w\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleanSnippet || cleanSnippet.length < 5) return null;

  // Tier 1: DuckDuckGo HTML Search
  try {
    const searchUrl = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(cleanSnippet + ' song lyrics');
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      signal: AbortSignal.timeout(7000)
    });
    if (res.ok) {
      const html = await res.text();
      const titles = [...html.matchAll(/class="result__title"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/g)]
        .map((m) => m[1].replace(/<[^>]+>/g, '').trim());

      const urls = [...html.matchAll(/<a[^>]+class="result__url"[^>]+href="([^"]+)"/g)]
        .map((m) => {
          const match = m[1].match(/uddg=([^&]+)/);
          return match ? decodeURIComponent(match[1]) : m[1];
        });

      for (let i = 0; i < titles.length; i++) {
        const raw = titles[i];
        const pageUrl = urls[i] || '';

        // Pattern 1: Title · Artist · LRCLIB
        const lrcMatch = raw.match(/^([^·•]+)\s*[·•]\s*([^·•]+)\s*[·•]\s*LRCLIB/i);
        if (lrcMatch) {
          const cleaned = cleanSongMetadata(lrcMatch[1], lrcMatch[2]);
          return { title: cleaned.title, artist: cleaned.artist, sourceUrl: pageUrl };
        }

        // Pattern 2: Artist "Title" lyrics
        const quoteMatch = raw.match(/^([^"“”]+)\s*["“”]([^"“”]+)["“”]\s*lyrics/i);
        if (quoteMatch) {
          const cleaned = cleanSongMetadata(quoteMatch[2], quoteMatch[1]);
          return { title: cleaned.title, artist: cleaned.artist, sourceUrl: pageUrl };
        }

        // Pattern 3: Clean standard suffixes
        let cleaned = raw
          .replace(/&amp;/g, '&')
          .replace(/&#x27;/g, "'")
          .replace(/&quot;/g, '"')
          .replace(/\s*\|\s*(?:AZLyrics\.com|Genius(?:\s*Lyrics)?|Lyrics\.net|YouTube|SongLyrics|Musixmatch|LrcLib|Chosic|LyricsHub).*$/i, '')
          .replace(/\s*-\s*(?:Genius(?:\s*Lyrics)?|AZLyrics|Lyrics\.net|YouTube|SongLyrics|Musixmatch|LRCLIB).*$/i, '')
          .replace(/\s*[([{\-]\s*(?:official\s*)?(?:video|audio|lyrics|extended(?:\s*version)?|with\s*lyrics)\s*[)\]}]/gi, '')
          .replace(/\s+lyrics\s*$/i, '')
          .trim();

        if (/[-–—]/.test(cleaned)) {
          const meta = cleanSongMetadata(cleaned);
          if (meta.title && meta.artist && !/find|search|generator|identifier|database/i.test(meta.title)) {
            return { title: meta.title, artist: meta.artist, sourceUrl: pageUrl };
          }
        }
      }
    }
  } catch (err) {
    log.debug({ err: err.message }, 'DuckDuckGo reverse lyrics search failed');
  }

  // Tier 2: YouTube ytsearch fallback
  try {
    const { stdout } = await execFileAsync('yt-dlp', [
      '--no-warnings',
      '--js-runtimes', 'node:/usr/bin/node',
      '--extractor-args', 'youtube:player_client=android,web',
      '--print', '%(title)s ||| %(channel)s',
      `ytsearch1:${cleanSnippet.slice(0, 100)} lyrics`
    ], { timeout: 10000 });

    const [ytTitle, ytChannel] = stdout.trim().split(' ||| ');
    if (ytTitle) {
      const meta = cleanSongMetadata(ytTitle, ytChannel || '');
      if (meta.title && meta.title.toLowerCase() !== 'song') {
        return { title: meta.title, artist: meta.artist || ytChannel || '' };
      }
    }
  } catch (err) {
    log.debug({ err: err.message }, 'YouTube reverse lyrics search failed');
  }

  return null;
}

/**
 * Fetch lyrics from LRCLIB & AZLyrics with intelligent fallback queries and reverse lyrics search
 */
export async function getLyrics(rawTitle, rawArtist = '') {
  let { title, artist } = cleanSongMetadata(rawTitle, rawArtist);
  log.debug({ rawTitle, rawArtist, title, artist }, 'fetching lyrics');

  // Guard against generic or empty titles
  if (!rawTitle || (title && title.toLowerCase() === 'song') || (title && title.toLowerCase() === 'unknown')) {
    return {
      found: false,
      title: rawTitle,
      artist: rawArtist,
      lyrics: null
    };
  }

  // Check if query is a lyrics snippet rather than title/artist
  const isSnippet = rawTitle.includes('\n') || (rawTitle.trim().split(/\s+/).length >= 5 && !/[-–—]/.test(rawTitle));
  let identifiedAzUrl = null;

  if (isSnippet || !title) {
    try {
      const identified = await searchSongByLyrics(rawTitle);
      if (identified && identified.title && identified.artist) {
        title = identified.title;
        artist = identified.artist;
        if (identified.sourceUrl?.includes('azlyrics.com')) {
          identifiedAzUrl = identified.sourceUrl;
        }
      }
    } catch {}
  }

  const headers = {
    'User-Agent': 'LancyBot/2.0 (Telegram bot; https://github.com/lancy)'
  };

  // 1. Try direct exact match via LRCLIB get API
  if (title && artist) {
    try {
      const url = `https://lrclib.net/api/get?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist)}`;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const data = await res.json();
        const plain = (data.plainLyrics || '').trim();
        const synced = stripLrcTimestamps(data.syncedLyrics || '').trim();
        const text = plain.length >= synced.length ? (plain || synced) : (synced || plain);
        if (text && text.length > 0) {
          return {
            found: true,
            title: data.trackName || title,
            artist: data.artistName || artist,
            album: data.albumName,
            lyrics: text,
            source: 'lrclib'
          };
        }
      }
    } catch (err) {
      log.debug({ err: err.message }, 'LRCLIB direct get failed');
    }
  }

  // 2. Try search by combined query on LRCLIB
  const searchQueries = [
    artist ? `${artist} ${title}` : title,
    title
  ].filter(Boolean);

  for (const q of searchQueries) {
    try {
      const searchUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(q)}`;
      const sRes = await fetch(searchUrl, { headers, signal: AbortSignal.timeout(8000) });
      if (sRes.ok) {
        const results = await sRes.json();
        if (Array.isArray(results) && results.length > 0) {
          const match = results.find((r) => r.plainLyrics || r.syncedLyrics);
          if (match) {
            const plain = (match.plainLyrics || '').trim();
            const synced = stripLrcTimestamps(match.syncedLyrics || '').trim();
            const text = plain.length >= synced.length ? (plain || synced) : (synced || plain);
            return {
              found: true,
              title: match.trackName || title,
              artist: match.artistName || artist,
              album: match.albumName,
              lyrics: text,
              source: 'lrclib'
            };
          }
        }
      }
    } catch (err) {
      log.debug({ err: err.message, q }, 'LRCLIB search query failed');
    }
  }

  // 3. Fallback to AZLyrics if URL found
  if (identifiedAzUrl) {
    const azLyrics = await fetchAzLyrics(identifiedAzUrl);
    if (azLyrics && azLyrics.length > 0) {
      return {
        found: true,
        title: title || rawTitle,
        artist: artist || rawArtist,
        lyrics: azLyrics,
        source: 'azlyrics'
      };
    }
  }

  // 4. Try reverse-search if not already done
  if (!isSnippet && rawTitle) {
    try {
      const reverse = await searchSongByLyrics(`${artist} ${title}`.trim() || rawTitle);
      if (reverse && (reverse.title !== title || reverse.artist !== artist)) {
        // Try LRCLIB with identified metadata
        const url = `https://lrclib.net/api/get?track_name=${encodeURIComponent(reverse.title)}&artist_name=${encodeURIComponent(reverse.artist)}`;
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const data = await res.json();
          const plain = (data.plainLyrics || '').trim();
          const synced = stripLrcTimestamps(data.syncedLyrics || '').trim();
          const text = plain.length >= synced.length ? (plain || synced) : (synced || plain);
          if (text) {
            return {
              found: true,
              title: data.trackName || reverse.title,
              artist: data.artistName || reverse.artist,
              album: data.albumName,
              lyrics: text,
              source: 'lrclib'
            };
          }
        }

        if (reverse.sourceUrl?.includes('azlyrics.com')) {
          const azLyrics = await fetchAzLyrics(reverse.sourceUrl);
          if (azLyrics && azLyrics.length > 0) {
            return {
              found: true,
              title: reverse.title,
              artist: reverse.artist,
              lyrics: azLyrics,
              source: 'azlyrics'
            };
          }
        }
      }
    } catch {}
  }

  return {
    found: false,
    title: rawTitle,
    artist: rawArtist,
    lyrics: null
  };
}

/**
 * Format lyrics as Markdown blockquote lines
 */
export function formatBlockquoteLyrics(lyricsText) {
  if (!lyricsText) return '';
  return lyricsText
    .split('\n')
    .map((line) => (line.trim() ? `> ${line}` : '>'))
    .join('\n');
}

/**
 * Escape HTML special characters for Telegram HTML mode
 */
export function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Split lyrics into chunks safely respecting verse boundaries,
 * keeping each chunk comfortably within Telegram message limits (max 2400 chars).
 */
export function chunkLyrics(lyricsText, maxChars = 2400) {
  if (!lyricsText || typeof lyricsText !== 'string') return [];
  const paragraphs = lyricsText.split(/\n\s*\n/);
  const chunks = [];
  let current = [];
  let currentLen = 0;

  for (const para of paragraphs) {
    const paraLen = para.length + 2;
    if (para.length > maxChars) {
      const lines = para.split('\n');
      for (const line of lines) {
        if (currentLen + line.length + 1 > maxChars && current.length > 0) {
          chunks.push(current.join('\n\n'));
          current = [];
          currentLen = 0;
        }
        if (current.length === 0) {
          current.push(line);
          currentLen = line.length;
        } else {
          current[current.length - 1] += '\n' + line;
          currentLen += line.length + 1;
        }
      }
      continue;
    }

    if (currentLen + paraLen > maxChars && current.length > 0) {
      chunks.push(current.join('\n\n'));
      current = [para];
      currentLen = paraLen;
    } else {
      current.push(para);
      currentLen += paraLen;
    }
  }

  if (current.length > 0) {
    chunks.push(current.join('\n\n'));
  }

  return chunks;
}
