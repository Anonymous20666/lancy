import { MusicError } from './model.js';
import { RADIO_CATEGORIES, normTrackTitleKey, rankTracksTrendingToOld } from './radio.js';
import { getArtistCatalogAndRelated, getTrendingCharts, formatTrendingForPrompt, isLikelyArtistQuery } from './charts.js';

const DEFAULT_VIBE = 'Late Night Studio Mix';

const COMPILATION_RE = /\b(24\/7|\d+\s*hours?|full\s*album|compilation|non[\s-]*stop|megamix|long\s*playlist|livestream|\blive\s*(now|stream)?\b|meditation\s*music\b.*relaxing|zen\s*music\b.*relaxing)\b/i;
const IMAGE_REFUSAL_RE = /\b(?:i'?m\s+sorry|sorry,?\s+but|cannot|can'?t)\b.*\b(?:generate|create|draw|make)\b.*\b(?:image|picture|photo|video|art)\b/i;
const HALLUCINATED_DJ_RE = /\b(?:girl\s+group|boy\s+band|legendary\s+group\s+from|k-?pop\s+idol|language\s+model|as\s+an\s+ai|cannot\s+access\s+(?:real[\s-]*time|live|internet)|don'?t\s+have\s+access\s+to\s+(?:real[\s-]*time|live|current|internet))\b/i;

const DETERMINISTIC_INTROS = [
  (t, artist, vibe, ch) => `${ch ? 'Live on air' : 'Up next'}: ${t} by ${artist} — locked into ${vibe}.`,
  (t, artist, vibe) => `Smooth segue into ${artist} — "${t}" keeps the ${vibe} energy flowing.`,
  (t, artist, vibe) => `Deck cued for ${t} (${artist}). Dialed to ${vibe} studio balance.`,
  (t, artist) => `Dropping "${t}" from ${artist} next — zero dead air, pure vibe.`
];

function cleanLine(text, maxLen = 135) {
  return String(text || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function isValidDjResponse(text, { maxWords = 30 } = {}) {
  const cleaned = cleanLine(text, 400);
  if (!cleaned) return false;
  if (IMAGE_REFUSAL_RE.test(cleaned) || HALLUCINATED_DJ_RE.test(cleaned)) return false;
  const wordCount = cleaned.split(/\s+/).filter(Boolean).length;
  return wordCount > 0 && wordCount <= maxWords;
}

function normArtist(artist) {
  return String(artist || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * AI DJ Engine: curates cohesive tracks, avoids artist fatigue, and crafts short liner notes.
 * Uses AIService (external LLM when active) with instant deterministic fallback so playback never stalls.
 */
export class AiDjEngine {
  constructor({ app, fetchCharts = null, artistResolver = null } = {}) {
    this.app = app;
    this.inflight = new Set();
    this.aiCooldownUntil = 0;
    this.fetchChartsFn = fetchCharts || ((opts) => getTrendingCharts(opts));
    this.artistResolverFn = artistResolver;
  }

  async #tryAiGenerate({ prompt, task, style = 'cool', context = {}, maxTokens = 160, timeoutMs = 22_000, maxWords = 85 } = {}) {
    if (!this.app?.ai?.generate || Date.now() < this.aiCooldownUntil) return null;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    timer.unref?.();
    try {
      const res = await this.app.ai.generate({
        task,
        style,
        text: prompt,
        context,
        maxTokens,
        signal: ac.signal
      });
      if (!res || !res.provider || res.provider === 'builtin' || !isValidDjResponse(res.text, { maxWords })) {
        return null;
      }
      this.aiCooldownUntil = 0;
      return res;
    } catch (err) {
      // Only pause briefly if the backend connection itself failed, never lock out for 90s on a slow response
      if (/ECONNREFUSED|fetch failed|unavailable/i.test(String(err?.message || ''))) {
        this.aiCooldownUntil = Date.now() + 15_000;
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async getCharts(genre = '', limit = 14) {
    try {
      const items = await Promise.race([
        this.fetchChartsFn({ genre, limit }),
        new Promise((resolve) => {
          const t = setTimeout(() => resolve([]), 2800);
          t.unref?.();
        })
      ]);
      return Array.isArray(items) ? items : [];
    } catch {
      return [];
    }
  }

  settingKey(chatId) {
    return `music.aidj.${Number(chatId)}`;
  }

  getConfig(chatId) {
    const saved = this.app?.db?.getSetting?.(this.settingKey(chatId), null);
    if (saved && typeof saved === 'object') {
      return {
        enabled: Boolean(saved.enabled),
        vibe: cleanLine(saved.vibe || DEFAULT_VIBE, 80) || DEFAULT_VIBE
      };
    }
    return { enabled: false, vibe: DEFAULT_VIBE };
  }

  saveConfig(chatId, patch = {}) {
    const prev = this.getConfig(chatId);
    const next = {
      enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : prev.enabled,
      vibe: patch.vibe !== undefined ? (cleanLine(patch.vibe, 80) || DEFAULT_VIBE) : prev.vibe
    };
    this.app?.db?.setSetting?.(this.settingKey(chatId), next);
    const s = this.app?.musicQueueManager?.sessions?.get?.(Number(chatId));
    if (s) {
      const resetArtistPlan = patch.vibe !== undefined && s.aiDj?.artistPlan?.seed !== next.vibe;
      s.aiDj = {
        ...(s.aiDj || {}),
        enabled: next.enabled,
        vibe: next.vibe,
        artistPlan: resetArtistPlan ? null : s.aiDj?.artistPlan || null
      };
    }
    return next;
  }

  syncSession(session) {
    if (!session) return null;
    const cfg = this.getConfig(session.chatId);
    if (!session.aiDj) {
      session.aiDj = {
        enabled: cfg.enabled,
        vibe: cfg.vibe,
        introNote: '',
        seenIds: [],
        cursor: 0
      };
    } else {
      session.aiDj.enabled = cfg.enabled;
      if (!session.aiDj.vibe) session.aiDj.vibe = cfg.vibe;
    }
    return session.aiDj;
  }

  isEnabled(session) {
    if (!session) return false;
    if (session.aiDj && typeof session.aiDj.enabled === 'boolean') {
      return session.aiDj.enabled;
    }
    return this.getConfig(session.chatId).enabled;
  }

  toggle(chatId, forceState = null) {
    const cur = this.getConfig(chatId);
    const enabled = forceState === null ? !cur.enabled : Boolean(forceState);
    const updated = this.saveConfig(chatId, { enabled });
    const s = this.app?.musicQueueManager?.getSession?.(Number(chatId));
    if (s) {
      this.syncSession(s);
      s.aiDj.enabled = enabled;
      if (!enabled) {
        s.aiDj.introNote = '';
      } else if (!s.aiDj.introNote) {
        s.aiDj.introNote = `AI DJ active (${updated.vibe}) — curating transitions & anti-repeat picks.`;
      }
    }
    return updated;
  }

  setVibe(chatId, vibe) {
    const cleanVibe = cleanLine(vibe, 80);
    if (!cleanVibe) {
      throw new MusicError('AIDJ_VIBE_REQUIRED', 'Specify a vibe or mood, e.g. /aidj vibe Afrobeats Midnight.');
    }
    const updated = this.saveConfig(chatId, { enabled: true, vibe: cleanVibe });
    const s = this.app?.musicQueueManager?.getSession?.(Number(chatId));
    if (s) {
      this.syncSession(s);
      s.aiDj.vibe = updated.vibe;
      s.aiDj.enabled = true;
      s.aiDj.seenIds = [];
      s.aiDj.introNote = `Mood locked to "${updated.vibe}" — curating next wave.`;
    }
    return updated;
  }

  async generateIntroNote(session, nextTrack, prevTrack = null) {
    if (!session || !nextTrack) return '';
    const dj = this.syncSession(session);
    const title = cleanLine(nextTrack.title || 'Next Track', 60);
    const artist = cleanLine(nextTrack.artist || 'Featured Artist', 40);
    const vibe = dj?.vibe || DEFAULT_VIBE;

    let note = '';
    const trending = await this.getCharts(vibe, 5);
    if (this.app?.ai?.generate && Date.now() >= this.aiCooldownUntil) {
      const prompt = [
        `Write ONE punchy 12-18 word Spotify X radio DJ transition line.`,
        `Next song: "${title}" by ${artist}.`,
        prevTrack ? `Previous song: "${cleanLine(prevTrack.title, 40)}" by ${cleanLine(prevTrack.artist || '', 30)}.` : '',
        `Mood/Vibe: ${vibe}.`,
        trending.length ? `Current charts buzz: ${trending.slice(0, 3).map(t => `${t.artist} - ${t.title}`).join(', ')}.` : '',
        session.isChannel ? 'Setting: Telegram live channel broadcast.' : 'Setting: live voice chat party.',
        'No hashtags, no emojis overload, no quotes around the whole line.'
      ].filter(Boolean).join(' ');

      const res = await this.#tryAiGenerate({
        prompt,
        task: 'music_dj',
        style: 'cool',
        context: {
          vibe,
          nextTrack: title,
          artist,
          isChannel: Boolean(session.isChannel),
          eq: session.eqPreset || (session.bass ? 'bass' : 'off'),
          trending
        },
        maxTokens: 70,
        timeoutMs: 8000,
        maxWords: 30
      });
      if (res?.text) note = cleanLine(res.text, 135);
    }

    if (!note) {
      const idx = (title.length + artist.length + (session.history?.length || 0)) % DETERMINISTIC_INTROS.length;
      note = DETERMINISTIC_INTROS[idx](title, artist, vibe, Boolean(session.isChannel));
    }

    if (dj) dj.introNote = note;
    return note;
  }

  async #resolveArtistPlan(session, baseVibe) {
    const dj = this.syncSession(session);
    if (dj?.artistPlan?.seed === baseVibe) return dj.artistPlan;
    if (!isLikelyArtistQuery(baseVibe, RADIO_CATEGORIES)) {
      dj.artistPlan = { seed: baseVibe, found: false, stage: 'category' };
      return dj.artistPlan;
    }
    const resolver = this.artistResolverFn || this.app?.music?.artistResolver || getArtistCatalogAndRelated;
    const planRes = await Promise.resolve(resolver(baseVibe, { knownCategories: RADIO_CATEGORIES })).catch(() => null);
    if (planRes?.found && planRes.artist) {
      dj.artistPlan = {
        seed: baseVibe,
        found: true,
        artist: planRes.artist,
        genre: planRes.genre || '',
        catalog: Array.isArray(planRes.tracks) ? planRes.tracks : [],
        catalogCursor: 0,
        relatedArtists: Array.isArray(planRes.relatedArtists) ? planRes.relatedArtists : [],
        relatedCursor: 0,
        providerPass: 0,
        stage: 'artist'
      };
    } else {
      dj.artistPlan = { seed: baseVibe, found: false, stage: 'category' };
    }
    return dj.artistPlan;
  }

  async #suggestSearchQueries(session, trendingItems = null, artistPlan = null) {
    const dj = this.syncSession(session);
    const baseVibe = dj?.vibe || session.radio?.queries?.[0] || DEFAULT_VIBE;
    const targetArtistNorm = artistPlan?.found ? normArtist(artistPlan.artist) : '';
    const relatedMode = Boolean(artistPlan?.found && artistPlan.stage === 'related');
    const anchor = session.currentTrack || session.history?.at(-1) || null;
    const avoidArtists = [...new Set([
      relatedMode ? artistPlan.artist : null,
      session.currentTrack?.artist,
      ...(session.upcoming || []).map(t => t.artist),
      ...(session.history || []).slice(-4).map(t => t.artist)
    ].filter(Boolean))].slice(0, 6);

    if (relatedMode && Array.isArray(artistPlan.relatedArtists) && artistPlan.relatedArtists.length) {
      const peers = artistPlan.relatedArtists
        .map(a => a?.name || a)
        .filter(name => normArtist(name) && normArtist(name) !== targetArtistNorm);
      if (peers.length) {
        const start = artistPlan.relatedCursor || 0;
        const rotatedPeers = [];
        for (let i = 0; i < Math.min(4, peers.length); i++) {
          rotatedPeers.push(peers[(start + i) % peers.length]);
        }
        artistPlan.relatedCursor = (start + 2) % peers.length;
        const chartGenre = artistPlan.genre || baseVibe;
        const trending = Array.isArray(trendingItems) ? trendingItems : await this.getCharts(chartGenre, 12);
        const peerCharts = trending
          .filter(t => t?.artist && t?.title && normArtist(t.artist) !== targetArtistNorm)
          .slice(0, 2)
          .map(t => cleanLine(`${t.artist} - ${t.title}`, 80));
        dj.cursor = (dj.cursor || 0) + 1;
        return [...new Set([...rotatedPeers, ...peerCharts])].slice(0, 6);
      }
    }

    const trending = Array.isArray(trendingItems) ? trendingItems : await this.getCharts(artistPlan?.genre || baseVibe, 12);
    const chartSeeds = trending
      .filter(t => t?.artist && t?.title && !avoidArtists.some(a => normArtist(a) && normArtist(t.artist) === normArtist(a)))
      .slice(0, 4)
      .map(t => cleanLine(`${t.artist} - ${t.title}`, 80));

    const seedQueries = [];
    if (this.app?.ai?.generate && Date.now() >= this.aiCooldownUntil) {
      const chartList = formatTrendingForPrompt(trending, 8);
      const prompt = [
        `Suggest 4 short music search queries ("Artist - Song") matching vibe "${baseVibe}".`,
        chartList ? `Currently charting global & genre hits:\n${chartList}` : '',
        anchor ? `Flow smoothly from "${cleanLine(anchor.title, 45)}" by "${cleanLine(anchor.artist || '', 30)}".` : '',
        avoidArtists.length ? `Do NOT repeat these recent artists: ${avoidArtists.join(', ')}.` : '',
        'Return one query per line, plain text only, max 4 lines.'
      ].filter(Boolean).join('\n');

      const res = await this.#tryAiGenerate({
        prompt,
        task: 'music_dj_curate',
        style: 'minimal',
        context: { vibe: baseVibe, avoidArtists, trending },
        maxTokens: 120,
        timeoutMs: 9000,
        maxWords: 50
      });
      if (res?.text) {
        const lines = String(res.text)
          .split(/\r?\n/)
          .map(l => cleanLine(l.replace(/^\d+[.)]\s*|^[-•*]\s*/, ''), 80))
          .filter(l => l.length >= 3 && !avoidArtists.some(a => normArtist(a) && normArtist(l).includes(normArtist(a))));
        seedQueries.push(...lines.slice(0, 4));
      }
    }

    const radioSeeds = Array.isArray(session.radio?.queries) ? session.radio.queries : [];
    const suffixes = ['trending hits', 'popular songs', 'top hits', 'classic hits', 'throwback hits'];
    const rotatedCharts = chartSeeds.length
      ? chartSeeds.map((_, i) => chartSeeds[(i + (dj.cursor || 0)) % chartSeeds.length])
      : [];
    const fallback = [
      ...rotatedCharts.slice(0, 2),
      ...radioSeeds,
      baseVibe,
      `${baseVibe} ${suffixes[dj.cursor % suffixes.length]}`,
      `${baseVibe} ${suffixes[(dj.cursor + 2) % suffixes.length]}`
    ].map(q => cleanLine(q, 80)).filter(Boolean);

    dj.cursor = (dj.cursor || 0) + 1;
    return [...new Set([...seedQueries, ...fallback])].slice(0, 6);
  }

  #detectChatIntent(text) {
    const raw = cleanLine(text, 200);
    const lower = raw.toLowerCase();
    const wantsBassOff = /\b(bass\s+off|turn\s+off\s+bass|no\s+bass|flat\s+eq|eq\s+off|reset\s+eq)\b/i.test(lower);
    const wantsStudio = /\b(studio\s*(?:eq|sound|mix)?|vocal\s+eq|nightcore|vaporwave|8d)\b/i.test(lower);
    const wantsBassBoost = !wantsBassOff && /\b(bass|sub[\s-]*bass|clean\s+bass|heavy\s+bass|punchy|eq)\b/i.test(lower);
    let bassPreset = null;
    if (wantsBassOff) bassPreset = 'off';
    else if (/\bnightcore\b/i.test(lower)) bassPreset = 'nightcore';
    else if (/\bvaporwave\b/i.test(lower)) bassPreset = 'vaporwave';
    else if (/\b8d\b/i.test(lower)) bassPreset = '8d';
    else if (/\bvocal\b/i.test(lower)) bassPreset = 'vocal';
    else if (/\bstudio\b/i.test(lower)) bassPreset = 'studio';
    else if (wantsBassBoost) bassPreset = 'bass';

    let playbackOp = null;
    if (/^(?:please\s+|can\s+you\s+|dj\s+)?(?:skip|next(?:\s+(?:song|track|video))?|change\s+(?:song|track))\b/i.test(lower)) playbackOp = 'skip';
    else if (/^(?:please\s+|can\s+you\s+|dj\s+)?(?:prev(?:ious)?|go\s+back|last\s+(?:song|track))\b/i.test(lower)) playbackOp = 'previous';
    else if (/^(?:please\s+|can\s+you\s+|dj\s+)?pause(?:\s+(?:music|vc|playback|this))?$/i.test(lower)) playbackOp = 'pause';
    else if (/^(?:please\s+|can\s+you\s+|dj\s+)?(?:resume|unpause|continue)(?:\s+(?:music|vc|playback))?$/i.test(lower)) playbackOp = 'resume';

    const wantsTrending = /\b(trend(?:ing)?|chart(?:s|ing)?|top\s*\d*|hot\s+(?:right\s+now|today)|what'?s\s+hot|latest\s+(?:hits|songs|music|drops)|new\s+(?:hits|songs|music)|popular\s+(?:now|today))\b/i.test(lower);
    const explicitPlay = /\b(play|queue|put\s+on|spin|drop|mix|switch(?:\s+to)?|(?:change|set)\s+(?:the\s+)?(?:vibe|mood)(?:\s+to)?|give\s+me|want\s+(?:some|to\s+hear)|listen\s+to)\b/i.test(lower);
    const playImmediate = /\b(play\s+now|right\s+now|immediately|switch\s+to|change\s+(?:song|track)\s+to|play\s+.+\s+(?:right\s+now|immediately|now))\b/i.test(lower);
    const isConclusion = !explicitPlay && !wantsTrending && !bassPreset && !playbackOp && (
      /^(?:ok(?:ay)?|k|cool|nice|great|awesome|perfect|bet|good|all\s*good|sounds?\s*good|i'?m\s+good|we'?re\s+good|thank(?:s|\s*you)(?:\s+so\s+much|\s+dj|\s+lancy|\s+bro|\s+man)?|ty|thx|that'?s\s*(?:all|it)|thats\s*(?:all|it)|that\s+is\s+(?:all|it)|done|bye|peace|stop\s*chat(?:ting)?|leave\s*it(?:\s*like\s*that)?|sorted|appreciate\s*it|no\s+more|nothing\s+else)[.!~\s♡]*$/i.test(lower) ||
      /\b(?:that'?s\s+all\s+for\s+now|thanks?\s+(?:dj|lancy)|all\s+set\s+thanks|you\s+can\s+conclude|we\s+are\s+done)\b/i.test(lower)
    );
    const isQuestionOnly = !explicitPlay && (/\b(?:who|what(?:'s|s|\s+is|\s+are)?|which|how(?:'s|s|\s+is|\s+are)?|why|when|tell\s+me|recommend|suggest|list|show)\b/i.test(lower) || /\?$/.test(raw));

    let topic = raw
      .replace(/^(?:hey\s+dj|yo\s+dj|lancy|dj)[,\s:]+/i, '')
      .replace(/\b(?:can\s+you|could\s+you|please|i\s+want\s+(?:some|to\s+hear)?|i'?d\s+like|put\s+on|play\s+me|play\s+now|play|queue|spin|drop|mix|switch(?:\s+the\s+vibe)?\s+to|change\s+(?:the\s+)?(?:vibe|mood|song|track)\s+to|set\s+(?:the\s+)?(?:vibe|mood)\s+to|give\s+me|want\s+(?:some|to\s+hear)|listen\s+to|all\s*songs?(?:\s+by|\s+of)?|every\s+song(?:\s+by|\s+of)?|a\s+to\s+z(?:\s+of)?|with\s+(?:clean|heavy|deep|good)?\s*bass|and\s+(?:clean|heavy|deep)?\s*bass|in\s+hd\s+video|music\s+video|immediately|right\s+now)\b/gi, ' ')
      .replace(/\b(?:what'?s|what\s+is|which|are|trending|charting|charts|top\s+\d+|hot|latest|new|popular|music|songs?|tracks?|videos?|right\s+now|today|please|now)\b/gi, ' ')
      .replace(/[?!.,]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^(?:in|for|of|the|some|me|on|to|a|an)\s+/i, '')
      .replace(/\s+(?:in|for|of|the|on|to)$/i, '')
      .trim();
    if (/^(?:something|anything|music|it|this|that|up|on|to)$/i.test(topic)) topic = '';

    const shouldQueue = !isConclusion && !playbackOp && !isQuestionOnly && Boolean(explicitPlay || (!bassPreset && !wantsTrending && topic.length >= 2 && !/\?$/.test(raw)));
    return {
      raw,
      bassPreset,
      playbackOp,
      wantsTrending,
      shouldQueue,
      playImmediate,
      isConclusion,
      topic: cleanLine(topic, 80),
      wantsStudio
    };
  }

  async #findMatches(session, query, { count = 2, excludedIds = null } = {}) {
    const providers = this.app?.musicProviders;
    if (!providers || !query) return [];
    const ytEnabled = Boolean(providers.get?.('youtube')?.enabled);
    const isVideo = Boolean(ytEnabled || session.radio?.video || session.radioVideo || session.currentTrack?.mediaType === 'video');
    const res = await providers.search(query, {
      limit: 6,
      video: isVideo,
      radio: true,
      filterDuration: 'medium'
    }).catch(() => null);
    const excluded = excludedIds || new Set([session.currentTrack?.id, ...(session.upcoming || []).map(t => t.id)].filter(Boolean));
    const ranked = rankTracksTrendingToOld(
      (res?.items || []).filter(t => t?.id && !excluded.has(t.id) && !COMPILATION_RE.test(String(t.title || ''))),
      { isVideo }
    );
    return ranked.slice(0, count).map(t => ({
      ...t,
      mediaType: isVideo ? 'video' : 'audio',
      requester: 'Spotify AI DJ'
    }));
  }

  #enqueuePicks(session, picks = [], { playNow = false } = {}) {
    const qm = this.app?.musicQueueManager;
    if (!qm || qm.closed || !picks.length) return [];
    const added = [];
    const list = playNow ? [...picks].reverse() : picks;
    for (const pick of list) {
      const enqueued = qm.enqueue(session.chatId, pick, { top: Boolean(playNow) });
      if (playNow) added.unshift(enqueued.track);
      else added.push(enqueued.track);
    }
    return added;
  }

  async #queueTopMatches(session, query, { trending = [], count = 2, playNow = false } = {}) {
    const searchQuery = query || (trending[0] ? `${trending[0].artist} - ${trending[0].title}` : session.aiDj?.vibe || 'trending music');
    const picks = await this.#findMatches(session, searchQuery, { count });
    return this.#enqueuePicks(session, picks, { playNow });
  }

  async chatWithDj(session, userText, { ctx = null, apply = true } = {}) {
    if (!session) throw new MusicError('INVALID_DESTINATION', 'Open a music session first.');
    const dj = this.syncSession(session);
    const cleanText = cleanLine(userText, 240);
    if (!cleanText) {
      return {
        reply: '🎙️ Hey, Lancy X here! Ask me what is trending right now, drop a song/artist/vibe to play in HD video, or say "clean bass" to shape the mix.',
        actions: [],
        added: [],
        trending: []
      };
    }

    const intent = this.#detectChatIntent(cleanText);
    const chartGenre = intent.topic || (intent.wantsTrending ? '' : dj.vibe);
    const actions = [];
    let added = [];
    const qm = this.app?.musicQueueManager;
    const service = this.app?.music;

    if (intent.isConclusion) {
      const nowPlaying = session.currentTrack ? `${session.currentTrack.title} — ${session.currentTrack.artist}` : `${dj.vibe} mix`;
      const reply = `🎙️ Anytime! Keeping the mix locked on ${nowPlaying} — enjoy the music and holler whenever you need me.`;
      dj.introNote = cleanLine(reply.replace(/^🎙️\s*/, ''), 140);
      if (!Array.isArray(dj.chatHistory)) dj.chatHistory = [];
      dj.chatHistory.push({ role: 'user', content: cleanText }, { role: 'assistant', content: reply });
      if (dj.chatHistory.length > 8) dj.chatHistory = dj.chatHistory.slice(-8);
      if (qm) await qm.updatePlayerCard(session.chatId).catch(() => {});
      return { reply, actions: ['Concluded DJ chat'], added: [], trending: [], intent, concluded: true };
    }

    const trending = await this.getCharts(chartGenre, 12);

    if (apply) {
      if (intent.bassPreset) {
        session.eqPreset = intent.bassPreset;
        session.bass = intent.bassPreset === 'bass';
        this.app?.db?.setSetting?.(`music.eq.${session.chatId}`, session.eqPreset);
        this.app?.db?.setSetting?.(`music.bass.${session.chatId}`, session.bass);
        actions.push(`EQ: ${session.eqPreset}`);
      }

      if (intent.playbackOp && qm) {
        if (intent.playbackOp === 'skip') {
          this.toggle(session.chatId, true);
          if (!session.upcoming?.length) await this.curateNextTracks(session, { count: 2 }).catch(() => []);
          await service?.prepare?.(ctx || { chatId: session.chatId }, session.chatId).catch(() => {});
          await qm.skip(session.chatId);
          actions.push('Skipped to next track');
        } else if (intent.playbackOp === 'previous') {
          await qm.previous(session.chatId);
          actions.push('Returned to previous track');
        } else if (intent.playbackOp === 'pause') {
          await qm.pause(session.chatId);
          actions.push('Paused');
        } else if (intent.playbackOp === 'resume') {
          await qm.resume(session.chatId);
          actions.push('Resumed');
        }
      } else if (intent.shouldQueue || (intent.wantsTrending && /\b(play|queue|spin|drop|put\s+on|mix)\b/i.test(cleanText))) {
        const nextVibe = intent.topic || (intent.wantsTrending ? 'Global Trending Hits' : dj.vibe);
        this.setVibe(session.chatId, nextVibe);
        const needsPrepare = Boolean(!session.connected && ctx && service?.prepare);
        const preparePromise = needsPrepare ? service.prepare(ctx, session.chatId).catch(() => {}) : Promise.resolve();

        if (intent.wantsTrending && trending.length) {
          const [, ...matchSets] = await Promise.all([
            preparePromise,
            ...trending.slice(0, 3).map(hit => this.#findMatches(session, `${hit.artist} - ${hit.title}`, { count: 1 }).catch(() => []))
          ]);
          const seenPickIds = new Set([session.currentTrack?.id, ...(session.upcoming || []).map(t => t.id)].filter(Boolean));
          const uniquePicks = [];
          for (const set of matchSets) {
            for (const item of set) {
              if (item?.id && !seenPickIds.has(item.id)) {
                seenPickIds.add(item.id);
                uniquePicks.push(item);
                break;
              }
            }
          }
          added = this.#enqueuePicks(session, uniquePicks, { playNow: true });
          if (!added.length) {
            added = await this.#queueTopMatches(session, intent.topic || nextVibe, { trending, count: 2, playNow: true });
          }
        } else {
          const [, queueAdded] = await Promise.all([
            preparePromise,
            intent.playImmediate && qm?.playImmediateAndContinue && ['playing', 'paused', 'buffering'].includes(session.status)
              ? (async () => {
                  const picks = await this.#findMatches(session, intent.topic || nextVibe, { count: 1 });
                  if (picks.length) {
                    const entry = await qm.playImmediateAndContinue(session.chatId, picks[0]);
                    return [entry?.track || picks[0]];
                  }
                  return [];
                })()
              : this.#queueTopMatches(session, intent.topic || nextVibe, { trending, count: 2, playNow: true })
          ]);
          added = queueAdded;
          if (!added.length) {
            added = await this.curateNextTracks(session, { count: 2 }).catch(() => []);
          }
        }
        if (added.length) {
          actions.push(intent.playImmediate ? `Playing "${added[0].title}" immediately (previous playlist continues after)` : `Queued ${added.length} HD video track(s)`);
          if (!['playing', 'paused', 'buffering'].includes(session.status) && qm) {
            await preparePromise;
            await qm.ensurePlaying(session.chatId).catch(() => {});
          }
          if (!intent.wantsTrending && session.upcoming.length < 3) {
            void this.curateNextTracks(session, { count: 2 }).catch(() => {});
          }
        }
      }
    }

    let reply = '';
    const history = Array.isArray(dj.chatHistory) ? dj.chatHistory.slice(-6) : [];
    const nowPlaying = session.currentTrack ? `${session.currentTrack.title} — ${session.currentTrack.artist}` : 'Idle deck';
    const chartSummary = formatTrendingForPrompt(trending, 5);

    if (!intent.playbackOp && this.app?.ai?.generate && Date.now() >= this.aiCooldownUntil) {
      const prompt = [
        `Listener message: "${cleanText}"`,
        actions.length ? `Actions already applied to the live player: ${actions.join('; ')}.` : '',
        added.length ? `Queued next: ${added.slice(0, 3).map(t => `${t.title} (${t.artist})`).join(', ')}.` : '',
        `Now playing: ${nowPlaying}. Vibe: ${dj.vibe}. EQ: ${session.eqPreset || 'off'}.`,
        chartSummary ? `Live Charts Right Now:\n${chartSummary}` : '',
        'Respond in 1–3 concise, upbeat Spotify X DJ sentences accurately reflecting what happened or what is charting.'
      ].filter(Boolean).join('\n');

      const res = await this.#tryAiGenerate({
        prompt,
        task: 'music_dj_chat',
        style: 'cool',
        context: {
          history,
          vibe: dj.vibe,
          nowPlaying,
          eq: session.eqPreset || 'off',
          trending,
          actions
        },
        maxTokens: 200,
        timeoutMs: 12_000,
        maxWords: 90
      });
      if (res?.text) reply = cleanLine(res.text, 380);
    }

    if (!reply) {
      if (intent.wantsTrending && trending.length) {
        const topLines = trending.slice(0, 5).map((t, i) => `${i + 1}. ${t.artist} — ${t.title}`).join('\n');
        reply = added.length
          ? `🎙️ Spinning what's charting right now! Loaded ${added.slice(0, 2).map(t => `"${t.title}"`).join(' & ')} in HD video.\n\n🔥 Top Charts:\n${topLines}`
          : `🎙️ Here's what's charting right now:\n${topLines}\n\nTell me any track or vibe and I'll drop the music video!`;
      } else if (added.length) {
        reply = `🎙️ Locked into ${dj.vibe} — queued ${added.slice(0, 2).map(t => `"${t.title}" by ${t.artist}`).join(' + ')} in HD video${actions.some(a => a.startsWith('EQ:')) ? ` (${session.eqPreset} clean bass active)` : ''}.`;
      } else if (actions.length) {
        reply = `🎙️ Done — ${actions.join(' · ')}. Keep the requests coming!`;
      } else if (trending.length) {
        const topLines = trending.slice(0, 3).map((t, i) => `${i + 1}. ${t.artist} — ${t.title}`).join('\n');
        reply = `🎙️ On deck: ${nowPlaying} (${dj.vibe}).\n\n🔥 Charting right now:\n${topLines}\n\nTell me a track to drop in HD video or say "clean bass"!`;
      } else {
        reply = `🎙️ On deck: ${nowPlaying} (${dj.vibe}). Ask me what's trending, request any artist/song, or ask for clean bass!`;
      }
    }

    dj.introNote = cleanLine(reply.split('\n')[0].replace(/^🎙️\s*/, ''), 140);
    if (!Array.isArray(dj.chatHistory)) dj.chatHistory = [];
    dj.chatHistory.push({ role: 'user', content: cleanText }, { role: 'assistant', content: reply });
    if (dj.chatHistory.length > 8) dj.chatHistory = dj.chatHistory.slice(-8);

    if (qm) await qm.updatePlayerCard(session.chatId).catch(() => {});
    return { reply, actions, added, trending: trending.slice(0, 5), intent };
  }

  async curateNextTracks(session, { count = 3 } = {}) {
    if (!session || this.inflight.has(session.chatId)) return [];
    const providers = this.app?.musicProviders;
    const qm = this.app?.musicQueueManager;
    if (!providers || !qm || qm.closed) return [];

    const dj = this.syncSession(session);
    if (!Array.isArray(dj.seenTitles)) dj.seenTitles = [];
    this.inflight.add(session.chatId);
    try {
      const ytEnabled = Boolean(providers.get?.('youtube')?.enabled);
      const isVideo = Boolean(session.radio?.video || session.radioVideo || session.currentTrack?.mediaType === 'video' || ytEnabled);
      const baseVibe = dj?.vibe || session.radio?.queries?.[0] || DEFAULT_VIBE;
      const artistPlan = await this.#resolveArtistPlan(session, baseVibe);

      const excludedIds = new Set([
        session.currentTrack?.id,
        ...(session.upcoming || []).map(t => t.id),
        ...(session.history || []).map(t => t.id),
        ...(dj.seenIds || [])
      ].filter(Boolean));
      const excludedTitles = new Set([
        session.currentTrack,
        ...(session.upcoming || []),
        ...(session.history || [])
      ].map(t => normTrackTitleKey(t?.artist, t?.title)).concat(dj.seenTitles || []).filter(Boolean));

      const hasAdapters = Boolean(providers.adapters);
      const filterCandidate = (t) => {
        if (!t?.id || excludedIds.has(t.id)) return false;
        if (t.availability === 'unavailable' || t.streamable === false || t.isLive || t.duration === 'LIVE') return false;
        if (COMPILATION_RE.test(String(t.title || ''))) return false;
        if (hasAdapters && (!Number.isFinite(t.durationSeconds) || t.durationSeconds < 40 || t.durationSeconds > 720)) return false;
        const tk = normTrackTitleKey(t.artist, t.title);
        if (tk && excludedTitles.has(tk)) return false;
        return true;
      };

      const picked = [];
      let transitionedNotice = '';

      if (artistPlan?.found && artistPlan.stage === 'artist') {
        const targetNorm = normArtist(artistPlan.artist);
        const matchesPlanArtist = (t) => {
          const ta = normArtist(t?.artist);
          return !targetNorm || !ta || ta.includes(targetNorm) || targetNorm.includes(ta) || normArtist(t?.title).includes(targetNorm);
        };

        for (let round = 0; round < 2 && artistPlan.catalogCursor < artistPlan.catalog.length && picked.length < count; round++) {
          const batch = [];
          while (artistPlan.catalogCursor < artistPlan.catalog.length && batch.length < count + 1) {
            const entry = artistPlan.catalog[artistPlan.catalogCursor++];
            const tk = normTrackTitleKey(entry.artist || artistPlan.artist, entry.title);
            if (!entry?.title || (tk && excludedTitles.has(tk))) continue;
            batch.push(entry);
          }
          if (!batch.length) break;
          const pages = await Promise.all(
            batch.map(entry =>
              providers.search(`${artistPlan.artist} ${entry.title}`, {
                offset: 0,
                limit: 3,
                video: isVideo,
                radio: true,
                filterDuration: 'medium'
              }).catch(() => null)
            )
          );
          for (const pg of pages) {
            if (picked.length >= count || session.upcoming.length >= 100) break;
            const filtered = (pg?.items || []).filter(filterCandidate);
            const strict = filtered.filter(matchesPlanArtist);
            const ranked = rankTracksTrendingToOld(strict.length ? strict : filtered, { isVideo });
            const chosen = ranked[0];
            if (chosen) {
              excludedIds.add(chosen.id);
              const tk = normTrackTitleKey(chosen.artist, chosen.title);
              if (tk) { excludedTitles.add(tk); dj.seenTitles.push(tk); }
              dj.seenIds.push(chosen.id);
              picked.push(chosen);
            }
          }
        }

        if (picked.length < count && artistPlan.providerPass < 2) {
          const qDirect = artistPlan.providerPass === 0 ? artistPlan.artist : `${artistPlan.artist} classic hits`;
          artistPlan.providerPass++;
          const page = await providers.search(qDirect, {
            offset: (artistPlan.providerPass - 1) * 6,
            limit: hasAdapters ? 12 : 6,
            video: isVideo,
            radio: true,
            filterDuration: 'medium'
          }).catch(() => null);
          const filtered = (page?.items || []).filter(filterCandidate);
          const strict = filtered.filter(matchesPlanArtist);
          const ranked = rankTracksTrendingToOld(strict.length ? strict : filtered, { isVideo });
          for (const chosen of ranked) {
            if (picked.length >= count || session.upcoming.length >= 100) break;
            excludedIds.add(chosen.id);
            const tk = normTrackTitleKey(chosen.artist, chosen.title);
            if (tk) { excludedTitles.add(tk); dj.seenTitles.push(tk); }
            dj.seenIds.push(chosen.id);
            picked.push(chosen);
          }
        }

        if (!picked.length) {
          artistPlan.stage = 'related';
          if (!artistPlan.relatedArtists?.length && artistPlan.genre) {
            const chartPeers = await this.getCharts(artistPlan.genre, 15).catch(() => []);
            const seenNames = new Set([normArtist(artistPlan.artist)]);
            artistPlan.relatedArtists = [];
            for (const x of chartPeers) {
              const name = String(x.artist || '').split(/[,&]|feat\.?|ft\./i)[0].trim();
              const an = normArtist(name);
              if (!an || seenNames.has(an)) continue;
              seenNames.add(an);
              artistPlan.relatedArtists.push({ name, genre: artistPlan.genre });
            }
          }
          const peerList = (artistPlan.relatedArtists || []).slice(0, 3).map(a => a?.name || a).filter(Boolean).join(', ');
          transitionedNotice = peerList
            ? `Finished ${artistPlan.artist}'s run — rolling into related ${artistPlan.genre || 'category'} artists: ${peerList}.`
            : `Finished ${artistPlan.artist}'s run — expanding into related artists.`;
        }
      }

      if (!picked.length) {
        const queries = await this.#suggestSearchQueries(session, null, artistPlan);
        const recentArtists = new Set([
          artistPlan?.stage === 'related' ? normArtist(artistPlan.artist) : null,
          normArtist(session.currentTrack?.artist),
          ...(session.upcoming || []).slice(-3).map(t => normArtist(t.artist)),
          ...(session.history || []).slice(-3).map(t => normArtist(t.artist))
        ].filter(Boolean));

        for (const query of queries) {
          if (picked.length >= count) break;
          const page = await providers.search(query, {
            offset: (dj.cursor % 3) * 5,
            limit: hasAdapters ? 12 : 6,
            video: isVideo,
            radio: true,
            filterDuration: 'medium'
          }).catch(() => null);

          const fresh = rankTracksTrendingToOld((page?.items || []).filter(filterCandidate), { isVideo });

          // Prefer distinct artists first, relax only if nothing else exists
          const distinctArtist = fresh.filter(t => {
            const a = normArtist(t.artist);
            return !a || !recentArtists.has(a);
          });
          const pool = distinctArtist.length ? distinctArtist : fresh;
          for (const item of pool) {
            if (picked.length >= count || session.upcoming.length >= 100) break;
            excludedIds.add(item.id);
            const a = normArtist(item.artist);
            if (a) recentArtists.add(a);
            const tk = normTrackTitleKey(item.artist, item.title);
            if (tk) { excludedTitles.add(tk); dj.seenTitles.push(tk); }
            dj.seenIds.push(item.id);
            picked.push(item);
          }
        }
      }

      dj.seenIds = (dj.seenIds || []).slice(-350);
      dj.seenTitles = (dj.seenTitles || []).slice(-350);
      const added = [];
      for (const t of picked) {
        const res = qm.enqueue(session.chatId, {
          ...t,
          mediaType: isVideo ? 'video' : 'audio',
          requester: 'AI DJ'
        });
        added.push(res.track);
      }

      if (transitionedNotice) {
        dj.introNote = transitionedNotice;
      } else if (added.length) {
        await this.generateIntroNote(session, added[0], session.currentTrack);
      }
      return added;
    } finally {
      this.inflight.delete(session.chatId);
    }
  }
}
