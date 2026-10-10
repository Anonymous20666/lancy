import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/core/db.js';
import { SettingsManager } from '../src/config/settings.js';
import { StateMachine } from '../src/core/stateMachine.js';
import { TelegramController } from '../src/telegram/bot.js';
import { MultiBotManager } from '../src/telegram/multiBotManager.js';
import { createDownloaderScreen } from '../src/telegram/screens/downloader.js';

test('TelegramController: live inline search returns entrypoint cards on empty query', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine();

  let inlineAnswer = null;
  const fakeApi = {
    getMe: async () => ({ id: 100, username: 'Lancy_easy_bot', first_name: 'Lancy' }),
    call: async (method, payload) => {
      if (method === 'answerInlineQuery') {
        inlineAnswer = payload;
        return { ok: true };
      }
      return { ok: true };
    }
  };

  const controller = new TelegramController({
    api: fakeApi,
    db,
    settings,
    stateMachine: sm,
    app: {},
    screens: new Map(),
    botContext: { botName: 'Lancy', botUsername: 'Lancy_easy_bot' }
  });
  controller.botUsername = 'Lancy_easy_bot';

  await controller.handleInlineQuery({
    id: 'query_123',
    from: { id: 1001, first_name: 'Alex' },
    query: '',
    offset: ''
  });

  assert.ok(inlineAnswer, 'answerInlineQuery should be called');
  assert.equal(inlineAnswer.inline_query_id, 'query_123');
  assert.equal(inlineAnswer.results.length, 3);
  assert.match(inlineAnswer.results[0].title, /Music Search/);
  assert.match(inlineAnswer.results[1].title, /Universal Downloader/);
  assert.match(inlineAnswer.results[2].title, /Pinterest Search/);
  assert.ok(inlineAnswer.results[0].thumbnail_url, 'should include thumbnail_url');
  assert.ok(inlineAnswer.results[0].thumb_url, 'should include thumb_url');

  db.close();
});

test('TelegramController: live inline search returns instant tracks with bot tag and rich play command', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine();

  let inlineAnswer = null;
  const fakeApi = {
    getMe: async () => ({ id: 101, username: 'PappyCodespacebot', first_name: 'Pappy' }),
    call: async (method, payload) => {
      if (method === 'answerInlineQuery') {
        inlineAnswer = payload;
        return { ok: true };
      }
      return { ok: true };
    }
  };

  const controller = new TelegramController({
    api: fakeApi,
    db,
    settings,
    stateMachine: sm,
    app: {},
    screens: new Map(),
    botContext: { botName: 'PappyBot', botUsername: 'PappyCodespacebot' }
  });
  controller.botUsername = 'PappyCodespacebot';

  // Search for track
  await controller.handleInlineQuery({
    id: 'query_456',
    from: { id: 1001, first_name: 'Alex' },
    query: 'FE!N Travis Scott',
    offset: ''
  });

  assert.ok(inlineAnswer, 'answerInlineQuery should be called');
  assert.equal(inlineAnswer.inline_query_id, 'query_456');
  assert.ok(inlineAnswer.results.length > 0, 'should return search results');

  const firstResult = inlineAnswer.results[0];
  assert.ok(firstResult.title, 'first result must have title');
  assert.ok(firstResult.type === 'audio' ? Boolean(firstResult.audio_url) : Boolean(firstResult.input_message_content?.message_text), 'first result must deliver real audio stream or input command');
  assert.ok(firstResult.thumbnail_url || firstResult.thumb_url || firstResult.audio_url, 'should have artwork thumbnail or audio stream');

  db.close();
});

test('TelegramController: group chat filters commands tagged for other bots', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  settings.values.general.ownerIds = [1001];
  const sm = new StateMachine();

  let playCalledWith = null;
  const screens = new Map();
  screens.set('downloader', {
    executeDownload: async (ctx, query) => {
      playCalledWith = query;
      return { message_id: 999 };
    }
  });

  const fakeApi = {
    getMe: async () => ({ id: 100, username: 'Lancy_easy_bot' }),
    call: async () => ({ ok: true }),
    sendMessage: async () => ({ message_id: 101 })
  };

  const controller = new TelegramController({
    api: fakeApi,
    db,
    settings,
    stateMachine: sm,
    app: {},
    screens,
    botContext: { botName: 'Lancy', botUsername: 'Lancy_easy_bot' }
  });
  controller.botUsername = 'Lancy_easy_bot';

  // 1. Command tagged for another bot: should be ignored!
  await controller.handleUpdate({
    update_id: 1,
    message: {
      message_id: 201,
      from: { id: 1001, first_name: 'Alex' },
      chat: { id: -100555, type: 'supergroup' },
      text: '/play@OtherBot Blinding Lights The Weeknd'
    }
  });
  assert.equal(playCalledWith, null, 'must ignore commands directed to other bots in the group');

  // 2. Command tagged for this bot: should be processed!
  await controller.handleUpdate({
    update_id: 2,
    message: {
      message_id: 202,
      from: { id: 1001, first_name: 'Alex' },
      chat: { id: -100555, type: 'supergroup' },
      text: '/play@Lancy_easy_bot Blinding Lights The Weeknd'
    }
  });
  assert.equal(playCalledWith, 'Blinding Lights The Weeknd', 'must execute command directed to this bot');

  // 3. Untagged command: should also be processed
  playCalledWith = null;
  await controller.handleUpdate({
    update_id: 3,
    message: {
      message_id: 203,
      from: { id: 1001, first_name: 'Alex' },
      chat: { id: -100555, type: 'supergroup' },
      text: '/play Starboy The Weeknd'
    }
  });
  assert.equal(playCalledWith, 'Starboy The Weeknd', 'must execute untagged command');

  db.close();
});

test('MultiBotManager: hotReloadAllCommands updates primary bot and all cloned bots', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);

  let primaryCommandsSet = 0;
  let cloneCommandsSet = 0;

  const mockApp = {
    telegram: {
      controller: {
        registerCommands: async () => {
          primaryCommandsSet++;
          return true;
        }
      }
    }
  };

  const mgr = new MultiBotManager({ db, settings, app: mockApp });

  // Add a fake running cloned bot
  mgr.runningBots.set(1, {
    botRecord: { id: 1, bot_username: 'Clone_1_bot' },
    controller: {
      registerCommands: async () => {
        cloneCommandsSet++;
        return true;
      }
    }
  });
  mgr.runningBots.set(2, {
    botRecord: { id: 2, bot_username: 'Clone_2_bot' },
    controller: {
      registerCommands: async () => {
        cloneCommandsSet++;
        return true;
      }
    }
  });

  const results = await mgr.hotReloadAllCommands();
  assert.equal(results.length, 3, 'should hot-reload 1 primary + 2 cloned bots');
  assert.equal(primaryCommandsSet, 1);
  assert.equal(cloneCommandsSet, 2);
  assert.ok(results.every((r) => r.success === true));

  db.close();
});

test('TelegramController: /reloadcommands hot-reloads command suggestions on demand', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  settings.values.general.ownerIds = [1001];

  let hotReloadTriggered = false;
  let sentMessage = null;

  const mockApp = {
    multiBotManager: {
      hotReloadAllCommands: async () => {
        hotReloadTriggered = true;
        return [
          { bot: 'primary', success: true },
          { botId: 5, username: 'pappy_bot', success: true }
        ];
      }
    }
  };

  const fakeApi = {
    getMe: async () => ({ id: 100, username: 'Lancy_easy_bot' }),
    sendMessage: async (chatId, text) => {
      sentMessage = text;
      return { message_id: 888 };
    }
  };

  const controller = new TelegramController({
    api: fakeApi,
    db,
    settings,
    stateMachine: new StateMachine(),
    app: mockApp,
    screens: new Map()
  });

  // Owner sends /reloadcommands
  await controller.handleUpdate({
    update_id: 10,
    message: {
      message_id: 301,
      from: { id: 1001, first_name: 'Admin' },
      chat: { id: 1001, type: 'private' },
      text: '/reloadcommands'
    }
  });

  assert.equal(hotReloadTriggered, true, 'must trigger hotReloadAllCommands');
  assert.match(sentMessage, /Hot-reloaded command suggestions/);
  assert.match(sentMessage, /2/);

  db.close();
});

test('Rich Music Drop: /play command produces full Rich Message with audio, metadata table, send audio file button and lyrics', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine();

  let deliveredRich = null;
  const fakeApi = {
    sendRichMessage: async (chatId, rich) => {
      deliveredRich = rich;
      return { message_id: 555 };
    },
    editMessageRich: async (chatId, msgId, rich) => {
      deliveredRich = rich;
      return { message_id: msgId };
    },
    sendMessage: async () => ({ message_id: 556 })
  };

  const app = {
    db,
    telegram: {
      api: fakeApi,
      controller: {
        markMediaDeliveryMessage: () => {},
        isMediaDeliveryMessage: () => true,
        isMediaDeliveryMessageId: () => true
      }
    },
    mediaDownloader: {
      download: async () => ({
        platform: 'spotify',
        title: 'Starboy',
        artist: 'The Weeknd',
        duration: '3:50',
        mediaItems: [{ type: 'photo', buffer: Buffer.from('album-art') }],
        audioTrack: {
          buffer: Buffer.from('audio-mp3-stream'),
          title: 'Starboy',
          performer: 'The Weeknd',
          duration: 230
        }
      })
    }
  };

  const downloader = createDownloaderScreen({ app });

  const ctx = {
    tgId: '1001',
    chatId: -100999,
    isGroup: true,
    user: { id: 1001, first_name: 'Alex' },
    db,
    settings,
    sm,
    api: fakeApi,
    controller: app.telegram.controller
  };

  await downloader.executeDownload(ctx, 'Starboy The Weeknd');

  assert.ok(deliveredRich, 'Rich message must be delivered');

  // Verify audio block
  const audioBlock = deliveredRich.blocks.find((b) => b.type === 'audio');
  assert.ok(audioBlock, 'Must contain audio player block');
  assert.equal(audioBlock.audio.title, 'Starboy');
  assert.equal(audioBlock.audio.performer, 'The Weeknd');

  // Verify metadata table
  const tableBlock = deliveredRich.blocks.find((b) => b.type === 'table');
  assert.ok(tableBlock, 'Must contain metadata table block');
  const tableContent = JSON.stringify(tableBlock.cells);
  assert.match(tableContent, /Starboy/);
  assert.match(tableContent, /The Weeknd/);
  assert.match(tableContent, /Alex/);

  // Verify action buttons: "Send Audio File" & "Lyrics"
  const buttonBlocks = deliveredRich.blocks.filter((b) => b.type === 'buttons');
  const allButtons = buttonBlocks.flatMap((b) => b.buttons);

  const sendAudioBtn = allButtons.find((btn) => btn.callback_data?.includes(':send_audio:'));
  assert.ok(sendAudioBtn, 'Must include Send Audio File button');
  assert.match(sendAudioBtn.callback_data, /send_audio/);

  const lyricsBtn = allButtons.find((btn) => btn.callback_data?.includes(':lyrics:'));
  assert.ok(lyricsBtn, 'Must include Lyrics button');
  assert.match(lyricsBtn.callback_data, /lyrics/);

  db.close();
});

test('TelegramController: live inline search for pint/photo returns real HD photos', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine();

  let inlineAnswer = null;
  const fakeApi = {
    getMe: async () => ({ id: 100, username: 'Lancy_easy_bot' }),
    call: async (method, payload) => {
      if (method === 'answerInlineQuery') {
        inlineAnswer = payload;
        return { ok: true };
      }
      return { ok: true };
    }
  };

  const fakePinterestProvider = {
    search: async ({ query }) => ({
      items: [
        {
          pinId: 'pin_1',
          mediaUrl: 'https://i.pinimg.com/originals/cute_cat.jpg',
          thumbnailUrl: 'https://i.pinimg.com/736x/cute_cat.jpg',
          type: 'image'
        },
        {
          pinId: 'pin_2',
          mediaUrl: 'https://v.pinimg.com/videos/cute_video.mp4',
          thumbnailUrl: 'https://i.pinimg.com/736x/thumb.jpg',
          type: 'video'
        }
      ]
    })
  };

  const controller = new TelegramController({
    api: fakeApi,
    db,
    settings,
    stateMachine: sm,
    app: { pinterest: { provider: fakePinterestProvider } },
    screens: new Map(),
    botContext: { botName: 'Lancy', botUsername: 'Lancy_easy_bot' }
  });
  controller.botUsername = 'Lancy_easy_bot';

  await controller.handleInlineQuery({
    id: 'query_pint_1',
    from: { id: 1001, first_name: 'Alex' },
    query: 'pint cute cats',
    offset: ''
  });

  assert.ok(inlineAnswer, 'answerInlineQuery should be called');
  assert.equal(inlineAnswer.inline_query_id, 'query_pint_1');
  assert.equal(inlineAnswer.results.length, 2);

  // First result is photo
  const photoResult = inlineAnswer.results[0];
  assert.equal(photoResult.type, 'photo');
  assert.equal(photoResult.photo_url, 'https://i.pinimg.com/originals/cute_cat.jpg');
  assert.match(photoResult.caption, /cute cats/);

  // Second result is video
  const videoResult = inlineAnswer.results[1];
  assert.equal(videoResult.type, 'video');
  assert.equal(videoResult.video_url, 'https://v.pinimg.com/videos/cute_video.mp4');

  db.close();
});

test('TelegramController: live inline search for Pinterest album and video URLs delivers real media items', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine();

  let inlineAnswer = null;
  const fakeApi = {
    getMe: async () => ({ id: 100, username: 'Lancy_easy_bot' }),
    call: async (method, payload) => {
      if (method === 'answerInlineQuery') {
        inlineAnswer = payload;
        return { ok: true };
      }
      return { ok: true };
    }
  };

  const controller = new TelegramController({
    api: fakeApi,
    db,
    settings,
    stateMachine: sm,
    app: {},
    screens: new Map(),
    botContext: { botName: 'Lancy', botUsername: 'Lancy_easy_bot' }
  });
  controller.botUsername = 'Lancy_easy_bot';

  // Test real Pinterest album extraction
  await controller.handleInlineQuery({
    id: 'query_pin_album',
    from: { id: 1001, first_name: 'Alex' },
    query: 'https://pin.it/2WiRqWBjo',
    offset: ''
  });

  assert.ok(inlineAnswer, 'answerInlineQuery should be called');
  assert.equal(inlineAnswer.inline_query_id, 'query_pin_album');
  assert.ok(inlineAnswer.results.length >= 1, 'should return album slides');
  const firstSlide = inlineAnswer.results[0];
  assert.equal(firstSlide.type, 'photo', 'album items must be delivered as photo type');
  assert.ok(firstSlide.photo_url.includes('pinimg.com'), 'photo_url must point to Pinterest CDN');

  db.close();
});

