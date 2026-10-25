import { randomBytes } from 'node:crypto';
import { KeyedLock, MusicError } from './model.js';
/** Callback data contains only an opaque token, revision, action and small index. */
export class SearchSessions {
  constructor({ providers, ttlMs = 600000, maxSessions = 300 } = {}) { this.providers = providers; this.ttlMs = ttlMs; this.maxSessions = maxSessions; this.sessions = new Map(); this.lock = new KeyedLock(); }
  create({ userId, chatId, botId, destination, query, mode }) {
    for (const [id,s] of this.sessions) if (Date.now() >= s.expires) this.sessions.delete(id);
    if (this.sessions.size >= this.maxSessions) this.sessions.delete(this.sessions.keys().next().value);
    const s = { id:randomBytes(9).toString('base64url'), userId:String(userId), chatId:Number(chatId), botId:String(botId || ''), destination:Number(destination), query:String(query).trim().slice(0,180), mode, pages:[], index:0, selected:new Map(), revision:0, expires:Date.now()+this.ttlMs, consumed:false, messageId:null };
    if (!s.query) throw new MusicError('QUERY_REQUIRED','Enter a title and artist.');
    this.sessions.set(s.id,s); return s;
  }
  get(id, ctx) {
    const s = this.sessions.get(id);
    if(!s)throw new MusicError('SEARCH_EXPIRED','This search has expired. Open a new search.');
    if (s.userId !== String(ctx.tgId) || s.chatId !== Number(ctx.chatId) || s.botId !== String(ctx.api?.me?.id || ctx.botUsername || '') || (s.messageId && s.messageId !== ctx.messageId)) throw new MusicError('SEARCH_OWNER','Use your own search panel in its original chat.');
    if(s.consumed)throw new MusicError('SEARCH_CONSUMED',['queue','video'].includes(s.mode)?'This selection was already queued. Open /player to inspect or retry it; do not add it again.':'This selection was already delivered. Open a new search for another recording.');
    if(!s.processing&&Date.now()>=s.expires)throw new MusicError('SEARCH_EXPIRED','This search has expired. Open a new search.');
    return s;
  }
  async page(s, index) {
    if (index < 0 || index > 19 || index > s.pages.length) throw new MusicError('INVALID_PAGE','That search page is unavailable.');
    if (!s.pages[index]) {
      const previous = s.pages[index-1]; if (index && previous.nextOffset == null) throw new MusicError('NO_MORE_RESULTS','There are no more results.');
      const result = await this.providers.search(s.query, { offset:previous?.nextOffset || 0, limit:5, video:s.mode==='video' });
      const seen = new Set(s.pages.flatMap(p => p.items.map(t => t.id)));
      result.items = result.items.filter(t => !seen.has(t.id)); s.pages[index] = result;
    }
    s.index = index; return s.pages[index];
  }
  async action(id, revision, ctx, work) {
    const current=this.get(id,ctx);if(current.processing)throw new MusicError('REQUEST_PROCESSING','Your selection is being prepared. Please wait; you do not need to press again.');
    return this.lock.run(id, async () => { const s = this.get(id,ctx); if (Number(revision) !== s.revision) throw new MusicError('STALE_PANEL','The panel has changed. Use the latest buttons.'); const value = await work(s); s.revision++; return value; });
  }
}
