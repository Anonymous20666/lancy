/**
 * Ollama provider — local, lightweight models (llama3.2, qwen2.5, etc.).
 * CPU-friendly, no paid API. Talks to the local ollama HTTP endpoint.
 */
import { BUILTIN_SYSTEM_PROMPTS } from './builtin.js';

export class OllamaProvider {
  constructor({ endpoint = 'http://127.0.0.1:11434', model = 'qwen2.5:0.5b', timeoutMs = 30000 } = {}) {
    this.name = 'ollama';
    this.endpoint = endpoint.replace(/\/$/, '');
    this.model = model && model.trim() ? model.trim() : 'qwen2.5:0.5b';
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
    const defaultSystem = BUILTIN_SYSTEM_PROMPTS[task] ?? BUILTIN_SYSTEM_PROMPTS.chat;
    const system = context.system ?? `${defaultSystem}\nStyle: ${style}. Personality: Lancy — warm, playful, feminine, confident, slightly Gen-Z, never robotic.`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      if (context.history && Array.isArray(context.history) && context.history.length > 0) {
        // Multi-turn chat using Ollama /api/chat
        const historyMessages = context.history.map((h) => ({
          role: h.role === 'assistant' ? 'assistant' : 'user',
          content: String(h.content)
        }));
        const last = historyMessages[historyMessages.length - 1];
        const messages = [{ role: 'system', content: system }, ...historyMessages];
        if (!last || last.role !== 'user' || last.content !== String(text)) {
          messages.push({ role: 'user', content: String(text) });
        }
        const res = await fetch(`${this.endpoint}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: this.model,
            messages,
            stream: false,
            options: { num_predict: maxTokens, temperature: 0.7 }
          }),
          signal: controller.signal
        });
        if (res.ok) {
          const data = await res.json();
          return String(data.message?.content ?? '').trim();
        }
      }

      const body = {
        model: this.model,
        system,
        prompt: text,
        stream: false,
        options: { num_predict: maxTokens, temperature: 0.7 }
      };
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
