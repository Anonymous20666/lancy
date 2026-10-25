import { randomBytes } from 'node:crypto';
import { KeyedLock, MusicError } from './model.js';

// Compact wire actions keep scoped callbacks below Telegram's 64-byte bound.
export const PANEL_ACTIONS = ['player','previous','pause','resume','skip','seekby','queue','lyrics','volume','options','loop','shuffle','bass','accounts','pin','preview','stop','leave','qpage','lypage','clear','remove','setvol','selectaccount','seek','prompt','playnow','radio','rpage','rpick','rstart','roff','channels','retry','eq','voteskip','catmenu','catpick','genresub','infinact'];
const LOCAL = new Set(['screenMessageId','playerChatId','api','view','page','lyrics','lyricsPage','availableAccounts','fullPreview','lastRender','editAfter','pinned','panelToken','panelActive','panelNotice','radioPage','radioSelected','radioCustom']);

/** Many verified administrators' private views; one authoritative destination queue.
 * No channel messages are sent, and a callback never relies on the latest DM binding. */
export class ChannelPanels {
  constructor({ service, maxPanels = 100, maxPerChannel = 8, membershipTtlMs = 30000 }) {
    this.service = service; this.app = service.app; this.maxPanels = maxPanels; this.maxPerChannel = maxPerChannel;
    this.membershipTtlMs = membershipTtlMs; this.panels = new Map(); this.locks = new KeyedLock();
  }
  key(ctx, destination) { return `${this.service.botKey(ctx)}:${ctx.tgId}:${destination}`; }
  find(ctx, destination) { return [...this.panels.values()].find(p => p.key === this.key(ctx, destination)); }
  state(p) {
    if (!p.state) {
      const session = this.app.musicQueueManager.getSession(p.destination);
      p.state = new Proxy(p, {
        ownKeys: () => [...new Set([...Reflect.ownKeys(session), ...LOCAL])],
        getOwnPropertyDescriptor: (_target, key) => ({ configurable: true, enumerable: true, value: LOCAL.has(key) ? p[key] : session[key] }),
        get: (target, key) => LOCAL.has(key) ? target[key] : session[key],
        set: (target, key, value) => { if (LOCAL.has(key)) target[key] = value; else session[key] = value; return true; }
      });
    }
    return p.state;
  }
  async open(ctx, session) {
    if (Number(ctx.chatId) <= 0 || Number(ctx.chatId) !== Number(ctx.tgId)) throw new MusicError('CHANNEL_DM_REQUIRED','Channel dashboards belong in the initiating administrator’s private chat. Use /channel @channelname in DM.');
    await this.service.authorize(ctx, true, session.chatId);
    const botKey = this.service.botKey(ctx);
    if (session.controlBotKey && session.controlBotKey !== botKey) throw new MusicError('PLAYER_ELSEWHERE','This channel is controlled through a different bot. Use that bot’s private dashboard.');
    session.controlBotKey = botKey;
    return this.locks.run(this.key(ctx, session.chatId), async () => {
      let p = this.find(ctx, session.chatId);
      if (!p) {
        if (this.panels.size >= this.maxPanels || [...this.panels.values()].filter(x => x.destination === session.chatId).length >= this.maxPerChannel) throw new MusicError('PANEL_LIMIT','The private dashboard limit has been reached. Close an unused channel dashboard first.');
        const panelToken = randomBytes(6).toString('base64url');
        p = { key: this.key(ctx, session.chatId), destination: session.chatId, userId: String(ctx.tgId), botKey, panelToken,
          api: ctx.api, playerChatId: Number(ctx.chatId), screenMessageId: null, view: 'player', page: 0, lyricsPage: 0,
          panelActive: true, checkedAt: Date.now(), pinned: false, fullPreview: null };
        this.panels.set(panelToken, p);
      }
      p.panelActive = true; p.checkedAt = Date.now(); p.view = 'player'; p.api = ctx.api; p.panelNotice = null;
      const state = this.state(p);
      if (!p.screenMessageId) {
        const rich = this.app.screens.get('music').renderPlayer(state);
        try { const sent = await p.api.sendRichMessage(p.playerChatId, rich); p.screenMessageId = sent.message_id; p.lastRender = JSON.stringify(rich); }
        catch (error) { this.panels.delete(p.panelToken); throw error; }
      }
      try { await this.pin(p.panelToken); }
      catch { p.panelNotice = 'This private dashboard could not be pinned. Use More → Pin player to retry; channel playback is unaffected.'; }
      await this.app.musicQueueManager.updatePlayerView(state);
      return state;
    });
  }
  hasDestination(id) { return [...this.panels.values()].some(p => p.destination === Number(id)); }
  replyPanel(ctx, message) {
    if(message.reply_to_message?.from?.id!==ctx.api?.me?.id)return null;
    return [...this.panels.values()].find(p=>p.userId===String(ctx.tgId)&&p.botKey===this.service.botKey(ctx)&&p.playerChatId===Number(ctx.chatId)&&p.screenMessageId===message.reply_to_message.message_id)||null;
  }
  async resolve(ctx, token, { requireMessage = true } = {}) {
    const p = this.panels.get(token);
    if (!p || p.userId !== String(ctx.tgId) || p.botKey !== this.service.botKey(ctx) || p.playerChatId !== Number(ctx.chatId) || (requireMessage && p.screenMessageId !== ctx.messageId)) throw new MusicError('STALE_PLAYER','Use your own channel dashboard in its original private chat.');
    await this.service.authorize(ctx, true, p.destination);
    p.panelActive = true; p.checkedAt = Date.now(); return this.state(p);
  }
  async pin(token, { force = false } = {}) {
    const p = this.panels.get(token);
    if (!p?.panelActive || !p.screenMessageId) throw new MusicError('STALE_PLAYER','Open /channel again in private chat.');
    if (!p.pinned || force) {
      const ok = await p.api.call('pinChatMessage', { chat_id: p.playerChatId, message_id: p.screenMessageId, disable_notification: true });
      if (ok !== true) throw new MusicError('PIN_FAILED','Telegram did not confirm pinning your private dashboard.');
      p.pinned = true; p.panelNotice = null;
    }
  }
  async update(destination, { preview = null, panelToken = null } = {}) {
    let updated = false;
    for (const p of this.panels.values()) {
      if (p.destination !== Number(destination) || (panelToken && p.panelToken !== panelToken) || !p.screenMessageId) continue;
      if (!p.panelActive) continue;
      if (Date.now() - p.checkedAt >= this.membershipTtlMs) {
        try { await this.service.authorize({ api: p.api, tgId: p.userId, chatId: p.playerChatId }, true, p.destination); p.checkedAt = Date.now(); }
        catch {
          p.panelActive = false; p.lastRender = null; p.fullPreview = null;
          await p.api.editMessageText(p.playerChatId, p.screenMessageId, 'Channel dashboard locked: administrator access could not be verified. Use /channel @channelname in private chat after access is restored.').catch(() => {});
          continue;
        }
      }
      updated = (await this.app.musicQueueManager.updatePlayerView(this.state(p), { preview })) || updated;
    }
    return updated;
  }
  async close(ctx, destination) {
    const p = this.find(ctx, destination); if (!p) return false;
    p.panelActive = false;
    await p.api.editMessageText(p.playerChatId, p.screenMessageId, 'Channel control dashboard closed. The shared channel playback was not stopped.').catch(() => {});
    if (p.pinned) await p.api.call('unpinChatMessage', { chat_id: p.playerChatId, message_id: p.screenMessageId }).catch(() => {});
    this.panels.delete(p.panelToken); return true;
  }
}
