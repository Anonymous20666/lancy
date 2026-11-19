import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { optimizePreviewImage } from '../src/media/convert.js';
import { ProgressTracker } from '../src/telegram/progress.js';
import { sendRichWithPhotoFallback, editOrSendRichWithFallback } from '../src/music/model.js';
import { QueueManager } from '../src/music/queueManager.js';
import { MusicService } from '../src/music/service.js';
import { createMusicScreen } from '../src/telegram/screens/music.js';
import { MovieApiClient } from '../src/media/movieApi.js';
import { MovieSessions } from '../src/media/movieSessions.js';
import { createMovieUi } from '../src/telegram/screens/movieUi.js';
import { prepareMovieTrailerPreview, getCachedTrailerFileId, saveCachedTrailerFileId, buildTrailerItemKey } from '../src/media/movieTrailer.js';

test('optimizePreviewImage converts small WebP preview images into Telegram-safe JPEG', async () => {
  const webpBuf = await sharp({
    create: { width: 320, height: 320, channels: 3, background: { r: 30, g: 60, b: 140 } }
  }).webp({ quality: 80 }).toBuffer();
  assert.ok(webpBuf.length < 250 * 1024, 'fixture WebP is under 250KB threshold');

  const out = await optimizePreviewImage(webpBuf, { maxDimension: 1280, quality: 88 });
  const meta = await sharp(out).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, 320);
  assert.equal(meta.height, 320);
});

test('ProgressTracker.finish falls back to sendRichMessage + deletes progress msg when editMessageRich strips photo/media', async () => {
  const deleted = [];
  const sent = [];
  let sendCount = 0;
  const mockApi = {
    sendRichMessage: async (chatId, rich, extra, files) => {
      sendCount += 1;
      const msgId = sendCount === 1 ? 101 : 202;
      sent.push({ chatId, msgId, rich, files });
      return { message_id: msgId, rich_message: rich };
    },
    editMessageRich: async () => {
      // Simulate Telegram editMessageText stripping attach://photo_0 when editing a text-only card
      return { message_id: 101, rich_message: { blocks: [{ type: 'paragraph', text: 'text only' }] } };
    },
    call: async (method, params) => {
      if (method === 'deleteMessage') deleted.push(params.message_id);
      return true;
    }
  };

  const tracker = new ProgressTracker({ api: mockApi, chatId: -10099, action: null });
  await tracker.live(() => ({ blocks: [{ type: 'paragraph', text: 'Searching...' }] }));
  assert.equal(tracker.messageId, 101);

  const img = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#112233' } }).jpeg().toBuffer();
  const finalRich = { blocks: [{ type: 'photo', photo: { type: 'photo', media: 'attach://photo_0' } }] };
  const result = await tracker.finish(finalRich, { photo_0: { buffer: img, filename: 'cover.jpg', contentType: 'image/jpeg' } });

  assert.equal(result.message_id, 202);
  assert.equal(tracker.messageId, 202);
  assert.ok(deleted.includes(101), 'Stale text-only progress message must be deleted');
  assert.equal(sent.length, 2, 'Initial progress + replacement media card must be sent');
  assert.ok(sent[1].files?.photo_0?.buffer, 'Replacement card must carry photo attachment');
});

test('sendRichWithPhotoFallback normalizes PNG/WebP remote artwork into JPEG while preserving existing files', async () => {
  const pngBytes = await sharp({
    create: { width: 64, height: 64, channels: 4, background: { r: 200, g: 50, b: 90, alpha: 1 } }
  }).png().toBuffer();

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('cover.png')) {
      return { ok: true, arrayBuffer: async () => pngBytes };
    }
    return { ok: false, status: 404 };
  };

  try {
    const calls = [];
    const fakeApi = {
      sendRichMessage: async (_chatId, rich, _extra, files) => {
        calls.push({ rich, files });
        if (calls.length === 1) {
          const err = new Error('Bad Request: wrong type of the web page content');
          err.description = err.message;
          throw err;
        }
        return { message_id: 303, rich_message: rich };
      }
    };

    const rich = {
      blocks: [
        { type: 'photo', photo: { type: 'photo', media: 'https://cdn.example.com/cover.png' } },
        { type: 'audio', audio: { type: 'audio', media: 'attach://music_full_audio' } }
      ]
    };
    const existingFiles = { music_full_audio: { buffer: Buffer.from('mp3'), filename: 'song.mp3', contentType: 'audio/mpeg' } };
    const out = await sendRichWithPhotoFallback(fakeApi, -1001, rich, {}, existingFiles);

    assert.equal(out.hasPhoto, true);
    assert.equal(calls.length, 2);
    assert.ok(calls[1].files.music_full_audio, 'Existing audio upload must be preserved during artwork fallback');
    assert.ok(calls[1].files.artwork_photo?.buffer, 'Remote artwork must be uploaded as attach://artwork_photo');
    assert.equal(calls[1].files.artwork_photo.contentType, 'image/jpeg');
    const normMeta = await sharp(calls[1].files.artwork_photo.buffer).metadata();
    assert.equal(normMeta.format, 'jpeg');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Music Player Card places photo before audio, caches file_id across FullTrackPreviews, and upgrades text->photo cards', async (t) => {
  const db = {
    getSetting: (_k, d) => d,
    setSetting: () => {}
  };
  const fakeVoice = {
    on: () => {},
    getState: async () => ({ sessions: [] }),
    close: async () => {}
  };
  const app = { db, settings: { get: (k, d) => (k === 'telegram.ownerIds' ? [1] : d) } };
  const qm = new QueueManager({ app, voiceClient: fakeVoice, db, pollMs: 0 });
  app.musicQueueManager = qm;
  const service = new MusicService({ app, search: null, lyrics: null, accounts: null });
  app.music = service;
  const screen = createMusicScreen({ app });
  app.screens = new Map([['music', screen]]);
  t.after(async () => {
    await service.previews.shutdown();
    await qm.shutdown();
    await screen.cleanup();
  });

  const edits = [];
  const sends = [];
  const artUrl = 'https://i.ytimg.com/vi/abc123def45/hq720.jpg';
  const s = qm.getSession(-10088);
  s.connected = true;
  s.status = 'playing';
  s.view = 'player';
  s.activeDeck = 'music';
  s.screenMessageId = 500;
  s.playerChatId = -10088;
  s.lastRenderHasPhoto = true;
  s.currentTrack = {
    id: 'youtube:abc123def45',
    provider: 'youtube',
    providerId: 'abc123def45',
    title: 'All Girls Are The Same',
    artist: 'Juice WRLD',
    durationSeconds: 166,
    artwork: artUrl,
    mediaType: 'audio',
    capabilities: { stream: true, download: true, seek: true }
  };
  s.api = {
    me: { id: 99, username: 'Lancy_easy_bot' },
    getChat: async () => ({ id: -10088, type: 'supergroup', title: 'Test VC' }),
    getChatMember: async () => ({ status: 'administrator' }),
    editMessageRich: async (_cid, _mid, rich) => {
      edits.push(rich);
      const hasAudio = rich?.blocks?.some((b) => b.type === 'audio');
      return {
        message_id: 500,
        rich_message: {
          blocks: [
            { type: 'photo', photo: { type: 'photo', file_id: 'AgACAgQAAxkBAA_cached_fid' } },
            ...(hasAudio ? [{ type: 'audio', audio: { file_id: 'CQAC_audio_fid' } }] : [])
          ]
        }
      };
    },
    sendRichMessage: async (_cid, rich) => {
      sends.push(rich);
      return { message_id: 501 };
    }
  };

  // 1. First normal update caches file_id from editMessageRich
  await qm.updatePlayerView(s, { forceEdit: true });
  assert.equal(s._photoFileIdByUrl.get(artUrl), 'AgACAgQAAxkBAA_cached_fid');

  // 2. FullTrackPreviews update must reuse cached file_id and place photo BEFORE audio
  const reqId = 'req-1';
  s.fullPreview = { request: reqId, trackId: s.currentTrack.id, playbackId: s.playbackId, status: 'pending' };
  const tmpFile = '/tmp/lancy-preview-card-test.mp3';
  const { writeFile, unlink } = await import('node:fs/promises');
  await writeFile(tmpFile, Buffer.from('fake-mp3-bytes'));
  t.after(() => unlink(tmpFile).catch(() => {}));

  await qm.updatePlayerView(s, {
    preview: {
      request: reqId,
      media: { track: s.currentTrack, filePath: tmpFile }
    }
  });

  const previewRich = edits.at(-1);
  const photoIdx = previewRich.blocks.findIndex((b) => b.type === 'photo');
  const audioIdx = previewRich.blocks.findIndex((b) => b.type === 'audio');
  assert.ok(photoIdx >= 0, 'Player preview card must contain photo block');
  assert.ok(audioIdx > photoIdx, 'Photo preview must come before audio block');
  assert.equal(previewRich.blocks[photoIdx].photo.media, 'AgACAgQAAxkBAA_cached_fid', 'FullTrackPreviews update must reuse cached file_id');

  // 3. Music player card with lastRenderHasPhoto=false upgrades to fresh photo card via service.player
  s.lastRenderHasPhoto = false;
  s._photoUpgradeAttemptedUrl = null;
  s.screenMessageId = 500;
  await service.player({ tgId: '1', chatId: -10088, api: s.api, user: { id: 1 } }, -10088);
  assert.equal(s.screenMessageId, 501, 'Music player must upgrade from text-only card to fresh photo card');
  assert.ok(sends.at(-1)?.blocks?.some((b) => b.type === 'photo'));
});

test('optimizePreviewImage clamps extreme aspect ratios and honors maxWidth/PNG normalization under 250KB', async () => {
  const bannerPng = await sharp({
    create: { width: 1200, height: 60, channels: 4, background: { r: 20, g: 120, b: 220, alpha: 0.9 } }
  }).png().toBuffer();
  assert.ok(bannerPng.length < 250 * 1024);

  const out = await optimizePreviewImage(bannerPng, { maxWidth: 900, quality: 80 });
  const meta = await sharp(out).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.ok(meta.width / meta.height <= 4.1, 'Extreme aspect ratio must be clamped within Telegram-safe ratio');
  assert.ok(meta.width <= 900);
});

test('editOrSendRichWithFallback detects stripped media, tries fallbackArtworkUrls, and preserves photo if trailer video fails', async () => {
  const fallbackPng = await sharp({
    create: { width: 48, height: 48, channels: 3, background: { r: 80, g: 180, b: 90 } }
  }).png().toBuffer();

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('backdrop-ok.png')) {
      return { ok: true, arrayBuffer: async () => fallbackPng };
    }
    return { ok: false, status: 404 };
  };

  try {
    const deleted = [];
    const sentCalls = [];
    const mockApi = {
      editMessageRich: async () => ({
        message_id: 700,
        rich_message: { blocks: [{ type: 'paragraph', text: 'stripped' }] }
      }),
      sendRichMessage: async (_cid, rich, _extra, files) => {
        sentCalls.push({ rich, files });
        if (sentCalls.length === 1) {
          const err = new Error('Bad Request: failed to get HTTP URL content');
          err.description = err.message;
          throw err;
        }
        if (sentCalls.length === 2 && rich.blocks.some((b) => b.type === 'video')) {
          const err = new Error('Bad Request: wrong file identifier/HTTP URL specified for video');
          err.description = err.message;
          throw err;
        }
        return { message_id: 701, rich_message: rich };
      },
      deleteMessage: async (_cid, mid) => { deleted.push(mid); return true; }
    };

    const rich = {
      blocks: [
        { type: 'photo', photo: { type: 'photo', media: 'https://broken.example.com/poster-404.jpg' } },
        { type: 'video', video: { type: 'video', media: 'attach://trailer_video' } },
        { type: 'paragraph', text: 'Movie synopsis' }
      ]
    };

    const res = await editOrSendRichWithFallback(
      mockApi,
      -10055,
      700,
      rich,
      {},
      { trailer_video: { buffer: Buffer.from('bad-vid'), filename: 'trailer.mp4', contentType: 'video/mp4' } },
      { fallbackArtworkUrls: ['https://cdn.example.com/backdrop-ok.png'] }
    );

    assert.equal(res.edited, false);
    assert.equal(res.didReplace, true);
    assert.equal(res.hasPhoto, true, 'Guaranteed photo preview must survive even if primary URL 404s AND video upload fails');
    assert.equal(res.hasVideo, false, 'Failing video block should degrade cleanly while preserving photo+text card');
    assert.equal(res.sent.message_id, 701);
    assert.ok(deleted.includes(700), 'Replaced stale message must be deleted');
    assert.ok(sentCalls.at(-1).files?.artwork_photo?.buffer, 'Fallback artwork must be uploaded as JPEG attachment');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('MovieApiClient.resolveTrailer & prepareMovieTrailerPreview resolve, attach, and cache Telegram file_id', async () => {
  const store = new Map();
  const db = {
    getSetting: (k, d = null) => (store.has(k) ? store.get(k) : d),
    setSetting: (k, v) => { store.set(k, v); }
  };

  const movieApi = new MovieApiClient({
    baseUrl: 'https://invalid.local/api',
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) })
  });

  const item = {
    id: 'tt1375666',
    imdbId: 'tt1375666',
    type: 'movie',
    title: 'Inception',
    year: 2010,
    yt_trailer_code: 'cdx31ak4KbQ',
    trailerYoutubeId: 'cdx31ak4KbQ'
  };

  const meta = await movieApi.resolveTrailer(item);
  assert.equal(meta?.youtubeId, 'cdx31ak4KbQ');
  assert.equal(meta?.url, 'https://www.youtube.com/watch?v=cdx31ak4KbQ');

  let dlCount = 0;
  const prep1 = await prepareMovieTrailerPreview({
    movieApi,
    db,
    item,
    botKey: '8839500296',
    downloadClipImpl: async (ytId) => {
      dlCount += 1;
      return {
        buffer: Buffer.from('mp4-trailer-bytes-' + ytId),
        filename: `trailer_${ytId}.mp4`,
        contentType: 'video/mp4',
        durationSeconds: 142
      };
    }
  });
  assert.equal(prep1.ok, true);
  assert.equal(prep1.fromCache, false);
  assert.equal(dlCount, 1);

  saveCachedTrailerFileId(db, item, '8839500296', { ...prep1, fileId: 'BAACAgQAA_cached_trailer_fid' });
  const cached = getCachedTrailerFileId(db, item, '8839500296');
  assert.equal(cached?.fileId, 'BAACAgQAA_cached_trailer_fid');

  const prep2 = await prepareMovieTrailerPreview({
    movieApi,
    db,
    item,
    botKey: '8839500296',
    downloadClipImpl: async () => {
      dlCount += 1;
      return null;
    }
  });
  assert.equal(prep2.ok, true);
  assert.equal(prep2.fromCache, true);
  assert.equal(prep2.fileId, 'BAACAgQAA_cached_trailer_fid');
  assert.equal(dlCount, 1, 'Cached trailer file_id must skip redundant downloads');
});

test('movieUi renders cached trailer video on preview card and upgrades seamlessly on tl callback', async () => {
  const store = new Map();
  const db = {
    getSetting: (k, d = null) => (store.has(k) ? store.get(k) : d),
    setSetting: (k, v) => { store.set(k, v); },
    getUserSetting: (_u, _k, d) => d
  };
  const item = {
    id: 'tt0903747',
    imdbId: 'tt0903747',
    type: 'tv',
    title: 'Breaking Bad',
    year: 2008,
    poster: 'https://cdn.example.com/bb.jpg',
    trailerYoutubeId: 'VFkjBy2b50Q'
  };
  saveCachedTrailerFileId(db, item, '8839500296', {
    fileId: 'BAAC_bb_trailer_fid',
    youtubeId: 'VFkjBy2b50Q',
    url: 'https://www.youtube.com/watch?v=VFkjBy2b50Q',
    title: 'Breaking Bad · Official Trailer',
    durationSeconds: 95
  });

  const sentPayloads = [];
  const fakeApi = {
    me: { id: 8839500296, username: 'pappy_agent' },
    sendRichMessage: async (_cid, rich) => {
      sentPayloads.push(rich);
      return {
        message_id: 901,
        rich_message: rich,
        video: { file_id: 'BAAC_bb_trailer_fid' }
      };
    },
    editMessageRich: async (_cid, mid, rich) => ({ message_id: mid, rich_message: rich }),
    answerCallbackQuery: async () => true,
    deleteMessage: async () => true
  };
  const app = {
    db,
    settings: { get: (k, d) => (k === 'movies.autoAttachTrailerPreview' ? false : d) },
    movieSessions: new MovieSessions({ db }),
    movieApi: {
      getTvShow: async () => ({ ...item, seasons: [{ seasonNumber: 1, name: 'Season 1', episodeCount: 7 }] }),
      getTvSeasons: async () => ({ seasons: [{ seasonNumber: 1, name: 'Season 1', episodeCount: 7 }] }),
      getTvSeasonEpisodes: async () => ({ episodes: [{ episodeNumber: 1, title: 'Pilot', runtimeMinutes: 58 }] }),
      getPlaybackInfo: async () => ({ available: true }),
      resolveTrailer: async () => ({ youtubeId: 'VFkjBy2b50Q', url: 'https://www.youtube.com/watch?v=VFkjBy2b50Q' })
    },
    music: { botKey: () => '8839500296', destination: () => -100777 },
    musicQueueManager: { getSession: () => null }
  };

  const ui = createMovieUi({
    app,
    card: (title, sub) => ({
      blocks: [{ type: 'heading', text: title, size: 2 }, ...(sub ? [{ type: 'paragraph', text: sub }] : [])],
      photo(m, c) { this.blocks.push({ type: 'photo', photo: { type: 'photo', media: m }, ...(c ? { caption: { text: c } } : {}) }); return this; },
      video(m, c) { this.blocks.push({ type: 'video', video: typeof m === 'object' ? m : { type: 'video', media: m }, ...(c ? { caption: { text: c } } : {}) }); return this; },
      paragraph(t) { this.blocks.push({ type: 'paragraph', text: t }); return this; },
      table(r) { this.blocks.push({ type: 'table', cells: r }); return this; },
      expandableBlockquote(t) { this.blocks.push({ type: 'expandable_blockquote', text: t }); return this; },
      blockquote(t) { this.blocks.push({ type: 'blockquote', blocks: [{ type: 'paragraph', text: t }] }); return this; },
      list(items) { this.blocks.push({ type: 'list', items }); return this; },
      buttons(btns) { this.blocks.push({ type: 'buttons', buttons: btns }); return this; }
    }),
    finish: (b) => ({ blocks: b.blocks }),
    mvBtn: (_ms, label, op, arg = '', opts = null) => ({ text: label, callback_data: `l1:music:mv:s:${op}:${arg}`, ...(opts || {}) }),
    startAiChat: async () => {},
    getUserDownloadQuality: () => '720p',
    resolvePlayableSourceForMovieItem: async () => null,
    buildMovieTrackFromResolved: () => ({}),
    buildDownloadProgressCard: () => ({ blocks: [] }),
    formatMbEst: () => '~300MB',
    estimateQualityInfo: () => ({ label: '720p HD', text: '~300MB' }),
    buildQualitySelectorRow: () => [],
    temporary: { remember: () => null },
    menuMsgByChat: new Map(),
    noticeMsgByChat: new Map(),
    isChannelCtx: () => false,
    chatSlotKey: (c) => String(c.chatId),
    reusableChannelSlotId: () => null,
    adoptChannelPlayerResult: async () => {},
    sendOrEditMenu: async () => {},
    syncMusicCommandsForCtx: async () => {}
  });

  const ms = app.movieSessions.create({ chatId: 12345, userId: '1', botKey: '8839500296' });
  ms.results = [item];
  await ui.handleCallback({ api: fakeApi, chatId: 12345, tgId: '1', query: { id: 'q1' } }, [ms.id, 'pk', '0']);

  assert.equal(ms.trailerMedia?.itemKey, buildTrailerItemKey(item));
  const detailRich = sentPayloads.at(-1);
  assert.ok(detailRich?.blocks?.some((b) => b.type === 'photo' && b.photo?.media === 'https://cdn.example.com/bb.jpg'));
  assert.ok(detailRich?.blocks?.some((b) => b.type === 'video' && b.video?.media === 'BAAC_bb_trailer_fid'), 'Cached trailer video block must be attached on series preview card');
});
