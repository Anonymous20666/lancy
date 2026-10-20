import { TemporaryBotMessages } from '../../music/messages.js';
import { audioInput } from '../../music/preview.js';
import { RichMessageBuilder, rt, richButton, encodeCallback, NOOP_CALLBACK } from '../rich.js';
import { States } from '../../core/stateMachine.js';
import { durationText, MusicError } from '../../music/model.js';
const cut = (s,n=65) => [...String(s || '')].slice(0,n).join('');
const cb = (action,...args) => encodeCallback('music',action,...args);
const button = (text,action,...args) => richButton.callback(text,cb(action,...args));
const card = (title,subtitle) => new RichMessageBuilder().paragraph(rt.bold(title)).paragraph(rt.italic(subtitle));
const finish = b => { b.validate(); return b.toJSON(); };

export function createMusicScreen({ app }) {
  const id='music';
  const temporary = new TemporaryBotMessages();
  function controls(s,label,action,...args){return button(label,action,...args,s.controlRevision||0);}
  function renderHome(){
    const b=card('Lancy · music','Find your track. Set the mood.');
    b.quote(rt.text('/play — listen here or download\n/addq — search and queue audio\n/vplay — queue genuine video + audio\n/player — your live dashboard'));
    b.buttons([button('Voice chat','prompt','queue'),button('Listen / download','prompt','download')]);
    b.buttons([button('Video','prompt','video'),button('Open player','openplayer')]);
    b.paragraph(rt.text('Search “title artist”, or prefix audius: / youtube:. Availability depends on source permissions.'));
    b.paragraph(rt.text('/playlist list · /playlist save <name> · /playlist load <name>'));
    return finish(b);
  }
  function trackAudio(b, track, media, vc = false) {
    b.audio(audioInput(track, media), vc ? 'Full track · listen here, independently of the voice chat' : 'Full track · listen in Telegram or save from the audio menu');
  }
  function renderListen(track, media) {
    const b=card('Lancy · listen & download','Your full recording. No voice chat needed.');
    trackAudio(b,track,media);
    b.quote(rt.concat(rt.bold(cut(track.title,160)),rt.text(`\n${cut(track.artist||'Artist not supplied',100)}${track.album?` · ${cut(track.album,60)}`:''}`)));
    b.paragraph(rt.text(`${durationText(track.durationSeconds)} · ${track.provider} · MP3`));
    b.buttons([button('Find another song','prompt','download'),button('Search for VC','prompt','queue')]);
    b.paragraph(rt.italic('Tap the audio to listen; use its menu to save the file. VC search is separate and requires a group or an owner-bound destination.'));
    return finish(b);
  }
  function renderPlayer(s){
    const b=card(s.isChannel?'Lancy · CHANNEL LIVE BROADCAST':'Lancy · music',`${s.isChannel?'Channel broadcast':'Voice chat'} · ${s.destinationTitle || (s.isChannel?'Channel':'Group')} · ${s.status}`);
    if(s.status==='stopped'){b.quote(rt.text('Playback service stopped. Open the current player after restart.'));if(s.lastError)b.paragraph(rt.text(s.lastError));b.buttons([button('Open current player','openplayer')]);return finish(b);}
    const t=s.currentTrack;
    if(!t){ b.quote(rt.text(s.connected?'Queue complete. Holding the call for ten minutes.':'No active playback. Use Add tracks for VC, or Listen / download without joining a call.')); }
    else {
      const preview=s.fullPreview?.trackId===t.id?s.fullPreview:null;
      if(preview?.status==='ready'&&preview.fileId)trackAudio(b,preview.track||t,preview.fileId,true);
      else if(preview?.status==='pending')b.paragraph(rt.italic('Preparing the full-song audio player… VC playback continues independently.'));
      else if(preview?.status==='unavailable')b.paragraph(rt.italic(cut(preview.reason,240)));
      b.quote(rt.concat(rt.bold(cut(t.title,160)),rt.text(`\n${cut(t.artist||'Artist not supplied',100)}${t.album?` · ${cut(t.album,60)}`:''}\nVC · ${durationText(s.positionSeconds)} / ${durationText(t.durationSeconds)} · ${t.mediaType==='video'?'Video + audio':'Audio'} · ${t.provider}`)));
      if(Number.isFinite(s.positionSeconds)&&t.durationSeconds){const n=Math.max(0,Math.min(10,Math.floor(s.positionSeconds/t.durationSeconds*10)));b.paragraph(rt.text('━'.repeat(n)+'─'.repeat(10-n)));}
      b.paragraph(rt.text(`VC volume ${s.volumeConfirmed===false?'unconfirmed':`${s.volume}%`} · Repeat ${s.loopMode} · ${s.upcoming?.length||0} queued`));
      if(s.upcoming?.[0])b.paragraph(rt.text(`Up next · ${cut(s.upcoming[0].title)}`));
      if(['playing','paused'].includes(s.status))b.buttons([controls(s,'Previous','previous'),controls(s,s.status==='paused'?'Resume VC':'Pause VC',s.status==='paused'?'resume':'pause'),controls(s,'Skip','skip')]);
      if(t.capabilities?.seek&&Number.isFinite(s.positionSeconds))b.buttons([controls(s,'−10 sec','seekby',-10),controls(s,'+10 sec','seekby',10)]);
    }
    if(s.lastNotice)b.paragraph(rt.text(cut(s.lastNotice,350)));
    if(s.lastError)b.paragraph(rt.text(cut(s.lastError,350)));
    b.buttons([controls(s,`Queue · ${s.upcoming?.length||0}`,'queue'),controls(s,'Lyrics','lyrics'),controls(s,'VC volume','volume')]);
    b.buttons([button('Add tracks','prompt','queue'),button('Listen / download','prompt','download'),controls(s,'More','options')]);
    return finish(b);
  }
  function renderOptions(s){
    const b=card('Lancy · voice-chat settings','Changes stay in this dashboard');
    b.paragraph(rt.text(`Account · ${s.accountAlias||s.preferredAccount||'Not connected'}\nRepeat · ${s.loopMode}\nGentle bass · ${s.bass?'on':'off'}`));
    b.buttons([controls(s,`Repeat · ${s.loopMode}`,'loop'),controls(s,'Shuffle','shuffle')]);
    b.buttons([controls(s,s.bass?'Bass · on':'Bass · off','bass'),controls(s,'Accounts','accounts')]);
    b.buttons([controls(s,'Pin player','pin'),controls(s,'Retry full preview','preview')]);
    b.buttons([controls(s,'Stop playback','stop'),controls(s,'Leave call','leave')]);
    b.buttons([controls(s,'Back to player','player')]);
    b.paragraph(rt.italic('VC settings do not control the audio player above. Bass changes apply to the next track. /seek <seconds> · /volume <0–150>'));
    return finish(b);
  }
  function renderQueue(s,page=0){
    const total=Math.max(1,Math.ceil(s.upcoming.length/5));page=Math.max(0,Math.min(Number(page)||0,total-1));
    const b=card('Lancy · queue',`Page ${page+1} of ${total} · ${s.upcoming.length} upcoming`);
    if(s.currentTrack)b.quote(rt.text(`Now · ${cut(s.currentTrack.title)} · ${durationText(s.currentTrack.durationSeconds)}`));
    const entries=s.upcoming.slice(page*5,page*5+5);
    if(!entries.length)b.paragraph(rt.text('Nothing queued. Add tracks with /addq.'));
    entries.forEach((t,i)=>{b.paragraph(rt.text(`${page*5+i+1}. ${cut(t.title)}\n${cut(t.artist||'Artist not supplied',40)} · ${durationText(t.durationSeconds)}`));b.buttons([controls(s,`Remove ${page*5+i+1}`,'remove',t.entryId)]);});
    const row=[];if(page>0)row.push(controls(s,'Previous page','qpage',page-1));if(page<total-1)row.push(controls(s,'Next page','qpage',page+1));if(row.length)b.buttons(row);
    b.buttons([controls(s,'Back to player','player'),controls(s,'Clear upcoming','clear')]);return finish(b);
  }
  function renderVolumePicker(s){const b=card('Lancy · volume',`${s.volume}% · unity gain is 100%; boosting can clip`);b.buttons([50,75,100].map(v=>controls(s,`${v}%`,'setvol',v)));b.buttons([controls(s,'Back to player','player')]);return finish(b);}
  function renderSearch(s){
    const p=s.pages[s.index],b=card(s.mode==='lyrics'?'Lancy · lyrics':s.mode==='download'?'Lancy · download':'Lancy · select your tracks',`${cut(s.query,90)} · ${p.provider} · page ${s.index+1}${['download','lyrics'].includes(s.mode)?'':` · destination ${s.destination}`}`);
    if(!p.items.length)b.paragraph(rt.text('No new results. Go back or search a different title and artist.'));
    p.items.forEach((t,i)=>{const selected=s.selected.has(t.id);b.paragraph(rt.text(`${i+1}. ${cut(t.title,100)}\n${cut(t.artist||'Artist not supplied',65)} · ${durationText(t.durationSeconds)} · ${t.provider}`));b.buttons([button(selected?'✓ Selected':'Select','pick',s.id,s.revision,i)]);});
    const row=[];if(s.index>0)row.push(button('Previous','spage',s.id,s.revision,s.index-1));if(p.nextOffset!=null)row.push(button('Next','spage',s.id,s.revision,s.index+1));if(row.length)b.buttons(row);
    b.buttons([button(s.mode==='lyrics'?'Show matched lyrics':s.mode==='download'?`Download selected · ${s.selected.size}`:`Add selected · ${s.selected.size}`,'submit',s.id,s.revision),button('Clear','sclear',s.id,s.revision)]);
    b.paragraph(rt.italic('Selected tracks stay selected across pages. Resolution and source permissions are checked before playback/download.'));
    return finish(b);
  }
  function renderAccounts(s){
    const b=card('Lancy · player accounts','Owner-approved aliases for this destination');
    for(const a of s.availableAccounts||[]){b.paragraph(rt.text(`${a.alias} · ${a.status}`));if(a.status==='available')b.buttons([controls(s,`Use ${a.alias}`,'selectaccount',a.alias)]);}
    if(!s.availableAccounts?.length)b.paragraph(rt.text('No accounts approved for this destination.'));
    b.buttons([controls(s,'Back to player','player')]);return finish(b);
  }
  function renderLyrics(s){
    const l=s.lyrics,b=card('Lancy · lyrics',l?.found?`${cut(l.title)} · ${cut(l.artist,40)} · ${l.source}`:'Match unavailable');
    if(!l?.found)b.paragraph(rt.text(l?.reason||'Choose a track first.'));
    else if(l.instrumental)b.paragraph(rt.text('This recording is marked instrumental.'));
    else {
      const full=process.env.MUSIC_LYRICS_FULL_TEXT==='true'; const text=full?l.text:cut(l.text,200);const pages=text.match(/[\s\S]{1,1800}/g)||[''];const p=Math.min(s.lyricsPage||0,pages.length-1);
      b.quote(rt.text(pages[p]));if(!full)b.paragraph(rt.italic('Excerpt · full display is disabled unless the operator has appropriate display rights.'));
      const row=[];if(p>0)row.push(controls(s,'Previous','lypage',p-1));if(p<pages.length-1)row.push(controls(s,'Next','lypage',p+1));if(row.length)b.buttons(row);
    }
    b.buttons([controls(s,'Back to player','player')]);return finish(b);
  }
  function renderStandaloneLyrics(track,result){
    const b=card('Lancy · matched lyrics',`${cut(track.title,100)} · ${cut(track.artist||'Artist not supplied',70)}`);
    if(!result?.found)b.paragraph(rt.text(result?.reason||'No reliable lyrics match.'));
    else if(result.instrumental)b.paragraph(rt.text('This recording is marked instrumental.'));
    else {b.quote(rt.text(cut(result.text,200)));b.paragraph(rt.italic('LRCLIB · excerpt. Full matched lyrics are available in the player only when appropriate display rights are configured.'));}
    b.buttons([button('Search another recording','prompt','lyrics')]);return finish(b);
  }
  function renderSessionSetupNotice(){const b=card('ASSISTANT ACCOUNT SETUP REQUIRED','Owner-managed user sessions');b.paragraph(rt.text('A bot token alone is not a playback account. The main owner should run the local terminal session generator, register its alias with /accounts, and approve this destination. Never send login codes or session strings to the bot.'));b.buttons([button('Account status','refresh_status')]);return finish(b);}
  function renderAssistantSessionStatus(health){const b=card('STREAMING ENGINE STATUS',health?.ready?'Account pool ready':'Voice engine not ready');b.paragraph(rt.text(`Mode · ${health?.mode==='bot_token'?'Bot Direct (unsupported for playback)':health?.mode==='assistant_user'?'Assistant Userbot (legacy)':health?.mode||'offline'}\nActive calls · ${health?.active_calls_count||0}`));b.paragraph(rt.text('Owner setup: /accounts list. Registration is local-terminal only.'));return finish(b);}
  async function error(ctx,e){const sent=await ctx.api.sendMessage(ctx.chatId,e instanceof MusicError?e.message:'The music operation could not finish. Check account health or try again later.');temporary.remember(ctx,sent,{ttlMs:60000});return sent;}
  async function search(ctx,query,mode='queue'){
    if(!query)return prompt(ctx,mode);
    const pending=await ctx.api.sendMessage(ctx.chatId,'Finding your tracks…');
    const temporaryToken=temporary.remember(ctx,pending);
    try{const s=await app.music.startSearch(ctx,query,mode);s.messageId=pending.message_id;s.temporaryToken=temporaryToken;await ctx.api.editMessageRich(ctx.chatId,s.messageId,renderSearch(s));return s;}
    catch(e){await ctx.api.editMessageText(ctx.chatId,pending.message_id,e instanceof MusicError?e.message:'Search failed. Try a different title and artist.');temporary.keep(temporaryToken);temporary.remember(ctx,pending,{ttlMs:60000});}
  }
  async function prompt(ctx,mode){
    if(['queue','video'].includes(mode))app.music.destination?.(ctx);
    if(app.sm.state(ctx.tgId)===States.MUSIC_QUEUE_INPUT)await app.sm.reset(ctx.tgId);
    const group=Number(ctx.chatId)<0, name=cut(ctx.user?.first_name||'Music request',40);
    const text=`${group?`${name}, `:''}send a track title and artist${group?' as a reply to this message':''}. /cancel closes this search.`;
    const sent=await ctx.api.sendMessage(ctx.chatId,text,{reply_markup:{force_reply:true,selective:true},
      ...(group?{entities:[{type:'text_mention',offset:0,length:name.length,user:{id:Number(ctx.tgId),is_bot:false,first_name:name}}]}:{}),
      ...(ctx.message?.from?.id===Number(ctx.tgId)?{reply_to_message_id:ctx.message.message_id}:{})});
    const temporaryToken=temporary.remember(ctx,sent,{ttlMs:120000});
    try{await app.sm.transition(ctx.tgId,States.MUSIC_QUEUE_INPUT,{chatId:ctx.chatId,timeoutMs:120000,context:{mode,botKey:app.music.botKey(ctx),promptMessageId:sent.message_id,temporaryToken}});}catch(e){await temporary.remove(temporaryToken);throw e;}
    return sent;
  }
  async function showAccounts(ctx){
    const id=await app.music.authorize(ctx,false);await app.music.accounts.sync();const pool=await app.voiceClient.accounts(id);const s=app.musicQueueManager.getSession(id);
    const b=card('Lancy · player accounts','Only owner-approved aliases for this destination');
    for(const a of pool.accounts){b.paragraph(rt.text(`${a.alias} · ${a.status}`));if(a.status==='available')b.buttons([controls(s,`Use ${a.alias}`,'selectaccount',a.alias)]);}
    if(!pool.accounts.length)b.paragraph(rt.text('No accounts approved. Ask the owner to use /accounts allow.'));
    b.buttons([controls(s,'Back to player','player')]);await ctx.api.editMessageRich(ctx.chatId,ctx.messageId,finish(b));
  }
  async function handle(ctx,action,args=[]){
    try{
      if(action==='prompt')return await prompt(ctx,args[0]||'queue');
      if(action==='openplayer')return await app.music.player(ctx);
      if(['pick','spage','sclear','submit'].includes(action)){
        const [token,revision,index]=args;
        let state;
        await app.music.search.action(token,revision,ctx,async s=>{state=s;if(action==='spage')await app.music.search.page(s,Number(index));
          if(action==='pick'){const t=s.pages[s.index].items[Number(index)];if(!t)throw new MusicError('INVALID_SELECTION','That track is unavailable.');if(s.selected.has(t.id))s.selected.delete(t.id);else{if(['download','lyrics'].includes(s.mode))s.selected.clear();if(s.selected.size>=20)throw new MusicError('SELECTION_LIMIT','Select up to 20 tracks per batch.');s.selected.set(t.id,t);}}
          if(action==='sclear')s.selected.clear();
          if(action==='submit'){
            temporary.hold(s.temporaryToken);
            try{await app.music.submit(ctx,s);}
            finally{
              if(s.consumed&&s.mode==='download')temporary.keep(s.temporaryToken);
              else if(s.consumed&&s.mode!=='lyrics')await temporary.remove(s.temporaryToken);
              else temporary.expire(s.temporaryToken,Math.max(1000,(s.expires||Date.now()+60000)-Date.now()));
            }
          }
        });
        if(state.consumed&&state.mode==='lyrics'){await ctx.api.editMessageRich(ctx.chatId,ctx.messageId,renderStandaloneLyrics(state.lyricsTrack,state.lyricsResult));temporary.keep(state.temporaryToken);}
        else if(state.consumed&&state.mode==='download')temporary.keep(state.temporaryToken);
        else if(state.consumed)await temporary.remove(state.temporaryToken);
        else await ctx.api.editMessageRich(ctx.chatId,ctx.messageId,renderSearch(state));return;
      }
      if(action==='refresh_status'){if(!app.music.owner(ctx)||Number(ctx.chatId)<0)throw new MusicError('OWNER_ONLY','Account health is available to the main owner in private chat.');const health=await app.voiceClient.checkHealth();return ctx.api.editMessageRich(ctx.chatId,ctx.messageId,renderAssistantSessionStatus(health));}
      if(action==='link_assistant')throw new MusicError('TERMINAL_SETUP','Telegram login-code collection has been retired. Use the protected local terminal generator.');
      if(action==='accounts')return await app.music.control(ctx,'accounts',args);
      if(action==='volume')return await app.music.control(ctx,'volume',args);
      await app.music.control(ctx,action,args);
    }catch(e){await error(ctx,e);}
  }
  async function handleCommand(ctx,command,args=[]){
    const commands=['/play','/song','/music','/addq','/vplay','/stream','/vc','/vcplay','/player','/pause','/resume','/skip','/next','/previous','/stop','/end','/leave','/queue','/q','/volume','/vol','/loop','/repeat','/shuffle','/seek','/accounts','/destination','/session','/gensession','/authassistant','/linkassistant','/playlist','/lyrics'];
    if(!commands.includes(command))return false;
    try{
      if(['/play','/song'].includes(command)&&!args.length&&ctx.controller?.handleAudioRecognition&&[ctx.replyTo?.audio,ctx.replyTo?.voice,ctx.replyTo?.video,ctx.replyTo?.video_note].some(Boolean)){await ctx.controller.handleAudioRecognition(ctx,ctx.replyTo);return true;}
      if(command==='/lyrics'){
        if(args.length)await search(ctx,args.join(' '),'lyrics');
        else {let current=null;try{current=app.musicQueueManager.getSession(app.music.destination(ctx)).currentTrack;}catch{}if(current)await app.music.control(ctx,'lyrics',[]);else await search(ctx,'','lyrics');}
      }
      else if(['/play','/song','/addq','/vplay','/stream','/vcplay','/vc'].includes(command)){await app.sm?.reset(ctx.tgId);await search(ctx,args.join(' '),['/play','/song'].includes(command)?'download':command==='/vplay'?'video':'queue');}
      else if(command==='/music'){if(args.length)await search(ctx,args.join(' '),'download');else await ctx.api.sendRichMessage(ctx.chatId,renderHome());}
      else if(command==='/accounts'){const accounts=await app.music.accountCommand(ctx,args);await ctx.api.sendMessage(ctx.chatId,accounts.map(a=>`${a.alias} · ${a.status}${a.destination?` · ${a.destination}`:''}\nApproved: ${a.allowed.join(', ')||'none'}`).join('\n\n')||'No registered accounts. Generate one locally, then /accounts register <alias>.');}
      else if(['/session','/gensession','/authassistant','/linkassistant'].includes(command)){if(!app.music.owner(ctx)||Number(ctx.chatId)<0)throw new MusicError('OWNER_ONLY','Use /accounts in the main owner private chat.');await ctx.api.sendRichMessage(ctx.chatId,renderSessionSetupNotice());}
      else if(command==='/destination'){app.music.bind(ctx,args[0]);await ctx.api.sendMessage(ctx.chatId,`Control destination set to ${Number(args[0])}. Use /player.`);}
      else if(command==='/playlist')await playlist(ctx,args);
      else{
        const s=await app.music.player(ctx);ctx={...ctx,messageId:null,query:null};
        const action=(!args.length&&['/volume','/vol'].includes(command))?'volume':({'/next':'skip','/q':'queue','/end':'stop','/vol':'setvol','/volume':'setvol','/repeat':'loop','/vc':'player'}[command]||command.slice(1));
        if(action!=='player')await app.music.control(ctx,action,args);
      }
    }catch(e){await error(ctx,e);}return true;
  }
  async function playlist(ctx,args){
    const [action='list',...nameParts]=args;const name=nameParts.join(' ').trim();const key=`music.playlists.${ctx.tgId}`;const lists=app.db.getSetting(key,{});
    if(action==='list')return ctx.api.sendMessage(ctx.chatId,Object.keys(lists).join('\n')||'No saved playlists. /playlist save <name> saves the current queue.');
    if(!/^[\p{L}\p{N} _-]{1,40}$/u.test(name)||['__proto__','constructor','prototype'].includes(name))throw new MusicError('PLAYLIST_NAME','Use a playlist name of 1–40 letters, numbers, spaces, underscores or hyphens.');
    if(action==='save'){const id=await app.music.authorize(ctx);const s=app.musicQueueManager.getSession(id);if(Object.keys(lists).length>=20&&!lists[name])throw new MusicError('PLAYLIST_LIMIT','Keep up to 20 playlists.');lists[name]=[s.currentTrack,...s.upcoming].filter(t=>t&&['youtube','audius'].includes(t.provider)).slice(0,50).map(({id,provider,providerId,title,artist,album,durationSeconds,artwork,sourceRef,mediaType,capabilities})=>({id,provider,providerId,title,artist,album,durationSeconds,artwork,sourceRef,mediaType,capabilities}));app.db.setSetting(key,lists);}
    else if(action==='delete'){delete lists[name];app.db.setSetting(key,lists);}
    else if(action==='load'){const id=await app.music.authorize(ctx);if(!lists[name]?.length)throw new MusicError('PLAYLIST_MISSING','That playlist is missing or empty.');await app.music.accounts.sync();await app.musicQueueManager.addMany(id,lists[name]);await app.music.player(ctx,id);}
    else throw new MusicError('PLAYLIST_ACTION','Use /playlist list, save, load or delete.');
    return ctx.api.sendMessage(ctx.chatId,`Playlist ${action} completed · ${name}`);
  }
  function registerStateHandlers(sm){
    sm.register(States.MUSIC_QUEUE_INPUT,{onCleanup:ctx=>temporary.remove(ctx.context?.temporaryToken),onMessage:async(ctx,message)=>{
      const record=sm.get(ctx.tgId);if(Number(record.chatId)!==Number(ctx.chatId)||record.context.botKey!==app.music.botKey(ctx))return false;
      if(!message.text||(Number(ctx.chatId)<0&&message.reply_to_message?.message_id!==record.context.promptMessageId))return false;const mode=record.context.mode;await sm.reset(ctx.tgId);await search(ctx,message.text,mode);return true;
    }});
    // Recover persisted legacy login flows safely; never accept or forward their secrets.
    for(const state of [States.ASSISTANT_AUTH_PHONE,States.ASSISTANT_AUTH_CODE,States.ASSISTANT_AUTH_2FA])sm.register(state,{onMessage:async(ctx,message)=>{if(message.message_id)await ctx.api?.deleteMessage(ctx.chatId,message.message_id).catch(()=>{});await sm.reset(ctx.tgId);await ctx.api?.sendMessage(ctx.chatId,'Session setup now uses the protected local terminal. Never send login codes or passwords here.');return true;}});
  }
  return{id,renderHome,renderListen,renderOptions,renderPlayer,renderQueue,renderVolumePicker,renderSearch,renderLyrics,renderAccounts,renderSessionSetupNotice,renderAssistantSessionStatus,registerStateHandlers,handle,handleCommand,search,cleanup:()=>temporary.shutdown(),async open(ctx){return ctx.api.sendRichMessage(ctx.chatId,renderHome());}};
}
