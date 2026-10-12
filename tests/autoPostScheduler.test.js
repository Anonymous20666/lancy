import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/core/db.js';
import { SettingsManager } from '../src/config/settings.js';
import { StateMachine } from '../src/core/stateMachine.js';
import { AutonomousScheduler, calculateNextRunTime } from '../src/ai/scheduler.js';
import { createAutoPostScreen } from '../src/telegram/screens/autoPost.js';

test('AutoPostScheduler: calculateNextRunTime calculates exact clock slots', () => {
  const scheduleTimes = ['09:00', '14:00', '20:00'];

  // 1. From 08:00 today -> should pick 09:00 today
  const d1 = new Date('2026-10-12T08:00:00.000Z');
  // Adjust to local time of the machine
  const localD1 = new Date();
  localD1.setHours(7, 0, 0, 0);
  const next1 = new Date(calculateNextRunTime(scheduleTimes, 12, localD1));
  assert.equal(next1.getHours(), 9);
  assert.equal(next1.getMinutes(), 0);
  assert.equal(next1.getDate(), localD1.getDate());

  // 2. From 10:00 today -> should pick 14:00 today
  const localD2 = new Date();
  localD2.setHours(10, 0, 0, 0);
  const next2 = new Date(calculateNextRunTime(scheduleTimes, 12, localD2));
  assert.equal(next2.getHours(), 14);
  assert.equal(next2.getMinutes(), 0);

  // 3. From 22:00 today -> should roll over to 09:00 tomorrow
  const localD3 = new Date();
  localD3.setHours(22, 0, 0, 0);
  const next3 = new Date(calculateNextRunTime(scheduleTimes, 12, localD3));
  assert.equal(next3.getHours(), 9);
  assert.equal(next3.getMinutes(), 0);
  assert.equal(next3.getDate(), (localD3.getDate() + 1) % 32 || 1);

  // 4. Fallback when scheduleTimes is empty -> interval hours
  const now = new Date();
  const nextFallback = new Date(calculateNextRunTime([], 6, now));
  const diffHours = (nextFallback.getTime() - now.getTime()) / (3600 * 1000);
  assert.ok(Math.abs(diffHours - 6) < 0.1);
});

test('AutoPostScheduler: schedule lifecycle, persistence, and execution', async () => {
  const db = new Database(':memory:');
  const userId = 7701;
  const tgChannelId = -100888999;

  // Insert mock pack
  db.run(
    `INSERT INTO sticker_packs (user_id, tg_short_name, tg_title, query, count, sticker_type, link)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    userId, 'sched_test_pack', 'Ghibli Aesthetic Drops', 'ghibli', 30, 'static', 'https://t.me/addstickers/sched_test_pack'
  );
  const pack = db.get('SELECT * FROM sticker_packs WHERE user_id = ?', userId);

  const sentPhotos = [];
  const sentStickers = [];
  const sentMessages = [];

  const mockApi = {
    getMe: async () => ({ id: 99999, username: 'lancybot' }),
    getStickerSet: async (name) => ({
      name,
      stickers: [
        { file_id: 'sample_stk_1', emoji: '🌸' },
        { file_id: 'sample_stk_2', emoji: '✨' },
        { file_id: 'sample_stk_3', emoji: '🍃' }
      ]
    }),
    getFile: async (fid) => ({ file_id: fid, file_path: null }),
    sendPhoto: async (cid, photo, opts) => {
      sentPhotos.push({ cid, photo, opts });
      return { message_id: 101 };
    },
    sendSticker: async (cid, sticker, opts) => {
      sentStickers.push({ cid, sticker, opts });
      return { message_id: 102 };
    },
    sendMessage: async (cid, text, opts) => {
      sentMessages.push({ cid, text, opts });
      return { message_id: 103 };
    }
  };

  const app = {
    db,
    telegram: { api: mockApi, botUsername: 'lancybot' },
    packs: {
      getPack: () => pack,
      listPacks: () => ({ packs: [pack], total: 1 })
    }
  };

  const scheduler = new AutonomousScheduler({ app, checkIntervalMs: 60000, log: console });

  // 1. Create 5-day schedule with 2 posts/day (10 total runs)
  const schedule = scheduler.createSchedule({
    userId,
    topic: 'Ghibli Aesthetic',
    frequencyLabel: '2× daily for 5 days',
    timesPerDay: 2,
    days: 5,
    platform: 'telegram',
    tgChannelId,
    packIds: [pack.id],
    scheduleTimes: ['09:00', '18:00'],
    contentMode: 'packs',
    startImmediate: true
  });

  assert.ok(schedule);
  assert.equal(schedule.total_days, 5);
  assert.equal(schedule.times_per_day, 2);
  assert.equal(schedule.total_runs, 10);
  assert.equal(schedule.platform, 'telegram');
  assert.equal(schedule.tg_channel_id, tgChannelId);
  assert.equal(schedule.status, 'active');

  // 2. Pause and Resume
  scheduler.pauseSchedule(schedule.id, userId);
  let updated = db.get('SELECT * FROM scheduled_drops WHERE id = ?', schedule.id);
  assert.equal(updated.status, 'paused');

  scheduler.resumeSchedule(schedule.id, userId);
  updated = db.get('SELECT * FROM scheduled_drops WHERE id = ?', schedule.id);
  assert.equal(updated.status, 'active');

  // 3. Execute drop run
  const execResult = await scheduler.executeDrop(updated);
  assert.equal(execResult.ok, true);
  assert.equal(execResult.run, 1);
  assert.equal(execResult.publishedTg, true);

  // Check Telegram channel posts:
  // Phase 1: Banner Photo with caption
  assert.equal(sentPhotos.length, 1);
  assert.equal(sentPhotos[0].cid, tgChannelId);

  // Phase 2: First 3 sample stickers
  assert.equal(sentStickers.length, 3);
  assert.equal(sentStickers[0].cid, tgChannelId);
  assert.equal(sentStickers[0].sticker, 'sample_stk_1');

  // Phase 3: Pack installation card
  const channelFinal = sentMessages.find((m) => m.cid === tgChannelId);
  assert.ok(channelFinal);
  assert.ok(channelFinal.opts.reply_markup.inline_keyboard[0][0].url.includes('sched_test_pack'));

  // Notification to user in Telegram:
  const userNotification = sentMessages.find((m) => m.cid === userId);
  assert.ok(userNotification);
  assert.ok(userNotification.text.includes('AUTO POST DELIVERED'));

  // Database updated to 1 run completed
  const afterRun = db.get('SELECT * FROM scheduled_drops WHERE id = ?', schedule.id);
  assert.equal(afterRun.runs_completed, 1);

  // Clean up
  scheduler.deleteSchedule(schedule.id, userId);
  assert.equal(scheduler.getUserSchedules(userId).length, 0);

  db.close();
});

test('AutoPost screen wizard: platform, channels, days, clock picker, and campaign launch', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine();
  const userId = 9001;
  const channelId = -100555666;

  db.recordTelegramChannel({
    channel_id: channelId,
    title: 'Neon Anime Vibe',
    username: 'neon_anime',
    can_post: 1,
    added_by: userId
  });

  const mockApi = {
    getMe: async () => ({ id: 99999, username: 'lancybot' }),
    sendMessage: async () => ({ message_id: 1 }),
    sendPhoto: async () => ({ message_id: 2 })
  };

  const app = {
    db,
    settings,
    sm,
    telegram: { api: mockApi, botUsername: 'lancybot' },
    packs: { listPacks: () => ({ packs: [], total: 0 }), getPack: () => null }
  };

  const scheduler = new AutonomousScheduler({ app, checkIntervalMs: 60000, log: console });
  app.scheduler = scheduler;

  const screen = createAutoPostScreen({ app });

  let renderedScreen = null;
  const ctx = {
    tgId: userId,
    chatId: userId,
    messageId: 10,
    screens: new Map([['autopost', screen], ['dashboard', { open: async () => true }]]),
    editScreen: async (rich) => {
      renderedScreen = rich;
      return rich;
    }
  };

  // 1. Open screen -> Step 1 (Platform picker)
  await screen.open(ctx);
  assert.ok(renderedScreen);

  // 2. Select Telegram platform
  await screen.handle(ctx, 'set_platform', ['telegram']);

  // 3. Move to channels
  await screen.handle(ctx, 'to_channels');
  // Toggle the channel
  await screen.handle(ctx, 'toggle_tg_ch', [channelId]);

  // 4. Move to days
  await screen.handle(ctx, 'to_days');
  // Set 10 days
  await screen.handle(ctx, 'set_days', [10]);

  // 5. Move to slots
  await screen.handle(ctx, 'to_slots');
  // Set 2 posts per day
  await screen.handle(ctx, 'set_freq', [2]);

  // 6. Open Morning Clock Picker
  await screen.handle(ctx, 'open_clock', ['morning']);
  // Adjust time by +60 min (09:00 -> 10:00)
  await screen.handle(ctx, 'clock_adj', ['morning', 60]);
  // Adjust time by +15 min (10:00 -> 10:15)
  await screen.handle(ctx, 'clock_adj', ['morning', 15]);

  // Return to slots
  await screen.handle(ctx, 'to_slots');

  // 7. Move to content strategy
  await screen.handle(ctx, 'to_content');
  await screen.handle(ctx, 'set_content_ai');

  // 8. Move to preview
  await screen.handle(ctx, 'to_preview');

  // 9. Launch campaign!
  await screen.handle(ctx, 'launch_campaign');

  // Verify created in DB
  const userSchedules = scheduler.getUserSchedules(userId);
  assert.equal(userSchedules.length, 1);
  assert.equal(userSchedules[0].total_days, 10);
  assert.equal(userSchedules[0].times_per_day, 2);
  assert.equal(userSchedules[0].total_runs, 20);
  assert.equal(userSchedules[0].tg_channel_id, channelId);

  const times = JSON.parse(userSchedules[0].schedule_times_json);
  assert.equal(times[0], '10:15'); // 09:00 + 1h 15m = 10:15!

  db.close();
});
