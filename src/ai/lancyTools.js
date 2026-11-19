/**
 * Unified A–Z project tool registry and executor for Lancy Conversational AI.
 * Exposes structured JSON-schema tools compatible with Ollama (`qwen2.5:3b`) and
 * OpenAI-compatible function calling across Voice Chat audio, Interactive VC text,
 * Group/Bot AI commands, and DM chat.
 */
import { audioUpload } from '../music/preview.js';
import { extractSeasonEpisodeHint } from '../media/movieQueryParser.js';
import { searchYouTubeFast } from '../media/youtubeSearch.js';
import { normalizeTrack } from '../music/model.js';
import { RichMessageBuilder, rt, richButton } from '../telegram/rich.js';
import { WebBrowser } from './browse.js';
import { lookupCurrentMediaAndStories, lookupOpenLibraryStories } from './mediaKnowledge.js';

function safeClip(str = '', max = 140) {
  const s = String(str || '');
  const clean = typeof s.toWellFormed === 'function' ? s.toWellFormed() : s;
  return [...clean].slice(0, max).join('').trim();
}

export const LANCY_TOOLS_SCHEMA = [
  {
    type: 'function',
    function: {
      name: 'get_call_state',
      description: 'Inspect live bot identity and Voice Chat state: bot username/clones, active movie/series season & episode, audio/subtitles, position/duration, numbered queue, and recent GC movie or video search results.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'control_playback',
      description: 'Control active VC media playback: pause, resume, skip, previous, stop, leave, cycle/set loop mode, shuffle queue, vote skip, switch music/movie deck, or refresh/pin player dashboard.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['pause', 'resume', 'skip', 'previous', 'stop', 'leave', 'toggle_loop', 'set_loop', 'shuffle', 'switch_deck', 'vote_skip', 'refresh_player', 'pin_player', 'hide_guide', 'show_guide']
          },
          loop_mode: { type: 'string', enum: ['off', 'track', 'queue'], description: 'Used when action=set_loop' },
          deck: { type: 'string', enum: ['music', 'movie'], description: 'Used when action=switch_deck' }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'adjust_volume',
      description: 'Adjust Voice Chat volume (0-200), raise or lower it relatively, or mute/unmute without losing previous volume.',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['set', 'lower', 'louder', 'mute', 'unmute'] },
          value: { type: 'number', description: 'Exact volume 0-200 (for set) or step amount like 20 (for lower/louder).' }
        },
        required: ['mode']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'seek_playback',
      description: 'Jump/seek the current movie, video, or track to an exact time (1:15:00), relative offset (+30s, -1m), percentage (50%), or named position ("middle", "quarter", "three_quarters", "start", "near_end").',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Position such as "middle", "50%", "+30s", "-45s", "42:10", or seconds.' }
        },
        required: ['target']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manage_queue',
      description: 'View or edit the upcoming queue by index or title substring, clear queue, or save/load/list playlists.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'jump', 'promote', 'remove', 'clear', 'playlist_save', 'playlist_load', 'playlist_list'] },
          index: { type: 'number', description: '1-based item index for jump/promote/remove.' },
          query: { type: 'string', description: 'Title keyword for queue item lookup or playlist name.' },
          deck: { type: 'string', enum: ['music', 'movie'] }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_movies_series',
      description: 'Search movies or TV series, inspect season/episode counts of numbered GC results, or load & play/queue any movie or specific season/episode (including on the current playing show, upcoming queue item, or numbered search result #N) without requiring pre-queuing.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Movie or TV show title or keywords (optional when targeting result_index, current, or up_next).' },
          action: { type: 'string', enum: ['search', 'play_now', 'queue', 'inspect', 'trending', 'random'] },
          media_type: { type: 'string', enum: ['multi', 'movie', 'tv'] },
          season: { type: 'number', description: 'Optional TV season number.' },
          episode: { type: 'number', description: 'Optional TV episode number.' },
          result_index: { type: 'number', description: 'Optional 1-based result index (#1, #2, ...) from the recent GC movie search.' },
          target_scope: { type: 'string', enum: ['search_result', 'current', 'up_next'], description: 'Target an already-searched result #N, the currently playing series, or the up-next queued title.' }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_videos',
      description: 'Search YouTube/web videos, post a numbered video list to Group Chat, or play/queue/send a video result (#1, #2, etc.) into Voice Chat or chat.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Video search query or topic (optional when picking result_index from recent search).' },
          action: { type: 'string', enum: ['search', 'play_now', 'queue', 'send_to_chat'] },
          result_index: { type: 'number', description: 'Optional 1-based result index (#1, #2, ...) from the recent video search.' }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_and_play_music',
      description: 'Search songs or artists, play or queue tracks, or ask Spotify-style AI DJ for remixes, artist rotations, or vibes.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Song title, artist(s), remix request, or vibe description.' },
          action: { type: 'string', enum: ['play_now', 'queue', 'search', 'ai_dj'] }
        },
        required: ['query', 'action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'tune_cinema_stream',
      description: 'Change audio language, subtitle mode/track/offset/auto-align, video quality (1080p/720p/480p), dual subtitle tile, alternate source, or switch RTMP vs Interactive mode.',
      parameters: {
        type: 'object',
        properties: {
          setting: { type: 'string', enum: ['audio_language', 'subtitle_mode', 'subtitle_track', 'subtitle_offset', 'auto_sync_subtitles', 'dual_subtitle_tile', 'switch_source', 'stream_mode', 'quality'] },
          value: { type: 'string', description: 'Target value such as "en", "screen", "off", "+1.5", "1080p", "720p", "480p", "interactive", "rtmp", "on", "off".' }
        },
        required: ['setting']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ai_dj_control',
      description: 'Control Visual DJ Desk, lyrics overlay, EQ preset (studio, bass, vocal, off), crossfade, or skip to the next DJ mix chapter.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['next_chapter', 'visual_on', 'visual_off', 'lyrics_on', 'lyrics_off', 'eq', 'crossfade'] },
          value: { type: 'string', description: 'EQ preset name or crossfade seconds.' }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'send_current_video_to_chat',
      description: 'Download/upload the currently playing movie, TV episode, video, or song directly into the Telegram chat so members can keep or watch it.',
      parameters: {
        type: 'object',
        properties: {
          quality: { type: 'string', enum: ['360p', '480p', '720p', '1080p'], description: 'Preferred video quality when sending video (default 480p for fast Telegram upload).' },
          query: { type: 'string', description: 'Optional specific movie/video title if user asked to send another title instead of current.' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'download_url_or_images',
      description: 'Download media from a direct URL into chat or search aesthetic images/Pinterest slides.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['download_url', 'search_images'] },
          target: { type: 'string', description: 'URL or image search query.' }
        },
        required: ['kind', 'target']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_decision_poll',
      description: 'Send an interactive Telegram vote poll in the chat when choosing between songs, artists, vibes, or movies — keeps conversation open.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'Short engaging poll question.' },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: '2 to 8 clear vote options.'
          },
          is_anonymous: { type: 'boolean', description: 'Default false so group members can see votes.' }
        },
        required: ['question', 'options']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_research',
      description: 'Search the live web, current music/videos/movies, or Wikipedia for up-to-date facts, releases, artists, film plots, news, or documentation.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query or topic to look up.' },
          mode: { type: 'string', enum: ['search', 'fetch'], description: 'search (live web + media + Wikipedia) or fetch (read specific URL).' },
          url: { type: 'string', description: 'Optional webpage URL when mode is fetch.' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'tell_story_or_novel',
      description: 'Look up real books, dark romance novels, thrillers, folklore, legends, or fiction synopses via OpenLibrary + Wikipedia so you can tell rich long-form stories aloud or in chat.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Book/novel/story title, trope, author, or theme (e.g. "Haunting Adeline", "dark romance mafia", "African folklore").' },
          genre: { type: 'string', description: 'Optional genre: dark_romance, romance, thriller, horror, fantasy, mystery, folklore, scifi.' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ask_clarification',
      description: 'Use when user speech/text is unclear, ambiguous, or missing required information instead of guessing an action.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'Short friendly question asking what the user meant.' }
        },
        required: ['question']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'finish_conversation',
      description: 'End the active listening / follow-up session when user confirms they are done ("yeah", "that is all", "carry on").',
      parameters: {
        type: 'object',
        properties: {
          resume_playback: { type: 'boolean', description: 'True to resume paused media playback cleanly.' },
          closing_line: { type: 'string', description: 'Brief friendly closing remark.' }
        },
        required: ['resume_playback']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_start_task',
      description: 'Operate real BrowserOS Chromium autonomously for any website workflow, login-assisted flow, form, search, download, or live screen share.',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'Clear description of the website task or navigation goal.' },
          url: { type: 'string', description: 'Optional starting URL (e.g. "https://github.com").' },
          show_live: { type: 'boolean', description: 'True to also show live BrowserOS screen video in the active Voice Chat.' }
        },
        required: ['goal']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_task_status',
      description: 'Get the current BrowserOS task status, active domain/URL, step progress, and pending approvals.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Optional task ID; omits for active task in this chat.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_list_tabs',
      description: 'List open tabs in the scoped BrowserOS session.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_pause_task',
      description: 'Pause the active autonomous BrowserOS task without closing its tabs.',
      parameters: { type: 'object', properties: { task_id: { type: 'string' } } }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_resume_task',
      description: 'Resume a paused or human-takeover BrowserOS task after user login/verification.',
      parameters: { type: 'object', properties: { task_id: { type: 'string' } } }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_stop_task',
      description: 'Stop the active autonomous BrowserOS task immediately.',
      parameters: { type: 'object', properties: { task_id: { type: 'string' } } }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_request_human_help',
      description: 'Pause BrowserOS automation safely and ask the human user to handle login, OTP, 2FA, CAPTCHA, or sensitive approval.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Short explanation of what the human needs to complete.' },
          task_id: { type: 'string' }
        },
        required: ['reason']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_show_live',
      description: 'Stream the real BrowserOS browser screen live inside the Telegram Voice Chat (auto-leases and pauses media cleanly).',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Optional URL to open if no browser task is open yet.' },
          task_id: { type: 'string' },
          quality: { type: 'string', enum: ['low', 'high'] }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_hide_live',
      description: 'Hide the live BrowserOS screen share from Telegram Voice Chat and smoothly restore any paused music/movie track.',
      parameters: {
        type: 'object',
        properties: {
          resume_media: { type: 'boolean', description: 'True to restore previously paused music/movie stream (default true).' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_replay_task',
      description: 'Inspect the step-by-step audit and replay timeline of a BrowserOS task.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Optional task ID; omits for latest task.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_interact_live',
      description: 'Perform a quick conversational action on the live visible browser page ("click the second result", "scroll down", "go back", "read this page", "open example.com").',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Exact natural browser command or navigation instruction.' }
        },
        required: ['command']
      }
    }
  }
];

function fmtClock(sec) {
  const n = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function resolveSeekTargetSeconds(targetRaw, currentPos = 0, duration = 0) {
  const raw = String(targetRaw ?? '').trim().toLowerCase();
  const dur = Math.max(0, Number(duration) || 0);
  const cur = Math.max(0, Number(currentPos) || 0);
  if (!raw) return { error: 'missing_target' };

  if (/\b(?:middle|halfway|center|half)\b/.test(raw)) {
    if (dur <= 2) return { error: 'unknown_duration' };
    return { seconds: Math.max(0, Math.min(dur - 2, Math.floor(dur * 0.5))), label: 'middle (50%)' };
  }
  if (/\b(?:quarter|25%)\b/.test(raw) && !/three/.test(raw)) {
    if (dur <= 2) return { error: 'unknown_duration' };
    return { seconds: Math.max(0, Math.min(dur - 2, Math.floor(dur * 0.25))), label: '25%' };
  }
  if (/\b(?:three\s*quarters?|75%)\b/.test(raw)) {
    if (dur <= 2) return { error: 'unknown_duration' };
    return { seconds: Math.max(0, Math.min(dur - 2, Math.floor(dur * 0.75))), label: '75%' };
  }
  if (/\b(?:start|beginning|restart|zero)\b/.test(raw)) {
    return { seconds: 0, label: 'start' };
  }
  if (/\b(?:near\s*end|end|ending|climax|90%)\b/.test(raw)) {
    if (dur <= 2) return { error: 'unknown_duration' };
    return { seconds: Math.max(0, Math.floor(dur * 0.9)), label: 'near the end' };
  }

  const pctMatch = raw.match(/^(\d{1,3}(?:\.\d+)?)\s*%$/);
  if (pctMatch) {
    if (dur <= 2) return { error: 'unknown_duration' };
    const pct = Math.max(0, Math.min(99, Number(pctMatch[1])));
    return { seconds: Math.floor((dur * pct) / 100), label: `${pct}%` };
  }

  // Relative offset: "+30s", "-2m", "forward 15 seconds", "back 1 minute"
  const relSign = /^(?:-|back|rewind|backward)/.test(raw) ? -1 : (/^(?:\+|forward|ahead|skip)/.test(raw) ? 1 : 0);
  const body = raw.replace(/^(?:[+-]|back(?:ward)?|rewind|forward|ahead|skip)\s*/i, '').trim();

  if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(body)) {
    const parts = body.split(':').map(Number);
    const sec = parts.length === 3 ? (parts[0] * 3600 + parts[1] * 60 + parts[2]) : (parts[0] * 60 + parts[1]);
    const target = relSign !== 0 ? Math.max(0, cur + relSign * sec) : sec;
    return { seconds: dur > 2 ? Math.min(dur - 2, target) : target, label: fmtClock(target) };
  }

  let unitSec = 0;
  const hM = body.match(/(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?/i);
  const mM = body.match(/(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?/i);
  const sM = body.match(/(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?/i);
  if (hM || mM || sM) {
    unitSec = (hM ? Number(hM[1]) * 3600 : 0) + (mM ? Number(mM[1]) * 60 : 0) + (sM ? Number(sM[1]) : 0);
  } else if (/^\d+(?:\.\d+)?$/.test(body)) {
    unitSec = Number(body);
  } else {
    return { error: 'unparsed_target' };
  }

  const target = relSign !== 0 ? Math.max(0, cur + relSign * Math.round(unitSec)) : Math.round(unitSec);
  const clamped = dur > 2 ? Math.min(dur - 2, target) : target;
  return { seconds: clamped, label: fmtClock(clamped) };
}

export class LancyToolExecutor {
  constructor({ app }) {
    this.app = app;
    this.browser = new WebBrowser();
  }

  #qm() { return this.app?.musicQueueManager || null; }
  #music() { return this.app?.music || null; }
  #movieUi() { return this.app?.screens?.get?.('music')?.movieUi || this.app?.screens?.get?.('movieUi') || null; }
  #session(chatId) {
    const qm = this.#qm();
    const id = Number(chatId);
    if (!qm || !Number.isSafeInteger(id) || !id) return null;
    return qm.sessions?.get?.(id) || qm.getSession?.(id) || null;
  }

  #buildGcCtx(chatId, s, context = {}) {
    const cid = Number(context.telegramChatId || chatId || 0);
    const api = context.ctx?.api || s?.api || this.app?.telegram?.api || null;
    return {
      chatId: cid,
      chat: { id: cid },
      tgId: Number(context.userId || context.ctx?.tgId || cid || 0),
      user: context.user || context.ctx?.user || null,
      api,
      controller: context.ctx?.controller || this.app?.telegram?.controller || null,
      reuseMessageId: false
    };
  }

  #getStoredMovieSearch(chatId, s) {
    const ms = this.app?.movieSessions?.getLatestForChat?.(Number(chatId));
    if (Array.isArray(ms?.results) && ms.results.length) {
      return { query: ms.query || s?.lastMovieSearch?.query || '', results: ms.results, view: ms.view || null, mediaItem: ms.mediaItem || null };
    }
    if (Array.isArray(s?.lastMovieSearch?.results) && s.lastMovieSearch.results.length) {
      return s.lastMovieSearch;
    }
    return null;
  }

  async #enrichMovieResults(items = [], { limit = 5, fetchSeasons = true } = {}) {
    const movieApi = this.app?.movieApi;
    const sliced = (Array.isArray(items) ? items : []).slice(0, limit);
    const enriched = await Promise.all(sliced.map(async (raw, idx) => {
      const m = { ...raw, index: idx + 1 };
      const isTv = m.type === 'tv' || m.mediaType === 'tv';
      if (isTv && fetchSeasons && !m.seasonsBreakdown && m.id && typeof movieApi?.getTvSeasons === 'function') {
        const info = await movieApi.getTvSeasons(m.id).catch(() => null);
        if (info) {
          const seasonsArr = Array.isArray(info.seasons) ? info.seasons.filter((sn) => Number(sn?.seasonNumber) > 0) : [];
          m.totalSeasons = Number(info.totalSeasons || seasonsArr.length || 0);
          m.totalEpisodes = Number(info.totalEpisodes || seasonsArr.reduce((acc, sn) => acc + Number(sn?.episodeCount || 0), 0) || 0);
          m.seasons = seasonsArr.map((sn) => ({
            seasonNumber: Number(sn.seasonNumber),
            name: sn.name || `Season ${sn.seasonNumber}`,
            episodeCount: Number(sn.episodeCount || 0)
          }));
          if (m.totalSeasons > 0) {
            const perSeason = m.seasons.slice(0, 4).map((sn) => `S${sn.seasonNumber}:${sn.episodeCount}`).join(', ');
            m.seasonsBreakdown = `${m.totalSeasons} season${m.totalSeasons === 1 ? '' : 's'}${m.totalEpisodes ? ` · ${m.totalEpisodes} eps` : ''}${perSeason ? ` (${perSeason}${m.seasons.length > 4 ? ', …' : ''})` : ''}`;
          }
        }
      }
      return m;
    }));
    return enriched;
  }

  async #syncMovieSearchCard(gcCtx, chatId, s, query, enrichedItems) {
    if (s) {
      s.lastMovieSearch = {
        query: query || '',
        timestamp: Date.now(),
        results: enrichedItems
      };
    }
    const ms = this.app?.movieSessions?.getLatestForChat?.(Number(chatId));
    if (ms && enrichedItems?.length) {
      ms.results = enrichedItems;
      if (query) ms.query = query;
    }
    const movieUi = this.#movieUi();
    if (gcCtx?.api && typeof movieUi?.openMovieSearch === 'function') {
      await movieUi.openMovieSearch(gcCtx, query || enrichedItems[0]?.title || 'Results', {
        preloadedResults: enrichedItems,
        forceNewCard: true
      }).catch(() => {});
      return true;
    }
    return false;
  }

  async #postVideoSearchCard(gcCtx, query, videos = []) {
    const api = gcCtx?.api;
    if (!api || !gcCtx?.chatId || !videos.length) return false;
    const b = new RichMessageBuilder()
      .bannerHeader([`🎥 Video Results — ${safeClip(query, 44)}`, `${videos.length} numbered picks · Ask Lancy to play or queue #1–#${videos.length}`], { size: 2 });
    const lines = videos.map((v) =>
      `#${v.index} ${safeClip(v.title, 54)}${v.duration ? ` (${v.duration})` : ''}${v.author ? ` · ${safeClip(v.author, 28)}` : ''}`
    );
    b.list(lines);
    b.footer(rt.text('🎙️ Say "Lancy play video #2" or "send #1 to chat" anytime.'));
    const urlRow = videos.slice(0, 3).map((v) =>
      richButton.url(`▶ #${v.index}`, v.url, { style: v.index === 1 ? 'primary' : 'secondary' })
    );
    if (urlRow.length) b.buttons(urlRow);
    b.validate();
    const payload = b.toJSON({ useCustomEmojis: true });
    if (typeof api.sendRichMessage === 'function') {
      await api.sendRichMessage(gcCtx.chatId, payload, { textFallback: payload.plainText }).catch(() => {});
      return true;
    }
    if (typeof api.sendMessage === 'function') {
      await api.sendMessage(gcCtx.chatId, payload.html || payload.plainText, { parse_mode: 'HTML' }).catch(() => {});
      return true;
    }
    return false;
  }

  async execute(toolName, args = {}, context = {}) {
    const chatId = Number(context.chatId || 0);
    const qm = this.#qm();
    const s = chatId ? this.#session(chatId) : null;

    switch (toolName) {
      case 'get_call_state': {
        const botInfo = this.app?.telegram?.botInfo || null;
        const clonesMap = this.app?.cloneManager?.clones;
        const clonesCount = typeof this.app?.cloneManager?.getActiveCount === 'function'
          ? this.app.cloneManager.getActiveCount()
          : (clonesMap?.size ?? 0);
        if (!s) {
          return {
            ok: false,
            error: 'no_session',
            bot: {
              name: botInfo?.first_name || 'Lancy',
              username: botInfo?.username || this.app?.config?.telegram?.botUsername || null,
              clonesCount
            }
          };
        }
        const t = s.currentTrack;
        const deck = s.activeDeck || (t?.provider === 'movie' ? 'movie' : 'music');
        const q = deck === 'movie' ? (s.movieUpcoming || []) : (s.upcoming || []);
        const dur = Number(t?.durationSeconds || 0);
        const pos = Number(s.positionSeconds ?? s.lastKnownPositionSeconds ?? 0);
        const storedSearch = this.#getStoredMovieSearch(chatId, s);
        const movieSearchResults = (storedSearch?.results || []).slice(0, 6).map((m, idx) => ({
          index: Number(m.index || idx + 1),
          id: m.id,
          title: m.title,
          year: m.year || null,
          type: m.type || 'movie',
          totalSeasons: m.totalSeasons || null,
          totalEpisodes: m.totalEpisodes || null,
          seasonsBreakdown: m.seasonsBreakdown || null
        }));
        const videoSearchResults = (s.lastVideoSearch?.results || []).slice(0, 5).map((v, idx) => ({
          index: Number(v.index || idx + 1),
          videoId: v.videoId,
          title: v.title,
          author: v.author || null,
          duration: v.duration || null
        }));
        return {
          ok: true,
          status: s.status || 'idle',
          connected: Boolean(s.connected),
          deck,
          streamMode: s.streamMode || 'interactive',
          quality: s.vcQuality || t?.quality || null,
          volume: Number(s.volume ?? 100),
          muted: Boolean(s._mutedByLancy || Number(s.volume) === 0),
          loopMode: s.loopMode || 'off',
          subtitleMode: s.subtitleMode || 'screen',
          bot: {
            name: botInfo?.first_name || 'Lancy',
            username: botInfo?.username || this.app?.config?.telegram?.botUsername || null,
            clonesCount
          },
          nowPlaying: t ? {
            title: t.title,
            seriesTitle: t.seriesTitle || null,
            artist: t.artist || null,
            provider: t.provider || null,
            mediaKind: t.mediaKind || null,
            seasonNumber: t.seasonNumber ?? t.season ?? null,
            episodeNumber: t.episodeNumber ?? t.episode ?? null,
            episodeTitle: t.episodeTitle || null,
            sourceLabel: t.sourceLabel || t.providerLabel || null,
            positionSec: Math.floor(pos),
            positionClock: fmtClock(pos),
            durationSec: Math.floor(dur),
            durationClock: dur > 0 ? fmtClock(dur) : null,
            remainingClock: dur > pos ? fmtClock(dur - pos) : null,
            audioLanguage: t.audioLanguage || t.originalLanguage || null,
            subtitleLanguage: t.subtitleLanguage || null,
            lyricsLines: Array.isArray(s.cardLyrics?.result?.lines) ? s.cardLyrics.result.lines.slice(0, 6) : null
          } : null,
          participants: Array.isArray(context.callParticipants) ? context.callParticipants : undefined,
          queueCount: q.length,
          upNext: q.slice(0, 5).map((item, idx) => `${idx + 1}. ${item.title}`),
          upNextItems: q.slice(0, 5).map((item, idx) => ({
            index: idx + 1,
            title: item.title,
            type: item.mediaKind || (item.seasonNumber ? 'tv' : (item.provider === 'movie' ? 'movie' : 'music')),
            seasonNumber: item.seasonNumber ?? item.season ?? null,
            episodeNumber: item.episodeNumber ?? item.episode ?? null
          })),
          lastMovieSearch: movieSearchResults.length ? { query: storedSearch?.query || null, results: movieSearchResults } : null,
          lastVideoSearch: videoSearchResults.length ? { query: s.lastVideoSearch?.query || null, results: videoSearchResults } : null
        };
      }

      case 'control_playback': {
        if (!qm || !chatId) return { ok: false, error: 'music_unavailable' };
        const action = String(args.action || '').toLowerCase();
        if (action === 'pause') {
          if (s?.status === 'paused') return { ok: true, action: 'pause', alreadyPaused: true };
          const changed = await qm.pause(chatId);
          return { ok: true, action: 'pause', changed: Boolean(changed) };
        }
        if (action === 'resume') {
          if (s?.status === 'playing') return { ok: true, action: 'resume', alreadyPlaying: true };
          const changed = await qm.resume(chatId);
          return { ok: true, action: 'resume', changed: Boolean(changed), suppressedAutoResume: false };
        }
        if (action === 'skip') {
          await qm.skip(chatId);
          return { ok: true, action: 'skip', nowPlaying: s?.currentTrack?.title || null };
        }
        if (action === 'previous') {
          await qm.previous(chatId);
          return { ok: true, action: 'previous', nowPlaying: s?.currentTrack?.title || null };
        }
        if (action === 'stop' || action === 'leave') {
          qm.requestStop?.(chatId);
          await qm.stop(chatId, { leaveMembership: false });
          return { ok: true, action, stopped: true };
        }
        if (action === 'toggle_loop') {
          const mode = qm.toggleLoopMode(chatId);
          return { ok: true, action: 'toggle_loop', loopMode: mode };
        }
        if (action === 'set_loop') {
          const desired = ['off', 'track', 'queue'].includes(String(args.loop_mode || '').toLowerCase())
            ? String(args.loop_mode).toLowerCase()
            : 'off';
          if (s) s.loopMode = desired;
          await qm.updatePlayerCard?.(chatId, { forceEdit: true }).catch(() => {});
          return { ok: true, action: 'set_loop', loopMode: desired };
        }
        if (action === 'shuffle') {
          const count = Number(qm.shuffle?.(chatId) || 0);
          await qm.updatePlayerCard?.(chatId, { forceEdit: true }).catch(() => {});
          return { ok: true, action: 'shuffle', count };
        }
        if (action === 'vote_skip') {
          if (!s?.currentTrack) return { ok: false, error: 'nothing_playing' };
          const needed = this.#music()?.getSkipVoteThreshold?.(chatId) ?? 2;
          const voter = Number(context.userId || 0) || String(context.senderName || 'voter');
          const votes = new Set(Array.isArray(s.skipVotes) ? s.skipVotes : []);
          votes.add(voter);
          s.skipVotes = [...votes];
          if (s.skipVotes.length >= needed) {
            s.skipVotes = [];
            await qm.skip(chatId);
            return { ok: true, action: 'vote_skip', skipped: true, votes: needed, needed };
          }
          await qm.updatePlayerCard?.(chatId, { forceEdit: true }).catch(() => {});
          return { ok: true, action: 'vote_skip', skipped: false, votes: s.skipVotes.length, needed };
        }
        if (action === 'refresh_player') {
          await qm.updatePlayerCard?.(chatId, { forceEdit: true });
          return { ok: true, action: 'refresh_player' };
        }
        if (action === 'pin_player') {
          await qm.autoPinPlayerCard?.(chatId, s?.screenMessageId || null, s?.playerChatId || chatId, s?.api || context.ctx?.api);
          return { ok: true, action: 'pin_player' };
        }
        if (action === 'hide_guide' || action === 'show_guide') {
          const hide = action === 'hide_guide';
          this.app?.db?.setSetting?.(`music.hideGuide.${chatId}`, hide);
          if (s) s.guideHidden = hide;
          await qm.updatePlayerCard?.(chatId, { forceEdit: true }).catch(() => {});
          return { ok: true, action, guideHidden: hide };
        }
        if (action === 'switch_deck') {
          const target = args.deck === 'movie' || args.deck === 'music'
            ? args.deck
            : ((s?.activeDeck === 'movie') ? 'music' : 'movie');
          await qm.switchDeck(chatId, target);
          return { ok: true, action: 'switch_deck', deck: target };
        }
        return { ok: false, error: 'unknown_playback_action' };
      }

      case 'adjust_volume': {
        if (!qm || !chatId || !s) return { ok: false, error: 'music_unavailable' };
        const rawMode = String(args.mode || 'set').toLowerCase();
        const mode = rawMode === 'up' ? 'louder' : rawMode === 'down' ? 'lower' : rawMode;
        const curVol = Number(s.volume ?? 100);
        if (mode === 'mute') {
          if (!s._mutedByLancy && curVol > 0) s._preMuteVolume = curVol;
          s._mutedByLancy = true;
          await qm.setVolume(chatId, 0);
          return { ok: true, mode: 'mute', volume: 0, previousVolume: s._preMuteVolume || curVol };
        }
        if (mode === 'unmute') {
          const restore = Math.max(20, Math.min(200, Number(s._preMuteVolume || (curVol > 0 ? curVol : 100))));
          s._mutedByLancy = false;
          await qm.setVolume(chatId, restore);
          return { ok: true, mode: 'unmute', volume: restore };
        }
        const delta = Math.max(5, Math.min(100, Number(Math.abs(Number(args.value)) || 25)));
        let nextVol = curVol;
        if (mode === 'lower') nextVol = Math.max(0, curVol - delta);
        else if (mode === 'louder') nextVol = Math.min(200, curVol + delta);
        else nextVol = Math.max(0, Math.min(200, Number(args.value ?? 100)));
        s._mutedByLancy = nextVol === 0;
        if (nextVol > 0) s._preMuteVolume = nextVol;
        await qm.setVolume(chatId, Math.round(nextVol));
        return { ok: true, mode, volume: Math.round(nextVol), previousVolume: curVol };
      }

      case 'seek_playback': {
        if (!qm || !chatId || !s) return { ok: false, error: 'music_unavailable' };
        if (!s.currentTrack) return { ok: false, error: 'nothing_playing' };
        const dur = Number(s.currentTrack.durationSeconds || 0);
        const cur = Number(s.positionSeconds ?? s.lastKnownPositionSeconds ?? 0);
        let targetSpec = args.target;
        if (targetSpec === undefined || targetSpec === null || targetSpec === '') {
          if (args.fraction !== undefined && Number.isFinite(Number(args.fraction))) {
            targetSpec = `${Math.max(0, Math.min(100, Number(args.fraction) * 100))}%`;
          } else if (args.seconds !== undefined && Number.isFinite(Number(args.seconds))) {
            const sec = Number(args.seconds);
            targetSpec = args.relative ? `${sec >= 0 ? '+' : ''}${sec}s` : `${sec}s`;
          }
        }
        const resolved = resolveSeekTargetSeconds(targetSpec, cur, dur);
        if (resolved.error) return { ok: false, error: resolved.error };
        await qm.seek(chatId, resolved.seconds);
        return { ok: true, seekSeconds: resolved.seconds, label: resolved.label, clock: fmtClock(resolved.seconds), title: s.currentTrack.title };
      }

      case 'manage_queue': {
        if (!qm || !chatId || !s) return { ok: false, error: 'music_unavailable' };
        const rawAction = String(args.action || 'list').toLowerCase();
        const action = rawAction === 'move_to_top' ? 'promote' : rawAction;
        const deck = args.deck === 'movie' || args.deck === 'music' ? args.deck : (s.activeDeck || 'music');
        const q = deck === 'movie' ? (s.movieUpcoming || []) : (s.upcoming || []);
        if (action === 'list') {
          return { ok: true, deck, count: q.length, items: q.slice(0, 8).map((item, idx) => ({ index: idx + 1, title: item.title, artist: item.artist || null })) };
        }
        if (action === 'playlist_list' || action === 'playlist_save' || action === 'playlist_load') {
          const uid = Number(context.userId || s.ownerId || chatId);
          const plKey = `music.playlists.${uid}`;
          const lists = this.app?.db?.getSetting?.(plKey, {}) || {};
          const plName = String(args.query || '').trim();
          if (action === 'playlist_list') {
            return { ok: true, action, playlists: Object.keys(lists) };
          }
          if (!plName || ['__proto__', 'constructor', 'prototype'].includes(plName)) {
            return { ok: false, error: 'invalid_playlist_name' };
          }
          if (action === 'playlist_save') {
            const tracksToSave = [s.currentTrack, ...s.upcoming].filter(Boolean).slice(0, 50).map(({ id: tid, provider, providerId, title, artist, album, durationSeconds, artwork, sourceRef, mediaType, capabilities }) => ({ id: tid, provider, providerId, title, artist, album, durationSeconds, artwork, sourceRef, mediaType, capabilities }));
            lists[plName] = tracksToSave;
            this.app?.db?.setSetting?.(plKey, lists);
            return { ok: true, action, name: plName, savedCount: tracksToSave.length };
          }
          const loaded = Array.isArray(lists[plName]) ? lists[plName] : null;
          if (!loaded?.length) return { ok: false, error: 'playlist_not_found', name: plName };
          await qm.addMany(chatId, loaded);
          return { ok: true, action, name: plName, addedCount: loaded.length };
        }
        if (action === 'clear') {
          const cleared = deck === 'movie' ? qm.clearMovieQueue(chatId) : qm.clearQueue(chatId);
          return { ok: true, action: 'clear', deck, cleared };
        }
        let idx = Math.max(0, (Number(args.index) || 1) - 1);
        const qText = String(args.query || '').trim().toLowerCase();
        if (qText && q.length) {
          const byName = q.findIndex((item) => String(item?.title || '').toLowerCase().includes(qText) || String(item?.artist || '').toLowerCase().includes(qText));
          if (byName >= 0) idx = byName;
          else if (args.index === undefined) return { ok: false, error: 'queue_item_not_found', query: args.query, count: q.length };
        }
        const targetItem = q[idx];
        if (!targetItem) return { ok: false, error: 'queue_item_not_found', count: q.length };
        if (action === 'jump') {
          if (deck === 'movie') await qm.playQueuedMovieNow(chatId, targetItem.entryId);
          else await qm.playNow(chatId, targetItem.entryId);
          return { ok: true, action: 'jump', title: targetItem.title, index: idx + 1 };
        }
        if (action === 'promote') {
          if (deck === 'movie') qm.promoteMovieTrack(chatId, targetItem.entryId);
          else qm.promoteTrack(chatId, targetItem.entryId);
          return { ok: true, action: 'promote', title: targetItem.title, index: idx + 1 };
        }
        if (action === 'remove') {
          const removed = deck === 'movie' ? qm.removeMovieTrack(chatId, idx) : qm.removeTrack(chatId, idx);
          return { ok: true, action: 'remove', title: removed?.title || targetItem.title };
        }
        return { ok: false, error: 'unknown_queue_action' };
      }

      case 'search_movies_series': {
        const movieApi = this.app?.movieApi;
        const movieResolver = this.app?.movieResolver;
        const action = String(args.action || 'search').toLowerCase();
        const rawQuery = String(args.query || '').trim();
        const hint = rawQuery ? extractSeasonEpisodeHint(rawQuery) : { title: '', season: null, episode: null };
        const query = hint.title || rawQuery;
        const reqSeason = Number(args.season) > 0 ? Number(args.season) : hint.season;
        const reqEpisode = Number(args.episode) > 0 ? Number(args.episode) : hint.episode;
        const resultIndex = Number(args.result_index || 0);
        const targetScope = String(args.target_scope || '').toLowerCase();
        const mediaType = ['movie', 'tv', 'multi'].includes(args.media_type)
          ? args.media_type
          : ((reqSeason != null || reqEpisode != null) ? 'tv' : 'multi');
        const gcCtx = this.#buildGcCtx(chatId, s, context);
        const storedSearch = this.#getStoredMovieSearch(chatId, s);

        let items = [];
        let pickedDirect = null;

        // Direct episode/season loading on currently playing title or next queued movie without pre-queuing
        if (targetScope === 'current' && s?.currentTrack) {
          const cur = s.currentTrack;
          const cleanTitle = String(cur.seriesTitle || cur.title || '').replace(/\s+S\d+\s*E\d+.*$/i, '').trim();
          pickedDirect = {
            id: cur.tmdbId || cur.seriesId || cur.id,
            tmdbId: cur.tmdbId || cur.seriesId || cur.id,
            title: cleanTitle || cur.title,
            originalTitle: cur.originalTitle || null,
            originalLanguage: cur.originalLanguage || cur.audioLanguage || null,
            year: cur.year || null,
            type: (cur.mediaKind === 'tv' || cur.seasonNumber != null || reqSeason != null || reqEpisode != null) ? 'tv' : 'movie',
            poster: cur.artwork || null,
            imdbId: cur.imdbId || null
          };
        } else if (targetScope === 'up_next') {
          const nextItem = s?.movieUpcoming?.[0] || s?.upcoming?.[0] || null;
          if (nextItem) {
            const cleanTitle = String(nextItem.seriesTitle || nextItem.title || '').replace(/\s+S\d+\s*E\d+.*$/i, '').trim();
            pickedDirect = {
              id: nextItem.tmdbId || nextItem.seriesId || nextItem.id,
              tmdbId: nextItem.tmdbId || nextItem.seriesId || nextItem.id,
              title: cleanTitle || nextItem.title,
              originalTitle: nextItem.originalTitle || null,
              originalLanguage: nextItem.originalLanguage || nextItem.audioLanguage || null,
              year: nextItem.year || null,
              type: (nextItem.mediaKind === 'tv' || nextItem.seasonNumber != null || reqSeason != null || reqEpisode != null) ? 'tv' : 'movie',
              poster: nextItem.artwork || null,
              imdbId: nextItem.imdbId || null
            };
          }
        }

        if (pickedDirect) {
          items = [pickedDirect];
        } else if (resultIndex > 0 && Array.isArray(storedSearch?.results) && storedSearch.results[resultIndex - 1] && (!query || targetScope === 'search_result')) {
          items = storedSearch.results;
        } else if (action === 'trending' && typeof movieApi?.trending === 'function') {
          const res = await movieApi.trending({ window: 'day', type: mediaType === 'multi' ? 'all' : mediaType });
          items = res?.results || res?.items || (Array.isArray(res) ? res : []);
        } else if (action === 'random' && typeof movieApi?.random === 'function') {
          const pick = await movieApi.random({ type: mediaType === 'multi' ? 'all' : mediaType });
          if (pick) items = [pick];
        } else if (query && typeof movieApi?.search === 'function') {
          const res = await movieApi.search(query, { type: mediaType, limit: 6 });
          items = res?.results || res?.items || (Array.isArray(res) ? res : []);
        } else if (action === 'inspect' && Array.isArray(storedSearch?.results) && storedSearch.results.length) {
          items = storedSearch.results;
        }

        if (!Array.isArray(items) || !items.length) {
          return { ok: false, error: 'no_movies_found', query };
        }

        const pickedIdx = (!pickedDirect && resultIndex > 0 && resultIndex <= items.length) ? (resultIndex - 1) : 0;
        const enriched = await this.#enrichMovieResults(items, {
          limit: 5,
          fetchSeasons: action === 'search' || action === 'inspect' || action === 'trending' || action === 'random' || resultIndex > 0
        });
        const top = enriched[pickedIdx] || enriched[0];

        if ((action === 'play_now' || action === 'queue') && qm && chatId) {
          const isTv = top.type === 'tv' || reqSeason != null || reqEpisode != null;
          const seasonNum = Number(reqSeason || top.seasonNumber || 1);
          const episodeNum = Number(reqEpisode || top.episodeNumber || 1);
          const desc = {
            type: isTv ? 'tv' : 'movie',
            id: top.id,
            tmdbId: top.tmdbId || top.id,
            title: top.title,
            originalTitle: top.originalTitle || null,
            originalLanguage: top.originalLanguage || top.language || null,
            year: top.year || null,
            artwork: top.poster || top.backdrop || null,
            imdbId: top.imdbId || null,
            ...(isTv ? { season: seasonNum, episode: episodeNum } : {})
          };
          if (typeof movieResolver?.resolve === 'function') {
            const resolved = await movieResolver.resolve(desc).catch(() => null);
            if (resolved?.track) {
              if (action === 'play_now' && typeof qm.addMovies === 'function') {
                await qm.addMovies(chatId, [resolved.track], { playNow: true });
              } else if (typeof qm.addMovies === 'function') {
                await qm.addMovies(chatId, [resolved.track], { playNow: false });
              } else {
                await qm.addMany(chatId, [resolved.track]);
              }
              this.app?.lancyAgent?.taste?.recordPreference?.({
                userId: context.userId,
                chatId,
                displayName: context.senderName,
                movieTitle: resolved.track.title || top.title,
                requestText: query || top.title
              });
              return {
                ok: true,
                action,
                cardKind: 'movie',
                resultIndex: pickedIdx + 1,
                targetScope: targetScope || null,
                title: resolved.track.title || top.title,
                seriesTitle: top.title,
                season: isTv ? seasonNum : null,
                episode: isTv ? episodeNum : null,
                year: top.year || null,
                seasonsBreakdown: top.seasonsBreakdown || null,
                overview: safeClip(top.overview || '', 180) || null,
                artwork: top.poster || top.backdrop || null,
                results: enriched.slice(0, 4).map((m) => ({
                  index: m.index,
                  id: m.id,
                  title: m.title,
                  year: m.year || null,
                  type: m.type || 'movie',
                  rating: m.rating || null,
                  seasonsBreakdown: m.seasonsBreakdown || null
                }))
              };
            }
          }
          // Fallback: open UI movie search card if resolver unavailable or streaming failed
          await this.#syncMovieSearchCard(gcCtx, chatId, s, query || top.title, enriched);
        }

        if (action === 'inspect') {
          if (s) s.lastMovieSearch = { query: query || storedSearch?.query || '', timestamp: Date.now(), results: enriched };
          return {
            ok: true,
            action: 'inspect',
            cardKind: 'movie_list',
            resultIndex: resultIndex > 0 ? pickedIdx + 1 : null,
            selected: resultIndex > 0 ? {
              index: pickedIdx + 1,
              id: top.id,
              title: top.title,
              year: top.year || null,
              type: top.type || 'movie',
              rating: top.rating || null,
              totalSeasons: top.totalSeasons || null,
              totalEpisodes: top.totalEpisodes || null,
              seasons: top.seasons || [],
              seasonsBreakdown: top.seasonsBreakdown || null,
              overview: safeClip(top.overview || '', 180) || null
            } : null,
            count: enriched.length,
            results: enriched.map((m) => ({
              index: m.index,
              id: m.id,
              title: m.title,
              year: m.year || null,
              type: m.type || 'movie',
              rating: m.rating || null,
              totalSeasons: m.totalSeasons || null,
              totalEpisodes: m.totalEpisodes || null,
              seasonsBreakdown: m.seasonsBreakdown || null,
              overview: safeClip(m.overview || '', 120) || null
            }))
          };
        }

        const postedToChat = await this.#syncMovieSearchCard(gcCtx, chatId, s, query || (action === 'trending' ? 'Trending' : top.title), enriched);
        return {
          ok: true,
          action: 'search',
          cardKind: 'movie_list',
          query: query || null,
          postedToChat,
          count: enriched.length,
          results: enriched.map((m) => ({
            index: m.index,
            id: m.id,
            title: m.title,
            year: m.year || null,
            type: m.type || 'movie',
            rating: m.rating || null,
            totalSeasons: m.totalSeasons || null,
            totalEpisodes: m.totalEpisodes || null,
            seasonsBreakdown: m.seasonsBreakdown || null,
            overview: safeClip(m.overview || '', 120) || null
          }))
        };
      }

      case 'search_videos': {
        const action = String(args.action || 'search').toLowerCase();
        const query = String(args.query || '').trim();
        const resultIndex = Number(args.result_index || 0);
        const gcCtx = this.#buildGcCtx(chatId, s, context);

        let videos = [];
        if (resultIndex > 0 && Array.isArray(s?.lastVideoSearch?.results) && (!query || action !== 'search')) {
          videos = s.lastVideoSearch.results;
        } else {
          if (!query) return { ok: false, error: 'missing_query' };
          const rawVids = await searchYouTubeFast(safeClip(query, 160), 'NG', { wide: true, video: true }).catch(() => []);
          videos = (Array.isArray(rawVids) ? rawVids : [])
            .filter((v) => /^[\w-]{11}$/.test(String(v?.videoId || '')) && !v?.isLive && v?.duration !== 'LIVE')
            .slice(0, 6)
            .map((v, idx) => ({
              index: idx + 1,
              videoId: v.videoId,
              title: safeClip(v.title || 'Untitled Video', 90),
              author: v.author || null,
              duration: v.duration || null,
              views: v.views || null,
              thumb: v.thumb || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
              url: `https://www.youtube.com/watch?v=${v.videoId}`
            }));
        }

        if (!videos.length) return { ok: false, error: 'no_videos_found', query };
        if (s) {
          s.lastVideoSearch = {
            query: query || s.lastVideoSearch?.query || '',
            timestamp: Date.now(),
            results: videos
          };
        }

        const pickedIdx = (resultIndex > 0 && resultIndex <= videos.length) ? (resultIndex - 1) : 0;
        const pick = videos[pickedIdx] || videos[0];

        if (action === 'search') {
          const postedToChat = await this.#postVideoSearchCard(gcCtx, query || pick.title, videos);
          return {
            ok: true,
            action: 'search',
            cardKind: 'video_list',
            query: query || null,
            postedToChat,
            count: videos.length,
            results: videos
          };
        }

        if (action === 'send_to_chat') {
          const api = gcCtx.api;
          const targetChatId = Number(gcCtx.chatId || 0);
          if (!api || !targetChatId) return { ok: false, error: 'telegram_api_unavailable' };
          const posted = await this.#postVideoSearchCard(gcCtx, pick.title, [pick]);
          return {
            ok: true,
            action: 'send_to_chat',
            cardKind: 'video',
            index: pick.index,
            title: pick.title,
            author: pick.author,
            duration: pick.duration,
            url: pick.url,
            sent: posted
          };
        }

        if ((action === 'play_now' || action === 'queue') && qm && chatId) {
          const track = {
            ...normalizeTrack({
              providerId: pick.videoId,
              title: pick.title,
              artist: pick.author || 'YouTube',
              duration: pick.duration || '',
              mediaType: 'video',
              artwork: pick.thumb,
              sourceRef: pick.url,
              availability: 'unresolved'
            }, 'youtube'),
            mediaType: 'video',
            requester: context.senderName || 'Lancy AI'
          };
          if (action === 'play_now' && typeof qm.playImmediateAndContinue === 'function') {
            await qm.playImmediateAndContinue(chatId, track);
          } else {
            await qm.addMany(chatId, [track]);
          }
          return {
            ok: true,
            action,
            cardKind: 'video',
            index: pick.index,
            title: pick.title,
            author: pick.author,
            duration: pick.duration,
            url: pick.url,
            results: videos.slice(0, 4)
          };
        }
        return { ok: false, error: 'music_unavailable' };
      }

      case 'search_and_play_music': {
        const query = String(args.query || '').trim();
        const action = String(args.action || 'play_now').toLowerCase();
        if (!query) return { ok: false, error: 'missing_query' };

        if (action === 'ai_dj' && this.#music()?.aiDj && s) {
          const djRes = await this.#music().aiDj.chatWithDj(s, query, { apply: true }).catch(() => null);
          if (djRes) return { ok: true, action: 'ai_dj', reply: djRes.reply || null, addedCount: djRes.added?.length || 0 };
        }

        const providers = this.app?.musicProviders;
        const searchProvider = providers?.get?.('youtube') || providers?.get?.('spotify');
        const results = typeof this.#music()?.search?.find === 'function'
          ? await this.#music().search.find(query).catch(() => [])
          : (typeof searchProvider?.search === 'function' ? await searchProvider.search(query).catch(() => []) : []);

        const tracks = Array.isArray(results) ? results : (results?.items || []);
        if (!tracks.length) return { ok: false, error: 'no_music_found', query };
        if (action === 'search') {
          return { ok: true, action: 'search', cardKind: 'music_list', results: tracks.slice(0, 5).map((t, i) => ({ index: i + 1, title: t.title, artist: t.artist || t.channel || null })) };
        }
        const pick = { ...tracks[0], mediaType: 'video', requester: context.senderName || 'Lancy AI' };
        if (qm && chatId) {
          if (action === 'play_now' && typeof qm.playImmediateAndContinue === 'function') {
            await qm.playImmediateAndContinue(chatId, pick);
          } else {
            await qm.addMany(chatId, [pick]);
          }
          this.app?.lancyAgent?.taste?.recordPreference?.({
            userId: context.userId,
            chatId,
            displayName: context.senderName,
            artist: pick.artist || pick.channel || query,
            requestText: query
          });
          return { ok: true, action, cardKind: 'music', title: pick.title, artist: pick.artist || null, results: tracks.slice(0, 4).map((t, i) => ({ index: i + 1, title: t.title, artist: t.artist || t.channel || null })) };
        }
        return { ok: false, error: 'music_unavailable' };
      }

      case 'tune_cinema_stream': {
        if (!qm || !chatId || !s) return { ok: false, error: 'music_unavailable' };
        let setting = String(args.setting || '').toLowerCase();
        let val = String(args.value || '').trim().toLowerCase();
        if (!setting) {
          if (args.audioLanguage || args.audio_language) {
            setting = 'audio_language';
            val = String(args.audioLanguage || args.audio_language).trim().toLowerCase();
          } else if (args.subtitles || args.subtitleMode || args.subtitle_mode) {
            setting = 'subtitle_mode';
            val = String(args.subtitles || args.subtitleMode || args.subtitle_mode).trim().toLowerCase();
          } else if (args.subtitleLanguage || args.subtitle_language || args.subtitleTrack) {
            setting = 'subtitle_track';
            val = String(args.subtitleLanguage || args.subtitle_language || args.subtitleTrack).trim().toLowerCase();
          }
        }
        if (setting === 'audio_language') {
          const variants = qm.getAudioVariants?.(s.currentTrack) || [];
          let targetIdx = null;
          if (val && val !== 'next') {
            const foundIdx = variants.findIndex((v) =>
              String(v.audioLanguage || '').toLowerCase().includes(val)
              || String(v.label || '').toLowerCase().includes(val)
              || (val.includes('orig') && !v.audioIsDub)
            );
            if (foundIdx >= 0) targetIdx = foundIdx;
          }
          return await qm.switchAudioLanguage(chatId, targetIdx);
        }
        if (setting === 'subtitle_mode') {
          const mode = val.includes('vc') ? 'vc' : val.includes('live') ? 'live' : val.includes('off') ? 'off' : 'screen';
          const out = await qm.setSubtitleMode(chatId, mode);
          return { ok: true, setting, subtitleMode: out };
        }
        if (setting === 'subtitle_track') {
          const idxM = val.match(/(\d+)/);
          let targetIdx = idxM ? Math.max(0, Number(idxM[1]) - 1) : null;
          const tracks = Array.isArray(s.currentTrack?.subtitleTracks) ? s.currentTrack.subtitleTracks : [];
          if (targetIdx === null && val && val !== 'next') {
            const found = tracks.findIndex((t) =>
              String(t?.language || '').toLowerCase().includes(val)
              || String(t?.label || '').toLowerCase().includes(val)
            );
            if (found >= 0) targetIdx = found;
          }
          const out = await qm.cycleSubtitleTrack?.(chatId, targetIdx);
          return out || { ok: true, setting };
        }
        if (setting === 'auto_sync_subtitles') {
          const res = await qm.checkSubtitleSync?.(chatId, { autoFix: true });
          return { ok: true, setting, status: res || null };
        }
        if (setting === 'dual_subtitle_tile') {
          const vc = this.app?.voiceClient;
          if (!vc) return { ok: false, error: 'voice_unavailable' };
          const wantOff = val === 'off' || (val === 'toggle' && Boolean(s.secondaryTile));
          if (wantOff) {
            await vc.stopSecondaryTile?.(chatId).catch(() => {});
            s.secondaryTile = null;
            return { ok: true, setting, dualTile: false };
          }
          const t = s.currentTrack;
          const tracks = Array.isArray(t?.subtitleTracks) ? t.subtitleTracks : [];
          const alt = tracks.find((tr) => tr?.filePath && tr.filePath !== t.subtitlePath) || tracks[0];
          if (!alt?.filePath) return { ok: false, error: 'no_alt_subtitle' };
          const tileRes = await vc.startSecondaryTile?.(chatId, {
            subtitlePath: alt.filePath,
            language: alt.language || 'spa',
            label: alt.label || 'Secondary Subtitles',
            subtitleOffset: s.subtitleSyncOffset || 0
          });
          s.secondaryTile = tileRes ? { alias: tileRes.account_alias, language: tileRes.language, label: tileRes.label } : { language: alt.language || 'spa' };
          return { ok: true, setting, dualTile: true, language: s.secondaryTile.language };
        }
        if (setting === 'quality') {
          const targetQ = /1080|fhd|full|high/.test(val) ? 'FHD_1080p' : (/480|360|low|sd/.test(val) ? 'SD_480p' : 'HD_720p');
          const applied = await qm.setVcQuality?.(chatId, targetQ);
          return { ok: true, setting, quality: applied || targetQ };
        }
        if (setting === 'subtitle_offset') {
          const num = parseFloat(val.replace(/s$/i, ''));
          if (!Number.isFinite(num)) return { ok: false, error: 'invalid_offset' };
          const abs = !val.startsWith('+') && !val.startsWith('-');
          await qm.setSubtitleOffset?.(chatId, num, { absolute: abs });
          return { ok: true, setting, offset: s.subtitleSyncOffset };
        }
        if (setting === 'switch_source') {
          const res = await qm.switchMovieSource?.(chatId);
          return res || { ok: true, setting };
        }
        if (setting === 'stream_mode') {
          const target = val.includes('rtmp') ? 'rtmp' : (val.includes('inter') || val.includes('webrtc') ? 'interactive' : null);
          await qm.setStreamMode(chatId, target);
          return { ok: true, setting, streamMode: s.streamMode };
        }
        return { ok: false, error: 'unknown_cinema_setting' };
      }

      case 'ai_dj_control': {
        if (!s || !this.#music()?.aiDj) return { ok: false, error: 'aidj_unavailable' };
        const aiDj = this.#music().aiDj;
        const action = String(args.action || '').toLowerCase();
        if (action === 'next_chapter') {
          const chap = await aiDj.dropNextChapter?.(s);
          return { ok: true, action, chapter: chap?.chapterTitle || chap?.stage || null };
        }
        if (action === 'visual_on' || action === 'visual_off') {
          const on = action === 'visual_on';
          if (typeof aiDj.setVisualDeskEnabled === 'function') await aiDj.setVisualDeskEnabled(s, on);
          else s.djDeskEnabled = on;
          return { ok: true, action, visualDesk: on };
        }
        if (action === 'lyrics_on' || action === 'lyrics_off') {
          const on = action === 'lyrics_on';
          if (s.djDesk) s.djDesk.showLyrics = on;
          s.showLyrics = on;
          this.app?.db?.setSetting?.(`music.djLyrics.${chatId}`, on);
          return { ok: true, action, showLyrics: on };
        }
        if (action === 'eq') {
          const preset = String(args.value || 'bass').toLowerCase();
          s.eqPreset = preset;
          this.app.db?.setSetting?.(`music.eq.${chatId}`, preset);
          return { ok: true, action, eqPreset: preset };
        }
        if (action === 'crossfade') {
          const sec = Math.max(0, Math.min(12, Number(args.value || 4)));
          s.crossfadeSec = sec;
          return { ok: true, action, crossfadeSec: sec };
        }
        return { ok: false, error: 'unknown_dj_action' };
      }

      case 'send_current_video_to_chat': {
        const targetChatId = Number(context.telegramChatId || chatId);
        const api = context.ctx?.api || this.app?.telegram?.api || s?.api;
        if (!targetChatId || !api) return { ok: false, error: 'telegram_api_unavailable' };

        const q = String(args.quality || '480p');
        const customQuery = String(args.query || '').trim();
        let trackToSend = s?.currentTrack || null;

        if (!trackToSend && customQuery && typeof this.app?.movieApi?.search === 'function') {
          const res = await this.app.movieApi.search(customQuery, { type: 'multi', limit: 3 }).catch(() => null);
          const first = res?.results?.[0] || res?.items?.[0] || res?.[0];
          if (first) trackToSend = first;
        }
        if (!trackToSend) return { ok: false, error: 'no_media_to_send' };

        const fakeCtx = context.ctx || { chatId: targetChatId, chat: { id: targetChatId }, api, user: context.user || null };
        const isMovieOrVideo = trackToSend.provider === 'movie' || trackToSend.mediaKind === 'tv' || trackToSend.mediaKind === 'movie' || trackToSend.isAdult || trackToSend.videoUrl || trackToSend.streamUrl;
        if (isMovieOrVideo && this.app?.movieDownloader?.sendSingleVideo) {
          const desc = {
            ...trackToSend,
            type: trackToSend.mediaKind === 'tv' || trackToSend.seasonNumber ? 'tv' : 'movie',
            title: trackToSend.title,
            artwork: trackToSend.artwork || trackToSend.poster || trackToSend.backdrop || null,
            downloadUrls: Array.isArray(trackToSend.downloadUrls) ? trackToSend.downloadUrls : []
          };
          // Run in background if large upload so live voice conversation doesn't block HTTP timeouts
          const uploadPromise = this.app.movieDownloader.sendSingleVideo(fakeCtx, desc, {
            quality: q,
            spoiler: Boolean(trackToSend.isAdult && targetChatId < 0),
            allowAdultFeatures: Boolean(trackToSend.isAdult)
          });
          if (context.waitForUpload === true) {
            const res = await uploadPromise;
            return res?.ok ? { ok: true, sent: true, title: desc.title, quality: q } : { ok: false, error: res?.reason || 'upload_failed' };
          }
          uploadPromise.catch(() => {});
          return { ok: true, started: true, title: desc.title, quality: q };
        }

        // Fallback: music track direct upload
        if (trackToSend.filePath && typeof api.sendAudio === 'function') {
          await api.sendAudio(targetChatId, audioUpload(trackToSend.filePath, trackToSend.title, trackToSend.artist), {
            title: trackToSend.title,
            performer: trackToSend.artist || undefined
          });
          return { ok: true, sent: true, title: trackToSend.title };
        }
        return { ok: false, error: 'downloader_unavailable' };
      }

      case 'download_url_or_images': {
        const kind = String(args.kind || '');
        const target = String(args.target || '').trim();
        if (!target) return { ok: false, error: 'missing_target' };
        if (kind === 'download_url') {
          const dlScreen = this.app?.screens?.get?.('downloader');
          if (context.ctx && dlScreen?.executeDownload) {
            await dlScreen.executeDownload(context.ctx, target);
            return { ok: true, kind, started: true, target };
          }
        }
        if (kind === 'search_images') {
          const pin = this.app?.screens?.get?.('pinterest');
          if (context.ctx && pin?.executeSearch) {
            await pin.executeSearch(context.ctx, target);
            return { ok: true, kind, started: true, target };
          }
        }
        return { ok: false, error: 'screen_unavailable' };
      }

      case 'create_group_poll':
      case 'create_decision_poll': {
        const targetChatId = Number(context.telegramChatId || chatId);
        const api = context.ctx?.api || this.app?.telegram?.api || s?.api;
        if (!targetChatId || typeof api?.sendPoll !== 'function') {
          return { ok: false, error: 'poll_api_unavailable' };
        }
        const question = String(args.question || 'Which vibe or title next?').trim().slice(0, 280);
        const cleanOpts = [...new Set((Array.isArray(args.options) ? args.options : []).map(o => String(o || '').trim().slice(0, 95)).filter(Boolean))].slice(0, 8);
        if (cleanOpts.length < 2) return { ok: false, error: 'need_two_options' };
        const sentPoll = await api.sendPoll(targetChatId, question, cleanOpts, {
          is_anonymous: Boolean(args.is_anonymous ?? false),
          allows_multiple_answers: Boolean(args.allows_multiple_answers ?? false)
        });
        return {
          ok: true,
          cardKind: 'poll',
          pollId: sentPoll?.poll?.id || null,
          messageId: sentPoll?.message_id || null,
          question,
          options: cleanOpts
        };
      }

      case 'web_research': {
        const mode = String(args.mode || (args.url ? 'fetch' : 'search')).toLowerCase();
        const query = String(args.query || '').trim();
        const url = String(args.url || '').trim();
        if (mode === 'fetch' && url) {
          const excerpt = await this.browser.fetchPageExcerpt(url, { maxChars: 1400 }).catch(() => null);
          if (!excerpt) return { ok: false, error: 'fetch_unavailable', url };
          return { ok: true, mode: 'fetch', retrievedAt: new Date().toISOString(), url, excerpt };
        }
        if (!query) return { ok: false, error: 'missing_query' };
        const [structured, liveMedia] = await Promise.all([
          this.browser.researchStructured(query, { maxResults: 4 }).catch(() => ({ results: [], topExcerpt: null })),
          lookupCurrentMediaAndStories({ query, kind: 'all', browser: null, app: this.app }).catch(() => null)
        ]);
        const results = Array.isArray(structured?.results) ? structured.results : [];
        const mediaHints = [];
        if (liveMedia?.music?.length) mediaHints.push(...liveMedia.music.slice(0, 2).map((m) => ({ title: `${m.title} — ${m.artist}`, snippet: `Song (${m.genre || 'Music'}, ${m.releaseDate || 'recent'}) album: ${m.album || 'Single'}`, url: m.url })));
        if (liveMedia?.series?.length) mediaHints.push(...liveMedia.series.slice(0, 2).map((s) => ({ title: `${s.title} (${s.premiered || 'TV'})`, snippet: s.summary || `${s.genres.join(', ')} (${s.status})`, url: s.url })));
        if (liveMedia?.movies?.length) mediaHints.push(...liveMedia.movies.slice(0, 2).map((m) => ({ title: `${m.title} (${m.year || 'Movie'})`, snippet: m.overview || m.title, url: null })));
        if (liveMedia?.videos?.length) mediaHints.push(...liveMedia.videos.slice(0, 2).map((v) => ({ title: v.title, snippet: `Video (${v.channel || 'YouTube'} ${v.duration || ''})`, url: v.url })));
        const combined = [...results, ...mediaHints].slice(0, 6);
        if (!combined.length && !structured?.topExcerpt) {
          return { ok: false, error: 'search_unavailable', query };
        }
        return {
          ok: true,
          mode: 'search',
          retrievedAt: new Date().toISOString(),
          query,
          results: combined.map((r) => ({ title: safeClip(r.title, 120), snippet: safeClip(r.snippet, 340), url: r.url || null })),
          topExcerpt: structured?.topExcerpt ? safeClip(structured.topExcerpt, 1000) : (combined[0]?.snippet || null)
        };
      }

      case 'tell_story_or_novel': {
        const query = String(args.query || '').trim();
        const genre = String(args.genre || '').trim();
        if (!query && !genre) return { ok: false, error: 'missing_story_query' };
        const [stories, wikiPlots] = await Promise.all([
          lookupOpenLibraryStories({ query, genre, limit: 4 }).catch(() => []),
          this.browser.searchWikipedia(`${query || genre} ${genre && !query.toLowerCase().includes(genre.toLowerCase()) ? genre : ''} novel story plot`, { maxResults: 3, extractChars: 1600 }).catch(() => [])
        ]);
        if (!stories.length && !wikiPlots.length) {
          return { ok: false, error: 'no_results', query: query || genre };
        }
        return {
          ok: true,
          query: query || genre,
          genre: genre || null,
          books: stories.slice(0, 4).map((b) => ({
            title: b.title,
            authors: b.authors,
            year: b.year,
            subjects: b.subjects,
            synopsis: b.synopsis || b.firstSentence || null,
            url: b.url
          })),
          plots: wikiPlots.slice(0, 3),
          narrativeNote: 'Use these details to tell a rich, immersive, uninterrupted long-form story or chapter with vivid pacing.'
        };
      }

      case 'ask_clarification':
        return { ok: true, clarification: true, question: String(args.question || 'Sorry, I didn’t quite catch that — what did you say?') };

      case 'finish_conversation':
        return {
          ok: true,
          done: true,
          resumePlayback: Boolean(args.resumePlayback ?? args.resume_playback),
          closingLine: String(args.closingLine || args.closing_line || '')
        };

      case 'browser_start_task':
      case 'browser_task_status':
      case 'browser_list_tabs':
      case 'browser_pause_task':
      case 'browser_resume_task':
      case 'browser_stop_task':
      case 'browser_request_human_help':
      case 'browser_show_live':
      case 'browser_hide_live':
      case 'browser_replay_task':
      case 'browser_interact_live': {
        const b = this.app?.browser;
        if (!b) return { ok: false, error: 'browser_service_unavailable' };
        const cid = Number(context.telegramChatId || chatId || context.userId || 0);
        const uid = Number(context.userId || context.ctx?.tgId || cid || 0);
        const scopeKey = b.constructor?.name ? `${cid < 0 ? `gc:${cid}` : `dm:${uid || cid}`}` : 'global';
        const perm = await b.perms.authorize(context, { chatId: cid, userId: uid });
        if (!perm.allowed) {
          return { ok: false, error: `permission_denied:${perm.reason}` };
        }
        const active = b.tasks.getActiveTaskForScope(perm.scopeKey);
        const targetTaskId = args.task_id || active?.id || null;

        if (toolName === 'browser_start_task') {
          return await b.startTask({
            chatId: cid,
            userId: uid,
            requestedByName: context.senderName || context.speakerName || 'User',
            goal: String(args.goal || args.url || 'Open browser'),
            url: args.url || null,
            showLiveVc: Boolean(args.show_live ?? (cid < 0 && b.liveView.isLive(cid)))
          });
        }
        if (toolName === 'browser_task_status') {
          return b.getTaskStatus({ scopeKey: perm.scopeKey, taskId: targetTaskId });
        }
        if (toolName === 'browser_list_tabs') {
          return await b.listTabs(perm.scopeKey);
        }
        if (toolName === 'browser_pause_task') {
          if (!targetTaskId) return { ok: false, error: 'no_active_browser_task' };
          return await b.pauseTask(targetTaskId);
        }
        if (toolName === 'browser_resume_task') {
          if (!targetTaskId) return { ok: false, error: 'no_paused_browser_task' };
          return await b.resumeTask(targetTaskId);
        }
        if (toolName === 'browser_stop_task') {
          if (!targetTaskId) return { ok: false, error: 'no_active_browser_task' };
          const res = await b.stopTask(targetTaskId);
          if (cid < 0 && b.liveView.isLive(cid)) await b.hideLive(cid, { resumeMedia: true });
          return res;
        }
        if (toolName === 'browser_request_human_help') {
          if (!targetTaskId) return { ok: false, error: 'no_active_browser_task' };
          return await b.requestHumanHelp(targetTaskId, { reason: String(args.reason || 'Human help required'), userId: uid });
        }
        if (toolName === 'browser_show_live') {
          if (cid >= 0) return { ok: false, error: 'vc_requires_group_chat' };
          return await b.showLive(cid, { userId: uid, taskId: targetTaskId, url: args.url || null, quality: args.quality || null });
        }
        if (toolName === 'browser_hide_live') {
          if (cid >= 0) return { ok: false, error: 'vc_requires_group_chat' };
          return await b.hideLive(cid, { resumeMedia: args.resume_media !== false });
        }
        if (toolName === 'browser_replay_task') {
          return await b.getReplay(targetTaskId, { scopeKey: perm.scopeKey || scopeKey });
        }
        return await b.interactLive({ chatId: cid, userId: uid, scopeKey: perm.scopeKey, command: String(args.command || '') });
      }

      default:
        return { ok: false, error: `unknown_tool:${toolName}` };
    }
  }
}
