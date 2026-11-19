/**
 * Live Telegram VC Video Bridge Manager for BrowserOS neo.
 * Manages VC stream leases (`QueueManager`), live `/v1/sessions/{id}/screencast` URL wiring,
 * clean real-time HUD metadata updates without stream restarts, and safe restore on hide/stop.
 */

import { buildBrowserScopeKey, extractDomain, sanitizeAuditText } from './security.js';

export class BrowserLiveViewManager {
  constructor({ app, connectionManager, taskManager, log = null } = {}) {
    this.app = app || null;
    this.conn = connectionManager;
    this.tasks = taskManager;
    this.log = log || app?.log?.child?.({ module: 'browser-live-vc' }) || null;
    this.activeLiveChats = new Map(); // chatId -> { chatId, scopeKey, taskId, mcpSessionId, syncId, screencastUrl, ... }

    // Push live task status milestones cleanly into the active VC video HUD + stats
    if (this.tasks?.on) {
      this.tasks.on('task_event', (ev) => {
        void this.#onTaskEvent(ev).catch(() => {});
      });
    }
  }

  isLive(chatId) {
    return this.activeLiveChats.has(Number(chatId));
  }

  getLiveInfo(chatId) {
    return this.activeLiveChats.get(Number(chatId)) || null;
  }

  async #onTaskEvent(ev) {
    const cid = Number(ev?.chatId || 0);
    if (!cid || cid >= 0) return;
    const live = this.activeLiveChats.get(cid);
    if (!live) return;

    const meta = {
      domain: extractDomain(ev.url) || live.domain || 'browser',
      url: sanitizeAuditText(ev.url || live.url || '', 180),
      task: sanitizeAuditText(ev.goal || live.task || 'Lancy Browser', 80),
      action: sanitizeAuditText(ev.action || ev.narration || ev.type || 'Working', 80),
      state: String(ev.status || 'LIVE').toUpperCase(),
      step: ev.stepCount ? `${ev.stepCount}/${ev.maxSteps || 18}` : ''
    };
    live.domain = meta.domain;
    live.url = meta.url;
    live.task = meta.task;
    live.action = meta.action;
    live.state = meta.state;

    await this.app?.voiceClient?.updateBrowserLiveMeta?.(cid, meta).catch(() => {});
  }

  /**
   * Show the real BrowserOS neo session live inside a Telegram Voice Chat while preserving media queue lease.
   */
  async showLiveInVc(chatId, {
    userId = null,
    taskId = null,
    url = null,
    tabId = null,
    quality = null,
    fps = null
  } = {}) {
    const cid = Number(chatId);
    if (!Number.isFinite(cid) || cid >= 0) {
      return { ok: false, error: 'vc_requires_group_chat' };
    }

    const scopeKey = buildBrowserScopeKey(cid, userId);
    const vc = this.app?.voiceClient;
    if (!vc) return { ok: false, error: 'voice_bridge_unavailable' };

    let task = taskId ? this.tasks.getTask(taskId) : this.tasks.getActiveTaskForScope(scopeKey);
    const client = await this.conn.getClient(scopeKey);
    const conn = this.conn.getConnector(null, scopeKey);

    if (!task) {
      const startUrl = url || 'https://example.com';
      const created = await this.tasks.startTask({
        chatId: cid,
        userId: Number(userId || 0),
        goal: url ? `Open ${startUrl}` : 'Open live browser view',
        url: startUrl,
        showLiveVc: true
      });
      if (!created?.ok) return created;
      task = this.tasks.getTask(created.taskId);
    }

    const mcpSessionId = task?.mcpSessionId || client.sessionId;
    const targetQuality = String(quality || this.app?.settings?.get?.('browser.streamQuality') || this.app?.env?.BROWSEROS_STREAM_QUALITY || 'high');
    const targetFps = Math.max(5, Math.min(30, Number(fps || this.app?.settings?.get?.('browser.streamFps') || this.app?.env?.BROWSEROS_STREAM_FPS || 12)));
    const width = Number(this.app?.settings?.get?.('browser.streamWidth') || this.app?.env?.BROWSEROS_STREAM_WIDTH || 1280);
    const height = Number(this.app?.settings?.get?.('browser.streamHeight') || this.app?.env?.BROWSEROS_STREAM_HEIGHT || 720);

    const screencastUrl = client.getScreencastUrl({
      sessionId: mcpSessionId,
      quality: targetQuality,
      tab: tabId ?? task?.activePageId ?? null
    });
    if (!screencastUrl) return { ok: false, error: 'screencast_url_unavailable' };

    // 1) Acquire Music/Cinema stream lease so active queues stay safely paused & restorable
    const qm = this.app?.musicQueueManager;
    const lease = qm?.acquireStreamLease ? await qm.acquireStreamLease(cid, 'browser') : { ok: true, hadMedia: false };

    const ownerIds = (this.app?.settings?.get?.('general.ownerIds') || []).map(Number).filter(Boolean);
    const domain = extractDomain(task?.currentUrl || url) || 'browseros';
    const metaPayload = {
      screencastUrl,
      mcpSessionId,
      apiToken: conn?.apiToken || '',
      domain,
      url: sanitizeAuditText(task?.currentUrl || url || '', 180),
      task: sanitizeAuditText(task?.goal || 'Lancy Browser', 80),
      action: sanitizeAuditText(task?.currentAction || 'Streaming live tab', 80),
      state: String(task?.status || 'LIVE').toUpperCase(),
      step: task?.stepCount ? `${task.stepCount}/${task.maxSteps || 18}` : '',
      accountAlias: lease?.accountAlias || undefined,
      vcTitle: `🌐 ${domain}`,
      voiceAiEnabled: true,
      voiceAuthorizedIds: ownerIds,
      width,
      height,
      fps: targetFps
    };

    try {
      const started = await vc.startBrowserLive(cid, metaPayload);
      if (task) task.liveVc = true;
      const entry = {
        chatId: cid,
        scopeKey,
        taskId: task?.id || null,
        mcpSessionId,
        syncId: started?.sync_id || null,
        screencastUrl,
        domain,
        url: metaPayload.url,
        task: metaPayload.task,
        action: metaPayload.action,
        state: metaPayload.state,
        fps: targetFps,
        width,
        height,
        hadMediaLease: Boolean(lease?.hadMedia),
        startedAt: Date.now()
      };
      this.activeLiveChats.set(cid, entry);
      this.app?.db?.upsertBrowserSession?.({
        scopeKey,
        chatId: cid,
        userId: Number(userId || 0),
        mcpSessionId,
        activeUrl: metaPayload.url,
        activeDomain: domain,
        liveVcEnabled: true,
        status: 'streaming'
      });
      await vc.pushLiveContext?.(cid, `Live BrowserOS screen share active in VC showing ${domain}: ${metaPayload.task}`).catch(() => {});
      return { ok: true, ...entry };
    } catch (err) {
      if (lease?.hadMedia && qm?.releaseStreamLease) {
        await qm.releaseStreamLease(cid, { resumePrevious: false }).catch(() => {});
      }
      return { ok: false, error: err?.message || 'browser_live_start_failed' };
    }
  }

  /**
   * Stop live BrowserOS screen share and optionally restore the paused music/movie track.
   */
  async hideLiveFromVc(chatId, { resumeMedia = true } = {}) {
    const cid = Number(chatId);
    const live = this.activeLiveChats.get(cid);
    this.activeLiveChats.delete(cid);

    if (live?.taskId) {
      const t = this.tasks.getTask(live.taskId);
      if (t) t.liveVc = false;
    }

    const qm = this.app?.musicQueueManager;
    const willResumeMedia = Boolean(resumeMedia && live?.hadMediaLease);
    await this.app?.voiceClient?.stopBrowserLive?.(cid, { keepCall: willResumeMedia }).catch(() => {});

    let restored = false;
    if (qm?.releaseStreamLease) {
      const rel = await qm.releaseStreamLease(cid, { resumePrevious: willResumeMedia }).catch(() => ({ restored: false }));
      restored = Boolean(rel?.restored);
    }

    if (live?.scopeKey) {
      this.app?.db?.upsertBrowserSession?.({
        scopeKey: live.scopeKey,
        chatId: cid,
        userId: 0,
        liveVcEnabled: false,
        status: 'idle'
      });
    }
    return { ok: true, hidden: Boolean(live), restoredMedia: restored };
  }

  async getLiveStats(chatId) {
    const cid = Number(chatId);
    const live = this.activeLiveChats.get(cid);
    if (!live) return { ok: true, live: false };
    const res = await this.app?.voiceClient?.updateBrowserLiveMeta?.(cid, {}).catch(() => null);
    return {
      ok: true,
      live: true,
      domain: live.domain,
      url: live.url,
      task: live.task,
      action: live.action,
      state: live.state,
      stats: res?.stats || null
    };
  }
}
