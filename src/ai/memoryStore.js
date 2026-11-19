/**
 * Unified 3-Scope Memory Store for Lancy AI
 *
 * Scopes:
 *  - 'session': Short-term conversation turns, speaker-to-statement links, current & previous topics,
 *    unanswered questions, pending follow-up references (persisted in `ai_session_context`).
 *  - 'user': Private individual user facts, preferred name, language/slang, music/movie preferences,
 *    explicit "remember that..." items, user-controlled deletion (strictly keyed by `user_id`, NEVER leaked to others).
 *  - 'group': Group-level established preferences, watch party vibes, recurring activities, shared context
 *    (strictly keyed by `chat_id`, never merged with private DM memories).
 */
import { normalizeDisplayName } from './userProfile.js';

const MAX_SESSION_TURNS = 24;
const MAX_PREV_TOPICS = 8;

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3);
}

function normKey(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || 'fact';
}

export class UnifiedMemoryStore {
  constructor({ db = null, log = null } = {}) {
    this.db = db;
    this.log = log;
    this.sessionCache = new Map();
  }

  // ────────────────────────────────────────────────────────────────────────
  // A. Short-Term Session Context (multi-speaker turns, topics, references)
  // ────────────────────────────────────────────────────────────────────────

  getSessionContext(sessionKey, { chatId = 0, surface = 'vc' } = {}) {
    const key = String(sessionKey || `${surface}:${Number(chatId) || 0}`);
    if (this.sessionCache.has(key)) return this.sessionCache.get(key);

    let loaded = null;
    if (this.db?.get) {
      try {
        const row = this.db.get('SELECT * FROM ai_session_context WHERE session_key = ?', key);
        if (row) {
          loaded = {
            sessionKey: key,
            chatId: Number(row.chat_id ?? chatId),
            surface: row.surface || surface,
            currentTopic: row.current_topic || null,
            previousTopics: safeJson(row.previous_topics_json, []),
            speakerTurns: safeJson(row.speaker_turns_json, []),
            unansweredQuestions: safeJson(row.unanswered_questions_json, []),
            pendingReferences: safeJson(row.pending_references_json, []),
            activeSpeakerId: row.active_speaker_id ? Number(row.active_speaker_id) : null,
            activeSpeakerName: row.active_speaker_name || null,
            mode: row.mode || 'IDLE',
            summary: row.summary || null,
            updatedAt: Date.now()
          };
        }
      } catch {}
    }

    const ctx = loaded || {
      sessionKey: key,
      chatId: Number(chatId) || 0,
      surface,
      currentTopic: null,
      previousTopics: [],
      speakerTurns: [],
      unansweredQuestions: [],
      pendingReferences: [],
      activeSpeakerId: null,
      activeSpeakerName: null,
      mode: 'IDLE',
      summary: null,
      updatedAt: Date.now()
    };
    this.sessionCache.set(key, ctx);
    return ctx;
  }

  saveSessionContext(ctx) {
    if (!ctx?.sessionKey) return;
    ctx.updatedAt = Date.now();
    if (!this.db?.run) return;
    try {
      this.db.run(
        `INSERT INTO ai_session_context (
          session_key, chat_id, surface, current_topic, previous_topics_json,
          speaker_turns_json, unanswered_questions_json, pending_references_json,
          active_speaker_id, active_speaker_name, mode, summary, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(session_key) DO UPDATE SET
          current_topic = excluded.current_topic,
          previous_topics_json = excluded.previous_topics_json,
          speaker_turns_json = excluded.speaker_turns_json,
          unanswered_questions_json = excluded.unanswered_questions_json,
          pending_references_json = excluded.pending_references_json,
          active_speaker_id = excluded.active_speaker_id,
          active_speaker_name = excluded.active_speaker_name,
          mode = excluded.mode,
          summary = excluded.summary,
          updated_at = datetime('now')`,
        ctx.sessionKey,
        Number(ctx.chatId || 0),
        String(ctx.surface || 'vc'),
        ctx.currentTopic || null,
        JSON.stringify((ctx.previousTopics || []).slice(-MAX_PREV_TOPICS)),
        JSON.stringify((ctx.speakerTurns || []).slice(-MAX_SESSION_TURNS)),
        JSON.stringify((ctx.unansweredQuestions || []).slice(-6)),
        JSON.stringify((ctx.pendingReferences || []).slice(-6)),
        ctx.activeSpeakerId ? Number(ctx.activeSpeakerId) : null,
        ctx.activeSpeakerName || null,
        String(ctx.mode || 'IDLE'),
        ctx.summary || null
      );
    } catch {}
  }

  recordSpeakerTurn(sessionKey, {
    chatId = 0,
    surface = 'vc',
    userId = null,
    speakerName = 'Speaker',
    role = 'user',
    text = '',
    addressedToLancy = false,
    confidence = 1,
    simultaneousSpeakers = []
  } = {}) {
    const cleanText = String(text || '').trim();
    if (!cleanText) return null;
    const sc = this.getSessionContext(sessionKey, { chatId, surface });
    const cleanSpeaker = role === 'assistant' ? 'Lancy' : normalizeDisplayName(speakerName, 'Member');

    const turn = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      ts: Date.now(),
      role,
      userId: userId ? Number(userId) : null,
      speakerName: cleanSpeaker,
      text: cleanText.slice(0, 400),
      addressedToLancy: Boolean(addressedToLancy),
      confidence: Number.isFinite(Number(confidence)) ? Number(confidence) : 1,
      ...(simultaneousSpeakers?.length ? { simultaneousSpeakers: simultaneousSpeakers.slice(0, 5) } : {})
    };
    sc.speakerTurns.push(turn);
    while (sc.speakerTurns.length > MAX_SESSION_TURNS) sc.speakerTurns.shift();

    if (role === 'user') {
      sc.activeSpeakerId = userId ? Number(userId) : sc.activeSpeakerId;
      sc.activeSpeakerName = cleanSpeaker;
      const detectedTopic = inferTopicLabel(cleanText);
      if (detectedTopic && detectedTopic !== sc.currentTopic) {
        if (sc.currentTopic && !sc.previousTopics.includes(sc.currentTopic)) {
          sc.previousTopics.push(sc.currentTopic);
          while (sc.previousTopics.length > MAX_PREV_TOPICS) sc.previousTopics.shift();
        }
        sc.currentTopic = detectedTopic;
      }
      if (cleanText.includes('?') || /^(?:what|who|why|how|when|where|which|can|could|did|do|is|are)\b/i.test(cleanText)) {
        sc.unansweredQuestions.push({ speaker: cleanSpeaker, text: cleanText.slice(0, 180), ts: Date.now() });
        if (sc.unansweredQuestions.length > 6) sc.unansweredQuestions.shift();
      }
    } else if (role === 'assistant') {
      // Mark latest question addressed once Lancy replies
      if (sc.unansweredQuestions.length) sc.unansweredQuestions.pop();
    }

    this.saveSessionContext(sc);
    return turn;
  }

  findSpeakerStatement(sessionKey, { speakerQuery = '', chatId = 0, surface = 'vc' } = {}) {
    const sc = this.getSessionContext(sessionKey, { chatId, surface });
    const needle = String(speakerQuery || '').trim().toLowerCase();
    const turns = [...(sc.speakerTurns || [])].reverse();
    if (!needle) return turns.find((t) => t.role === 'user') || null;
    return turns.find((t) =>
      t.role === 'user' && (
        String(t.speakerName || '').toLowerCase().includes(needle)
        || String(t.text || '').toLowerCase().includes(needle)
      )
    ) || null;
  }

  setPendingReference(sessionKey, ref, { chatId = 0, surface = 'vc' } = {}) {
    const sc = this.getSessionContext(sessionKey, { chatId, surface });
    sc.pendingReferences.push({ ...ref, ts: Date.now() });
    while (sc.pendingReferences.length > 6) sc.pendingReferences.shift();
    this.saveSessionContext(sc);
  }

  // ────────────────────────────────────────────────────────────────────────
  // B. Individual Private User Memory (strictly isolated per userId)
  // ────────────────────────────────────────────────────────────────────────

  rememberFact({
    scope = 'user',
    scopeKey,
    userId = null,
    chatId = null,
    factKey,
    category = 'fact',
    content,
    confidence = 0.9,
    salience = 1.0,
    source = 'inferred',
    expiresAt = null
  }) {
    if (!this.db?.run || !scopeKey || !content) return false;
    const cleanKey = normKey(factKey || content.slice(0, 40));
    const cleanContent = String(content).trim().slice(0, 500);
    if (!cleanContent) return false;

    try {
      this.db.run(
        `INSERT INTO ai_memories (
          scope, scope_key, user_id, chat_id, fact_key, category, content,
          confidence, salience, source, expires_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(scope, scope_key, fact_key) DO UPDATE SET
          category = excluded.category,
          content = excluded.content,
          confidence = excluded.confidence,
          salience = MAX(ai_memories.salience, excluded.salience),
          source = excluded.source,
          expires_at = excluded.expires_at,
          updated_at = datetime('now')`,
        String(scope),
        String(scopeKey),
        userId != null ? Number(userId) : null,
        chatId != null ? Number(chatId) : null,
        cleanKey,
        String(category || 'fact'),
        cleanContent,
        Number(confidence) || 0.9,
        Number(salience) || 1.0,
        String(source || 'inferred'),
        expiresAt != null ? Number(expiresAt) : null
      );
      return true;
    } catch {
      return false;
    }
  }

  rememberUserFact(userId, factKey, content, opts = {}) {
    const uid = Number(userId);
    if (!Number.isSafeInteger(uid) || uid <= 0) return false;
    return this.rememberFact({
      scope: 'user',
      scopeKey: String(uid),
      userId: uid,
      factKey,
      ...opts,
      content
    });
  }

  rememberGroupFact(chatId, factKey, content, opts = {}) {
    const cid = Number(chatId);
    if (!Number.isSafeInteger(cid) || cid === 0) return false;
    return this.rememberFact({
      scope: 'group',
      scopeKey: String(cid),
      chatId: cid,
      factKey,
      ...opts,
      content
    });
  }

  #queryMemories(scope, scopeKey, { query = '', limit = 8 } = {}) {
    if (!this.db?.all || !scopeKey) return [];
    const now = Date.now();
    try {
      this.db.run('DELETE FROM ai_memories WHERE expires_at IS NOT NULL AND expires_at <= ?', now);
      const rows = this.db.all(
        `SELECT * FROM ai_memories
         WHERE scope = ? AND scope_key = ? AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY salience DESC, updated_at DESC
         LIMIT 50`,
        String(scope),
        String(scopeKey),
        now
      );
      if (!rows?.length) return [];

      const qTokens = new Set(tokenize(query));
      const scored = rows.map((r) => {
        const memTokens = tokenize(`${r.fact_key} ${r.category} ${r.content}`);
        let overlap = 0;
        for (const t of memTokens) {
          if (qTokens.has(t)) overlap += 1;
        }
        const explicitBoost = r.source === 'explicit' ? 0.6 : 0;
        const score = (Number(r.salience) || 1) + explicitBoost + overlap * 0.85;
        return { ...r, score };
      });
      scored.sort((a, b) => b.score - a.score);
      const picked = scored.slice(0, limit);
      for (const p of picked) {
        try {
          this.db.run('UPDATE ai_memories SET access_count = access_count + 1 WHERE id = ?', p.id);
        } catch {}
      }
      return picked;
    } catch {
      return [];
    }
  }

  getUserMemories(userId, opts = {}) {
    const uid = Number(userId);
    if (!Number.isSafeInteger(uid) || uid <= 0) return [];
    return this.#queryMemories('user', String(uid), opts);
  }

  getGroupMemories(chatId, opts = {}) {
    const cid = Number(chatId);
    if (!Number.isSafeInteger(cid) || cid === 0) return [];
    return this.#queryMemories('group', String(cid), opts);
  }

  forgetUserMemories(userId, query = '') {
    const uid = Number(userId);
    if (!this.db?.run || !Number.isSafeInteger(uid) || uid <= 0) return 0;
    const q = String(query || '').trim().toLowerCase();
    try {
      if (!q || /^(?:all|everything|my\s+memory|memories)$/i.test(q)) {
        const res = this.db.run("DELETE FROM ai_memories WHERE scope = 'user' AND scope_key = ?", String(uid));
        return Number(res?.changes || 0);
      }
      const like = `%${q.replace(/[%_]/g, '')}%`;
      const res = this.db.run(
        "DELETE FROM ai_memories WHERE scope = 'user' AND scope_key = ? AND (LOWER(content) LIKE ? OR LOWER(fact_key) LIKE ? OR LOWER(category) LIKE ?)",
        String(uid),
        like,
        like,
        like
      );
      return Number(res?.changes || 0);
    } catch {
      return 0;
    }
  }

  forgetGroupMemories(chatId, query = '') {
    const cid = Number(chatId);
    if (!this.db?.run || !Number.isSafeInteger(cid) || cid === 0) return 0;
    const q = String(query || '').trim().toLowerCase();
    try {
      if (!q || q === 'all') {
        const res = this.db.run("DELETE FROM ai_memories WHERE scope = 'group' AND scope_key = ?", String(cid));
        return Number(res?.changes || 0);
      }
      const like = `%${q.replace(/[%_]/g, '')}%`;
      const res = this.db.run(
        "DELETE FROM ai_memories WHERE scope = 'group' AND scope_key = ? AND (LOWER(content) LIKE ? OR LOWER(fact_key) LIKE ?)",
        String(cid),
        like,
        like
      );
      return Number(res?.changes || 0);
    } catch {
      return 0;
    }
  }

  /**
   * Extract & persist explicit or clear preferences from natural conversation,
   * updating outdated values seamlessly and keeping user vs group scopes separated.
   */
  extractAndStoreFromText({ userId = null, chatId = null, text = '', speakerName = null, isGroup = false } = {}) {
    const raw = String(text || '').trim();
    if (!raw || raw.length < 4) return { stored: [], deleted: 0 };
    const stored = [];
    let deleted = 0;

    // 1. User-controlled memory deletion ("forget what I told you about...", "forget my memory")
    const forgetM = raw.match(/^(?:lancy[,\s]+)?(?:please\s+)?forget(?:\s+everything|\s+all(?:\s+my\s+memories)?|\s+(?:about|that|my)\s+(.+))$/i);
    if (forgetM && userId) {
      deleted = this.forgetUserMemories(userId, forgetM[1] || 'all');
      return { stored, deleted, forgotRequested: true };
    }

    // 2. Explicit "remember that..." / "save this..."
    const remM = raw.match(/(?:^|\b)remember\s+(?:that\s+)?(.{4,240})$/i);
    if (remM && userId) {
      const fact = remM[1].trim().replace(/[.!]+$/, '');
      if (isGroup && /^(?:this\s+group|we|our\s+group)\b/i.test(fact) && chatId) {
        this.rememberGroupFact(chatId, `explicit_${normKey(fact.slice(0, 28))}`, fact, { category: 'group_vibe', source: 'explicit', salience: 1.4 });
        stored.push({ scope: 'group', content: fact });
      } else {
        this.rememberUserFact(userId, `explicit_${normKey(fact.slice(0, 28))}`, fact, { category: 'fact', source: 'explicit', salience: 1.4 });
        stored.push({ scope: 'user', content: fact });
      }
    }

    // 3. Preferred name updates ("call me Pappy", "my name is Alex")
    const nameM = raw.match(/\b(?:call me|my name is|you can call me)\s+([\p{L}\p{N}_ -]{2,28})(?:[.!,]|$)/iu);
    if (nameM && userId) {
      const cleanName = normalizeDisplayName(nameM[1], null);
      if (cleanName && !/^(?:sir|ma|bro|boss|dude)$/i.test(cleanName)) {
        this.rememberUserFact(userId, 'preferred_name', `Prefers to be called ${cleanName}`, { category: 'profile', source: 'explicit', salience: 1.6 });
        stored.push({ scope: 'user', content: `Prefers to be called ${cleanName}` });
      }
    }

    // 4. Music / Movie / Vibe preferences (updates existing preference key cleanly)
    const favMusicM = raw.match(/\bi\s+(?:really\s+)?(?:love|like|prefer|enjoy|stan)\s+([a-z0-9 &,'-]{3,60}?)\s*(?:music|songs?|vibes?|tracks?|afrobeats|amapiano|rap|hip[\s-]?hop|gospel|r&b|movies?|films?|horror|anime|thrillers?|comedy|action)?(?:[.!,]|$)/i);
    if (favMusicM && userId && favMusicM[1].trim().length >= 3 && !/^(?:that|this|it|what|how|when|you)$/i.test(favMusicM[1].trim())) {
      const pref = favMusicM[1].trim();
      const isMoviePref = /\b(?:movie|movies|film|films|horror|anime|thriller|sci-?fi|comedy|drama|series)\b/i.test(raw);
      const cat = isMoviePref ? 'movie' : 'music';
      this.rememberUserFact(userId, `pref_${cat}_${normKey(pref)}`, `${isMoviePref ? 'Enjoys watching' : 'Enjoys listening to'}: ${pref}`, {
        category: cat,
        source: 'inferred',
        salience: 1.15
      });
      stored.push({ scope: 'user', content: pref });
    }

    // 5. Group recurring vibe / theme ("we love horror nights here")
    const grpM = isGroup && chatId ? raw.match(/\b(?:our group|we usually|we love|every\s+(?:friday|saturday|night|weekend)\s+we)\s+(.{4,120})/i) : null;
    if (grpM && chatId) {
      const fact = grpM[0].trim();
      this.rememberGroupFact(chatId, `group_vibe_${normKey(fact.slice(0, 24))}`, fact, { category: 'group_vibe', source: 'inferred', salience: 1.25 });
      stored.push({ scope: 'group', content: fact });
    }

    if (speakerName && userId && !nameM) {
      const clean = normalizeDisplayName(speakerName, null);
      if (clean && this.db?.get) {
        const hasName = this.db.get("SELECT 1 FROM ai_memories WHERE scope='user' AND scope_key=? AND fact_key='preferred_name'", String(userId));
        if (!hasName) {
          this.rememberUserFact(userId, 'display_name', `Telegram name: ${clean}`, { category: 'profile', source: 'system', salience: 0.9 });
        }
      }
    }

    return { stored, deleted };
  }

  /**
   * Build privacy-safe memory context for system prompts.
   * - In DM (`includeUserPrivate: true`): includes full user private memories.
   * - In Group/VC (`includeUserPrivate: false` by default unless single-speaker DM): only includes
   *   group memories + non-sensitive profile/taste items for active speaker without leaking other DM secrets.
   */
  formatPromptContext({ sessionKey, chatId = 0, userId = null, query = '', surface = 'vc', includeUserPrivate = false } = {}) {
    const sc = this.getSessionContext(sessionKey, { chatId, surface });
    const lines = [];

    if (sc.currentTopic) lines.push(`Current Topic: ${sc.currentTopic}`);
    if (sc.previousTopics?.length) lines.push(`Previous Topics: ${sc.previousTopics.slice(-3).join(' → ')}`);
    if (sc.speakerTurns?.length) {
      const recentTurns = sc.speakerTurns.slice(-8).map((t) => `${t.speakerName}: "${t.text.slice(0, 120)}"`);
      lines.push(`Recent Speaker Turns: ${recentTurns.join(' | ')}`);
    }
    if (sc.unansweredQuestions?.length) {
      const q = sc.unansweredQuestions.at(-1);
      lines.push(`Open Question (${q.speaker}): ${q.text}`);
    }

    if (Number(chatId) < 0) {
      const groupMems = this.getGroupMemories(chatId, { query, limit: 5 });
      if (groupMems.length) {
        lines.push(`Group Memory: ${groupMems.map((m) => m.content).join(' ; ')}`);
      }
    }

    if (userId) {
      const userMems = this.getUserMemories(userId, { query, limit: includeUserPrivate ? 8 : 4 })
        .filter((m) => includeUserPrivate || ['profile', 'music', 'movie', 'preference'].includes(m.category));
      if (userMems.length) {
        lines.push(`${includeUserPrivate ? 'User Memory' : 'Active Speaker Preferences'}: ${userMems.map((m) => m.content).join(' ; ')}`);
      }
    }

    return lines.join('\n');
  }
}

function safeJson(raw, fallback) {
  try {
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function inferTopicLabel(text) {
  const clean = String(text || '').trim();
  if (clean.length < 8) return null;
  if (/\b(?:python|javascript|typescript|node|react|coding|bug|api|server|docker|database)\b/i.test(clean)) return 'Tech & Coding';
  if (/\b(?:movie|film|series|season|episode|horror|thriller|netflix|cinema|anime)\b/i.test(clean)) return 'Movies & Series';
  if (/\b(?:song|music|track|album|artist|burna|wizkid|davido|rema|asake|beat|remix|lyrics|dj)\b/i.test(clean)) return 'Music & DJ Mix';
  if (/\b(?:news|today|latest|release|price|crypto|ton|football|match)\b/i.test(clean)) return 'News & Live Updates';
  return null;
}
