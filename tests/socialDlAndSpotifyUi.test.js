import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { MediaDownloader } from '../src/media/downloader.js';
import { Database } from '../src/core/db.js';
import { SettingsManager } from '../src/config/settings.js';
import { StateMachine } from '../src/core/stateMachine.js';
import { createDownloaderScreen } from '../src/telegram/screens/downloader.js';
import { richTextToString } from '../src/telegram/rich.js';

test('MediaDownloader detects Spotify URIs, Apple Music, Audiomack, SoundCloud, Threads, RedNote, and short dramas', () => {
  const dl = new MediaDownloader();

  // Spotify variations
  assert.equal(dl.detectPlatform('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT'), 'spotify');
  assert.equal(dl.detectPlatform('https://open.spotify.com/album/4yP0hdKOZPNshxUOjY0cZj'), 'spotify');
  assert.equal(dl.detectPlatform('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'), 'spotify');
  assert.equal(dl.detectPlatform('https://spotify.link/abc123XYZ'), 'spotify');
  assert.equal(dl.detectPlatform('https://spoti.fi/3abcXYZ'), 'spotify');
  assert.equal(dl.detectPlatform('spotify:track:4cOdK2wGLETKBW3PvgPWqT'), 'spotify');
  assert.equal(dl.detectPlatform('spotify:album:4yP0hdKOZPNshxUOjY0cZj'), 'spotify');

  // Music platforms
  assert.equal(dl.detectPlatform('https://music.apple.com/us/album/starboy/1440871397?i=1440871398'), 'applemusic');
  assert.equal(dl.detectPlatform('https://audiomack.com/asakemusic/song/lonely-at-the-top'), 'audiomack');
  assert.equal(dl.detectPlatform('https://soundcloud.com/user/track-name'), 'soundcloud');
  assert.equal(dl.detectPlatform('https://on.soundcloud.com/abcde12345'), 'soundcloud');

  // Social platforms
  assert.equal(dl.detectPlatform('https://www.threads.net/@zuck/post/C123456'), 'threads');
  assert.equal(dl.detectPlatform('https://www.threads.com/@user/post/C999999'), 'threads');
  assert.equal(dl.detectPlatform('https://www.xiaohongshu.com/explore/65a1b2c3'), 'rednote');
  assert.equal(dl.detectPlatform('https://xhslink.com/o/abc123'), 'rednote');

  // Short-drama platforms
  assert.equal(dl.detectPlatform('https://www.dramabox.com/movie/123'), 'dramabox');
  assert.equal(dl.detectPlatform('https://www.reelshort.com/movie/123'), 'reelshort');
  assert.equal(dl.detectPlatform('https://www.goodshort.com/drama/123'), 'goodshort');
});

test('Downloader Bot API 10.3 UI renders bannerHeader, striped tables, details, and semantic button styles', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine();
  let lastRich = null;

  const mockCtx = {
    tgId: '501',
    chatId: 501,
    messageId: 10,
    settings,
    sm,
    editScreen: async (rich) => {
      lastRich = rich;
      return { message_id: 10 };
    }
  };

  const screen = createDownloaderScreen({
    app: { telegram: { api: {} }, mediaDownloader: new MediaDownloader() }
  });

  await screen.open(mockCtx);
  assert.ok(lastRich);
  assert.equal(lastRich.blocks[0].type, 'heading');
  assert.ok(lastRich.blocks.some((b) => b.type === 'table' && b.is_striped === true));
  assert.ok(lastRich.blocks.some((b) => b.type === 'details' && richTextToString(b.summary).includes('Supported Link Types')));
  const btns = lastRich.blocks.filter((b) => b.type === 'buttons').flatMap((b) => b.buttons);
  const pasteBtn = btns.find((btn) => richTextToString(btn.text).includes('Paste / Send Link'));
  assert.equal(pasteBtn?.style, 'success');
  const playBtn = btns.find((btn) => richTextToString(btn.text).includes('Play Music'));
  assert.equal(playBtn?.style, 'success');

  await screen.handle(mockCtx, 'input');
  assert.ok(lastRich.blocks.some((b) => b.type === 'table' && b.is_striped === true));
  const inputBtns = lastRich.blocks.filter((b) => b.type === 'buttons').flatMap((b) => b.buttons);
  assert.equal(inputBtns.find((btn) => richTextToString(btn.text).includes('Cancel'))?.style, 'danger');
});

test('Spotify collection (album/playlist) renders Bot API 10.3 track selector, pagination (sp_page), and track download (sp_trk)', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine();

  const coverPng = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 30, g: 215, b: 96 } }
  }).jpeg().toBuffer();

  const tracks = Array.from({ length: 10 }, (_, idx) => ({
    id: `trk_${idx + 1}`,
    title: `Track Number ${idx + 1}`,
    artist: 'The Weeknd',
    duration: '3:30',
    trackNumber: idx + 1,
    url: `https://open.spotify.com/track/trk_${idx + 1}`
  }));

  const downloadedUrls = [];
  let deliveredRich = null;
  let editedRich = null;

  const app = {
    db,
    telegram: {
      api: {
        answerCallbackQuery: async () => true,
        sendRichMessage: async (_chatId, rich) => {
          deliveredRich = rich;
          return { message_id: 900 };
        },
        editMessageRich: async (_chatId, _msgId, rich) => {
          editedRich = rich;
          return { message_id: 900 };
        }
      },
      controller: {
        markMediaDeliveryMessage: () => {},
        userScreenMessage: new Map()
      }
    },
    mediaDownloader: {
      download: async (target) => {
        downloadedUrls.push(target);
        if (target.includes('/album/')) {
          return {
            sourceUrl: target,
            platform: 'spotify',
            spotifyType: 'album',
            title: 'After Hours',
            artist: 'The Weeknd',
            author: 'The Weeknd',
            album: 'After Hours',
            year: '2020',
            totalTracks: 10,
            tracks,
            mediaItems: [{ type: 'photo', buffer: coverPng, filename: 'cover.jpg', mimeType: 'image/jpeg' }],
            audioTrack: null
          };
        }
        return {
          sourceUrl: target,
          platform: 'spotify',
          title: 'Track Number 7',
          artist: 'The Weeknd',
          album: 'After Hours',
          duration: '3:30',
          mediaItems: [{ type: 'photo', buffer: coverPng, filename: 'cover.jpg', mimeType: 'image/jpeg' }],
          audioTrack: { buffer: Buffer.from('fake-mp3-data'), title: 'Track Number 7', performer: 'The Weeknd', duration: '3:30' }
        };
      }
    }
  };

  const screen = createDownloaderScreen({ app });
  const baseCtx = {
    tgId: '777',
    chatId: 777,
    db,
    settings,
    sm,
    api: app.telegram.api,
    controller: app.telegram.controller
  };

  await screen.executeDownload(baseCtx, 'https://open.spotify.com/album/4yP0hdKOZPNshxUOjY0cZj');
  const albumRich = editedRich || deliveredRich;
  assert.ok(albumRich, 'Spotify album card should be delivered');
  assert.ok(albumRich.blocks.some((b) => b.type === 'photo'));
  assert.ok(albumRich.blocks.some((b) => b.type === 'table' && b.is_striped === true));
  assert.ok(albumRich.blocks.some((b) => b.type === 'expandable_blockquote' && richTextToString(b.text).includes('Track Number 10')));

  const page1Btns = albumRich.blocks.filter((b) => b.type === 'buttons').flatMap((b) => b.buttons);
  assert.ok(page1Btns.some((btn) => richTextToString(btn.text).includes('1. Track Number 1')));
  assert.ok(page1Btns.some((btn) => richTextToString(btn.text).includes('6. Track Number 6')));
  assert.ok(!page1Btns.some((btn) => richTextToString(btn.text).includes('7. Track Number 7')));

  const batchBtn = page1Btns.find((btn) => btn.callback_data?.includes(':sp_batch:'));
  assert.equal(batchBtn?.style, 'success');
  assert.ok(page1Btns.some((btn) => btn.copy_text?.text?.includes('Track Number 1')));
  assert.ok(page1Btns.some((btn) => btn.url === 'https://open.spotify.com/album/4yP0hdKOZPNshxUOjY0cZj'));

  const nextBtn = page1Btns.find((btn) => btn.callback_data?.includes(':sp_page:'));
  assert.ok(nextBtn, 'Next pagination button should exist on page 1');
  const spKey = nextBtn.callback_data.split(':')[3];

  // Navigate to Page 2
  editedRich = null;
  await screen.handle(
    { ...baseCtx, query: { id: 'q1', message: { message_id: 900, photo: [{ file_id: 'p1' }] } } },
    'sp_page',
    [spKey, '1']
  );
  assert.ok(editedRich, 'Page 2 should edit existing rich message');
  const page2Btns = editedRich.blocks.filter((b) => b.type === 'buttons').flatMap((b) => b.buttons);
  assert.ok(page2Btns.some((btn) => richTextToString(btn.text).includes('7. Track Number 7')));
  assert.ok(page2Btns.some((btn) => richTextToString(btn.text).includes('10. Track Number 10')));
  assert.ok(page2Btns.some((btn) => richTextToString(btn.text).includes('• Page 2/2 •')));

  // Tap track 7 (index 6)
  deliveredRich = null;
  editedRich = null;
  await screen.handle(
    { ...baseCtx, query: { id: 'q2', message: { message_id: 900 } } },
    'sp_trk',
    [spKey, '6']
  );
  assert.ok(downloadedUrls.includes('https://open.spotify.com/track/trk_7'));
  const trkRich = editedRich || deliveredRich;
  assert.ok(trkRich, 'Track 7 audio delivery card should be sent');
  const trkTables = trkRich.blocks.filter((b) => b.type === 'table');
  assert.ok(JSON.stringify(trkTables).includes('SPOTIFY ♡'));
});
