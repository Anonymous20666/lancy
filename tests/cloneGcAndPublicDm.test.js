import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from '../src/core/db.js';
import { SettingsManager } from '../src/config/settings.js';
import { StateMachine } from '../src/core/stateMachine.js';
import { loadEnvFile } from '../src/config/env.js';
import { LancyApp } from '../src/app.js';
import { MultiBotManager } from '../src/telegram/multiBotManager.js';
import {
  checkChatMediaPermissions,
  invalidateChatPermissions,
  recordChatPermissionRestriction
} from '../src/telegram/permissions.js';
import { ProgressTracker } from '../src/telegram/progress.js';
import { isMusicSuperAdmin, resolveAppScreen, isSameMusicBot } from '../src/music/accounts.js';
import { MusicService } from '../src/music/service.js';
import { QueueManager } from '../src/music/queueManager.js';
import { originalPlayDelivery } from '../src/music/originalPlayCard.js';
import { TelegramAPI } from '../src/telegram/api.js';

function createTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('MultiBotManager wires music screen, cloneApp.screens, noop action, and cloneApp.telegram helpers for GC commands & callbacks', async (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const settings = new SettingsManager(db, { env: { OWNER_IDS: '9001', PUBLIC_ACCESS: 'false' } });
  const sm = new StateMachine();

  const CLONE_OWNER = 8598406808;
  const GC_ID = -1003965634225;
  const CLONE_BOT_ID = 8966063771;
  const CLONE_TOKEN = `${CLONE_BOT_ID}:AAG_TEST_CLONE_TOKEN`;

  const calls = [];
  const origCall = TelegramAPI.prototype.call;
  TelegramAPI.prototype.call = async function patchedCall(method, params = {}) {
    calls.push({ token: this.token, method, params });
    if (method === 'getMe') {
      return {
        id: CLONE_BOT_ID,
        is_bot: true,
        first_name: 'pappy',
        username: 'pappyishimd_bot',
        can_join_groups: true,
        can_read_all_group_messages: false,
        supports_inline_queries: false
      };
    }
    if (method === 'getUpdates') {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return [];
    }
    if (method === 'getChat') {
      return { id: params.chat_id, type: 'supergroup', title: 'Test Clone GC' };
    }
    if (method === 'getChatMember') {
      return { user: { id: params.user_id, is_bot: true }, status: 'administrator' };
    }
    if (method === 'sendMessage' || method === 'sendPhoto') {
      return { message_id: 500 + calls.length, chat: { id: params.chat_id, type: 'supergroup' } };
    }
    return true;
  };
  t.after(() => {
    TelegramAPI.prototype.call = origCall;
  });

  // Track musicQueueManager calls cleanly without spawning real bridge
  let playerOpens = 0;
  const sessions = new Map();
  const fakeApp = {
    db,
    settings,
    sm,
    screens: new Map(),
    customEmojiRegistry: null,
    movieSessions: { search: async () => [], getDetail: async () => null },
    voiceClient: { accounts: async () => ({ accounts: [] }) },
    musicQueueManager: {
      getSession: (id) => {
        if (!sessions.has(id)) {
          sessions.set(id, {
            chatId: id,
            status: 'idle',
            activeDeck: 'music',
            upcoming: [],
            movieUpcoming: [],
            history: [],
            movieHistory: [],
            connected: false,
            repeat: 'off',
            shuffle: false,
            volume: 100
          });
        }
        return sessions.get(id);
      },
      setPlayerMessage: (id, msgId, playerChatId, api) => {
        const s = sessions.get(id);
        if (s) {
          s.screenMessageId = msgId;
          s.playerChatId = playerChatId;
          s.api = api;
        }
      },
      autoPinPlayerCard: async () => false,
      updatePlayerCard: async () => true
    },
    telegram: {
      api: { me: { id: 9039220035, username: 'Oldlancy_bot' }, botUsername: 'Oldlancy_bot' },
      botUsername: 'Oldlancy_bot',
      userScreenMessage: new Map(),
      markMediaDeliveryMessage: () => {},
      isMediaDeliveryMessage: () => false,
      isMediaDeliveryMessageId: () => false
    }
  };
  fakeApp.music = {
    destination: (ctx) => Number(ctx.chatId),
    player: async (ctx, id = Number(ctx.chatId)) => {
      playerOpens += 1;
      const s = fakeApp.musicQueueManager.getSession(id);
      const rich = resolveAppScreen(fakeApp, 'music', { ctx, session: s }).renderPlayer(s);
      await ctx.api.sendRichMessage(ctx.chatId, rich);
      fakeApp.musicQueueManager.setPlayerMessage(id, 777, Number(ctx.chatId), ctx.api);
      return s;
    }
  };

  db.run(
    `INSERT INTO cloned_bots (owner_tg_id, token, bot_name, bot_username, status)
     VALUES (?, ?, 'pappy', 'pappyishimd_bot', 'active')`,
    CLONE_OWNER,
    CLONE_TOKEN
  );
  const botRecord = db.get('SELECT * FROM cloned_bots WHERE token = ?', CLONE_TOKEN);

  const mbm = new MultiBotManager({ app: fakeApp, db, settings });
  t.after(() => mbm.stopAll());

  const controller = await mbm.startBot(botRecord);
  const musicScreen = controller.screens.get('music');
  assert.ok(musicScreen, 'cloned bot must register the music screen');
  assert.equal(controller.app.screens, controller.screens, 'cloneApp.screens must point to cloneScreens, not main app');
  assert.equal(controller.app.telegram.sm, controller.sm);
  assert.equal(controller.app.telegram.userScreenMessage, controller.userScreenMessage);
  assert.equal(typeof controller.app.telegram.createContext, 'function');

  // Verify noop callback action works cleanly on clone
  await controller.handleUpdate({
    update_id: 100,
    callback_query: {
      id: 'cb_noop',
      from: { id: CLONE_OWNER, first_name: 'Owner', is_bot: false },
      message: { message_id: 10, chat: { id: GC_ID, type: 'supergroup', title: 'Test Clone GC' } },
      data: 'noop'
    }
  });
  assert.ok(calls.some((c) => c.method === 'answerCallbackQuery' && c.params?.callback_query_id === 'cb_noop'));

  // Verify /player in GC routes to clone's music screen
  await controller.handleUpdate({
    update_id: 101,
    message: {
      message_id: 11,
      from: { id: CLONE_OWNER, first_name: 'Owner', is_bot: false },
      chat: { id: GC_ID, type: 'supergroup', title: 'Test Clone GC' },
      text: '/player',
      date: Math.floor(Date.now() / 1000)
    }
  });
  assert.equal(playerOpens, 1, '/player on clone in GC must invoke music player');

  // Verify /vc in GC reaches music screen command handler
  let vcHandled = false;
  const origMusicCmd = musicScreen.handleCommand;
  musicScreen.handleCommand = async (ctx, cmd, args) => {
    if (cmd === '/vc' || cmd === '/movie') {
      vcHandled = true;
      return true;
    }
    return origMusicCmd.call(musicScreen, ctx, cmd, args);
  };
  await controller.handleUpdate({
    update_id: 102,
    message: {
      message_id: 12,
      from: { id: 6647901342, first_name: 'Member', is_bot: false },
      chat: { id: GC_ID, type: 'supergroup', title: 'Test Clone GC' },
      text: '/movie Inception',
      date: Math.floor(Date.now() / 1000)
    }
  });
  assert.equal(vcHandled, true, '/movie on clone in GC must route to music screen');
  musicScreen.handleCommand = origMusicCmd;

  // Verify dashboard "Player" callback (l1:music:openplayer) works instead of "That screen is not available right now."
  await controller.handleUpdate({
    update_id: 103,
    callback_query: {
      id: 'cb_openplayer',
      from: { id: CLONE_OWNER, first_name: 'Owner', is_bot: false },
      message: { message_id: 13, chat: { id: GC_ID, type: 'supergroup', title: 'Test Clone GC' } },
      data: 'l1:music:openplayer'
    }
  });
  const missingScreenNotice = calls.find(
    (c) => c.method === 'answerCallbackQuery' && /not available right now/i.test(String(c.params?.text || ''))
  );
  assert.equal(missingScreenNotice, undefined, 'l1:music:openplayer must not report screen unavailable');
  assert.equal(playerOpens, 2, 'l1:music:openplayer must open player from clone dashboard');
});

test('Clone owner has superAdmin in MusicService, idle/restarted bot avoids PLAYER_ELSEWHERE, and clone screens resolve cleanly', async (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const settings = new SettingsManager(db, { env: { OWNER_IDS: '1000', PUBLIC_ACCESS: 'true' } });

  const mainMusic = {
    id: 'music',
    renderPlayer: () => ({ text: 'MAIN_PLAYER', blocks: [{ type: 'text', text: 'MAIN_PLAYER' }] }),
    renderListen: () => ({ text: 'MAIN_LISTEN', blocks: [{ type: 'text', text: 'MAIN_LISTEN' }] })
  };
  const cloneMusic = {
    id: 'music',
    renderPlayer: () => ({ text: 'CLONE_PLAYER', blocks: [{ type: 'text', text: 'CLONE_PLAYER' }] }),
    renderListen: () => ({ text: 'CLONE_LISTEN', blocks: [{ type: 'text', text: 'CLONE_LISTEN' }] })
  };
  const cloneDownloader = {
    id: 'downloader',
    renderRecordingCard: async ({ track }) => ({
      rich: { text: `CLONE_DL:${track.title}`, blocks: [{ type: 'text', text: `CLONE_DL:${track.title}` }] },
      files: null
    })
  };

  const cloneScreens = new Map([['music', cloneMusic], ['downloader', cloneDownloader]]);
  const mainScreens = new Map([['music', mainMusic]]);

  const cloneApiV1 = {
    token: '8966:token',
    me: { id: 8966, username: 'pappyishimd_bot' },
    botUsername: 'pappyishimd_bot',
    getChat: async () => ({ id: -10077, type: 'supergroup', title: 'GC' }),
    getChatMember: async () => ({ status: 'administrator' }),
    sendRichMessage: async (_chatId, rich) => ({ message_id: 401, rich }),
    editMessageRich: async (_chatId, msgId, rich) => ({ message_id: msgId, rich }),
    pinChatMessage: async () => true,
    call: async () => true
  };
  const cloneApiV2AfterRestart = { ...cloneApiV1 };
  const otherBotApi = {
    ...cloneApiV1,
    token: '9039:main',
    me: { id: 9039, username: 'Oldlancy_bot' },
    botUsername: 'Oldlancy_bot',
    sendRichMessage: async (_chatId, rich) => ({ message_id: 301, rich })
  };

  const app = {
    db,
    settings,
    screens: mainScreens,
    multiBotManager: {
      getRunningBot: (botId) => (botId === 1 ? { controller: { screens: cloneScreens }, api: cloneApiV2AfterRestart } : null)
    },
    telegram: { api: otherBotApi, botUsername: 'Oldlancy_bot' },
    voiceClient: { accounts: async () => ({ accounts: [] }) }
  };
  const qm = new QueueManager({ app, voiceClient: app.voiceClient, db, pollMs: 0 });
  t.after(() => qm.close?.());
  app.musicQueueManager = qm;
  const service = new MusicService({ app });

  const cloneController = { isOwner: (id) => Number(id) === 8598406808, isMainOwner: () => false, screens: cloneScreens };
  assert.equal(isMusicSuperAdmin(app, 8598406808), false);
  assert.equal(isMusicSuperAdmin(app, 8598406808, { controller: cloneController }), true);
  assert.equal(service.superAdmin({ tgId: 8598406808, controller: cloneController }), true);

  // originalPlayDelivery prefers ctx clone screens
  const dlCard = await originalPlayDelivery({
    app,
    ctx: { screens: cloneScreens, controller: cloneController },
    track: { id: 't1', title: 'Track 1' },
    audio: null,
    lyrics: null,
    allowArtwork: false
  });
  assert.equal(dlCard.rich.text, 'CLONE_DL:Track 1');

  // Main bot opens idle card in GC -> Clone bot takes over without PLAYER_ELSEWHERE because main is idle
  const mainCtx = { tgId: 1000, chatId: -10077, botId: 0, api: otherBotApi, screens: mainScreens };
  const sMain = await service._player(mainCtx, -10077);
  assert.equal(sMain.screenMessageId, 301);

  const cloneCtx1 = {
    tgId: 8598406808,
    chatId: -10077,
    botId: 1,
    api: cloneApiV1,
    controller: cloneController,
    screens: cloneScreens
  };
  const sClone = await service._player(cloneCtx1, -10077);
  assert.equal(sClone.screenMessageId, 401);
  assert.equal(sClone.botId, 1);

  // When clone is actively playing, different bot still gets PLAYER_ELSEWHERE, while restarted same clone succeeds
  sClone.status = 'playing';
  sClone.connected = true;
  await assert.rejects(service._player(mainCtx, -10077), (err) => err?.code === 'PLAYER_ELSEWHERE');

  const cloneCtxRestarted = { ...cloneCtx1, api: cloneApiV2AfterRestart };
  assert.equal(isSameMusicBot(sClone, cloneCtxRestarted), true);
  await service._player(cloneCtxRestarted, -10077);
  await qm.updatePlayerView(sClone, { forceEdit: true });
});

test('permissionsCache and ProgressTracker isolate main bot and clone bot in the same GC', async () => {
  const GC_ID = -100424242;
  invalidateChatPermissions(GC_ID);

  const restrictedBotApi = {
    me: { id: 101 },
    getChat: async () => ({ permissions: { can_send_messages: true, can_send_media_messages: false } }),
    getChatMember: async () => ({ status: 'restricted', can_send_messages: true, can_send_media_messages: false })
  };
  const adminCloneApi = {
    me: { id: 202 },
    getChat: async () => ({ permissions: { can_send_messages: true, can_send_media_messages: false } }),
    getChatMember: async () => ({ status: 'administrator' })
  };

  const caps1 = await checkChatMediaPermissions(restrictedBotApi, GC_ID);
  assert.equal(caps1.canSendVideos, false);

  const caps2 = await checkChatMediaPermissions(adminCloneApi, GC_ID);
  assert.equal(caps2.isAdmin, true);
  assert.equal(caps2.canSendVideos, true);

  // Restriction recorded for bot 202 must not leak to bot 101 cache and vice-versa
  recordChatPermissionRestriction(GC_ID, { canSendPhotos: false }, restrictedBotApi);
  const cachedAdmin = await checkChatMediaPermissions(adminCloneApi, GC_ID);
  assert.equal(cachedAdmin.canSendVideos, true);
  invalidateChatPermissions(GC_ID);

  // ProgressTracker for bot A must not stop bot B's active tracker in the same GC
  const sentA = [];
  const sentB = [];
  const apiA = {
    me: { id: 101 },
    sendRichMessage: async (_c, rich) => { sentA.push(rich); return { message_id: 1 }; },
    editMessageRich: async () => true,
    deleteMessage: async () => true,
    sendChatAction: async () => true
  };
  const apiB = {
    me: { id: 202 },
    sendRichMessage: async (_c, rich) => { sentB.push(rich); return { message_id: 2 }; },
    editMessageRich: async () => true,
    deleteMessage: async () => true,
    sendChatAction: async () => true
  };

  const tA = new ProgressTracker({ api: apiA, chatId: GC_ID, heartbeatMs: 60000, action: null });
  const tB = new ProgressTracker({ api: apiB, chatId: GC_ID, heartbeatMs: 60000, action: null });
  await tA.start({ text: 'A', blocks: [{ type: 'text', text: 'A' }] });
  await tB.start({ text: 'B', blocks: [{ type: 'text', text: 'B' }] });
  assert.equal(tA.closed, false);
  assert.equal(tB.closed, false);

  ProgressTracker.stopForChat(GC_ID, apiA);
  assert.equal(tA.closed, true);
  assert.equal(tB.closed, false);
  tB.stop();
});

test('LancyApp honors .env DATA_DIR over inherited process.env.DATA_DIR and PUBLIC_ACCESS=true opens DM cleanly', (t) => {
  const prevEnvDataDir = process.env.DATA_DIR;
  const staleGlobalDir = createTempDir('lancy-stale-data-');
  const envDataDir = createTempDir('lancy-project-data-');
  const envDir = createTempDir('lancy-env-file-');
  t.after(() => {
    if (prevEnvDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prevEnvDataDir;
    rmSync(staleGlobalDir, { recursive: true, force: true });
    rmSync(envDataDir, { recursive: true, force: true });
    rmSync(envDir, { recursive: true, force: true });
  });

  process.env.DATA_DIR = staleGlobalDir;
  const envPath = join(envDir, '.env');
  writeFileSync(envPath, `BOT_TOKEN=123:abc\nOWNER_IDS=8598406808\nPUBLIC_ACCESS=true\nDATA_DIR=${envDataDir}\n`);
  const parsedEnv = loadEnvFile(envPath);

  const app = new LancyApp({ env: parsedEnv });
  t.after(() => {
    app.queues?.stopAll?.();
    app.musicQueueManager?.close?.();
    app.db?.close?.();
  });

  assert.equal(app.root, envDataDir);
  assert.equal(app.settings.get('security.publicAccess'), true);
});
