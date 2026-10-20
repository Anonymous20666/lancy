import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceClient } from '../src/music/voiceClient.js';
import { createMusicScreen } from '../src/telegram/screens/music.js';
import { States } from '../src/core/stateMachine.js';

test('VoiceClient: provides auth and reload methods', async () => {
  const client = new VoiceClient({ port: 3056, host: '127.0.0.1' });
  assert.equal(typeof client.reload, 'function');
  assert.equal(typeof client.sendAuthCode, 'function');
  assert.equal(typeof client.verifyAuthCode, 'function');
  assert.equal(typeof client.verifyAuthPassword, 'function');
  assert.equal(typeof client.cancelAuth, 'function');
});

test('MusicScreen: renderAssistantSessionStatus formats aesthetic rich message', async () => {
  const app = {
    settings: { get: () => 'Lancy' },
    musicQueueManager: { getSession: () => ({ chatId: 12345 }) },
    voiceClient: {}
  };
  const screen = createMusicScreen({ app });
  assert.equal(typeof screen.renderAssistantSessionStatus, 'function');

  const healthBot = {
    ok: true,
    ready: true,
    mode: 'bot_token',
    account: { id: 8859351350, username: 'Lancy_easy_bot' },
    active_calls_count: 0
  };
  const msgBot = screen.renderAssistantSessionStatus(healthBot, 'Lancy_easy_bot');
  const botBlocksJson = JSON.stringify(msgBot.blocks);
  assert.ok(botBlocksJson.includes('STREAMING ENGINE STATUS'));
  assert.ok(botBlocksJson.includes('Bot Direct'));

  const btnBlock = msgBot.blocks.find((b) => b.type === 'buttons');
  assert.ok(!btnBlock, 'Status must not offer an unsafe credential collection button');

  const healthUser = {
    ok: true,
    ready: true,
    mode: 'assistant_user',
    account: { id: 1234567, username: 'LancyAssistant' },
    active_calls_count: 1
  };
  const msgUser = screen.renderAssistantSessionStatus(healthUser, 'Lancy_easy_bot');
  const userBlocksJson = JSON.stringify(msgUser.blocks);
  assert.ok(userBlocksJson.includes('Assistant Userbot'));
  assert.ok(!userBlocksJson.includes('phone_number'), 'No private phone details in status');
});

test('MusicScreen: registers ASSISTANT_AUTH states on state machine', async () => {
  const registered = {};
  const mockSm = {
    register: (state, handlers) => {
      registered[state] = handlers;
    }
  };

  const app = {
    settings: { get: () => 'Lancy' },
    musicQueueManager: { getSession: () => ({ chatId: 12345 }) },
    voiceClient: {}
  };
  const screen = createMusicScreen({ app });
  assert.equal(typeof screen.registerStateHandlers, 'function');

  screen.registerStateHandlers(mockSm);
  assert.ok(registered[States.ASSISTANT_AUTH_PHONE], 'ASSISTANT_AUTH_PHONE registered');
  assert.ok(registered[States.ASSISTANT_AUTH_CODE], 'ASSISTANT_AUTH_CODE registered');
  assert.ok(registered[States.ASSISTANT_AUTH_2FA], 'ASSISTANT_AUTH_2FA registered');

  assert.equal(typeof registered[States.ASSISTANT_AUTH_PHONE].onMessage, 'function');
  assert.equal(typeof registered[States.ASSISTANT_AUTH_CODE].onMessage, 'function');
  assert.equal(typeof registered[States.ASSISTANT_AUTH_2FA].onMessage, 'function');
});

test('MusicScreen: session setup directs owner to terminal, never collects login secrets', async () => {
  const app = {
    settings: { get: () => 'Lancy' },
    musicQueueManager: { getSession: () => ({ chatId: 12345 }) },
    voiceClient: {}
  };
  const screen = createMusicScreen({ app });
  const notice = screen.renderSessionSetupNotice();
  const noticeJson = JSON.stringify(notice.blocks);
  assert.ok(noticeJson.includes('ASSISTANT ACCOUNT SETUP REQUIRED'));

  const btnBlock = notice.blocks.find((b) => b.type === 'buttons');
  assert.ok(btnBlock, 'Button block found');
  assert.ok(!btnBlock.buttons.some(b => b.callback_data.includes('link_assistant')), 'No Telegram OTP setup button');
  assert.match(noticeJson, /Never send login codes/);
  assert.ok(btnBlock.buttons.every(b => Buffer.byteLength(b.callback_data) <= 64));
});
