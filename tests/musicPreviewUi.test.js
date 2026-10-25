import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { audioFileId, FullTrackPreviews } from '../src/music/preview.js';
import { TemporaryBotMessages } from '../src/music/messages.js';
import { MusicService } from '../src/music/service.js';
import { MediaLibrary } from '../src/music/library.js';
import { QueueManager } from '../src/music/queueManager.js';
import { normalizeTrack, MusicError } from '../src/music/model.js';
import { createMusicScreen } from '../src/telegram/screens/music.js';
import { StateMachine, States } from '../src/core/stateMachine.js';
import { SearchSessions } from '../src/music/search.js';
import { decodeCallback } from '../src/telegram/rich.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const gate = () => { let resolve; const promise=new Promise(r=>{resolve=r;}); return {promise,resolve}; };
const song = (n=1, extra={}) => normalizeTrack({providerId:`recording${n}`,title:`Full recording ${n}`,artist:'Fixture artist',durationSeconds:240,capabilities:{stream:true,download:true,seek:true},...extra},'youtube');
const response = (id=20) => ({message_id:id,rich_message:{blocks:[{type:'audio',audio:{file_id:'telegram_full_audio_fixture'}}]}});
async function drain(previews) { for(let i=0;i<10;i++){await Promise.allSettled([...previews.jobs]);await delay(1);if(!previews.jobs.size)break;} }
async function harness(t,{acquire}={}) {
  const root=await mkdtemp(join(tmpdir(),'lancy-preview-ui-'));await writeFile(join(root,'full.mp3'),'fixture bytes');
  const calls=[],app={settings:{get:()=>[10]},db:{getSetting:(_k,d)=>d,setSetting(){}}};
  const api={me:{id:99},getChat:async()=>({type:'supergroup',title:'Fixture group'}),getChatMember:async()=>({status:'administrator',can_pin_messages:true}),
    editMessageRich:async(chat,id,rich,extra,files)=>{calls.push({chat,id,rich,extra,files});return response(id);},sendRichMessage:async(chat,rich,extra,files)=>{calls.push({chat,id:20,rich,extra,files});return response();},deleteMessage:async()=>true};
  let refs=0,acquires=0;
  app.musicLibrary={acquire:async(track,options)=>{acquires++;assert.equal(options.download,true);refs++;if(acquire)await acquire(track);let released=false;return{track,filePath:join(root,'full.mp3'),release(){if(!released){refs--;released=true;}}};}};
  app.musicQueueManager=new QueueManager({app,pollMs:0,voiceClient:{stop:async()=>({ok:true}),pause:async()=>({ok:true}),resume:async()=>({ok:true})}});
  app.music=new MusicService({app});const screen=createMusicScreen({app});app.screens=new Map([['music',screen]]);
  const s=app.musicQueueManager.getSession(-1);Object.assign(s,{api,currentTrack:song(),status:'playing',playbackId:'one',view:'player',screenMessageId:20,playerChatId:-1,positionSeconds:12});
  t.after(async()=>{await app.musicQueueManager.shutdown();await app.music.previews.shutdown();await screen.cleanup();await rm(root,{recursive:true,force:true});});
  return {app,api,screen,s,calls,refs:()=>refs,acquires:()=>acquires,root};
}

test('audio reference parser uses actual rich audio response, never artwork thumbnail IDs',()=>{
  assert.equal(audioFileId(response()),'telegram_full_audio_fixture');
  assert.equal(audioFileId({rich_message:{blocks:[{type:'photo',photo:{file_id:'wrong_cover'}}]}}),null);
  assert.equal(audioFileId({audio:{thumbnail:{file_id:'wrong_cover'}}}),null);
  assert.equal(audioFileId({audio:{file_id:'standard_audio'}}),'standard_audio');
  assert.equal(audioFileId({rich_message:{blocks:[{type:'blockquote',blocks:response().rich_message.blocks}]}}),'telegram_full_audio_fixture');
});
test('listen/download card embeds the full duration and no voice-chat transport controls',()=>{
  const screen=createMusicScreen({app:{}}),rich=screen.renderListen(song(),'full_audio_reference');
  assert.equal(rich.blocks.find(b=>b.type==='audio').audio.duration,240);
  assert.match(JSON.stringify(rich),/No voice chat needed/);
  assert.ok(!JSON.stringify(rich).includes('Pause VC'));
  assert.ok(!JSON.stringify(rich).includes('30-second'));
});
test('player clearly separates Telegram listening from VC progress and ignores another recording preview',()=>{
  const screen=createMusicScreen({app:{}}),s={status:'playing',currentTrack:song(),positionSeconds:12,upcoming:[],loopMode:'off',volume:80,fullPreview:{trackId:'youtube:recording1',status:'ready',fileId:'cached_reference'}};
  assert.equal(screen.renderPlayer(s).blocks.filter(b=>b.type==='audio').length,1);
  assert.match(JSON.stringify(screen.renderPlayer(s)),/independently of the voice chat/);
  assert.match(JSON.stringify(screen.renderPlayer(s)),/VC · 0:12 \/ 4:00/);
  s.fullPreview.trackId='youtube:other';assert.equal(screen.renderPlayer(s).blocks.filter(b=>b.type==='audio').length,0);
});
test('compact settings and all new view callbacks remain bounded and decodable',()=>{
  const screen=createMusicScreen({app:{}}),s={status:'idle',upcoming:[],loopMode:'off',volume:100};
  for(const rich of [screen.renderPlayer(s),screen.renderOptions(s),screen.renderListen(song(),'file_id')])
    for(const row of rich.blocks.filter(b=>b.type==='buttons'))for(const b of row.buttons){assert.ok(Buffer.byteLength(b.callback_data)<=64);assert.ok(decodeCallback(b.callback_data));}
  assert.match(JSON.stringify(screen.renderOptions(s)),/Stop & leave group/);
  assert.match(JSON.stringify(screen.renderOptions({...s,isChannel:true})),/Stop & leave call/);
  assert.ok(!JSON.stringify(screen.renderPlayer(s)).includes('Leave call'));
});
test('download selection becomes the full-song rich card in the same message, never auto-joins VC',async t=>{
  const h=await harness(t),state={mode:'download',messageId:30,selected:new Map([[song().id,song()]])};
  h.app.musicQueueManager.addMany=()=>{throw Error('download must not queue');};
  await h.app.music.submit({api:h.api,tgId:10,chatId:10,messageId:30},state);
  assert.equal(state.consumed,true);assert.equal(h.calls.length,1);assert.equal(h.calls[0].id,30);
  assert.ok(h.calls[0].files.music_full_audio.buffer.length>0);assert.equal(h.refs(),0);
  assert.equal(h.app.music.previews.cached(h.api,song()),'telegram_full_audio_fixture');
});
test('failed audio-card delivery releases the file and leaves selection retryable',async t=>{
  const h=await harness(t),state={mode:'download',messageId:30,selected:new Map([[song().id,song()]])};
  h.api.editMessageRich=async()=>{throw Error('transport failed');};
  await assert.rejects(h.app.music.submit({api:h.api,tgId:10,chatId:10,messageId:30},state));
  assert.equal(h.refs(),0);assert.notEqual(state.consumed,true);
});
test('stream-only recording is never uploaded as a downloadable Telegram preview',async t=>{
  const h=await harness(t);h.s.currentTrack={...song(),id:'audius:abc',provider:'audius',providerId:'abc',downloadable:false};
  await h.app.musicQueueManager.updatePlayerCard(-1);await drain(h.app.music.previews);
  assert.equal(h.acquires(),0);assert.equal(h.s.fullPreview.status,'unavailable');assert.equal(h.s.status,'playing');
  assert.ok(h.calls.every(c=>!c.files));
});
test('full preview resolves in background, uploads once and reuses file_id on routine edits',async t=>{
  const wait=gate(),h=await harness(t,{acquire:()=>wait.promise});
  await h.app.musicQueueManager.updatePlayerCard(-1);
  assert.equal(h.s.fullPreview.status,'pending');assert.equal(h.calls.filter(c=>c.files).length,0);
  wait.resolve();await drain(h.app.music.previews);
  assert.equal(h.s.fullPreview.status,'ready');assert.equal(h.refs(),0);assert.equal(h.calls.filter(c=>c.files).length,1);
  h.s.positionSeconds=22;await h.app.musicQueueManager.updatePlayerCard(-1);
  h.s.view='volume';await h.app.musicQueueManager.updatePlayerCard(-1);h.s.view='player';await h.app.musicQueueManager.updatePlayerCard(-1);
  assert.equal(h.calls.filter(c=>c.files).length,1);assert.equal(h.acquires(),1);
  assert.equal(h.calls.at(-1).rich.blocks.find(b=>b.type==='audio').audio.media,'telegram_full_audio_fixture');
});
test('cached Telegram references are isolated per bot and bounded by size and TTL',async()=>{
  const p=new FullTrackPreviews({app:{},maxEntries:2,ttlMs:5}),a={me:{id:1}},b={me:{id:2}};
  p.remember(a,song(),'a');assert.equal(p.cached(b,song()),null);
  p.remember(a,song(2),'b');p.remember(a,song(3),'c');assert.equal(p.cache.size,2);assert.equal(p.cached(a,song()),null);
  await delay(8);assert.equal(p.cached(a,song(3)),null);await p.shutdown();
});
test('changing recording during preparation cannot upload the old song into the new dashboard',async t=>{
  const wait=gate(),h=await harness(t,{acquire:track=>track.id===song().id?wait.promise:undefined});
  await h.app.musicQueueManager.updatePlayerCard(-1);h.s.currentTrack=song(2);h.s.playbackId='two';await h.app.musicQueueManager.updatePlayerCard(-1);
  wait.resolve();await drain(h.app.music.previews);
  const uploads=h.calls.filter(c=>c.files);assert.equal(uploads.length,1);
  assert.equal(uploads[0].rich.blocks.find(b=>b.type==='audio').audio.title,song(2).title);assert.equal(h.refs(),0);
});
test('navigating away mid-resolution does not inject audio into queue/settings and releases refs',async t=>{
  const wait=gate(),h=await harness(t,{acquire:()=>wait.promise});await h.app.musicQueueManager.updatePlayerCard(-1);
  h.s.view='queue';await h.app.musicQueueManager.updatePlayerCard(-1);wait.resolve();await drain(h.app.music.previews);
  assert.equal(h.calls.filter(c=>c.files).length,0);assert.equal(h.refs(),0);
  h.s.view='player';await h.app.musicQueueManager.updatePlayerCard(-1);await drain(h.app.music.previews);assert.equal(h.s.fullPreview.status,'ready');
});
test('shutdown during preparation cannot revive a stopped panel or leak media refs',async t=>{
  const wait=gate(),h=await harness(t,{acquire:()=>wait.promise});await h.app.musicQueueManager.updatePlayerCard(-1);
  await h.app.musicQueueManager.shutdown();wait.resolve();await h.app.music.previews.shutdown();
  assert.equal(h.s.status,'stopped');assert.equal(h.calls.filter(c=>c.files).length,0);assert.equal(h.refs(),0);
});
test('upload failure is contained, leaves VC playing, and does not retry on every progress poll',async t=>{
  const h=await harness(t),normal=h.api.editMessageRich;h.api.editMessageRich=async(...args)=>{if(args[4])throw Error('upload failed');return normal(...args);};
  await h.app.musicQueueManager.updatePlayerCard(-1);await drain(h.app.music.previews);
  assert.equal(h.s.fullPreview.status,'unavailable');assert.equal(h.s.status,'playing');assert.equal(h.refs(),0);
  for(let i=0;i<3;i++){h.s.positionSeconds++;await h.app.musicQueueManager.updatePlayerCard(-1);}assert.equal(h.acquires(),1);
});
test('pending preview is single-flight per destination despite repeated refresh requests',async t=>{
  const wait=gate(),h=await harness(t,{acquire:()=>wait.promise});await h.app.musicQueueManager.updatePlayerCard(-1);
  for(let i=0;i<20;i++){h.s.fullPreview=null;h.app.music.previews.schedule(h.s);}
  assert.equal(h.app.music.previews.jobs.size,1);assert.equal(h.acquires(),1);wait.resolve();await drain(h.app.music.previews);
});
test('renderer edits are serialized, preventing overlapping uploads and stale response reordering',async t=>{
  const h=await harness(t);h.s.currentTrack=null;let active=0,max=0;
  h.api.editMessageRich=async()=>{active++;max=Math.max(max,active);await delay(5);active--;return response();};
  await Promise.all(Array.from({length:10},(_,i)=>{h.s.lastNotice=String(i);return h.app.musicQueueManager.updatePlayerCard(-1);}));assert.equal(max,1);
});
test('Audius cached files cannot bypass current creator download permission',async t=>{
  const root=await mkdtemp(join(tmpdir(),'lancy-preview-permissions-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const track={...song(),id:'audius:abc',provider:'audius',providerId:'abc',downloadable:true};let permitted=true,checks=0;
  const library=new MediaLibrary({root,providers:{get:()=>({media:async()=>{checks++;if(!permitted)throw new MusicError('RESTRICTED','Download not permitted');return{track};}})}});
  const key=createHash('sha256').update(`${track.id}:false:true`).digest('hex');library.active.set(key,{key,filePath:join(root,'cached.mp3'),track});
  const first=await library.acquire(track,{download:true});first.release();permitted=false;
  await assert.rejects(library.acquire(track,{download:true}),e=>e.code==='RESTRICTED');assert.equal(checks,2);
});
test('authorized full audio reuses the complete VC cache without another transcode or download',async t=>{
  const root=await mkdtemp(join(tmpdir(),'lancy-preview-reuse-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const track={...song(),id:'audius:abc',provider:'audius',providerId:'abc',downloadable:true};let checks=0;
  const library=new MediaLibrary({root,providers:{get:()=>({media:async()=>{checks++;return{track};}})},runner:async()=>{throw Error('must not transcode');}});
  const key=createHash('sha256').update(`${track.id}:false:false`).digest('hex'),path=join(root,'cached.mp3');library.active.set(key,{key,filePath:path,track});library.refs.set(key,1);
  const media=await library.acquire(track,{download:true});assert.equal(media.filePath,path);assert.equal(checks,1);assert.equal(library.refs.get(key),2);media.release();assert.equal(library.refs.get(key),1);
});
test('slow download-consent check does not hold the VC media-resolution lock',async t=>{
  const root=await mkdtemp(join(tmpdir(),'lancy-preview-priority-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const wait=gate(),track={...song(),id:'audius:abc',provider:'audius',providerId:'abc',downloadable:true};
  const library=new MediaLibrary({root,providers:{get:()=>({media:async()=>{await wait.promise;return{track};}})}});
  const key=createHash('sha256').update(`${track.id}:false:false`).digest('hex');library.active.set(key,{key,filePath:join(root,'cached.mp3'),track});
  const preview=library.acquire(track,{download:true});const media=await Promise.race([library.acquire(track),delay(100).then(()=>{throw Error('preview blocked VC');})]);media.release();wait.resolve();(await preview).release();
});
test('temporary cleanup targets only recorded bot messages, not callback/user IDs, and survives failures',async()=>{
  const deleted=[],api={deleteMessage:async(chat,id)=>{deleted.push([chat,id]);return true;}};
  const m=new TemporaryBotMessages(),ctx={api,chatId:-1};const token=m.remember(ctx,{message_id:7});
  assert.equal(await m.remove('user-controlled-message-id'),false);await m.remove(token);assert.deepEqual(deleted,[[-1,7]]);
  const keep=m.remember(ctx,{message_id:8});m.keep(keep);await m.shutdown();assert.equal(deleted.length,1);
  const bad=m.remember({api:{deleteMessage:async()=>{throw Error('no permission');}},chatId:-2},{message_id:9});assert.equal(await m.remove(bad),false);await m.shutdown();
});
test('temporary bot bookkeeping and expiry remain bounded',async()=>{
  const deleted=[],m=new TemporaryBotMessages({maxEntries:2}),ctx={chatId:1,api:{deleteMessage:async(_chat,id)=>{deleted.push(id);return true;}}};
  for(let id=1;id<=4;id++)m.remember(ctx,{message_id:id},{ttlMs:5});assert.equal(m.entries.size,2);await delay(15);assert.equal(m.entries.size,0);assert.deepEqual(deleted,[1,2,3,4]);
});
test('accepted music input and cancellation delete bot ForceReply prompts, never user replies',async()=>{
  const deleted=[],sm=new StateMachine(),app={sm,music:{botKey:()=> '99',startSearch:async()=>({id:'session',mode:'download',query:'fixture',pages:[{items:[],provider:'fixture'}],index:0,selected:new Map(),revision:0})}};
  const api={me:{id:99},sendMessage:async()=>({message_id:7}),deleteMessage:async(_c,id)=>{deleted.push(id);return true;},editMessageRich:async()=>{}};
  const ctx={api,tgId:'10',chatId:-1};const screen=createMusicScreen({app});screen.registerStateHandlers(sm);
  await screen.search(ctx,'','download');assert.equal(sm.state('10'),States.MUSIC_QUEUE_INPUT);
  await sm.handleMessage('10',{text:'song artist',message_id:100,reply_to_message:{message_id:7}},ctx);
  assert.equal(deleted.includes(7),true);assert.equal(deleted.includes(100),false);
  await screen.search(ctx,'','download');await sm.cancel('10');assert.equal(deleted.filter(id=>id===7).length,2);await screen.cleanup();
});
test('completed VC selection removes its temporary search card while download card is kept',async()=>{
  for(const mode of ['queue','download']){
    const deleted=[],store=new SearchSessions({providers:{search:async()=>({items:[song()],provider:'youtube'})}}),app={music:{botKey:()=> '99',search:store,startSearch:async(ctx,q,m)=>{const s=store.create({userId:ctx.tgId,chatId:ctx.chatId,botId:'99',destination:-1,query:q,mode:m});await store.page(s,0);return s;},submit:async(_c,s)=>{s.consumed=true;}}};
    const api={me:{id:99},sendMessage:async()=>({message_id:7}),deleteMessage:async(_c,id)=>{deleted.push(id);return true;},editMessageRich:async()=>{},editMessageText:async()=>{throw Error('must not leave an Audio delivered message');}};
    const screen=createMusicScreen({app}),ctx={api,tgId:'10',chatId:-1,messageId:7};const state=await screen.search(ctx,'fixture',mode);state.selected.set(song().id,song());
    await screen.handle(ctx,'submit',[state.id,'0']);assert.equal(deleted.length,mode==='queue'?1:0);await screen.cleanup();assert.equal(deleted.length,mode==='queue'?1:0);
  }
});


test('a long media submission holds cleanup expiry until the final audio card is kept',async()=>{
  const deleted=[],m=new TemporaryBotMessages(),ctx={chatId:1,api:{deleteMessage:async(_c,id)=>{deleted.push(id);return true;}}};
  const token=m.remember(ctx,{message_id:7},{ttlMs:3});m.hold(token);await delay(8);assert.equal(deleted.length,0);
  m.keep(token);await m.shutdown();assert.equal(deleted.length,0);
});
test('transient deletion failures are retried with bounded bookkeeping',async()=>{
  let attempts=0;const m=new TemporaryBotMessages({retryDelayMs:3}),ctx={chatId:1,api:{deleteMessage:async()=>++attempts>1}};
  const token=m.remember(ctx,{message_id:7});assert.equal(await m.remove(token),false);await delay(12);assert.equal(attempts,2);assert.equal(m.entries.size,0);await m.shutdown();
});


test('unknown source duration is not marketed as a verified full-song download',async t=>{
  const root=await mkdtemp(join(tmpdir(),'lancy-preview-duration-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const track=song(),library=new MediaLibrary({root,providers:{get:()=>({download:async(_track,path)=>{await writeFile(path,'fixture');return {...track,durationSeconds:null};}})}});
  await assert.rejects(library.acquire(track,{download:true}),e=>e.code==='DURATION_UNVERIFIED');
});

test('automatic previews are globally bounded and simultaneous destinations share one audio upload per bot/recording',async t=>{
  const wait=gate(),h=await harness(t,{acquire:()=>wait.promise});
  const sessions=[h.s];
  for(const id of [-2,-3]){const s=h.app.musicQueueManager.getSession(id);Object.assign(s,{api:h.api,currentTrack:song(),status:'playing',playbackId:String(id),screenMessageId:20-id,playerChatId:id});sessions.push(s);}
  for(const s of sessions)await h.app.musicQueueManager.updatePlayerCard(s.chatId);
  assert.equal(h.app.music.previews.jobs.size,2);assert.equal(sessions[2].fullPreview.status,'unavailable');
  wait.resolve();await drain(h.app.music.previews);
  assert.equal(h.calls.filter(c=>c.files).length,1);assert.equal(sessions[0].fullPreview.status,'ready');assert.equal(sessions[1].fullPreview.status,'ready');assert.equal(h.refs(),0);
});
test('explicit full-song deliveries have a fail-fast concurrency bound and release their slots',async t=>{
  const h=await harness(t),wait=gate();h.api.editMessageRich=async(_chat,id)=>{await wait.promise;return response(id);};
  const state=id=>({mode:'download',messageId:id,selected:new Map([[song().id,song()]])});
  const ctx=id=>({api:h.api,tgId:10,chatId:10,messageId:id});
  const a=h.app.music.submit(ctx(30),state(30)),b=h.app.music.submit(ctx(31),state(31));
  assert.equal(h.app.music.downloads,2);await assert.rejects(h.app.music.submit(ctx(32),state(32)),e=>e.code==='DOWNLOAD_BUSY');
  wait.resolve();await Promise.all([a,b]);assert.equal(h.app.music.downloads,0);assert.equal(h.refs(),0);
});
