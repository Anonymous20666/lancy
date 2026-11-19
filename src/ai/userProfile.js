/**
 * User identity normalization, Telegram native mentions, time-of-day awareness,
 * and persistent per-user taste profile memory for personalized AI companionship.
 */
import { rt } from '../telegram/rich.js';

export function normalizeDisplayName(rawName, fallback = 'friend') {
  const s = String(rawName ?? '').normalize('NFKD');
  // Strip combining marks and decorative symbols/emojis while preserving letters, numbers, and spaces
  const stripped = s
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}\s'-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return fallback;

  // Join spaced calligraphy letters (e.g. "P A P P Y" -> "PAPPY")
  const tokens = stripped.split(' ').filter(Boolean);
  const merged = [];
  let singleRun = '';
  for (const tok of tokens) {
    if (tok.length === 1 && /\p{L}/u.test(tok)) {
      singleRun += tok;
    } else {
      if (singleRun) {
        merged.push(singleRun);
        singleRun = '';
      }
      merged.push(tok);
    }
  }
  if (singleRun) merged.push(singleRun);

  const primary = merged[0] || fallback;
  if (/^[A-Z0-9'-]+$/.test(primary) && primary.length > 2) {
    return (primary.charAt(0).toUpperCase() + primary.slice(1).toLowerCase()).slice(0, 28);
  }
  return primary.slice(0, 28);
}

export function extractUserIdentity(ctxOrUser) {
  const userObj = ctxOrUser?.message?.from || ctxOrUser?.query?.from || ctxOrUser?.user || ctxOrUser || {};
  const id = Number(ctxOrUser?.tgId ?? userObj?.id ?? 0);
  const rawName = [userObj?.first_name, userObj?.last_name].filter(Boolean).join(' ').trim()
    || userObj?.username
    || '';
  const cleanName = normalizeDisplayName(rawName, userObj?.username ? `@${userObj.username}` : 'friend');
  return {
    userId: Number.isSafeInteger(id) && id > 0 ? id : 0,
    cleanName,
    username: userObj?.username ? String(userObj.username).replace(/^@/, '') : null
  };
}

export function buildTelegramMention(userOrCtx, cleanName = null) {
  const ident = typeof userOrCtx === 'object' ? extractUserIdentity(userOrCtx) : { userId: Number(userOrCtx) || 0, cleanName: cleanName || 'friend' };
  const label = cleanName || ident.cleanName || 'friend';
  if (ident.userId > 0) {
    return {
      text: label,
      userId: ident.userId,
      rich: rt.url(label, `tg://user?id=${ident.userId}`),
      html: `<a href="tg://user?id=${ident.userId}">${label.replace(/[<>&]/g, '')}</a>`
    };
  }
  return { text: label, userId: 0, rich: rt.text(label), html: label.replace(/[<>&]/g, '') };
}

export function getTimeOfDayContext(tz = 'Africa/Lagos', nowDate = null) {
  const zone = String(tz || 'Africa/Lagos').trim() || 'Africa/Lagos';
  const now = nowDate instanceof Date ? nowDate : new Date();
  let hour = 12;
  let minute = 0;
  let weekday = '';
  let localTimeStr = '';
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'long',
      hour12: false
    }).formatToParts(now);
    const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    hour = Number(map.hour ?? 12) % 24;
    minute = Number(map.minute ?? 0);
    weekday = String(map.weekday || '');
    localTimeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  } catch {
    hour = now.getUTCHours();
    minute = now.getUTCMinutes();
    localTimeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} UTC`;
  }

  let period = 'afternoon';
  let greeting = 'Good afternoon';
  let vibeHint = 'midday groove — smooth Afrobeats, chill R&B, or upbeat energy';
  if (hour >= 5 && hour < 12) {
    period = 'morning';
    greeting = 'Good morning';
    vibeHint = 'fresh morning boost or smooth chill start to the day';
  } else if (hour >= 12 && hour < 17) {
    period = 'afternoon';
    greeting = 'Good afternoon';
    vibeHint = 'afternoon cruise — chill music, Afrobeats, or something to keep the day flowing';
  } else if (hour >= 17 && hour < 22) {
    period = 'evening';
    greeting = 'Good evening';
    vibeHint = 'evening unwind — soulful jams, Afrobeats hits, or a good movie';
  } else {
    period = 'late_night';
    greeting = 'Hey night owl';
    vibeHint = 'late-night slow jams, chill melodic rap/Afro, or a midnight film';
  }

  return { timeZone: zone, hour, minute, weekday, localTimeStr, period, greeting, vibeHint };
}

export class UserTasteStore {
  constructor({ db } = {}) {
    this.db = db || null;
  }

  #readRow(userId, chatId = 0) {
    const uid = Number(userId || 0);
    if (!this.db || !Number.isSafeInteger(uid) || uid <= 0) return null;
    try {
      const exact = this.db.get('SELECT * FROM user_taste_profiles WHERE user_id = ? AND chat_id = ?', uid, Number(chatId || 0));
      if (exact) return exact;
      if (Number(chatId || 0) !== 0) {
        return this.db.get('SELECT * FROM user_taste_profiles WHERE user_id = ? AND chat_id = 0', uid) || null;
      }
      return null;
    } catch {
      return null;
    }
  }

  getProfile(userId, chatId = 0) {
    const row = this.#readRow(userId, chatId);
    if (!row) {
      return {
        userId: Number(userId || 0),
        displayName: null,
        topArtists: [],
        topGenres: [],
        recentMovies: [],
        recentRequests: [],
        interactionCount: 0
      };
    }
    const parseObj = (raw) => {
      try { const v = JSON.parse(raw || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
    };
    const parseArr = (raw) => {
      try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
    };
    const artistsMap = parseObj(row.favorite_artists_json);
    const genresMap = parseObj(row.favorite_genres_json);
    const topArtists = Object.entries(artistsMap).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 6).map(([k]) => k);
    const topGenres = Object.entries(genresMap).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 5).map(([k]) => k);
    return {
      userId: Number(row.user_id),
      displayName: row.display_name || null,
      topArtists,
      topGenres,
      recentMovies: parseArr(row.favorite_movies_json).slice(0, 6),
      recentRequests: parseArr(row.recent_requests_json).slice(0, 6),
      interactionCount: Number(row.interaction_count || 0)
    };
  }

  recordPreference({ userId, chatId = 0, displayName = null, artist = null, genre = null, movieTitle = null, requestText = null } = {}) {
    const uid = Number(userId || 0);
    if (!this.db || !Number.isSafeInteger(uid) || uid <= 0) return;
    const scopes = [0];
    const cid = Number(chatId || 0);
    if (cid !== 0) scopes.push(cid);
    for (const sc of scopes) {
      try {
        const cur = this.db.get('SELECT * FROM user_taste_profiles WHERE user_id = ? AND chat_id = ?', uid, sc);
        const artists = cur ? JSON.parse(cur.favorite_artists_json || '{}') : {};
        const genres = cur ? JSON.parse(cur.favorite_genres_json || '{}') : {};
        const movies = cur ? JSON.parse(cur.favorite_movies_json || '[]') : [];
        const reqs = cur ? JSON.parse(cur.recent_requests_json || '[]') : [];

        const cleanArtist = String(artist || '').trim().slice(0, 50);
        if (cleanArtist && cleanArtist.toLowerCase() !== 'unknown artist') {
          artists[cleanArtist] = (Number(artists[cleanArtist]) || 0) + 1;
        }
        const cleanGenre = String(genre || '').trim().slice(0, 40);
        if (cleanGenre) {
          genres[cleanGenre] = (Number(genres[cleanGenre]) || 0) + 1;
        }
        const cleanMovie = String(movieTitle || '').trim().slice(0, 70);
        if (cleanMovie) {
          const nextM = [cleanMovie, ...movies.filter((m) => m.toLowerCase() !== cleanMovie.toLowerCase())].slice(0, 10);
          movies.splice(0, movies.length, ...nextM);
        }
        const cleanReq = String(requestText || '').trim().slice(0, 90);
        if (cleanReq) {
          const nextR = [cleanReq, ...reqs.filter((r) => r.toLowerCase() !== cleanReq.toLowerCase())].slice(0, 8);
          reqs.splice(0, reqs.length, ...nextR);
        }

        const cleanName = displayName ? normalizeDisplayName(displayName, cur?.display_name || '') : (cur?.display_name || null);
        const nextCount = Number(cur?.interaction_count || 0) + 1;
        this.db.run(
          `INSERT INTO user_taste_profiles (user_id, chat_id, display_name, favorite_artists_json, favorite_genres_json, favorite_movies_json, recent_requests_json, interaction_count, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(user_id, chat_id) DO UPDATE SET
             display_name = COALESCE(excluded.display_name, user_taste_profiles.display_name),
             favorite_artists_json = excluded.favorite_artists_json,
             favorite_genres_json = excluded.favorite_genres_json,
             favorite_movies_json = excluded.favorite_movies_json,
             recent_requests_json = excluded.recent_requests_json,
             interaction_count = excluded.interaction_count,
             updated_at = datetime('now')`,
          uid,
          sc,
          cleanName,
          JSON.stringify(artists),
          JSON.stringify(genres),
          JSON.stringify(movies),
          JSON.stringify(reqs),
          nextCount
        );
      } catch {}
    }
  }

  formatPromptSummary(userId, chatId = 0) {
    const prof = this.getProfile(userId, chatId);
    const bits = [];
    if (prof.topArtists.length) bits.push(`Favorite artists: ${prof.topArtists.join(', ')}`);
    if (prof.topGenres.length) bits.push(`Preferred vibes/genres: ${prof.topGenres.join(', ')}`);
    if (prof.recentMovies.length) bits.push(`Watched/liked movies: ${prof.recentMovies.slice(0, 4).join(', ')}`);
    return bits.join(' | ');
  }
}
