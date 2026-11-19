/**
 * Manages isolated BrowserOS neo MCP endpoints & scoped sessions (`local` Docker service
 * or user-registered remote PC / SSH tunnel / Tailscale connectors).
 */

import { BrowserOSMCPClient } from './mcpClient.js';

export class BrowserConnectionManager {
  constructor({ app, log = null, clientFactory = null } = {}) {
    this.app = app || null;
    this.log = log || app?.log?.child?.({ module: 'browser-conn' }) || null;
    this.clientFactory = clientFactory || ((opts) => new BrowserOSMCPClient(opts));
    this.clients = new Map(); // scopeKey -> { client, connectorId, updatedAt }
    this.connectors = new Map();
    this.#loadConnectors();
  }

  #getConfig() {
    const s = this.app?.settings;
    const env = this.app?.env || {};
    const mcpUrl = String(env.BROWSEROS_MCP_URL || s?.get?.('browser.mcpUrl') || 'http://127.0.0.1:9010/mcp').trim();
    const baseUrl = String(env.BROWSEROS_BASE_URL || s?.get?.('browser.baseUrl') || mcpUrl.replace(/\/mcp\/?$/i, '')).replace(/\/+$/, '');
    const novncUrl = String(env.BROWSEROS_NOVNC_URL || s?.get?.('browser.novncUrl') || 'http://127.0.0.1:6080').replace(/\/+$/, '');
    const apiToken = String(env.BROWSEROS_API_TOKEN || s?.get?.('browser.apiToken') || '').trim();
    const connectorMode = String(env.BROWSEROS_CONNECTOR_MODE || s?.get?.('browser.connectorMode') || 'local').trim();
    return { mcpUrl, baseUrl, novncUrl, apiToken, connectorMode };
  }

  #loadConnectors() {
    const cfg = this.#getConfig();
    this.connectors.set('local', {
      id: 'local',
      label: 'Managed BrowserOS Neo Service',
      mode: cfg.connectorMode || 'local',
      mcpUrl: cfg.mcpUrl,
      baseUrl: cfg.baseUrl,
      novncUrl: cfg.novncUrl,
      apiToken: cfg.apiToken
    });
    const saved = this.app?.db?.getSetting?.('browser.remoteConnectors', {}) || {};
    if (saved && typeof saved === 'object') {
      for (const [id, rec] of Object.entries(saved)) {
        if (rec?.mcpUrl) {
          this.connectors.set(id, {
            id,
            label: rec.label || id,
            mode: rec.mode || 'remote',
            mcpUrl: rec.mcpUrl,
            baseUrl: rec.baseUrl || String(rec.mcpUrl).replace(/\/mcp\/?$/i, ''),
            novncUrl: rec.novncUrl || '',
            apiToken: rec.apiToken || ''
          });
        }
      }
    }
  }

  getActiveConnectorId(scopeKey = 'global') {
    const perScope = this.app?.db?.getSetting?.(`browser.connector.${scopeKey}`, null);
    if (perScope && this.connectors.has(perScope)) return perScope;
    const globalActive = this.app?.db?.getSetting?.('browser.activeConnector', 'local');
    return this.connectors.has(globalActive) ? globalActive : 'local';
  }

  getConnector(connectorId = null, scopeKey = 'global') {
    if (connectorId === 'local' || !connectorId) {
      this.#loadConnectors();
    }
    const id = connectorId || this.getActiveConnectorId(scopeKey);
    return this.connectors.get(id) || this.connectors.get('local');
  }

  listConnectors() {
    this.#loadConnectors();
    return [...this.connectors.values()].map((c) => ({
      id: c.id,
      label: c.label,
      mode: c.mode,
      mcpUrl: c.mcpUrl,
      baseUrl: c.baseUrl,
      novncUrl: c.novncUrl,
      hasToken: Boolean(c.apiToken)
    }));
  }

  registerConnector({ id = 'remote-pc', label = 'Remote PC BrowserOS', mcpUrl, baseUrl = '', novncUrl = '', apiToken = '', mode = 'remote', activateScope = null } = {}) {
    const cleanId = String(id || 'remote-pc').replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'remote-pc';
    if (cleanId === 'local') throw new Error('Cannot overwrite reserved local connector');
    const url = new URL(String(mcpUrl || '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Connector URL must use http:// or https://');
    const rec = {
      id: cleanId,
      label: String(label || cleanId).slice(0, 64),
      mode,
      mcpUrl: url.toString(),
      baseUrl: String(baseUrl || url.toString().replace(/\/mcp\/?$/i, '')).replace(/\/+$/, ''),
      novncUrl: String(novncUrl || '').trim(),
      apiToken: String(apiToken || '').trim()
    };
    this.connectors.set(cleanId, rec);
    const saved = this.app?.db?.getSetting?.('browser.remoteConnectors', {}) || {};
    saved[cleanId] = rec;
    this.app?.db?.setSetting?.('browser.remoteConnectors', saved);
    if (activateScope) {
      this.app?.db?.setSetting?.(`browser.connector.${activateScope}`, cleanId);
      const prev = this.clients.get(activateScope);
      if (prev) {
        void prev.client.close().catch(() => {});
        this.clients.delete(activateScope);
      }
    }
    return { id: rec.id, label: rec.label, mode: rec.mode, mcpUrl: rec.mcpUrl, baseUrl: rec.baseUrl };
  }

  selectConnector(scopeKey, connectorId) {
    if (!this.connectors.has(connectorId)) throw new Error(`Unknown connector: ${connectorId}`);
    this.app?.db?.setSetting?.(`browser.connector.${scopeKey}`, connectorId);
    const existing = this.clients.get(scopeKey);
    if (existing && existing.connectorId !== connectorId) {
      void existing.client.close().catch(() => {});
      this.clients.delete(scopeKey);
    }
    return this.getConnector(connectorId, scopeKey);
  }

  /**
   * Return an initialized BrowserOSMCPClient isolated strictly to `scopeKey` (`gc:<chatId>` or `dm:<userId>`).
   */
  async getClient(scopeKey = 'global', { connectorId = null, ensure = true } = {}) {
    const conn = this.getConnector(connectorId, scopeKey);
    let entry = this.clients.get(scopeKey);
    if (!entry || entry.connectorId !== conn.id) {
      if (entry) await entry.client.close().catch(() => {});
      const client = this.clientFactory({
        mcpUrl: conn.mcpUrl,
        baseUrl: conn.baseUrl,
        apiToken: conn.apiToken,
        clientName: `lancy-${scopeKey}`,
        agentName: `lancy-${scopeKey}`.slice(0, 48),
        log: this.log
      });
      entry = { client, connectorId: conn.id, connector: conn, updatedAt: Date.now() };
      this.clients.set(scopeKey, entry);
    } else {
      entry.client.setEndpoint({ mcpUrl: conn.mcpUrl, baseUrl: conn.baseUrl, apiToken: conn.apiToken });
      entry.updatedAt = Date.now();
    }
    if (ensure) {
      await entry.client.ensureConnected();
    }
    return entry.client;
  }

  async checkHealth(connectorId = 'local', scopeKey = 'global') {
    const conn = this.getConnector(connectorId, scopeKey);
    const probe = this.clientFactory({
      mcpUrl: conn.mcpUrl,
      baseUrl: conn.baseUrl,
      apiToken: conn.apiToken,
      log: this.log
    });
    const res = await probe.checkHealth();
    return { ...res, connectorId: conn.id, novncUrl: conn.novncUrl };
  }

  async closeScope(scopeKey) {
    const entry = this.clients.get(scopeKey);
    if (!entry) return false;
    this.clients.delete(scopeKey);
    await entry.client.close().catch(() => {});
    return true;
  }

  async shutdown() {
    for (const [k, entry] of [...this.clients.entries()]) {
      this.clients.delete(k);
      await entry.client.close().catch(() => {});
    }
  }
}
