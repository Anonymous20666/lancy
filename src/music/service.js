import { isMusicOwner } from './accounts.js';
import { KeyedLock, MusicError } from './model.js';
import { checkChatMediaPermissions } from '../telegram/permissions.js';
export class MusicService {
  constructor({ app, search, lyrics, accounts }) { this.app=app; this.search=search; this.lyrics=lyrics; this.accounts=accounts; this.rates=new Map(); this.destinations=new Map(); this.controlLock=new KeyedLock(); this.panelLock=new KeyedLock(); }
  owner(ctx) { return isMusicOwner(this.app,ctx.tgId); }
  botKey(ctx) { return String(ctx.api?.me?.id || ctx.botUsername || ''); }
  destination(ctx) {
    if (Number(ctx.chatId)<0) return Number(ctx.chatId);
    const binding=this.destinations.get(`${this.botKey(ctx)}:${ctx.tgId}`);
    if (!binding) throw new MusicError('DESTINATION_REQUIRED','Use this command in a group. The owner can bind a channel from private chat with /destination <negative numeric ID>.');
    if (!this.owner(ctx)) throw new MusicError('OWNER_ONLY','Channel control is owner-only.'); return binding;
  }
  rate(ctx) {
    const now=Date.now(); for (const [key,t] of this.rates) if(now-t>60000)this.rates.delete(key);
    const key=`${ctx.chatId}:${ctx.tgId}`; if(now-(this.rates.get(key)||0)<1000) throw new MusicError('SLOW_DOWN','Please wait a moment before another music request.'); this.rates.set(key,now);
  }
  async authorize(ctx, destructive=false, destination=null) {
    const id=destination ?? this.destination(ctx);
    if (this.owner(ctx)) return id;
    if (Number(ctx.chatId)!==id) throw new MusicError('PERMISSION_DENIED','Operate this player from its own group.');
    const member=await ctx.api.getChatMember(id,Number(ctx.tgId)).catch(()=>null);
    if (!member || !['creator','administrator','member','restricted'].includes(member.status) || (member.status==='restricted' && !member.is_member)) throw new MusicError('PERMISSION_DENIED','Membership could not be verified.');
    if (destructive && !['creator','administrator'].includes(member.status)) throw new MusicError('ADMIN_ONLY','Only group administrators can change playback or remove queued tracks.'); return id;
  }
  async startSearch(ctx,query,mode='queue') {
    this.rate(ctx); const destination=['download','lyrics'].includes(mode) ? Number(ctx.chatId) : await this.authorize(ctx);
    if (!['download','lyrics'].includes(mode)) { const chat=await ctx.api.getChat(destination); const state=this.app.musicQueueManager.getSession(destination);state.isChannel=chat.type==='channel';state.bass=this.app.db.getSetting(`music.bass.${destination}`,false); await this.accounts.sync(); const available=await this.app.voiceClient.accounts(destination); if(!available.accounts.some(a=>a.enabled && ['available','busy'].includes(a.status))) throw new MusicError('ACCOUNT_UNAVAILABLE','No authorized player account is approved for this destination. Ask the owner to use /accounts allow <alias> <chat-id>.'); }
    const s=this.search.create({ userId:ctx.tgId,chatId:ctx.chatId,botId:this.botKey(ctx),destination,query,mode });
    await this.search.page(s,0); return s;
  }
  async submit(ctx,s) {
    if (!s.selected.size) throw new MusicError('EMPTY_SELECTION','Select at least one track.');
    if(s.mode==='lyrics'){if(s.selected.size!==1)throw new MusicError('ONE_SELECTION','Select one recording for lyrics.');s.lyricsTrack=[...s.selected.values()][0];s.lyricsResult=await this.lyrics.get(s.lyricsTrack);s.consumed=true;return;}
    if (s.mode==='download') {
      if (s.selected.size!==1) throw new MusicError('ONE_DOWNLOAD','Choose one track to download.');
      const permission=await checkChatMediaPermissions(ctx.api,ctx.chatId,Number(ctx.tgId)).catch(()=>null);
      if(permission?.canSendAudios===false)throw new MusicError('MEDIA_RESTRICTED','Audio uploads are restricted in this chat.');
      const track=[...s.selected.values()][0]; const media=await this.app.musicLibrary.acquire(track,{download:true});
      try {
        await ctx.api.sendAudio(ctx.chatId,await import('node:fs/promises').then(fs=>fs.readFile(media.filePath)),{title:media.track.title,performer:media.track.artist || undefined,duration:Math.floor(media.track.durationSeconds),caption:`${media.track.title}\nSource: ${media.track.provider}`,reply_to_message_id:ctx.messageId,filename:`${media.track.title.replace(/[^\p{L}\p{N}\s._-]/gu,'').slice(0,80)||'track'}.mp3`});
        s.consumed=true;
      } finally { media.release(); }
      return;
    }
    await this.authorize(ctx,false,s.destination); const tracks=[...s.selected.values()].map(t=>({...t,mediaType:s.mode==='video'?'video':'audio',requester:ctx.user?.username || ctx.user?.first_name || 'Member'}));
    await this.app.musicQueueManager.addMany(s.destination,tracks); s.consumed=true;
    await this.player(ctx,s.destination);
  }
  async player(ctx,id=this.destination(ctx)) { return this.panelLock.run(id,()=>this._player(ctx,id)); }
  async _player(ctx,id) {
    await this.authorize(ctx,false,id);
    const qm=this.app.musicQueueManager,s=qm.getSession(id); const chat=await ctx.api.getChat(id); s.isChannel=chat.type==='channel'; s.bass=this.app.db.getSetting(`music.bass.${id}`,false);
    if(s.screenMessageId && (s.playerChatId!==Number(ctx.chatId) || (s.api && s.api!==ctx.api))) throw new MusicError('PLAYER_ELSEWHERE','This destination already has its player dashboard in another control chat/bot. Use that dashboard.');
    s.view='player';
    if(!s.screenMessageId){ const sent=await ctx.api.sendRichMessage(ctx.chatId,this.app.screens.get('music').renderPlayer(s)); qm.setPlayerMessage(id,sent.message_id,Number(ctx.chatId),ctx.api); }
    else await qm.updatePlayerCard(id);
    return s;
  }
  async control(ctx,action,args=[]) {
    if(!['player','queue','qpage','lyrics','lypage','accounts','volume'].includes(action))this.rate(ctx);
    const destination=this.destination(ctx);
    return this.controlLock.run(destination,()=>this._control(ctx,action,[...args]));
  }
  async _control(ctx,action,args=[]) {
    if(!['player','pause','resume','skip','previous','stop','leave','setvol','seek','seekby','shuffle','loop','clear','remove','volume','accounts','queue','qpage','lyrics','lypage','bass','selectaccount','pin'].includes(action))throw new MusicError('STALE_PLAYER','That control is no longer supported. Open /player.');
    const id=await this.authorize(ctx,!['player','queue','qpage','lyrics','lypage','accounts','refresh_status'].includes(action));
    const qm=this.app.musicQueueManager,s=qm.getSession(id);
    if(ctx.query&&!s.screenMessageId)throw new MusicError('STALE_PLAYER','That player belongs to an earlier session. Open /player.');
    if(ctx.query && args.pop() !== String(s.controlRevision || 0))throw new MusicError('STALE_PLAYER','Use the latest player controls.');
    if(ctx.messageId && s.screenMessageId && (s.screenMessageId!==ctx.messageId || s.playerChatId!==Number(ctx.chatId) || (s.api && s.api!==ctx.api))) throw new MusicError('STALE_PLAYER','Use the current player dashboard for this destination.');
    if(['pause','resume','skip','previous'].includes(action))await qm[action](id);
    else if(action==='stop'||action==='leave')await qm.stop(id,{leave:action==='leave'});
    else if(action==='setvol')await qm.setVolume(id,Number(args[0]));
    else if(action==='seek')await qm.seek(id,Number(args[0]));
    else if(action==='seekby'){ if(s.positionSeconds==null)throw new MusicError('CLOCK_UNAVAILABLE','The playback clock is unavailable.'); await qm.seek(id,Math.max(0,s.positionSeconds+Number(args[0]))); }
    else if(action==='shuffle')qm.shuffle(id);
    else if(action==='loop')qm.toggleLoopMode(id);
    else if(action==='clear')qm.clearQueue(id);
    else if(action==='remove')qm.removeTrack(id,args[0]);
    else if(action==='volume'){s.view='volume';}
    else if(action==='accounts'){await this.accounts.sync();s.availableAccounts=(await this.app.voiceClient.accounts(id)).accounts;s.view='accounts';}
    else if(action==='queue'||action==='qpage'){s.view='queue';s.page=Math.max(0,Number(args[0])||0);}
    else if(action==='lyrics'){ const result=await this.lyrics.get(s.currentTrack);s.lyrics=result;s.lyricsPage=0;s.view='lyrics'; }
    else if(action==='lypage'){s.lyricsPage=Math.max(0,Number(args[0])||0);s.view='lyrics';}
    else if(action==='bass'){s.bass=!s.bass;this.app.db.setSetting(`music.bass.${id}`,s.bass);}
    else if(action==='selectaccount'){
      if(s.connected)throw new MusicError('ACCOUNT_BUSY','Leave the current call before changing its account.');
      const pool=await this.app.voiceClient.accounts(id);const account=pool.accounts.find(a=>a.alias===args[0]&&a.status==='available'&&a.enabled);
      if(!account)throw new MusicError('ACCOUNT_UNAVAILABLE','That approved account is no longer available.');s.preferredAccount=account.alias;
    }
    else if(action==='pin'){
      const me=ctx.api.me?.id;if(!me)throw new MusicError('PERMISSION_DENIED','Bot identity unavailable.');
      const member=await ctx.api.getChatMember(ctx.chatId,me);
      if(!['creator','administrator'].includes(member.status)||(member.status!=='creator'&&!member.can_pin_messages&&!(s.isChannel&&member.can_edit_messages)))throw new MusicError('PIN_PERMISSION','Grant only the pin permission if you want a pinned player. Playback does not require it.');
      if(!s.pinned){const result=await ctx.api.call('pinChatMessage',{chat_id:ctx.chatId,message_id:s.screenMessageId,disable_notification:true});if(!result)throw new MusicError('PIN_FAILED','Telegram did not confirm pinning.');s.pinned=true;}
    }
    if(['player','pause','resume','skip','previous','stop','leave','seek','seekby','selectaccount'].includes(action))s.view='player';
    s.controlRevision=(s.controlRevision||0)+1; await qm.updatePlayerCard(id);return s;
  }
  async accountCommand(ctx,args) {
    if(!this.owner(ctx)||Number(ctx.chatId)<0||ctx.isClone)throw new MusicError('OWNER_ONLY','Account-pool management is restricted to the main owner in private chat.');
    const [action='list',alias,destination]=args;
    if(action==='register')await this.accounts.register(alias);
    else if(action!=='list'&&action!=='health')await this.accounts.configure(alias,action,destination);
    await this.accounts.sync(); const live=await this.app.voiceClient.accounts(null,action==='health');
    const records=this.accounts.records(); return records.map(a=>{const runtime=live.accounts.find(x=>x.alias===a.alias);return{alias:a.alias,allowed:a.allowed,status:!a.enabled?'disabled':runtime?.status||'authentication_required',destination:runtime?.destination};});
  }
  bind(ctx,id){if(!this.owner(ctx)||Number(ctx.chatId)<0||!Number.isSafeInteger(Number(id))||Number(id)>=0)throw new MusicError('OWNER_ONLY','The main owner can bind a numeric channel/group ID in private chat.');this.destinations.set(`${this.botKey(ctx)}:${ctx.tgId}`,Number(id));}
}
