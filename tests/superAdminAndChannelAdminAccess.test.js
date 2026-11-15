import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from '../src/core/db.js';
import { SettingsManager } from '../src/config/settings.js';
import { StateMachine } from '../src/core/stateMachine.js';
import { TelegramController } from '../src/telegram/bot.js';
import {
  getBotSuperAdminIds,
  isBotSuperAdmin,
  verifyChannelAdmin,
  isNativeChannelPost,
  listVerifiedAdminChannels
} from '../src/telegram/permissions.js';
import { setGlobalForceJoinChannels } from '../src/telegram/forceJoin.js';
import { QueueManager } from '../src/music/queueManager.js';
import { MusicService } from '../src/music/service.js';
import { isMusicOwner, isMusicSuperAdmin } from '../src/music/accounts.js';
import { createMusicScreen } from '../src/telegram/screens/music.js';
import { createChannelPostScreen } from '../src/telegram/screens/channelPost.js';
import { createAutoPostScreen } from '../src/telegram/screens/autoPost.js';
import { createNsfwScreen } from '../src/telegram/screens/nsfw.js';
import { encodeCallback } from '../src/telegram/rich.js';

function collectButtons(rich) {
  return (rich?.blocks || [])
    .filter((b) => b.type === 'buttons')
    .flatMap((b) => b.buttons || []);
}

function makeHarness(t, { env = {}, members = new Map(), chatTypes = new Map() } = {}) {
  let msgSeq = 1000;
  const sentMessages = [];
  const sentRich = [];
  const editedRich = [];
  const alerts = [];
  const registerCalls = [];

  const api = {
    botUsername: 'Lancy_easy_bot',
    me: { id: 999, username: 'Lancy_easy_bot', first_name: 'Lancy' },
    async getMe() { return this.me; },
    async setMyCommands(commands, scope) {
      registerCalls.push({ commands, scope });
      return true;
    },
    async getChat(chatId) {
      const id = Number(chatId);
      if (id > 0) return { id, type: 'private', first_name: `User${id}` };
      const type = chatTypes.get(id) || 'channel';
      return { id, type, title: type === 'channel' ? `Channel ${id}` : `Group ${id}`, username: `chat_${Math.abs(id)}` };
    },
    async getChatMember(chatId, userId) {
      const cid = Number(chatId);
      const uid = Number(userId);
      if (uid === 999) return { status: 'administrator', can_post_messages: true, user: this.me };
      const key = `${cid}:${uid}`;
      const entry = members.get(key) ?? members.get(uid);
      if (typeof entry === 'string') return { status: entry, user: { id: uid } };
      if (entry && typeof entry === 'object') return { user: { id: uid }, ...entry };
      return { status: 'member', user: { id: uid } };
    },
    async getChatAdministrators(chatId) {
      const cid = Number(chatId);
      const out = [];
      for (const [k, v] of members.entries()) {
        if (String(k).startsWith(`${cid}:`)) {
          const uid = Number(String(k).split(':')[1]);
          const rec = typeof v === 'string' ? { status: v } : v;
          if (['creator', 'administrator'].includes(rec?.status)) {
            out.push({ user: { id: uid }, ...rec });
          }
        }
      }
      return out;
    },
    async answerCallbackQuery(id, opts = {}) {
      alerts.push({ id, ...opts, showAlert: Boolean(opts.show_alert ?? opts.showAlert) });
      return true;
    },
    async deleteMessage() { return true; },
    async call() { return true; },
    async sendChatAction() { return true; },
    async sendMessage(chatId, text, extra = {}) {
      const message_id = ++msgSeq;
      sentMessages.push({ chatId: Number(chatId), message_id, text, extra });
      return { message_id, chat: { id: Number(chatId) } };
    },
    async sendRichMessage(chatId, rich, extra = {}, files = null) {
      const message_id = ++msgSeq;
      sentRich.push({ chatId: Number(chatId), message_id, rich, extra, files });
      return { message_id, chat: { id: Number(chatId) } };
    },
    async editMessageRich(chatId, message_id, rich, extra = {}, files = null) {
      editedRich.push({ chatId: Number(chatId), message_id, rich, extra, files });
      return { message_id, chat: { id: Number(chatId) } };
    }
  };

  return {
    api,
    sentMessages,
    sentRich,
    editedRich,
    alerts,
    registerCalls,
    async createApp(dir) {
      const db = new Database(join(dir, 'bot.db'));
      db.migrate();
      t.after(() => db.close());

      const settings = new SettingsManager(db, { env });
      const sm = new StateMachine();
      const app = {
        db,
        settings,
        sm,
        screens: new Map(),
        packs: { listPacks: () => ({ packs: [], total: 0 }), getPack: () => null },
        scheduler: { createSchedule: () => 1, getUserSchedules: () => [] },
        voiceClient: {
          async setup() { return { ok: true, account_alias: 'a1' }; },
          async play() { return { ok: true }; },
          async pause() { return { ok: true }; },
          async resume() { return { ok: true }; },
          async stop() { return { ok: true }; },
          async setVolume() { return { ok: true }; }
        }
      };
      app.musicQueueManager = new QueueManager({ app, voiceClient: app.voiceClient, db, pollMs: 0 });
      app.music = new MusicService({ app, accounts: { sync: async () => {} } });

      const musicScreen = createMusicScreen({ app });
      const channelPostScreen = createChannelPostScreen({ app });
      const autoPostScreen = createAutoPostScreen({ app });
      const nsfwScreen = createNsfwScreen({ app });

      app.screens.set('music', musicScreen);
      app.screens.set('channel_post', channelPostScreen);
      app.screens.set('autopost', autoPostScreen);
      app.screens.set('nsfw', nsfwScreen);

      musicScreen.registerStateHandlers?.(sm);
      nsfwScreen.registerStateHandlers?.(sm);

      const ctrl = new TelegramController({
        app,
        api,
        db,
        settings,
        stateMachine: sm,
        screens: app.screens,
        botContext: { botId: 0, isMain: true, ownerId: settings.get('general.ownerIds')?.[0] || 100 }
      });
      app.telegram = { api, controller: ctrl, botUsername: 'Lancy_easy_bot' };

      t.after(async () => {
        await musicScreen.cleanup();
        await app.music.previews.shutdown();
        await app.musicQueueManager.shutdown();
      });

      return { db, settings, sm, app, ctrl, musicScreen, channelPostScreen, autoPostScreen, nsfwScreen };
    }
  };
}

test('Bot Super Admins (OWNER_IDS + ADMIN_IDS/telegram.adminIds) can use all Lancy features while strict isOwner/accountCommand stay owner-only', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'lancy_superadmin_'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const members = new Map([
    ['-100999:200', 'left'],
    ['-100999:300', 'left'],
    ['-10050:200', 'member'],
    ['-10050:300', 'member']
  ]);
  const chatTypes = new Map([
    [-100999, 'channel'],
    [-10050, 'supergroup']
  ]);

  const h = makeHarness(t, {
    env: { OWNER_IDS: '100', ADMIN_IDS: '200' },
    members,
    chatTypes
  });
  const { db, settings, app, ctrl, nsfwScreen } = await h.createApp(dir);

  // Super admin resolution includes both OWNER_IDS and ADMIN_IDS
  assert.deepEqual([...getBotSuperAdminIds(settings)].sort((a, b) => a - b), [100, 200]);
  assert.equal(isBotSuperAdmin(settings, 200), true);
  assert.equal(ctrl.isOwner(200), false);
  assert.equal(ctrl.isMainOwner(200), false);
  assert.equal(ctrl.isSuperAdmin(200), true);
  assert.equal(isMusicOwner(app, 200), false);
  assert.equal(isMusicSuperAdmin(app, 200), true);
  assert.deepEqual(ctrl.isAllowed(200), { ok: true, role: 'admin' });

  // Closed private + Force-Join active: non-owner Super Admin 200 still bypasses Force-Join and closed gate
  await settings.set('security.publicAccess', false);
  setGlobalForceJoinChannels(db, [{ id: -100999, username: 'fjtest', title: 'FJ Gate' }]);

  await ctrl.handleUpdate({
    message: { message_id: 1, chat: { id: 200, type: 'private' }, from: { id: 200, first_name: 'SuperAdmin' }, text: '/admins' }
  });
  assert.ok(h.sentMessages.some((m) => m.chatId === 200 && /200/.test(m.text)));

  await ctrl.handleUpdate({
    message: { message_id: 2, chat: { id: 200, type: 'private' }, from: { id: 200, first_name: 'SuperAdmin' }, text: '/reloadcommands' }
  });
  assert.ok(h.sentMessages.some((m) => m.chatId === 200 && /Hot-reloaded command suggestions/i.test(m.text)));

  // Non-super-admin allowed user 300 still hits Force-Join gate when not joined
  await settings.set('security.allowedUsers', [300]);
  await ctrl.handleUpdate({
    message: { message_id: 3, chat: { id: 300, type: 'private' }, from: { id: 300, first_name: 'AllowedUser' }, text: '/admins' }
  });
  assert.equal(h.sentRich.some((m) => m.chatId === 300), true);
  assert.equal(h.sentMessages.some((m) => m.chatId === 300 && /200/.test(m.text)), false);

  // Main-owner-only commands stay restricted for non-owner super admin 200
  const beforeOwnerOnlyCount = h.sentMessages.length;
  await ctrl.handleUpdate({
    message: { message_id: 4, chat: { id: 200, type: 'private' }, from: { id: 200, first_name: 'SuperAdmin' }, text: '/addadmin 300' }
  });
  await ctrl.handleUpdate({
    message: { message_id: 5, chat: { id: 200, type: 'private' }, from: { id: 200, first_name: 'SuperAdmin' }, text: '/accounts list' }
  });
  assert.ok(h.sentMessages.slice(beforeOwnerOnlyCount).every((m) => !/Admin.*added/i.test(m.text)));
  await assert.rejects(
    app.music.accountCommand({ tgId: '200', chatId: 200, api: h.api }, ['list']),
    (e) => e.code === 'OWNER_ONLY'
  );

  // Group abilities for non-owner Super Admin 200 in -10050 (even when status === 'member' and vcsudo is enforced)
  db.setSetting('music.vcsudo.enforced.-10050', true);
  db.setSetting('music.vcsudo.-10050', []);
  assert.equal(await app.music.authorize({ tgId: '200', chatId: -10050, api: h.api }, true), -10050);

  const vcsudoMsg = await app.music.vcsudoCommand({ tgId: '200', chatId: -10050, api: h.api }, ['add', '555']);
  assert.match(vcsudoMsg, /Added <code>555<\/code>/);

  await ctrl.handleUpdate({
    message: { message_id: 6, chat: { id: -10050, type: 'supergroup' }, from: { id: 200, first_name: 'SuperAdmin' }, text: '/hidetag Hello team' }
  });
  assert.ok(h.sentMessages.some((m) => m.chatId === -10050 && /Hello team/.test(m.text) && !/Only group administrators/i.test(m.text)));

  await ctrl.handleUpdate({
    message: { message_id: 7, chat: { id: -10050, type: 'supergroup' }, from: { id: 200, first_name: 'SuperAdmin' }, text: '/setprefix !' }
  });
  assert.equal(db.getChatPrefix(-10050), '!');

  const nsfwResult = await nsfwScreen.toggleGroupNsfw({ tgId: '200', chatId: -10050, isGroup: true, api: h.api, controller: ctrl }, false);
  assert.equal(nsfwResult, false);
});

test('Telegram Group creators, full-right super admins (can_promote_members), and anonymous group admins bypass vcsudo while plain moderators stay blocked', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'lancy_gc_super_'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const members = new Map([
    ['-10060:601', { status: 'creator' }],
    ['-10060:602', { status: 'administrator', can_promote_members: true }],
    ['-10060:603', { status: 'administrator', can_promote_members: false }],
    ['-10060:604', { status: 'member' }]
  ]);
  const chatTypes = new Map([[-10060, 'supergroup']]);

  const h = makeHarness(t, { env: { OWNER_IDS: '100' }, members, chatTypes });
  const { db, app, ctrl, nsfwScreen } = await h.createApp(dir);

  db.setSetting('music.vcsudo.enforced.-10060', true);
  db.setSetting('music.vcsudo.-10060', ['777']);

  // Group creator succeeds even though vcsudo is enforced to ['777']
  assert.equal(await app.music.authorize({ tgId: '601', chatId: -10060, api: h.api }, true), -10060);

  // Full-right group super admin (can_promote_members: true) succeeds
  assert.equal(await app.music.authorize({ tgId: '602', chatId: -10060, api: h.api }, true), -10060);
  const vcsudoRes = await app.music.vcsudoCommand({ tgId: '602', chatId: -10060, api: h.api }, ['add', '604']);
  assert.match(vcsudoRes, /Added <code>604<\/code>/);

  // Plain group moderator (can_promote_members: false) stays silently blocked
  await assert.rejects(
    app.music.authorize({ tgId: '603', chatId: -10060, api: h.api }, true),
    (e) => e.code === 'ADMIN_ONLY' && e.silent === true
  );
  await assert.rejects(
    app.music.vcsudoCommand({ tgId: '603', chatId: -10060, api: h.api }, ['list']),
    (e) => e.code === 'ADMIN_ONLY' && e.silent === true
  );

  // Anonymous group admin (@GroupAnonymousBot 1087968824 with sender_chat === chat.id) succeeds
  const anonMsg = {
    message_id: 20,
    chat: { id: -10060, type: 'supergroup' },
    sender_chat: { id: -10060, type: 'supergroup' },
    from: { id: 1087968824, is_bot: true, username: 'GroupAnonymousBot' },
    text: '/setprefix .'
  };
  assert.equal(await app.music.authorize({ tgId: '1087968824', chatId: -10060, message: anonMsg, api: h.api }, true), -10060);

  await ctrl.handleUpdate({ message: anonMsg });
  assert.equal(db.getChatPrefix(-10060), '.');

  const nsfwAnon = await nsfwScreen.toggleGroupNsfw({ tgId: '1087968824', chatId: -10060, isGroup: true, message: anonMsg, api: h.api, controller: ctrl }, false);
  assert.equal(nsfwAnon, false);
});

test('Any channel admin (creator, co-admin regardless of added_by, anonymous channel_post without sender_chat, instant promotion/demotion) can operate channel and DM channel tools', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'lancy_chan_admin_'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const members = new Map([
    ['-10070:701', { status: 'creator' }],
    ['-10070:702', { status: 'member' }],
    ['-10070:799', { status: 'member' }]
  ]);
  const chatTypes = new Map([[-10070, 'channel']]);

  const h = makeHarness(t, { env: { OWNER_IDS: '100' }, members, chatTypes });
  const { db, settings, app, ctrl, channelPostScreen, autoPostScreen, nsfwScreen } = await h.createApp(dir);

  await settings.set('security.publicAccess', false);
  db.recordTelegramChannel({
    channel_id: -10070,
    title: 'Shared Creator Channel',
    username: 'shared_chan',
    can_post: 1,
    added_by: 701
  });

  // 1) System pseudo IDs & non-admins stay fail-closed
  assert.equal(await verifyChannelAdmin({ chatId: -10070, fromUser: { id: 799 }, api: h.api }), false);
  assert.equal(await verifyChannelAdmin({ chatId: -10070, fromUser: { id: 1087968824 }, api: h.api }), false);
  assert.equal(await verifyChannelAdmin({ chatId: -10070, fromUser: { id: 777000 }, api: h.api }), false);

  // 2) Negative result for 702 is NOT cached; promoting 702 unlocks channel immediately, demoting via chat_member revokes immediately
  assert.equal(await verifyChannelAdmin({ chatId: -10070, fromUser: { id: 702 }, api: h.api }), false);
  members.set('-10070:702', { status: 'administrator', can_post_messages: false }); // minimal admin rights
  assert.equal(await verifyChannelAdmin({ chatId: -10070, fromUser: { id: 702 }, api: h.api }), true);

  await ctrl.handleUpdate({
    chat_member: {
      chat: { id: -10070, type: 'channel' },
      new_chat_member: { user: { id: 702, is_bot: false }, status: 'member' }
    }
  });
  members.set('-10070:702', { status: 'member' });
  assert.equal(await verifyChannelAdmin({ chatId: -10070, fromUser: { id: 702 }, api: h.api }), false);

  // Promote 702 back to administrator
  members.set('-10070:702', { status: 'administrator' });
  await ctrl.handleUpdate({
    chat_member: {
      chat: { id: -10070, type: 'channel' },
      new_chat_member: { user: { id: 702, is_bot: false }, status: 'administrator' }
    }
  });

  // 3) Native anonymous channel_post even when sender_chat is omitted works; automatic forward is ignored
  const postNoSenderChat = { message_id: 50, chat: { id: -10070, type: 'channel', title: 'Shared Creator Channel' }, text: '/player' };
  assert.equal(isNativeChannelPost(postNoSenderChat, { isChannelPost: true }), true);
  assert.equal(isNativeChannelPost({ ...postNoSenderChat, is_automatic_forward: true }, { isChannelPost: true }), false);

  const beforeSentRich = h.sentRich.length;
  await ctrl.handleUpdate({ channel_post: postNoSenderChat });
  assert.ok(h.sentRich.length > beforeSentRich || h.sentMessages.some((m) => m.chatId === -10070));

  // 4) Co-admin 702 (different from added_by 701) can run channel commands & toggle channel NSFW / setprefix
  await ctrl.handleUpdate({
    message: { message_id: 51, chat: { id: -10070, type: 'channel', title: 'Shared Creator Channel' }, from: { id: 702, first_name: 'CoAdmin' }, text: '/setprefix .' }
  });
  assert.equal(db.getChatPrefix(-10070), '.');

  const chanNsfw = await nsfwScreen.toggleGroupNsfw({
    tgId: '702',
    chatId: -10070,
    isChannel: true,
    channelAdminVerified: true,
    api: h.api,
    controller: ctrl
  }, false);
  assert.equal(chanNsfw, false);

  // 5) listVerifiedAdminChannels lists -10070 for co-admin 702 (never for stranger 799)
  const admin702Channels = await listVerifiedAdminChannels({ db, api: h.api, settings, controller: ctrl, userId: 702 });
  assert.deepEqual(admin702Channels.map((c) => c.channel_id), [-10070]);
  const strangerChannels = await listVerifiedAdminChannels({ db, api: h.api, settings, controller: ctrl, userId: 799 });
  assert.deepEqual(strangerChannels, []);

  // 6) In closed-private DM (publicAccess: false), co-admin 702 can open /postchannel and /autopost, pick -10070, while stranger 799 cannot and /accounts remains blocked
  await ctrl.handleUpdate({
    message: { message_id: 60, chat: { id: 702, type: 'private' }, from: { id: 702, first_name: 'CoAdmin' }, text: '/postchannel' }
  });
  assert.ok(h.sentRich.some((m) => m.chatId === 702));

  const renderedPostPick = await channelPostScreen.handle({ tgId: '702', chatId: 702, api: h.api, controller: ctrl, editScreen: async (r) => r }, 'to_channels');
  assert.ok(collectButtons(renderedPostPick).some((b) => String(b.callback_data || '').includes('-10070')));

  await channelPostScreen.handle({ tgId: '702', chatId: 702, api: h.api, controller: ctrl, editScreen: async (r) => r }, 'select_channel', ['-10070']);

  await ctrl.handleUpdate({
    message: { message_id: 61, chat: { id: 702, type: 'private' }, from: { id: 702, first_name: 'CoAdmin' }, text: '/autopost' }
  });
  const renderedAutoPick = await autoPostScreen.handle({ tgId: '702', chatId: 702, api: h.api, controller: ctrl, editScreen: async (r) => r }, 'set_platform', ['telegram']);
  assert.ok(renderedAutoPick);

  // Non-channel-admin stranger 799 stays blocked on /postchannel, channel_post callbacks, and menu selection
  const richBeforeStranger = h.sentRich.length;
  await ctrl.handleUpdate({
    message: { message_id: 62, chat: { id: 799, type: 'private' }, from: { id: 799, first_name: 'Stranger' }, text: '/postchannel' }
  });
  assert.equal(h.sentRich.length, richBeforeStranger);

  await ctrl.handleUpdate({
    callback_query: {
      id: 'cb_stranger',
      from: { id: 799, first_name: 'Stranger' },
      message: { message_id: 60, chat: { id: 799, type: 'private' } },
      data: encodeCallback('channel_post', 'open')
    }
  });
  assert.ok(h.alerts.some((a) => a.id === 'cb_stranger' && /belongs to someone else/i.test(a.text)));

  await channelPostScreen.handle(
    { tgId: '799', chatId: 799, api: h.api, controller: ctrl, query: { id: 'cb_sel_stranger', from: { id: 799 } }, editScreen: async (r) => r },
    'select_channel',
    ['-10070']
  );
  assert.ok(h.alerts.some((a) => a.id === 'cb_sel_stranger' && /Only channel administrators/i.test(a.text)));
});
