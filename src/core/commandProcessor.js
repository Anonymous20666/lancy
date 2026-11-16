import { logger } from './logger.js';

const FAST_COMMANDS = new Set([
  '/pause', '/resume', '/skip', '/voteskip', '/next', '/previous',
  '/stop', '/end', '/leave', '/player', '/vc', '/vidc',
  '/queue', '/q', '/mqueue', '/volume', '/vol', '/loop', '/repeat',
  '/shuffle', '/seek', '/eq', '/bass', '/streammode', '/rtmp', '/vcsudo', '/rmsudo', '/accounts',
  '/moviecast', '/moviebroadcast', '/moviealert', '/cinemaalert', '/movieannounce',
  '/destination', '/channel', '/start', '/help', '/menu', '/settings',
  '/cancel', '/setprefix', '/prefix', '/rmbot', '/forcejoin', '/fsub', '/forcesub'
]);

const REPEATABLE_CALLBACK_ACTIONS = new Set([
  'seekby', 'seek', 'setseekstep', 'seekmenu', 'subsync', 'vol', 'prompt', 'vcquality'
]);

/**
 * Smart multi-lane Command & Callback Job Processor for busy Group Chats and DMs.
 *
 * Features:
 * 1. Coalesces duplicate command bursts per (chatId, userId, command, query) so
 *    spamming a command in a GC does not spawn N parallel scrapers/downloads.
 * 2. Separates Fast Controls (/skip, /pause, /player, /q) from Heavy/Interactive
 *    jobs (/xvideos, /pornhub, /movie, /play, /pint, /nsfw, /dl) so playback and UI
 *    controls respond in <50ms even when multiple users are downloading media.
 * 3. Fair round-robin scheduling across users and chats with bounded per-user queues
 *    and silent GC backpressure (at most 1 notice per 30s per user).
 * 4. Supersedes stale rapid pagination/filter callbacks on the same message card.
 */
export class CommandJobProcessor {
  constructor({
    maxConcurrentGlobal = 16,
    maxConcurrentPerChat = 4,
    maxConcurrentPerUser = 2,
    maxQueuedPerUser = 4,
    dedupWindowMs = 2200,
    callbackDedupMs = 650,
    noticeCooldownMs = 30000,
    log = null
  } = {}) {
    this.maxConcurrentGlobal = Math.max(4, Number(maxConcurrentGlobal) || 16);
    this.maxConcurrentPerChat = Math.max(2, Number(maxConcurrentPerChat) || 4);
    this.maxConcurrentPerUser = Math.max(1, Number(maxConcurrentPerUser) || 2);
    this.maxQueuedPerUser = Math.max(1, Number(maxQueuedPerUser) || 4);
    this.dedupWindowMs = Math.max(0, Number(dedupWindowMs) ?? 2200);
    this.callbackDedupMs = Math.max(0, Number(callbackDedupMs) ?? 650);
    this.noticeCooldownMs = Math.max(5000, Number(noticeCooldownMs) || 30000);
    this.log = log || logger().child({ module: 'command-processor' });

    this.activeGlobal = 0;
    this.activeByChat = new Map(); // chatKey -> count
    this.activeByUser = new Map(); // userKey -> count
    this.userQueues = new Map();   // userKey -> Array<Job>
    this.rrUsers = [];

    this.inFlightCommands = new Map(); // sig -> { promise, startedAt }
    this.recentCommands = new Map();   // sig -> finishedAt
    this.recentCallbacks = new Map();  // sig -> at
    this.cardPipelines = new Map();    // cardKey -> { running: Promise, pendingJob: fn|null }
    this.noticeHistory = new Map();    // `${chatId}:${userId}` -> at
  }

  isFastCommand(command = '') {
    const clean = String(command || '').split('@')[0].toLowerCase().trim();
    return FAST_COMMANDS.has(clean);
  }

  /**
   * Execute a slash/prefix command with duplicate burst coalescing and fair scheduling.
   */
  async runCommand({
    chatId,
    userId,
    tgId,
    command = '',
    argsText = '',
    query = '',
    isGroup = false,
    api = null,
    replyToMessageId = null
  } = {}, fn) {
    const cleanCmd = String(command || '').split('@')[0].toLowerCase().trim();
    const normArgs = String(argsText || query || '').trim().toLowerCase().slice(0, 120);
    const cKey = String(chatId ?? 'global');
    const uKey = String(userId ?? tgId ?? chatId ?? 'anon');
    const sig = isGroup ? `${cKey}:${cleanCmd}:${normArgs}` : `${cKey}:${uKey}:${cleanCmd}:${normArgs}`;
    const now = Date.now();

    // 1. Coalesce identical in-flight command in same chat
    const existing = this.inFlightCommands.get(sig);
    if (existing && (now - existing.startedAt) < 45000) {
      this.log.debug({ chatId, userId: uKey, command: cleanCmd }, 'coalesced duplicate in-flight command');
      const res = await existing.promise;
      return res && typeof res === 'object' ? { ...res, coalesced: true } : { result: res, coalesced: true };
    }

    // 2. Drop rapid post-completion duplicate bursts in groups (e.g. double-send spam)
    if (isGroup && this.dedupWindowMs > 0 && cleanCmd && !this.isFastCommand(cleanCmd)) {
      const lastDone = this.recentCommands.get(sig) || 0;
      if (now - lastDone < this.dedupWindowMs) {
        this.log.debug({ chatId, userId: uKey, command: cleanCmd }, 'dropped rapid duplicate group command');
        return { coalesced: true, dropped: true };
      }
    }

    // 3. Fast lane commands run immediately without waiting behind heavy scrapers
    if (!cleanCmd || this.isFastCommand(cleanCmd)) {
      const p = Promise.resolve().then(fn).finally(() => {
        if (this.inFlightCommands.get(sig)?.promise === p) {
          this.inFlightCommands.delete(sig);
        }
      });
      this.inFlightCommands.set(sig, { promise: p, startedAt: now });
      return p;
    }

    // 4. Interactive / Heavy lane: check per-user queue depth
    const q = this.userQueues.get(uKey) || [];
    const activeUser = this.activeByUser.get(uKey) || 0;
    if (activeUser >= this.maxConcurrentPerUser && q.length >= this.maxQueuedPerUser) {
      await this.#maybeSendBackpressureNotice({ chatId, userId: uKey, isGroup, api, replyToMessageId });
      return null;
    }

    const promise = this.schedule({ chatKey: cKey, userKey: uKey, isGroup }, fn).finally(() => {
      if (this.inFlightCommands.get(sig)?.promise === promise) {
        this.inFlightCommands.delete(sig);
      }
      this.recentCommands.set(sig, Date.now());
      if (this.recentCommands.size > 1500) {
        const cutoff = Date.now() - 30000;
        for (const [k, t] of this.recentCommands) {
          if (t < cutoff) this.recentCommands.delete(k);
        }
      }
    });

    this.inFlightCommands.set(sig, { promise, startedAt: now });
    return promise;
  }

  /**
   * Execute an inline keyboard callback with double-tap deduplication and
   * per-message superseding for rapid pagination/filter clicks.
   */
  async runCallback({
    chatId,
    userId,
    tgId,
    messageId,
    data = '',
    screen = '',
    action = '',
    args = [],
    coalesceOnCard = true,
    queryId = null,
    api = null
  } = {}, fn) {
    const cKey = String(chatId ?? 'global');
    const uKey = String(userId ?? tgId ?? 'anon');
    const mKey = String(messageId ?? '0');
    const cbKey = data || `${screen}:${action}:${(args || []).join(':')}`;
    const sig = `${cKey}:${uKey}:${mKey}:${cbKey}`;
    const now = Date.now();
    const normAction = String(action || '').toLowerCase().trim();
    const isRepeatable = REPEATABLE_CALLBACK_ACTIONS.has(normAction);

    // Ignore exact identical double-tap within callbackDedupMs (except repeatable incremental controls like seekby)
    if (this.callbackDedupMs > 0 && !isRepeatable) {
      const prevAt = this.recentCallbacks.get(sig) || 0;
      if (now - prevAt < this.callbackDedupMs) {
        if (queryId && api?.answerCallbackQuery) {
          void api.answerCallbackQuery(queryId).catch(() => {});
        }
        return null;
      }
      this.recentCallbacks.set(sig, now);
      if (this.recentCallbacks.size > 2000) {
        const cutoff = now - 15000;
        for (const [k, t] of this.recentCallbacks) {
          if (t < cutoff) this.recentCallbacks.delete(k);
        }
      }
    }

    if (!coalesceOnCard || !messageId || normAction === 'seekby') {
      const ctrl = new AbortController();
      return fn(ctrl.signal);
    }

    // Per-card pipeline: if a render is already running on this messageId,
    // abort its AbortController and supersede any older queued pagination click.
    const cardKey = `${cKey}:${mKey}`;
    let state = this.cardPipelines.get(cardKey);
    if (!state) {
      state = { running: false, activeController: null, nextFn: null, nextResolvers: [] };
      this.cardPipelines.set(cardKey, state);
    }

    if (state.running) {
      state.activeController?.abort();
      for (const r of state.nextResolvers) {
        try { r.resolve(null); } catch {}
      }
      state.nextResolvers = [];
      state.nextFn = fn;
      return new Promise((resolve, reject) => {
        state.nextResolvers.push({ resolve, reject });
      });
    }

    state.running = true;
    try {
      const firstCtrl = new AbortController();
      state.activeController = firstCtrl;
      const firstResult = await fn(firstCtrl.signal);
      while (state.nextFn) {
        const currentFn = state.nextFn;
        const resolvers = state.nextResolvers;
        state.nextFn = null;
        state.nextResolvers = [];
        const nextCtrl = new AbortController();
        state.activeController = nextCtrl;
        try {
          const res = await currentFn(nextCtrl.signal);
          for (const r of resolvers) r.resolve(res);
        } catch (err) {
          for (const r of resolvers) r.reject(err);
        }
      }
      return firstResult;
    } finally {
      state.running = false;
      state.activeController = null;
      if (!state.nextFn) {
        this.cardPipelines.delete(cardKey);
      }
    }
  }

  /**
   * Fair round-robin scheduler across users and group chats.
   */
  schedule({ chatKey = 'global', userKey = 'anon', isGroup = false } = {}, fn) {
    return new Promise((resolve, reject) => {
      let q = this.userQueues.get(userKey);
      if (!q) {
        q = [];
        this.userQueues.set(userKey, q);
      }
      q.push({ chatKey, userKey, isGroup, fn, resolve, reject });
      if (!this.rrUsers.includes(userKey)) {
        this.rrUsers.push(userKey);
      }
      this.#drain();
    });
  }

  #canRunJob(job) {
    if (this.activeGlobal >= this.maxConcurrentGlobal) return false;
    const uActive = this.activeByUser.get(job.userKey) || 0;
    if (uActive >= this.maxConcurrentPerUser) return false;
    if (job.isGroup) {
      const cActive = this.activeByChat.get(job.chatKey) || 0;
      if (cActive >= this.maxConcurrentPerChat) return false;
    }
    return true;
  }

  #drain() {
    if (this.activeGlobal >= this.maxConcurrentGlobal || this.rrUsers.length === 0) return;

    let scanned = 0;
    while (this.activeGlobal < this.maxConcurrentGlobal && scanned < this.rrUsers.length) {
      const userKey = this.rrUsers.shift();
      const q = this.userQueues.get(userKey);
      if (!q || q.length === 0) {
        this.userQueues.delete(userKey);
        continue;
      }

      const idx = q.findIndex((j) => this.#canRunJob(j));
      if (idx === -1) {
        this.rrUsers.push(userKey);
        scanned += 1;
        continue;
      }

      const [job] = q.splice(idx, 1);
      if (q.length > 0) {
        this.rrUsers.push(userKey);
      } else {
        this.userQueues.delete(userKey);
      }
      scanned = 0;

      this.activeGlobal += 1;
      this.activeByUser.set(job.userKey, (this.activeByUser.get(job.userKey) || 0) + 1);
      if (job.isGroup) {
        this.activeByChat.set(job.chatKey, (this.activeByChat.get(job.chatKey) || 0) + 1);
      }

      Promise.resolve()
        .then(() => job.fn())
        .then(job.resolve, job.reject)
        .finally(() => {
          this.activeGlobal = Math.max(0, this.activeGlobal - 1);
          const nextU = (this.activeByUser.get(job.userKey) || 1) - 1;
          if (nextU <= 0) this.activeByUser.delete(job.userKey);
          else this.activeByUser.set(job.userKey, nextU);

          if (job.isGroup) {
            const nextC = (this.activeByChat.get(job.chatKey) || 1) - 1;
            if (nextC <= 0) this.activeByChat.delete(job.chatKey);
            else this.activeByChat.set(job.chatKey, nextC);
          }
          this.#drain();
        });
    }
  }

  async #maybeSendBackpressureNotice({ chatId, userId, isGroup, api, replyToMessageId }) {
    if (!chatId || !api?.sendMessage) return;
    const nKey = `${chatId}:${userId}`;
    const now = Date.now();
    const lastAt = this.noticeHistory.get(nKey) || 0;
    if (now - lastAt < this.noticeCooldownMs) return;
    this.noticeHistory.set(nKey, now);

    const notice = await api.sendMessage(
      chatId,
      '<blockquote>⏳ <b>Processing your queued requests!</b> Your earlier tasks are running now — new ones will start automatically in a moment ♡</blockquote>',
      {
        parse_mode: 'HTML',
        dropOnFloodWait: true,
        ...(isGroup && replyToMessageId ? { reply_to_message_id: replyToMessageId, allow_sending_without_reply: true } : {})
      }
    ).catch(() => null);

    if (notice?.message_id && typeof api.deleteMessage === 'function') {
      setTimeout(() => {
        api.deleteMessage(chatId, notice.message_id).catch(() => {});
      }, 6000)?.unref?.();
    }
  }

  stats() {
    let queued = 0;
    for (const q of this.userQueues.values()) queued += q.length;
    return {
      activeGlobal: this.activeGlobal,
      activeUsers: this.activeByUser.size,
      activeChats: this.activeByChat.size,
      queuedJobs: queued
    };
  }
}
