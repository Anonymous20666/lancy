import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, statSync, unlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { MusicError, KeyedLock } from './model.js';

export function isMusicOwner(app, id) {
  const owners = [...String(process.env.OWNER_IDS || '').split(','), ...(app.settings?.get('general.ownerIds') || [])].map(Number).filter(n => Number.isSafeInteger(n) && n > 0);
  return owners.includes(Number(id));
}
export class AccountStore {
  constructor({ db, root, voice }) { this.db = db; this.root = root; this.voice = voice; this.lock = new KeyedLock(); this.initialized = false; }
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
      // Migrate, do not replace, the previously configured single assistant. Default deny
      // destination access until the owner approves its chat IDs using /accounts allow.
      if (!this.db.getSetting('music.legacyImported') && !records.length && process.env.TELEGRAM_STRING_SESSION) {
        records.push({ alias:'legacy', enabled:true, allowed:[], encrypted:this.encrypt(process.env.TELEGRAM_STRING_SESSION) }); this.save(records); this.db.setSetting('music.legacyImported',true);
      }
      const live = await this.voice.accounts(); const known = new Set(live.accounts.map(a => a.alias));
      const failures = [];
      for (const record of records) if (record.enabled && !known.has(record.alias)) {
        try { await this.voice.registerAccount({ ...record, encrypted:undefined, session:this.decrypt(record.encrypted) }); }
        catch { failures.push(record.alias); }
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
      await this.voice.registerAccount({ alias, enabled:true, allowed:[], session });
      try{records.push({ alias, enabled:true, allowed:[], encrypted });this.save(records);}
      catch(error){await this.voice.configureAccount({alias,remove:true}).catch(()=>{});throw new MusicError('STORAGE_FAILED','Account registration could not be persisted. The protected staging file was retained.');}
      unlinkSync(path);
    });
  }
  async configure(alias, action, destination) {
    return this.lock.run('accounts', async () => {
      const records = this.records(); const record = records.find(a => a.alias === alias); if (!record) throw new MusicError('UNKNOWN_ACCOUNT','Unknown player account alias.');
      const next = { ...record, allowed:[...record.allowed] };
      if (action === 'enable' || action === 'disable') next.enabled = action === 'enable';
      else if (action === 'allow' || action === 'deny') {
        if (!Number.isSafeInteger(Number(destination)) || Number(destination) >= 0) throw new MusicError('INVALID_DESTINATION','Use a negative numeric group or channel ID.');
        next.allowed = next.allowed.filter(x => x !== String(destination)); if (action === 'allow') next.allowed.push(String(destination));
      } else if (action !== 'remove') throw new MusicError('INVALID_ACTION','Use register/list/enable/disable/remove/allow/deny.');
      await this.voice.ensureDaemon(); const live = await this.voice.accounts(); const exists = live.accounts.some(a => a.alias === alias);
      if (exists) await this.voice.configureAccount({ alias, enabled:next.enabled, allowed:next.allowed, remove:action === 'remove' });
      else if (next.enabled && action !== 'remove') await this.voice.registerAccount({ ...next, encrypted:undefined, session:this.decrypt(next.encrypted) });
      this.save(action === 'remove' ? records.filter(a => a.alias !== alias) : records.map(a => a.alias === alias ? next : a));
    });
  }
}
