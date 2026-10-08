/**
 * Ollama provider — local, lightweight models (llama3.2, qwen2.5, etc.).
 * CPU-friendly, no paid API. Talks to the local ollama HTTP endpoint.
 */
import { BUILTIN_SYSTEM_PROMPTS } from './builtin.js';

export class OllamaProvider {
  constructor({ endpoint = 'http://127.0.0.1:11434', model = 'llama3.2', timeoutMs = 30000 } = {}) {
    this.name = 'ollama';
    this.endpoint = endpoint.replace(/\/$/, '');
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.available = null; // unknown until probed
  }

  async probe() {
    try {
      const response = await fetch(`${this.endpoint}/api/tags`, { signal: AbortSignal.timeout(3000) });
      this.available = response.ok;
      return this.available;
    } catch {
      this.available = false;
      return false;
    }
  }

  async generate({ task = 'chat', style = 'girly', text = '', context = {}, maxTokens = 400 }) {
    const system = BUILTIN_SYSTEM_PROMPTS[task] ?? BUILTIN_SYSTEM_PROMPTS.chat;
    const body = {
      model: this.model,
      system: `${system}\nStyle: ${style}. Personality: Lancy — warm, playful, feminine, confident, slightly Gen-Z, never robotic.`,
      prompt: text,
      stream: false,
      options: { num_predict: maxTokens, temperature: 0.7 }
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.endpoint}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`ollama HTTP ${response.status}`);
      const data = await response.json();
      return String(data.response ?? '').trim();
    } finally {
      clearTimeout(timer);
    }
  }
}
