import { RADIO_CATEGORIES } from '../../music/radio.js';
import { PANEL_ACTIONS } from '../../music/channelPanels.js';
import { TemporaryBotMessages } from '../../music/messages.js';
import { audioInput, audioFileId } from '../../music/preview.js';
import { currentLyricWindow } from '../../music/lyrics.js';
import { RichMessageBuilder, block, rt, richButton, encodeCallback, decodeCallback, NOOP_CALLBACK } from '../rich.js';
import { States } from '../../core/stateMachine.js';
import { durationText, MusicError } from '../../music/model.js';
const cut = (s,n=65) => [...String(s || '')].slice(0,n).join('');
const cb = (action,...args) => encodeCallback('music',action,...args);
const button = (text,action,...args) => richButton.callback(text,cb(action,...args));
const card = (title,subtitle) => new RichMessageBuilder().paragraph(rt.bold(title)).paragraph(rt.italic(subtitle));


export function createMusicScreen({ app }) {
  const id='music';
  const finish=b=>{const window=app.db?.getSetting?.('music.testWindow');if(window?.commit&&Number.isFinite(window.expiresAt)){const end=new Date(window.expiresAt).toLocaleTimeString('en-GB',{timeZone:'Africa/Lagos',hour:'2-digit',minute:'2-digit'});b.footer(rt.text(Date.now()<window.expiresAt?`Test build ${String(window.commit).slice(0,7)} · guarded until ${end} Lagos time · not finalized`:'This guarded test window has ended. Open the current /player; do not reuse this selection.'));}b.validate();return b.toJSON();};
  const temporary = new TemporaryBotMessages();
  function controls(s,label,action,...args){
    if(s.panelToken){if(['remove','playnow'].includes(action))args[0]=String(args[0]).replaceAll('-','').slice(0,12);return button(label,'pc',s.panelToken,PANEL_ACTIONS.indexOf(action).toString(36),...args,Number(s.controlRevision||0).toString(36));}
    return button(label,action,...args,s.controlRevision||0);
  }
  function renderHome(){
    const b=card('Lancy · music','Find your track. Set the mood.');
    b.quote(rt.text('/play — listen here or download\n/addq — search and queue audio\n/vplay — queue genuine video + audio\n/player — your live dashboard'));
    b.buttons([button('Voice chat','prompt','queue'),button('Listen / download','prompt','download')]);
    b.buttons([button('Video / vidc','prompt','video'),button('Open player','openplayer')]);
    b.buttons([button('Channel Play','channels'),button('Random / Infinite','openradio')]);
    b.paragraph(rt.text('Search “title artist”, or prefix audius: / youtube:. Availability depends on source permissions.'));
    b.paragraph(rt.text('/playlist list · /playlist save <name> · /playlist load <name>'));
    return finish(b);
  }
  function trackAudio(b, track, media, vc = false) {
    b.audio(audioInput(track, media), vc ? 'Full track · listen here, independently of the voice chat' : 'Full track · listen in Telegram or save from the audio menu');
  }
  function recording(b,track,{media=null,lyrics=null,vc=false,positionSeconds=null}={}){
    if(media)trackAudio(b,track,media,vc);
    if(track.artwork){try{const u=new URL(track.artwork);if(u.protocol==='https:'&&!u.username&&!u.password&&u.hostname.includes('.')&&!/^(?:127\.|10\.|192\.168\.|169\.254\.)/.test(u.hostname))b.photo(u.href,'Recording artwork');}catch{}}
    b.quote(rt.concat(rt.bold(cut(track.title,160)),rt.text(`\n${cut(track.artist||'Artist not supplied',100)}${track.album?` · ${cut(track.album,60)}`:''}`)));
    b.table([['Artist',track.artist||'Not supplied'],['Album',track.album||'Not supplied'],['Length',durationText(track.durationSeconds)],['Source',track.provider],['Format',track.mediaType==='video'?'Video + audio':'Full audio']],{compact:true});
    const karaoke=vc&&lyrics?.syncedLyrics&&Number.isFinite(positionSeconds)?currentLyricWindow(lyrics.syncedLyrics,positionSeconds):null;
    const baseText=lyrics?.found?(lyrics.instrumental?'Instrumental recording.':cut(lyrics.text,process.env.MUSIC_LYRICS_FULL_TEXT==='true'?1800:200)):(lyrics?.reason||'No reliable matched lyrics yet. Use Lyrics for a fresh check.');
    const text=karaoke?`🎤 Live Karaoke:\n${karaoke}\n\n${baseText}`:baseText;
    b.expandableBlockquote(`Lyrics · ${cut(track.title,70)}\n\n${text}`);
    if(lyrics?.found&&!lyrics.instrumental)b.paragraph(rt.italic(process.env.MUSIC_LYRICS_FULL_TEXT==='true'?'Matched lyrics · open Lyrics for remaining pages.':'Matched lyrics excerpt · extended display needs the operator’s display-rights setting.'));
  }
  function renderListen(track, media, {cardToken=null,lyrics=null}={}) {
    const b=card('Lancy · listen & download','Your full recording. No voice chat needed.');
    recording(b,track,{media,lyrics});
    if(cardToken)b.buttons([button('Add to VC queue','listenq',cardToken)]);
    b.buttons([button('Find another song','prompt','download'),button('Search for VC','prompt','queue')]);
    b.paragraph(rt.italic('Tap the audio to listen; use its menu to save the file. Adding to VC requires verified destination-administrator rights.'));
    return finish(b);
  }
  function renderPlayer(s){
    const b=card(s.isChannel?'Lancy · CHANNEL LIVE BROADCAST':'Lancy · music',`${s.isChannel?'Channel broadcast':'Voice chat'} · ${s.destinationTitle || (s.isChannel?'Channel':'Group')} · ${s.status}`);
    if(s.status==='stopped'){b.quote(rt.text('Playback service stopped. Open the current player after restart.'));if(s.lastError)b.paragraph(rt.text(s.lastError));b.buttons([s.panelToken?controls(s,'Open current player','player'):button('Open current player','openplayer')]);return finish(b);}
    const t=s.currentTrack;
    if(!t){ b.quote(rt.text(s.status==='error'&&s.upcoming?.length?'Playback could not start. Your queued recording is retained; use Retry queued track.':s.connected?'Queue complete. After ten uninterrupted idle minutes the assistant leaves the call and, for groups, the group.':'No active playback. Use Add tracks for VC, or Listen / download without joining a call.')); }
    else {
      const preview=s.fullPreview?.trackId===t.id?s.fullPreview:null;
      if(preview?.status==='ready'&&preview.fileId)trackAudio(b,preview.track||t,preview.fileId,true);
      else if(preview?.status==='pending')b.paragraph(rt.italic('Preparing the full-song audio player… VC playback continues independently.'));
      else if(preview?.status==='unavailable')b.paragraph(rt.italic(cut(preview.reason,240)));
      recording(b,t,{lyrics:s.cardLyrics&&s.cardLyrics.trackId===t.id?s.cardLyrics.result:null,vc:true,positionSeconds:s.positionSeconds});
      const eqLabel=s.eqPreset&&s.eqPreset!=='off'?` · EQ ${s.eqPreset}`:(s.bass?' · EQ bass':'');
      b.paragraph(rt.text(`VC · ${durationText(s.positionSeconds)} / ${durationText(t.durationSeconds)} · ${t.mediaType==='video'?'Video + audio':'Audio'}${eqLabel}`));
      if(Number.isFinite(s.positionSeconds)&&t.durationSeconds){const n=Math.max(0,Math.min(10,Math.floor(s.positionSeconds/t.durationSeconds*10)));b.paragraph(rt.text('━'.repeat(n)+'─'.repeat(10-n)));}
      b.paragraph(rt.text(`VC volume ${s.volumeConfirmed===false?'unconfirmed':`${s.volume}%`} · Repeat ${s.loopMode} · ${s.upcoming?.length||0} queued`));
      if(s.upcoming?.[0])b.paragraph(rt.text(`Up next · ${cut(s.upcoming[0].title)}`));
      if(['playing','paused'].includes(s.status))b.buttons([controls(s,'Previous','previous'),controls(s,s.status==='paused'?'Resume VC':'Pause VC',s.status==='paused'?'resume':'pause'),controls(s,'Skip','skip'),controls(s,s.skipVotes?.length?`Vote skip (${s.skipVotes.length})`:'Vote skip','voteskip')]);
      if(t.capabilities?.seek&&Number.isFinite(s.positionSeconds))b.buttons([controls(s,'−10 sec','seekby',-10),controls(s,'+10 sec','seekby',10)]);
    }
    if(!t&&s.upcoming?.length&&s.status==='error')b.buttons([controls(s,'Retry queued track','retry')]);
    if(s.radio?.enabled)b.paragraph(rt.text(`Infinite radio · ${s.radio.queries.join(' + ')}`));
    if(s.radio?.notice)b.paragraph(rt.text(cut(s.radio.notice,220)));
    if(s.panelNotice)b.paragraph(rt.text(cut(s.panelNotice,240)));
    if(s.lastNotice)b.paragraph(rt.text(cut(s.lastNotice,350)));
    if(s.lastError)b.paragraph(rt.text(cut(s.lastError,350)));
    b.buttons([controls(s,`Queue · ${s.upcoming?.length||0}`,'queue'),controls(s,'Lyrics','lyrics'),controls(s,'VC volume','volume')]);
    b.buttons([s.panelToken?controls(s,s.isChannel?'Add music / video':'Add tracks','prompt',s.isChannel?'video':'queue'):button(s.isChannel?'Add music / video':'Add tracks','prompt',s.isChannel?'video':'queue'),s.panelToken?controls(s,'Listen / download','prompt','download'):button('Listen / download','prompt','download'),controls(s,'More','options')]);
    b.buttons([s.panelToken?controls(s,'🎬 Video / vidc','prompt','video'):button('🎬 Video / vidc','prompt','video'),controls(s,'♾️ Infinite & Genres','catmenu',s.isChannel?'video':'queue')]);
    if(s.panelToken)b.buttons([controls(s,'My channels','channels')]);
    if(s.panelToken)b.paragraph(rt.italic('Reply here with a song title + artist, then Select → Add selected for this channel. /play stays listen/download only.'));
    return finish(b);
  }
  function renderOptions(s){
    const eq=s.eqPreset||(s.bass?'bass':'off');
    const b=card('Lancy · voice-chat settings','Changes stay in this dashboard');
    b.paragraph(rt.text(`Account · ${s.accountAlias||s.preferredAccount||'Not connected'}\nRepeat · ${s.loopMode}\nGentle bass · ${s.bass?'on':'off'}\nAudio EQ · ${eq}`));
    b.buttons([controls(s,`Repeat · ${s.loopMode}`,'loop'),controls(s,'Shuffle','shuffle')]);
    b.buttons([controls(s,s.bass?'Bass · on':'Bass · off','bass'),controls(s,`EQ · ${eq}`,'eq'),controls(s,'Accounts','accounts')]);
    b.buttons([controls(s,'Pin player','pin'),controls(s,'Retry full preview','preview')]);
    b.buttons([controls(s,s.isChannel?'Stop & leave call':'Stop & leave group','stop')]);
    b.buttons([controls(s,'Back to player','player')]);
    b.paragraph(rt.italic('VC settings do not control the audio player above. Bass & EQ changes apply to the next track or seek. /seek <seconds> · /volume <0–150> · /dj'));
    return finish(b);
  }
  function renderQueue(s,page=0){
    const total=Math.max(1,Math.ceil(s.upcoming.length/5));page=Math.max(0,Math.min(Number(page)||0,total-1));
    const b=card('Lancy · queue',`Page ${page+1} of ${total} · ${s.upcoming.length} upcoming`);
    if(s.currentTrack)b.quote(rt.text(`Now · ${cut(s.currentTrack.title)} · ${durationText(s.currentTrack.durationSeconds)}`));
    const entries=s.upcoming.slice(page*5,page*5+5);
    if(!entries.length)b.paragraph(rt.text('Nothing queued. Add tracks with /addq.'));
    entries.forEach((t,i)=>{b.paragraph(rt.text(`${page*5+i+1}. ${cut(t.title)}\n${cut(t.artist||'Artist not supplied',40)} · ${durationText(t.durationSeconds)}`));b.buttons([controls(s,`Play now ${page*5+i+1}`,'playnow',t.entryId),controls(s,`Remove ${page*5+i+1}`,'remove',t.entryId)]);});
    const row=[];if(page>0)row.push(controls(s,'Previous page','qpage',page-1));if(page<total-1)row.push(controls(s,'Next page','qpage',page+1));if(row.length)b.buttons(row);
    b.buttons([controls(s,'Back to player','player'),controls(s,'Clear upcoming','clear')]);return finish(b);
  }
  function renderRadio(s){
    const page=Math.max(0,Math.min(Math.ceil(RADIO_CATEGORIES.length/8)-1,s.radioPage||0)),selected=s.radioSelected||[];
    const b=card('Lancy · Random / Infinite',`Choose up to five categories/custom searches · page ${page+1}/${Math.ceil(RADIO_CATEGORIES.length/8)}`);
    if(selected.length||s.radioCustom)b.quote(rt.text([...selected.map(i=>RADIO_CATEGORIES[i]),s.radioCustom].filter(Boolean).join(' + ')));
    b.list(Array.from({length:Math.min(8,RADIO_CATEGORIES.length-page*8)},(_,offset)=>{
      const n=page*8+offset,checked=selected.includes(n);
      return{has_checkbox:true,...(checked?{is_checked:true}:{}),blocks:[block.paragraph(rt.text(RADIO_CATEGORIES[n])),block.buttons([{...controls(s,checked?'Deselect':'Select','rpick',n),style:checked?'success':'primary'}])]};
    }));
    b.paragraph(rt.italic('Use Select / Deselect to change a native checkbox. Selections stay selected across pages.'));
    const row=[];if(page)row.push(controls(s,'Previous categories','rpage',page-1));if((page+1)*8<RADIO_CATEGORIES.length)row.push(controls(s,'More categories','rpage',page+1));if(row.length)b.buttons(row);
    b.buttons([controls(s,'🔥 1-Tap Genres & Submenus','catmenu'),s.panelToken?controls(s,'Custom artist / search','prompt','radio'):button('Custom artist / search','prompt','radio')]);
    b.buttons([controls(s,'Start infinite radio','rstart'),controls(s,'Turn autoplay off','roff')]);
    b.buttons([controls(s,'Back to player','player')]);b.paragraph(rt.italic('Bounded rolling queue, no repeats within the recent window. Provider exhaustion or rate limits pause radio instead of looping requests.'));
    return finish(b);
  }
  function renderChannels(ctx,state){
    const list=app.music.channels.list(ctx);state.items=list.slice();const pages=Math.max(1,Math.ceil(list.length/5));state.page=Math.max(0,Math.min(state.page,pages-1));
    const b=card('Lancy · Channel Play',`${state.queueCardToken?'Choose where to queue your full recording':'Your verified saved channels'} · page ${state.page+1}/${pages}`);
    if(!list.length)b.quote(rt.text('No saved channels yet. Add Lancy as a channel administrator, then add its link/ID or forward an original channel post.'));
    for(let i=state.page*5;i<Math.min(list.length,state.page*5+5);i++)b.buttons([button(cut(list[i].title,55),'ch',state.id,state.revision,'select',i),button('Remove','ch',state.id,state.revision,'delete',i)]);
    const row=[];if(state.page)row.push(button('Previous','ch',state.id,state.revision,'page',state.page-1));if(state.page+1<pages)row.push(button('Next','ch',state.id,state.revision,'page',state.page+1));if(row.length)b.buttons(row);
    b.buttons([button('Add channel','ch',state.id,state.revision,'add')]);b.paragraph(rt.italic('Membership and administrator rights are checked again when you use a saved channel. Assistant setup only starts when you request playback/search.'));
    return finish(b);
  }
  async function channels(ctx,queueCardToken=null){
    const state=app.music.channels.create(ctx);state.queueCardToken=queueCardToken;const rich=renderChannels(ctx,state);
    if(ctx.messageId&&ctx.query){await ctx.api.editMessageRich(ctx.chatId,ctx.messageId,rich);state.messageId=ctx.messageId;}
    else state.messageId=(await ctx.api.sendRichMessage(ctx.chatId,rich)).message_id;
    return state;
  }
  const QUICK_GENRES = ['Afrobeats', 'Amapiano', 'Hip hop', 'Trap', 'R&B', 'Pop', 'Lo-fi', 'Drill', 'Gospel', 'Party'];
  function resolveGenre(ref, s=null){
    if(ref==='custom')return s?.radioCustom || 'Afrobeats';
    if(typeof ref==='number'||/^\d+$/.test(ref)){
      const idx=Number(ref);
      if(QUICK_GENRES[idx])return QUICK_GENRES[idx];
      if(RADIO_CATEGORIES[idx])return RADIO_CATEGORIES[idx];
    }
    return String(ref||'Afrobeats').trim().slice(0,100);
  }
  function renderGenreSubmenu(genre, mode='queue', panelToken=null){
    const cleanGenre=resolveGenre(genre);
    const b=card(`Lancy · ${cut(cleanGenre,50)}`,`Infinite non-stop streaming or queueing`);
    b.quote(rt.text(`🎵 ${cleanGenre}\nChoose whether to stream non-stop now or add to upcoming queue:`));
    if(panelToken){
      b.buttons([
        button(`▶ Start Non-stop ${cut(cleanGenre,12)}`,'pc',panelToken,PANEL_ACTIONS.indexOf('infinact').toString(36),mode,'start',cut(cleanGenre,24)),
        button(`➕ Queue ${cut(cleanGenre,12)}`,'pc',panelToken,PANEL_ACTIONS.indexOf('infinact').toString(36),mode,'queue',cut(cleanGenre,24))
      ]);
      b.buttons([
        button('🔍 Browse Songs','pc',panelToken,PANEL_ACTIONS.indexOf('catpick').toString(36),mode,cut(cleanGenre,24)),
        button('🎨 Custom Artist','pc',panelToken,PANEL_ACTIONS.indexOf('prompt').toString(36),'radio')
      ]);
      b.buttons([
        button('« All Genres','pc',panelToken,PANEL_ACTIONS.indexOf('catmenu').toString(36),mode),
        button('Back to player','pc',panelToken,PANEL_ACTIONS.indexOf('player').toString(36))
      ]);
    }else{
      b.buttons([
        button(`▶ Start Non-stop ${cut(cleanGenre,12)}`,'infinact',mode,'start',cut(cleanGenre,24)),
        button(`➕ Queue ${cut(cleanGenre,12)}`,'infinact',mode,'queue',cut(cleanGenre,24))
      ]);
      b.buttons([
        button('🔍 Browse Songs','catpick',mode,cut(cleanGenre,24)),
        button('🎨 Custom Artist','prompt','radio')
      ]);
      b.buttons([
        button('« All Genres','catmenu',mode),
        button('Back to player','openplayer')
      ]);
    }
    b.paragraph(rt.italic('▶ Start Non-stop plays immediately with continuous refill. ➕ Queue adds tracks behind your current song.'));
    return finish(b);
  }
  function renderCategoryPicker(mode='queue', panelToken=null, page=0){
    const totalPages=Math.ceil(RADIO_CATEGORIES.length/10),safePage=Math.max(0,Math.min(Number(page)||0,totalPages-1));
    const b=card('Lancy · Categories & Non-stop',mode==='video'?'Choose a genre for genuine video + audio streams':'Tap any genre for non-stop infinite play, queueing or search');
    b.quote(rt.text('🔥 Fast 1-Tap Genres — tap to start non-stop, queue, or search:'));
    const list=safePage===0?QUICK_GENRES:RADIO_CATEGORIES.slice(safePage*10,safePage*10+10);
    for(let i=0;i<list.length;i+=2){
      const g1=list[i],g2=list[i+1];
      const row=[];
      if(panelToken){
        row.push(button(g1,'pc',panelToken,PANEL_ACTIONS.indexOf('genresub').toString(36),mode,cut(g1,24)));
        if(g2)row.push(button(g2,'pc',panelToken,PANEL_ACTIONS.indexOf('genresub').toString(36),mode,cut(g2,24)));
      }else{
        row.push(button(g1,'genresub',mode,cut(g1,24)));
        if(g2)row.push(button(g2,'genresub',mode,cut(g2,24)));
      }
      b.buttons(row);
    }
    const navRow=[];
    if(safePage>0){
      navRow.push(panelToken?button('◀ Previous','pc',panelToken,PANEL_ACTIONS.indexOf('catmenu').toString(36),mode,String(safePage-1)):button('◀ Previous','catmenu',mode,String(safePage-1)));
    }
    if(safePage+1<totalPages){
      navRow.push(panelToken?button(`More Genres (${safePage+1}/${totalPages}) ▶`,'pc',panelToken,PANEL_ACTIONS.indexOf('catmenu').toString(36),mode,String(safePage+1)):button(`More Genres (${safePage+1}/${totalPages}) ▶`,'catmenu',mode,String(safePage+1)));
    }
    if(navRow.length)b.buttons(navRow);
    b.buttons([
      panelToken?button('🎨 Custom Artist / Genre','pc',panelToken,PANEL_ACTIONS.indexOf('prompt').toString(36),'radio'):button('🎨 Custom Artist / Genre','prompt','radio'),
      panelToken?button('🔍 Search Specific Title','pc',panelToken,PANEL_ACTIONS.indexOf('prompt').toString(36),mode):button('🔍 Search Specific Title','prompt',mode)
    ]);
    b.buttons([
      panelToken?button('Back to player','pc',panelToken,PANEL_ACTIONS.indexOf('player').toString(36)):button('Back to player','openplayer')
    ]);
    b.paragraph(rt.italic('Non-stop categories play continuously with zero repetition. Works for both VC audio & video.'));
    return finish(b);
  }
  function renderVolumePicker(s){
    const b=card('Lancy · volume',`${s.volume}% · unity gain is 100%; boost up to 200%`);
    b.buttons([50,80,100].map(v=>controls(s,`${v}%`,'setvol',v)));
    b.buttons([125,150,200].map(v=>controls(s,`${v}%`,'setvol',v)));
    b.buttons([controls(s,'Back to player','player')]);
    return finish(b);
  }
  function renderSearch(s){
    const p=s.pages[s.index],b=card(s.mode==='lyrics'?'Lancy · lyrics':s.mode==='download'?'Lancy · download':'Lancy · select your tracks',`${cut(s.query,90)} · ${p.provider} · page ${s.index+1}${['download','lyrics'].includes(s.mode)?'':` · ${cut(s.destinationTitle||s.destination,55)}`}`);
    if(s.processing){b.quote(rt.text(s.mode==='download'?'Preparing your full recording…':s.mode==='lyrics'?'Finding matched lyrics…':'Preparing your selected tracks…'));b.paragraph(rt.text('Checking access and resolving media. This can take a little while. There is no need to press again.'));if(['queue','video'].includes(s.mode))b.paragraph(rt.italic('Use /stop to cancel pending playback.'));return finish(b);}
    if(!p.items.length)b.paragraph(rt.text('No new results. Go back or search a different title and artist.'));
    p.items.forEach((t,i)=>{const selected=s.selected.has(t.id);
      b.list([{has_checkbox:true,...(selected?{is_checked:true}:{}),blocks:[block.paragraph(rt.bold(cut(t.title,100))),block.paragraph(rt.text(`${cut(t.artist||'Artist not supplied',65)} · ${durationText(t.durationSeconds)} · ${t.provider}`))]}]);
      b.buttons([{...button(selected?'Deselect':'Select','pick',s.id,s.revision,i),style:selected?'success':'primary'}]);
    });
    const row=[];if(s.index>0)row.push(button('Previous','spage',s.id,s.revision,s.index-1));if(p.nextOffset!=null)row.push(button('Next','spage',s.id,s.revision,s.index+1));if(row.length)b.buttons(row);
    b.buttons([button(s.mode==='lyrics'?'Show matched lyrics':s.mode==='download'?`Download selected · ${s.selected.size}`:`Add selected · ${s.selected.size}`,'submit',s.id,s.revision),button('Clear','sclear',s.id,s.revision)]);
    b.paragraph(rt.italic('Use Select / Deselect to change a native checkbox. Selected tracks stay selected across pages. Source permissions are checked before playback/download.'));
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
  async function error(ctx,e){if(e.code==='REQUEST_PROCESSING'){if(ctx.query?.id&&ctx.api.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:e.message}).catch(()=>{});return;}const msg=e instanceof MusicError?e.message:(e?.message||'The music operation could not finish. Check account health or try again later.');const sent=await ctx.api.sendMessage(ctx.chatId,msg);temporary.remember(ctx,sent,{ttlMs:300000});return sent;}
  async function search(ctx,query,mode='queue'){
    if(!query)return prompt(ctx,mode);
    const pending=await ctx.api.sendMessage(ctx.chatId,'Finding your tracks…');
    const temporaryToken=temporary.remember(ctx,pending);
    try{const s=await app.music.startSearch(ctx,query,mode);s.messageId=pending.message_id;s.temporaryToken=temporaryToken;await ctx.api.editMessageRich(ctx.chatId,s.messageId,renderSearch(s));return s;}
    catch(e){await ctx.api.editMessageText(ctx.chatId,pending.message_id,e instanceof MusicError?e.message:'Search failed. Try a different title and artist.');temporary.keep(temporaryToken);temporary.remember(ctx,pending,{ttlMs:60000});}
  }
  async function prompt(ctx,mode){
    if(['queue','video'].includes(mode)){app.music.destination?.(ctx);await app.music.authorize?.(ctx,true);await app.music.prepare?.(ctx);}
    if(mode==='radio')await app.music.authorize(ctx,true);
    if(app.sm.state(ctx.tgId)===States.MUSIC_QUEUE_INPUT)await app.sm.reset(ctx.tgId);
    const group=Number(ctx.chatId)<0, name=cut(ctx.user?.first_name||'Music request',40);
    const text=mode==='channel'?'Send a channel link, @name or negative ID, or forward an original channel post. Lancy and you must be channel administrators. /cancel closes setup.':mode==='radio'?'Send an artist name or style (e.g. Burna Boy, Drake, Wizkid, Trap sad songs) to stream or queue infinite non-stop music. /cancel closes this input.':`${group?`${name}, `:''}send a track title and artist${group?' as a reply to this message':''}. /cancel closes this search.`;
    const sent=await ctx.api.sendMessage(ctx.chatId,text,{reply_markup:{force_reply:true,selective:true},
      ...(group?{entities:[{type:'text_mention',offset:0,length:name.length,user:{id:Number(ctx.tgId),is_bot:false,first_name:name}}]}:{}),
      ...(ctx.message?.from?.id===Number(ctx.tgId)?{reply_to_message_id:ctx.message.message_id}:{})});
    const temporaryToken=temporary.remember(ctx,sent,{ttlMs:120000});
    try{await app.sm.transition(ctx.tgId,States.MUSIC_QUEUE_INPUT,{chatId:ctx.chatId,timeoutMs:120000,context:{mode,botKey:app.music.botKey(ctx),promptMessageId:sent.message_id,temporaryToken,panelToken:ctx.musicPanel?.panelToken||null}});}catch(e){await temporary.remove(temporaryToken);throw e;}
    return sent;
  }
  async function showAccounts(ctx){
    const id=await app.music.authorize(ctx,false);await app.music.accounts.sync();const pool=await app.voiceClient.accounts(id);const s=app.musicQueueManager.getSession(id);
    const b=card('Lancy · player accounts','Only owner-approved aliases for this destination');
    for(const a of pool.accounts){b.paragraph(rt.text(`${a.alias} · ${a.status}`));if(a.status==='available')b.buttons([controls(s,`Use ${a.alias}`,'selectaccount',a.alias)]);}
    if(!pool.accounts.length)b.paragraph(rt.text('No accounts approved. Ask the owner to use /accounts allow.'));
    b.buttons([controls(s,'Back to player','player')]);await ctx.api.editMessageRich(ctx.chatId,ctx.messageId,finish(b));
  }
  async function handleInfiniteAction(ctx,args,panelToken=null){
    const [mode='queue',op='start',genreRef='0']=args;
    const panel=panelToken?await app.music.channelPanels.resolve(ctx,panelToken,{requireMessage:false}):ctx.musicPanel;
    const targetCtx=panel?{...ctx,musicPanel:panel}:ctx;
    const destination=app.music.destination(targetCtx);
    const s=panel||app.musicQueueManager.getSession(destination);
    const genre=resolveGenre(genreRef,s);
    const isVideo=mode==='video'||Boolean(s.isChannel);
    const procMsg=card(`Lancy · ${cut(genre,40)}`,op==='start'?'Starting non-stop playback…':'Adding to queue…');
    procMsg.quote(rt.text(op==='start'
      ?`⏳ Starting non-stop ${genre} streaming…\nConnecting assistant to voice chat and resolving tracks…`
      :`⏳ Adding ${genre} tracks to upcoming queue…\nResolving media sources…`));
    procMsg.buttons([button('⏳ Processing…','noop')]);
    if(ctx.messageId&&ctx.query)await ctx.api.editMessageRich(ctx.chatId,ctx.messageId,finish(procMsg)).catch(()=>{});
    else if(ctx.messageId)await ctx.api.editMessageRich(ctx.chatId,ctx.messageId,finish(procMsg)).catch(()=>{});
    s.lastNotice=op==='start'?`⏳ Starting non-stop ${genre} streaming…`:`⏳ Adding ${genre} to queue…`;
    if(s.screenMessageId&&!panelToken)void app.musicQueueManager.updatePlayerCard(destination).catch(()=>{});
    if(op==='start'){
      if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:`♾️ Streaming non-stop ${cut(genre,25)}…`}).catch(()=>{});
      const generation=app.music.queueGeneration(destination);
      await app.music.authorize(targetCtx,true,destination,{allowDj:true});
      if(typeof app.voiceClient?.setup==='function')await app.music.prepare(targetCtx,destination);
      app.music.assertQueueGeneration(destination,generation);
      if(isVideo) app.musicQueueManager.getSession(destination).radioVideo=true;
      app.music.radio.configure(app.musicQueueManager.getSession(destination),[genre],{video:isVideo});
      await app.music.radio.refill(app.musicQueueManager.getSession(destination));
      await app.musicQueueManager.ensurePlaying(destination);
      s.view='player';
      if(panelToken)await app.music.channelPanels.update(destination,{panelToken});
      else if(!s.screenMessageId&&Number(ctx.chatId)<0)await app.music.player(targetCtx,destination);
      else {
        await app.musicQueueManager.updatePlayerCard(destination);
        if(ctx.messageId&&ctx.messageId!==s.screenMessageId){
          const doneCard=renderPlayer(s);
          await ctx.api.editMessageRich(ctx.chatId,ctx.messageId,doneCard).catch(()=>{});
        }
      }
    }else if(op==='queue'){
      if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:`➕ Queued ${cut(genre,25)} tracks!`}).catch(()=>{});
      const generation=app.music.queueGeneration(destination);
      await app.music.authorize(targetCtx,true,destination,{allowDj:true});
      if(typeof app.voiceClient?.setup==='function')await app.music.prepare(targetCtx,destination);
      app.music.assertQueueGeneration(destination,generation);
      if(isVideo) app.musicQueueManager.getSession(destination).radioVideo=true;
      app.music.radio.configure(app.musicQueueManager.getSession(destination),[genre],{video:isVideo});
      let searchRes=null;
      try{searchRes=await app.musicProviders.search(genre,{limit:3,video:isVideo});}catch{searchRes=null;}
      const tracks=(searchRes?.items||[]).slice(0,3).map(t=>({...t,mediaType:isVideo?'video':'audio',requester:ctx.user?.username||ctx.user?.first_name||'Member'}));
      if(tracks.length){
        await app.musicQueueManager.addMany(destination,tracks);
      }else{
        await app.music.radio.refill(app.musicQueueManager.getSession(destination));
      }
      if(!['playing','paused','buffering'].includes(s.status)){
        await app.musicQueueManager.ensurePlaying(destination);
      }
      s.view='player';
      if(panelToken)await app.music.channelPanels.update(destination,{panelToken});
      else if(!s.screenMessageId&&Number(ctx.chatId)<0)await app.music.player(targetCtx,destination);
      else {
        await app.musicQueueManager.updatePlayerCard(destination);
        if(ctx.messageId&&ctx.messageId!==s.screenMessageId){
          const doneMsg=card(`Lancy · ${cut(genre,40)}`,'Added to upcoming queue');
          doneMsg.quote(rt.text(`✅ Added ${tracks.length||'new'} ${genre} tracks to the queue!\nUse /q or /player to view upcoming songs.`));
          doneMsg.buttons([button('Open player','openplayer'),button('« All Genres','catmenu',mode)]);
          await ctx.api.editMessageRich(ctx.chatId,ctx.messageId,finish(doneMsg)).catch(()=>{});
        }
      }
    }
  }
  async function handle(ctx,action,args=[]){
    try{
      if(action==='channels')return await channels(ctx);
      if(action==='ch')return await app.music.channels.lock.run(args[0],async()=>{
        const [token,revision,operation,index]=args,state=app.music.channels.resolve(ctx,token,revision);
        if(operation==='add')return prompt(ctx,'channel');
        const selected=state.items?.[Number(index)];
        if(operation==='delete'){if(!selected)throw new MusicError('CHANNEL_MENU_EXPIRED','That channel is unavailable.');await app.music.channels.remove(ctx,selected.id);}
        else if(operation==='page')state.page=Math.max(0,Number(index)||0);
        else if(operation!=='select')throw new MusicError('CHANNEL_MENU_EXPIRED','Open Channel Play again.');
        state.revision++;await ctx.api.editMessageRich(ctx.chatId,ctx.messageId,renderChannels(ctx,state));
        if(operation==='select'){
          if(!selected)throw new MusicError('CHANNEL_MENU_EXPIRED','That channel is unavailable.');
          if(state.queueCardToken){const token=state.queueCardToken;await app.music.queueListen(ctx,token,{destination:selected.id,fromCatalog:true});state.queueCardToken=null;}
          else{await app.music.bind(ctx,String(selected.id));await app.music.player({...ctx,forceNew:true},selected.id);}
        }
      });
      if(action==='listenq'){const c=app.music.listenCard(ctx,args[0]);if(!c.destination)return channels(ctx,c.token);return await app.music.queueListen(ctx,c.token);}
      if(action==='catmenu'){const [mode='queue',page=0]=args;const rich=renderCategoryPicker(mode,null,Number(page)||0);if(ctx.query&&ctx.messageId)await ctx.api.editMessageRich(ctx.chatId,ctx.messageId,rich);else await ctx.api.sendRichMessage(ctx.chatId,rich);return;}
      if(action==='genresub'){const [mode='queue',genreRef]=args;const genre=resolveGenre(genreRef);const rich=renderGenreSubmenu(genre,mode,null);if(ctx.query&&ctx.messageId)await ctx.api.editMessageRich(ctx.chatId,ctx.messageId,rich);else await ctx.api.sendRichMessage(ctx.chatId,rich);return;}
      if(action==='catpick'){const [mode='queue',genreRef]=args;const genre=resolveGenre(genreRef);if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:`Loading ${genre}…`}).catch(()=>{});return await search(ctx,genre,mode);}
      if(action==='infinact')return await handleInfiniteAction(ctx,args,null);
      if(action==='openradio'){const state=await app.music.player(ctx);return await app.music.control({...ctx,query:null,messageId:null,musicPanel:state.panelToken?state:undefined},'radio',[]);}
      if(action==='pc'){
        const [token,wire,...controlArgs]=args;
        const command=PANEL_ACTIONS[parseInt(wire,36)];
        if(!command)throw new MusicError('STALE_PLAYER','Open your current channel dashboard.');
        const panel=await app.music.channelPanels.resolve(ctx,token);
        if(command==='channels')return await channels(ctx);
        if(command==='prompt')return await prompt({...ctx,musicPanel:panel},controlArgs[0]||'queue');
        if(command==='catmenu'){
          const [mode=panel?.isChannel?'video':'queue',page=0]=controlArgs;
          const rich=renderCategoryPicker(mode,token,Number(page)||0);
          if(ctx.query&&ctx.messageId)await ctx.api.editMessageRich(ctx.chatId,ctx.messageId,rich);
          else await ctx.api.sendRichMessage(ctx.chatId,rich);
          return;
        }
        if(command==='genresub'){
          const [mode='queue',genreRef]=controlArgs;
          const genre=resolveGenre(genreRef,panel);
          const rich=renderGenreSubmenu(genre,mode,token);
          if(ctx.query&&ctx.messageId)await ctx.api.editMessageRich(ctx.chatId,ctx.messageId,rich);
          else await ctx.api.sendRichMessage(ctx.chatId,rich);
          return;
        }
        if(command==='catpick'){
          const [mode='queue',genreRef]=controlArgs;
          const genre=resolveGenre(genreRef,panel);
          if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:`Loading ${genre}…`}).catch(()=>{});
          return await search({...ctx,musicPanel:panel},genre,mode);
        }
        if(command==='infinact'){
          return await handleInfiniteAction({...ctx,musicPanel:panel},controlArgs,token);
        }
        return await app.music.control({...ctx,musicPanel:panel},command,controlArgs);
      }
      if(action==='prompt')return await prompt(ctx,args[0]||'queue');
      if(action==='openplayer'){if(ctx.query?.id&&ctx.api?.answerCallbackQuery)await ctx.api.answerCallbackQuery(ctx.query.id,{text:'Opening player…'}).catch(()=>{});return await app.music.player({...ctx,forceNew:true});}
      if(['pick','spage','sclear','submit'].includes(action)){
        const [token,revision,index]=args;
        let state;
        await app.music.search.action(token,revision,ctx,async s=>{state=s;if(action==='spage')await app.music.search.page(s,Number(index));
          if(action==='pick'){const t=s.pages[s.index].items[Number(index)];if(!t)throw new MusicError('INVALID_SELECTION','That track is unavailable.');if(s.selected.has(t.id))s.selected.delete(t.id);else{if(['download','lyrics'].includes(s.mode))s.selected.clear();if(s.selected.size>=20)throw new MusicError('SELECTION_LIMIT','Select up to 20 tracks per batch.');s.selected.set(t.id,t);}}
          if(action==='sclear')s.selected.clear();
          if(action==='submit'){
            temporary.hold(s.temporaryToken);s.processing={kind:'submit',startedAt:Date.now()};s.expires=Date.now()+(app.music.search.ttlMs||600000);
            try{await ctx.api.editMessageRich(ctx.chatId,ctx.messageId,renderSearch(s));await app.music.submit(ctx,s);}
            finally{
              s.processing=null;if(!s.consumed){s.expires=Date.now()+(app.music.search.ttlMs||600000);await ctx.api.editMessageRich(ctx.chatId,ctx.messageId,renderSearch(s)).catch(()=>{});}
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
    const commands=['/play','/song','/music','/addq','/vplay','/stream','/vc','/vidc','/random','/vcplay','/player','/pause','/resume','/skip','/voteskip','/next','/previous','/stop','/end','/leave','/queue','/q','/volume','/vol','/loop','/repeat','/shuffle','/seek','/eq','/dj','/accounts','/destination','/channel','/session','/gensession','/authassistant','/linkassistant','/playlist','/lyrics'];
    if(!commands.includes(command))return false;
    try{
      if(command==='/dj'){const msg=await app.music.djCommand(ctx,args);await ctx.api.sendMessage(ctx.chatId,msg);return true;}
      if(['/play','/song'].includes(command)&&!args.length&&ctx.controller?.handleAudioRecognition&&[ctx.replyTo?.audio,ctx.replyTo?.voice,ctx.replyTo?.video,ctx.replyTo?.video_note].some(Boolean)){await ctx.controller.handleAudioRecognition(ctx,ctx.replyTo);return true;}
      if(command==='/lyrics'){
        if(args.length){if(app.screens?.get('downloader')?.executeLyricsSearch){await app.screens.get('downloader').executeLyricsSearch(ctx,args.join(' '),{forceNew:true});return true;}await search(ctx,args.join(' '),'lyrics');}
        else {let current=null;try{current=app.musicQueueManager.getSession(app.music.destination(ctx)).currentTrack;}catch{}if(current)await app.music.control(ctx,'lyrics',[]);else await search(ctx,'','lyrics');}
      }
      else if(command==='/stream'){if(ctx.replyTo)await app.music.streamReply(ctx,ctx.replyTo);else if(args.length)await search(ctx,args.join(' '),'queue');else throw new MusicError('REPLY_MEDIA','Reply /stream to a song, voice message or video to add it to the VC queue.');}
      else if(command==='/vc'||command==='/vidc'){if(ctx.replyTo&&[ctx.replyTo.audio,ctx.replyTo.voice,ctx.replyTo.video,ctx.replyTo.video_note,ctx.replyTo.document,audioFileId(ctx.replyTo)].some(Boolean))await app.music.streamReply(ctx,ctx.replyTo,{video:command==='/vidc'});else if(args.length||command==='/vidc'){let isChan=false;try{isChan=app.musicQueueManager?.getSession?.(app.music.destination(ctx))?.isChannel;}catch{}await search(ctx,args.join(' '),command==='/vidc'||isChan?'video':'queue');}else{await app.music.prepare(ctx);await app.music.player(ctx);}}
      else if(command==='/random'){const dest=await app.music.authorize(ctx,true);if(args.length){await app.music.prepare(ctx,dest);app.music.radio.configure(app.musicQueueManager.getSession(dest),[args.join(' ')]);await app.music.radio.refill(app.musicQueueManager.getSession(dest));await app.musicQueueManager.ensurePlaying(dest);await app.music.player(ctx,dest);}else{const state=await app.music.player(ctx,dest);await app.music.control({...ctx,query:null,messageId:null,musicPanel:state.panelToken?state:undefined},'radio',[]);}}
      else if(['/play','/song','/addq','/vplay','/vcplay'].includes(command)){
        await app.sm?.reset(ctx.tgId);
        if(['/play','/song'].includes(command)&&args.length&&app.screens?.get('downloader')?.executeDownload){
          await app.screens.get('downloader').executeDownload(ctx,args.join(' '),{forceMusicSearch:true,forceNew:true});
          return true;
        }
        const isVideoCmd=['/vplay','/vcplay'].includes(command);
        if(!args.length&&isVideoCmd){
          const rich=renderCategoryPicker('video');
          await ctx.api.sendRichMessage(ctx.chatId,rich);
          return true;
        }
        let isChan=false;try{isChan=app.musicQueueManager?.getSession?.(app.music.destination(ctx))?.isChannel;}catch{}
        await search(ctx,args.join(' '),['/play','/song'].includes(command)?'download':(isVideoCmd||isChan)?'video':'queue');
      }
      else if(command==='/music'){if(args.length){if(app.screens?.get('downloader')?.executeDownload){await app.screens.get('downloader').executeDownload(ctx,args.join(' '),{forceMusicSearch:true,forceNew:true});return true;}await search(ctx,args.join(' '),'download');}else await ctx.api.sendRichMessage(ctx.chatId,renderHome());}
      else if(command==='/accounts'){const accounts=await app.music.accountCommand(ctx,args);await ctx.api.sendMessage(ctx.chatId,accounts.map(a=>`${a.alias} · ${a.status} · ${a.activeCalls||0} active calls\nApproved: ${a.allowed.join(', ')||'none'}`).join('\n\n')||'No registered accounts. Generate one locally, then /accounts register <alias>.');}
      else if(['/session','/gensession','/authassistant','/linkassistant'].includes(command)){if(!app.music.owner(ctx)||Number(ctx.chatId)<0)throw new MusicError('OWNER_ONLY','Use /accounts in the main owner private chat.');await ctx.api.sendRichMessage(ctx.chatId,renderSessionSetupNotice());}
      else if(command==='/destination'||command==='/channel'){
        const isChan=ctx.message?.chat?.type==='channel';
        if(isChan){
          await app.music.player(ctx,Number(ctx.chatId));
          return true;
        }
        if(Number(ctx.chatId)<0){
          if(args.length){
            const id=await app.music.bind(ctx,args[0]);
            await app.music.player(ctx,id);
          }else{
            await ctx.api.sendMessage(ctx.chatId,`<blockquote>🌸 To manage channels, open a private chat with @${ctx.api?.me?.username || 'the bot'} and send <code>/channel</code> ♡\nTo bind a channel here, use <code>/channel @channelname</code>.</blockquote>`,{parse_mode:'HTML'}).catch(()=>{});
          }
          return true;
        }
        if(args[0]==='close'){
          const id=app.music.destination(ctx);
          await app.music.channelPanels.close(ctx,id);
        }
        else if(!args.length&&!ctx.message?.forward_origin&&!ctx.message?.forward_from_chat)
          await channels(ctx);
        else{
          const id=await app.music.bind(ctx,args[0]);
          await app.music.player({...ctx,forceNew:true},id);
        }
        return true;
      }
      else if(command==='/playlist')await playlist(ctx,args);
      else{
        if(command==='/voteskip'){await app.music.control({...ctx,messageId:null,query:null},'voteskip',args);return true;}
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
    else if(action==='load'){const id=await app.music.authorize(ctx,true);if(!lists[name]?.length)throw new MusicError('PLAYLIST_MISSING','That playlist is missing or empty.');await app.music.accounts.sync();await app.music.prepare?.(ctx,id);await app.musicQueueManager.addMany(id,lists[name]);await app.music.player(ctx,id);}
    else throw new MusicError('PLAYLIST_ACTION','Use /playlist list, save, load or delete.');
    return ctx.api.sendMessage(ctx.chatId,`Playlist ${action} completed · ${name}`);
  }
  function musicText(ctx,value){
    const text=String(value||'').trim(),chatPrefix=app.db?.getChatPrefix?.(ctx.chatId)||'/',userPrefix=app.db?.getUserPrefix?.(ctx.tgId)||'/';
    const prefix=Number(ctx.chatId)<0?chatPrefix:userPrefix!=='/'?userPrefix:chatPrefix;
    if(prefix!=='/'&&text.startsWith(prefix))return '/'+text.slice(prefix.length).trim();
    if(prefix==='/'&&/^[!.]/.test(text))return '/'+text.slice(1).trim();
    return text;
  }
  async function handlePlayerReply(ctx,message){
    if(!message.text||message.reply_to_message?.from?.id!==ctx.api?.me?.id)return false;
    let source=ctx;
    if(Number(ctx.chatId)>0){
      const record=app.music.channelPanels.replyPanel(ctx,message);if(!record)return false;
      try{const panel=await app.music.channelPanels.resolve({...ctx,messageId:record.screenMessageId},record.panelToken);source={...ctx,musicPanel:panel};}catch(e){await error(ctx,e);return true;}
    }else{
      const session=app.musicQueueManager?.sessions?.get(Number(ctx.chatId));
      if(!session||session.screenMessageId!==message.reply_to_message.message_id)return false;
    }
    const text=musicText(ctx,message.text),[head,...rest]=text.split(/\s+/),command=head.split('@')[0].toLowerCase();
    if(head.startsWith('/')&&head.includes('@')&&head.split('@')[1].toLowerCase()!==ctx.api.me.username?.toLowerCase())return false;
    const destId = Number(ctx.chatId) < 0 ? Number(ctx.chatId) : source.musicPanel?.destination;
    const isChannel = Boolean(source.musicPanel?.isChannel || (destId && app.musicQueueManager?.sessions?.get(destId)?.isChannel));
    let mode=isChannel?'video':'queue',query=text;
    if(['/play','/song'].includes(command)||/^play\s+/i.test(text)){mode='download';query=command.startsWith('/')?rest.join(' '):text.replace(/^play\s+/i,'');if(app.screens?.has('downloader')&&query.trim()){await app.screens.get('downloader').executeDownload(ctx,query.trim(),{forceMusicSearch:true,forceNew:true});return true;}}
    else if(['/addq','/vplay','/vcplay','/stream','/vc','/vidc'].includes(command)){mode=(['/vplay','/vcplay','/vidc'].includes(command)||isChannel)?'video':'queue';query=rest.join(' ');}
    else if(/^(?:add(?:\s+(?:track|song))?|queue)\s+/i.test(text)){mode=isChannel?'video':'queue';query=text.replace(/^(?:add(?:\s+(?:track|song))?|queue)\s+/i,'');}
    else if(command.startsWith('/')){if(!channelCommands.has(command))return false;try{await app.music.authorize(source,true);return await handleCommand(source,command,rest);}catch(e){await error(ctx,e);return true;}}
    else if(isChannel){mode='video';}
    try{if(mode!=='download')await app.music.authorize(source,true);const pending=app.sm?.get(ctx.tgId);if(pending?.state===States.MUSIC_QUEUE_INPUT&&pending.context.botKey===app.music.botKey(ctx)&&Number(pending.chatId)===Number(ctx.chatId))await app.sm.reset(ctx.tgId);await search(source,query,mode);}
    catch(e){await error(ctx,e);}return true;
  }
  const channelCommands=new Set(['/vidc','/random','/channel','/destination','/player','/addq','/vplay','/vcplay','/vc','/stream','/pause','/resume','/skip','/voteskip','/next','/previous','/stop','/end','/leave','/queue','/q','/volume','/vol','/seek','/eq','/repeat','/loop','/shuffle','/playlist','/lyrics','/play','/song','/music','/cancel']);
  function privateChannelRequest(ctx,source){
    if(Number(ctx.chatId)<=0||Number(ctx.chatId)!==Number(ctx.tgId))return false;
    if(!source.data&&app.music.channelPanels?.replyPanel(ctx,source))return true;
    if(source.data){const d=decodeCallback(source.data);return d?.screen==='music'&&(['pc','channels','ch','listenq'].includes(d.action)||app.music.destinations?.has(`${app.music.botKey(ctx)}:${ctx.tgId}`));}
    const pending=app.sm?.get?.(ctx.tgId);if(pending?.state===States.MUSIC_QUEUE_INPUT&&pending.context.mode==='channel'&&pending.context.botKey===app.music.botKey(ctx)&&Number(pending.chatId)===Number(ctx.chatId))return true;
    const command=musicText(ctx,source.text).split(/\s+/)[0]?.split('@')[0]?.toLowerCase();
    return command==='/channel'||command==='/destination'||(app.music.destinations?.has(`${app.music.botKey(ctx)}:${ctx.tgId}`)&&(channelCommands.has(command)||app.sm?.state(ctx.tgId)===States.MUSIC_QUEUE_INPUT));
  }
  async function handlePrivateChannel(ctx,source){
    if(!privateChannelRequest(ctx,source))return false;
    if(!source.data&&await handlePlayerReply(ctx,source))return true;
    if(source.data){
      const d=decodeCallback(source.data);
      if(!['pc','channels','ch','listenq'].includes(d.action)){
        try{
          const session=['pick','spage','sclear','submit'].includes(d.action)?app.music.search.get(d.args[0],ctx):null;
          await app.music.authorize(ctx,true,session&&['queue','video'].includes(session.mode)?session.destination:null);
        }catch(e){await error(ctx,e);return true;}
      }
      await handle(ctx,d.action,d.args);return true;
    }
    const [head,...args]=musicText(ctx,source.text).split(/\s+/),[command,targetBot]=head.split('@');
    if(targetBot&&targetBot.toLowerCase()!==ctx.api.me?.username?.toLowerCase())return false;
    if(['/channel','/destination'].includes(command.toLowerCase()))return await handleCommand(ctx,command.toLowerCase(),args);
    const pending=app.sm?.get(ctx.tgId),scopedInput=pending?.state===States.MUSIC_QUEUE_INPUT&&pending.context.botKey===app.music.botKey(ctx)&&Number(pending.chatId)===Number(ctx.chatId);
    if(scopedInput&&command.toLowerCase()==='/cancel'){await app.sm.cancel(ctx.tgId);return true;}
    if(scopedInput&&pending.context.mode==='channel'&&!command.startsWith('/'))return app.sm.handleMessage(ctx.tgId,source,ctx);
    // A ForceReply retains its original panel, not the most recently bound DM channel.
    if(scopedInput&&pending.context.panelToken&&!command.startsWith('/'))return app.sm.handleMessage(ctx.tgId,source,ctx);
    try{await app.music.authorize(ctx,true);}catch{return false;}
    if(channelCommands.has(command.toLowerCase()))return await handleCommand(ctx,command.toLowerCase(),args);
    if(!command.startsWith('/')&&app.sm?.state(ctx.tgId)===States.MUSIC_QUEUE_INPUT)return app.sm.handleMessage(ctx.tgId,source,ctx);
    return false;
  }
  function registerStateHandlers(sm){
    sm.register(States.MUSIC_QUEUE_INPUT,{onCleanup:ctx=>temporary.remove(ctx.context?.temporaryToken),onMessage:async(ctx,message)=>{
      const record=sm.get(ctx.tgId);if(Number(record.chatId)!==Number(ctx.chatId)||record.context.botKey!==app.music.botKey(ctx))return false;
      if(record.context.mode==='channel'){try{const value=message.text||message.caption||'',id=await app.music.bind({...ctx,message},value);await sm.reset(ctx.tgId);await channels(ctx);return id;}catch(e){await error(ctx,e);return true;}}
      if(!message.text||(Number(ctx.chatId)<0&&message.reply_to_message?.message_id!==record.context.promptMessageId))return false;
      const mode=record.context.mode,panelToken=record.context.panelToken;
      try{const panel=panelToken?await app.music.channelPanels.resolve(ctx,panelToken,{requireMessage:false}):null;await sm.reset(ctx.tgId);if(mode==='radio'){const scoped=panel?{...ctx,musicPanel:panel}:ctx,id=await app.music.authorize(scoped,true),state=panel||app.musicQueueManager.getSession(id);const customArtist=String(message.text).trim().slice(0,120);state.radioCustom=customArtist;state.view='player';const rich=renderGenreSubmenu(customArtist,'queue',panelToken);const sent=await ctx.api.sendRichMessage(ctx.chatId,rich).catch(()=>null);if(sent)temporary.remember(ctx,sent,{ttlMs:120000});}else await search(panel?{...ctx,musicPanel:panel}:ctx,message.text,mode);}
      catch(e){await sm.reset(ctx.tgId);await error(ctx,e);}return true;
    }});
    // Recover persisted legacy login flows safely; never accept or forward their secrets.
    for(const state of [States.ASSISTANT_AUTH_PHONE,States.ASSISTANT_AUTH_CODE,States.ASSISTANT_AUTH_2FA])sm.register(state,{onMessage:async(ctx,message)=>{if(message.message_id)await ctx.api?.deleteMessage(ctx.chatId,message.message_id).catch(()=>{});await sm.reset(ctx.tgId);await ctx.api?.sendMessage(ctx.chatId,'Session setup now uses the protected local terminal. Never send login codes or passwords here.');return true;}});
  }
  return{id,renderHome,renderListen,renderOptions,renderPlayer,renderQueue,renderVolumePicker,renderRadio,renderCategoryPicker,renderGenreSubmenu,renderChannels,renderSearch,renderLyrics,renderAccounts,renderSessionSetupNotice,renderAssistantSessionStatus,registerStateHandlers,handle,handleCommand,handlePlayerReply,privateChannelRequest,handlePrivateChannel,search,cleanup:()=>temporary.shutdown(),async open(ctx){return ctx.api.sendRichMessage(ctx.chatId,renderHome());}};
}
