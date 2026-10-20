import { audioUpload, audioFileId } from './preview.js';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { logger } from '../core/logger.js';
import { KeyedLock, MusicError, queueEntry } from './model.js';

/** Sole owner of ephemeral destination queues. The bridge exclusively owns account leases. */
export class QueueManager extends EventEmitter {
  constructor({ app, voiceClient, db, log, idleTimeoutMs = Number(process.env.MUSIC_IDLE_SECONDS || 600) * 1000, pollMs = 10000 } = {}) {
    super(); this.app = app; this.voice = voiceClient; this.db = db;
    this.log = log || logger().child({ module: 'music-queue' }); this.sessions = new Map(); this.locks = new KeyedLock(); this.cardLocks = new KeyedLock(); this.closed = false;
    if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) throw new MusicError('INVALID_CONFIGURATION', 'Music idle timeout must be a positive duration.');
    this.idleTimeoutMs = idleTimeoutMs;
    if (pollMs > 0) { this.poller = setInterval(() => this.reconcile().catch(() => this.log.warn('Music reconciliation failed')), pollMs); this.poller.unref?.(); }
  }
  getSession(chatId) {
    const id = Number(chatId);
    if (!Number.isSafeInteger(id) || !id) throw new MusicError('INVALID_DESTINATION', 'Invalid playback destination.');
    if(!this.sessions.has(id)&&this.sessions.size>=1000){const old=[...this.sessions].find(([,s])=>!s.connected&&!s.currentTrack&&!s.upcoming.length&&!s.idleTimeout);if(old)this.sessions.delete(old[0]);else throw new MusicError('SESSION_LIMIT','The music destination limit has been reached.');}
    if (!this.sessions.has(id)) this.sessions.set(id, { chatId: id, status: 'idle', currentTrack: null, upcoming: [], history: [], loopMode: 'off', volume: 100, isChannel: false, screenMessageId: null, playerChatId: id, idleTimeout: null, generation: 0, playbackId: null, positionSeconds: null, connected: false, accountAlias: null, preferredAccount: null, lastError: null, view: 'player', page: 0, bass: false });
    return this.sessions.get(id);
  }
  hasActiveSession(id) { const s = this.sessions.get(Number(id)); return Boolean(s && ['playing','paused','buffering'].includes(s.status)); }
  enqueue(id, track, { top = false } = {}) {
    if (this.closed) throw new MusicError('SHUTTING_DOWN', 'Music is shutting down.');
    const s = this.getSession(id); if (s.upcoming.length >= 100) throw new MusicError('QUEUE_FULL', 'This destination has reached its 100-track queue limit.');
    this.#cancelIdle(s); const entry = queueEntry(track); top ? s.upcoming.unshift(entry) : s.upcoming.push(entry);
    this.emit('queue_updated', { chatId: s.chatId, session: s }); return { position: top ? 1 : s.upcoming.length, total: s.upcoming.length, track: entry };
  }
  async addMany(id, tracks) {
    return this.locks.run(Number(id), async () => {
      const s = this.getSession(id); if (s.upcoming.length + tracks.length > 100) throw new MusicError('QUEUE_FULL', 'There is not enough room in the queue for this selection.');
      const result = tracks.map(t => this.enqueue(id, t));
      if (!['playing','paused','buffering'].includes(s.status)) await this.#next(s, { manual: true });
      await this.updatePlayerCard(id); return result;
    });
  }
  async playNext(id) { return this.locks.run(Number(id), () => this.#next(this.getSession(id))); }
  async ensurePlaying(id) { return this.locks.run(Number(id), () => this.hasActiveSession(id) ? this.getSession(id).currentTrack : this.#next(this.getSession(id), { manual: true })); }
  #release(s) { s.media?.release?.(); s.media = null; }
  async #next(s, { manual = false } = {}) {
    if (this.closed) return null;
    // Stop the old decoder before resolving the next recording; never show the
    // next title while the previous audio continues during a slow download.
    if(s.currentTrack&&s.connected&&this.voice.idle){
      try{this.#assert(await this.voice.idle(s.chatId));}
      catch(error){
        if(error.code!=='NO_ACTIVE_CALL')throw error;
        this.#cancelIdle(s);this.#release(s);s.upcoming.unshift(s.currentTrack);s.currentTrack=null;s.playbackId=null;s.connected=false;s.accountAlias=null;s.status='error';s.lastError='The voice chat has ended. Start it again, then /addq to retry; your queue is retained.';await this.updatePlayerCard(s.chatId);return null;
      }
    }
    this.#cancelIdle(s); s.lastNotice=null; s.controlRevision=(s.controlRevision||0)+1; const previous = s.currentTrack;
    if (previous) {
      if (!manual && s.loopMode === 'track') s.upcoming.unshift(previous);
      else if (s.loopMode === 'queue') s.upcoming.push(previous);
      s.history.push(previous); if (s.history.length > 25) s.history.shift();
    }
    this.#release(s); s.currentTrack = null; s.positionSeconds = null;
    const attempts = s.upcoming.length;
    for (let n = 0; n < attempts; n++) {
      const entry = s.upcoming.shift(); s.currentTrack = entry; s.playbackId = randomUUID(); s.status = 'buffering'; s.lastError = null;
      await this.updatePlayerCard(s.chatId);
      try {
        if (this.app?.musicLibrary && ['youtube','audius'].includes(entry.provider)) {
          s.media = await this.app.musicLibrary.acquire(entry, { video: entry.mediaType === 'video' });
          s.currentTrack = { ...s.media.track, entryId: entry.entryId, requester: entry.requester };
        }
        if(this.closed)throw new MusicError('SHUTTING_DOWN','Music is shutting down.');
        const track = s.currentTrack; const source = track.filePath || track.streamUrl || track.audioUrl;
        if (!source) throw new MusicError('NO_SOURCE', 'This track has no playable media.');
        const r = await this.voice.play(s.chatId, source, { isChannel: s.isChannel, video: track.mediaType === 'video', playbackId: s.playbackId, accountAlias: s.preferredAccount, durationSeconds: track.durationSeconds, bass: s.bass });
        this.#assert(r); s.status = 'playing'; s.connected = true; s.accountAlias = r.account_alias || s.preferredAccount;
        s.positionSeconds = null; s.failures = 0;
        try { this.#assert(await this.voice.setVolume(s.chatId,s.volume)); s.volumeConfirmed=true; }
        catch { s.volumeConfirmed=false; s.lastError='Playback started, but output volume could not be confirmed.'; }
        this.emit('track_start', { chatId: s.chatId, track: s.currentTrack, session: s }); await this.updatePlayerCard(s.chatId); return s.currentTrack;
      } catch (error) {
        this.#release(s); s.lastError = error instanceof MusicError ? error.message : 'The call or media source failed. Check account membership and an active voice chat.';
        this.log.warn({ chatId: s.chatId, code: error.code || 'PLAY_FAILED' }, 'Music track could not start');
        this.emit('track_error', { chatId: s.chatId, track: entry, code: error.code || 'PLAY_FAILED' });
        s.lastNotice=`Could not play ${entry.title}. ${s.lastError}`;
        if (['POOL_EXHAUSTED','SESSION_NOT_READY','ACCOUNT_UNAVAILABLE','NO_ACTIVE_CALL','PERMISSION_DENIED','BRIDGE_UNAVAILABLE','BRIDGE_INCOMPATIBLE'].includes(error.code)) { s.upcoming.unshift(entry); s.currentTrack = null; s.status = 'error'; await this.updatePlayerCard(s.chatId); return null; }
        s.currentTrack = null;
      }
    }
    s.status = 'idle'; s.currentTrack = null; s.playbackId = null;
    if (s.connected) { if (this.voice.idle) this.#assert(await this.voice.idle(s.chatId)); this.#idle(s); }
    this.emit('queue_empty', { chatId: s.chatId }); await this.updatePlayerCard(s.chatId); return null;
  }
  #assert(r) { if (!r?.ok) throw new MusicError(r?.error || 'BRIDGE_FAILURE', r?.message || 'The playback engine did not confirm this operation.'); return r; }
  async pause(id) { return this.locks.run(Number(id), async () => { const s = this.getSession(id); if (s.status !== 'playing') return false; this.#assert(await this.voice.pause(id)); s.status = 'paused'; await this.updatePlayerCard(id); return true; }); }
  async resume(id) { return this.locks.run(Number(id), async () => { const s = this.getSession(id); if (s.status !== 'paused') return false; this.#assert(await this.voice.resume(id)); this.#cancelIdle(s); s.status = 'playing'; await this.updatePlayerCard(id); return true; }); }
  async skip(id) { return this.locks.run(Number(id), () => this.#next(this.getSession(id), { manual: true })); }
  async previous(id) { return this.locks.run(Number(id), async () => { const s = this.getSession(id); const track = s.history.at(-1); if (!track) return null; if(s.currentTrack&&s.connected&&this.voice.idle)this.#assert(await this.voice.idle(id)); s.history.pop(); if (s.currentTrack) s.upcoming.unshift(s.currentTrack); s.upcoming=s.upcoming.filter(t=>t.entryId!==track.entryId); s.currentTrack = null; s.upcoming.unshift(track); return this.#next(s, { manual: true }); }); }
  async stop(id, { leave = false } = {}) {
    return this.locks.run(Number(id), async () => {
      const s = this.getSession(id); this.#cancelIdle(s);
      if (s.connected) this.#assert(await (leave || !this.voice.idle ? this.voice.stop(id) : this.voice.idle(id)));
      this.#release(s); s.currentTrack = null; s.upcoming = []; s.playbackId = null; s.positionSeconds = null; s.status = 'idle'; s.lastError = null;
      if (leave) { s.connected = false; s.accountAlias = null; } else if (s.connected) this.#idle(s);
      await this.updatePlayerCard(id); return true;
    });
  }
  async setVolume(id, value) { return this.locks.run(Number(id), async () => { const s = this.getSession(id); const volume = Number(value); if (!Number.isFinite(volume) || volume < 0 || volume > 150) throw new MusicError('INVALID_VOLUME', 'Use a volume between 0 and 150. Levels above 100 may clip.'); if (s.connected) this.#assert(await this.voice.setVolume(id, volume)); s.volume = volume; s.volumeConfirmed=true; await this.updatePlayerCard(id); return volume; }); }
  async seek(id, seconds) { return this.locks.run(Number(id), async () => { const s = this.getSession(id); const value = Number(seconds); if (!s.currentTrack?.capabilities?.seek || !Number.isFinite(value) || value < 0 || value >= s.currentTrack.durationSeconds || !['playing','paused'].includes(s.status)) throw new MusicError('CANNOT_SEEK', 'Choose a position inside the current seekable track.'); const r = this.#assert(await this.voice.seek(id, value)); s.positionSeconds = r.position_seconds ?? null; await this.updatePlayerCard(id); return true; }); }
  toggleLoopMode(id) { const s = this.getSession(id); const modes = ['off','track','queue']; s.loopMode = modes[(modes.indexOf(s.loopMode) + 1) % 3]; return s.loopMode; }
  shuffle(id) { const q = this.getSession(id).upcoming; for (let i=q.length-1; i>0; i--) { const j=Math.floor(Math.random()*(i+1)); [q[i],q[j]]=[q[j],q[i]]; } return q.length; }
  clearQueue(id) { const s = this.getSession(id); const count = s.upcoming.length; s.upcoming = []; if (!s.currentTrack && s.connected) this.#idle(s); return count; }
  removeTrack(id, entryId) { const s = this.getSession(id); const index = typeof entryId === 'number' ? entryId : s.upcoming.findIndex(t => t.entryId === entryId); return index >= 0 && index < s.upcoming.length ? s.upcoming.splice(index, 1)[0] : null; }
  async handleStreamEnded(id, playbackId) {
    return this.locks.run(Number(id), async () => { const s = this.sessions.get(Number(id)); if (!s || !playbackId || playbackId !== s.playbackId || s.status !== 'playing') return false; await this.#next(s); return true; });
  }
  #cancelIdle(s) { s.generation++; clearTimeout(s.idleTimeout); s.idleTimeout = null; }
  #idle(s) {
    this.#cancelIdle(s); const generation = s.generation;
    const leave = () => this.locks.run(s.chatId, async () => {
      if (this.closed || s.generation !== generation || s.currentTrack || s.upcoming.length || s.status !== 'idle') return;
      try { this.#assert(await this.voice.stop(s.chatId)); s.connected = false; s.accountAlias = null; s.idleTimeout = null; await this.updatePlayerCard(s.chatId); }
      catch { s.lastError = 'Idle departure failed; retrying shortly.'; s.idleTimeout = setTimeout(() => void leave(), 30000); s.idleTimeout.unref?.(); }
    });
    s.idleTimeout = setTimeout(() => void leave(), this.idleTimeoutMs); s.idleTimeout.unref?.();
  }
  async reconcile() {
    if(this.reconciling)return this.reconciling;
    this.reconciling=this.#reconcile();
    try{return await this.reconciling;}finally{this.reconciling=null;}
  }
  async #reconcile() {
    await Promise.allSettled([...this.sessions.values()].filter(s => s.connected).map(s => this.locks.run(s.chatId, async () => {
      if (this.closed) return;
      try {
        const r = this.#assert(await this.voice.getStatus(s.chatId));
        if (!r.active) {
          s.status = 'error'; s.connected = false; this.#release(s); s.lastError = 'The account disconnected. Queue retained; use /player to inspect and /addq to retry.'; if(s.currentTrack)s.upcoming.unshift(s.currentTrack);s.currentTrack = null; s.playbackId = null;
        } else if (r.info?.playback_id === s.playbackId) {
          s.positionSeconds = Number.isFinite(r.info.position_seconds) ? r.info.position_seconds : null;
          if(Number.isFinite(r.info.volume)){s.volume=r.info.volume;s.volumeConfirmed=true;}
          if(r.info.status === 'recovering'){s.lastError='Reconnecting this stream; other destinations are unaffected.';s.positionSeconds=null;}
          if (r.info.status === 'ended' && s.status === 'playing') await this.#next(s);
          else if (r.info.status === 'error') { s.lastError = 'The stream was interrupted. Advancing to the next queued recording.'; await this.#next(s, { manual: true }); }
        }
        s.failures = 0;
      } catch { s.failures = (s.failures || 0) + 1; s.positionSeconds = null; s.lastError = 'Playback status unavailable; reconnecting to the engine.'; }
      await this.updatePlayerCard(s.chatId);
    })));
  }
  setPlayerMessage(id, messageId, targetChatId = null, api = null) { const s = this.getSession(id); s.screenMessageId = messageId; s.playerChatId = targetChatId || id; if (api) s.api = api; }
  async updatePlayerCard(id, { preview = null } = {}) {
    return this.cardLocks.run(Number(id), async () => {
      const s = this.getSession(id), api = s.api || this.app?.telegram?.api;
      if (!s.screenMessageId || !api || Date.now() < (s.editAfter || 0)) return false;
      const screen = this.app?.screens?.get('music'); if (!screen) return false;
      const previews = this.app?.music?.previews;
      if (!preview) previews?.schedule(s);
      if (preview && (!previews?.current(s, preview.request) || s.view !== 'player')) return false;
      const display = preview ? { ...s, fullPreview: { ...s.fullPreview, status: 'ready', fileId: 'attach://music_full_audio', track: preview.media.track } } : s;
      const rich = display.view === 'queue' ? screen.renderQueue(display, display.page) : display.view === 'lyrics' ? screen.renderLyrics?.(display) : display.view === 'volume' ? screen.renderVolumePicker(display) : display.view === 'accounts' ? screen.renderAccounts(display) : display.view === 'options' ? screen.renderOptions(display) : screen.renderPlayer(display);
      if (!rich) return false;
      const content = JSON.stringify(rich); if (!preview && content === s.lastRender) return true;
      try {
        const files = preview ? await audioUpload(preview.media) : null;
        // A track/control can change while reading the file. Never upload stale audio.
        if (preview && (!previews.current(s, preview.request) || s.view !== 'player')) return false;
        const sent = await api.editMessageRich(s.playerChatId, s.screenMessageId, rich, { dropOnFloodWait: true }, files);
        s.lastRender = content;
        if (preview) {
          const fileId = audioFileId(sent);
          if (!fileId) throw new MusicError('PREVIEW_REFERENCE_UNAVAILABLE', 'Telegram did not return a reusable audio reference. Full preview is unavailable; VC playback is unaffected.');
          previews.remember(api, preview.media.track, fileId);
          if (previews.current(s, preview.request)) {
            s.fullPreview = { ...s.fullPreview, status: 'ready', fileId, track: preview.media.track };
            // Subsequent progress/control edits reuse file_id, never upload again.
            s.lastRender = JSON.stringify(screen.renderPlayer({ ...display, fullPreview: s.fullPreview }));
          }
        }
        return true;
      } catch (e) {
        if (preview) throw e;
        s.editAfter = Date.now() + Math.max(3, Number(e.retry_after || e.parameters?.retry_after || 5)) * 1000;
        this.log.debug({ chatId: id }, 'Player edit deferred'); return false;
      }
    });
  }
  async shutdown() {
    this.closed = true; clearInterval(this.poller);
    await Promise.allSettled([...this.sessions.values()].map(s => this.locks.run(s.chatId, async () => {
      this.#cancelIdle(s);let confirmed=!s.connected;
      try{if(s.connected)this.#assert(await this.voice.stop(s.chatId));confirmed=true;}
      catch{s.lastError='The service is stopping, but call departure has not been confirmed.';}
      finally{this.#release(s);s.connected=!confirmed;s.currentTrack=null;s.upcoming=[];s.playbackId=null;s.positionSeconds=null;s.status='stopped';s.view='player';if(confirmed){s.accountAlias=null;s.lastError=null;}await this.updatePlayerCard(s.chatId);}
    })));
  }
}
