import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/core/db.js';
import {
  checkChatMediaPermissions,
  isPermissionError,
  registerPendingDownload,
  resolvePendingDownload,
  formatMediaRestrictedNotice,
  recordChatPermissionRestriction,
  invalidateChatPermissions
} from '../src/telegram/permissions.js';
import { ProgressTracker } from '../src/telegram/progress.js';
import { createDownloaderScreen } from '../src/telegram/screens/downloader.js';
import { SettingsManager } from '../src/config/settings.js';
import { StateMachine } from '../src/core/stateMachine.js';

test('isPermissionError: accurately identifies Telegram permission denial errors', () => {
  assert.equal(isPermissionError(new Error('Bad Request: not enough rights to send the rich message to the chat')), true);
  assert.equal(isPermissionError(new Error('Bad Request: not enough rights to send photos to the chat')), true);
  assert.equal(isPermissionError(new Error('Bad Request: not enough rights to send videos to the chat')), true);
  assert.equal(isPermissionError(new Error('Bad Request: CHAT_SEND_MEDIA_FORBIDDEN')), true);
  assert.equal(isPermissionError(new Error("Bad Request: can't send media in this chat")), true);
  assert.equal(isPermissionError(new Error('Bad Request: CHAT_ADMIN_REQUIRED')), true);

  assert.equal(isPermissionError(new Error('Bad Request: message is not modified')), false);
  assert.equal(isPermissionError(new Error('Bad Request: message to edit not found')), false);
  assert.equal(isPermissionError(new Error('Network error: connect ECONNREFUSED')), false);
  assert.equal(isPermissionError(null), false);
});

test('registerPendingDownload & resolvePendingDownload: stores and resolves tokens safely', () => {
  const db = new Database(':memory:');

  const testUrl = 'https://vm.tiktok.com/ZSbcpepg2/';
  const token = registerPendingDownload(testUrl, db);
  assert.ok(token);
  assert.equal(token.length, 8);

  // Resolve from memory
  const resolved = resolvePendingDownload(token, db);
  assert.equal(resolved, testUrl);

  // Resolve base64url fallback
  const b64 = Buffer.from(testUrl, 'utf8').toString('base64url');
  assert.equal(resolvePendingDownload(b64, db), testUrl);

  db.close();
});

test('checkChatMediaPermissions: handles private chats and group permissions with caching', async () => {
  const mockApi = {
    me: { id: 8859351350 },
    getChat: async (chatId) => {
      if (chatId === -1001) {
        return {
          permissions: {
            can_send_messages: true,
            can_send_media_messages: true,
            can_send_photos: false,
            can_send_videos: false,
            can_send_audios: true
          }
        };
      }
      return {};
    },
    getChatMember: async (chatId, userId) => {
      if (chatId === -1001) {
        return { status: 'member' };
      }
      return { status: 'administrator' };
    }
  };

  // 1. Private chat
  const privateCaps = await checkChatMediaPermissions(mockApi, 12345678);
  assert.equal(privateCaps.isGroup, false);
  assert.equal(privateCaps.canSendPhotos, true);
  assert.equal(privateCaps.canSendVideos, true);

  // 2. Group chat with restricted photos/videos
  invalidateChatPermissions(-1001);
  const groupCaps = await checkChatMediaPermissions(mockApi, -1001);
  assert.equal(groupCaps.isGroup, true);
  assert.equal(groupCaps.isAdmin, false);
  assert.equal(groupCaps.canSendPhotos, false);
  assert.equal(groupCaps.canSendVideos, false);
  assert.equal(groupCaps.canSendAudios, true);

  // 3. Second call returns cached result
  const cachedCaps = await checkChatMediaPermissions(mockApi, -1001);
  assert.equal(cachedCaps.canSendVideos, false);
});

test('ProgressTracker: cleans up progress message and sends notice when permissions are denied', async () => {
  const deletedMessages = [];
  const sentMessages = [];

  const mockApi = {
    botUsername: 'Lancy_easy_bot',
    sendRichMessage: async () => ({ message_id: 101 }),
    editMessageRich: async () => {
      const err = new Error('Bad Request: not enough rights to send the rich message to the chat');
      err.description = 'Bad Request: not enough rights to send the rich message to the chat';
      throw err;
    },
    deleteMessage: async (chatId, messageId) => {
      deletedMessages.push({ chatId, messageId });
      return true;
    },
    sendMessage: async (chatId, text, opts) => {
      sentMessages.push({ chatId, text, opts });
      return { message_id: 202 };
    }
  };

  const tracker = new ProgressTracker({
    api: mockApi,
    chatId: -1001,
    action: 'typing'
  });

  await tracker.live(() => ({ blocks: [{ type: 'paragraph', text: 'Searching…' }] }));
  assert.equal(tracker.messageId, 101);

  // Call finish with files (media delivery)
  await tracker.finish({ blocks: [] }, { video: Buffer.from('fake') });

  // Verify:
  // 1. Progress message was deleted (never left stuck at 100%)
  assert.ok(deletedMessages.some((d) => d.messageId === 101), 'Progress message must be deleted');
  assert.equal(tracker.messageId, null, 'messageId must be cleared');

  // 2. Sent informative permission notice with deep link into DM
  assert.equal(sentMessages.length, 1, 'Must send permission restricted notice');
  assert.ok(sentMessages[0].text.includes('MEDIA RESTRICTED IN GROUP'));
  assert.ok(sentMessages[0].opts.reply_markup.inline_keyboard[0][0].url.includes('t.me/Lancy_easy_bot?start='));
});

test('DownloaderScreen executeDownload: pre-flight checks prevent infinity loop in restricted groups', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine();
  const sentMessages = [];
  let downloadCalled = false;

  const mockApi = {
    me: { id: 8859351350 },
    botUsername: 'Lancy_easy_bot',
    getChat: async () => ({
      permissions: {
        can_send_messages: true,
        can_send_media_messages: true,
        can_send_photos: false,
        can_send_videos: false,
        can_send_audios: true
      }
    }),
    getChatMember: async () => ({ status: 'member' }),
    sendMessage: async (chatId, text, opts) => {
      sentMessages.push({ chatId, text, opts });
      return { message_id: 303 };
    }
  };

  const fakeDownloader = {
    detectPlatform: () => 'tiktok',
    download: async () => {
      downloadCalled = true;
      return { platform: 'tiktok', mediaItems: [{ type: 'video', buffer: Buffer.from('vid') }] };
    }
  };

  const dlScreen = createDownloaderScreen({
    app: {
      telegram: { api: mockApi },
      mediaDownloader: fakeDownloader,
      db
    }
  });

  const groupCtx = {
    isGroup: true,
    chatId: -1001,
    tgId: '12345',
    api: mockApi,
    botUsername: 'Lancy_easy_bot',
    db,
    settings,
    sm
  };

  invalidateChatPermissions(-1001);
  await dlScreen.executeDownload(groupCtx, 'https://vm.tiktok.com/ZSbcpepg2/');

  // 1. MediaDownloader was NEVER called — bandwidth and time saved!
  assert.equal(downloadCalled, false, 'Should not download media when group restricts videos/photos');

  // 2. Immediately informed the user with deep-link into private DM
  assert.equal(sentMessages.length, 1);
  assert.ok(sentMessages[0].text.includes('MEDIA RESTRICTED IN GROUP'));
  const btn = sentMessages[0].opts.reply_markup.inline_keyboard[0][0];
  assert.ok(btn.url.startsWith('https://t.me/Lancy_easy_bot?start=grab_'));

  db.close();
});
