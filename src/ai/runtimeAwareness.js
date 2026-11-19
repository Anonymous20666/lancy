/**
 * Runtime Awareness & Performance Telemetry for Lancy AI.
 *
 * Supplies grounded, timestamped system snapshots (never invented state) and records
 * real pipeline latency/reliability metrics without logging secrets or private audio.
 */
import { durationText } from '../music/model.js';
import { getTimeOfDayContext } from './userProfile.js';

export class RuntimeAwareness {
  constructor({ app = null } = {}) {
    this.app = app;
    this.metrics = {
      turnsTotal: 0,
      modelCalls: 0,
      modelFailures: 0,
      toolCalls: 0,
      toolFailures: 0,
      duplicateDrops: 0,
      interruptions: 0,
      lastEndOfSpeechToFirstAudioMs: null,
      lastModelLatencyMs: null,
      lastToolLatencyMs: null,
      lastBargeInLatencyMs: null,
      recentErrors: []
    };
  }

  recordError(area, message) {
    this.metrics.recentErrors.push({
      ts: Date.now(),
      area: String(area || 'ai'),
      message: String(message || 'unknown error').slice(0, 180)
    });
    if (this.metrics.recentErrors.length > 10) this.metrics.recentErrors.shift();
  }

  recordModelTurn({ latencyMs = null, ok = true, error = null } = {}) {
    this.metrics.modelCalls += 1;
    if (Number.isFinite(latencyMs)) this.metrics.lastModelLatencyMs = Math.round(latencyMs);
    if (!ok) {
      this.metrics.modelFailures += 1;
      if (error) this.recordError('model', error);
    }
  }

  recordToolBatch({ count = 0, failures = 0, latencyMs = null } = {}) {
    this.metrics.toolCalls += Number(count || 0);
    this.metrics.toolFailures += Number(failures || 0);
    if (Number.isFinite(latencyMs)) this.metrics.lastToolLatencyMs = Math.round(latencyMs);
  }

  recordVoiceLatency({ firstAudioMs = null, bargeInMs = null } = {}) {
    if (Number.isFinite(firstAudioMs)) this.metrics.lastEndOfSpeechToFirstAudioMs = Math.round(firstAudioMs);
    if (Number.isFinite(bargeInMs)) {
      this.metrics.interruptions += 1;
      this.metrics.lastBargeInLatencyMs = Math.round(bargeInMs);
    }
  }

  recordDuplicateDrop() {
    this.metrics.duplicateDrops += 1;
  }

  getMetricsSummary() {
    return {
      ...this.metrics,
      recentErrors: [...this.metrics.recentErrors]
    };
  }

  /**
   * Build an authoritative, timestamped snapshot of active chat/VC/deck/permissions/model state.
   */
  async buildSnapshot({ chatId = 0, userId = null, speakerName = null, surface = 'dm', sessionState = null, ctx = null } = {}) {
    const cid = Number(chatId || 0);
    const qm = this.app?.musicQueueManager || null;
    const session = cid && qm ? (qm.sessions?.get?.(cid) || null) : null;
    const tz = (cid && this.app?.db?.getSetting?.(`voiceai.tz.${cid}`, null))
      || this.app?.settings?.get?.('voiceAi.timezone')
      || 'Africa/Lagos';
    const timeCtx = getTimeOfDayContext(tz);

    const activeDeck = session ? (session.activeDeck || (session.currentTrack?.provider === 'movie' ? 'movie' : 'music')) : 'none';
    const queueList = session ? (activeDeck === 'movie' ? (session.movieUpcoming || []) : (session.upcoming || [])) : [];
    const cur = session?.currentTrack || null;

    let participants = [];
    if (session?.connected && cid < 0 && typeof this.app?.voiceClient?.getParticipants === 'function') {
      try {
        const res = await this.app.voiceClient.getParticipants(cid);
        if (Array.isArray(res?.participants)) participants = res.participants;
      } catch {}
    }

    const perms = { owner: false, superAdmin: false, vcSudo: false };
    if (userId && this.app?.music) {
      const ctxLike = { ...(ctx || {}), tgId: Number(userId), user: { id: Number(userId) }, chatId: cid };
      perms.owner = Boolean(this.app.music.owner?.(ctxLike));
      perms.superAdmin = Boolean(this.app.music.superAdmin?.(ctxLike));
      perms.vcSudo = Boolean(this.app.music.isVcSudo?.(ctxLike, cid));
    }

    const aiStatus = this.app?.ai?.getCapabilities?.() || {
      primaryModel: this.app?.settings?.get?.('ai.model') || 'unknown',
      backupModel: this.app?.settings?.get?.('ai.backupModel') || null,
      realtimeVoiceAvailable: false
    };

    const lyricsSnippet = session?.cardLyrics?.result?.lines?.slice?.(0, 6)
      || (session?.liveSubCue ? [session.liveSubCue] : null);

    return {
      timestamp: Date.now(),
      chatId: cid,
      surface,
      localTime: timeCtx,
      callActive: Boolean(session?.connected),
      participants: participants.slice(0, 25),
      activeSpeaker: speakerName || sessionState?.activeSpeakerName || null,
      conversationMode: sessionState?.mode || 'IDLE',
      pendingActions: sessionState?.pendingReferences || [],
      permissions: perms,
      bot: {
        username: this.app?.telegram?.botUsername || this.app?.telegram?.api?.me?.username || 'Lancy_easy_bot',
        clonesCount: Number(this.app?.multiBotManager?.activeBotsCount?.() || 0)
      },
      player: session ? {
        status: session.status || 'idle',
        deck: activeDeck,
        streamMode: session.streamMode || 'interactive',
        quality: session.vcQuality || 'auto',
        subtitleMode: session.subtitleMode || 'screen',
        volume: session.volume ?? 100,
        muted: Boolean(session.muted),
        loopMode: session.loopMode || 'off',
        nowPlaying: cur ? {
          title: cur.title,
          artist: cur.artist || null,
          seasonNumber: cur.seasonNumber || null,
          episodeNumber: cur.episodeNumber || null,
          positionSeconds: Number(session.positionSeconds || 0),
          positionClock: durationText(session.positionSeconds || 0),
          durationSeconds: Number(cur.durationSeconds || 0) || null,
          durationClock: cur.durationSeconds ? durationText(cur.durationSeconds) : null,
          audioLanguage: cur.audioLanguage || null,
          lyricsSnippet
        } : null,
        queueCount: queueList.length,
        upNext: queueList.slice(0, 5).map((t, i) => `${i + 1}. ${t.title}${t.artist ? ` (${t.artist})` : ''}`)
      } : null,
      ai: aiStatus,
      recentErrors: this.metrics.recentErrors.slice(-3)
    };
  }
}
