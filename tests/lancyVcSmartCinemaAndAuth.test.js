import test from 'node:test';
import assert from 'node:assert/strict';

import { LancyAgent } from '../src/ai/lancyAgent.js';
import { LancyToolExecutor } from '../src/ai/lancyTools.js';
import { parseDeskIntents } from '../src/ai/deskNlu.js';

test('VC AI strictly limits replies to Owner or VC-Sudo users (ignores plain group admins and viewers silently)', async () => {
  const spoken = [];
  const vcMsgs = [];
  let tgAdminCalls = 0;

  const session = {
    chatId: -100888,
    connected: true,
    status: 'playing',
    activeDeck: 'movie',
    volume: 90,
    upcoming: [],
    movieUpcoming: [],
    currentTrack: { title: 'The Batman', provider: 'movie', durationSeconds: 5400 }
  };

  const fakeApp = {
    db: { getSetting: () => null, setSetting: () => {} },
    voiceClient: {
      speak: async (_id, text) => { spoken.push(text); return { ok: true }; },
      sendCallMessage: async (_id, text) => { vcMsgs.push(text); return { ok: true }; },
      setListenState: async () => ({ ok: true })
    },
    telegram: {
      botInfo: { id: 10, username: 'pappy_agent', first_name: 'Lancy' },
      api: {
        getChatAdministrators: async () => {
          tgAdminCalls++;
          return [{ user: { id: 5555 } }]; // plain group admin who is NOT VC sudo
        },
        sendMessage: async () => ({})
      }
    },
    music: {
      owner: (ctx) => Number(ctx.tgId) === 1111,
      superAdmin: () => false,
      isVcSudo: (ctx) => Number(ctx.tgId) === 2222
    },
    musicQueueManager: {
      sessions: new Map([[-100888, session]]),
      getSession: () => session,
      pause: async () => { session.status = 'paused'; return true; },
      resume: async () => { session.status = 'playing'; return true; }
    }
  };

  const agent = new LancyAgent({ app: fakeApp });

  // Plain group admin (even with fromAdmin: true in caller flag!) MUST be ignored silently
  const plainAdminVoice = await agent.handleVcTurn({
    chatId: -100888,
    userId: 5555,
    fromAdmin: true,
    text: 'Lancy listen',
    source: 'vc_voice',
    isWake: true,
    isListenCommand: true
  });
  assert.equal(plainAdminVoice.blocked, true);
  assert.equal(plainAdminVoice.handled, false);
  assert.equal(spoken.length, 0, 'must NOT reply to plain admin on voice');
  assert.equal(vcMsgs.length, 0, 'must NOT post VC message to plain admin');
  assert.equal(tgAdminCalls, 0, 'must NOT bypass via getChatAdministrators');

  // Plain group admin in VC text MUST be ignored silently too
  const plainAdminText = await agent.handleVcTurn({
    chatId: -100888,
    userId: 5555,
    fromAdmin: true,
    text: 'Lancy pause the movie',
    source: 'vc_message'
  });
  assert.equal(plainAdminText.blocked, true);
  assert.equal(plainAdminText.handled, false);
  assert.equal(vcMsgs.length, 0);

  // VC Sudo user IS allowed
  const sudoRes = await agent.handleVcTurn({
    chatId: -100888,
    userId: 2222,
    senderName: 'SudoBro',
    text: 'Lancy listen',
    source: 'vc_voice',
    isWake: true,
    isListenCommand: true
  });
  assert.equal(sudoRes.handled, true);
  assert.equal(sudoRes.mode, 'LISTENING');
  assert.equal(session.status, 'paused');
  assert.equal(spoken.length, 1);
});

test('LancyToolExecutor search_videos searches, posts numbered card to GC, plays #2, and get_call_state exposes full awareness', async () => {
  const sentRich = [];
  const played = [];
  const session = {
    chatId: -100999,
    connected: true,
    status: 'playing',
    activeDeck: 'movie',
    vcQuality: 'FHD_1080p',
    volume: 85,
    positionSeconds: 125,
    subtitleMode: 'screen',
    upcoming: [],
    movieUpcoming: [{ entryId: 'u1', title: 'Severance', mediaKind: 'tv', tmdbId: 95396, id: 95396 }],
    lastVideoSearch: null,
    currentTrack: {
      id: 70523,
      tmdbId: 70523,
      seriesTitle: 'Dark',
      title: 'Dark S01E01',
      provider: 'movie',
      mediaKind: 'tv',
      seasonNumber: 1,
      episodeNumber: 1,
      durationSeconds: 3200,
      audioLanguage: 'de'
    },
    api: {
      sendRichMessage: async (cid, payload) => {
        sentRich.push({ cid, payload });
        return { message_id: 91 };
      }
    }
  };

  const fakeApp = {
    telegram: { botInfo: { id: 1, username: 'pappy_agent', first_name: 'Lancy' }, api: session.api },
    cloneManager: { getActiveCount: () => 2 },
    musicQueueManager: {
      sessions: new Map([[-100999, session]]),
      getSession: () => session,
      playImmediateAndContinue: async (_cid, track) => { played.push(track); }
    }
  };

  const exec = new LancyToolExecutor({ app: fakeApp });

  // Seed lastVideoSearch directly or simulate follow-up pick #2 + test send_to_chat + get_call_state awareness
  session.lastVideoSearch = {
    query: 'burna boy live',
    timestamp: Date.now(),
    results: [
      { index: 1, videoId: 'dQw4w9WgXcQ', title: 'Burna Boy Live Paris', author: 'Burna Boy', duration: '12:30', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
      { index: 2, videoId: 'abcdefghijk', title: 'Burna Boy City Boys Live', author: 'Tiny Desk', duration: '06:15', url: 'https://www.youtube.com/watch?v=abcdefghijk' }
    ]
  };

  const playVid = await exec.execute('search_videos', { action: 'play_now', result_index: 2 }, { chatId: -100999, senderName: 'Owner' });
  assert.equal(playVid.ok, true);
  assert.equal(playVid.index, 2);
  assert.equal(playVid.title, 'Burna Boy City Boys Live');
  assert.equal(played.length, 1);
  assert.equal(played[0].mediaType, 'video');

  const sendVid = await exec.execute('search_videos', { action: 'send_to_chat', result_index: 1 }, { chatId: -100999 });
  assert.equal(sendVid.ok, true);
  assert.equal(sendVid.sent, true);
  assert.equal(sentRich.length, 1);

  const state = await exec.execute('get_call_state', {}, { chatId: -100999 });
  assert.equal(state.ok, true);
  assert.equal(state.bot.username, 'pappy_agent');
  assert.equal(state.bot.clonesCount, 2);
  assert.equal(state.nowPlaying.seasonNumber, 1);
  assert.equal(state.nowPlaying.episodeNumber, 1);
  assert.equal(state.quality, 'FHD_1080p');
  assert.equal(state.upNextItems[0].title, 'Severance');
  assert.equal(state.lastVideoSearch.results.length, 2);
});

test('search_movies_series syncs numbered results with TV seasons/episodes to GC and loads unqueued season/episode on current, up_next, or #N', async () => {
  const uiOpened = [];
  const resolvedDescs = [];
  const queuedMovies = [];

  const session = {
    chatId: -100666,
    connected: true,
    status: 'playing',
    activeDeck: 'movie',
    upcoming: [],
    movieUpcoming: [
      { entryId: 'nx1', id: 95396, tmdbId: 95396, title: 'Severance', seriesTitle: 'Severance', mediaKind: 'tv', seasonNumber: 1, episodeNumber: 1 }
    ],
    currentTrack: {
      id: 1396,
      tmdbId: 1396,
      title: 'Breaking Bad S01E01',
      seriesTitle: 'Breaking Bad',
      provider: 'movie',
      mediaKind: 'tv',
      seasonNumber: 1,
      episodeNumber: 1
    },
    api: { sendMessage: async () => ({}), sendRichMessage: async () => ({}) }
  };

  const fakeApp = {
    screens: new Map([
      ['music', {
        movieUi: {
          openMovieSearch: async (ctx, q, opts) => {
            uiOpened.push({ chatId: ctx.chatId, q, preloadedResults: opts?.preloadedResults });
          }
        }
      }]
    ]),
    movieApi: {
      search: async (q) => ({
        results: [
          { id: 70523, title: 'Dark', year: 2017, type: 'tv', overview: 'Time travel mystery' },
          { id: 66732, title: 'Stranger Things', year: 2016, type: 'tv', overview: 'Upside down' }
        ],
        query: q
      }),
      getTvSeasons: async (id) => id === 70523
        ? {
            seriesId: 70523,
            title: 'Dark',
            totalSeasons: 3,
            totalEpisodes: 26,
            seasons: [
              { seasonNumber: 1, name: 'Season 1', episodeCount: 10 },
              { seasonNumber: 2, name: 'Season 2', episodeCount: 8 },
              { seasonNumber: 3, name: 'Season 3', episodeCount: 8 }
            ]
          }
        : {
            seriesId: 66732,
            title: 'Stranger Things',
            totalSeasons: 4,
            totalEpisodes: 34,
            seasons: [
              { seasonNumber: 1, name: 'Season 1', episodeCount: 8 },
              { seasonNumber: 2, name: 'Season 2', episodeCount: 9 }
            ]
          }
    },
    movieResolver: {
      resolve: async (desc) => {
        resolvedDescs.push(desc);
        return {
          track: {
            id: desc.id,
            tmdbId: desc.tmdbId,
            title: `${desc.title} S${String(desc.season || 1).padStart(2, '0')}E${String(desc.episode || 1).padStart(2, '0')}`,
            seriesTitle: desc.title,
            seasonNumber: desc.season || 1,
            episodeNumber: desc.episode || 1,
            provider: 'movie',
            mediaKind: desc.type
          }
        };
      }
    },
    musicQueueManager: {
      sessions: new Map([[-100666, session]]),
      getSession: () => session,
      addMovies: async (_cid, tracks, opts) => { queuedMovies.push({ tracks, opts }); }
    }
  };

  const exec = new LancyToolExecutor({ app: fakeApp });

  // 1. Search reads res.results, enriches seasons/episodes, and posts numbered results to GC UI
  const searchRes = await exec.execute('search_movies_series', { query: 'Dark', action: 'search' }, { chatId: -100666 });
  assert.equal(searchRes.ok, true);
  assert.equal(searchRes.postedToChat, true);
  assert.equal(searchRes.results[0].index, 1);
  assert.match(searchRes.results[0].seasonsBreakdown, /3 seasons/);
  assert.equal(uiOpened.length, 1);
  assert.equal(uiOpened[0].preloadedResults.length, 2);

  // 2. Inspect #2 Stranger Things
  const inspectRes = await exec.execute('search_movies_series', { action: 'inspect', result_index: 2 }, { chatId: -100666 });
  assert.equal(inspectRes.ok, true);
  assert.equal(inspectRes.selected.title, 'Stranger Things');
  assert.equal(inspectRes.selected.totalSeasons, 4);

  // 3. Play result #1 Season 3 Episode 4 directly
  const pickEpRes = await exec.execute('search_movies_series', {
    action: 'play_now',
    target_scope: 'search_result',
    result_index: 1,
    season: 3,
    episode: 4
  }, { chatId: -100666 });
  assert.equal(pickEpRes.ok, true);
  assert.equal(pickEpRes.season, 3);
  assert.equal(pickEpRes.episode, 4);
  assert.equal(resolvedDescs.at(-1).title, 'Dark');
  assert.equal(resolvedDescs.at(-1).season, 3);
  assert.equal(resolvedDescs.at(-1).episode, 4);

  // 4. Load Season 2 Episode 3 of current playing Breaking Bad (not in queue)
  const curEpRes = await exec.execute('search_movies_series', {
    action: 'play_now',
    target_scope: 'current',
    season: 2,
    episode: 3
  }, { chatId: -100666 });
  assert.equal(curEpRes.ok, true);
  assert.equal(resolvedDescs.at(-1).title, 'Breaking Bad');
  assert.equal(resolvedDescs.at(-1).season, 2);
  assert.equal(resolvedDescs.at(-1).episode, 3);

  // 5. Load Episode 5 of up_next Severance directly
  const nextEpRes = await exec.execute('search_movies_series', {
    action: 'play_now',
    target_scope: 'up_next',
    season: 2,
    episode: 5
  }, { chatId: -100666 });
  assert.equal(nextEpRes.ok, true);
  assert.equal(resolvedDescs.at(-1).title, 'Severance');
  assert.equal(resolvedDescs.at(-1).episode, 5);
  assert.equal(queuedMovies.length, 3);
});

test('deskNlu parses video search, #N movie season/episode, and current/next episode commands deterministically', () => {
  const v1 = parseDeskIntents('search videos of Burna Boy live');
  assert.equal(v1?.[0]?.name, 'search_videos');
  assert.equal(v1?.[0]?.args?.action, 'search');

  const v2 = parseDeskIntents('play video #2');
  assert.equal(v2?.[0]?.name, 'search_videos');
  assert.equal(v2?.[0]?.args?.action, 'play_now');
  assert.equal(v2?.[0]?.args?.result_index, 2);

  const m1 = parseDeskIntents('play #1 season 3 episode 4');
  assert.equal(m1?.[0]?.name, 'search_movies_series');
  assert.equal(m1?.[0]?.args?.target_scope, 'search_result');
  assert.equal(m1?.[0]?.args?.result_index, 1);
  assert.equal(m1?.[0]?.args?.season, 3);
  assert.equal(m1?.[0]?.args?.episode, 4);

  const m2 = parseDeskIntents('play episode 3 of this movie');
  assert.equal(m2?.[0]?.name, 'search_movies_series');
  assert.equal(m2?.[0]?.args?.target_scope, 'current');
  assert.equal(m2?.[0]?.args?.episode, 3);
});

test('Gemini Live tool declarations align with LancyToolExecutor across all 5 normalized adapters', async () => {
  const calls = { volumes: [], seeks: [], polls: [], promoted: 0, langs: 0, subMode: [] };
  const track = {
    id: 'm1',
    title: 'Inception',
    durationSeconds: 1000,
    subtitleTracks: [{ language: 'Spanish', label: 'Spanish', filePath: '/tmp/es.srt' }]
  };
  const session = {
    activeDeck: 'movie',
    volume: 100,
    positionSeconds: 100,
    currentTrack: track,
    upcoming: [{ entryId: 'u1', title: 'Track A' }, { entryId: 'u2', title: 'Track B' }],
    movieUpcoming: []
  };
  const exec = new LancyToolExecutor({
    app: {
      musicQueueManager: {
        sessions: new Map([[-100888, session]]),
        getSession: () => session,
        setVolume: async (_c, v) => { session.volume = v; calls.volumes.push(v); },
        seek: async (_c, s) => { calls.seeks.push(s); },
        promoteTrack: () => { calls.promoted += 1; },
        getAudioVariants: () => [{ audioLanguage: 'en', label: 'Original', audioIsDub: false }],
        switchAudioLanguage: async () => { calls.langs += 1; return { ok: true }; },
        setSubtitleMode: async (_c, m) => { calls.subMode.push(m); return m; },
        cycleSubtitleTrack: async () => ({ ok: true })
      },
      telegram: {
        api: {
          sendPoll: async (_cid, q, opts) => {
            calls.polls.push({ q, opts });
            return { poll: { id: 'p1' }, message_id: 42 };
          }
        }
      }
    }
  });

  const vUp = await exec.execute('adjust_volume', { mode: 'up', value: 20 }, { chatId: -100888 });
  assert.equal(vUp.volume, 120);
  const vDown = await exec.execute('adjust_volume', { mode: 'down', value: 35 }, { chatId: -100888 });
  assert.equal(vDown.volume, 85);

  const sRel = await exec.execute('seek_playback', { seconds: 30, relative: true }, { chatId: -100888 });
  assert.equal(sRel.seekSeconds, 130);
  const sRelInt = await exec.execute('seek_playback', { relative: 30 }, { chatId: -100888 });
  assert.equal(sRelInt.seekSeconds, 130);
  const sRelNeg = await exec.execute('seek_playback', { relative: -15 }, { chatId: -100888 });
  assert.equal(sRelNeg.seekSeconds, 85);
  const sFrac = await exec.execute('seek_playback', { fraction: 0.5 }, { chatId: -100888 });
  assert.equal(sFrac.seekSeconds, 500);

  const qTop = await exec.execute('manage_queue', { action: 'move_to_top', index: 2, deck: 'music' }, { chatId: -100888 });
  assert.equal(qTop.action, 'promote');
  assert.equal(calls.promoted, 1);

  const tAudio = await exec.execute('tune_cinema_stream', { audioLanguage: 'original' }, { chatId: -100888 });
  assert.equal(tAudio.ok, true);
  assert.equal(calls.langs, 1);
  const tSub = await exec.execute('tune_cinema_stream', { subtitles: 'vc' }, { chatId: -100888 });
  assert.equal(tSub.subtitleMode, 'vc');

  const poll = await exec.execute('create_group_poll', { question: 'Next movie?', options: ['Matrix', 'Dune'] }, { chatId: -100888 });
  assert.equal(poll.ok, true);
  assert.equal(calls.polls.length, 1);
});
