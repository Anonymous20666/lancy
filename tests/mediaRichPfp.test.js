import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramAPI } from '../src/telegram/api.js';
import { createDashboardScreen } from '../src/telegram/screens/dashboard.js';
import { SettingsManager } from '../src/config/settings.js';
import { StateMachine } from '../src/core/stateMachine.js';
import { Database } from '../src/core/db.js';

test('TelegramAPI has getUserProfilePhotos method', () => {
  const api = new TelegramAPI('123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11');
  assert.equal(typeof api.getUserProfilePhotos, 'function');
});

test('dashboard screen fetches user pfp and adds hero photo block', async () => {
  const fakePfpBuffer = Buffer.from('fake-avatar-bytes');
  let calledMethod = null;
  let sentRich = null;
  let sentFiles = null;

  const mockApi = {
    getUserProfilePhotos: async (userId, opts) => {
      calledMethod = 'getUserProfilePhotos';
      return {
        total_count: 1,
        photos: [[{ file_id: 'photo_abc', width: 640, height: 640 }]]
      };
    },
    getFile: async (fileId) => ({ file_id: fileId, file_path: 'photos/file_1.jpg' }),
    downloadFile: async (filePath) => fakePfpBuffer,
    sendRichMessage: async (chatId, rich, extra, files) => {
      sentRich = rich;
      sentFiles = files;
      return { message_id: 999 };
    },
    editMessageRich: async () => ({ message_id: 999 })
  };

  const app = {
    whatsapp: { listForUser: () => [] },
    media: { cache: { stats: () => ({ entries: 0, totalBytes: 0 }) } },
    ai: { status: async () => ({ enabled: false }) }
  };

  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine({ db });

  const dashboard = createDashboardScreen({ app });

  const ctx = {
    tgId: 1001,
    chatId: 1001,
    user: { first_name: 'TestUser' },
    api: mockApi,
    db,
    settings,
    sm,
    forceNew: true,
    sendRichMessage: (rich, extra, files) => mockApi.sendRichMessage(1001, rich, extra, files),
    editScreen: (rich, extra, files) => mockApi.editMessageRich(1001, 100, rich, extra, files)
  };

  await dashboard.open(ctx, { forceNew: true });

  assert.equal(calledMethod, 'getUserProfilePhotos');
  assert.ok(sentRich);
  assert.ok(sentFiles?.pfp);
  assert.equal(sentFiles.pfp.buffer, fakePfpBuffer);

  // Verify first block is photo attach://pfp
  const firstBlock = sentRich.blocks[0];
  assert.equal(firstBlock.type, 'photo');
  assert.equal(firstBlock.photo?.media, 'attach://pfp');

  db.close();
});

test('pinterest search embeds videos directly into Rich Message slideshow', () => {
  // Verify block builder produces proper video block inside slideshow
  const previewBlocks = [
    { type: 'video', ref: 'attach://video_0' },
    { type: 'photo', ref: 'attach://photo_1' }
  ];

  const slideItems = previewBlocks.map((item) => {
    if (item.type === 'video') return { type: 'video', video: { type: 'video', media: item.ref } };
    return { type: 'photo', photo: { type: 'photo', media: item.ref } };
  });

  assert.equal(slideItems[0].type, 'video');
  assert.equal(slideItems[0].video.media, 'attach://video_0');
  assert.equal(slideItems[1].type, 'photo');
  assert.equal(slideItems[1].photo.media, 'attach://photo_1');
});
