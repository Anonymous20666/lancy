import { Worker, MessageChannel } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { logger } from '../core/logger.js';
import { BuiltinProvider } from './providers/builtin.js';
import { QueueManager } from '../core/queue.js';
import { RealtimeVoiceCapability } from './realtimeVoice.js';

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

export const AI_PROVIDER_PRESETS = {
  experiential: {
    provider: 'openai-compatible',
    endpoint: 'https://api.experientiallabs.ai/v1',
    model: 'gpt-6.2-astra:free',
    backupProvider: 'openai-compatible',
    backupEndpoint: 'https://api.experientiallabs.ai/v1',
    backupModel: 'gemini-4-neon:free'
  },
  astra: {
    provider: 'openai-compatible',
    endpoint: 'https://api.experientiallabs.ai/v1',
    model: 'gpt-6.2-astra:free',
    backupProvider: 'openai-compatible',
    backupEndpoint: 'https://api.experientiallabs.ai/v1',
    backupModel: 'gemini-4-neon:free'
  },
  neon: {
    provider: 'openai-compatible',
    endpoint: 'https://api.experientiallabs.ai/v1',
    model: 'gemini-4-neon:free'
  },
  ollama: {
    provider: 'ollama',
    endpoint: 'http://127.0.0.1:11434',
    model: 'qwen2.5:7b'
  },
  gemini: {
    provider: 'openai-compatible',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash'
  },
  groq: {
    provider: 'openai-compatible',
    endpoint: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile'
  },
  openai: {
    provider: 'openai-compatible',
    endpoint: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini'
  }
};

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
    this.realtimeVoice = new RealtimeVoiceCapability({ settings: this.settings });
    this.enabled = settings?.get('ai.enabled') ?? true;
  }

  getCapabilities() {
    const primary = this.settings?.get('ai.model') || 'qwen2.5:7b';
    const backup = this.settings?.get('ai.backupModel') || null;
    const rt = this.realtimeVoice?.lastProbe || {
      model: 'gemini-3.8-live',
      available: false,
      reason: 'Not yet probed'
    };
    return {
      provider: this.providerName,
      primaryModel: primary,
      backupModel: backup,
      realtimeVoiceAvailable: Boolean(rt.available),
      realtimeVoiceModel: rt.model || 'gemini-3.8-live',
      realtimeVoiceReason: rt.reason || null
    };
  }

  async probeRealtimeVoice(opts = {}) {
    return await this.realtimeVoice.probe(opts);
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
    const endpoint = this.settings?.get('ai.endpoint') || 'http://127.0.0.1:11434';
    const envExplabs = this.settings?.env?.EXPLABS_API_KEY || process.env.EXPLABS_API_KEY || '';
    const apiKey = this.settings?.get('ai.apiKey') || (String(endpoint).includes('experientiallabs.ai') ? envExplabs : '') || '';
    const backupEndpoint = this.settings?.get('ai.backupEndpoint') || (this.settings?.get('ai.backupModel') ? endpoint : '');
    const backupApiKey = this.settings?.get('ai.backupApiKey') || (String(backupEndpoint).includes('experientiallabs.ai') ? (envExplabs || apiKey) : apiKey) || '';
    return {
      provider: this.settings?.get('ai.provider') || 'ollama',
      endpoint,
      model: this.settings?.get('ai.model') || 'qwen2.5:7b',
      apiKey,
      backupProvider: this.settings?.get('ai.backupProvider') || '',
      backupEndpoint,
      backupModel: this.settings?.get('ai.backupModel') || '',
      backupApiKey,
      timeoutMs: Math.min(45000, Math.max(2000, (this.settings?.get('ai.timeoutSeconds') ?? 32) * 1000))
    };
  }

  /** Hot reload: reconfigure the worker when safe settings change. */
  reconfigure() {
    if (!this.worker || !this.port) return;
    this.#send({ type: 'reconfigure', payload: { config: this.#config() } }).catch(() => {});
  }

  applyPreset({ preset = 'ollama', apiKey = '', model = '', endpoint = '' } = {}, db = null) {
    const key = String(preset || 'ollama').toLowerCase();
    const spec = AI_PROVIDER_PRESETS[key];
    if (!spec) throw new Error(`Unknown AI preset "${preset}". Use experiential, astra, neon, ollama, gemini, groq, or openai.`);
    const envExplabs = this.settings?.env?.EXPLABS_API_KEY || process.env.EXPLABS_API_KEY || '';
    const isDirectGoogleGemini = key === 'gemini' && String(apiKey || '').startsWith('AIza');
    const useExperientialForGemini = key === 'gemini' && !isDirectGoogleGemini && (String(apiKey || '').startsWith('xpl_') || Boolean(envExplabs));
    const nextProvider = spec.provider;
    const nextEndpoint = String(endpoint || (useExperientialForGemini ? 'https://api.experientiallabs.ai/v1' : spec.endpoint)).trim();
    const nextModel = String(model || (useExperientialForGemini ? 'gemini-4-neon:free' : spec.model)).trim();
    const effectiveKey = String(apiKey || (nextEndpoint.includes('experientiallabs.ai') ? envExplabs : '')).trim();
    const nextBackupProvider = spec.backupProvider || '';
    const nextBackupEndpoint = spec.backupEndpoint || '';
    const nextBackupModel = spec.backupModel || '';
    if (db?.setSetting) {
      db.setSetting('ai.provider', nextProvider);
      db.setSetting('ai.endpoint', nextEndpoint);
      db.setSetting('ai.model', nextModel);
      db.setSetting('ai.backupProvider', nextBackupProvider);
      db.setSetting('ai.backupEndpoint', nextBackupEndpoint);
      db.setSetting('ai.backupModel', nextBackupModel);
      if (effectiveKey) {
        db.setSetting('ai.apiKey', effectiveKey);
        if (nextBackupModel) db.setSetting('ai.backupApiKey', effectiveKey);
      } else if (key === 'ollama') {
        db.setSetting('ai.apiKey', '');
        db.setSetting('ai.backupApiKey', '');
      }
      this.settings?.load?.();
    } else if (this.settings?.values) {
      this.settings.values['ai.provider'] = nextProvider;
      this.settings.values['ai.endpoint'] = nextEndpoint;
      this.settings.values['ai.model'] = nextModel;
      this.settings.values['ai.backupProvider'] = nextBackupProvider;
      this.settings.values['ai.backupEndpoint'] = nextBackupEndpoint;
      this.settings.values['ai.backupModel'] = nextBackupModel;
      if (effectiveKey) {
        this.settings.values['ai.apiKey'] = effectiveKey;
        if (nextBackupModel) this.settings.values['ai.backupApiKey'] = effectiveKey;
      }
    }
    this.reconfigure();
    return { preset: key, provider: nextProvider, endpoint: nextEndpoint, model: nextModel, backupModel: nextBackupModel || null };
  }

  get providerName() {
    return this.settings?.get('ai.provider') ?? 'ollama';
  }

  async status() {
    if (!this.enabled) return { enabled: false, provider: 'disabled', available: false };
    if (this.providerName === 'builtin') return { enabled: true, provider: 'builtin', available: true, local: true };
    this.start();
    try {
      const available = await this.#send({ type: 'probe' }).then((r) => Boolean(r), () => false);
      return { enabled: true, provider: this.providerName, available, local: true };
    } catch {
      return { enabled: true, provider: this.providerName, available: false, local: true };
    }
  }

  /**
   * Generate text. Runs in the AI queue + worker thread; falls back to the
   * builtin provider on any failure.
   */
  async generate({ task = 'chat', style, text = '', context = {}, maxTokens, tools = null, messages = null, returnObject = false, preferBackup = false, reasoning = 'standard', signal } = {}) {
    if (!this.enabled) throw new Error('AI is disabled in Settings.');
    const styleName = style ?? this.settings?.get('ai.style') ?? 'girly';
    const backupModel = String(this.settings?.get('ai.backupModel') || '');
    const primaryModel = String(this.settings?.get('ai.model') || '');
    const hasImages = Array.isArray(context?.images) && context.images.length > 0;
    // Route complex/deep-reasoning/multimodal turns to Gemini 4 Neon when configured as backup (and Astra for fast everyday turns)
    const shouldPreferNeon = Boolean(
      preferBackup
      || ((reasoning === 'deep' || hasImages) && /gemini-4-neon/i.test(backupModel) && !/gemini-4-neon/i.test(primaryModel))
    );
    const max = maxTokens ?? this.settings?.get('ai.maxTokens') ?? (shouldPreferNeon ? 600 : 400);
    const payload = { task, style: styleName, text, context, maxTokens: max, preferBackup: shouldPreferNeon };
    if (Array.isArray(tools) && tools.length) payload.tools = tools;
    if (Array.isArray(messages) && messages.length) payload.messages = messages;
    if (returnObject) payload.returnObject = true;

    const job = {
      type: 'ai-generate',
      payload,
      run: async () => {
        this.start();
        if (this.worker && this.port) {
          try {
            const result = await this.#send({ type: 'generate', payload }, signal);
            if (result && typeof result === 'object' && ('toolCalls' in result || 'text' in result)) {
              return { ...result, provider: this.providerName };
            }
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
        if (returnObject || (Array.isArray(tools) && tools.length)) {
          return { text: text2, toolCalls: [], provider: 'builtin' };
        }
        return { text: text2, provider: 'builtin' };
      }
    };
    return this.queues.add('ai', job, { attempts: 1, signal });
  }

  chatWithTools({ system = '', messages = [], tools = [], text = '', style, maxTokens = 450, temperature = 0.35, preferBackup = false, reasoning = 'standard', images = null, signal } = {}) {
    return this.generate({
      task: 'chat',
      style,
      text,
      context: { ...(system ? { system } : {}), ...(Array.isArray(images) && images.length ? { images } : {}), temperature },
      tools,
      messages,
      returnObject: true,
      maxTokens,
      preferBackup,
      reasoning,
      signal
    });
  }

  deepReason({ system = '', messages = [], tools = [], text = '', style, maxTokens = 650, temperature = 0.35, images = null, signal } = {}) {
    return this.chatWithTools({
      system,
      messages,
      tools,
      text,
      style,
      maxTokens,
      temperature,
      preferBackup: true,
      reasoning: 'deep',
      images,
      signal
    });
  }

  async generateStream({ task = 'chat', style, text = '', context = {}, maxTokens, messages = null, onChunk = null, signal } = {}) {
    if (!this.enabled) throw new Error('AI is disabled in Settings.');
    const styleName = style ?? this.settings?.get('ai.style') ?? 'girly';
    const max = maxTokens ?? this.settings?.get('ai.maxTokens') ?? 260;
    const payload = { task, style: styleName, text, context, maxTokens: max };
    if (Array.isArray(messages) && messages.length) payload.messages = messages;

    const job = {
      type: 'ai-generate-stream',
      payload,
      run: async () => {
        this.start();
        if (this.worker && this.port) {
          try {
            let chunkCount = 0;
            const fullText = await this.#send(
              { type: 'generate_stream', payload },
              signal,
              (chunk, index) => {
                chunkCount += 1;
                onChunk?.(chunk, index);
              }
            );
            const clean = String(fullText || '').trim();
            if (clean && chunkCount === 0) onChunk?.(clean, 0);
            return { text: clean, provider: this.providerName, streamedChunks: chunkCount };
          } catch (error) {
            this.log.warn({ err: error }, 'ai stream failed — using builtin fallback');
            this.emit('fallback', { task, error: error.message });
          }
        }
        const text2 = await this.fallback.generate({ task, style: styleName, text, context, maxTokens: max });
        if (text2) onChunk?.(text2, 0);
        return { text: text2, provider: 'builtin', streamedChunks: text2 ? 1 : 0 };
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

  #send(request, signal, onChunk = null) {
    if (!this.worker || !this.port) return Promise.reject(new Error('AI worker is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('AI request timed out'));
      }, (this.settings?.get('ai.timeoutSeconds') ?? 32) * 1000 + 12000);
      if (timer.unref) timer.unref();
      this.pending.set(id, { resolve, reject, timer, onChunk });
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
    if (msg?.type === 'chunk') {
      try { entry.onChunk?.(msg.chunk, msg.index); } catch {}
      return;
    }
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
