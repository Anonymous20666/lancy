/**
 * OpenAI-compatible provider — any /v1/chat/completions endpoint
 * (LM Studio, LocalAI, OpenRouter, OpenAI itself…). API key optional for
 * local servers.
 */
import { BUILTIN_SYSTEM_PROMPTS } from './builtin.js';

export class OpenAICompatibleProvider {
  constructor({ endpoint = 'http://127.0.0.1:1234/v1', model = 'local', apiKey = '', timeoutMs = 30000 } = {}) {
    this.name = 'openai-compatible';
    this.endpoint = endpoint.replace(/\/$/, '');
    this.model = model;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.available = null;
  }

  async probe() {
    try {
      const response = await fetch(`${this.endpoint}/models`, {
        headers: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {},
        signal: AbortSignal.timeout(3000)
      });
      this.available = response.ok;
      return this.available;
    } catch {
      this.available = false;
      return false;
    }
  }

  async generate({ task = 'chat', style = 'girly', text = '', context = {}, maxTokens = 400 }) {
    const system = BUILTIN_SYSTEM_PROMPTS[task] ?? BUILTIN_SYSTEM_PROMPTS.chat;
    const response = await fetch(`${this.endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: `${system}\nStyle: ${style}. Personality: Lancy.` },
          { role: 'user', content: text }
        ],
        max_tokens: maxTokens,
        temperature: 0.7
      }),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok) throw new Error(`endpoint HTTP ${response.status}`);
    const data = await response.json();
    return String(data?.choices?.[0]?.message?.content ?? '').trim();
  }
}
