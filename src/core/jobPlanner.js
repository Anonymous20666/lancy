import os from 'node:os';
import { EventEmitter } from 'node:events';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { logger } from './logger.js';
import { backoffDelay, sleep } from '../utils/retry.js';

export const JOB_LANES = {
  critical: 0,
  interactive: 10,
  media: 20,
  broadcast: 30,
  background: 40
};

/**
 * Embedded SQLite-backed Priority Job Planner & Adaptive Stress-Relief Engine.
 *
 * Replaces external Redis/BullMQ daemons without adding extra process overhead:
 * - Monitors live CPU load, heap/RSS memory, Node.js event-loop lag, and active VC streams.
 * - Executes work across 5 strict priority lanes (`critical` -> `background`) with
 *   dynamic concurrency scaling & cooperative event-loop yielding under load.
 * - Deduplicates identical queued jobs (`dedupeKey`) and persists durable jobs in
 *   the SQLite `jobs` table so scheduled/background jobs survive restarts.
 */
export class JobPlanner extends EventEmitter {
  constructor({
    db = null,
    queues = null,
    settings = null,
    log = null,
    maxConcurrency = 8,
    getStressSignals = null,
    persistPollMs = 5000
  } = {}) {
    super();
    this.db = db;
    this.queues = queues;
    this.settings = settings;
    this.log = log ?? logger().child({ module: 'job-planner' });
    this.baseConcurrency = Math.max(2, Number(maxConcurrency) || 8);
    this.getStressSignals = typeof getStressSignals === 'function' ? getStressSignals : () => ({});
    this.persistPollMs = Math.max(1000, Number(persistPollMs) || 5000);

    this.pending = []; // { id, lane, priority, dedupeKey, runAt, fn, resolve, reject, enqueuedAt }
    this.active = new Map(); // id -> { lane, startedAt, dedupeKey }
    this.dedupeMap = new Map(); // dedupeKey -> promise
    this.handlers = new Map(); // persistent job type -> async (payload, row) => result
    this.seq = 1;
    this.closed = false;

    this.stats = {
      completedTotal: 0,
      failedTotal: 0,
      coalescedTotal: 0,
      deferredForStress: 0,
      yieldsTotal: 0
    };

    this._eld = null;
    this._monitorTimer = null;
    this._persistTimer = null;
    this._delayTimers = new Set();
    this._cachedStress = null;
    this._cachedStressAt = 0;
  }

  start() {
    if (this.closed) return this;
    if (!this._eld) {
      try {
        this._eld = monitorEventLoopDelay({ resolution: 25 });
        this._eld.enable();
      } catch {
        this._eld = null;
      }
    }
    this.recoverStaleJobs();
    if (!this._monitorTimer) {
      this._monitorTimer = setInterval(() => {
        this.sampleStress(true);
        this.#pump();
      }, 2500);
      this._monitorTimer.unref?.();
    }
    if (this.db && !this._persistTimer) {
      this._persistTimer = setInterval(() => {
        void this.processPersistentDue().catch(() => {});
      }, this.persistPollMs);
      this._persistTimer.unref?.();
    }
    return this;
  }

  async shutdown() {
    this.closed = true;
    if (this._monitorTimer) {
      clearInterval(this._monitorTimer);
      this._monitorTimer = null;
    }
    if (this._persistTimer) {
      clearInterval(this._persistTimer);
      this._persistTimer = null;
    }
    for (const t of this._delayTimers) clearTimeout(t);
    this._delayTimers.clear();
    if (this._eld) {
      try { this._eld.disable(); } catch {}
      this._eld = null;
    }
    for (const item of this.pending.splice(0)) {
      item.reject?.(new DOMException('JobPlanner shutting down', 'AbortError'));
    }
    this.dedupeMap.clear();
  }

  registerHandler(type, fn) {
    if (typeof fn === 'function') this.handlers.set(String(type), fn);
  }

  sampleStress(force = false) {
    const now = Date.now();
    if (!force && this._cachedStress && (now - this._cachedStressAt) < 1500) {
      return this._cachedStress;
    }
    const cpuCount = Math.max(1, os.cpus()?.length || 4);
    const load1m = os.loadavg?.()[0] ?? 0;
    const cpuLoadRatio = Number((load1m / cpuCount).toFixed(2));

    let eventLoopLagMs = 0;
    if (this._eld) {
      const p95Ns = Number(this._eld.percentile?.(95) || this._eld.mean || 0);
      eventLoopLagMs = Number((p95Ns / 1e6).toFixed(1));
      if (Number.isFinite(eventLoopLagMs) && eventLoopLagMs > 5000) eventLoopLagMs = 0;
      try { this._eld.reset(); } catch {}
    }

    let rssMb = 256;
    try {
      const mem = process.memoryUsage();
      rssMb = Math.round(mem.rss / (1024 * 1024));
    } catch {
      rssMb = Math.round((process.memoryUsage.rss?.() || 268435456) / (1024 * 1024));
    }
    const totalMemMb = Math.max(512, Math.round(os.totalmem() / (1024 * 1024)));
    const memPct = Math.round((rssMb / totalMemMb) * 100);
    const ext = this.getStressSignals() || {};
    const activeVcCount = Math.max(0, Number(ext.activeVcCount || 0));

    let pressureLevel = 'nominal';
    if (eventLoopLagMs >= 250 || cpuLoadRatio >= 1.65 || memPct >= 88) {
      pressureLevel = 'critical';
    } else if (eventLoopLagMs >= 100 || cpuLoadRatio >= 1.15 || activeVcCount >= 5 || memPct >= 75) {
      pressureLevel = 'high';
    } else if (eventLoopLagMs >= 40 || cpuLoadRatio >= 0.75 || activeVcCount >= 3 || rssMb >= 1400) {
      pressureLevel = 'elevated';
    }

    const cfgWorker = Number(this.settings?.get?.('performance.workerConcurrency') ?? this.baseConcurrency) || this.baseConcurrency;
    const maxEff = Math.max(2, Math.min(24, cfgWorker));
    const concurrencyLimit = pressureLevel === 'critical'
      ? Math.max(2, Math.floor(maxEff * 0.25))
      : pressureLevel === 'high'
        ? Math.max(2, Math.floor(maxEff * 0.45))
        : pressureLevel === 'elevated'
          ? Math.max(3, Math.floor(maxEff * 0.7))
          : maxEff;

    this._cachedStress = {
      pressureLevel,
      eventLoopLagMs,
      load1m: Number(load1m.toFixed(2)),
      cpuCount,
      cpuLoadRatio,
      rssMb,
      memPct,
      activeVcCount,
      concurrencyLimit,
      sampledAt: now
    };
    this._cachedStressAt = now;
    return this._cachedStress;
  }

  shouldDeferBackground() {
    const { pressureLevel } = this.sampleStress();
    if (pressureLevel === 'high' || pressureLevel === 'critical') {
      this.stats.deferredForStress += 1;
      return true;
    }
    return false;
  }

  async yieldIfStressed(lane = 'background') {
    if (lane === 'critical') return;
    const { pressureLevel } = this.sampleStress();
    if (pressureLevel === 'nominal') {
      if (lane === 'broadcast' || lane === 'background') {
        await new Promise((r) => setImmediate(r));
      }
      return;
    }
    this.stats.yieldsTotal += 1;
    const baseDelay = pressureLevel === 'critical' ? 320 : pressureLevel === 'high' ? 120 : 30;
    const mult = lane === 'background' ? 1.5 : lane === 'broadcast' ? 1.0 : 0.5;
    await sleep(Math.round(baseDelay * mult));
  }

  /**
   * Schedule an in-memory priority job with optional deduplication & delayed runAt.
   */
  schedule(lane = 'media', optsOrFn = {}, maybeFn = null) {
    const fn = typeof optsOrFn === 'function' ? optsOrFn : maybeFn;
    const opts = typeof optsOrFn === 'function' ? {} : (optsOrFn || {});
    if (typeof fn !== 'function') return Promise.reject(new Error('JobPlanner.schedule requires a runner function'));
    if (this.closed) return Promise.reject(new DOMException('JobPlanner is closed', 'AbortError'));

    const normalizedLane = Object.prototype.hasOwnProperty.call(JOB_LANES, lane) ? lane : 'media';
    const dedupeKey = opts.dedupeKey ? `${normalizedLane}:${opts.dedupeKey}` : null;
    if (dedupeKey && this.dedupeMap.has(dedupeKey)) {
      this.stats.coalescedTotal += 1;
      return this.dedupeMap.get(dedupeKey);
    }

    const delayMs = Math.max(0, Number(opts.delayMs || 0));
    const runAt = opts.runAt ? Number(new Date(opts.runAt).getTime() || Date.now()) : (Date.now() + delayMs);
    const id = opts.id || `jp-${this.seq++}`;

    const promise = new Promise((resolve, reject) => {
      const entry = {
        id,
        lane: normalizedLane,
        priority: JOB_LANES[normalizedLane],
        dedupeKey,
        runAt,
        fn,
        resolve,
        reject,
        enqueuedAt: Date.now()
      };
      this.pending.push(entry);
      this.pending.sort((a, b) => (a.priority - b.priority) || (a.runAt - b.runAt) || (a.enqueuedAt - b.enqueuedAt));
      if (runAt > Date.now()) {
        const waitMs = Math.min(60000, runAt - Date.now());
        const timer = setTimeout(() => {
          this._delayTimers.delete(timer);
          this.#pump();
        }, waitMs);
        timer.unref?.();
        this._delayTimers.add(timer);
      } else {
        this.#pump();
      }
    });

    if (dedupeKey) {
      this.dedupeMap.set(dedupeKey, promise);
      promise.finally(() => {
        if (this.dedupeMap.get(dedupeKey) === promise) this.dedupeMap.delete(dedupeKey);
      }).catch(() => {});
    }
    return promise;
  }

  #canDispatch(entry, stress) {
    if (entry.runAt > Date.now()) return false;
    // Critical lane ALWAYS gets an emergency slot unless catastrophically overloaded
    if (entry.lane === 'critical') {
      return this.active.size < (stress.concurrencyLimit + 6);
    }
    if (entry.lane === 'interactive') {
      return this.active.size < (stress.concurrencyLimit + 2);
    }
    if (entry.lane === 'background' && (stress.pressureLevel === 'critical' || stress.pressureLevel === 'high')) {
      return false;
    }
    if (entry.lane === 'broadcast' && stress.pressureLevel === 'critical') {
      return false;
    }
    return this.active.size < stress.concurrencyLimit;
  }

  #pump() {
    if (this.closed || !this.pending.length) return;
    const stress = this.sampleStress();

    for (let i = 0; i < this.pending.length;) {
      const entry = this.pending[i];
      if (!this.#canDispatch(entry, stress)) {
        i++;
        continue;
      }
      this.pending.splice(i, 1);
      this.active.set(entry.id, { lane: entry.lane, startedAt: Date.now(), dedupeKey: entry.dedupeKey });

      Promise.resolve()
        .then(() => entry.fn({ id: entry.id, lane: entry.lane, stress }))
        .then((res) => {
          this.stats.completedTotal += 1;
          entry.resolve(res);
        })
        .catch((err) => {
          this.stats.failedTotal += 1;
          entry.reject(err);
        })
        .finally(() => {
          this.active.delete(entry.id);
          this.#pump();
        });
    }
  }

  // ── Persistent SQLite `jobs` table API (Redis/BullMQ durability across restarts) ──

  enqueuePersistent(type, payload = {}, { userId = null, maxAttempts = 3, delayMs = 0, runAt = null } = {}) {
    if (!this.db) return null;
    const nextRun = runAt
      ? new Date(runAt).toISOString()
      : (delayMs > 0 ? new Date(Date.now() + delayMs).toISOString() : new Date().toISOString());
    const info = this.db.run(
      `INSERT INTO jobs (user_id, type, payload_json, status, attempts, max_attempts, next_run_at)
       VALUES (?, ?, ?, 'pending', 0, ?, ?)`,
      userId != null ? Number(userId) : null,
      String(type),
      JSON.stringify(payload ?? {}),
      Math.max(1, Number(maxAttempts) || 3),
      nextRun
    );
    return Number(info?.lastInsertRowid || 0) || null;
  }

  recoverStaleJobs() {
    if (!this.db) return 0;
    try {
      const info = this.db.run(
        `UPDATE jobs SET status = 'pending', updated_at = datetime('now') WHERE status = 'running'`
      );
      return Number(info?.changes || 0);
    } catch {
      return 0;
    }
  }

  async processPersistentDue({ limit = 6 } = {}) {
    if (!this.db || this.closed) return 0;
    if (this.shouldDeferBackground()) return 0;
    const nowIso = new Date().toISOString();
    const due = this.db.all(
      `SELECT * FROM jobs
       WHERE status = 'pending' AND (next_run_at IS NULL OR next_run_at <= ?)
       ORDER BY id ASC LIMIT ?`,
      nowIso,
      Math.max(1, limit)
    ) || [];

    let processed = 0;
    for (const row of due) {
      const handler = this.handlers.get(row.type);
      if (!handler) continue;
      this.db.run(
        `UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = datetime('now') WHERE id = ?`,
        row.id
      );
      let payload = {};
      try { payload = JSON.parse(row.payload_json || '{}'); } catch {}

      await this.schedule('background', { id: `dbjob-${row.id}` }, async () => {
        try {
          const result = await handler(payload, row);
          this.db.run(
            `UPDATE jobs SET status = 'done', result_json = ?, error = NULL, updated_at = datetime('now') WHERE id = ?`,
            JSON.stringify(result ?? {}),
            row.id
          );
          processed += 1;
        } catch (err) {
          const attemptsDone = Number(row.attempts || 0) + 1;
          const maxAtt = Math.max(1, Number(row.max_attempts || 3));
          if (attemptsDone >= maxAtt) {
            this.db.run(
              `UPDATE jobs SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?`,
              String(err?.message || 'Job failed').slice(0, 400),
              row.id
            );
          } else {
            const delayMs = backoffDelay(attemptsDone, { baseMs: 2000, maxMs: 60000 });
            const retryIso = new Date(Date.now() + delayMs).toISOString();
            this.db.run(
              `UPDATE jobs SET status = 'pending', error = ?, next_run_at = ?, updated_at = datetime('now') WHERE id = ?`,
              String(err?.message || 'Retrying').slice(0, 400),
              retryIso,
              row.id
            );
          }
        }
      }).catch(() => {});
    }
    return processed;
  }

  getStats() {
    const stress = this.sampleStress();
    const queuedByLane = { critical: 0, interactive: 0, media: 0, broadcast: 0, background: 0 };
    for (const item of this.pending) {
      queuedByLane[item.lane] = (queuedByLane[item.lane] || 0) + 1;
    }
    let persistent = null;
    if (this.db) {
      try {
        const rows = this.db.all(`SELECT status, COUNT(*) AS cnt FROM jobs GROUP BY status`) || [];
        persistent = { pending: 0, running: 0, done: 0, failed: 0 };
        for (const r of rows) {
          if (r?.status) persistent[r.status] = Number(r.cnt || 0);
        }
      } catch {}
    }
    const queueStats = {};
    if (this.queues?.queues) {
      for (const [qName, qObj] of this.queues.queues.entries()) {
        queueStats[qName] = { pending: qObj.size || 0, active: qObj.activeCount || 0 };
      }
    }
    return {
      ...stress,
      activeJobs: this.active.size,
      pendingJobs: this.pending.length,
      queuedByLane,
      queues: queueStats,
      persistent,
      ...this.stats
    };
  }
}
