import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { createDownloaderScreen } from '../src/telegram/screens/downloader.js';
import { createMusicScreen } from '../src/telegram/screens/music.js';
import { originalPlayDelivery, recordingArtwork } from '../src/music/originalPlayCard.js';
import { boundedFetchFile } from '../src/music/library.js';
import { MusicService } from '../src/music/service.js';
import { normalizeTrack } from '../src/music/model.js';
import { decodeCallback } from '../src/telegram/rich.js';
const track = extra => normalizeTrack({providerId:'fixture-recording',title:'Fixture full song',artist:'Fixture artist',album:'Fixture album',year:2025,durationSeconds:240,artwork:'https://i.ytimg.com/vi/fixture/hqdefault.jpg',...extra},'youtube');
const audio = {buffer:Buffer.from('complete recording fixture'),filename:'fixture.mp3',contentType:'audio/mpeg'};
const context = {chatId:-1001,tgId:42,isGroup:true,user:{first_name:'Fixture listener'}};
const buttons = rich => rich.blocks.filter(b=>b.type==='buttons').flatMap(b=>b.buttons);
const callback = (rich, action) => buttons(rich).map(b=>decodeCallback(b.callback_data)).find(c=>c?.action===action);
function fixture() {
  let resolverCalls=0;
  const app={db:{run(){}},screens:new Map(),mediaDownloader:{download(){resolverCalls++;throw Error('Legacy resolution must not run.');}}};
  const original=createDownloaderScreen({app});app.screens.set('downloader',original);
  return {app,original,resolverCalls:()=>resolverCalls};
}
function cleanCaches(t,rich) {
  const a=callback(rich,'send_audio')?.args[0],i=callback(rich,'to_sticker')?.args[0];
  t.after(async()=>{
    for(const name of [a&&`lancy_track_${a}.mp3`,a&&`lancy_meta_${a}.json`,a&&`lancy_thumb_${a}.jpg`,i&&`lancy_img_${i}_0.jpg`,i&&`lancy_img_${i}_meta.json`].filter(Boolean)) await rm(join(tmpdir(),name),{force:true});
  });
}
test('standalone full recording reuses the original delivery layout and preserves non-VC buttons',async t=>{
  const f=fixture(),artwork={buffer:await sharp({create:{width:8,height:8,channels:3,background:'#000000'}}).jpeg().toBuffer(),filename:'cover.jpg',mimeType:'image/jpeg'};
  const delivery=await originalPlayDelivery({app:f.app,ctx:context,track:track(),audio,lyrics:{found:true,text:'Fixture lyrics excerpt'},cardToken:'scoped-listen-token',artworkLoader:async()=>artwork});
  cleanCaches(t,delivery.rich);
  const json=JSON.stringify(delivery.rich);
  assert.ok(delivery.rich.blocks.some(b=>b.type==='table'));assert.match(json,/YOUTUBE/);assert.match(json,/Fixture album/);assert.match(json,/2025/);assert.match(json,/Requested By/);assert.match(json,/Fixture listener/);
  assert.match(json,/Fixture lyrics excerpt/);assert.ok(delivery.rich.blocks.some(b=>b.type==='expandable_blockquote'));
  assert.equal(delivery.rich.blocks.find(b=>b.type==='audio').audio.duration,240);
  assert.ok(delivery.rich.blocks.findIndex(b=>b.type==='photo')<delivery.rich.blocks.findIndex(b=>b.type==='audio'));
  assert.deepEqual(delivery.files.audio_track.buffer,audio.buffer);assert.deepEqual(delivery.files.photo_0.buffer,artwork.buffer);
  for(const action of ['send_audio','to_sticker','input','play','open']) assert.ok(callback(delivery.rich,action),`original action ${action} missing`);
  assert.ok(buttons(delivery.rich).some(b=>b.text.includes('Sticker Pack')));
  assert.deepEqual(callback(delivery.rich,'listenq').args,['scoped-listen-token']);
  assert.equal(callback(delivery.rich,'listenq').screen,'music');
  assert.equal(f.resolverCalls(),0);assert.doesNotMatch(json,/Lancy · listen & download|SPOTIFY|192k|Pause VC/);
});
test('original Send Audio File callback still sends the exact delivered recording and metadata',async t=>{
  const f=fixture(),sent=[];
  const delivery=await originalPlayDelivery({app:f.app,ctx:context,track:track(),audio,cardToken:'card',artworkLoader:async()=>null});
  cleanCaches(t,delivery.rich);
  const c=callback(delivery.rich,'send_audio');
  await f.original.handle({...context,api:{sendChatAction:async()=>{},sendAudio:async(chat,buffer,options)=>{sent.push({chat,buffer,options});return {message_id:5,audio:{file_id:'fixture'}};}}},c.action,c.args);
  assert.equal(sent.length,1);assert.deepEqual(sent[0].buffer,audio.buffer);assert.equal(sent[0].options.title,'Fixture full song');
  assert.match(sent[0].options.caption,/Fixture album/);assert.match(sent[0].options.caption,/2025/);assert.match(sent[0].options.caption,/YOUTUBE/);assert.doesNotMatch(sent[0].options.caption,/192k/);
});
test('unknown source metadata is not replaced with fabricated Spotify, album or bitrate claims',async t=>{
  const f=fixture(),delivery=await originalPlayDelivery({app:f.app,ctx:context,track:track({artist:null,album:null,year:null}),audio,artworkLoader:async()=>null});
  cleanCaches(t,delivery.rich);const json=JSON.stringify(delivery.rich);
  assert.match(json,/Artist not supplied/);assert.match(json,/YOUTUBE/);assert.doesNotMatch(json,/SPOTIFY|192k|💿 Album|📅 Release/);
  assert.ok(callback(delivery.rich,'send_audio'));assert.equal(callback(delivery.rich,'listenq'),undefined);
});
test('audio-only permissions retain original audio/metadata/actions without requesting cover media',async t=>{
  const f=fixture(),delivery=await originalPlayDelivery({app:f.app,ctx:context,track:track(),audio,allowArtwork:false,artworkLoader:async()=>{throw Error('Must not fetch a forbidden photo.');}});
  cleanCaches(t,delivery.rich);assert.ok(delivery.rich.blocks.some(b=>b.type==='audio'));assert.ok(!delivery.rich.blocks.some(b=>b.type==='photo'));assert.ok(callback(delivery.rich,'send_audio'));
});
test('cover art has HTTPS/private-network checks and never breaks full-song delivery',async()=>{
  assert.equal(await recordingArtwork(track({artwork:'https://127.0.0.1/private'})),null);
  assert.equal(await recordingArtwork(track({artwork:'http://example.com/cover'})),null);
  assert.equal(await recordingArtwork(track({artwork:null})),null);
});
test('bounded media fetch accepts an already-aborted optional signal without opening a file',async t=>{
  const root=await mkdtemp(join(tmpdir(),'lancy-cover-abort-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const controller=new AbortController();controller.abort();
  await assert.rejects(boundedFetchFile('https://127.0.0.1/private',join(root,'never-written'),1024,0,{signal:controller.signal}),{name:'AbortError'});
});
test('MusicService full-song submission actually uses the original renderer without starting VC or re-resolving',async t=>{
  const f=fixture(),root=await mkdtemp(join(tmpdir(),'lancy-original-play-test-'));await writeFile(join(root,'full.mp3'),audio.buffer);
  let released=0,acquired=0,voiceCalls=0,delivered;
  f.app.settings={get:()=>[42]};f.app.db.getSetting=(_key,d)=>d;
  f.app.musicLibrary={acquire:async(value,options)=>{acquired++;assert.equal(options.download,true);return {track:value,filePath:join(root,'full.mp3'),release(){released++;}};}};
  f.app.voiceClient={setup(){voiceCalls++;throw Error('Standalone /play cannot start VC.');}};
  f.app.musicQueueManager={sessions:new Map()};f.app.music=new MusicService({app:f.app});f.app.music.lyrics={get:async()=>({found:true,text:'Fixture matched excerpt'})};
  const screen=createMusicScreen({app:f.app});f.app.screens.set('music',screen);
  t.after(async()=>{await f.app.music.previews.shutdown();await screen.cleanup();await rm(root,{recursive:true,force:true});});
  const state={mode:'download',selected:new Map([['fixture',track({artwork:null})]]),messageId:22,queueDestination:-1001};
  const api={me:{id:99},getChat:async()=>({type:'supergroup',permissions:{can_send_audios:true}}),getChatMember:async()=>({status:'administrator'}),editMessageRich:async(chat,id,rich,extra,files)=>{delivered={rich,files};return {message_id:id,rich_message:{blocks:[{type:'audio',audio:{file_id:'fixture_delivered_audio'}}]}};}};
  await f.app.music.submit({...context,api,messageId:22},state);cleanCaches(t,delivered.rich);
  assert.match(JSON.stringify(delivered.rich),/Fixture album/);assert.ok(callback(delivered.rich,'send_audio'));assert.equal(callback(delivered.rich,'listenq'),undefined);
  assert.equal(acquired,1);assert.equal(released,1);assert.equal(voiceCalls,0);assert.equal(f.resolverCalls(),0);assert.equal(state.consumed,true);
  assert.deepEqual(delivered.files.audio_track.buffer,audio.buffer);assert.equal(f.app.music.previews.cached(api,track()),'fixture_delivered_audio');
  // Card-only repair deliberately does not activate the unfinished queue-card feature.
});

test('a song title mentioning matching PFP does not hijack the verified music card into a PFP album',async t=>{
  const f=fixture(),delivery=await originalPlayDelivery({app:f.app,ctx:context,track:track({title:'Matching PFP',artwork:null}),audio,artworkLoader:async()=>null});
  cleanCaches(t,delivery.rich);assert.match(JSON.stringify(delivery.rich),/YOUTUBE/);assert.ok(callback(delivery.rich,'send_audio'));assert.ok(!callback(delivery.rich,'pfp_sep'));
});
