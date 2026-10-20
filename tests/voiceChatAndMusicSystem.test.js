import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QueueManager } from '../src/music/queueManager.js';
import { VoiceClient } from '../src/music/voiceClient.js';
import { createMusicScreen } from '../src/telegram/screens/music.js';
import { decodeCallback, encodeCallback } from '../src/telegram/rich.js';

test('VoiceClient: provides valid endpoints and health format', async () => {
  const client = new VoiceClient({ port: 3056 });
  assert.equal(client.port, 3056);
  assert.equal(client.baseUrl, 'http://127.0.0.1:3056');
});

test('QueueManager: maintains independent per-chat queues and handles loop/shuffle', async () => {
  const mockVoice = {
    play: async () => ({ ok: true }),
    pause: async () => ({ ok: true }),
    resume: async () => ({ ok: true }),
    stop: async () => ({ ok: true }),
    setVolume: async () => ({ ok: true })
  };

  const qm = new QueueManager({ voiceClient: mockVoice });
  const chat1 = -100123456789;
  const chat2 = -100987654321;

  // Enqueue tracks to Chat 1
  qm.enqueue(chat1, { title: 'Song 1', artist: 'Artist 1', streamUrl: 'http://127.0.0.1:3055/audio/live/s1' });
  qm.enqueue(chat1, { title: 'Song 2', artist: 'Artist 2', streamUrl: 'http://127.0.0.1:3055/audio/live/s2' });
  qm.enqueue(chat1, { title: 'Song 3', artist: 'Artist 3', streamUrl: 'http://127.0.0.1:3055/audio/live/s3' });

  const s1 = qm.getSession(chat1);
  assert.equal(s1.upcoming.length, 3);

  // Verify Chat 2 is isolated
  const s2 = qm.getSession(chat2);
  assert.equal(s2.upcoming.length, 0);

  // Play next track
  const started = await qm.playNext(chat1);
  assert.equal(started.title, 'Song 1');
  assert.equal(s1.status, 'playing');
  assert.equal(s1.upcoming.length, 2);

  // Pause and resume
  await qm.pause(chat1);
  assert.equal(s1.status, 'paused');
  await qm.resume(chat1);
  assert.equal(s1.status, 'playing');

  // Volume
  await qm.setVolume(chat1, 150);
  assert.equal(s1.volume, 150);

  // Loop mode toggle: off -> track -> queue -> off
  assert.equal(qm.toggleLoopMode(chat1), 'track');
  assert.equal(qm.toggleLoopMode(chat1), 'queue');
  assert.equal(qm.toggleLoopMode(chat1), 'off');

  // Skip
  const next = await qm.skip(chat1);
  assert.equal(next.title, 'Song 2');
  assert.equal(s1.history.length, 1);
  assert.equal(s1.history[0].title, 'Song 1');

  // Shuffle
  qm.enqueue(chat1, { title: 'Song 4', artist: 'Artist 4', streamUrl: 'http://127.0.0.1:3055/audio/live/s4' });
  qm.enqueue(chat1, { title: 'Song 5', artist: 'Artist 5', streamUrl: 'http://127.0.0.1:3055/audio/live/s5' });
  const shuffledCount = qm.shuffle(chat1);
  assert.ok(shuffledCount >= 2);

  // Stop
  await qm.stop(chat1);
  assert.equal(s1.status, 'idle');
  assert.equal(s1.currentTrack, null);
  assert.equal(s1.upcoming.length, 0);
});

test('MusicScreen: renders aesthetic Now Playing card and verifies <= 64 byte callbacks', async () => {
  const mockApp = {
    settings: { get: () => 'Lancy' },
    musicQueueManager: null
  };
  const screen = createMusicScreen({ app: mockApp });

  const session = {
    chatId: -100123456789,
    status: 'playing',
    currentTrack: {
      title: 'Starboy',
      artist: 'The Weeknd',
      duration: '03:50',
      requester: 'alex'
    },
    upcoming: [{ title: 'Blinding Lights', artist: 'The Weeknd', duration: '03:20', requester: 'sarah' }],
    volume: 100,
    loopMode: 'off',
    isChannel: false
  };

  const richMsg = screen.renderPlayer(session);
  assert.ok(richMsg);
  assert.ok(richMsg.blocks && richMsg.blocks.length > 0);

  // Check buttons & callback lengths
  const buttonBlocks = richMsg.blocks.filter((b) => b.type === 'buttons');
  assert.ok(buttonBlocks.length >= 3, 'Contains at least 3 rows of player controls');

  for (const block of buttonBlocks) {
    for (const btn of block.buttons) {
      assert.ok(btn.callback_data, 'Button has callback_data');
      const bytes = Buffer.byteLength(btn.callback_data, 'utf8');
      assert.ok(bytes <= 64, `Callback data "${btn.callback_data}" exceeds 64 bytes (${bytes} bytes)`);
      const decoded = decodeCallback(btn.callback_data);
      assert.ok(decoded, `Callback data "${btn.callback_data}" decodes successfully`);
      assert.equal(decoded.screen, 'music');
    }
  }

  // Queue viewer
  const queueMsg = screen.renderQueue(session, 0);
  assert.ok(queueMsg);
  const qBtnBlocks = queueMsg.blocks.filter((b) => b.type === 'buttons');
  for (const block of qBtnBlocks) {
    for (const btn of block.buttons) {
      if (btn.callback_data !== 'noop') {
        const bytes = Buffer.byteLength(btn.callback_data, 'utf8');
        assert.ok(bytes <= 64, `Queue callback data "${btn.callback_data}" exceeds 64 bytes`);
      }
    }
  }

  // Volume picker
  const volMsg = screen.renderVolumePicker(session);
  assert.ok(volMsg);
  const vBtnBlocks = volMsg.blocks.filter((b) => b.type === 'buttons');
  for (const block of vBtnBlocks) {
    for (const btn of block.buttons) {
      const bytes = Buffer.byteLength(btn.callback_data, 'utf8');
      assert.ok(bytes <= 64, `Volume callback data "${btn.callback_data}" exceeds 64 bytes`);
    }
  }
});

test('MusicScreen: renders channel live stream banner when isChannel is true', async () => {
  const mockApp = { settings: { get: () => 'Lancy' } };
  const screen = createMusicScreen({ app: mockApp });

  const channelSession = {
    chatId: -100999888777,
    status: 'playing',
    currentTrack: {
      title: 'Lofi Beats 24/7',
      artist: 'Chillhop',
      duration: 'Live',
      requester: 'admin'
    },
    upcoming: [],
    volume: 100,
    loopMode: 'off',
    isChannel: true
  };

  const richMsg = screen.renderPlayer(channelSession);
  const headerBlock = richMsg.blocks.find((b) => b.type === 'paragraph');
  const str = JSON.stringify(headerBlock);
  assert.ok(str.includes('CHANNEL LIVE BROADCAST'), 'Header reflects Channel Live Broadcast');
});
