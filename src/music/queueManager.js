import { audioUpload, audioFileId } from './preview.js';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { logger } from '../core/logger.js';
import { KeyedLock, MusicError, queueEntry } from './model.js';

/** Sole owner of ephemeral destination queues. The bridge exclusively owns account leases. */
export class QueueManager extends EventEmitter {
  constructor({ app, voiceClient, db, log, idleTimeoutMs = Number(process.env.MUSIC_IDLE_SECONDS || 600) * 1000, pollMs = 1000 } = {}) {
    super(); this.app = app; this.voice = voiceClient; this.db = db;
    this.log = log || logger().child({ module: 'music-queue' }); this.sessions = new Map(); this.locks = new KeyedLock(); this.cardLocks = new KeyedLock(); this.closed = false;
    if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) throw new MusicError('INVALID_CONFIGURATION', 'Music idle timeout must be a positive duration.');
    this.idleTimeoutMs = idleTimeoutMs;this.prefetchJobs=0;this.prefetchWork=new Set();this.eventJobs=new Set();this.eventAbort=new AbortController();
    for(const [id,m] of Object.entries(db?.getSetting?.('music.managedMemberships',{})||{})){const state=this.getSession(Number(id));state.prepared=true;state.isChannel=Boolean(m.isChannel);state.accountAlias=m.alias;this.#idle(state);}
    if(pollMs>0&&typeof this.voice?.waitEvent==='function')void this.watchEvents();
    if (pollMs > 0) { this.poller = setInterval(() => this.reconcile().catch(() => this.log.warn('Music reconciliation failed')), pollMs); this.poller.unref?.(); }
  }
  async watchEvents(){
    while(!this.closed){
      try{const result=await this.voice.waitEvent(this.eventAbort.signal);if(this.closed)return;for(const event of result.events||[]){if(event.status!=='ended'||this.eventJobs.size>=16)continue;const job=this.handleStreamEnded(event.chat_id,event.playback_id).catch(()=>{}).finally(()=>this.eventJobs.delete(job));this.eventJobs.add(job);}}
      catch{if(this.closed)return;await new Promise(resolve=>{const timer=setTimeout(resolve,3000);timer.unref?.();});}
    }
  }
  getSession(chatId) {
    const id = Number(chatId);
    if (!Number.isSafeInteger(id) || !id) throw new MusicError('INVALID_DESTINATION', 'Invalid playback destination.');
    if(!this.sessions.has(id)&&this.sessions.size>=1000){const old=[...this.sessions].find(([,s])=>!s.connected&&!s.currentTrack&&!s.upcoming.length&&!s.idleTimeout&&!this.app?.music?.channelPanels?.hasDestination(s.chatId));if(old)this.sessions.delete(old[0]);else throw new MusicError('SESSION_LIMIT','The music destination limit has been reached.');}
    if (!this.sessions.has(id)) this.sessions.set(id, { chatId: id, status: 'idle', currentTrack: null, upcoming: [], history: [], loopMode: 'off', volume: 100, isChannel: false, screenMessageId: null, playerChatId: id, idleTimeout: null, generation: 0, playbackId: null, positionSeconds: null, connected: false, accountAlias: null, preferredAccount: null, lastError: null, view: 'player', page: 0, bass: false, eqPreset: 'off', skipVotes: [] });
    return this.sessions.get(id);
  }
  hasActiveSession(id) { const s = this.sessions.get(Number(id)); return Boolean(s && ['playing','paused','buffering'].includes(s.status)); }
  enqueue(id, track, { top = false } = {}) {
    if (this.closed) throw new MusicError('SHUTTING_DOWN', 'Music is shutting down.');
    const s = this.getSession(id); if (s.upcoming.length >= 100) throw new MusicError('QUEUE_FULL', 'This destination has reached its 100-track queue limit.');
    this.#cancelIdle(s); const entry = queueEntry(track); top ? s.upcoming.unshift(entry) : s.upcoming.push(entry);
    if(s.status==='playing')this.prefetch(s);this.emit('queue_updated', { chatId: s.chatId, session: s }); return { position: top ? 1 : s.upcoming.length, total: s.upcoming.length, track: entry };
  }
  async addMany(id, tracks) {
    const generation=this.getSession(id).stopGeneration||0;
    return this.locks.run(Number(id), async () => {
      const s = this.getSession(id);if((s.stopGeneration||0)!==generation)throw new MusicError('ACTION_CANCELLED','This queue request was cancelled by Stop.');if(s.stopPending)throw new MusicError('DEPARTURE_PENDING','Wait for call/group departure to be confirmed, then run /vc to start again.'); if (s.upcoming.length + tracks.length > 100) throw new MusicError('QUEUE_FULL', 'There is not enough room in the queue for this selection.');
      const result = tracks.map(t => this.enqueue(id, t));
      if (!['playing','paused','buffering'].includes(s.status)) await this.#next(s, { manual: true });
      await this.updatePlayerCard(id); return result;
    });
  }
  async playNext(id) { return this.locks.run(Number(id), () => this.#next(this.getSession(id))); }
  async ensurePlaying(id) { return this.locks.run(Number(id), () => this.hasActiveSession(id) ? this.getSession(id).currentTrack : this.#next(this.getSession(id), { manual: true })); }
  #release(s) { s.media?.release?.(); s.media = null; }
  armPreparedIdle(id) { const s=this.getSession(id);if(!s.currentTrack&&!s.upcoming.length&&s.status==='idle')this.#idle(s); }
  dropPrefetch(s) { const p=s.prefetched;s.prefetched=null;p?.media?.release?.();if(p)p.media=null; }
  prefetch(s) {
    if(this.closed||s.status!=='playing')return;
    if(s.radio?.enabled&&s.upcoming.length<3){
      void this.app?.music?.radio?.refill(s).catch(()=>{}).then(()=>this.prefetch(s));
    }
    const next=s.upcoming[0];
    if(!next||!['youtube','audius','telegram'].includes(next.provider)||!this.app?.musicLibrary||s.status!=='playing')return;
    if(s.prefetched?.entryId===next.entryId)return;
    this.dropPrefetch(s);if(this.prefetchJobs>=5)return;
    const p={entryId:next.entryId,media:null,claimed:false};s.prefetched=p;this.prefetchJobs++;
    const wantsVideo=next.mediaType==='video'||Boolean(s.isChannel);
    p.promise=this.app.musicLibrary.acquire(next,{video:wantsVideo}).then(media=>{
      if(this.closed||s.prefetched!==p||(!p.claimed&&s.upcoming[0]?.entryId!==p.entryId)){media.release();return null;}
      p.media=media;return media;
    }).catch(()=>null).finally(()=>{this.prefetchJobs=Math.max(0,this.prefetchJobs-1);this.prefetchWork.delete(p.promise);});this.prefetchWork.add(p.promise);
  }
  async #next(s, { manual = false } = {}) {
    if(this.closed)return null;
    if(s.stopPending)throw new MusicError('DEPARTURE_PENDING','Wait for call/group departure to be confirmed, then run /vc to start again.');
    this.#cancelIdle(s);s.controlRevision=(s.controlRevision||0)+1;s.lastNotice=null;
    const previous=s.currentTrack,cancel=s.stopGeneration||0;
    if(previous){
      if(!manual&&s.loopMode==='track')s.upcoming.unshift(previous);
      else if(s.loopMode==='queue'&&!s.upcoming.some(t=>t.entryId===previous.entryId))s.upcoming.push(previous);
    }
    if(s.radio?.enabled&&s.upcoming.length<3)await this.app?.music?.radio?.refill(s);
    if(s.radio?.enabled&&!s.upcoming.length)await this.app?.music?.radio?.refill(s);
    if(this.closed||(s.stopGeneration||0)!==cancel)return null;
    const attempts=s.upcoming.length;
    for(let n=0;n<attempts;n++){
      const entry=s.upcoming.shift();let media=null,calledNative=false;
      const warm=s.prefetched?.entryId===entry.entryId?s.prefetched:null;if(warm)warm.claimed=true;
      // Keep the old recording/title truthful during preparation. There is no
      // intentional empty-stream gap before an already prepared replacement.
      if(!previous)s.status='buffering';s.lastNotice=`Preparing ${entry.title}…`;await this.updatePlayerCard(s.chatId);
      try{
        if(entry.queuedMedia){media=entry.queuedMedia;entry.queuedMedia=null;}
        else if(warm){media=warm.media||await this.#awaitMedia(s,()=>warm.promise);if(s.prefetched===warm)s.prefetched=null;warm.media=null;}
        if(this.closed||(s.stopGeneration||0)!==cancel){media?.release();return null;}
        const wantsVideo=entry.mediaType==='video'||Boolean(s.isChannel);
        if(!media&&this.app?.musicLibrary&&['youtube','audius','telegram'].includes(entry.provider)){
          try {
            media=await this.#awaitMedia(s,()=>this.app.musicLibrary.acquire(entry,{video:wantsVideo}));
          } catch(acquireErr) {
            if(this.app?.musicProviders&&entry.provider!=='telegram'){
              const altProvider=entry.provider==='youtube'?'audius':(this.app.musicProviders.get('youtube')?.enabled?'youtube':null);
              if(altProvider&&(!wantsVideo||altProvider==='youtube')){
                const query=`${entry.title} ${entry.artist||''}`.trim();
                const altRes=await this.app.musicProviders.get(altProvider).search(query,{limit:1}).catch(()=>null);
                if(altRes?.items?.[0]){
                  const altTrack={...altRes.items[0],entryId:entry.entryId,requester:entry.requester};
                  media=await this.#awaitMedia(s,()=>this.app.musicLibrary.acquire(altTrack,{video:wantsVideo})).catch(()=>null);
                }
              }
            }
            if(!media)throw acquireErr;
          }
        }
        if(this.closed||(s.stopGeneration||0)!==cancel){media?.release();return null;}
        const track=media?{...media.track,entryId:entry.entryId,requester:entry.requester}:entry;
        if(wantsVideo&&track.capabilities)track.capabilities={...track.capabilities,video:true};
        const source=track.filePath||track.streamUrl||track.audioUrl;if(!source)throw new MusicError('NO_SOURCE','This track has no playable media.');
        const playbackId=randomUUID();calledNative=true;
        const eq=s.eqPreset||(s.bass?'bass':'off');
        const isVideo=track.mediaType==='video'||Boolean(s.isChannel)||Boolean(track.capabilities?.video);
        const r=this.#assert(await this.voice.play(s.chatId,source,{isChannel:s.isChannel,video:isVideo,playbackId,accountAlias:s.preferredAccount,durationSeconds:track.durationSeconds,bass:s.bass||eq==='bass',eq}));
        if(previous){s.history.push(previous);if(s.history.length>25)s.history.shift();}
        this.#release(s);s.media=media;media=null;s.currentTrack=track;s.playbackId=playbackId;s.status='playing';s.connected=true;s.lastError=null;s.lastNotice=null;s.accountAlias=r.account_alias||s.preferredAccount;s.positionSeconds=null;s.failures=0;s.skipVotes=[];
        try{this.#assert(await this.voice.setVolume(s.chatId,s.volume));s.volumeConfirmed=true;}catch{s.volumeConfirmed=false;s.lastError='Playback started, but output volume could not be confirmed.';}
        this.emit('track_start',{chatId:s.chatId,track:s.currentTrack,session:s});
        this.prefetch(s);await this.updatePlayerCard(s.chatId);return s.currentTrack;
      }catch(error){
        if(media&&['POOL_EXHAUSTED','SESSION_NOT_READY','ACCOUNT_UNAVAILABLE','NO_ACTIVE_CALL','PERMISSION_DENIED','BRIDGE_UNAVAILABLE','BRIDGE_INCOMPATIBLE','PUBLISHER_UNVERIFIED','CALL_FAILED','RATE_LIMITED'].includes(error.code)){entry.queuedMedia=media;media=null;}
        media?.release();s.lastError=error instanceof MusicError?error.message:'The call or media source failed. Check account membership and call permissions.';
        this.log.warn({chatId:s.chatId,code:error.code||'PLAY_FAILED',backendKind:/^[A-Za-z0-9_]{1,80}$/.test(error.backendKind||'')?error.backendKind:undefined},'Music track could not start');this.emit('track_error',{chatId:s.chatId,track:entry,code:error.code||'PLAY_FAILED'});s.lastNotice=`Could not start ${entry.title}.`;
        if(['POOL_EXHAUSTED','SESSION_NOT_READY','ACCOUNT_UNAVAILABLE','NO_ACTIVE_CALL','PERMISSION_DENIED','BRIDGE_UNAVAILABLE','BRIDGE_INCOMPATIBLE','PUBLISHER_UNVERIFIED','CALL_FAILED','RATE_LIMITED'].includes(error.code)){
          s.lastNotice+=' Your selection is retained in the queue.';s.upcoming.unshift(entry);if(previous&&calledNative&&!s.upcoming.some(t=>t.entryId===previous.entryId))s.upcoming.unshift(previous);
          if(calledNative){this.#release(s);s.currentTrack=null;s.playbackId=null;s.connected=false;s.status='error';}
          else if(!previous)s.status='error';
          await this.updatePlayerCard(s.chatId);return null;
        }
      }
    }
    if(s.connected&&this.voice.idle){
      try{this.#assert(await this.voice.idle(s.chatId));}
      catch(error){if(error.code!=='NO_ACTIVE_CALL')throw error;s.connected=false;s.accountAlias=null;s.lastError='The voice chat has ended. Use /vc to prepare it again.';}
    }
    if(previous){s.history.push(previous);if(s.history.length>25)s.history.shift();}
    this.dropPrefetch(s);this.#release(s);s.currentTrack=null;s.playbackId=null;s.positionSeconds=null;s.status='idle';
    if(s.connected||s.prepared)this.#idle(s);
    this.emit('queue_empty',{chatId:s.chatId});await this.updatePlayerCard(s.chatId);return null;
  }
  #assert(r) { if (!r?.ok) throw new MusicError(r?.error || 'BRIDGE_FAILURE', r?.message || 'The playback engine did not confirm this operation.'); return r; }
  async pause(id) { return this.locks.run(Number(id), async () => { const s = this.getSession(id); if (s.status !== 'playing') return false; this.#assert(await this.voice.pause(id)); s.status = 'paused'; await this.updatePlayerCard(id); return true; }); }
  async resume(id) {
    return this.locks.run(Number(id), async () => {
      const s = this.getSession(id);
      if (s.status !== 'paused') {
        if ((s.status === 'idle' || s.status === 'error') && (s.currentTrack || s.upcoming.length)) {
          return this.#next(s, { manual: true });
        }
        return false;
      }
      try {
        this.#assert(await this.voice.resume(id));
        this.#cancelIdle(s);
        s.status = 'playing';
        await this.updatePlayerCard(id);
        return true;
      } catch (err) {
        if (['NO_ACTIVE_CALL', 'CALL_FAILED', 'RATE_LIMITED'].includes(err?.code)) {
          return this.#next(s, { manual: true });
        }
        throw err;
      }
    });
  }
  async skip(id) { return this.locks.run(Number(id), () => this.#next(this.getSession(id), { manual: true })); }
  async previous(id) { return this.locks.run(Number(id), async () => { const s = this.getSession(id); const track = s.history.at(-1); if (!track) return null; s.history.pop(); if (s.currentTrack) s.upcoming.unshift(s.currentTrack); s.upcoming=s.upcoming.filter(t=>t.entryId!==track.entryId); s.upcoming.unshift(track); return this.#next(s, { manual: true }); }); }
  async #finishStop(s) {
    this.#assert(await this.voice.stop(s.chatId,{leaveMembership:!s.isChannel}));
    this.#release(s);s.connected=false;s.prepared=false;s.accountAlias=null;s.playbackId=null;s.stopPending=false;s.stopRetryAfter=0;s.lastError=null;
    this.app?.music?.setup?.forget(s.chatId);
  }
  requestStop(id) {const s=this.getSession(id);s.stopGeneration=(s.stopGeneration||0)+1;s.prepareAbort?.abort();if(s.radio)s.radio.enabled=false;}
  async stop(id) {
    this.requestStop(id);
    return this.locks.run(Number(id), async () => {
      const s=this.getSession(id);this.#cancelIdle(s);
      if(s.radio)s.radio.enabled=false;
      this.dropPrefetch(s);for(const t of s.upcoming)t.queuedMedia?.release?.();
      s.upcoming=[];s.currentTrack=null;s.positionSeconds=null;s.status='idle';s.lastNotice=null;s.stopPending=true;
      try { await this.#finishStop(s); }
      catch(error) {s.status='error';s.lastError='Queue cleared, but immediate call/group departure was not confirmed. Cleanup will retry.';s.stopRetryAfter=Date.now()+30000;throw error;}
      finally {await this.updatePlayerCard(id);}
      return true;
    });
  }
  async #awaitMedia(s, load) {
    // Cancel only this destination's wait. Shared/cache work may finish for a
    // sibling chat, but any late result owned by this wait must be released.
    const controller=new AbortController();s.prepareAbort=controller;let onAbort;
    const cancelled=new Promise(resolve=>{onAbort=()=>resolve(null);controller.signal.addEventListener('abort',onAbort,{once:true});});
    const work=Promise.resolve().then(load).then(media=>{if(controller.signal.aborted){media?.release?.();return null;}return media;});
    try{return await Promise.race([work,cancelled]);}
    finally{controller.signal.removeEventListener('abort',onAbort);if(s.prepareAbort===controller)s.prepareAbort=null;}
  }
  async setVolume(id, value) { return this.locks.run(Number(id), async () => { const s = this.getSession(id); const volume = Number(value); if (!Number.isFinite(volume) || volume < 0 || volume > 200) throw new MusicError('INVALID_VOLUME', 'Use a volume between 0 and 200. Levels above 100 may clip.'); if (s.connected) this.#assert(await this.voice.setVolume(id, volume)); s.volume = volume; s.volumeConfirmed=true; await this.updatePlayerCard(id); return volume; }); }
  async seek(id, seconds) { return this.locks.run(Number(id), async () => { const s = this.getSession(id); const value = Number(seconds); if (!s.currentTrack?.capabilities?.seek || !Number.isFinite(value) || value < 0 || value >= s.currentTrack.durationSeconds || !['playing','paused'].includes(s.status)) throw new MusicError('CANNOT_SEEK', 'Choose a position inside the current seekable track.'); const r = this.#assert(await this.voice.seek(id, value)); s.positionSeconds = r.position_seconds ?? null; await this.updatePlayerCard(id); return true; }); }
  toggleLoopMode(id) { const s = this.getSession(id); const modes = ['off','track','queue']; s.loopMode = modes[(modes.indexOf(s.loopMode) + 1) % 3]; return s.loopMode; }
  shuffle(id) { const q = this.getSession(id).upcoming; for (let i=q.length-1; i>0; i--) { const j=Math.floor(Math.random()*(i+1)); [q[i],q[j]]=[q[j],q[i]]; } this.dropPrefetch(this.getSession(id));this.prefetch(this.getSession(id));return q.length; }
  clearQueue(id) { const s = this.getSession(id); const count = s.upcoming.length;for(const t of s.upcoming)t.queuedMedia?.release?.();this.dropPrefetch(s);s.upcoming = [];if(s.radio)s.radio.enabled=false; if (!s.currentTrack && (s.connected||s.prepared)) this.#idle(s); return count; }
  removeTrack(id, entryId) { const s = this.getSession(id); const index = typeof entryId === 'number' ? entryId : s.upcoming.findIndex(t => t.entryId === entryId); if(index<0||index>=s.upcoming.length)return null;const removed=s.upcoming.splice(index,1)[0];removed.queuedMedia?.release?.();if(s.prefetched?.entryId===removed.entryId)this.dropPrefetch(s);this.prefetch(s);return removed; }
  async playNow(id,entryId){return this.locks.run(Number(id),async()=>{const s=this.getSession(id),index=s.upcoming.findIndex(t=>t.entryId===entryId);if(index<0)throw new MusicError('STALE_PLAYER','That queued recording is no longer available.');const [entry]=s.upcoming.splice(index,1);s.upcoming.unshift(entry);if(s.prefetched?.entryId!==entryId)this.dropPrefetch(s);return this.#next(s,{manual:true});});}
  async handleStreamEnded(id, playbackId) {
    return this.locks.run(Number(id), async () => { const s = this.sessions.get(Number(id)); if (!s || !playbackId || playbackId !== s.playbackId || s.status !== 'playing') return false; await this.#next(s); return true; });
  }
  #cancelIdle(s) { s.generation++; clearTimeout(s.idleTimeout); s.idleTimeout = null; }
  #idle(s) {
    this.#cancelIdle(s); const generation = s.generation,armedAt=Date.now(),armedMonotonic=performance.now();s.idleDeadline=armedAt+this.idleTimeoutMs;
    const leave = () => this.locks.run(s.chatId, async () => {
      if (this.closed || s.generation !== generation || s.currentTrack || s.upcoming.length || s.status !== 'idle') return;
      try { const groupLeft=Boolean(s.prepared&&!s.isChannel);this.#assert(await this.voice.stop(s.chatId,{leaveMembership:groupLeft})); s.connected = false;s.prepared=false;this.app?.music?.setup?.forget(s.chatId);this.db?.setSetting?.(`music.idleReceipt.${s.chatId}`,{armedAt,departedAt:Date.now(),elapsedMs:Math.round(performance.now()-armedMonotonic),groupLeft});s.lastNotice=groupLeft?'Ten idle minutes completed; the assistant left the call and group.':'Ten idle minutes completed; the assistant left the call.'; s.accountAlias = null; s.idleTimeout = null; await this.updatePlayerCard(s.chatId); }
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
    await Promise.allSettled([...this.sessions.values()].filter(s => s.connected||s.stopPending).map(s => this.locks.run(s.chatId, async () => {
      if (this.closed) return;
      if(s.stopPending){if(Date.now()<(s.stopRetryAfter||0))return;try{await this.#finishStop(s);s.status='idle';}catch{s.stopRetryAfter=Date.now()+30000;s.lastError='Queue cleared; call/group departure is still awaiting confirmation.';}await this.updatePlayerCard(s.chatId);return;}
      try {
        const r = this.#assert(await this.voice.getStatus(s.chatId));
        if (!r.active) {
          s.connected = false;
          this.#release(s);
          if (s.currentTrack) {
            s.upcoming.unshift(s.currentTrack);
            s.currentTrack = null;
          }
          s.playbackId = null;
          s.status = 'idle';
          s.lastNotice = 'Voice chat ended. Tap ▶ Resume or send a song to start playback.';
          s.lastError = null;
        } else if (r.info?.playback_id === s.playbackId) {
          s.positionSeconds = Number.isFinite(r.info.position_seconds) ? r.info.position_seconds : null;
          if(Number.isFinite(r.info.volume)){s.volume=r.info.volume;s.volumeConfirmed=true;}
          if(r.info.status === 'recovering'){s.lastError='Reconnecting this stream; other destinations are unaffected.';s.positionSeconds=null;}
          if (r.info.status === 'ended' && s.status === 'playing') await this.#next(s);
          else if (r.info.status === 'error' && r.info.publisher_muted) { s.status='error';s.positionSeconds=null;s.lastError='Telegram muted the playback account. Allow it to speak, then stop and retry playback. Your current recording and queue are retained.'; }
          else if (r.info.status === 'error') { s.lastError = 'The stream was interrupted. Advancing to the next queued recording.'; await this.#next(s, { manual: true }); }
        }
        s.failures = 0;
        if(s.status==='playing'&&(!s.prefetched||(s.radio?.enabled&&s.upcoming.length<3))){this.prefetch(s);}
      } catch { s.failures = (s.failures || 0) + 1; s.positionSeconds = null; s.lastError = 'Playback status unavailable; reconnecting to the engine.'; }
      if(Date.now()>=(s.nextCardEdit||0)){s.nextCardEdit=Date.now()+5000;await this.updatePlayerCard(s.chatId);}
    })));
  }
  setPlayerMessage(id, messageId, targetChatId = null, api = null) { const s = this.getSession(id); s.screenMessageId = messageId; s.playerChatId = targetChatId || id; if (api) s.api = api; }
  async updatePlayerCard(id, options = {}) {
    const s=this.getSession(id);
    let updated = false;
    if(s.screenMessageId) {
      updated = (await this.updatePlayerView(s, options)) || updated;
    }
    if(s.isChannel&&this.app?.music?.channelPanels){
      const panelUpdated = await this.app.music.channelPanels.update(id, options);
      updated = panelUpdated || updated;
    }
    return updated;
  }
  async updatePlayerView(s, { preview = null } = {}) {
    return this.cardLocks.run(s.panelToken || s.chatId, async () => {
      const api = s.api || this.app?.telegram?.api;
      if (!s.screenMessageId || !api || Date.now() < (s.editAfter || 0)) return false;
      const screen = this.app?.screens?.get('music'); if (!screen) return false;
      const previews = this.app?.music?.previews;
      if (!preview) previews?.schedule(s);
      if (preview && (!previews?.current(s, preview.request) || s.view !== 'player')) return false;
      const display = preview ? { ...s, fullPreview: { ...s.fullPreview, status: 'ready', fileId: 'attach://music_full_audio', track: preview.media.track } } : s;
      const rich = display.view === 'radio' ? screen.renderRadio(display) : display.view === 'queue' ? screen.renderQueue(display, display.page) : display.view === 'lyrics' ? screen.renderLyrics?.(display) : display.view === 'volume' ? screen.renderVolumePicker(display) : display.view === 'accounts' ? screen.renderAccounts(display) : display.view === 'options' ? screen.renderOptions(display) : screen.renderPlayer(display);
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
        const desc = String(e?.description || e?.message || '');
        if (/message to edit not found|message_id_invalid|chat not found/i.test(desc)) {
          s.screenMessageId = null;
        }
        s.editAfter = Date.now() + Math.max(3, Number(e.retry_after || e.parameters?.retry_after || 5)) * 1000;
        this.log.debug({ chatId: s.chatId }, 'Player edit deferred'); return false;
      }
    });
  }
  async shutdown() {
    this.closed = true;this.eventAbort.abort(); clearInterval(this.poller);for(const s of this.sessions.values())s.prepareAbort?.abort();
    await Promise.allSettled([...this.sessions.values()].map(s => this.locks.run(s.chatId, async () => {
      this.#cancelIdle(s);this.dropPrefetch(s);for(const t of s.upcoming)t.queuedMedia?.release?.();let confirmed=!s.connected&&!s.prepared;
      try{if(s.connected||s.prepared||s.stopPending)this.#assert(await this.voice.stop(s.chatId,{leaveMembership:!s.isChannel}));confirmed=true;if(s.prepared){s.prepared=false;this.app?.music?.setup?.forget(s.chatId);}}
      catch{s.lastError='The service is stopping, but call departure has not been confirmed.';}
      finally{this.#release(s);s.connected=!confirmed;s.currentTrack=null;s.upcoming=[];s.playbackId=null;s.positionSeconds=null;s.status='stopped';s.view='player';if(confirmed){s.accountAlias=null;s.lastError=null;}await this.updatePlayerCard(s.chatId);}
    })));
    await Promise.allSettled([...this.prefetchWork,...this.eventJobs]);
  }
}
