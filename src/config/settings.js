import { EventEmitter } from 'node:events';
import { DEFAULT_SETTINGS, RESTART_REQUIRED_PATHS, mergeSettings, flattenSettings, applySettingPatch } from './defaults.js';
import { logger } from '../core/logger.js';

/**
 * SettingsManager — the single source of truth for configuration.
 *
 * - Loads defaults, overlays the DB, overlays env (env wins for secrets).
 * - `get(path)` / `set(path, value)` with dotted paths.
 * - Hot reload: safe paths emit 'change' immediately; restart-required
 *   paths are flagged honestly and require `requiresRestart()` to be called.
 */
export class SettingsManager extends EventEmitter {
  constructor(db, { env = {} } = {}) {
    super();
    this.db = db;
    this.env = env;
    this.log = logger().child({ module: 'settings' });
    this.values = structuredClone(DEFAULT_SETTINGS);
    this.restartRequired = new Set();
    this.#load();
  }

  #load() {
    // Overlay persisted settings (stored as one JSON blob per top category).
    for (const category of Object.keys(DEFAULT_SETTINGS)) {
      const stored = this.db.getSetting(`settings.${category}`);
      if (stored && typeof stored === 'object') {
        this.values[category] = mergeSettings(DEFAULT_SETTINGS[category], stored);
      }
    }
    // Env wins for secrets / identity.
    if (this.env.BOT_TOKEN) this.values.telegram.botToken = this.env.BOT_TOKEN;
    if (this.env.OWNER_IDS) {
      const ids = String(this.env.OWNER_IDS).split(',').map((s) => Number(s.trim())).filter(Boolean);
      this.values.general.ownerIds = ids;
      this.values.security.ownerIds = ids;
    }
    if (this.env.ADMIN_IDS) {
      this.values.telegram.adminIds = String(this.env.ADMIN_IDS).split(',').map((s) => Number(s.trim())).filter(Boolean);
    }
    if (this.env.AI_PROVIDER) this.values.ai.provider = this.env.AI_PROVIDER;
    if (this.env.AI_ENDPOINT) this.values.ai.endpoint = this.env.AI_ENDPOINT;
    if (this.env.AI_MODEL) this.values.ai.model = this.env.AI_MODEL;
    if (this.env.AI_API_KEY) this.values.ai.apiKey = this.env.AI_API_KEY;
    if (this.env.PINTEREST_PROVIDER) this.values.pinterest.provider = this.env.PINTEREST_PROVIDER;
    if (this.env.FFMPEG_PATH) this.values.media.ffmpegPath = this.env.FFMPEG_PATH;
  }

  /** Get a value by dotted path ('whatsapp.physicalStickerPackLimit'). */
  get(path, fallback = undefined) {
    const parts = path.split('.');
    let node = this.values;
    for (const part of parts) {
      if (node == null || typeof node !== 'object') return fallback;
      node = node[part];
    }
    return node === undefined ? fallback : node;
  }

  getAll() {
    return structuredClone(this.values);
  }

  /**
   * Set a value. Returns { applied, hotReloaded, restartRequired }.
   * Never pretends: restart-required paths are only marked, not applied
   * to live services until `applyRestart()` is called by the owner.
   */
  set(path, value) {
    const flat = flattenSettings(this.values);
    if (!(path in flat) && !this.#isKnownPath(path)) {
      throw new Error(`Unknown setting: ${path}`);
    }
    const requiresRestart = RESTART_REQUIRED_PATHS.has(path);
    this.values = applySettingPatch(this.values, path, value);

    // Persist the owning top-level category.
    const category = path.split('.')[0];
    this.db.setSetting(`settings.${category}`, this.values[category]);
    this.db.audit(null, 'settings.changed', { path, value: typeof value === 'string' && /token|key|secret/i.test(path) ? '***' : value });

    if (requiresRestart) {
      this.restartRequired.add(path);
      this.emit('restartRequired', { path, value });
      this.log.warn({ path }, 'setting changed but requires restart');
      return { applied: false, hotReloaded: false, restartRequired: true };
    }

    this.emit('change', { path, value, category });
    this.emit(`change:${category}`, { path, value });
    this.log.info({ path }, 'setting hot-reloaded');
    return { applied: true, hotReloaded: true, restartRequired: false };
  }

  #isKnownPath(path) {
    return path in flattenSettings(this.values);
  }

  /** True when any change needs a restart to take effect. */
  needsRestart() {
    return this.restartRequired.size > 0;
  }

  /** Called by the owner after a controlled restart; clears flags. */
  clearRestartFlags() {
    this.restartRequired.clear();
  }

  /** Live-apply a hot-reloaded category to a target object (service). */
  subscribe(service, mapping) {
    for (const [path, apply] of Object.entries(mapping)) {
      this.on('change', ({ path: changedPath, value }) => {
        if (changedPath === path) apply(value);
      });
    }
  }
}
