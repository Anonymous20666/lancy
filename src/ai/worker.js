import { parentPort, workerData } from 'node:worker_threads';
import { BuiltinProvider } from './providers/builtin.js';
import { OllamaProvider } from './providers/ollama.js';
import { OpenAICompatibleProvider } from './providers/openaiCompatible.js';

/**
 * AI worker thread — AI generation NEVER blocks Telegram, WhatsApp,
 * Pinterest, sticker conversion or publishing. Requests are serialized here
 * (aiConcurrency = 1 by default) and answered via message passing.
 *
 * Talks over an explicit transferred MessagePort when provided; the parent
 * unrefs its end so the worker can never keep the process alive.
 */
const port = workerData?.port ?? parentPort;

function createProvider(config, { timeoutOverrideMs = null } = {}) {
  const timeoutMs = timeoutOverrideMs ?? config.timeoutMs;
  switch (config.provider) {
    case 'ollama':
      return new OllamaProvider({ endpoint: config.endpoint, model: config.model, timeoutMs });
    case 'openai-compatible':
      return new OpenAICompatibleProvider({ endpoint: config.endpoint, model: config.model, apiKey: config.apiKey, timeoutMs });
    case 'builtin':
    default:
      return new BuiltinProvider();
  }
}

function createBackupProvider(config) {
  const model = String(config?.backupModel || '').trim();
  const providerType = String(config?.backupProvider || (model ? config?.provider : '') || '').trim();
  if (!model || !providerType || providerType === 'builtin') return null;
  const endpoint = String(config?.backupEndpoint || config?.endpoint || '').trim();
  const apiKey = String(config?.backupApiKey || config?.apiKey || '').trim();
  if (providerType === config.provider && endpoint === config.endpoint && model === config.model) {
    return null;
  }
  return createProvider({ provider: providerType, endpoint, model, apiKey, timeoutMs: config.timeoutMs });
}

const config = workerData?.config ?? {};
let backupProvider = createBackupProvider(config);
let provider = createProvider(config, {
  timeoutOverrideMs: backupProvider ? Math.min(20000, Number(config.timeoutMs || 32000)) : config.timeoutMs
});

async function handle(request) {
  const { id, type, payload } = request;
  try {
    if (type === 'generate') {
      const preferBackup = Boolean(payload?.preferBackup && backupProvider);
      const first = preferBackup ? backupProvider : provider;
      const second = preferBackup ? provider : backupProvider;
      let result;
      try {
        result = await first.generate(payload);
      } catch (firstErr) {
        if (!second) throw firstErr;
        result = await second.generate(payload);
      }
      port.postMessage({ id, ok: true, result });
    } else if (type === 'generate_stream') {
      let emitted = 0;
      const runStream = (p) => (typeof p.generateStream === 'function'
        ? p.generateStream({
            ...payload,
            onSentence: (chunk, index) => {
              emitted += 1;
              port.postMessage({ id, type: 'chunk', chunk, index });
            }
          })
        : p.generate(payload));
      const preferBackup = Boolean(payload?.preferBackup && backupProvider);
      const first = preferBackup ? backupProvider : provider;
      const second = preferBackup ? provider : backupProvider;
      let result;
      try {
        result = await runStream(first);
      } catch (firstErr) {
        if (!second || emitted > 0) throw firstErr;
        result = await runStream(second);
      }
      port.postMessage({ id, ok: true, result });
    } else if (type === 'reconfigure') {
      backupProvider = createBackupProvider(payload.config);
      provider = createProvider(payload.config, {
        timeoutOverrideMs: backupProvider ? Math.min(20000, Number(payload.config?.timeoutMs || 32000)) : payload.config?.timeoutMs
      });
      port.postMessage({ id, ok: true, result: true });
    } else if (type === 'probe') {
      let ok = typeof provider.probe === 'function' ? await provider.probe() : provider.available !== false;
      if (!ok && backupProvider) {
        ok = typeof backupProvider.probe === 'function' ? await backupProvider.probe() : backupProvider.available !== false;
      }
      port.postMessage({ id, ok: true, result: ok });
    } else {
      throw new Error(`unknown request type: ${type}`);
    }
  } catch (error) {
    port.postMessage({ id, ok: false, error: { message: error.message, name: error.name } });
  }
}

port.on('message', (request) => {
  void handle(request);
});

port.postMessage({ type: 'ready', provider: provider.name });
