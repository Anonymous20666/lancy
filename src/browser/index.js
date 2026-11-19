/**
 * High-level BrowserOS neo service coordinator for Lancy AI.
 * Combines MCP connections, isolated scoped task execution, approval & human-help handoffs,
 * event-driven VC narration + Telegram live status updates, and live Telegram VC streaming.
 */

import { inlineKeyboard, ikButton, encodeCallback } from '../telegram/rich.js';
import { BrowserConnectionManager } from './connectionManager.js';
import { BrowserTaskManager } from './taskManager.js';
import { BrowserLiveViewManager } from './liveViewManager.js';
import { BrowserPermissionManager, buildBrowserScopeKey, extractDomain, sanitizeAuditText } from './security.js';

export class BrowserService {
  constructor({ app, log = null, clientFactory = null } = {}) {
    this.app = app || null;
    this.log = log || app?.log?.child?.({ module: 'browser-service' }) || null;
    this.perms = new BrowserPermissionManager({ app });
    this.conn = new BrowserConnectionManager({ app, log: this.log, clientFactory });
    this.tasks = new BrowserTaskManager({
      app,
      connectionManager: this.conn,
      permissionManager: this.perms,
      log: this.log
    });
    this.liveView = new BrowserLiveViewManager({
      app,
      connectionManager: this.conn,
      taskManager: this.tasks,
      log: this.log
    });
    this._lastSpokenAt = new Map();

    this.tasks.on('task_event', (ev) => {
      void this.#handleTaskMilestone(ev).catch(() => {});
    });
  }

  async #handleTaskMilestone(ev) {
    const cid = Number(ev?.chatId || 0);
    if (!cid) return;

    // 1) Push rich browser state into Gemini Live; request an active spoken turn on key outcomes
    const turnTriggerEvents = new Set(['task_completed', 'task_failed', 'human_help_needed', 'approval_required']);
    const shouldTriggerTurn = turnTriggerEvents.has(ev.type);
    let liveDelivered = false;
    if (cid < 0 && this.app?.voiceClient?.pushLiveContext) {
      const domain = ev.domain || extractDomain(ev.url) || 'page';
      let detail = sanitizeAuditText(ev.action || ev.type, 80);
      if (ev.type === 'task_completed') {
        detail = sanitizeAuditText(ev.summary || ev.excerpt || `Finished viewing ${domain}`, 280);
      } else if (ev.type === 'task_failed') {
        detail = sanitizeAuditText(`Failed: ${ev.error || 'unknown error'}`, 180);
      } else if (ev.type === 'human_help_needed') {
        detail = sanitizeAuditText(`Needs human help (${domain}): ${ev.reason || 'Sign-in or verification required'}`, 200);
      } else if (ev.type === 'approval_required') {
        detail = sanitizeAuditText(`Needs user approval: ${ev.approval?.actionLabel || 'high-impact action'}`, 200);
      }
      const ctxLine = `[Browser] event=${ev.type} status=${ev.status} domain=${domain} step=${ev.stepCount || 0} detail="${detail}"${shouldTriggerTurn ? ' — Briefly tell the user this browser update aloud in your own natural voice.' : ''}`;
      const pushed = await this.app.voiceClient.pushLiveContext(cid, ctxLine, { triggerTurn: shouldTriggerTurn }).catch(() => null);
      liveDelivered = Boolean(pushed?.sent);
    }

    // 2) Fallback Edge-TTS narration ONLY when Gemini Live session is NOT active (avoids colliding voices/interruptions)
    const speakable = new Set(['task_started', 'approval_required', 'human_help_needed', 'task_completed', 'task_failed']);
    if (cid < 0 && !liveDelivered && speakable.has(ev.type) && this.app?.voiceClient?.speak) {
      const now = Date.now();
      const prev = this._lastSpokenAt.get(cid) || 0;
      const minGap = ev.type === 'human_help_needed' || ev.type === 'approval_required' ? 1000 : 2800;
      if ((now - prev) >= minGap) {
        this._lastSpokenAt.set(cid, now);
        let line = '';
        if (ev.type === 'task_started') line = `Opening ${ev.domain || 'the browser'} now to work on that.`;
        else if (ev.type === 'approval_required') line = `Hold on, I need your confirmation before continuing: ${ev.approval?.actionLabel || 'high-impact action'}.`;
        else if (ev.type === 'human_help_needed') line = `I reached a sign-in or verification screen on ${ev.domain || 'the site'}. Please take over briefly and tap done when ready.`;
        else if (ev.type === 'task_completed') line = sanitizeAuditText(ev.summary || 'Browser task is finished.', 220);
        else if (ev.type === 'task_failed') line = `The browser task ran into an issue: ${sanitizeAuditText(ev.error || 'unknown error', 90)}.`;
        if (line) {
          const voiceOpts = this.app?.lancyAgent?.getVoiceProfileForChat?.(cid) || {};
          await this.app.voiceClient.speak(cid, line, { ...voiceOpts, barge_in_clear: false }).catch(() => {});
        }
      }
    }

    // 3) Send interactive Telegram cards on approval_required & human_help_needed
    const api = this.app?.telegram?.api;
    if (!api) return;
    if (ev.type === 'approval_required' && ev.approval) {
      const text = [
        `🛡 <b>Browser Action Requires Approval</b>`,
        `Domain: <code>${extractDomain(ev.url) || 'page'}</code>`,
        `Action: <b>${sanitizeAuditText(ev.approval.actionLabel, 120)}</b>`,
        `Reason: ${sanitizeAuditText(ev.approval.reason, 180)}`,
        `\nTask: <code>${ev.taskId}</code>`
      ].join('\n');
      const reply_markup = inlineKeyboard([
        [
          ikButton('✅ Approve Action', encodeCallback('browser', 'approve', ev.taskId), { style: 'success' }),
          ikButton('❌ Deny & Stop', encodeCallback('browser', 'deny', ev.taskId), { style: 'danger' })
        ]
      ]);
      await api.sendMessage(cid, text, { parse_mode: 'HTML', reply_markup }).catch(() => {});
    } else if (ev.type === 'human_help_needed') {
      const novnc = ev.novncUrl || this.conn.getConnector(null, ev.scopeKey)?.novncUrl || 'http://127.0.0.1:6080';
      const lines = [
        `🧑 <b>Human Help Needed in BrowserOS</b>`,
        `Site: <code>${extractDomain(ev.url) || 'page'}</code>`,
        `Reason: ${sanitizeAuditText(ev.reason || 'Login / 2FA / CAPTCHA required', 180)}`,
        `Remote viewer (noVNC): <code>${novnc}</code>`,
        `\nAutomation is paused cleanly until you finish and tap Done.`
      ];
      const reply_markup = inlineKeyboard([
        [
          ikButton('✅ I\'m Done — Resume Lancy', encodeCallback('browser', 'done', ev.taskId), { style: 'success' }),
          ikButton('🛑 Stop Task', encodeCallback('browser', 'stop', ev.taskId), { style: 'danger' })
        ]
      ]);
      if (ev.snapshotImage?.data) {
        const buf = Buffer.from(ev.snapshotImage.data, 'base64');
        await api.sendPhoto(cid, buf, { caption: lines.join('\n'), parse_mode: 'HTML', reply_markup }).catch(() =>
          api.sendMessage(cid, lines.join('\n'), { parse_mode: 'HTML', reply_markup }).catch(() => {})
        );
      } else {
        await api.sendMessage(cid, lines.join('\n'), { parse_mode: 'HTML', reply_markup }).catch(() => {});
      }
    }
  }

  async checkHealth(scopeKey = 'global') {
    return this.conn.checkHealth(null, scopeKey);
  }

  async startTask(opts = {}) {
    const res = await this.tasks.startTask(opts);
    if (res?.ok && opts.showLiveVc && Number(opts.chatId) < 0) {
      const live = await this.liveView.showLiveInVc(opts.chatId, {
        userId: opts.userId,
        taskId: res.taskId,
        tabId: res.pageId,
        url: res.url
      });
      res.liveVc = live;
    }
    return res;
  }

  getTaskStatus(opts = {}) { return this.tasks.getStatusSnapshot(opts); }
  listTabs(scopeKey, opts = {}) { return this.tasks.listTabs(scopeKey, opts); }
  pauseTask(taskId) { return this.tasks.pauseTask(taskId); }
  resumeTask(taskId) { return this.tasks.resumeTask(taskId); }
  stopTask(taskId, opts = {}) { return this.tasks.stopTask(taskId, opts); }
  requestHumanHelp(taskId, opts = {}) { return this.tasks.requestHumanHelp(taskId, opts); }
  resolveApproval(taskId, opts = {}) { return this.tasks.resolveApproval(taskId, opts); }
  interactLive(opts = {}) { return this.tasks.interactLive(opts); }
  getReplay(taskId, opts = {}) { return this.tasks.getReplay(taskId, opts); }
  showLive(chatId, opts = {}) { return this.liveView.showLiveInVc(chatId, opts); }
  hideLive(chatId, opts = {}) { return this.liveView.hideLiveFromVc(chatId, opts); }

  async shutdown() {
    for (const cid of [...this.liveView.activeLiveChats.keys()]) {
      await this.liveView.hideLiveFromVc(cid, { resumeMedia: false }).catch(() => {});
    }
    await this.conn.shutdown();
  }
}

export { buildBrowserScopeKey };
