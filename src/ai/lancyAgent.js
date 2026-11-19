/**
 * Real-Time Conversational AI Agent ("Lancy") & Multi-Turn VC Session Manager.
 *
 * Powers bidirectional live Voice Chat interaction, Interactive VC text chat,
 * and unified Media/Project AI commands using native LLM tool-calling,
 * Nigerian English / Pidgin understanding, low-confidence clarification gates,
 * and an attentive "Lancy listen" -> batch execution -> "Is that all?" -> resume loop.
 */
import { LANCY_TOOLS_SCHEMA, LancyToolExecutor } from './lancyTools.js';
import { parseDeskIntents } from './deskNlu.js';
import { UnifiedMemoryStore } from './memoryStore.js';
import { RuntimeAwareness } from './runtimeAwareness.js';
import { ConversationalDecisionEngine, DECISION } from './decisionEngine.js';
import { HumanBehaviorEngine } from './behaviorEngine.js';
import { BUILTIN_PERSONAS, getPersonaById, resolvePersonaFromText } from './personas.js';
import { KeyedLock } from '../music/model.js';
import {
  UserTasteStore,
  buildTelegramMention,
  extractUserIdentity,
  getTimeOfDayContext,
  normalizeDisplayName
} from './userProfile.js';
import {
  RichMessageBuilder,
  block,
  richButton,
  rt,
  encodeCallback,
  applyCustomEmojisToBlocks
} from '../telegram/rich.js';

const CONVERSATION_IDLE_MS = 32000;
const MAX_HISTORY_TURNS = 14;

const AFFIRMATIVE_DONE_RE = /^(?:y(?:es|eah|ep|up)|that'?s\s+all|thats\s+all|that\s+is\s+all|all\s+good|i'?m\s+good|im\s+good|i'?m\s+done|nothing\s+else|no\s+more|done|carry\s+on|continue|go\s+ahead|play\s+on|resume(?:\s+it)?|na\s+all|e\s+don\s+do|no\s+wahala)[.!?,\s]*$/i;
const WAKE_ONLY_LISTEN_RE = /^(?:(?:hey|hi|yo|ok|okay|abeg)\s+)?lancy(?:\s*,?\s*(?:listen|abeg\s+listen|hear\s+me|are\s+you\s+there|you\s+there))?[.!?,\s]*$/i;
const CLEAR_COMMAND_RESCUE_RE = /\b(?:pause|resume|play|skip|next|previous|volume|mute|unmute|middle|seek|search|movie|send|video|queue|stop|leave|subtitle|audio|english)\b/i;
const CLEAR_ACTION_HINT_RE = /\b(?:play|pause|resume|skip|next|previous|prev|vol|volume|mute|unmute|seek|middle|halfway|move|jump|send|video|movie|film|series|episode|season|song|track|music|mix|remix|queue|poll|vote|sub|subtitle|language|lang|stop|leave|search|find|suggest|recommend|drop|put\s+on|give\s+me|want|need|bass|eq|download|playing|what'?s\s+on)\b/i;
const CASUAL_GREETING_RE = /^(?:hi+|he+y+|he+llo+|yo+|sup|wass?up|what'?s\s+(?:up|good)|how(?:'?s|\s+is|\s+are|\s+u|\s+you)(?:\s+(?:doing|going|dey|today|tonight|ur\s+day|your\s+day|far))?|wetin\s+dey|how\s+far|wagwan|good\s+(?:morning|afternoon|evening|night)|lol|lmao|chill|nice|cool|alright|talk\s+to\s+me|what\s+do\s+you\s+think|who\s+are\s+you|how\s+you\s+feeling)[.!?,~\s]*$/i;

export function isPureCasualBanter(text) {
  const clean = String(text || '').trim();
  if (!clean) return false;
  if (CLEAR_ACTION_HINT_RE.test(clean)) return false;
  return CASUAL_GREETING_RE.test(clean);
}

export function stripWakePrefix(text) {
  let out = String(text || '').trim();
  out = out.replace(/^(?:(?:hey|hi|yo|ok|okay|abeg)\s+)?lancy[\s,:-]+(?:listen[\s,:-]+)?/i, '');
  out = out.replace(/[\s,:-]+lancy[.!?\s]*$/i, '');
  return out.trim();
}

export class LancyAgent {
  constructor(opts = {}) {
    const app = opts?.app || (opts?.db || opts?.settings ? opts : undefined);
    this.app = app;
    this.executor = new LancyToolExecutor({ app });
    this.taste = new UserTasteStore({ db: app?.db });
    this.memory = new UnifiedMemoryStore({ db: app?.db, log: app?.log });
    this.awareness = new RuntimeAwareness({ app });
    this.decision = new ConversationalDecisionEngine();
    this.behavior = new HumanBehaviorEngine({ memory: this.memory, db: app?.db });
    this.chatLocks = new KeyedLock();
    this.vcSessions = new Map();
    this.botSessions = new Map();
    this.speakerPersonas = new Map();
    this.activeTurnControllers = new Map();
    this.recentEventIds = new Set();
    this.adminCache = new Map();
    this._greetingCounter = 0;
    this._wakeCounter = 0;
    this._banterCounter = 0;
  }

  #markEventSeen(eventId) {
    if (!eventId) return false;
    const key = String(eventId);
    if (this.recentEventIds.has(key)) {
      this.awareness.recordDuplicateDrop();
      return true;
    }
    this.recentEventIds.add(key);
    if (this.recentEventIds.size > 400) {
      const oldest = this.recentEventIds.values().next().value;
      this.recentEventIds.delete(oldest);
    }
    return false;
  }

  getBotConversation(chatId, userId = 0) {
    const key = `bot:${Number(chatId) || 0}:${Number(userId) || 0}`;
    if (!this.botSessions.has(key)) {
      this.botSessions.set(key, {
        sessionKey: key,
        chatId: Number(chatId) || 0,
        mode: 'IDLE',
        history: [],
        lastActiveAt: 0
      });
    }
    if (this.botSessions.size > 300) {
      const oldest = this.botSessions.keys().next().value;
      this.botSessions.delete(oldest);
    }
    return this.botSessions.get(key);
  }

  isGroupAiEnabled(chatId) {
    const id = Number(chatId);
    if (!(id < 0)) return false;
    const chatVal = this.app?.db?.getSetting?.(`ai.groupEnabled.${id}`, null);
    if (typeof chatVal === 'boolean') return chatVal;
    return Boolean(this.app?.settings?.get?.('ai.groupChatEnabled'));
  }

  setGroupAiEnabled(chatId, enabled) {
    const id = Number(chatId);
    if (!id) return false;
    this.app?.db?.setSetting?.(`ai.groupEnabled.${id}`, Boolean(enabled));
    return Boolean(enabled);
  }

  async resolveSpeakerName(chatId, userId = null, fallback = null, ctx = null) {
    const rawFb = String(fallback || '').trim();
    const isNumericOnly = /^\d{4,}$/.test(rawFb);
    if (ctx?.user?.first_name) {
      return normalizeDisplayName(ctx.user.first_name, 'Member');
    }
    if (rawFb && !isNumericOnly && !/^Speaker$/i.test(rawFb) && !/^User \d+$/i.test(rawFb)) {
      return normalizeDisplayName(rawFb, 'Member');
    }
    const uid = Number(userId || 0);
    const cid = Number(chatId || 0);
    if (uid > 0 && this.app?.db?.get) {
      try {
        if (cid < 0) {
          const gm = this.app.db.get('SELECT first_name, username FROM group_members WHERE chat_id = ? AND user_id = ?', cid, uid);
          if (gm?.first_name || gm?.username) return normalizeDisplayName(gm.first_name || gm.username, `User ${uid}`);
        }
        const bu = this.app.db.get('SELECT first_name, username FROM bot_users WHERE tg_id = ? ORDER BY last_seen DESC LIMIT 1', uid);
        if (bu?.first_name || bu?.username) return normalizeDisplayName(bu.first_name || bu.username, `User ${uid}`);
        const tp = this.app.db.get('SELECT display_name FROM user_taste_profiles WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1', uid);
        if (tp?.display_name && !/^\d{4,}$/.test(tp.display_name)) return normalizeDisplayName(tp.display_name, `User ${uid}`);
      } catch {}
    }
    const api = ctx?.api || this.app?.telegram?.api;
    if (cid < 0 && uid > 0 && typeof api?.getChatMember === 'function') {
      const m = await api.getChatMember(cid, uid).catch(() => null);
      if (m?.user?.first_name || m?.user?.username) {
        return normalizeDisplayName(m.user.first_name || m.user.username, 'Member');
      }
    }
    return uid > 0 ? `Member ${String(uid).slice(-4)}` : 'Friend';
  }

  async observeGroupMessage({ chatId, userId = null, senderName = null, text = '', isAddressed = false, ctx = null } = {}) {
    const cid = Number(chatId || 0);
    if (!(cid < 0) || !text) return { observed: false, proactiveReply: null };
    const cleanName = normalizeDisplayName(senderName, 'Member');
    const sessionKey = `vc:${cid}`;
    this.memory.recordSpeakerTurn(sessionKey, {
      chatId: cid,
      surface: 'group_text',
      userId,
      speakerName: cleanName,
      role: 'user',
      text,
      addressedToLancy: Boolean(isAddressed)
    });
    if (userId) {
      this.memory.extractAndStoreFromText({ userId, chatId: cid, text, speakerName: cleanName, isGroup: true });
    }
    const qmSession = this.app?.musicQueueManager?.sessions?.get?.(cid) || null;
    const analysis = this.behavior.analyzeTurn({
      chatId: cid,
      userId,
      senderName: cleanName,
      surface: 'group_text',
      sessionKey,
      text,
      isDirectlyAddressed: Boolean(isAddressed),
      conversationMode: this.getVcConversation(cid).mode,
      snapshot: qmSession ? {
        nowPlaying: qmSession.currentTrack || null,
        lastMovieSearch: qmSession.lastMovieSearch || null,
        lastVideoSearch: qmSession.lastVideoSearch || null
      } : null
    });

    let proactiveReply = null;
    if (
      !isAddressed
      && this.isGroupAiEnabled(cid)
      && analysis?.participation?.speak
      && (analysis.participation.mode === 'proactive' || analysis.participation.mode === 'deescalate')
      && this.decision.canEmitProactive(cid, analysis.topic || analysis.social?.signal)
    ) {
      const conv = this.getBotConversation(cid, 0);
      const out = await this.#runToolLoop({
        conv,
        userText: text,
        sourceSurface: 'group_text',
        context: {
          chatId: cid,
          telegramChatId: cid,
          userId,
          senderName: cleanName,
          ctx,
          isDirectlyAddressed: false,
          includeUserPrivate: false,
          behaviorAnalysis: analysis
        }
      }).catch(() => null);
      if (out?.reply) {
        proactiveReply = out.reply;
        this.behavior.group.markProactiveSpoken(cid);
        this.behavior.recordOutcome({ sessionKey, chatId: cid, surface: 'group_text', reply: proactiveReply });
        this.memory.recordSpeakerTurn(sessionKey, { chatId: cid, surface: 'group_text', role: 'assistant', speakerName: 'Lancy', text: proactiveReply });
      }
    }
    return { observed: true, proactiveReply, analysis };
  }

  /**
   * Synchronize Gemini 3.8 Live spoken turns into Lancy's shared Human Behavior Engine & cross-surface memory,
   * pushing silent behavioral/reference updates back to Live when topic or social context shifts.
   */
  async syncLiveBehavioralTurn({ chatId, inputText = '', outputText = '', userId = null, senderName = null } = {}) {
    const cid = Number(chatId || 0);
    if (!(cid < 0)) return { synced: false };
    const sessionKey = `vc:${cid}`;
    const cleanName = await this.resolveSpeakerName(cid, userId, senderName);
    const qmSession = this.app?.musicQueueManager?.sessions?.get?.(cid) || null;
    let analysis = null;

    if (String(inputText || '').trim()) {
      this.memory.recordSpeakerTurn(sessionKey, {
        chatId: cid,
        surface: 'vc_voice',
        userId,
        speakerName: cleanName,
        role: 'user',
        text: inputText,
        addressedToLancy: true
      });
      this.memory.extractAndStoreFromText({ userId, chatId: cid, text: inputText, speakerName: cleanName, isGroup: true });
      analysis = this.behavior.analyzeTurn({
        chatId: cid,
        userId,
        senderName: cleanName,
        surface: 'vc_voice',
        sessionKey,
        text: inputText,
        isDirectlyAddressed: true,
        conversationMode: 'LISTENING',
        snapshot: qmSession ? {
          nowPlaying: qmSession.currentTrack || null,
          lastMovieSearch: qmSession.lastMovieSearch || null,
          lastVideoSearch: qmSession.lastVideoSearch || null
        } : null
      });
    }

    if (String(outputText || '').trim()) {
      this.memory.recordSpeakerTurn(sessionKey, {
        chatId: cid,
        surface: 'vc_voice',
        role: 'assistant',
        speakerName: 'Lancy',
        text: outputText
      });
      this.behavior.recordOutcome({ sessionKey, chatId: cid, surface: 'vc_voice', reply: outputText });
    }

    if (analysis && (analysis.social?.isSeriousContext || analysis.restoredTopic || analysis.resolvedReferences?.length) && typeof this.app?.voiceClient?.pushLiveContext === 'function') {
      const notes = [
        analysis.social?.isSeriousContext ? `socialMood=${analysis.social.signal}(no_jokes)` : null,
        analysis.restoredTopic ? `resumedTopic="${analysis.restoredTopic.topic}"` : null,
        analysis.resolvedReferences?.length ? `refs=${analysis.resolvedReferences.map((r) => `${r.kind}:${r.speaker || r.title || r.topic || ''}`).join(',')}` : null
      ].filter(Boolean);
      if (notes.length) {
        void this.app.voiceClient.pushLiveContext(cid, notes.join(' | ')).catch(() => {});
      }
    }
    return { synced: true, analysis };
  }

  async handleBargeIn({ chatId, userId = null, senderName = null, detectedAtMs = null } = {}) {
    const cid = Number(chatId || 0);
    if (!cid) return { ok: false };
    const ctrl = this.activeTurnControllers.get(cid);
    if (ctrl) {
      try { ctrl.abort(); } catch {}
      this.activeTurnControllers.delete(cid);
    }
    const conv = this.getVcConversation(cid);
    conv.mode = 'INTERRUPTED';
    conv.bargeInAt = Date.now();
    if (typeof this.app?.voiceClient?.bargeIn === 'function') {
      await this.app.voiceClient.bargeIn(cid).catch(() => {});
    }
    if (Number.isFinite(detectedAtMs)) {
      this.awareness.recordVoiceLatency({ bargeInMs: Math.max(0, Date.now() - detectedAtMs) });
    } else {
      this.awareness.recordVoiceLatency({ bargeInMs: 0 });
    }
    return { ok: true, mode: conv.mode, speakerName: senderName || null, userId };
  }

  getActivePersona(chatId = 0, userId = 0) {
    const uKey = `${Number(chatId) || 0}:${Number(userId) || 0}`;
    if (this.speakerPersonas.has(uKey)) return this.speakerPersonas.get(uKey);
    const cKey = `${Number(chatId) || 0}:0`;
    if (this.speakerPersonas.has(cKey)) return this.speakerPersonas.get(cKey);
    const saved = chatId ? this.app?.db?.getSetting?.(`voiceai.voice.${Number(chatId)}`, null) : null;
    return (saved && getPersonaById(saved)) || BUILTIN_PERSONAS.pappy;
  }

  setActivePersona(chatId = 0, personaOrVoice = 'pappy', userId = 0) {
    const resolved = (typeof personaOrVoice === 'object' && personaOrVoice?.id)
      ? personaOrVoice
      : (getPersonaById(personaOrVoice) || BUILTIN_PERSONAS.pappy);
    const key = `${Number(chatId) || 0}:${Number(userId) || 0}`;
    this.speakerPersonas.set(key, resolved);
    if (!userId && chatId) {
      this.app?.db?.setSetting?.(`voiceai.voice.${Number(chatId)}`, resolved.id);
    }
    return resolved;
  }

  getVoiceProfileForChat(chatId, userId = null) {
    const cid = Number(chatId || 0);
    const uid = Number(userId || 0);
    const sp = (uid && this.speakerPersonas.get(`${cid}:${uid}`)) || this.vcSessions.get(cid)?.activePersona || null;
    if (sp) {
      return {
        persona: sp.id,
        voice: sp.edgeVoice || sp.edge_tts_voice,
        rate: sp.rate || '+0%'
      };
    }
    return {};
  }

  /**
   * Execute an asynchronous tool call emitted by Gemini 3.8 Live and return a strict
   * guide-compliant structured payload ({ status, retryable, message, ... }).
   */
  async executeLiveToolCall({ chatId, callId = '', name = '', args = {}, userId = null, senderName = null } = {}) {
    const cid = Number(chatId || 0);
    const fnName = String(name || '').trim();
    if (!cid || !fnName) {
      return { status: 'invalid_argument', retryable: false, message: 'Missing chat_id or tool name.' };
    }
    const readOnlyLiveTools = new Set([
      'get_call_state', 'web_research', 'tell_story_or_novel',
      'browser_task_status', 'browser_list_tabs', 'browser_replay_task'
    ]);
    if (!readOnlyLiveTools.has(fnName) && userId) {
      const ok = await this.isAuthorizedSpeaker(cid, userId, { fromAdmin: false });
      if (!ok) {
        return {
          status: 'permission_denied',
          retryable: false,
          message: 'Only the group owner, superadmins, or VC sudo members can control VC media.'
        };
      }
    }
    const cleanSpeaker = await this.resolveSpeakerName(cid, userId, senderName);
    const t0 = Date.now();
    try {
      const out = await this.executor.execute(fnName, args || {}, {
        chatId: cid,
        telegramChatId: cid,
        userId,
        senderName: cleanSpeaker
      });
      this.awareness.recordToolBatch({ count: 1, failures: out?.ok ? 0 : 1, latencyMs: Date.now() - t0 });
      if (!out || typeof out !== 'object') {
        return { status: 'error', retryable: false, message: `Tool ${fnName} returned no result.` };
      }
      if (!out.ok) {
        return {
          status: out.error === 'no_results' ? 'no_results' : 'error',
          retryable: false,
          message: String(out.error || `Could not complete ${fnName}.`)
        };
      }
      const noResults = Array.isArray(out.results) && out.results.length === 0 && out.action === 'search';
      const { status: rawSubStatus, ...restOut } = out;
      return {
        ...restOut,
        ...(rawSubStatus !== undefined ? { playbackStatus: rawSubStatus } : {}),
        status: noResults ? 'no_results' : 'ok',
        retryable: false,
        message: noResults
          ? `No matching results were found for ${fnName}.`
          : (out.summary || out.title || `${fnName} completed successfully.`)
      };
    } catch (err) {
      this.awareness.recordToolBatch({ count: 1, failures: 1, latencyMs: Date.now() - t0 });
      return {
        status: 'error',
        retryable: false,
        message: err?.message || `Failed executing ${fnName}.`
      };
    }
  }

  getTimeContext(chatId = 0) {
    const tz = (chatId && this.app?.db?.getSetting?.(`voiceai.tz.${chatId}`, null))
      || this.app?.settings?.get?.('voiceAi.timezone')
      || 'Africa/Lagos';
    return getTimeOfDayContext(tz);
  }

  getHudTheme(chatId = 0) {
    return (chatId && this.app?.db?.getSetting?.(`voiceai.hudTheme.${chatId}`, null)) || 'neon_rose';
  }

  setHudTheme(chatId, theme) {
    const valid = ['neon_rose', 'cinema_gold', 'frosted_cyan', 'minimal', 'off'].includes(theme) ? theme : 'neon_rose';
    if (chatId) this.app?.db?.setSetting?.(`voiceai.hudTheme.${chatId}`, valid);
    return valid;
  }

  setTimezone(chatId, tz) {
    const clean = String(tz || 'Africa/Lagos').trim() || 'Africa/Lagos';
    if (chatId) this.app?.db?.setSetting?.(`voiceai.tz.${chatId}`, clean);
    return clean;
  }

  getVcConversation(chatId) {
    const id = Number(chatId);
    if (!this.vcSessions.has(id)) {
      this.vcSessions.set(id, {
        chatId: id,
        mode: 'IDLE', // IDLE | LISTENING | CLARIFYING | AWAITING_FOLLOWUP
        pausedByLancy: false,
        pendingSource: null,
        activeSpeakerId: null,
        pendingClarificationText: null,
        history: [],
        idleTimer: null,
        lastActiveAt: 0,
        voiceEnabled: null, // null = follow default ON
        ttsVoice: null
      });
    }
    return this.vcSessions.get(id);
  }

  isVoiceAiEnabled(chatId) {
    const id = Number(chatId);
    const saved = this.app?.db?.getSetting?.(`voiceai.enabled.${id}`, null);
    if (typeof saved === 'boolean') return saved;
    const globalVal = this.app?.settings?.get?.('voiceAi.enabled');
    return typeof globalVal === 'boolean' ? globalVal : true;
  }

  setVoiceAiEnabled(chatId, enabled) {
    const id = Number(chatId);
    this.app?.db?.setSetting?.(`voiceai.enabled.${id}`, Boolean(enabled));
    const st = this.getVcConversation(id);
    st.voiceEnabled = Boolean(enabled);
    if (typeof this.app?.voiceClient?.setListenState === 'function') {
      this.app.voiceClient.setListenState(id, { mode: 'config', enabled: Boolean(enabled), active: false }).catch(() => {});
    }
    return Boolean(enabled);
  }

  async isAuthorizedSpeaker(chatId, userId, { fromAdmin = false } = {}) {
    const uid = Number(userId);
    if (!Number.isSafeInteger(uid) || uid <= 0) return false;
    const music = this.app?.music;
    if (music) {
      // Strictly Owner, SuperAdmin, or VC-Sudo users only (plain group admins do not bypass).
      const ctxLike = { tgId: uid, user: { id: uid }, chatId: Number(chatId) };
      if (music.owner?.(ctxLike) || music.superAdmin?.(ctxLike)) return true;
      if (music.isVcSudo?.(ctxLike, Number(chatId))) return true;
      return false;
    }
    return Boolean(fromAdmin);
  }

  #pushHistory(conv, role, content) {
    const clean = String(content || '').trim();
    if (!clean) return;
    conv.history.push({ role, content: clean });
    while (conv.history.length > MAX_HISTORY_TURNS) conv.history.shift();
  }

  #resetIdleTimer(conv) {
    if (conv.idleTimer) {
      clearTimeout(conv.idleTimer);
      conv.idleTimer = null;
    }
    if (conv.mode === 'IDLE') return;
    conv.idleTimer = setTimeout(() => {
      void this.#handleConversationTimeout(conv).catch(() => {});
    }, CONVERSATION_IDLE_MS);
    conv.idleTimer.unref?.();
  }

  async #handleConversationTimeout(conv) {
    conv.idleTimer = null;
    if (conv.mode === 'IDLE') return;
    const s = this.app?.musicQueueManager?.sessions?.get?.(conv.chatId);
    const sameTrack = !conv.pausedTrackId || !s?.currentTrack || (s.currentTrack?.entryId || s.currentTrack?.id) === conv.pausedTrackId;
    const shouldResume = Boolean(conv.pausedByLancy && sameTrack && (!s || s.status === 'paused'));
    conv.mode = 'IDLE';
    conv.pausedByLancy = false;
    conv.pausedTrackId = null;
    conv.activeSpeakerId = null;
    conv.pendingClarificationText = null;
    this.memory.saveSessionContext(this.memory.getSessionContext(`vc:${conv.chatId}`, { chatId: conv.chatId, surface: 'vc' }));
    if (typeof this.app?.voiceClient?.setListenState === 'function') {
      await this.app.voiceClient.setListenState(conv.chatId, {
        mode: 'stop',
        active: false,
        resume_media: shouldResume
      }).catch(() => {});
    }
    if (shouldResume) {
      if (s && s.status === 'paused') {
        s.status = 'playing';
        void this.app?.musicQueueManager?.updatePlayerCard?.(conv.chatId, { forceEdit: true }).catch(() => {});
      }
      await this.#deliverVcReply(conv.chatId, 'No more requests? Resuming playback now!', { speak: true });
    }
  }

  async #deliverVcReply(chatId, text, { speak = true, speakerName = null, userText = null, appendMode = false, bargeInClear = false, sendChat = true } = {}) {
    const clean = String(text || '').trim();
    if (!clean) return;
    const vc = this.app?.voiceClient;
    const hudTheme = this.getHudTheme(chatId);
    const tasks = [];
    if (speak && typeof vc?.speak === 'function') {
      const ttsVoice = this.app?.db?.getSetting?.(`voiceai.voice.${chatId}`, null) || undefined;
      tasks.push(vc.speak(chatId, clean, {
        voice: ttsVoice,
        ...(appendMode ? { append_mode: true } : {}),
        ...(bargeInClear ? { barge_in_clear: true } : {}),
        ...(speakerName ? { speaker_name: speakerName } : {}),
        ...(userText ? { user_text: String(userText).slice(0, 140) } : {}),
        lancy_text: clean.slice(0, 260),
        ...(hudTheme && hudTheme !== 'off' ? { hud_theme: hudTheme } : {})
      }).catch(() => {}));
    }
    if (sendChat && typeof vc?.sendCallMessage === 'function') {
      tasks.push(vc.sendCallMessage(chatId, `🎙️ Lancy: ${clean.slice(0, 400)}`).catch(() => {}));
    }
    await Promise.allSettled(tasks);
  }

  #buildSystemPrompt({ snapshot, conv, sourceSurface, userName = null, tasteSummary = '', memoryContext = '', timeCtx = null, awareness = null, behaviorAnalysis = null, persona = null }) {
    const activePersona = persona || BUILTIN_PERSONAS.pappy;
    const pName = activePersona.name || 'Pappy';
    const tCtx = timeCtx || this.getTimeContext(conv?.chatId);
    const botMeta = snapshot?.bot?.username
      ? `@${snapshot.bot.username}${snapshot?.bot?.clonesCount ? ` (${snapshot.bot.clonesCount} clones synced)` : ''}`
      : `${snapshot?.bot?.name || pName}${snapshot?.bot?.clonesCount ? ` (${snapshot.bot.clonesCount} clones synced)` : ''}`;
    const np = snapshot?.nowPlaying;
    const epTag = np?.seasonNumber ? ` S${np.seasonNumber}E${np.episodeNumber || 1}` : '';
    const nowPlayingStr = np
      ? `${np.title}${epTag} (${np.positionClock}${np.durationClock ? ` / ${np.durationClock}` : ''}, deck=${snapshot.deck}, quality=${snapshot.quality || 'auto'}, audio=${np.audioLanguage || 'default'}, subs=${snapshot.subtitleMode || 'screen'})`
      : 'Nothing playing right now';
    const lyricsHint = Array.isArray(np?.lyricsLines) && np.lyricsLines.length
      ? `Current Lyrics Snippet: ${np.lyricsLines.slice(0, 3).map((l) => l?.text || l).join(' / ')}`
      : '';
    const participantsHint = Array.isArray(awareness?.participants) && awareness.participants.length
      ? `Active VC Participants (${awareness.participants.length}): ${awareness.participants.slice(0, 10).map((p) => `${p.display_name || p.name || p.user_id}${p.muted ? ' (muted)' : ''}`).join(', ')}`
      : '';
    const modelHint = awareness?.ai
      ? `Runtime AI: primary=${awareness.ai.primaryModel}${awareness.ai.backupModel ? `, reasoning=${awareness.ai.backupModel}` : ''}, gemini-3.8-live=${awareness.ai.realtimeVoiceAvailable ? 'active' : 'unavailable (streaming VAD/Whisper + streaming PCM active)'}.`
      : '';
    const lastMovieSummary = snapshot?.lastMovieSearch?.results?.length
      ? `Last GC Movie Search (${snapshot.lastMovieSearch.query || 'results'}): ${snapshot.lastMovieSearch.results.slice(0, 5).map((m) => `#${m.index} ${m.title}${m.year ? ` (${m.year})` : ''}${m.seasonsBreakdown ? ` [${m.seasonsBreakdown}]` : ''}`).join(' | ')}`
      : '';
    const lastVideoSummary = snapshot?.lastVideoSearch?.results?.length
      ? `Last Video Search (${snapshot.lastVideoSearch.query || 'results'}): ${snapshot.lastVideoSearch.results.slice(0, 5).map((v) => `#${v.index} ${v.title}${v.duration ? ` (${v.duration})` : ''}`).join(' | ')}`
      : '';
    return [
      `You are ${pName} (${activePersona.ageGroup || 'man'}, ${activePersona.gender || 'male'}) — a deeply human companion, co-host, DJ, cinema concierge, and long-form storyteller in the Pappy & Co cast.`,
      `Character & Voice Persona: ${activePersona.personality}`,
      'Personality & Character Mirroring: Speak naturally with genuine human presence, emotional intuition, and zero robotic clichés ("How may I assist?" / "As an AI" forbidden). Mirror the energy and register of whoever is talking to you: effortless Nigerian English & Pidgin banter ("abeg", "no wahala", "omo") when playful, and calm grounded attentiveness when serious, deep, or sharing long multi-part thoughts.',
      'Long Talk, Stories & Dark Romance Narration: Never rush or truncate stories, dark romance novels, deep explanations, or long conversations. When asked for a story, novel, dark romance, fantasy, folklore, or book plot, call `tell_story_or_novel` or `web_research` to ground details cleanly, then tell rich, vivid, immersive chapters/narratives at natural full length.',
      `Self-Awareness: running on ${botMeta}. ${modelHint} In Voice Chat, only Owner, SuperAdmins, and VC-Sudo users control VC.`,
      `Local time context: ${tCtx.greeting} (${tCtx.localTimeStr} ${tCtx.weekday || ''} — ${tCtx.vibeHint}).`,
      userName ? `Active speaker/user: ${userName}.` : '',
      tasteSummary ? `Listener Taste Profile: ${tasteSummary}` : '',
      memoryContext,
      participantsHint,
      `Current surface: ${sourceSurface}. Conversation state: ${conv.mode} (pausedByLancy=${Boolean(conv.pausedByLancy)}).`,
      `Live VC Deck Snapshot: status=${snapshot?.status || 'idle'}, mode=${snapshot?.streamMode || 'interactive'}, volume=${snapshot?.volume ?? 100}%, muted=${Boolean(snapshot?.muted)}, playing="${nowPlayingStr}", queueCount=${snapshot?.queueCount ?? 0}.`,
      lyricsHint,
      snapshot?.upNext?.length ? `Up Next: ${snapshot.upNext.join('; ')}` : '',
      lastMovieSummary,
      lastVideoSummary,
      behaviorAnalysis?.promptDirective || '',
      'RULES:',
      '1. Distinguish real system state, memory, and live web search (`web_research`) from general knowledge. Never invent playback status, queue items, participants, or unexecuted actions — call tools and check results before confirming.',
      '2. Understand natural conversational intent rather than keywords alone — support switching anything on deck (tracks, music<->movie decks, episodes, audio dubs, subtitles, quality, volume). For clear direct requests, act right away; for ambiguous hints, mood complaints ("this song is boring"), or big switches ("switch to a movie?"), ASK the user if they want that change before doing it.',
      '3. For current news, releases, specs, docs, or factual lookup, call `web_research`. In text chats include concise source links; in Voice Chat summarize naturally without reading raw URLs aloud.',
      '4. NEVER guess on unclear or garbled audio/text — call `ask_clarification` warmly.',
      '5. For YouTube/web videos use `search_videos`; for movies/series use `search_movies_series` (supports numbered #1/#2 picks and loading `season Y episode Z` on `current`, `up_next`, or `search_result`). Chain all requested tools in one turn when the user asks for multiple actions.',
      sourceSurface.startsWith('vc_')
        ? '6. Spoken VC replies: 1–2 concise natural sentences, ZERO markdown, never read internal tool names aloud. Ask about resuming/anything else ONLY when you just ran deck actions while paused.'
        : '6. Chat/DM replies: clear, expressive, structured nicely only when helpful (not every simple reply needs a huge card).'
    ].filter(Boolean).join('\n');
  }

  async generatePersonalizedGreeting(ctx, { chatId = 0, mode = 'dj' } = {}) {
    const ident = extractUserIdentity(ctx);
    const cleanName = ident.cleanName;
    const mention = buildTelegramMention(ctx, cleanName);
    const tCtx = this.getTimeContext(chatId);
    const profile = this.taste.getProfile(ident.userId, chatId);
    const tasteSummary = this.taste.formatPromptSummary(ident.userId, chatId);
    const s = this.app?.musicQueueManager?.sessions?.get?.(Number(chatId));
    const nowPlaying = s?.currentTrack?.title ? `${s.currentTrack.title}${s.currentTrack.artist ? ` by ${s.currentTrack.artist}` : ''}` : null;

    this._greetingCounter = (this._greetingCounter + 1) % 6;
    const favArtist = profile.topArtists[0] || null;
    const favArtistsStr = profile.topArtists.slice(0, 2).join(' & ');
    const favMovie = profile.recentMovies[0] || null;

    let aiLine = '';
    if (typeof this.app?.ai?.generate === 'function') {
      const openerPrompt = [
        `Write ONE short warm personalized opening greeting (2 sentences max) to ${cleanName}.`,
        `Time of day: ${tCtx.greeting} (${tCtx.localTimeStr}, ${tCtx.vibeHint}).`,
        tasteSummary ? `They love: ${tasteSummary}.` : 'No saved taste yet — ask gently what vibe or movie they want.',
        nowPlaying ? `Currently in VC: ${nowPlaying}.` : 'VC deck is idle right now.',
        mode === 'dj' ? 'Context: User just clicked Chat DJ.' : 'Context: User just opened Lancy AI Movie & Song chat.',
        'Mention their name naturally without weird symbols, ask how their day/evening is going, suggest fitting music or movie/poll, and DO NOT use generic clichés.'
      ].join('\n');
      try {
        const res = await this.app.ai.generate({
          task: 'chat',
          style: 'cool',
          text: openerPrompt,
          context: { temperature: 0.8 },
          maxTokens: 140
        });
        if (res && res.provider !== 'builtin' && res.text) {
          aiLine = String(res.text).replace(/^["']|["']$/g, '').trim();
        }
      } catch {}
    }

    if (!aiLine) {
      const variants = [
        () => `${tCtx.greeting}, ${cleanName}! How’s your ${tCtx.period === 'late_night' ? 'night' : 'day'} going? ${favArtist ? `I remember how much you rock with ${favArtistsStr} — want me to spin something in that pocket` : `Want some ${tCtx.vibeHint.split('—')[0].trim()}`} or maybe drop a group poll?`,
        () => `Yo ${cleanName}! ${tCtx.greeting} ✨ ${nowPlaying ? `Right now we’ve got ${nowPlaying} rolling.` : 'The deck is wide open for you.'} ${favArtist ? `Should we run ${favArtist}, switch to a fresh movie, or chill?` : 'Tell me what kind of jam or movie you’re feeling right now!'}`,
        () => `Hey ${cleanName}! Hope your ${tCtx.period.replace('_', ' ')} is treating you well 🎧 ${favArtist ? `Knowing your taste (${favArtistsStr}),` : 'Since you tapped Chat DJ,'} do you need some chill music right now, or want us to put up a poll for the chat?`,
        () => `${tCtx.greeting}, ${cleanName} 💫 Ready when you are! ${favMovie ? `Loved when we checked out ${favMovie} too — ` : ''}hit me with any artist (Ayo Maff, Tems, whatever!), any movie to play, or say "make a poll".`
      ];
      aiLine = variants[this._greetingCounter % variants.length]();
    }

    return {
      cleanName,
      mention,
      timeCtx: tCtx,
      profile,
      tasteSummary,
      greetingText: aiLine
    };
  }

  buildConversationRichCard({ title = '🎙️ Lancy AI Booth', subtitle = '', bodyText = '', mention = null, executed = [], mode = 'dj', includeQuickStarters = false } = {}) {
    const b = new RichMessageBuilder().bannerHeader([title, subtitle || 'Real-Time DJ · Movies · VC Companion'], { size: 2 });

    if (mention?.rich && bodyText) {
      // Tag user natively at the top of the Rich Card if body doesn't already lead cleanly or pair as header greeting line
      b.paragraph(rt.concat(rt.text('👤 '), mention.rich));
    }

    b.blockquote(rt.text(bodyText));

    const actionLines = [];
    for (const step of executed || []) {
      const out = step?.out || {};
      if (!out.ok) continue;
      if (out.cardKind === 'music' || step.name === 'search_and_play_music') {
        if (out.title) actionLines.push(`🎵 Queued/Playing: ${out.title}${out.artist ? ` — ${out.artist}` : ''}`);
      } else if (out.cardKind === 'video' || out.cardKind === 'video_list' || step.name === 'search_videos') {
        if (out.title && out.action !== 'search') {
          actionLines.push(`🎥 Video #${out.index || 1}: ${out.title}${out.duration ? ` (${out.duration})` : ''}`);
        } else if (Array.isArray(out.results) && out.results.length) {
          for (const v of out.results.slice(0, 4)) {
            actionLines.push(`🎥 #${v.index} ${v.title}${v.duration ? ` (${v.duration})` : ''}${v.author ? ` · ${v.author}` : ''}`);
          }
        }
      } else if (out.cardKind === 'movie' || out.cardKind === 'movie_list' || step.name === 'search_movies_series') {
        if (out.title && out.action !== 'inspect') {
          const epBit = out.season ? ` S${out.season}E${out.episode || 1}` : '';
          actionLines.push(`🎬 Movie: ${out.title}${epBit}${out.year ? ` (${out.year})` : ''}`);
        } else if (Array.isArray(out.results) && out.results.length) {
          for (const m of out.results.slice(0, 4)) {
            actionLines.push(`🎬 #${m.index || ''} ${m.title}${m.year ? ` (${m.year})` : ''}${m.seasonsBreakdown ? ` · ${m.seasonsBreakdown}` : (m.rating ? ` ⭐ ${m.rating}` : '')}`);
          }
        }
      } else if (out.cardKind === 'poll') {
        actionLines.push(`📊 Live Poll: "${out.question}" (${out.options?.join(' / ')})`);
      } else if (step.name === 'adjust_volume') {
        actionLines.push(`🔊 Volume: ${out.volume}%`);
      } else if (step.name === 'seek_playback') {
        actionLines.push(`⏱ Jumped to ${out.label || out.clock}`);
      } else if (step.name === 'send_current_video_to_chat') {
        actionLines.push(`⬇️ Sending "${out.title}" (${out.quality || 'HD'}) to chat`);
      }
    }

    if (actionLines.length) {
      b.divider();
      b.list(actionLines);
    }

    b.footer(rt.text('💬 Keep replying anytime to continue chatting — say "done" or tap Finish to close.'));

    const row1 = includeQuickStarters
      ? [
          richButton.callback('🔥 Trending Hits', encodeCallback('music', 'djquick', 'trending'), { style: 'primary' }),
          richButton.callback('🌊 Chill Mix', encodeCallback('music', 'djquick', 'chill'), { style: 'primary' }),
          richButton.callback('📊 Group Poll', encodeCallback('music', 'djquick', 'poll'), { style: 'success' })
        ]
      : [
          richButton.callback('🔥 Trending', encodeCallback('music', 'djquick', 'trending'), { style: 'primary' }),
          richButton.callback('📊 Poll Next', encodeCallback('music', 'djquick', 'poll'), { style: 'success' }),
          richButton.callback('🎬 Movies', encodeCallback('music', 'mv', 'new', 'hb'), { style: 'primary' })
        ];
    const row2 = [
      richButton.callback('🎛 Player', encodeCallback('music', 'refresh', ''), { style: 'secondary' }),
      richButton.callback('🚪 Finish Chat', encodeCallback('music', 'aiclose', mode === 'dj' ? 'dj' : ''), { style: 'danger' })
    ];
    b.buttons(row1);
    b.buttons(row2);

    b.validate();
    return b.toJSON({ useCustomEmojis: true });
  }

  #formatDeskSummary(executed = [], userName = 'friend') {
    const okParts = [];
    const failParts = [];
    for (const step of executed) {
      const { name, args, out } = step || {};
      if (!out?.ok) {
        failParts.push(out?.error ? `${name} (${out.error})` : name);
        continue;
      }
      if (name === 'adjust_volume') {
        okParts.push(out.mode === 'mute' ? 'muted the call' : `volume set to ${out.volume}%`);
      } else if (name === 'seek_playback') {
        okParts.push(`jumped to ${out.label || out.clock}`);
      } else if (name === 'send_current_video_to_chat') {
        okParts.push(`sending "${out.title || 'current media'}" (${out.quality || 'HD'}) to chat`);
      } else if (name === 'control_playback') {
        if (out.action === 'set_loop' || out.action === 'toggle_loop') okParts.push(`loop set to ${out.loopMode}`);
        else if (out.action === 'shuffle') okParts.push(`shuffled ${out.count} queued items`);
        else if (out.action === 'switch_deck') okParts.push(`switched to ${out.deck} deck`);
        else if (out.action === 'vote_skip') okParts.push(out.skipped ? 'skip vote passed, skipping' : `skip vote ${out.votes}/${out.needed}`);
        else if (out.action === 'refresh_player') okParts.push('refreshed player card');
        else if (out.action === 'pin_player') okParts.push('pinned player card');
        else if (out.action === 'hide_guide') okParts.push('hid the VC command guide permanently');
        else if (out.action === 'show_guide') okParts.push('restored the VC command guide');
        else okParts.push(`${args?.action || out.action} done`);
      } else if (name === 'tune_cinema_stream') {
        if (out.setting === 'quality') okParts.push(`quality switched to ${out.quality}`);
        else if (out.setting === 'stream_mode') okParts.push(`switched to ${out.streamMode} mode`);
        else if (out.setting === 'subtitle_mode') okParts.push(`subtitles set to ${out.subtitleMode}`);
        else if (out.setting === 'subtitle_offset') okParts.push(`subtitle offset now ${out.offset > 0 ? `+${out.offset}` : out.offset}s`);
        else if (out.setting === 'auto_sync_subtitles') okParts.push('auto-aligned subtitles');
        else if (out.setting === 'dual_subtitle_tile') okParts.push(out.dualTile ? `dual subtitle tile ON (${out.language || 'alt'})` : 'dual subtitle tile OFF');
        else if (out.setting === 'audio_language') okParts.push(`switched audio${out.audioLanguage ? ` to ${out.audioLanguage}` : ''}`);
        else if (out.setting === 'switch_source') okParts.push('switched stream source');
        else okParts.push(`${out.setting} updated`);
      } else if (name === 'ai_dj_control') {
        if (out.action === 'visual_on' || out.action === 'visual_off') okParts.push(`DJ visual desk ${out.visualDesk ? 'ON' : 'OFF'}`);
        else if (out.action === 'lyrics_on' || out.action === 'lyrics_off') okParts.push(`lyrics ${out.showLyrics ? 'ON' : 'OFF'}`);
        else if (out.action === 'eq') okParts.push(`EQ set to ${out.eqPreset}`);
        else if (out.action === 'crossfade') okParts.push(`crossfade set to ${out.crossfadeSec}s`);
        else if (out.action === 'next_chapter') okParts.push(`next chapter${out.chapter ? `: ${out.chapter}` : ''}`);
      } else if (name === 'manage_queue') {
        if (out.action === 'list') {
          okParts.push(out.count ? `up next (${out.count}): ${out.items.slice(0, 3).map((it) => `${it.index}. ${it.title}`).join(', ')}` : 'queue is empty');
        } else if (out.action === 'clear') okParts.push(`cleared ${out.cleared} queued items`);
        else if (out.action === 'playlist_list') okParts.push(out.playlists?.length ? `saved playlists: ${out.playlists.join(', ')}` : 'no saved playlists yet');
        else if (out.action === 'playlist_save') okParts.push(`saved playlist "${out.name}" (${out.savedCount} tracks)`);
        else if (out.action === 'playlist_load') okParts.push(`loaded playlist "${out.name}" (${out.addedCount} tracks)`);
        else okParts.push(`${out.action} "${out.title || `#${out.index}`}"`);
      } else if (name === 'get_call_state') {
        if (out.nowPlaying) {
          const np = out.nowPlaying;
          const ep = np.seasonNumber ? ` (Season ${np.seasonNumber} Episode ${np.episodeNumber || 1})` : '';
          okParts.push(`currently playing "${np.title}"${ep} at ${np.positionClock}${np.durationClock ? ` of ${np.durationClock}` : ''}${out.queueCount ? ` with ${out.queueCount} in queue` : ''}`);
        } else {
          okParts.push('nothing is playing on deck right now');
        }
      } else if (name === 'search_videos') {
        if (out.action === 'search') {
          const topList = (out.results || []).slice(0, 3).map((v) => `#${v.index} ${v.title}${v.duration ? ` (${v.duration})` : ''}`).join(', ');
          okParts.push(`found ${out.count || (out.results || []).length} videos${out.postedToChat ? ' and posted them to chat' : ''}: ${topList}`);
        } else if (out.action === 'send_to_chat') {
          okParts.push(`sent video #${out.index || 1} "${out.title}" to chat`);
        } else {
          okParts.push(`${out.action === 'play_now' ? 'playing' : 'queued'} video #${out.index || 1} "${out.title}"`);
        }
      } else if (name === 'search_movies_series') {
        if (out.action === 'search' || out.action === 'inspect') {
          const picks = out.selected ? [out.selected] : (out.results || []).slice(0, 3);
          const descList = picks.map((m) => `#${m.index || 1} is ${m.title}${m.year ? ` (${m.year})` : ''}${m.seasonsBreakdown ? ` with ${m.seasonsBreakdown}` : ''}`).join('; ');
          okParts.push(`${out.action === 'inspect' ? 'details' : `found ${out.count || picks.length} results${out.postedToChat ? ' on the group chat card' : ''}`}: ${descList}`);
        } else {
          const ep = out.season ? ` Season ${out.season} Episode ${out.episode || 1}` : '';
          okParts.push(`${out.action === 'play_now' ? 'playing' : 'queued'} "${out.title}"${ep}`);
        }
      } else if (name === 'search_and_play_music') {
        okParts.push(out.action === 'search' ? `found ${(out.results || []).length} songs` : `${out.action === 'play_now' ? 'playing' : 'queued'} "${out.title}"`);
      }
    }
    if (okParts.length && !failParts.length) {
      return `Got it, ${userName} — ${okParts.join(', ')}.`;
    }
    if (okParts.length && failParts.length) {
      return `Done with ${okParts.join(', ')} (couldn't run ${failParts.join(', ')}).`;
    }
    return failParts.length ? `Couldn't complete ${failParts.join(', ')} right now, ${userName}.` : '';
  }

  async #generateHumanBanterReply({ conv, userText, sourceSurface, context }) {
    const snapshot = await this.executor.execute('get_call_state', {}, context).catch(() => null);
    const userName = context.senderName ? normalizeDisplayName(context.senderName, 'friend') : 'friend';
    const tasteSummary = context.userId ? this.taste.formatPromptSummary(context.userId, context.chatId) : '';
    const timeCtx = this.getTimeContext(context.chatId);
    const nowTitle = snapshot?.nowPlaying?.title || null;
    const recentBotLines = (conv?.history || []).filter((h) => h.role === 'assistant').slice(-4).map((h) => h.content);
    const isVc = String(sourceSurface || '').startsWith('vc_');

    const sysPrompt = [
      `You are Lancy — ${userName}'s sharp, warm, humorous Nigerian Gen-Z co-host, DJ, and movie buddy.`,
      `Local time: ${timeCtx.greeting} (${timeCtx.localTimeStr} ${timeCtx.weekday || ''} — ${timeCtx.vibeHint}).`,
      nowTitle ? `Right now on the deck: "${nowTitle}" (${snapshot?.status || 'playing'}, pausedByLancy=${Boolean(conv?.pausedByLancy)}).` : 'The deck is currently quiet/idle.',
      tasteSummary ? `${userName}'s taste: ${tasteSummary}.` : '',
      recentBotLines.length ? `Do NOT repeat phrases you already used recently: ${recentBotLines.join(' | ')}` : '',
      'CRITICAL RULES:',
      `- Reply like a real human friend hanging out with ${userName} — NOT a scripted AI or customer-support bot.`,
      '- NEVER say "How can I assist", "How may I help", "What do you need", "Is that all", or "As an AI".',
      '- Respond genuinely to what they just said AND share a brief warm thought/reasoning (about the vibe, the track/movie paused, or the time of day).',
      isVc ? '- Keep it 1-2 crisp spoken sentences (no markdown, no bullet lists).' : '- Keep it 2 lively conversational sentences with natural emojis.'
    ].filter(Boolean).join('\n');

    let reply = '';
    let streamedSpeech = false;
    const canStreamSpeak = Boolean(context.streamTts && typeof this.app?.ai?.generateStream === 'function');
    if (canStreamSpeak) {
      try {
        let idxSeq = 0;
        const ttsTasks = [];
        const res = await this.app.ai.generateStream({
          task: 'chat',
          style: 'cool',
          text: userText,
          context: {
            system: sysPrompt,
            history: (conv?.history || []).slice(-8),
            temperature: 0.86
          },
          maxTokens: 160,
          signal: context.signal,
          onChunk: (sentence) => {
            if (context.signal?.aborted) return;
            const cleanSent = String(sentence || '').trim();
            if (!cleanSent || /\b(?:how\s+(?:can|may)\s+i\s+(?:help|assist)|as\s+an\s+ai)\b/i.test(cleanSent)) return;
            const seq = idxSeq++;
            streamedSpeech = true;
            ttsTasks.push(this.#deliverVcReply(context.chatId, cleanSent, {
              speak: true,
              sendChat: false,
              appendMode: seq > 0,
              bargeInClear: seq === 0,
              speakerName: userName,
              userText
            }));
          }
        });
        await Promise.allSettled(ttsTasks);
        const candidate = String(res?.text || '').replace(/^["']|["']$/g, '').trim();
        if (candidate && res?.provider !== 'builtin' && !/\b(?:how\s+(?:can|may)\s+i\s+(?:help|assist)|as\s+an\s+ai)\b/i.test(candidate)) {
          reply = candidate;
        }
      } catch {}
    } else if (typeof this.app?.ai?.generate === 'function') {
      try {
        const res = await this.app.ai.generate({
          task: 'chat',
          style: 'cool',
          text: userText,
          preferBackup: !isVc,
          context: {
            system: sysPrompt,
            history: (conv?.history || []).slice(-8),
            temperature: 0.86
          },
          maxTokens: isVc ? 110 : 220
        });
        const candidate = String(res?.text || '').replace(/^["']|["']$/g, '').trim();
        if (candidate && res?.provider !== 'builtin' && !/\b(?:how\s+(?:can|may)\s+i\s+(?:help|assist)|as\s+an\s+ai)\b/i.test(candidate)) {
          reply = candidate;
        }
      } catch {}
    }

    if (!reply) {
      this._banterCounter = (this._banterCounter + 1) % 6;
      const trackBit = nowTitle ? `just vibing with "${nowTitle}" right now` : `${timeCtx.period.replace('_', ' ')} energy feels solid`;
      const variants = [
        `Hey ${userName}! Doing good over here, honestly ${trackBit} — how’s your ${timeCtx.period === 'late_night' ? 'night' : 'day'} going?`,
        `Yo ${userName}! Ngl ${nowTitle ? `rolling "${nowTitle}" gave me good vibes` : `quiet deck has me thinking we need a proper jam`} — talk to me, wetin dey happen?`,
        `Hiii ${userName}! Feeling pretty locked in today (${timeCtx.localTimeStr} vibes hitting just right) — you chilling or tryna switch the energy up?`,
        `Ayy ${userName}! Honestly I was just thinking ${nowTitle ? `"${nowTitle}" hits better when we actually catch the groove` : `we could spin something smooth`} — you good on your side?`,
        `Hey ${userName}, good to hear from you! Always down to vibe or bounce ideas — what’s the mood feeling like right now?`,
        `Yo ${userName}! Life’s smooth here, just keeping the booth warm for you — what’s moving you right now?`
      ];
      reply = variants[this._banterCounter % variants.length];
    }

    return { reply, executed: [], clarificationAsked: null, finishedState: null, streamedSpeech };
  }

  async #generateWakeSelfAwareReply({ conv, cleanSpeaker, userId, chatId, wasPlaying, rawText, snapshot }) {
    const timeCtx = this.getTimeContext(chatId);
    const tasteSummary = userId ? this.taste.formatPromptSummary(userId, chatId) : '';
    const nowTitle = snapshot?.nowPlaying?.title || null;
    const posClock = snapshot?.nowPlaying?.positionClock || null;
    const recentBotLines = (conv?.history || []).filter((h) => h.role === 'assistant').slice(-4).map((h) => h.content);

    if (typeof this.app?.ai?.generate === 'function') {
      const prompt = [
        `${cleanSpeaker} just called your name ("${rawText}") in Voice Chat.`,
        wasPlaying
          ? `You JUST paused "${nowTitle || 'the playback'}"${posClock ? ` at ${posClock}` : ''} so you can hear them clearly.`
          : 'Nothing is playing right now; you are giving them your full attention.',
        `Local time: ${timeCtx.greeting} (${timeCtx.localTimeStr}).`,
        tasteSummary ? `You know ${cleanSpeaker}'s vibe: ${tasteSummary}.` : '',
        recentBotLines.length ? `NEVER reuse these past lines: ${recentBotLines.join(' | ')}` : '',
        'Write ONE short, warm, self-aware spoken response (1-2 natural sentences, zero markdown).',
        'Acknowledge pausing/listening naturally like a real human co-host (mention the song/movie if paused or the vibe), vary your wording completely, and DO NOT sound like a robot saying "How can I assist you" or "What do you need".'
      ].filter(Boolean).join('\n');
      try {
        const res = await this.app.ai.generate({
          task: 'chat',
          style: 'cool',
          text: prompt,
          context: { temperature: 0.9 },
          maxTokens: 95
        });
        const candidate = String(res?.text || '').replace(/^["']|["']$/g, '').trim();
        if (candidate && res?.provider !== 'builtin') {
          return candidate;
        }
      } catch {}
    }

    this._wakeCounter = (this._wakeCounter + 1) % 6;
    if (wasPlaying && nowTitle) {
      const pausedVariants = [
        `Hold on ${cleanSpeaker}, I paused "${nowTitle}" right there — talk to me, I'm listening!`,
        `Gotcha ${cleanSpeaker}, put "${nowTitle}" on hold for a sec — what's on your mind?`,
        `Easy ${cleanSpeaker}, stopped "${nowTitle}" at ${posClock || 'this spot'} so I can hear you proper — go ahead!`,
        `I’m right here ${cleanSpeaker}! Paused "${nowTitle}" for you — drop whatever you’re thinking.`,
        `All ears ${cleanSpeaker}! Held "${nowTitle}" right there — what are we saying?`,
        `Say less ${cleanSpeaker}, I’ve got "${nowTitle}" paused cleanly — talk to me.`
      ];
      return pausedVariants[this._wakeCounter % pausedVariants.length];
    }
    const idleVariants = [
      `Right here with you ${cleanSpeaker}! Room’s quiet and I’m all ears — what’s good?`,
      `Yo ${cleanSpeaker}, I hear you loud and clear — what’s the move?`,
      `I’m locked in ${cleanSpeaker}, go ahead and talk to me!`,
      `Always around for you ${cleanSpeaker} — what are we getting into ${timeCtx.period === 'late_night' ? 'tonight' : 'today'}?`,
      `All ears ${cleanSpeaker}! Tell me what you’re feeling right now.`,
      `Hey ${cleanSpeaker}, tuned right in — wetin dey on your mind?`
    ];
    return idleVariants[this._wakeCounter % idleVariants.length];
  }

  async #runToolLoop({ conv, userText, sourceSurface, context }) {
    const hasImages = Boolean(Array.isArray(context.images) && context.images.length > 0);
    const userName = context.senderName ? normalizeDisplayName(context.senderName, null) : null;
    const isVc = String(sourceSurface || '').startsWith('vc_');
    const sessionKey = isVc
      ? `vc:${context.chatId}`
      : (Number(context.chatId) > 0 ? `dm:${context.userId || context.chatId}` : `bot:${context.chatId}`);
    const sessionCtx = this.memory.getSessionContext(sessionKey, { chatId: context.chatId, surface: sourceSurface });
    const [snapshot, awareness] = await Promise.all([
      this.executor.execute('get_call_state', {}, context).catch(() => null),
      this.awareness.buildSnapshot({
        chatId: context.chatId,
        userId: context.userId,
        speakerName: userName,
        surface: sourceSurface,
        sessionState: sessionCtx,
        ctx: context.ctx
      }).catch(() => null)
    ]);

    const behaviorAnalysis = context.behaviorAnalysis || this.behavior.analyzeTurn({
      chatId: context.chatId,
      userId: context.userId,
      senderName: userName || 'Member',
      surface: sourceSurface,
      sessionKey,
      text: userText,
      isDirectlyAddressed: context.isDirectlyAddressed ?? true,
      conversationMode: conv.mode,
      lowConfidence: Boolean(context.lowConfidence),
      simultaneousSpeakers: context.simultaneousSpeakers || [],
      participants: awareness?.participants || [],
      snapshot
    });

    const decision = this.decision.decide({
      text: userText,
      surface: sourceSurface,
      hasImages,
      isDirectlyAddressed: context.isDirectlyAddressed ?? true,
      conversationMode: conv.mode,
      lowConfidence: Boolean(context.lowConfidence),
      simultaneousSpeakers: context.simultaneousSpeakers || [],
      recentTurnCount: conv.history?.length || 0,
      nowPlayingTitle: snapshot?.nowPlaying?.title || null,
      behaviorAnalysis
    });

    if (decision.cancelSpeech) {
      await this.handleBargeIn({ chatId: context.chatId, userId: context.userId, senderName: userName }).catch(() => {});
      return { reply: '', executed: [], skipped: true, cancelledSpeech: true, decision, clarificationAsked: null, finishedState: null };
    }

    if (decision.action === DECISION.CONTINUE_LISTENING || decision.action === DECISION.SILENT_OTHER_SPEAKER) {
      return { reply: '', executed: [], skipped: true, decision, clarificationAsked: null, finishedState: null };
    }

    if (decision.action === DECISION.SHORT_ACK && !hasImages) {
      const acks = ['Got you.', 'Right.', 'I hear you.', 'Say less.', 'Makes sense.'];
      const ackReply = acks[conv.history.length % acks.length];
      this.behavior.recordOutcome({ sessionKey, chatId: context.chatId, surface: sourceSurface, reply: ackReply });
      return { reply: ackReply, executed: [], decision, clarificationAsked: null, finishedState: null };
    }

    if (!hasImages && decision.action === DECISION.RESPOND && isPureCasualBanter(userText)) {
      return this.#generateHumanBanterReply({ conv, userText, sourceSurface, context });
    }

    const deskSteps = !hasImages && decision.action !== DECISION.DEEP_REASON ? parseDeskIntents(userText) : null;
    if (deskSteps?.length) {
      const executed = [];
      const t0 = Date.now();
      for (const step of deskSteps) {
        const out = await this.executor.execute(step.name, step.args, context).catch((e) => ({ ok: false, error: e?.message || 'execution_failed' }));
        executed.push({ name: step.name, args: step.args, out });
      }
      this.awareness.recordToolBatch({
        count: executed.length,
        failures: executed.filter((e) => !e.out?.ok).length,
        latencyMs: Date.now() - t0
      });
      const cleanUser = userName || 'friend';
      const deskReply = this.#formatDeskSummary(executed, cleanUser);
      this.behavior.recordOutcome({ sessionKey, chatId: context.chatId, surface: sourceSurface, reply: deskReply });
      return {
        reply: deskReply,
        executed,
        clarificationAsked: null,
        finishedState: null
      };
    }

    const currentPersona = context.persona || this.getActivePersona(context.chatId, context.userId);
    const participantNames = (awareness?.participants || []).map((p) => p?.display_name || p?.name).filter(Boolean);
    const personaPick = resolvePersonaFromText(userText, currentPersona, participantNames);
    const activePersona = personaPick.persona || currentPersona;
    if (personaPick.switched) {
      this.setActivePersona(context.chatId, activePersona, context.userId || 0);
      if (isVc && typeof this.app?.voiceClient?.setListenState === 'function') {
        void this.app.voiceClient.setListenState(context.chatId, { mode: 'config', voice: activePersona.geminiVoice }).catch(() => {});
      }
    }

    const tasteSummary = context.userId ? this.taste.formatPromptSummary(context.userId, context.chatId) : '';
    const memoryContext = this.memory.formatPromptContext({
      sessionKey,
      chatId: context.chatId,
      userId: context.userId,
      query: userText,
      surface: sourceSurface,
      includeUserPrivate: Boolean(context.includeUserPrivate)
    });
    const timeCtx = this.getTimeContext(context.chatId);
    const system = this.#buildSystemPrompt({ snapshot, conv, sourceSurface, userName, tasteSummary, memoryContext, timeCtx, awareness, behaviorAnalysis, persona: activePersona });

    const messages = [
      ...conv.history.slice(-10).map((h) => ({ role: h.role, content: h.content })),
      {
        role: 'user',
        content: userText,
        ...(hasImages ? { images: context.images } : {})
      }
    ];

    const executed = [];
    const seenToolExecs = new Set();
    let clarificationAsked = null;
    let finishedState = null;
    let finalReply = '';
    const readOnlyTools = new Set(['get_call_state', 'web_research', 'tell_story_or_novel']);
    const wantsStorytelling = /\b(?:story|stories|novel|dark\s+romance|mafia\s+romance|tell\s+me\s+a|narrate|chapter)\b/i.test(userText);

    for (let step = 0; step < 5; step++) {
      if (context.signal?.aborted) {
        return { reply: '', executed, aborted: true, clarificationAsked: null, finishedState: null, persona: activePersona };
      }

      // VC turns default to GPT (gpt-6.2-astra:free) for fast real-time interaction,
      // escalating to Gemini 4 Neon on vision/research/stories/deep recall; Chat turns default to Neon.
      const useDeep = Boolean(hasImages || !isVc || wantsStorytelling || decision.action === DECISION.DEEP_REASON || step >= 2);
      const tModelStart = Date.now();
      let res = null;
      try {
        if (useDeep && typeof this.app?.ai?.deepReason === 'function') {
          res = await this.app.ai.deepReason({
            system,
            messages,
            tools: LANCY_TOOLS_SCHEMA,
            text: userText,
            images: hasImages ? context.images : null,
            maxTokens: 480,
            temperature: 0.38,
            signal: context.signal
          });
        } else if (typeof this.app?.ai?.chatWithTools === 'function') {
          res = await this.app.ai.chatWithTools({
            system,
            messages,
            tools: LANCY_TOOLS_SCHEMA,
            text: userText,
            images: hasImages ? context.images : null,
            maxTokens: useDeep ? 460 : 340,
            temperature: 0.42,
            signal: context.signal
          });
        }
        this.awareness.recordModelTurn({ latencyMs: Date.now() - tModelStart, ok: Boolean(res) });
      } catch (err) {
        this.awareness.recordModelTurn({ latencyMs: Date.now() - tModelStart, ok: false, error: err?.message || 'model_call_failed' });
        res = null;
      }

      if (context.signal?.aborted) {
        return { reply: '', executed, aborted: true, clarificationAsked: null, finishedState: null };
      }

      const toolCalls = Array.isArray(res?.toolCalls) ? res.toolCalls : [];
      if (!toolCalls.length) {
        finalReply = String(res?.text || '').trim();
        // If AI provider fell back to builtin or gave no tool call on an unmistakable command, do a safe deterministic check
        if (step === 0 && (!finalReply || res?.provider === 'builtin')) {
          const rescued = await this.#safeFallbackIntent(userText, context, conv);
          if (rescued) return rescued;
        }
        break;
      }

      messages.push({
        role: 'assistant',
        content: String(res?.text || ''),
        ...(res?.rawMessage?.reasoning_content ? { reasoning_content: res.rawMessage.reasoning_content } : {}),
        ...(res?.rawMessage?.thought_signature ? { thought_signature: res.rawMessage.thought_signature } : {}),
        tool_calls: toolCalls.map((tc, idx) => ({
          id: tc.id || `call_${step}_${idx}`,
          type: 'function',
          ...(tc.thought_signature ? { thought_signature: tc.thought_signature } : {}),
          ...(tc.extra_content ? { extra_content: tc.extra_content } : {}),
          function: {
            name: tc.function.name,
            arguments: typeof tc.function.arguments === 'string'
              ? tc.function.arguments
              : JSON.stringify(tc.function.arguments || {})
          }
        }))
      });

      const isReadOnlyCall = (name, args) => readOnlyTools.has(name)
        || (name === 'search_videos' && (!args?.action || args.action === 'search'))
        || (name === 'search_movies_series' && (!args?.action || args.action === 'search' || args.action === 'inspect'))
        || (name === 'download_url_or_images' && args?.kind === 'search_images');

      const tToolsStart = Date.now();
      const prepared = toolCalls.map((tc, idx) => ({
        idx,
        id: tc.id || `call_${step}_${idx}`,
        name: tc.function.name,
        args: tc.function.arguments || {},
        readOnly: isReadOnlyCall(tc.function.name, tc.function.arguments || {})
      }));

      const outcomes = new Array(prepared.length);
      const readBatch = prepared.filter((p) => p.readOnly);
      if (readBatch.length > 1) {
        await Promise.all(readBatch.map(async (item) => {
          const sigKey = `${item.name}:${JSON.stringify(item.args)}`;
          if (seenToolExecs.has(sigKey)) {
            outcomes[item.idx] = { ok: true, deduplicated: true };
            return;
          }
          seenToolExecs.add(sigKey);
          outcomes[item.idx] = await this.executor.execute(item.name, item.args, context).catch((err) => ({ ok: false, error: err?.message || 'execution_failed' }));
        }));
      }

      for (const item of prepared) {
        if (outcomes[item.idx] !== undefined) continue;
        const sigKey = `${item.name}:${JSON.stringify(item.args)}`;
        if (seenToolExecs.has(sigKey)) {
          outcomes[item.idx] = { ok: true, deduplicated: true };
          continue;
        }
        seenToolExecs.add(sigKey);
        outcomes[item.idx] = await this.executor.execute(item.name, item.args, context).catch((err) => ({ ok: false, error: err?.message || 'execution_failed' }));
      }

      let toolFailures = 0;
      for (const item of prepared) {
        const out = outcomes[item.idx];
        if (!out?.ok) toolFailures += 1;
        executed.push({ name: item.name, args: item.args, out });
        if (item.name === 'ask_clarification') clarificationAsked = out.question;
        if (item.name === 'finish_conversation') finishedState = out;
        messages.push({
          role: 'tool',
          tool_call_id: item.id,
          name: item.name,
          tool_name: item.name,
          content: JSON.stringify(out)
        });
      }
      this.awareness.recordToolBatch({
        count: prepared.length,
        failures: toolFailures,
        latencyMs: Date.now() - tToolsStart
      });

      if (clarificationAsked) {
        finalReply = clarificationAsked;
        break;
      }
      if (finishedState) {
        finalReply = finishedState.closingLine || '';
        break;
      }
    }

    if (finalReply) {
      this.behavior.recordOutcome({
        sessionKey,
        chatId: context.chatId,
        surface: sourceSurface,
        reply: finalReply,
        concluded: Boolean(finishedState?.done)
      });
    }
    return { reply: finalReply, executed, decision, clarificationAsked, finishedState, behaviorAnalysis, persona: activePersona };
  }

  /**
   * Minimal safe fallback when Ollama is offline / builtin provider ran.
   * Only acts on unambiguous explicit commands; otherwise asks cleanly or chats warmly.
   */
  async #safeFallbackIntent(text, context, conv) {
    const clean = stripWakePrefix(text).toLowerCase();
    if (!clean) return null;
    if (conv.mode !== 'IDLE' && AFFIRMATIVE_DONE_RE.test(clean)) {
      return {
        reply: 'Alright, enjoying the show — back to playback!',
        executed: [],
        finishedState: { done: true, resumePlayback: true }
      };
    }

    const actions = [];
    if (/\b(?:mute)\b/.test(clean) && !/\bunmute\b/.test(clean)) actions.push(['adjust_volume', { mode: 'mute' }]);
    else if (/\bunmute\b/.test(clean)) actions.push(['adjust_volume', { mode: 'unmute' }]);
    const volNum = clean.match(/\bvolume\s*(?:to|at)?\s*(\d{1,3})\b/);
    if (volNum) actions.push(['adjust_volume', { mode: 'set', value: Number(volNum[1]) }]);
    else if (/\b(?:lower|reduce|turn\s+down|decrease)\b.*\b(?:vol|volume|sound)\b/.test(clean)) actions.push(['adjust_volume', { mode: 'lower', value: 25 }]);
    else if (/\b(?:raise|increase|turn\s+up|louder)\b.*\b(?:vol|volume|sound)\b/.test(clean)) actions.push(['adjust_volume', { mode: 'louder', value: 25 }]);

    if (/\bpause\b/.test(clean)) actions.push(['control_playback', { action: 'pause' }]);
    if (/\bresume\b/.test(clean)) actions.push(['control_playback', { action: 'resume' }]);
    if (/\b(?:next\s+queue|move\s+to\s+next|skip)\b/.test(clean)) actions.push(['control_playback', { action: 'skip' }]);
    if (/\b(?:previous|go\s+back\s+track|last\s+track)\b/.test(clean)) actions.push(['control_playback', { action: 'previous' }]);
    if (/\b(?:middle|halfway)\b/.test(clean)) actions.push(['seek_playback', { target: 'middle' }]);
    if (/\bsend\b.*\b(?:video|movie|song|this)\b.*\bchat\b/.test(clean)) actions.push(['send_current_video_to_chat', {}]);

    // Natural music / movie / video / poll fallback intents
    const vidMatch = clean.match(/\b(?:search|find|look\s*up)\s+(?:for\s+)?videos?\s+(?:of|about|for)?\s*(.+)/i)
      || clean.match(/\b(?:play|queue|send)\s+video\s*#?\s*(\d+)\b/i);
    const numMoviePick = clean.match(/\b(?:play|watch|stream|queue)\s+(?:result\s*|option\s*|number\s*)?#\s*(\d+)(?:\s+season\s*(\d+))?(?:\s+episode\s*(\d+))?/i);
    const inspectMatch = clean.match(/\b(?:what\s+is|tell\s+me\s+about|how\s+many\s+(?:seasons|episodes))\s+.*?(?:#\s*(\d+)|results?)/i);
    const curOrNextEp = clean.match(/\b(?:season\s*(\d+)\s*)?(?:episode|ep)\s*(\d+)\b.*\b(?:this|current|playing|now\s+playing|next|upcoming)\b/i);
    const movieReq = clean.match(/\b(?:play|stream|watch|find|search|put\s+on)\s+(?:the\s+)?(?:movie|film|series|show)\s+(?:of\s+)?(.+)/i);

    if (inspectMatch) {
      actions.push(['search_movies_series', { action: 'inspect', ...(inspectMatch[1] ? { result_index: Number(inspectMatch[1]) } : {}) }]);
    } else if (numMoviePick) {
      actions.push(['search_movies_series', {
        action: /\bqueue\b/i.test(clean) ? 'queue' : 'play_now',
        target_scope: 'search_result',
        result_index: Number(numMoviePick[1]),
        ...(numMoviePick[2] ? { season: Number(numMoviePick[2]) } : {}),
        ...(numMoviePick[3] ? { episode: Number(numMoviePick[3]) } : {})
      }]);
    } else if (curOrNextEp) {
      actions.push(['search_movies_series', {
        action: 'play_now',
        target_scope: /\b(?:next|upcoming)\b/i.test(clean) ? 'up_next' : 'current',
        ...(curOrNextEp[1] ? { season: Number(curOrNextEp[1]) } : {}),
        episode: Number(curOrNextEp[2])
      }]);
    } else if (vidMatch) {
      if (/^\d+$/.test(String(vidMatch[1] || '').trim())) {
        actions.push(['search_videos', {
          action: /\bsend\b/i.test(clean) ? 'send_to_chat' : (/\bqueue\b/i.test(clean) ? 'queue' : 'play_now'),
          result_index: Number(vidMatch[1])
        }]);
      } else {
        actions.push(['search_videos', { query: vidMatch[1].trim(), action: 'search' }]);
      }
    } else if (movieReq && movieReq[1]?.trim().length >= 2) {
      actions.push(['search_movies_series', {
        query: movieReq[1].trim(),
        action: /\b(?:search|find)\b/i.test(clean) && !/\b(?:play|stream|watch)\b/i.test(clean) ? 'search' : 'play_now'
      }]);
    } else if (/\b(?:poll|vote)\b/i.test(clean) && !/\bskip\b/i.test(clean)) {
      const prof = context.userId ? this.taste.getProfile(context.userId, context.chatId) : null;
      const opts = prof?.topArtists?.length >= 2
        ? [...prof.topArtists.slice(0, 3), 'Surprise Chill Mix']
        : ['Afrobeats Heat', 'Chill / R&B', 'Rap & Drill', 'Surprise Movie'];
      actions.push(['create_decision_poll', { question: '🎙️ What should we roll with next?', options: opts }]);
    } else {
      const songWant = clean.match(/^(?:i(?:'?ll|\s+would)?\s+want|give\s+me|play|put\s+on|drop|queue|i\s+need)\s+(?:some\s+|the\s+)?(.+)/i);
      if (songWant && songWant[1]?.trim().length >= 2 && !/\b(?:movie|film|series|poll)\b/i.test(songWant[1])) {
        actions.push(['search_and_play_music', { query: songWant[1].trim(), action: 'play_now' }]);
      }
    }

    if (!actions.length) return null;
    const executed = [];
    for (const [name, args] of actions) {
      const out = await this.executor.execute(name, args, context).catch((e) => ({ ok: false, error: e?.message }));
      executed.push({ name, args, out });
    }
    const userName = context.senderName ? normalizeDisplayName(context.senderName, 'friend') : 'friend';
    return {
      reply: this.#formatDeskSummary(executed, userName) || 'I tried to run that, check the player card for status.',
      executed
    };
  }

  /**
   * Handle live VC speech or interactive VC text input.
   */
  async handleVcTurn({
    chatId,
    userId = null,
    senderName = 'Admin',
    fromAdmin = false,
    text = '',
    source = 'vc_voice', // 'vc_voice' | 'vc_message'
    confidence = 1.0,
    lowConfidence = false,
    isWake = false,
    isListenCommand = false,
    eventId = null,
    simultaneousSpeakers = [],
    detectedAtMs = null,
    ctx = null
  } = {}) {
    const cid = Number(chatId);
    const raw = String(text || '').trim();
    if (!Number.isSafeInteger(cid) || cid >= 0 || !raw) return { handled: false };

    if (eventId && this.#markEventSeen(eventId)) {
      return { handled: false, duplicate: true };
    }

    return this.chatLocks.run(cid, async () => {
      const isVcText = source === 'vc_message';
      const isVcVoice = !isVcText;
      const conv = this.getVcConversation(cid);
      const authorized = await this.isAuthorizedSpeaker(cid, userId, { fromAdmin });
      const cleanSpeaker = await this.resolveSpeakerName(cid, userId, senderName, ctx);
      const sessionKey = `vc:${cid}`;
      const mentionsLancy = /\blancy\b/i.test(raw);
      const explicitListenWake = Boolean(
        isListenCommand
        || /\blancy\b[\s,]*(?:abeg\s+|please\s+)?\blisten\b|\blisten\b[\s,]*\blancy\b/i.test(raw)
      );

      // Always track group conversation speakers & topics passively even while Lancy stays quiet
      this.memory.recordSpeakerTurn(sessionKey, {
        chatId: cid,
        surface: source,
        userId,
        speakerName: cleanSpeaker,
        role: 'user',
        text: raw,
        addressedToLancy: mentionsLancy || explicitListenWake || conv.mode !== 'IDLE',
        confidence,
        simultaneousSpeakers
      });

      // For VC text chat: require "lancy" (or an active VC text clarification prompt) and execute without pausing.
      if (isVcText) {
        if (!mentionsLancy && !(conv.mode === 'CLARIFYING' && conv.pendingSource === 'vc_message')) {
          return { handled: false };
        }
        if (!authorized) {
          return { handled: false, blocked: true };
        }
      } else {
        // For VC voice mic: when idle, strictly ONLY "Lancy listen" wakes Lancy; ignore all other idle speech.
        if (conv.mode === 'IDLE' && !explicitListenWake) {
          return { handled: false, ignored: true };
        }
        if (!authorized) {
          return { handled: false, blocked: true };
        }
      }

      const prevCtrl = this.activeTurnControllers.get(cid);
      if (prevCtrl) prevCtrl.abort('superseded');
      const turnCtrl = new AbortController();
      this.activeTurnControllers.set(cid, turnCtrl);

      try {
        conv.lastActiveAt = Date.now();
        this.awareness.metrics.turnsTotal += 1;
        this.memory.extractAndStoreFromText({
          chatId: cid,
          userId,
          speakerName: cleanSpeaker,
          text: raw,
          isGroup: true
        });
        if (userId) this.taste.recordPreference({ userId, chatId: cid, displayName: cleanSpeaker, requestText: raw });

        const s = this.app?.musicQueueManager?.sessions?.get?.(cid);
        const hudTheme = this.getHudTheme(cid);
        const hudExtras = hudTheme && hudTheme !== 'off' ? { hud_theme: hudTheme } : {};
        const wantsSpokenReply = isVcVoice || /\b(?:speak|say\s+it\s+out|talk\s+on\s+mic|voice\s+reply|read\s+out)\b/i.test(raw);

        // 1. Handle wake-only "Lancy listen" -> pause playback immediately, then generate a fresh self-aware reply
        if (explicitListenWake && WAKE_ONLY_LISTEN_RE.test(raw)) {
          const wasPlaying = s?.status === 'playing';
          conv.mode = 'LISTENING';
          conv.pausedByLancy = wasPlaying || conv.pausedByLancy;
          if (wasPlaying) conv.pausedTrackId = s?.currentTrack?.entryId || s?.currentTrack?.id || null;
          conv.pendingSource = source;
          conv.activeSpeakerId = userId ? Number(userId) : conv.activeSpeakerId;
          conv.pendingClarificationText = null;
          this.#resetIdleTimer(conv);

          if (typeof this.app?.voiceClient?.setListenState === 'function') {
            await this.app.voiceClient.setListenState(cid, {
              mode: 'start',
              active: true,
              pause_media: wasPlaying,
              duration_sec: 32,
              active_user_id: conv.activeSpeakerId,
              speaker_name: cleanSpeaker,
              user_text: raw,
              lancy_text: '',
              ...hudExtras
            }).catch(() => {});
          }
          if (wasPlaying && s) s.status = 'paused';

          const snap = await this.executor.execute('get_call_state', {}, { chatId: cid, telegramChatId: cid, userId, senderName: cleanSpeaker, ctx }).catch(() => null);
          const reply = await this.#generateWakeSelfAwareReply({
            conv,
            cleanSpeaker,
            userId,
            chatId: cid,
            wasPlaying,
            rawText: raw,
            snapshot: snap
          });

          this.#pushHistory(conv, 'user', raw);
          this.#pushHistory(conv, 'assistant', reply);
          this.memory.recordSpeakerTurn(sessionKey, { chatId: cid, surface: source, role: 'assistant', speakerName: 'Lancy', text: reply });
          const sc = this.memory.getSessionContext(sessionKey, { chatId: cid, surface: 'vc' });
          sc.mode = conv.mode;
          this.memory.saveSessionContext(sc);

          await this.#deliverVcReply(cid, reply, { speak: true, speakerName: cleanSpeaker, userText: raw });
          if (detectedAtMs) this.awareness.recordVoiceLatency({ firstAudioMs: Date.now() - Number(detectedAtMs) });
          return { handled: true, mode: conv.mode, reply };
        }

        const stripped = stripWakePrefix(raw) || raw;
        // Bare "Lancy" in VC text chat -> warm non-pausing greeting in VC chat
        if (isVcText && WAKE_ONLY_LISTEN_RE.test(raw) && !explicitListenWake) {
          const banter = await this.#generateHumanBanterReply({
            conv,
            userText: 'hi',
            sourceSurface: source,
            context: { chatId: cid, telegramChatId: cid, userId, senderName: cleanSpeaker, ctx, streamTts: false, signal: turnCtrl.signal }
          });
          this.#pushHistory(conv, 'user', raw);
          this.#pushHistory(conv, 'assistant', banter.reply);
          this.memory.recordSpeakerTurn(sessionKey, { chatId: cid, surface: source, role: 'assistant', speakerName: 'Lancy', text: banter.reply });
          await this.#deliverVcReply(cid, banter.reply, { speak: wantsSpokenReply, speakerName: cleanSpeaker, userText: raw });
          return { handled: true, mode: conv.mode, reply: banter.reply };
        }

        // 2. Quick end-of-conversation check ("yeah", "that's all", "resume") during active voice session
        if (conv.mode !== 'IDLE' && conv.pausedByLancy && AFFIRMATIVE_DONE_RE.test(stripped)) {
          const shouldResume = Boolean(conv.pausedByLancy || s?.status === 'paused');
          conv.mode = 'IDLE';
          conv.pausedByLancy = false;
          conv.pausedTrackId = null;
          conv.pendingSource = null;
          conv.activeSpeakerId = null;
          conv.pendingClarificationText = null;
          if (conv.idleTimer) { clearTimeout(conv.idleTimer); conv.idleTimer = null; }
          const reply = shouldResume ? 'Alright, enjoy! Resuming now.' : 'Alright, I’m right here whenever you call me!';
          if (typeof this.app?.voiceClient?.setListenState === 'function') {
            await this.app.voiceClient.setListenState(cid, {
              mode: 'stop',
              active: false,
              resume_media: shouldResume,
              speaker_name: cleanSpeaker,
              user_text: raw,
              lancy_text: reply
            }).catch(() => {});
          }
          if (shouldResume && s) {
            s.status = 'playing';
            void this.app?.musicQueueManager?.updatePlayerCard?.(cid, { forceEdit: true }).catch(() => {});
          }
          this.#pushHistory(conv, 'user', raw);
          this.#pushHistory(conv, 'assistant', reply);
          this.memory.recordSpeakerTurn(sessionKey, { chatId: cid, surface: source, role: 'assistant', speakerName: 'Lancy', text: reply });
          const sc = this.memory.getSessionContext(sessionKey, { chatId: cid, surface: 'vc' });
          sc.mode = conv.mode;
          this.memory.saveSessionContext(sc);

          await this.#deliverVcReply(cid, reply, { speak: wantsSpokenReply, speakerName: cleanSpeaker, userText: raw });
          return { handled: true, mode: conv.mode, reply };
        }

        // 3. Speech clarification gate on noisy/garbled voice transcripts
        const hasRescueKeyword = CLEAR_COMMAND_RESCUE_RE.test(stripped);
        if (isVcVoice && lowConfidence && (!hasRescueKeyword || Number(confidence) < 0.38)) {
          const wasPlaying = s?.status === 'playing';
          if (conv.mode === 'IDLE') {
            conv.mode = 'CLARIFYING';
            conv.pausedByLancy = wasPlaying;
            if (wasPlaying) conv.pausedTrackId = s?.currentTrack?.entryId || s?.currentTrack?.id || null;
          }
          conv.pendingSource = 'vc_voice';
          conv.pendingClarificationText = stripped;
          this.#resetIdleTimer(conv);
          const ask = 'Sorry, I didn’t catch that clearly — what did you say?';
          if (typeof this.app?.voiceClient?.setListenState === 'function') {
            await this.app.voiceClient.setListenState(cid, {
              mode: 'start',
              active: true,
              pause_media: wasPlaying,
              duration_sec: 28,
              active_user_id: userId ? Number(userId) : conv.activeSpeakerId,
              speaker_name: cleanSpeaker,
              user_text: stripped,
              lancy_text: ask,
              ...hudExtras
            }).catch(() => {});
          }
          if (wasPlaying && s) s.status = 'paused';
          this.#pushHistory(conv, 'user', `[unclear voice: ${raw}]`);
          this.#pushHistory(conv, 'assistant', ask);
          this.memory.recordSpeakerTurn(sessionKey, { chatId: cid, surface: source, role: 'assistant', speakerName: 'Lancy', text: ask });
          await this.#deliverVcReply(cid, ask, { speak: true, speakerName: cleanSpeaker, userText: stripped });
          return { handled: true, clarification: true, reply: ask };
        }

        // 4. Refresh active voice listening window ONLY for voice interactions (VC text works live without locking mic/playback!)
        if (isVcVoice) {
          if (conv.mode === 'IDLE') conv.mode = 'AWAITING_FOLLOWUP';
          this.#resetIdleTimer(conv);
          if (typeof this.app?.voiceClient?.setListenState === 'function') {
            await this.app.voiceClient.setListenState(cid, {
              mode: 'start',
              active: true,
              pause_media: false,
              duration_sec: 28,
              active_user_id: userId ? Number(userId) : conv.activeSpeakerId,
              speaker_name: cleanSpeaker,
              user_text: stripped,
              ...hudExtras
            }).catch(() => {});
          }
        }

        // 5. Run zero-latency NLU + Hybrid AI tool loop
        this.#pushHistory(conv, 'user', stripped);
        const result = await this.#runToolLoop({
          conv,
          userText: stripped,
          sourceSurface: source,
          context: {
            chatId: cid,
            telegramChatId: cid,
            userId,
            senderName: cleanSpeaker,
            ctx,
            lowConfidence,
            simultaneousSpeakers,
            isDirectlyAddressed: mentionsLancy || explicitListenWake,
            includeUserPrivate: false,
            signal: turnCtrl.signal,
            streamTts: isVcVoice && wantsSpokenReply
          }
        });

        if (result.aborted) {
          return { handled: false, aborted: true };
        }
        if (result.cancelledSpeech) {
          return { handled: true, cancelledSpeech: true, mode: conv.mode, reply: '' };
        }
        if (result.skipped) {
          return { handled: false, ignored: true, decision: result.decision };
        }

        const explicitStopOrPause = result.executed.some((e) =>
          e.name === 'control_playback' && ['pause', 'stop', 'leave'].includes(e.args?.action)
        );
        const explicitResumeOrPlay = result.executed.some((e) =>
          (e.name === 'control_playback' && ['resume', 'skip', 'previous'].includes(e.args?.action))
          || (['search_movies_series', 'search_and_play_music'].includes(e.name) && e.args?.action === 'play_now')
        );

        if (explicitStopOrPause) {
          conv.pausedByLancy = false;
          conv.pausedTrackId = null;
        }

        if (result.finishedState) {
          const shouldResume = Boolean(result.finishedState.resumePlayback && !explicitStopOrPause);
          conv.mode = 'IDLE';
          conv.pausedByLancy = false;
          conv.pausedTrackId = null;
          conv.pendingSource = null;
          if (conv.idleTimer) { clearTimeout(conv.idleTimer); conv.idleTimer = null; }
          if (isVcVoice && typeof this.app?.voiceClient?.setListenState === 'function') {
            await this.app.voiceClient.setListenState(cid, {
              mode: 'stop',
              active: false,
              resume_media: shouldResume
            }).catch(() => {});
          }
          if (shouldResume && s) {
            s.status = 'playing';
            void this.app?.musicQueueManager?.updatePlayerCard?.(cid, { forceEdit: true }).catch(() => {});
          }
        } else if (isVcVoice && explicitResumeOrPlay) {
          conv.pausedByLancy = false;
          conv.pausedTrackId = null;
          conv.mode = 'AWAITING_FOLLOWUP';
        } else if (isVcVoice && !result.clarificationAsked && conv.pausedByLancy) {
          conv.mode = 'AWAITING_FOLLOWUP';
        } else if (isVcText && conv.mode === 'CLARIFYING') {
          conv.mode = 'IDLE';
          conv.pendingSource = null;
        }

        let reply = result.reply;
        if (!reply) {
          reply = result.executed.length
            ? `Sorted that out for you, ${cleanSpeaker}.`
            : `I hear you, ${cleanSpeaker} — go on.`;
        }
        const recentlyCheckedIn = conv.history.slice(-2).some(
          (h) => h.role === 'assistant' && /\b(?:is that all|anything else|is there more|roll playback back)\b/i.test(h.content || '')
        );
        if (
          isVcVoice
          && result.executed.length > 0
          && conv.pausedByLancy
          && !explicitResumeOrPlay
          && !explicitStopOrPause
          && !result.finishedState
          && !result.clarificationAsked
          && !recentlyCheckedIn
          && !/\b(?:is that all|anything else|should i resume|roll it back|what'?s next|is there more)\b/i.test(reply)
        ) {
          const checkIns = ['Should I roll playback back, or is there more?', 'Want me to hit anything else while it’s paused?'];
          reply = `${reply.replace(/[.!?]+$/, '')}. ${checkIns[conv.history.length % checkIns.length]}`;
        }

        this.#pushHistory(conv, 'assistant', reply);
        this.memory.recordSpeakerTurn(sessionKey, { chatId: cid, surface: source, role: 'assistant', speakerName: 'Lancy', text: reply });
        this.behavior.recordOutcome({ sessionKey, chatId: cid, surface: source, reply, concluded: Boolean(result.finishedState?.done) });
        const sc = this.memory.getSessionContext(sessionKey, { chatId: cid, surface: 'vc' });
        sc.mode = conv.mode;
        this.memory.saveSessionContext(sc);

        await this.#deliverVcReply(cid, reply, {
          speak: !result.streamedSpeech && wantsSpokenReply,
          sendChat: true,
          speakerName: cleanSpeaker,
          userText: stripped
        });
        if (detectedAtMs && isVcVoice && wantsSpokenReply) {
          this.awareness.recordVoiceLatency({ firstAudioMs: Date.now() - Number(detectedAtMs) });
        }
        return { handled: true, mode: conv.mode, executed: result.executed, reply, spoken: wantsSpokenReply };
      } finally {
        if (this.activeTurnControllers.get(cid) === turnCtrl) {
          this.activeTurnControllers.delete(cid);
        }
      }
    });
  }

  /**
   * Handle conversational Bot / DM / Chat DJ / Group text using full Lancy A–Z tools + Rich UI card metadata.
   */
  async handleBotTurn(ctx, text, { mode = 'dj', images = null, surface = null, includeUserPrivate = null } = {}) {
    const chatId = Number(ctx?.chatId ?? ctx?.chat?.id ?? ctx?.tgId ?? 0);
    const ident = extractUserIdentity(ctx);
    const userId = ident.userId || Number(ctx?.tgId ?? 0);
    const cleanName = ident.cleanName;
    const mention = buildTelegramMention(ctx, cleanName);
    const conv = this.getBotConversation(chatId, userId);
    const resolvedSurface = surface || (chatId > 0 ? 'dm_text' : 'group_text');
    const sessionKey = chatId > 0 ? `dm:${userId || chatId}` : `bot:${chatId}`;
    const stripped = stripWakePrefix(text) || String(text || '').trim();

    if (/^(?:done|exit|quit|close|cancel|that'?s\s+all|thats\s+all|bye(?:\s+lancy)?|stop\s+chat)$/i.test(stripped)) {
      conv.mode = 'IDLE';
      const bye = `Got you, ${cleanName}! Wrapping up this chat — tap 🎙 Chat DJ anytime you want me again ✨`;
      return {
        reply: bye,
        cleanName,
        mention,
        executed: [],
        concluded: true,
        card: null
      };
    }

    this.awareness.metrics.turnsTotal += 1;
    this.taste.recordPreference({ userId, chatId, displayName: cleanName, requestText: stripped });
    this.memory.recordSpeakerTurn(sessionKey, {
      chatId,
      surface: resolvedSurface,
      userId,
      speakerName: cleanName,
      role: 'user',
      text: stripped,
      addressedToLancy: true
    });
    this.memory.extractAndStoreFromText({
      chatId,
      userId,
      speakerName: cleanName,
      text: stripped,
      isGroup: chatId < 0
    });
    this.#pushHistory(conv, 'user', stripped);

    const result = await this.#runToolLoop({
      conv,
      userText: stripped,
      sourceSurface: resolvedSurface,
      context: {
        chatId,
        telegramChatId: chatId,
        userId,
        senderName: cleanName,
        user: ctx?.user || null,
        ctx,
        images,
        isDirectlyAddressed: true,
        includeUserPrivate: includeUserPrivate ?? (chatId > 0),
        waitForUpload: false
      }
    });

    const reply = result.reply || (result.executed.length ? `Done, ${cleanName}.` : `I hear you, ${cleanName} — go ahead.`);
    this.#pushHistory(conv, 'assistant', reply);
    this.memory.recordSpeakerTurn(sessionKey, {
      chatId,
      surface: resolvedSurface,
      role: 'assistant',
      speakerName: 'Lancy',
      text: reply
    });
    this.behavior.recordOutcome({ sessionKey, chatId, surface: resolvedSurface, reply, concluded: Boolean(result.finishedState?.done) });
    const concluded = Boolean(result.finishedState?.done);
    const cardPayload = concluded
      ? null
      : this.buildConversationRichCard({
          title: mode === 'dj' ? '🎙️ Lancy · Chat DJ' : '✨ Lancy AI Companion',
          subtitle: `${this.getTimeContext(chatId).greeting} · Live Multi-Turn Chat`,
          bodyText: reply,
          mention,
          executed: result.executed,
          mode,
          includeQuickStarters: false
        });

    return { reply, cleanName, mention, executed: result.executed, concluded, card: cardPayload, persona: result.persona || null };
  }
}
