import { EventEmitter } from 'node:events';
import { logger } from './logger.js';
import { backoffDelay, sleep } from '../utils/retry.js';

/**
 * JobQueue — persistent-backed-capable, concurrency-limited job runner.
 *
 * - Named queues with per-queue concurrency (worker pools per concern:
 *   telegram, whatsapp, pinterest, stickers, ai, media).
 * - Retries with exponential backoff + jitter.
 * - Cancellation via AbortSignal.
 * - Backpressure: max pending jobs per queue; overflow waits.
 * - Events: 'started', 'done', 'failed', 'retry', 'cancelled', 'drained'.
 *
 * Jobs are plain objects: { id?, type, payload, userId?, run(job, ctx) }.
 * Persistence is layered on top by the JobStore (DB) — this class is the
 * in-memory execution engine.
 */
export class JobQueue extends EventEmitter {
  constructor({ name = 'default', concurrency = 2, maxPending = 500, log } = {}) {
    super();
    this.name = name;
    this.concurrency = Math.max(1, concurrency);
    this.maxPending = maxPending;
    this.log = log ?? logger().child({ module: 'queue', queue: name });
    this.pending = [];
    this.running = new Map(); // id -> { job, signal }
    this.nextId = 1;
    this.paused = false;
  }

  get size() {
    return this.pending.length;
  }

  get activeCount() {
    return this.running.size;
  }

  /**
   * Enqueue a job. Returns a promise that resolves with the job result
   * (or rejects on failure/cancellation).
   */
  async add(job, { attempts = 3, signal, baseMs = 800, maxMs = 60000 } = {}) {
    if (this.pending.length >= this.maxPending) {
      await this.waitForRoom(signal);
    }
    const fullJob = {
      id: job.id ?? `${this.name}-${this.nextId++}`,
      type: job.type ?? 'generic',
      payload: job.payload ?? {},
      userId: job.userId ?? null,
      attempts,
      baseMs,
      maxMs,
      attempt: 0,
      enqueuedAt: Date.now(),
      run: job.run
    };

    if (typeof fullJob.run !== 'function') {
      throw new Error('Job must define run(job, ctx)');
    }

    const promise = new Promise((resolve, reject) => {
      fullJob._resolve = resolve;
      fullJob._reject = reject;
    });

    this.pending.push({ job: fullJob, signal });
    this.emit('enqueued', fullJob);
    this.#pump();
    return promise;
  }

  async waitForRoom(signal) {
    while (this.pending.length >= this.maxPending && !this.paused) {
      await Promise.race([sleep(250), signal ? abortPromise(signal) : new Promise(() => {})]);
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    }
  }

  cancel(id) {
    const idx = this.pending.findIndex((p) => p.job.id === id);
    if (idx >= 0) {
      const [entry] = this.pending.splice(idx, 1);
      entry.job._reject?.(new DOMException('Job cancelled', 'AbortError'));
      this.emit('cancelled', entry.job);
      return true;
    }
    const running = this.running.get(id);
    if (running) {
      running.controller.abort();
      return true;
    }
    return false;
  }

  cancelAll() {
    for (const entry of this.pending.splice(0)) {
      entry.job._reject?.(new DOMException('Job cancelled', 'AbortError'));
    }
    for (const { controller } of this.running.values()) controller.abort();
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    this.#pump();
  }

  async drained() {
    while (this.pending.length > 0 || this.running.size > 0) {
      await sleep(100);
    }
  }

  #pump() {
    while (!this.paused && this.running.size < this.concurrency && this.pending.length > 0) {
      const { job, signal } = this.pending.shift();
      void this.#execute(job, signal).catch((error) => {
        this.log.error({ err: error, jobId: job.id }, 'unhandled job error');
      });
    }
    if (this.pending.length === 0 && this.running.size === 0) {
      this.emit('drained');
    }
  }

  async #execute(job, externalSignal) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    externalSignal?.addEventListener('abort', onAbort, { once: true });
    this.running.set(job.id, { job, signal: externalSignal, controller });

    const ctx = {
      signal: controller.signal,
      attempt: job.attempt,
      queue: this,
      log: this.log.child({ jobId: job.id, jobType: job.type }),
      isCancelled: () => controller.signal.aborted
    };

    try {
      for (;;) {
        job.attempt += 1;
        this.emit('started', job);
        try {
          const result = await job.run(job, ctx);
          job._resolve?.(result);
          this.emit('done', job, result);
          return;
        } catch (error) {
          if (controller.signal.aborted || error?.name === 'AbortError') {
            job._reject?.(error);
            this.emit('cancelled', job);
            return;
          }
          const canRetry = job.attempt < job.attempts && isRetryable(error);
          if (!canRetry) {
            job._reject?.(error);
            this.emit('failed', job, error);
            return;
          }
          const delay = backoffDelay(job.attempt, { baseMs: job.baseMs, maxMs: job.maxMs });
          this.emit('retry', job, error, delay);
          this.log.warn({ err: error, attempt: job.attempt, delay }, 'job failed, retrying');
          await sleep(delay);
        }
      }
    } finally {
      externalSignal?.removeEventListener('abort', onAbort);
      this.running.delete(job.id);
      this.#pump();
    }
  }
}

function isRetryable(error) {
  if (!error) return true;
  if (error.retryable === false) return false;
  if (error.name === 'AbortError') return false;
  // Validation/domain errors are not retryable by default.
  if (error.code && /INVALID|BAD_|NOT_FOUND|FORBIDDEN|UNAUTHORIZED|VALIDATION/.test(error.code)) return false;
  return true;
}

function abortPromise(signal) {
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
}

/**
 * QueueManager — a set of named queues for the whole app.
 */
export class QueueManager extends EventEmitter {
  constructor(defaults = {}) {
    super();
    this.queues = new Map();
    this.defaults = defaults;
  }

  queue(name, opts = {}) {
    if (!this.queues.has(name)) {
      const cfg = { ...(this.defaults[name] ?? {}), ...opts };
      const q = new JobQueue({ name, ...cfg });
      q.on('failed', (job, error) => this.emit('failed', name, job, error));
      q.on('done', (job, result) => this.emit('done', name, job, result));
      this.queues.set(name, q);
    }
    return this.queues.get(name);
  }

  add(queueName, job, opts) {
    return this.queue(queueName).add(job, opts);
  }

  cancel(queueName, id) {
    return this.queues.get(queueName)?.cancel(id) ?? false;
  }

  async shutdown() {
    for (const q of this.queues.values()) q.cancelAll();
    await Promise.all([...this.queues.values()].map((q) => q.drained().catch(() => {})));
  }
}
