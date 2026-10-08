import { Worker, MessageChannel } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { logger } from '../core/logger.js';
import { BuiltinProvider } from './providers/builtin.js';
import { QueueManager } from '../core/queue.js';

/**
 * AIService — the main-thread face of the AI worker.
 *
 * - Runs generation in a separate worker thread (never blocks the bot).
 * - Falls back to the builtin provider when the configured provider fails,
 *   so AI features degrade gracefully instead of breaking.
 * - Hot-reloads provider config when settings change (worker reconfigure).
 * - Talks to the worker over an explicit MessageChannel whose parent port is
 *   unref'd, so the worker can never keep the process alive on its own.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));

export class AIService extends EventEmitter {
  constructor({ settings, log } = {}) {
    super();
    this.settings = settings;
    this.log = log ?? logger().child({ module: 'ai' });
    this.worker = null;
    this.port = null;
    this.nextId = 1;
    this.pending = new Map();
    this.queues = new QueueManager({ ai: { concurrency: Math.max(1, settings?.get('performance.aiConcurrency') ?? 1) } });
    this.fallback = new BuiltinProvider();
    this.enabled = settings?.get('ai.enabled') ?? true;
  }

  start() {
    if (this.worker || !this.enabled) return;
    try {
      const channel = new MessageChannel();
      this.port = channel.port1;
      this.worker = new Worker(join(__dirname, 'worker.js'), {
        workerData: { config: this.#config(), port: channel.port2 },
        transferList: [channel.port2],
        stdout: false,
        stderr: false
      });
      this.port.on('message', (msg) => this.#onMessage(msg));
      // Unref AFTER attaching the listener (a listener refs the port) so the
      // worker can never keep the process alive on its own.
      this.port.unref();
      this.worker.on('error', (error) => {
        this.log.error({ err: error }, 'ai worker crashed — falling back to in-process builtin');
        this.worker = null;
        this.#rejectAll(error);
      });
      this.worker.on('exit', (code) => {
        if (code !== 0 && this.worker) {
          this.log.warn({ code }, 'ai worker exited — will restart on next request');
          this.worker = null;
        }
      });
    } catch (error) {
      this.log.error({ err: error }, 'ai worker failed to start — using builtin in-process');
      this.worker = null;
    }
  }

  async stop() {
    if (this.worker) {
      await this.worker.terminate().catch(() => {});
      this.worker = null;
    }
    if (this.port) {
      try { this.port.close(); } catch {}
      this.port = null;
    }
    this.#rejectAll(new Error('AI service stopped'));
  }

  #config() {
    return {
      provider: this.settings?.get('ai.provider') ?? 'builtin',
      endpoint: this.settings?.get('ai.endpoint') ?? 'http://127.0.0.1:11434',
      model: this.settings?.get('ai.model') ?? '',
      apiKey: this.settings?.get('ai.apiKey') ?? '',
      timeoutMs: (this.settings?.get('ai.timeoutSeconds') ?? 30) * 1000
    };
  }

  /** Hot reload: reconfigure the worker when safe settings change. */
  reconfigure() {
    if (!this.worker || !this.port) return;
    this.#send({ type: 'reconfigure', payload: { config: this.#config() } }).catch(() => {});
  }

  get providerName() {
    return this.settings?.get('ai.provider') ?? 'builtin';
  }

  async status() {
    if (!this.enabled) return { enabled: false, provider: 'disabled', available: false };
    if (this.providerName === 'builtin') return { enabled: true, provider: 'builtin', available: true, local: true };
    try {
      const available = await this.#send({ type: 'probe' }).then((r) => r.result, () => false);
      return { enabled: true, provider: this.providerName, available, local: true };
    } catch {
      return { enabled: true, provider: this.providerName, available: false, local: true };
    }
  }

  /**
   * Generate text. Runs in the AI queue + worker thread; falls back to the
   * builtin provider on any failure.
   */
  async generate({ task = 'chat', style, text = '', context = {}, maxTokens, signal } = {}) {
    if (!this.enabled) throw new Error('AI is disabled in Settings.');
    const styleName = style ?? this.settings?.get('ai.style') ?? 'girly';
    const max = maxTokens ?? this.settings?.get('ai.maxTokens') ?? 400;

    const job = {
      type: 'ai-generate',
      payload: { task, style: styleName, text, context, maxTokens: max },
      run: async () => {
        this.start();
        if (this.worker && this.port) {
          try {
            const result = await this.#send({ type: 'generate', payload: { task, style: styleName, text, context, maxTokens: max } }, signal);
            return { text: result, provider: this.providerName };
          } catch (error) {
            this.log.warn({ err: error }, 'ai provider failed — using builtin fallback');
            this.emit('fallback', { task, error: error.message });
          }
        }
        // Builtin fallback (also the default provider path when no worker).
        const fallbackProvider = this.settings?.get('ai.fallbackProvider') ?? 'builtin';
        if (fallbackProvider !== 'builtin') {
          this.log.warn({ fallbackProvider }, 'configured fallback is not builtin; using builtin anyway');
        }
        const text2 = await this.fallback.generate({ task, style: styleName, text, context, maxTokens: max });
        return { text: text2, provider: 'builtin' };
      }
    };
    return this.queues.add('ai', job, { attempts: 1, signal });
  }

  /** Convenience wrappers used across the app. */
  caption(context, { style } = {}) {
    return this.generate({ task: 'caption', text: context.query ?? '', context, style });
  }

  rewrite(text, { style } = {}) {
    return this.generate({ task: 'rewrite', text, style });
  }

  suggestName(query, { style } = {}) {
    return this.generate({ task: 'name', text: query, style, context: { query } });
  }

  chat(text, { style, history = [] } = {}) {
    return this.generate({ task: 'chat', text, style, context: { history } });
  }

  #send(request, signal) {
    if (!this.worker || !this.port) return Promise.reject(new Error('AI worker is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('AI request timed out'));
      }, (this.settings?.get('ai.timeoutSeconds') ?? 30) * 1000 + 5000);
      if (timer.unref) timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.port.postMessage({ id, ...request });
      signal?.addEventListener('abort', () => {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });
  }

  #onMessage(msg) {
    if (msg?.type === 'ready') {
      this.emit('ready', msg.provider);
      return;
    }
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(new Error(msg.error?.message ?? 'AI request failed'));
  }

  #rejectAll(error) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }
}
