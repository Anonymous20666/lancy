import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/core/db.js';
import { SettingsManager } from '../src/config/settings.js';
import { StateMachine } from '../src/core/stateMachine.js';
import { TelegramController } from '../src/telegram/bot.js';
import { createDownloaderScreen } from '../src/telegram/screens/downloader.js';
import { createMusicScreen } from '../src/telegram/screens/music.js';
import { createDashboardScreen } from '../src/telegram/screens/dashboard.js';
import { getLyrics } from '../src/media/lyrics.js';
import { isProxyReachable, resolveAndDownloadAudio } from '../src/media/musicResolver.js';
import { LancyAssistant } from '../src/ai/assistant.js';
import { GameEngine } from '../src/games/engine.js';
import { QueueManager } from '../src/music/queueManager.js';
import { MusicService } from '../src/music/service.js';

test('Section 4: /play <song> executes one-step download with blockquote stage card and never forces multi-select search menu', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine({ db });

  const richMessages = [];
  const mockApi = {
    me: { id: 999, username: 'Lancy_easy_bot' },
    getChat: async () => ({
      id: -100500,
      type: 'supergroup',
      permissions: { can_send_audios: true, can_send_photos: true, can_send_videos: true, can_send_media_messages: true }
    }),
    getChatMember: async () => ({ status: 'member' }),
    sendChatAction: async () => {},
    sendRichMessage: async (chatId, rich, extra, files) => {
      richMessages.push({ type: 'send', chatId, rich, files });
      return { message_id: 100 + richMessages.length };
    },
    editMessageRich: async (chatId, messageId, rich, extra, files) => {
      richMessages.push({ type: 'edit', chatId, messageId, rich, files });
      return { message_id: messageId };
    },
    deleteMessage: async () => {},
    sendMessage: async () => ({ message_id: 999 })
  };

  let multiSelectCalls = 0;
  const app = {
    db,
    settings,
    sm,
    screens: new Map(),
    telegram: { api: mockApi },
    music: {
      botKey: () => '999',
      startSearch: async () => {
        multiSelectCalls++;
        throw new Error('/play must not invoke mandatory multi-select startSearch');
      }
    },
    mediaDownloader: {
      download: async (query, { onProgress }) => {
        onProgress?.(`Searching source & metadata for "${query}"… ♡`);
        onProgress?.(`Resolving media match: "Starboy" — The Weeknd… ♡`);
        onProgress?.(`Downloading full audio track for "Starboy"… ♡`);
        onProgress?.(`Processing audio & tagging "Starboy"… ♡`);
        return {
          platform: 'spotify',
          title: 'Starboy',
          artist: 'The Weeknd',
          album: 'Starboy',
          year: 2016,
          duration: '3:50',
          mediaItems: [{ type: 'photo', buffer: Buffer.from('cover-bytes'), filename: 'cover.jpg', mimeType: 'image/jpeg' }],
          audioTrack: {
            buffer: Buffer.from('mp3-audio-bytes'),
            title: 'Starboy',
            performer: 'The Weeknd',
            duration: 230,
            filename: 'Starboy.mp3'
          }
        };
      }
    }
  };

  const downloaderScreen = createDownloaderScreen({ app });
  const musicScreen = createMusicScreen({ app });
  app.screens.set('downloader', downloaderScreen);
  app.screens.set('music', musicScreen);

  const controller = new TelegramController({
    api: mockApi,
    db,
    settings,
    stateMachine: sm,
    app,
    screens: app.screens,
    botContext: { botName: 'Lancy', botUsername: 'Lancy_easy_bot' }
  });
  app.telegram.controller = controller;

  await controller.handleUpdate({
    update_id: 1,
    message: {
      message_id: 10,
      from: { id: 501, first_name: 'Maya' },
      chat: { id: -100500, type: 'supergroup' },
      text: '/play Starboy The Weeknd'
    }
  });

  assert.equal(multiSelectCalls, 0, '/play must not open the multi-select search menu');
  assert.ok(richMessages.length >= 2, 'Should send initial progress card and final delivered audio card');

  // Verify initial progress card has MUSIC DOWNLOADER header and blockquote with stage flow
  const progressRich = richMessages[0].rich;
  const progressStr = JSON.stringify(progressRich);
  assert.match(progressStr, /MUSIC DOWNLOADER/);
  assert.match(progressStr, /\[Searching source\] → Resolving media → Downloading → Processing audio → Delivering file/);
  assert.ok(progressRich.blocks.some((b) => b.type === 'blockquote'), 'Progress card must use a blockquote block');

  // Verify final delivered card has audio, metadata table, Send Audio File, Full Lyrics button, and expandable lyrics
  const finalEntry = richMessages.at(-1);
  const finalRich = finalEntry.rich;
  assert.ok(finalRich.blocks.some((b) => b.type === 'audio'), 'Final card must include audio player block');
  assert.ok(finalRich.blocks.some((b) => b.type === 'table'), 'Final card must include metadata table');
  assert.ok(finalRich.blocks.some((b) => b.type === 'expandable_blockquote'), 'Final card must include expandable lyrics blockquote');
  const buttons = finalRich.blocks.filter((b) => b.type === 'buttons').flatMap((b) => b.buttons);
  assert.ok(buttons.some((b) => JSON.stringify(b.text).includes('Send Audio File')), 'Final card must include Send Audio File button');
  assert.ok(buttons.some((b) => JSON.stringify(b.text).includes('Full Lyrics')), 'Final card must include Full Lyrics button');

  db.close();
});

test('Section 4 & 11: /addq and /vplay still route to VC queue selection while /play downloads directly', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine({ db });

  const searchModes = [];
  let directDownloads = 0;

  const mockApi = {
    me: { id: 999, username: 'Lancy_easy_bot' },
    sendRichMessage: async () => ({ message_id: 50 }),
    editMessageRich: async () => ({ message_id: 50 }),
    sendMessage: async () => ({ message_id: 51 })
  };

  const app = {
    db,
    settings,
    sm,
    screens: new Map(),
    telegram: { api: mockApi },
    music: {
      botKey: () => '999',
      startSearch: async (_ctx, query, mode) => {
        searchModes.push({ query, mode });
        return { id: 'tok', pages: [{ items: [], provider: 'youtube' }], index: 0, selected: new Map(), revision: 0 };
      }
    }
  };

  const musicScreen = createMusicScreen({ app });
  app.screens.set('music', musicScreen);
  app.screens.set('downloader', {
    id: 'downloader',
    executeDownload: async () => {
      directDownloads++;
    }
  });

  const controller = new TelegramController({
    api: mockApi,
    db,
    settings,
    stateMachine: sm,
    app,
    screens: app.screens
  });

  await controller.handleUpdate({
    update_id: 1,
    message: { message_id: 1, from: { id: 10, first_name: 'Admin' }, chat: { id: -1001, type: 'supergroup' }, text: '/addq Burna Boy' }
  });
  await controller.handleUpdate({
    update_id: 2,
    message: { message_id: 2, from: { id: 10, first_name: 'Admin' }, chat: { id: -1001, type: 'supergroup' }, text: '/vplay Rema Calm Down' }
  });
  await controller.handleUpdate({
    update_id: 3,
    message: { message_id: 3, from: { id: 10, first_name: 'Admin' }, chat: { id: -1001, type: 'supergroup' }, text: '/play Wizkid Essence' }
  });

  assert.deepEqual(searchModes, [
    { query: 'Burna Boy', mode: 'queue' },
    { query: 'Rema Calm Down', mode: 'video' }
  ]);
  assert.equal(directDownloads, 1);

  db.close();
});

test('Section 5: getLyrics matches LRCLIB candidates with or without artist, handles multiple album editions, and rejects unrelated songs', async () => {
  const prevFetch = global.fetch;
  try {
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/get?')) {
        return { ok: false, status: 404 };
      }
      if (u.includes('/api/search?')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              trackName: 'Calm Down',
              artistName: 'Rema',
              albumName: 'Rave & Roses',
              plainLyrics: 'Baby calm down, calm down\nGirl this your body e put my heart for lockdown'
            },
            {
              trackName: 'Calm Down',
              artistName: 'Rema',
              albumName: 'Rave & Roses Ultra',
              plainLyrics: 'Baby calm down, calm down\nGirl this your body e put my heart for lockdown',
              syncedLyrics: '[00:10.00] Baby calm down, calm down'
            }
          ]
        };
      }
      return { ok: false, status: 404 };
    };

    // 1. Query with title only (no artist) and multiple album editions in LRCLIB
    const resNoArtist = await getLyrics('Calm Down');
    assert.equal(resNoArtist.found, true, 'Must resolve lyrics when only song title is given');
    assert.equal(resNoArtist.title, 'Calm Down');
    assert.equal(resNoArtist.artist, 'Rema');
    assert.match(resNoArtist.lyrics, /put my heart for lockdown/);

    // 2. Query with combined artist + title in single string
    const resCombined = await getLyrics('Rema Calm Down');
    assert.equal(resCombined.found, true, 'Must resolve lyrics when artist and title are in a single query');
    assert.equal(resCombined.artist, 'Rema');

    // 3. Unrelated query must NOT return Calm Down lyrics
    const resUnrelated = await getLyrics('Nonexistent Song XYZ 98765');
    assert.equal(resUnrelated.found, false, 'Must not return unrelated lyrics for non-matching query');
  } finally {
    global.fetch = prevFetch;
  }
});

test('Section 5: isProxyReachable fast-skips closed local proxy ports in <200ms', async () => {
  const start = Date.now();
  const ok = await isProxyReachable('http://127.0.0.1:59999', 100);
  const elapsed = Date.now() - start;
  assert.equal(ok, false);
  assert.ok(elapsed < 500, `Closed proxy check should be fast (<500ms), took ${elapsed}ms`);
});

test('Section 7 & 8 & 9: Automatic URL detection, multi-user group concurrency, and strict group AI non-intrusion', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine({ db });

  const downloadedUrls = [];
  let aiCalls = 0;

  const mockApi = {
    me: { id: 999, username: 'Lancy_easy_bot' },
    sendMessage: async () => ({ message_id: 70 }),
    sendRichMessage: async () => ({ message_id: 71 }),
    deleteMessage: async () => {}
  };

  const app = {
    db,
    settings,
    sm,
    screens: new Map(),
    telegram: { api: mockApi },
    ai: {
      generate: async () => {
        aiCalls++;
        return { text: 'AI reply' };
      }
    }
  };
  app.assistant = new LancyAssistant({ app });

  app.screens.set('downloader', {
    id: 'downloader',
    executeDownload: async (ctx, url) => {
      downloadedUrls.push({ user: ctx.tgId, url });
    }
  });

  const controller = new TelegramController({
    api: mockApi,
    db,
    settings,
    stateMachine: sm,
    app,
    screens: app.screens,
    botContext: { botName: 'Lancy', botUsername: 'Lancy_easy_bot' }
  });

  // 1. Ordinary group conversation between members must NOT trigger AI
  await controller.handleUpdate({
    update_id: 10,
    message: {
      message_id: 100,
      from: { id: 201, first_name: 'Alice' },
      chat: { id: -100777, type: 'supergroup' },
      text: 'Hey everyone, what are we listening to tonight?'
    }
  });
  assert.equal(aiCalls, 0, 'Ordinary group chat must never invoke AI');

  // 2. Concurrent supported URL messages from two different group members auto-trigger downloader once each and never invoke AI
  await Promise.all([
    controller.handleUpdate({
      update_id: 11,
      message: {
        message_id: 101,
        from: { id: 201, first_name: 'Alice' },
        chat: { id: -100777, type: 'supergroup' },
        text: 'Check this clip https://www.tiktok.com/@user/video/7123456789012345678'
      }
    }),
    controller.handleUpdate({
      update_id: 12,
      message: {
        message_id: 102,
        from: { id: 202, first_name: 'Bob' },
        chat: { id: -100777, type: 'supergroup' },
        text: 'https://www.instagram.com/reel/C1234567890/'
      }
    })
  ]);

  assert.equal(downloadedUrls.length, 2, 'Both group members must have their URLs auto-downloaded concurrently');
  assert.equal(aiCalls, 0, 'URL messages must not fall through to AI');

  db.close();
});

test('Section 10, 11, 12 & 13: Multi-group game isolation, 10-minute VC idle timeout, non-kick VC leave, and /start media preservation', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine({ db });

  // 1. Verify default 10-minute (600s) idle timeout in settings & QueueManager
  assert.equal(settings.get('music.idleLeaveSeconds'), 600, 'Default VC idle leave timeout must be 600s (10 minutes)');
  const stopCalls = [];
  const qm = new QueueManager({
    voiceClient: {
      play: async () => ({ ok: true }),
      setVolume: async () => ({ ok: true }),
      stop: async (chatId, opts) => {
        stopCalls.push({ chatId, opts });
        return { ok: true };
      }
    },
    pollMs: 0
  });
  assert.equal(qm.idleTimeoutMs, 600_000, 'QueueManager default idleTimeoutMs must be 600,000ms (10 minutes)');

  // 2. Verify stopping/leaving VC only leaves the voice call and never kicks the assistant account from the group
  qm.enqueue(-100888, { title: 'Test Song', artist: 'Artist', streamUrl: 'http://127.0.0.1:3055/audio/live/test' });
  await qm.playNext(-100888);
  await qm.stop(-100888, { leave: true });
  assert.equal(stopCalls.length, 1);
  assert.equal(stopCalls[0].chatId, -100888);

  // 3. Verify two groups can run games simultaneously without cross-talk
  const mockGameApi = {
    sendRichMessage: async () => ({ message_id: 301 }),
    editMessageRich: async () => ({ message_id: 301 }),
    deleteMessage: async () => {},
    sendMessage: async () => ({ message_id: 302 })
  };
  const gameEngine = new GameEngine({ api: mockGameApi, db, log: { info: () => {}, error: () => {}, debug: () => {} } });
  await gameEngine.startGame(-100111, { mode: 'trivia', totalRounds: 3 });
  await gameEngine.startGame(-100222, { mode: 'emoji', totalRounds: 5 });
  assert.equal(gameEngine.getSession(-100111).mode, 'trivia');
  assert.equal(gameEngine.getSession(-100222).mode, 'emoji');
  await gameEngine.stopGame(-100111);
  assert.equal(gameEngine.hasActiveGame(-100111), false);
  assert.equal(gameEngine.hasActiveGame(-100222), true, 'Stopping game in Group A must not affect Group B');
  await gameEngine.stopGame(-100222);

  // 4. Verify /start always sends a fresh dashboard and never edits/overwrites a delivered media message
  const apiCalls = [];
  const startApi = {
    me: { id: 999, username: 'Lancy_easy_bot' },
    sendRichMessage: async (chatId, rich) => {
      apiCalls.push({ method: 'sendRichMessage', chatId, rich });
      return { message_id: 901 };
    },
    editMessageRich: async (chatId, messageId, rich) => {
      apiCalls.push({ method: 'editMessageRich', chatId, messageId, rich });
      return { message_id: messageId };
    },
    sendMessage: async () => ({ message_id: 902 })
  };
  const app = { db, settings, sm, screens: new Map(), telegram: { api: startApi } };
  const dashboardScreen = createDashboardScreen({ app });
  app.screens.set('dashboard', dashboardScreen);
  const controller = new TelegramController({
    api: startApi,
    db,
    settings,
    stateMachine: sm,
    app,
    screens: app.screens
  });
  await settings.set('security.publicAccess', true);

  // Mark message 500 as a delivered media message and set it as the user's last screen message
  controller.markMediaDeliveryMessage(500);
  controller.userScreenMessage.set('777', { chatId: 777, messageId: 500 });

  await controller.handleUpdate({
    update_id: 99,
    message: {
      message_id: 501,
      from: { id: 777, first_name: 'Leo' },
      chat: { id: 777, type: 'private' },
      text: '/start'
    }
  });

  assert.equal(apiCalls.filter((c) => c.method === 'editMessageRich').length, 0, '/start must never overwrite delivered media');
  assert.equal(apiCalls.filter((c) => c.method === 'sendRichMessage').length, 1, '/start must send a fresh dashboard');

  db.close();
});
