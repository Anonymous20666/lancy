import { randomBytes } from 'node:crypto';

/**
 * Persistent interactive UI session store for Movie & TV Series search,
 * Season 1..N switching, pagination, multi-select episode checkboxes, and
 * paginated download album manifests. Never expires active cards across normal use
 * or restarts when backed by SQLite `db`.
 */
export class MovieSessions {
  constructor(options = {}) {
    const opts = typeof options === 'number' ? { ttlMs: options } : (options || {});
    this.ttlMs = Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : 0; // 0 = non-expiring (LRU capped)
    this.db = opts.db || null;
    this.maxSessions = Math.max(50, Number(opts.maxSessions) || 300);
    this.settingKey = opts.settingKey || 'movie.sessions.v1';
    this.sessions = new Map();
    this.byChat = new Map();
    this.byMessage = new Map(); // `${chatId}:${messageId}` -> sid
    this.saveTimer = null;
    this.#load();
  }

  #serializeSession(s) {
    return {
      id: s.id,
      revision: s.revision || 1,
      chatId: s.chatId,
      userId: s.userId ?? null,
      botKey: s.botKey ?? null,
      destination: s.destination ?? null,
      panelToken: s.panelToken ?? null,
      channelMode: Boolean(s.channelMode),
      view: s.view || 'hub',
      query: s.query || '',
      categoryLabel: s.categoryLabel || '',
      categories: Array.isArray(s.categories) ? s.categories.slice(0, 40) : [],
      catPage: s.catPage || 0,
      results: Array.isArray(s.results) ? s.results.slice(0, 25) : [],
      resultPage: s.resultPage || 0,
      mediaItem: s.mediaItem || null,
      playback: s.playback || null,
      seasons: Array.isArray(s.seasons) ? s.seasons : [],
      seasonNumber: Number(s.seasonNumber || 1),
      seasonName: s.seasonName || 'Season 1',
      seasonOverview: s.seasonOverview || '',
      seasonPage: s.seasonPage || 0,
      episodes: Array.isArray(s.episodes) ? s.episodes : [],
      episodeCache: s.episodeCache instanceof Map ? [...s.episodeCache.entries()] : [],
      epPage: s.epPage || 0,
      selectedBySeason: s.selectedBySeason instanceof Map
        ? [...s.selectedBySeason.entries()].map(([k, set]) => [Number(k), [...set]])
        : [],
      dlManifest: s.dlManifest || null,
      dlPage: Number(s.dlPage || 0),
      dlMessageId: s.dlMessageId || null,
      dlMediaMessageIds: Array.isArray(s.dlMediaMessageIds) ? s.dlMediaMessageIds.slice(-40) : [],
      dlKeptPages: Array.isArray(s.dlKeptPages) ? [...new Set(s.dlKeptPages.map(Number))] : [],
      dlKeptMessageIds: Array.isArray(s.dlKeptMessageIds) ? [...new Set(s.dlKeptMessageIds.map(Number))].slice(-80) : [],
      adultMode: s.adultMode || null,
      sourceMode: s.sourceMode === 'xvideos' ? 'xvideos' : 'movie',
      xvMode: s.xvMode || null,
      xvQuery: s.xvQuery || '',
      xvCat: s.xvCat || '',
      xvArtist: s.xvArtist || '',
      xvSort: s.xvSort || 'relevance',
      xvDur: s.xvDur || 'all',
      xvQuality: s.xvQuality || '480p',
      xvResults: Array.isArray(s.xvResults) ? s.xvResults.slice(0, 30) : [],
      xvSelected: s.xvSelected instanceof Set
        ? [...s.xvSelected].map(Number).filter(Number.isFinite)
        : (Array.isArray(s.xvSelected) ? s.xvSelected.map(Number).filter(Number.isFinite) : []),
      xvCurrentIdx: Number(s.xvCurrentIdx || 0),
      xvResolved: s.xvResolved || null,
      xvResPage: Number(s.xvResPage || 0),
      xvApiPage: Number(s.xvApiPage || 0),
      xvTotalPages: Math.max(1, Number(s.xvTotalPages || 1)),
      xvCatPage: Number(s.xvCatPage || 0),
      xvArtistPage: Number(s.xvArtistPage || 0),
      notice: s.notice || null,
      messageId: s.messageId || null,
      activeCardIds: Array.isArray(s.activeCardIds) ? s.activeCardIds.slice(-10) : [],
      promptMessageId: s.promptMessageId || null,
      createdAt: s.createdAt || Date.now(),
      updatedAt: s.updatedAt || Date.now()
    };
  }

  #hydrateSession(raw) {
    if (!raw?.id) return null;
    const epCache = new Map();
    if (Array.isArray(raw.episodeCache)) {
      for (const [k, v] of raw.episodeCache) {
        if (Array.isArray(v)) epCache.set(Number(k), v);
      }
    }
    const selMap = new Map();
    if (Array.isArray(raw.selectedBySeason)) {
      for (const [k, arr] of raw.selectedBySeason) {
        if (Array.isArray(arr)) selMap.set(Number(k), new Set(arr.map(Number)));
      }
    }
    const xvSel = new Set(Array.isArray(raw.xvSelected) ? raw.xvSelected.map(Number).filter(Number.isFinite) : []);
    return {
      ...raw,
      chatId: Number(raw.chatId),
      userId: raw.userId != null ? Number(raw.userId) : null,
      sourceMode: raw.sourceMode === 'xvideos' ? 'xvideos' : 'movie',
      xvMode: raw.xvMode || null,
      xvQuery: raw.xvQuery || '',
      xvCat: raw.xvCat || '',
      xvArtist: raw.xvArtist || '',
      xvSort: raw.xvSort || 'relevance',
      xvDur: raw.xvDur || 'all',
      xvQuality: raw.xvQuality || '480p',
      xvResults: Array.isArray(raw.xvResults) ? raw.xvResults : [],
      xvSelected: xvSel,
      xvCurrentIdx: Number(raw.xvCurrentIdx || 0),
      xvResolved: raw.xvResolved || null,
      xvResPage: Number(raw.xvResPage || 0),
      xvApiPage: Number(raw.xvApiPage || 0),
      xvTotalPages: Math.max(1, Number(raw.xvTotalPages || 1)),
      xvCatPage: Number(raw.xvCatPage || 0),
      xvArtistPage: Number(raw.xvArtistPage || 0),
      episodeCache: epCache,
      selectedBySeason: selMap,
      dlMediaMessageIds: Array.isArray(raw.dlMediaMessageIds) ? raw.dlMediaMessageIds.map(Number).filter(Number.isFinite) : [],
      dlKeptPages: Array.isArray(raw.dlKeptPages) ? [...new Set(raw.dlKeptPages.map(Number).filter(Number.isFinite))] : [],
      dlKeptMessageIds: Array.isArray(raw.dlKeptMessageIds) ? [...new Set(raw.dlKeptMessageIds.map(Number).filter(Number.isFinite))] : [],
      logLines: null
    };
  }

  #load() {
    try {
      const stored = this.db?.getSetting?.(this.settingKey, []);
      if (!Array.isArray(stored)) return;
      for (const item of stored) {
        const s = this.#hydrateSession(item);
        if (!s) continue;
        this.sessions.set(s.id, s);
        if (Number.isFinite(s.chatId)) this.byChat.set(s.chatId, s.id);
        if (s.chatId && s.messageId) this.byMessage.set(`${s.chatId}:${s.messageId}`, s.id);
        if (s.chatId && s.dlMessageId) this.byMessage.set(`${s.chatId}:${s.dlMessageId}`, s.id);
      }
    } catch {}
  }

  persistNow() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.db?.setSetting) return;
    try {
      const sorted = [...this.sessions.values()]
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, this.maxSessions)
        .map((s) => this.#serializeSession(s));
      this.db.setSetting(this.settingKey, sorted);
    } catch {}
  }

  #scheduleSave() {
    if (!this.db?.setSetting || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.persistNow();
    }, 350);
    this.saveTimer.unref?.();
  }

  #sweep() {
    const now = Date.now();
    if (this.ttlMs > 0) {
      for (const [id, s] of this.sessions) {
        if (now - s.updatedAt > this.ttlMs) {
          this.sessions.delete(id);
        }
      }
    }
    if (this.sessions.size > this.maxSessions) {
      const byAge = [...this.sessions.values()].sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
      const removeCount = this.sessions.size - this.maxSessions;
      for (let i = 0; i < removeCount; i++) {
        this.sessions.delete(byAge[i].id);
      }
    }
  }

  registerMessage(s, messageId, kind = 'card') {
    if (!s || !messageId) return;
    const msgId = Number(messageId);
    if (!Number.isFinite(msgId)) return;
    if (kind === 'dl_media') {
      if (!Array.isArray(s.dlMediaMessageIds)) s.dlMediaMessageIds = [];
      if (!s.dlMediaMessageIds.includes(msgId)) s.dlMediaMessageIds.push(msgId);
      if (s.dlMediaMessageIds.length > 40) s.dlMediaMessageIds = s.dlMediaMessageIds.slice(-40);
      this.#scheduleSave();
      return;
    }
    if (kind === 'dl') {
      s.dlMessageId = msgId;
    } else {
      if (!Array.isArray(s.activeCardIds)) s.activeCardIds = [];
      if (!s.activeCardIds.includes(msgId)) s.activeCardIds.push(msgId);
      if (s.activeCardIds.length > 10) s.activeCardIds = s.activeCardIds.slice(-10);
      s.messageId = msgId;
    }
    if (Number.isFinite(s.chatId)) {
      this.byMessage.set(`${s.chatId}:${msgId}`, s.id);
    }
    this.#scheduleSave();
  }

  clearSlideMessages(s) {
    if (!s) return;
    s.dlMessageId = null;
    s.dlMediaMessageIds = [];
    this.touch(s);
  }

  getByMessage(chatId, messageId) {
    const sid = this.byMessage.get(`${Number(chatId)}:${Number(messageId)}`);
    return sid ? this.get(sid) : null;
  }

  create({ chatId, userId = null, botKey = null, destination = null, panelToken = null, view = 'hub', query = '', results = [], channelMode = false, adultMode = null, sourceMode = 'movie' } = {}) {
    this.#sweep();
    const id = randomBytes(3).toString('hex'); // 6 chars
    const session = {
      id,
      revision: 1,
      chatId: Number(chatId),
      userId: userId != null ? Number(userId) : null,
      botKey,
      destination,
      panelToken,
      channelMode: Boolean(channelMode),
      adultMode,
      sourceMode: sourceMode === 'xvideos' ? 'xvideos' : 'movie',
      xvMode: null,
      xvQuery: '',
      xvCat: '',
      xvArtist: '',
      xvSort: 'relevance',
      xvDur: 'all',
      xvQuality: '480p',
      xvResults: [],
      xvSelected: new Set(),
      xvCurrentIdx: 0,
      xvResolved: null,
      xvResPage: 0,
      xvApiPage: 0,
      xvTotalPages: 1,
      xvCatPage: 0,
      xvArtistPage: 0,
      view, // 'hub' | 'results' | 'movie' | 'season' | 'seasons' | 'categories' | 'dl' | 'xv_results' | 'xv_detail' | 'xv_cats' | 'xv_artists'
      query: String(query || ''),
      categoryLabel: '',
      categories: [],
      catPage: 0,
      results: Array.isArray(results) ? results : [],
      resultPage: 0,
      mediaItem: null,
      playback: null,
      seasons: [],
      seasonNumber: 1,
      seasonName: 'Season 1',
      seasonOverview: '',
      seasonPage: 0,
      episodes: [],
      episodeCache: new Map(),
      epPage: 0,
      // Map<seasonNumber, Set<episodeNumber>>
      selectedBySeason: new Map(),
      dlManifest: null,
      dlPage: 0,
      dlMessageId: null,
      dlMediaMessageIds: [],
      dlKeptPages: [],
      dlKeptMessageIds: [],
      notice: null,
      messageId: null,
      activeCardIds: [],
      promptMessageId: null,
      temporaryToken: null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    this.sessions.set(id, session);
    if (Number.isFinite(session.chatId)) this.byChat.set(session.chatId, session.id);
    this.#scheduleSave();
    return session;
  }

  get(id) {
    const s = this.sessions.get(String(id || ''));
    if (!s) return null;
    if (this.ttlMs > 0 && Date.now() - s.updatedAt > this.ttlMs) {
      this.sessions.delete(s.id);
      return null;
    }
    s.updatedAt = Date.now();
    return s;
  }

  getLatestForChat(chatId) {
    const sid = this.byChat.get(Number(chatId));
    return sid ? this.get(sid) : null;
  }

  touch(s) {
    if (!s) return s;
    s.revision = (s.revision || 0) + 1;
    s.updatedAt = Date.now();
    this.#scheduleSave();
    return s;
  }

  getSelectedSet(s, seasonNum = s?.seasonNumber) {
    const k = Number(seasonNum ?? 1);
    let set = s.selectedBySeason.get(k);
    if (!set) {
      set = new Set();
      s.selectedBySeason.set(k, set);
    }
    return set;
  }

  totalSelectedCount(s) {
    let n = 0;
    for (const set of s.selectedBySeason.values()) n += set.size;
    return n;
  }

  toggleEpisode(s, seasonNum, episodeNum) {
    const set = this.getSelectedSet(s, seasonNum);
    const ep = Number(episodeNum);
    if (set.has(ep)) set.delete(ep);
    else set.add(ep);
    this.touch(s);
    return set.has(ep);
  }

  selectPageEpisodes(s, pageSize = 6) {
    const start = (s.epPage || 0) * pageSize;
    const slice = (s.episodes || []).slice(start, start + pageSize);
    const set = this.getSelectedSet(s, s.seasonNumber);
    const allSelected = slice.length > 0 && slice.every((ep) => set.has(ep.episodeNumber));
    for (const ep of slice) {
      if (allSelected) set.delete(ep.episodeNumber);
      else set.add(ep.episodeNumber);
    }
    this.touch(s);
    return !allSelected;
  }

  selectAllInSeason(s) {
    const set = this.getSelectedSet(s, s.seasonNumber);
    const eps = s.episodes || [];
    const allSelected = eps.length > 0 && eps.every((ep) => set.has(ep.episodeNumber));
    if (allSelected) set.clear();
    else {
      for (const ep of eps) set.add(ep.episodeNumber);
    }
    this.touch(s);
    return !allSelected;
  }

  /**
   * Select (or toggle off if already 100% selected) every episode across ALL valid seasons.
   * `episodesBySeason` may be a Map<seasonNum, episodes[]> or plain object.
   */
  selectAllSeasonsAndEpisodes(s, episodesBySeason = null) {
    if (episodesBySeason) {
      const entries = episodesBySeason instanceof Map
        ? [...episodesBySeason.entries()]
        : Object.entries(episodesBySeason);
      for (const [k, eps] of entries) {
        if (Array.isArray(eps) && eps.length) {
          s.episodeCache.set(Number(k), eps);
        }
      }
    }
    const validSeasonNums = (s.seasons || [])
      .map((se) => Number(se.seasonNumber))
      .filter((n) => Number.isFinite(n) && n >= 1 && (s.episodeCache.get(n)?.length || (n === Number(s.seasonNumber) ? s.episodes?.length : 0)));
    const targetSeasons = validSeasonNums.length ? validSeasonNums : [...s.episodeCache.keys()].filter((n) => n >= 1);

    let totalAvailable = 0;
    let totalAlreadySelected = 0;
    for (const sNum of targetSeasons) {
      const eps = s.episodeCache.get(sNum) || (sNum === Number(s.seasonNumber) ? (s.episodes || []) : []);
      const set = this.getSelectedSet(s, sNum);
      for (const ep of eps) {
        totalAvailable++;
        if (set.has(Number(ep.episodeNumber))) totalAlreadySelected++;
      }
    }

    const shouldSelect = !(totalAvailable > 0 && totalAlreadySelected === totalAvailable);
    for (const sNum of targetSeasons) {
      const eps = s.episodeCache.get(sNum) || (sNum === Number(s.seasonNumber) ? (s.episodes || []) : []);
      const set = this.getSelectedSet(s, sNum);
      if (!shouldSelect) {
        set.clear();
      } else {
        for (const ep of eps) set.add(Number(ep.episodeNumber));
      }
    }
    this.touch(s);
    return {
      selected: shouldSelect,
      seasonsCount: targetSeasons.length,
      episodesCount: shouldSelect ? totalAvailable : 0
    };
  }

  clearSelections(s) {
    s.selectedBySeason.clear();
    this.touch(s);
  }

  setDownloadManifest(s, items = [], { pageSize = 4, title = '', type = 'movie', albumTitle = '' } = {}) {
    if (!s) return null;
    s.dlManifest = {
      items: Array.isArray(items) ? items : [],
      pageSize: Math.max(1, Math.min(10, Number(pageSize) || 4)),
      title: String(title || s.mediaItem?.title || 'Movie Selection'),
      type: String(type || s.mediaItem?.type || 'movie'),
      albumTitle: String(albumTitle || '')
    };
    s.dlPage = 0;
    this.touch(s);
    return s.dlManifest;
  }

  /**
   * Return all selected episodes ordered cleanly by (seasonNumber ASC, episodeNumber ASC).
   */
  getSelectedEpisodes(s, seasonEpisodesCache = null) {
    const out = [];
    const seasonNums = [...s.selectedBySeason.keys()].sort((a, b) => a - b);
    for (const sNum of seasonNums) {
      const set = s.selectedBySeason.get(sNum);
      if (!set || !set.size) continue;
      const epList = sNum === s.seasonNumber
        ? (s.episodes || [])
        : (seasonEpisodesCache?.get?.(sNum) || []);
      const sortedEps = [...set].sort((a, b) => a - b);
      for (const epNum of sortedEps) {
        const meta = epList.find((e) => e.episodeNumber === epNum);
        out.push({
          seasonNumber: sNum,
          episodeNumber: epNum,
          title: meta?.title || `Episode ${epNum}`,
          runtimeSeconds: meta?.runtimeSeconds || null,
          still: meta?.still || null
        });
      }
    }
    return out;
  }

  /**
   * Format short callback: mv:<sid>:<action>:<arg> (always <= 32 chars)
   */
  cb(s, action, arg = '') {
    const raw = arg !== '' && arg !== undefined && arg !== null
      ? `mv:${s.id}:${action}:${arg}`
      : `mv:${s.id}:${action}`;
    return raw.slice(0, 64);
  }
}
