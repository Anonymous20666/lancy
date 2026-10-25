import { SearchSessions } from '../src/music/search.js';
import { setGlobalForceJoinChannels } from '../src/telegram/forceJoin.js';
import { Database } from '../src/core/db.js';
import { SettingsManager } from '../src/config/settings.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MusicService } from '../src/music/service.js';
import { QueueManager } from '../src/music/queueManager.js';
import { normalizeTrack } from '../src/music/model.js';
import { createMusicScreen } from '../src/telegram/screens/music.js';
import { PANEL_ACTIONS } from '../src/music/channelPanels.js';
import { withMusicCommands, ADMIN_MUSIC_COMMANDS } from '../src/music/commands.js';
import { decodeCallback, encodeCallback } from '../src/telegram/rich.js';
import { TelegramController } from '../src/telegram/bot.js';
import { StateMachine } from '../src/core/stateMachine.js';

const song=n=>normalizeTrack({providerId:String(n),title:`Recording ${n}`,artist:'Generated fixture',durationSeconds:90,streamUrl:`https://example.com/${n}.mp3`,capabilities:{stream:true,seek:true}},'fixture');
function setup(t){
 const sent=[],edits=[],pins=[],members=new Map(),calls=[];let mid=100;
 const chat=value=>{const id=value==='@onechannel'?-10011:value==='@twochannel'?-10022:Number(value);return{id,type:id===-555?'supergroup':'channel',title:id===-10011?'Channel One':'Channel Two'};};
 const api={me:{id:99},getChat:async value=>chat(value),getChatMember:async(id,user)=>{assert.ok(id<0,'No fake administrator lookup in a private chat');return{status:members.get(`${id}:${user}`)||(user===99?'administrator':[10,11].includes(Number(user))?'administrator':'member'),can_pin_messages:true};},
 sendRichMessage:async(id,rich)=>{assert.ok(id>0,'A channel dashboard must never be posted to the channel');const message_id=++mid;sent.push({id,rich,message_id});return{message_id};},
 editMessageRich:async(id,message_id,rich)=>{assert.ok(id>0);edits.push({id,message_id,rich});return{message_id};},editMessageText:async(id,message_id,text)=>{edits.push({id,message_id,text});return{message_id};},sendMessage:async(id,text)=>{sent.push({id,text,message_id:++mid});return{message_id:mid};},deleteMessage:async()=>true,
 call:async(method,params)=>{pins.push({method,...params});return true;}};
 const voice={play:async(id)=>{calls.push(['play',id]);return{ok:true,account_alias:'fixture'};},pause:async id=>{calls.push(['pause',id]);return{ok:true};},resume:async()=>({ok:true}),stop:async id=>{calls.push(['stop',id]);return{ok:true};},idle:async()=>({ok:true}),setVolume:async()=>({ok:true}),accounts:async()=>({accounts:[{alias:'fixture',enabled:true,status:'available'}]})};
 const app={settings:{get:()=>[1000]},db:{getSetting:(_k,d)=>d,setSetting(){}},sm:new StateMachine(),voiceClient:voice};
 app.musicQueueManager=new QueueManager({app,voiceClient:voice,pollMs:0});
 app.music=new MusicService({app,accounts:{sync:async()=>{}},lyrics:{get:async()=>({found:false,reason:'Fixture'})}});
 const screen=createMusicScreen({app});app.screens=new Map([['music',screen]]);screen.registerStateHandlers(app.sm);
 const ctx=(user=10)=>({tgId:String(user),chatId:user,api,user:{first_name:'Admin'}});
 async function open(user=10,id=-10011){app.music.rates.clear();await app.music.bind(ctx(user),String(id));return app.music.player(ctx(user),id);}
 async function control(state,action,args=[]){app.music.rates.clear();const c={...ctx(Number(state.playerChatId)),messageId:state.screenMessageId,query:{id:'fixture'}};const p=await app.music.channelPanels.resolve(c,state.panelToken);return app.music.control({...c,musicPanel:p},action,[...args,Number(p.controlRevision||0).toString(36)]);}
 t.after(async()=>{await app.musicQueueManager.shutdown();await app.music.previews.shutdown();await screen.cleanup();});
 return{app,api,ctx,open,control,sent,edits,pins,members,calls,screen};
}

test('a channel admin who is not the bot owner can bind their channel and gets a pinned private dashboard',async t=>{
 const h=setup(t),p=await h.open();assert.equal(p.chatId,-10011);assert.equal(p.playerChatId,10);assert.ok(p.panelToken);
 assert.equal(h.app.musicQueueManager.getSession(-10011).screenMessageId,null);assert.equal(h.sent[0].id,10);
 assert.deepEqual(h.pins[0],{method:'pinChatMessage',chat_id:10,message_id:p.screenMessageId,disable_notification:true});
});
test('channel links resolve to canonical numeric identity; members and bot-owner non-admins fail closed',async t=>{
 const h=setup(t);assert.equal(await h.app.music.bind(h.ctx(),'https://t.me/onechannel'),-10011);
 await assert.rejects(h.app.music.bind(h.ctx(12),'@onechannel'),e=>e.code==='ADMIN_ONLY');
 h.app.music.rates.clear();await assert.rejects(h.app.music.bind(h.ctx(1000),'@onechannel'),e=>e.code==='ADMIN_ONLY');
 await assert.rejects(h.app.music.bind({...h.ctx(),chatId:-10011},'@onechannel'),e=>e.code==='CHANNEL_DM_REQUIRED');
});
test('channel bot membership is verified; a permission API outage is never treated as administrator access',async t=>{
 const h=setup(t);h.members.set('-10011:99','member');await assert.rejects(h.open(),e=>e.code==='BOT_ADMIN_REQUIRED');
 h.api.getChatMember=async()=>{throw Error('offline');};await assert.rejects(h.open());assert.equal(h.sent.length,0);
});
test('two administrators get separate private views over one shared channel queue',async t=>{
 const h=setup(t),a=await h.open(10),b=await h.open(11);assert.notEqual(a.panelToken,b.panelToken);assert.notEqual(a.screenMessageId,b.screenMessageId);
 await h.app.musicQueueManager.addMany(-10011,[song(1),song(2)]);assert.equal(a.currentTrack.id,b.currentTrack.id);assert.equal(a.upcoming,b.upcoming);
 await h.control(a,'queue');assert.equal(a.view,'queue');assert.equal(b.view,'player');
 await h.control(b,'volume');assert.equal(a.view,'queue');assert.equal(b.view,'volume');assert.equal(h.app.musicQueueManager.sessions.size,1);
});
test('a private panel callback cannot be copied across user, bot, message or chat boundaries',async t=>{
 const h=setup(t),p=await h.open(),base={...h.ctx(),messageId:p.screenMessageId};
 for(const c of [{...base,tgId:'11'},{...base,chatId:11},{...base,messageId:999},{...base,api:{...h.api,me:{id:98}}}])await assert.rejects(h.app.music.channelPanels.resolve(c,p.panelToken),e=>e.code==='STALE_PLAYER');
});
test('an older channel dashboard still controls its own channel after the admin selects another channel',async t=>{
 const h=setup(t),a=await h.open(10,-10011),b=await h.open(10,-10022);
 await h.app.musicQueueManager.addMany(-10011,[song(1)]);await h.app.musicQueueManager.addMany(-10022,[song(2)]);
 await h.control(a,'pause');assert.equal(a.status,'paused');assert.equal(b.status,'playing');assert.deepEqual(h.calls.filter(c=>c[0]==='pause'),[['pause',-10011]]);
});
test('private scoped callbacks including maximal aliases and queue IDs stay within 64 bytes',async t=>{
 const h=setup(t),p=await h.open();const s=h.app.musicQueueManager.getSession(-10011);s.currentTrack=song(1);s.upcoming=[{...song(2),entryId:'12345678-1234-1234-1234-123456789abc'}];s.controlRevision=Number.MAX_SAFE_INTEGER;
 p.availableAccounts=[{alias:'a'.repeat(24),status:'available'}];
 for(const rich of [h.screen.renderPlayer(p),h.screen.renderQueue(p),h.screen.renderOptions(p),h.screen.renderAccounts(p)])for(const row of rich.blocks.filter(b=>b.type==='buttons'))for(const b of row.buttons){assert.ok(Buffer.byteLength(b.callback_data)<=64,b.callback_data);const d=decodeCallback(b.callback_data);assert.equal(d.action,'pc');assert.equal(d.args[0],p.panelToken);assert.ok(PANEL_ACTIONS[parseInt(d.args[1],36)]);}
});
test('compact remove handles target stable entries and stale callback revisions cannot remove another recording',async t=>{
 const h=setup(t),p=await h.open();const s=h.app.musicQueueManager.getSession(-10011);s.upcoming=[{...song(1),entryId:'12345678-1234-1234-1234-123456789abc'},{...song(2),entryId:'bbbbbbbb-1234-1234-1234-123456789abc'}];
 await h.control(p,'remove',['123456781234']);assert.deepEqual(s.upcoming.map(x=>x.id),[song(2).id]);
 h.app.music.rates.clear();await assert.rejects(h.app.music.control({...h.ctx(),musicPanel:p,messageId:p.screenMessageId,query:{}},'remove',['bbbbbbbb1234','0']),e=>e.code==='STALE_PLAYER');
});
test('channel private-state proxies include live canonical track/status fields in preview upload snapshots',async t=>{
 const h=setup(t),p=await h.open();const s=h.app.musicQueueManager.getSession(-10011);s.currentTrack=song(1);s.status='playing';
 const snapshot={...p};assert.equal(snapshot.currentTrack.id,song(1).id);assert.equal(snapshot.status,'playing');assert.equal(snapshot.playerChatId,10);assert.equal(snapshot.panelToken,p.panelToken);
 s.currentTrack=song(2);assert.equal(p.currentTrack.id,song(2).id);
});
test('revoked channel admins cannot control playback and their scheduled private updates are locked',async t=>{
 const h=setup(t),p=await h.open();h.members.set('-10011:10','member');
 await assert.rejects(h.control(p,'pause'),e=>e.code==='ADMIN_ONLY');
 h.app.music.channelPanels.membershipTtlMs=0;await h.app.musicQueueManager.updatePlayerCard(-10011);
 assert.equal(p.panelActive,false);assert.match(h.edits.at(-1).text,/locked/);assert.equal(h.calls.filter(x=>x[0]==='pause').length,0);
});
test('restoring admin membership restores the original private dashboard instead of leaving a locked stale card',async t=>{
 const h=setup(t),p=await h.open();h.members.set('-10011:10','member');h.app.music.channelPanels.membershipTtlMs=0;await h.app.musicQueueManager.updatePlayerCard(-10011);
 h.members.set('-10011:10','administrator');const reopened=await h.open();assert.equal(reopened.screenMessageId,p.screenMessageId);assert.ok(h.edits.at(-1).rich);assert.equal(reopened.panelActive,true);
});
test('private pinning uses the private message, never channel pin rights or the channel itself',async t=>{
 const h=setup(t),p=await h.open();await h.control(p,'pin');assert.ok(h.pins.every(x=>x.chat_id===10));assert.equal(h.pins.filter(x=>x.method==='pinChatMessage').length,2);
});
test('group queue additions, dashboard access and playlist loads require admin rights while downloads remain public',async t=>{
 const h=setup(t),member={...h.ctx(12),chatId:-555};await assert.rejects(h.app.music.startSearch(member,'song','queue'),e=>e.code==='ADMIN_ONLY');
 await assert.rejects(h.app.music.player(member),e=>e.code==='ADMIN_ONLY');
 h.app.music.search={create:()=>({}),page:async()=>{}};h.app.music.rates.clear();await h.app.music.startSearch(member,'song','download');
});
test('channel Add tracks prompt preserves its original destination after the private DM binding changes',async t=>{
 const h=setup(t),p=await h.open(),rich=h.screen.renderPlayer(p),button=rich.blocks.flatMap(b=>b.buttons||[]).find(b=>b.text==='Add tracks'||b.text==='Add music / video'),d=decodeCallback(button.callback_data);
 await h.open(10,-10022);await h.screen.handle({...h.ctx(),messageId:p.screenMessageId,query:{}},d.action,d.args);
 assert.equal(h.app.sm.context('10').panelToken,p.panelToken);
 let target;h.app.music.startSearch=async(ctx)=>{target=h.app.music.destination(ctx);return{id:'s',pages:[{items:[],provider:'fixture'}],index:0,query:'song',selected:new Map(),mode:'queue',revision:0};};
 await h.app.sm.handleMessage('10',{text:'song artist',message_id:999},h.ctx());assert.equal(target,-10011);
});
test('closing one administrator dashboard never stops shared playback or affects another admin panel',async t=>{
 const h=setup(t),a=await h.open(10),b=await h.open(11);await h.app.musicQueueManager.addMany(-10011,[song(1)]);
 assert.equal(await h.app.music.channelPanels.close(h.ctx(),-10011),true);assert.equal(b.status,'playing');assert.equal(h.app.music.channelPanels.panels.size,1);assert.equal(h.calls.filter(x=>x[0]==='stop').length,0);
});
test('global and custom-prefix command menus preserve unrelated commands and expose mutations only in admin/private scopes',()=>{
 const base=[{command:'game',description:'Existing games'},{command:'play',description:'old misleading quality'}];
 const publicMenu=withMusicCommands(base),admin=withMusicCommands(base,{admin:true}),privateMenu=withMusicCommands(base,{privateChat:true}),custom=withMusicCommands(base,{admin:true,prefix:'!'});
 assert.ok(publicMenu.some(c=>c.command==='game'));assert.ok(publicMenu.some(c=>c.command==='play'));assert.ok(!publicMenu.some(c=>c.command==='addq'));
 for(const c of ADMIN_MUSIC_COMMANDS)assert.ok(admin.some(x=>x.command===c.command));assert.ok(privateMenu.some(c=>c.command==='channel'));
 assert.ok(custom.find(c=>c.command==='addq').description.startsWith('[!addq]'));assert.ok(!JSON.stringify(custom).includes('320k'));
});
test('actual command registration publishes separate group/admin scopes and custom-prefix admin scopes',async()=>{
 const calls=[],controller=new TelegramController({api:{call:async(method,params)=>{calls.push({method,...params});}},db:{},settings:{get:()=>[]},sm:new StateMachine(),screens:new Map()});
 await controller.registerCommands();const ordinary=calls.find(c=>c.scope.type==='all_group_chats'),admin=calls.find(c=>c.scope.type==='all_chat_administrators');assert.ok(!ordinary.commands.some(c=>c.command==='pause'));assert.ok(admin.commands.some(c=>c.command==='pause'));
 calls.length=0;await controller.updateCommandsForChat(-555,'!');assert.ok(calls.find(c=>c.scope.type==='chat_administrators').commands.some(c=>c.command==='addq'));
 calls.length=0;await controller.updateCommandsForChat(-555,'/');assert.deepEqual(calls.map(c=>c.scope.type),['chat','chat_administrators']);
});


test('closed-private bot admits verified channel admins only to scoped music, not AI or owner account management',async t=>{
 const h=setup(t),db=new Database(':memory:');t.after(()=>db.close());
 const settings=new SettingsManager(db,{env:{OWNER_IDS:'1000'}});h.app.settings=settings;h.app.db=db;
 h.api.answerCallbackQuery=async()=>true;
 const c=new TelegramController({api:h.api,db,settings,sm:h.app.sm,screens:h.app.screens,app:h.app});
 const from={id:10,is_bot:false,first_name:'Admin'},chat={id:10,type:'private'};
 assert.equal(c.isAllowed(10).ok,false);
 await c.handleUpdate({message:{message_id:1,from,chat,text:'/channel @onechannel'}});
 const panel=h.app.music.channelPanels.find(h.ctx(),-10011);assert.ok(panel?.screenMessageId);
 const count=h.sent.length;
 await c.handleUpdate({message:{message_id:2,from,chat,text:'Discuss this private AI topic'}});
 await c.handleUpdate({message:{message_id:3,from,chat,text:'/accounts list'}});assert.equal(h.sent.length,count);
 await h.app.musicQueueManager.addMany(-10011,[song(1)]);
 const p=h.app.music.channelPanels.state(panel),pause=h.screen.renderPlayer(p).blocks.flatMap(b=>b.buttons||[]).find(b=>b.text==='Pause VC');h.app.music.rates.clear();
 await c.handleUpdate({callback_query:{id:'actual-shaped-callback',from,message:{message_id:p.screenMessageId,chat,from:{id:99,is_bot:true}},data:pause.callback_data}});
 assert.equal(p.status,'paused');assert.equal(c.isAllowed(10).ok,false);
});

test('replying with a title or add-track intent to a private channel dashboard opens selection for that exact channel',async t=>{
 const h=setup(t),a=await h.open(10,-10011);await h.open(10,-10022);const requests=[];
 h.app.music.startSearch=async(ctx,query,mode)=>{requests.push({destination:h.app.music.destination(ctx),query,mode});return{id:'search',query,mode,pages:[{items:[],provider:'fixture'}],index:0,revision:0,selected:new Map()};};
 for(const text of ['Artist and recording','add track Artist and recording','queue Artist and recording','/addq Artist and recording'])assert.equal(await h.screen.handlePlayerReply(h.ctx(),{text,reply_to_message:{message_id:a.screenMessageId,from:{id:99}}}),true);
 assert.ok(requests.every(x=>x.destination===-10011&&['queue','video'].includes(x.mode)));assert.equal(requests[1].query,'Artist and recording');assert.equal(h.calls.length,0);
});
test('play replies retain standalone-download semantics rather than accidentally queueing to the channel',async t=>{
 const h=setup(t),p=await h.open();let mode;
 h.app.music.startSearch=async(_ctx,query,m)=>{mode=m;return{id:'search',query,mode:m,pages:[{items:[],provider:'fixture'}],index:0,revision:0,selected:new Map()};};
 await h.screen.handlePlayerReply(h.ctx(),{text:'play Artist recording',reply_to_message:{message_id:p.screenMessageId,from:{id:99}}});assert.equal(mode,'download');assert.equal(h.calls.length,0);
});
test('a revoked admin or a reply to another bot/user cannot turn a private panel reply into queue mutation',async t=>{
 const h=setup(t),p=await h.open();let searches=0;h.app.music.startSearch=async()=>{searches++;throw Error('must not search');};
 assert.equal(await h.screen.handlePlayerReply(h.ctx(),{text:'add song',reply_to_message:{message_id:p.screenMessageId,from:{id:98}}}),false);
 h.members.set('-10011:10','member');assert.equal(await h.screen.handlePlayerReply(h.ctx(),{text:'add song',reply_to_message:{message_id:p.screenMessageId,from:{id:99}}}),true);assert.equal(searches,0);
});
test('closed-private controller routes a real-shaped bare dashboard reply to music selection, not AI',async t=>{
 const h=setup(t),db=new Database(':memory:');t.after(()=>db.close());const settings=new SettingsManager(db,{env:{OWNER_IDS:'1000'}});h.app.settings=settings;h.app.db=db;
 const panel=await h.open();let selectedTarget;h.app.music.startSearch=async(ctx,query,mode)=>{selectedTarget=h.app.music.destination(ctx);return{id:'search',query,mode,pages:[{items:[],provider:'fixture'}],index:0,revision:0,selected:new Map()};};
 const c=new TelegramController({api:h.api,db,settings,sm:h.app.sm,screens:h.app.screens,app:h.app});
 await c.handleUpdate({message:{message_id:42,from:{id:10,is_bot:false,first_name:'Admin'},chat:{id:10,type:'private'},text:'Artist recording',reply_to_message:{message_id:panel.screenMessageId,from:{id:99,is_bot:true}}}});assert.equal(selectedTarget,-10011);assert.equal(c.isAllowed(10).ok,false);
});

test('real reply → search → pick → submit remains canonical when another DM binding loses permissions',async t=>{
 const h=setup(t),db=new Database(':memory:');t.after(()=>db.close());const settings=new SettingsManager(db,{env:{OWNER_IDS:'1000'}});h.app.settings=settings;h.app.db=db;h.api.answerCallbackQuery=async()=>true;
 h.app.music.search=new SearchSessions({providers:{search:async()=>({items:[song(7)],provider:'fixture',nextOffset:null})}});
 const c=new TelegramController({api:h.api,db,settings,sm:h.app.sm,screens:h.app.screens,app:h.app}),panel=await h.open(),from={id:10,is_bot:false,first_name:'Admin'},chat={id:10,type:'private'};
 h.app.music.rates.clear();await c.handleUpdate({message:{message_id:42,from,chat,text:'Artist recording',reply_to_message:{message_id:panel.screenMessageId,from:{id:99,is_bot:true}}}});
 const search=[...h.app.music.search.sessions.values()][0];assert.ok(search);assert.equal(search.destination,-10011);assert.equal(search.destinationTitle,'Channel One');assert.equal(h.calls.length,0,'Search alone must not broadcast a guessed recording');
 await h.open(10,-10022);h.members.set('-10022:10','member');
 for(const [action,args] of [['pick',[0]],['submit',[]]]){h.app.music.rates.clear();await c.handleUpdate({callback_query:{id:action,from,message:{message_id:search.messageId,chat,from:{id:99,is_bot:true}},data:encodeCallback('music',action,search.id,search.revision,...args)}});}
 assert.equal(search.consumed,true);assert.deepEqual(h.calls.filter(x=>x[0]==='play'),[['play',-10011]]);assert.equal(h.app.musicQueueManager.getSession(-10011).currentTrack.id,song(7).id);assert.equal(h.app.musicQueueManager.getSession(-10022).currentTrack,null);
});
test('closed-private ForceReply targets its original permitted channel even when a later DM binding is revoked',async t=>{
 const h=setup(t),db=new Database(':memory:');t.after(()=>db.close());const settings=new SettingsManager(db,{env:{OWNER_IDS:'1000'}});h.app.settings=settings;h.app.db=db;
 const p=await h.open(),prompt=h.screen.renderPlayer(p).blocks.flatMap(b=>b.buttons||[]).find(b=>b.text==='Add tracks'||b.text==='Add music / video'),d=decodeCallback(prompt.callback_data);await h.screen.handle({...h.ctx(),messageId:p.screenMessageId},d.action,d.args);
 await h.open(10,-10022);h.members.set('-10022:10','member');let target;
 h.app.music.startSearch=async(ctx,query,mode)=>{target=h.app.music.destination(ctx);return{id:'s',query,mode,pages:[{items:[],provider:'fixture'}],index:0,revision:0,selected:new Map()};};
 const c=new TelegramController({api:h.api,db,settings,sm:h.app.sm,screens:h.app.screens,app:h.app});await c.handleUpdate({message:{message_id:44,from:{id:10,is_bot:false,first_name:'Admin'},chat:{id:10,type:'private'},text:'Artist recording'}});assert.equal(target,-10011);assert.equal(h.app.sm.context(10).panelToken,undefined);
});
test('public-private dashboard replies cannot bypass the existing ForceJoin gate',async t=>{
 const h=setup(t),db=new Database(':memory:');t.after(()=>db.close());const settings=new SettingsManager(db,{env:{OWNER_IDS:'1000'}});h.app.settings=settings;h.app.db=db;await settings.set('security.publicAccess',true);
 const p=await h.open();setGlobalForceJoinChannels(db,[{id:-10033,title:'Required channel',username:'required',inviteLink:'https://t.me/required'}]);h.members.set('-10033:10','left');let searches=0;h.app.music.startSearch=async()=>{searches++;};
 const c=new TelegramController({api:h.api,db,settings,sm:h.app.sm,screens:h.app.screens,app:h.app});await c.handleUpdate({message:{message_id:45,from:{id:10,is_bot:false,first_name:'Admin'},chat:{id:10,type:'private'},text:'Artist recording',reply_to_message:{message_id:p.screenMessageId,from:{id:99,is_bot:true}}}});assert.equal(searches,0);assert.ok(h.sent.some(x=>JSON.stringify(x.rich||'').includes('MEMBERSHIP REQUIRED')));
});

test('group dashboard replies enforce admin additions but explicit play remains public download intent',async t=>{
 const h=setup(t),s=h.app.musicQueueManager.getSession(-555);s.screenMessageId=501;h.api.editMessageRich=async()=>({message_id:502});const modes=[];
 h.app.music.startSearch=async(_ctx,query,mode)=>{modes.push(mode);return{id:'s',query,mode,pages:[{items:[],provider:'fixture'}],index:0,revision:0,selected:new Map()};};
 const reply={message_id:501,from:{id:99,is_bot:true}},member={...h.ctx(12),chatId:-555},admin={...h.ctx(),chatId:-555};
 await h.screen.handlePlayerReply(member,{text:'Artist recording',reply_to_message:reply});assert.equal(modes.length,0);assert.match(h.sent.at(-1).text,/administrators/);
 await h.screen.handlePlayerReply(member,{text:'play Artist recording',reply_to_message:reply});await h.screen.handlePlayerReply(admin,{text:'add track Artist recording',reply_to_message:reply});assert.deepEqual(modes,['download','queue']);assert.equal(h.calls.length,0);
});
test('closed-private channel music honors existing personal custom command prefixes',async t=>{
 const h=setup(t);h.app.db.getUserPrefix=()=>'!';const ctx=h.ctx(),source={text:'!channel @onechannel'};
 assert.equal(h.screen.privateChannelRequest(ctx,source),true);assert.equal(await h.screen.handlePrivateChannel(ctx,source),true);assert.ok(h.app.music.channelPanels.find(ctx,-10011));
});

test('repeated /channel command always posts a fresh dashboard at the bottom of the chat and unpins old',async t=>{
 const h=setup(t),db=new Database(':memory:');t.after(()=>db.close());
 const settings=new SettingsManager(db,{env:{OWNER_IDS:'1000'}});h.app.settings=settings;h.app.db=db;
 const p1=await h.open(10,-10011);
 assert.ok(p1.screenMessageId);
 const firstId=p1.screenMessageId;
 assert.equal(h.sent.length,1);
 h.app.music.rates.clear();
 // Simulate user sending /channel @onechannel again later in DM
 const c=new TelegramController({api:h.api,db,settings,sm:h.app.sm,screens:h.app.screens,app:h.app});
 const from={id:10,is_bot:false,first_name:'Admin'},chat={id:10,type:'private'};
 await c.handleUpdate({message:{message_id:888,from,chat,text:'/channel @onechannel'}});
 assert.equal(h.sent.length,2);
 const p2=h.app.music.channelPanels.find(h.ctx(10),-10011);
 assert.notEqual(p2.screenMessageId,firstId);
 assert.ok(h.pins.some(p=>p.method==='unpinChatMessage'&&p.message_id===firstId));
});

