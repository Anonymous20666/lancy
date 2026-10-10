import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { logger } from '../core/logger.js';
import { WASession } from './session.js';
import { ensureSessionDir, removeDir } from '../utils/paths.js';
import { randomToken } from '../utils/hash.js';

/**
 * WhatsAppManager — owns MANY isolated WhatsApp sessions.
 *
 * Each session gets:
 *   - a unique session ID
 *   - an isolated credentials directory (chmod 700, files 600)
 *   - independent reconnect state and posting statistics
 *   - DB-persisted metadata (survives restarts; sessions auto-reconnect)
 *
 * Sessions never block each other: each WASession runs its own socket and
 * reconnect loop.
 */
export class WhatsAppManager extends EventEmitter {
  constructor({ db, settings, credsRoot, log } = {}) {
    super();
    this.db = db;
    this.settings = settings;
    this.credsRoot = credsRoot;
    this.log = log ?? logger().child({ module: 'wa-manager' });
    this.sessions = new Map(); // sessionId -> WASession
  }

  /** Restore sessions from the DB and reconnect the ones that were online. */
  async restore() {
    const rows = this.db.all('SELECT * FROM wa_sessions');
    for (const row of rows) {
      const session = this.#hydrate(row);
      this.sessions.set(row.session_id, session);
      this.#attach(session);
      if (row.status !== 'logged_out') {
        const credsFile = `${this.credsRoot}/sessions/${row.session_id}/creds.json`;
        if (existsSync(credsFile)) {
          session.start().catch((error) => {
            this.log.error({ err: error, sessionId: row.session_id }, 'restore start failed');
          });
        }
      }
    }
    return rows.length;
  }

  #hydrate(row) {
    const session = new WASession({
      sessionId: row.session_id,
      name: row.name,
      phone: row.phone,
      prefix: row.prefix ?? '.',
      credsDir: this.credsRoot,
      settings: this.settings
    });
    session.userId = row.user_id;
    session.jid = row.jid;
    session.status = row.status === 'online' ? 'offline' : row.status; // reconnect will set online
    session.reconnectState = row.reconnect_state ?? 'idle';
    session.stats = this.db.readJsonColumn(row, 'stats_json');
    session.lastConnected = row.last_connected;
    session.lastDisconnect = row.last_disconnect;
    return session;
  }

  #attach(session) {
    session.on('status', (status) => {
      this.#persistSession(session, { status });
      this.emit('status', { sessionId: session.sessionId, status });
    });
    session.on('online', ({ jid }) => {
      this.#persistSession(session, { status: 'online', jid, lastConnected: new Date().toISOString() });
      this.emit('online', { sessionId: session.sessionId, jid });
    });
    session.on('disconnect', ({ statusCode, reason, loggedOut }) => {
      this.#persistSession(session, {
        status: loggedOut ? 'logged_out' : 'offline',
        lastDisconnect: new Date().toISOString()
      });
      this.emit('disconnect', { sessionId: session.sessionId, statusCode, reason, loggedOut });
    });
    session.on('pairingCode', (code) => {
      this.emit('pairingCode', { sessionId: session.sessionId, code });
    });
    session.on('reconnecting', (info) => {
      this.#persistSession(session, { status: 'reconnecting', reconnectState: 'backing_off' });
      this.emit('reconnecting', { sessionId: session.sessionId, ...info });
    });
    session.on('command', (data) => {
      this.emit('command', data);
    });
    session.on('prefixChange', (prefix) => {
      this.db.run('UPDATE wa_sessions SET prefix = ? WHERE session_id = ?', prefix, session.sessionId);
    });
  }

  #persistSession(session, patch = {}) {
    const merged = {
      status: patch.status ?? session.status,
      reconnect_state: patch.reconnectState ?? session.reconnectState,
      jid: patch.jid ?? session.jid,
      last_connected: patch.lastConnected ?? session.lastConnected,
      last_disconnect: patch.lastDisconnect ?? session.lastDisconnect
    };
    session.reconnectState = merged.reconnect_state;
    this.db.run(
      `UPDATE wa_sessions
         SET status = ?, reconnect_state = ?, jid = ?, last_connected = ?, last_disconnect = ?,
             phone = ?, stats_json = ?, updated_at = datetime('now')
       WHERE session_id = ?`,
      merged.status, merged.reconnect_state, merged.jid, merged.last_connected,
      merged.last_disconnect, session.phone, JSON.stringify(session.stats), session.sessionId
    );
  }

  /** Create + persist a new session record and start it. */
  async createSession({ userId, name, phone = null }) {
    const sessionId = `wa_${randomToken(8)}`;
    ensureSessionDir(this.credsRoot, sessionId);
    this.db.run(
      `INSERT INTO wa_sessions (user_id, session_id, name, phone, jid, status, reconnect_state, creds_path, prefix)
       VALUES (?, ?, ?, ?, NULL, 'offline', 'idle', ?, '.')`,
      userId, sessionId, name, phone, `${this.credsRoot}/sessions/${sessionId}`
    );
    const session = new WASession({
      sessionId, name, phone,
      prefix: '.',
      credsDir: this.credsRoot,
      settings: this.settings
    });
    session.userId = userId;
    this.sessions.set(sessionId, session);
    this.#attach(session);
    this.db.audit(userId, 'wa.session.created', { sessionId, name, phone });
    return session;
  }

  get(sessionId) {
    return this.sessions.get(sessionId) ?? null;
  }

  list() {
    return [...this.sessions.values()].map((s) => this.describe(s));
  }

  listForUser(userId) {
    const rows = this.db.all('SELECT session_id FROM wa_sessions WHERE user_id = ?', userId);
    return rows.map((r) => this.sessions.get(r.session_id)).filter(Boolean).map((s) => this.describe(s));
  }

  describe(session) {
    if (!session) {
      return {
        sessionId: null,
        userId: null,
        name: 'Unknown',
        phone: null,
        jid: null,
        prefix: '.',
        status: 'offline',
        reconnectState: 'idle',
        pairingCode: null,
        lastConnected: null,
        lastDisconnect: null,
        stats: {}
      };
    }
    return {
      sessionId: session.sessionId,
      userId: session.userId ?? null,
      name: session.name,
      phone: session.phone,
      jid: session.jid,
      prefix: session.prefix ?? '.',
      status: session.status,
      reconnectState: session.reconnectState,
      pairingCode: session.pairingCode,
      lastConnected: session.lastConnected,
      lastDisconnect: session.lastDisconnect,
      stats: session.stats
    };
  }

  async startSession(sessionId) {
    const session = this.get(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    await session.start();
    return this.describe(session);
  }

  async requestPairing(sessionId, phoneDigits, customPairingCode = null) {
    const session = this.get(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    this.db.run('UPDATE wa_sessions SET phone = ?, status = ? WHERE session_id = ?', phoneDigits, 'pairing', sessionId);
    session.phone = phoneDigits;
    return session.requestPairingCode(phoneDigits, customPairingCode);
  }

  async logoutSession(sessionId, { deleteCreds = true } = {}) {
    const session = this.get(sessionId);
    if (session) {
      await session.logout().catch(() => {});
      await session.destroy().catch(() => {});
    }
    if (deleteCreds) {
      removeDir(`${this.credsRoot}/sessions/${sessionId}`);
      this.db.run('DELETE FROM wa_sessions WHERE session_id = ?', sessionId);
      this.sessions.delete(sessionId);
    } else {
      this.db.run('UPDATE wa_sessions SET status = ?, updated_at = datetime(\'now\') WHERE session_id = ?', 'logged_out', sessionId);
    }
    this.db.audit(null, 'wa.session.logout', { sessionId, deleteCreds });
    return true;
  }

  async removeSession(sessionId) {
    return this.logoutSession(sessionId, { deleteCreds: true });
  }

  async stopAll() {
    await Promise.all([...this.sessions.values()].map((s) => s.destroy().catch(() => {})));
  }
}
