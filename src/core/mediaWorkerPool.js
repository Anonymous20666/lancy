import { Worker } from 'node:worker_threads';
import { availableParallelism, cpus } from 'node:os';
import { EventEmitter } from 'node:events';

const WORKER_SCRIPT = `
const { parentPort } = require('node:worker_threads');
const { execFile } = require('node:child_process');
const { readFile, writeFile, stat } = require('node:fs/promises');

parentPort.on('message', async (msg) => {
  const { id, type, payload } = msg || {};
  try {
    if (type === 'exec') {
      const { bin, args = [], options = {} } = payload;
      const result = await new Promise((resolve, reject) => {
        execFile(bin, args, {
          timeout: options.timeout || 120000,
          maxBuffer: options.maxBuffer || 8 * 1024 * 1024,
          windowsHide: true
        }, (err, stdout, stderr) => {
          if (err) {
            err.stdout = stdout;
            err.stderr = stderr;
            reject(err);
            return;
          }
          resolve({ stdout, stderr });
        });
      });
      parentPort.postMessage({ id, ok: true, result });
      return;
    }
    if (type === 'ffprobe_json') {
      const { ffprobeBin = 'ffprobe', args = [], timeout = 15000 } = payload;
      const result = await new Promise((resolve, reject) => {
        execFile(ffprobeBin, args, {
          timeout,
          maxBuffer: 4 * 1024 * 1024,
          windowsHide: true
        }, (err, stdout) => {
          if (err) return reject(err);
          try {
            resolve(JSON.parse(stdout || '{}'));
          } catch (parseErr) {
            reject(parseErr);
          }
        });
      });
      parentPort.postMessage({ id, ok: true, result });
      return;
    }
    if (type === 'copy_file') {
      const { src, dest } = payload;
      const buf = await readFile(src);
      await writeFile(dest, buf);
      const st = await stat(dest);
      parentPort.postMessage({ id, ok: true, result: { size: st.size } });
      return;
    }
    throw new Error('Unsupported worker task type: ' + type);
  } catch (err) {
    parentPort.postMessage({
      id,
      ok: false,
      error: {
        message: err?.message || String(err),
        code: err?.code || 'WORKER_ERROR',
        stderr: err?.stderr ? String(err.stderr).slice(0, 1000) : undefined
      }
    });
  }
});
`;

/**
 * Multi-Worker Media & Song Delivery Pool for High-Traffic (1,000+ User) Group Chats.
 * - Spawns real Node.js worker_threads for off-main-thread FFmpeg/ffprobe/IO work.
 * - Provides a fair per-user round-robin async task scheduler so heavy media/song
 *   requests from many concurrent group members run in parallel across worker lanes
 *   without blocking the main Telegram event loop or starving other users.
 */
export class MediaWorkerPool extends EventEmitter {
  constructor({
    size = Math.min(8, Math.max(4, (typeof availableParallelism === 'function' ? availableParallelism() : cpus()?.length) || 4)),
    maxConcurrentJobs = Math.max(12, size * 3),
    maxPerUser = 3
  } = {}) {
    super();
    this.size = size;
    this.maxConcurrentJobs = maxConcurrentJobs;
    this.maxPerUser = maxPerUser;
    this.workers = [];
    this.idleWorkers = [];
    this.workerWaiters = [];
    this.inflightMessages = new Map();
    this.nextMsgId = 1;

    // Fair async job lanes (per-user round-robin queue)
    this.activeJobs = 0;
    this.userActiveCounts = new Map(); // userKey -> count
    this.userQueues = new Map(); // userKey -> Array<job>
    this.roundRobinUsers = [];
    this.completedJobs = 0;
    this.closed = false;
  }

  #ensureWorkers() {
    if (this.closed || this.workers.length > 0) return;
    for (let i = 0; i < this.size; i++) {
      this.#spawnWorker(i);
    }
  }

  #spawnWorker(index) {
    if (this.closed) return null;
    const worker = new Worker(WORKER_SCRIPT, { eval: true });
    worker._poolIndex = index;
    worker._busy = false;

    worker.on('message', (msg) => {
      const entry = this.inflightMessages.get(msg?.id);
      if (entry) {
        this.inflightMessages.delete(msg.id);
        clearTimeout(entry.timer);
        this.#releaseWorker(worker);
        if (msg.ok) entry.resolve(msg.result);
        else {
          const err = new Error(msg.error?.message || 'Worker task failed');
          err.code = msg.error?.code || 'WORKER_ERROR';
          err.stderr = msg.error?.stderr;
          entry.reject(err);
        }
      }
    });

    worker.on('error', () => {
      this.#handleWorkerExit(worker);
    });

    worker.on('exit', () => {
      this.#handleWorkerExit(worker);
    });

    // Unref AFTER attaching the 'message' listener (attaching 'message' refs the
    // worker's MessagePort), so idle pool workers never keep tests/CLI alive.
    worker.unref();

    this.workers.push(worker);
    this.idleWorkers.push(worker);
    return worker;
  }

  #handleWorkerExit(worker) {
    const idx = this.workers.indexOf(worker);
    if (idx !== -1) this.workers.splice(idx, 1);
    const idleIdx = this.idleWorkers.indexOf(worker);
    if (idleIdx !== -1) this.idleWorkers.splice(idleIdx, 1);
    for (const [id, entry] of this.inflightMessages.entries()) {
      if (entry.worker === worker) {
        this.inflightMessages.delete(id);
        clearTimeout(entry.timer);
        entry.reject(new Error('Worker thread exited unexpectedly'));
      }
    }
    if (!this.closed && this.workers.length < this.size) {
      const replacement = this.#spawnWorker(worker._poolIndex ?? 0);
      if (replacement && this.workerWaiters.length > 0) {
        const nextWaiter = this.workerWaiters.shift();
        const rIdx = this.idleWorkers.indexOf(replacement);
        if (rIdx !== -1) this.idleWorkers.splice(rIdx, 1);
        replacement._busy = true;
        nextWaiter(replacement);
      }
    }
  }

  async #acquireWorker() {
    this.#ensureWorkers();
    if (this.idleWorkers.length > 0) {
      const w = this.idleWorkers.shift();
      w._busy = true;
      return w;
    }
    return new Promise((resolve) => {
      this.workerWaiters.push(resolve);
    });
  }

  #releaseWorker(worker) {
    worker._busy = false;
    if (this.workerWaiters.length > 0) {
      const waiter = this.workerWaiters.shift();
      worker._busy = true;
      waiter(worker);
    } else if (!this.closed && this.workers.includes(worker)) {
      this.idleWorkers.push(worker);
      worker.unref?.();
    } else {
      worker.unref?.();
    }
  }

  /**
   * Dispatch a task directly to a worker_threads instance.
   */
  async dispatchWorkerTask(type, payload, { timeoutMs = 120000 } = {}) {
    if (this.closed) throw new Error('MediaWorkerPool is closed');
    const worker = await this.#acquireWorker();
    const id = this.nextMsgId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.inflightMessages.delete(id);
        this.#releaseWorker(worker);
        reject(new Error(`MediaWorkerPool task (${type}) timed out after ${timeoutMs}ms`));
      }, timeoutMs + 2000);
      timer.unref?.();
      this.inflightMessages.set(id, { worker, resolve, reject, timer });
      worker.ref?.();
      worker.postMessage({ id, type, payload });
    });
  }

  execInWorker(bin, args = [], options = {}) {
    return this.dispatchWorkerTask('exec', { bin, args, options }, { timeoutMs: options.timeout || 120000 });
  }

  probeInWorker(ffprobeBin, args = [], timeout = 15000) {
    return this.dispatchWorkerTask('ffprobe_json', { ffprobeBin, args, timeout }, { timeoutMs: timeout + 2000 });
  }

  /**
   * Fair multi-worker job scheduler for concurrent group chat requests.
   * Ensures a 1,000-user group chat can process up to `maxConcurrentJobs` media/song
   * jobs simultaneously while round-robining fairly across distinct users.
   */
  schedule(userKey, fn) {
    const key = String(userKey || 'anon');
    return new Promise((resolve, reject) => {
      const job = { key, fn, resolve, reject };
      let q = this.userQueues.get(key);
      if (!q) {
        q = [];
        this.userQueues.set(key, q);
      }
      q.push(job);
      if (!this.roundRobinUsers.includes(key)) {
        this.roundRobinUsers.push(key);
      }
      this.#drainJobs();
    });
  }

  #drainJobs() {
    while (this.activeJobs < this.maxConcurrentJobs && this.roundRobinUsers.length > 0) {
      let pickedJob = null;
      const checkedCount = this.roundRobinUsers.length;
      for (let i = 0; i < checkedCount; i++) {
        const userKey = this.roundRobinUsers.shift();
        const q = this.userQueues.get(userKey);
        if (!q || q.length === 0) {
          this.userQueues.delete(userKey);
          continue;
        }
        const userActive = this.userActiveCounts.get(userKey) || 0;
        if (userActive >= this.maxPerUser) {
          this.roundRobinUsers.push(userKey);
          continue;
        }
        pickedJob = q.shift();
        if (q.length > 0) {
          this.roundRobinUsers.push(userKey);
        } else {
          this.userQueues.delete(userKey);
        }
        break;
      }

      if (!pickedJob) break;

      this.activeJobs++;
      const prevUserActive = this.userActiveCounts.get(pickedJob.key) || 0;
      this.userActiveCounts.set(pickedJob.key, prevUserActive + 1);

      Promise.resolve()
        .then(() => pickedJob.fn())
        .then(
          (res) => pickedJob.resolve(res),
          (err) => pickedJob.reject(err)
        )
        .finally(() => {
          this.activeJobs = Math.max(0, this.activeJobs - 1);
          this.completedJobs++;
          const nextUserActive = (this.userActiveCounts.get(pickedJob.key) || 1) - 1;
          if (nextUserActive <= 0) this.userActiveCounts.delete(pickedJob.key);
          else this.userActiveCounts.set(pickedJob.key, nextUserActive);
          this.#drainJobs();
        });
    }
  }

  stats() {
    let queuedJobs = 0;
    for (const q of this.userQueues.values()) queuedJobs += q.length;
    return {
      workerThreads: this.size,
      spawnedThreads: this.workers.length,
      idleThreads: this.idleWorkers.length,
      activeJobs: this.activeJobs,
      queuedJobs,
      maxConcurrentJobs: this.maxConcurrentJobs,
      completedJobs: this.completedJobs
    };
  }

  async shutdown() {
    this.closed = true;
    const toTerminate = [...this.workers];
    this.workers.length = 0;
    this.idleWorkers.length = 0;
    await Promise.allSettled(toTerminate.map((w) => w.terminate()));
  }
}

let sharedPool = null;
export function getSharedMediaWorkerPool(options) {
  if (!sharedPool || sharedPool.closed) {
    sharedPool = new MediaWorkerPool(options);
  }
  return sharedPool;
}
