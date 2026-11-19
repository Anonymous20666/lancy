/**
 * Dynamic Streamable-HTTP MCP client for BrowserOS neo (`/mcp` + `/v1/sessions/...` + `/system/ready`).
 * Supports JSON and SSE (`text/event-stream`) responses, dynamic `tools/list` capability discovery,
 * token auth headers, health monitoring, backoff reconnect, cancellation, and clean teardown.
 */

const MCP_PROTOCOL_VERSION = '2025-06-18';

export class BrowserOSMCPClient {
  constructor({
    mcpUrl = 'http://127.0.0.1:9010/mcp',
    baseUrl = '',
    apiToken = '',
    clientName = 'lancy-ai',
    agentName = 'lancy',
    log = null,
    fetchImpl = null
  } = {}) {
    this.mcpUrl = String(mcpUrl || 'http://127.0.0.1:9010/mcp').trim();
    this.baseUrl = String(baseUrl || this.mcpUrl.replace(/\/mcp\/?$/i, '')).replace(/\/+$/, '');
    this.apiToken = String(apiToken || '').trim();
    this.clientName = String(clientName || 'lancy-ai');
    this.agentName = String(agentName || 'lancy');
    this.log = log || null;
    this.fetchImpl = fetchImpl || globalThis.fetch;

    this.sessionId = null;
    this.initialized = false;
    this.serverInfo = null;
    this.tools = new Map();
    this.nextRpcId = 0;
    this.connectPromise = null;
    this.lastHealthyAt = 0;
    this.lastError = null;
  }

  setEndpoint({ mcpUrl, baseUrl, apiToken } = {}) {
    const nextMcp = String(mcpUrl || this.mcpUrl).trim();
    const nextBase = String(baseUrl || nextMcp.replace(/\/mcp\/?$/i, '')).replace(/\/+$/, '');
    const changed = nextMcp !== this.mcpUrl || nextBase !== this.baseUrl || (apiToken !== undefined && apiToken !== this.apiToken);
    if (changed) {
      this.mcpUrl = nextMcp;
      this.baseUrl = nextBase;
      if (apiToken !== undefined) this.apiToken = String(apiToken || '').trim();
      this.sessionId = null;
      this.initialized = false;
      this.tools.clear();
    }
  }

  _headers(extra = {}, { jsonBody = true } = {}) {
    const h = {
      Accept: 'application/json, text/event-stream',
      ...(jsonBody ? { 'Content-Type': 'application/json' } : {}),
      ...(this.sessionId ? {
        'mcp-session-id': this.sessionId,
        'mcp-protocol-version': MCP_PROTOCOL_VERSION
      } : {}),
      ...(this.apiToken ? { Authorization: `Bearer ${this.apiToken}` } : {}),
      ...extra
    };
    return h;
  }

  async checkHealth({ timeoutMs = 4000 } = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      for (const path of ['/system/ready', '/system/health']) {
        try {
          const r = await this.fetchImpl(`${this.baseUrl}${path}`, {
            method: 'GET',
            headers: this.apiToken ? { Authorization: `Bearer ${this.apiToken}` } : {},
            signal: ac.signal
          });
          if (r.ok) {
            this.lastHealthyAt = Date.now();
            this.lastError = null;
            return { ok: true, status: r.status, endpoint: this.baseUrl, path };
          }
        } catch (err) {
          this.lastError = String(err?.message || err);
        }
      }
      return { ok: false, endpoint: this.baseUrl, error: this.lastError || 'unreachable' };
    } finally {
      clearTimeout(timer);
    }
  }

  async _parseRpcResponse(resp, rpcId, method) {
    const nextSid = resp.headers?.get?.('mcp-session-id') || resp.headers?.get?.('Mcp-Session-Id');
    if (nextSid) this.sessionId = nextSid;

    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`MCP HTTP ${resp.status} on ${method}: ${txt.slice(0, 200)}`);
    }

    const ct = String(resp.headers?.get?.('content-type') || '').toLowerCase();
    if (!ct.includes('text/event-stream')) {
      const msg = await resp.json();
      if (msg?.error) {
        const err = new Error(msg.error.message || JSON.stringify(msg.error));
        err.code = msg.error.code;
        throw err;
      }
      return msg?.result;
    }

    // Streamable HTTP SSE parser
    const reader = resp.body?.getReader?.();
    if (!reader) {
      const full = await resp.text();
      return this._extractSseResult(full, rpcId, method);
    }
    const dec = new TextDecoder();
    let buffer = '';
    let dataLines = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trim());
        } else if (!line.trim() && dataLines.length) {
          const payload = dataLines.join('\n').trim();
          dataLines = [];
          if (!payload) continue;
          try {
            const parsed = JSON.parse(payload);
            if (parsed.id === rpcId) {
              try { await reader.cancel(); } catch {}
              if (parsed.error) {
                const err = new Error(parsed.error.message || JSON.stringify(parsed.error));
                err.code = parsed.error.code;
                throw err;
              }
              return parsed.result;
            }
          } catch (err) {
            if (err?.code !== undefined || /MCP/.test(err?.message || '')) throw err;
          }
        }
      }
    }
    if (dataLines.length || buffer.trim()) {
      const rest = [...dataLines, ...(buffer.trim().startsWith('data:') ? [buffer.trim().slice(5).trim()] : [])].join('\n').trim();
      if (rest) {
        const parsed = JSON.parse(rest);
        if (parsed.id === rpcId) {
          if (parsed.error) throw new Error(parsed.error.message || JSON.stringify(parsed.error));
          return parsed.result;
        }
      }
    }
    throw new Error(`MCP SSE stream ended before reply for ${method}`);
  }

  _extractSseResult(rawText, rpcId, method) {
    let data = [];
    for (const line of String(rawText || '').split(/\r?\n/)) {
      if (line.startsWith('data:')) data.push(line.slice(5).trim());
      else if (!line.trim() && data.length) {
        const payload = data.join('\n').trim();
        data = [];
        if (!payload) continue;
        const parsed = JSON.parse(payload);
        if (parsed.id === rpcId) {
          if (parsed.error) throw new Error(parsed.error.message || JSON.stringify(parsed.error));
          return parsed.result;
        }
      }
    }
    throw new Error(`MCP SSE reply missing for ${method}`);
  }

  async rpc(method, params = {}, { timeoutMs = 45000, signal = null } = {}) {
    const rpcId = ++this.nextRpcId;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error(`MCP timeout after ${timeoutMs}ms on ${method}`)), timeoutMs);
    const mergedSignal = signal ? AbortSignal.any([signal, ac.signal]) : ac.signal;
    try {
      const resp = await this.fetchImpl(this.mcpUrl, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method, params }),
        signal: mergedSignal
      });
      return await this._parseRpcResponse(resp, rpcId, method);
    } finally {
      clearTimeout(timer);
    }
  }

  async notify(method, params = {}, { timeoutMs = 10000 } = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const resp = await this.fetchImpl(this.mcpUrl, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify({ jsonrpc: '2.0', method, params }),
        signal: ac.signal
      });
      await resp.text().catch(() => {});
    } finally {
      clearTimeout(timer);
    }
  }

  async ensureConnected({ force = false, retries = 2 } = {}) {
    if (this.initialized && this.sessionId && !force) return this.sessionId;
    if (this.connectPromise && !force) return this.connectPromise;

    this.connectPromise = (async () => {
      let lastErr = null;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 400 * (2 ** (attempt - 1))));
          this.sessionId = null;
          this.initialized = false;
          const initRes = await this.rpc('initialize', {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: this.clientName, version: '1.0.0' }
          }, { timeoutMs: 12000 });
          this.serverInfo = initRes?.serverInfo || null;
          await this.notify('notifications/initialized', {});
          await this.refreshTools();
          this.initialized = true;
          this.lastHealthyAt = Date.now();
          this.lastError = null;
          return this.sessionId;
        } catch (err) {
          lastErr = err;
          this.lastError = String(err?.message || err);
        }
      }
      throw lastErr || new Error('Failed to initialize BrowserOS MCP session');
    })();

    try {
      return await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  async refreshTools() {
    const res = await this.rpc('tools/list', {}, { timeoutMs: 15000 });
    const list = Array.isArray(res?.tools) ? res.tools : [];
    this.tools.clear();
    for (const tool of list) {
      if (tool?.name) this.tools.set(tool.name, tool);
    }
    return this.getToolNames();
  }

  hasTool(name) {
    return this.tools.has(String(name || ''));
  }

  getToolNames() {
    return [...this.tools.keys()];
  }

  getToolSchema(name) {
    return this.tools.get(String(name || '')) || null;
  }

  /**
   * Call any discovered MCP tool dynamically. Handles reconnect if session expired cleanly.
   */
  async callTool(name, args = {}, { timeoutMs = 45000, signal = null, taskName = null } = {}) {
    await this.ensureConnected();
    const tool = this.getToolSchema(name);
    if (!tool) {
      throw new Error(`BrowserOS MCP tool unavailable on server: ${name}`);
    }
    const cleanArgs = { ...args };
    const props = tool?.inputSchema?.properties || {};
    if (taskName && 'taskName' in props && cleanArgs.taskName === undefined) {
      cleanArgs.taskName = String(taskName).slice(0, 80);
    }
    if ('session' in props && !cleanArgs.session && this.agentName) {
      // Only set session label when explicitly provided or optional; keep args schema-safe
    }

    let result;
    try {
      result = await this.rpc('tools/call', { name, arguments: cleanArgs }, { timeoutMs, signal });
    } catch (err) {
      if (/session|404|410|closed|expired/i.test(String(err?.message || ''))) {
        await this.ensureConnected({ force: true });
        result = await this.rpc('tools/call', { name, arguments: cleanArgs }, { timeoutMs, signal });
      } else {
        throw err;
      }
    }

    const content = Array.isArray(result?.content) ? result.content : [];
    const text = content.filter((c) => c?.type === 'text').map((c) => c.text || '').join('\n');
    const images = content.filter((c) => c?.type === 'image').map((c) => ({ mimeType: c.mimeType || 'image/png', data: c.data }));
    const metaSession = result?._meta?.['com.browseros.neo/session'];
    if (metaSession && typeof metaSession === 'string') {
      this.sessionId = metaSession;
    }

    if (result?.isError) {
      const err = new Error(text || `MCP tool ${name} failed`);
      err.toolName = name;
      err.structured = result?.structuredContent || null;
      throw err;
    }
    return {
      ok: true,
      tool: name,
      text,
      images,
      structured: result?.structuredContent || null,
      meta: result?._meta || null,
      sessionId: this.sessionId
    };
  }

  // Typed convenience methods built dynamically over discovered tools
  tabsList(opts = {}) { return this.callTool('tabs', { action: 'list' }, opts); }
  tabsNew(url = 'about:blank', { groupId, ...opts } = {}) {
    return this.callTool('tabs', { action: 'new', url, ...(groupId ? { groupId } : {}) }, opts);
  }
  tabsClose(page, opts = {}) { return this.callTool('tabs', { action: 'close', page: Number(page) }, opts); }

  navigate(page, url, { action = 'url', ...opts } = {}) {
    return this.callTool('navigate', { page: Number(page), action, ...(action === 'url' ? { url } : {}) }, opts);
  }
  snapshot(page, { mode = 'interactive', depth = 8, ...opts } = {}) {
    return this.callTool('snapshot', { page: Number(page), mode, ...(depth ? { depth } : {}) }, opts);
  }
  diff(page, opts = {}) { return this.callTool('diff', { page: Number(page) }, opts); }
  act(page, kind, params = {}, opts = {}) {
    return this.callTool('act', { page: Number(page), kind, ...params }, opts);
  }
  read(page, { format = 'markdown', viewportOnly = false, ...opts } = {}) {
    return this.callTool('read', { page: Number(page), format, viewportOnly }, opts);
  }
  grep(page, pattern, { over, limit, ...opts } = {}) {
    return this.callTool('grep', { page: Number(page), pattern, ...(over ? { over } : {}), ...(limit ? { limit } : {}) }, opts);
  }
  screenshot(page, { format = 'jpeg', quality = 85, annotate = false, ...opts } = {}) {
    return this.callTool('screenshot', { page: Number(page), format, quality, annotate }, opts);
  }
  run(code, { timeout = 30000, maxChars = 25000, ...opts } = {}) {
    return this.callTool('run', { code, timeout, maxChars }, { timeoutMs: Math.max(timeout + 15000, 45000), ...opts });
  }
  pursue(args = {}, opts = {}) {
    return this.callTool('pursue', args, { timeoutMs: 90000, ...opts });
  }
  requestHumanHelp(args = {}, opts = {}) {
    if (!this.hasTool('request_human_help')) return null;
    return this.callTool('request_human_help', args, opts);
  }

  getScreencastUrl({ sessionId = null, quality = 'high', tab = null } = {}) {
    const sid = sessionId || this.sessionId;
    if (!sid) return null;
    const qs = new URLSearchParams({ quality: quality === 'low' ? 'low' : 'high' });
    if (tab !== null && tab !== undefined) qs.set('tab', String(tab));
    return `${this.baseUrl}/v1/sessions/${encodeURIComponent(sid)}/screencast?${qs.toString()}`;
  }

  getVideoUrl({ sessionId = null, quality = 'high', tab = null } = {}) {
    const sid = sessionId || this.sessionId;
    if (!sid) return null;
    const qs = new URLSearchParams({ quality: quality === 'low' ? 'low' : 'high' });
    if (tab !== null && tab !== undefined) qs.set('tab', String(tab));
    return `${this.baseUrl}/v1/sessions/${encodeURIComponent(sid)}/video?${qs.toString()}`;
  }

  async getSessionRecord(sessionId = null) {
    const sid = sessionId || this.sessionId;
    if (!sid) return null;
    for (const path of [`/v1/sessions/${encodeURIComponent(sid)}`, `/api/v1/sessions/${encodeURIComponent(sid)}`]) {
      try {
        const r = await this.fetchImpl(`${this.baseUrl}${path}`, {
          headers: this.apiToken ? { Authorization: `Bearer ${this.apiToken}` } : {}
        });
        if (r.ok) return await r.json();
      } catch {}
    }
    return null;
  }

  async close() {
    if (!this.sessionId) return;
    const sid = this.sessionId;
    this.sessionId = null;
    this.initialized = false;
    try {
      await this.fetchImpl(this.mcpUrl, {
        method: 'DELETE',
        headers: {
          'mcp-session-id': sid,
          ...(this.apiToken ? { Authorization: `Bearer ${this.apiToken}` } : {})
        }
      });
    } catch {}
  }
}
