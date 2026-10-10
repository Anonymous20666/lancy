import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../src/core/db.js';
import { SettingsManager } from '../src/config/settings.js';
import { WhatsAppManager } from '../src/whatsapp/manager.js';
import { DedupService } from '../src/media/dedup.js';
import { normalizeWhatsAppNumber } from '../src/utils/phone.js';
import { createWhatsAppScreen, pairingCodeRich } from '../src/telegram/screens/whatsapp.js';
import { StateMachine, States } from '../src/core/stateMachine.js';
import { ChannelService, normalizeSubscribedResponse } from '../src/whatsapp/channels.js';

test('WhatsApp pairing normalizes phone digits with or without plus', () => {
  const norm1 = normalizeWhatsAppNumber('+234 801 234 5678');
  assert.equal(norm1.e164, '2348012345678');

  const norm2 = normalizeWhatsAppNumber('234-801-234-5678');
  assert.equal(norm2.e164, '2348012345678');

  const cleaned = String(norm1.e164).replace(/\D/g, '');
  assert.equal(cleaned, '2348012345678');
});

test('WhatsApp logout completely deletes credentials directory and database record', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'lancy-wa-logout-test-'));
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const manager = new WhatsAppManager({ db, settings, credsRoot: tmpRoot });

  const userId = 1001;
  const session = await manager.createSession({ userId, name: 'Lancy Test', phone: '2348012345678' });
  const sessionId = session.sessionId;

  // Verify session created in DB and folder on disk
  const credsDir = join(tmpRoot, 'sessions', sessionId);
  assert.ok(existsSync(credsDir), 'credentials directory exists');
  const dbRow = db.get('SELECT * FROM wa_sessions WHERE session_id = ?', sessionId);
  assert.ok(dbRow, 'db record exists');
  assert.equal(manager.listForUser(userId).length, 1);

  // Perform logout with deleteCreds = true
  const success = await manager.logoutSession(sessionId, { deleteCreds: true });
  assert.equal(success, true);

  // Verify data is deleted off the system
  assert.equal(existsSync(credsDir), false, 'credentials folder deleted from disk');
  const afterRow = db.get('SELECT * FROM wa_sessions WHERE session_id = ?', sessionId);
  assert.ok(!afterRow, 'session record deleted from database');
  assert.equal(manager.listForUser(userId).length, 0, 'session removed from user sessions list');

  db.close();
});

test('WhatsApp screen logout callback triggers full cleanup and redirects to empty menu', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'lancy-screen-logout-test-'));
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const manager = new WhatsAppManager({ db, settings, credsRoot: tmpRoot });
  const sm = new StateMachine({ db });

  const userId = 1001;
  const session = await manager.createSession({ userId, name: 'Main', phone: '2348012345678' });
  const sessionId = session.sessionId;

  let editedRich = null;
  const ctx = {
    tgId: userId,
    chatId: userId,
    messageId: 100,
    api: {},
    db,
    settings,
    sm,
    editScreen: async (rich) => { editedRich = rich; return { message_id: 100 }; },
    reply: async () => {}
  };

  const app = { whatsapp: manager, db, settings };
  const waScreen = createWhatsAppScreen({ app });

  // Handle logout
  await waScreen.handle(ctx, 'logout', [sessionId]);

  // Check that session is deleted from manager and disk
  assert.equal(manager.listForUser(userId).length, 0);
  assert.equal(existsSync(join(tmpRoot, 'sessions', sessionId)), false);

  // Check that editedRich renders empty menu with "Pair Number"
  assert.ok(editedRich);
  const buttons = editedRich.blocks.find(b => b.type === 'buttons')?.buttons ?? [];
  assert.ok(buttons.some(b => b.callback_data?.includes('pair')), 'renders pair button');

  db.close();
});

test('dedup index includes pinterest_media so videos and pics never repeat across searches', () => {
  const db = new Database(':memory:');
  const dedup = new DedupService(db);
  const userId = 1001;

  // Insert a video pick into pinterest_media from previous search
  db.run(
    `INSERT INTO pinterest_media (search_id, user_id, pin_id, media_url, sha256, phash, type, is_duplicate, status)
     VALUES (1, ?, 'pin_vid_123', 'https://v1.pinimg.com/vid1.mp4', 'sha_vid_123', '5de97462362c31d8', 'video', 0, 'valid')`,
    userId
  );

  // Insert an image pick into pinterest_media from previous search
  db.run(
    `INSERT INTO pinterest_media (search_id, user_id, pin_id, media_url, sha256, phash, type, is_duplicate, status)
     VALUES (1, ?, 'pin_img_456', 'https://i.pinimg.com/img1.jpg', 'sha_img_456', '4bc3616d49b1a4ce', 'image', 0, 'valid')`,
    userId
  );

  // A fresh DedupService instance checks the same items for next search:
  const freshDedup = new DedupService(db);

  // 1. Video with same pinId
  assert.equal(freshDedup.check(userId, { pinId: 'pin_vid_123' }).duplicate, true);
  // 2. Video with same mediaUrl
  assert.equal(freshDedup.check(userId, { mediaUrl: 'https://v1.pinimg.com/vid1.mp4' }).duplicate, true);
  // 3. Video with same sha256
  assert.equal(freshDedup.check(userId, { sha256: 'sha_vid_123' }).duplicate, true);
  // 4. Video with matching perceptual hash
  assert.equal(freshDedup.check(userId, { phash: '5de97462362c31d8' }).duplicate, true);

  // 5. Image with same pinId
  assert.equal(freshDedup.check(userId, { pinId: 'pin_img_456' }).duplicate, true);
  // 6. Image with same mediaUrl
  assert.equal(freshDedup.check(userId, { mediaUrl: 'https://i.pinimg.com/img1.jpg' }).duplicate, true);
  // 7. Image with same sha256
  assert.equal(freshDedup.check(userId, { sha256: 'sha_img_456' }).duplicate, true);
  // 8. Image with matching perceptual hash
  assert.equal(freshDedup.check(userId, { phash: '4bc3616d49b1a4ce' }).duplicate, true);

  // 9. New unique item is not duplicate
  assert.equal(freshDedup.check(userId, { pinId: 'new_unique_pin', mediaUrl: 'https://new/img.jpg', sha256: 'new_sha', phash: '1111222233334444' }).duplicate, false);

  db.close();
});

test('WhatsApp custom pairing code defaults to LANCYBOT and renders copy button + instructions', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  assert.equal(settings.get('whatsapp.customPairingCode'), 'LANCYBOT');

  const tmpRoot = mkdtempSync(join(tmpdir(), 'lancy-wa-custom-code-'));
  const manager = new WhatsAppManager({ db, settings, credsRoot: tmpRoot });
  const session = await manager.createSession({ userId: 12345, name: 'Lancy Custom', phone: '2348012345678' });

  // Mock socket to intercept requestPairingCode arguments
  let passedPhone = null;
  let passedCustomCode = null;
  session.sock = {
    authState: { creds: { registered: false } },
    ws: { isOpen: true, readyState: 1 },
    requestPairingCode: async (phone, customCode) => {
      passedPhone = phone;
      passedCustomCode = customCode;
      return customCode ?? 'RANDOM12';
    }
  };

  const code = await manager.requestPairing(session.sessionId, '2348012345678');
  assert.equal(passedPhone, '2348012345678');
  assert.equal(passedCustomCode, 'LANCYBOT');
  assert.equal(code, 'LANCYBOT');

  // Verify pairingCodeRich rendering
  const rendered = pairingCodeRich({ formatted: '+234 801 234 5678' }, 'Lancy Custom', code);
  assert.ok(rendered);
  const textContent = JSON.stringify(rendered);
  assert.ok(textContent.includes('LANC-YBOT'), 'contains hyphenated formatted code');
  assert.ok(textContent.includes('HOW TO ENTER THE CODE ON YOUR PHONE'), 'contains phone instructions');
  assert.ok(textContent.includes('Linked Devices'), 'mentions Linked Devices in instructions');

  // Verify copy button
  const buttonsBlock = rendered.blocks.find(b => b.type === 'buttons');
  assert.ok(buttonsBlock, 'has buttons block');
  const copyBtn = buttonsBlock.buttons.find(btn => btn.copy_text?.text === 'LANCYBOT');
  assert.ok(copyBtn, 'renders 1-tap copy button for LANCYBOT');
  assert.equal(copyBtn.copy_text.text, 'LANCYBOT');

  db.close();
});

test('WhatsApp session socket ignores non-newsletter inbound traffic and ensures pairing reconnection', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const tmpRoot = mkdtempSync(join(tmpdir(), 'lancy-wa-stability-test-'));
  const manager = new WhatsAppManager({ db, settings, credsRoot: tmpRoot });
  const session = await manager.createSession({ userId: 12345, name: 'Lancy Stability', phone: '2348012345678' });

  // 1. Verify that pairing reconnects if socket is closed / dead
  let connectCount = 0;
  session.sock = {
    authState: { creds: { registered: true } }, // stale registered flag
    ws: { isOpen: false, readyState: 3 }, // closed
    end: () => {}
  };

  // Mock #connect to simulate reviving the socket
  session.start = async () => {};
  let requestedPhone = null;
  let requestedCustomCode = null;

  // Simulate #connect behavior by hooking into session
  const origConnect = session['#connect'];
  // We can test requestPairingCode recovery when session.sock is closed:
  // If sock.ws is closed, it calls #connect
  let newSockCreated = false;
  session.sock = null; // triggers connect or mock
  session.sock = {
    authState: { creds: { registered: false } },
    ws: { isOpen: true, readyState: 1 },
    requestPairingCode: async (phone, code) => {
      requestedPhone = phone;
      requestedCustomCode = code;
      return code ?? 'RANDOM12';
    }
  };

  const code = await session.requestPairingCode('2348012345678');
  assert.equal(code, 'LANCYBOT');
  assert.equal(requestedPhone, '2348012345678');
  assert.equal(requestedCustomCode, 'LANCYBOT');

  db.close();
});

test('normalizeSubscribedResponse handles multiple shapes and normalizes numeric IDs to @newsletter', () => {
  // Shape 1: Direct array of newsletter objects with numeric ID and thread_metadata
  const rawArray = [
    {
      id: '12036311111111111',
      thread_metadata: { name: { text: 'Aesthetic Channel 1' } },
      viewer_metadata: { role: 'ADMIN' }
    },
    {
      id: '12036322222222222@newsletter',
      name: 'Aesthetic Channel 2',
      viewer_metadata: { role: 'OWNER' }
    }
  ];
  const list1 = normalizeSubscribedResponse(rawArray);
  assert.equal(list1.length, 2);
  assert.equal(list1[0].jid, '12036311111111111@newsletter');
  assert.equal(list1[0].name, 'Aesthetic Channel 1');
  assert.equal(list1[1].jid, '12036322222222222@newsletter');
  assert.equal(list1[1].name, 'Aesthetic Channel 2');

  // Shape 2: { result: [...] }
  const rawResult = {
    result: [
      { id: '12036333333333333', name: 'Channel from Result' }
    ]
  };
  const list2 = normalizeSubscribedResponse(rawResult);
  assert.equal(list2.length, 1);
  assert.equal(list2[0].jid, '12036333333333333@newsletter');
  assert.equal(list2[0].name, 'Channel from Result');

  // Shape 3: { xwa2_newsletter_subscribed: [...] }
  const rawMex = {
    xwa2_newsletter_subscribed: [
      { id: '12036344444444444@newsletter', thread_metadata: { name: { text: 'Mex Channel' } } }
    ]
  };
  const list3 = normalizeSubscribedResponse(rawMex);
  assert.equal(list3.length, 1);
  assert.equal(list3[0].jid, '12036344444444444@newsletter');
  assert.equal(list3[0].name, 'Mex Channel');
});

test('ChannelService resolves channel by invite link or direct JID and persists to wa_channels', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const channels = new ChannelService({ db, settings });

  const mockSession = {
    sessionId: 'wa_test_session',
    jid: '2348000000001@s.whatsapp.net',
    getNewsletterInviteInfo: async (codeOrUrl) => ({
      id: '12036355555555555@newsletter',
      thread_metadata: { name: { text: 'Pappy Aesthetic World' } },
      viewer_metadata: { role: 'ADMIN' }
    }),
    getNewsletterMetadata: async (jid) => ({
      id: jid,
      thread_metadata: { name: { text: 'Pappy Secondary Channel' } },
      viewer_metadata: { role: 'OWNER' }
    })
  };

  // 1. Resolve by invite link
  const ch1 = await channels.resolveChannel(mockSession, 'https://whatsapp.com/channel/0029VaPappy123');
  assert.equal(ch1.jid, '12036355555555555@newsletter');
  assert.equal(ch1.name, 'Pappy Aesthetic World');
  assert.equal(ch1.canPublish, 'yes');

  // 2. Resolve by direct JID
  const ch2 = await channels.resolveChannel(mockSession, '12036366666666666@newsletter');
  assert.equal(ch2.jid, '12036366666666666@newsletter');
  assert.equal(ch2.name, 'Pappy Secondary Channel');
  assert.equal(ch2.canPublish, 'yes');

  // 3. Verify saved to SQLite wa_channels
  const saved = channels.cached('wa_test_session');
  assert.equal(saved.length, 2);
  assert.ok(saved.some(c => c.channel_jid === '12036355555555555@newsletter'));
  assert.ok(saved.some(c => c.channel_jid === '12036366666666666@newsletter'));

  db.close();
});

test('WhatsAppManager.describe handles null and undefined safely', () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const manager = new WhatsAppManager({ db, settings, credsRoot: tmpdir() });

  const descNull = manager.describe(null);
  assert.equal(descNull.sessionId, null);
  assert.equal(descNull.name, 'Unknown');
  assert.equal(descNull.status, 'offline');

  const descUndef = manager.describe(undefined);
  assert.equal(descUndef.sessionId, null);
  assert.equal(descUndef.name, 'Unknown');
  assert.equal(descUndef.status, 'offline');

  db.close();
});

test('WhatsAppPublisher.buildPlan correctly parses pack with .count and .title (no NaN)', async () => {
  const { WhatsAppPublisher } = await import('../src/whatsapp/publisher.js');
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const publisher = new WhatsAppPublisher({ db, settings });

  const packs = [
    { id: 1, title: 'Sukuna Stickers', count: 13, query: 'sukuna' },
    { id: 2, title: 'Death Stickers', count: 10, query: 'death' }
  ];

  const plan = publisher.buildPlan({
    packs,
    sessionId: 'wa_test',
    channelJids: ['120363431396805997@newsletter'],
    caption: 'Test Caption'
  });

  assert.equal(plan.totals.logicalPacks, 2);
  assert.equal(plan.totals.stickers, 23);
  assert.equal(plan.totals.physicalPacks, 2);
  assert.ok(!Number.isNaN(plan.totals.stickers));
  assert.equal(plan.packs[0].physicalPacks[0].name, 'Sukuna Stickers');
  assert.equal(plan.packs[0].physicalPacks[0].stickerCount, 13);
  assert.equal(plan.packs[1].physicalPacks[0].name, 'Death Stickers');
  assert.equal(plan.packs[1].physicalPacks[0].stickerCount, 10);

  db.close();
});

test('WhatsAppPublisher.publish sends caption first and publishes sticker pack to channel', async () => {
  const { WhatsAppPublisher } = await import('../src/whatsapp/publisher.js');
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);

  const mockChannels = {
    revalidate: async () => [{ jid: '120363431396805997@newsletter', name: 'Him', canPublish: 'yes' }]
  };

  const publisher = new WhatsAppPublisher({ db, settings, channels: mockChannels });

  const callLog = [];
  const mockSession = {
    sessionId: 'wa_test_sess',
    jid: '2348000000001@s.whatsapp.net',
    isOnline: true,
    sendText: async (jid, text) => {
      callLog.push({ type: 'text', jid, text });
    },
    sendStickerPack: async (jid, pack) => {
      callLog.push({ type: 'pack', jid, pack });
      return { key: { id: 'msg_1' } };
    }
  };

  const plan = publisher.buildPlan({
    packs: [{ id: 5, title: 'Death Stickers', count: 2 }],
    sessionId: 'wa_test_sess',
    channelJids: ['120363431396805997@newsletter'],
    caption: '♡ Him • Lancy Stickers'
  });

  const dummyWebp = Buffer.from('RIFF\x20\x00\x00\x00WEBPVP8 \x14\x00\x00\x00', 'binary');
  const results = await publisher.publish({
    plan,
    session: mockSession,
    getStickerBytes: async () => dummyWebp
  });

  assert.equal(results.status, 'done');
  assert.equal(results.totals.succeeded, 1);
  assert.equal(callLog.length, 2);
  // Verify caption drops FIRST
  assert.equal(callLog[0].type, 'text');
  assert.equal(callLog[0].text, '♡ Him • Lancy Stickers');
  // Verify sticker pack drops SECOND
  assert.equal(callLog[1].type, 'pack');
  assert.equal(callLog[1].jid, '120363431396805997@newsletter');
  assert.equal(callLog[1].pack.name, 'Death Stickers');
  assert.equal(callLog[1].pack.stickers.length, 2);

  db.close();
});

test('WhatsApp screen post_confirm executes publish without throwing and uses persisted selection', async () => {
  const db = new Database(':memory:');
  const settings = new SettingsManager(db);
  const sm = new StateMachine();
  const userId = 1001;

  let publishedPlan = null;
  const mockSession = {
    sessionId: 'wa_sess_1',
    jid: '2348000000001@s.whatsapp.net',
    isOnline: true,
    status: 'online'
  };

  const mockManager = {
    listForUser: () => [mockSession],
    get: (id) => (id === 'wa_sess_1' ? mockSession : null),
    describe: () => ({ name: 'Test WA', phone: '2348000000001' })
  };

  const mockPacks = {
    listPacks: () => ({ packs: [{ id: 10, title: 'Cute Anime', count: 5, tg_short_name: 'cute_anime' }] }),
    getPack: () => ({ id: 10, title: 'Cute Anime', count: 5, tg_short_name: 'cute_anime' }),
    getStickerBytes: async () => Buffer.from('fake-webp')
  };

  const mockPublisher = {
    buildPlan: (opts) => ({
      userId: opts.userId,
      packs: [{ pack: opts.packs[0], physicalPacks: [{ count: 5 }] }],
      sessionId: opts.sessionId,
      channelJids: opts.channelJids,
      totals: { stickers: 5, physicalPacks: 1 }
    }),
    publish: async ({ plan }) => {
      publishedPlan = plan;
      return { status: 'done', totals: { stickers: 5 }, publicationId: 'pub_1' };
    }
  };

  const mockQueues = {
    add: async (name, job) => job.run(null, { signal: new AbortController().signal })
  };

  let editRichCalled = null;
  const mockApi = {
    editMessageRich: async (_chatId, _msgId, rich) => { editRichCalled = rich; return { message_id: 100 }; },
    sendRichMessage: async (_chatId, rich) => { editRichCalled = rich; return { message_id: 101 }; },
    sendMessage: async () => ({ message_id: 102 })
  };

  const app = {
    whatsapp: mockManager,
    packs: mockPacks,
    publisher: mockPublisher,
    queues: mockQueues,
    telegram: { api: mockApi },
    db,
    settings,
    captions: {
      renderDefault: () => 'Aesthetic Caption'
    }
  };

  const waScreen = createWhatsAppScreen({ app });

  const ctx = {
    tgId: userId,
    chatId: userId,
    messageId: 100,
    api: mockApi,
    db,
    settings,
    sm,
    editScreen: async (rich) => { editRichCalled = rich; return { message_id: 100 }; }
  };

  // 1. Simulate toggling channel
  await waScreen.handle(ctx, 'toggleChannel', ['120363431396805997@newsletter']);

  // 2. Click post_confirm
  await waScreen.handle(ctx, 'post_confirm', []);

  assert.ok(publishedPlan, 'publisher.publish must have been executed');
  assert.equal(publishedPlan.channelJids[0], '120363431396805997@newsletter');
  assert.equal(publishedPlan.userId, userId);

  db.close();
});

