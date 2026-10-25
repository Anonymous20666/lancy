import { randomBytes } from 'node:crypto';
import { CallSetup } from './setup.js';
import { SavedChannels, channelReference } from './channels.js';
import { InfiniteRadio, RADIO_CATEGORIES } from './radio.js';
import { ChannelPanels } from './channelPanels.js';
import { FullTrackPreviews, audioUpload, audioFileId } from './preview.js';
import { originalPlayDelivery } from './originalPlayCard.js';
import { isMusicOwner } from './accounts.js';
import { KeyedLock, MusicError } from './model.js';
import { checkChatMediaPermissions } from '../telegram/permissions.js';
export const EQ_PRESETS = ['off','bass','vocal','nightcore','vaporwave','8d'];
export class MusicService {
  constructor({ app, search, lyrics, accounts }) { this.app=app; this.search=search; this.lyrics=lyrics; this.accounts=accounts; this.rates=new Map(); this.destinations=new Map(); this.controlLock=new KeyedLock(); this.panelLock=new KeyedLock(); this.previews=new FullTrackPreviews({app}); this.downloads=0; this.channelPanels=new ChannelPanels({service:this});this.setup=new CallSetup({service:this});this.channels=new SavedChannels({service:this});this.radio=new InfiniteRadio({app});this.listenCards=new Map();this.cardLocks=new KeyedLock();this.lyricJobs=new Map(); }
  async prepare(ctx,id=this.destination(ctx)) {
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
  async queueListen(ctx,token,{destination=null,fromCatalog=false}={}){return this.cardLocks.run(token,async()=>{const c=this.listenCard(ctx,token,{requireMessage:!fromCatalog}),id=c.destination||destination;if(!id)throw new MusicError('DESTINATION_REQUIRED','Choose a saved channel, or use /play inside your group.');if(c.destination&&destination&&c.destination!==destination)throw new MusicError('DESTINATION_CHANGED','That recording belongs to its original destination.');const generation=this.queueGeneration(id);await this.prepare(ctx,id);this.assertQueueGeneration(id,generation);await this.app.musicQueueManager.addMany(id,[{...c.track,mediaType:'audio',requester:ctx.user?.first_name||'Member'}]);c.consumed=true;return this.player(ctx,id);});}
  async streamReply(ctx,message,{video=null}={}){
    this.rate(ctx);const id=this.destination(ctx),generation=this.queueGeneration(id);await this.authorize(ctx,true,id,{allowDj:true});this.assertQueueGeneration(id,generation);await this.prepare(ctx,id);this.assertQueueGeneration(id,generation);
    const media=await this.app.musicLibrary.importTelegram(ctx.api,message,{video});let transferred=false;
    try{this.assertQueueGeneration(id,generation);await this.app.musicQueueManager.addMany(id,[{...media.track,queuedMedia:media,requester:ctx.user?.first_name||'Member'}]);transferred=true;return await this.player(ctx,id);}finally{if(!transferred)media.release();}
  }
  requestCardLyrics(s){
    const track=s.currentTrack;if(!track||!this.lyrics?.get||s.cardLyrics?.trackId===track.id||this.lyricJobs.has(s.chatId))return;
    const playback=s.playbackId;s.cardLyrics={trackId:track.id,status:'pending'};
    const job=Promise.resolve(this.lyrics.get(track)).then(result=>{if(s.currentTrack?.id===track.id&&s.playbackId===playback)s.cardLyrics={trackId:track.id,status:'ready',result};}).catch(()=>{if(s.currentTrack?.id===track.id&&s.playbackId===playback)s.cardLyrics={trackId:track.id,status:'unavailable'};}).finally(()=>{this.lyricJobs.delete(s.chatId);if(!this.app.musicQueueManager.closed)void this.app.musicQueueManager.updatePlayerCard(s.chatId).catch(()=>{});});this.lyricJobs.set(s.chatId,job);
  }
  owner(ctx) { return isMusicOwner(this.app,ctx.tgId); }
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
  async djCommand(ctx, args = []) {
    const id = await this.authorize(ctx, true);
    const key = `music.djs.${id}`;
    const current = new Set((this.app.db?.getSetting?.(key, []) || []).map(String));
    const sub = String(args[0] || '').toLowerCase();
    if (sub === 'list' || (!sub && !ctx.replyTo?.from?.id)) {
      const list = [...current];
      return list.length ? `🎧 Authorized DJs for this chat:\n${list.map(u => `• ${u}`).join('\n')}\n\nReply /dj to a member's message or use /dj add <user-id> / /dj remove <user-id>.` : '🎧 No custom DJs assigned yet. Reply /dj to a member\'s message or use /dj add <user-id> to let them queue & control tracks.';
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
      if(!chat || (chat.type!=='channel'&&!this.owner(ctx)))throw new MusicError('PERMISSION_DENIED','Only verified channel administrators can use this private controller.');
      if(chat.type==='channel'){
        const botId=ctx.api?.me?.id;
        const bot=botId?await ctx.api.getChatMember(id,botId).catch(()=>null):null;
        if(!bot||!['creator','administrator'].includes(bot.status))throw new MusicError('BOT_ADMIN_REQUIRED','Make this bot a channel administrator before opening its private dashboard.');
      }
    }else if(!destructive&&this.owner(ctx))return id;
    const member=await ctx.api?.getChatMember?.(id,Number(ctx.tgId)).catch(()=>null);
    if(!member || !['creator','administrator','member','restricted'].includes(member.status) || (member.status==='restricted'&&!member.is_member))throw new MusicError('PERMISSION_DENIED','Membership could not be verified.');
    if((destructive||remote)&&!['creator','administrator'].includes(member.status)&&!(allowDj&&!remote&&this.isDj(ctx,id)))throw new MusicError('ADMIN_ONLY','Only verified chat administrators can operate the player or change playback, queue and settings.');
    return id;
  }
  async startSearch(ctx,query,mode='queue') {
    this.rate(ctx); const destination=['download','lyrics'].includes(mode) ? Number(ctx.chatId) : await this.authorize(ctx,true,null,{allowDj:true});
    if (!['download','lyrics'].includes(mode)) { const chat=await ctx.api.getChat(destination);const state=this.app.musicQueueManager.getSession(destination);state.isChannel=chat.type==='channel';state.destinationTitle=chat.title||String(destination);state.bass=this.app.db?.getSetting?.(`music.bass.${destination}`,false)||false;state.eqPreset=this.app.db?.getSetting?.(`music.eq.${destination}`,state.bass?'bass':'off')||'off';await this.prepare(ctx,destination); }
    const s=this.search.create({ userId:ctx.tgId,chatId:ctx.chatId,botId:this.botKey(ctx),destination,query,mode });
    s.queueDestination=ctx.musicPanel?.chatId||(Number(ctx.chatId)<0?Number(ctx.chatId):this.destinations.get(`${this.botKey(ctx)}:${ctx.tgId}`))||null;
    if(!['download','lyrics'].includes(mode))s.destinationTitle=this.app.musicQueueManager.getSession(destination).destinationTitle;
    await this.search.page(s,0); return s;
  }
  async submit(ctx,s) {
    if (!s.selected.size) throw new MusicError('EMPTY_SELECTION','Select at least one track.');
    if(s.mode==='lyrics'){if(s.selected.size!==1)throw new MusicError('ONE_SELECTION','Select one recording for lyrics.');s.lyricsTrack=[...s.selected.values()][0];s.lyricsResult=await this.lyrics.get(s.lyricsTrack);s.consumed=true;return;}
    if (s.mode==='download') {
      if (s.selected.size!==1) throw new MusicError('ONE_DOWNLOAD','Choose one track to download.');
      if(this.downloads>=2)throw new MusicError('DOWNLOAD_BUSY','Two full-song deliveries are already being prepared. Please try again shortly.');
      this.downloads++;
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
      }finally{this.downloads--;}
      return;
    }
    const generation=this.queueGeneration(s.destination);await this.authorize(ctx,true,s.destination,{allowDj:true});this.assertQueueGeneration(s.destination,generation);if(typeof this.app.voiceClient?.setup==='function')await this.prepare(ctx,s.destination);this.assertQueueGeneration(s.destination,generation); const tracks=[...s.selected.values()].map(t=>({...t,mediaType:s.mode==='video'?'video':'audio',requester:ctx.user?.username || ctx.user?.first_name || 'Member'}));
    await this.app.musicQueueManager.addMany(s.destination,tracks); s.consumed=true;
    await this.player(ctx,s.destination);
  }
  async player(ctx,id=this.destination(ctx)) { return this.panelLock.run(id,()=>this._player(ctx,id)); }
  async _player(ctx,id) {
    await this.authorize(ctx,true,id,{allowDj:true});
    const qm=this.app.musicQueueManager,s=qm.getSession(id); const chat=await ctx.api.getChat(id); s.isChannel=chat.type==='channel'; s.destinationTitle=chat.title || (s.isChannel?'Channel':'Group'); s.bass=this.app.db?.getSetting?.(`music.bass.${id}`,false)||false; s.eqPreset=this.app.db?.getSetting?.(`music.eq.${id}`,s.bass?'bass':'off')||'off';
    if(s.currentTrack)this.requestCardLyrics(s);
    if(s.isChannel)return this.channelPanels.open(ctx,s);
    if(s.screenMessageId && (s.playerChatId!==Number(ctx.chatId) || (s.api && s.api!==ctx.api))) throw new MusicError('PLAYER_ELSEWHERE','This destination already has its player dashboard in another control chat/bot. Use that dashboard.');
    s.view='player';
    const created=!s.screenMessageId;
    if(created){const rich=this.app.screens.get('music').renderPlayer(s);const sent=await ctx.api.sendRichMessage(ctx.chatId,rich);qm.setPlayerMessage(id,sent.message_id,Number(ctx.chatId),ctx.api);s.lastRender=JSON.stringify(rich);}
    else await qm.updatePlayerCard(id);
    this.previews.schedule(s);
    if(created&&s.fullPreview)await qm.updatePlayerCard(id);
    return s;
  }
  async control(ctx,action,args=[]) {
    if(!['player','queue','qpage','lyrics','lypage','accounts','volume','options','eq','voteskip','bass'].includes(action))this.rate(ctx);
    const destination=this.destination(ctx);
    // Urgent Stop must reach the queue cancellation path even when an older
    // Skip/radio control is still waiting for source preparation. _control still
    // performs fresh authorization and full callback/message validation first.
    if(['stop','leave'].includes(action))return this._control(ctx,action,[...args]);
    return this.controlLock.run(destination,()=>this._control(ctx,action,[...args]));
  }
  async _control(ctx,action,args=[]) {
    if(!['player','pause','resume','skip','previous','stop','leave','setvol','seek','seekby','shuffle','loop','clear','remove','volume','accounts','queue','qpage','lyrics','lypage','bass','eq','voteskip','selectaccount','pin','options','preview','playnow','radio','rpage','rpick','rstart','roff','retry'].includes(action))throw new MusicError('STALE_PLAYER','That control is no longer supported. Open /player.');
    const isVoteSkip=action==='voteskip';
    const allowDj=!['stop','leave','accounts','selectaccount','pin'].includes(action);
    const id=await this.authorize(ctx,!isVoteSkip,null,{allowDj});
    const qm=this.app.musicQueueManager;
    const panel=ctx.musicPanel || (qm.getSession(id).isChannel ? this.channelPanels.find(ctx,id) : null);
    const s=panel?.state ? this.channelPanels.state(panel) : panel || qm.getSession(id);
    if(s.isChannel&&!s.panelToken)throw new MusicError('CHANNEL_DM_REQUIRED','Open /channel @channelname in your private chat first.');
    if(ctx.query&&!s.screenMessageId)throw new MusicError('STALE_PLAYER','That player belongs to an earlier session. Open /player.');
    if(ctx.query && args.pop() !== (s.panelToken?Number(s.controlRevision||0).toString(36):String(s.controlRevision||0)))throw new MusicError('STALE_PLAYER','Use the latest player controls.');
    if(ctx.messageId && s.screenMessageId && (s.screenMessageId!==ctx.messageId || s.playerChatId!==Number(ctx.chatId) || (s.api && s.api!==ctx.api))) throw new MusicError('STALE_PLAYER','Use the current player dashboard for this destination.');
    if(['pause','resume','skip','previous'].includes(action)){
      if(action==='skip'){
        s.lastNotice='⏭ Skipping to next track…';
        if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:'⏭ Skipping to next track…'}).catch(()=>{});
        if(s.screenMessageId)void qm.updatePlayerCard(id).catch(()=>{});
      }else if(action==='previous'){
        s.lastNotice='⏮ Loading previous track…';
        if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:'⏮ Loading previous track…'}).catch(()=>{});
        if(s.screenMessageId)void qm.updatePlayerCard(id).catch(()=>{});
      }else if(action==='pause'){
        if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:'⏸ Paused'}).catch(()=>{});
      }else if(action==='resume'){
        if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:'▶ Resumed'}).catch(()=>{});
      }
      await qm[action](id);
    }
    else if(action==='voteskip'){
      if(!s.currentTrack||!['playing','paused'].includes(s.status))throw new MusicError('NOTHING_PLAYING','There is no active track to vote-skip.');
      const needed=Math.max(1,Number(this.app.settings?.get?.('music.skipVoteThreshold')||2));
      const votes=new Set(Array.isArray(s.skipVotes)?s.skipVotes:[]);
      votes.add(String(ctx.tgId));
      s.skipVotes=[...votes];
      if(s.skipVotes.length>=needed){
        s.skipVotes=[];
        s.lastNotice=`Vote skip passed (${needed}/${needed}) — advancing to next track.`;
        if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:'Vote skip passed! Skipping…'}).catch(()=>{});
        await qm.skip(id);
      }else{
        s.lastNotice=`Skip vote recorded (${s.skipVotes.length}/${needed} needed).`;
        if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:`Skip vote: ${s.skipVotes.length}/${needed}`}).catch(()=>{});
      }
      s.view='player';
    }
    else if(action==='stop'||action==='leave'){
      if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:'⏹ Stopping playback…'}).catch(()=>{});
      qm.requestStop?.(id);await this.setup.lock.run(Number(id),()=>qm.stop(id));
    }
    else if(action==='retry'){s.lastNotice='Preparing your queued recording…';await qm.updatePlayerCard(id);const generation=this.queueGeneration(id);await this.prepare(ctx,id);this.assertQueueGeneration(id,generation);await qm.ensurePlaying(id);s.view='player';}
    else if(action==='setvol'){
      const targetVol=Number(args[0]);
      await qm.setVolume(id,targetVol);
      if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:`Volume: ${targetVol}%`}).catch(()=>{});
    }
    else if(action==='seek')await qm.seek(id,Number(args[0]));
    else if(action==='seekby'){ if(s.positionSeconds==null)throw new MusicError('CLOCK_UNAVAILABLE','The playback clock is unavailable.'); await qm.seek(id,Math.max(0,s.positionSeconds+Number(args[0]))); }
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
      s.lastNotice='▶ Switching track…';
      if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:'▶ Switching track…'}).catch(()=>{});
      await qm.playNow(id,entry);
      s.view='player';
    }
    else if(['radio','rpage','rpick','rstart','roff','retry'].includes(action)){
      s.view='radio';if(action==='rpage')s.radioPage=Math.max(0,Math.min(7,Number(args[0])||0));
      if(action==='rpick'){const index=Number(args[0]);if(!RADIO_CATEGORIES[index])throw new MusicError('RADIO_SELECTION','Choose a category from this menu.');const selected=[...(s.radioSelected||[])];const at=selected.indexOf(index);if(at>=0)selected.splice(at,1);else{if(selected.length+(s.radioCustom?1:0)>=5)throw new MusicError('RADIO_SELECTION','Choose up to five categories/custom searches.');selected.push(index);}s.radioSelected=selected;}
      if(action==='roff')this.radio.stop(qm.getSession(id));
      if(action==='rstart'){const generation=qm.getSession(id).stopGeneration||0;await this.prepare(ctx,id);if((qm.getSession(id).stopGeneration||0)!==generation)throw new MusicError('ACTION_CANCELLED','Radio start was cancelled by Stop.');this.radio.configure(qm.getSession(id),[...(s.radioSelected||[]).map(i=>RADIO_CATEGORIES[i]),...(s.radioCustom?[s.radioCustom]:[])]);await this.radio.refill(qm.getSession(id));await qm.ensurePlaying(id);s.view='player';}
    }
    else if(action==='remove'){let entry=args[0];if(s.panelToken){const matches=s.upcoming.filter(t=>t.entryId.replaceAll('-','').slice(0,12)===entry);if(matches.length!==1)throw new MusicError('STALE_PLAYER','That queued recording is no longer available.');entry=matches[0].entryId;}qm.removeTrack(id,entry);}
    else if(action==='options'){s.view='options';}
    else if(action==='preview'){if(this.previews.pending.has(id))throw new MusicError('PREVIEW_BUSY','The full preview is already being prepared.');s.fullPreview=null;s.view='player';}
    else if(action==='volume'){s.view='volume';}
    else if(action==='accounts'){await this.accounts.sync();s.availableAccounts=(await this.app.voiceClient.accounts(id)).accounts;s.view='accounts';}
    else if(action==='queue'||action==='qpage'){s.view='queue';s.page=Math.max(0,Number(args[0])||0);}
    else if(action==='lyrics'){ const result=await this.lyrics.get(s.currentTrack);s.lyrics=result;s.lyricsPage=0;s.view='lyrics'; }
    else if(action==='lypage'){s.lyricsPage=Math.max(0,Number(args[0])||0);s.view='lyrics';}
    else if(action==='bass'){s.bass=!s.bass;s.eqPreset=s.bass?'bass':'off';this.app.db?.setSetting?.(`music.bass.${id}`,s.bass);this.app.db?.setSetting?.(`music.eq.${id}`,s.eqPreset);}
    else if(action==='eq'){
      const requested=args[0]&&EQ_PRESETS.includes(String(args[0]).toLowerCase())?String(args[0]).toLowerCase():null;
      const cur=EQ_PRESETS.includes(s.eqPreset)?s.eqPreset:(s.bass?'bass':'off');
      s.eqPreset=requested || EQ_PRESETS[(EQ_PRESETS.indexOf(cur)+1)%EQ_PRESETS.length];
      s.bass=s.eqPreset==='bass';
      this.app.db?.setSetting?.(`music.eq.${id}`,s.eqPreset);
      this.app.db?.setSetting?.(`music.bass.${id}`,s.bass);
      if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:`EQ preset: ${s.eqPreset}`}).catch(()=>{});
    }
    else if(action==='selectaccount'){
      if(s.connected||s.prepared)throw new MusicError('ACCOUNT_BUSY','Leave the current prepared session/call before changing its account.');
      const pool=await this.app.voiceClient.accounts(id);const account=pool.accounts.find(a=>a.alias===args[0]&&a.status==='available'&&a.enabled);
      if(!account)throw new MusicError('ACCOUNT_UNAVAILABLE','That approved account is no longer available.');s.preferredAccount=account.alias;
    }
    else if(action==='pin'&&s.panelToken)await this.channelPanels.pin(s.panelToken,{force:true});
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
    const records=this.accounts.records(); return records.map(a=>{const runtime=live.accounts.find(x=>x.alias===a.alias);return{alias:a.alias,allowed:a.allowed,status:!a.enabled?'disabled':runtime?.status||'authentication_required',activeCalls:runtime?.active_calls||0,destinations:runtime?.destinations||[]};});
  }
  async bind(ctx,value){
    if(Number(ctx.chatId)<=0||Number(ctx.chatId)!==Number(ctx.tgId))throw new MusicError('CHANNEL_DM_REQUIRED','Use /channel @channelname in your private chat.');
    this.rate(ctx);
    const target=channelReference(value,ctx.message||{});
    const chat=await ctx.api.getChat(target);
    if(!Number.isSafeInteger(chat.id)||chat.id>=0||(!this.owner(ctx)&&chat.type!=='channel'))throw new MusicError('INVALID_DESTINATION','Choose a channel you administer.');
    await this.authorize(ctx,true,chat.id);
    if(chat.type==='channel')await this.channels.save(ctx,chat.id);
    this.destinations.set(`${this.botKey(ctx)}:${ctx.tgId}`,chat.id);
    const session=this.app.musicQueueManager.getSession(chat.id);session.isChannel=chat.type==='channel';session.destinationTitle=chat.title||'Channel';
    return chat.id;
  }
}
