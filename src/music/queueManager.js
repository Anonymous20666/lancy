import { audioUpload, audioFileId } from './preview.js';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { logger } from '../core/logger.js';
import { getCueAt, mapMediaSecToSubMs } from '../media/subtitles.js';
import { resolveAppScreen } from './accounts.js';
import { KeyedLock, MusicError, queueEntry, stripRemotePhotoBlocks, isRemotePhotoError } from './model.js';

/** Sole owner of ephemeral destination queues. The bridge exclusively owns account leases. */
export class QueueManager extends EventEmitter {
  constructor({ app, voiceClient, db, log, idleTimeoutMs = Number(process.env.MUSIC_IDLE_SECONDS || 600) * 1000, pollMs = 1000 } = {}) {
    super(); this.app = app; this.voice = voiceClient; this.db = db || app?.db;
    this.log = log || logger().child({ module: 'music-queue' }); this.sessions = new Map(); this.locks = new KeyedLock(); this.cardLocks = new KeyedLock(); this.closed = false;
    if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) throw new MusicError('INVALID_CONFIGURATION', 'Music idle timeout must be a positive duration.');
    this.idleTimeoutMs = idleTimeoutMs;this.prefetchJobs=0;this.prefetchWork=new Set();this.radioRefillInFlight=new Set();this.eventJobs=new Set();this.eventAbort=new AbortController();
    for(const [id,m] of Object.entries(db?.getSetting?.('music.managedMemberships',{})||{})){const state=this.getSession(Number(id));state.prepared=true;state.isChannel=Boolean(m.isChannel);state.accountAlias=m.alias;this.#idle(state);}
    if(pollMs>0&&typeof this.voice?.waitEvent==='function')void this.watchEvents();
    if (pollMs > 0) { this.poller = setInterval(() => this.reconcile().catch(() => this.log.warn('Music reconciliation failed')), pollMs); this.poller.unref?.(); }
  }
  async watchEvents(){
    while(!this.closed){
      try{const result=await this.voice.waitEvent(this.eventAbort.signal);if(this.closed)return;for(const event of result.events||[]){if(this.eventJobs.size>=16)continue;if(event.status==='ended'){const job=this.handleStreamEnded(event.chat_id,event.playback_id).catch(()=>{}).finally(()=>this.eventJobs.delete(job));this.eventJobs.add(job);}else if(event.status==='call_ended'){const job=this.handleCallEnded(event.chat_id,event.playback_id,event.position_seconds).catch(()=>{}).finally(()=>this.eventJobs.delete(job));this.eventJobs.add(job);}else if(event.type==='vc_message'){const job=this.handleVcMessage(event).catch(()=>{}).finally(()=>this.eventJobs.delete(job));this.eventJobs.add(job);}}}
      catch{if(this.closed)return;await new Promise(resolve=>{const timer=setTimeout(resolve,3000);timer.unref?.();});}
    }
  }
  getDeckStreamMode(id, deck = 'music') {
    const d = deck === 'movie' ? 'movie' : 'music';
    const deckVal = this.db?.getSetting?.(`music.streamMode.${d}.${id}`, null);
    if (deckVal === 'rtmp' || deckVal === 'interactive') return deckVal;
    if (d === 'music') {
      const legacy = this.db?.getSetting?.(`music.streamMode.${id}`, null);
      if (legacy === 'rtmp' || legacy === 'interactive') return legacy;
      return 'interactive';
    }
    return 'rtmp';
  }
  getSession(chatId) {
    const id = Number(chatId);
    if (!Number.isSafeInteger(id) || !id) throw new MusicError('INVALID_DESTINATION', 'Invalid playback destination.');
    if(!this.sessions.has(id)&&this.sessions.size>=1000){const old=[...this.sessions].find(([,s])=>!s.connected&&!s.currentTrack&&!s.upcoming.length&&!(s.movieUpcoming?.length)&&!s.idleTimeout&&!this.app?.music?.channelPanels?.hasDestination(s.chatId));if(old)this.sessions.delete(old[0]);else throw new MusicError('SESSION_LIMIT','The music destination limit has been reached.');}
    if (!this.sessions.has(id)) {
      const savedAiDj = this.db?.getSetting?.(`music.aidj.${id}`, null);
      const savedBass = this.db?.getSetting?.(`music.bass.${id}`, null);
      const savedEq = this.db?.getSetting?.(`music.eq.${id}`, null);
      const savedSubMode = this.db?.getSetting?.(`music.submode.${id}`, null);
      const musicStreamMode = this.getDeckStreamMode(id, 'music');
      const movieStreamMode = this.getDeckStreamMode(id, 'movie');
      const savedSeekStep = Number(this.db?.getSetting?.(`music.seekstep.${id}`, 0) || 0);
      const defaultBass = savedBass !== null && savedBass !== undefined ? Boolean(savedBass) : true;
      const defaultEq = savedEq || (defaultBass ? 'bass' : 'off');
      this.sessions.set(id, {
        chatId: id, status: 'idle', currentTrack: null, upcoming: [], history: [], movieUpcoming: [], movieHistory: [], activeDeck: 'music', loopMode: 'off', volume: 100, isChannel: false,
        screenMessageId: null, playerChatId: id, pinned: false, pinnedMessageId: null, idleTimeout: null, generation: 0, playbackId: null, positionSeconds: null, lastKnownPositionSeconds: 0, positionUpdatedAt: 0, callEnded: false,
        connected: false, accountAlias: null, preferredAccount: null, lastError: null, view: 'player', page: 0, bass: defaultBass, eqPreset: defaultEq,
        streamMode: musicStreamMode,
        userStreamMode: musicStreamMode,
        musicStreamMode,
        movieStreamMode,
        seekStepSeconds: (Number.isFinite(savedSeekStep) && savedSeekStep >= 5 && savedSeekStep <= 600) ? Math.round(savedSeekStep) : null,
        subtitleMode: ['screen', 'live', 'vc', 'off'].includes(savedSubMode) ? savedSubMode : 'screen',
        _vcMsgRateBySender: new Map(), _lastVcMsgAt: 0, _lastVcSubText: '', _lastVcSubSentAt: 0,
        subtitleSyncOffset: 0,
        subtitleAutoOffset: null,
        subtitleAutoVerified: false,
        subtitleSyncStatus: null,
        subtitleDriftRate: 0,
        subtitleDriftAnchor: 0,
        subtitleTrackIndex: 0,
        liveSubCue: '',
        skipVotes: [],
        vcUrl: null,
        callInviteLink: null,
        dlqTarget: null,
        groupInviteLink: null,
        destinationUsername: null,
        botUsername: null,
        botId: 0,
        activePoll: null,
        aiDj: savedAiDj && typeof savedAiDj === 'object'
          ? { enabled: Boolean(savedAiDj.enabled), vibe: savedAiDj.vibe || 'Late Night Studio Mix', introNote: '', seenIds: [], cursor: 0, chatHistory: [] }
          : { enabled: false, vibe: 'Late Night Studio Mix', introNote: '', seenIds: [], cursor: 0, chatHistory: [] }
      });
    }
    return this.sessions.get(id);
  }
  hasActiveSession(id) { const s = this.sessions.get(Number(id)); return Boolean(s && ['playing','paused','buffering'].includes(s.status)); }
  #deckForTrack(track) { return track?.provider === 'movie' ? 'movie' : 'music'; }
  #deckQueue(s, deck) { return deck === 'movie' ? s.movieUpcoming : s.upcoming; }
  #deckHistory(s, deck) { return deck === 'movie' ? s.movieHistory : s.history; }
  enqueue(id, track, { top = false, skipSnapshot = false } = {}) {
    if (track?.provider === 'movie') return this.enqueueMovie(id, track, { top, skipSnapshot });
    if (this.closed) throw new MusicError('SHUTTING_DOWN', 'Music is shutting down.');
    const s = this.getSession(id);
    this.#cancelIdle(s); const entry = queueEntry(track); top ? s.upcoming.unshift(entry) : s.upcoming.push(entry);
    if (!skipSnapshot) {
      if (s.status === 'playing' && s.activeDeck !== 'movie') this.prefetch(s);
      else for (const u of s.upcoming.slice(0, 3)) this.#warmTrack(s, u);
      this.#savePlaybackSnapshot(s);
      this.emit('queue_updated', { chatId: s.chatId, session: s });
    }
    return { position: top ? 1 : s.upcoming.length, total: s.upcoming.length, track: entry };
  }
  enqueueMovie(id, track, { top = false, skipSnapshot = false } = {}) {
    if (this.closed) throw new MusicError('SHUTTING_DOWN', 'Music is shutting down.');
    const s = this.getSession(id);
    this.#cancelIdle(s); const entry = queueEntry({ ...track, provider: 'movie', mediaType: 'video' });
    top ? s.movieUpcoming.unshift(entry) : s.movieUpcoming.push(entry);
    if (!skipSnapshot) {
      this.#savePlaybackSnapshot(s);
      this.emit('queue_updated', { chatId: s.chatId, session: s });
    }
    return { position: top ? 1 : s.movieUpcoming.length, total: s.movieUpcoming.length, track: entry };
  }
  #trackAcquireOptions(s, entry) {
    return {
      video: entry?.mediaType === 'video',
      isChannel: Boolean(s?.isChannel),
      eqPreset: s?.eqPreset || (s?.bass ? 'bass' : 'off'),
      djNote: s?.aiDj?.introNote || ''
    };
  }
  #warmTrack(s, entry) {
    if (this.closed || !entry?.entryId) return null;
    if (entry.filePath && existsSync(entry.filePath)) return null;
    if (!['youtube', 'audius', 'telegram', 'music'].includes(entry.provider)) return null;
    if (typeof this.app?.musicLibrary?.warm !== 'function') return null;
    if (!s.warmedPromises) s.warmedPromises = new Map();
    const existing = s.warmedPromises.get(entry.entryId);
    if (existing) return existing;
    if (!s.warmedIds) s.warmedIds = new Set();
    if (s.warmedIds.has(entry.entryId)) return null;
    s.warmedIds.add(entry.entryId);
    if (s.warmedIds.size > 80) s.warmedIds.delete(s.warmedIds.values().next().value);
    const job = Promise.resolve(this.app.musicLibrary.warm(entry, this.#trackAcquireOptions(s, entry)))
      .catch(() => null)
      .finally(() => { if (s.warmedPromises?.get(entry.entryId) === job) s.warmedPromises.delete(entry.entryId); });
    s.warmedPromises.set(entry.entryId, job);
    return job;
  }
  async addMany(id, tracks) {
    if (Array.isArray(tracks) && tracks.length && tracks.every(t => t?.provider === 'movie')) {
      return this.addMovies(id, tracks);
    }
    const generation=this.getSession(id).stopGeneration||0;
    return this.locks.run(Number(id), async () => {
      const s = this.getSession(id);if((s.stopGeneration||0)!==generation)throw new MusicError('ACTION_CANCELLED','This queue request was cancelled by Stop.');if(s.stopPending)throw new MusicError('DEPARTURE_PENDING','Wait for call/group departure to be confirmed, then run /vc to start again.');
      const result = tracks.map(t => this.enqueue(id, t, { skipSnapshot: true }));
      if (s.status === 'playing' && s.activeDeck !== 'movie') this.prefetch(s);
      else for (const u of s.upcoming.slice(0, 3)) this.#warmTrack(s, u);
      this.#savePlaybackSnapshot(s);
      this.emit('queue_updated', { chatId: s.chatId, session: s });
      if (!['playing','paused','buffering'].includes(s.status)) {
        s.activeDeck = 'music';
        if (s.view === 'cinema' || s.view === 'mqueue') s.view = 'player';
        await this.#next(s, { manual: true, deck: 'music' });
      }
      await this.updatePlayerCard(id); return result;
    });
  }
  async addMovies(id, tracks, { playNow = false } = {}) {
    const list = (Array.isArray(tracks) ? tracks : [tracks]).filter(Boolean);
    if (!list.length) return [];
    if (playNow) this.sessions.get(Number(id))?.prepareAbort?.abort();
    const generation = this.getSession(id).stopGeneration || 0;
    return this.locks.run(Number(id), async () => {
      const s = this.getSession(id);
      if ((s.stopGeneration || 0) !== generation) throw new MusicError('ACTION_CANCELLED', 'This Cinema request was cancelled by Stop.');
      if (s.stopPending) throw new MusicError('DEPARTURE_PENDING', 'Wait for call/group departure to be confirmed, then run /vc to start again.');
      let result;
      if (playNow) {
        result = [];
        for (let i = list.length - 1; i >= 0; i--) {
          result.unshift(this.enqueueMovie(id, list[i], { top: true, skipSnapshot: true }));
        }
      } else {
        result = list.map(t => this.enqueueMovie(id, t, { skipSnapshot: true }));
      }
      this.#savePlaybackSnapshot(s);
      this.emit('queue_updated', { chatId: s.chatId, session: s });
      const hadActive = ['playing', 'paused', 'buffering'].includes(s.status) && Boolean(s.currentTrack);
      if (playNow || !hadActive) {
        s.activeDeck = 'movie';
        s.view = 'cinema';
        const movMode = this.getDeckStreamMode(id, 'movie');
        s.streamMode = movMode;
        s.movieStreamMode = movMode;
        this.dropPrefetch(s);
        await this.#next(s, {
          manual: true,
          targetEntryId: result[0]?.track?.entryId || null,
          preservePreviousToEnd: Boolean(playNow && hadActive),
          deck: 'movie'
        });
      } else {
        await this.updatePlayerCard(id);
      }
      return result;
    });
  }
  async playNext(id) { return this.locks.run(Number(id), () => this.#next(this.getSession(id))); }
  async ensurePlaying(id) { return this.locks.run(Number(id), () => this.hasActiveSession(id) ? this.getSession(id).currentTrack : this.#next(this.getSession(id), { manual: true })); }
  #stopLiveSubTimer(s) {
    if (s?._liveSubTimer) {
      clearInterval(s._liveSubTimer);
      s._liveSubTimer = null;
    }
  }
  #ensureLiveSubTimer(s) {
    if (!s || this.closed) return;
    const activeSub = ['live', 'vc'].includes(s.subtitleMode) && Boolean(s.currentTrack?.subtitlePath) && s.connected;
    if (!activeSub) {
      this.#stopLiveSubTimer(s);
      return;
    }
    if (s._liveSubTimer) return;
    s._liveSubTimer = setInterval(() => {
      if (this.closed || !s.connected || !['live', 'vc'].includes(s.subtitleMode) || !s.currentTrack?.subtitlePath) {
        this.#stopLiveSubTimer(s);
        return;
      }
      this.#emitLiveSubCue(s);
    }, 200);
    s._liveSubTimer.unref?.();
  }
  #emitLiveSubCue(s) {
    if (!s || !['live', 'vc'].includes(s.subtitleMode) || !s.currentTrack?.subtitlePath || !Number.isFinite(s.positionSeconds)) {
      if (s?.liveSubCue) s.liveSubCue = '';
      return;
    }
    const cues = this.app?.subtitles?.loadCues?.(s.currentTrack.subtitlePath);
    if (!cues?.length) return;
    const elapsedSec = (s.status === 'playing' && s.positionUpdatedAt)
      ? Math.max(0, Math.min(2.5, (Date.now() - s.positionUpdatedAt) / 1000))
      : 0;
    // Python reports decoder/playback media clock; when piping through ffmpeg/RTMP, align chat/live cues
    const rtmpDelay = (s.streamMode === 'rtmp' && Number(s.rtmpPipelineDelaySec) > 0)
      ? Math.min(4.0, Number(s.rtmpPipelineDelaySec))
      : 0;
    const effMediaSec = Math.max(0, s.positionSeconds + elapsedSec - rtmpDelay);
    const subPosMs = mapMediaSecToSubMs(effMediaSec, {
      offsetSec: Number(s.subtitleSyncOffset || 0) || 0,
      driftRate: Number(s.subtitleDriftRate || 0) || 0,
      driftAnchorSec: Number(s.subtitleDriftAnchor || 0) || 0
    });
    const cue = getCueAt(cues, subPosMs);
    const nextCueText = cue?.text || '';
    if (nextCueText !== (s.liveSubCue || '')) {
      s.liveSubCue = nextCueText;
      if (nextCueText) {
        this.emit('subtitle_cue', { chatId: s.chatId, cue: nextCueText, positionSeconds: effMediaSec, track: s.currentTrack });
        if (s.subtitleMode === 'vc' && nextCueText !== (s._lastVcSubText || '') && Date.now() - (s._lastVcSubSentAt || 0) >= 1500 && typeof this.voice?.sendCallMessage === 'function') {
          s._lastVcSubText = nextCueText;
          s._lastVcSubSentAt = Date.now();
          void this.voice.sendCallMessage(s.chatId, `💬 ${nextCueText.slice(0, 240)}`).catch(() => {});
        }
        if (Date.now() - (s.lastSubEdit || 0) >= 3500) {
          s.lastSubEdit = Date.now();
          s.nextCardEdit = Math.min(s.nextCardEdit || 0, Date.now());
        }
      }
    }
  }
  #release(s) { this.#stopLiveSubTimer(s); s.media?.release?.(); s.media = null; }
  armPreparedIdle(id) { const s=this.getSession(id);if(!s.currentTrack&&!s.upcoming.length&&!(s.movieUpcoming?.length)&&s.status==='idle')this.#idle(s); }
  dropPrefetch(s) { const p=s.prefetched;s.prefetched=null;p?.media?.release?.();if(p)p.media=null; }
  async ensureInfinityLookahead(s) {
    if (this.closed || !this.app?.musicProviders || this.radioRefillInFlight.has(s.chatId)) return;
    const aiDj = this.app?.music?.aiDj;
    const radioActive = Boolean(s.radio?.enabled);
    const aiDjActive = Boolean(aiDj?.isEnabled?.(s));
    if ((!radioActive && !aiDjActive) || s.upcoming.length >= 3) return;
    this.radioRefillInFlight.add(s.chatId);
    try {
      if (radioActive) {
        await this.app?.music?.radio?.refill(s).catch(() => {});
      }
      if (aiDjActive && s.upcoming.length < 3) {
        await aiDj.curateNextTracks(s, { count: 3 }).catch(() => {});
      }
      if (s.upcoming.length && s.status === 'playing') {
        this.prefetch(s);
      }
    } finally {
      this.radioRefillInFlight.delete(s.chatId);
    }
  }
  prefetch(s) {
    if(this.closed||s.status!=='playing')return;
    const activeDeck=s.activeDeck==='movie'||s.currentTrack?.provider==='movie'?'movie':'music';
    if(activeDeck==='movie')return;
    const aiDjActive=Boolean(this.app?.music?.aiDj?.isEnabled?.(s));
    if((s.radio?.enabled||aiDjActive)&&s.upcoming.length<3&&this.app?.musicLibrary&&!this.radioRefillInFlight.has(s.chatId)){
      void this.ensureInfinityLookahead(s);
    }
    const next=s.upcoming[0];
    if(!next||s.status!=='playing')return;
    for(const u of s.upcoming.slice(1,4))this.#warmTrack(s,u);
    if(next.filePath&&existsSync(next.filePath))return;
    if(!['youtube','audius','telegram','music'].includes(next.provider)||!this.app?.musicLibrary)return;
    const acquireOpts=this.#trackAcquireOptions(s,next);
    if(s.prefetched?.entryId===next.entryId)return;
    this.dropPrefetch(s);if(this.prefetchJobs>=5)return;
    const p={entryId:next.entryId,media:null,claimed:false};s.prefetched=p;this.prefetchJobs++;
    p.promise=this.app.musicLibrary.acquire(next,acquireOpts).then(media=>{
      if(this.closed||s.prefetched!==p||(!p.claimed&&s.upcoming[0]?.entryId!==p.entryId)){media.release();return null;}
      p.media=media;
      void this.updatePlayerCard(s.chatId).catch(()=>{});
      return media;
    }).catch(()=>null).finally(()=>{this.prefetchJobs=Math.max(0,this.prefetchJobs-1);this.prefetchWork.delete(p.promise);});this.prefetchWork.add(p.promise);
  }
  async #next(s, { manual = false, targetEntryId = null, preservePreviousToEnd = false, deck = null } = {}) {
    if(this.closed)return null;
    if(s.stopPending)throw new MusicError('DEPARTURE_PENDING','Wait for call/group departure to be confirmed, then run /vc to start again.');
    this.#cancelIdle(s);s.controlRevision=(s.controlRevision||0)+1;s.lastNotice=null;
    const previous=s.currentTrack,cancel=s.stopGeneration||0;
    const targetDeck=deck||(s.activeDeck==='movie'||previous?.provider==='movie'?'movie':'music');
    s.activeDeck=targetDeck;
    const q=this.#deckQueue(s,targetDeck);
    const hist=this.#deckHistory(s,targetDeck);
    const prevDeck=previous?this.#deckForTrack(previous):targetDeck;
    const sameDeckPrevious=Boolean(previous&&prevDeck===targetDeck);
    const allowAutoRefill=targetDeck==='music';
    const aiDj=allowAutoRefill?this.app?.music?.aiDj:null;
    const aiDjActive=Boolean(allowAutoRefill&&aiDj?.isEnabled?.(s));
    if(previous&&!sameDeckPrevious){
      const prevQ=this.#deckQueue(s,prevDeck);
      if(!prevQ.some(t=>t.entryId===previous.entryId)){
        prevQ.unshift({...previous,resumePositionSeconds:Number.isFinite(s.positionSeconds)?s.positionSeconds:(previous.resumePositionSeconds||0)});
      }
    }else if(previous && !targetEntryId){
      if(!manual&&s.loopMode==='track')q.unshift(previous);
      else if(s.loopMode==='queue'&&!q.some(t=>t.entryId===previous.entryId))q.push(previous);
    }
    if(allowAutoRefill&&(s.radio?.enabled||aiDjActive)&&q.length<3){
      if(q.length<2){
        if(s.radio?.enabled)await this.app?.music?.radio?.refill(s).catch(()=>{});
        if(aiDjActive&&q.length<2)await aiDj.curateNextTracks(s,{count:3}).catch(()=>{});
      }else{
        void this.ensureInfinityLookahead(s);
      }
    }
    if(this.closed||(s.stopGeneration||0)!==cancel)return null;
    let refillTries=0;
    while(q.length||(allowAutoRefill&&(s.radio?.enabled||aiDjActive)&&refillTries<2)){
      if(!q.length&&allowAutoRefill&&(s.radio?.enabled||aiDjActive)&&refillTries<2){
        refillTries++;
        if(s.radio?.enabled)await this.app?.music?.radio?.refill(s).catch(()=>{});
        if(aiDjActive&&!q.length)await aiDj.curateNextTracks(s,{count:3}).catch(()=>{});
        if(!q.length)break;
      }
      const entry=q.shift();let media=null,calledNative=false;
      const warm=s.prefetched?.entryId===entry.entryId?s.prefetched:null;if(warm)warm.claimed=true;
      for(const u of q.slice(0,3))this.#warmTrack(s,u);
      const wantsVideo=entry.mediaType==='video';
      const acquireOpts=this.#trackAcquireOptions(s,entry);
      const warmedJob=s.warmedPromises?.get(entry.entryId)||null;
      const readyNow=Boolean(
        entry.queuedMedia||
        warm?.media||
        (entry.filePath&&existsSync(entry.filePath))||
        (typeof this.app?.musicLibrary?.hasReady==='function'&&['youtube','audius','telegram','music'].includes(entry.provider)&&this.app.musicLibrary.hasReady(entry,acquireOpts))
      );
      // Keep the old recording/title truthful during preparation. Skip the extra
      // "Preparing..." card edit when media is already prefetched/warmed locally.
      if(!previous)s.status='buffering';
      if(!readyNow){s.lastNotice=`⏳ Preparing ${entry.title}…`;await this.updatePlayerCard(s.chatId);}
      try{
        if(entry.queuedMedia){media=entry.queuedMedia;entry.queuedMedia=null;}
        else if(warm){media=warm.media||await this.#awaitMedia(s,()=>warm.promise);if(s.prefetched===warm)s.prefetched=null;warm.media=null;}
        if(!media&&warmedJob){await this.#awaitMedia(s,()=>warmedJob).catch(()=>null);}
        if(this.closed||(s.stopGeneration||0)!==cancel){media?.release();return null;}
        if(!media&&this.app?.musicLibrary&&['youtube','audius','telegram','music'].includes(entry.provider)){
          try {
            media=await this.#awaitMedia(s,()=>this.app.musicLibrary.acquire(entry,acquireOpts));
          } catch(acquireErr) {
            if(this.app?.musicProviders&&entry.provider!=='telegram'){
              const query=`${entry.title} ${entry.artist||''}`.trim();
              try {
                const sameProvider=this.app.musicProviders.get(entry.provider);
                if(sameProvider&&(!sameProvider.assertEnabled||sameProvider.enabled!==false)){
                  const sameRes=await sameProvider.search(query,{limit:3,video:wantsVideo}).catch(()=>null);
                  for(const cand of (sameRes?.items||[]).filter(x=>x.providerId!==entry.providerId).slice(0,2)){
                    if(this.closed||(s.stopGeneration||0)!==cancel)break;
                    const candTrack={...cand,mediaType:wantsVideo?'video':(cand.mediaType||entry.mediaType),entryId:entry.entryId,requester:entry.requester};
                    media=await this.#awaitMedia(s,()=>this.app.musicLibrary.acquire(candTrack,acquireOpts)).catch(()=>null);
                    if(media)break;
                  }
                }
              } catch {}
              if(!media){
                const hasMusicAdapter=Boolean(this.app.musicProviders.adapters?.has?.('music'));
                const ytEnabled=Boolean(this.app.musicProviders.get?.('youtube')?.enabled);
                const altProvider=entry.provider==='youtube'?(hasMusicAdapter?'music':(wantsVideo?null:'audius')):(ytEnabled?'youtube':(hasMusicAdapter&&entry.provider!=='music'?'music':null));
                if(altProvider){
                  const altRes=await this.app.musicProviders.get(altProvider).search(query,{limit:3,video:altProvider==='youtube'?wantsVideo:false}).catch(()=>null);
                  for(const cand of (altRes?.items||[]).slice(0,2)){
                    if(this.closed||(s.stopGeneration||0)!==cancel)break;
                    const altTrack={...cand,mediaType:wantsVideo?'video':(cand.mediaType||entry.mediaType),entryId:entry.entryId,requester:entry.requester};
                    media=await this.#awaitMedia(s,()=>this.app.musicLibrary.acquire(altTrack,acquireOpts)).catch(()=>null);
                    if(media)break;
                  }
                }
              }
            }
            if(!media)throw acquireErr;
          }
        }
        if(this.closed||(s.stopGeneration||0)!==cancel){media?.release();return null;}
        const track=media?{...media.track,entryId:entry.entryId,requester:entry.requester}:entry;
        if(wantsVideo&&track.capabilities)track.capabilities={...track.capabilities,video:true};
        const staleAdultStream = Boolean(
          !track.filePath &&
          track.isAdult &&
          track.pageUrl &&
          (!track.streamUrl || !track.streamResolvedAt || (Date.now() - Number(track.streamResolvedAt) > 90 * 60 * 1000))
        );
        await this.#refreshTrackStream(track, { staleAdultStream });
        const rawSource=track.filePath||track.streamUrl||track.videoUrl||track.audioUrl;if(!rawSource)throw new MusicError('NO_SOURCE','This track has no playable media.');
        if(!track.streamUrl && track.videoUrl && /^https?:\/\//i.test(track.videoUrl)) track.streamUrl = track.videoUrl;
        let source=rawSource;
        let remoteProxy=false;
        const isMovieTrack=targetDeck==='movie' || track?.provider==='movie';
        const deckKey=isMovieTrack ? 'movie' : 'music';
        const streamMode=this.getDeckStreamMode(s.chatId, deckKey);
        s.streamMode=streamMode;
        if(isMovieTrack)s.movieStreamMode=streamMode; else s.musicStreamMode=streamMode;
        const savedQuality = typeof this.getVcQuality === 'function' ? this.getVcQuality(s.chatId, { isMovieTrack, streamMode }) : null;
        const videoQuality = savedQuality || ((isMovieTrack || streamMode==='rtmp') ? 'FHD_1080p' : (process.env.VOICE_VIDEO_QUALITY || 'HD_720p'));
        s.vcQuality = videoQuality;
        if(!track.filePath && track.streamUrl && /^https?:\/\//i.test(track.streamUrl) && typeof this.app?.videoServer?.registerRemoteStream==='function'){
          const isDash = Boolean(track.isDash || track.format === 'dash' || /\.mpd(\?|$)/i.test(track.streamUrl));
          const isHls = !isDash && Boolean(track.isHls || track.format === 'hls' || /\.m3u8(\?|$)/i.test(track.streamUrl));
          const proxied=this.app.videoServer.registerRemoteStream({
            url:track.streamUrl,
            headers:track.streamHeaders||{},
            isHls,
            isDash,
            maxHeight:(isMovieTrack || streamMode==='rtmp') ? 1080 : 720,
            preferredAudioLang: track.preferredAudioLang || null,
            contentType: isDash ? 'application/dash+xml' : isHls ? 'application/vnd.apple.mpegurl' : 'video/mp4'
          });
          if(proxied){source=proxied;remoteProxy=true;}
        }
        const subMode=s.subtitleMode||'screen';
        const subtitlePath=subMode !== 'off' && track.subtitlePath && existsSync(track.subtitlePath)?track.subtitlePath:null;
        const subtitleRenderScreen = subMode === 'screen';
        const subtitleSameRoute=subtitlePath ? this.#isSameRouteSub(track, subtitlePath) : false;
        const subSaved=track.subtitlePath && existsSync(track.subtitlePath) ? this.#readTrackSubState(track, track.subtitlePath) : { offset: 0, manual: false, driftRate: 0, driftAnchor: 0 };
        const subtitleOffset=subSaved.offset;
        const subtitleManualOverride=subSaved.manual;
        const subDriftRate = Number(subSaved.driftRate || 0) || 0;
        const subDriftAnchor = Number(subSaved.driftAnchor || 0) || 0;
        const playbackId=randomUUID();calledNative=true;
        const eq=s.eqPreset||(s.bass?'bass':'off');
        const isVideo=track.mediaType==='video';
        const startSeconds=Math.max(0, Number(entry.startOffsetSeconds ?? entry.resumePositionSeconds ?? 0) || 0);
        const vcTitle=String(track.title||'').trim().slice(0, 64) || undefined;
        const volume=Number.isFinite(Number(s.volume)) ? Number(s.volume) : 100;
        const playOpts={isChannel:s.isChannel,video:isVideo,videoQuality,volume,playbackId,accountAlias:s.preferredAccount,durationSeconds:track.durationSeconds,startSeconds,vcTitle,bass:s.bass||eq==='bass',eq,remoteProxy,subtitlePath,subtitleOffset,subtitleSameRoute,subtitleManualOverride,subtitleRenderScreen,subDriftSecPerSec:subDriftRate,subDriftAnchorSec:subDriftAnchor,streamMode,preferredAudioLang:track.preferredAudioLang||null,rejectDub:Boolean(track.preferredAudioLang)};
        let r;
        try {
          r=this.#assert(await this.voice.play(s.chatId,source,playOpts));
        } catch(playErr) {
          if(['NO_ACTIVE_CALL','CALL_FAILED'].includes(playErr?.code)&&typeof this.voice?.setup==='function'){
            const setupRes=await this.voice.setup(s.chatId,'start',{create:true,account_alias:s.preferredAccount||s.accountAlias||undefined,vc_title:vcTitle,stream_mode:streamMode}).catch(()=>null);
            if(setupRes?.call_invite_link){s.callInviteLink=setupRes.call_invite_link;s.vcUrl=setupRes.call_invite_link;}
            r=this.#assert(await this.voice.play(s.chatId,source,playOpts));
          } else if(playErr?.code==='RATE_LIMITED'&&this.app?.musicProviders?.adapters){
            await new Promise(res=>setTimeout(res,2000));
            r=this.#assert(await this.voice.play(s.chatId,source,playOpts));
          } else {
            throw playErr;
          }
        }
        if(r?.call_invite_link){
          s.callInviteLink=r.call_invite_link;
          s.vcUrl=r.call_invite_link;
        } else if(!s.vcUrl && typeof this.app?.music?.syncSessionIdentity==='function'){
          await this.app.music.syncSessionIdentity(s,null,null).catch(()=>{});
        }
        if(previous&&sameDeckPrevious&&!s.suppressHistoryOnce){const {startOffsetSeconds:_so,resumePositionSeconds:_rp,...histItem}=previous;hist.push(histItem);if(hist.length>25)hist.shift();}
        if(previous&&sameDeckPrevious&&preservePreviousToEnd&&previous.entryId!==entry.entryId&&!q.some(t=>t.entryId===previous.entryId)){
          q.push({...previous,resumePositionSeconds:Number.isFinite(s.positionSeconds)?s.positionSeconds:(previous.resumePositionSeconds||0)});
        }
        s.suppressHistoryOnce=false;
        const trackIdx=Array.isArray(track.subtitleTracks)&&track.subtitlePath?track.subtitleTracks.findIndex(t=>t?.filePath===track.subtitlePath):-1;
        if (r?.audio_language) track.audioLanguage = r.audio_language;
        if (r?.audio_is_dub !== undefined) {
          track.audioIsDub = Boolean(r.audio_is_dub);
          if (track.audioIsDub && track.preferredAudioLang && !track.dubOnlyWarning) {
            track.dubOnlyWarning = '⚠️ Dub Only Available';
          }
        }
        const landedStartPos = (typeof r?.position_seconds === 'number' && Number.isFinite(r.position_seconds) && r.position_seconds >= 0) ? r.position_seconds : (startSeconds > 0 ? startSeconds : 0);
        this.#release(s);s.media=media;media=null;s.currentTrack=track;s.subtitleTrackIndex=trackIdx>=0?trackIdx:0;s.subtitleSyncOffset=subtitleOffset;s.subtitleManualOverride=subtitleManualOverride;s.subtitleAutoOffset=null;s.subtitleAutoVerified=false;s.subtitleSyncStatus=null;s.subtitleDriftRate=subDriftRate;s.subtitleDriftAnchor=subDriftAnchor;s.rtmpPipelineDelaySec=Number(r?.rtmp_pipeline_delay_sec)||0;s.avSync=r?.av_sync||null;s.activeDeck=targetDeck;if(targetDeck==='movie'){if(s.view==='player'||!s.view)s.view='cinema';}else if(s.view==='cinema'||s.view==='mqueue'){s.view='player';}s.playbackId=playbackId;s.status='playing';s.connected=true;s.callEnded=false;s.lastError=null;s.lastNotice=null;s.liveSubCue='';s.accountAlias=r.account_alias||s.preferredAccount;s.positionSeconds=landedStartPos;s.lastKnownPositionSeconds=s.positionSeconds;s.positionUpdatedAt=Date.now();s.failures=0;s.skipVotes=[];
        this.#ensureLiveSubTimer(s);
        this.prefetch(s);
        if(!previous||!s.volumeConfirmed||s.appliedVolume!==s.volume){
          try{this.#assert(await this.voice.setVolume(s.chatId,s.volume));s.volumeConfirmed=true;s.appliedVolume=s.volume;}catch{s.volumeConfirmed=false;s.lastError='Playback started, but output volume could not be confirmed.';}
        }
        this.emit('track_start',{chatId:s.chatId,track:s.currentTrack,session:s});
        this.#savePlaybackSnapshot(s);
        if(targetDeck==='music')this.app?.music?.requestCardLyrics?.(s);
        if(aiDjActive&&aiDj?.generateIntroNote){
          void aiDj.generateIntroNote(s,s.currentTrack,previous).then(()=>this.updatePlayerCard(s.chatId)).catch(()=>{});
        }
        await this.updatePlayerCard(s.chatId);return s.currentTrack;
      }catch(error){
        if(media&&['POOL_EXHAUSTED','SESSION_NOT_READY','ACCOUNT_UNAVAILABLE','NO_ACTIVE_CALL','PERMISSION_DENIED','BRIDGE_UNAVAILABLE','BRIDGE_INCOMPATIBLE','PUBLISHER_UNVERIFIED','CALL_FAILED','RATE_LIMITED'].includes(error.code)){entry.queuedMedia=media;media=null;}
        media?.release();s.lastError=error instanceof MusicError?error.message:'The call or media source failed. Check account membership and call permissions.';
        this.log.warn({chatId:s.chatId,code:error.code||'PLAY_FAILED',backendKind:/^[A-Za-z0-9_]{1,80}$/.test(error.backendKind||'')?error.backendKind:undefined},'Music track could not start');this.emit('track_error',{chatId:s.chatId,track:entry,code:error.code||'PLAY_FAILED'});s.lastNotice=`Could not start ${entry.title}.`;
        const failCount = Number(entry._failoverAttempts || 0);
        if (!Array.isArray(entry._failedStreamUrls)) entry._failedStreamUrls = [];
        if (entry.streamUrl && !entry._failedStreamUrls.includes(entry.streamUrl)) {
          entry._failedStreamUrls.push(entry.streamUrl);
        }
        const retryMovieOnError = Boolean(
          failCount < 3 &&
          (entry?.provider === 'movie' || entry?.isAdult) &&
          ['MEDIA_INVALID', 'NO_SOURCE', 'BRIDGE_FAILURE', 'STREAM_FAILED'].includes(error.code) &&
          await this.#refreshTrackStream(entry, { force: true, excludeUrls: entry._failedStreamUrls })
        );
        if (retryMovieOnError) {
          entry._failoverAttempts = failCount + 1;
          entry._reResolved = entry._failoverAttempts >= 3;
          q.unshift(entry);
          continue;
        }
        const retainMovieError = Boolean((entry?.provider === 'movie' || entry?.isAdult) && error.code === 'MEDIA_INVALID');
        if(retainMovieError || ['POOL_EXHAUSTED','SESSION_NOT_READY','ACCOUNT_UNAVAILABLE','NO_ACTIVE_CALL','PERMISSION_DENIED','BRIDGE_UNAVAILABLE','BRIDGE_INCOMPATIBLE','PUBLISHER_UNVERIFIED','CALL_FAILED','RATE_LIMITED'].includes(error.code)){
          s.lastNotice+=' Your selection is retained in the queue.';q.unshift(entry);if(previous&&sameDeckPrevious&&calledNative&&!q.some(t=>t.entryId===previous.entryId)){const prevSaved=this.#resolveSavedPosition(s,null,previous);q.unshift(prevSaved>0?{...previous,resumePositionSeconds:prevSaved,startOffsetSeconds:prevSaved}:previous);}
          if(calledNative){this.#release(s);s.currentTrack=null;s.playbackId=null;s.connected=false;s.status='error';}
          else if(!previous)s.status='error';
          await this.updatePlayerCard(s.chatId);return null;
        }
        if(targetEntryId&&entry.entryId===targetEntryId&&!calledNative){
          s.lastNotice=`Could not load ${entry.title}. Your selection is retained in the queue.`;
          q.unshift(entry);
          await this.updatePlayerCard(s.chatId);
          return s.currentTrack;
        }
        if(targetDeck==='music'&&s.radio?.seen&&entry?.id){s.radio.seen.push(entry.id);}
      }
    }
    if(s.connected&&this.voice.idle){
      try{this.#assert(await this.voice.idle(s.chatId));}
      catch(error){if(error.code!=='NO_ACTIVE_CALL')throw error;s.connected=false;s.accountAlias=null;s.lastError='The voice chat has ended. Use /vc to prepare it again.';}
    }
    if(previous&&sameDeckPrevious){const {startOffsetSeconds:_so,resumePositionSeconds:_rp,...histItem}=previous;hist.push(histItem);if(hist.length>25)hist.shift();}
    this.dropPrefetch(s);this.#release(s);s.currentTrack=null;s.playbackId=null;s.positionSeconds=null;s.lastKnownPositionSeconds=0;s.callEnded=false;s.status='idle';
    if(s.connected||s.prepared)this.#idle(s);
    this.#clearPlaybackSnapshot(s.chatId);
    this.emit('queue_empty',{chatId:s.chatId});await this.updatePlayerCard(s.chatId);return null;
  }
  #assert(r) { if (!r?.ok) throw new MusicError(r?.error || 'BRIDGE_FAILURE', r?.message || 'The playback engine did not confirm this operation.'); return r; }
  async pause(id) { return this.locks.run(Number(id), async () => { const s = this.getSession(id); if (s.status !== 'playing') return false; this.#assert(await this.voice.pause(id)); s.status = 'paused'; this.#savePlaybackSnapshot(s); await this.updatePlayerCard(id, { forceEdit: true }); return true; }); }
  #resolveSavedPosition(s, reportedPos = null, track = null) {
    const candidates = [
      reportedPos,
      s?.positionSeconds,
      s?.lastKnownPositionSeconds,
      track?.resumePositionSeconds,
      track?.startOffsetSeconds,
      s?.currentTrack?.resumePositionSeconds,
      s?.currentTrack?.startOffsetSeconds,
    ];
    for (const raw of candidates) {
      const num = Number(raw);
      if (Number.isFinite(num) && num > 0) return num;
    }
    return 0;
  }
  #formatSavedClock(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const hrs = Math.floor(total / 3600);
    const mins = Math.floor((total % 3600) / 60);
    const secs = String(total % 60).padStart(2, '0');
    return hrs > 0 ? `${hrs}:${String(mins).padStart(2, '0')}:${secs}` : `${mins}:${secs}`;
  }
  #requeueCurrentForResume(s, reportedPos = null) {
    const savedPos = this.#resolveSavedPosition(s, reportedPos, s.currentTrack);
    const cur = s.currentTrack;
    const deck = cur ? (cur.provider === 'movie' ? 'movie' : 'music') : (s.activeDeck === 'movie' ? 'movie' : 'music');
    s.activeDeck = deck;
    const curQ = this.#deckQueue(s, deck);
    if (cur) {
      const restored = { ...cur, resumePositionSeconds: savedPos, startOffsetSeconds: savedPos };
      const filtered = curQ.filter(t => t.entryId !== restored.entryId);
      filtered.unshift(restored);
      if (deck === 'movie') s.movieUpcoming = filtered;
      else s.upcoming = filtered;
      this.#release(s);
      s.currentTrack = null;
    } else if (curQ[0] && savedPos > 0 && !(Number(curQ[0].resumePositionSeconds || curQ[0].startOffsetSeconds || 0) > 0)) {
      curQ[0] = { ...curQ[0], resumePositionSeconds: savedPos, startOffsetSeconds: savedPos };
    }
    return savedPos;
  }
  #handleCallEndedSession(s, reportedPos = null) {
    const wasActive = Boolean(s.connected || s.currentTrack || ['playing', 'paused', 'buffering'].includes(s.status));
    if (!wasActive && !reportedPos) return false;
    const savedPos = this.#requeueCurrentForResume(s, reportedPos);
    s.connected = false;
    s.playbackId = null;
    s.lastKnownPositionSeconds = savedPos;
    s.positionSeconds = savedPos > 0 ? savedPos : null;
    s.status = 'idle';
    s.liveSubCue = '';
    s.callEnded = true;
    s.lastNotice = savedPos > 0
      ? `Voice chat ended (saved at ${this.#formatSavedClock(savedPos)}). Tap ▶ Resume or send a song to start playback.`
      : 'Voice chat ended. Tap ▶ Resume or send a song to start playback.';
    s.lastError = null;
    s.nextCardEdit = 0;
    this.#savePlaybackSnapshot(s);
    this.emit('playback_stopped', { chatId: s.chatId, reason: 'call_ended', session: s });
    return true;
  }
  async handleCallEnded(id, playbackId = null, reportedPos = null) {
    const changed = await this.locks.run(Number(id), async () => {
      const s = this.sessions.get(Number(id));
      if (!s) return false;
      if (playbackId && s.playbackId && playbackId !== s.playbackId) return false;
      return this.#handleCallEndedSession(s, reportedPos);
    });
    if (changed) await this.updatePlayerCard(id, { forceEdit: true }).catch(() => {});
    return changed;
  }
  async resume(id) {
    return this.locks.run(Number(id), async () => {
      const s = this.getSession(id);
      if (s.status === 'playing' && typeof this.voice?.getStatus === 'function') {
        const st = await this.voice.getStatus(id).catch(() => null);
        if (st && st.active === false) {
          this.#handleCallEndedSession(s, st.last_position_seconds);
        }
      }
      if (s.status !== 'paused') {
        let deck = s.currentTrack?.provider === 'movie' ? 'movie' : (s.activeDeck || 'music');
        let deckQ = this.#deckQueue(s, deck);
        if (!s.currentTrack && !deckQ.length) {
          const altDeck = deck === 'movie' ? 'music' : 'movie';
          if (this.#deckQueue(s, altDeck).length) {
            deck = altDeck;
            deckQ = this.#deckQueue(s, deck);
            s.activeDeck = deck;
          }
        }
        const canRecoverFromHistory = Boolean(
          !s.currentTrack &&
          !deckQ.length &&
          (s.callEnded || s.status === 'error' || (Number(s.lastKnownPositionSeconds) || 0) > 0) &&
          this.#deckHistory(s, deck).length
        );
        if (canRecoverFromHistory) {
          const last = this.#deckHistory(s, deck).at(-1);
          if (last) {
            const resumePos = Number(s.lastKnownPositionSeconds || last.resumePositionSeconds || last.startOffsetSeconds || 0) || 0;
            deckQ.unshift(queueEntry({
              ...last,
              ...(resumePos > 1 ? { resumePositionSeconds: resumePos, startOffsetSeconds: resumePos } : {})
            }));
          }
        }
        if ((s.status === 'idle' || s.status === 'error' || s.status === 'stopped') && (s.currentTrack || deckQ.length)) {
          const resumingMidTrack = Boolean(s.callEnded || s.currentTrack || Number(deckQ[0]?.resumePositionSeconds || deckQ[0]?.startOffsetSeconds || 0) > 0);
          if (s.currentTrack) this.#requeueCurrentForResume(s);
          if (deckQ[0]?.provider === 'movie' && deckQ[0]?._restoredFromSnapshot) {
            await this.#refreshTrackStream(deckQ[0], { force: true });
          }
          s.status = 'idle';
          s.callEnded = false;
          if (resumingMidTrack) s._suppressCinemaAnnounce = true;
          try {
            return await this.#next(s, { manual: true, deck });
          } finally {
            s._suppressCinemaAnnounce = false;
          }
        }
        return false;
      }
      const deck = s.currentTrack?.provider === 'movie' ? 'movie' : (s.activeDeck || 'music');
      const deckQ = this.#deckQueue(s, deck);
      const rebuildPaused = async (forceResolve = false) => {
        this.#requeueCurrentForResume(s);
        if (deckQ[0] && (deckQ[0].provider === 'movie' || deckQ[0].isAdult)) {
          await this.#refreshTrackStream(deckQ[0], { force: Boolean(forceResolve || deckQ[0]._restoredFromSnapshot) });
        }
        s.connected = false;
        s.playbackId = null;
        s.status = 'idle';
        s.callEnded = false;
        s._suppressCinemaAnnounce = true;
        try {
          return await this.#next(s, { manual: true, deck });
        } finally {
          s._suppressCinemaAnnounce = false;
        }
      };
      if (!s.connected && (s.currentTrack || deckQ.length)) {
        return await rebuildPaused(false);
      }
      let voiceAlive = true;
      if (s.connected && typeof this.voice?.getStatus === 'function') {
        const st = await this.voice.getStatus(id).catch(() => null);
        if (st && (!st.active || ['ended', 'error', 'idle'].includes(String(st?.info?.status || '')))) {
          voiceAlive = false;
        }
      }
      try {
        if (!voiceAlive && (s.currentTrack || deckQ.length)) {
          throw new MusicError('NO_ACTIVE_CALL', 'Voice stream ended while paused; rebuilding stream.');
        }
        this.#assert(await this.voice.resume(id));
        this.#cancelIdle(s);
        s.status = 'playing';
        s.callEnded = false;
        this.#savePlaybackSnapshot(s);
        await this.updatePlayerCard(id, { forceEdit: true });
        return true;
      } catch (err) {
        if (['NO_ACTIVE_CALL', 'CALL_FAILED', 'RATE_LIMITED', 'MEDIA_INVALID', 'BRIDGE_FAILURE', 'PUBLISHER_UNVERIFIED', 'SESSION_NOT_READY', 'STREAM_FAILED'].includes(err?.code) && (s.currentTrack || deckQ.length)) {
          return await rebuildPaused(err?.code === 'MEDIA_INVALID' || err?.code === 'BRIDGE_FAILURE');
        }
        throw err;
      }
    });
  }
  async skip(id) { this.sessions.get(Number(id))?.prepareAbort?.abort(); return this.locks.run(Number(id), () => { const s = this.getSession(id); return this.#next(s, { manual: true, deck: s.activeDeck || 'music' }); }); }
  async previous(id) {
    this.sessions.get(Number(id))?.prepareAbort?.abort();
    return this.locks.run(Number(id), async () => {
      const s = this.getSession(id);
      const deck = s.activeDeck === 'movie' || s.currentTrack?.provider === 'movie' ? 'movie' : 'music';
      const hist = this.#deckHistory(s, deck);
      const track = hist.at(-1);
      if (!track) return null;
      hist.pop();
      if (deck === 'movie') {
        if (s.currentTrack?.provider === 'movie') s.movieUpcoming.unshift(s.currentTrack);
        s.movieUpcoming = s.movieUpcoming.filter(t => t.entryId !== track.entryId);
        s.movieUpcoming.unshift(track);
      } else {
        if (s.currentTrack && s.currentTrack.provider !== 'movie') s.upcoming.unshift(s.currentTrack);
        s.upcoming = s.upcoming.filter(t => t.entryId !== track.entryId);
        s.upcoming.unshift(track);
      }
      if (s.prefetched?.entryId !== track.entryId) this.dropPrefetch(s);
      s.suppressHistoryOnce = true;
      return this.#next(s, { manual: true, deck });
    });
  }
  async #finishStop(s) {
    this.#assert(await this.voice.stop(s.chatId,{leaveMembership:!s.isChannel}));
    this.#release(s);s.connected=false;s.prepared=false;s.accountAlias=null;s.playbackId=null;s.stopPending=false;s.stopRetryAfter=0;s.lastError=null;
    this.app?.music?.setup?.forget(s.chatId);
  }
  requestStop(id) {const s=this.getSession(id);s.stopGeneration=(s.stopGeneration||0)+1;s.prepareAbort?.abort();if(s.radio&&s.activeDeck!=='movie')s.radio.enabled=false;}
  async stop(id) {
    this.requestStop(id);
    return this.locks.run(Number(id), async () => {
      const s=this.getSession(id);this.#cancelIdle(s);
      this.#clearPlaybackSnapshot(id);
      this.dropPrefetch(s);
      if (s.activeDeck === 'movie') {
        for(const t of s.movieUpcoming)t.queuedMedia?.release?.();
        s.movieUpcoming=[];
      } else {
        if(s.radio)s.radio.enabled=false;
        for(const t of s.upcoming)t.queuedMedia?.release?.();
        s.upcoming=[];
      }
      s.currentTrack=null;s.positionSeconds=null;s.lastKnownPositionSeconds=0;s.callEnded=false;s.status='idle';s.lastNotice=null;s.liveSubCue='';s.stopPending=true;
      this.emit('playback_stopped', { chatId: s.chatId, reason: 'stop', session: s });
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
  getEstimatedPosition(id) {
    const s = this.getSession(id);
    if (typeof s.positionSeconds === 'number' && Number.isFinite(s.positionSeconds) && s.positionSeconds >= 0) {
      return s.positionSeconds;
    }
    const lastKnown = (typeof s.lastKnownPositionSeconds === 'number' && Number.isFinite(s.lastKnownPositionSeconds) && s.lastKnownPositionSeconds > 0)
      ? s.lastKnownPositionSeconds
      : 0;
    const resumeFallback = Number(s.currentTrack?.resumePositionSeconds || s.currentTrack?.startOffsetSeconds || 0) || 0;
    let base = Math.max(lastKnown, resumeFallback);
    if (base > 0 && s.status === 'playing' && s.positionUpdatedAt > 0) {
      const elapsedSec = Math.floor((Date.now() - s.positionUpdatedAt) / 1000);
      if (elapsedSec >= 1) {
        base += Math.min(15, elapsedSec);
      }
    }
    const dur = Number(s.currentTrack?.durationSeconds || 0);
    if (dur > 0) base = Math.min(base, Math.max(0, dur - 1));
    return Math.max(0, base);
  }
  setSeekStep(id, seconds) {
    const s = this.getSession(id);
    const clean = Math.max(5, Math.min(600, Math.round(Number(seconds) || 30)));
    s.seekStepSeconds = clean;
    this.db?.setSetting?.(`music.seekstep.${id}`, clean);
    return clean;
  }
  async setVolume(id, value, { skipCardUpdate = false } = {}) { return this.locks.run(Number(id), async () => { const s = this.getSession(id); const volume = Number(value); if (!Number.isFinite(volume) || volume < 0 || volume > 200) throw new MusicError('INVALID_VOLUME', 'Use a volume between 0 and 200. Levels above 100 may clip.'); if (s.connected) this.#assert(await this.voice.setVolume(id, volume)); s.volume = volume; s.volumeConfirmed=true; s.appliedVolume=volume; this.#savePlaybackSnapshot(s); if (!skipCardUpdate) await this.updatePlayerCard(id); return volume; }); }
  async seek(id, seconds) { return this.locks.run(Number(id), async () => { const s = this.getSession(id); const value = Number(seconds); const dur = Number(s.currentTrack?.durationSeconds || 0); const seekable = Boolean(s.currentTrack?.capabilities?.seek || s.currentTrack?.provider === 'movie'); if (!seekable || !Number.isFinite(value) || value < 0 || (dur > 0 && value >= dur) || !['playing','paused'].includes(s.status)) throw new MusicError('CANNOT_SEEK', 'Choose a position inside the current seekable track.'); const r = this.#assert(await this.voice.seek(id, value)); const nextPos = (r.position_seconds !== null && r.position_seconds !== undefined && Number.isFinite(Number(r.position_seconds))) ? Number(r.position_seconds) : value; s.positionSeconds = nextPos; s.lastKnownPositionSeconds = nextPos; s.positionUpdatedAt = Date.now(); this.#savePlaybackSnapshot(s); await this.updatePlayerCard(id, { forceEdit: true }); return true; }); }
  toggleLoopMode(id) { const s = this.getSession(id); const modes = ['off','track','queue']; s.loopMode = modes[(modes.indexOf(s.loopMode) + 1) % 3]; this.#savePlaybackSnapshot(s); return s.loopMode; }
  shuffle(id) { const q = this.getSession(id).upcoming; for (let i=q.length-1; i>0; i--) { const j=Math.floor(Math.random()*(i+1)); [q[i],q[j]]=[q[j],q[i]]; } this.dropPrefetch(this.getSession(id));this.prefetch(this.getSession(id));return q.length; }
  clearQueue(id) { const s = this.getSession(id); const count = s.upcoming.length;for(const t of s.upcoming)t.queuedMedia?.release?.();this.dropPrefetch(s);s.upcoming = [];if(s.radio)s.radio.enabled=false; if (!s.currentTrack && (s.connected||s.prepared)) this.#idle(s); return count; }
  clearMovieQueue(id) { const s = this.getSession(id); const count = s.movieUpcoming.length; for (const t of s.movieUpcoming) t.queuedMedia?.release?.(); s.movieUpcoming = []; if (!s.currentTrack && (s.connected || s.prepared)) this.#idle(s); this.emit('movie_queue_cleared', { chatId: s.chatId, session: s }); return count; }
  removeTrack(id, entryId) { const s = this.getSession(id); const index = typeof entryId === 'number' ? entryId : s.upcoming.findIndex(t => t.entryId === entryId); if(index<0||index>=s.upcoming.length)return null;const removed=s.upcoming.splice(index,1)[0];removed.queuedMedia?.release?.();if(s.prefetched?.entryId===removed.entryId)this.dropPrefetch(s);this.prefetch(s);return removed; }
  removeMovieTrack(id, entryId) { const s = this.getSession(id); const index = typeof entryId === 'number' ? entryId : s.movieUpcoming.findIndex(t => t.entryId === entryId); if (index < 0 || index >= s.movieUpcoming.length) return null; const removed = s.movieUpcoming.splice(index, 1)[0]; removed.queuedMedia?.release?.(); return removed; }
  async playNow(id,entryId){this.sessions.get(Number(id))?.prepareAbort?.abort();return this.locks.run(Number(id),async()=>{const s=this.getSession(id),index=s.upcoming.findIndex(t=>t.entryId===entryId);if(index<0)throw new MusicError('STALE_PLAYER','That queued recording is not available.');const [entry]=s.upcoming.splice(index,1);s.upcoming.unshift(entry);if(s.prefetched?.entryId!==entryId)this.dropPrefetch(s);s.activeDeck='music';s.view='player';const hadActive=Boolean(s.currentTrack&&s.currentTrack.entryId!==entryId&&['playing','paused','buffering'].includes(s.status));return this.#next(s,{manual:true,targetEntryId:entryId,preservePreviousToEnd:hadActive,deck:'music'});});}
  async playQueuedMovieNow(id, entryId) {
    this.sessions.get(Number(id))?.prepareAbort?.abort();
    return this.locks.run(Number(id), async () => {
      const s = this.getSession(id);
      const index = s.movieUpcoming.findIndex(t => t.entryId === entryId);
      if (index < 0) throw new MusicError('STALE_PLAYER', 'That queued movie/episode is no longer available.');
      const [entry] = s.movieUpcoming.splice(index, 1);
      s.movieUpcoming.unshift(entry);
      this.dropPrefetch(s);
      s.activeDeck = 'movie';
      s.view = 'cinema';
      const hadActive = Boolean(s.currentTrack && s.currentTrack.entryId !== entryId && ['playing', 'paused', 'buffering'].includes(s.status));
      return this.#next(s, { manual: true, targetEntryId: entryId, preservePreviousToEnd: hadActive, deck: 'movie' });
    });
  }
  promoteMovieTrack(id, entryId) {
    const s = this.getSession(id);
    const index = s.movieUpcoming.findIndex(t => t.entryId === entryId);
    if (index < 0) throw new MusicError('STALE_PLAYER', 'That queued movie/episode is no longer available.');
    const [entry] = s.movieUpcoming.splice(index, 1);
    entry.votes = [];
    s.movieUpcoming.unshift(entry);
    this.emit('queue_updated', { chatId: s.chatId, session: s });
    return entry;
  }

  promoteTrack(id, entryId) {
    const s = this.getSession(id);
    const index = s.upcoming.findIndex(t => t.entryId === entryId);
    if (index < 0) throw new MusicError('STALE_PLAYER', 'That queued track is no longer available.');
    const [entry] = s.upcoming.splice(index, 1);
    entry.votes = [];
    s.upcoming.unshift(entry);
    this.emit('queue_updated', { chatId: s.chatId, session: s });
    return entry;
  }
  async playImmediateAndContinue(id,track){
    if (track?.provider === 'movie') {
      const res = await this.addMovies(id, [track], { playNow: true });
      return { track: res?.[0]?.track || track, replaced: null, interrupted: null };
    }
    this.sessions.get(Number(id))?.prepareAbort?.abort();
    return this.locks.run(Number(id),async()=>{
      const s=this.getSession(id);
      if(s.stopPending)throw new MusicError('DEPARTURE_PENDING','Wait for call/group departure to be confirmed, then run /vc to start again.');
      this.#cancelIdle(s);
      const active=['playing','paused','buffering'].includes(s.status)&&Boolean(s.currentTrack);
      const replaced=active?{...s.currentTrack}:null;
      const incoming=queueEntry(track);
      s.upcoming.unshift(incoming);
      s.activeDeck='music';
      if(s.view==='cinema'||s.view==='mqueue')s.view='player';
      if(s.prefetched?.entryId!==incoming.entryId)this.dropPrefetch(s);
      for(const u of s.upcoming.slice(0,3))this.#warmTrack(s,u);
      const played=await this.#next(s,{manual:true,targetEntryId:incoming.entryId,preservePreviousToEnd:active,deck:'music'});
      return {track:played,replaced,interrupted:replaced};
    });
  }
  async switchDeck(id, targetDeck) {
    const target = targetDeck === 'movie' ? 'movie' : 'music';
    this.sessions.get(Number(id))?.prepareAbort?.abort();
    return this.locks.run(Number(id), async () => {
      const s = this.getSession(id);
      if (s.activeDeck !== target && s.currentTrack) {
        const curDeck = this.#deckForTrack(s.currentTrack);
        const curQ = this.#deckQueue(s, curDeck);
        if (!curQ.some(t => t.entryId === s.currentTrack.entryId)) {
          curQ.unshift({ ...s.currentTrack, resumePositionSeconds: Number.isFinite(s.positionSeconds) ? s.positionSeconds : (s.currentTrack.resumePositionSeconds || 0) });
        }
        try { if (s.connected && this.voice?.idle) await this.voice.idle(id); } catch {}
        this.#release(s);
        this.dropPrefetch(s);
        s.currentTrack = null;
        s.playbackId = null;
        s.positionSeconds = null;
        s.status = 'idle';
        s.liveSubCue = '';
        this.emit('playback_stopped', { chatId: s.chatId, reason: 'deck_switch', session: s });
      }
      s.activeDeck = target;
      s.view = target === 'movie' ? 'cinema' : 'player';
      const prevMode = s.streamMode === 'rtmp' ? 'rtmp' : 'interactive';
      const nextMode = this.getDeckStreamMode(id, target);
      s.streamMode = nextMode;
      const targetQ = this.#deckQueue(s, target);
      if (!s.currentTrack && (s.connected || s.prepared) && prevMode !== nextMode && typeof this.voice?.setup === 'function') {
        const swRes = await this.voice.setup(id, 'start', {
          create: true,
          account_alias: s.preferredAccount || s.accountAlias || undefined,
          stream_mode: nextMode,
          force_switch: true,
        }).catch(() => null);
        if (swRes?.call_invite_link) {
          s.callInviteLink = swRes.call_invite_link;
          s.vcUrl = swRes.call_invite_link;
        }
      }
      if (!s.currentTrack && targetQ.length && (s.connected || s.prepared)) {
        await this.#next(s, { manual: true, deck: target });
      } else {
        await this.updatePlayerCard(id, { forceEdit: true });
      }
      return s;
    });
  }
  #subOffsetKey(track, filePath = null) {
    const tid = String(track?.id || track?.url || '').trim();
    if (!tid) return null;
    const subFile = basename(String(filePath || track?.subtitlePath || ''));
    const raw = subFile ? `${tid}:${subFile}` : tid;
    return `music.suboffset.v2.${createHash('sha1').update(raw).digest('hex').slice(0, 16)}`;
  }
  #readTrackSubState(track, filePath = null) {
    const k = this.#subOffsetKey(track, filePath);
    if (!k) return { offset: 0, manual: false, driftRate: 0, driftAnchor: 0 };
    const raw = this.db?.getSetting?.(k, null);
    if (raw && typeof raw === 'object') {
      const num = Number(raw.offset) || 0;
      const dRate = Number(raw.driftRate) || 0;
      const dAnchor = Number(raw.driftAnchor) || 0;
      return {
        offset: Number.isFinite(num) ? Math.max(-20, Math.min(20, num)) : 0,
        manual: Boolean(raw.manual),
        driftRate: Number.isFinite(dRate) ? Math.max(-0.08, Math.min(0.08, dRate)) : 0,
        driftAnchor: (Number.isFinite(dAnchor) && dAnchor >= 0) ? dAnchor : 0
      };
    }
    const val = Number(raw || 0);
    // Self-heal legacy unflagged extreme DB values saved by prior auto-normalizer bugs
    if (!Number.isFinite(val) || Math.abs(val) > 3.0) {
      return { offset: 0, manual: false, driftRate: 0, driftAnchor: 0 };
    }
    return { offset: Math.max(-20, Math.min(20, val)), manual: false, driftRate: 0, driftAnchor: 0 };
  }
  #readTrackSubOffset(track, filePath = null) {
    return this.#readTrackSubState(track, filePath).offset;
  }
  #saveTrackSubState(track, offset, manual = false, filePath = null, { driftRate = null, driftAnchor = null } = {}) {
    const k = this.#subOffsetKey(track, filePath);
    if (!k) return;
    const prev = this.db?.getSetting?.(k, null);
    const prevRate = (prev && typeof prev === 'object' && Number.isFinite(Number(prev.driftRate))) ? Number(prev.driftRate) : 0;
    const prevAnchor = (prev && typeof prev === 'object' && Number.isFinite(Number(prev.driftAnchor))) ? Number(prev.driftAnchor) : 0;
    const clamped = Math.round(Math.max(-20, Math.min(20, Number(offset) || 0)) * 100) / 100;
    const effRate = (driftRate !== null && driftRate !== undefined && Number.isFinite(Number(driftRate)))
      ? Math.max(-0.08, Math.min(0.08, Number(driftRate)))
      : prevRate;
    const effAnchor = (driftAnchor !== null && driftAnchor !== undefined && Number.isFinite(Number(driftAnchor)) && Number(driftAnchor) >= 0)
      ? Number(driftAnchor)
      : prevAnchor;
    const roundRate = Math.round(effRate * 1000000) / 1000000;
    const roundAnchor = Math.round(effAnchor * 100) / 100;
    const statePayload = {
      offset: clamped,
      manual: Boolean(manual)
    };
    if (roundRate !== 0 || roundAnchor !== 0) {
      statePayload.driftRate = roundRate;
      statePayload.driftAnchor = roundAnchor;
    }
    this.db?.setSetting?.(k, statePayload);
  }
  #isSameRouteSub(track, filePath = null) {
    const target = String(filePath || track?.subtitlePath || '');
    const tracks = Array.isArray(track?.subtitleTracks) ? track.subtitleTracks : [];
    const hit = target ? tracks.find(t => t?.filePath === target) : null;
    if (hit) {
      const baseSame = Boolean(hit.sameRoute || ['embedded', 'subtitle_hint'].includes(hit.source));
      if (!baseSame) return false;
      if (hit.source !== 'embedded' && track?.audioIsDub) return false;
      return true;
    }
    return Boolean(track?.subtitleSameRoute && !track?.audioIsDub);
  }
  async setSubtitleMode(id, mode) {
    return this.locks.run(Number(id), async () => {
      const s = this.getSession(id);
      const valid = ['screen', 'live', 'vc', 'off'].includes(mode) ? mode : 'screen';
      s.subtitleMode = valid;
      s.liveSubCue = '';
      s._lastVcSubText = '';
      this.db?.setSetting?.(`music.submode.${id}`, valid);
      if (valid !== 'off') this.#ensureLiveSubTimer(s);
      else this.#stopLiveSubTimer(s);
      if (s.connected && s.currentTrack?.subtitlePath && typeof this.voice?.setSubtitle === 'function') {
        const subArg = valid !== 'off' ? s.currentTrack.subtitlePath : null;
        const off = Number(s.subtitleSyncOffset || 0) || 0;
        await this.voice.setSubtitle(id, subArg, {
          subtitleOffset: off,
          subtitleSameRoute: this.#isSameRouteSub(s.currentTrack),
          manualOverride: Boolean(s.subtitleManualOverride),
          subtitleRenderScreen: valid === 'screen',
          driftRate: Number(s.subtitleDriftRate || 0) || 0,
          driftAnchor: Number(s.subtitleDriftAnchor || 0) || 0
        }).catch(() => {});
      }
      await this.updatePlayerCard(id);
      return valid;
    });
  }
  async setStreamMode(id, targetMode = null) {
    return this.locks.run(Number(id), async () => {
      const s = this.getSession(id);
      const prev = s.streamMode === 'rtmp' ? 'rtmp' : 'interactive';
      const nextMode = ['rtmp', 'interactive'].includes(targetMode)
        ? targetMode
        : (prev === 'rtmp' ? 'interactive' : 'rtmp');
      s.streamMode = nextMode;
      const curIsMovie = (s.currentTrack?.provider === 'movie' || s.activeDeck === 'movie');
      const deckKey = curIsMovie ? 'movie' : 'music';
      if (curIsMovie) {
        s.movieStreamMode = nextMode;
      } else {
        s.musicStreamMode = nextMode;
        s.userStreamMode = nextMode;
        this.db?.setSetting?.(`music.streamMode.${id}`, nextMode);
      }
      this.db?.setSetting?.(`music.streamMode.${deckKey}.${id}`, nextMode);
      const wasActive = Boolean(s.connected || (s.currentTrack && ['playing', 'paused', 'buffering'].includes(s.status)));
      if (nextMode !== prev && wasActive) {
        const curTrack = s.currentTrack;
        const deck = (curTrack?.provider === 'movie' || s.activeDeck === 'movie') ? 'movie' : 'music';
        const deckQ = this.#deckQueue(s, deck);
        const resumePos = curTrack ? this.#resolveSavedPosition(s, null, curTrack) : 0;
        const wasPaused = s.status === 'paused';
        const vcTitle = String(curTrack?.title || '').trim().slice(0, 64) || undefined;
        if (curTrack) {
          const requeued = resumePos > 1
            ? { ...curTrack, resumePositionSeconds: resumePos, startOffsetSeconds: resumePos }
            : { ...curTrack };
          s.currentTrack = null;
          s.playbackId = null;
          deckQ.unshift(requeued);
        }
        if (typeof this.voice?.setup === 'function') {
          const res = await this.voice.setup(s.chatId, 'start', {
            create: true,
            account_alias: s.preferredAccount || s.accountAlias || undefined,
            stream_mode: nextMode,
            force_switch: true,
            ...(vcTitle ? { vc_title: vcTitle } : {})
          }).catch(() => null);
          if (res?.call_invite_link) {
            s.callInviteLink = res.call_invite_link;
            s.vcUrl = res.call_invite_link;
          }
        }
        s.connected = false;
        s.status = 'idle';
        if (deckQ.length) {
          s._suppressCinemaAnnounce = true;
          try {
            await this.#next(s, { manual: true, deck });
            if (wasPaused && s.status === 'playing' && typeof this.voice?.pause === 'function') {
              await this.voice.pause(s.chatId).catch(() => {});
              s.status = 'paused';
            }
          } finally {
            s._suppressCinemaAnnounce = false;
          }
        }
      }
      s.lastNotice = nextMode === 'rtmp'
        ? '🔒 Switched to RTMP Live Stream (100% locked A/V broadcast).'
        : '🎙 Switched to Interactive VC (WebRTC open-mic mode).';
      this.#savePlaybackSnapshot(s);
      await this.updatePlayerCard(id, { forceEdit: true });
      return nextMode;
    });
  }
  getVcQuality(id, { isMovieTrack = false, streamMode = 'interactive' } = {}) {
    const saved = String(this.db?.getSetting?.(`music.vcQuality.${id}`) || '').trim();
    if (['FHD_1080p', 'HD_720p', 'SD_480p'].includes(saved)) return saved;
    return (isMovieTrack || streamMode === 'rtmp') ? 'FHD_1080p' : (process.env.VOICE_VIDEO_QUALITY || 'HD_720p');
  }
  async setVcQuality(id, targetQuality = null) {
    return this.locks.run(Number(id), async () => {
      const s = this.getSession(id);
      const isMovieTrack = (s.currentTrack?.provider === 'movie' || s.activeDeck === 'movie');
      const cur = s.vcQuality || this.getVcQuality(id, { isMovieTrack, streamMode: s.streamMode || 'interactive' });
      const cycle = ['FHD_1080p', 'HD_720p', 'SD_480p'];
      const nextQ = cycle.includes(targetQuality)
        ? targetQuality
        : cycle[(cycle.indexOf(cur) + 1) % cycle.length];
      s.vcQuality = nextQ;
      this.db?.setSetting?.(`music.vcQuality.${id}`, nextQ);
      const labels = {
        FHD_1080p: '1080p HD (Sharp)',
        HD_720p: '720p Smooth (Anti-Lag)',
        SD_480p: '480p Data Saver (Fastest)'
      };
      const wasActive = Boolean(s.connected && s.currentTrack && ['playing', 'paused', 'buffering'].includes(s.status) && s.currentTrack.mediaType === 'video');
      if (nextQ !== cur && wasActive) {
        const curTrack = s.currentTrack;
        const deck = (curTrack?.provider === 'movie' || s.activeDeck === 'movie') ? 'movie' : 'music';
        const deckQ = this.#deckQueue(s, deck);
        const resumePos = this.#resolveSavedPosition(s, null, curTrack);
        const wasPaused = s.status === 'paused';
        const requeued = resumePos > 1
          ? { ...curTrack, resumePositionSeconds: resumePos, startOffsetSeconds: resumePos }
          : { ...curTrack };
        s.currentTrack = null;
        s.playbackId = null;
        deckQ.unshift(requeued);
        s.status = 'idle';
        s._suppressCinemaAnnounce = true;
        try {
          await this.#next(s, { manual: true, deck });
          if (wasPaused && s.status === 'playing' && typeof this.voice?.pause === 'function') {
            await this.voice.pause(s.chatId).catch(() => {});
            s.status = 'paused';
          }
        } finally {
          s._suppressCinemaAnnounce = false;
        }
      }
      s.lastNotice = `🎞 Stream Quality: ${labels[nextQ] || nextQ}`;
      this.#savePlaybackSnapshot(s);
      await this.updatePlayerCard(id, { forceEdit: true });
      return nextQ;
    });
  }
  #buildTrackSourcePool(track) {
    if (!track) return [];
    const seen = new Set();
    const pool = [];
    const pushSource = (cand) => {
      const u = String(cand?.url || '').trim();
      if (!u || seen.has(u)) return;
      seen.add(u);
      pool.push({
        url: u,
        headers: cand.headers || track.headers || undefined,
        mediaType: cand.mediaType || track.mediaType || 'video',
        audioLanguage: cand.audioLanguage ?? track.audioLanguage ?? null,
        audioIsDub: Boolean(cand.audioIsDub),
        subtitlesLabel: cand.subtitlesLabel ?? track.subtitlesLabel ?? null,
        label: `Source ${pool.length + 1}`
      });
    };
    if (Array.isArray(track._sourcePool) && track._sourcePool.length) {
      for (const p of track._sourcePool) pushSource(p);
    } else {
      if (track.streamUrl) {
        pushSource({
          url: track.streamUrl,
          headers: track.headers,
          mediaType: track.mediaType || 'video',
          audioLanguage: track.audioLanguage,
          audioIsDub: track.audioIsDub,
          subtitlesLabel: track.subtitlesLabel
        });
      }
      if (Array.isArray(track.fallbackStreams)) {
        for (const fb of track.fallbackStreams) pushSource(fb);
      }
    }
    if (track.streamUrl && !seen.has(track.streamUrl)) {
      pushSource({
        url: track.streamUrl,
        headers: track.headers,
        mediaType: track.mediaType || 'video',
        audioLanguage: track.audioLanguage,
        audioIsDub: track.audioIsDub,
        subtitlesLabel: track.subtitlesLabel
      });
    }
    track._sourcePool = pool;
    track.sourceCount = pool.length;
    return pool;
  }
  async switchMovieSource(id, targetIndex = null) {
    return this.locks.run(Number(id), async () => {
      const s = this.getSession(id);
      const curTrack = s.currentTrack;
      if (!curTrack || (curTrack.provider !== 'movie' && s.activeDeck !== 'movie')) {
        return { ok: false, reason: 'no_movie_playing' };
      }
      const pool = this.#buildTrackSourcePool(curTrack);
      const curUrl = curTrack.streamUrl || '';
      let curIdx = pool.findIndex((p) => p.url === curUrl);
      if (curIdx < 0) curIdx = 0;

      let nextIdx = -1;
      if (Number.isInteger(targetIndex) && pool.length > 0) {
        nextIdx = ((targetIndex % pool.length) + pool.length) % pool.length;
      } else if (pool.length > 1) {
        nextIdx = (curIdx + 1) % pool.length;
      }

      if ((pool.length <= 1 || nextIdx === curIdx) && !curTrack.xvItem && typeof this.app?.movieResolver?.resolve === 'function') {
        const blocked = [
          ...pool.map((p) => p.url),
          ...(Array.isArray(curTrack._failedStreamUrls) ? curTrack._failedStreamUrls : [])
        ].filter(Boolean);
        const fresh = await this.app.movieResolver.resolve(curTrack, {
          allowAdultFeatures: Boolean(curTrack.isAdult),
          fetchSubtitles: false,
          excludeUrls: blocked
        }).catch(() => null);
        if (fresh?.ok && fresh.track?.streamUrl && !pool.some((p) => p.url === fresh.track.streamUrl)) {
          const mergeCand = (cand) => {
            const u = String(cand?.url || '').trim();
            if (!u || pool.some((p) => p.url === u)) return;
            pool.push({
              url: u,
              headers: cand.headers || undefined,
              mediaType: cand.mediaType || curTrack.mediaType || 'video',
              audioLanguage: cand.audioLanguage ?? null,
              audioIsDub: Boolean(cand.audioIsDub),
              subtitlesLabel: cand.subtitlesLabel ?? null,
              label: `Source ${pool.length + 1}`
            });
          };
          nextIdx = pool.length;
          mergeCand({
            url: fresh.track.streamUrl,
            headers: fresh.track.headers,
            mediaType: fresh.track.mediaType,
            audioLanguage: fresh.track.audioLanguage,
            audioIsDub: fresh.track.audioIsDub,
            subtitlesLabel: fresh.track.subtitlesLabel
          });
          if (Array.isArray(fresh.track.fallbackStreams)) {
            for (const fb of fresh.track.fallbackStreams) mergeCand(fb);
          }
        }
      }

      if (nextIdx < 0 || nextIdx >= pool.length || !pool[nextIdx]?.url || pool[nextIdx].url === curUrl) {
        s.lastNotice = '⚠️ No alternate source available — keeping current stream.';
        await this.updatePlayerCard(id, { forceEdit: true });
        return { ok: false, reason: 'no_alt_source', sourceIndex: curIdx, sourceCount: pool.length };
      }

      const picked = pool[nextIdx];
      curTrack.streamUrl = picked.url;
      curTrack.headers = picked.headers;
      curTrack.mediaType = picked.mediaType || curTrack.mediaType || 'video';
      if (picked.audioLanguage !== undefined && picked.audioLanguage !== null) {
        curTrack.audioLanguage = picked.audioLanguage;
      }
      curTrack.audioIsDub = Boolean(picked.audioIsDub);
      if (picked.subtitlesLabel !== undefined) curTrack.subtitlesLabel = picked.subtitlesLabel;
      curTrack._sourcePool = pool;
      curTrack.activeSourceIndex = nextIdx;
      curTrack.sourceCount = pool.length;
      curTrack.sourceLabel = `Source ${nextIdx + 1}`;
      curTrack.fallbackStreams = pool.filter((p) => p.url && p.url !== picked.url);

      const wasActive = Boolean(s.connected && ['playing', 'paused', 'buffering'].includes(s.status));
      if (wasActive) {
        const deck = 'movie';
        const deckQ = this.#deckQueue(s, deck);
        const resumePos = this.#resolveSavedPosition(s, null, curTrack);
        const wasPaused = s.status === 'paused';
        const requeued = resumePos > 1
          ? { ...curTrack, resumePositionSeconds: resumePos, startOffsetSeconds: resumePos }
          : { ...curTrack };
        s.currentTrack = null;
        s.playbackId = null;
        deckQ.unshift(requeued);
        s.status = 'idle';
        s._suppressCinemaAnnounce = true;
        try {
          await this.#next(s, { manual: true, deck });
          if (wasPaused && s.status === 'playing' && typeof this.voice?.pause === 'function') {
            await this.voice.pause(s.chatId).catch(() => {});
            s.status = 'paused';
          }
        } finally {
          s._suppressCinemaAnnounce = false;
        }
      }
      s.lastNotice = `📡 Switched to Source ${nextIdx + 1}/${pool.length}`;
      this.#savePlaybackSnapshot(s);
      await this.updatePlayerCard(id, { forceEdit: true });
      return { ok: true, sourceIndex: nextIdx, sourceCount: pool.length, sourceLabel: curTrack.sourceLabel };
    });
  }
  async #refreshTrackStream(track, { force = false, staleAdultStream = false, staleMovieStream = false, excludeUrls = [] } = {}) {
    if (!track || track.filePath) return false;
    const blocked = new Set([
      ...(Array.isArray(excludeUrls) ? excludeUrls : []),
      ...(Array.isArray(track._failedStreamUrls) ? track._failedStreamUrls : [])
    ].filter(Boolean));
    if (force && track.streamUrl) blocked.add(track.streamUrl);

    if (force && Array.isArray(track.fallbackStreams) && track.fallbackStreams.length) {
      const nextFallback = track.fallbackStreams.find((cand) => cand?.url && !blocked.has(cand.url));
      if (nextFallback) {
        track.streamUrl = nextFallback.url;
        track.videoUrl = nextFallback.url;
        track.format = nextFallback.format || (nextFallback.isDash ? 'dash' : nextFallback.isHls ? 'hls' : 'mp4');
        track.isHls = Boolean(nextFallback.isHls);
        track.isDash = Boolean(nextFallback.isDash);
        if (nextFallback.headers) {
          track.streamHeaders = { ...(track.streamHeaders || {}), ...nextFallback.headers };
        }
        if (nextFallback.referer) track.referer = nextFallback.referer;
        if (nextFallback.label) track.sourceLabel = nextFallback.label;
        track.streamResolvedAt = Date.now();
        delete track._restoredFromSnapshot;
        return true;
      }
    }

    const resolvedAt = Number(track.streamResolvedAt || track.resolvedAt || 0);
    const ageMs = resolvedAt ? (Date.now() - resolvedAt) : 0;
    const isProxyLocal = /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/i.test(String(track.streamUrl || ''));
    const needAdult = Boolean(
      track.isAdult &&
      typeof this.app?.adultCatalog?.resolveStream === 'function' &&
      (force || staleAdultStream || !track.streamUrl || (track.pageUrl && (!resolvedAt || ageMs > 90 * 60 * 1000)))
    );
    if (needAdult) {
      const resolvedAdult = await this.app.adultCatalog.resolveStream(track).catch(() => null);
      if (resolvedAdult?.streamUrl && !blocked.has(resolvedAdult.streamUrl)) {
        track.streamUrl = resolvedAdult.streamUrl;
        track.videoUrl = resolvedAdult.streamUrl;
        track.isHls = Boolean(resolvedAdult.isHls);
        track.isDash = Boolean(resolvedAdult.isDash);
        track.streamHeaders = { ...(track.streamHeaders || {}), ...(resolvedAdult.headers || {}) };
        track.streamResolvedAt = Date.now();
        if (resolvedAdult.durationSeconds && !track.durationSeconds) track.durationSeconds = resolvedAdult.durationSeconds;
        delete track._restoredFromSnapshot;
        return true;
      }
      return false;
    }
    const needMovie = Boolean(
      !track.isAdult &&
      track.provider === 'movie' &&
      typeof this.app?.movieResolver?.resolve === 'function' &&
      (force || staleMovieStream || !track.streamUrl || (resolvedAt && ageMs > 45 * 60 * 1000) || (track._restoredFromSnapshot && !isProxyLocal))
    );
    if (needMovie) {
      try {
        const freshRes = await this.app.movieResolver.resolve(track, {
          allowAdultFeatures: Boolean(track.isAdult),
          fetchSubtitles: !track.isAdult && !track.subtitlePath,
          excludeUrls: [...blocked]
        });
        if (freshRes?.ok && freshRes.track?.streamUrl) {
          track.streamUrl = freshRes.track.streamUrl;
          track.videoUrl = freshRes.track.videoUrl || freshRes.track.streamUrl;
          track.format = freshRes.track.format || track.format;
          track.isHls = Boolean(freshRes.track.isHls ?? track.isHls);
          track.isDash = Boolean(freshRes.track.isDash ?? track.isDash);
          if (Array.isArray(freshRes.track.fallbackStreams) && freshRes.track.fallbackStreams.length) {
            track.fallbackStreams = freshRes.track.fallbackStreams;
          }
          if (freshRes.track.streamHeaders || freshRes.track.headers) {
            track.streamHeaders = { ...(track.streamHeaders || {}), ...(freshRes.track.streamHeaders || freshRes.track.headers || {}) };
          }
          if (freshRes.track.referer) track.referer = freshRes.track.referer;
          if (!track.subtitlePath && freshRes.track.subtitlePath) {
            track.subtitlePath = freshRes.track.subtitlePath;
            if (freshRes.track.subtitleLabel) track.subtitleLabel = freshRes.track.subtitleLabel;
            if (Array.isArray(freshRes.track.subtitleTracks) && freshRes.track.subtitleTracks.length) {
              track.subtitleTracks = freshRes.track.subtitleTracks;
            }
          }
          if (freshRes.track.durationSeconds && !track.durationSeconds) track.durationSeconds = freshRes.track.durationSeconds;
          track.streamResolvedAt = Date.now();
          delete track._restoredFromSnapshot;
          return true;
        }
      } catch {}
    }
    return false;
  }
  async sendVcChatMessage(id, text) {
    const clean = String(text || '').trim().slice(0, 500);
    if (!clean) return { ok: false, reason: 'empty' };
    const s = this.getSession(id);
    if (!s?.connected && !s?.currentTrack) return { ok: false, reason: 'not_connected' };
    if (typeof this.voice?.sendCallMessage !== 'function') return { ok: false, reason: 'unsupported' };
    const res = await this.voice.sendCallMessage(Number(id), clean).catch(() => ({ ok: false }));
    if (res?.ok) {
      s.lastNotice = `💬 Sent to VC chat: ${clean.slice(0, 80)}`;
    }
    return res || { ok: false };
  }
  async handleVcMessage(event) {
    const chatId = Number(event?.chat_id);
    if (!Number.isFinite(chatId) || chatId >= 0) return;
    const s = this.sessions.get(chatId);
    if (!s || (!s.connected && !s.currentTrack)) return;
    const text = String(event?.text || '').trim();
    if (!text) return;
    this.emit('vc_message', event);
    const now = Date.now();
    const senderKey = event?.sender_id ? String(event.sender_id) : String(event?.sender_name || 'anon');
    if (!(s._vcMsgRateBySender instanceof Map)) s._vcMsgRateBySender = new Map();
    const lastFromSender = s._vcMsgRateBySender.get(senderKey) || 0;
    const minSenderGap = event?.from_admin ? 1200 : 4000;
    if (now - lastFromSender < minSenderGap || now - (s._lastVcMsgAt || 0) < 1000) return;
    const reply = async msg => {
      if (typeof this.voice?.sendCallMessage !== 'function') return;
      s._vcMsgRateBySender.set(senderKey, Date.now());
      if (s._vcMsgRateBySender.size > 128) s._vcMsgRateBySender.clear();
      s._lastVcMsgAt = Date.now();
      await this.voice.sendCallMessage(chatId, String(msg).slice(0, 420)).catch(() => {});
    };
    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const fmtSec = sec => {
      const n = Math.max(0, Math.floor(Number(sec) || 0));
      const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), s2 = n % 60;
      return h ? `${h}:${String(m).padStart(2, '0')}:${String(s2).padStart(2, '0')}` : `${m}:${String(s2).padStart(2, '0')}`;
    };
    if (cmd === '!np' || cmd === '!now') {
      const t = s.currentTrack;
      if (!t) return reply('⚪ Nothing is currently playing in Voice Chat.');
      const posStr = fmtSec(s.positionSeconds || 0);
      const durStr = t.durationSeconds ? ` / ${fmtSec(t.durationSeconds)}` : '';
      const eng = s.streamMode === 'rtmp' ? 'RTMP Live' : 'Interactive VC';
      return reply(`▶ ${t.title} [${posStr}${durStr}] · ${eng}`);
    }
    if (cmd === '!queue' || cmd === '!q') {
      const q = this.#deckQueue(s, s.activeDeck || 'music');
      if (!q?.length) return reply('🗳 Queue is currently empty.');
      const lines = q.slice(0, 3).map((item, idx) => `${idx + 1}. ${item.title}`);
      return reply(`🗳 Up Next (${q.length}):\n${lines.join('\n')}`);
    }
    if (cmd === '!skip') {
      if (!s.currentTrack) return;
      const needed = this.app?.music?.getSkipVoteThreshold?.(chatId) ?? 2;
      const voter = event?.sender_id ? Number(event.sender_id) : senderKey;
      const votes = new Set(Array.isArray(s.skipVotes) ? s.skipVotes : []);
      if (votes.has(voter)) return reply(`⏭ You already voted (${votes.size}/${needed}).`);
      votes.add(voter);
      s.skipVotes = [...votes];
      if (s.skipVotes.length >= needed) {
        s.skipVotes = [];
        await reply(`⏭ Skip vote passed (${needed}/${needed}) — skipping!`);
        await this.skip(chatId).catch(() => {});
      } else {
        await reply(`⏭ Skip vote: ${s.skipVotes.length}/${needed}`);
      }
      return;
    }
    if (event?.from_admin && cmd === '!pause' && s.status === 'playing') {
      await this.pause(chatId).catch(() => {});
      return reply('⏸ Paused playback.');
    }
    if (event?.from_admin && cmd === '!resume' && s.status === 'paused') {
      await this.resume(chatId).catch(() => {});
      return reply('▶ Resumed playback.');
    }
    if (cmd === '!vcmsg' && event?.from_admin && parts.length > 1) {
      return reply(parts.slice(1).join(' '));
    }
    if (cmd === '!help') {
      return reply('Commands: !np (now playing), !queue (up next), !skip (vote skip)');
    }
  }
  async setSubtitleOffset(id, deltaOrValue = 0, { absolute = false } = {}) {
    return this.locks.run(Number(id), async () => {
      const s = this.getSession(id);
      const cur = Number(s.subtitleSyncOffset || 0) || 0;
      const val = Number(deltaOrValue) || 0;
      const nextRaw = absolute ? val : cur + val;
      const next = Math.round(Math.max(-20, Math.min(20, nextRaw)) * 10) / 10;
      s.subtitleSyncOffset = next;
      s.subtitleManualOverride = true;
      s.subtitleSyncStatus = {
        ...(s.subtitleSyncStatus || {}),
        status: 'manual',
        applied_offset_sec: next,
        residual_sec: 0,
        manual_override: true,
        message: `Manual offset locked (${next > 0 ? `+${next}` : next}s)`,
        updated_at: Date.now() / 1000
      };
      this.#saveTrackSubState(s.currentTrack, next, true, null, {
        driftRate: Number(s.subtitleDriftRate || 0) || 0,
        driftAnchor: Number(s.subtitleDriftAnchor || 0) || 0
      });
      const subMode = s.subtitleMode || 'screen';
      if (s.connected && subMode !== 'off' && s.currentTrack?.subtitlePath && typeof this.voice?.setSubtitle === 'function') {
        await this.voice.setSubtitle(id, s.currentTrack.subtitlePath, {
          subtitleOffset: next,
          subtitleSameRoute: this.#isSameRouteSub(s.currentTrack),
          manualOverride: true,
          subtitleRenderScreen: subMode === 'screen',
          driftRate: Number(s.subtitleDriftRate || 0) || 0,
          driftAnchor: Number(s.subtitleDriftAnchor || 0) || 0
        }).catch(() => {});
      }
      if (['live', 'vc'].includes(subMode)) this.#emitLiveSubCue(s);
      await this.updatePlayerCard(id, { forceEdit: true });
      return next;
    });
  }
  async cycleSubtitleTrack(id, targetIndex = null) {
    return this.locks.run(Number(id), async () => {
      const s = this.getSession(id);
      const tracks = Array.isArray(s.currentTrack?.subtitleTracks)
        ? s.currentTrack.subtitleTracks.filter(t => t?.filePath && existsSync(t.filePath))
        : [];
      if (!tracks.length) return null;
      const curIdx = Math.max(0, Number(s.subtitleTrackIndex || 0));
      const nextIdx = Number.isInteger(targetIndex) && targetIndex >= 0 && targetIndex < tracks.length
        ? targetIndex
        : (curIdx + 1) % tracks.length;
      const chosen = tracks[nextIdx];
      s.subtitleTrackIndex = nextIdx;
      s.currentTrack.subtitlePath = chosen.filePath;
      s.currentTrack.subtitleFormat = chosen.format || 'srt';
      const nextSaved = this.#readTrackSubState(s.currentTrack, chosen.filePath);
      const nextOffset = nextSaved.offset;
      s.subtitleSyncOffset = nextOffset;
      s.subtitleManualOverride = nextSaved.manual;
      s.subtitleAutoOffset = null;
      s.subtitleAutoVerified = false;
      s.subtitleSyncStatus = null;
      s.subtitleDriftRate = Number(nextSaved.driftRate || 0) || 0;
      s.subtitleDriftAnchor = Number(nextSaved.driftAnchor || 0) || 0;
      s.liveSubCue = '';
      const subMode = s.subtitleMode || 'screen';
      if (subMode !== 'off') this.#ensureLiveSubTimer(s);
      if (s.connected && subMode !== 'off' && typeof this.voice?.setSubtitle === 'function') {
        await this.voice.setSubtitle(id, chosen.filePath, {
          subtitleOffset: nextOffset,
          subtitleSameRoute: this.#isSameRouteSub(s.currentTrack, chosen.filePath),
          manualOverride: nextSaved.manual,
          subtitleRenderScreen: subMode === 'screen',
          driftRate: s.subtitleDriftRate,
          driftAnchor: s.subtitleDriftAnchor
        }).catch(() => {});
      }
      if (['live', 'vc'].includes(subMode)) this.#emitLiveSubCue(s);
      await this.updatePlayerCard(id, { forceEdit: true });
      return { index: nextIdx, track: chosen };
    });
  }
  #syncSubtitleTelemetryFromInfo(s, info) {
    if (!s || !info || typeof info !== 'object') return false;
    let changed = false;
    if (info.auto_subtitle_offset !== null && info.auto_subtitle_offset !== undefined && Number.isFinite(Number(info.auto_subtitle_offset))) {
      const autoOff = Number(info.auto_subtitle_offset);
      const normalizedAuto = autoOff || null;
      if (s.subtitleAutoOffset !== normalizedAuto || !s.subtitleAutoVerified) changed = true;
      s.subtitleAutoOffset = normalizedAuto;
      s.subtitleAutoVerified = true;
    }
    if (info.subtitle_offset !== undefined && info.subtitle_offset !== null && Number.isFinite(Number(info.subtitle_offset))) {
      const nextOff = Number(info.subtitle_offset);
      if (Math.abs(nextOff - (Number(s.subtitleSyncOffset || 0) || 0)) >= 0.05) {
        s.subtitleSyncOffset = nextOff;
        changed = true;
      }
    }
    if (info.sub_drift_sec_per_sec !== undefined && info.sub_drift_sec_per_sec !== null && Number.isFinite(Number(info.sub_drift_sec_per_sec))) {
      const nextDrift = Number(info.sub_drift_sec_per_sec) || 0;
      if (Math.abs(nextDrift - (Number(s.subtitleDriftRate || 0) || 0)) >= 0.0001) changed = true;
      s.subtitleDriftRate = nextDrift;
    }
    if (info.sub_drift_anchor_sec !== undefined && info.sub_drift_anchor_sec !== null && Number.isFinite(Number(info.sub_drift_anchor_sec))) {
      s.subtitleDriftAnchor = Number(info.sub_drift_anchor_sec) || 0;
    }
    if (info.subtitle_sync && typeof info.subtitle_sync === 'object') {
      const prevStatus = s.subtitleSyncStatus?.status || null;
      const nextStatus = info.subtitle_sync.status || null;
      const prevOff = Number(s.subtitleSyncStatus?.applied_offset_sec ?? 0);
      const nextOff = Number(info.subtitle_sync.applied_offset_sec ?? s.subtitleSyncOffset ?? 0);
      if (prevStatus !== nextStatus || Math.abs(prevOff - nextOff) >= 0.05) {
        changed = true;
      }
      if (typeof info.subtitle_sync.manual_override === 'boolean') {
        s.subtitleManualOverride = info.subtitle_sync.manual_override;
      }
      s.subtitleSyncStatus = { ...info.subtitle_sync };
    }
    return changed;
  }
  async checkSubtitleSync(id, { autoFix = true } = {}) {
    return this.locks.run(Number(id), async () => {
      const s = this.getSession(id);
      if (!s.connected || !s.currentTrack?.subtitlePath) {
        return {
          ok: false,
          reason: 'NO_SUBTITLE',
          sync: { status: 'none', message: 'No active subtitle stream to check' },
          offset: Number(s.subtitleSyncOffset || 0) || 0
        };
      }
      if (typeof this.voice?.checkSubtitleSync !== 'function') {
        return { ok: false, reason: 'UNSUPPORTED', sync: s.subtitleSyncStatus, offset: Number(s.subtitleSyncOffset || 0) || 0 };
      }
      const res = await this.voice.checkSubtitleSync(id, { autoFix });
      this.#syncSubtitleTelemetryFromInfo(s, res);
      if (autoFix && (res?.subtitle_sync?.auto_normalized || Math.abs(Number(s.subtitleDriftRate || 0)) >= 0.0002) && Number.isFinite(Number(s.subtitleSyncOffset))) {
        this.#saveTrackSubState(s.currentTrack, s.subtitleSyncOffset, false, null, {
          driftRate: Number(s.subtitleDriftRate || 0) || 0,
          driftAnchor: Number(s.subtitleDriftAnchor || 0) || 0
        });
      }
      await this.updatePlayerCard(id, { forceEdit: true });
      return { ...(res || { ok: true }), sync: s.subtitleSyncStatus, offset: Number(s.subtitleSyncOffset || 0) || 0 };
    });
  }
  async handleStreamEnded(id, playbackId) {
    return this.locks.run(Number(id), async () => { const s = this.sessions.get(Number(id)); if (!s || !playbackId || playbackId !== s.playbackId || s.status !== 'playing') return false; await this.#next(s); return true; });
  }
  #cancelIdle(s) { s.generation++; clearTimeout(s.idleTimeout); s.idleTimeout = null; }
  #idle(s) {
    this.#cancelIdle(s); const generation = s.generation,armedAt=Date.now(),armedMonotonic=performance.now();s.idleDeadline=armedAt+this.idleTimeoutMs;
    const leave = () => this.locks.run(s.chatId, async () => {
      if (this.closed || s.generation !== generation || s.currentTrack || s.upcoming.length || (s.movieUpcoming?.length || 0) || s.status !== 'idle') return;
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
          this.#handleCallEndedSession(s, r.last_position_seconds);
        } else if (r.info?.playback_id === s.playbackId) {
          if (typeof r.info.position_seconds === 'number' && Number.isFinite(r.info.position_seconds)) {
            const prevPos = s.positionSeconds;
            s.positionSeconds = r.info.position_seconds;
            if (prevPos === null || prevPos === undefined || Math.abs(r.info.position_seconds - prevPos) >= 0.05 || (Date.now() - (s.positionUpdatedAt || 0)) >= 1400) {
              s.positionUpdatedAt = Date.now();
            }
            if (r.info.position_seconds > 0) s.lastKnownPositionSeconds = r.info.position_seconds;
          } else {
            s.positionSeconds = null;
          }
          if(Number.isFinite(r.info.volume)){s.volume=r.info.volume;s.volumeConfirmed=true;}
          const prevSyncing = Boolean(s.avSync?.syncing);
          const prevSyncHealth = s.avSync?.sync_health || null;
          const prevResyncCount = Number(s.avSync?.resync_count || 0);
          s.avSync = r.info.av_sync || null;
          const nextSyncHealth = s.avSync?.sync_health || null;
          const nextResyncCount = Number(s.avSync?.resync_count || 0);
          if (nextSyncHealth && nextSyncHealth !== prevSyncHealth) {
            if (['drifted', 'stalled'].includes(nextSyncHealth)) {
              this.log.warn({ chatId: s.chatId, syncHealth: nextSyncHealth, skewMs: s.avSync?.skew_ms, hbAgeSec: s.avSync?.hb_age_sec }, 'VC A/V sync degraded');
            } else if (['drifted', 'stalled', 'syncing'].includes(prevSyncHealth) && nextSyncHealth === 'locked') {
              this.log.info({ chatId: s.chatId, skewMs: s.avSync?.skew_ms }, 'VC A/V sync locked');
            }
          }
          if (nextResyncCount > prevResyncCount) {
            this.log.warn({ chatId: s.chatId, resyncCount: nextResyncCount, reason: s.avSync?.last_resync_reason }, 'VC A/V auto-resync triggered');
          }
          if (Boolean(s.avSync?.syncing) !== prevSyncing || nextSyncHealth !== prevSyncHealth || nextResyncCount !== prevResyncCount) {
            s.nextCardEdit = Math.min(s.nextCardEdit || 0, Date.now());
          }
          if (r.info.audio_language && s.currentTrack) s.currentTrack.audioLanguage = r.info.audio_language;
          if (r.info.audio_is_dub !== undefined && s.currentTrack) {
            s.currentTrack.audioIsDub = Boolean(r.info.audio_is_dub);
            if (s.currentTrack.audioIsDub && s.currentTrack.preferredAudioLang && !s.currentTrack.dubOnlyWarning) {
              s.currentTrack.dubOnlyWarning = '⚠️ Dub Only Available';
            }
          }
          if(r.info.status === 'recovering'){s.lastError='Reconnecting this stream; other destinations are unaffected.';s.positionSeconds=null;}
          if (r.info.rtmp_pipeline_delay_sec !== undefined && r.info.rtmp_pipeline_delay_sec !== null && Number.isFinite(Number(r.info.rtmp_pipeline_delay_sec))) {
            s.rtmpPipelineDelaySec = Number(r.info.rtmp_pipeline_delay_sec) || 0;
          }
          if (this.#syncSubtitleTelemetryFromInfo(s, r.info)) {
            if ((r.info.subtitle_sync?.auto_normalized || Math.abs(Number(r.info.sub_drift_sec_per_sec || 0)) >= 0.0002) && Number.isFinite(Number(s.subtitleSyncOffset))) {
              this.#saveTrackSubState(s.currentTrack, s.subtitleSyncOffset, false, null, {
                driftRate: Number(s.subtitleDriftRate || 0) || 0,
                driftAnchor: Number(s.subtitleDriftAnchor || 0) || 0
              });
            }
            s.nextCardEdit = Math.min(s.nextCardEdit || 0, Date.now());
          }
          if (['live', 'vc'].includes(s.subtitleMode) && s.currentTrack?.subtitlePath && Number.isFinite(s.positionSeconds)) {
            this.#ensureLiveSubTimer(s);
            this.#emitLiveSubCue(s);
          } else {
            this.#stopLiveSubTimer(s);
            if (s.liveSubCue) s.liveSubCue = '';
          }
          if (r.info.status === 'ended' && s.status === 'playing') await this.#next(s);
          else if (r.info.status === 'error' && r.info.publisher_muted) { s.status='error';s.positionSeconds=null;s.lastError='Telegram muted the playback account. Allow it to speak, then stop and retry playback. Your current recording and queue are retained.'; }
          else if (r.info.status === 'error') { s.lastError = 'The stream was interrupted. Advancing to the next queued recording.'; await this.#next(s, { manual: true }); }
        }
        s.failures = 0;
        const totalQueued = (s.upcoming?.length || 0) + (s.movieUpcoming?.length || 0);
        const snapIntervalMs = totalQueued > 200 ? 15000 : 5000;
        if (s.currentTrack && ['playing', 'paused'].includes(s.status) && Date.now() - (s._lastSnapshotAt || 0) >= snapIntervalMs) {
          this.#savePlaybackSnapshot(s);
        }
        if(s.status==='playing'&&(!s.prefetched||((s.radio?.enabled||this.app?.music?.aiDj?.isEnabled?.(s))&&s.upcoming.length<3))){this.prefetch(s);}
      } catch { s.failures = (s.failures || 0) + 1; s.positionSeconds = null; s.lastError = 'Playback status unavailable; reconnecting to the engine.'; }
      if(Date.now()>=(s.nextCardEdit||0)){s.nextCardEdit=Date.now()+25000;if(!s.overlayView&&(s.view==='player'||s.view==='cinema'))await this.updatePlayerCard(s.chatId);}
    })));
  }
  setPlayerMessage(id, messageId, targetChatId = null, api = null) { const s = this.getSession(id); s.screenMessageId = messageId; s.playerChatId = targetChatId || id; if (api) s.api = api; if (s.currentTrack && ['playing', 'paused', 'buffering'].includes(s.status)) this.#savePlaybackSnapshot(s); }
  #serializeTrackSnapshot(track) {
    if (!track || typeof track !== 'object') return null;
    const { queuedMedia, media, release, ...rest } = track;
    return rest;
  }
  #savePlaybackSnapshot(s) {
    if (!this.db?.setSetting || s?._skipSnapshotSave) return;
    const isActiveTrack = Boolean(s?.currentTrack && ['playing', 'paused', 'buffering'].includes(s.status));
    const deck = s?.activeDeck === 'movie' || s?.currentTrack?.provider === 'movie' ? 'movie' : 'music';
    const deckQ = deck === 'movie' ? (s?.movieUpcoming || []) : (s?.upcoming || []);
    const isInterrupted = Boolean(!isActiveTrack && s?.callEnded && deckQ.length && Number(deckQ[0]?.resumePositionSeconds || deckQ[0]?.startOffsetSeconds || s?.lastKnownPositionSeconds || 0) > 0);
    if (!isActiveTrack && !isInterrupted) return;
    try {
      const all = { ...(this.db.getSetting('music.activePlaybackSnapshots', {}) || {}) };
      all[String(s.chatId)] = {
        chatId: s.chatId,
        isChannel: Boolean(s.isChannel),
        activeDeck: deck,
        status: isInterrupted ? 'idle' : (s.status === 'paused' ? 'paused' : 'playing'),
        paused: s.status === 'paused' || isInterrupted,
        callEnded: isInterrupted,
        positionSeconds: this.#resolveSavedPosition(s, null, isActiveTrack ? s.currentTrack : deckQ[0]),
        currentTrack: isActiveTrack ? this.#serializeTrackSnapshot(s.currentTrack) : null,
        upcoming: (s.upcoming || []).map(t => this.#serializeTrackSnapshot(t)).filter(Boolean),
        history: (s.history || []).slice(-25).map(t => this.#serializeTrackSnapshot(t)).filter(Boolean),
        movieUpcoming: (s.movieUpcoming || []).map(t => this.#serializeTrackSnapshot(t)).filter(Boolean),
        movieHistory: (s.movieHistory || []).slice(-25).map(t => this.#serializeTrackSnapshot(t)).filter(Boolean),
        volume: Number.isFinite(Number(s.volume)) ? Number(s.volume) : 100,
        loopMode: s.loopMode || 'off',
        bass: Boolean(s.bass),
        eqPreset: s.eqPreset || (s.bass ? 'bass' : 'off'),
        streamMode: s.streamMode === 'rtmp' ? 'rtmp' : 'interactive',
        musicStreamMode: s.musicStreamMode || this.getDeckStreamMode(s.chatId, 'music'),
        movieStreamMode: s.movieStreamMode || this.getDeckStreamMode(s.chatId, 'movie'),
        subtitleMode: s.subtitleMode || 'screen',
        subtitleSyncOffset: Number(s.subtitleSyncOffset || 0) || 0,
        subtitleDriftRate: Number(s.subtitleDriftRate || 0) || 0,
        subtitleDriftAnchor: Number(s.subtitleDriftAnchor || 0) || 0,
        preferredAccount: s.preferredAccount || s.accountAlias || null,
        screenMessageId: s.screenMessageId || null,
        playerChatId: s.playerChatId || s.chatId,
        pinned: Boolean(s.pinned),
        destinationTitle: s.destinationTitle || null,
        destinationUsername: s.destinationUsername || null,
        botUsername: s.botUsername || null,
        botId: Number(s.botId || 0),
        vcUrl: s.vcUrl || null,
        callInviteLink: s.callInviteLink || null,
        groupInviteLink: s.groupInviteLink || null,
        view: s.view || (s.activeDeck === 'movie' ? 'cinema' : 'player'),
        savedAt: Date.now()
      };
      this.db.setSetting('music.activePlaybackSnapshots', all);
      s._lastSnapshotAt = Date.now();
    } catch {}
  }
  #clearPlaybackSnapshot(id) {
    if (!this.db?.setSetting || this.closed) return;
    try {
      const all = { ...(this.db.getSetting('music.activePlaybackSnapshots', {}) || {}) };
      if (Object.hasOwn(all, String(Number(id)))) {
        delete all[String(Number(id))];
        this.db.setSetting('music.activePlaybackSnapshots', all);
      }
    } catch {}
  }
  async autoPinPlayerCard(id, msgId = null, targetChatId = null, api = null) {
    const s = this.getSession(id);
    const messageId = Number(msgId || s.screenMessageId);
    const chatId = Number(targetChatId || s.playerChatId || id);
    const useApi = api || s.api || this.app?.telegram?.api;
    const isActive = Boolean(s.currentTrack) || ['playing', 'paused', 'buffering'].includes(s.status);
    if (!messageId || !useApi || !(chatId < 0) || !isActive || s.pinnedMessageId === messageId) return false;
    if (typeof useApi.pinChatMessage !== 'function') return false;
    try {
      await useApi.pinChatMessage(chatId, messageId, { disable_notification: true });
      s.pinned = true;
      s.pinnedMessageId = messageId;
      return true;
    } catch {
      return false;
    }
  }
  async restoreActiveSessions({ api = null } = {}) {
    if (this.closed || !this.db?.getSetting) return [];
    const saved = this.db.getSetting('music.activePlaybackSnapshots', {}) || {};
    const entries = Object.values(saved).filter(snap => (snap?.currentTrack || (snap?.callEnded && (snap?.movieUpcoming?.length || snap?.upcoming?.length))) && snap?.chatId);
    if (!entries.length) return [];
    const restored = [];
    const maxAgeMs = Number(process.env.MUSIC_RESUME_MAX_AGE_MS || 24 * 60 * 60 * 1000);
    for (const snap of entries) {
      if (this.closed) break;
      const age = Date.now() - Number(snap.savedAt || 0);
      if (Number.isFinite(maxAgeMs) && maxAgeMs > 0 && snap.savedAt && age > maxAgeMs) {
        this.#clearPlaybackSnapshot(snap.chatId);
        continue;
      }
      try {
        const started = await this.locks.run(Number(snap.chatId), async () => {
          const s = this.getSession(snap.chatId);
          if (this.hasActiveSession(s.chatId)) return false;
          const trackCopy = snap.currentTrack ? { ...snap.currentTrack } : null;
          if (trackCopy?.filePath && !existsSync(trackCopy.filePath)) delete trackCopy.filePath;
          if (trackCopy?.subtitlePath && !existsSync(trackCopy.subtitlePath)) delete trackCopy.subtitlePath;
          if (trackCopy?.streamUrl && /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/i.test(trackCopy.streamUrl)) delete trackCopy.streamUrl;
          else if (trackCopy && !trackCopy.filePath && trackCopy.provider === 'movie' && trackCopy.streamUrl && /^https?:\/\//i.test(trackCopy.streamUrl)) {
            trackCopy._restoredFromSnapshot = true;
          }
          const resumeSec = Math.max(0, Number(snap.positionSeconds || 0) || 0);
          const deck = snap.activeDeck === 'movie' || trackCopy?.provider === 'movie' ? 'movie' : 'music';
          const hydrateEntry = raw => {
            const copy = { ...raw };
            if (copy.filePath && !existsSync(copy.filePath)) delete copy.filePath;
            if (copy.subtitlePath && !existsSync(copy.subtitlePath)) delete copy.subtitlePath;
            if (copy.streamUrl && /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/i.test(copy.streamUrl)) delete copy.streamUrl;
            else if (!copy.filePath && copy.provider === 'movie' && copy.streamUrl && /^https?:\/\//i.test(copy.streamUrl)) {
              copy._restoredFromSnapshot = true;
            }
            return queueEntry(copy);
          };
          s.isChannel = Boolean(snap.isChannel);
          s.activeDeck = deck;
          s.volume = Number.isFinite(Number(snap.volume)) ? Number(snap.volume) : s.volume;
          s.loopMode = snap.loopMode || s.loopMode;
          s.bass = Boolean(snap.bass);
          s.eqPreset = snap.eqPreset || (s.bass ? 'bass' : 'off');
          if (snap.musicStreamMode === 'rtmp' || snap.musicStreamMode === 'interactive') s.musicStreamMode = snap.musicStreamMode;
          if (snap.movieStreamMode === 'rtmp' || snap.movieStreamMode === 'interactive') s.movieStreamMode = snap.movieStreamMode;
          if (snap.streamMode === 'rtmp' || snap.streamMode === 'interactive') s.streamMode = snap.streamMode;
          s.subtitleMode = snap.subtitleMode || s.subtitleMode;
          s.subtitleSyncOffset = Number.isFinite(Number(snap.subtitleSyncOffset)) ? Number(snap.subtitleSyncOffset) : (s.subtitleSyncOffset || 0);
          s.subtitleDriftRate = Number.isFinite(Number(snap.subtitleDriftRate)) ? Number(snap.subtitleDriftRate) : (s.subtitleDriftRate || 0);
          s.subtitleDriftAnchor = Number.isFinite(Number(snap.subtitleDriftAnchor)) ? Number(snap.subtitleDriftAnchor) : (s.subtitleDriftAnchor || 0);
          s.preferredAccount = snap.preferredAccount || s.preferredAccount;
          s.destinationTitle = snap.destinationTitle || s.destinationTitle || null;
          s.destinationUsername = snap.destinationUsername || s.destinationUsername || null;
          s.botUsername = snap.botUsername || s.botUsername || null;
          s.botId = Number(snap.botId ?? s.botId ?? 0) || 0;
          s.vcUrl = snap.vcUrl || s.vcUrl || null;
          s.callInviteLink = snap.callInviteLink || s.callInviteLink || null;
          s.groupInviteLink = snap.groupInviteLink || s.groupInviteLink || null;
          if (s.botId > 0 && !s.api && this.app?.multiBotManager?.getRunningBot) {
            const cloneBot = this.app.multiBotManager.getRunningBot(s.botId);
            if (cloneBot?.api) s.api = cloneBot.api;
          }
          s.view = snap.view || (deck === 'movie' ? 'cinema' : 'player');
          s.screenMessageId = snap.screenMessageId || s.screenMessageId || null;
          s.playerChatId = snap.playerChatId || s.playerChatId || s.chatId;
          s.pinned = false;
          s.pinnedMessageId = null;
          if (!s.api && api) s.api = api;
          s.upcoming = Array.isArray(snap.upcoming) ? snap.upcoming.map(hydrateEntry) : [];
          s.history = Array.isArray(snap.history) ? snap.history.map(hydrateEntry) : [];
          s.movieUpcoming = Array.isArray(snap.movieUpcoming) ? snap.movieUpcoming.map(hydrateEntry) : [];
          s.movieHistory = Array.isArray(snap.movieHistory) ? snap.movieHistory.map(hydrateEntry) : [];
          if (snap.callEnded && !trackCopy) {
            const q = deck === 'movie' ? s.movieUpcoming : s.upcoming;
            if (q[0] && resumeSec > 0 && !(Number(q[0].resumePositionSeconds || q[0].startOffsetSeconds || 0) > 0)) {
              q[0] = { ...q[0], resumePositionSeconds: resumeSec, startOffsetSeconds: resumeSec };
            }
            s.callEnded = true;
            s.status = 'idle';
            s.connected = false;
            s.lastKnownPositionSeconds = resumeSec;
            s.positionSeconds = resumeSec > 0 ? resumeSec : null;
            s.lastNotice = resumeSec > 0
              ? `Voice chat ended (saved at ${this.#formatSavedClock(resumeSec)}). Tap ▶ Resume or send a song to start playback.`
              : 'Voice chat ended. Tap ▶ Resume or send a song to start playback.';
            await this.#ensureRestoredCard(s, api);
            return true;
          }
          const resumeEntry = queueEntry({ ...trackCopy, startOffsetSeconds: resumeSec });
          if (deck === 'movie') s.movieUpcoming.unshift(resumeEntry);
          else s.upcoming.unshift(resumeEntry);
          s._skipSnapshotSave = true;
          s._suppressCinemaAnnounce = true;
          let activeTrack = null;
          try {
            activeTrack = await this.#next(s, { manual: true, deck });
            if (activeTrack && snap.paused) {
              await this.voice.pause(s.chatId).catch(() => null);
              s.status = 'paused';
            }
          } finally {
            s._skipSnapshotSave = false;
            s._suppressCinemaAnnounce = false;
          }
          if (activeTrack) {
            this.#savePlaybackSnapshot(s);
            await this.#ensureRestoredCard(s, api);
            return true;
          }
          return false;
        });
        if (started) restored.push(Number(snap.chatId));
      } catch (err) {
        this.log.warn({ chatId: snap.chatId, code: err?.code, err: err?.message }, 'Could not auto-resume playback after restart');
      }
    }
    return restored;
  }
  async #ensureRestoredCard(s, api) {
    if (s.screenMessageId) {
      const updated = await this.updatePlayerCard(s.chatId, { forceEdit: true });
      if (updated) return true;
    }
    const useApi = s.api || api || (s.botId > 0 ? this.app?.multiBotManager?.getRunningBot?.(s.botId)?.api : null) || this.app?.telegram?.api;
    const targetChatId = Number(s.playerChatId || s.chatId);
    if (!useApi || typeof useApi.sendRichMessage !== 'function' || !(targetChatId < 0)) return false;
    const screen = resolveAppScreen(this.app, 'music', { session: s });
    if (!screen) return false;
    const isCinema = s.activeDeck === 'movie' || s.currentTrack?.provider === 'movie';
    const rich = isCinema && screen.renderCinemaPlayer ? screen.renderCinemaPlayer(s) : screen.renderPlayer(s);
    if (!rich) return false;
    let sent = await useApi.sendRichMessage(targetChatId, rich).catch(() => null);
    if (!sent) {
      const noPhoto = stripRemotePhotoBlocks(rich);
      if (noPhoto) sent = await useApi.sendRichMessage(targetChatId, noPhoto).catch(() => null);
    }
    if (!sent?.message_id) return false;
    this.setPlayerMessage(s.chatId, sent.message_id, targetChatId, useApi);
    s.pinned = false;
    s.pinnedMessageId = null;
    s.lastRender = JSON.stringify(rich);
    s.editAfter = 0;
    await this.autoPinPlayerCard(s.chatId, sent.message_id, targetChatId, useApi);
    return true;
  }
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
  async updatePlayerView(s, { preview = null, forceEdit = false } = {}) {
    return this.cardLocks.run(s.panelToken || s.chatId, async () => {
      const api = s.api || (s.botId > 0 ? this.app?.multiBotManager?.getRunningBot?.(s.botId)?.api : null) || this.app?.telegram?.api;
      if (!s.screenMessageId || !api || (!forceEdit && Date.now() < (s.editAfter || 0))) return false;
      if (!preview && !forceEdit && s.overlayView && (Date.now() - (s.overlayAt || 0) < 180000)) return false;
      const screen = resolveAppScreen(this.app, 'music', { session: s }); if (!screen) return false;
      const previews = this.app?.music?.previews;
      if (!preview) {
        previews?.schedule(s);
        if (s.currentTrack) this.app?.music?.requestCardLyrics?.(s);
      }
      if (preview && (!previews?.current(s, preview.request) || s.view !== 'player')) return false;
      const display = preview ? { ...s, fullPreview: { ...s.fullPreview, status: 'ready', fileId: 'attach://music_full_audio', track: preview.media.track } } : s;
      if (display.view === 'queue' || display.view === 'mqueue') {
        const qLen = display.view === 'mqueue' ? (display.movieUpcoming?.length || 0) : (display.upcoming?.length || 0);
        const totalQueuePages = Math.max(1, Math.ceil(qLen / 5));
        if ((display.page || 0) >= totalQueuePages) display.page = totalQueuePages - 1;
      }
      const effectiveView = (display.view === 'player' && (display.activeDeck === 'movie' || display.currentTrack?.provider === 'movie')) ? 'cinema' : display.view;
      const rich = effectiveView === 'radio' ? screen.renderRadio(display)
        : effectiveView === 'queue' ? screen.renderQueue(display, display.page)
        : effectiveView === 'mqueue' ? (screen.renderMovieQueue ? screen.renderMovieQueue(display, display.page) : screen.renderQueue(display, display.page))
        : effectiveView === 'cinema' ? (screen.renderCinemaPlayer ? screen.renderCinemaPlayer(display) : screen.renderPlayer(display))
        : effectiveView === 'lyrics' ? screen.renderLyrics?.(display)
        : effectiveView === 'volume' ? screen.renderVolumePicker(display)
        : effectiveView === 'accounts' ? screen.renderAccounts(display)
        : effectiveView === 'options' ? screen.renderOptions(display)
        : effectiveView === 'voteset' ? (screen.renderVoteSettings ? screen.renderVoteSettings(display) : screen.renderOptions(display))
        : effectiveView === 'subsync' ? (screen.renderSubSyncPicker ? screen.renderSubSyncPicker(display) : screen.renderOptions(display))
        : effectiveView === 'seekmenu' ? (screen.renderSeekPicker ? screen.renderSeekPicker(display) : screen.renderOptions(display))
        : effectiveView === 'dlq' ? (screen.renderCinemaDownloadQuality ? screen.renderCinemaDownloadQuality(display) : screen.renderCinemaPlayer(display))
        : screen.renderPlayer(display);
      if (!rich) return false;
      const content = JSON.stringify(rich); if (!preview && !forceEdit && content === s.lastRender) return true;
      try {
        const files = preview ? await audioUpload(preview.media) : null;
        // A track/control can change while reading the file. Never upload stale audio.
        if (preview && (!previews.current(s, preview.request) || s.view !== 'player')) return false;
        let sent;
        try {
          sent = await api.editMessageRich(s.playerChatId, s.screenMessageId, rich, { dropOnFloodWait: !forceEdit }, files);
        } catch (editErr) {
          if (!preview && isRemotePhotoError(editErr)) {
            const noPhoto = stripRemotePhotoBlocks(rich);
            if (noPhoto) {
              sent = await api.editMessageRich(s.playerChatId, s.screenMessageId, noPhoto, { dropOnFloodWait: !forceEdit }, files);
            } else {
              throw editErr;
            }
          } else {
            throw editErr;
          }
        }
        s.lastRender = content;
        await this.autoPinPlayerCard(s.chatId, s.screenMessageId, s.playerChatId, api);
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
        if (/message is not modified/i.test(desc)) {
          s.lastRender = content;
          await this.autoPinPlayerCard(s.chatId, s.screenMessageId, s.playerChatId, api);
          return true;
        }
        if (/message to edit not found|message_id_invalid|message can't be edited|message edit time expired|message_edit_time_expired|edit_time_expired|edit time expired|there is no text in the message to edit/i.test(desc)) {
          const oldMsgId = s.screenMessageId;
          const now = Date.now();
          if (oldMsgId && (forceEdit || now - (s._lastCardReplaceAt || 0) >= 8000) && typeof api.sendRichMessage === 'function') {
            s._lastCardReplaceAt = now;
            try {
              let replacement = null;
              try {
                replacement = await api.sendRichMessage(s.playerChatId, rich);
              } catch (sendErr) {
                if (isRemotePhotoError(sendErr)) {
                  const noPhoto = stripRemotePhotoBlocks(rich);
                  if (noPhoto) replacement = await api.sendRichMessage(s.playerChatId, noPhoto);
                } else {
                  throw sendErr;
                }
              }
              if (replacement?.message_id) {
                if (oldMsgId !== replacement.message_id && typeof api.deleteMessage === 'function') {
                  await api.deleteMessage(s.playerChatId, oldMsgId).catch(() => {});
                }
                if (oldMsgId !== replacement.message_id) {
                  s.pinned = false;
                  s.pinnedMessageId = null;
                }
                if (s.panelToken && this.app?.music?.channelPanels?.registerMessage) {
                  this.app.music.channelPanels.registerMessage(s.panelToken, replacement.message_id);
                } else {
                  s.screenMessageId = replacement.message_id;
                }
                s.lastRender = content;
                s.editAfter = 0;
                await this.autoPinPlayerCard(s.chatId, replacement.message_id, s.playerChatId, api);
                return true;
              }
            } catch {}
          }
          s.screenMessageId = null;
          s.pinned = false;
          s.pinnedMessageId = null;
          s.lastRender = null;
          s.editAfter = 0;
          return false;
        }
        if (/chat not found/i.test(desc)) {
          s.screenMessageId = null;
          s.lastRender = null;
          s.editAfter = 0;
          return false;
        }
        s.editAfter = Date.now() + Math.max(3, Number(e.retry_after || e.parameters?.retry_after || 5)) * 1000;
        this.log.debug({ chatId: s.chatId }, 'Player edit deferred'); return false;
      }
    });
  }
  async shutdown() {
    for (const s of this.sessions.values()) this.#savePlaybackSnapshot(s);
    this.closed = true;this.eventAbort.abort(); clearInterval(this.poller);for(const s of this.sessions.values())s.prepareAbort?.abort();
    await Promise.allSettled([...this.sessions.values()].map(s => this.locks.run(s.chatId, async () => {
      this.#cancelIdle(s);this.dropPrefetch(s);for(const t of s.upcoming)t.queuedMedia?.release?.();for(const t of (s.movieUpcoming||[]))t.queuedMedia?.release?.();let confirmed=!s.connected&&!s.prepared;
      try{if(s.connected||s.prepared||s.stopPending)this.#assert(await this.voice.stop(s.chatId,{leaveMembership:!s.isChannel}));confirmed=true;if(s.prepared){s.prepared=false;this.app?.music?.setup?.forget(s.chatId);}}
      catch{s.lastError='The service is stopping, but call departure has not been confirmed.';}
      finally{this.#release(s);s.connected=!confirmed;s.currentTrack=null;s.upcoming=[];s.movieUpcoming=[];s.playbackId=null;s.positionSeconds=null;s.status='stopped';s.view='player';if(confirmed){s.accountAlias=null;s.lastError=null;}await this.updatePlayerCard(s.chatId);}
    })));
    await Promise.allSettled([...this.prefetchWork,...this.eventJobs]);
  }
}
