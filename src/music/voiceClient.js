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
    const python = join(process.cwd(), 'service/voice/.venv/bin/python3'); const script = join(process.cwd(), 'service/voice/main.py');
    if (!existsSync(python) || !existsSync(script)) throw new MusicError('BRIDGE_UNAVAILABLE', 'Voice runtime is missing. The owner must install service/voice/requirements.txt in its venv.');
    if (!this.process) {
      this.process = spawn(python, [script], { env: { ...process.env, VOICE_BRIDGE_TOKEN: this.token, VOICE_BRIDGE_PORT: String(this.port), VOICE_BRIDGE_HOST: this.host, MUSIC_CACHE_DIR: this.app.musicLibrary.root }, stdio: ['ignore','ignore','ignore'] });
      this.process.once('error', () => { this.process = null; this.log.warn('Voice engine spawn failed'); });
      this.process.once('exit', code => { this.process = null; this.log.warn({ code }, 'Voice engine exited'); });
    }
    for (let i=0; i<30; i++) { await new Promise(r => setTimeout(r, 200)); const h = await this.checkHealth().catch(() => null); if (h?.protocol === 2) return true; if (!this.process) break; }
    throw new MusicError('BRIDGE_UNAVAILABLE', 'Voice engine did not start. Check the protected operator service logs.');
  }
  async stopDaemon() {
    this.closed = true; const proc = this.process; if (!proc) return;
    await new Promise(resolve => { const timer = setTimeout(resolve, 20000); proc.once('exit', () => { clearTimeout(timer); resolve(); }); proc.kill('SIGTERM'); });
  }
  async request(endpoint, { method = 'GET', body, timeoutMs = 10000 } = {}) {
    try {
      const r = await fetch(`${this.baseUrl}${endpoint}`, { method, headers: { 'Content-Type':'application/json', Authorization: `Bearer ${this.token}` }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      if (r.status === 401) throw new MusicError('BRIDGE_INCOMPATIBLE', 'The existing voice bridge is not authorized for this process. Do not start a competing player; arrange a controlled restart.');
      const data = await r.json(); if (!r.ok || !data.ok) { const error=new MusicError(data.error || 'BRIDGE_FAILURE', data.message || 'The playback engine rejected this operation.');if(data.publisher_state)error.publisherState=data.publisher_state;if(data.error_kind)error.backendKind=data.error_kind;throw error; } return data;
    } catch (error) { if (error instanceof MusicError) throw error; throw new MusicError('BRIDGE_UNAVAILABLE', 'The voice engine is unreachable or timed out. Check its status before retrying.'); }
  }
  checkHealth() { return this.request('/health', { timeoutMs: 1500 }); }
  async play(chatId, streamUrl, opts = {}) { await this.ensureDaemon(); return this.request('/call/play', { method:'POST', body: { chat_id:Number(chatId), stream_url:streamUrl, is_channel:Boolean(opts.isChannel), video:Boolean(opts.video), playback_id:opts.playbackId, account_alias:opts.accountAlias, duration_seconds:opts.durationSeconds, bass:Boolean(opts.bass) }, timeoutMs:110000 }); }
  control(op, id, more = {}) { return this.request(`/call/${op}`, { method:'POST', body:{ chat_id:Number(id), ...more }, timeoutMs: op === 'seek' ? 65000 : op === 'resume' ? 35000 : 20000 }); }
  pause(id) { return this.control('pause', id); }
  resume(id) { return this.control('resume', id); }
  stop(id) { return this.control('stop', id); }
  idle(id) { return this.control('idle', id); }
  setVolume(id, volume) { return this.control('volume', id, { volume:Number(volume) }); }
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
