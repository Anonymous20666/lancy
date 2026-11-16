import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { logger } from '../core/logger.js';
import { MusicError } from './model.js';

export class VoiceClient {
  constructor({ app, port = 3056, host = '127.0.0.1', log } = {}) {
    this.app = app; this.port = Number(process.env.VOICE_BRIDGE_PORT || port); this.host = process.env.VOICE_BRIDGE_HOST || host;
    if (!['127.0.0.1','::1'].includes(this.host)) throw new Error('Voice bridge must use loopback');
    this.baseUrl = `http://${this.host === '::1' ? '[::1]' : this.host}:${this.port}`;
    this.token = process.env.VOICE_BRIDGE_TOKEN || randomBytes(32).toString('hex');
    this.log = log || logger().child({ module: 'voice-client' }); this.process = null; this.starting = null; this.closed = false;
  }
  async ensureDaemon() {
    if (this.closed) throw new MusicError('SHUTTING_DOWN', 'Music is shutting down.');
    if (this.starting) return this.starting;
    this.starting = this.#start();
    try { return await this.starting; } finally { this.starting = null; }
  }
  async #start() {
    try { const h = await this.checkHealth(); if (h.protocol !== 2) throw new MusicError('BRIDGE_INCOMPATIBLE', 'An older voice engine is running. Owner approval and a controlled restart are required.'); return true; }
    catch (e) { if (e.code !== 'BRIDGE_UNAVAILABLE') throw e; }
    if (this.closed) throw new MusicError('SHUTTING_DOWN', 'Music is shutting down.');
    const python = join(process.cwd(), 'service/voice/.venv/bin/python3'); const script = join(process.cwd(), 'service/voice/main.py');
    if (!existsSync(python) || !existsSync(script)) throw new MusicError('BRIDGE_UNAVAILABLE', 'Voice runtime is missing. The owner must install service/voice/requirements.txt in its venv.');
    if (!this.process) {
      if (this.closed) throw new MusicError('SHUTTING_DOWN', 'Music is shutting down.');
      this.process = spawn(python, [script], { env: { ...process.env, VOICE_BRIDGE_TOKEN: this.token, VOICE_BRIDGE_PORT: String(this.port), VOICE_BRIDGE_HOST: this.host, VOICE_BRIDGE_PARENT_PID: String(process.pid), MUSIC_CACHE_DIR: this.app.musicLibrary.root }, stdio: ['ignore','ignore','pipe'] });
      if (this.process.stderr) {
        let stderrBuf = '';
        this.process.stderr.setEncoding('utf8');
        this.process.stderr.on('data', (chunk) => {
          stderrBuf += chunk;
          const lines = stderrBuf.split(/\r?\n/);
          stderrBuf = lines.pop() || '';
          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line) continue;
            if (/warning|error|stalled|resync|drift/i.test(line)) this.log.warn({ voiceLog: line.slice(0, 260) }, 'Voice engine monitor');
            else this.log.debug({ voiceLog: line.slice(0, 220) }, 'Voice engine log');
          }
        });
      }
      this.process.once('error', () => { this.process = null; this.log.warn('Voice engine spawn failed'); });
      this.process.once('exit', code => { this.process = null; this.log.warn({ code }, 'Voice engine exited'); });
    }
    for (let i=0; i<75; i++) {
      if (this.closed) {
        try { this.process?.kill('SIGTERM'); } catch {}
        throw new MusicError('SHUTTING_DOWN', 'Music is shutting down.');
      }
      await new Promise(r => setTimeout(r, 200));
      const h = await this.checkHealth().catch(() => null);
      if (h?.protocol === 2) return true;
      if (!this.process) break;
    }
    throw new MusicError('BRIDGE_UNAVAILABLE', 'Voice engine did not start. Check the protected operator service logs.');
  }
  async stopDaemon() {
    this.closed = true;
    try { await this.starting; } catch {}
    const proc = this.process;
    if (!proc) return;
    await new Promise(resolve => {
      const forceKill = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 1200);
      const timer = setTimeout(() => { clearTimeout(forceKill); resolve(); }, 3000);
      proc.once('exit', () => { clearTimeout(forceKill); clearTimeout(timer); resolve(); });
      try { proc.kill('SIGTERM'); } catch { clearTimeout(forceKill); clearTimeout(timer); resolve(); }
    });
  }
  async request(endpoint, { method = 'GET', body, timeoutMs = 10000, signal = null } = {}) {
    try {
      const r = await fetch(`${this.baseUrl}${endpoint}`, { method, headers: { 'Content-Type':'application/json', Authorization: `Bearer ${this.token}` }, body: body === undefined ? undefined : JSON.stringify(body), signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs) });
      if (r.status === 401) throw new MusicError('BRIDGE_INCOMPATIBLE', 'The existing voice bridge is not authorized for this process. Do not start a competing player; arrange a controlled restart.');
      const data = await r.json(); if (!r.ok || !data.ok) { const error=new MusicError(data.error || 'BRIDGE_FAILURE', data.message || 'The playback engine rejected this operation.');if(data.publisher_state)error.publisherState=data.publisher_state;if(/^[A-Za-z0-9_]{1,80}$/.test(data.error_kind||'')){error.backendKind=data.error_kind;this.log.warn({code:error.code,backendKind:error.backendKind,...(data.error_detail?{detail:String(data.error_detail).slice(0,240)}:{})},'Native call operation failed');}throw error; } return data;
    } catch (error) { if (error instanceof MusicError) throw error; throw new MusicError('BRIDGE_UNAVAILABLE', 'The voice engine is unreachable or timed out. Check its status before retrying.'); }
  }
  waitEvent(signal) { return this.request('/events',{timeoutMs:25000,signal}); }
  checkHealth() { return this.request('/health', { timeoutMs: 1500 }); }
  async play(chatId, streamUrl, opts = {}) { await this.ensureDaemon(); return this.request('/call/play', { method:'POST', body: { chat_id:Number(chatId), stream_url:streamUrl, remote_proxy:Boolean(opts.remoteProxy), subtitle_path:opts.subtitlePath || null, subtitle_offset:Number.isFinite(Number(opts.subtitleOffset)) ? Number(opts.subtitleOffset) : 0, subtitle_same_route:Boolean(opts.subtitleSameRoute), ...(opts.subtitleRenderScreen !== undefined ? { subtitle_render_screen: Boolean(opts.subtitleRenderScreen) } : {}), ...(Number.isFinite(Number(opts.subDriftSecPerSec)) && Number(opts.subDriftSecPerSec) !== 0 ? { sub_drift_sec_per_sec: Number(opts.subDriftSecPerSec) } : {}), ...(Number.isFinite(Number(opts.subDriftAnchorSec)) && Number(opts.subDriftAnchorSec) > 0 ? { sub_drift_anchor_sec: Number(opts.subDriftAnchorSec) } : {}), ...(opts.subtitleManualOverride !== undefined ? { subtitle_manual_override: Boolean(opts.subtitleManualOverride) } : {}), is_channel:Boolean(opts.isChannel), video:Boolean(opts.video), video_quality:String(opts.videoQuality || process.env.VOICE_VIDEO_QUALITY || 'HD_720p'), playback_id:opts.playbackId, account_alias:opts.accountAlias, duration_seconds:opts.durationSeconds, start_seconds:Number.isFinite(Number(opts.startSeconds)) && Number(opts.startSeconds) > 0 ? Number(opts.startSeconds) : 0, vc_title:opts.vcTitle ? String(opts.vcTitle).slice(0, 64) : undefined, bass:Boolean(opts.bass), eq:String(opts.eq || (opts.bass ? 'bass' : 'off')), volume:Number.isFinite(Number(opts.volume)) ? Number(opts.volume) : 100, ...(opts.streamMode ? { stream_mode: String(opts.streamMode) } : {}), ...(opts.preferredAudioLang ? { preferred_audio_lang: String(opts.preferredAudioLang) } : {}), ...(opts.rejectDub !== undefined ? { reject_dub: Boolean(opts.rejectDub) } : {}), ...(opts.messages_enabled !== undefined ? { messages_enabled: Boolean(opts.messages_enabled) } : (opts.messagesEnabled !== undefined ? { messages_enabled: Boolean(opts.messagesEnabled) } : {})) }, timeoutMs:110000 }); }
  control(op, id, more = {}) { return this.request(`/call/${op}`, { method:'POST', body:{ chat_id:Number(id), ...more }, timeoutMs: op === 'seek' ? 65000 : op === 'resume' ? 35000 : op === 'subcheck' ? 30000 : 20000 }); }
  sendCallMessage(id, text, more = {}) { return this.request('/call/message', { method:'POST', body:{ chat_id:Number(id), text:String(text || ''), ...more }, timeoutMs:12000 }); }
  updateCallSettings(id, settings = {}) { return this.request('/call/settings', { method:'POST', body:{ chat_id:Number(id), ...settings }, timeoutMs:12000 }); }
  deleteCallMessages(id, messageIds = []) { return this.request('/call/messages/delete', { method:'POST', body:{ chat_id:Number(id), message_ids:Array.isArray(messageIds) ? messageIds : [] }, timeoutMs:12000 }); }
  pause(id) { return this.control('pause', id); }
  resume(id) { return this.control('resume', id); }
  stop(id, options = {}) { return this.control('stop', id, { leave_membership: Boolean(options.leaveMembership) }); }
  existingGroupAccounts(id){return this.request('/destination/existing-group',{method:'POST',body:{chat_id:Number(id)},timeoutMs:65000});}
  async setup(id, stage, options = {}) { await this.ensureDaemon();return this.request('/destination/setup',{method:'POST',body:{chat_id:Number(id),stage,...options},timeoutMs:65000}); }
  idle(id) { return this.control('idle', id); }
  setVolume(id, volume) { return this.control('volume', id, { volume:Number(volume) }); }
  setSubtitle(id, subtitlePath, {
    subtitleOffset = null,
    subtitleSameRoute = null,
    manualOverride = null,
    subtitleRenderScreen = null,
    driftRate = null,
    driftAnchor = null
  } = {}) {
    const payload = { subtitle_path: subtitlePath || null };
    if (subtitleOffset !== null && subtitleOffset !== undefined && Number.isFinite(Number(subtitleOffset))) {
      payload.subtitle_offset = Number(subtitleOffset);
    }
    if (subtitleSameRoute !== null && subtitleSameRoute !== undefined) {
      payload.subtitle_same_route = Boolean(subtitleSameRoute);
    }
    if (manualOverride !== null && manualOverride !== undefined) {
      payload.subtitle_manual_override = Boolean(manualOverride);
    }
    if (subtitleRenderScreen !== null && subtitleRenderScreen !== undefined) {
      payload.subtitle_render_screen = Boolean(subtitleRenderScreen);
    }
    if (driftRate !== null && driftRate !== undefined && Number.isFinite(Number(driftRate))) {
      payload.sub_drift_sec_per_sec = Number(driftRate);
    }
    if (driftAnchor !== null && driftAnchor !== undefined && Number.isFinite(Number(driftAnchor))) {
      payload.sub_drift_anchor_sec = Number(driftAnchor);
    }
    return this.control('subtitle', id, payload);
  }
  checkSubtitleSync(id, { autoFix = true } = {}) {
    return this.control('subcheck', id, { auto_fix: Boolean(autoFix) });
  }
  getCallInviteLink(id) { return this.request(`/call/invite-link?chat_id=${Number(id)}`, { timeoutMs: 8000 }); }
  seek(id, seconds) { return this.control('seek', id, { seconds:Number(seconds) }); }
  getStatus(id) { return this.request(`/call/status?chat_id=${Number(id)}`); }
  accounts(id = null, refresh = false) { const params = new URLSearchParams();if(id!=null)params.set('chat_id',String(Number(id)));if(refresh)params.set('refresh','1');return this.request(`/accounts?${params}`, {timeoutMs:75000}); }
  registerAccount(account) { return this.request('/accounts/register', { method:'POST', body:account, timeoutMs:70000 }); }
  configureAccount(account) { return this.request('/accounts/configure', { method:'POST', body:account, timeoutMs:20000 }); }
  // Compatibility surface: unsafe Telegram login-code collection is intentionally retired.
  reload() { throw new MusicError('OWNER_SETUP', 'Use /accounts in the main owner private chat. Active accounts are never replaced automatically.'); }
  sendAuthCode() { throw new MusicError('OWNER_SETUP', 'Generate a session locally using service/voice/generate_session.py. Never send login codes to a bot.'); }
  verifyAuthCode() { return this.sendAuthCode(); }
  verifyAuthPassword() { return this.sendAuthCode(); }
  async cancelAuth() { return { ok: true }; }
}
