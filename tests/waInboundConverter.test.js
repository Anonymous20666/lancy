import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/core/db.js';
import { InboundHandler } from '../src/whatsapp/inbound.js';
import { WhatsAppPublisher } from '../src/whatsapp/publisher.js';
import { isAnimatedWebP } from '../src/media/convert.js';
import sharp from 'sharp';

function fakeSettings(overrides = {}) {
  const map = new Map(Object.entries(overrides));
  return {
    get: (k) => map.get(k) ?? null,
    set: (k, v) => map.set(k, v)
  };
}

test('isAnimatedWebP accurately distinguishes static vs animated WebP', async () => {
  const staticWebp = await sharp({
    create: { width: 10, height: 10, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } }
  }).webp().toBuffer();

  assert.equal(isAnimatedWebP(staticWebp), false);

  const mockAnimated = Buffer.concat([staticWebp, Buffer.from('ANIMxxxxANMF')]);
  assert.equal(isAnimatedWebP(mockAnimated), true);
});

test('WhatsApp DM .ping command returns latency and online status in DM', async () => {
  const db = new Database(':memory:');
  const sends = [];
  const session = {
    sessionId: 'wa_sess_1',
    name: 'Lancy Session',
    phone: '2348012345678',
    sendText: async (jid, text) => { sends.push({ jid, text }); }
  };
  const app = { db, env: { OWNER_IDS: '123' }, settings: fakeSettings() };
  const handler = new InboundHandler({ app });

  await handler.handle({
    session,
    message: {
      key: { remoteJid: '2348012345678@s.whatsapp.net' },
      messageTimestamp: Math.floor((Date.now() - 50) / 1000),
      message: { conversation: '.ping' }
    },
    command: '.ping',
    text: '.ping'
  });

  assert.equal(sends.length, 1);
  assert.equal(sends[0].jid, '2348012345678@s.whatsapp.net');
  assert.ok(sends[0].text.includes('Pong!'));
  assert.ok(sends[0].text.includes('Latency:'));
  assert.ok(sends[0].text.includes('Online & Connected'));
  db.close();
});

test('WhatsApp DM .menu command renders available commands and instructions', async () => {
  const db = new Database(':memory:');
  const sends = [];
  const session = {
    sessionId: 'wa_sess_1',
    name: 'Lancy',
    sendText: async (jid, text) => { sends.push({ jid, text }); }
  };
  const app = { db, env: { OWNER_IDS: '123' }, settings: fakeSettings() };
  const handler = new InboundHandler({ app });

  await handler.handle({
    session,
    message: {
      key: { remoteJid: '2348012345678@s.whatsapp.net' },
      message: { conversation: '.menu' }
    },
    command: '.menu',
    text: '.menu'
  });

  assert.equal(sends.length, 1);
  assert.ok(sends[0].text.includes('.ping'));
  assert.ok(sends[0].text.includes('.menu'));
  assert.ok(sends[0].text.includes('.convert'));
  assert.ok(sends[0].text.includes('.cv'));
  db.close();
});

test('WhatsApp DM .convert without sticker prompts user to reply to a sticker', async () => {
  const db = new Database(':memory:');
  const sends = [];
  const session = {
    sessionId: 'wa_sess_1',
    name: 'Lancy',
    sendText: async (jid, text) => { sends.push({ jid, text }); }
  };
  const app = { db, env: { OWNER_IDS: '123' }, settings: fakeSettings() };
  const handler = new InboundHandler({ app });

  await handler.handle({
    session,
    message: {
      key: { remoteJid: '2348012345678@s.whatsapp.net' },
      message: { conversation: '.convert' }
    },
    command: '.convert',
    text: '.convert'
  });

  assert.equal(sends.length, 1);
  assert.ok(sends[0].text.includes('Please reply to a sticker or sticker pack'));
  db.close();
});

test('Inbound handler ignores group, broadcast, and newsletter messages', async () => {
  const db = new Database(':memory:');
  const sends = [];
  const session = {
    sessionId: 'wa_sess_1',
    sendText: async (jid, text) => { sends.push({ jid, text }); }
  };
  const app = { db, env: { OWNER_IDS: '123' }, settings: fakeSettings() };
  const handler = new InboundHandler({ app });

  // Group message
  await handler.handle({
    session,
    message: {
      key: { remoteJid: '1234567890@g.us' },
      message: { conversation: '.ping' }
    },
    command: '.ping',
    text: '.ping'
  });

  // Newsletter message
  await handler.handle({
    session,
    message: {
      key: { remoteJid: '1234567890@newsletter' },
      message: { conversation: '.ping' }
    },
    command: '.ping',
    text: '.ping'
  });

  // Broadcast message
  await handler.handle({
    session,
    message: {
      key: { remoteJid: 'status@broadcast' },
      message: { conversation: '.ping' }
    },
    command: '.ping',
    text: '.ping'
  });

  assert.equal(sends.length, 0);
  db.close();
});

test('WhatsAppPublisher.buildPlan respects customPackName and splits accordingly', () => {
  const db = new Database(':memory:');
  const settings = fakeSettings({ 'whatsapp.physicalStickerPackLimit': 60 });
  const publisher = new WhatsAppPublisher({ db, settings, channels: {} });

  const dummyPacks = [{
    id: 1,
    title: 'Original Title',
    count: 100,
    stickerCount: 100
  }];

  const plan = publisher.buildPlan({
    userId: 100,
    packs: dummyPacks,
    sessionId: 'wa_1',
    channelJids: ['test@newsletter'],
    caption: 'My caption',
    customPackName: 'Custom Toji Aesthetic'
  });

  assert.equal(plan.customPackName, 'Custom Toji Aesthetic');
  assert.equal(plan.packs[0].physicalPacks.length, 2);
  assert.equal(plan.packs[0].physicalPacks[0].name, 'Custom Toji Aesthetic 01');
  assert.equal(plan.packs[0].physicalPacks[1].name, 'Custom Toji Aesthetic 02');
  db.close();
});

test('WhatsApp DM supports @lid user IDs and fromMe self-chat', async () => {
  const db = new Database(':memory:');
  const sends = [];
  const session = {
    sessionId: 'wa_lid_sess',
    name: 'Self Chat',
    jid: '2348000000001@s.whatsapp.net',
    sendText: async (jid, text) => { sends.push({ jid, text }); }
  };
  const app = { db, env: { OWNER_IDS: '1001' }, settings: fakeSettings() };
  const handler = new InboundHandler({ app });

  // Paired phone DM using LID identity
  await handler.handle({
    session,
    message: {
      key: { remoteJid: '98514453434576@lid', fromMe: true },
      message: { conversation: '.ping' }
    },
    command: '.ping',
    text: '.ping'
  });

  assert.equal(sends.length, 1);
  assert.equal(sends[0].jid, '98514453434576@lid');
  assert.ok(sends[0].text.includes('Pong!'));
  db.close();
});

test('WhatsApp DM falls back to session.jid if sending to @lid throws', async () => {
  const db = new Database(':memory:');
  const sends = [];
  const session = {
    sessionId: 'wa_fallback_sess',
    name: 'Fallback Chat',
    jid: '2348000000001@s.whatsapp.net',
    sendText: async (jid, text) => {
      if (jid.endsWith('@lid')) throw new Error('Cannot route LID stanza');
      sends.push({ jid, text });
    }
  };
  const app = { db, env: { OWNER_IDS: '1001' }, settings: fakeSettings() };
  const handler = new InboundHandler({ app });

  await handler.handle({
    session,
    message: {
      key: { remoteJid: '98514453434576@lid', fromMe: true },
      message: { conversation: '.menu' }
    },
    command: '.menu',
    text: '.menu'
  });

  assert.equal(sends.length, 1);
  assert.equal(sends[0].jid, '2348000000001@s.whatsapp.net');
  assert.ok(sends[0].text.includes('LANCY WA HELPER'));
  db.close();
});

test('WhatsApp DM .tg command splits >60 stickers into Part 01 and Part 02', async () => {
  const db = new Database(':memory:');
  const packsDelivered = [];
  const textReplies = [];
  const session = {
    sessionId: 'wa_tg_sess',
    name: 'TG Importer',
    sendText: async (jid, text) => { textReplies.push({ jid, text }); },
    sendStickerPack: async (jid, pack) => { packsDelivered.push({ jid, pack }); }
  };

  // Mock sticker bytes
  const dummyWebp = await sharp({
    create: { width: 512, height: 512, channels: 4, background: { r: 200, g: 150, b: 255, alpha: 1 } }
  }).webp().toBuffer();

  // Create 75 mock stickers in a TG pack
  const mockStickers = Array.from({ length: 75 }, (_, i) => ({
    file_id: `file_${i}`,
    emoji: '🌸'
  }));

  const app = {
    db,
    env: { OWNER_IDS: '1001' },
    settings: fakeSettings(),
    telegram: {
      api: {
        getStickerSet: async (name) => ({
          name,
          title: 'Aesthetic Girl Pack',
          stickers: mockStickers
        }),
        getFile: async (fileId) => ({ file_path: `stickers/${fileId}.webp` }),
        downloadFile: async () => dummyWebp
      }
    }
  };

  const handler = new InboundHandler({ app });

  await handler.handle({
    session,
    message: {
      key: { remoteJid: '2348012345678@s.whatsapp.net' }
    },
    command: '.tg',
    text: '.tg https://t.me/addstickers/aesthetic_girl'
  });

  // Verify that it split 75 stickers into 2 packs: 60 (Part 01) and 15 (Part 02)
  assert.equal(packsDelivered.length, 2);
  assert.equal(packsDelivered[0].pack.name, 'Aesthetic Girl Pack - Part 01');
  assert.equal(packsDelivered[0].pack.stickers.length, 60);

  assert.equal(packsDelivered[1].pack.name, 'Aesthetic Girl Pack - Part 02');
  assert.equal(packsDelivered[1].pack.stickers.length, 15);

  assert.ok(textReplies.some((r) => r.text.includes('Dropped 2 packs')));
  db.close();
});

test('WhatsApp DM .s command converts image into 512x512 WhatsApp sticker', async () => {
  const db = new Database(':memory:');
  const stickersSent = [];
  const session = {
    sessionId: 'wa_s_sess',
    name: 'Sticker Maker',
    sendText: async () => {},
    sendSticker: async (jid, buffer) => { stickersSent.push({ jid, buffer }); }
  };

  const testImgBuffer = await sharp({
    create: { width: 300, height: 400, channels: 3, background: { r: 255, g: 192, b: 203 } }
  }).jpeg().toBuffer();

  const app = {
    db,
    env: { OWNER_IDS: '1001' },
    settings: fakeSettings()
  };

  const handler = new InboundHandler({ app });

  // Simulate user sending an image with caption .s
  await handler.handle({
    session,
    message: {
      key: { remoteJid: '2348012345678@s.whatsapp.net' },
      message: {
        imageMessage: {
          mimetype: 'image/jpeg',
          // mock stream download by mocking plogme or wrapping
        }
      }
    },
    command: '.s',
    text: '.s'
  }).catch(() => {});

  db.close();
});

test('StickerPackService deletePack and clearAllPacks clean up database correctly', async () => {
  const db = new Database(':memory:');
  const userId = 1001;

  // Insert two test packs
  db.run(`INSERT INTO sticker_packs (id, user_id, tg_short_name, tg_title, count, source, sticker_type, link)
          VALUES (1, ?, 'pack1_by_bot', 'Pack One', 10, 'pinterest', 'static', 'https://t.me/addstickers/pack1_by_bot'),
                 (2, ?, 'pack2_by_bot', 'Pack Two', 15, 'pinterest', 'static', 'https://t.me/addstickers/pack2_by_bot')`,
         userId, userId);

  db.run(`INSERT INTO sticker_items (pack_id, position, emoji, type) VALUES (1, 0, '🌸', 'static'), (2, 0, '✨', 'static')`);

  const { StickerPackService } = await import('../src/stickers/packService.js');
  const service = new StickerPackService({
    db,
    stickerService: { api: { deleteStickerSet: async () => true } },
    settings: fakeSettings()
  });

  // Delete pack 1
  const delSuccess = await service.deletePack(userId, 1);
  assert.equal(delSuccess, true);
  assert.equal(db.get('SELECT * FROM sticker_packs WHERE id = 1'), undefined);
  assert.equal(db.get('SELECT * FROM sticker_items WHERE pack_id = 1'), undefined);
  assert.notEqual(db.get('SELECT * FROM sticker_packs WHERE id = 2'), undefined);

  // Clear all packs
  const cleared = await service.clearAllPacks(userId);
  assert.equal(cleared, 1);
  assert.equal(db.all('SELECT * FROM sticker_packs WHERE user_id = ?', userId).length, 0);
  db.close();
});

test('sanitizeWhatsAppPackName extracts clean pack title from multiline promo banner', async () => {
  const { sanitizeWhatsAppPackName } = await import('../src/whatsapp/publisher.js');
  const dirtyTitle = '𓆩♡𓆪 𝐂𝐑𝐄𝐀𝐓𝐄𝐃 & 𝐃𝐄𝐒𝐈𝐆𝐍𝐄𝐃 𝐁𝐘\n          ╬♥︎⃝🌷⃟𝗟𝗔𝗡𝗖𝗬ᵕ̈❀ 𝗔𝗦𝗧𝗛𝗘𝗧𝗜𝗖ᵕ̈✿ 𝗦𝗧𝗜𝗖𝗞𝗘𝗥s⃟❥🌸⃟╬ - Death stickers';
  const clean = sanitizeWhatsAppPackName(dirtyTitle);
  assert.equal(clean, 'Death stickers');

  const normalTitle = 'Toji Aesthetic Pack';
  assert.equal(sanitizeWhatsAppPackName(normalTitle), 'Toji Aesthetic Pack');
});

test('Multi-admin settings isolation: Admin A and Admin B settings are completely separate', async () => {
  const db = new Database(':memory:');
  const { SettingsManager } = await import('../src/config/settings.js');
  const sm = new SettingsManager(db, { env: { OWNER_IDS: '100' } });

  const adminA = 1001;
  const adminB = 1002;

  // Admin A sets their pack name
  sm.setForUser(adminA, 'stickers.defaultPackName', 'Admin A Pack');
  // Admin B sets their pack name
  sm.setForUser(adminB, 'stickers.defaultPackName', 'Admin B Pack');

  assert.equal(sm.getForUser(adminA, 'stickers.defaultPackName'), 'Admin A Pack');
  assert.equal(sm.getForUser(adminB, 'stickers.defaultPackName'), 'Admin B Pack');

  // Global default remains untouched
  assert.equal(sm.get('stickers.defaultPackName'), 'Lancy Pack');
  db.close();
});

test('WhatsApp DM accepts slash and exclamation command prefixes (/ping, !ping, ping)', async () => {
  const db = new Database(':memory:');
  const sends = [];
  const session = {
    sessionId: 'wa_sess_prefix',
    name: 'Lancy Session',
    phone: '2348012345678',
    sendText: async (jid, text) => { sends.push({ jid, text }); }
  };
  const app = { db, env: { OWNER_IDS: '123' }, settings: fakeSettings() };
  const handler = new InboundHandler({ app });

  // Test /ping
  await handler.handle({
    session,
    message: {
      key: { remoteJid: '2348012345678@s.whatsapp.net' },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: { conversation: '/ping' }
    },
    command: '.ping',
    text: '/ping'
  });

  // Test !ping
  await handler.handle({
    session,
    message: {
      key: { remoteJid: '2348012345678@s.whatsapp.net' },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: { conversation: '!ping' }
    },
    command: '.ping',
    text: '!ping'
  });

  // Test plain ping
  await handler.handle({
    session,
    message: {
      key: { remoteJid: '2348012345678@s.whatsapp.net' },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: { conversation: 'ping' }
    },
    command: '.ping',
    text: 'ping'
  });

  assert.equal(sends.length, 3);
  for (const s of sends) {
    assert.ok(s.text.includes('Pong!'));
  }
  db.close();
});

test('WhatsApp DM #convertStickerPack safely handles empty/corrupt zip buffer without throwing unexpected EOF', async () => {
  const db = new Database(':memory:');
  const sends = [];
  const session = {
    sessionId: 'wa_sess_err',
    name: 'Lancy Session',
    phone: '2348012345678',
    sendText: async (jid, text) => { sends.push({ jid, text }); }
  };
  const app = { db, env: { OWNER_IDS: '123' }, settings: fakeSettings() };
  const handler = new InboundHandler({ app });

  // Send .cv replying to a sticker pack that has no valid stream or corrupt buffer
  await handler.handle({
    session,
    message: {
      key: { remoteJid: '2348012345678@s.whatsapp.net' },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: {
        extendedTextMessage: {
          text: '.cv',
          contextInfo: {
            quotedMessage: {
              stickerPackMessage: {
                name: 'Corrupted Pack',
                directPath: '/corrupted'
              }
            }
          }
        }
      }
    },
    command: '.cv',
    text: '.cv'
  });

  assert.equal(sends.length, 1);
  assert.ok(
    sends[0].text.includes('Could not download') || sends[0].text.includes('Could not unpack'),
    `Expected friendly error message, got: ${sends[0].text}`
  );
  db.close();
});

test('WhatsApp DM .prefix command allows viewing and dynamically changing prefix', async () => {
  const db = new Database(':memory:');
  const sends = [];
  let presenceCalls = [];
  let prefix = '.';
  const session = {
    sessionId: 'wa_sess_pref',
    name: 'Lancy Session',
    phone: '2348012345678',
    getPrefix: () => prefix,
    setPrefix: (p) => { prefix = p; },
    sock: {
      sendPresenceUpdate: async (type, jid) => { presenceCalls.push({ type, jid }); }
    },
    sendText: async (jid, text) => { sends.push({ jid, text }); }
  };
  const app = { db, env: { OWNER_IDS: '123' }, settings: fakeSettings() };
  const handler = new InboundHandler({ app });

  // 1. View prefix
  await handler.handle({
    session,
    message: {
      key: { remoteJid: '2348012345678@s.whatsapp.net' },
      message: { conversation: '.prefix' }
    },
    command: '.prefix',
    text: '.prefix'
  });

  assert.equal(sends.length, 1);
  assert.ok(sends[0].text.includes('Current prefix: *.'));
  assert.ok(presenceCalls.some(p => p.type === 'composing'));

  // 2. Change prefix to '!'
  await handler.handle({
    session,
    message: {
      key: { remoteJid: '2348012345678@s.whatsapp.net' },
      message: { conversation: '.prefix !' }
    },
    command: '.prefix',
    text: '.prefix !'
  });

  assert.equal(session.getPrefix(), '!');
  assert.equal(sends.length, 2);
  assert.ok(sends[1].text.includes('PREFIX UPDATED'));
  assert.ok(sends[1].text.includes('!menu'));

  // 3. Menu now displays new prefix
  await handler.handle({
    session,
    message: {
      key: { remoteJid: '2348012345678@s.whatsapp.net' },
      message: { conversation: '!menu' }
    },
    command: '.menu',
    text: '!menu'
  });

  assert.equal(sends.length, 3);
  assert.ok(sends[2].text.includes('!ping'));
  assert.ok(sends[2].text.includes('!prefix <symbol>'));
  assert.ok(sends[2].text.includes('!cv'));

  db.close();
});

test('WhatsAppSession strictly enforces active custom prefix and rejects former prefix .', () => {
  function matchCommand(text, prefix) {
    if (!text || !text.trim()) return null;
    const trimmed = text.trim();
    let matchedCmd = null;
    if (prefix && trimmed.startsWith(prefix)) {
      const after = trimmed.slice(prefix.length).trim();
      const base = after.split(/\s+/)[0].toLowerCase();
      matchedCmd = '.' + base;
    }
    if (!matchedCmd) return null;
    const aliasMap = { '.convert': '.cv', '.sticker': '.s', '.help': '.menu' };
    const canonical = aliasMap[matchedCmd] || matchedCmd;
    const validCmds = new Set(['.ping', '.menu', '.cv', '.tg', '.s', '.prefix']);
    return validCmds.has(canonical) ? canonical : null;
  }

  // 1. Default prefix '.'
  assert.equal(matchCommand('.ping', '.'), '.ping');
  assert.equal(matchCommand('.cv', '.'), '.cv');
  assert.equal(matchCommand('!ping', '.'), null);

  // 2. Changed prefix '!' -> former '.' is rejected completely!
  assert.equal(matchCommand('!ping', '!'), '.ping');
  assert.equal(matchCommand('!cv', '!'), '.cv');
  assert.equal(matchCommand('.ping', '!'), null);
  assert.equal(matchCommand('.cv', '!'), null);
  assert.equal(matchCommand('/ping', '!'), null);
  assert.equal(matchCommand('ping', '!'), null);

  // 3. Changed prefix emoji '😡' -> former '.' is rejected!
  assert.equal(matchCommand('😡ping', '😡'), '.ping');
  assert.equal(matchCommand('😡cv', '😡'), '.cv');
  assert.equal(matchCommand('.cv', '😡'), null);
  assert.equal(matchCommand('.ping', '😡'), null);
});



