import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/core/db.js';
import { SettingsManager } from '../src/config/settings.js';
import { StateMachine, States } from '../src/core/stateMachine.js';
import { TelegramController } from '../src/telegram/bot.js';
import {
  listVerifiedAdminChannels,
  listCrossBotVerifiedTargets,
  verifyBotCanPostInTarget
} from '../src/telegram/permissions.js';
import {
  utf16EntitiesToHtml,
  extractBroadcastItemFromMessage,
  groupBroadcastItems,
  deliverBroadcastToTarget
} from '../src/telegram/broadcastEngine.js';
import { createBroadcastScreen } from '../src/telegram/screens/broadcast.js';
import { createDashboardScreen } from '../src/telegram/screens/dashboard.js';
import { MultiBotManager } from '../src/telegram/multiBotManager.js';

function collectButtons(rich) {
  return (rich?.blocks || [])
    .filter((b) => b.type === 'buttons')
    .flatMap((b) => b.buttons || []);
}

function makeBotApi(botId, username, {
  chats = new Map(),
  members = new Map(),
  files = new Map(),
  failRichMessage = false
} = {}) {
  const sent = [];
  let msgSeq = 100;

  return {
    me: { id: botId, username, first_name: username, is_bot: true },
    botUsername: username,
    sent,
    async getMe() { return this.me; },
    async getChat(chatId) {
      const c = chats.get(Number(chatId));
      if (!c) throw Object.assign(new Error('Telegram getChat: Bad Request: chat not found'), { error_code: 400, description: 'Bad Request: chat not found' });
      return c;
    },
    async getChatMember(chatId, userId) {
      const key = `${Number(chatId)}:${Number(userId)}`;
      if (members.has(key)) return members.get(key);
      return { status: 'left', user: { id: Number(userId) } };
    },
    async getFile(fileId) {
      const entry = files.get(String(fileId));
      if (!entry) throw new Error(`File not found: ${fileId}`);
      return { file_path: entry.path };
    },
    async downloadFile(filePath) {
      for (const entry of files.values()) {
        if (entry.path === filePath) return entry.buffer;
      }
      throw new Error(`Path not found: ${filePath}`);
    },
    async sendMessage(chatId, text, extra = {}) {
      const rec = { method: 'sendMessage', botId, chatId: Number(chatId), text, extra, message_id: ++msgSeq };
      sent.push(rec);
      return rec;
    },
    async sendRichMessage(chatId, rich, extra = {}, filesArg = null) {
      if (failRichMessage) throw new Error('Telegram sendRichMessage: 404 Not Found');
      const rec = { method: 'sendRichMessage', botId, chatId: Number(chatId), rich, extra, files: filesArg, message_id: ++msgSeq };
      sent.push(rec);
      return rec;
    },
    async editMessageRich(chatId, messageId, rich, extra = {}) {
      const rec = { method: 'editMessageRich', botId, chatId: Number(chatId), message_id: messageId, rich, extra };
      sent.push(rec);
      return rec;
    },
    async sendPhoto(chatId, photo, extra = {}) {
      const rec = { method: 'sendPhoto', botId, chatId: Number(chatId), photo, extra, message_id: ++msgSeq };
      sent.push(rec);
      return rec;
    },
    async sendVideo(chatId, video, extra = {}) {
      const rec = { method: 'sendVideo', botId, chatId: Number(chatId), video, extra, message_id: ++msgSeq };
      sent.push(rec);
      return rec;
    },
    async sendAudio(chatId, audio, extra = {}) {
      const rec = { method: 'sendAudio', botId, chatId: Number(chatId), audio, extra, message_id: ++msgSeq };
      sent.push(rec);
      return rec;
    },
    async sendDocument(chatId, document, extra = {}) {
      const rec = { method: 'sendDocument', botId, chatId: Number(chatId), document, extra, message_id: ++msgSeq };
      sent.push(rec);
      return rec;
    },
    async sendMediaGroup(chatId, media, extra = {}, filesArg = null) {
      const rec = { method: 'sendMediaGroup', botId, chatId: Number(chatId), media, extra, files: filesArg, message_id: ++msgSeq };
      sent.push(rec);
      return [rec];
    },
    async sendPoll(chatId, question, options, extra = {}) {
      const rec = { method: 'sendPoll', botId, chatId: Number(chatId), question, options, extra, message_id: ++msgSeq };
      sent.push(rec);
      return rec;
    },
    async answerCallbackQuery() { return true; },
    async deleteMessage() { return true; }
  };
}

test('Channel & Group live verification excludes unpostable channels and muted/left GCs with per-bot isolation', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  settings.values.general.ownerIds = [100];

  const chats = new Map([
    [-1001, { id: -1001, type: 'channel', title: 'Main Postable CH', username: 'main_ok' }],
    [-1002, { id: -1002, type: 'channel', title: 'Main NoPost Right CH', username: 'no_post' }],
    [-1003, { id: -1003, type: 'channel', title: 'Clone Only CH', username: 'clone_ok' }],
    [-2001, { id: -2001, type: 'supergroup', title: 'Active Squad GC' }],
    [-2002, { id: -2002, type: 'supergroup', title: 'Muted Bot GC' }]
  ]);

  db.recordTelegramChannel({ channel_id: -1001, title: 'Main Postable CH', username: 'main_ok', chat_type: 'channel', can_post: 1, added_by: 100 });
  db.recordTelegramChannel({ channel_id: -1002, title: 'Main NoPost Right CH', username: 'no_post', chat_type: 'channel', can_post: 1, added_by: 100 });
  db.recordTelegramChannel({ channel_id: -1003, title: 'Clone Only CH', username: 'clone_ok', chat_type: 'channel', can_post: 1, added_by: 200 });
  db.recordTelegramChannel({ channel_id: -2001, title: 'Active Squad GC', chat_type: 'supergroup', can_post: 1, added_by: 100 });
  db.recordTelegramChannel({ channel_id: -2002, title: 'Muted Bot GC', chat_type: 'supergroup', can_post: 1, added_by: 100 });

  const mainMembers = new Map([
    ['-1001:10', { status: 'administrator', can_post_messages: true }],
    ['-1002:10', { status: 'administrator', can_post_messages: false }],
    ['-1003:10', { status: 'left' }],
    ['-2001:10', { status: 'member' }],
    ['-2002:10', { status: 'restricted', can_send_messages: false }]
  ]);
  const cloneMembers = new Map([
    ['-1003:20', { status: 'administrator', can_post_messages: true }],
    ['-2001:20', { status: 'administrator' }]
  ]);

  const mainApi = makeBotApi(10, 'pappy_agent', { chats, members: mainMembers });
  const cloneApi = makeBotApi(20, 'clone_bot', { chats, members: cloneMembers });

  // Main bot channels-only: sees ONLY -1001 (excludes -1002 lacking post rights and -1003 where main isn't admin)
  const mainChannelsOnly = await listVerifiedAdminChannels({
    db, api: mainApi, settings, userId: 100, includeGroups: false, forceRefresh: true
  });
  assert.deepEqual(mainChannelsOnly.map((c) => c.channel_id), [-1001]);

  // Main bot with GCs: sees -1001 + -2001 (excludes muted -2002!)
  const mainWithGcs = await listVerifiedAdminChannels({
    db, api: mainApi, settings, userId: 100, includeGroups: true, forceRefresh: true
  });
  assert.deepEqual(mainWithGcs.map((c) => c.channel_id).sort((a, b) => a - b), [-2001, -1001]);

  // Clone bot kicked via my_chat_member on -2001 does NOT wipe -2001 for Main Bot!
  const sm = new StateMachine({ db });
  const cloneCtrl = new TelegramController({ api: cloneApi, db, settings, stateMachine: sm, botContext: { isClone: true, botId: 1, botUsername: 'clone_bot' } });
  await cloneCtrl.handleUpdate({
    my_chat_member: {
      chat: { id: -2001, type: 'supergroup', title: 'Active Squad GC' },
      from: { id: 100, first_name: 'Owner' },
      new_chat_member: { status: 'kicked', user: { id: 20, is_bot: true, username: 'clone_bot' } }
    }
  });
  assert.ok(db.getTelegramChannel(-2001), 'Main bot still has -2001 in tg_channels when Clone B is kicked');
  assert.equal(db.getBotChannelVerification('20', -2001)?.can_post, 0);

  db.close();
});

test('Broadcast Engine preserves Telegram entities, builds photo/audio albums cleanly, and transfers media cross-bot', async () => {
  // 1. Entities -> HTML including custom_emoji + text_link + spoiler + safe escaping
  const html = utf16EntitiesToHtml('Hi <user> check Link & ✨!', [
    { offset: 0, length: 9, type: 'bold' },
    { offset: 16, length: 4, type: 'text_link', url: 'https://t.me/test' },
    { offset: 23, length: 1, type: 'custom_emoji', custom_emoji_id: '55512345' }
  ]);
  assert.match(html, /^<b>Hi &lt;user&gt;<\/b> check <a href="https:\/\/t\.me\/test">Link<\/a> &amp; <tg-emoji emoji-id="55512345">✨<\/tg-emoji>!$/);

  // 2. Grouping multi-photo album + audio tracks + standalone poll
  const photoBuf1 = Buffer.from('photo-one');
  const photoBuf2 = Buffer.from('photo-two');
  const audioBuf1 = Buffer.from('mp3-one');
  const audioBuf2 = Buffer.from('mp3-two');

  const sourceApi = makeBotApi(10, 'main_bot', {
    files: new Map([
      ['main_p1', { path: 'photos/1.jpg', buffer: photoBuf1 }],
      ['main_p2', { path: 'photos/2.jpg', buffer: photoBuf2 }],
      ['main_a1', { path: 'audio/1.mp3', buffer: audioBuf1 }],
      ['main_a2', { path: 'audio/2.mp3', buffer: audioBuf2 }]
    ])
  });
  const cloneApi = makeBotApi(20, 'clone_bot', { failRichMessage: true });

  const items = [
    extractBroadcastItemFromMessage({
      media_group_id: 'mg_1',
      photo: [{ file_id: 'main_p1', width: 800, height: 800 }],
      caption: 'Album cap'
    }, { sourceApi, sourceBotId: 10 }),
    extractBroadcastItemFromMessage({
      media_group_id: 'mg_1',
      photo: [{ file_id: 'main_p2', width: 800, height: 800 }]
    }, { sourceApi, sourceBotId: 10 }),
    extractBroadcastItemFromMessage({
      audio: { file_id: 'main_a1', title: 'Track 1', performer: 'Lancy', duration: 120 }
    }, { sourceApi, sourceBotId: 10 }),
    extractBroadcastItemFromMessage({
      audio: { file_id: 'main_a2', title: 'Track 2', performer: 'Lancy', duration: 140 }
    }, { sourceApi, sourceBotId: 10 }),
    extractBroadcastItemFromMessage({
      poll: { question: 'Best drop?', options: [{ text: 'Fire' }, { text: 'Chill' }] }
    }, { sourceApi, sourceBotId: 10 })
  ];

  const batches = groupBroadcastItems(items);
  assert.equal(batches.length, 3);
  assert.equal(batches[0].type, 'album');
  assert.equal(batches[0].family, 'visual');
  assert.equal(batches[1].type, 'album');
  assert.equal(batches[1].family, 'audio');
  assert.equal(batches[2].type, 'single');
  assert.equal(batches[2].item.kind, 'poll');

  // 3. Deliver from Main Bot captured items THROUGH Clone Bot (cross-bot upload buffers!)
  await deliverBroadcastToTarget({
    targetApi: cloneApi,
    targetBotId: 20,
    chatId: -100999,
    items,
    richCard: true,
    bufferCache: new Map()
  });

  const mediaGroups = cloneApi.sent.filter((s) => s.method === 'sendMediaGroup');
  assert.equal(mediaGroups.length, 2, 'Visual album + audio album delivered via sendMediaGroup');
  assert.equal(mediaGroups[0].media[0].media, 'attach://album_0');
  assert.ok(Buffer.isBuffer(mediaGroups[0].files.album_0.buffer));
  assert.match(mediaGroups[0].media[0].caption, /<blockquote>Album cap<\/blockquote>/);
  assert.equal(mediaGroups[1].media[0].type, 'audio');
  assert.ok(Buffer.isBuffer(mediaGroups[1].files.album_0.buffer));

  const pollSend = cloneApi.sent.find((s) => s.method === 'sendPoll');
  assert.equal(pollSend.question, 'Best drop?');
});

test('Platform Owner accesses ALL clones + clone channels + GCs and launches verified broadcast through Clone Bot', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  settings.values.general.ownerIds = [100]; // Main Owner = 100
  const sm = new StateMachine({ db });

  // Two cloned bots: Clone A owned by user 200, Clone B owned by Main Owner 100
  db.run("INSERT INTO cloned_bots (id, owner_tg_id, bot_name, bot_username, token, status) VALUES (1, 200, 'Alpha', 'alpha_clone_bot', '111:AAA', 'active')");
  db.run("INSERT INTO cloned_bots (id, owner_tg_id, bot_name, bot_username, token, status) VALUES (2, 100, 'Beta', 'beta_clone_bot', '222:BBB', 'active')");

  const chats = new Map([
    [-10010, { id: -10010, type: 'channel', title: 'Main Channel', username: 'main_ch' }],
    [-10020, { id: -10020, type: 'channel', title: 'Alpha Clone Channel', username: 'alpha_ch' }],
    [-30010, { id: -30010, type: 'supergroup', title: 'Main Group Chat' }],
    [-30020, { id: -30020, type: 'group', title: 'Alpha Clone Group Chat' }],
    [-10099, { id: -10099, type: 'channel', title: 'Revoked Channel', username: 'revoked_ch' }]
  ]);

  db.recordTelegramChannel({ channel_id: -10010, title: 'Main Channel', username: 'main_ch', chat_type: 'channel', can_post: 1, added_by: 100 });
  db.recordTelegramChannel({ channel_id: -10020, title: 'Alpha Clone Channel', username: 'alpha_ch', chat_type: 'channel', can_post: 1, added_by: 200 });
  db.recordTelegramChannel({ channel_id: -30010, title: 'Main Group Chat', chat_type: 'supergroup', can_post: 1, added_by: 100 });
  db.recordTelegramChannel({ channel_id: -30020, title: 'Alpha Clone Group Chat', chat_type: 'group', can_post: 1, added_by: 200 });
  db.recordTelegramChannel({ channel_id: -10099, title: 'Revoked Channel', username: 'revoked_ch', chat_type: 'channel', can_post: 1, added_by: 100 });

  const mainApi = makeBotApi(1, 'pappy_agent', {
    chats,
    members: new Map([
      ['-10010:1', { status: 'administrator', can_post_messages: true }],
      ['-30010:1', { status: 'member' }],
      ['-10099:1', { status: 'administrator', can_post_messages: false }]
    ]),
    files: new Map([['main_photo', { path: 'p.jpg', buffer: Buffer.from('img-bytes') }]])
  });
  const alphaApi = makeBotApi(111, 'alpha_clone_bot', {
    chats,
    members: new Map([
      ['-10020:111', { status: 'administrator', can_post_messages: true }],
      ['-30020:111', { status: 'administrator' }]
    ])
  });
  const betaApi = makeBotApi(222, 'beta_clone_bot', { chats, members: new Map() });

  const app = {
    db,
    settings,
    sm,
    telegram: { api: mainApi, botUsername: 'pappy_agent' },
    multiBotManager: new MultiBotManager({ app: { telegram: { api: mainApi } }, db, settings })
  };
  app.multiBotManager.runningBots.set(1, { api: alphaApi, controller: { isOwner: (id) => Number(id) === 200 } });
  app.multiBotManager.runningBots.set(2, { api: betaApi, controller: { isOwner: (id) => Number(id) === 100 } });

  // Dashboard renders Broadcast Studio button
  const dashScreen = createDashboardScreen({ app });
  let dashRich = null;
  await dashScreen.open({
    tgId: '100',
    chatId: 100,
    db,
    settings,
    isGroup: false,
    editScreen: async (r) => { dashRich = r; return r; },
    replyRich: async (r) => { dashRich = r; return r; }
  });
  assert.ok(collectButtons(dashRich).some((b) => String(b.callback_data).includes('broadcast:open')), 'Dashboard displays Broadcast Studio button');

  // Main Owner cross-bot discovery includes Main + Alpha clone targets (channels + GCs), and excludes Revoked Channel!
  const crossOwner = await listCrossBotVerifiedTargets({
    db, settings, multiBotManager: app.multiBotManager, mainApi, userId: 100, includeGroups: true, forceRefresh: true
  });
  assert.deepEqual(crossOwner.targets.map((t) => t.channel_id).sort((a, b) => a - b), [-30020, -30010, -10020, -10010]);
  assert.equal(crossOwner.targets.some((t) => t.channel_id === -10099), false, 'Revoked channel must be hidden');

  // Non-platform Clone Owner 200 does NOT see Main Owner's private targets (-10010, -30010)
  const crossUser200 = await listCrossBotVerifiedTargets({
    db, settings, multiBotManager: app.multiBotManager, mainApi, userId: 200, includeGroups: true, forceRefresh: true
  });
  assert.deepEqual(crossUser200.targets.map((t) => t.channel_id).sort((a, b) => a - b), [-30020, -10020]);

  // E2E Broadcast Screen: Owner 100 selects Alpha Clone Bot, stacks a photo (received on Main Bot!), selects -10020 & -30020, and launches!
  const broadcastScreen = createBroadcastScreen({ app });
  broadcastScreen.registerStateHandlers(sm);
  const screens = new Map([['broadcast', broadcastScreen]]);
  const noopCtx = (extra = {}) => ({
    tgId: '100',
    chatId: 100,
    api: mainApi,
    sm,
    screens,
    editScreen: async (r) => r,
    replyRich: async (r) => r,
    ...extra
  });

  await broadcastScreen.handle(noopCtx(), 'open_bot', ['1']); // Select clone row id 1 (Alpha)
  await broadcastScreen.handle(noopCtx(), 'compose');
  const handler = sm.handlers.get(States.BROADCAST_COMPOSE);
  await handler.onMessage({ tgId: '100', chatId: 100, api: mainApi, sm }, {
    chat: { id: 100, type: 'private' },
    photo: [{ file_id: 'main_photo', width: 500, height: 500 }],
    caption: 'Hello from Main Owner through Clone!'
  });
  await broadcastScreen.handle(noopCtx(), 'select_all');
  const report = await broadcastScreen.handle(noopCtx(), 'launch');

  const alphaPhotos = alphaApi.sent.filter((s) => s.method === 'sendPhoto');
  assert.equal(alphaPhotos.length, 2, 'Alpha clone delivered photo to both Alpha Channel and Alpha Group Chat');
  assert.ok(Buffer.isBuffer(alphaPhotos[0].photo), 'Cross-bot photo uploaded as Buffer to Alpha Clone');
  assert.deepEqual(alphaPhotos.map((s) => s.chatId).sort((a, b) => a - b), [-30020, -10020]);
  assert.ok(report, 'Broadcast report returned');

  // Surrogate-pair fancy Unicode titles in broadcast:targets must NEVER split UTF-16 pairs or emit invalid UTF-8
  const fancyTitle = "🧸 𝕬𝖉𝖎𝖓𝖆𝕰𝖓𝖎𝖌𝖒𝖆'𝖘 𝖂𝖔𝖗𝖑𝖉 🍫";
  chats.set(-30099, { id: -30099, type: 'supergroup', title: fancyTitle });
  db.recordTelegramChannel({ channel_id: -30099, title: fancyTitle, chat_type: 'supergroup', can_post: 1, added_by: 100 });
  alphaApi.me = { id: 111, username: 'alpha_clone_bot', first_name: 'Alpha', is_bot: true };
  const prevGetChatMember = alphaApi.getChatMember;
  alphaApi.getChatMember = async (cid, uid) => (Number(cid) === -30099 && Number(uid) === 111
    ? { status: 'administrator' }
    : prevGetChatMember.call(alphaApi, cid, uid));

  const targetsRich = await broadcastScreen.handle(noopCtx(), 'targets');
  const serializedTargets = JSON.stringify(targetsRich);
  assert.equal(serializedTargets.isWellFormed(), true, 'broadcast:targets RichMessage must be valid UTF-8 without split surrogates');

  db.close();
});
