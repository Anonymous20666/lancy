import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, statSync, unlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { MusicError, KeyedLock } from './model.js';

import { isBotSuperAdmin, getBotOwnerIds } from '../telegram/permissions.js';

export function isMusicOwner(app, id) {
  const uid = Number(id);
  return Number.isSafeInteger(uid) && uid > 0 && getBotOwnerIds(app).has(uid);
}

export function isMusicSuperAdmin(app, id, { controller = null } = {}) {
  return isBotSuperAdmin(app, id, { controller });
}

/**
 * Resolve a screen from the initiating bot/controller context first, then by session botId
 * on multiBotManager, falling back to the primary app screens map.
 */
export function resolveAppScreen(app, screenId, { ctx = null, session = null } = {}) {
  const fromCtx = ctx?.screens?.get?.(screenId) ?? ctx?.controller?.screens?.get?.(screenId);
  if (fromCtx) return fromCtx;
  const botId = Number(session?.botId ?? ctx?.botId ?? ctx?.controller?.botContext?.botId ?? 0);
  if (botId > 0) {
    const fromClone = app?.multiBotManager?.getRunningBot?.(botId)?.controller?.screens?.get?.(screenId);
    if (fromClone) return fromClone;
  }
  return app?.screens?.get?.(screenId) ?? null;
}

/**
 * True when ctx represents the same bot instance (or restarted clone botId/token) as the session.
 */
export function isSameMusicBot(session, ctx) {
  if (!session?.api) return true;
  if (session.api === ctx?.api) return true;
  const sessApiBotId = Number(session.api?.me?.id || 0);
  const ctxApiBotId = Number(ctx?.api?.me?.id || 0);
  if (sessApiBotId > 0 && ctxApiBotId > 0) return sessApiBotId === ctxApiBotId;
  if (session.api?.token && ctx?.api?.token) return session.api.token === ctx.api.token;
  const sessBotId = Number(session.botId ?? 0);
  const ctxBotId = Number(ctx?.botId ?? ctx?.controller?.botContext?.botId ?? 0);
  return sessBotId > 0 && ctxBotId > 0 && sessBotId === ctxBotId;
}
export class AccountStore {
  constructor({ db, root, voice, allowExistingMemberGroups=false }) { this.allowExistingMemberGroups=Boolean(allowExistingMemberGroups);this.db = db; this.root = root; this.voice = voice; this.lock = new KeyedLock(); this.initialized = false; this.retryAfter = new Map(); }
  key() {
    const dir = join(this.root, 'secrets'); mkdirSync(dir, { recursive:true, mode:0o700 });
    const path = join(dir,'music-session.key'); let key;
    if (process.env.MUSIC_SESSION_KEY) key = Buffer.from(process.env.MUSIC_SESSION_KEY, 'hex');
    else {
      try { if (lstatSync(path).isSymbolicLink()) throw new MusicError('UNSAFE_KEY', 'Session key must not be a symbolic link.'); key = readFileSync(path); }
      catch (e) { if (e.code !== 'ENOENT') throw e; key = randomBytes(32); writeFileSync(path, key, { mode:0o600, flag:'wx' }); }
      if ((statSync(path).mode & 0o077) !== 0) throw new MusicError('UNSAFE_KEY', 'Session encryption key must have mode 600.');
    }
    if (key.length !== 32) throw new MusicError('INVALID_KEY', 'MUSIC_SESSION_KEY must be a 32-byte hex key.'); return key;
  }
  encrypt(value) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.key(), iv); const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return [iv.toString('hex'),cipher.getAuthTag().toString('hex'),encrypted.toString('hex')].join('.'); }
  decrypt(value) { const [iv,tag,data] = value.split('.').map(x => Buffer.from(x,'hex')); const decipher = createDecipheriv('aes-256-gcm', this.key(), iv); decipher.setAuthTag(tag); return Buffer.concat([decipher.update(data),decipher.final()]).toString('utf8'); }
  records() { return this.db.getSetting('music.accounts') || []; }
  save(records) { this.db.setSetting('music.accounts', records); }
  async sync() {
    return this.lock.run('accounts', async () => {
      await this.voice.ensureDaemon();
      const records = this.records();
      // Migrate the configured assistant and approve it across all authorized chats ('*')
      // unless explicitly denied by the owner via /accounts deny.
      if (!this.db.getSetting('music.legacyImported') && !records.length && process.env.TELEGRAM_STRING_SESSION) {
        records.push({ alias:'legacy', enabled:true, allowed:['*'], encrypted:this.encrypt(process.env.TELEGRAM_STRING_SESSION) }); this.save(records); this.db.setSetting('music.legacyImported',true);
      }
      let upgraded = false;
      for (const record of records) {
        if (record.enabled && Array.isArray(record.allowed) && !record.allowed.includes('*') && !(record.denied || []).includes('*')) {
          record.allowed = ['*', ...record.allowed];
          upgraded = true;
        }
      }
      if (upgraded) this.save(records);
      const live = await this.voice.accounts();
      const liveByAlias = new Map(live.accounts.map(a => [a.alias, a]));
      const failures = [];
      for (const record of records) if (record.enabled) {
        const runtime = liveByAlias.get(record.alias);
        const needRecover = Boolean(runtime && runtime.status === 'authentication_required' && Date.now() >= (this.retryAfter.get(record.alias) || 0));
        if (!runtime || needRecover) {
          try {
            if (needRecover && typeof this.voice.configureAccount === 'function') {
              await this.voice.configureAccount({ alias: record.alias, remove: true }).catch(() => {});
            }
            const managed=this.db.getSetting('music.managedMemberships',{})||{};
            await this.voice.registerAccount({ ...record, encrypted:undefined, session:this.decrypt(record.encrypted), allow_existing_member_groups:this.allowExistingMemberGroups, managed_destinations:Object.entries(managed).filter(([,m])=>m.alias===record.alias).map(([id])=>Number(id)) });
            this.retryAfter.delete(record.alias);
          } catch (err) {
            this.retryAfter.set(record.alias, Date.now() + 30000);
            failures.push(record.alias);
            this.voice?.log?.warn?.({ alias: record.alias, code: err?.code, err: err?.message }, 'Failed to register playback account');
          }
        } else if (upgraded && typeof this.voice.configureAccount === 'function') {
          await this.voice.configureAccount({ alias:record.alias, enabled:record.enabled, allowed:record.allowed, denied:record.denied || [] }).catch(() => {});
        }
      }
      this.initialized = true; return failures;
    });
  }
  async register(alias) {
    if (!/^[a-z0-9_-]{1,24}$/.test(alias || '')) throw new MusicError('INVALID_ALIAS', 'Use a lowercase account alias, 1–24 letters, numbers, underscores or hyphens.');
    return this.lock.run('accounts', async () => {
      const records = this.records(); if (records.some(a => a.alias === alias) || records.length >= 8) throw new MusicError('ACCOUNT_LIMIT', 'That alias exists or the eight-account limit has been reached.');
      const path = join(this.root,'music-inbox',`${alias}.session`); const st = lstatSync(path);
      if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) || st.size > 4096) throw new MusicError('UNSAFE_SESSION_FILE', 'The staging session must be a regular file with mode 600, under 4 KB.');
      const session = readFileSync(path,'utf8').trim();
      if (!/^[A-Za-z0-9_=-]{100,2048}$/.test(session)) throw new MusicError('INVALID_SESSION', 'The staged file does not contain a supported Pyrogram session.');
      const encrypted=this.encrypt(session);
      await this.voice.ensureDaemon();
      await this.voice.registerAccount({ alias, enabled:true, allowed:['*'], session, allow_existing_member_groups:this.allowExistingMemberGroups });
      try{records.push({ alias, enabled:true, allowed:['*'], encrypted });this.save(records);}
      catch(error){await this.voice.configureAccount({alias,remove:true}).catch(()=>{});throw new MusicError('STORAGE_FAILED','Account registration could not be persisted. The protected staging file was retained.');}
      unlinkSync(path);
    });
  }
  async configure(alias, action, destination) {
    return this.lock.run('accounts', async () => {
      const records = this.records(); const record = records.find(a => a.alias === alias); if (!record) throw new MusicError('UNKNOWN_ACCOUNT','Unknown player account alias.');
      const next = { ...record, allowed:[...record.allowed], denied:[...(record.denied||[])] };
      if (action === 'enable' || action === 'disable') next.enabled = action === 'enable';
      else if (action === 'allow' || action === 'deny') {
        if (destination !== '*' && (!Number.isSafeInteger(Number(destination)) || Number(destination) >= 0)) throw new MusicError('INVALID_DESTINATION','Use a negative numeric group or channel ID.');
        next.allowed = next.allowed.filter(x => x !== String(destination));next.denied=next.denied.filter(x=>x!==String(destination)); if (action === 'allow') next.allowed.push(String(destination));else next.denied.push(String(destination));
      } else if (action !== 'remove') throw new MusicError('INVALID_ACTION','Use register/list/enable/disable/remove/allow/deny.');
      await this.voice.ensureDaemon(); const live = await this.voice.accounts(); const exists = live.accounts.some(a => a.alias === alias);
      if (exists) await this.voice.configureAccount({ alias, enabled:next.enabled, allowed:next.allowed, denied:next.denied, remove:action === 'remove' });
      else if (next.enabled && action !== 'remove') await this.voice.registerAccount({ ...next, encrypted:undefined, session:this.decrypt(next.encrypted), allow_existing_member_groups:this.allowExistingMemberGroups });
      this.save(action === 'remove' ? records.filter(a => a.alias !== alias) : records.map(a => a.alias === alias ? next : a));
    });
  }
}
