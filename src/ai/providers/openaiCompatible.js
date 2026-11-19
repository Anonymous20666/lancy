/**
 * OpenAI-compatible provider — any /v1/chat/completions endpoint
 * (LM Studio, LocalAI, OpenRouter, OpenAI itself…). API key optional for
 * local servers.
 */
import { BUILTIN_SYSTEM_PROMPTS } from './builtin.js';
import { consumeTokenStream } from './streamHelper.js';

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

  #effectiveMaxTokens(maxTokens) {
    const requested = Number(maxTokens) || 400;
    if (/gemini-4-neon|gemini-2\.5|gemini-3/i.test(String(this.model || ''))) {
      return Math.max(400, requested);
    }
    return requested;
  }

  #supportsSamplingTemp() {
    return !/(?:^|\/)(?:gpt-6(?:\.\d+)?-astra|o[134](?:-|$))/i.test(String(this.model || ''));
  }

  #formatMessages({ system, style, text, context = {}, explicitMessages = null }) {
    const sysContent = context.system ? system : `${system}\nStyle: ${style}. Personality: Lancy.`;
    const rawList = (Array.isArray(explicitMessages) && explicitMessages.length > 0)
      ? [
          ...(explicitMessages[0]?.role === 'system' ? [] : [{ role: 'system', content: sysContent }]),
          ...explicitMessages
        ]
      : [
          { role: 'system', content: sysContent },
          ...(Array.isArray(context.history) ? context.history.slice(-12).map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.content) })) : []),
          ...(text ? [{ role: 'user', content: text, images: context.images }] : [])
        ];

    return rawList.map((m) => {
      if (!m || typeof m !== 'object') return m;
      const out = { role: m.role };
      if (m.tool_call_id) out.tool_call_id = String(m.tool_call_id);
      if (m.name) out.name = String(m.name);

      // Normalize assistant tool_calls from either Ollama or OpenAI representation cleanly
      if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        out.tool_calls = m.tool_calls.map((tc, idx) => {
          const fn = tc?.function || {};
          const rawArgs = fn.arguments;
          const argStr = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs && typeof rawArgs === 'object' ? rawArgs : {});
          const normalized = {
            id: String(tc?.id || `call_${idx}`),
            type: 'function',
            function: { name: String(fn.name || ''), arguments: argStr }
          };
          if (tc?.thought_signature) normalized.thought_signature = tc.thought_signature;
          if (tc?.extra_content) normalized.extra_content = tc.extra_content;
          return normalized;
        });
      }

      // Preserve reasoning/thought signatures returned by Gemini/Experiential multi-turn tool calls
      if (m.reasoning_content !== undefined) out.reasoning_content = m.reasoning_content;
      if (m.thought_signature !== undefined) out.thought_signature = m.thought_signature;

      // Multimodal vision content blocks when images are attached
      const imgs = Array.isArray(m.images) ? m.images.filter(Boolean) : [];
      if (imgs.length > 0 && m.role === 'user') {
        const parts = [];
        const txt = String(m.content || '').trim();
        parts.push({ type: 'text', text: txt || 'Analyze the attached image carefully.' });
        for (const img of imgs.slice(0, 4)) {
          const url = typeof img === 'string' ? img : img?.url;
          if (url) parts.push({ type: 'image_url', image_url: { url } });
        }
        out.content = parts;
      } else {
        out.content = m.content ?? '';
      }
      return out;
    });
  }

  async generate({ task = 'chat', style = 'girly', text = '', context = {}, maxTokens = 400, tools = null, messages: explicitMessages = null, returnObject = false }) {
    const system = context.system || BUILTIN_SYSTEM_PROMPTS[task] || BUILTIN_SYSTEM_PROMPTS.chat;
    const hasTools = Array.isArray(tools) && tools.length > 0;
    const chatMessages = this.#formatMessages({ system, style, text, context, explicitMessages });
    const body = {
      model: this.model,
      messages: chatMessages,
      ...(hasTools ? { tools } : {}),
      max_tokens: this.#effectiveMaxTokens(maxTokens)
    };
    if (this.#supportsSamplingTemp()) {
      body.temperature = Number.isFinite(Number(context?.temperature)) ? Number(context.temperature) : (hasTools ? 0.35 : 0.7);
    }
    const response = await fetch(`${this.endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {})
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok) throw new Error(`endpoint HTTP ${response.status}`);
    const data = await response.json();
    const msg = data?.choices?.[0]?.message || {};
    const replyText = String(msg.content ?? '').trim();
    const toolCalls = Array.isArray(msg.tool_calls)
      ? msg.tool_calls.map((tc, idx) => {
          const fn = tc?.function || {};
          let args = fn.arguments;
          if (typeof args === 'string') {
            try { args = JSON.parse(args); } catch { args = {}; }
          }
          const callObj = {
            id: tc?.id || `call_${idx}`,
            type: 'function',
            function: { name: String(fn.name || '').trim(), arguments: (args && typeof args === 'object') ? args : {} }
          };
          if (tc?.thought_signature) callObj.thought_signature = tc.thought_signature;
          if (tc?.extra_content) callObj.extra_content = tc.extra_content;
          return callObj;
        }).filter(tc => tc.function.name)
      : [];
    if (!replyText && !toolCalls.length) {
      throw new Error('endpoint returned empty completion');
    }
    if (hasTools || returnObject) {
      return { text: replyText, toolCalls, rawMessage: msg, usage: data?.usage || null, model: data?.model || this.model };
    }
    return replyText;
  }

  async generateStream({ task = 'chat', style = 'girly', text = '', context = {}, maxTokens = 320, messages: explicitMessages = null, onSentence = null } = {}) {
    const system = context.system || BUILTIN_SYSTEM_PROMPTS[task] || BUILTIN_SYSTEM_PROMPTS.chat;
    const temperature = Number.isFinite(Number(context?.temperature)) ? Number(context.temperature) : 0.72;
    const chatMessages = this.#formatMessages({ system, style, text, context, explicitMessages });
    const body = {
      model: this.model,
      messages: chatMessages,
      max_tokens: this.#effectiveMaxTokens(maxTokens),
      stream: true
    };
    if (this.#supportsSamplingTemp()) {
      body.temperature = temperature;
    }
    const response = await fetch(`${this.endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {})
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok) throw new Error(`endpoint HTTP ${response.status}`);
    const full = await consumeTokenStream(
      response,
      (line) => {
        if (!line.startsWith('data:')) return '';
        const chunkBody = line.slice(5).trim();
        if (!chunkBody || chunkBody === '[DONE]') return '';
        try { return JSON.parse(chunkBody)?.choices?.[0]?.delta?.content || ''; } catch { return ''; }
      },
      onSentence
    );
    if (!full) throw new Error('endpoint returned empty stream');
    return full;
  }
}
