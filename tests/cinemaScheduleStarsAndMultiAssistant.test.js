import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Database } from '../src/core/db.js';
import { SettingsManager } from '../src/config/settings.js';
import { StarsBillingService } from '../src/music/starsBilling.js';
import { CinemaVcAnnouncer } from '../src/music/cinemaAnnouncer.js';
import { MovieScheduleService, parseScheduleInput, formatCountdown } from '../src/music/movieScheduler.js';
import { createSettingsScreen } from '../src/telegram/screens/settings.js';

function createTempDb(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lancy-cinema-plan-'));
  const db = new Database(join(dir, 'test.db'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

test('parseScheduleInput parses relative durations, clock times, and repeat rules', () => {
  const now = Date.UTC(2026, 10, 16, 18, 0, 0);
  const rel = parseScheduleInput('Inception in 2h', { nowMs: now, timezone: 'UTC' });
  assert.equal(rel.title, 'Inception');
  assert.equal(rel.scheduledAt, now + 2 * 3600_000);
  assert.equal(rel.repeatRule, null);

  const clk = parseScheduleInput('Demon Slayer S01E02 at 9:30pm daily', { nowMs: now, timezone: 'UTC' });
  assert.equal(clk.title, 'Demon Slayer S01E02');
  assert.equal(clk.scheduledAt, Date.UTC(2026, 10, 16, 21, 30, 0));
  assert.equal(clk.repeatRule, 'daily');

  assert.equal(formatCountdown(90 * 60_000), '1h 30m');
});

test('MovieScheduleService handles countdown re-pinning every N hours, pre-warming, and auto-start', async (t) => {
  const db = createTempDb(t);
  const settings = new SettingsManager(db);
  settings.set('cinema.scheduleRepinHours', 1);
  settings.set('cinema.schedulePrewarmMinutes', 3);

  const sentMsgs = [];
  const editedMsgs = [];
  const deletedMsgs = [];
  const pinnedMsgs = [];
  let nextMsgId = 100;

  const api = {
    sendRichMessage: async (chatId, rich) => {
      const id = ++nextMsgId;
      sentMsgs.push({ id, chatId, rich });
      return { message_id: id };
    },
    editMessageRich: async (chatId, messageId, rich) => {
      editedMsgs.push({ chatId, messageId, rich });
      return { message_id: messageId };
    },
    deleteMessage: async (chatId, messageId) => {
      deletedMsgs.push({ chatId, messageId });
    },
    pinChatMessage: async (chatId, messageId, opts) => {
      pinnedMsgs.push({ chatId, messageId, opts });
    },
    unpinChatMessage: async () => {}
  };

  let playedTrack = null;
  let prewarmCalls = 0;
  const app = {
    db,
    settings,
    telegram: { api },
    movieResolver: {
      resolve: async (item) => {
        prewarmCalls++;
        return {
          ok: true,
          track: {
            id: 'mv:1',
            provider: 'movie',
            title: item.title,
            mediaType: 'video',
            streamUrl: 'https://cdn.example/movie.mp4'
          }
        };
      }
    },
    music: {
      setup: { prepare: async () => ({ ok: true }) }
    },
    musicQueueManager: {
      getSession: () => ({ chatId: -100555, vcUrl: 'https://t.me/test?voicechat' }),
      playImmediateAndContinue: async (_chatId, track) => {
        playedTrack = track;
      }
    }
  };

  const sched = new MovieScheduleService({ app, db, settings });
  const t0 = Date.UTC(2026, 10, 16, 12, 0, 0);
  const row = await sched.createScreening({
    chatId: -100555,
    createdBy: 777,
    title: 'Bahubali (2015)',
    tmdbId: '256040',
    scheduledAt: t0 + 3 * 3600_000,
    repeatRule: 'daily',
    api
  });
  assert.equal(sentMsgs.length, 1);
  assert.equal(pinnedMsgs.length, 1);
  assert.equal(pinnedMsgs[0].opts.disableNotification, true);

  // Move last_pinned_at 61 minutes into the past -> triggers hourly delete + fresh send + silent re-pin
  db.run('UPDATE scheduled_screenings SET last_pinned_at = ? WHERE id = ?', t0 - 61 * 60_000, row.id);
  await sched.tick(t0);
  assert.equal(deletedMsgs.length, 1);
  assert.equal(deletedMsgs[0].messageId, 101);
  assert.equal(sentMsgs.length, 2);
  assert.equal(pinnedMsgs.length, 2);

  // T - 2 minutes -> pre-warms stream
  await sched.tick(t0 + 3 * 3600_000 - 2 * 60_000);
  assert.equal(prewarmCalls, 1);
  const warmedRow = sched.getById(row.id);
  assert.ok(warmedRow.prewarmed_json);

  // T = 0 -> auto-starts screening, updates card to live, and creates next day's recurring slot
  await sched.tick(t0 + 3 * 3600_000 + 1_000);
  assert.equal(playedTrack.title, 'Bahubali (2015)');
  assert.equal(sched.getById(row.id).status, 'live');
  assert.ok(editedMsgs.some((e) => JSON.stringify(e.rich).includes('WATCH PARTY LIVE NOW')));
  const nextScheduled = sched.listByChat(-100555, { status: 'scheduled' });
  assert.equal(nextScheduled.length, 1);
  assert.equal(nextScheduled[0].scheduled_at, row.scheduled_at + 24 * 3600_000);
});

test('MovieScheduleService.suggestScheduleWithAi parses AI lineup and falls back cleanly if AI fails', async (t) => {
  const db = createTempDb(t);
  const settings = new SettingsManager(db);
  const trendingItems = [
    { id: '1', tmdbId: '1', title: 'Movie A', year: 2024, type: 'movie' },
    { id: '2', tmdbId: '2', title: 'Movie B', year: 2025, type: 'movie' },
    { id: '3', tmdbId: '3', title: 'Series C', year: 2023, type: 'tv' }
  ];

  const app = {
    db,
    settings,
    movieApi: { trending: async () => ({ items: trendingItems }) },
    ai: {
      generate: async () => ({
        text: JSON.stringify([
          { index: 2, offsetHours: 2, note: 'Epic opener!' },
          { index: 1, offsetHours: 4, note: 'Main feature!' },
          { index: 3, offsetHours: 6, note: 'Late night binge!' }
        ])
      })
    }
  };
  const sched = new MovieScheduleService({ app, db, settings });
  const prop = await sched.suggestScheduleWithAi({ chatId: -1001, userId: 42, promptText: 'friday night' });
  assert.equal(prop.slots.length, 3);
  assert.equal(prop.slots[0].title, 'Movie B (2025)');
  assert.equal(prop.slots[0].aiNote, 'Epic opener!');

  // Deterministic fallback when AI throws
  app.ai.generate = async () => { throw new Error('ollama offline'); };
  const fb = await sched.suggestScheduleWithAi({ chatId: -1001, userId: 42, promptText: 'chill' });
  assert.equal(fb.slots.length, 3);
  assert.equal(fb.slots[0].title, 'Movie A (2024)');
});

test('StarsBillingService gates CinemaVcAnnouncer broadcasts, validates XTR checkout, activates passes, and supports owner refunds', async (t) => {
  const db = createTempDb(t);
  const settings = new SettingsManager(db);
  settings.set('general.ownerIds', [999]);
  settings.set('cinema.requireStarsForGcBroadcast', true);
  settings.set('cinema.starsBroadcastSinglePrice', 30);
  settings.set('cinema.freeBroadcastChats', [-100888]);

  db.run('INSERT INTO bot_users (bot_id, tg_id, is_banned) VALUES (0, 5001, 0)');

  const invoices = [];
  const checkoutAnswers = [];
  const refunded = [];
  const dmSent = [];
  const api = {
    getChat: async (cid) => ({ id: cid, title: `Group ${cid}`, invite_link: `https://t.me/+inv${Math.abs(cid)}` }),
    sendInvoice: async (chatId, opts) => {
      invoices.push({ chatId, opts });
      return { message_id: 700 };
    },
    answerPreCheckoutQuery: async (id, ok, err) => {
      checkoutAnswers.push({ id, ok, err });
    },
    refundStarPayment: async (uid, chargeId) => {
      refunded.push({ uid, chargeId });
      return true;
    },
    sendRichMessage: async (uid, rich) => {
      dmSent.push({ uid, rich });
      return { message_id: 800 };
    }
  };

  const app = { db, settings, telegram: { api } };
  const billing = new StarsBillingService({ app, db, settings });
  app.starsBilling = billing;
  const announcer = new CinemaVcAnnouncer({ app, db, cooldownMs: 0, pacingMs: 0 });
  app.cinemaAnnouncer = announcer;

  const track = { id: 'mv:10', provider: 'movie', title: 'Bahubali (2015)', mediaType: 'video' };

  // Unpaid GC is gated
  const blocked = await announcer.onTrackStart({ chatId: -100777, track, session: { botId: 0, api } });
  assert.deepEqual(blocked, { skipped: 'stars_required' });
  assert.equal(dmSent.length, 0);

  // VIP allowlisted GC broadcasts for free
  await announcer.onTrackStart({ chatId: -100888, track, session: { botId: 0, api } });
  await announcer.flush();
  assert.equal(dmSent.length, 1);

  // Owner is exempt even in non-VIP GC
  await announcer.onTrackStart({ chatId: -100777, track, session: { botId: 0, api }, forceBoost: true, initiatorUserId: 999 });
  await announcer.flush();
  assert.equal(dmSent.length, 2);

  // Send Stars XTR invoice for -100777
  const inv = await billing.sendBroadcastInvoice({
    api,
    invoiceChatId: 1234,
    targetChatId: -100777,
    payerTgId: 1234,
    productKind: 'broadcast_single'
  });
  assert.equal(inv.amount, 30);
  assert.equal(invoices[0].opts.currency, 'XTR');

  // Bad pre-checkout amount is rejected
  await billing.handlePreCheckout({ id: 'q1', currency: 'XTR', invoice_payload: inv.payloadId, total_amount: 1 }, api);
  assert.equal(checkoutAnswers[0].ok, false);

  // Valid pre-checkout accepted
  await billing.handlePreCheckout({ id: 'q2', currency: 'XTR', invoice_payload: inv.payloadId, total_amount: 30 }, api);
  assert.equal(checkoutAnswers[1].ok, true);

  // Successful payment grants single broadcast credit
  const paidRow = await billing.handleSuccessfulPayment({
    chat: { id: 1234 },
    successful_payment: { invoice_payload: inv.payloadId, telegram_payment_charge_id: 'chg_abc' }
  }, api);
  assert.equal(paidRow.status, 'paid');

  // Consumes single boost credit to broadcast once, then blocks again
  await announcer.onTrackStart({ chatId: -100777, track, session: { botId: 0, api }, forceBoost: true, initiatorUserId: 1234 });
  await announcer.flush();
  const secondTry = await announcer.onTrackStart({ chatId: -100777, track, session: { botId: 0, api }, forceBoost: true, initiatorUserId: 1234 });
  assert.deepEqual(secondTry, { skipped: 'stars_required' });

  // Owner Settings screen enforces owner-only edits and executes Stars refund
  const settingsScreen = createSettingsScreen({ app });
  await settingsScreen.handle({ tgId: 1234, chatId: 1234, settings, api, sm: { transition: async () => {} } }, 'cinemaToggle', ['starsEnabled']);
  assert.equal(settings.get('cinema.starsEnabled'), true); // non-owner ignored

  await settingsScreen.handle({ tgId: 999, chatId: 999, settings, api, sm: { transition: async () => {} } }, 'cinemaToggle', ['scheduleRepinHours']);
  assert.equal(settings.get('cinema.scheduleRepinHours'), 2);

  await billing.refundPayment(paidRow.id, api);
  assert.deepEqual(refunded, [{ uid: 1234, chargeId: 'chg_abc' }]);
  assert.equal(billing.summary().refundedCount, 1);
});
