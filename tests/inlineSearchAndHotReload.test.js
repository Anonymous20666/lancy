import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/core/db.js';
import { SettingsManager } from '../src/config/settings.js';
import { StateMachine } from '../src/core/stateMachine.js';
import { TelegramController, searchYouTubeFast, fetchSearchSuggestions } from '../src/telegram/bot.js';
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
  assert.equal(inlineAnswer.results.length, 4);
  assert.match(inlineAnswer.results[0].title, /Music Search/);
  assert.match(inlineAnswer.results[1].title, /Universal Downloader/);
  assert.match(inlineAnswer.results[2].title, /Pinterest Search/);
  assert.match(inlineAnswer.results[3].title, /TikTok Search/);
  assert.ok(inlineAnswer.results[0].thumbnail_url, 'should include thumbnail_url');
  assert.ok(inlineAnswer.results[0].thumb_url, 'should include thumb_url');
  for (const res of inlineAnswer.results) {
    if (res.reply_markup?.inline_keyboard) {
      for (const row of res.reply_markup.inline_keyboard) {
        for (const btn of row) {
          assert.equal(btn.style, 'primary', `button "${btn.text}" must have primary style`);
        }
      }
    }
  }

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

  db.prepare(`
    CREATE TABLE IF NOT EXISTS cached_audio_tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT NOT NULL,
      file_id TEXT NOT NULL,
      title TEXT NOT NULL,
      artist TEXT,
      duration INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();
  db.prepare('INSERT INTO cached_audio_tracks (query, file_id, title, artist, duration) VALUES (?, ?, ?, ?, ?)').run(
    'fe!n travis scott',
    'CQACAgQAAxkDAAIDUmrKn92mh3oNparAAXmX00Jt_RK2AAIWIQACZahRUsuQ4WTCVUcWPQQ',
    'FE!N',
    'Travis Scott',
    191
  );

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
  assert.equal(firstResult.type, 'audio', 'first result must deliver native audio type');
  assert.equal(firstResult.audio_file_id, 'CQACAgQAAxkDAAIDUmrKn92mh3oNparAAXmX00Jt_RK2AAIWIQACZahRUsuQ4WTCVUcWPQQ');
  assert.equal(firstResult.audio_duration, 191, 'audio duration must be set to 191s');
  assert.equal(firstResult.reply_markup?.inline_keyboard?.[0]?.[0]?.style, 'primary', 'inline button must have primary style');
  assert.ok(firstResult.reply_markup?.inline_keyboard?.[0]?.[0]?.url, 'must include deep-link download button');

  for (const res of inlineAnswer.results) {
    if (res.reply_markup?.inline_keyboard) {
      for (const row of res.reply_markup.inline_keyboard) {
        for (const btn of row) {
          assert.equal(btn.style, 'primary', `button "${btn.text}" must have primary style`);
        }
      }
    }
  }

  db.close();
});

test('TelegramController: /start with play_ deep link executes immediate download in DM', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  settings.values.general.ownerIds = [1001];
  const sm = new StateMachine();

  let executedQuery = null;
  const screens = new Map();
  screens.set('downloader', {
    executeDownload: async (ctx, query) => {
      executedQuery = query;
      return { message_id: 888 };
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

  // Deep-link from inline audio button:
  await controller.handleUpdate({
    update_id: 10,
    message: {
      message_id: 50,
      from: { id: 1001, first_name: 'Alex' },
      chat: { id: 1001, type: 'private' },
      text: '/start play_No_More_Parties'
    }
  });

  assert.equal(executedQuery, 'No More Parties', 'executeDownload should be triggered with parsed song name');

  db.close();
});

test('TelegramController: live inline search returns cached audio with audio_file_id and dedups preview', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  settings.values.general.ownerIds = [1001];
  const sm = new StateMachine();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS cached_audio_tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT NOT NULL,
      file_id TEXT NOT NULL,
      title TEXT NOT NULL,
      artist TEXT,
      duration INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();

  db.prepare('INSERT INTO cached_audio_tracks (query, file_id, title, artist, duration) VALUES (?, ?, ?, ?, ?)').run(
    'one life lorda',
    'CQACAgQAAxkDAAIDUmrKn92mh3oNparAAXmX00Jt_RK2AAIWIQACZahRUsuQ4WTCVUcWPQQ',
    'One Life',
    'Lorda',
    215
  );

  let inlineAnswer = null;
  const fakeApi = {
    getMe: async () => ({ id: 100, username: 'Lancy_easy_bot' }),
    call: async (method, params) => {
      if (method === 'answerInlineQuery') {
        inlineAnswer = params;
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
    id: 'query_cached_1',
    from: { id: 1001, first_name: 'Alex' },
    query: 'one life lorda',
    offset: ''
  });

  assert.ok(inlineAnswer, 'answerInlineQuery should be called');
  const first = inlineAnswer.results[0];
  assert.equal(first.type, 'audio');
  assert.equal(first.audio_file_id, 'CQACAgQAAxkDAAIDUmrKn92mh3oNparAAXmX00Jt_RK2AAIWIQACZahRUsuQ4WTCVUcWPQQ');
  assert.match(first.caption, /Full Audio/);
  assert.equal(first.reply_markup.inline_keyboard[0][0].style, 'primary');

  // Verify dedup: freshResults should not contain a second duplicate of "One Life Lorda"
  const duplicates = inlineAnswer.results.filter((r) => /one life/i.test(r.title || r.caption) && /lorda/i.test(r.performer || r.caption));
  assert.equal(duplicates.length, 1, 'should not return duplicate preview for cached track');

  db.close();
});

test('TelegramController: chosen_inline_result upgrades inline audio message to full audio file', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  settings.values.general.ownerIds = [1001];
  const sm = new StateMachine();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS cached_audio_tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT NOT NULL,
      file_id TEXT NOT NULL,
      title TEXT NOT NULL,
      artist TEXT,
      duration INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();

  db.prepare('INSERT INTO cached_audio_tracks (query, file_id, title, artist, duration) VALUES (?, ?, ?, ?, ?)').run(
    'gratitude',
    'CQACAgQAAxkDAAIDH2rKkj-Y19OSEHC_Rz3ZODwdsS73AAKDHwACqN5YUoyVLlFR6jCePQQ',
    'Gratitude',
    'Brandon Lake',
    337
  );

  let editedMedia = null;
  const fakeApi = {
    getMe: async () => ({ id: 100, username: 'Lancy_easy_bot' }),
    call: async (method, params) => {
      if (method === 'editMessageMedia') {
        editedMedia = params;
      }
      return { ok: true };
    },
    editMessageMedia: async (params) => {
      editedMedia = params;
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

  // Trigger chosen_inline_result update
  await controller.handleUpdate({
    update_id: 11,
    chosen_inline_result: {
      result_id: 'fresh_aud_12345_67890',
      from: { id: 1001, first_name: 'Alex' },
      inline_message_id: 'inline_msg_999',
      query: 'gratitude'
    }
  });

  assert.ok(editedMedia, 'editMessageMedia should be called to upgrade message');
  assert.equal(editedMedia.inline_message_id, 'inline_msg_999');
  assert.equal(editedMedia.media.type, 'audio');
  assert.equal(editedMedia.media.media, 'CQACAgQAAxkDAAIDH2rKkj-Y19OSEHC_Rz3ZODwdsS73AAKDHwACqN5YUoyVLlFR6jCePQQ');
  assert.match(editedMedia.media.caption, /Gratitude/);
  assert.equal(editedMedia.reply_markup.inline_keyboard[0][0].style, 'primary');

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

test('TelegramController: live inline search handles tt / tiktok query and returns video cards with primary button style', async () => {
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

  // 1. Test empty tt query shows prompt
  await controller.handleInlineQuery({
    id: 'query_tt_empty',
    from: { id: 1001, first_name: 'Alex' },
    query: 'tt',
    offset: ''
  });

  assert.ok(inlineAnswer, 'answerInlineQuery should be called');
  assert.equal(inlineAnswer.results.length, 1);
  assert.match(inlineAnswer.results[0].title, /search TikTok videos/i);
  assert.equal(inlineAnswer.results[0].reply_markup.inline_keyboard[0][0].style, 'primary');

  // 2. Test tt query with topic
  inlineAnswer = null;
  await controller.handleInlineQuery({
    id: 'query_tt_dance',
    from: { id: 1001, first_name: 'Alex' },
    query: 'tt dance tutorial',
    offset: ''
  });

  assert.ok(inlineAnswer, 'answerInlineQuery should be called');
  assert.ok(inlineAnswer.results.length >= 1, 'should return video cards');
  const firstVideo = inlineAnswer.results[0];
  assert.equal(firstVideo.type, 'video', 'must return video type to drop playable media into chat');
  assert.ok(firstVideo.video_url, 'must provide video_url');
  assert.ok(firstVideo.reply_markup?.inline_keyboard, 'must have inline keyboard');
  for (const row of firstVideo.reply_markup.inline_keyboard) {
    for (const btn of row) {
      assert.equal(btn.style, 'primary', `button "${btn.text}" must have style primary`);
    }
  }
  if (inlineAnswer.results.length >= 8) {
    assert.equal(inlineAnswer.next_offset, String(inlineAnswer.results.length));
  }

  db.close();
});

test('DownloaderScreen: main menu includes TikTok search button and executes TikTok search', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine();

  let replyPayload = null;
  const fakeApi = {
    sendRichMessage: async (chatId, rich) => {
      replyPayload = rich;
      return { message_id: 201 };
    },
    editMessageRich: async (chatId, msgId, rich) => {
      replyPayload = rich;
      return { message_id: msgId };
    }
  };

  const fakeApp = {
    db,
    settings,
    telegram: { api: fakeApi, botUsername: 'Lancy_easy_bot' },
    screens: new Map()
  };

  const downloader = createDownloaderScreen({ app: fakeApp });
  downloader.registerStates(sm);

  let renderedMenu = null;
  const ctx = {
    tgId: '1001',
    chatId: 1001,
    db,
    settings,
    sm,
    api: fakeApi,
    editScreen: async (rich) => { renderedMenu = rich; return { message_id: 200 }; },
    replyRich: async (rich) => { replyPayload = rich; return { message_id: 200 }; }
  };

  await downloader.open(ctx);
  assert.ok(renderedMenu, 'menu should render');
  const buttonBlocks = (renderedMenu.blocks || []).filter(b => b.type === 'buttons');
  const allButtons = buttonBlocks.flatMap(b => b.buttons);
  const ttButton = allButtons.find(b => b.callback_data?.includes('tiktokSearch'));
  assert.ok(ttButton, 'TikTok Search button should exist');

  // Trigger tiktokSearch action
  let promptRendered = null;
  const promptCtx = {
    ...ctx,
    editScreen: async (rich) => { promptRendered = rich; return { message_id: 200 }; }
  };
  await downloader.handle(promptCtx, 'tiktokSearch', []);
  assert.ok(promptRendered, 'TikTok prompt should be rendered');
  assert.equal(sm.get('1001').state, 'TIKTOK_SEARCH_INPUT');

  db.close();
});

test('TelegramController: live inline audio drops 100% full audio player with rich blockquote and lyrics deep link', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  settings.values.general.ownerIds = [1001];
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

  db.prepare(`
    CREATE TABLE IF NOT EXISTS cached_audio_tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT NOT NULL,
      file_id TEXT NOT NULL,
      title TEXT NOT NULL,
      artist TEXT,
      duration INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();

  // Seed cached track
  db.prepare('INSERT INTO cached_audio_tracks (query, file_id, title, artist, duration) VALUES (?, ?, ?, ?, ?)').run(
    'hold out lithe',
    'CQACAgQAAxkDAAIDh2rKreV6zQqdL9tRalLAbHHeDzPlAAJEIQACZahRUnAynHRyR1PXPQQ',
    'Hold Out',
    'Lithe',
    121
  );

  let lyricsHandled = null;
  const screens = new Map();
  screens.set('downloader', {
    handle: async (ctx, action, args) => {
      if (action === 'lyrics') {
        lyricsHandled = args[0];
        return { message_id: 555 };
      }
    }
  });

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

  // 1. Live inline search for Lithe
  await controller.handleInlineQuery({
    id: 'query_lithe_live',
    from: { id: 1001, first_name: 'Alex' },
    query: 'Lithe',
    offset: ''
  });

  assert.ok(inlineAnswer.results.length >= 1, 'should return results with cached audio track at top');

  const audioItem = inlineAnswer.results[0];
  assert.equal(audioItem.type, 'audio', 'must deliver native audio type to drop player into chat');
  assert.equal(audioItem.audio_file_id, 'CQACAgQAAxkDAAIDh2rKreV6zQqdL9tRalLAbHHeDzPlAAJEIQACZahRUnAynHRyR1PXPQQ');
  assert.equal(audioItem.title, 'Hold Out');
  assert.equal(audioItem.performer, 'Lithe');
  assert.equal(audioItem.audio_duration, 121);

  // Check rich caption formatting
  assert.ok(audioItem.caption.includes('<blockquote>'), 'caption must include rich blockquote');
  assert.ok(audioItem.caption.includes('<b>Duration:</b> 2:01'), 'caption must display formatted duration');
  assert.ok(audioItem.caption.includes('320 kbps HD'), 'caption must display audio quality');

  // Check inline buttons
  const buttons = audioItem.reply_markup.inline_keyboard;
  assert.equal(buttons.length, 2, 'must have 2 button rows');
  assert.equal(buttons[0][0].text, '📜 Lyrics & Info ♡');
  assert.match(buttons[0][0].url, /start=lyrics_Hold_Out/);
  assert.equal(buttons[0][0].style, 'primary');

  assert.equal(buttons[1][0].text, '🎵 Search Music Live');
  assert.equal(buttons[1][0].switch_inline_query_current_chat, '');
  assert.equal(buttons[1][0].style, 'primary');

  // 2. Test /start lyrics_Hold_Out deep-link execution
  await controller.handleUpdate({
    update_id: 101,
    message: {
      message_id: 111,
      from: { id: 1001, first_name: 'Alex' },
      chat: { id: 1001, type: 'private' },
      text: '/start lyrics_Hold_Out'
    }
  });

  assert.equal(lyricsHandled, 'Hold Out', 'deep-link should pass clean song title to lyrics handler');

  db.close();
});

test('TelegramController: live inline search supports infinite pagination with next_offset', async () => {
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

  db.prepare(`
    CREATE TABLE IF NOT EXISTS cached_audio_tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT NOT NULL,
      file_id TEXT NOT NULL,
      title TEXT NOT NULL,
      artist TEXT,
      duration INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();

  // Insert 25 cached tracks for "pop hits"
  for (let i = 1; i <= 25; i++) {
    db.prepare('INSERT INTO cached_audio_tracks (query, file_id, title, artist, duration) VALUES (?, ?, ?, ?, ?)').run(
      'pop hits',
      `audio_file_id_${i}`,
      `Pop Track ${i}`,
      'Pop Artist',
      180
    );
  }

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

  // 1. Initial query with offset '' (page 1: items 0-9)
  await controller.handleInlineQuery({
    id: 'query_page_1',
    from: { id: 1001, first_name: 'Alex' },
    query: 'pop hits',
    offset: ''
  });

  assert.ok(inlineAnswer, 'answerInlineQuery should be called');
  assert.equal(inlineAnswer.results.length, 10, 'first page should contain 10 tracks');
  assert.equal(inlineAnswer.next_offset, '10', 'next_offset should be 10');

  // 2. Subsequent query with offset '10' (page 2: items 10-19)
  await controller.handleInlineQuery({
    id: 'query_page_2',
    from: { id: 1001, first_name: 'Alex' },
    query: 'pop hits',
    offset: '10'
  });

  assert.equal(inlineAnswer.results.length, 10, 'second page should contain 10 tracks');
  assert.equal(inlineAnswer.next_offset, '20', 'next_offset should be 20');

  // 3. Final query with offset '20' (page 3: items 20-24)
  await controller.handleInlineQuery({
    id: 'query_page_3',
    from: { id: 1001, first_name: 'Alex' },
    query: 'pop hits',
    offset: '20'
  });

  assert.equal(inlineAnswer.results.length, 5, 'third page should contain remaining 5 tracks');
  assert.equal(inlineAnswer.next_offset, '', 'next_offset should be empty once exhausted');

  db.close();
});

test('TelegramController: live inline search for uncached music delivers playable media and zero text articles', async () => {
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

  // Live inline search for a song not yet cached in DB
  await controller.handleInlineQuery({
    id: 'query_uncached_song',
    from: { id: 1001, first_name: 'Alex' },
    query: 'Espresso Sabrina Carpenter',
    offset: ''
  });

  assert.ok(inlineAnswer, 'answerInlineQuery should be called');
  assert.ok(inlineAnswer.results.length >= 1, 'must return tracks');

  // Verify that all results are real media (video, audio, or photo), NEVER article
  for (const track of inlineAnswer.results) {
    assert.notEqual(track.type, 'article', 'live music results must never be text articles');
    assert.ok(track.type === 'video' || track.type === 'audio' || track.type === 'photo', 'must be real media');
    if (track.type === 'video') {
      assert.ok(track.video_url, 'must have video_url');
      assert.equal(track.mime_type, 'text/html');
    }
    if (track.reply_markup?.inline_keyboard) {
      for (const row of track.reply_markup.inline_keyboard) {
        for (const btn of row) {
          assert.equal(btn.style, 'primary', `button "${btn.text}" must have style primary`);
          if (btn.url) {
            assert.ok(!btn.url.includes('start=dl_'), 'button must not redirect to dl DM');
          }
        }
      }
    }
  }

  db.close();
});

test('Fast Search: searchYouTubeFast and fetchSearchSuggestions respond with rich items and suggestions', async () => {
  const suggestions = await fetchSearchSuggestions('jjk');
  assert.ok(Array.isArray(suggestions), 'suggestions must be an array');

  const videos = await searchYouTubeFast('jjk');
  assert.ok(Array.isArray(videos), 'videos must be an array');
  assert.ok(videos.length > 0, 'must return video results');
  const first = videos[0];
  assert.ok(first.videoId, 'must have videoId');
  assert.ok(first.title, 'must have title');
  assert.ok(first.duration, 'must have duration');
  assert.ok(first.thumb, 'must have thumbnail');
});

test('TelegramController: TikTok live search supports infinite pagination without DM redirect', async () => {
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

  // 1. Initial page
  await controller.handleInlineQuery({
    id: 'query_tt_page_1',
    from: { id: 1001, first_name: 'Alex' },
    query: 'tt anime edit',
    offset: ''
  });

  assert.ok(inlineAnswer, 'answerInlineQuery should be called');
  assert.ok(inlineAnswer.results.length >= 1, 'must return video cards');
  assert.equal(inlineAnswer.results[0].type, 'video');
  for (const res of inlineAnswer.results) {
    if (res.reply_markup?.inline_keyboard) {
      for (const row of res.reply_markup.inline_keyboard) {
        for (const btn of row) {
          assert.equal(btn.style, 'primary', `button "${btn.text}" must have style primary`);
          if (btn.url) {
            assert.ok(!btn.url.includes('start=dl_'), 'must never redirect to download DM');
          }
        }
      }
    }
  }

  // 2. Next page with offset
  const nextOff = inlineAnswer.next_offset;
  if (nextOff) {
    inlineAnswer = null;
    await controller.handleInlineQuery({
      id: 'query_tt_page_2',
      from: { id: 1001, first_name: 'Alex' },
      query: 'tt anime edit',
      offset: nextOff
    });
    assert.ok(inlineAnswer, 'second page must return results');
    assert.ok(inlineAnswer.results.length >= 1, 'second page must have items');
  }

  db.close();
});
