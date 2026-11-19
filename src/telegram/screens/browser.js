/**
 * Telegram BrowserOS Neo control panel, /browser command handler, inline actions,
 * approval prompts, human-takeover handoff, replay viewer, and remote PC connector setup.
 */

import { inlineKeyboard, ikButton, escapeHtml, encodeCallback } from '../rich.js';
import { buildBrowserScopeKey, extractDomain, sanitizeAuditText } from '../../browser/security.js';

function formatStatusCard({ status, health, liveInfo, connectors = [] }) {
  const healthBadge = health?.ok ? '🟢 Connected' : '🔴 Offline';
  const liveBadge = liveInfo ? `📺 <b>Streaming Live in VC</b> (${liveInfo.fps || 12} FPS · ${liveInfo.width || 1280}x${liveInfo.height || 720})` : '🕶 Not streaming to VC';
  const lines = [
    '🌐 <b>Lancy BrowserOS Neo Operator</b>\n',
    `<blockquote>• <b>Service:</b> ${healthBadge} (<code>${escapeHtml(health?.endpoint || '127.0.0.1:9010')}</code>)`,
    `• <b>VC Stream:</b> ${liveBadge}`,
    `• <b>Connectors:</b> ${connectors.length} available (<code>${escapeHtml(connectors.map((c) => c.id).join(', ') || 'local')}</code>)</blockquote>`
  ];

  if (status?.active) {
    lines.push(
      '',
      `<b>Active Task:</b> <code>${escapeHtml(status.taskId)}</code>`,
      `• <b>Status:</b> <code>${escapeHtml(status.status)}</code>`,
      `• <b>Page:</b> <code>${escapeHtml(status.domain || extractDomain(status.url) || 'about:blank')}</code>`,
      `• <b>Action:</b> ${escapeHtml(sanitizeAuditText(status.currentAction || 'Working', 100))}`,
      `• <b>Progress:</b> Step ${status.stepCount || 0}/${status.maxSteps || 18}`,
      `• <b>Goal:</b> <i>${escapeHtml(sanitizeAuditText(status.goal || '', 140))}</i>`
    );
  } else if (status?.recentTasks?.length) {
    lines.push('', '<b>Recent Tasks:</b>');
    for (const r of status.recentTasks.slice(0, 3)) {
      lines.push(`• <code>${escapeHtml(r.id)}</code> [${escapeHtml(r.status)}] ${escapeHtml(sanitizeAuditText(r.goal, 60))}`);
    }
  } else {
    lines.push('', '<i>Send <code>/browser open https://example.com</code> or ask Lancy in VC to browse anything live!</i>');
  }
  return lines.join('\n');
}

function buildPanelKeyboard(status, isGroup) {
  const tid = status?.taskId || 'none';
  const rows = [];
  if (isGroup) {
    rows.push([
      ikButton('📺 Show Live VC', encodeCallback('browser', 'live'), { style: 'success' }),
      ikButton('🕶 Hide Live VC', encodeCallback('browser', 'hide'))
    ]);
  }
  if (status?.active) {
    if (status.status === 'paused' || status.status === 'awaiting_human') {
      rows.push([
        ikButton('▶️ Resume / Done', encodeCallback('browser', 'done', tid), { style: 'success' }),
        ikButton('🛑 Stop Task', encodeCallback('browser', 'stop', tid), { style: 'danger' })
      ]);
    } else {
      rows.push([
        ikButton('⏸ Pause', encodeCallback('browser', 'pause', tid)),
        ikButton('🧑 Take Over', encodeCallback('browser', 'takeover', tid)),
        ikButton('🛑 Stop', encodeCallback('browser', 'stop', tid), { style: 'danger' })
      ]);
    }
    rows.push([
      ikButton('🗂 Tabs', encodeCallback('browser', 'tabs')),
      ikButton('🎬 Replay', encodeCallback('browser', 'replay', tid)),
      ikButton('🔄 Refresh', encodeCallback('browser', 'status'))
    ]);
  } else {
    rows.push([
      ikButton('🗂 List Tabs', encodeCallback('browser', 'tabs')),
      ikButton('🎬 Last Replay', encodeCallback('browser', 'replay', 'latest')),
      ikButton('🔄 Refresh', encodeCallback('browser', 'status'))
    ]);
  }
  return inlineKeyboard(rows);
}

export function createBrowserScreen({ app }) {
  async function authorize(ctx, mode = 'operate') {
    const svc = app?.browser;
    if (!svc) return { allowed: false, reason: 'browser_service_unavailable' };
    return svc.perms.authorize(ctx, { chatId: ctx.chatId, userId: ctx.tgId, mode });
  }

  async function renderDashboard(ctx, { edit = false } = {}) {
    const svc = app.browser;
    const scopeKey = buildBrowserScopeKey(ctx.chatId, ctx.tgId);
    const [status, health] = await Promise.all([
      Promise.resolve(svc.getTaskStatus({ scopeKey })),
      svc.checkHealth(scopeKey).catch(() => ({ ok: false }))
    ]);
    const liveInfo = Number(ctx.chatId) < 0 ? svc.liveView.getLiveInfo(ctx.chatId) : null;
    const connectors = svc.conn.listConnectors();
    const html = formatStatusCard({ status, health, liveInfo, connectors });
    const reply_markup = buildPanelKeyboard(status, Number(ctx.chatId) < 0);
    if (edit && ctx.messageId) {
      await ctx.api.editMessageText(ctx.chatId, ctx.messageId, undefined, html, { parse_mode: 'HTML', reply_markup }).catch(() => {});
      return;
    }
    await ctx.api.sendMessage(ctx.chatId, html, { parse_mode: 'HTML', reply_markup }).catch(() => {});
  }

  async function handleCommand(ctx, rawText = '') {
    const perm = await authorize(ctx, 'operate');
    if (!perm.allowed) {
      await ctx.api.sendMessage(ctx.chatId, `🚫 Browser access in this chat requires Owner, VC-Sudo, or Group Admin (${perm.reason}).`).catch(() => {});
      return true;
    }

    const svc = app.browser;
    const scopeKey = perm.scopeKey;
    const rest = String(rawText || '').replace(/^[!/.\w@]+(?:\s+|$)/, '').trim();
    const tokens = rest ? rest.split(/\s+/) : [];
    const sub = String(tokens[0] || '').toLowerCase();
    const isGroup = Number(ctx.chatId) < 0;

    if (!rest || sub === 'status' || sub === 'panel') {
      await renderDashboard(ctx);
      return true;
    }

    if (sub === 'live' || sub === 'show') {
      if (!isGroup) {
        await ctx.api.sendMessage(ctx.chatId, '📺 Live VC streaming works inside a Telegram group/channel Voice Chat.').catch(() => {});
        return true;
      }
      const targetUrl = tokens[1] && /^https?:\/\/|\./i.test(tokens[1]) ? tokens[1] : null;
      const res = await svc.showLive(ctx.chatId, { userId: ctx.tgId, url: targetUrl });
      if (!res?.ok) {
        await ctx.api.sendMessage(ctx.chatId, `❌ Could not start Browser VC live stream: <code>${escapeHtml(res?.error || 'unknown')}</code>`, { parse_mode: 'HTML' }).catch(() => {});
        return true;
      }
      await ctx.api.sendMessage(
        ctx.chatId,
        `📺 <b>Lancy Browser Live VC Active!</b>\nStreaming real BrowserOS view of <code>${escapeHtml(res.domain)}</code> (${res.width}x${res.height} @ ${res.fps}fps).\nSend natural commands like <i>"scroll down"</i> or <i>"click the second result"</i>.`,
        { parse_mode: 'HTML', reply_markup: buildPanelKeyboard({ active: true, taskId: res.taskId, status: 'running' }, true) }
      ).catch(() => {});
      return true;
    }

    if (sub === 'hide' || sub === 'unshare') {
      const res = await svc.hideLive(ctx.chatId, { resumeMedia: true });
      await ctx.api.sendMessage(
        ctx.chatId,
        res.restoredMedia
          ? '🕶 Hid live browser VC view and resumed your paused music/movie track cleanly.'
          : '🕶 Stopped live browser VC view.'
      ).catch(() => {});
      return true;
    }

    if (sub === 'tabs') {
      const res = await svc.listTabs(scopeKey);
      const list = (res.tabs || []).slice(0, 12).map((t) => `• <b>#${t.pageId}</b> [${escapeHtml(t.ownership)}] ${escapeHtml(sanitizeAuditText(t.title || t.url, 60))}\n  <code>${escapeHtml(sanitizeAuditText(t.url, 90))}</code>`);
      await ctx.api.sendMessage(
        ctx.chatId,
        list.length ? `🗂 <b>Open BrowserOS Tabs</b>\n\n${list.join('\n')}` : '🗂 No open tabs in this session.',
        { parse_mode: 'HTML' }
      ).catch(() => {});
      return true;
    }

    if (sub === 'pause') {
      const st = svc.getTaskStatus({ scopeKey });
      if (!st?.taskId) {
        await ctx.api.sendMessage(ctx.chatId, 'No active browser task in this chat.').catch(() => {});
        return true;
      }
      await svc.pauseTask(st.taskId);
      await renderDashboard(ctx);
      return true;
    }

    if (sub === 'resume' || sub === 'done' || sub === 'continue') {
      const st = svc.getTaskStatus({ scopeKey });
      const tid = tokens[1] || st?.taskId;
      if (!tid) {
        await ctx.api.sendMessage(ctx.chatId, 'No paused browser task to resume.').catch(() => {});
        return true;
      }
      await svc.resumeTask(tid);
      await ctx.api.sendMessage(ctx.chatId, `▶️ Resumed browser task <code>${escapeHtml(tid)}</code>.`, { parse_mode: 'HTML' }).catch(() => {});
      return true;
    }

    if (sub === 'stop' || sub === 'cancel') {
      const st = svc.getTaskStatus({ scopeKey });
      const tid = tokens[1] || st?.taskId;
      if (!tid) {
        await ctx.api.sendMessage(ctx.chatId, 'No running browser task to stop.').catch(() => {});
        return true;
      }
      await svc.stopTask(tid);
      if (isGroup && svc.liveView.isLive(ctx.chatId)) {
        await svc.hideLive(ctx.chatId, { resumeMedia: true });
      }
      await ctx.api.sendMessage(ctx.chatId, `🛑 Stopped browser task <code>${escapeHtml(tid)}</code>.`, { parse_mode: 'HTML' }).catch(() => {});
      return true;
    }

    if (sub === 'takeover' || sub === 'human') {
      const st = svc.getTaskStatus({ scopeKey });
      if (!st?.taskId) {
        await ctx.api.sendMessage(ctx.chatId, 'Start a browser task first before requesting human takeover.').catch(() => {});
        return true;
      }
      await svc.requestHumanHelp(st.taskId, { reason: 'Manual user takeover requested via /browser takeover', kind: 'manual', userId: ctx.tgId });
      return true;
    }

    if (sub === 'approve' || sub === 'deny') {
      const st = svc.getTaskStatus({ scopeKey });
      const tid = tokens[1] || st?.taskId;
      if (!tid) return true;
      await svc.resolveApproval(tid, { approved: sub === 'approve', approvedBy: ctx.tgId });
      await ctx.api.sendMessage(ctx.chatId, sub === 'approve' ? '✅ Approved action — continuing browser task.' : '❌ Denied action — stopped safely.').catch(() => {});
      return true;
    }

    if (sub === 'replay') {
      const st = svc.getTaskStatus({ scopeKey });
      const tid = (tokens[1] && tokens[1] !== 'latest') ? tokens[1] : (st?.taskId || st?.recentTasks?.[0]?.id);
      if (!tid) {
        await ctx.api.sendMessage(ctx.chatId, '🎬 No browser session replay found yet for this scope.').catch(() => {});
        return true;
      }
      const rep = await svc.getReplay(tid, { scopeKey });
      if (!rep?.ok) {
        await ctx.api.sendMessage(ctx.chatId, `🎬 Replay unavailable: ${escapeHtml(rep?.error || 'not_found')}`).catch(() => {});
        return true;
      }
      const steps = (rep.timeline || []).slice(-12).map((item) => `• Step ${item.step}: <b>${escapeHtml(item.tool || '')}</b> — ${escapeHtml(sanitizeAuditText(item.summary || item.url || item.error || '', 95))}`);
      await ctx.api.sendMessage(
        ctx.chatId,
        [`🎬 <b>Browser Replay</b> <code>${escapeHtml(rep.taskId)}</code>`, `Goal: <i>${escapeHtml(sanitizeAuditText(rep.goal, 120))}</i>`, `Status: <code>${escapeHtml(rep.status)}</code>\n`, ...(steps.length ? steps : ['<i>No steps recorded yet.</i>'])].join('\n'),
        { parse_mode: 'HTML' }
      ).catch(() => {});
      return true;
    }

    if (sub === 'connector') {
      const adminPerm = await authorize(ctx, 'connector_admin');
      if (!adminPerm.allowed) {
        await ctx.api.sendMessage(ctx.chatId, '🚫 Only Bot Owner or SuperAdmin can register remote BrowserOS PC connectors.').catch(() => {});
        return true;
      }
      if (tokens[1] === 'local') {
        svc.conn.selectConnector(scopeKey, 'local');
        await ctx.api.sendMessage(ctx.chatId, '🖥 Switched this chat back to local Managed BrowserOS Neo service.').catch(() => {});
        return true;
      }
      if (!tokens[2]) {
        const list = svc.conn.listConnectors().map((c) => `• <code>${escapeHtml(c.id)}</code> — ${escapeHtml(c.label)} (<code>${escapeHtml(c.mcpUrl)}</code>)`).join('\n');
        await ctx.api.sendMessage(
          ctx.chatId,
          `🔌 <b>BrowserOS Connectors</b>\n${list}\n\nRegister remote PC:\n<code>/browser connector home https://my-pc.ts.net/mcp [token]</code>\nSwitch back: <code>/browser connector local</code>`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
        return true;
      }
      try {
        const added = svc.conn.registerConnector({
          id: tokens[1],
          label: `Remote PC (${tokens[1]})`,
          mcpUrl: tokens[2],
          apiToken: tokens[3] || '',
          activateScope: scopeKey
        });
        await ctx.api.sendMessage(ctx.chatId, `🔌 Connected & activated remote BrowserOS connector <code>${escapeHtml(added.id)}</code> -> <code>${escapeHtml(added.mcpUrl)}</code>.`, { parse_mode: 'HTML' }).catch(() => {});
      } catch (err) {
        await ctx.api.sendMessage(ctx.chatId, `❌ Connector error: ${escapeHtml(err?.message || err)}`, { parse_mode: 'HTML' }).catch(() => {});
      }
      return true;
    }

    // Default: treat rest as browser goal or URL (`open ...` / `browse ...` / goal text)
    const goalText = sub === 'open' || sub === 'run' || sub === 'browse' ? rest.slice(sub.length).trim() : rest;
    const autoLive = isGroup && (Boolean(app.musicQueueManager?.getSession?.(ctx.chatId)?.connected) || /\blive\b/i.test(goalText));
    const started = await svc.startTask({
      chatId: ctx.chatId,
      userId: ctx.tgId,
      requestedByName: ctx.user?.first_name || ctx.from?.first_name || 'User',
      goal: goalText,
      showLiveVc: autoLive
    });
    if (!started?.ok) {
      await ctx.api.sendMessage(ctx.chatId, `❌ Could not start BrowserOS task: <code>${escapeHtml(started?.error || 'failed')}</code>`, { parse_mode: 'HTML' }).catch(() => {});
      return true;
    }
    await ctx.api.sendMessage(
      ctx.chatId,
      `🌐 <b>Started BrowserOS Task</b> <code>${escapeHtml(started.taskId)}</code>\n• Domain: <code>${escapeHtml(started.domain || 'page')}</code>\n• Goal: <i>${escapeHtml(sanitizeAuditText(goalText, 120))}</i>`,
      { parse_mode: 'HTML', reply_markup: buildPanelKeyboard({ active: true, taskId: started.taskId, status: started.status }, isGroup) }
    ).catch(() => {});
    return true;
  }

  async function handle(ctx, action, args = []) {
    const perm = await authorize(ctx, 'operate');
    if (!perm.allowed) {
      if (ctx.query?.id) await ctx.api.answerCallbackQuery(ctx.query.id, { text: 'Requires Owner, VC-Sudo, or Admin access.', show_alert: true }).catch(() => {});
      return;
    }
    const svc = app.browser;
    const scopeKey = perm.scopeKey;
    const targetId = String(args[0] || '');

    if (ctx.query?.id) await ctx.api.answerCallbackQuery(ctx.query.id).catch(() => {});

    if (action === 'status') {
      await renderDashboard(ctx, { edit: true });
    } else if (action === 'live') {
      await handleCommand(ctx, '/browser live');
    } else if (action === 'hide') {
      await handleCommand(ctx, '/browser hide');
    } else if (action === 'tabs') {
      await handleCommand(ctx, '/browser tabs');
    } else if (action === 'pause' && targetId) {
      await svc.pauseTask(targetId);
      await renderDashboard(ctx, { edit: true });
    } else if ((action === 'done' || action === 'resume') && targetId) {
      await svc.resumeTask(targetId);
      await renderDashboard(ctx, { edit: true });
    } else if (action === 'stop' && targetId) {
      await svc.stopTask(targetId);
      if (Number(ctx.chatId) < 0 && svc.liveView.isLive(ctx.chatId)) await svc.hideLive(ctx.chatId, { resumeMedia: true });
      await renderDashboard(ctx, { edit: true });
    } else if (action === 'takeover' && targetId) {
      await svc.requestHumanHelp(targetId, { reason: 'User clicked Take Over in Telegram', kind: 'manual', userId: ctx.tgId });
    } else if (action === 'approve' && targetId) {
      await svc.resolveApproval(targetId, { approved: true, approvedBy: ctx.tgId });
      await renderDashboard(ctx, { edit: true });
    } else if (action === 'deny' && targetId) {
      await svc.resolveApproval(targetId, { approved: false, approvedBy: ctx.tgId });
      await renderDashboard(ctx, { edit: true });
    } else if (action === 'replay') {
      await handleCommand(ctx, `/browser replay ${targetId}`);
    }
  }

  return {
    id: 'browser',
    handleCommand,
    handle,
    renderDashboard
  };
}
