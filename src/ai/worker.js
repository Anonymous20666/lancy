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

function createProvider(config) {
  switch (config.provider) {
    case 'ollama':
      return new OllamaProvider({ endpoint: config.endpoint, model: config.model, timeoutMs: config.timeoutMs });
    case 'openai-compatible':
      return new OpenAICompatibleProvider({ endpoint: config.endpoint, model: config.model, apiKey: config.apiKey, timeoutMs: config.timeoutMs });
    case 'builtin':
    default:
      return new BuiltinProvider();
  }
}

const config = workerData?.config ?? {};
let provider = createProvider(config);

async function handle(request) {
  const { id, type, payload } = request;
  try {
    if (type === 'generate') {
      const result = await provider.generate(payload);
      port.postMessage({ id, ok: true, result });
    } else if (type === 'reconfigure') {
      provider = createProvider(payload.config);
      port.postMessage({ id, ok: true, result: true });
    } else if (type === 'probe') {
      const ok = typeof provider.probe === 'function' ? await provider.probe() : provider.available !== false;
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
