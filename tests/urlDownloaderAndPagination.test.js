import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { unlinkSync, existsSync } from 'node:fs';
import { MediaDownloader } from '../src/media/downloader.js';
import { Database } from '../src/core/db.js';
import { SettingsManager } from '../src/config/settings.js';
import { StickerPackService } from '../src/stickers/packService.js';
import { StateMachine, States } from '../src/core/stateMachine.js';
import { createDownloaderScreen } from '../src/telegram/screens/downloader.js';
import { createStickersScreen } from '../src/telegram/screens/stickers.js';
import { TelegramController } from '../src/telegram/bot.js';

const execFileAsync = promisify(execFile);

test('MediaDownloader platform detection works across all major platforms', () => {
  const dl = new MediaDownloader();

  assert.equal(dl.detectPlatform('https://www.tiktok.com/@user/video/123456789'), 'tiktok');
  assert.equal(dl.detectPlatform('https://vt.tiktok.com/ZS123456/'), 'tiktok');
  assert.equal(dl.detectPlatform('https://vm.tiktok.com/ZM123456/'), 'tiktok');
  assert.equal(dl.detectPlatform('https://www.instagram.com/reel/C8qL8GSpV1d/'), 'instagram');
  assert.equal(dl.detectPlatform('https://www.instagram.com/p/C-fP3Y4sX_Z/'), 'instagram');
  assert.equal(dl.detectPlatform('https://www.pinterest.com/pin/1049902094380628628/'), 'pinterest');
  assert.equal(dl.detectPlatform('https://pin.it/7abcXYZ'), 'pinterest');
  assert.equal(dl.detectPlatform('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'youtube');
  assert.equal(dl.detectPlatform('https://youtu.be/dQw4w9WgXcQ'), 'youtube');
  assert.equal(dl.detectPlatform('https://x.com/jack/status/20'), 'twitter');
  assert.equal(dl.detectPlatform('https://twitter.com/user/status/1234'), 'twitter');
  assert.equal(dl.detectPlatform('https://example.com/cute_video.mp4'), 'direct-video');
  assert.equal(dl.detectPlatform('https://example.com/cute_photo.jpg'), 'direct-photo');
  assert.equal(dl.detectPlatform('https://example.com/cute_song.mp3'), 'direct-audio');
  assert.equal(dl.detectPlatform('https://facebook.com/watch/?v=123'), 'facebook');
  assert.equal(dl.detectPlatform('https://reddit.com/r/anime/comments/123'), 'reddit');
  assert.equal(dl.detectPlatform('https://threads.net/@user/post/123'), 'threads');
  assert.equal(dl.detectPlatform('https://some-random-website.com/article'), 'generic');
  assert.equal(dl.detectPlatform('Die With A Smile'), 'music-search');
  assert.equal(dl.detectPlatform('Kendrick Lamar Not Like Us'), 'music-search');
  assert.equal(dl.detectPlatform('music: Gojo Theme'), 'music-search');
});

test('MediaDownloader extracts MP3 audio from video with sound and handles silent video cleanly', async () => {
  const dl = new MediaDownloader();
  const tmpVideoWithAudio = '/tmp/test_dl_with_audio.mp4';
  const tmpVideoSilent = '/tmp/test_dl_silent.mp4';

  try {
    // Generate a 1-second video with an audio tone
    await execFileAsync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x120:rate=10',
      '-f', 'lavfi', '-i', 'sine=frequency=800:duration=1',
      '-c:v', 'libx264', '-c:a', 'aac', tmpVideoWithAudio
    ]);

    // Generate a 1-second silent video
    await execFileAsync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x120:rate=10',
      '-c:v', 'libx264', tmpVideoSilent
    ]);

    const fs = await import('node:fs');
    const bufWithAudio = fs.readFileSync(tmpVideoWithAudio);
    const bufSilent = fs.readFileSync(tmpVideoSilent);

    const extractedAudio = await dl.extractAudioFromBuffer(bufWithAudio);
    assert.ok(extractedAudio, 'should successfully extract audio track');
    assert.ok(Buffer.isBuffer(extractedAudio));
    assert.ok(extractedAudio.length > 1024, 'extracted MP3 should be valid size');

    // Silent video should return null without throwing an exception
    const silentResult = await dl.extractAudioFromBuffer(bufSilent);
    assert.equal(silentResult, null, 'silent video should return null');
  } finally {
    if (existsSync(tmpVideoWithAudio)) unlinkSync(tmpVideoWithAudio);
    if (existsSync(tmpVideoSilent)) unlinkSync(tmpVideoSilent);
  }
});

test('Add Imported Sticker: listAvailablePacks pagination slices correctly per page', () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const packs = new StickerPackService({ db, settings, stickerService: null, media: null });
  const userId = 777123;

  // Insert 12 sticker packs for user 777123
  for (let i = 1; i <= 12; i++) {
    db.run(
      `INSERT INTO sticker_packs (user_id, tg_title, tg_short_name, count, sticker_type, modified_at)
       VALUES (?, ?, ?, ?, 'static', datetime('now', '-${i} minutes'))`,
      userId, `Cute Pack ${i}`, `pack_${i}`, i
    );
  }

  // Also insert packs for a different user (to ensure workspace isolation)
  db.run(
    `INSERT INTO sticker_packs (user_id, tg_title, tg_short_name, count, sticker_type, modified_at)
     VALUES (?, 'Other User Pack', 'other_pack', 5, 'static', datetime('now'))`,
    888999
  );

  // Test page 1 with limit 5
  const page1 = packs.listAvailablePacks(userId, { limit: 5, offset: 0, stickerType: 'static' });
  assert.equal(page1.total, 12, 'total available packs should be 12');
  assert.equal(page1.packs.length, 5, 'page 1 should return exactly 5 packs');
  assert.equal(page1.packs[0].title, 'Cute Pack 1');
  assert.equal(page1.packs[4].title, 'Cute Pack 5');

  // Test page 2 with limit 5 (offset 5)
  const page2 = packs.listAvailablePacks(userId, { limit: 5, offset: 5, stickerType: 'static' });
  assert.equal(page2.total, 12);
  assert.equal(page2.packs.length, 5, 'page 2 should return 5 packs');
  assert.equal(page2.packs[0].title, 'Cute Pack 6');
  assert.equal(page2.packs[4].title, 'Cute Pack 10');

  // Test page 3 with limit 5 (offset 10)
  const page3 = packs.listAvailablePacks(userId, { limit: 5, offset: 10, stickerType: 'static' });
  assert.equal(page3.total, 12);
  assert.equal(page3.packs.length, 2, 'page 3 should return remaining 2 packs');
  assert.equal(page3.packs[0].title, 'Cute Pack 11');
  assert.equal(page3.packs[1].title, 'Cute Pack 12');

  // Ensure workspace isolation: other user only sees their own pack
  const otherPacks = packs.listAvailablePacks(888999, { limit: 5, offset: 0, stickerType: 'static' });
  assert.equal(otherPacks.total, 1);
  assert.equal(otherPacks.packs[0].title, 'Other User Pack');
});

test('Stickers screen waAddChoose renders pagination buttons when total packs > pageSize', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const packs = new StickerPackService({ db, settings, stickerService: null, media: null });
  const userId = 999888;

  // Insert 7 static sticker packs
  for (let i = 1; i <= 7; i++) {
    db.run(
      `INSERT INTO sticker_packs (user_id, tg_title, tg_short_name, count, sticker_type, modified_at)
       VALUES (?, ?, ?, ?, 'static', datetime('now', '-${i} minutes'))`,
      userId, `Aesthetic Pack ${i}`, `aes_${i}`, 5
    );
  }

  let lastSentRich = null;
  const mockApi = {
    editMessageRich: async (_chatId, _msgId, rich) => {
      lastSentRich = rich;
      return { message_id: 123 };
    },
    sendRichMessage: async (_chatId, rich) => {
      lastSentRich = rich;
      return { message_id: 123 };
    }
  };

  const mockApp = {
    telegram: { api: mockApi },
    packs,
    inboundHandler: {
      getImport: (_token) => ({
        token: 'test_token',
        count: 2,
        sticker_type: 'static',
        items: []
      })
    }
  };

  const stickersScreen = createStickersScreen({ app: mockApp });
  const mockCtx = {
    tgId: String(userId),
    chatId: userId,
    messageId: 100,
    settings,
    editScreen: async (rich) => {
      lastSentRich = rich;
      return { message_id: 100 };
    },
    reply: (text) => text
  };

  function extractButtonTexts(rich) {
    return rich.blocks.filter((b) => b.type === 'buttons').flatMap((b) => b.buttons.map((btn) => JSON.stringify(btn.text)));
  }

  // Render Page 1
  await stickersScreen.handle(mockCtx, 'waAddChoose', ['test_token', '1']);
  assert.ok(lastSentRich, 'rich message should be generated');

  const buttonTexts = extractButtonTexts(lastSentRich);
  assert.ok(buttonTexts.some((t) => t.includes('Aesthetic Pack 1')));
  assert.ok(buttonTexts.some((t) => t.includes('Aesthetic Pack 5')));
  assert.ok(!buttonTexts.some((t) => t.includes('Aesthetic Pack 6')), 'Pack 6 should not be on page 1');
  assert.ok(buttonTexts.some((t) => t.includes('Next »')), 'Next button should be present on page 1');
  assert.ok(buttonTexts.some((t) => t.includes('• 1/2 •')), 'Page counter should show 1/2');

  // Render Page 2
  await stickersScreen.handle(mockCtx, 'waAddChoose', ['test_token', '2']);
  const buttonTextsPage2 = extractButtonTexts(lastSentRich);
  assert.ok(buttonTextsPage2.some((t) => t.includes('Aesthetic Pack 6')));
  assert.ok(buttonTextsPage2.some((t) => t.includes('Aesthetic Pack 7')));
  assert.ok(buttonTextsPage2.some((t) => t.includes('« Prev')), 'Prev button should be present on page 2');
  assert.ok(buttonTextsPage2.some((t) => t.includes('• 2/2 •')), 'Page counter should show 2/2');
});

test('Downloader Screen renders aesthetic menu and registers URL_DOWNLOADER_INPUT state handler', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine();

  let editedRich = null;
  const mockCtx = {
    tgId: '123456',
    chatId: 123456,
    messageId: 50,
    settings,
    sm,
    editScreen: async (rich) => {
      editedRich = rich;
      return { message_id: 50 };
    }
  };

  const dlScreen = createDownloaderScreen({
    app: {
      telegram: { api: {} },
      mediaDownloader: new MediaDownloader()
    }
  });

  // Verify menu render
  await dlScreen.open(mockCtx);
  assert.ok(editedRich);
  const btnTexts = editedRich.blocks.filter((b) => b.type === 'buttons').flatMap((b) => b.buttons.map((btn) => btn.text));
  assert.ok(btnTexts.some((t) => t.includes('Paste / Send Link')));
  assert.ok(btnTexts.some((t) => t.includes('Dashboard')));

  // Verify state handlers registration
  dlScreen.registerStateHandlers(sm);
  assert.ok(sm.handlers.has(States.URL_DOWNLOADER_INPUT));
  assert.equal(typeof sm.handlers.get(States.URL_DOWNLOADER_INPUT).onMessage, 'function');
});

test('Downloader Screen input prompt displays transparent list of supported platforms without vague ellipsis', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine();

  let editedRich = null;
  const mockCtx = {
    tgId: '123456',
    chatId: 123456,
    messageId: 50,
    settings,
    sm,
    editScreen: async (rich) => {
      editedRich = rich;
      return { message_id: 50 };
    }
  };

  const dlScreen = createDownloaderScreen({
    app: {
      telegram: { api: {} },
      mediaDownloader: new MediaDownloader()
    }
  });

  await dlScreen.handle(mockCtx, 'input');
  assert.ok(editedRich);

  // Extract all text content
  const fullText = JSON.stringify(editedRich);
  assert.ok(fullText.includes('TikTok'));
  assert.ok(fullText.includes('Instagram'));
  assert.ok(fullText.includes('Pinterest'));
  assert.ok(fullText.includes('YouTube'));
  assert.ok(fullText.includes('Twitter / X'));
  assert.ok(fullText.includes('CapCut'));
  assert.ok(fullText.includes('Spotify'));
  assert.ok(!fullText.includes('Twitter/X…'), 'must not contain vague ellipsis');
});

test('MediaDownloader detects CapCut and Spotify platforms correctly', () => {
  const dl = new MediaDownloader();
  assert.equal(dl.detectPlatform('https://www.capcut.com/template-detail/12345'), 'capcut');
  assert.equal(dl.detectPlatform('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT'), 'spotify');
});

test('MediaDownloader end-to-end: Pinterest video download extracts video and audio track', async () => {
  const dl = new MediaDownloader();
  const res = await dl.download('https://pin.it/4ioQSe9HL');
  assert.equal(res.platform, 'pinterest');
  assert.equal(res.mediaItems.length, 1);
  assert.equal(res.mediaItems[0].type, 'video');
  assert.ok(res.mediaItems[0].buffer.length > 100000);
  assert.ok(res.audioTrack, 'Pinterest video should extract audio track');
  assert.ok(res.audioTrack.buffer.length > 10000);
});

test('MediaDownloader end-to-end: Pinterest album download extracts all carousel photos', async () => {
  const dl = new MediaDownloader();
  const res = await dl.download('https://pin.it/2WiRqWBjo');
  assert.equal(res.platform, 'pinterest');
  assert.ok(res.mediaItems.length >= 2, 'should extract photos in the album');
  for (const item of res.mediaItems) {
    assert.equal(item.type, 'photo');
    assert.ok(item.buffer.length > 10000);
  }
});

test('MediaDownloader end-to-end: TikTok video download extracts clean video and audio track', async () => {
  const dl = new MediaDownloader();
  const res = await dl.download('https://vm.tiktok.com/ZSbt4PsUY/');
  assert.equal(res.platform, 'tiktok');
  assert.equal(res.mediaItems.length, 1);
  assert.equal(res.mediaItems[0].type, 'video');
  assert.ok(res.mediaItems[0].buffer.length > 500000);
  assert.ok(res.audioTrack, 'TikTok video should extract audio track');
  assert.ok(res.audioTrack.buffer.length > 10000);
});

test('Downloader Screen delivers video, photos and audio inside ONE unified Rich Message', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine();

  let finalRich = null;
  let finalFiles = null;
  const mockApi = {
    sendRichMessage: async (chatId, rich, extra, files) => {
      finalRich = rich;
      finalFiles = files;
      return { message_id: 100 };
    },
    editMessageText: async (chatId, msgId, text, extra, files) => {
      finalRich = extra?.rich_message;
      finalFiles = files;
      return { message_id: msgId };
    },
    sendChatAction: async () => true
  };

  const fakeDownloader = {
    download: async () => ({
      platform: 'tiktok',
      title: 'Aesthetic Dance',
      mediaItems: [
        { type: 'video', buffer: Buffer.from('fake-video'), filename: 'vid.mp4', mimeType: 'video/mp4' }
      ],
      audioTrack: {
        buffer: Buffer.from('fake-audio'),
        filename: 'sound.mp3',
        title: 'Original Sound'
      }
    })
  };

  const dlScreen = createDownloaderScreen({
    app: {
      telegram: { api: mockApi },
      mediaDownloader: fakeDownloader
    }
  });

  const ctx = {
    tgId: '123456',
    chatId: 123456,
    messageId: 50,
    settings,
    sm,
    api: mockApi
  };

  await dlScreen.executeDownload(ctx, 'https://vm.tiktok.com/fake');

  assert.ok(finalRich, 'unified rich message must be delivered');
  assert.ok(finalFiles, 'multipart files must be provided');

  // Verify video block is present in rich message
  const videoBlock = finalRich.blocks.find((b) => b.type === 'video');
  assert.ok(videoBlock, 'rich message must contain video block');
  assert.equal(videoBlock.video.media, 'attach://video_0');
  assert.ok(finalFiles.video_0);

  // Verify audio block is present in rich message
  const audioBlock = finalRich.blocks.find((b) => b.type === 'audio');
  assert.ok(audioBlock, 'rich message must contain audio block');
  assert.equal(audioBlock.audio.media, 'attach://audio_track');
  assert.ok(finalFiles.audio_track);

  // Verify info table and buttons are present
  assert.ok(finalRich.blocks.some((b) => b.type === 'table'));
  assert.ok(finalRich.blocks.some((b) => b.type === 'buttons'));

  db.close();
});

test('Downloader Screen delivers multi-photo carousel as swipeable slideshow instead of album collage', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine();

  let finalRich = null;
  let finalFiles = null;

  const mockApi = {
    sendRichMessage: async (chatId, rich, extra, files) => {
      finalRich = rich;
      finalFiles = files;
      return { message_id: 101 };
    },
    editMessageText: async (chatId, msgId, text, extra, files) => {
      finalRich = extra?.rich_message;
      finalFiles = files;
      return { message_id: msgId };
    },
    sendChatAction: async () => true
  };

  const fakeDownloader = {
    download: async () => ({
      platform: 'tiktok',
      title: 'Aesthetic Slideshow',
      mediaItems: [
        { type: 'photo', buffer: Buffer.from('photo-1'), filename: 'p1.jpg', mimeType: 'image/jpeg' },
        { type: 'photo', buffer: Buffer.from('photo-2'), filename: 'p2.jpg', mimeType: 'image/jpeg' },
        { type: 'photo', buffer: Buffer.from('photo-3'), filename: 'p3.jpg', mimeType: 'image/jpeg' }
      ]
    })
  };

  const dlScreen = createDownloaderScreen({
    app: {
      telegram: { api: mockApi },
      mediaDownloader: fakeDownloader
    }
  });

  const ctx = {
    tgId: '123456',
    chatId: 123456,
    messageId: 51,
    settings,
    sm,
    api: mockApi
  };

  await dlScreen.executeDownload(ctx, 'https://vm.tiktok.com/slideshow_test');

  assert.ok(finalRich, 'rich message must be delivered');
  const slideshowBlock = finalRich.blocks.find((b) => b.type === 'slideshow');
  assert.ok(slideshowBlock, 'media carousel must be sent as slideshow');
  assert.equal(slideshowBlock.blocks.length, 3, 'slideshow must contain all 3 photos');
  assert.equal(finalRich.blocks.some((b) => b.type === 'collage'), false, 'must NOT be sent as collage album');
  assert.ok(finalFiles.photo_0);
  assert.ok(finalFiles.photo_1);
  assert.ok(finalFiles.photo_2);

  db.close();
});

test('TelegramController editScreen: sends a fresh rich message when navigating away from a delivered media card', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine();

  const sentRichMessages = [];
  const editedRichMessages = [];

  const mockApi = {
    sendRichMessage: async (chatId, rich, extra, files) => {
      const msg = { message_id: 501, chat: { id: chatId } };
      sentRichMessages.push({ chatId, rich, extra, files });
      return msg;
    },
    editMessageRich: async (chatId, msgId, rich, extra, files) => {
      const msg = { message_id: msgId, chat: { id: chatId } };
      editedRichMessages.push({ chatId, msgId, rich, extra, files });
      return msg;
    }
  };

  const bot = new TelegramController({ api: mockApi, db, settings, sm });

  // 1. Normal menu callback: editScreen should edit in-place
  const normalQuery = {
    id: 'q1',
    from: { id: 12345, username: 'testuser' },
    message: { message_id: 100, chat: { id: 12345 }, text: 'Normal Menu' }
  };
  const ctxNormal = bot.createContext(12345, normalQuery);
  const dummyRich1 = { blocks: [{ type: 'header', text: 'New Menu' }] };
  await ctxNormal.editScreen(dummyRich1);

  assert.equal(editedRichMessages.length, 1, 'normal menu callback must edit in-place');
  assert.equal(editedRichMessages[0].msgId, 100);
  assert.equal(sentRichMessages.length, 0, 'normal menu must not send a new message');

  // 2. Mark message 200 as delivered media (e.g. from downloader or pinterest or stickers)
  bot.markMediaDeliveryMessage(200);
  assert.ok(bot.isMediaDeliveryMessageId(200));

  const mediaDeliveryQuery = {
    id: 'q2',
    from: { id: 12345, username: 'testuser' },
    message: { message_id: 200, chat: { id: 12345 }, text: 'Media card with video and audio' }
  };
  const ctxMedia = bot.createContext(12345, mediaDeliveryQuery);
  const dummyRich2 = { blocks: [{ type: 'header', text: 'Back to Dashboard' }] };
  await ctxMedia.editScreen(dummyRich2);

  // Assert that instead of editing message 200, it sent a brand new message (preserving media 200)
  assert.equal(sentRichMessages.length, 1, 'navigating from media card must send a fresh message');
  assert.equal(sentRichMessages[0].chatId, 12345);
  // Edited messages count should still be 1 (from the first normal test)
  assert.equal(editedRichMessages.length, 1, 'media card must NOT be edited in-place');

  // 3. Test native media message (e.g. msg with video property) even without explicit mark
  const nativeVideoQuery = {
    id: 'q3',
    from: { id: 12345, username: 'testuser' },
    message: { message_id: 300, chat: { id: 12345 }, video: { file_id: 'vid123' } }
  };
  const ctxNativeVideo = bot.createContext(12345, nativeVideoQuery);
  await ctxNativeVideo.editScreen(dummyRich2);

  assert.equal(sentRichMessages.length, 2, 'navigating from native video message must send a fresh message');
  assert.equal(editedRichMessages.length, 1, 'native video message must NOT be edited in-place');

  db.close();
});

test('Downloader Screen & MediaDownloader: music search query delivers Spotify MP3 and artwork', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine();

  let deliveredRich = null;
  let deliveredFiles = null;
  const mockApi = {
    sendRichMessage: async (chatId, rich, extra, files) => {
      deliveredRich = rich;
      deliveredFiles = files;
      return { message_id: 888 };
    },
    editMessageRich: async (chatId, msgId, rich, extra, files) => {
      deliveredRich = rich;
      deliveredFiles = files;
      return { message_id: msgId };
    },
    sendChatAction: async () => true
  };

  const fakeDownloader = {
    download: async (query) => {
      assert.equal(query, 'Die With A Smile');
      return {
        sourceUrl: query,
        platform: 'spotify',
        title: 'Lady Gaga, Bruno Mars - Die With A Smile',
        author: 'Lady Gaga',
        mediaItems: [{
          type: 'photo',
          buffer: Buffer.from('fake-cover-art'),
          filename: 'cover.jpg',
          mimeType: 'image/jpeg'
        }],
        audioTrack: {
          buffer: Buffer.from('fake-mp3-bytes'),
          filename: 'Die With A Smile.mp3',
          title: 'Die With A Smile',
          performer: 'Lady Gaga, Bruno Mars'
        }
      };
    }
  };

  const dlScreen = createDownloaderScreen({
    app: {
      telegram: { api: mockApi },
      mediaDownloader: fakeDownloader
    }
  });

  dlScreen.registerStateHandlers(sm);

  // Simulate user sending plain text song title in URL_DOWNLOADER_INPUT state
  await sm.transition('12345', States.URL_DOWNLOADER_INPUT);
  const handled = await sm.handleMessage('12345', {
    chatId: 12345,
    message_id: 777,
    text: 'Die With A Smile'
  });

  assert.equal(handled, true, 'music search query should be handled by downloader input state');
  assert.ok(deliveredRich, 'delivered rich message must exist');
  assert.ok(deliveredFiles, 'delivered files must exist');
  assert.ok(deliveredFiles.audio_track, 'audio_track file must be included in delivery');
  assert.ok(deliveredFiles.photo_0, 'cover art photo must be included in delivery');
  const audioBlock = deliveredRich.blocks.find((b) => b.type === 'audio');
  assert.equal(audioBlock?.caption, undefined, 'Music audio block has no caption to avoid vertical collision with player and table');

  db.close();
});

test('MediaDownloader.download does not reject music search strings with URL check error', () => {
  const dl = new MediaDownloader();
  assert.equal(dl.detectPlatform('Billie Eilish Birds of a Feather'), 'music-search');
  assert.equal(dl.detectPlatform('lithe'), 'music-search');
});

test('Dashboard handle from_media forces fresh message to prevent overwriting media', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine(db);

  const queryMsg = {
    message_id: 888,
    video: { file_id: 'vid_123' },
    caption: '𓆩♡𓆪 TIKTOK DOWNLOAD 𓆩♡𓆪'
  };

  const fakeController = {
    isMediaDeliveryMessage: (msg) => Boolean(msg?.video || msg?.photo)
  };

  let openedForceNew = null;
  const ctx = {
    tgId: '12345',
    chatId: 12345,
    query: { message: queryMsg },
    controller: fakeController,
    db,
    settings,
    sm,
    sendRichMessage: async () => { openedForceNew = true; return { message_id: 999 }; },
    editScreen: async () => { openedForceNew = false; return { message_id: 888 }; }
  };

  const { createDashboardScreen } = await import('../src/telegram/screens/dashboard.js');
  const dashboard = createDashboardScreen({ app: { whatsapp: null, db, settings } });

  await dashboard.handle(ctx, 'open', ['from_media']);

  assert.equal(openedForceNew, true, 'must force new message when returning from media card');
  assert.equal(ctx.controller.isMediaDeliveryMessage(queryMsg), true);
  db.close();
});

test('MediaDownloader: detects Instagram profile URLs and guides user to specific post/reel', async () => {
  const { MediaDownloader } = await import('../src/media/downloader.js');
  const dl = new MediaDownloader();

  // 1. Profile URLs
  assert.equal(dl.isInstagramProfileUrl('https://www.instagram.com/ilov.etulips1?stkn=N2NqbTBsMzlpNzUy'), 'ilov.etulips1');
  assert.equal(dl.isInstagramProfileUrl('https://instagram.com/selenagomez/'), 'selenagomez');
  assert.equal(dl.isInstagramProfileUrl('https://www.instagram.com/p/DBxyz123/'), null);
  assert.equal(dl.isInstagramProfileUrl('https://www.instagram.com/reel/C-abc987/'), null);

  // 2. Download profile URL throws friendly guidance
  await assert.rejects(
    async () => dl.download('https://www.instagram.com/ilov.etulips1?stkn=N2NqbTBsMzlpNzUy'),
    (err) => {
      assert.ok(err.message.includes('Instagram profile link detected (@ilov.etulips1)'));
      assert.ok(err.message.includes('Tap the specific Reel or Post'));
      return true;
    }
  );
});



