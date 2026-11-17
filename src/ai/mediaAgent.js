import { logger } from '../core/logger.js';
import { parseMovieSearchIntent } from '../media/movieQueryParser.js';

const CONCLUDE_RE = /^(?:(?:ok(?:ay)?|alright|cool|great|nice|awesome|perfect|yes|yeah)[,\s]+)*(?:that'?s\s*(?:all|it)|i'?m\s*(?:good|done|set|ok(?:ay)?)|we(?:'re|\s*are)\s*(?:good|done|set)|all\s*(?:good|done|set)|done|thank(?:s|\s*you)(?:\s*(?:so\s*much|lancy|bestie))?(?:[,\s]*(?:that'?s\s*(?:all|it)|done|bye))?|(?:exit|close|leave|quit|stop|end)\s*(?:ai|chat|dj|mode)?|bye(?:\s*lancy)?|good\s*(?:night|bye))(?:[,\s]+(?:thanks?|thank\s*you|done|that'?s\s*(?:all|it)|for\s*now|bye|lancy))*[\s!.,♡✨]*$/i;

const MOVIE_WORD_RE = /\b(movies?|films?|cinema|series|tv\s*shows?|shows?|episodes?|seasons?|nollywood|bollywood|hollywood|k-?drama|kdrama|anime\s*(?:series|movie|show)|watch|netflix)\b/i;
const SONG_WORD_RE = /\b(songs?|tracks?|music|albums?|lyrics|afrobeats|amapiano|hip[\s-]*hop|rap|rnb|gospel|dj|vibe|playlist|bass|eq|beat)\b/i;
const RANDOM_RE = /\b(random|surprise\s*me|pick\s*(?:one|any|something)|anything\s*(?:good|nice)|recommend\s*(?:something|a\s*(?:movie|film|series|song)))\b/i;
const TRENDING_RE = /\b(trend(?:ing)?|popular|hot\s*(?:right\s*now|now)?|top\s*(?:rated|charts?|picks?|movies?|series|songs?)|new\s*releases?|latest)\b/i;

function parseActionTag(raw) {
  const str = String(raw || '');
  const match = str.match(/\[ACTION:\s*([a-zA-Z_]+)([^\]]*)\]/i);
  const cleanText = str
    .replace(/\[ACTION:[^\]]*(?:\]|$)/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!match) return { action: null, cleanText };
  const name = match[1].toLowerCase();
  const rest = match[2] || '';
  const extract = (key) => {
    const m = rest.match(new RegExp(`${key}=["']([^"']+)["']`, 'i')) || rest.match(new RegExp(`${key}=([^\\s\\]]+)`, 'i'));
    return m ? m[1].trim() : null;
  };
  return {
    action: {
      name,
      query: extract('query'),
      type: extract('type'),
      category: extract('category'),
      season: extract('season') ? Number(extract('season')) : null,
      playNow: extract('play_now') === 'true' || extract('immediate') === 'true',
      op: extract('op'),
      value: extract('value')
    },
    cleanText
  };
}

export class MediaAiAgent {
  constructor({ app, log } = {}) {
    this.app = app;
    this.log = log || logger().child({ module: 'media-ai-agent' });
    this.histories = new Map();
    this.activeKinds = new Map(); // remembers whether user is currently talking about 'movie' vs 'music'
  }

  #key(chatId, userId) {
    return `${Number(chatId || 0)}:${Number(userId || 0)}`;
  }

  getHistory(chatId, userId) {
    return this.histories.get(this.#key(chatId, userId)) || [];
  }

  #pushHistory(chatId, userId, role, content) {
    const key = this.#key(chatId, userId);
    if (!this.histories.has(key) && this.histories.size >= 300) {
      const oldest = this.histories.keys().next().value;
      if (oldest !== undefined) this.histories.delete(oldest);
    }
    const list = this.histories.get(key) || [];
    list.push({ role, content: String(content || '').slice(0, 600) });
    if (list.length > 10) list.splice(0, list.length - 10);
    this.histories.set(key, list);
  }

  clearHistory(chatId, userId) {
    const key = this.#key(chatId, userId);
    this.histories.delete(key);
    this.activeKinds.delete(key);
  }

  #detectDeterministicIntent(text, lastDomain = null) {
    const t = String(text || '').trim();
    if (!t) return null;
    if (CONCLUDE_RE.test(t)) return { name: 'conclude' };

    const seasonMatch = t.match(/\bseason\s*(\d{1,2})\b/i) || t.match(/\bs(\d{1,2})\b/i);
    const mentionsMovie = MOVIE_WORD_RE.test(t);
    const mentionsSong = SONG_WORD_RE.test(t);
    const wantsTv = /\b(tv\s*shows?|series|episodes?|seasons?|k-?drama|kdrama)\b/i.test(t) || Boolean(seasonMatch);
    const wantsRandom = RANDOM_RE.test(t);
    const wantsTrending = TRENDING_RE.test(t);

    if (wantsRandom && (mentionsMovie || (!mentionsSong && lastDomain === 'movie'))) {
      const catMatch = t.match(/\b(hollywood|bollywood|nollywood|anime|kdrama|k-drama|comedy|action|horror|sci-fi|romance|thriller|animation)\b/i);
      return {
        name: 'random_movie',
        type: wantsTv ? 'tv' : 'all',
        category: catMatch ? catMatch[1].toLowerCase().replace('k-drama', 'kdrama') : null
      };
    }

    if (wantsTrending && mentionsMovie) {
      return { name: 'trending_movies', type: wantsTv ? 'tv' : 'all' };
    }

    // Direct category/genre requests (e.g. "give me Romance movies", "action movies", "k-drama series")
    const parsedIntent = parseMovieSearchIntent(t);
    if (parsedIntent.kind === 'category' && (mentionsMovie || (!mentionsSong && lastDomain === 'movie') || !/\b(?:music|song|track|album)\b/i.test(t))) {
      return {
        name: 'browse_category',
        category: parsedIntent.category,
        genreId: parsedIntent.genreId,
        label: parsedIntent.label,
        type: parsedIntent.type || (wantsTv ? 'tv' : 'movie')
      };
    }

    // Explicit movie/series search request (e.g. "find movie inception", "watch game of thrones season 2", "search for breaking bad series")
    const explicitMovieCmd = t.match(/^(?:can\s+you\s+|please\s+|help\s+me\s+)?(?:search|find|stream|watch|play|put\s+on|open|load|show|give|get|send|bring|recommend|suggest)(?:\s+for)?(?:\s+me)?\s+(?:the\s+)?(?:movies?|films?|series|tv\s*shows?|shows?)?\s*[:\-]?\s*(.+)$/i);
    if (explicitMovieCmd && (mentionsMovie || (!mentionsSong && lastDomain === 'movie' && !/^\s*(?:pause|resume|skip|next|stop|volume|bass|eq)\b/i.test(t)))) {
      let query = explicitMovieCmd[1]
        .replace(/^\s*me\s+/i, '')
        .replace(/\b(?:movies?|films?|series|tv\s*shows?|shows?|full\s*movie|in\s*vc|on\s*vc|please)\b/gi, '')
        .replace(/\bseason\s*\d+\b/gi, '')
        .trim();
      if (query.length >= 2 && !/^(?:random|trending|popular|something|anything)$/i.test(query)) {
        return {
          name: 'search_movie',
          query,
          type: wantsTv ? 'tv' : 'multi',
          season: seasonMatch ? Number(seasonMatch[1]) : null,
          playNow: /\b(now|immediately|right\s*now)\b/i.test(t)
        };
      }
    }

    return null;
  }

  async chat({ ctx, chatId, userId, text, defaultDomain = null } = {}) {
    const cleanText = String(text || '').trim();
    if (!cleanText) return { reply: 'Tell me what song, vibe, movie, or series you are looking for!', action: null, concluded: false };

    const key = this.#key(chatId, userId);
    const domainHint = defaultDomain || this.activeKinds.get(key) || 'mixed';
    if (MOVIE_WORD_RE.test(cleanText)) this.activeKinds.set(key, 'movie');
    else if (SONG_WORD_RE.test(cleanText)) this.activeKinds.set(key, 'music');

    // Fast path for unambiguous conclusion or direct random/movie commands
    const fastIntent = this.#detectDeterministicIntent(cleanText, domainHint);
    if (fastIntent?.name === 'conclude') {
      const qm = this.app?.musicQueueManager;
      const s = chatId ? qm?.sessions?.get(Number(chatId)) : null;
      const nowPlaying = s?.currentTrack?.title ? ` Now playing: ${s.currentTrack.title}.` : '';
      const qCount = s?.upcoming?.length || 0;
      const reply = `Got it — wrapping up our AI chat session.${nowPlaying}${qCount ? ` ${qCount} item(s) waiting in your queue.` : ''} Tap Player or Movie Stream anytime you need me again.`;
      this.clearHistory(chatId, userId);
      return { reply, action: fastIntent, concluded: true };
    }

    const qm = this.app?.musicQueueManager;
    const s = chatId ? qm?.sessions?.get(Number(chatId)) : null;
    const nowPlaying = s?.currentTrack ? `${s.currentTrack.title} (${s.currentTrack.mediaType === 'video' ? 'Video/Movie' : 'Audio'})` : 'Nothing playing right now';
    const history = this.getHistory(chatId, userId);

    // Optional live context snippets for grounded answers
    let movieContext = '';
    if (this.app?.movieApi && (MOVIE_WORD_RE.test(cleanText) || domainHint === 'movie' || TRENDING_RE.test(cleanText))) {
      try {
        const trend = await this.app.movieApi.trending({ window: 'day', type: 'all' });
        const top = (trend?.results || []).slice(0, 5).map((m) => `${m.title} (${m.type === 'tv' ? 'TV' : 'Movie'}${m.year ? `, ${m.year}` : ''})`).join('; ');
        if (top) movieContext = `Trending Movies/Shows right now: ${top}.`;
      } catch {}
    }

    let musicContext = '';
    if (this.app?.music?.aiDj?.getCharts && (SONG_WORD_RE.test(cleanText) || domainHint === 'music' || TRENDING_RE.test(cleanText))) {
      try {
        const charts = await this.app.music.aiDj.getCharts('', 5);
        if (charts?.length) {
          musicContext = `Trending Songs right now: ${charts.slice(0, 5).map((c) => `${c.artist} - ${c.title}`).join('; ')}.`;
        }
      } catch {}
    }

    const systemPrompt = [
      'You are Lancy, a sharp, warm, natural AI entertainment companion inside a Telegram Voice Chat & Channel studio.',
      'You help users discover, chat about, and stream BOTH Songs/Music Videos AND Movies/TV Series directly in VC.',
      `Current VC state: ${nowPlaying}. Upcoming queued items: ${s?.upcoming?.length || 0}.`,
      movieContext,
      musicContext,
      'Reply naturally in 1–3 concise, human sentences FIRST. Never mention image policies or claim inability without trying.',
      'Only if the user asks to find, play, queue, or pick something (or wants to finish chatting), append AT MOST ONE exact action tag at the very end:',
      '- [ACTION: search_movie query="exact title" type="movie|tv|multi" season="optional number"]',
      '- [ACTION: random_movie type="movie|tv|all" category="optional genre/country"]',
      '- [ACTION: trending_movies type="movie|tv|all"]',
      '- [ACTION: search_song query="song or artist" play_now="true|false"]',
      '- [ACTION: vc_control op="pause|resume|skip|stop|volume|eq" value="optional"]',
      '- [ACTION: conclude] (ONLY when user signals they are done/finished/exiting).'
    ].filter(Boolean).join('\n');

    let replyText = '';
    let parsedAction = fastIntent;

    if (this.app?.ai?.generate) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 25_000);
      timer.unref?.();
      try {
        const res = await this.app.ai.generate({
          task: 'chat',
          style: 'cool',
          text: cleanText,
          context: { system: systemPrompt, history },
          maxTokens: 220,
          signal: ac.signal
        });
        if (res && res.provider !== 'builtin' && res.text) {
          const parsed = parseActionTag(res.text);
          replyText = parsed.cleanText;
          if (!parsedAction && parsed.action) parsedAction = parsed.action;
        }
      } catch (err) {
        this.log?.debug?.({ err: err?.message }, 'media ai generate timed out or failed, using smart deterministic handler');
      } finally {
        clearTimeout(timer);
      }
    }

    // Check song playback / DJ intent fallback if LLM did not emit a structured action
    if (!parsedAction && SONG_WORD_RE.test(cleanText) && !MOVIE_WORD_RE.test(cleanText)) {
      const songCmd = cleanText.match(/(?:play|stream|queue|find|search|put\s*on)\s+(?:song|track|music)?\s*(.+)/i);
      if (songCmd && songCmd[1]?.trim().length >= 2) {
        parsedAction = { name: 'search_song', query: songCmd[1].trim(), playNow: /\bnow|immediately\b/i.test(cleanText) };
      }
    }

    if (!replyText) {
      if (parsedAction?.name === 'random_movie') {
        replyText = `Spinning the reel for a random ${parsedAction.category || parsedAction.type || 'movie/series'} pick right now!`;
      } else if (parsedAction?.name === 'browse_category') {
        replyText = `Opening top ${parsedAction.label || parsedAction.category || 'genre'} titles right now — tap any title to stream or download!`;
      } else if (parsedAction?.name === 'search_movie') {
        replyText = `Searching "${parsedAction.query}" now — I'll pull up its details, seasons & stream controls!`;
      } else if (parsedAction?.name === 'trending_movies') {
        replyText = movieContext
          ? `Here's what's hot right now — opening the Trending Movie & Series picker for you!`
          : 'Loading the trending movies and series list right now!';
      } else if (parsedAction?.name === 'search_song') {
        replyText = `Searching "${parsedAction.query}" for VC playback right now!`;
      } else if (MOVIE_WORD_RE.test(cleanText)) {
        replyText = movieContext
          ? `${movieContext} Tell me any title, genre, or say "random movie" and I'll load it up!`
          : 'Tell me any movie or TV series name (or say "random movie") and I will find it with seasons, episodes & subtitles!';
      } else {
        replyText = musicContext
          ? `${musicContext} Tell me any song, artist, or movie/series title to queue in VC!`
          : 'Tell me any song, artist vibe, or movie/TV series you want — or say "random movie" or "done" when finished!';
      }
    }

    this.#pushHistory(chatId, userId, 'user', cleanText);
    this.#pushHistory(chatId, userId, 'assistant', replyText);

    const concluded = parsedAction?.name === 'conclude';
    if (concluded) this.clearHistory(chatId, userId);

    return { reply: replyText, action: parsedAction, concluded };
  }
}
