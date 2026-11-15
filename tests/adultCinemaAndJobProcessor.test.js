import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../src/core/db.js';
import { SettingsManager } from '../src/config/settings.js';
import { StateMachine } from '../src/core/stateMachine.js';
import { createNsfwScreen } from '../src/telegram/screens/nsfw.js';
import { AdultCatalog } from '../src/media/adultCatalog.js';
import { CommandJobProcessor } from '../src/core/commandProcessor.js';
import { QueueManager } from '../src/music/queueManager.js';
import { CinemaVcAnnouncer } from '../src/music/cinemaAnnouncer.js';
import { TelegramAPI } from '../src/telegram/api.js';
import { decodeCallback } from '../src/telegram/rich.js';

function makeDb() {
  const dir = mkdtempSync(join(tmpdir(), 'lancy-ac-test-'));
  return new Database(join(dir, 'test.db'));
}

test('AdultCatalog: searchPornhub and resolvePornhubStream parse Webmasters API and flashvars mediaDefinitions', async (t) => {
  const origFetch = global.fetch;
  t.after(() => {
    global.fetch = origFetch;
  });

  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('pornhub.com/webmasters/search')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          videos: [
            {
              video_id: 'ph12345',
              title: 'Eva Elfie Romantic 4K Scene',
              duration: '18:30',
              views: 1250000,
              rating: 94.5,
              url: 'https://www.pornhub.com/view_video.php?viewkey=ph12345',
              default_thumb: 'https://ei.phncdn.com/videos/thumb1.jpg',
              pornstars: [{ pornstar_name: 'Eva Elfie' }],
              categories: [{ category: 'romantichd' }, { category: 'hd-porn' }],
              tags: [{ tag_name: '4k' }]
            }
          ]
        })
      };
    }
    if (u.includes('pornhub.com/view_video.php')) {
      return {
        ok: true,
        status: 200,
        headers: { getSetCookie: () => ['bs=abc123; path=/'] },
        text: async () => `
          <script>
            var flashvars_12345 = {"video_title":"Eva Elfie Romantic 4K Scene","video_duration":"1110","mediaDefinitions":[{"format":"mp4","videoUrl":"https://www.pornhub.com/video/get_media?s=tok123","quality":[240,480,720]}]};
          </script>
        `
      };
    }
    if (u.includes('pornhub.com/video/get_media')) {
      return {
        ok: true,
        status: 200,
        json: async () => ([
          { format: 'mp4', quality: '240', videoUrl: 'https://ev.phncdn.com/videos/ph12345_240p.mp4' },
          { format: 'mp4', quality: '480', videoUrl: 'https://ev.phncdn.com/videos/ph12345_480p.mp4' },
          { format: 'mp4', quality: '720', videoUrl: 'https://ev.phncdn.com/videos/ph12345_720p.mp4' }
        ])
      };
    }
    return { ok: false, status: 404, text: async () => '' };
  };

  const catalog = new AdultCatalog();
  const searchRes = await catalog.searchPornhub({ query: 'Eva Elfie', page: 0, limit: 10 });
  assert.equal(searchRes.results.length, 1);
  assert.equal(searchRes.results[0].id, 'ph_ph12345');
  assert.equal(searchRes.results[0].artist, 'Eva Elfie');
  assert.equal(searchRes.results[0].durationSeconds, 1110);

  const item = searchRes.results[0];
  await catalog.resolveStream(item);
  assert.equal(item.videoUrl, 'https://ev.phncdn.com/videos/ph12345_720p.mp4');
  assert.equal(item.variants.length, 3);
  assert.equal(item.variants[0].quality, '720p');
  assert.equal(item.variants[1].quality, '480p');
});

test('18+ Cinema UI: Detail Card quality selector, Categories, Artists, Page Jump & strict VC auth without chat spam', async (t) => {
  const origFetch = global.fetch;
  t.after(() => {
    global.fetch = origFetch;
  });

  global.fetch = async (url, opts) => {
    const u = String(url);
    if (opts?.method === 'HEAD') {
      return {
        ok: true,
        status: 200,
        headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(42 * 1024 * 1024) : 'video/mp4') }
      };
    }
    if (u.includes('pornhub.com/webmasters/search')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          videos: Array.from({ length: 12 }, (_, idx) => ({
            video_id: `ph_${idx + 1}`,
            title: `Pornhub HD Feature #${idx + 1}`,
            duration: '14:20',
            views: 98000,
            rating: 91,
            url: `https://www.pornhub.com/view_video.php?viewkey=ph_${idx + 1}`,
            default_thumb: `https://ei.phncdn.com/videos/t_${idx + 1}.jpg`,
            pornstars: [{ pornstar_name: 'Lana Rhoades' }],
            categories: [{ category: 'latina' }],
            tags: []
          }))
        })
      };
    }
    if (u.includes('pornhub.com/view_video.php')) {
      return {
        ok: true,
        status: 200,
        headers: { getSetCookie: () => [] },
        text: async () => `var flashvars_1 = {"mediaDefinitions":[{"format":"mp4","videoUrl":"https://www.pornhub.com/video/get_media?s=1","quality":[480,720]}]};`
      };
    }
    if (u.includes('pornhub.com/video/get_media')) {
      return {
        ok: true,
        status: 200,
        json: async () => ([
          { format: 'mp4', quality: '480', videoUrl: 'https://ev.phncdn.com/videos/stream_480p.mp4' },
          { format: 'mp4', quality: '720', videoUrl: 'https://ev.phncdn.com/videos/stream_720p.mp4' }
        ])
      };
    }
    return { ok: false, status: 404, text: async () => '' };
  };

  const db = makeDb();
  const settings = new SettingsManager(db);
  const sm = new StateMachine();
  const sentRich = [];
  const chatMessages = [];
  const cbAlerts = [];
  const downloaded = [];
  let vcAuthAllowed = false;

  const mockApi = {
    sendRichMessage: async (chatId, rich) => {
      sentRich.push({ chatId, rich });
      return { message_id: 900 + sentRich.length };
    },
    editMessageRich: async (chatId, msgId, rich) => {
      sentRich.push({ chatId, msgId, rich, edited: true });
      return { message_id: msgId };
    },
    sendMessage: async (chatId, text) => {
      chatMessages.push({ chatId, text });
      return { message_id: 999 };
    },
    deleteMessage: async () => true,
    answerCallbackQuery: async (id, opts) => {
      cbAlerts.push({ id, opts });
      return true;
    }
  };

  const app = {
    db,
    settings,
    sm,
    adultCatalog: new AdultCatalog(),
    telegram: { api: mockApi },
    music: {
      destination: (c) => c.chatId,
      authorize: async () => {
        if (!vcAuthAllowed) throw new Error('Only group admins or DJs can stream in VC.');
        return true;
      },
      prepare: async () => true,
      player: async () => ({ screenMessageId: 777 })
    },
    musicQueueManager: {
      getSession: () => ({ activeDeck: 'movie', screenMessageId: null }),
      addMovies: async () => {}
    },
    movieDownloader: {
      sendSingleVideo: async (c, track, opts) => {
        downloaded.push({ track, opts });
        return { ok: true };
      }
    }
  };

  const nsfw = createNsfwScreen({ app });
  nsfw.registerStateHandlers(sm);
  db.setSetting('nsfw.ageVerified.777', true);
  db.setSetting('nsfw.groupEnabled.-100555', true);

  // 1. Open Pornhub search in group
  await nsfw.executePornhubSearch({ tgId: '777', chatId: -100555, isGroup: true, api: mockApi, sm }, 'latina');
  assert.equal(
    sentRich.some(r => /SEARCHING 18\+ STUDIO|Searching Eporner|Countdown:/i.test(JSON.stringify(r.rich))),
    false,
    '18+ Cinema catalog search must never render the 18+ Studio batch downloader countdown screen'
  );
  const countAfterSearch = sentRich.length;
  await new Promise(r => setTimeout(r, 2700));
  assert.equal(sentRich.length, countAfterSearch, 'No leaked ProgressTracker timer may overwrite the results card after 2.5s');
  const resultsCard = sentRich.at(-1).rich;
  const allButtons = resultsCard.blocks.filter(b => b.type === 'buttons').flatMap(b => b.buttons);

  // Verify Detail button, Jump button, Categories button, Artists button exist
  const btnLabel = (b) => JSON.stringify(b?.text || '');
  const detailBtn = allButtons.find(b => btnLabel(b).includes('#1') && String(b.callback_data).includes(':acDt:'));
  const jumpBtn = allButtons.find(b => btnLabel(b).includes('Jump'));
  const catBtn = allButtons.find(b => btnLabel(b).includes('Categories'));
  const artBtn = allButtons.find(b => btnLabel(b).includes('Artists'));
  assert.ok(detailBtn && jumpBtn && catBtn && artBtn, 'Results card must include Detail, Jump, Categories, and Artists buttons');

  // 2. Open Movie-Style Detail Card -> select 360p quality -> download uses 360p
  const dtDecoded = decodeCallback(detailBtn.callback_data);
  await nsfw.handle({ tgId: '777', chatId: -100555, isGroup: true, api: mockApi, sm, query: { id: 'q_dt', message: { message_id: 901 } } }, dtDecoded.action, dtDecoded.args);
  const detailRich = sentRich.at(-1).rich;
  assert.match(JSON.stringify(detailRich), /MOVIE DETAIL/);
  const detailBtns = detailRich.blocks.filter(b => b.type === 'buttons').flatMap(b => b.buttons);
  const q360Btn = detailBtns.find(b => btnLabel(b).includes('360p'));
  assert.ok(q360Btn, 'Detail card should render 360p quality pill with ~MB estimate');

  const qDecoded = decodeCallback(q360Btn.callback_data);
  await nsfw.handle({ tgId: '777', chatId: -100555, isGroup: true, api: mockApi, sm, query: { id: 'q_ql', message: { message_id: 901 } } }, qDecoded.action, qDecoded.args);

  const updatedDetailBtns = sentRich.at(-1).rich.blocks.filter(b => b.type === 'buttons').flatMap(b => b.buttons);
  const dlBtn = updatedDetailBtns.find(b => btnLabel(b).includes('MP4 (360p)'));
  assert.ok(dlBtn, 'Download button should reflect selected 360p quality');

  const dlDecoded = decodeCallback(dlBtn.callback_data);
  await nsfw.handle({ tgId: '777', chatId: -100555, isGroup: true, api: mockApi, sm, query: { id: 'q_dl', message: { message_id: 901 } } }, dlDecoded.action, dlDecoded.args);
  assert.equal(downloaded.length, 1);
  assert.equal(downloaded[0].opts.quality, '360p');
  assert.equal(downloaded[0].opts.spoiler, true);

  // 3. Unauthorized user clicking Stream in VC gets callback alert, ZERO chat message spam!
  const streamBtn = updatedDetailBtns.find(b => btnLabel(b).includes('Stream in VC'));
  const stDecoded = decodeCallback(streamBtn.callback_data);
  vcAuthAllowed = false;
  await nsfw.handle({ tgId: '777', chatId: -100555, isGroup: true, api: mockApi, sm, query: { id: 'q_vc', message: { message_id: 901 } } }, stDecoded.action, stDecoded.args);
  assert.equal(chatMessages.length, 0, 'Unauthorized VC stream attempt must never spam the group chat');
  assert.ok(cbAlerts.some(a => a.opts?.show_alert === true && /Only group admins or DJs/i.test(a.opts?.text || '')));

  // 4. Smart Page Jump modal + typing page number in chat transitions to requested page
  const jpDecoded = decodeCallback(jumpBtn.callback_data);
  await nsfw.handle({ tgId: '777', chatId: -100555, isGroup: true, api: mockApi, sm, query: { id: 'q_jp', message: { message_id: 901 } } }, jpDecoded.action, jpDecoded.args);
  assert.match(JSON.stringify(sentRich.at(-1).rich), /JUMP TO PAGE/);

  await sm.handleMessage('777', { text: '2', chat: { id: -100555, type: 'supergroup' }, message_id: 950 }, { chatId: -100555, isGroup: true, api: mockApi });
  assert.match(JSON.stringify(sentRich.at(-1).rich), /Page 2\/3/);

  // 5. Categories menu handles paginated { items, total, totalPages } from AdultCatalog without TypeError
  const catDecoded = decodeCallback(catBtn.callback_data);
  await nsfw.handle({ tgId: '777', chatId: -100555, isGroup: true, api: mockApi, sm, query: { id: 'q_cat', message: { message_id: 901 } } }, catDecoded.action, catDecoded.args);
  const catCard0 = JSON.stringify(sentRich.at(-1).rich);
  assert.match(catCard0, /CINEMA CATEGORIES/);
  assert.match(catCard0, /Page 1\/\d+/);
  await nsfw.handle({ tgId: '777', chatId: -100555, isGroup: true, api: mockApi, sm, query: { id: 'q_cat2', message: { message_id: 901 } } }, 'acCatMenu', ['all', '1']);
  assert.match(JSON.stringify(sentRich.at(-1).rich), /Page 2\/\d+/);
});

test('CinemaVcAnnouncer: never broadcasts 18+ adult VC streams to bot users DMs', async () => {
  const dmCalls = [];
  const fakeBus = { on: () => {} };
  const announcer = new CinemaVcAnnouncer({
    app: {
      bus: fakeBus,
      telegram: {
        api: {
          sendRichMessage: async (chatId, rich) => {
            dmCalls.push({ chatId, rich });
            return { message_id: 1 };
          }
        }
      }
    },
    db: { all: () => [{ tg_id: 111 }, { tg_id: 222 }] },
    queueManager: { on: () => {} }
  });

  const res = await announcer.onTrackStart(-100999, {
    id: 'xv_1',
    title: '18+ Private Stream',
    mediaType: 'video',
    isAdult: true
  });
  assert.equal(res, null);
  assert.equal(dmCalls.length, 0, '18+ adult tracks must never be announced to all bot users');
});

test('Unlimited QueueManager: supports >250 items without 100-item cap and coalesces snapshot writes', async () => {
  let snapshotWrites = 0;
  const mockDb = {
    setSetting: () => {
      snapshotWrites += 1;
    },
    getSetting: () => null
  };
  const qm = new QueueManager({
    voiceClient: { stop: async () => {}, play: async () => ({ durationSeconds: 180 }) },
    library: { ensureTrack: async (t) => t },
    db: mockDb
  });

  const bigBatch = Array.from({ length: 260 }, (_, i) => ({
    id: `song_${i + 1}`,
    title: `Unlimited Track #${i + 1}`,
    artist: 'Lancy DJ',
    durationSeconds: 180
  }));

  const s = qm.getSession(-100777);
  s.currentTrack = bigBatch[0];
  s.status = 'playing';

  const res = await qm.addMany(-100777, bigBatch.slice(1), { playNow: false });
  assert.equal(res.length, 259);
  assert.equal(s.upcoming.length, 259, 'Queue must hold all 259 upcoming items without 100-item truncation');
  assert.equal(snapshotWrites, 1, 'addMany should write playback snapshot once for the entire batch');
});

test('CommandJobProcessor & TelegramAPI: coalesces duplicate GC command bursts, supersedes stale callbacks, and deduplicates sendChatAction', async () => {
  const proc = new CommandJobProcessor({ coalesceWindowMs: 5000 });
  let executions = 0;

  // Fire 5 identical /xvideos trending commands concurrently in the same group chat
  const burst = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      proc.runCommand(
        { chatId: -100888, tgId: String(100 + i), command: '/xvideos', query: 'trending', isGroup: true },
        async () => {
          executions += 1;
          await new Promise(r => setTimeout(r, 40));
          return { ok: true, executions };
        }
      )
    )
  );

  assert.equal(executions, 1, '5 identical concurrent GC commands should coalesce into 1 execution');
  assert.equal(burst.filter(b => b.coalesced).length, 4);

  // Per-card callback superseding
  const signals = [];
  await proc.runCallback({ chatId: -100888, tgId: '101', messageId: 55, screen: 'nsfw', action: 'acPg', args: ['s1', '1'] }, async (sig) => {
    signals.push(sig);
    await new Promise(r => setTimeout(r, 60));
  });
  // Fire two overlapping callbacks on the same card
  const p1 = proc.runCallback({ chatId: -100888, tgId: '101', messageId: 55, screen: 'nsfw', action: 'acPg', args: ['s1', '2'] }, async (sig) => {
    signals.push(sig);
    await new Promise(r => setTimeout(r, 60));
  });
  const p2 = proc.runCallback({ chatId: -100888, tgId: '101', messageId: 55, screen: 'nsfw', action: 'acPg', args: ['s1', '3'] }, async (sig) => {
    signals.push(sig);
    await new Promise(r => setTimeout(r, 10));
  });
  await Promise.all([p1, p2]);
  assert.equal(signals[1].aborted, true, 'Older in-flight pagination callback on the same card must be aborted when superseded');
  assert.equal(signals[2].aborted, false);

  // TelegramAPI sendChatAction per-chat deduplication
  const api = new TelegramAPI('123456:TEST_TOKEN');
  let rawCalls = 0;
  api.call = async () => {
    rawCalls += 1;
    return true;
  };
  await api.sendChatAction(-100888, 'typing');
  await api.sendChatAction(-100888, 'typing');
  await api.sendChatAction(-100888, 'upload_video');
  assert.equal(rawCalls, 1, 'sendChatAction within 4s window on the same chat must be coalesced into 1 API call');
});
