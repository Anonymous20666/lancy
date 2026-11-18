import { randomBytes } from 'node:crypto';
import { CallSetup } from './setup.js';
import { SavedChannels, channelReference } from './channels.js';
import { InfiniteRadio, RADIO_CATEGORIES } from './radio.js';
import { parseMultiArtistPrompt } from './charts.js';
import { AiDjEngine } from './aiDj.js';
import { ChannelPanels } from './channelPanels.js';
import { FullTrackPreviews, audioUpload, audioFileId } from './preview.js';
import { originalPlayDelivery } from './originalPlayCard.js';
import { isMusicOwner, isMusicSuperAdmin, resolveAppScreen, isSameMusicBot } from './accounts.js';
import { KeyedLock, MusicError, stripRemotePhotoBlocks, isRemotePhotoError, hasRichPhotoPayload, sendRichWithPhotoFallback, extractRichPhotoUrl, extractSentPhotoFileId } from './model.js';
import { checkChatMediaPermissions, isGroupSuperAdminMember, isAnonymousGroupAdmin } from '../telegram/permissions.js';
import { ProgressTracker } from '../telegram/progress.js';
import { RichMessageBuilder, rt } from '../telegram/rich.js';
import { normalizeDownloadQuality } from '../media/telegramLimits.js';
export const EQ_PRESETS = ['off','studio','bass','vocal','nightcore','vaporwave','8d'];
export const EQ_CYCLE_PRESETS = ['off','studio','bass','vocal','8d'];

function parseDurationTokens(str) {
  const s = String(str || '').trim().toLowerCase();
  if (!s) return null;
  if (/^\d+(?::\d{1,2}){1,2}(?:\.\d+)?$/.test(s)) {
    const parts = s.split(':').map(Number);
    if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
  }
  const unitRe = /^(?:(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?\s*)?(?:(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?\s*)?(?:(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?)?$/i;
  const um = s.match(unitRe);
  if (um && (um[1] !== undefined || um[2] !== undefined || um[3] !== undefined)) {
    const hrs = Number(um[1] || 0);
    const mins = Number(um[2] || 0);
    const secs = Number(um[3] || 0);
    return hrs * 3600 + mins * 60 + secs;
  }
  if (/^\d+(?:\.\d+)?$/.test(s)) {
    return Number(s);
  }
  return null;
}

export function parseSeekInput(raw, currentPos = 0, duration = 0) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const stepMatch = text.match(/^(?:step|set|button|skip)\s+(.+)$/i);
  if (stepMatch) {
    const val = parseDurationTokens(stepMatch[1].replace(/^[+-]/, '').trim());
    if (val === null || !Number.isFinite(val) || val < 5 || val > 600) return null;
    return { kind: 'step', seconds: Math.round(val) };
  }
  let sign = 0;
  let body = text;
  if (/^[+-]/.test(body)) {
    sign = body.startsWith('-') ? -1 : 1;
    body = body.slice(1).trim();
  } else if (/^(?:ff|forward|fwd|\+)\s+/i.test(body)) {
    sign = 1;
    body = body.replace(/^(?:ff|forward|fwd|\+)\s+/i, '').trim();
  } else if (/^(?:rw|rewind|back|-)\s+/i.test(body)) {
    sign = -1;
    body = body.replace(/^(?:rw|rewind|back|-)\s+/i, '').trim();
  }
  const parsedSec = parseDurationTokens(body);
  if (parsedSec === null || !Number.isFinite(parsedSec)) return null;
  const dur = Math.max(0, Number(duration) || 0);
  const base = Math.max(0, Number(currentPos) || 0);
  if (sign !== 0) {
    const delta = sign * parsedSec;
    let target = Math.max(0, base + delta);
    if (dur > 2 && target >= dur) target = Math.max(0, dur - 2);
    return { kind: 'relative', delta, targetSeconds: target };
  }
  let target = Math.max(0, parsedSec);
  if (dur > 2 && target >= dur) target = Math.max(0, dur - 2);
  return { kind: 'absolute', targetSeconds: target };
}

export class MusicService {
  constructor({ app, search, lyrics, accounts }) { this.app=app; this.search=search; this.lyrics=lyrics; this.accounts=accounts; this.rates=new Map(); this.destinations=new Map(); this.controlLock=new KeyedLock(); this.panelLock=new KeyedLock(); this.pollLock=new KeyedLock(); this.previews=new FullTrackPreviews({app}); this.downloads=0; this.userDownloads=new Map(); this.maxDownloads=16; this.maxUserDownloads=2; this.channelPanels=new ChannelPanels({service:this});this.setup=new CallSetup({service:this});this.channels=new SavedChannels({service:this});this.radio=new InfiniteRadio({app});this.aiDj=new AiDjEngine({app});this.listenCards=new Map();this.cardLocks=new KeyedLock();this.lyricJobs=new Map();this.activePolls=new Map();this.autoPollTimers=new Map();this._boundQm=null;this.pendingSeeks=new Map(); this.#hydratePersistedPolls(); this.bindQueuePollLifecycle(); }
  isAutoPollEnabled(chatId){
    const perChat=chatId!=null?this.app?.db?.getSetting?.(`music.autoPoll.${chatId}`,null):null;
    if(typeof perChat==='boolean')return perChat;
    const globalVal=this.app?.db?.getSetting?.('music.autoPoll.global',null);
    if(typeof globalVal==='boolean')return globalVal;
    const cfgVal=this.app?.settings?.get?.('music.autoPoll');
    return typeof cfgVal==='boolean'?cfgVal:true;
  }
  setAutoPollEnabled(chatId, enabled){
    const val=Boolean(enabled);
    const id=Number(chatId);
    if(Number.isSafeInteger(id)&&id!==0){
      this.app?.db?.setSetting?.(`music.autoPoll.${id}`,val);
      if(!val){
        const t=this.autoPollTimers.get(id);
        if(t){clearTimeout(t);this.autoPollTimers.delete(id);}
      }
    }else{
      this.app?.db?.setSetting?.('music.autoPoll.global',val);
    }
    return val;
  }
  getSkipVoteThreshold(chatId){
    const perChat=chatId!=null?this.app?.db?.getSetting?.(`music.skipVoteThreshold.${chatId}`,null):null;
    const raw=perChat!==null&&perChat!==undefined?perChat:this.app?.settings?.get?.('music.skipVoteThreshold');
    return Math.max(1,Math.min(25,Number(raw||2)));
  }
  getQueueVoteThreshold(chatId){
    const perChat=chatId!=null?this.app?.db?.getSetting?.(`music.queueVoteThreshold.${chatId}`,null):null;
    const raw=perChat!==null&&perChat!==undefined?perChat:this.app?.settings?.get?.('music.queueVoteThreshold');
    return Math.max(1,Math.min(25,Number(raw||2)));
  }
  getQueueVoteAction(chatId){
    const mode=chatId!=null?this.app?.db?.getSetting?.(`music.queueVoteAction.${chatId}`,'playnow'):'playnow';
    return mode==='top'?'top':'playnow';
  }
  async syncSessionIdentity(s,ctx,chat=null,{bridgeInviteLink=null}={}){
    if(!s)return s;
    const botUser=ctx?.api?.botUsername||ctx?.api?.me?.username||this.app?.telegram?.botUsername||s.botUsername||'Lancy_easy_bot';
    s.botUsername=String(botUser).replace(/^@/,'');
    const resolvedBotId=ctx?.botId??ctx?.controller?.botContext?.botId??s.botId??0;
    s.botId=Number(resolvedBotId)||0;
    if(ctx?.api)s.api=ctx.api;
    if(bridgeInviteLink&&/^https:\/\/t\.me\//i.test(String(bridgeInviteLink))){
      s.callInviteLink=String(bridgeInviteLink).trim();
    }
    if(chat){
      s.isChannel=chat.type==='channel';
      s.destinationTitle=chat.title||(s.isChannel?'Channel':'Group');
      s.destinationUsername=chat.username||null;
      if(chat.username){
        const clean=String(chat.username).replace(/^@/,'');
        s.groupInviteLink=`https://t.me/${clean}`;
      } else if(chat.invite_link){
        s.groupInviteLink=chat.invite_link;
      }
    }
    if(s.callInviteLink&&/^https:\/\/t\.me\//i.test(s.callInviteLink)){
      s.vcUrl=s.callInviteLink;
    } else if(s.destinationUsername){
      const clean=String(s.destinationUsername).replace(/^@/,'');
      s.vcUrl=s.isChannel?`https://t.me/${clean}?livestream`:`https://t.me/${clean}?voicechat`;
    } else {
      s.vcUrl=null;
    }
    return s;
  }
  async prepare(ctx,id=this.destination(ctx)) {
    const preSess = this.app.musicQueueManager?.getSession?.(id);
    if (preSess && ctx) {
      preSess.botId = Number(ctx?.botId ?? ctx?.controller?.botContext?.botId ?? preSess.botId ?? 0) || 0;
      if (ctx.api) preSess.api = ctx.api;
      const bUser = ctx.api?.botUsername || ctx.api?.me?.username || this.app?.telegram?.botUsername;
      if (bUser) preSess.botUsername = String(bUser).replace(/^@/, '');
    }
    // Older offline adapters remain supported. The real VoiceClient always has setup.
    if(typeof this.app.voiceClient?.setup==='function')return this.setup.prepare(ctx,id);
    await this.authorize(ctx,true,id);await this.accounts.sync();
    const live=await this.app.voiceClient.accounts(id);
    if(!live.accounts.some(a=>a.enabled&&['available','busy'].includes(a.status)))throw new MusicError('ACCOUNT_UNAVAILABLE','No authorized player account is approved for this destination. Ask the owner to use /accounts allow <alias> <chat-id>.');
    return {destination:id};
  }
  queueGeneration(id){return this.app.musicQueueManager?.getSession?.(id)?.stopGeneration||0;}
  assertQueueGeneration(id,generation){if(this.queueGeneration(id)!==generation||this.app.musicQueueManager?.getSession?.(id)?.stopPending)throw new MusicError('ACTION_CANCELLED','This pending music request was cancelled by Stop.');}
  rememberListen(ctx,track,destination=null){
    for(const [id,c]of this.listenCards)if(c.expires<Date.now())this.listenCards.delete(id);
    if(this.listenCards.size>=500)this.listenCards.delete(this.listenCards.keys().next().value);
    const token=randomBytes(6).toString('base64url'),c={token,track,destination,user:String(ctx.tgId),bot:this.botKey(ctx),chat:Number(ctx.chatId),messageId:null,expires:Date.now()+3600000,consumed:false};this.listenCards.set(token,c);return c;
  }
  listenCard(ctx,token,{requireMessage=true}={}){const c=this.listenCards.get(token);if(!c||c.expires<Date.now()||c.user!==String(ctx.tgId)||c.bot!==this.botKey(ctx)||c.chat!==Number(ctx.chatId)||(requireMessage&&c.messageId!==ctx.messageId))throw new MusicError('LISTEN_CARD_EXPIRED','Use your own /play card in its original chat, or search again.');if(c.consumed)throw new MusicError('ALREADY_QUEUED','This recording was already added from this card.');return c;}
  hasYoutubeVideo(){return Boolean(this.app?.musicProviders?.get?.('youtube')?.enabled);}
  syncEqSettings(s,id){const savedBass=this.app.db?.getSetting?.(`music.bass.${id}`,null);const savedEq=this.app.db?.getSetting?.(`music.eq.${id}`,null);s.bass=savedBass!==null&&savedBass!==undefined?Boolean(savedBass):true;s.eqPreset=savedEq||(s.bass?'bass':'off');this.aiDj?.syncSession?.(s);}
  async queueListen(ctx,token,{destination=null,fromCatalog=false,playNow=false}={}){return this.cardLocks.run(token,async()=>{const c=this.listenCard(ctx,token,{requireMessage:!fromCatalog}),id=c.destination||destination;if(!id)throw new MusicError('DESTINATION_REQUIRED','Choose a saved channel, or use /play inside your group.');if(c.destination&&destination&&c.destination!==destination)throw new MusicError('DESTINATION_CHANGED','That recording belongs to its original destination.');const generation=this.queueGeneration(id);await this.authorize(ctx,true,id,{allowDj:true});this.assertQueueGeneration(id,generation);await this.prepare(ctx,id);this.assertQueueGeneration(id,generation);this.app.musicQueueManager.getSession(id);const mediaType=(ctx.mode==='video'||this.hasYoutubeVideo())?'video':'audio';const trackObj={...c.track,mediaType,requester:ctx.user?.first_name||'Member'};if(playNow&&typeof this.app.musicQueueManager.playImmediateAndContinue==='function'){await this.app.musicQueueManager.playImmediateAndContinue(id,trackObj);}else{await this.app.musicQueueManager.addMany(id,[trackObj]);}c.consumed=true;return this.player(ctx,id);});}
  async streamReply(ctx,message,{video=null}={}){
    this.rate(ctx);const id=this.destination(ctx),generation=this.queueGeneration(id);await this.authorize(ctx,true,id,{allowDj:true});this.assertQueueGeneration(id,generation);await this.prepare(ctx,id);this.assertQueueGeneration(id,generation);
    const isChannelSession = Boolean(this.app.musicQueueManager?.getSession(id)?.isChannel);
    const wantsVideo=video!==null?Boolean(video):false;
    const media=await this.app.musicLibrary.importTelegram(ctx.api,message,{video:wantsVideo||isChannelSession});let transferred=false;
    try{this.assertQueueGeneration(id,generation);await this.app.musicQueueManager.addMany(id,[{...media.track,queuedMedia:media,requester:ctx.user?.first_name||'Member'}]);transferred=true;return await this.player(ctx,id);}finally{if(!transferred)media.release();}
  }
  requestCardLyrics(s, { force = false } = {}){
    const root=(s?.destination&&this.app?.musicQueueManager)?this.app.musicQueueManager.getSession(s.destination):s;
    const track=root?.currentTrack;if(!track||!this.lyrics?.get)return;
    if(!force&&(root.cardLyrics?.trackId===track.id||this.lyricJobs.has(root.chatId)))return;
    const playback=root.playbackId;root.cardLyrics={trackId:track.id,status:'pending'};
    const job=Promise.resolve(this.lyrics.get(track,{force})).then(result=>{if(root.currentTrack?.id===track.id&&root.playbackId===playback)root.cardLyrics={trackId:track.id,status:result?.found?'ready':'unavailable',result};}).catch(()=>{if(root.currentTrack?.id===track.id&&root.playbackId===playback)root.cardLyrics={trackId:track.id,status:'unavailable'};}).finally(()=>{this.lyricJobs.delete(root.chatId);if(!this.app.musicQueueManager.closed)void this.app.musicQueueManager.updatePlayerCard(root.chatId).catch(()=>{});});this.lyricJobs.set(root.chatId,job);
  }
  owner(ctx) { return isMusicOwner(this.app,ctx?.tgId); }
  superAdmin(ctx) { return isMusicSuperAdmin(this.app, ctx?.tgId, { controller: ctx?.controller }); }
  async #isChatSuperAdmin(ctx, id = null) {
    if (!ctx || id == null || Number(id) >= 0) return false;
    if (isAnonymousGroupAdmin(ctx.message, id)) return true;
    const chatType = ctx.chatType || ctx.message?.chat?.type || ctx.query?.message?.chat?.type || (this.app?.musicQueueManager?.getSession?.(id)?.isChannel ? 'channel' : null);
    if (chatType === 'channel' && ctx.channelAdminVerified) return true;
    const uid = Number(ctx.tgId);
    if (!Number.isSafeInteger(uid) || uid <= 0) return false;
    const member = await ctx.api?.getChatMember?.(Number(id), uid).catch(() => null);
    if (!member) return false;
    if (chatType === 'channel') return ['creator', 'administrator'].includes(member.status);
    return isGroupSuperAdminMember(member);
  }
  #isTrackReady(session, entry) {
    if (!entry) return false;
    if (entry.queuedMedia) return true;
    if (session?.prefetched?.entryId === entry.entryId && session.prefetched.media) return true;
    if (typeof this.app?.musicLibrary?.hasReady === 'function' && ['youtube', 'audius', 'telegram', 'music'].includes(entry.provider)) {
      return this.app.musicLibrary.hasReady(entry, {
        video: entry.mediaType === 'video',
        isChannel: Boolean(session?.isChannel),
        eqPreset: session?.eqPreset || (session?.bass ? 'bass' : 'off'),
        djNote: session?.aiDj?.introNote || ''
      });
    }
    return false;
  }
  botKey(ctx) { return String(ctx.api?.me?.id || ctx.botUsername || ''); }
  destination(ctx) {
    if(ctx.musicPanel)return ctx.musicPanel.chatId;
    if (Number(ctx.chatId)<0) return Number(ctx.chatId);
    const binding=this.destinations.get(`${this.botKey(ctx)}:${ctx.tgId}`);
    if (!binding) throw new MusicError('DESTINATION_REQUIRED','Use this command in a group, or select your channel in private chat with /channel @channelname.');
    return binding;
  }
  rate(ctx) {
    const now=Date.now(); for (const [key,t] of this.rates) if(now-t>60000)this.rates.delete(key);
    const key=`${ctx.chatId}:${ctx.tgId}`; if(now-(this.rates.get(key)||0)<1000) throw new MusicError('SLOW_DOWN','Please wait a moment before another music request.'); this.rates.set(key,now);
  }
  isDj(ctx, id) {
    const djs = this.app.db?.getSetting?.(`music.djs.${id}`, []) || [];
    return Array.isArray(djs) && djs.map(String).includes(String(ctx.tgId));
  }
  getVcSudoList(id = null) {
    const globalList = this.app?.db?.getSetting?.('music.vcsudo.global', []) || [];
    const chatList = id !== null && id !== undefined ? (this.app?.db?.getSetting?.(`music.vcsudo.${id}`, []) || []) : [];
    return {
      global: Array.isArray(globalList) ? globalList.map(String) : [],
      chat: Array.isArray(chatList) ? chatList.map(String) : []
    };
  }
  isVcSudo(ctx, id = null) {
    if (!ctx) return false;
    if (this.superAdmin(ctx)) return true;
    const { global, chat } = this.getVcSudoList(id);
    const combined = new Set([...global, ...chat].map(s => String(s).toLowerCase().replace(/^@/, '')));
    if (ctx.tgId !== undefined && ctx.tgId !== null && combined.has(String(ctx.tgId).toLowerCase())) return true;
    const uname = String(ctx.user?.username || ctx.from?.username || '').toLowerCase().replace(/^@/, '');
    if (uname && combined.has(uname)) return true;
    return false;
  }
  isVcSudoEnforced(id = null) {
    if (id !== null && id !== undefined) {
      const chatEnforced = this.app?.db?.getSetting?.(`music.vcsudo.enforced.${id}`, null);
      if (typeof chatEnforced === 'boolean') return chatEnforced;
    }
    const globalEnforced = this.app?.db?.getSetting?.('music.vcsudo.enforced', null);
    if (typeof globalEnforced === 'boolean') return globalEnforced;
    const { global, chat } = this.getVcSudoList(id);
    if (global.length > 0 || chat.length > 0) return true;
    if (Boolean(this.app?.env?.BOT_TOKEN)) return true;
    return false;
  }
  getMovieBroadcastStatus(chatId = null, botId = 0) {
    const dbGlobal = this.app?.db?.getSetting?.('cinema.announceEnabled', null);
    const settingsGlobal = this.app?.settings?.get?.('music.cinemaAnnounceEnabled');
    const globalEnabled = typeof dbGlobal === 'boolean' ? dbGlobal : (settingsGlobal !== false);
    const cid = Number(chatId);
    const groupEnabled = (Number.isFinite(cid) && cid < 0)
      ? (this.app?.db?.getSetting?.(`cinema.announceGroup.${cid}`, true) !== false)
      : true;
    const eligibleUsersCount = typeof this.app?.cinemaAnnouncer?.getEligibleUserIds === 'function'
      ? this.app.cinemaAnnouncer.getEligibleUserIds(Number(botId) || 0).length
      : null;
    return { globalEnabled, groupEnabled, chatId: Number.isFinite(cid) ? cid : null, eligibleUsersCount };
  }
  async setMovieBroadcast(ctx, { scope = 'global', enable, chatId = null } = {}) {
    const targetChatId = Number(chatId ?? ctx?.chatId);
    const botId = Number(ctx?.botId ?? ctx?.controller?.botContext?.botId ?? 0) || 0;
    const val = Boolean(enable);
    if (scope === 'group') {
      if (!Number.isFinite(targetChatId) || targetChatId >= 0) {
        throw new MusicError('GROUP_ONLY', 'Per-group broadcast toggle applies inside a group chat.');
      }
      if (!this.owner(ctx) && !this.superAdmin(ctx) && !this.isVcSudo(ctx, targetChatId) && !(await this.#isChatSuperAdmin(ctx, targetChatId))) {
        throw new MusicError('ADMIN_ONLY', 'Only Bot Owner, VC Sudo, or Group Admins can change this group\'s movie broadcast setting.');
      }
      this.app?.db?.setSetting?.(`cinema.announceGroup.${targetChatId}`, val);
    } else {
      if (!this.owner(ctx) && !this.superAdmin(ctx)) {
        throw new MusicError('OWNER_ONLY', 'Only the Bot Owner can allow or disallow broadcasting movies to all users.');
      }
      this.app?.db?.setSetting?.('cinema.announceEnabled', val);
      try { this.app?.settings?.set?.('music.cinemaAnnounceEnabled', val); } catch {}
    }
    return { scope, enabled: val, ...this.getMovieBroadcastStatus(targetChatId, botId) };
  }
  async movieBroadcastCommand(ctx, args = []) {
    const tokens = (Array.isArray(args) ? args : String(args || '').split(/\s+/))
      .map(s => String(s || '').trim().toLowerCase())
      .filter(Boolean);
    const cid = Number(ctx?.chatId);
    const botId = Number(ctx?.botId ?? ctx?.controller?.botContext?.botId ?? 0) || 0;
    const isGroupScope = ['group', 'gc', 'chat', 'here'].includes(tokens[0]);
    const verb = isGroupScope ? (tokens[1] || '') : (tokens[0] || '');

    const onWords = new Set(['on', 'allow', 'enable', 'enabled', 'true', 'yes', '1', 'all', 'start']);
    const offWords = new Set(['off', 'disallow', 'disable', 'disabled', 'false', 'no', '0', 'mute', 'stop']);

    if (!verb || verb === 'status' || verb === 'info') {
      if (!this.owner(ctx) && !this.superAdmin(ctx) && !(Number.isFinite(cid) && cid < 0 && (this.isVcSudo(ctx, cid) || await this.#isChatSuperAdmin(ctx, cid)))) {
        throw new MusicError('OWNER_ONLY', 'Only the Bot Owner can manage movie broadcast settings.');
      }
      return { action: 'status', scope: isGroupScope ? 'group' : 'global', ...this.getMovieBroadcastStatus(cid, botId) };
    }
    if (onWords.has(verb)) {
      const res = await this.setMovieBroadcast(ctx, { scope: isGroupScope ? 'group' : 'global', enable: true, chatId: cid });
      return { action: 'set', ...res };
    }
    if (offWords.has(verb)) {
      const res = await this.setMovieBroadcast(ctx, { scope: isGroupScope ? 'group' : 'global', enable: false, chatId: cid });
      return { action: 'set', ...res };
    }
    throw new MusicError('INVALID_ARG', 'Use /moviecast allow, /moviecast disallow, or /moviecast group on|off.');
  }
  async vcsudoCommand(ctx, args = []) {
    return this.#manageVcSudo(ctx, args, { defaultAction: null });
  }
  async rmsudoCommand(ctx, args = []) {
    return this.#manageVcSudo(ctx, args, { defaultAction: 'remove' });
  }
  async #manageVcSudo(ctx, args = [], { defaultAction = null } = {}) {
    const chatId = Number(ctx.chatId);
    const targetChatId = chatId < 0 ? chatId : null;
    if (!this.superAdmin(ctx) && !this.isVcSudo(ctx, targetChatId) && !(await this.#isChatSuperAdmin(ctx, targetChatId))) {
      throw Object.assign(new MusicError('ADMIN_ONLY', 'Only the Bot Owner, Super Admins, or authorized VC Sudo users can manage /vcsudo.'), { silent: true });
    }
    const rawArgs = (Array.isArray(args) ? args : String(args || '').split(/\s+/)).map(s => String(s || '').trim()).filter(Boolean);
    const hasGlobalFlag = rawArgs.some(a => a === '--global' || a === '-g');
    const positional = rawArgs.filter(a => a !== '--global' && a !== '-g');
    const isGlobal = hasGlobalFlag || !targetChatId;
    if (hasGlobalFlag && targetChatId && !this.superAdmin(ctx) && !this.isVcSudo(ctx, null)) {
      throw Object.assign(new MusicError('ADMIN_ONLY', 'Only the Bot Owner, Super Admins, or Global VC Sudo users can modify Global VC Sudo.'), { silent: true });
    }
    const scopeKey = isGlobal ? 'music.vcsudo.global' : `music.vcsudo.${targetChatId}`;
    const scopeLabel = isGlobal ? 'Global VC Sudo' : `Chat VC Sudo (${targetChatId})`;
    const current = new Set((this.app?.db?.getSetting?.(scopeKey, []) || []).map(s => String(s).replace(/^@/, '')));
    const firstLower = String(positional[0] || '').toLowerCase();

    if (firstLower === 'list' || (!defaultAction && !firstLower && !ctx.replyTo?.from?.id)) {
      const { global, chat } = this.getVcSudoList(targetChatId);
      const enforced = this.isVcSudoEnforced(targetChatId);
      const lines = [
        `🛡️ <b>VC Sudo Access Control</b> · <i>${enforced ? 'STRICT (Active)' : 'Standard'}</i>`,
        `• <b>Global VC Sudo:</b> ${global.length ? global.map(u => `<code>${u}</code>`).join(', ') : '<i>Owner only</i>'}`
      ];
      if (targetChatId) {
        lines.push(`• <b>This Group VC Sudo:</b> ${chat.length ? chat.map(u => `<code>${u}</code>`).join(', ') : '<i>None added yet</i>'}`);
      }
      lines.push(
        '',
        '<b>Usage:</b>',
        '• Reply <code>/vcsudo</code> to a user\'s message to grant/revoke VC Sudo',
        '• <code>/vcsudo add &lt;user_id|@username&gt;</code>',
        '• <code>/rmsudo &lt;user_id|@username&gt;</code> (or reply <code>/rmsudo</code>)',
        '• <code>/vcsudo remove &lt;user_id|@username&gt;</code>',
        '• <code>/rmsudo clear</code> · <code>/vcsudo clear</code>'
      );
      return lines.join('\n');
    }

    if (firstLower === 'clear' || (defaultAction === 'remove' && firstLower === 'all')) {
      this.app?.db?.setSetting?.(scopeKey, []);
      return `🛡️ Cleared all entries in ${scopeLabel}. Only Bot Owner (and Global VC Sudo) can control VC now.`;
    }

    if (!defaultAction && (firstLower === 'strict' || firstLower === 'enforce')) {
      const mode = String(positional[1] || 'on').toLowerCase();
      const val = !['off', 'false', '0', 'disable'].includes(mode);
      const enforceKey = targetChatId ? `music.vcsudo.enforced.${targetChatId}` : 'music.vcsudo.enforced';
      this.app?.db?.setSetting?.(enforceKey, val);
      return `🛡️ VC Sudo strict mode is now <b>${val ? 'ON (random group admins blocked & unauthorized users ignored silently)' : 'OFF'}</b>.`;
    }

    const isSubVerb = ['add', 'remove', 'del', 'rm'].includes(firstLower);
    const op = defaultAction === 'remove'
      ? 'remove'
      : (isSubVerb ? firstLower : null);
    const targetArgs = (isSubVerb ? positional.slice(1) : positional)
      .map(s => String(s || '').replace(/^@/, '').trim())
      .filter(Boolean);

    const replyId = ctx.replyTo?.from?.id ? String(ctx.replyTo.from.id) : null;
    const replyUname = ctx.replyTo?.from?.username ? String(ctx.replyTo.from.username).replace(/^@/, '').trim() : null;
    const validTargetRe = /^(?:\d+|[a-zA-Z0-9_]{3,32})$/;
    const invalidUsage = defaultAction === 'remove'
      ? 'Reply /rmsudo to a user\'s message, or pass a user ID / @username: /rmsudo <user-id>'
      : 'Reply /vcsudo to a user\'s message, or pass a user ID / @username: /vcsudo add <user-id>';

    if (targetArgs.length > 0 && targetArgs.some(t => !validTargetRe.test(t))) {
      throw new MusicError('INVALID_VCSUDO', invalidUsage);
    }

    let targets = targetArgs;
    if (!targets.length) {
      if (!replyId || !validTargetRe.test(replyId)) {
        throw new MusicError('INVALID_VCSUDO', invalidUsage);
      }
      targets = [replyId];
    }

    const replyLookup = (!targetArgs.length && replyId)
      ? [replyId, ...(replyUname && validTargetRe.test(replyUname) ? [replyUname] : [])]
      : null;

    const findMatches = (candidates) => {
      const norms = new Set(candidates.map(c => c.toLowerCase()));
      return [...current].filter(x => norms.has(x.toLowerCase()));
    };

    const existingMatches = replyLookup ? findMatches(replyLookup) : findMatches(targets);
    const isRemove = ['remove', 'del', 'rm'].includes(op) || (!['add'].includes(op) && existingMatches.length > 0);

    if (isRemove) {
      const removed = [];
      const notFound = [];
      if (replyLookup) {
        for (const m of existingMatches) {
          current.delete(m);
          removed.push(m);
        }
        if (!removed.length) notFound.push(replyId);
      } else {
        for (const rawTarget of targets) {
          const match = [...current].find(x => x.toLowerCase() === rawTarget.toLowerCase());
          if (match) {
            current.delete(match);
            removed.push(match);
          } else {
            notFound.push(rawTarget);
          }
        }
      }
      this.app?.db?.setSetting?.(scopeKey, [...current]);
      if (targetChatId) this.app?.db?.setSetting?.(`music.vcsudo.enforced.${targetChatId}`, true);
      if (removed.length > 0) {
        const removedHtml = removed.map(u => `<code>${u}</code>`).join(', ');
        const extra = notFound.length ? ` (not in list: ${notFound.map(u => `<code>${u}</code>`).join(', ')})` : '';
        return `🛡️ Removed ${removedHtml} from ${scopeLabel}.${extra}`;
      }
      const missingHtml = notFound.map(u => `<code>${u}</code>`).join(', ');
      let msg = `🛡️ ${missingHtml} is not listed in ${scopeLabel}.`;
      if (!isGlobal) {
        const globalMatches = new Set(this.getVcSudoList(targetChatId).global.map(x => x.toLowerCase()));
        const inGlobal = (replyLookup || targets).find(t => globalMatches.has(t.toLowerCase()));
        if (inGlobal) {
          msg += `\n💡 <code>${inGlobal}</code> is in <b>Global VC Sudo</b> — use <code>/rmsudo ${inGlobal} --global</code> if authorized.`;
        }
      }
      return msg;
    }

    const added = [];
    for (const rawTarget of targets) {
      const existing = [...current].find(x => x.toLowerCase() === rawTarget.toLowerCase());
      if (!existing) current.add(rawTarget);
      added.push(existing || rawTarget);
    }
    this.app?.db?.setSetting?.(scopeKey, [...current]);
    if (targetChatId) this.app?.db?.setSetting?.(`music.vcsudo.enforced.${targetChatId}`, true);
    else this.app?.db?.setSetting?.('music.vcsudo.enforced', true);
    const addedHtml = added.map(u => `<code>${u}</code>`).join(', ');
    return `🛡️ Added ${addedHtml} to ${scopeLabel}. They are now authorized to control Voice Chat playback and queues.`;
  }
  async chatDjCommand(ctx, text) {
    const id = await this.authorize(ctx, true, null, { allowDj: true });
    const qm = this.app.musicQueueManager;
    const s = qm.getSession(id);
    if (ctx.message?.chat?.id === id) {
      s.isChannel = ctx.message.chat.type === 'channel';
      if (ctx.message.chat.title) s.destinationTitle = ctx.message.chat.title;
    }
    if (!s.destinationTitle || s.destinationTitle === String(id)) {
      try {
        const chat = await ctx.api?.getChat?.(id);
        if (chat) {
          s.isChannel = chat.type === 'channel';
          s.destinationTitle = chat.title || (s.isChannel ? 'Channel' : 'Group');
        }
      } catch {}
    }
    this.syncEqSettings(s, id);
    this.aiDj.toggle(id, true);
    const res = await this.aiDj.chatWithDj(s, text, { ctx, apply: true });
    s.lastNotice = `🎙️ DJ · ${String(res.reply || '').split('\n')[0].replace(/^🎙️\s*/, '').slice(0, 140)}`;
    if (s.screenMessageId || !s.isChannel || Number(ctx.chatId) > 0 || res.added?.length || ['playing', 'paused', 'buffering'].includes(s.status)) {
      await this.player(ctx, id).catch(() => {});
    } else {
      await qm.updatePlayerCard(id).catch(() => {});
    }
    return { ...res, chatId: id, session: s };
  }
  async djCommand(ctx, args = []) {
    const sub = String(args[0] || '').toLowerCase();
    const isRoleSub = ['add', 'remove', 'list', 'clear'].includes(sub);
    const looksLikeUserId = /^@?\d+$/.test(String(args[1] || args[0] || ''));
    if (args.length > 0 && !isRoleSub && !ctx.replyTo?.from?.id && !looksLikeUserId && this.aiDj?.chatWithDj) {
      const res = await this.chatDjCommand(ctx, args.join(' '));
      return { kind: 'ai_chat', ...res };
    }
    const id = await this.authorize(ctx, true);
    const key = `music.djs.${id}`;
    const current = new Set((this.app.db?.getSetting?.(key, []) || []).map(String));
    if (sub === 'list' || (!sub && !ctx.replyTo?.from?.id)) {
      const list = [...current];
      return list.length ? `🎧 Authorized DJs for this chat:\n${list.map(u => `• ${u}`).join('\n')}\n\nReply /dj to a member's message, use /dj add <user-id>, or chat directly: /dj what's trending.` : '🎧 No custom DJs assigned yet. Reply /dj to a member\'s message, use /dj add <user-id>, or chat directly with Spotify AI DJ: /dj what\'s trending.';
    }
    if (sub === 'clear') {
      this.app.db?.setSetting?.(key, []);
      return '🎧 Cleared all custom DJ roles for this chat.';
    }
    const targetId = ctx.replyTo?.from?.id ? String(ctx.replyTo.from.id) : String(args[1] || args[0] || '').replace(/^@/, '');
    if (!/^\d+$/.test(targetId)) throw new MusicError('INVALID_DJ', 'Reply /dj to a member\'s message, or pass a numeric Telegram user ID: /dj add <user-id>.');
    if (sub === 'remove' || (sub !== 'add' && current.has(targetId))) {
      current.delete(targetId);
      this.app.db?.setSetting?.(key, [...current]);
      return `🎧 Removed DJ role from user ${targetId}.`;
    }
    current.add(targetId);
    this.app.db?.setSetting?.(key, [...current]);
    return `🎧 Granted DJ role to user ${targetId}. They can now queue tracks and control the player in this chat.`;
  }
  async authorize(ctx, destructive=false, destination=null, { allowDj=false }={}) {
    const id=destination ?? this.destination(ctx);
    const remote=Number(ctx.chatId)!==id;
    if(remote){
      if(Number(ctx.chatId)<=0 || Number(ctx.chatId)!==Number(ctx.tgId))throw new MusicError('PERMISSION_DENIED','Use your own private chat to control a channel.');
      const chat=await ctx.api?.getChat(id).catch(()=>null);
      if(!chat || (chat.type!=='channel'&&!this.superAdmin(ctx)))throw new MusicError('PERMISSION_DENIED','Only verified channel administrators can use this private controller.');
      if(chat.type==='channel'){
        const me=ctx.api?.me || (await ctx.api?.getMe?.().catch(()=>null));
        const botId=me?.id;
        const bot=botId?await ctx.api.getChatMember(id,botId).catch(()=>null):null;
        if(!bot||!['creator','administrator'].includes(bot.status))throw new MusicError('BOT_ADMIN_REQUIRED','Make this bot a channel administrator before opening its private dashboard.');
      }else if(this.superAdmin(ctx))return id;
    }else if(this.superAdmin(ctx) || this.isVcSudo(ctx, id))return id;
    const isChannelChat = Boolean(ctx.isChannel || ctx.chatType === 'channel' || ctx.message?.chat?.type === 'channel' || this.app?.musicQueueManager?.getSession?.(id)?.isChannel);
    const nativeChannelPost = Boolean(
      isChannelChat && !ctx.query && (
        ctx.isNativeChannelPost ||
        ctx.channelAdminVerified ||
        (
          !ctx.message?.from &&
          !ctx.message?.is_automatic_forward &&
          (ctx.message?.sender_chat?.id != null
            ? Number(ctx.message.sender_chat.id) === id
            : (Number(ctx.tgId) === id && Number(ctx.chatId) === id && ctx.message?.chat?.type === 'channel'))
        )
      )
    );
    if (!remote && nativeChannelPost) return id;
    if (isChannelChat && !remote && ctx.channelAdminVerified === true) return id;
    if (!remote && !isChannelChat && Number(ctx.chatId) < 0 && !ctx.query && Number(ctx.tgId) === id) return id;
    if (!remote && !isChannelChat && Number(ctx.chatId) < 0 && isAnonymousGroupAdmin(ctx.message, id)) return id;
    const vcSudoEnforced = !remote && Number(id) < 0 && !isChannelChat && this.isVcSudoEnforced(id);
    if (vcSudoEnforced && destructive) {
      if (allowDj && this.isDj(ctx, id)) return id;
      if (await this.#isChatSuperAdmin(ctx, id)) return id;
      throw Object.assign(new MusicError('ADMIN_ONLY', 'Only authorized VC Sudo users can operate the player or change Voice Chat playback.'), { silent: true });
    }
    const uid = Number(ctx.tgId);
    if (isChannelChat && (!Number.isFinite(uid) || uid <= 0 || [136817688, 1087968824, 777000].includes(uid))) {
      throw new MusicError('ADMIN_ONLY', 'Only verified channel administrators can use bot controls in this channel.');
    }
    const member=await ctx.api?.getChatMember?.(id,uid).catch(()=>null);
    if(!member || !['creator','administrator','member','restricted'].includes(member.status) || (member.status==='restricted'&&!member.is_member)) {
      throw Object.assign(new MusicError('PERMISSION_DENIED','Membership could not be verified.'), vcSudoEnforced ? { silent: true } : {});
    }
    const requireAdmin = destructive || remote || isChannelChat;
    if(requireAdmin&&!['creator','administrator'].includes(member.status)&&!(!isChannelChat&&allowDj&&!remote&&this.isDj(ctx,id))) {
      throw Object.assign(new MusicError('ADMIN_ONLY', isChannelChat ? 'Only verified channel administrators can use bot controls in this channel.' : 'Only verified chat administrators can operate the player or change playback, queue and settings.'), vcSudoEnforced ? { silent: true } : {});
    }
    return id;
  }
  async startSearch(ctx,query,mode='queue') {
    this.rate(ctx);
    const isChannelChat = Boolean(ctx.isChannel || ctx.chatType === 'channel' || ctx.message?.chat?.type === 'channel' || this.app?.musicQueueManager?.getSession?.(Number(ctx.chatId))?.isChannel);
    const destination=(['download','lyrics'].includes(mode) && !isChannelChat) ? Number(ctx.chatId) : await this.authorize(ctx,true,null,{allowDj:!isChannelChat});
    let sessionChannel = isChannelChat;
    if (!['download','lyrics'].includes(mode)) { const state=this.app.musicQueueManager.getSession(destination); if (ctx.message?.chat?.id === destination) { state.isChannel = ctx.message.chat.type === 'channel'; if (ctx.message.chat.title) state.destinationTitle = ctx.message.chat.title; } this.syncEqSettings(state,destination); await this.prepare(ctx,destination); if (!state.destinationTitle || state.destinationTitle === String(destination)) { const chat=await ctx.api?.getChat?.(destination).catch(()=>null); if (chat) { state.isChannel=chat.type==='channel'; state.destinationTitle=chat.title||String(destination); } } sessionChannel=Boolean(state.isChannel||sessionChannel); }
    const s=this.search.create({ userId:ctx.tgId,chatId:ctx.chatId,botId:this.botKey(ctx),destination,query,mode,isChannel:sessionChannel && Number(ctx.chatId)===Number(destination) });
    s.queueDestination=ctx.musicPanel?.chatId||(Number(ctx.chatId)<0?Number(ctx.chatId):this.destinations.get(`${this.botKey(ctx)}:${ctx.tgId}`))||null;
    if(!['download','lyrics'].includes(mode))s.destinationTitle=this.app.musicQueueManager.getSession(destination).destinationTitle;
    await this.search.page(s,0); return s;
  }
  async submit(ctx,s,{playNow=false}={}) {
    if (!s.selected.size) throw new MusicError('EMPTY_SELECTION','Select at least one track.');
    if(s.mode==='lyrics'){if(s.selected.size!==1)throw new MusicError('ONE_SELECTION','Select one recording for lyrics.');s.lyricsTrack=[...s.selected.values()][0];s.lyricsResult=await this.lyrics.get(s.lyricsTrack);s.consumed=true;return;}
    if (s.mode==='download') {
      if (s.selected.size!==1) throw new MusicError('ONE_DOWNLOAD','Choose one track to download.');
      const userKey = String(ctx.tgId || ctx.chatId || 'anon');
      const activeUserDownloads = this.userDownloads.get(userKey) || 0;
      if(activeUserDownloads>=this.maxUserDownloads || this.downloads>=this.maxDownloads)throw new MusicError('DOWNLOAD_BUSY','Two full-song deliveries are already being prepared. Please try again shortly.');
      this.downloads++;
      this.userDownloads.set(userKey, activeUserDownloads + 1);
      try{
      const permission=await checkChatMediaPermissions(ctx.api,ctx.chatId,Number(ctx.tgId)).catch(()=>null);
      if(permission?.canSendAudios===false)throw new MusicError('MEDIA_RESTRICTED','Audio uploads are restricted in this chat.');
      const track=[...s.selected.values()][0]; const media=await this.app.musicLibrary.acquire(track,{download:true});
      try {
        if(media.track.id!==track.id)throw new MusicError('TRACK_MISMATCH','The provider returned a different recording.');
        const listen=this.rememberListen(ctx,media.track,s.queueDestination);
        const lyrics=await Promise.resolve(this.lyrics?.get?.(media.track)).catch(()=>null);
        const uploaded=await audioUpload(media);
        const {rich,files}=await originalPlayDelivery({app:this.app,ctx,track:media.track,audio:uploaded.music_full_audio,lyrics,allowArtwork:permission?.canSendPhotos!==false});
        const sent=s.messageId && s.messageId===ctx.messageId
          ? await ctx.api.editMessageRich(ctx.chatId,s.messageId,rich,{},files)
          : await ctx.api.sendRichMessage(ctx.chatId,rich,{},files);
        this.previews.remember(ctx.api,media.track,audioFileId(sent));
        s.consumed=true; s.deliveryMessageId=sent?.message_id || s.messageId;listen.messageId=s.deliveryMessageId;
      } finally { media.release(); }
      }finally{
        this.downloads--;
        const left = (this.userDownloads.get(userKey) || 1) - 1;
        if (left <= 0) this.userDownloads.delete(userKey);
        else this.userDownloads.set(userKey, left);
      }
      return;
    }
    const generation=this.queueGeneration(s.destination);await this.authorize(ctx,true,s.destination,{allowDj:true});this.assertQueueGeneration(s.destination,generation);if(typeof this.app.voiceClient?.setup==='function')await this.prepare(ctx,s.destination);this.assertQueueGeneration(s.destination,generation); const mediaType=(s.mode==='video'||(s.mode==='queue'&&this.hasYoutubeVideo()))?'video':'audio';const tracks=[...s.selected.values()].map(t=>({...t,mediaType,requester:ctx.user?.username || ctx.user?.first_name || 'Member'}));
    const qm = this.app.musicQueueManager;
    const shouldPlayNow = Boolean(playNow || s.playNow);
    if (shouldPlayNow && tracks.length > 0 && typeof qm.playImmediateAndContinue === 'function') {
      await qm.playImmediateAndContinue(s.destination, tracks[0]);
      if (tracks.length > 1) {
        const sess = qm.getSession(s.destination);
        const extra = tracks.slice(1).map((t) => qm.createQueueEntry ? qm.createQueueEntry(t) : { ...t, entryId: randomBytes(8).toString('hex') });
        sess.upcoming.unshift(...extra);
      }
      const sess = qm.getSession(s.destination);
      sess.lastNotice = `⚡ Playing "${tracks[0].title}" immediately — previous playlist will continue after.`;
    } else {
      await qm.addMany(s.destination,tracks);
    }
    s.consumed=true;
    await this.player(ctx,s.destination);
  }
  async player(ctx,id=this.destination(ctx)) { return this.panelLock.run(id,()=>this._player(ctx,id)); }
  async aidjCommand(ctx, args = []) {
    const id = await this.authorize(ctx, true, null, { allowDj: true });
    const qm = this.app.musicQueueManager;
    const s = qm.getSession(id);
    this.aiDj.syncSession(s);
    const sub = String(args[0] || '').toLowerCase();
    if (sub === 'off' || sub === 'stop' || sub === 'disable') {
      const cfg = this.aiDj.toggle(id, false);
      s.lastNotice = '🤖 AI DJ turned off. Existing queue is retained.';
      await qm.updatePlayerCard(id);
      return cfg;
    }
    const rawArgs = args.join(' ').trim();
    if (sub === 'desk' || sub === 'live') {
      s.view = 'djdesk';
      await this.player(ctx, id);
      return this.aiDj.getConfig(id);
    }
    if (sub === 'chapter' || sub === 'nextchapter') {
      const chap = await this.aiDj.dropNextChapter(s);
      s.lastNotice = `⏭ Switched chapter: ${chap.chapterTitle || chap.stage}${chap.added?.length ? ` · Cued "${chap.added[0].title}"` : ''}`;
      if (chap.added?.length && !['playing', 'paused', 'buffering'].includes(s.status)) {
        await this.prepare(ctx, id);
        await qm.ensurePlaying(id);
      }
      await this.player(ctx, id);
      return this.aiDj.getConfig(id);
    }
    if (sub && !['on', 'start', 'enable', 'off', 'stop', 'disable', 'vibe', 'mood', 'skip', 'next', 'status', 'desk', 'live', 'chapter', 'nextchapter'].includes(sub) && (/\b(what|who|which|why|how|trend|chart|bass|eq|play|put\s+on|drop|pause|resume)\b|\?/i.test(rawArgs)) && this.aiDj?.chatWithDj) {
      const res = await this.chatDjCommand(ctx, rawArgs);
      return { ...this.aiDj.getConfig(id), kind: 'ai_chat', reply: res.reply, actions: res.actions, added: res.added, intent: res.intent };
    }
    if (sub === 'vibe' || sub === 'mood' || (sub && !['on', 'start', 'enable', 'skip', 'next', 'status'].includes(sub))) {
      const vibeText = ['vibe', 'mood'].includes(sub) ? args.slice(1).join(' ') : args.join(' ');
      const parsed = parseMultiArtistPrompt(vibeText, RADIO_CATEGORIES);
      const wantCount = Math.max(3, Math.min(6, parsed.artists?.length || 3));
      const cfg = this.aiDj.setVibe(id, vibeText);
      const added = await this.aiDj.curateNextTracks(s, { count: wantCount, top: parsed.artists.length >= 2 }).catch(() => []);
      s.lastNotice = added.length
        ? `🤖 AI DJ "${cfg.vibe}" loaded ${added.length} tracks.`
        : `🤖 AI DJ vibe locked to "${cfg.vibe}".`;
      if (added.length && !['playing', 'paused', 'buffering'].includes(s.status)) {
        await this.prepare(ctx, id);
        await qm.ensurePlaying(id);
      }
      await this.player(ctx, id);
      return cfg;
    }
    if (sub === 'skip' || sub === 'next') {
      this.aiDj.toggle(id, true);
      if (!s.upcoming.length) {
        await this.aiDj.curateNextTracks(s, { count: 3 }).catch(() => []);
      }
      await this.prepare(ctx, id);
      await qm.skip(id);
      await this.player(ctx, id);
      return this.aiDj.getConfig(id);
    }
    const cfg = sub === 'status' ? this.aiDj.getConfig(id) : this.aiDj.toggle(id, sub === 'on' || sub === 'start' || sub === 'enable' ? true : undefined);
    if (cfg.enabled && s.upcoming.length < 2) {
      const added = await this.aiDj.curateNextTracks(s, { count: 3 }).catch(() => []);
      if (added.length && !['playing', 'paused', 'buffering'].includes(s.status)) {
        await this.prepare(ctx, id);
        await qm.ensurePlaying(id);
      }
    }
    s.lastNotice = cfg.enabled
      ? `🤖 AI DJ active · ${cfg.vibe}${s.aiDj?.introNote ? ` — ${s.aiDj.introNote}` : ''}`
      : '🤖 AI DJ paused.';
    await this.player(ctx, id);
    return cfg;
  }
  async _player(ctx,id) {
    await this.authorize(ctx,true,id,{allowDj:true});
    const qm=this.app.musicQueueManager,s=qm.getSession(id);
    const chat=await ctx.api.getChat(id).catch(()=>null);
    let bridgeInviteLink = s.callInviteLink || null;
    if (!bridgeInviteLink && (s.connected || s.prepared) && typeof this.app?.voiceClient?.getCallInviteLink === 'function') {
      const linkRes = await this.app.voiceClient.getCallInviteLink(id).catch(() => null);
      if (linkRes?.call_invite_link) bridgeInviteLink = linkRes.call_invite_link;
    }
    const prevPlayerChatId = s.playerChatId;
    const sameBot = isSameMusicBot(s, ctx);
    const sessionIsChannel = Boolean(s.isChannel || chat?.type === 'channel');
    const activeSession = Boolean(s.connected || ['playing', 'paused', 'buffering'].includes(s.status));
    if(s.screenMessageId && !sessionIsChannel && activeSession && (s.playerChatId!==Number(ctx.chatId) || !sameBot)) {
      throw new MusicError('PLAYER_ELSEWHERE','This destination already has its player dashboard in another control chat/bot. Use that dashboard.');
    }
    await this.syncSessionIdentity(s,ctx,chat,{bridgeInviteLink}); this.syncEqSettings(s,id);
    if(s.status==='stopped'){s.status='idle';s.lastError=null;}
    const isCinemaDeck = s.activeDeck === 'movie' || s.currentTrack?.provider === 'movie';
    if(s.currentTrack && !isCinemaDeck)this.requestCardLyrics(s);
    if(s.isChannel && Number(ctx.chatId) > 0)return this.channelPanels.open(ctx,s,{forceNew:Boolean(ctx.forceNew)});
    s.view=isCinemaDeck?'cinema':'player';
    s.overlayView=null;
    s.overlayAt=0;
    const sendFreshPlayerCard = async () => {
      const oldMessageId = s.screenMessageId;
      const oldPlayerChatId = prevPlayerChatId || Number(ctx.chatId);
      const screen = resolveAppScreen(this.app, 'music', { ctx, session: s });
      const rich = isCinemaDeck && typeof screen.renderCinemaPlayer === 'function' ? screen.renderCinemaPlayer(s) : screen.renderPlayer(s);
      const wantPhoto = hasRichPhotoPayload(rich);
      let sent = null;
      let sentHasPhoto = wantPhoto;
      if (ctx.reuseMessageId && Number(ctx.chatId) === Number(id) && typeof ctx.api.editMessageRich === 'function') {
        try {
          const edited = await ctx.api.editMessageRich(ctx.chatId, ctx.reuseMessageId, rich);
          sent = edited?.message_id ? edited : { message_id: ctx.reuseMessageId };
        } catch (editErr) {
          if (!wantPhoto || !isRemotePhotoError(editErr)) {
            // Fall through cleanly to sendRichMessage if message can't be edited in place
          }
        }
      }
      if (!sent) {
        const out = await sendRichWithPhotoFallback(ctx.api, ctx.chatId, rich);
        sent = out.sent;
        sentHasPhoto = out.hasPhoto;
        if (sent?.message_id && ctx.reuseMessageId && sent.message_id !== ctx.reuseMessageId && typeof ctx.api.deleteMessage === 'function') {
          await ctx.api.deleteMessage(ctx.chatId, ctx.reuseMessageId).catch(() => {});
        }
      }
      const sentPhotoUrl = extractRichPhotoUrl(rich);
      if (sentPhotoUrl) {
        s._photoUpgradeAttemptedUrl = sentPhotoUrl;
        if (!sentHasPhoto) {
          s._photoBlockedUrl = sentPhotoUrl;
        } else {
          const fid = extractSentPhotoFileId(sent);
          if (fid) {
            if (!s._photoFileIdByUrl) s._photoFileIdByUrl = new Map();
            s._photoFileIdByUrl.set(sentPhotoUrl, fid);
          }
        }
      }
      if (sent?.message_id && sent.message_id !== oldMessageId) {
        s.pinned = false;
        s.pinnedMessageId = null;
      }
      qm.setPlayerMessage(id, sent.message_id, Number(ctx.chatId), ctx.api);
      s.lastRender = JSON.stringify(rich);
      s.lastRenderHasPhoto = sentHasPhoto;
      s.editAfter = 0;
      if (oldMessageId && oldMessageId !== sent.message_id && sameBot && typeof ctx.api?.deleteMessage === 'function') {
        await ctx.api.deleteMessage(oldPlayerChatId, oldMessageId).catch(() => {});
      }
      await qm.autoPinPlayerCard?.(id, sent.message_id, Number(ctx.chatId), ctx.api);
    };
    const needFreshForPhoto = Boolean(
      s.lastRenderHasPhoto === false
      && isCinemaDeck
      && (s.currentTrack?.artwork || s.currentTrack?.poster || s.currentTrack?.backdrop)
      && s._photoUpgradeAttemptedUrl !== (s.currentTrack?.artwork || s.currentTrack?.poster || s.currentTrack?.backdrop)
      && s._photoBlockedUrl !== (s.currentTrack?.artwork || s.currentTrack?.poster || s.currentTrack?.backdrop)
    );
    let created = Boolean(!s.screenMessageId || ctx.forceNew || !sameBot || needFreshForPhoto || (prevPlayerChatId && prevPlayerChatId !== Number(ctx.chatId)));
    if(created){
      await sendFreshPlayerCard();
    } else {
      const updated = await qm.updatePlayerCard(id, { forceEdit: true });
      if(!updated){
        created = true;
        await sendFreshPlayerCard();
      }
    }
    if (!isCinemaDeck) this.previews.schedule(s);
    if(created&&s.fullPreview&&!isCinemaDeck)await qm.updatePlayerCard(id);
    return s;
  }
  async control(ctx,action,args=[]) {
    if(!['player','queue','qpage','playnow','mqueue','mqpage','mplaynow','switchdeck','lyrics','lypage','accounts','volume','setvol','options','eq','streammode','vcquality','switchsource','audiolang','submode','subsync','subtrack','subcheck','vcmsg','voteskip','votequeue','voteset','setvotethresh','autopoll','launchpoll','downloadnow','downloadq','dlq','bass','aidj','djdesk','seek','seekby','seekmenu','setseekstep','pause','resume','skip','previous','loop','shuffle','pin','retry'].includes(action))this.rate(ctx);
    const destination=this.destination(ctx);
    // Urgent Stop must reach the queue cancellation path even when an older
    // Skip/radio control is still waiting for source preparation. _control still
    // performs fresh authorization and full callback/message validation first.
    if(['stop','leave','seekby'].includes(action))return this._control(ctx,action,[...args]);
    return this.controlLock.run(destination,()=>this._control(ctx,action,[...args]));
  }
  #formatSeekClock(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const hrs = Math.floor(total / 3600);
    const mins = Math.floor((total % 3600) / 60);
    const secs = String(total % 60).padStart(2, '0');
    return hrs > 0 ? `${hrs}:${String(mins).padStart(2, '0')}:${secs}` : `${mins}:${secs}`;
  }
  async #coalesceSeekBy(ctx, s, id, delta) {
    const qm = this.app.musicQueueManager;
    const rootSession = qm.getSession(id);
    const dur = Number(rootSession.currentTrack?.durationSeconds || 0);
    let state = this.pendingSeeks.get(id);
    const basePos = state
      ? state.currentTarget
      : (typeof qm.getEstimatedPosition === 'function'
        ? qm.getEstimatedPosition(id)
        : ((typeof rootSession.positionSeconds === 'number' && Number.isFinite(rootSession.positionSeconds)) ? rootSession.positionSeconds : 0));
    let targetPos = Math.max(0, basePos + delta);
    if (dur > 2 && targetPos >= dur) targetPos = Math.max(0, dur - 2);

    rootSession.positionSeconds = targetPos;
    rootSession.lastKnownPositionSeconds = targetPos;
    rootSession.positionUpdatedAt = Date.now();
    if (s && s !== rootSession) s.positionSeconds = targetPos;

    if (!state) {
      state = {
        currentTarget: targetPos,
        queuedTarget: targetPos,
        totalDelta: delta,
        timer: null,
        running: false,
        waiters: []
      };
      this.pendingSeeks.set(id, state);
    } else {
      state.currentTarget = targetPos;
      state.queuedTarget = targetPos;
      state.totalDelta += delta;
    }

    if (ctx.query?.id && ctx.api?.answerCallbackQuery) {
      const signLabel = state.totalDelta >= 0 ? `+${Math.round(state.totalDelta)}s` : `${Math.round(state.totalDelta)}s`;
      await ctx.api.answerCallbackQuery(ctx.query.id, {
        text: `${delta >= 0 ? '⏩' : '⏪'} ${this.#formatSeekClock(targetPos)} (${signLabel})`
      }).catch(() => {});
    }

    const coalesceMs = Math.max(0, Number(this.seekCoalesceMs ?? (typeof this.app?.voiceClient?.checkHealth === 'function' ? 350 : 0)));

    const flush = async () => {
      if (state.running) return;
      state.running = true;
      try {
        while (state.queuedTarget !== null) {
          const nextPos = state.queuedTarget;
          state.queuedTarget = null;
          await qm.seek(id, nextPos);
        }
        const waiters = state.waiters.splice(0);
        for (const w of waiters) w.resolve(true);
      } catch (err) {
        const waiters = state.waiters.splice(0);
        for (const w of waiters) w.reject(err);
      } finally {
        state.running = false;
        if (state.queuedTarget !== null && !state.timer) {
          void flush();
        } else if (!state.timer && state.queuedTarget === null) {
          this.pendingSeeks.delete(id);
        }
      }
    };

    return new Promise((resolve, reject) => {
      state.waiters.push({ resolve, reject });
      if (coalesceMs > 0) {
        if (state.timer) clearTimeout(state.timer);
        state.timer = setTimeout(() => {
          state.timer = null;
          void flush();
        }, coalesceMs);
        state.timer.unref?.();
      } else {
        void flush();
      }
    });
  }
  async customSeekInput(ctx, rawText) {
    const id = await this.authorize(ctx, true, null, { allowDj: true });
    const qm = this.app.musicQueueManager;
    const s = qm.getSession(id);
    const curPos = typeof qm.getEstimatedPosition === 'function' ? qm.getEstimatedPosition(id) : (Number(s.positionSeconds) || 0);
    const dur = Number(s.currentTrack?.durationSeconds || 0);
    const parsed = parseSeekInput(rawText, curPos, dur);
    if (!parsed) {
      throw new MusicError('CANNOT_SEEK', 'Send seconds (e.g. 45, +90, -30), a timestamp (e.g. 12:30, 1:05:00), or "step 45" to set your custom skip button step.');
    }
    if (parsed.kind === 'step') {
      const stepSec = qm.setSeekStep(id, parsed.seconds);
      s.lastNotice = `⏱ Custom skip buttons set to ±${stepSec}s.`;
    } else {
      await qm.seek(id, parsed.targetSeconds);
      s.lastNotice = `⏩ Jumped to ${this.#formatSeekClock(parsed.targetSeconds)}.`;
    }
    const isCinema = (s.activeDeck === 'movie' || s.currentTrack?.provider === 'movie') && s.view !== 'queue';
    if (s.view === 'seekmenu') s.view = isCinema ? 'cinema' : 'player';
    await qm.updatePlayerCard(id, { forceEdit: true });
    return parsed;
  }
  async #startCinemaDownload(ctx, s, id, targetItem, qualityRaw = null) {
    const downloader=this.app?.movieDownloader;
    if(!downloader)throw new MusicError('UNAVAILABLE','Download service is currently unavailable.');
    const uid=Number(ctx.tgId||0);
    const fallbackQ=uid>0?this.app?.db?.getUserSetting?.(uid,'movie.downloadQuality','480p'):'480p';
    const quality=normalizeDownloadQuality(qualityRaw||fallbackQ||'480p');
    if(uid>0)this.app?.db?.setUserSetting?.(uid,'movie.downloadQuality',quality);
    const userKey=String(ctx.tgId||ctx.chatId||'anon');
    const activeUserDownloads=this.userDownloads.get(userKey)||0;
    if(activeUserDownloads>=this.maxUserDownloads||this.downloads>=this.maxDownloads)throw new MusicError('DOWNLOAD_BUSY','Download queue is busy right now. Wait a few seconds and retry.');
    if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:`⬇️ Preparing ${quality} download: ${String(targetItem.title||'').slice(0,32)}…`}).catch(()=>{});
    this.downloads++;
    this.userDownloads.set(userKey,activeUserDownloads+1);
    void (async()=>{
      const dlCtx={...ctx,chatId:ctx.chatId||s.playerChatId||id};
      const titleSafe=String(targetItem.title||'Movie');
      const instantHit=Boolean(downloader.hasCachedVideo?.(targetItem,quality));
      let tracker=null;
      let statusMsg=null;
      try{
        if(!instantHit&&typeof dlCtx.api?.sendRichMessage==='function'){
          tracker=new ProgressTracker({api:dlCtx.api,chatId:dlCtx.chatId,heartbeatMs:2000,action:'upload_video'});
          await tracker.live((state,{elapsedMs})=>{
            const sec=Math.max(0,Math.floor(elapsedMs/1000));
            const pb=new RichMessageBuilder();
            pb.bannerHeader([`⬇️ ${titleSafe.slice(0,44)}`,`${quality} MP4 Download`],{size:2});
            pb.blockquote(rt.text(`${state.statusLine||'Preparing video for Telegram…'}\n⏱ Elapsed: ${sec}s`));
            pb.validate();
            return pb.toJSON();
          },{statusLine:`⬇️ Preparing ${quality} · ${titleSafe.slice(0,34)}…`}).catch(()=>{});
        }else if(!instantHit){
          statusMsg=await dlCtx.api?.sendMessage?.(dlCtx.chatId,`⬇️ Preparing <b>${titleSafe.replace(/[<>&]/g,'')}</b> (${quality}) for Telegram…`,{parse_mode:'HTML'}).catch(()=>null);
        }
        const res=await downloader.sendSingleVideo(dlCtx,targetItem,{
          quality,
          spoiler:Boolean(targetItem.isAdult&&Number(dlCtx.chatId)<0),
          onProgress:(line)=>{
            if(tracker)tracker.set({statusLine:String(line).slice(0,200)});
            else if(statusMsg?.message_id&&dlCtx.api?.editMessageText){
              void dlCtx.api.editMessageText(dlCtx.chatId,statusMsg.message_id,`⬇️ ${String(line).slice(0,200)}`).catch(()=>{});
            }
          }
        });
        if(!res?.ok){
          await dlCtx.api?.sendMessage?.(dlCtx.chatId,`⚠️ Download could not finish: ${res?.reason||'Stream unavailable'}`).catch(()=>{});
        }
      }catch(err){
        await dlCtx.api?.sendMessage?.(dlCtx.chatId,`⚠️ Download failed: ${err?.message||'Unknown error'}`).catch(()=>{});
      }finally{
        await tracker?.cleanup?.().catch(()=>{});
        if(statusMsg?.message_id)await dlCtx.api?.deleteMessage?.(dlCtx.chatId,statusMsg.message_id).catch(()=>{});
        this.downloads=Math.max(0,this.downloads-1);
        const left=(this.userDownloads.get(userKey)||1)-1;
        if(left<=0)this.userDownloads.delete(userKey);
        else this.userDownloads.set(userKey,left);
      }
    })();
  }
  async _control(ctx,action,args=[]) {
    this.bindQueuePollLifecycle();
    if(!['player','pause','resume','skip','previous','stop','leave','setvol','seek','seekby','seekmenu','setseekstep','shuffle','loop','clear','remove','volume','accounts','queue','qpage','mqueue','mqpage','mplaynow','mremove','mclear','switchdeck','lyrics','lypage','bass','eq','streammode','vcquality','switchsource','audiolang','submode','subsync','subtrack','subcheck','vcmsg','voteskip','votequeue','voteset','setvotethresh','autopoll','launchpoll','downloadnow','downloadq','dlq','selectaccount','pin','options','preview','playnow','radio','rpage','rpick','rstart','roff','retry','catmenu','catpick','genresub','infinact','aidj','djdesk'].includes(action))throw new MusicError('STALE_PLAYER','That control is no longer supported. Open /player.');
    const isViewerVote=['voteskip','votequeue'].includes(action);
    const isDownloadAct=['downloadnow','downloadq','dlq'].includes(action);
    const allowDj=!['stop','leave','accounts','selectaccount','pin','voteset','setvotethresh','autopoll'].includes(action);
    const id=await this.authorize(ctx,!(isViewerVote||isDownloadAct),null,{allowDj});
    const qm=this.app.musicQueueManager;
    const panel=ctx.musicPanel || ((qm.getSession(id).isChannel && Number(ctx.chatId) > 0) ? this.channelPanels.find(ctx,id) : null);
    const s=panel?.state ? this.channelPanels.state(panel) : panel || qm.getSession(id);
    if(s.isChannel&&!s.panelToken&&Number(ctx.chatId)>0)throw new MusicError('CHANNEL_DM_REQUIRED','Open /channel @channelname in your private chat first.');
    if(ctx.query&&!s.screenMessageId)throw new MusicError('STALE_PLAYER','That player belongs to an earlier session. Open /player.');
    const strictRevisionActions=new Set(['remove','mremove','clear','mclear','playnow','mplaynow','selectaccount','stop','leave']);
    if(ctx.query){
      const revArg = args.pop();
      const expectedRev = s.panelToken?Number(s.controlRevision||0).toString(36):String(s.controlRevision||0);
      if(strictRevisionActions.has(action) && revArg !== expectedRev)throw new MusicError('STALE_PLAYER','Use the latest player controls.');
    }
    if(ctx.messageId && s.screenMessageId && (s.screenMessageId!==ctx.messageId || s.playerChatId!==Number(ctx.chatId) || !isSameMusicBot(s, ctx))) throw new MusicError('STALE_PLAYER','Use the current player dashboard for this destination.');
    if(['pause','resume','skip','previous'].includes(action)){
      const rootSession=qm.getSession(id);
      const deckQueue = rootSession.activeDeck === 'movie' ? (rootSession.movieUpcoming || []) : (rootSession.upcoming || []);
      const deckHist = rootSession.activeDeck === 'movie' ? (rootSession.movieHistory || []) : (rootSession.history || []);
      let ackPromise=null;
      if(action==='skip'){
        const isMovieDeck = rootSession.activeDeck === 'movie';
        const ready=this.#isTrackReady(rootSession,deckQueue[0]);
        if(!ready)s.lastNotice=isMovieDeck?'⏭ Skipping to next item…':'⏭ Skipping to next track…';
        if(ctx.query?.id&&ctx.api?.answerCallbackQuery)ackPromise=ctx.api.answerCallbackQuery(ctx.query.id,{text:isMovieDeck?(ready?'⏭ Next':'⏭ Skipping…'):(ready?'⏭ Next track':'⏭ Skipping to next track…')}).catch(()=>{});
        if(!ready&&s.screenMessageId)void qm.updatePlayerCard(id).catch(()=>{});
      }else if(action==='previous'){
        const isMovieDeck = rootSession.activeDeck === 'movie';
        const ready=this.#isTrackReady(rootSession,deckHist.at?.(-1));
        if(!ready)s.lastNotice=isMovieDeck?'⏮ Loading previous item…':'⏮ Loading previous track…';
        if(ctx.query?.id&&ctx.api?.answerCallbackQuery)ackPromise=ctx.api.answerCallbackQuery(ctx.query.id,{text:isMovieDeck?(ready?'⏮ Previous':'⏮ Loading previous…'):(ready?'⏮ Previous track':'⏮ Loading previous track…')}).catch(()=>{});
        if(!ready&&s.screenMessageId)void qm.updatePlayerCard(id).catch(()=>{});
      }else if(action==='pause'){
        if(ctx.query?.id&&ctx.api?.answerCallbackQuery)ackPromise=ctx.api.answerCallbackQuery(ctx.query.id,{text:'⏸ Paused'}).catch(()=>{});
      }else if(action==='resume'){
        if(ctx.query?.id&&ctx.api?.answerCallbackQuery)ackPromise=ctx.api.answerCallbackQuery(ctx.query.id,{text:'▶ Resuming playback…'}).catch(()=>{});
        if(!s.connected){
          s.lastNotice='⏳ Reconnecting to call & starting playback…';
          if(s.screenMessageId)void qm.updatePlayerCard(id).catch(()=>{});
        }
      }
      if(action!=='pause'&&!s.connected&&typeof this.app.voiceClient?.setup==='function'){
        const generation=this.queueGeneration(id);
        await this.prepare(ctx,id);
        this.assertQueueGeneration(id,generation);
      }
      try{
        await qm[action](id);
      }catch(err){
        if(action==='resume'&&['NO_ACTIVE_CALL','CALL_FAILED','PERMISSION_DENIED','ASSISTANT_MEMBERSHIP'].includes(err?.code)&&typeof this.app.voiceClient?.setup==='function'){
          const generation=this.queueGeneration(id);
          await this.prepare(ctx,id);
          this.assertQueueGeneration(id,generation);
          await qm.resume(id);
        }else{
          throw err;
        }
      }
      if(ackPromise)await ackPromise;
    }
    else if(action==='voteskip'){
      if(!s.currentTrack||!['playing','paused'].includes(s.status))throw new MusicError('NOTHING_PLAYING','There is no active track to vote-skip.');
      const needed=this.getSkipVoteThreshold(id);
      const votes=new Set(Array.isArray(s.skipVotes)?s.skipVotes:[]);
      const voterId=String(ctx.tgId);
      if(votes.has(voterId))votes.delete(voterId);
      else votes.add(voterId);
      s.skipVotes=[...votes];
      if(s.skipVotes.length>=needed){
        s.skipVotes=[];
        s.lastNotice=`✅ Vote skip passed (${needed}/${needed}) — advancing to next.`;
        if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:'Vote skip passed! Skipping…'}).catch(()=>{});
        await qm.skip(id);
      }else{
        s.lastNotice=`⏭ Skip vote: ${s.skipVotes.length}/${needed} needed.`;
        if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:`Skip vote: ${s.skipVotes.length}/${needed}`}).catch(()=>{});
      }
      s.view=(s.activeDeck==='movie'||s.currentTrack?.provider==='movie')?'cinema':'player';
    }
    else if(action==='votequeue'){
      const deckQueue=s.activeDeck==='movie'?(s.movieUpcoming||[]):(s.upcoming||[]);
      let entryId=args[0];
      if(s.panelToken){
        const matches=deckQueue.filter(t=>t.entryId.replaceAll('-','').slice(0,12)===entryId);
        if(matches.length===1)entryId=matches[0].entryId;
      }
      const rootSession=qm.getSession(id);
      const rootQ=s.activeDeck==='movie'?(rootSession.movieUpcoming||[]):(rootSession.upcoming||[]);
      const targetEntry=rootQ.find(t=>t.entryId===entryId);
      if(!targetEntry)throw new MusicError('STALE_PLAYER','That queued item is no longer available.');
      const needed=this.getQueueVoteThreshold(id);
      const voterId=String(ctx.tgId);
      const votes=new Set(Array.isArray(targetEntry.votes)?targetEntry.votes.map(String):[]);
      if(votes.has(voterId))votes.delete(voterId);
      else votes.add(voterId);
      targetEntry.votes=[...votes];
      if(targetEntry.votes.length>=needed){
        targetEntry.votes=[];
        const mode=this.getQueueVoteAction(id);
        s.lastNotice=`🗳 Viewer vote passed (${needed}/${needed}) for ${targetEntry.title}!`;
        if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:`🗳 Vote passed! ${mode==='playnow'?'Playing now…':'Moved to #1!'}`}).catch(()=>{});
        if(mode==='playnow'){
          if(!s.connected&&typeof this.app.voiceClient?.setup==='function'){
            const generation=this.queueGeneration(id);
            await this.prepare(ctx,id);
            this.assertQueueGeneration(id,generation);
          }
          if(s.activeDeck==='movie'||targetEntry.provider==='movie'){
            await qm.playQueuedMovieNow(id,targetEntry.entryId);
            s.view='cinema';
          }else{
            await qm.playNow(id,targetEntry.entryId);
            s.view='player';
          }
        }else if(s.activeDeck==='movie'||targetEntry.provider==='movie'){
          qm.promoteMovieTrack(id,targetEntry.entryId);
          s.view='mqueue';
        }else{
          qm.promoteTrack(id,targetEntry.entryId);
          s.view='queue';
        }
      }else{
        s.lastNotice=`🗳 Queue vote for ${targetEntry.title}: ${targetEntry.votes.length}/${needed}`;
        if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:`Queue vote: ${targetEntry.votes.length}/${needed}`}).catch(()=>{});
      }
    }
    else if(action==='voteset'){
      s.view='voteset';
      if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:'🗳 Viewer Vote Settings'}).catch(()=>{});
    }
    else if(action==='autopoll'){
      const want=args[0]==='on'?true:args[0]==='off'?false:!this.isAutoPollEnabled(id);
      this.setAutoPollEnabled(id,want);
      s.lastNotice=want
        ?'🤖 Auto-Poll is now ON · One poll posts per playing movie when queue has upcoming movies, and deletes once decided.'
        :'⚪ Auto-Poll is now OFF · Use 📊 Poll whenever you want to post a manual poll.';
      if(want)this.#scheduleAutoPoll(id,null,{delayMs:150});
      if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:want?'🤖 Auto-Poll: ON':'⚪ Auto-Poll: OFF'}).catch(()=>{});
    }
    else if(action==='setvotethresh'){
      const [kind,valRaw]=args;
      if(kind==='autopoll'){
        const want=valRaw==='on'?true:valRaw==='off'?false:!this.isAutoPollEnabled(id);
        this.setAutoPollEnabled(id,want);
        s.lastNotice=want
          ?'🤖 Auto-Poll is now ON · One poll per playing movie.'
          :'⚪ Auto-Poll is now OFF · Manual polls only.';
        if(want)this.#scheduleAutoPoll(id,null,{delayMs:150});
        if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:want?'🤖 Auto-Poll: ON':'⚪ Auto-Poll: OFF'}).catch(()=>{});
      }else if(kind==='mode'){
        const nextMode=valRaw==='top'?'top':'playnow';
        this.app.db?.setSetting?.(`music.queueVoteAction.${id}`,nextMode);
        s.lastNotice=`⚡ Winning Poll Action: ${nextMode==='playnow'?'Play Immediately':'Boost to #1'}`;
        if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:`Queue action: ${nextMode==='playnow'?'Play Immediately':'Boost to #1'}`}).catch(()=>{});
      }else{
        const count=Math.max(1,Math.min(25,Number(valRaw)||2));
        const key=kind==='skip'?`music.skipVoteThreshold.${id}`:`music.queueVoteThreshold.${id}`;
        this.app.db?.setSetting?.(key,count);
        s.lastNotice=`🗳 ${kind==='skip'?'Skip':'Movie Queue'} vote limit set to ${count} vote(s).`;
        if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:`${kind==='skip'?'Skip':'Queue'} vote limit: ${count}`}).catch(()=>{});
      }
      s.view='voteset';
    }
    else if(action==='launchpoll'){
      const posted=await this.createViewerPoll(id,{api:ctx.api,botId:Number(ctx.botId??ctx.controller?.botContext?.botId??0)||0,isChannel:ctx.isChannel,auto:false,sessionView:s});
      s.lastNotice=`📊 Live Viewer Poll posted! First option to hit its vote limit (${posted.needed}v) wins & auto-deletes the poll.`;
      if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:'📊 Live Viewer Poll posted!'}).catch(()=>{});
    }
    else if(action==='downloadnow'||action==='downloadq'){
      const downloader=this.app?.movieDownloader;
      if(!downloader)throw new MusicError('UNAVAILABLE','Download service is currently unavailable.');
      const deck=s.activeDeck==='movie'?'movie':'music';
      const rootSession=qm.getSession(id);
      let targetItem=null;
      let explicitQuality=null;
      if(action==='downloadnow'){
        targetItem=s.currentTrack;
        explicitQuality=args[0]||null;
      }else{
        let entryId=args[0];
        const qList=deck==='movie'?(rootSession.movieUpcoming||[]):(rootSession.upcoming||[]);
        if(s.panelToken){
          const matches=qList.filter(t=>t.entryId.replaceAll('-','').slice(0,12)===entryId);
          if(matches.length===1)entryId=matches[0].entryId;
        }
        targetItem=qList.find(t=>t.entryId===entryId)||null;
        explicitQuality=args[1]||null;
      }
      if(!targetItem)throw new MusicError('NOTHING_PLAYING','Select an active movie or episode to download.');
      if(!explicitQuality){
        s.dlqTarget={action,entryId:targetItem.entryId||null,title:targetItem.title,durationSeconds:targetItem.durationSeconds||0,item:targetItem};
        s.view='dlq';
        if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:'📦 Choose download quality (360p / 480p / 720p)'}).catch(()=>{});
      }else{
        s.dlqTarget=null;
        await this.#startCinemaDownload(ctx,s,id,targetItem,explicitQuality);
        return s;
      }
    }
    else if(action==='dlq'){
      const req=String(args[0]||'').toLowerCase();
      const rootSession=qm.getSession(id);
      const targetMeta=s.dlqTarget;
      const backView=targetMeta?.action==='downloadq'?'mqueue':((s.activeDeck==='movie'||s.currentTrack?.provider==='movie')?'cinema':'player');
      if(!req||req==='back'){
        s.dlqTarget=null;
        s.view=backView;
      }else{
        let targetItem=null;
        if(targetMeta?.action==='downloadq'){
          const qList=rootSession.activeDeck==='movie'?(rootSession.movieUpcoming||[]):(rootSession.upcoming||[]);
          targetItem=qList.find(t=>t.entryId===targetMeta.entryId)||targetMeta.item||null;
        }else{
          targetItem=s.currentTrack||targetMeta?.item||null;
        }
        if(!targetItem)throw new MusicError('NOTHING_PLAYING','Select an active movie or episode to download.');
        s.dlqTarget=null;
        s.view=backView;
        await this.#startCinemaDownload(ctx,s,id,targetItem,req);
      }
    }
    else if(action==='stop'||action==='leave'){
      if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:'⏹ Stopping playback…'}).catch(()=>{});
      qm.requestStop?.(id);await this.setup.lock.run(Number(id),()=>qm.stop(id));
    }
    else if(action==='retry'){s.lastNotice='Preparing your queued recording…';await qm.updatePlayerCard(id);const generation=this.queueGeneration(id);await this.prepare(ctx,id);this.assertQueueGeneration(id,generation);await qm.ensurePlaying(id);s.view=(s.activeDeck==='movie'||s.currentTrack?.provider==='movie')?'cinema':'player';}
    else if(action==='setvol'){
      const targetVol=Number(args[0]);
      await qm.setVolume(id,targetVol,{skipCardUpdate:true});
      if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:`🔊 Volume: ${targetVol}%`}).catch(()=>{});
    }
    else if(action==='seek'){
      const rawSeek=args.join(' ').trim();
      if(!rawSeek){
        s.view='seekmenu';
        if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:'⏱ Custom Seek & Skip Step'}).catch(()=>{});
      }else{
        const rootSession=qm.getSession(id);
        const curPos=typeof qm.getEstimatedPosition==='function'?qm.getEstimatedPosition(id):(Number(rootSession.positionSeconds)||0);
        const dur=Number(rootSession.currentTrack?.durationSeconds||0);
        const parsed=parseSeekInput(rawSeek,curPos,dur);
        if(parsed?.kind==='step'){
          const stepSec=qm.setSeekStep(id,parsed.seconds);
          s.seekStepSeconds=stepSec;
          s.lastNotice=`⏱ Custom skip buttons set to ±${stepSec}s.`;
        }else if(parsed){
          await qm.seek(id,parsed.targetSeconds);
        }else{
          await qm.seek(id,Number(args[0]));
        }
      }
    }
    else if(action==='seekby'){
      const delta=Number(args[0])||0;
      await this.#coalesceSeekBy(ctx,s,id,delta);
    }
    else if(action==='seekmenu'){
      const subOp=String(args[0]||'').toLowerCase();
      if(subOp==='back'){
        s.view=(s.activeDeck==='movie'||s.currentTrack?.provider==='movie')?'cinema':'player';
      }else{
        s.view='seekmenu';
        if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:'⏱ Custom Seek & Skip Step'}).catch(()=>{});
      }
    }
    else if(action==='setseekstep'){
      const stepSec=qm.setSeekStep(id,Number(args[0])||30);
      const rootSession=qm.getSession(id);
      rootSession.seekStepSeconds=stepSec;
      s.seekStepSeconds=stepSec;
      s.lastNotice=`⏱ Skip step set to ±${stepSec}s`;
      if(ctx.query?.id&&ctx.api?.answerCallbackQuery){
        await ctx.api.answerCallbackQuery(ctx.query.id,{text:`⏱ Skip buttons set to ±${stepSec}s`}).catch(()=>{});
      }
    }
    else if(action==='shuffle'){
      qm.shuffle(id);
      if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:'🔀 Queue shuffled'}).catch(()=>{});
    }
    else if(action==='loop'){
      qm.toggleLoopMode(id);
      if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:`🔁 Repeat: ${s.loopMode}`}).catch(()=>{});
    }
    else if(action==='clear'){
      qm.clearQueue(id);
      if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:'🗑 Queue cleared'}).catch(()=>{});
    }
    else if(action==='playnow'){
      let entry=args[0];
      if(s.panelToken){
        const matches=s.upcoming.filter(t=>t.entryId.replaceAll('-','').slice(0,12)===entry);
        if(matches.length!==1)throw new MusicError('STALE_PLAYER','That queued recording is no longer available.');
        entry=matches[0].entryId;
      }
      const rootSession=qm.getSession(id);
      const targetEntry=rootSession.upcoming.find(t=>t.entryId===entry);
      const ready=this.#isTrackReady(rootSession,targetEntry);
      s.view='player';
      if(rootSession)rootSession.view='player';
      if(!ready)s.lastNotice=`▶ Switching to ${targetEntry?.title||'selected track'}…`;
      const ackPromise=(ctx.query?.id&&ctx.api?.answerCallbackQuery)?ctx.api.answerCallbackQuery(ctx.query.id,{text:ready?'▶ Playing track now':'▶ Switching track…'}).catch(()=>{}):null;
      if(!s.connected&&typeof this.app.voiceClient?.setup==='function'){
        const generation=this.queueGeneration(id);
        await this.prepare(ctx,id);
        this.assertQueueGeneration(id,generation);
      }
      await qm.playNow(id,entry);
      if(ackPromise)await ackPromise;
      s.view='player';
    }
    else if(['radio','rpage','rpick','rstart','roff'].includes(action)){
      s.view='radio';if(action==='rpage')s.radioPage=Math.max(0,Math.min(7,Number(args[0])||0));
      if(action==='rpick'){const index=Number(args[0]);if(!RADIO_CATEGORIES[index])throw new MusicError('RADIO_SELECTION','Choose a category from this menu.');const selected=[...(s.radioSelected||[])];const at=selected.indexOf(index);if(at>=0)selected.splice(at,1);else{if(selected.length+(s.radioCustom?1:0)>=5)throw new MusicError('RADIO_SELECTION','Choose up to five categories/custom searches.');selected.push(index);}s.radioSelected=selected;}
      if(action==='roff')this.radio.stop(qm.getSession(id));
      if(action==='rstart'){
        s.lastNotice='⏳ Starting infinite radio… Connecting assistant & tracks…';
        if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:'⏳ Starting infinite radio…'}).catch(()=>{});
        if(s.screenMessageId)void qm.updatePlayerCard(id).catch(()=>{});
        const generation=qm.getSession(id).stopGeneration||0;
        await this.prepare(ctx,id);
        if((qm.getSession(id).stopGeneration||0)!==generation)throw new MusicError('ACTION_CANCELLED','Radio start was cancelled by Stop.');
        this.radio.configure(qm.getSession(id),[...(s.radioSelected||[]).map(i=>RADIO_CATEGORIES[i]),...(s.radioCustom?[s.radioCustom]:[])]);
        await this.radio.refill(qm.getSession(id));
        await qm.ensurePlaying(id);
        s.view='player';
      }
    }
    else if(action==='remove'){let entry=args[0];if(s.panelToken){const matches=s.upcoming.filter(t=>t.entryId.replaceAll('-','').slice(0,12)===entry);if(matches.length!==1)throw new MusicError('STALE_PLAYER','That queued recording is no longer available.');entry=matches[0].entryId;}qm.removeTrack(id,entry);}
    else if(action==='options'){s.view='options';}
    else if(action==='preview'){if(this.previews.pending.has(id))throw new MusicError('PREVIEW_BUSY','The full preview is already being prepared.');s.fullPreview=null;s.view='player';}
    else if(action==='volume'){
      s.view='volume';
      if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:`🔊 Volume: ${s.volume ?? 100}%`}).catch(()=>{});
    }
    else if(action==='accounts'){await this.accounts.sync();s.availableAccounts=(await this.app.voiceClient.accounts(id)).accounts;s.view='accounts';}
    else if(action==='queue'||action==='qpage'){s.view='queue';s.page=Math.max(0,Number(args[0])||0);}
    else if(action==='mqueue'||action==='mqpage'){s.view='mqueue';s.page=Math.max(0,Number(args[0])||0);}
    else if(action==='mclear'){
      qm.clearMovieQueue(id);
      if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:'🗑 Cinema queue cleared'}).catch(()=>{});
    }
    else if(action==='mremove'){
      let entry=args[0];
      if(s.panelToken){
        const matches=(s.movieUpcoming||[]).filter(t=>t.entryId.replaceAll('-','').slice(0,12)===entry);
        if(matches.length!==1)throw new MusicError('STALE_PLAYER','That queued movie/episode is no longer available.');
        entry=matches[0].entryId;
      }
      qm.removeMovieTrack(id,entry);
    }
    else if(action==='mplaynow'){
      let entry=args[0];
      if(s.panelToken){
        const matches=(s.movieUpcoming||[]).filter(t=>t.entryId.replaceAll('-','').slice(0,12)===entry);
        if(matches.length!==1)throw new MusicError('STALE_PLAYER','That queued movie/episode is no longer available.');
        entry=matches[0].entryId;
      }
      const rootSession=qm.getSession(id);
      const targetEntry=(rootSession.movieUpcoming||[]).find(t=>t.entryId===entry);
      s.view='cinema';
      if(rootSession)rootSession.view='cinema';
      s.lastNotice=`▶ Starting ${targetEntry?.title||'selected movie'}…`;
      const ackPromise=(ctx.query?.id&&ctx.api?.answerCallbackQuery)?ctx.api.answerCallbackQuery(ctx.query.id,{text:'▶ Playing now…'}).catch(()=>{}):null;
      if(!s.connected&&typeof this.app.voiceClient?.setup==='function'){
        const generation=this.queueGeneration(id);
        await this.prepare(ctx,id);
        this.assertQueueGeneration(id,generation);
      }
      await qm.playQueuedMovieNow(id,entry);
      if(ackPromise)await ackPromise;
      s.view='cinema';
    }
    else if(action==='switchdeck'){
      const reqDeck=args[0]==='movie'?'movie':args[0]==='music'?'music':(s.activeDeck==='movie'?'music':'movie');
      const switched=await qm.switchDeck(id,reqDeck);
      s.activeDeck=switched.activeDeck;
      s.view=switched.view;
      if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:reqDeck==='movie'?'🎬 Cinema VC':'🎵 Music Player'}).catch(()=>{});
    }
    else if(action==='lyrics'){
      if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:'🎶 Fetching lyrics…'}).catch(()=>{});
      const result=s.currentTrack?await this.lyrics.get(s.currentTrack,{force:true}):{found:false,reason:'Choose a track first.'};
      s.lyrics=result;s.lyricsPage=0;s.view='lyrics';
      const root=qm.getSession(id);
      if(root&&s.currentTrack&&root.currentTrack?.id===s.currentTrack.id){
        root.cardLyrics={trackId:s.currentTrack.id,status:result?.found?'ready':'unavailable',result};
      }
    }
    else if(action==='lypage'){s.lyricsPage=Math.max(0,Number(args[0])||0);s.view='lyrics';}
    else if(action==='bass'){s.bass=!s.bass;s.eqPreset=s.bass?'bass':'off';this.app.db?.setSetting?.(`music.bass.${id}`,s.bass);this.app.db?.setSetting?.(`music.eq.${id}`,s.eqPreset);if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:s.bass?'🎛 Clean Bass EQ: ON (applies on next track / seek)':'🎛 Clean Bass EQ: OFF'}).catch(()=>{});}
    else if(action==='aidj'){
      const cfg=this.aiDj.toggle(id);
      if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:cfg.enabled?`🤖 AI DJ ON · ${cfg.vibe}`:'🤖 AI DJ OFF'}).catch(()=>{});
      if(cfg.enabled){
        const root=qm.getSession(id);
        this.aiDj.syncSession(root);
        if(root.upcoming.length<2){
          const added=await this.aiDj.curateNextTracks(root,{count:2}).catch(()=>[]);
          if(added.length&&!['playing','paused','buffering'].includes(root.status)){
            await this.prepare(ctx,id);
            await qm.ensurePlaying(id);
          }
        }
        s.lastNotice=`🤖 AI DJ active · ${cfg.vibe}`;
      }else{
        s.lastNotice='🤖 AI DJ paused. Existing queue is retained.';
      }
    }
    else if(action==='djdesk'){
      const subOp=String(args[0]||'open').toLowerCase();
      const root=qm.getSession(id);
      this.aiDj.syncSession(root);
      if(subOp==='back'){
        s.view=(s.activeDeck==='movie'||s.currentTrack?.provider==='movie')?'cinema':'player';
      }else if(subOp==='vdesk'){
        const curV=root.aiDj?.visualDesk!==false;
        const next=this.aiDj.setDeckOption(id,{visualDesk:!curV});
        s.visualDesk=next.visualDesk;
        s.view='djdesk';
        s.lastNotice=next.visualDesk?'🎛 Animated Visual DJ Desk: ON (next track / seek)':'📺 Visual DJ Desk: OFF (raw video/audio)';
        if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:next.visualDesk?'🎛 Visual DJ Desk ON':'📺 Visual DJ Desk OFF'}).catch(()=>{});
      }else if(subOp==='dlyrics'){
        const curL=root.aiDj?.deskLyrics!==false;
        const next=this.aiDj.setDeckOption(id,{deskLyrics:!curL});
        s.view='djdesk';
        if(root.connected && root.currentTrack?.subtitlePath && typeof this.app?.voiceClient?.setSubtitle==='function'){
          await this.app.voiceClient.setSubtitle(id, root.currentTrack.subtitlePath, {
            subtitleRenderScreen: Boolean(next.deskLyrics && (root.subtitleMode||'screen')==='screen'),
            subtitleSameRoute: Boolean(root.currentTrack.subtitleSameRoute)
          }).catch(()=>{});
        }
        s.lastNotice=next.deskLyrics?'📜 Desk Karaoke Lyrics: ON (Live)':'📜 Desk Karaoke Lyrics: OFF';
        if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:next.deskLyrics?'📜 Desk Lyrics ON':'📜 Desk Lyrics OFF'}).catch(()=>{});
      }else if(subOp==='remix'){
        const next=this.aiDj.toggleRemixFocus(id);
        const on=/remix/i.test(next.styleQualifier||'');
        s.view='djdesk';
        s.lastNotice=on?'🔀 Remix Focus: ON (next curated cuts prioritize remixes)':'🎵 Remix Focus: OFF (original tracks)';
        if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:on?'🔀 Remix Focus ON':'🎵 Remix Focus OFF'}).catch(()=>{});
      }else if(subOp==='xfade'){
        const cycle=[0,4,8];
        const curCf=Number(root.aiDj?.crossfadeSec??4);
        const nextCf=cycle[(cycle.indexOf(curCf)+1)%cycle.length];
        this.aiDj.setDeckOption(id,{crossfadeSec:nextCf});
        s.view='djdesk';
        s.lastNotice=nextCf?`🎚 Smooth Crossfade: ${nextCf}s (applies to Deck A→B fade)`:'🎚 Transition: Clean Cut (0s)';
        if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:nextCf?`Crossfade ${nextCf}s`:'Crossfade OFF'}).catch(()=>{});
      }else if(subOp==='chapter'){
        const chap=await this.aiDj.dropNextChapter(root);
        s.view='djdesk';
        s.lastNotice=`⏭ Switched to ${chap.chapterTitle||chap.stage}${chap.added?.length?` · Cued "${chap.added[0].title}"`:''}`;
        if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:`⏭ ${chap.chapterTitle||'Next Chapter'}`}).catch(()=>{});
      }else{
        s.view='djdesk';
        if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:'🎛 Live AI DJ Desk'}).catch(()=>{});
      }
    }
    else if(action==='eq'){
      const requested=args[0]&&EQ_PRESETS.includes(String(args[0]).toLowerCase())?String(args[0]).toLowerCase():null;
      const cur=EQ_CYCLE_PRESETS.includes(s.eqPreset)?s.eqPreset:(s.bass?'bass':'off');
      s.eqPreset=requested || EQ_CYCLE_PRESETS[(EQ_CYCLE_PRESETS.indexOf(cur)+1)%EQ_CYCLE_PRESETS.length];
      s.bass=s.eqPreset==='bass';
      this.app.db?.setSetting?.(`music.eq.${id}`,s.eqPreset);
      this.app.db?.setSetting?.(`music.bass.${id}`,s.bass);
      if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:`EQ preset: ${s.eqPreset}`}).catch(()=>{});
    }
    else if(action==='submode'){
      const modes=['screen','live','vc','off'];
      const cur=modes.includes(s.subtitleMode)?s.subtitleMode:'screen';
      const req=args[0]&&modes.includes(String(args[0]).toLowerCase())?String(args[0]).toLowerCase():null;
      const nextMode=req||modes[(modes.indexOf(cur)+1)%modes.length];
      await qm.setSubtitleMode(id,nextMode);
      const label=nextMode==='screen'?'Burned on VC Screen':nextMode==='live'?'Live Chat/Card Cues':nextMode==='vc'?'Burned + VC Chat Cues':'Off';
      if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:`💬 Subtitles: ${label}`}).catch(()=>{});
    }
    else if(action==='streammode'){
      const req=args[0]&&['rtmp','interactive'].includes(String(args[0]).toLowerCase())?String(args[0]).toLowerCase():null;
      if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:'📡 Switching VC stream engine…'}).catch(()=>{});
      const nextEngine=await qm.setStreamMode(id,req);
      s.streamMode=nextEngine;
    }
    else if(action==='vcquality'){
      const rawQ=String(args[0]||'').trim();
      const mapQ={ '1080p':'FHD_1080p', '720p':'HD_720p', '480p':'SD_480p', 'FHD_1080p':'FHD_1080p', 'HD_720p':'HD_720p', 'SD_480p':'SD_480p' };
      const req=mapQ[rawQ]||null;
      if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:'🎞 Adjusting VC stream quality…'}).catch(()=>{});
      const nextQ=await qm.setVcQuality(id,req);
      s.vcQuality=nextQ;
    }
    else if(action==='switchsource'){
      const idxArg=args[0]!==undefined&&args[0]!==''&&Number.isFinite(Number(args[0]))?Math.max(0,Math.floor(Number(args[0]))):null;
      if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:'📡 Switching movie source…'}).catch(()=>{});
      await qm.switchMovieSource(id,idxArg);
    }
    else if(action==='audiolang'){
      const rawOp=String(args[0]??'').trim().toLowerCase();
      if(!rawOp||rawOp==='open'){
        s.view='audiolang';
        if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:'🔊 Audio Language Controls'}).catch(()=>{});
      }else if(rawOp==='back'){
        s.view=(s.activeDeck==='movie'||s.currentTrack?.provider==='movie')?'cinema':'player';
      }else if(Number.isFinite(Number(rawOp))){
        const idxArg=Math.max(0,Math.floor(Number(rawOp)));
        if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:'🔊 Hot-reloading audio language…'}).catch(()=>{});
        const switched=await qm.switchAudioLanguage(id,idxArg);
        if(switched?.ok){
          s.view=(s.activeDeck==='movie'||s.currentTrack?.provider==='movie')?'cinema':'player';
        }
      }
    }
    else if(action==='vcmsg'){
      const msgText=args.join(' ').trim();
      const sendRes=await qm.sendVcChatMessage(id,msgText);
      if(!sendRes?.ok)throw new MusicError('VC_MESSAGE_FAILED',sendRes?.reason==='empty'?'Include a message after /vcmsg.':'Active Voice Chat unavailable for in-call messages.');
      s.lastNotice=`💬 Sent to VC chat: ${msgText.slice(0,80)}`;
    }
    else if(action==='subsync'){
      const op=String(args[0]||'').toLowerCase();
      if(!op||op==='open'){
        s.view='subsync';
        if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:'💬 Subtitle Sync & Track Controls'}).catch(()=>{});
      }else if(op==='back'){
        s.view=(s.activeDeck==='movie'||s.currentTrack?.provider==='movie')?'cinema':'player';
      }else if(op==='reset'||op==='0'){
        await qm.setSubtitleOffset(id,0,{absolute:true});
        s.view='subsync';
        if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:'⏱ Subtitle timing reset to 0.0s'}).catch(()=>{});
      }else{
        const delta=Number(args[0]);
        if(Number.isFinite(delta)){
          const nextOff=await qm.setSubtitleOffset(id,delta,{absolute:false});
          s.view='subsync';
          if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:`⏱ Subtitle sync: ${nextOff>0?`+${nextOff}`:nextOff}s`}).catch(()=>{});
        }
      }
    }
    else if(action==='subtrack'){
      const idxArg=args[0]!==undefined?Number(args[0]):null;
      const picked=await qm.cycleSubtitleTrack(id,Number.isInteger(idxArg)?idxArg:null);
      if(ctx.query?.id&&ctx.api?.answerCallbackQuery){
        await ctx.api.answerCallbackQuery(ctx.query.id,{text:picked?`🌐 Subtitle: ${picked.track?.label||`Track ${picked.index+1}`}`:'No alternate subtitle tracks on this video'}).catch(()=>{});
      }
    }
    else if(action==='subcheck'){
      if(ctx.query?.id&&ctx.api?.answerCallbackQuery){
        await ctx.api.answerCallbackQuery(ctx.query.id,{text:'🔍 Checking live audio vs subtitles…'}).catch(()=>{});
      }
      const chk=await qm.checkSubtitleSync(id,{autoFix:args[0]!=='probe'});
      const st=chk?.sync||{};
      s.lastNotice=st.message||(st.status==='none'?'No subtitle track loaded':'Subtitle sync checked');
    }
    else if(action==='selectaccount'){
      if(s.connected||s.prepared)throw new MusicError('ACCOUNT_BUSY','Leave the current prepared session/call before changing its account.');
      const pool=await this.app.voiceClient.accounts(id);const account=pool.accounts.find(a=>a.alias===args[0]&&a.status==='available'&&a.enabled);
      if(!account)throw new MusicError('ACCOUNT_UNAVAILABLE','That approved account is no longer available.');s.preferredAccount=account.alias;
    }
    else if(action==='pin'&&s.panelToken)await this.channelPanels.pin(s.panelToken,{force:true});
    else if(action==='pin'){
      if(!s.screenMessageId)throw new MusicError('STALE_PLAYER','No active player card found yet. Run /player first.');
      const me=ctx.api.me?.id || (await ctx.api.getMe?.().catch(()=>null))?.id;if(!me)throw new MusicError('PERMISSION_DENIED','Bot identity unavailable.');
      const member=await ctx.api.getChatMember(ctx.chatId,me);
      if(!['creator','administrator'].includes(member.status)||(member.status!=='creator'&&!member.can_pin_messages&&!(s.isChannel&&member.can_edit_messages)))throw new MusicError('PIN_PERMISSION','Grant only the pin permission if you want a pinned player. Playback does not require it.');
      const targetMsgId = s.screenMessageId;
      const result=await ctx.api.call('pinChatMessage',{chat_id:ctx.chatId,message_id:targetMsgId,disable_notification:true});
      if(!result)throw new MusicError('PIN_FAILED','Telegram did not confirm pinning.');
      s.pinned=true;
      s.pinnedMessageId=targetMsgId;
      if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:'📌 Player card pinned'}).catch(()=>{});
    }
    s.overlayView=null;s.overlayAt=0;
    const isCinema=(s.activeDeck==='movie'||s.currentTrack?.provider==='movie')&&s.view!=='queue';
    if((['player','stop','leave','seekby','selectaccount'].includes(action)||(action==='seek'&&args.length>0))&&s.view!=='seekmenu'&&s.view!=='djdesk')s.view=isCinema?'cinema':'player';
    else if(s.view!=='queue'&&s.view!=='mqueue'&&s.view!=='seekmenu'&&s.view!=='djdesk'&&['pause','resume','skip','previous'].includes(action))s.view=isCinema?'cinema':'player';
    if(action==='player'&&s.status==='stopped'){s.status='idle';s.lastError=null;}
    s.controlRevision=(s.controlRevision||0)+1; await qm.updatePlayerCard(id,{forceEdit:Boolean(ctx.query)});return s;
  }
  #resolvePollApi(poll, s = null, meta = null){
    if(meta?.api)return meta.api;
    const bId=Number(meta?.botId??poll?.botId??s?.botId??0);
    if(bId>0){
      const cloneRec=this.app?.multiBotManager?.runningBots?.get?.(bId);
      if(cloneRec?.api)return cloneRec.api;
    }
    if(poll?.api)return poll.api;
    if(s?.api)return s.api;
    return this.app?.telegram?.api||null;
  }
  #persistActivePoll(poll){
    if(!poll?.pollId||!this.app?.db?.setSetting)return;
    const votesObj=poll.votesByUser instanceof Map?Object.fromEntries(poll.votesByUser.entries()):(poll.votesByUser&&typeof poll.votesByUser==='object'?poll.votesByUser:{});
    this.app.db.setSetting(`music.activePoll.${poll.pollId}`,{
      pollId:String(poll.pollId),
      chatId:poll.chatId,
      destination:poll.destination,
      messageId:poll.messageId,
      deck:poll.deck,
      trackEntryId:poll.trackEntryId||null,
      playbackId:poll.playbackId||null,
      botId:Number(poll.botId||0)||0,
      optionTargets:poll.optionTargets,
      optionCounts:Array.isArray(poll.optionCounts)?poll.optionCounts:[],
      needed:poll.needed,
      skipNeeded:poll.skipNeeded,
      queueNeeded:poll.queueNeeded,
      auto:Boolean(poll.auto),
      votesByUser:votesObj
    });
  }
  #deletePersistedPoll(pollId){
    const key=`music.activePoll.${pollId}`;
    try{
      if(typeof this.app?.db?.run==='function'){
        this.app.db.run('DELETE FROM bot_settings WHERE key = ?',key);
        return;
      }
    }catch{}
    this.app?.db?.setSetting?.(key,null);
  }
  #hydratePersistedPolls(){
    try{
      if(typeof this.app?.db?.all!=='function')return;
      const rows=this.app.db.all("SELECT key, value_json FROM bot_settings WHERE key LIKE 'music.activePoll.%'");
      for(const row of (rows||[])){
        let data=null;
        try{data=JSON.parse(row.value_json);}catch{}
        if(!data||typeof data!=='object'||!data.pollId)continue;
        const pollId=String(data.pollId);
        const votesMap=new Map(Object.entries(data.votesByUser&&typeof data.votesByUser==='object'?data.votesByUser:{}));
        const poll={
          ...data,
          pollId,
          completed:false,
          votesByUser:votesMap,
          api:this.#resolvePollApi(data,null,null)
        };
        this.activePolls.set(pollId,poll);
        const sess=this.app?.musicQueueManager?.sessions?.get?.(Number(data.destination));
        if(sess&&!sess.activePoll){
          sess.activePoll={
            pollId,
            messageId:poll.messageId,
            chatId:poll.chatId,
            needed:poll.needed,
            skipNeeded:poll.skipNeeded,
            queueNeeded:poll.queueNeeded,
            trackEntryId:poll.trackEntryId||null,
            counts:Array.isArray(poll.optionCounts)?poll.optionCounts:[],
            totalVoters:votesMap.size
          };
          if(poll.trackEntryId)sess.pollDoneEntryId=poll.trackEntryId;
        }
      }
    }catch{}
  }
  bindQueuePollLifecycle(){
    const qm=this.app?.musicQueueManager;
    if(!qm||this._boundQm===qm||typeof qm.on!=='function')return;
    this._boundQm=qm;
    qm.on('track_start',({chatId,track,session})=>{
      const id=Number(chatId);
      const s=session||qm.getSession?.(id);
      if(!s)return;
      if(track?.provider!=='movie'){
        if(s.activePoll||[...this.activePolls.values()].some(p=>Number(p.destination)===id)){
          void this.cleanupDestinationPolls(id,{reason:'non_movie'}).catch(()=>{});
        }
        return;
      }
      if(s.pollDoneEntryId&&track.entryId&&s.pollDoneEntryId===track.entryId){
        return;
      }
      void this.cleanupDestinationPolls(id,{reason:'next_movie'}).then(()=>{
        const cur=qm.getSession?.(id);
        if(!cur||cur.status!=='playing'||cur.currentTrack?.entryId!==track.entryId)return;
        cur.pollDoneEntryId=null;
        if(this.isAutoPollEnabled(id)&&(cur.movieUpcoming?.length||0)>=1){
          this.#scheduleAutoPoll(id,track.entryId,{delayMs:450});
        }
      }).catch(()=>{});
    });
    qm.on('queue_updated',({chatId,session})=>{
      const id=Number(chatId);
      const s=session||qm.getSession?.(id);
      if(!s||s.status!=='playing'||s.currentTrack?.provider!=='movie')return;
      if((s.movieUpcoming?.length||0)<1)return;
      if(s.activePoll||s.pollDoneEntryId===s.currentTrack.entryId)return;
      if(this.isAutoPollEnabled(id)){
        this.#scheduleAutoPoll(id,s.currentTrack.entryId,{delayMs:550});
      }
    });
    const onStopLike=({chatId})=>{
      const id=Number(chatId);
      const t=this.autoPollTimers.get(id);
      if(t){clearTimeout(t);this.autoPollTimers.delete(id);}
      void this.cleanupDestinationPolls(id,{reason:'stopped'}).catch(()=>{});
    };
    qm.on('playback_stopped',onStopLike);
    qm.on('queue_empty',onStopLike);
    qm.on('movie_queue_cleared',({chatId})=>{
      const id=Number(chatId);
      const s=qm.getSession?.(id);
      if(s?.activePoll&&!s.activePoll.decided){
        void this.cleanupDestinationPolls(id,{reason:'queue_cleared'}).catch(()=>{});
      }
    });
  }
  #scheduleAutoPoll(chatId,expectedEntryId=null,{delayMs=450}={}){
    const id=Number(chatId);
    if(!Number.isSafeInteger(id)||id>=0)return;
    const prev=this.autoPollTimers.get(id);
    if(prev)clearTimeout(prev);
    const timer=setTimeout(()=>{
      this.autoPollTimers.delete(id);
      void this.maybeAutoLaunchPoll(id,{expectedEntryId}).catch(()=>{});
    },Math.max(0,Number(delayMs)||0));
    timer.unref?.();
    this.autoPollTimers.set(id,timer);
  }
  async maybeAutoLaunchPoll(chatId,{expectedEntryId=null}={}){
    const id=Number(chatId);
    const qm=this.app?.musicQueueManager;
    const s=qm?.getSession?.(id);
    if(!s||s.status!=='playing'||s.currentTrack?.provider!=='movie')return null;
    if(expectedEntryId&&s.currentTrack.entryId!==expectedEntryId)return null;
    if(!this.isAutoPollEnabled(id))return null;
    if((s.movieUpcoming?.length||0)<1)return null;
    if(s.activePoll||s.pollDoneEntryId===s.currentTrack.entryId)return null;
    const api=this.#resolvePollApi(null,s,null);
    if(typeof api?.sendPoll!=='function')return null;
    // Lock single-poll-per-movie immediately before awaiting sendPoll to avoid duplicate posts
    s.pollDoneEntryId=s.currentTrack.entryId;
    try{
      return await this.createViewerPoll(id,{api,botId:Number(s.botId||0)||0,isChannel:Boolean(s.isChannel),auto:true,sessionView:s});
    }catch(err){
      s.pollDoneEntryId=null;
      qm?.log?.warn?.({chatId:id,err:err?.message},'Auto-poll post failed');
      return null;
    }
  }
  async cleanupDestinationPolls(chatId,{reason='cleanup'}={}){
    const id=Number(chatId);
    const qm=this.app?.musicQueueManager;
    const s=qm?.sessions?.get?.(id)||null;
    const matches=[...this.activePolls.values()].filter(p=>Number(p.destination)===id||Number(p.chatId)===id);
    if(s?.activePoll?.pollId&&!matches.some(m=>m.pollId===s.activePoll.pollId)){
      const extra=this.#resolveActivePoll(s.activePoll.pollId);
      if(extra)matches.push(extra);
    }
    for(const poll of matches){
      const pid=String(poll.pollId||'');
      poll.completed=true;
      this.activePolls.delete(pid);
      this.#deletePersistedPoll(pid);
      const api=this.#resolvePollApi(poll,s,null);
      if(poll.messageId){
        if(typeof api?.stopPoll==='function')await api.stopPoll(poll.chatId,poll.messageId).catch(()=>{});
        if(typeof api?.deleteMessage==='function')await api.deleteMessage(poll.chatId,poll.messageId).catch(()=>{});
      }
    }
    if(s){
      s.activePoll=null;
      if(reason==='stopped'||reason==='non_movie')s.pollDoneEntryId=null;
    }
    return matches.length;
  }
  async createViewerPoll(id,{api=null,botId=0,isChannel=null,auto=false,sessionView=null}={}){
    const qm=this.app.musicQueueManager;
    const rootSession=qm.getSession(id);
    const viewSess=sessionView||rootSession;
    const effApi=this.#resolvePollApi(null,rootSession,{api,botId});
    if(typeof effApi?.sendPoll!=='function')throw new MusicError('POLL_UNAVAILABLE','Telegram Poll API is unavailable.');
    const deck=(viewSess.activeDeck==='movie'||rootSession.currentTrack?.provider==='movie'||(!(rootSession.upcoming||[]).length&&(rootSession.movieUpcoming||[]).length>0))?'movie':'music';
    const q=deck==='movie'?(rootSession.movieUpcoming||[]):(rootSession.upcoming||[]);
    if(!q.length&&!rootSession.currentTrack)throw new MusicError('NOTHING_QUEUED','Queue at least one movie or track before launching a poll.');
    await this.cleanupDestinationPolls(id,{reason:'replaced'});

    const icon=deck==='movie'?'🎬':'🎵';
    const optionTargets=[];
    const optionLabels=[];
    if(rootSession.currentTrack){
      optionTargets.push({kind:'skip',title:rootSession.currentTrack.title});
      optionLabels.push(`⏭ Skip: ${String(rootSession.currentTrack.title||'Current').slice(0,82)}`);
    }
    const maxItems=rootSession.currentTrack?8:9;
    for(const item of q.slice(0,maxItems)){
      optionTargets.push({kind:'play',entryId:item.entryId,title:item.title});
      optionLabels.push(`${icon} ${String(item.title||'Queued Item').slice(0,90)}`);
    }
    if(optionLabels.length<2){
      optionTargets.push({kind:'keep',title:'Keep playing'});
      optionLabels.push('🔁 Keep Current Order');
    }

    const targetChatId=Number(id)<0?Number(id):(rootSession.playerChatId||id);
    const isChanPoll=Boolean(rootSession?.isChannel||viewSess?.isChannel||isChannel);
    const skipNeeded=this.getSkipVoteThreshold(id);
    const queueNeeded=this.getQueueVoteThreshold(id);
    const needed=deck==='movie'?queueNeeded:skipNeeded;
    const nowTitle=rootSession.currentTrack?.title?` · Now: ${String(rootSession.currentTrack.title).slice(0,70)}`:'';
    const question=`🗳 Up Next Poll${nowTitle} (${needed} vote${needed===1?'':'s'} wins!)`.slice(0,255);

    let sentPoll;
    try{
      sentPoll=await effApi.sendPoll(targetChatId,question,optionLabels,{is_anonymous:isChanPoll,allows_multiple_answers:false});
    }catch(err){
      const desc=String(err?.description||err?.message||'');
      if(!isChanPoll&&/non-anonymous|channel/i.test(desc)){
        rootSession.isChannel=true;
        sentPoll=await effApi.sendPoll(targetChatId,question,optionLabels,{is_anonymous:true,allows_multiple_answers:false});
      }else{
        throw err;
      }
    }
    const pollId=sentPoll?.poll?.id;
    const effBotId=Number(botId||rootSession.botId||effApi?.me?.id||0)||0;
    const trackEntryId=rootSession.currentTrack?.entryId||null;
    if(pollId){
      const pollRec={
        pollId:String(pollId),
        chatId:targetChatId,
        destination:id,
        messageId:sentPoll.message_id,
        deck,
        trackEntryId,
        playbackId:rootSession.playbackId||null,
        botId:effBotId,
        optionTargets,
        optionCounts:optionLabels.map(()=>0),
        needed,
        skipNeeded,
        queueNeeded,
        auto:Boolean(auto),
        completed:false,
        votesByUser:new Map(),
        api:effApi
      };
      this.activePolls.set(String(pollId),pollRec);
      this.#persistActivePoll(pollRec);
      rootSession.activePoll={
        pollId:String(pollId),
        messageId:sentPoll.message_id,
        chatId:targetChatId,
        needed,
        skipNeeded,
        queueNeeded,
        trackEntryId,
        counts:optionLabels.map(()=>0),
        totalVoters:0
      };
      if(trackEntryId)rootSession.pollDoneEntryId=trackEntryId;
    }
    qm?.log?.info?.({chatId:id,pollId:String(pollId||''),auto:Boolean(auto),options:optionLabels.length,needed,skipNeeded,queueNeeded},'Viewer poll posted');
    return {pollId:pollId?String(pollId):null,needed,skipNeeded,queueNeeded,messageId:sentPoll?.message_id||null};
  }
  #thresholdForOption(poll,target){
    if(target?.kind==='skip')return Math.max(1,Number(poll?.skipNeeded??poll?.needed??2));
    return Math.max(1,Number(poll?.queueNeeded??poll?.needed??2));
  }
  async autopollCommand(ctx,args=[]){
    const id=await this.authorize(ctx,false,null,{allowDj:false});
    const tokens=(Array.isArray(args)?args:String(args||'').split(/\s+/)).map(s=>String(s||'').trim().toLowerCase()).filter(Boolean);
    const onWords=new Set(['on','enable','enabled','allow','true','yes','1','start']);
    const offWords=new Set(['off','disable','disabled','disallow','false','no','0','stop']);
    const qm=this.app?.musicQueueManager;
    const s=qm?.getSession?.(id);
    if(!tokens.length||tokens[0]==='status'){
      const enabled=this.isAutoPollEnabled(id);
      const qNeed=this.getQueueVoteThreshold(id);
      const sNeed=this.getSkipVoteThreshold(id);
      if(s)s.view='voteset';
      return {enabled,queueNeed:qNeed,skipNeed:sNeed,activePoll:s?.activePoll||null};
    }
    let nextEnabled=this.isAutoPollEnabled(id);
    let updatedThresh=null;
    for(const tok of tokens){
      if(onWords.has(tok))nextEnabled=this.setAutoPollEnabled(id,true);
      else if(offWords.has(tok))nextEnabled=this.setAutoPollEnabled(id,false);
      else if(/^\d+$/.test(tok)){
        const count=Math.max(1,Math.min(25,Number(tok)));
        this.app?.db?.setSetting?.(`music.queueVoteThreshold.${id}`,count);
        this.app?.db?.setSetting?.(`music.skipVoteThreshold.${id}`,count);
        updatedThresh=count;
      }
    }
    if(nextEnabled&&s)this.#scheduleAutoPoll(id,null,{delayMs:200});
    const qNeed=this.getQueueVoteThreshold(id);
    const sNeed=this.getSkipVoteThreshold(id);
    if(s){
      s.lastNotice=updatedThresh
        ?`🤖 Auto-Poll ${nextEnabled?'ON':'OFF'} · Vote limit set to ${updatedThresh}v.`
        :`🤖 Auto-Poll is now ${nextEnabled?'ON':'OFF'} (${qNeed}v to decide).`;
      await qm.updatePlayerCard(id,{forceEdit:true}).catch(()=>{});
    }
    return {enabled:nextEnabled,queueNeed:qNeed,skipNeed:sNeed,updatedThresh,activePoll:s?.activePoll||null};
  }
  #resolveActivePoll(pollId,meta=null){
    const key=String(pollId||'');
    if(!key)return null;
    let poll=this.activePolls.get(key);
    if(!poll){
      const persisted=this.app?.db?.getSetting?.(`music.activePoll.${key}`,null);
      if(persisted&&typeof persisted==='object'){
        const session=this.app?.musicQueueManager?.sessions?.get?.(Number(persisted.destination))||null;
        const votesMap=new Map(Object.entries(persisted.votesByUser&&typeof persisted.votesByUser==='object'?persisted.votesByUser:{}));
        poll={
          ...persisted,
          pollId:key,
          completed:false,
          votesByUser:votesMap,
          api:this.#resolvePollApi(persisted,session,meta)
        };
        this.activePolls.set(key,poll);
      }
    }else if(meta?.api&&!poll.api){
      poll.api=meta.api;
    }
    return poll||null;
  }
  async #completePollVote(poll,winnerIndex,votesCount){
    if(poll.completed)return false;
    const winner=poll.optionTargets?.[winnerIndex];
    if(!winner)return false;
    poll.completed=true;
    const pollId=String(poll.pollId||'');
    this.activePolls.delete(pollId);
    this.#deletePersistedPoll(pollId);
    const qm=this.app?.musicQueueManager;
    const s=qm?.getSession?.(poll.destination);
    if(s){
      if(s.activePoll?.pollId===pollId)s.activePoll=null;
      if(poll.trackEntryId)s.pollDoneEntryId=poll.trackEntryId;
    }
    const api=this.#resolvePollApi(poll,s,null);
    if(poll.messageId){
      if(typeof api?.stopPoll==='function'){
        await api.stopPoll(poll.chatId,poll.messageId).catch(()=>{});
      }
      if(typeof api?.deleteMessage==='function'){
        await api.deleteMessage(poll.chatId,poll.messageId).catch(()=>{});
      }
    }
    qm?.log?.info?.({chatId:poll.destination,pollId,winnerKind:winner.kind,winnerTitle:winner.title,votes:votesCount},'Viewer poll decided & deleted');
    let resultNotice=null;
    if(qm&&s){
      if(winner.kind==='skip'){
        resultNotice=`📊 Poll passed (${votesCount}v): Skipped to next! Poll removed.`;
        await qm.skip(poll.destination).catch(()=>{});
      }else if(winner.kind==='play'&&winner.entryId){
        const mode=this.getQueueVoteAction(poll.destination);
        const inMovie=(s.movieUpcoming||[]).some(t=>t.entryId===winner.entryId);
        const inMusic=(s.upcoming||[]).some(t=>t.entryId===winner.entryId);
        if(inMovie||inMusic){
          if(mode==='playnow'){
            resultNotice=`📊 Poll winner (${votesCount}v): Playing ${winner.title}!`;
            if(inMovie)await qm.playQueuedMovieNow(poll.destination,winner.entryId).catch(()=>{});
            else await qm.playNow(poll.destination,winner.entryId).catch(()=>{});
          }else{
            resultNotice=`📊 Poll winner (${votesCount}v): ${winner.title} moved to #1!`;
            try{
              if(inMovie)qm.promoteMovieTrack(poll.destination,winner.entryId);
              else qm.promoteTrack(poll.destination,winner.entryId);
            }catch{
              resultNotice=`📊 Poll closed (${votesCount}v): Selected item was no longer in queue.`;
            }
          }
        }else{
          resultNotice=`📊 Poll closed (${votesCount}v): Selected item was already played or removed.`;
        }
      }else if(winner.kind==='keep'){
        resultNotice=`📊 Poll decided (${votesCount}v): Keeping current movie playing.`;
      }
      if(resultNotice)s.lastNotice=resultNotice;
      await qm.updatePlayerCard(poll.destination,{forceEdit:true}).catch(()=>{});
    }
    return true;
  }
  async handlePollUpdate(pollObj,meta=null){
    const pollId=String(pollObj?.id||'');
    if(!pollId)return false;
    return this.pollLock.run(pollId,async()=>{
      const poll=this.#resolveActivePoll(pollId,meta);
      if(!poll||poll.completed)return false;
      const options=Array.isArray(pollObj?.options)?pollObj.options:[];
      const counts=options.map(o=>Number(o?.voter_count||0));
      poll.optionCounts=counts;
      const qm=this.app?.musicQueueManager;
      const s=qm?.getSession?.(poll.destination)||null;
      let winnerIndex=null;
      let bestCount=-1;
      for(let i=0;i<options.length;i++){
        const target=poll.optionTargets?.[i];
        if(!target)continue;
        const cnt=counts[i]||0;
        const need=this.#thresholdForOption(poll,target);
        if(cnt>=need&&cnt>bestCount){
          bestCount=cnt;
          winnerIndex=i;
        }
      }
      qm?.log?.info?.({chatId:poll.destination,pollId,counts,totalVoters:pollObj?.total_voter_count,winnerIndex},'Telegram poll update received');
      if(winnerIndex!==null){
        return await this.#completePollVote(poll,winnerIndex,bestCount);
      }
      if(pollObj?.is_closed){
        poll.completed=true;
        this.activePolls.delete(pollId);
        this.#deletePersistedPoll(pollId);
        if(s?.activePoll?.pollId===pollId)s.activePoll=null;
        return true;
      }
      if(s?.activePoll?.pollId===pollId){
        s.activePoll={...s.activePoll,counts,totalVoters:Number(pollObj?.total_voter_count||counts.reduce((a,b)=>a+b,0))};
      }
      this.#persistActivePoll(poll);
      return true;
    });
  }
  async handlePollAnswer(pollAnswer,meta=null){
    const pollId=String(pollAnswer?.poll_id||'');
    if(!pollId)return false;
    return this.pollLock.run(pollId,async()=>{
      const poll=this.#resolveActivePoll(pollId,meta);
      if(!poll||poll.completed)return false;
      const voterId=String(pollAnswer?.user?.id||pollAnswer?.voter_chat?.id||'');
      if(!voterId)return false;
      const picks=Array.isArray(pollAnswer.option_ids)?pollAnswer.option_ids:[];
      if(!picks.length)poll.votesByUser.delete(voterId);
      else poll.votesByUser.set(voterId,picks);

      const tallies=new Map();
      for(const optIds of poll.votesByUser.values()){
        for(const oi of optIds)tallies.set(oi,(tallies.get(oi)||0)+1);
      }
      const counts=Array.isArray(poll.optionTargets)?poll.optionTargets.map((_,idx)=>tallies.get(idx)||0):[];
      poll.optionCounts=counts;
      const qm=this.app?.musicQueueManager;
      const s=qm?.getSession?.(poll.destination)||null;
      let winnerIndex=null;
      let bestCount=-1;
      for(const [oi,cnt] of tallies.entries()){
        const target=poll.optionTargets?.[oi];
        if(!target)continue;
        const need=this.#thresholdForOption(poll,target);
        if(cnt>=need&&cnt>bestCount){
          bestCount=cnt;
          winnerIndex=oi;
        }
      }
      qm?.log?.info?.({chatId:poll.destination,pollId,voterId,picks,counts,winnerIndex},'Telegram poll_answer vote received');
      if(winnerIndex!==null){
        return await this.#completePollVote(poll,winnerIndex,bestCount);
      }
      this.#persistActivePoll(poll);
      if(s){
        if(s.activePoll?.pollId===pollId){
          s.activePoll={...s.activePoll,counts,totalVoters:poll.votesByUser.size};
        }
        const topCnt=counts.length?Math.max(...counts):0;
        const topIdx=counts.indexOf(topCnt);
        const topTarget=topIdx>=0?poll.optionTargets?.[topIdx]:null;
        if(topTarget&&topCnt>0){
          const need=this.#thresholdForOption(poll,topTarget);
          s.lastNotice=`🗳 Viewer Poll vote (${topCnt}/${need}): ${String(topTarget.title||'Option').slice(0,60)}`;
          await qm.updatePlayerCard(poll.destination).catch(()=>{});
        }
      }
      return true;
    });
  }
  async accountCommand(ctx,args) {
    if(!this.owner(ctx)||Number(ctx.chatId)<0||ctx.isClone)throw new MusicError('OWNER_ONLY','Account-pool management is restricted to the main owner in private chat.');
    const [action='list',alias,destination]=args;
    if(action==='register')await this.accounts.register(alias);
    else if(action!=='list'&&action!=='health')await this.accounts.configure(alias,action,destination);
    await this.accounts.sync(); const live=await this.app.voiceClient.accounts(null,action==='health');
    const records=this.accounts.records(); return records.map(a=>{const runtime=live.accounts.find(x=>x.alias===a.alias);return{alias:a.alias,allowed:a.allowed,status:!a.enabled?'disabled':runtime?.status||'authentication_required',activeCalls:runtime?.active_calls||0,destinations:runtime?.destinations||[]};});
  }
  async bind(ctx,value){
    if(Number(ctx.chatId)<=0||Number(ctx.chatId)!==Number(ctx.tgId))throw new MusicError('CHANNEL_DM_REQUIRED','Use /channel @channelname in your private chat.');
    this.rate(ctx);
    const target=channelReference(value,ctx.message||{});
    let chat;
    try {
      chat=await ctx.api.getChat(target);
    } catch {
      throw new MusicError('INVALID_DESTINATION','Could not access that channel. Make sure the channel username or link is correct and the bot has been added as an administrator to the channel.');
    }
    if(!Number.isSafeInteger(chat.id)||chat.id>=0||(!this.superAdmin(ctx)&&chat.type!=='channel'))throw new MusicError('INVALID_DESTINATION','Choose a channel you administer.');
    await this.authorize(ctx,true,chat.id);
    if(chat.type==='channel')await this.channels.save(ctx,chat.id);
    this.destinations.set(`${this.botKey(ctx)}:${ctx.tgId}`,chat.id);
    const session=this.app.musicQueueManager.getSession(chat.id);await this.syncSessionIdentity(session,ctx,chat);
    return chat.id;
  }
}
