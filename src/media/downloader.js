import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync, unlinkSync, openSync, readSync, closeSync, createWriteStream, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { logger } from '../core/logger.js';
import { uploadLimitBytes } from './telegramLimits.js';
import { getSharedMediaWorkerPool } from '../core/mediaWorkerPool.js';
import {
  tiktokDl,
  instagramDl,
  twitterDl,
  youtubeDl,
  facebookDl,
  capcutDl,
  spotifyDl,
  spotifyMetadata,
  selectSpotifyCandidate,
  pinterestDl,
  applemusicMetadata,
  applemusicDl,
  audiomackDl,
  threadsDl,
  rednoteDl,
  thenkiriDl,
  thenkiriGetLink,
  isThenkiriUrl,
  bilibiliDl,
  bilibiliSave,
  isBilibiliUrl,
  justwatchDetails,
  justwatchWatch,
  isJustWatchUrl,
  universalDl,
  universalSave,
  detectPlatform as socialDetectPlatform
} from 'social-dl';

import { searchSongByLyrics, cleanSongMetadata } from './lyrics.js';
import { searchYouTubeFast } from './youtubeSearch.js';
import { parseDurationToSeconds } from '../utils/time.js';
import { splitMatchingCollage, resolveFfmpegPath } from './convert.js';

const SHORT_DRAMA_PLATFORMS = new Set([
  'dramabox', 'anydrama', 'dramafren', 'goodshort',
  'flextv', 'moboreels', 'reelshort', 'shortmax', 'flickreels'
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let tikwmLastRequestAt = 0;
let tikwmQueue = Promise.resolve();

function scheduleTikwmRequest(taskFn, minIntervalMs = 1250) {
  const run = tikwmQueue.then(async () => {
    const waitMs = Math.max(0, minIntervalMs - (Date.now() - tikwmLastRequestAt));
    if (waitMs > 0) await sleep(waitMs);
    tikwmLastRequestAt = Date.now();
    return taskFn();
  });
  tikwmQueue = run.catch(() => {});
  return run;
}

const execFileAsync = promisify(execFile);

export function getCookieArgs() {
  const possiblePaths = [
    join(process.cwd(), 'youtube_cookies.txt'),
    '/data/youtube_cookies.txt',
    join(process.cwd(), 'data', 'youtube_cookies.txt')
  ];
  for (const p of possiblePaths) {
    if (existsSync(p)) return ['--cookies', p];
  }
  return [];
}

export async function getAudioDurationSeconds(filePath) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ], { timeout: 5000 });
    const dur = parseFloat(stdout.trim());
    return Number.isFinite(dur) ? dur : null;
  } catch {
    return null;
  }
}

/**
 * Rank YouTube audio candidates with smart duration scoring:
 * - Prioritizes standard commercial song length (1:30 - 7:00)
 * - Penalizes long 1-3 hour mixes, continuous loops, and sub-45s snippets unless explicitly requested
 */
const UNWANTED_VARIANT_RE = /\b(slowed|reverb|nightcore|sped\s*up|8d\s*audio|karaoke|instrumental|reaction|teaser|shorts|cover|tiktok\s*version)\b/i;

function isMp3HeaderBuffer(buf) {
  return Boolean(
    buf &&
    buf.length >= 3 &&
    ((buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) ||
     (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0))
  );
}

function isMp3FileByMagic(filePath) {
  let fd = null;
  try {
    fd = openSync(filePath, 'r');
    const hdr = Buffer.alloc(4);
    const bytesRead = readSync(fd, hdr, 0, 4, 0);
    return bytesRead >= 3 && isMp3HeaderBuffer(hdr);
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
  }
}

export function rankYouTubeAudioCandidates(items, queryTerms, { clean = '', wantsLongMix = false } = {}) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const cleanLower = clean.toLowerCase();
  const queryContext = `${cleanLower} ${(queryTerms || []).join(' ').toLowerCase()}`;
  const queryWantsVariant = UNWANTED_VARIANT_RE.test(queryContext);
  const scored = items.map((item) => {
    const combined = `${item.title} ${item.author}`.toLowerCase();
    let score = 0;
    for (const term of queryTerms) {
      if (combined.includes(term)) score += 10;
    }
    if (clean && combined.includes(cleanLower)) score += 15;

    const durSec = parseDurationToSeconds(item.duration);

    if (!wantsLongMix) {
      if (durSec >= 90 && durSec <= 420) {
        score += 30; // Sweet spot for songs (1.5 to 7 mins)
      } else if (durSec > 420 && durSec <= 600) {
        score += 15; // 7 to 10 mins
      } else if (durSec > 600 && durSec <= 900) {
        score -= 15; // 10 to 15 mins
      } else if (durSec > 900 && durSec <= 1800) {
        score -= 60; // 15 to 30 mins
      } else if (durSec > 1800) {
        score -= 200; // > 30 mins (1-3 hour mixes)
      } else if (durSec < 45 || /^short$/i.test(item.duration)) {
        score -= 40; // Too short / Shorts clip
      }
    } else {
      if (durSec >= 600) score += 25;
    }

    if (/\b(official\s*audio|topic|provided\s+to\s+youtube)\b/i.test(combined)) {
      score += 20;
    } else if (/\b(official\s*(?:music\s*video|video|lyric)|lyrics)\b/i.test(combined)) {
      score += 12;
    }
    if (!queryWantsVariant && UNWANTED_VARIANT_RE.test(combined)) {
      score -= 45;
    }

    return { item, score, durSec };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.item || null;
}

/**
 * Universal Media Downloader & Extractor
 *
 * Supports:
 * - TikTok (videos without watermark, photo slideshows/carousels + original music)
 * - Instagram (Reels, posts, carousels/albums + audio)
 * - Pinterest (HD original images, videos, carousel albums, story/idea pins, pin.it)
 * - YouTube & Shorts (HD videos + MP3 audio track)
 * - Twitter / X (videos, photos, multi-image tweets)
 * - Facebook, CapCut, Spotify, Reddit, Threads & generic media URLs
 */
export class MediaDownloader {
  constructor({ log } = {}) {
    this.log = log ?? logger().child({ module: 'downloader' });
  }

  detectPlatform(url) {
    const trimmed = String(url || '').trim();
    if (!trimmed) return 'generic';
    const u = trimmed.toLowerCase();
    if (/^spotify:(track|album|artist|playlist):/i.test(u)) return 'spotify';
    let host = '';
    try {
      if (/^https?:\/\//i.test(trimmed)) {
        host = new URL(trimmed).hostname.replace(/^www\./i, '').toLowerCase();
      }
    } catch {}
    const matchesDomain = (...domains) => {
      if (host) {
        return domains.some((d) => host === d || host.endsWith(`.${d}`));
      }
      return domains.some((d) => new RegExp(`(?:^|//|\\.)${d.replace(/\./g, '\\.')}(?:[/:?#]|$)`, 'i').test(u));
    };

    if (matchesDomain('tiktok.com', 'vt.tiktok.com', 'vm.tiktok.com')) return 'tiktok';
    if (matchesDomain('instagram.com')) return 'instagram';
    if (matchesDomain('pinterest.com', 'pin.it')) return 'pinterest';
    if (matchesDomain('youtube.com', 'youtu.be')) return 'youtube';
    if (matchesDomain('twitter.com', 'x.com')) return 'twitter';
    if (matchesDomain('facebook.com', 'fb.watch', 'fb.com')) return 'facebook';
    if (matchesDomain('capcut.com')) return 'capcut';
    if (matchesDomain('spotify.com', 'open.spotify.com', 'spotify.link', 'spoti.fi')) return 'spotify';
    if (matchesDomain('music.apple.com')) return 'applemusic';
    if (matchesDomain('audiomack.com')) return 'audiomack';
    if (matchesDomain('soundcloud.com', 'on.soundcloud.com')) return 'soundcloud';
    if (matchesDomain('threads.net', 'threads.com')) return 'threads';
    if (matchesDomain('xiaohongshu.com', 'xhslink.com')) return 'rednote';
    if (matchesDomain('reddit.com', 'redd.it')) return 'reddit';
    if (matchesDomain('spankbang.com')) return 'spankbang';
    if (matchesDomain('thenkiri.com', 'nkiri.com', 'nkiri.ink') || isThenkiriUrl(trimmed)) return 'thenkiri';
    if (matchesDomain('bilibili.com', 'b23.tv') || isBilibiliUrl(trimmed)) return 'bilibili';
    if (matchesDomain('justwatch.com') || isJustWatchUrl(trimmed)) return 'justwatch';
    if (matchesDomain('bsky.app')) return 'bluesky';
    if (matchesDomain('snapchat.com')) return 'snapchat';
    if (matchesDomain('twitch.tv', 'clips.twitch.tv')) return 'twitch';
    if (matchesDomain('kick.com')) return 'kick';
    if (matchesDomain('vimeo.com')) return 'vimeo';
    if (matchesDomain('dailymotion.com', 'dai.ly')) return 'dailymotion';
    if (matchesDomain('rumble.com')) return 'rumble';
    if (matchesDomain('bandcamp.com')) return 'bandcamp';
    if (matchesDomain('ok.ru')) return 'odnoklassniki';
    if (matchesDomain('vk.com', 'vk.ru')) return 'vk';
    if (matchesDomain('ted.com')) return 'ted';
    for (const p of SHORT_DRAMA_PLATFORMS) {
      if (host && host.includes(p)) return p;
    }
    try {
      const detected = socialDetectPlatform(trimmed);
      if (detected) return detected;
    } catch {}
    if (/\.(mp4|webm|mov|mkv)(\?|$)/i.test(u)) return 'direct-video';
    if (/\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(u)) return 'direct-photo';
    if (/\.(mp3|m4a|wav|ogg|opus)(\?|$)/i.test(u)) return 'direct-audio';
    if (!/^https?:\/\//i.test(trimmed)) return 'music-search';
    return 'generic';
  }

  /**
   * Main download function
   * @param {string} url - Target URL
   * @param {object} opts - { onProgress?: (status: string) => void }
   */
  async download(url, { onProgress } = {}) {
    let rawUrl = String(url || '').trim();
    if (!rawUrl) {
      throw new Error('Please provide a media link or song title to search ♡');
    }

    const uriMatch = rawUrl.match(/^spotify:(track|album|artist|playlist):([A-Za-z0-9]+)$/i);
    if (uriMatch) {
      rawUrl = `https://open.spotify.com/${uriMatch[1].toLowerCase()}/${uriMatch[2]}`;
    }

    const platform = this.detectPlatform(rawUrl);
    if (platform !== 'music-search' && !/^https?:\/\//i.test(rawUrl)) {
      throw new Error('Please provide a valid link starting with http:// or https:// ♡');
    }

    this.log.info({ url: rawUrl, platform }, 'download started');
    onProgress?.(`Detecting platform: ${platform.toUpperCase()} ♡`);

    if (SHORT_DRAMA_PLATFORMS.has(platform)) {
      return this.#downloadSocialDrama(rawUrl, { onProgress, platform });
    }

    switch (platform) {
      case 'tiktok':
        return this.#downloadTikTok(rawUrl, { onProgress });
      case 'pinterest':
        return this.#downloadPinterest(rawUrl, { onProgress });
      case 'instagram':
        return this.#downloadInstagram(rawUrl, { onProgress });
      case 'youtube':
        return this.#downloadYouTube(rawUrl, { onProgress });
      case 'twitter':
        return this.#downloadTwitter(rawUrl, { onProgress });
      case 'facebook':
        return this.#downloadFacebook(rawUrl, { onProgress });
      case 'capcut':
        return this.#downloadCapcut(rawUrl, { onProgress });
      case 'spotify':
        return this.#downloadSpotify(rawUrl, { onProgress });
      case 'applemusic':
        return this.#downloadAppleMusic(rawUrl, { onProgress });
      case 'audiomack':
        return this.#downloadAudiomack(rawUrl, { onProgress });
      case 'soundcloud':
        return this.#downloadSoundCloud(rawUrl, { onProgress });
      case 'threads':
        return this.#downloadThreads(rawUrl, { onProgress });
      case 'rednote':
        return this.#downloadRedNote(rawUrl, { onProgress });
      case 'thenkiri':
        return this.#downloadThenkiri(rawUrl, { onProgress });
      case 'bilibili':
        return this.#downloadBilibili(rawUrl, { onProgress });
      case 'justwatch':
        return this.#downloadJustWatch(rawUrl, { onProgress });
      case 'reddit':
        return this.#downloadReddit(rawUrl, { onProgress });
      case 'music-search':
        return this.#downloadMusicSearch(rawUrl, { onProgress });
      case 'spankbang':
        return this.#downloadSpankbang(rawUrl, { onProgress });
      case 'direct-video':
      case 'direct-photo':
      case 'direct-audio':
        return this.#downloadDirect(rawUrl, { onProgress });
      default:
        return this.#downloadUniversal(rawUrl, { onProgress, platform });
    }
  }

  /**
   * TikTok Downloader: Handles videos without watermark AND photo slideshows/albums + music!
   */
  async #downloadTikTok(url, { onProgress }) {
    onProgress?.('Fetching TikTok media from TikWM… ♡');
    const fetchTikwm = () => scheduleTikwmRequest(async () => {
      const res = await fetch('https://www.tikwm.com/api/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36',
          Referer: 'https://www.tikwm.com/'
        },
        body: new URLSearchParams({ url, hd: '1' }),
        signal: AbortSignal.timeout(15000)
      });
      return res.json().catch(() => null);
    });
    try {
      let json = await fetchTikwm();
      if (json?.code === -1 && /1 request\/second|rate.?limit|too many/i.test(json?.msg || '')) {
        await sleep(1350);
        json = await fetchTikwm();
      }

      if (json?.code === 0 && json.data) {
        const d = json.data;
        const title = d.title || 'TikTok Media';
        const author = d.author?.nickname || d.author?.unique_id || 'TikTok';
        const durationSeconds = Number(d.duration || d.music_info?.duration || 0) || null;
        const mediaItems = [];
        let audioTrack = null;

        // Check if photo album / carousel (TikTok photo slideshow)
        if (Array.isArray(d.images) && d.images.length > 0) {
          onProgress?.(`Downloading ${d.images.length} photos from TikTok album… ♡`);
          for (let i = 0; i < d.images.length; i++) {
            const imgUrl = d.images[i];
            try {
              const imgRes = await fetch(imgUrl, { signal: AbortSignal.timeout(10000) });
              if (imgRes.ok) {
                const buf = Buffer.from(await imgRes.arrayBuffer());
                mediaItems.push({
                  type: 'photo',
                  buffer: buf,
                  filename: `tiktok_${i + 1}.jpg`,
                  mimeType: 'image/jpeg'
                });
              }
            } catch (err) {
              this.log.debug({ err: err.message, index: i }, 'failed to fetch tiktok image slide');
            }
          }
        } else if (d.hdplay || d.play || d.wmplay) {
          // Video post
          onProgress?.('Downloading clean TikTok video… ♡');
          const videoUrl = d.hdplay || d.play || d.wmplay;
          const vidRes = await fetch(videoUrl, { signal: AbortSignal.timeout(30000) });
          if (vidRes.ok) {
            let vidBuf = Buffer.from(await vidRes.arrayBuffer());
            try {
              vidBuf = await optimizeVideoForTelegram(vidBuf) || vidBuf;
            } catch {}
            mediaItems.push({
              type: 'video',
              buffer: vidBuf,
              filename: 'tiktok_video.mp4',
              mimeType: 'video/mp4'
            });
          }
        }

        // Background sound / music extraction
        const musicUrl = d.music || d.music_info?.play;
        if (musicUrl) {
          onProgress?.('Extracting TikTok audio sound track… ♡');
          try {
            const musRes = await fetch(musicUrl, { signal: AbortSignal.timeout(15000) });
            if (musRes.ok) {
              const musBuf = Buffer.from(await musRes.arrayBuffer());
              if (musBuf.length > 1024) {
                audioTrack = {
                  buffer: musBuf,
                  filename: 'tiktok_sound.mp3',
                  title: d.music_info?.title || 'Original Sound',
                  performer: d.music_info?.author || author
                };
              }
            }
          } catch {}
        }

        // If audioTrack not fetched from URL but we have a video, extract via FFmpeg
        if (!audioTrack && mediaItems.length === 1 && mediaItems[0].type === 'video') {
          const extracted = await this.extractAudioFromBuffer(mediaItems[0].buffer);
          if (extracted) {
            audioTrack = {
              buffer: extracted,
              filename: 'tiktok_audio.mp3',
              title: title,
              performer: author
            };
          }
        }

        if (mediaItems.length > 0) {
          return {
            sourceUrl: url,
            platform: 'tiktok',
            title,
            author,
            durationSeconds,
            mediaItems,
            audioTrack
          };
        }
      }
    } catch (err) {
      this.log.debug({ err: err.message }, 'tikwm fetch failed, falling back to social-dl');
    }

    // Fallback 1: social-dl
    try {
      onProgress?.('Trying TikTok direct extractor… ♡');
      const info = await tiktokDl(url);
      if (Array.isArray(info?.images) && info.images.length > 0) {
        const mediaItems = [];
        for (let i = 0; i < info.images.length; i++) {
          try {
            const imgRes = await fetch(info.images[i], { signal: AbortSignal.timeout(10000) });
            if (imgRes.ok) {
              mediaItems.push({
                type: 'photo',
                buffer: Buffer.from(await imgRes.arrayBuffer()),
                filename: `tiktok_${i + 1}.jpg`,
                mimeType: 'image/jpeg'
              });
            }
          } catch {}
        }
        let audioTrack = null;
        if (info.music) {
          const musRes = await fetch(info.music, { signal: AbortSignal.timeout(15000) }).catch(() => null);
          if (musRes?.ok) {
            const musBuf = Buffer.from(await musRes.arrayBuffer());
            if (musBuf.length > 1024) {
              audioTrack = {
                buffer: musBuf,
                filename: 'tiktok_sound.mp3',
                title: info.title || 'Original Sound',
                performer: info.author || 'TikTok'
              };
            }
          }
        }
        if (mediaItems.length > 0) {
          return {
            sourceUrl: url,
            platform: 'tiktok',
            title: info.title || 'TikTok Photo Slideshow',
            author: info.author || 'TikTok',
            mediaItems,
            audioTrack
          };
        }
      }
      if (info?.video) {
        const vidRes = await fetch(info.video, { signal: AbortSignal.timeout(30000) });
        if (vidRes.ok) {
          let vidBuf = Buffer.from(await vidRes.arrayBuffer());
          try {
            vidBuf = await optimizeVideoForTelegram(vidBuf) || vidBuf;
          } catch {}
          let audioTrack = null;
          if (info.music) {
            const musRes = await fetch(info.music, { signal: AbortSignal.timeout(15000) }).catch(() => null);
            if (musRes?.ok) {
              const musBuf = Buffer.from(await musRes.arrayBuffer());
              if (musBuf.length > 1024) {
                audioTrack = {
                  buffer: musBuf,
                  filename: 'tiktok_sound.mp3',
                  title: info.title || 'Original Sound',
                  performer: info.author || 'TikTok'
                };
              }
            }
          }
          if (!audioTrack) {
            const extracted = await this.extractAudioFromBuffer(vidBuf);
            if (extracted) {
              audioTrack = {
                buffer: extracted,
                filename: 'tiktok_audio.mp3',
                title: info.title || 'TikTok Audio',
                performer: info.author || 'TikTok'
              };
            }
          }
          return {
            sourceUrl: url,
            platform: 'tiktok',
            title: info.title || 'TikTok Video',
            author: info.author || 'TikTok',
            mediaItems: [{
              type: 'video',
              buffer: vidBuf,
              filename: 'tiktok_video.mp4',
              mimeType: 'video/mp4'
            }],
            audioTrack
          };
        }
      }
    } catch (err) {
      this.log.debug({ err: err.message }, 'social-dl tiktok failed, falling back to universal');
    }

    // Fallback 2: universal downloader
    return this.#downloadUniversal(url, { onProgress, platform: 'tiktok' });
  }

  /**
   * Pinterest Downloader: HD original photos, videos, carousel albums, idea pins, pin.it links
   */
  async #downloadPinterest(url, { onProgress }) {
    onProgress?.('Resolving Pinterest pin media… ♡');
    try {
      // 1. Follow any redirects (e.g. pin.it)
      const headRes = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000)
      });
      let resolvedUrl = headRes.url;
      if (/show_error=true/i.test(resolvedUrl)) {
        throw new Error('Pinterest pin not found or removed by creator.');
      }
      const pinIdMatch = resolvedUrl.match(/pin\/(\d+)/);
      const pinId = pinIdMatch ? pinIdMatch[1] : null;

      let html = await headRes.text();

      // If redirected to an invite/sent page, fetch the clean canonical pin page directly
      if (pinId && (resolvedUrl.includes('/sent/') || !html.includes('window.__PWS_RELAY_REGISTER_COMPLETED_REQUEST__('))) {
        const cleanUrl = `https://www.pinterest.com/pin/${pinId}/`;
        try {
          const cleanRes = await fetch(cleanUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            signal: AbortSignal.timeout(15000)
          });
          if (cleanRes.ok) {
            resolvedUrl = cleanUrl;
            html = await cleanRes.text();
          }
        } catch {}
      }

      const mediaItems = [];
      let audioTrack = null;
      let title = 'Pinterest Pin';

      const ogTitle = html.match(/<meta property="og:title" content="([^"]+)"/i)?.[1];
      if (ogTitle) {
        title = ogTitle.replace(/\s*\|\s*Pinterest.*$/i, '').trim();
      }

      let videoUrl = null;
      const imageUrls = [];

      // 2. Parse Pinterest Relay Completed Request JSON (modern web architecture)
      const relayMarker = 'window.__PWS_RELAY_REGISTER_COMPLETED_REQUEST__(';
      let searchIdx = 0;
      while ((searchIdx = html.indexOf(relayMarker, searchIdx)) !== -1) {
        const after = html.slice(searchIdx + relayMarker.length);
        const firstComma = after.indexOf(',');
        if (firstComma !== -1) {
          const secondArg = after.slice(firstComma + 1).trim();
          let depth = 0;
          let endIdx = -1;
          for (let i = 0; i < secondArg.length; i++) {
            if (secondArg[i] === '{') depth++;
            else if (secondArg[i] === '}') {
              depth--;
              if (depth === 0) { endIdx = i + 1; break; }
            }
          }
          if (endIdx !== -1) {
            try {
              const parsed = JSON.parse(secondArg.slice(0, endIdx));
              const pin = parsed?.data?.v3GetPinQueryv2?.data || parsed?.data?.pin;
              if (pin) {
                if (pin.title || pin.gridTitle) {
                  title = (pin.title || pin.gridTitle).trim();
                }

                // Video extraction
                if (pin.videos?.videoList) {
                  const vList = pin.videos.videoList;
                  const vBest = vList.v720P?.url || vList.vEXP3?.url || vList.vEXP2?.url || Object.values(vList).find((v) => v?.url && /\.mp4(?:[?&]|$)/i.test(v.url))?.url;
                  if (vBest) videoUrl = vBest;
                }
                if (!videoUrl && Array.isArray(pin.videos?.videoUrls)) {
                  videoUrl = pin.videos.videoUrls.find((u) => /\.mp4(?:[?&]|$)/i.test(u)) || null;
                }

                // Carousel / Album extraction (supports both camelCase and snake_case)
                const carouselSlots = pin.carouselData?.carouselSlots || pin.carousel_data?.carousel_slots;
                if (Array.isArray(carouselSlots) && carouselSlots.length > 0) {
                  for (const slot of carouselSlots) {
                    const img = slot.images_orig?.url
                      || slot.images?.orig?.url
                      || (slot.imageSignature ? `https://i.pinimg.com/originals/${slot.imageSignature.slice(0, 2)}/${slot.imageSignature.slice(2, 4)}/${slot.imageSignature.slice(4, 6)}/${slot.imageSignature}.jpg` : null)
                      || (slot.image_signature ? `https://i.pinimg.com/originals/${slot.image_signature.slice(0, 2)}/${slot.image_signature.slice(2, 4)}/${slot.image_signature.slice(4, 6)}/${slot.image_signature}.jpg` : null)
                      || slot.images_1200x?.url
                      || slot.images?.['1200x']?.url
                      || slot.images_736x?.url
                      || slot.images?.['736x']?.url;
                    if (img && !imageUrls.includes(img)) {
                      imageUrls.push(img);
                    }
                  }
                }

                // Story / Idea Pin extraction
                const storyPages = pin.storyPinData?.pages || pin.story_pin_data?.pages;
                if (Array.isArray(storyPages) && storyPages.length > 0) {
                  for (const page of storyPages) {
                    const img = page.image?.images?.originals?.url
                      || page.image?.images?.orig?.url
                      || page.image?.images?.['736x']?.url;
                    if (img && !imageUrls.includes(img)) imageUrls.push(img);
                    const vid = page.video?.video_list?.V_720P?.url || page.video?.video_list?.V_EXP3?.url;
                    if (vid && !videoUrl) videoUrl = vid;
                  }
                }

                // Single photo pin
                if (!videoUrl && imageUrls.length === 0) {
                  const orig = pin.images_orig?.url || pin.imageLargeUrl || pin.images_736x?.url;
                  if (orig) imageUrls.push(orig);
                }
              }
            } catch {}
          }
        }
        searchIdx += relayMarker.length;
      }

      // 2b. Fallback to Pinterest SSR state (__PWS_DATA__ or __PWS_INITIAL_PROPS__)
      if (!videoUrl && imageUrls.length === 0) {
        const pwsMatch = html.match(/<script id="(?:__PWS_DATA__|__PWS_INITIAL_PROPS__)"[^>]*>([\s\S]*?)<\/script>/i);
        if (pwsMatch?.[1]) {
          try {
            const pwsData = JSON.parse(pwsMatch[1]);
            const pins = pwsData?.props?.initialReduxState?.pins || pwsData?.initialReduxState?.pins;
            if (pins) {
              const pin = Object.values(pins)[0];
              if (pin) {
                if (pin.title || pin.gridTitle) title = (pin.title || pin.gridTitle).trim();
                const carouselSlots = pin.carouselData?.carouselSlots || pin.carousel_data?.carousel_slots;
                if (Array.isArray(carouselSlots) && carouselSlots.length > 0) {
                  for (const slot of carouselSlots) {
                    const img = slot.images_orig?.url
                      || slot.images?.orig?.url
                      || slot.images_1200x?.url
                      || slot.images?.['1200x']?.url
                      || slot.images_736x?.url
                      || slot.images?.['736x']?.url;
                    if (img && !imageUrls.includes(img)) imageUrls.push(img);
                  }
                }
                const storyPages = pin.storyPinData?.pages || pin.story_pin_data?.pages;
                if (Array.isArray(storyPages) && storyPages.length > 0) {
                  for (const page of storyPages) {
                    const img = page.image?.images?.originals?.url || page.image?.images?.orig?.url || page.image?.images?.['736x']?.url;
                    if (img && !imageUrls.includes(img)) imageUrls.push(img);
                  }
                }
                if (imageUrls.length === 0) {
                  const orig = pin.images_orig?.url || pin.images?.orig?.url || pin.images_736x?.url;
                  if (orig) imageUrls.push(orig);
                }
              }
            }
          } catch {}
        }
      }

      // 3. Fallback Video Regex
      if (!videoUrl) {
        const vMatches = html.match(/https:\/\/(?:v\d+|v)\.pinimg\.com\/videos\/[^\s"'\\]+\.mp4/g);
        if (vMatches?.length) videoUrl = vMatches[0];
      }

      // 4. Fallback Image Regex (Clean 32-hex character hash, ignoring UI button icons)
      if (!videoUrl && imageUrls.length === 0) {
        const origMatches = html.match(/https:\/\/i\.pinimg\.com\/originals\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{32}\.(jpg|png|webp)/g) || [];
        for (const u of new Set(origMatches)) {
          imageUrls.push(u);
        }
        if (imageUrls.length === 0) {
          const medMatches = html.match(/https:\/\/i\.pinimg\.com\/736x\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{32}\.(jpg|png|webp)/g) || [];
          if (medMatches.length) imageUrls.push(medMatches[0]);
        }
      }

      // 5. Deliver Video Pin
      if (videoUrl) {
        onProgress?.('Downloading Pinterest HD video… ♡');
        const vRes = await fetch(videoUrl, { signal: AbortSignal.timeout(30000) });
        if (vRes.ok) {
          let vBuf = Buffer.from(await vRes.arrayBuffer());
          try {
            vBuf = await optimizeVideoForTelegram(vBuf) || vBuf;
          } catch {}
          mediaItems.push({
            type: 'video',
            buffer: vBuf,
            filename: 'pinterest_video.mp4',
            mimeType: 'video/mp4'
          });
          const extAudio = await this.extractAudioFromBuffer(vBuf);
          if (extAudio) {
            audioTrack = {
              buffer: extAudio,
              filename: 'pinterest_audio.mp3',
              title,
              performer: 'Pinterest'
            };
          }
        }
      }

      // 6. Deliver Album / Images Pin
      if (mediaItems.length === 0 && imageUrls.length > 0) {
        onProgress?.(`Downloading ${imageUrls.length} Pinterest photo(s)… ♡`);
        for (let i = 0; i < Math.min(imageUrls.length, 30); i++) {
          let buf = null;
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const imgRes = await fetch(imageUrls[i], { signal: AbortSignal.timeout(15000) });
              if (imgRes.ok) {
                buf = Buffer.from(await imgRes.arrayBuffer());
                break;
              }
            } catch (err) {
              this.log.debug({ err: err.message, index: i, attempt }, 'failed to fetch pinterest image');
            }
          }
          if (buf) {
            mediaItems.push({
              type: 'photo',
              buffer: buf,
              filename: `pinterest_${i + 1}.jpg`,
              mimeType: 'image/jpeg'
            });
          }
        }
      }

      if (mediaItems.length > 0) {
        let isMatchingPfp = Boolean(
          /matching\s*(?:pfp|icons?|avatars?|profile|couple|duo|pair)|couple\s*(?:pfp|icons?|avatar)|bestie\s*(?:pfp|icons?)|pfp\s*matching|trio\s*pfp/i.test(title) ||
          /matching\s*(?:pfp|icons?|avatars?|profile|couple|duo|pair)|couple\s*(?:pfp|icons?|avatar)|bestie\s*(?:pfp|icons?)|pfp\s*matching|trio\s*pfp/i.test(url) ||
          (mediaItems.length >= 2 && mediaItems.length <= 4 && !videoUrl && /pfp|icon|avatar|profile/i.test(title))
        );

        // Smart collage split: if a single photo was downloaded and title/URL hints at matching or photo is split 2-in-1
        if (mediaItems.length === 1 && mediaItems[0].type === 'photo' && !videoUrl) {
          const splitParts = await splitMatchingCollage(mediaItems[0].buffer);
          if (splitParts.length >= 2) {
            mediaItems = splitParts.map((buf, i) => ({
              type: 'photo',
              buffer: buf,
              filename: `pinterest_matching_${i + 1}.jpg`,
              mimeType: 'image/jpeg'
            }));
            isMatchingPfp = true;
          }
        }

        return {
          sourceUrl: resolvedUrl,
          platform: 'pinterest',
          title,
          author: 'Pinterest',
          mediaItems,
          audioTrack,
          isMatchingPfp
        };
      }
    } catch (err) {
      this.log.warn({ err: err.message }, 'pinterest custom extractor failed, trying social-dl');
    }

    // Fallback to social-dl
    try {
      onProgress?.('Trying Pinterest direct downloader… ♡');
      const pRes = await pinterestDl(url);
      if (Array.isArray(pRes?.images) && pRes.images.length > 0) {
        const mediaItems = [];
        for (let i = 0; i < pRes.images.length; i++) {
          try {
            const imgRes = await fetch(pRes.images[i], { signal: AbortSignal.timeout(15000) });
            if (imgRes.ok) {
              mediaItems.push({
                type: 'photo',
                buffer: Buffer.from(await imgRes.arrayBuffer()),
                filename: `pinterest_${i + 1}.jpg`,
                mimeType: 'image/jpeg'
              });
            }
          } catch {}
        }
        if (mediaItems.length > 0) {
          return {
            sourceUrl: url,
            platform: 'pinterest',
            title: pRes.title || 'Pinterest Pin',
            author: 'Pinterest',
            mediaItems,
            audioTrack: null
          };
        }
      }
      if (pRes?.formats?.length) {
        const best = pRes.formats[0];
        const res = await fetch(best.url, { signal: AbortSignal.timeout(30000) });
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          const isVid = best.type === 'mp4' || /\.mp4(?:[?&]|$)/i.test(best.url);
          let audioTrack = null;
          if (isVid) {
            const extAudio = await this.extractAudioFromBuffer(buf);
            if (extAudio) {
              audioTrack = {
                buffer: extAudio,
                filename: 'pinterest_audio.mp3',
                title: pRes.title || 'Pinterest Audio',
                performer: 'Pinterest'
              };
            }
          }
          return {
            sourceUrl: url,
            platform: 'pinterest',
            title: pRes.title || 'Pinterest Pin',
            author: 'Pinterest',
            mediaItems: [{
              type: isVid ? 'video' : 'photo',
              buffer: buf,
              filename: `pinterest_${isVid ? 'video.mp4' : 'photo.jpg'}`,
              mimeType: isVid ? 'video/mp4' : 'image/jpeg'
            }],
            audioTrack
          };
        }
      }
    } catch {}

    return this.#downloadUniversal(url, { onProgress, platform: 'pinterest' });
  }

  isInstagramProfileUrl(url) {
    try {
      const u = new URL(String(url || '').trim());
      const host = u.hostname.toLowerCase().replace(/^www\./, '');
      if (!host.endsWith('instagram.com')) return null;
      const pathParts = u.pathname.split('/').filter(Boolean);
      if (pathParts.length === 1) {
        const first = pathParts[0].toLowerCase();
        const nonUserRoutes = ['p', 'reel', 'reels', 'tv', 'stories', 'share', 'explore', 'direct', 'accounts', 'developer', 'about', 'legal'];
        if (!nonUserRoutes.includes(first)) {
          return pathParts[0];
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Instagram Downloader: Reels, posts, carousel albums, stories + music!
   */
  async #downloadInstagram(url, { onProgress }) {
    const profileUser = this.isInstagramProfileUrl(url);
    if (profileUser) {
      throw new Error(
        `🌸 Instagram profile link detected (@${profileUser}) ♡\n` +
        `This is a link to an Instagram account profile rather than a specific Post, Reel, or Video.\n\n` +
        `✨ How to download from this account:\n` +
        `1. Open @${profileUser} on Instagram\n` +
        `2. Tap the specific Reel or Post you want to download\n` +
        `3. Tap ↗️ Share ➔ Copy Link\n` +
        `4. Send it here to download the full HD video, photos & audio track! ♡`
      );
    }

    onProgress?.('Fetching Instagram media… ♡');

    // Layer 1: btch-downloader igdl
    try {
      const btch = await import('btch-downloader');
      if (typeof btch.igdl === 'function') {
        const res = await btch.igdl(url);
        if (res?.status && Array.isArray(res.result) && res.result.length > 0) {
          onProgress?.(`Downloading ${res.result.length} Instagram item(s)… ♡`);
          const mediaItems = [];
          let audioTrack = null;

          for (let i = 0; i < res.result.length; i++) {
            const item = res.result[i];
            const itemUrl = item.url || item.link;
            if (!itemUrl) continue;
            try {
              const r = await fetch(itemUrl, { signal: AbortSignal.timeout(20000) });
              if (r.ok) {
                let buf = Buffer.from(await r.arrayBuffer());
                const isVid = item.type === 'video' || /\.(mp4|mov|webm)/i.test(itemUrl);
                if (isVid) {
                  try {
                    buf = await optimizeVideoForTelegram(buf) || buf;
                  } catch {}
                }
                mediaItems.push({
                  type: isVid ? 'video' : 'photo',
                  buffer: buf,
                  filename: `instagram_${i + 1}.${isVid ? 'mp4' : 'jpg'}`,
                  mimeType: isVid ? 'video/mp4' : 'image/jpeg'
                });
                if (isVid && !audioTrack) {
                  const extAudio = await this.extractAudioFromBuffer(buf);
                  if (extAudio) {
                    audioTrack = {
                      buffer: extAudio,
                      filename: 'instagram_audio.mp3',
                      title: 'Instagram Sound',
                      performer: 'Instagram'
                    };
                  }
                }
              }
            } catch (err) {
              this.log.debug({ err: err.message, index: i }, 'failed to download instagram item');
            }
          }

          if (mediaItems.length > 0) {
            return {
              sourceUrl: url,
              platform: 'instagram',
              title: 'Instagram Post',
              author: 'Instagram',
              mediaItems,
              audioTrack
            };
          }
        }
      }
    } catch (err) {
      this.log.debug({ err: err.message }, 'btch igdl failed');
    }

    // Layer 2: social-dl instagramDl (reels, posts & multi-photo carousels)
    try {
      onProgress?.('Trying Instagram direct extractor… ♡');
      const igInfo = await instagramDl(url);
      if (igInfo) {
        const mediaItems = [];
        let audioTrack = null;
        if (Array.isArray(igInfo.images) && igInfo.images.length > 0) {
          for (let i = 0; i < igInfo.images.length; i++) {
            try {
              const imgRes = await fetch(igInfo.images[i], { signal: AbortSignal.timeout(15000) });
              if (imgRes.ok) {
                mediaItems.push({
                  type: 'photo',
                  buffer: Buffer.from(await imgRes.arrayBuffer()),
                  filename: `instagram_${i + 1}.jpg`,
                  mimeType: 'image/jpeg'
                });
              }
            } catch {}
          }
        } else if (Array.isArray(igInfo.formats) && igInfo.formats.length > 0) {
          const vidUrl = igInfo.formats[0]?.url;
          if (vidUrl) {
            const vidRes = await fetch(vidUrl, { signal: AbortSignal.timeout(30000) });
            if (vidRes.ok) {
              let buf = Buffer.from(await vidRes.arrayBuffer());
              try { buf = await optimizeVideoForTelegram(buf) || buf; } catch {}
              mediaItems.push({ type: 'video', buffer: buf, filename: 'instagram_video.mp4', mimeType: 'video/mp4' });
              const extAudio = await this.extractAudioFromBuffer(buf);
              if (extAudio) {
                audioTrack = {
                  buffer: extAudio,
                  filename: 'instagram_audio.mp3',
                  title: igInfo.title || 'Instagram Sound',
                  performer: igInfo.author || 'Instagram'
                };
              }
            }
          }
        }
        if (mediaItems.length > 0) {
          return {
            sourceUrl: url,
            platform: 'instagram',
            title: igInfo.title || 'Instagram Post',
            author: igInfo.author || 'Instagram',
            mediaItems,
            audioTrack
          };
        }
      }
    } catch (err) {
      this.log.debug({ err: err.message }, 'social-dl instagramDl failed');
    }

    // Layer 3: yt-dlp fallback
    return this.#downloadUniversal(url, { onProgress, platform: 'instagram' });
  }

  /**
   * Twitter / X Downloader: Videos, single and multi-image tweets!
   */
  async #downloadTwitter(url, { onProgress }) {
    onProgress?.('Fetching Twitter/X media… ♡');

    // Try fxtwitter API
    try {
      const tweetId = url.match(/status\/(\d+)/i)?.[1];
      if (tweetId) {
        const fxRes = await fetch(`https://api.fxtwitter.com/status/${tweetId}`, {
          signal: AbortSignal.timeout(10000)
        });
        const fxJson = await fxRes.json().catch(() => null);
        const tweet = fxJson?.tweet;

        if (tweet && Array.isArray(tweet.media?.all) && tweet.media.all.length > 0) {
          const mediaList = tweet.media.all;
          onProgress?.(`Downloading ${mediaList.length} media item(s) from X… ♡`);
          const mediaItems = [];
          let audioTrack = null;

          for (let i = 0; i < mediaList.length; i++) {
            const item = mediaList[i];
            const itemUrl = item.url;
            if (!itemUrl) continue;
            try {
              const r = await fetch(itemUrl, { signal: AbortSignal.timeout(20000) });
              if (r.ok) {
                const buf = Buffer.from(await r.arrayBuffer());
                const isVid = item.type === 'video' || item.type === 'gif';
                mediaItems.push({
                  type: isVid ? 'video' : 'photo',
                  buffer: buf,
                  filename: `twitter_${i + 1}.${isVid ? 'mp4' : 'jpg'}`,
                  mimeType: isVid ? 'video/mp4' : 'image/jpeg'
                });
                if (isVid && !audioTrack) {
                  const extAudio = await this.extractAudioFromBuffer(buf);
                  if (extAudio) {
                    audioTrack = {
                      buffer: extAudio,
                      filename: 'twitter_audio.mp3',
                      title: tweet.text ? tweet.text.slice(0, 40) : 'X Audio',
                      performer: tweet.author?.name || 'X'
                    };
                  }
                }
              }
            } catch (err) {
              this.log.debug({ err: err.message, index: i }, 'failed to fetch x item');
            }
          }

          if (mediaItems.length > 0) {
            return {
              sourceUrl: url,
              platform: 'twitter',
              title: tweet.text ? tweet.text.slice(0, 60) : 'Twitter / X Media',
              author: tweet.author?.name || 'X',
              mediaItems,
              audioTrack
            };
          }
        }
      }
    } catch (err) {
      this.log.debug({ err: err.message }, 'fxtwitter failed');
    }

    return this.#downloadUniversal(url, { onProgress, platform: 'twitter' });
  }

  /**
   * YouTube & YouTube Shorts Downloader: HD video + MP3 sound track!
   */
  async #downloadYouTube(url, { onProgress }) {
    onProgress?.('Downloading YouTube video with yt-dlp… ♡');
    return this.#downloadUniversal(url, { onProgress, platform: 'youtube', isYouTube: true });
  }

  /**
   * Facebook Downloader: Reels & Video Posts
   */
  async #downloadFacebook(url, { onProgress }) {
    onProgress?.('Fetching Facebook video… ♡');
    try {
      const res = await facebookDl(url);
      if (res?.formats?.length) {
        const best = res.formats[0];
        const vidRes = await fetch(best.url, { signal: AbortSignal.timeout(30000) });
        if (vidRes.ok) {
          const buf = Buffer.from(await vidRes.arrayBuffer());
          const extAudio = await this.extractAudioFromBuffer(buf);
          return {
            sourceUrl: url,
            platform: 'facebook',
            title: res.title || 'Facebook Video',
            author: res.author || 'Facebook',
            mediaItems: [{
              type: 'video',
              buffer: buf,
              filename: 'facebook_video.mp4',
              mimeType: 'video/mp4'
            }],
            audioTrack: extAudio ? {
              buffer: extAudio,
              filename: 'facebook_audio.mp3',
              title: res.title || 'Facebook Audio',
              performer: 'Facebook'
            } : null
          };
        }
      }
    } catch (err) {
      this.log.debug({ err: err.message }, 'facebookDl failed, trying universal');
    }
    return this.#downloadUniversal(url, { onProgress, platform: 'facebook' });
  }

  /**
   * CapCut Downloader: Templates & Videos
   */
  async #downloadCapcut(url, { onProgress }) {
    onProgress?.('Fetching CapCut video template… ♡');
    try {
      const res = await capcutDl(url);
      if (res?.formats?.length) {
        const best = res.formats[0];
        const vidRes = await fetch(best.url, { signal: AbortSignal.timeout(30000) });
        if (vidRes.ok) {
          const buf = Buffer.from(await vidRes.arrayBuffer());
          const extAudio = await this.extractAudioFromBuffer(buf);
          return {
            sourceUrl: url,
            platform: 'capcut',
            title: res.title || 'CapCut Video',
            author: 'CapCut',
            mediaItems: [{
              type: 'video',
              buffer: buf,
              filename: 'capcut_video.mp4',
              mimeType: 'video/mp4'
            }],
            audioTrack: extAudio ? {
              buffer: extAudio,
              filename: 'capcut_audio.mp3',
              title: res.title || 'CapCut Audio',
              performer: 'CapCut'
            } : null
          };
        }
      }
    } catch (err) {
      this.log.debug({ err: err.message }, 'capcutDl failed, trying universal');
    }
    return this.#downloadUniversal(url, { onProgress, platform: 'capcut' });
  }

  /**
   * Fast CBR 192k MP3 re-encoding / stream copy with clean ID3v2.3 tags
   * Strips bloated descriptions and ensures instant 0ms playback in mobile ExoPlayer / Telegram
   */
  async #optimizeAudioToCbrMp3(input, { title = '', artist = '', album = '', year = '' } = {}) {
    const tempDir = join(tmpdir(), `lancy_cbr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
    mkdirSync(tempDir, { recursive: true });

    let inPath;
    let isAlreadyMp3 = false;
    if (typeof input === 'string') {
      inPath = input;
      // Verify magic bytes so non-MP3 streams (e.g. M4A/AAC saved as .mp3) are transcoded rather than stream-copied
      isAlreadyMp3 = isMp3FileByMagic(inPath);
    } else if (Buffer.isBuffer(input)) {
      inPath = join(tempDir, 'input_raw');
      writeFileSync(inPath, input);
      isAlreadyMp3 = isMp3HeaderBuffer(input);
    } else {
      return input;
    }

    const ffmpegBin = resolveFfmpegPath() || 'ffmpeg';
    const outPath = join(tempDir, 'optimized.mp3');
    try {
      const cleaned = cleanSongMetadata(title, artist);
      let optTitle = cleaned.title || title || 'Audio Track';
      if (optTitle.length > 45) {
        optTitle = `${optTitle.slice(0, 42).trim()}…`;
      }
      const optArtist = cleaned.artist || artist || 'Spotify';

      const audioCodecArgs = isAlreadyMp3
        ? ['-c:a', 'copy']
        : ['-c:a', 'libmp3lame', '-b:a', '192k', '-compression_level', '7', '-ar', '44100'];

      const ffArgs = [
        '-y',
        '-i', inPath,
        '-map_metadata', '-1',
        ...audioCodecArgs,
        '-id3v2_version', '3',
        '-metadata', `title=${optTitle}`,
        '-metadata', `artist=${optArtist}`,
        ...(album ? ['-metadata', `album=${album}`] : []),
        ...(year ? ['-metadata', `date=${year}`] : []),
        outPath
      ];
      try {
        await getSharedMediaWorkerPool().execInWorker(ffmpegBin, ffArgs, { timeout: 30000 });
      } catch {
        await execFileAsync(ffmpegBin, ffArgs, { timeout: 30000 });
      }

      if (existsSync(outPath) && statSync(outPath).size > 1000) {
        return readFileSync(outPath);
      }
    } catch (err) {
      this.log.warn({ err: err.message }, 'Failed to optimize audio with ffmpeg, using original');
    } finally {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }

    return Buffer.isBuffer(input) ? input : (existsSync(input) ? readFileSync(input) : null);
  }

  /**
   * Shared helper: resolve full audio track matching metadata (title/artist/duration)
   * and normalize to CBR 192k MP3 with ID3v2 tags + artwork.
   */
  async #resolveAndOptimizeTrack({
    sourceUrl,
    platform = 'spotify',
    title = 'Audio Track',
    artist = '',
    album = '',
    year = '',
    duration = '',
    expectedDurationSec = 0,
    coverBuf = null,
    onProgress
  }) {
    const ffmpegBin = resolveFfmpegPath() || 'ffmpeg';
    const cookieArgs = getCookieArgs();
    const primaryArtist = (artist || '').split(/[,&]/)[0].trim();
    const cleanTitle = (title || '').replace(/\(.*?\)/g, '').replace(/\[.*?\]/g, '').trim();

    const candidateQueries = [
      `${primaryArtist} ${cleanTitle}`,
      `${artist} ${cleanTitle}`,
      `${title} ${artist}`,
      `${cleanTitle} official audio`
    ]
      .map((q) => q.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim())
      .filter((q, i, arr) => q && arr.indexOf(q) === i);

    onProgress?.(`Finding full audio match for "${title}"… ♡`);

    for (const query of candidateQueries) {
      const tempDir = join(tmpdir(), `lancy_trk_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
      mkdirSync(tempDir, { recursive: true });
      try {
        let downloaded = false;

        // 1. Multi-source resolver (InnerTube scored NG/US -> JioSaavn 320k -> Audius)
        try {
          const { resolveAndDownloadAudio } = await import('./musicResolver.js');
          const resolvedPath = join(tempDir, 'resolved.mp3');
          const resolved = await resolveAndDownloadAudio({
            query,
            trackId: null,
            tempPath: resolvedPath,
            ffmpegPath: ffmpegBin,
            minSeconds: 45,
            meta: { title, artist: artist || 'Music' },
            skipYouTube: false,
            onProgress
          });
          if (resolved.ok && existsSync(resolvedPath) && statSync(resolvedPath).size > 20000) {
            downloaded = true;
          }
        } catch (rErr) {
          this.log?.debug?.({ err: rErr.message, query }, 'track resolver attempt failed');
        }

        // 2. Duration-aware InnerTube candidate fallback
        if (!downloaded) {
          try {
            const fastVids = await searchYouTubeFast(query, 'NG', { wide: true });
            const filtered = expectedDurationSec > 45
              ? fastVids.filter((v) => {
                  const d = parseDurationToSeconds(v.duration);
                  return !d || Math.abs(d - expectedDurationSec) <= Math.max(25, expectedDurationSec * 0.25);
                })
              : fastVids;
            const pool = filtered.length ? filtered : fastVids;
            const bestCandidate = rankYouTubeAudioCandidates(
              pool,
              query.toLowerCase().split(/\s+/).filter(Boolean),
              { clean: query }
            );
            if (bestCandidate?.videoId) {
              await execFileAsync('yt-dlp', [
                '--no-warnings',
                '--no-playlist',
                '--ffmpeg-location', ffmpegBin,
                ...cookieArgs,
                '-N', '4',
                '--max-filesize', '48M',
                '--js-runtimes', 'node:/usr/bin/node',
                '-f', 'ba[ext=m4a]/ba/b',
                '-x',
                '--audio-format', 'mp3',
                '--audio-quality', '2',
                '-o', join(tempDir, '%(title).60s.%(ext)s'),
                `https://www.youtube.com/watch?v=${bestCandidate.videoId}`
              ], { timeout: 45000 });
              const foundAudio = readdirSync(tempDir).find((f) => /\.(mp3|m4a|webm|opus|ogg|wav)$/i.test(f));
              if (foundAudio) {
                const dur = await getAudioDurationSeconds(join(tempDir, foundAudio));
                if (dur && dur >= 45) downloaded = true;
              }
            }
          } catch {}
        }

        // 3. Direct yt-dlp search fallback
        if (!downloaded) {
          try {
            await execFileAsync('yt-dlp', [
              '--no-warnings',
              '--no-playlist',
              '--ffmpeg-location', ffmpegBin,
              ...cookieArgs,
              '-N', '4',
              '--max-filesize', '48M',
              '--js-runtimes', 'node:/usr/bin/node',
              '-f', 'ba[ext=m4a]/ba/b',
              '-x',
              '--audio-format', 'mp3',
              '--audio-quality', '2',
              '-o', join(tempDir, '%(title).60s.%(ext)s'),
              `ytsearch1:${query}`
            ], { timeout: 45000 });
            const foundAudio = readdirSync(tempDir).find((f) => /\.(mp3|m4a|webm|opus|ogg|wav)$/i.test(f));
            if (foundAudio) {
              const dur = await getAudioDurationSeconds(join(tempDir, foundAudio));
              if (dur && dur >= 45) downloaded = true;
            }
          } catch {}
        }

        const audioFile = readdirSync(tempDir).find((f) => /\.(mp3|m4a|webm|opus|ogg|wav)$/i.test(f));
        if (audioFile) {
          const fullAudioPath = join(tempDir, audioFile);
          const durSec = await getAudioDurationSeconds(fullAudioPath);
          if (durSec && durSec < 45) continue;
          const audioBuf = await this.#optimizeAudioToCbrMp3(fullAudioPath, { title, artist, album, year });
          const mediaItems = coverBuf ? [{ type: 'photo', buffer: coverBuf, filename: 'cover.jpg', mimeType: 'image/jpeg' }] : [];
          const durString = durSec ? `${Math.floor(durSec / 60)}:${String(Math.floor(durSec % 60)).padStart(2, '0')}` : duration;
          return {
            sourceUrl,
            platform,
            title,
            artist,
            author: artist || platform.toUpperCase(),
            album,
            year,
            duration: durString,
            mediaItems,
            audioTrack: {
              buffer: audioBuf,
              filename: `${title.replace(/[^\w\s-]/g, '') || 'track'}.mp3`,
              title,
              performer: artist || platform.toUpperCase(),
              album,
              year,
              duration: durSec || expectedDurationSec || undefined
            }
          };
        }
      } catch (err) {
        this.log.debug({ err: err.message, query }, 'candidate query search failed');
      } finally {
        try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
      }
    }

    throw new Error(`Could not download full audio track for "${title}". Please verify the link/title or try another song ♡`);
  }

  /**
   * Fetch image gallery or video URLs with headers + optional audio extraction.
   */
  async #collectMediaFromUrls({
    sourceUrl,
    platform,
    title,
    author,
    images = [],
    videoUrl = null,
    headers = {},
    optimizeVideo = false
  }) {
    const mediaItems = [];
    let audioTrack = null;

    if (videoUrl) {
      const vidRes = await fetch(videoUrl, { headers, signal: AbortSignal.timeout(45000) });
      if (vidRes.ok) {
        let buf = Buffer.from(await vidRes.arrayBuffer());
        if (optimizeVideo) {
          try { buf = await optimizeVideoForTelegram(buf) || buf; } catch {}
        }
        if (buf.length > 4096) {
          mediaItems.push({ type: 'video', buffer: buf, filename: `${platform}_video.mp4`, mimeType: 'video/mp4' });
          const extAudio = await this.extractAudioFromBuffer(buf);
          if (extAudio) {
            audioTrack = {
              buffer: extAudio,
              filename: `${platform}_audio.mp3`,
              title: title || `${platform} Audio`,
              performer: author || platform
            };
          }
        }
      }
    }

    if (mediaItems.length === 0 && Array.isArray(images) && images.length > 0) {
      for (let i = 0; i < Math.min(images.length, 30); i++) {
        try {
          const r = await fetch(images[i], { headers, signal: AbortSignal.timeout(15000) });
          if (r.ok) {
            const buf = Buffer.from(await r.arrayBuffer());
            if (buf.length > 1024) {
              mediaItems.push({
                type: 'photo',
                buffer: buf,
                filename: `${platform}_${i + 1}.jpg`,
                mimeType: 'image/jpeg'
              });
            }
          }
        } catch {}
      }
    }

    if (mediaItems.length === 0) return null;
    return { sourceUrl, platform, title, author, mediaItems, audioTrack };
  }

  /**
   * Spotify Downloader: Supports Tracks, Albums, Playlists & Artists (via social-dl@1.4.3 spotifyMetadata + fallbacks)
   */
  async #downloadSpotify(url, { onProgress }) {
    onProgress?.('Fetching Spotify metadata… ♡');
    let title = 'Spotify Track';
    let artist = '';
    let album = '';
    let year = '';
    let duration = '';
    let expectedDurationSec = 0;
    let coverBuf = null;
    let spMeta = null;

    // 1. Structured Spotify metadata from social-dl (handles spotify.link, spoti.fi, track/album/playlist/artist)
    try {
      spMeta = await spotifyMetadata(url);
      if (spMeta) {
        if (spMeta.title) title = spMeta.title;
        if (spMeta.artist || spMeta.author) artist = spMeta.artist || spMeta.author;
        if (spMeta.album) album = spMeta.album;
        if (spMeta.releaseDate) year = String(spMeta.releaseDate).slice(0, 4);
        if (spMeta.duration) duration = spMeta.duration;
        if (spMeta.durationMs) expectedDurationSec = Math.round(spMeta.durationMs / 1000);
        if (spMeta.thumbnail) {
          try {
            const imgRes = await fetch(spMeta.thumbnail, { signal: AbortSignal.timeout(10000) });
            if (imgRes.ok) {
              const rawCover = Buffer.from(await imgRes.arrayBuffer());
              const meta = await sharp(rawCover, { failOn: 'none', animated: false }).metadata().catch(() => null);
              if (meta?.width >= 8 && meta?.height >= 8) {
                coverBuf = await sharp(rawCover, { failOn: 'none', animated: false })
                  .rotate().resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })
                  .flatten({ background: '#0b1021' }).jpeg({ quality: 90 }).toBuffer().catch(() => rawCover);
              }
            }
          } catch {}
        }
      }
    } catch (err) {
      this.log?.debug?.({ err: err.message }, 'spotifyMetadata embed lookup failed, falling back to oEmbed/HTML');
    }

    // Return rich collection object for Spotify Albums, Playlists, and Artists so UI renders track selector
    if (spMeta && ['album', 'playlist', 'artist'].includes(spMeta.type)) {
      return {
        sourceUrl: spMeta.originalUrl || url,
        platform: 'spotify',
        spotifyType: spMeta.type,
        title: spMeta.title || title,
        artist: artist || spMeta.author || 'Spotify',
        author: spMeta.author || artist || 'Spotify',
        album: spMeta.type === 'album' ? (spMeta.title || album) : album,
        year,
        totalTracks: spMeta.totalTracks || spMeta.tracks?.length || 0,
        tracks: Array.isArray(spMeta.tracks) ? spMeta.tracks : [],
        description: spMeta.description || '',
        mediaItems: coverBuf ? [{ type: 'photo', buffer: coverBuf, filename: 'cover.jpg', mimeType: 'image/jpeg' }] : [],
        audioTrack: null
      };
    }

    // 2. Fallback metadata via Spotify oEmbed + HTML OG tags when embed fails
    if (!artist || title === 'Spotify Track' || !coverBuf) {
      try {
        const oembedRes = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(10000) });
        if (oembedRes.ok) {
          const oembedData = await oembedRes.json();
          if (oembedData.title && title === 'Spotify Track') title = oembedData.title;
          if (oembedData.thumbnail_url && !coverBuf) {
            const imgRes = await fetch(oembedData.thumbnail_url, { signal: AbortSignal.timeout(10000) });
            if (imgRes.ok) {
              const rawCover = Buffer.from(await imgRes.arrayBuffer());
              const meta = await sharp(rawCover, { failOn: 'none', animated: false }).metadata().catch(() => null);
              if (meta?.width >= 8 && meta?.height >= 8) {
                coverBuf = await sharp(rawCover, { failOn: 'none', animated: false })
                  .rotate().resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })
                  .flatten({ background: '#0b1021' }).jpeg({ quality: 90 }).toBuffer().catch(() => rawCover);
              }
            }
          }
        }
      } catch {}

      if (!artist || title === 'Spotify Track') {
        try {
          const pageRes = await fetch(url, {
            headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            signal: AbortSignal.timeout(10000)
          });
          if (pageRes.ok) {
            const html = await pageRes.text();
            const ogTitle = html.match(/<meta property="og:title" content="(.*?)"/i)?.[1];
            const ogDesc = html.match(/<meta property="og:description" content="(.*?)"/i)?.[1];
            const ogImage = html.match(/<meta property="og:image" content="(.*?)"/i)?.[1];

            if (ogTitle && title === 'Spotify Track') {
              const clean = ogTitle.replace(/\s*\|\s*Spotify.*/i, '').trim();
              if (clean) title = clean;
            }
            if (ogDesc) {
              const parts = ogDesc.split(/\s*[·•]\s*/).map((p) => p.trim()).filter(Boolean);
              if (parts.length >= 1 && !artist) artist = parts[0];
              if (parts.length >= 2 && !album) album = parts[1];
              const yearMatch = ogDesc.match(/\b(19\d\d|20\d\d)\b/);
              if (yearMatch && !year) year = yearMatch[1];
            }
            const mTitle = html.match(/<title>(.*?)\s*-\s*song and lyrics by (.*?)\s*\|\s*Spotify<\/title>/i);
            if (mTitle) {
              if (!title || title === 'Spotify Track') title = mTitle[1].trim();
              if (!artist) artist = mTitle[2].trim();
            }
            if (ogImage && !coverBuf) {
              try {
                const imgRes = await fetch(ogImage, { signal: AbortSignal.timeout(10000) });
                if (imgRes.ok) coverBuf = Buffer.from(await imgRes.arrayBuffer());
              } catch {}
            }
          }
        } catch {}
      }
    }

    // 3. Resolve full-length audio + optimize CBR 192k MP3 with ID3v2 tags
    return this.#resolveAndOptimizeTrack({
      sourceUrl: spMeta?.originalUrl || url,
      platform: 'spotify',
      title,
      artist,
      album,
      year,
      duration,
      expectedDurationSec,
      coverBuf,
      onProgress
    });
  }

  /**
   * Apple Music Downloader: Catalog metadata + full studio match (fallback to preview only if needed)
   */
  async #downloadAppleMusic(url, { onProgress }) {
    onProgress?.('Fetching Apple Music catalog metadata… ♡');
    let meta = null;
    try {
      meta = await applemusicMetadata(url);
    } catch {
      const dlInfo = await applemusicDl(url).catch(() => null);
      if (dlInfo) meta = dlInfo;
    }
    if (!meta?.title) {
      throw new Error('Could not read Apple Music track metadata from this link ♡');
    }

    const coverUrl = meta.thumbnail ? String(meta.thumbnail).replace('100x100bb', '600x600bb') : null;
    let coverBuf = null;
    if (coverUrl) {
      try {
        const imgRes = await fetch(coverUrl, { signal: AbortSignal.timeout(10000) });
        if (imgRes.ok) coverBuf = Buffer.from(await imgRes.arrayBuffer());
      } catch {}
    }

    const expectedDurationSec = meta.durationMs ? Math.round(meta.durationMs / 1000) : 0;
    const durStr = expectedDurationSec ? `${Math.floor(expectedDurationSec / 60)}:${String(expectedDurationSec % 60).padStart(2, '0')}` : '';
    const year = meta.releaseDate ? String(meta.releaseDate).slice(0, 4) : '';

    return this.#resolveAndOptimizeTrack({
      sourceUrl: url,
      platform: 'applemusic',
      title: meta.title,
      artist: meta.artist || meta.author || '',
      album: meta.album || '',
      year,
      duration: durStr,
      expectedDurationSec,
      coverBuf,
      onProgress
    });
  }

  /**
   * Audiomack Downloader: Direct HQ stream + ID3v2 MP3 optimization (with resolver fallback)
   */
  async #downloadAudiomack(url, { onProgress }) {
    onProgress?.('Fetching Audiomack track stream… ♡');
    let info = null;
    try {
      info = await audiomackDl(url);
    } catch (err) {
      this.log?.debug?.({ err: err.message }, 'audiomackDl failed, falling back');
    }

    let coverBuf = null;
    if (info?.thumbnail) {
      try {
        const imgRes = await fetch(info.thumbnail, { signal: AbortSignal.timeout(10000) });
        if (imgRes.ok) coverBuf = Buffer.from(await imgRes.arrayBuffer());
      } catch {}
    }

    const streamUrl = info?.formats?.[0]?.url;
    if (streamUrl) {
      try {
        onProgress?.(`Downloading Audiomack HQ audio for "${info.title}"… ♡`);
        const res = await fetch(streamUrl, {
          headers: { Referer: 'https://audiomack.com/' },
          signal: AbortSignal.timeout(45000)
        });
        if (res.ok) {
          const rawBuf = Buffer.from(await res.arrayBuffer());
          if (rawBuf.length > 20000) {
            const optBuf = await this.#optimizeAudioToCbrMp3(rawBuf, {
              title: info.title,
              artist: info.artist || info.author || 'Audiomack',
              album: info.album || ''
            });
            const durSec = Number(info.duration || 0);
            const durStr = durSec > 0 ? `${Math.floor(durSec / 60)}:${String(Math.floor(durSec % 60)).padStart(2, '0')}` : '';
            return {
              sourceUrl: url,
              platform: 'audiomack',
              title: info.title || 'Audiomack Track',
              artist: info.artist || info.author || 'Audiomack',
              author: info.author || info.artist || 'Audiomack',
              album: info.album || '',
              duration: durStr,
              mediaItems: coverBuf ? [{ type: 'photo', buffer: coverBuf, filename: 'cover.jpg', mimeType: 'image/jpeg' }] : [],
              audioTrack: {
                buffer: optBuf,
                filename: `${(info.title || 'audiomack_track').replace(/[^\w\s-]/g, '') || 'track'}.mp3`,
                title: info.title || 'Audiomack Track',
                performer: info.artist || info.author || 'Audiomack',
                album: info.album || '',
                duration: durSec || undefined
              }
            };
          }
        }
      } catch (err) {
        this.log?.debug?.({ err: err.message }, 'audiomack direct stream fetch failed');
      }
    }

    if (info?.title) {
      return this.#resolveAndOptimizeTrack({
        sourceUrl: url,
        platform: 'audiomack',
        title: info.title,
        artist: info.artist || info.author || '',
        album: info.album || '',
        expectedDurationSec: Number(info.duration || 0),
        coverBuf,
        onProgress
      });
    }

    return this.#downloadUniversal(url, { onProgress, platform: 'audiomack' });
  }

  /**
   * SoundCloud Downloader: Audio track + artwork extraction
   */
  async #downloadSoundCloud(url, { onProgress }) {
    onProgress?.('Fetching SoundCloud track… ♡');
    const ffmpegBin = resolveFfmpegPath() || 'ffmpeg';
    const tempDir = join(tmpdir(), `lancy_sc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
    mkdirSync(tempDir, { recursive: true });
    try {
      const { stdout } = await execFileAsync('yt-dlp', [
        '--no-warnings',
        '--no-playlist',
        '--ffmpeg-location', ffmpegBin,
        '--write-thumbnail',
        '--print-json',
        '-x',
        '--audio-format', 'mp3',
        '--audio-quality', '2',
        '-P', tempDir,
        '-o', '%(title).60s.%(ext)s',
        url
      ], { timeout: 60000, maxBuffer: 6 * 1024 * 1024 });

      let meta = null;
      const lastJsonLine = String(stdout || '').trim().split('\n').reverse().find((l) => l.trim().startsWith('{'));
      if (lastJsonLine) {
        try { meta = JSON.parse(lastJsonLine); } catch {}
      }

      const files = readdirSync(tempDir);
      const audioFile = files.find((f) => /\.(mp3|m4a|opus|ogg|wav)$/i.test(f));
      if (audioFile) {
        const title = meta?.track || meta?.title || 'SoundCloud Track';
        const artist = meta?.artist || meta?.uploader || 'SoundCloud';
        const durSec = Number(meta?.duration || 0) || (await getAudioDurationSeconds(join(tempDir, audioFile))) || 0;
        const durStr = durSec > 0 ? `${Math.floor(durSec / 60)}:${String(Math.floor(durSec % 60)).padStart(2, '0')}` : '';

        const thumbFile = files.find((f) => /\.(jpg|jpeg|png|webp)$/i.test(f));
        let coverBuf = null;
        if (thumbFile) {
          try {
            coverBuf = await sharp(readFileSync(join(tempDir, thumbFile))).jpeg({ quality: 92 }).toBuffer();
          } catch {}
        }

        const audioBuf = await this.#optimizeAudioToCbrMp3(join(tempDir, audioFile), { title, artist });
        return {
          sourceUrl: url,
          platform: 'soundcloud',
          title,
          artist,
          author: artist,
          duration: durStr,
          mediaItems: coverBuf ? [{ type: 'photo', buffer: coverBuf, filename: 'cover.jpg', mimeType: 'image/jpeg' }] : [],
          audioTrack: {
            buffer: audioBuf,
            filename: `${title.replace(/[^\w\s-]/g, '') || 'track'}.mp3`,
            title,
            performer: artist,
            duration: durSec || undefined
          }
        };
      }
    } catch (err) {
      this.log?.debug?.({ err: err.message }, 'soundcloud yt-dlp extraction failed');
    } finally {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }

    return this.#downloadUniversal(url, { onProgress, platform: 'soundcloud' });
  }

  /**
   * Threads Downloader: Handles video & multi-image posts (using social-dl@1.4.3 login-shell bypass)
   */
  async #downloadThreads(url, { onProgress }) {
    onProgress?.('Fetching Threads post media… ♡');
    try {
      const info = await threadsDl(url);
      if (info) {
        const collected = await this.#collectMediaFromUrls({
          sourceUrl: url,
          platform: 'threads',
          title: info.title || 'Threads Post',
          author: info.author || 'Threads',
          images: info.images || [],
          videoUrl: info.formats?.[0]?.url || null,
          headers: { Referer: 'https://www.threads.net/', 'User-Agent': 'Mozilla/5.0' },
          optimizeVideo: true
        });
        if (collected) return collected;
      }
    } catch (err) {
      this.log?.debug?.({ err: err.message }, 'threadsDl failed, falling back to universal');
    }
    return this.#downloadUniversal(url, { onProgress, platform: 'threads' });
  }

  /**
   * RedNote / Xiaohongshu Downloader: Videos & multi-photo notes
   */
  async #downloadRedNote(url, { onProgress }) {
    onProgress?.('Fetching RedNote / Xiaohongshu media… ♡');
    try {
      const info = await rednoteDl(url);
      if (info) {
        const collected = await this.#collectMediaFromUrls({
          sourceUrl: url,
          platform: 'rednote',
          title: info.title || 'RedNote Post',
          author: info.author || 'RedNote',
          images: info.images || [],
          videoUrl: info.formats?.[0]?.url || null,
          headers: { Referer: url },
          optimizeVideo: false
        });
        if (collected) return collected;
      }
    } catch (err) {
      this.log?.debug?.({ err: err.message }, 'rednoteDl failed, falling back to universal');
    }
    return this.#downloadUniversal(url, { onProgress, platform: 'rednote' });
  }

  /**
   * Short-Drama Platforms Downloader (DramaBox, ReelShort, GoodShort, FlexTV, MoboReels, AnyDrama, ShortMax, FlickReels)
   */
  async #downloadSocialDrama(url, { onProgress, platform }) {
    onProgress?.(`Extracting ${platform.toUpperCase()} episode stream… ♡`);
    const tempDir = join(tmpdir(), `lancy_drama_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
    mkdirSync(tempDir, { recursive: true });
    try {
      const info = await universalDl(url).catch(() => null);
      const destPath = join(tempDir, `${platform}.mp4`);
      await universalSave(url, destPath, { quality: 'best' });
      if (existsSync(destPath) && statSync(destPath).size > 8192) {
        const buf = readFileSync(destPath);
        const extAudio = await this.extractAudioFromBuffer(buf);
        const title = info?.title || `${platform.toUpperCase()} Video`;
        const author = info?.author || platform.toUpperCase();
        return {
          sourceUrl: url,
          platform,
          title,
          author,
          mediaItems: [{ type: 'video', buffer: buf, filename: `${platform}.mp4`, mimeType: 'video/mp4' }],
          audioTrack: extAudio ? { buffer: extAudio, filename: `${platform}_audio.mp3`, title, performer: author } : null
        };
      }
    } catch (err) {
      this.log?.debug?.({ err: err.message, platform }, 'short-drama direct extraction failed, falling back to universal');
    } finally {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
    return this.#downloadUniversal(url, { onProgress, platform });
  }

  /**
   * Read bounded response body into Buffer while aborting early if payload exceeds maxBytes.
   */
  async #fetchBoundedBuffer(targetUrl, { headers = {}, maxBytes = 46 * 1024 * 1024, timeoutMs = 45000 } = {}) {
    const res = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        ...headers
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) throw new Error(`HTTP_${res.status}`);
    const cl = Number(res.headers.get('content-length') || 0);
    if (cl > 0 && cl > maxBytes) {
      await res.body?.cancel?.().catch(() => {});
      return { oversized: true, contentLength: cl, contentType: res.headers.get('content-type') || '', buffer: null };
    }
    if (!res.body) {
      const arr = Buffer.from(await res.arrayBuffer());
      if (arr.length > maxBytes) return { oversized: true, contentLength: arr.length, contentType: res.headers.get('content-type') || '', buffer: null };
      return { oversized: false, contentLength: arr.length, contentType: res.headers.get('content-type') || '', buffer: arr };
    }
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.byteLength) {
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel().catch(() => {});
            return { oversized: true, contentLength: total, contentType: res.headers.get('content-type') || '', buffer: null };
          }
          chunks.push(Buffer.from(value));
        }
      }
      return { oversized: false, contentLength: total, contentType: res.headers.get('content-type') || '', buffer: Buffer.concat(chunks) };
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  }

  /**
   * Stream a large file (up to 2 GB) directly to disk without holding it in RAM.
   */
  async #fetchBoundedStreamToFile(targetUrl, destPath, { headers = {}, maxBytes = 2000 * 1024 * 1024, timeoutMs = 600000, onProgress } = {}) {
    const res = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        ...headers
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) throw new Error(`HTTP_${res.status}`);
    const cl = Number(res.headers.get('content-length') || 0);
    if (cl > 0 && cl > maxBytes) {
      await res.body?.cancel?.().catch(() => {});
      return { oversized: true, contentLength: cl, contentType: res.headers.get('content-type') || '', filePath: null };
    }
    if (!res.body) {
      const arr = Buffer.from(await res.arrayBuffer());
      if (arr.length > maxBytes) return { oversized: true, contentLength: arr.length, contentType: res.headers.get('content-type') || '', filePath: null };
      writeFileSync(destPath, arr);
      return { oversized: false, contentLength: arr.length, contentType: res.headers.get('content-type') || '', filePath: destPath };
    }
    const reader = res.body.getReader();
    const out = createWriteStream(destPath, { mode: 0o600 });
    let total = 0;
    let lastReportAt = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.byteLength) {
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel().catch(() => {});
            out.destroy();
            try { unlinkSync(destPath); } catch {}
            return { oversized: true, contentLength: total, contentType: res.headers.get('content-type') || '', filePath: null };
          }
          if (!out.write(Buffer.from(value))) {
            await new Promise((resolve) => out.once('drain', resolve));
          }
          if (onProgress && Date.now() - lastReportAt > 3500) {
            lastReportAt = Date.now();
            const mbDone = Math.round(total / (1024 * 1024));
            const mbTotal = cl > 0 ? ` / ${Math.round(cl / (1024 * 1024))} MB` : ' MB';
            onProgress(`Downloading movie stream: ${mbDone}${mbTotal}… ♡`);
          }
        }
      }
      await new Promise((resolve, reject) => {
        out.end((err) => (err ? reject(err) : resolve()));
      });
      return { oversized: false, contentLength: total, contentType: res.headers.get('content-type') || '', filePath: destPath };
    } catch (err) {
      out.destroy();
      try { unlinkSync(destPath); } catch {}
      throw err;
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  }

  /**
   * TheNkiri / Nkiri Movies & TV Series Downloader (supports trailers, direct clips & 2 GB+ full movies via Local Bot API)
   */
  async #downloadThenkiri(url, { onProgress }) {
    const sdl = this.socialDl || { thenkiriDl, thenkiriGetLink };
    onProgress?.('Fetching TheNkiri release metadata… ♡');
    const details = await sdl.thenkiriDl(url);
    const title = details?.title || 'TheNkiri Release';
    const description = details?.description || '';
    const mediaItems = [];

    if (details?.poster) {
      try {
        const posterRes = await this.#fetchBoundedBuffer(details.poster, { maxBytes: 8 * 1024 * 1024, timeoutMs: 12000 });
        if (!posterRes.oversized && posterRes.buffer?.length > 1024) {
          mediaItems.push({
            type: 'photo',
            buffer: posterRes.buffer,
            filename: 'thenkiri_poster.jpg',
            mimeType: 'image/jpeg'
          });
        }
      } catch {}
    }

    onProgress?.('Resolving direct TheNkiri download link… ♡');
    const resolved = await sdl.thenkiriGetLink(url).catch(() => null);
    const maxTgBytes = Math.max(46 * 1024 * 1024, uploadLimitBytes());
    const sources = (details?.sources || []).filter((s) => !s.locked && s.available !== false);

    if (resolved?.url) {
      const cl = Number(resolved.contentLength || 0);
      const canTryVideo = !cl || cl <= maxTgBytes;
      if (canTryVideo && details?.contentType !== 'series') {
        try {
          if (cl > 60 * 1024 * 1024 && maxTgBytes > 100 * 1024 * 1024) {
            onProgress?.(`Downloading full TheNkiri movie (${Math.round(cl / (1024 * 1024))} MB)… ♡`);
            const largeDir = existsSync('/data/tmp') ? '/data/tmp' : tmpdir();
            mkdirSync(largeDir, { recursive: true });
            const moviePath = join(largeDir, `lancy_thenkiri_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.${resolved.format || 'mp4'}`);
            const streamed = await this.#fetchBoundedStreamToFile(resolved.url, moviePath, {
              headers: resolved.headers || { Referer: url },
              maxBytes: maxTgBytes,
              timeoutMs: 600000,
              onProgress
            });
            if (!streamed.oversized && streamed.filePath && existsSync(streamed.filePath) && streamed.contentLength > 4096) {
              return {
                sourceUrl: url,
                platform: 'thenkiri',
                title,
                author: 'TheNkiri',
                description,
                directUrl: resolved.url,
                mediaItems: [{
                  type: 'video',
                  filePath: streamed.filePath,
                  sizeBytes: streamed.contentLength,
                  filename: `${title.replace(/[^\w\s.-]/g, '').slice(0, 48) || 'thenkiri'}.${resolved.format || 'mp4'}`,
                  mimeType: 'video/mp4',
                  cleanupOnDeliver: true
                }],
                audioTrack: null
              };
            }
          } else {
            onProgress?.('Downloading TheNkiri video clip… ♡');
            const fetched = await this.#fetchBoundedBuffer(resolved.url, {
              headers: resolved.headers || { Referer: url },
              maxBytes: Math.min(maxTgBytes, 60 * 1024 * 1024),
              timeoutMs: 60000
            });
            if (!fetched.oversized && fetched.buffer?.length > 4096) {
              let vidBuf = fetched.buffer;
              try {
                vidBuf = await optimizeVideoForTelegram(vidBuf) || vidBuf;
              } catch {}
              const extAudio = await this.extractAudioFromBuffer(vidBuf).catch(() => null);
              return {
                sourceUrl: url,
                platform: 'thenkiri',
                title,
                author: 'TheNkiri',
                description,
                mediaItems: [{
                  type: 'video',
                  buffer: vidBuf,
                  filename: `${title.replace(/[^\w\s.-]/g, '').slice(0, 48) || 'thenkiri'}.${resolved.format || 'mp4'}`,
                  mimeType: 'video/mp4'
                }],
                audioTrack: extAudio ? { buffer: extAudio, filename: 'thenkiri_audio.mp3', title, performer: 'TheNkiri' } : null
              };
            }
          }
        } catch (err) {
          this.log?.debug?.({ err: err.message }, 'thenkiri direct media download fell back to link card');
        }
      }
    }

    const directUrl = resolved?.url || sources[0]?.url || url;
    const epCount = Array.isArray(details?.episodes) ? details.episodes.length : 0;
    const sizeLabel = resolved?.contentLength ? `~${Math.round(Number(resolved.contentLength) / (1024 * 1024))} MB` : 'Full HD file (>50 MB Telegram upload limit)';
    return {
      sourceUrl: url,
      platform: 'thenkiri',
      title,
      author: 'TheNkiri',
      description,
      directUrl,
      sourceLinks: sources.slice(0, 6).map((s) => ({
        label: s.label || (s.episodeNumber ? `S${s.seasonNumber || 1}E${s.episodeNumber}` : 'Download Mirror'),
        url: s.url
      })),
      oversizeNotice: epCount
        ? `Found ${epCount} episode(s) on TheNkiri (${sizeLabel}). Tap the direct download link below to save or stream in full quality! ♡`
        : `Direct stream ready (${sizeLabel}). Telegram bots cap uploads at 50 MB, so use the direct high-speed link below! ♡`,
      mediaItems,
      infoOnly: true
    };
  }

  /**
   * Bilibili Video Downloader (bilibili.com/video/BV...|av... & b23.tv)
   */
  async #downloadBilibili(url, { onProgress }) {
    const sdl = this.socialDl || { bilibiliDl, bilibiliSave, isBilibiliUrl };
    onProgress?.('Fetching Bilibili video details… ♡');
    let meta = null;
    if (sdl.isBilibiliUrl?.(url)) {
      try {
        meta = await sdl.bilibiliDl(url);
        const tempDir = mkdtempSync(join(tmpdir(), 'lancy_bili_'));
        try {
          const outPath = join(tempDir, 'bilibili.mp4');
          onProgress?.('Downloading Bilibili video stream… ♡');
          await sdl.bilibiliSave(url, outPath, 'best');
          if (existsSync(outPath)) {
            const st = statSync(outPath);
            if (st.size > 4096 && st.size <= 48 * 1024 * 1024) {
              let vidBuf = readFileSync(outPath);
              try {
                vidBuf = await optimizeVideoForTelegram(vidBuf) || vidBuf;
              } catch {}
              const extAudio = await this.extractAudioFromBuffer(vidBuf).catch(() => null);
              const title = meta?.title || 'Bilibili Video';
              const author = meta?.author || 'Bilibili';
              return {
                sourceUrl: url,
                platform: 'bilibili',
                title,
                author,
                durationSeconds: Number(meta?.duration || 0) || null,
                mediaItems: [{ type: 'video', buffer: vidBuf, filename: 'bilibili.mp4', mimeType: 'video/mp4' }],
                audioTrack: extAudio ? { buffer: extAudio, filename: 'bilibili_audio.mp3', title, performer: author } : null
              };
            }
          }
        } finally {
          try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
        }
      } catch (err) {
        this.log?.debug?.({ err: err.message }, 'social-dl bilibili failed, falling back to universal');
      }
    }
    return this.#downloadUniversal(url, {
      onProgress,
      platform: 'bilibili',
      extraArgs: ['--add-headers', 'Referer:https://www.bilibili.com/'],
      metadataHint: meta ? { title: meta.title, author: meta.author, durationSeconds: meta.duration } : null
    });
  }

  /**
   * JustWatch Catalog & Official Streaming Providers Lookup
   */
  async #downloadJustWatch(url, { onProgress }) {
    const sdl = this.socialDl || { justwatchDetails, justwatchWatch };
    onProgress?.('Fetching JustWatch catalog & watch providers… ♡');
    const details = await sdl.justwatchDetails(url);
    const watch = await sdl.justwatchWatch(url).catch(() => null);
    const mediaItems = [];
    const posterUrl = details?.poster || details?.thumbnail;
    if (posterUrl) {
      try {
        const p = await this.#fetchBoundedBuffer(posterUrl, { maxBytes: 8 * 1024 * 1024, timeoutMs: 12000 });
        if (!p.oversized && p.buffer?.length > 1024) {
          mediaItems.push({ type: 'photo', buffer: p.buffer, filename: 'justwatch_poster.jpg', mimeType: 'image/jpeg' });
        }
      } catch {}
    }
    const offers = (details?.offers || []).slice(0, 6);
    const offerSummary = offers.map((o) => `${o.provider}${o.accessLabel ? ` (${o.accessLabel})` : ''}`).join(', ');
    return {
      sourceUrl: url,
      platform: 'justwatch',
      title: details?.title || 'JustWatch Title',
      author: details?.releaseYear ? `JustWatch (${details.releaseYear})` : 'JustWatch',
      year: details?.releaseYear || null,
      description: [details?.description, offerSummary ? `Where to watch: ${offerSummary}` : ''].filter(Boolean).join('\n\n'),
      directUrl: watch?.watchUrl || details?.canonicalUrl || url,
      sourceLinks: offers.filter((o) => o.providerUrl || o.watchUrl).map((o) => ({
        label: `▶ ${o.provider}${o.accessLabel ? ` (${o.accessLabel})` : ''}`,
        url: o.providerUrl || o.watchUrl
      })),
      oversizeNotice: offerSummary
        ? `Available on: ${offerSummary}. Tap any official provider link below to watch! ♡`
        : 'Catalog metadata retrieved from JustWatch. Open the official link below for provider availability! ♡',
      mediaItems,
      infoOnly: true
    };
  }

  /**
   * Reddit Video + DASH Audio Muxed Downloader (reddit.com & redd.it)
   */
  async #downloadReddit(url, { onProgress }) {
    onProgress?.('Extracting Reddit video & audio… ♡');
    return this.#downloadUniversal(url, {
      onProgress,
      platform: 'reddit',
      extraArgs: ['-f', 'bv*[filesize<45M]+ba/b[filesize<48M]/b/best']
    });
  }

  /**
   * Universal Music Search Downloader (Song title / Artist / Track search)
   */
  async #downloadMusicSearch(query, { onProgress } = {}) {
    let clean = String(query || '')
      .replace(/^(music|song|track|audio|play|search\s*music|download\s*song|spotify)\s*[:\-]?\s*/i, '')
      .replace(/^["'“”]+|["'“”]+$/g, '')
      .trim();
    if (!clean) throw new Error('Please provide a song title or artist to search ♡');

    onProgress?.(`Searching music for "${clean}"… ♡`);

    const tempDir = join(tmpdir(), `lancy_music_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
    mkdirSync(tempDir, { recursive: true });

    try {
      // Check if query is explicitly multi-line lyrics or starts with lyrics:
      let isLyricQuery = false;
      const lines = clean.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length >= 2) {
        isLyricQuery = true;
      } else if (/^lyrics?\s*[:\-]/i.test(query)) {
        isLyricQuery = true;
      }

      let trackTitle = clean;
      let trackAuthor = 'Spotify / YouTube';

      if (isLyricQuery) {
        onProgress?.('Identifying song from lyrics snippet… ♡');
        try {
          const identified = await searchSongByLyrics(clean);
          if (identified && identified.title && identified.artist) {
            onProgress?.(`Identified: "${identified.title}" by ${identified.artist} ♡`);
            trackTitle = identified.title;
            trackAuthor = identified.artist;
          }
        } catch {}
      }

      let trackThumbnailUrl = null;
      let trackDuration = null;
      let trackYear = null;
      let videoId = null;

      const queryTerms = clean.toLowerCase().split(/\s+/).filter(Boolean);
      const wantsLongMix = /\b(mix|compilation|full\s*album|album|1\s*hour|2\s*hour|3\s*hour|10\s*hour|1hr|2hr|3hr|10hr|hours|extended|continuous|medley|playlist|podcast|lofi|lo-fi)\b/i.test(clean);

      onProgress?.(`Searching source & metadata for "${clean}"… ♡`);

      // Fast concurrent search via InnerTube (NG + US wide) + Deezer + iTunes
      const [fastItemsResult, deezerResult, itunesResult] = await Promise.allSettled([
        searchYouTubeFast(clean, 'NG', { wide: true }),
        fetch(`https://api.deezer.com/search?q=${encodeURIComponent(clean)}&limit=8`, {
          signal: AbortSignal.timeout(3000)
        }).then((r) => (r.ok ? r.json() : null)),
        fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(clean)}&entity=song&limit=8`, {
          signal: AbortSignal.timeout(3000)
        }).then((r) => (r.ok ? r.json() : null))
      ]);

      const fastItems = fastItemsResult.status === 'fulfilled' && Array.isArray(fastItemsResult.value) ? fastItemsResult.value : [];
      const metaCandidates = [];
      if (deezerResult.status === 'fulfilled' && deezerResult.value?.data?.length > 0) {
        for (const item of deezerResult.value.data) {
          const combined = `${item.title || ''} ${item.artist?.name || ''}`.toLowerCase();
          const score = queryTerms.reduce((acc, term) => acc + (combined.includes(term) ? 1 : 0), 0);
          metaCandidates.push({ item, score, sourceScore: 1 });
        }
      }
      if (itunesResult.status === 'fulfilled' && itunesResult.value?.results?.length > 0) {
        for (const it of itunesResult.value.results) {
          const combined = `${it.trackName || ''} ${it.artistName || ''}`.toLowerCase();
          const score = queryTerms.reduce((acc, term) => acc + (combined.includes(term) ? 1 : 0), 0);
          metaCandidates.push({
            item: {
              title: it.trackName,
              artist: { name: it.artistName },
              duration: it.trackTimeMillis ? Math.round(it.trackTimeMillis / 1000) : 0,
              album: {
                cover_big: it.artworkUrl100?.replace('100x100bb', '600x600bb') || it.artworkUrl100
              }
            },
            score,
            sourceScore: 0
          });
        }
      }
      metaCandidates.sort((a, b) => (b.score - a.score) || (b.sourceScore - a.sourceScore));
      const bestSp = metaCandidates[0]?.item || null;

      let bestYt = rankYouTubeAudioCandidates(fastItems, queryTerms, { clean, wantsLongMix });

      // If YouTube's best candidate is a long compilation (> 15m) and Deezer/iTunes found a standard commercial track, search for the artist + title
      const bestYtDur = parseDurationToSeconds(bestYt?.duration);
      if ((!bestYt || (bestYtDur > 900 && !wantsLongMix)) && bestSp && bestSp.artist?.name && bestSp.title) {
        try {
          const refinedItems = await searchYouTubeFast(`${bestSp.artist.name} ${bestSp.title}`, 'NG', { wide: false });
          const refinedBest = rankYouTubeAudioCandidates(refinedItems, queryTerms, { clean, wantsLongMix });
          if (refinedBest) bestYt = refinedBest;
        } catch {}
      }

      if (bestYt) {
        videoId = bestYt.videoId;
        trackTitle = bestYt.title || trackTitle;
        trackAuthor = bestYt.author || trackAuthor;
        trackDuration = bestYt.duration || trackDuration;
        trackThumbnailUrl = bestYt.thumb || trackThumbnailUrl;
      }

      if (bestSp) {
        if (!videoId) {
          trackTitle = bestSp.title || trackTitle;
          trackAuthor = bestSp.artist?.name || trackAuthor;
        }
        if (bestSp.duration && !trackDuration) {
          const min = Math.floor(bestSp.duration / 60);
          const sec = String(bestSp.duration % 60).padStart(2, '0');
          trackDuration = `${min}:${sec}`;
        }
        trackThumbnailUrl = bestSp.album?.cover_big || bestSp.album?.cover_medium || trackThumbnailUrl;
      }

      // Clean track title & author from search if needed
      const initialClean = cleanSongMetadata(trackTitle, trackAuthor);
      if (initialClean.title && initialClean.title.toLowerCase() !== 'song') {
        trackTitle = initialClean.title;
        if (initialClean.artist) trackAuthor = initialClean.artist;
      }

      onProgress?.(`Resolving media match: "${trackTitle}" — ${trackAuthor}… ♡`);
      onProgress?.(`Downloading full audio track for "${trackTitle}"… ♡`);

      // Pre-fetch thumbnail in background while audio downloads
      const normalizeThumb = async (rawThumb) => {
        if (!rawThumb || rawThumb.length < 64) return null;
        try {
          const meta = await sharp(rawThumb, { failOn: 'none', animated: false }).metadata();
          if (!meta?.width || !meta?.height || meta.width < 8 || meta.height < 8) return null;
          return await sharp(rawThumb, { failOn: 'none', animated: false })
            .rotate()
            .resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })
            .flatten({ background: '#0b1021' })
            .jpeg({ quality: 90 })
            .toBuffer();
        } catch {
          return null;
        }
      };

      const coverPromise = (async () => {
        if (trackThumbnailUrl) {
          try {
            const imgRes = await fetch(trackThumbnailUrl, { signal: AbortSignal.timeout(8000) });
            if (imgRes.ok) {
              const rawThumb = Buffer.from(await imgRes.arrayBuffer());
              const norm = await normalizeThumb(rawThumb);
              if (norm) return norm;
            }
          } catch {}
        }
        if (videoId) {
          try {
            const imgRes = await fetch(`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, { signal: AbortSignal.timeout(5000) });
            if (imgRes.ok) {
              const rawThumb = Buffer.from(await imgRes.arrayBuffer());
              const norm = await normalizeThumb(rawThumb);
              if (norm) return norm;
            }
          } catch {}
        }
        return null;
      })();

      let downloaded = false;
      const cookieArgs = getCookieArgs();

      const getValidAudioFile = async () => {
        try {
          const files = readdirSync(tempDir);
          const audio = files.find((f) => /\.(mp3|m4a|webm|opus|ogg|wav)$/i.test(f));
          if (!audio) return null;
          const fullPath = join(tempDir, audio);
          const dur = await getAudioDurationSeconds(fullPath);
          if (dur !== null && dur < 45) {
            // Delete preview snippet! Never accept truncated tracks.
            try { unlinkSync(fullPath); } catch {}
            return null;
          }
          return { filename: audio, path: fullPath, duration: dur };
        } catch {
          return null;
        }
      };

      // Layer 0: Instant 0ms Disk Cache Hit (/data/audio_cache/<videoId|queryHash>.mp3)
      const queryCacheHash = createHash('sha1').update(clean.toLowerCase()).digest('hex').slice(0, 16);
      const cacheCandidates = [
        videoId ? `/data/audio_cache/${videoId}.mp3` : null,
        `/data/audio_cache/q_${queryCacheHash}.mp3`
      ].filter(Boolean);
      for (const diskCachePath of cacheCandidates) {
        try {
          if (existsSync(diskCachePath) && statSync(diskCachePath).size > 40000) {
            const targetCopy = join(tempDir, `${videoId || queryCacheHash}.mp3`);
            writeFileSync(targetCopy, readFileSync(diskCachePath));
            if (await getValidAudioFile()) {
              downloaded = true;
              break;
            }
          }
        } catch {}
      }

      const ffmpegBin = resolveFfmpegPath() || 'ffmpeg';

      // Layer 0.5: Ultra-fast direct HTTP CDN resolver (JioSaavn 320k / Audius — ~0.6s, no yt-dlp process overhead!)
      if (!downloaded && !wantsLongMix && !isLyricQuery) {
        try {
          const { resolveAndDownloadAudio } = await import('./musicResolver.js');
          const resolvedPath = join(tempDir, 'fast_resolved.mp3');
          const preMeta = bestSp ? { title: trackTitle, artist: trackAuthor } : { title: trackTitle, artist: trackAuthor };
          const fastRes = await Promise.race([
            resolveAndDownloadAudio({
              query: clean,
              trackId: videoId || null,
              tempPath: resolvedPath,
              ffmpegPath: ffmpegBin,
              minSeconds: 45,
              meta: preMeta,
              skipYouTube: true,
              onProgress
            }),
            new Promise((resolve) => setTimeout(() => resolve({ ok: false }), 4500))
          ]);
          if (fastRes?.ok && (await getValidAudioFile())) {
            downloaded = true;
          }
        } catch {}
      }

      // Layer 1: Download matched YouTube video with authenticated session & node challenge solver (-N 8 fast fragments)
      if (!downloaded && videoId) {
        try {
          await execFileAsync('yt-dlp', [
            '--no-warnings',
            '--no-playlist',
            '--ffmpeg-location', ffmpegBin,
            ...cookieArgs,
            '-N', '8',
            '--max-filesize', '48M',
            '--js-runtimes', 'node:/usr/bin/node',
            '-f', 'ba[ext=m4a]/ba[ext=mp3]/ba/b',
            '-P', tempDir,
            '-o', '%(title).60s.%(ext)s',
            `https://www.youtube.com/watch?v=${videoId}`
          ], { timeout: 40000 });
          if (await getValidAudioFile()) downloaded = true;
        } catch (ytDlErr) {
          this.log.warn({ err: ytDlErr.message, videoId }, 'Direct YouTube video download failed, trying search fallback');
        }
      }

      // Layer 2: Direct clean query search with authenticated session & node challenge solver
      if (!downloaded) {
        try {
          await execFileAsync('yt-dlp', [
            '--no-warnings',
            '--no-playlist',
            '--ffmpeg-location', ffmpegBin,
            ...cookieArgs,
            '-N', '8',
            '--max-filesize', '48M',
            '--js-runtimes', 'node:/usr/bin/node',
            '-f', 'ba[ext=m4a]/ba/b',
            '-x',
            '--audio-format', 'mp3',
            '--audio-quality', '2',
            '-P', tempDir,
            '-o', '%(title).60s.%(ext)s',
            `ytsearch1:${clean}`
          ], { timeout: 40000 });
          if (await getValidAudioFile()) downloaded = true;
        } catch (ytSearchErr) {
          this.log.warn({ err: ytSearchErr.message }, 'YouTube query search failed, trying proxy fallback');
        }
      }

      // Layer 3: YouTube via SOCKS5 proxy fallback (only when local proxy port is reachable)
      if (!downloaded) {
        try {
          const { isProxyReachable } = await import('./musicResolver.js');
          if (await isProxyReachable('socks5h://127.0.0.1:9000')) {
            await execFileAsync('yt-dlp', [
              '--no-warnings',
              '--no-playlist',
              '--ffmpeg-location', ffmpegBin,
              '--proxy', 'socks5h://127.0.0.1:9000',
              ...cookieArgs,
              '-N', '8',
              '--max-filesize', '48M',
              '--js-runtimes', 'node:/usr/bin/node',
              '-f', 'ba[ext=m4a]/ba/b',
              '-x',
              '--audio-format', 'mp3',
              '--audio-quality', '2',
              '-P', tempDir,
              '-o', '%(title).60s.%(ext)s',
              `ytsearch1:${clean}`
            ], { timeout: 40000 });
            if (await getValidAudioFile()) downloaded = true;
          }
        } catch (proxyErr) {
          this.log.warn({ err: proxyErr.message }, 'YouTube proxy download failed, trying multi-source resolver');
        }
      }

      // Layer 4: Fast multi-source HTTP resolver (JioSaavn 320k, Audius full stream)
      if (!downloaded) {
        try {
          const { resolveAndDownloadAudio } = await import('./musicResolver.js');
          const resolvedPath = join(tempDir, 'resolved.mp3');
          const preMeta = bestSp ? { title: trackTitle, artist: trackAuthor } : null;
          const resolved = await resolveAndDownloadAudio({
            query: clean,
            trackId: videoId || null,
            tempPath: resolvedPath,
            ffmpegPath: ffmpegBin,
            minSeconds: 45,
            meta: preMeta,
            skipYouTube: true,
            onProgress
          });
          if (resolved.ok) {
            downloaded = true;
            onProgress?.(`Got full track via ${resolved.source} ♡`);
            this.log?.info?.({ query: clean, source: resolved.source }, 'multi-source resolver delivered full track');
          }
        } catch (rErr) {
          this.log?.debug?.({ err: rErr.message }, 'resolver layer failed');
        }
      }

      // Layer 5: SoundCloud Search fallback (non-DRM tracks)
      if (!downloaded) {
        onProgress?.(`Trying SoundCloud for "${clean}"… ♡`);
        try {
          await execFileAsync('yt-dlp', [
            '--no-warnings',
            '--no-playlist',
            '--ffmpeg-location', ffmpegBin,
            '-N', '8',
            '--max-filesize', '48M',
            '-x',
            '--audio-format', 'mp3',
            '--audio-quality', '2',
            '-P', tempDir,
            '-o', '%(title).60s.%(ext)s',
            `scsearch1:${clean}`
          ], { timeout: 40000 });
          if (await getValidAudioFile()) downloaded = true;
        } catch (scErr) {
          this.log.warn({ err: scErr.message }, 'SoundCloud search download also failed');
        }
      }

      const validAudio = await getValidAudioFile();
      if (!validAudio) {
        throw new Error(`Could not download full audio track for "${clean}". Please check spelling and try again ♡`);
      }
      const audioFile = validAudio.filename;
      if (validAudio.duration && !trackDuration) {
        const min = Math.floor(validAudio.duration / 60);
        const sec = String(Math.floor(validAudio.duration % 60)).padStart(2, '0');
        trackDuration = `${min}:${sec}`;
      }

      const finalClean = cleanSongMetadata(trackTitle, trackAuthor);
      if (finalClean.title) trackTitle = finalClean.title;
      if (finalClean.artist) trackAuthor = finalClean.artist;

      onProgress?.(`Processing audio & tagging "${trackTitle}"… ♡`);

      const [coverBuf, audioBuf] = await Promise.all([
        coverPromise.then(async (buf) => {
          if (buf) return buf;
          const files = readdirSync(tempDir);
          const thumbFile = files.find((f) => /\.(webp|jpg|jpeg|png)$/i.test(f));
          if (thumbFile) {
            try {
              const rawThumb = readFileSync(join(tempDir, thumbFile));
              return await sharp(rawThumb).jpeg({ quality: 90 }).toBuffer();
            } catch {
              return readFileSync(join(tempDir, thumbFile));
            }
          }
          return null;
        }).catch(() => null),
        this.#optimizeAudioToCbrMp3(join(tempDir, audioFile), {
          title: trackTitle,
          artist: trackAuthor,
          year: trackYear
        })
      ]);

      // Save to /data/audio_cache/<videoId>.mp3 and query hash so future group requests or inline streams are 0ms!
      if (audioBuf && audioBuf.length > 40000) {
        try {
          mkdirSync('/data/audio_cache', { recursive: true });
          if (videoId) writeFileSync(`/data/audio_cache/${videoId}.mp3`, audioBuf);
          writeFileSync(`/data/audio_cache/q_${queryCacheHash}.mp3`, audioBuf);
        } catch {}
      }

      const safeFilename = `${trackTitle.replace(/[^\w\s-]/g, '').trim() || 'track'}.mp3`;
      const mediaItems = coverBuf ? [{
        type: 'photo',
        buffer: coverBuf,
        filename: 'cover.jpg',
        mimeType: 'image/jpeg'
      }] : [];

      return {
        sourceUrl: query,
        platform: 'spotify',
        title: trackTitle,
        artist: trackAuthor,
        author: trackAuthor,
        year: trackYear,
        duration: trackDuration,
        mediaItems,
        audioTrack: {
          buffer: audioBuf,
          filename: safeFilename,
          title: trackTitle,
          performer: trackAuthor,
          year: trackYear,
          duration: validAudio.duration
        }
      };
    } finally {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
  }

  /**
   * Direct media URL downloader
   */
  async #downloadDirect(url, { onProgress }) {
    onProgress?.('Fetching direct media file… ♡');
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`Direct download failed with status ${res.status}`);

    const buf = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') || '';
    const isVid = /video/i.test(contentType) || /\.(mp4|webm|mov|mkv)/i.test(url);
    const isAudio = /audio/i.test(contentType) || /\.(mp3|m4a|wav|ogg|opus)/i.test(url);

    let mediaItems = [];
    let audioTrack = null;

    if (isAudio) {
      audioTrack = {
        buffer: buf,
        filename: 'direct_audio.mp3',
        title: 'Audio File',
        performer: 'Direct Media'
      };
    } else {
      let finalBuf = buf;
      if (isVid) {
        try {
          finalBuf = await optimizeVideoForTelegram(buf) || buf;
        } catch {}
      }
      mediaItems.push({
        type: isVid ? 'video' : 'photo',
        buffer: finalBuf,
        filename: isVid ? 'video.mp4' : 'photo.jpg',
        mimeType: isVid ? 'video/mp4' : 'image/jpeg'
      });
      if (isVid) {
        const ext = await this.extractAudioFromBuffer(buf);
        if (ext) {
          audioTrack = {
            buffer: ext,
            filename: 'extracted_audio.mp3',
            title: 'Audio Track',
            performer: 'Lancy Bot'
          };
        }
      }
    }

    return {
      sourceUrl: url,
      platform: 'direct',
      title: 'Direct Media',
      author: 'Lancy Downloader',
      mediaItems,
      audioTrack
    };
  }

  /**
   * Spankbang 18+ Video Downloader
   */
  async #downloadSpankbang(url, { onProgress }) {
    onProgress?.('Extracting 18+ video stream… ♡');
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        signal: AbortSignal.timeout(10000)
      });
      const html = await res.text();
      const mp4Match = html.match(/https:\/\/tbv\.sb-cd\.com\/t\/\d+\/[0-9a-z]+\/[0-9a-z]+\/td\.mp4/i);
      const titleMatch = html.match(/<title>(.*?)<\/title>/i);
      const title = titleMatch ? titleMatch[1].replace(/- SpankBang/i, '').trim() : '18+ Adult Video';
      if (mp4Match) {
        onProgress?.('Downloading video clip… ♡');
        return this.#downloadDirect(mp4Match[0], { onProgress });
      }
      throw new Error('Could not extract direct stream for this video');
    } catch (err) {
      this.log.debug({ err: err?.message, url }, 'spankbang extraction fallback to universal');
      return this.#downloadUniversal(url, { onProgress, platform: 'spankbang' });
    }
  }

  /**
   * Universal Downloader using yt-dlp + FFmpeg:
   * Handles 1000+ websites, carousels, playlists, and extracts clean MP3 audio tracks!
   */
  async #downloadUniversal(url, { onProgress, platform = 'generic', isYouTube = false, extraArgs = [], metadataHint = null }) {
    const tempDir = mkdtempSync(join(tmpdir(), 'lancy_dl_'));
    onProgress?.('Running engine & extracting files… ♡');

    try {
      const cookieArgs = getCookieArgs();
      const tgLimitMb = Math.round(uploadLimitBytes() / (1024 * 1024));
      const maxSourceMb = Math.max(60, Number(process.env.MEDIA_MAX_SOURCE_MB) || tgLimitMb || 2000);
      const isHighLimit = tgLimitMb > 100;
      const needsDesktopUa = ['tiktok', 'bilibili', 'reddit', 'vimeo', 'dailymotion', 'twitch'].includes(platform) || /tiktok\.com|bilibili\.com|b23\.tv|reddit\.com/i.test(url);
      const userAgent = needsDesktopUa
        ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
        : 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36';
      const args = [
        '--no-warnings',
        '--no-playlist',
        '--write-thumbnail',
        '--write-info-json',
        '--concurrent-fragments', '8',
        '--max-filesize', `${maxSourceMb}M`,
        // When local 2GB Bot API is active, allow full HD streams; otherwise prefer ~45M rendition.
        '-S', isHighLimit ? 'res:720,ext:mp4:m4a' : 'filesize~45M',
        '--js-runtimes', 'node:/usr/bin/node',
        '--ffmpeg-location', resolveFfmpegPath() || '/usr/bin/ffmpeg',
        '--user-agent', userAgent,
        '-P', tempDir,
        '-o', '%(autonumber)02d_%(title).50s.%(ext)s',
        url
      ];

      if (cookieArgs.length > 0) {
        args.splice(1, 0, ...cookieArgs);
      } else {
        args.splice(1, 0,
          '--extractor-args', 'youtube:player_client=android,web'
        );
      }

      if (Array.isArray(extraArgs) && extraArgs.length > 0) {
        args.splice(1, 0, ...extraArgs);
      }

      if (isYouTube) {
        // Enforce mp4 and max 1080p for Telegram file limit safety
        args.splice(1, 0, '-f', 'bv*[ext=mp4][height<=1080]+ba[ext=m4a]/b[ext=mp4]/ba/b/best');
      }

      await execFileAsync('yt-dlp', args, { timeout: isHighLimit ? 360000 : 90000 });

      const files = readdirSync(tempDir);
      if (files.length === 0) {
        throw new Error(`No media could be downloaded from this link. It may exceed the ${maxSourceMb} MB source limit or be unavailable ♡`);
      }

      const mediaItems = [];
      let audioTrack = null;
      let title = metadataHint?.title || 'Downloaded Media';
      let author = metadataHint?.author || 'Social Media';
      let durationSeconds = Number(metadataHint?.durationSeconds || 0) || null;

      // Sort files to preserve order; read .info.json first for accurate title/author/duration
      files.sort();
      for (const f of files) {
        if (!f.endsWith('.info.json')) continue;
        try {
          const info = JSON.parse(readFileSync(join(tempDir, f), 'utf8'));
          if (info?.title && !metadataHint?.title) title = String(info.title).trim();
          const detectedAuthor = info?.uploader || info?.channel || info?.artist || info?.creator;
          if (detectedAuthor && !metadataHint?.author) author = String(detectedAuthor).trim();
          if (Number(info?.duration) > 0 && !durationSeconds) durationSeconds = Math.round(Number(info.duration));
        } catch {}
      }

      for (const f of files) {
        if (f.endsWith('.info.json') || f.endsWith('.part') || f.endsWith('.ytdl')) continue;
        const fullPath = join(tempDir, f);
        const stat = statSync(fullPath);
        if (stat.isDirectory() || stat.size === 0) continue;

        const ext = f.split('.').pop().toLowerCase();

        if (['mp4', 'webm', 'mov', 'mkv'].includes(ext)) {
          if (stat.size > 80 * 1024 * 1024) {
            const largeDir = existsSync('/data/tmp') ? '/data/tmp' : tmpdir();
            mkdirSync(largeDir, { recursive: true });
            const movedPath = join(largeDir, `lancy_large_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.mp4`);
            renameSync(fullPath, movedPath);
            mediaItems.push({
              type: 'video',
              filePath: movedPath,
              sizeBytes: stat.size,
              filename: `${f.replace(/\.[^.]+$/, '')}.mp4`,
              mimeType: 'video/mp4',
              cleanupOnDeliver: true
            });
          } else {
            const buf = readFileSync(fullPath);
            let vidBuf = buf;
            try {
              vidBuf = await optimizeVideoForTelegram(buf) || buf;
            } catch {}
            mediaItems.push({
              type: 'video',
              buffer: vidBuf,
              filename: `${f.replace(/\.[^.]+$/, '')}.mp4`,
              mimeType: 'video/mp4'
            });

            // Extract audio from first video with sound
            if (!audioTrack) {
              onProgress?.('Checking video sound track… ♡');
              const extAudio = await this.extractAudioFromFile(fullPath);
              if (extAudio) {
                audioTrack = {
                  buffer: extAudio,
                  filename: `${f.replace(/\.[^.]+$/, '')}.mp3`,
                  title: title !== 'Downloaded Media' ? title : f.replace(/\.[^.]+$/, ''),
                  performer: author !== 'Social Media' ? author : 'Audio Track'
                };
              }
            }
          }
        } else if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
          const buf = readFileSync(fullPath);
          mediaItems.push({
            type: 'photo',
            buffer: buf,
            filename: f,
            mimeType: 'image/jpeg'
          });
        } else if (['mp3', 'm4a', 'wav', 'opus'].includes(ext)) {
          if (!audioTrack && stat.size <= 80 * 1024 * 1024) {
            const buf = readFileSync(fullPath);
            audioTrack = {
              buffer: buf,
              filename: `${f.replace(/\.[^.]+$/, '')}.mp3`,
              title: title !== 'Downloaded Media' ? title : f.replace(/\.[^.]+$/, ''),
              performer: author !== 'Social Media' ? author : 'Audio Track'
            };
          }
        }
      }

      if (mediaItems.length === 0 && !audioTrack) {
        throw new Error('The media format from this link is not supported ♡');
      }

      return {
        sourceUrl: url,
        platform,
        title,
        author,
        durationSeconds,
        mediaItems,
        audioTrack
      };
    } finally {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
  }

  /**
   * Extract audio from a video buffer using FFmpeg to high-quality MP3 (VBR ~190kbps)
   */
  async extractAudioFromBuffer(videoBuffer) {
    if (!Buffer.isBuffer(videoBuffer) || videoBuffer.length < 1024) return null;
    const tmpIn = join(tmpdir(), `lancy_in_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
    const tmpOut = join(tmpdir(), `lancy_out_${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`);

    try {
      writeFileSync(tmpIn, videoBuffer);
      return await this.extractAudioFromFile(tmpIn);
    } finally {
      try { unlinkSync(tmpIn); } catch {}
      try { unlinkSync(tmpOut); } catch {}
    }
  }

  /**
   * Extract audio from a file path using FFmpeg
   */
  async extractAudioFromFile(filePath) {
    const tmpOut = join(tmpdir(), `lancy_out_${Date.now()}_${Math.random().toString(36).slice(2)}.mp3`);
    try {
      await execFileAsync('ffmpeg', [
        '-y',
        '-i', filePath,
        '-vn',
        '-acodec', 'libmp3lame',
        '-q:a', '2',
        tmpOut
      ], { timeout: 30000 });

      if (existsSync(tmpOut)) {
        const buf = readFileSync(tmpOut);
        if (buf.length > 2048) {
          return buf;
        }
      }
      return null;
    } catch {
      // If video has no audio stream, FFmpeg returns error - return null safely
      return null;
    } finally {
      try { unlinkSync(tmpOut); } catch {}
    }
  }

  /**
   * Optimize video buffer or file for Telegram playback
   */
  async optimizeVideo(input) {
    return optimizeVideoForTelegram(input);
  }
}

/**
 * Optimize video for Telegram mobile players:
 * Enforces H.264 (AVC) video, AAC audio, yuv420p color format, and +faststart moov atom.
 * Guarantees zero "Format not supported" errors across all Telegram clients (iOS, Android, Desktop).
 */
export async function optimizeVideoForTelegram(input) {
  if (!input) return null;
  const tempDir = mkdtempSync(join(tmpdir(), 'lancy_vidopt_'));
  const inPath = join(tempDir, 'in.mp4');
  const outPath = join(tempDir, 'out.mp4');

  try {
    if (Buffer.isBuffer(input)) {
      writeFileSync(inPath, input);
    } else if (typeof input === 'string' && existsSync(input)) {
      writeFileSync(inPath, readFileSync(input));
    } else {
      return null;
    }

    // Probe existing streams
    let needsFullTranscode = true;
    try {
      const probeRes = await execFileAsync('ffprobe', [
        '-v', 'error',
        '-show_entries', 'stream=codec_name,codec_type',
        '-of', 'json',
        inPath
      ]);
      const probeJson = JSON.parse(probeRes.stdout || '{}');
      const streams = probeJson.streams || [];
      const vStream = streams.find((s) => s.codec_type === 'video');
      const aStream = streams.find((s) => s.codec_type === 'audio');

      if (vStream?.codec_name === 'h264' && (!aStream || aStream.codec_name === 'aac')) {
        needsFullTranscode = false;
      }
    } catch {}

    const ffmpegArgs = needsFullTranscode
      ? [
          '-y',
          '-i', inPath,
          '-c:v', 'libx264',
          '-pix_fmt', 'yuv420p',
          '-profile:v', 'high',
          '-level', '4.0',
          '-preset', 'veryfast',
          '-crf', '23',
          '-c:a', 'aac',
          '-b:a', '128k',
          '-ar', '44100',
          '-movflags', '+faststart',
          outPath
        ]
      : [
          '-y',
          '-i', inPath,
          '-c', 'copy',
          '-movflags', '+faststart',
          outPath
        ];

    await execFileAsync('ffmpeg', ffmpegArgs, { timeout: 60000 });

    if (existsSync(outPath) && statSync(outPath).size > 1024) {
      return readFileSync(outPath);
    }
    return Buffer.isBuffer(input) ? input : readFileSync(input);
  } catch {
    return Buffer.isBuffer(input) ? input : (existsSync(inPath) ? readFileSync(inPath) : null);
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}
