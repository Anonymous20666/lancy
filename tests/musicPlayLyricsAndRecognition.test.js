import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getLyrics, formatBlockquoteLyrics, chunkLyrics, searchSongByLyrics, cleanSongMetadata } from '../src/media/lyrics.js';
import { recognizeAudio, extractMediaForMusicRecognition } from '../src/media/recognizer.js';
import { createDashboardScreen } from '../src/telegram/screens/dashboard.js';
import { createDownloaderScreen } from '../src/telegram/screens/downloader.js';
import { Database } from '../src/core/db.js';
import { SettingsManager } from '../src/config/settings.js';
import { StateMachine, States } from '../src/core/stateMachine.js';

test('Lyrics Engine: getLyrics retrieves and formatBlockquoteLyrics formats in blockquote', async () => {
  const result = await getLyrics('Blinding Lights', 'The Weeknd');
  assert.equal(result.found, true);
  assert.ok(result.lyrics && result.lyrics.length > 20, 'Lyrics content is populated');

  const formatted = formatBlockquoteLyrics(result.lyrics);
  assert.ok(formatted.startsWith('>'), 'Blockquote formatting prepends > to lines');
  assert.ok(formatted.includes('\n>'), 'Contains multiple blockquote lines');
});

test('Audio Recognizer: recognizeAudio handles audio buffers safely', async () => {
  // Invalid buffer handling
  const badRes = await recognizeAudio(Buffer.from('not an audio buffer'));
  assert.equal(badRes.success, false);
  assert.ok(badRes.reason);
});

test('Dashboard: renders 🎵 Play Music button in quick actions', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine();
  const app = {
    whatsapp: { listForUser: () => [] },
    ai: { status: async () => ({ enabled: true, available: true, provider: 'ollama' }) },
    media: { cache: { stats: () => ({ entries: 0, totalBytes: 0 }) } }
  };

  const dashboard = createDashboardScreen({ app });
  const ctx = {
    tgId: '100',
    db,
    settings,
    sm,
    user: { first_name: 'Hero' },
    api: {}
  };

  const stats = { sessions: [], online: 0, packs: 0, searches: 0, delivered: 0, ai: null, cacheStats: { entries: 0 } };
  // Access open
  let sentRich = null;
  ctx.sendRichMessage = async (rich) => { sentRich = rich; return { message_id: 999 }; };

  await dashboard.open(ctx, { forceNew: true });
  assert.ok(sentRich, 'Sent rich dashboard');

  const allButtons = sentRich.blocks.filter((b) => b.type === 'buttons').flatMap((b) => b.buttons);
  const playBtn = allButtons.find((btn) => btn.callback_data === 'l1:downloader:play');
  assert.ok(playBtn, 'Dashboard contains 🎵 Play Music button');
  const btnText = typeof playBtn.text === 'string' ? playBtn.text : JSON.stringify(playBtn.text);
  assert.ok(btnText.includes('Play Music'), 'Button label is Play Music');
});

test('Downloader Screen: handles play prompt and sends lyrics as new message without editing media', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine();
  const app = {
    telegram: { api: {}, markMediaDeliveryMessage: () => {} },
    mediaDownloader: {
      download: async () => ({
        platform: 'spotify',
        title: 'Save Your Tears',
        artist: 'The Weeknd',
        mediaItems: [],
        audioTrack: { buffer: Buffer.from('fake-mp3'), title: 'Save Your Tears', performer: 'The Weeknd' }
      })
    }
  };

  const downloader = createDownloaderScreen({ app });
  let editedRich = null;
  const sentMessages = [];
  const ctx = {
    tgId: '100',
    chatId: 100,
    db,
    settings,
    sm,
    api: {
      answerCallbackQuery: async () => true,
      sendMessage: async (chatId, text, opts) => {
        sentMessages.push({ chatId, text, opts });
        return { message_id: 2000 + sentMessages.length };
      }
    },
    editScreen: async (rich) => { editedRich = rich; return { message_id: 1000 }; }
  };

  // 1. Play action opens Music Search Prompt with Audio Recognition
  await downloader.handle(ctx, 'play', []);
  assert.ok(editedRich, 'Play prompt rendered');
  const playText = JSON.stringify(editedRich);
  assert.ok(playText.includes('PLAY & DOWNLOAD MUSIC'), 'Prompt title correct');
  assert.ok(playText.includes('Audio Recognition'), 'Play prompt includes Audio Recognition button and guide');

  // 1b. Recognize action opens dedicated Audio Recognition prompt
  editedRich = null;
  await downloader.handle(ctx, 'recognize', []);
  assert.ok(editedRich, 'Audio Recognition prompt rendered');
  const recText = JSON.stringify(editedRich);
  assert.ok(recText.includes('AUDIO & MUSIC RECOGNITION'), 'Audio recognition prompt rendered');

  // 2. Lyrics action NEVER edits screen (preserves media!) and sends new message
  editedRich = null;
  await downloader.handle(ctx, 'lyrics', ['fake-key']);
  assert.equal(editedRich, null, 'Lyrics action must NEVER edit the screen or media!');
  assert.ok(sentMessages.length > 0, 'Sent lyrics as new message');
  const firstMsg = sentMessages[0].text;
  assert.ok(firstMsg.includes('Could not find lyrics') || firstMsg.includes('blockquote'), 'Appropriate lyrics response');
});

test('Media Recognition: extractMediaForMusicRecognition handles video, audio, vn and documents', () => {
  assert.equal(extractMediaForMusicRecognition({ video: { file_id: 'vid_1' } })?.type, 'video');
  assert.equal(extractMediaForMusicRecognition({ video_note: { file_id: 'vn_1' } })?.type, 'video_note');
  assert.equal(extractMediaForMusicRecognition({ voice: { file_id: 'vc_1' } })?.type, 'voice');
  assert.equal(extractMediaForMusicRecognition({ audio: { file_id: 'aud_1' } })?.type, 'audio');
  assert.equal(extractMediaForMusicRecognition({ document: { file_id: 'doc_v', mime_type: 'video/mp4' } })?.type, 'video');
  assert.equal(extractMediaForMusicRecognition({ document: { file_id: 'doc_a', file_name: 'track.mp3' } })?.type, 'audio');
  assert.equal(extractMediaForMusicRecognition({ text: 'just text' }), null);
});

test('Downloader State: onMessage passes video, voice notes, and audio files to handleAudioRecognition', async () => {
  let recognizedMedia = null;
  const mockController = {
    handleAudioRecognition: async (ctx, mediaObj, message) => {
      recognizedMedia = mediaObj;
      return true;
    }
  };
  const app = {
    telegram: { controller: mockController, api: {} },
    mediaDownloader: {}
  };
  const sm = new StateMachine();
  const downloader = createDownloaderScreen({ app });
  downloader.registerStateHandlers(sm);

  await sm.transition('100', States.URL_DOWNLOADER_INPUT);

  // 1. Voice note (vn)
  const fakeVoiceMsg = {
    voice: { file_id: 'voice_123' },
    chat: { id: 100 },
    from: { id: 100 }
  };
  let handled = await sm.handleMessage('100', fakeVoiceMsg);
  assert.equal(handled, true);
  assert.equal(recognizedMedia?.file_id, 'voice_123', 'Audio note routed to handleAudioRecognition');

  // 2. Video file (vid)
  const fakeVideoMsg = {
    video: { file_id: 'video_456' },
    chat: { id: 100 },
    from: { id: 100 }
  };
  handled = await sm.handleMessage('100', fakeVideoMsg);
  assert.equal(handled, true);
  assert.equal(recognizedMedia?.file_id, 'video_456', 'Video file routed to handleAudioRecognition');

  // 3. Document video (uploaded as file)
  const fakeDocVideoMsg = {
    document: { file_id: 'doc_vid_789', mime_type: 'video/quicktime', file_name: 'clip.mov' },
    chat: { id: 100 },
    from: { id: 100 }
  };
  handled = await sm.handleMessage('100', fakeDocVideoMsg);
  assert.equal(handled, true);
  assert.equal(recognizedMedia?.file_id, 'doc_vid_789', 'Document video routed to handleAudioRecognition');
});

test('Lyrics Engine: chunkLyrics splits long lyrics into continuation messages with blockquote', () => {
  const longLyrics = Array(80).fill('Verse line that repeats over and over again to build long lyrics text.').join('\n');
  assert.ok(longLyrics.length > 5000, 'Test lyrics exceeds 5000 chars');

  const chunks = chunkLyrics(longLyrics, 3400);
  assert.ok(chunks.length >= 2, 'Split into at least 2 chunks');
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 3400, 'Each chunk within max limit');
  }
  assert.equal(chunks.join('\n'), longLyrics, 'Recombining chunks preserves exact lyrics content');
});

test('Zero Media Message Editing: clicking play or input from media card sends fresh message and never edits media', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine();
  let deliveredRich = null;
  const app = {
    telegram: {
      api: {
        sendRichMessage: async () => ({ message_id: 111 }),
        editMessageRich: async () => { throw new Error('Cannot edit delivered media!'); }
      },
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
        mediaItems: [{ type: 'photo', buffer: Buffer.from('photo') }],
        audioTrack: { buffer: Buffer.from('fake-mp3'), title: 'Starboy', performer: 'The Weeknd' }
      })
    }
  };

  const downloader = createDownloaderScreen({ app });

  // 1. Simulate download execution and verify all action buttons carry ['from_media']
  let trackerFinished = false;
  const origExecute = downloader.executeDownload;
  const mockCtx = {
    tgId: '100',
    chatId: 100,
    messageId: null,
    db,
    settings,
    sm,
    api: app.telegram.api,
    controller: app.telegram.controller
  };

  // Run download to inspect generated buttons
  let finishedRich = null;
  app.telegram.api.editMessageRich = async () => { throw new Error('Edit not supported'); };
  app.telegram.api.sendRichMessage = async (_c, rich) => {
    finishedRich = rich;
    return { message_id: 555 };
  };

  await downloader.executeDownload(mockCtx, 'Starboy The Weeknd');
  assert.ok(finishedRich, 'Delivery card was rendered');

  const allButtons = finishedRich.blocks.filter((b) => b.type === 'buttons').flatMap((b) => b.buttons);
  const playBtn = allButtons.find((btn) => btn.callback_data.includes(':play'));
  assert.ok(playBtn, 'Contains Play Another button');
  assert.ok(playBtn.callback_data.includes('from_media'), 'Play Another button carries from_media tag');

  const inputBtn = allButtons.find((btn) => btn.callback_data.includes(':input'));
  assert.ok(inputBtn, 'Contains Download Link button');
  assert.ok(inputBtn.callback_data.includes('from_media'), 'Download Link button carries from_media tag');

  const stickerBtn = allButtons.find((btn) => btn.callback_data.includes('stickers:open'));
  assert.ok(stickerBtn, 'Contains Make Sticker Pack button');
  assert.ok(stickerBtn.callback_data.includes('from_media'), 'Make Sticker Pack button carries from_media tag');

  const dashBtn = allButtons.find((btn) => btn.callback_data.includes('dashboard:open'));
  assert.ok(dashBtn, 'Contains Dashboard button');
  assert.ok(dashBtn.callback_data.includes('from_media'), 'Dashboard button carries from_media tag');

  // 2. Verify handle('play', ['from_media']) uses replyRich and NEVER touches editScreen
  let replyRichCalled = false;
  let editScreenCalled = false;
  const callbackCtx = {
    tgId: '100',
    chatId: 100,
    fromMedia: true,
    forceNew: true,
    sm,
    replyRich: async (rich) => { replyRichCalled = true; return { message_id: 999 }; },
    editScreen: async () => { editScreenCalled = true; throw new Error('editScreen must NOT be called!'); }
  };

  await downloader.handle(callbackCtx, 'play', ['from_media']);
  assert.equal(replyRichCalled, true, 'replyRich called to send fresh message');
  assert.equal(editScreenCalled, false, 'editScreen was NOT called');

  // 3. Verify handle('input', ['from_media']) also uses replyRich
  replyRichCalled = false;
  editScreenCalled = false;
  await downloader.handle(callbackCtx, 'input', ['from_media']);
  assert.equal(replyRichCalled, true, 'replyRich called for input prompt');
  assert.equal(editScreenCalled, false, 'editScreen was NOT called for input prompt');
});

test('Accurate Lyrics Matching: Wild Side returns Normani lyrics and rejects generic Song titles', async () => {
  // 1. Generic word "Song" must NEVER return Regina Song
  const genericRes = await getLyrics('Song', '');
  assert.equal(genericRes.found, false, 'Generic "Song" title must not match random lyrics');

  // 2. "Normani - Wild Side (Extended Version)" must return exact Normani Wild Side lyrics
  const wildSideRes = await getLyrics('Normani - Wild Side (Extended Version)', 'Normani');
  assert.equal(wildSideRes.found, true);
  assert.ok(wildSideRes.lyrics.includes("I'm ready to pull up on you") || wildSideRes.lyrics.includes('wild side'), 'Contains real Wild Side lyrics');
});

test('Lyrics Fallback from Message Card: extracts title and artist from query.message when cache key is missing after restart', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine();
  const app = {
    db,
    telegram: { api: {}, controller: {} },
    mediaDownloader: {}
  };

  const downloader = createDownloaderScreen({ app });
  const sentMessages = [];

  const mockQueryMessage = {
    message_id: 777,
    text: `𓆩♡𓆪 SPOTIFY DOWNLOAD 𓆩♡𓆪\n\n🎵 Title\nNormani - Wild Side (Extended Versi…\n🎧 Artist\nNormani\n📦 Audio Quality\n320 kbps MP3 + Artwork ♡`
  };

  const ctx = {
    tgId: '100',
    chatId: 100,
    db,
    settings,
    sm,
    query: { id: 'q1', message: mockQueryMessage },
    api: {
      answerCallbackQuery: async () => true,
      sendMessage: async (chatId, text, opts) => {
        sentMessages.push({ chatId, text, opts });
        return { message_id: 888 };
      }
    }
  };

  // Unknown or wiped key (e.g. after PM2 restart)
  await downloader.handle(ctx, 'lyrics', ['wiped_key_after_restart']);
  assert.ok(sentMessages.length > 0, 'Sent lyrics message');
  const lyricsText = sentMessages[0].text;
  assert.ok(lyricsText.includes('Wild Side') || lyricsText.includes("ready to pull up on you") || lyricsText.includes("wild side"), 'Extracted real Wild Side lyrics from card text fallback');
  assert.ok(!lyricsText.includes("Dreamer's Song"), 'Must NOT return Dreamer\'s Song!');
});

test('Smart Reverse Lyrics Search: identifies track from snippet and retrieves full lyrics', async () => {
  // 1. Identify Regina Song - Dreamer's Song from lyric verse snippet
  const snippet = "You make me feel Love is so real I wished on a star And it made you appear";
  const identified = await searchSongByLyrics(snippet);
  assert.ok(identified, 'Identified track from snippet');
  assert.equal(identified.title.toLowerCase(), "dreamer's song");
  assert.equal(identified.artist.toLowerCase(), "regina song");

  // 2. getLyrics directly from verse snippet
  const lyricsRes = await getLyrics(snippet);
  assert.equal(lyricsRes.found, true);
  assert.ok(lyricsRes.lyrics.includes('wished on a star') || lyricsRes.lyrics.includes('Love is so real'));
  assert.equal(lyricsRes.artist.toLowerCase(), "regina song");
});

test('Clean Metadata Handles Truncated Titles and Dashes: preserves song name', () => {
  const meta1 = cleanSongMetadata('Normani - Wild Side (Extended Versi…', 'Normani');
  assert.equal(meta1.title, 'Wild Side');
  assert.equal(meta1.artist, 'Normani');

  const meta2 = cleanSongMetadata('Queen – Bohemian Rhapsody (Official Video Remastered)', 'Queen');
  assert.equal(meta2.title, 'Bohemian Rhapsody');
  assert.equal(meta2.artist, 'Queen');

  const meta3 = cleanSongMetadata('Adele — Hello (Lyrics)', 'Rare Vibes');
  assert.equal(meta3.title, 'Hello');
  assert.equal(meta3.artist, 'Adele');
});

