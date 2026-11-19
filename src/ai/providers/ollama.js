/**
 * Ollama provider — local, lightweight models (llama3.2, qwen2.5, etc.).
 * CPU-friendly, no paid API. Talks to the local ollama HTTP endpoint.
 */
import { BUILTIN_SYSTEM_PROMPTS } from './builtin.js';
import { consumeTokenStream } from './streamHelper.js';

export class OllamaProvider {
  constructor({ endpoint = 'http://127.0.0.1:11434', model = 'qwen2.5:7b', timeoutMs = 42000 } = {}) {
    this.name = 'ollama';
    this.endpoint = endpoint.replace(/\/$/, '');
    this.model = model && model.trim() ? model.trim() : 'qwen2.5:7b';
    this.timeoutMs = Math.min(45000, Math.max(2000, Number(timeoutMs) || 42000));
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

  #normalizeToolCalls(rawCalls) {
    if (!Array.isArray(rawCalls)) return [];
    return rawCalls.map((tc, idx) => {
      const fn = tc?.function || {};
      let args = fn.arguments;
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { args = {}; }
      }
      return {
        id: tc?.id || `call_${idx}`,
        function: {
          name: String(fn.name || '').trim(),
          arguments: (args && typeof args === 'object') ? args : {}
        }
      };
    }).filter((tc) => tc.function.name);
  }

  async generate({ task = 'chat', style = 'girly', text = '', context = {}, maxTokens = 400, tools = null, messages: explicitMessages = null, returnObject = false }) {
    const defaultSystem = BUILTIN_SYSTEM_PROMPTS[task] ?? BUILTIN_SYSTEM_PROMPTS.chat;
    const system = context.system ?? `${defaultSystem}\nStyle: ${style}. Personality: Lancy — warm, playful, feminine, confident, slightly Gen-Z, never robotic.`;
    const hasTools = Array.isArray(tools) && tools.length > 0;
    const temperature = Number.isFinite(Number(context?.temperature)) ? Number(context.temperature) : (hasTools ? 0.35 : 0.7);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      if (hasTools || Array.isArray(explicitMessages) || returnObject) {
        const chatMessages = [];
        if (Array.isArray(explicitMessages) && explicitMessages.length > 0) {
          if (explicitMessages[0]?.role !== 'system' && system) {
            chatMessages.push({ role: 'system', content: system });
          }
          for (const m of explicitMessages) {
            if (!m || !m.role) continue;
            const item = { role: m.role, content: String(m.content ?? '') };
            if (Array.isArray(m.tool_calls) && m.tool_calls.length) item.tool_calls = m.tool_calls;
            if (m.tool_name) item.tool_name = m.tool_name;
            chatMessages.push(item);
          }
        } else {
          chatMessages.push({ role: 'system', content: system });
          if (Array.isArray(context.history)) {
            for (const h of context.history) {
              chatMessages.push({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.content) });
            }
          }
          if (text) chatMessages.push({ role: 'user', content: String(text) });
        }

        const res = await fetch(`${this.endpoint}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: this.model,
            messages: chatMessages,
            ...(hasTools ? { tools } : {}),
            keep_alive: '60m',
            stream: false,
            options: { num_predict: maxTokens, temperature, num_ctx: 3072, num_thread: 12 }
          }),
          signal: controller.signal
        });
        if (!res.ok) throw new Error(`ollama HTTP ${res.status}`);
        const data = await res.json();
        const msg = data.message || {};
        const toolCalls = this.#normalizeToolCalls(msg.tool_calls);
        const replyText = String(msg.content ?? '').trim();
        if (hasTools || returnObject) {
          return { text: replyText, toolCalls, rawMessage: msg };
        }
        return replyText;
      }

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
            keep_alive: '60m',
            stream: false,
            options: { num_predict: maxTokens, temperature, num_ctx: 3072, num_thread: 12 }
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
        keep_alive: '60m',
        stream: false,
        options: { num_predict: maxTokens, temperature, num_ctx: 3072, num_thread: 12 }
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

  async generateStream({ task = 'chat', style = 'girly', text = '', context = {}, maxTokens = 260, messages: explicitMessages = null, onSentence = null } = {}) {
    const defaultSystem = BUILTIN_SYSTEM_PROMPTS[task] ?? BUILTIN_SYSTEM_PROMPTS.chat;
    const system = context.system ?? `${defaultSystem}\nStyle: ${style}. Personality: Lancy.`;
    const temperature = Number.isFinite(Number(context?.temperature)) ? Number(context.temperature) : 0.78;
    const chatMessages = Array.isArray(explicitMessages) && explicitMessages.length > 0
      ? explicitMessages
      : [
          { role: 'system', content: system },
          ...(Array.isArray(context.history) ? context.history.slice(-10).map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.content) })) : []),
          ...(text ? [{ role: 'user', content: String(text) }] : [])
        ];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.endpoint}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: chatMessages,
          keep_alive: '60m',
          stream: true,
          options: { num_predict: maxTokens, temperature, num_ctx: 3072, num_thread: 12 }
        }),
        signal: controller.signal
      });
      if (!res.ok) throw new Error(`ollama HTTP ${res.status}`);
      return await consumeTokenStream(
        res,
        (line) => {
          try { return JSON.parse(line)?.message?.content || ''; } catch { return ''; }
        },
        onSentence
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
