import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { logger } from '../core/logger.js';
import {
  tiktokDl,
  instagramDl,
  twitterDl,
  youtubeDl,
  facebookDl,
  capcutDl,
  spotifyDl,
  pinterestDl,
  universalDl
} from 'social-dl';

import { searchSongByLyrics, cleanSongMetadata } from './lyrics.js';

const execFileAsync = promisify(execFile);

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
    if (/tiktok\.com|vt\.tiktok\.com|vm\.tiktok\.com/.test(u)) return 'tiktok';
    if (/instagram\.com/.test(u)) return 'instagram';
    if (/pinterest\.com|pin\.it/.test(u)) return 'pinterest';
    if (/youtube\.com|youtu\.be/.test(u)) return 'youtube';
    if (/twitter\.com|x\.com/.test(u)) return 'twitter';
    if (/facebook\.com|fb\.watch|fb\.com/.test(u)) return 'facebook';
    if (/capcut\.com/.test(u)) return 'capcut';
    if (/spotify\.com/.test(u)) return 'spotify';
    if (/reddit\.com|redd\.it/.test(u)) return 'reddit';
    if (/threads\.net/.test(u)) return 'threads';
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
    const rawUrl = String(url || '').trim();
    if (!rawUrl) {
      throw new Error('Please provide a media link or song title to search ♡');
    }

    const platform = this.detectPlatform(rawUrl);
    if (platform !== 'music-search' && !/^https?:\/\//i.test(rawUrl)) {
      throw new Error('Please provide a valid link starting with http:// or https:// ♡');
    }

    this.log.info({ url: rawUrl, platform }, 'download started');
    onProgress?.(`Detecting platform: ${platform.toUpperCase()} ♡`);

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
      case 'music-search':
        return this.#downloadMusicSearch(rawUrl, { onProgress });
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
    try {
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
      const json = await res.json().catch(() => null);

      if (json?.code === 0 && json.data) {
        const d = json.data;
        const title = d.title || 'TikTok Media';
        const author = d.author?.nickname || d.author?.unique_id || 'TikTok';
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
            const vidBuf = Buffer.from(await vidRes.arrayBuffer());
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
      if (info?.video) {
        const vidRes = await fetch(info.video, { signal: AbortSignal.timeout(30000) });
        if (vidRes.ok) {
          const vidBuf = Buffer.from(await vidRes.arrayBuffer());
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

                // Carousel / Album extraction
                if (pin.carouselData?.carouselSlots?.length) {
                  for (const slot of pin.carouselData.carouselSlots) {
                    const img = slot.images_orig?.url
                      || (slot.imageSignature ? `https://i.pinimg.com/originals/${slot.imageSignature.slice(0, 2)}/${slot.imageSignature.slice(2, 4)}/${slot.imageSignature.slice(4, 6)}/${slot.imageSignature}.jpg` : null)
                      || slot.images_1200x?.url
                      || slot.images_736x?.url;
                    if (img && !imageUrls.includes(img)) {
                      imageUrls.push(img);
                    }
                  }
                }

                // Story / Idea Pin extraction
                if (pin.storyPinData?.pages?.length) {
                  for (const page of pin.storyPinData.pages) {
                    const img = page.image?.images?.originals?.url || page.image?.images?.['736x']?.url;
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
          const vBuf = Buffer.from(await vRes.arrayBuffer());
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
        return {
          sourceUrl: resolvedUrl,
          platform: 'pinterest',
          title,
          author: 'Pinterest',
          mediaItems,
          audioTrack
        };
      }
    } catch (err) {
      this.log.warn({ err: err.message }, 'pinterest custom extractor failed, trying social-dl');
    }

    // Fallback to social-dl
    try {
      onProgress?.('Trying Pinterest direct downloader… ♡');
      const pRes = await pinterestDl(url);
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
                const buf = Buffer.from(await r.arrayBuffer());
                const isVid = item.type === 'video' || /\.(mp4|mov|webm)/i.test(itemUrl);
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

    // Layer 2: yt-dlp fallback
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
   * Fast CBR 192k MP3 re-encoding with clean ID3v2.3 tags
   * Strips all bloated YouTube descriptions and ensures instant 0ms playback in mobile ExoPlayer / Telegram
   */
  async #optimizeAudioToCbrMp3(input, { title = '', artist = '', album = '', year = '' } = {}) {
    const tempDir = join(tmpdir(), `lancy_cbr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
    mkdirSync(tempDir, { recursive: true });

    let inPath;
    if (typeof input === 'string') {
      inPath = input;
    } else if (Buffer.isBuffer(input)) {
      inPath = join(tempDir, 'input_raw');
      writeFileSync(inPath, input);
    } else {
      return input;
    }

    const outPath = join(tempDir, 'optimized.mp3');
    try {
      const cleaned = cleanSongMetadata(title, artist);
      let optTitle = cleaned.title || title || 'Audio Track';
      if (optTitle.length > 45) {
        optTitle = `${optTitle.slice(0, 42).trim()}…`;
      }
      const optArtist = cleaned.artist || artist || 'Spotify';

      await execFileAsync('ffmpeg', [
        '-y',
        '-i', inPath,
        '-map_metadata', '-1',
        '-c:a', 'libmp3lame',
        '-b:a', '192k',
        '-ar', '44100',
        '-id3v2_version', '3',
        '-metadata', `title=${optTitle}`,
        '-metadata', `artist=${optArtist}`,
        ...(album ? ['-metadata', `album=${album}`] : []),
        ...(year ? ['-metadata', `date=${year}`] : []),
        outPath
      ], { timeout: 30000 });

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
   * Spotify Downloader: Metadata, Cover Art & Audio
   */
  async #downloadSpotify(url, { onProgress }) {
    onProgress?.('Fetching Spotify track metadata… ♡');
    let title = 'Spotify Track';
    let artist = '';
    let album = '';
    let year = '';
    let duration = '';
    let coverBuf = null;

    // 1. Fetch metadata & cover art via Spotify oembed API
    try {
      const oembedRes = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(10000) });
      if (oembedRes.ok) {
        const oembedData = await oembedRes.json();
        if (oembedData.title) title = oembedData.title;
        if (oembedData.thumbnail_url) {
          const imgRes = await fetch(oembedData.thumbnail_url, { signal: AbortSignal.timeout(10000) });
          if (imgRes.ok) coverBuf = Buffer.from(await imgRes.arrayBuffer());
        }
      }
    } catch {}

    // 2. Extract song title, artist, album, year & high-res artwork from Spotify HTML meta tags
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

        if (ogTitle) {
          const clean = ogTitle.replace(/\s*\|\s*Spotify.*/i, '').trim();
          if (clean) title = clean;
        }

        if (ogDesc) {
          // Spotify og:description format: "Artist · Album · Song · Year"
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

        // Schema.org JSON-LD
        const ldMatch = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s);
        if (ldMatch) {
          try {
            const ld = JSON.parse(ldMatch[1]);
            if (ld.name && (!title || title === 'Spotify Track')) title = ld.name;
            if (ld.datePublished && !year) year = ld.datePublished.slice(0, 4);
          } catch {}
        }

        // High-res album artwork
        if (ogImage && !coverBuf) {
          try {
            const imgRes = await fetch(ogImage, { signal: AbortSignal.timeout(10000) });
            if (imgRes.ok) coverBuf = Buffer.from(await imgRes.arrayBuffer());
          } catch {}
        }
      }
    } catch {}

    // 3. Try social-dl
    try {
      const res = await spotifyDl(url);
      if (res?.title) title = res.title;
      if (res?.artist && !artist) artist = res.artist;
      if (res?.formats?.length) {
        const best = res.formats[0];
        const musRes = await fetch(best.url, { signal: AbortSignal.timeout(30000) });
        if (musRes.ok) {
          let buf = Buffer.from(await musRes.arrayBuffer());
          buf = await this.#optimizeAudioToCbrMp3(buf, { title, artist, album, year });
          const mediaItems = coverBuf ? [{ type: 'photo', buffer: coverBuf, filename: 'cover.jpg', mimeType: 'image/jpeg' }] : [];
          return {
            sourceUrl: url,
            platform: 'spotify',
            title,
            artist,
            author: artist || 'Spotify',
            album,
            year,
            duration,
            mediaItems,
            audioTrack: {
              buffer: buf,
              filename: `${title.replace(/[^\w\s-]/g, '') || 'track'}.mp3`,
              title,
              performer: artist || 'Spotify',
              album,
              year
            }
          };
        }
      }
    } catch (err) {
      this.log.debug({ err: err.message }, 'spotifyDl threw');
      const match = err.message?.match(/“([^”]+)”\s*by\s*([^.]+)/);
      if (match) {
        if (!title || title === 'Spotify Track') title = match[1].trim();
        if (!artist) artist = match[2].trim();
      }
    }

    // 4. Download clean audio match via ytsearch
    const primaryArtist = (artist || '').split(/[,&]/)[0].trim();
    const cleanTitle = (title || '').replace(/\(.*?\)/g, '').replace(/\[.*?\]/g, '').trim();

    const candidateQueries = [
      `${primaryArtist} ${cleanTitle} audio`,
      `${artist} ${cleanTitle} audio`,
      `${primaryArtist} ${title} audio`,
      `${title} audio`
    ].map((q) => q.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);

    onProgress?.(`Finding audio match for "${title}"… ♡`);

    for (const query of candidateQueries) {
      const tempDir = join(tmpdir(), `lancy_sp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
      mkdirSync(tempDir, { recursive: true });
      try {
        let downloaded = false;
        try {
          await execFileAsync('yt-dlp', [
            '--no-warnings',
            '--js-runtimes', 'node:/usr/bin/node',
            '--extractor-args', 'youtube:player_client=android,web',
            '--user-agent', 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36',
            '-f', 'ba/b',
            '-x',
            '--audio-format', 'mp3',
            '--audio-quality', '2',
            '-o', join(tempDir, '%(title).60s.%(ext)s'),
            `ytsearch1:${query}`
          ], { timeout: 60000 });
          downloaded = true;
        } catch (ytErr) {
          this.log.debug({ err: ytErr.message, query }, 'YouTube query failed, trying SoundCloud fallback');
          await execFileAsync('yt-dlp', [
            '--no-warnings',
            '-x',
            '--audio-format', 'mp3',
            '--audio-quality', '2',
            '-o', join(tempDir, '%(title).60s.%(ext)s'),
            `scsearch1:${query}`
          ], { timeout: 60000 });
          downloaded = true;
        }

        const files = readdirSync(tempDir);
        const audioFile = files.find((f) => /\.(mp3|m4a|webm|opus|ogg|wav)$/i.test(f));
        if (audioFile) {
          const audioBuf = await this.#optimizeAudioToCbrMp3(join(tempDir, audioFile), {
            title,
            artist,
            album,
            year
          });
          const mediaItems = coverBuf ? [{ type: 'photo', buffer: coverBuf, filename: 'cover.jpg', mimeType: 'image/jpeg' }] : [];
          return {
            sourceUrl: url,
            platform: 'spotify',
            title,
            artist,
            author: artist || 'Spotify',
            album,
            year,
            duration,
            mediaItems,
            audioTrack: {
              buffer: audioBuf,
              filename: `${title.replace(/[^\w\s-]/g, '') || 'track'}.mp3`,
              title,
              performer: artist || 'Spotify',
              album,
              year
            }
          };
        }
      } catch (err) {
        this.log.debug({ err: err.message, query }, 'candidate query search failed');
      } finally {
        try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
      }
    }

    throw new Error(`Could not download audio track for "${title}".`);
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
      // Check if query looks like lyrics or a verse snippet
      let isLyricQuery = clean.includes('\n') || (clean.split(/\s+/).length >= 4 && !/[-–—]/.test(clean));
      if (!isLyricQuery && clean.split(/\s+/).length >= 3) {
        if (/\b(love|feel|heart|baby|wished|star|shoot|shot|bulletproof|eyes|night|hold|dance|wanna|gonna|overtime|tears|fly|die|kiss|look|know|tell|say|fall|time|girl|boy|never|always)\b/i.test(clean)) {
          isLyricQuery = true;
        }
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

      // 1. YouTube Primary Search (ytsearch5 ranked by query relevance)
      const queryTerms = clean.toLowerCase().split(/\s+/).filter(Boolean);
      try {
        let stdout = '';
        try {
          const res = await execFileAsync('yt-dlp', [
            '--no-warnings',
            '--js-runtimes', 'node:/usr/bin/node',
            '--ignore-errors',
            '--print', '%(id)s ||| %(title)s ||| %(channel)s ||| %(duration_string)s ||| %(upload_date)s ||| %(thumbnail)s',
            `ytsearch5:${clean}`
          ], { timeout: 15000 });
          stdout = res.stdout || '';
        } catch (ytErr) {
          stdout = ytErr.stdout || '';
        }

        const lines = stdout.trim().split('\n').filter((l) => l.includes(' ||| '));
        const candidates = [];

        for (const line of lines) {
          const parts = line.split(' ||| ');
          if (!parts[0]) continue;
          const id = parts[0].trim();
          const title = (parts[1] || '').trim();
          const channel = (parts[2] || '').trim();
          const duration = (parts[3] || '').trim();
          const year = (parts[4] || '').slice(0, 4);
          const thumb = (parts[5] || '').trim();

          const combined = `${title} ${channel}`.toLowerCase();
          const score = queryTerms.reduce((acc, term) => acc + (combined.includes(term) ? 1 : 0), 0);
          candidates.push({ id, title, channel, duration, year, thumb, score });
        }

        if (candidates.length > 0) {
          candidates.sort((a, b) => b.score - a.score);
          const best = candidates[0];
          videoId = best.id;
          trackTitle = best.title;
          trackAuthor = best.channel;
          trackDuration = best.duration;
          trackYear = best.year;
          trackThumbnailUrl = best.thumb;
        }
      } catch (ytErr) {
        this.log.warn({ err: ytErr?.message, clean }, 'YouTube primary search failed, trying Spotify fallback');
      }

      // 2. Spotify / Deezer Fallback (if YouTube search yielded no match)
      if (!videoId) {
        onProgress?.(`Trying Spotify metadata for "${clean}"… ♡`);
        try {
          const spRes = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(clean)}&limit=3`, {
            signal: AbortSignal.timeout(5000)
          });
          if (spRes.ok) {
            const spData = await spRes.json();
            if (Array.isArray(spData.data) && spData.data.length > 0) {
              const spCandidates = spData.data.map((item) => {
                const combined = `${item.title} ${item.artist?.name || ''}`.toLowerCase();
                const score = queryTerms.reduce((acc, term) => acc + (combined.includes(term) ? 1 : 0), 0);
                return { item, score };
              });
              spCandidates.sort((a, b) => b.score - a.score);
              const bestSp = spCandidates[0].item;
              trackTitle = bestSp.title || trackTitle;
              trackAuthor = bestSp.artist?.name || trackAuthor;
              if (bestSp.duration) {
                const min = Math.floor(bestSp.duration / 60);
                const sec = String(bestSp.duration % 60).padStart(2, '0');
                trackDuration = `${min}:${sec}`;
              }
              trackThumbnailUrl = bestSp.album?.cover_big || bestSp.album?.cover_medium || trackThumbnailUrl;
            }
          }
        } catch {}
      }

      // Clean track title & author from search if needed
      const initialClean = cleanSongMetadata(trackTitle, trackAuthor);
      if (initialClean.title && initialClean.title.toLowerCase() !== 'song') {
        trackTitle = initialClean.title;
        if (initialClean.artist) trackAuthor = initialClean.artist;
      }

      onProgress?.(`Downloading audio track for "${trackTitle}"… ♡`);

      let downloaded = false;

      // Layer 1: Download matched YouTube video with Android client (bypasses 403 SABR block)
      if (videoId) {
        try {
          await execFileAsync('yt-dlp', [
            '--no-warnings',
            '--js-runtimes', 'node:/usr/bin/node',
            '--ignore-errors',
            '--extractor-args', 'youtube:player_client=android,web',
            '--user-agent', 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36',
            '-f', 'ba/b',
            '-x',
            '--audio-format', 'mp3',
            '--audio-quality', '2',
            '--write-thumbnail',
            '-P', tempDir,
            '-o', '%(title).60s.%(ext)s',
            `https://www.youtube.com/watch?v=${videoId}`
          ], { timeout: 60000 });
          downloaded = true;
        } catch (ytDlErr) {
          this.log.warn({ err: ytDlErr.message, videoId }, 'YouTube direct video download failed, trying search fallback');
        }
      }

      // Layer 2: Direct clean query search with Android client
      if (!downloaded) {
        try {
          await execFileAsync('yt-dlp', [
            '--no-warnings',
            '--js-runtimes', 'node:/usr/bin/node',
            '--ignore-errors',
            '--extractor-args', 'youtube:player_client=android,web',
            '--user-agent', 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36',
            '-f', 'ba/b',
            '-x',
            '--audio-format', 'mp3',
            '--audio-quality', '2',
            '--write-thumbnail',
            '-P', tempDir,
            '-o', '%(title).60s.%(ext)s',
            `ytsearch1:${clean}`
          ], { timeout: 60000 });
          downloaded = true;
        } catch (ytSearchErr) {
          this.log.warn({ err: ytSearchErr.message }, 'YouTube searchTarget download failed, trying SoundCloud fallback');
        }
      }

      // Layer 3: SoundCloud Search fallback (zero 403 blocks)
      if (!downloaded) {
        onProgress?.(`Trying SoundCloud for "${clean}"… ♡`);
        try {
          await execFileAsync('yt-dlp', [
            '--no-warnings',
            '-x',
            '--audio-format', 'mp3',
            '--audio-quality', '2',
            '--write-thumbnail',
            '-P', tempDir,
            '-o', '%(title).60s.%(ext)s',
            `scsearch1:${clean}`
          ], { timeout: 60000 });
          downloaded = true;
        } catch (scErr) {
          this.log.error({ err: scErr.message }, 'SoundCloud search download also failed');
        }
      }

      const files = readdirSync(tempDir);
      const audioFile = files.find((f) => /\.(mp3|m4a|webm|opus|ogg|wav)$/i.test(f));
      if (!audioFile) {
        throw new Error(`Could not download audio for "${clean}". Please check spelling and try again ♡`);
      }

      const finalClean = cleanSongMetadata(trackTitle, trackAuthor);
      if (finalClean.title) trackTitle = finalClean.title;
      if (finalClean.artist) trackAuthor = finalClean.artist;

      const audioBuf = await this.#optimizeAudioToCbrMp3(join(tempDir, audioFile), {
        title: trackTitle,
        artist: trackAuthor,
        year: trackYear
      });

      let coverBuf = null;
      const thumbFile = files.find((f) => /\.(webp|jpg|jpeg|png)$/i.test(f));
      if (thumbFile) {
        try {
          const rawThumb = readFileSync(join(tempDir, thumbFile));
          coverBuf = await sharp(rawThumb).jpeg({ quality: 90 }).toBuffer();
        } catch {
          coverBuf = readFileSync(join(tempDir, thumbFile));
        }
      } else if (trackThumbnailUrl) {
        try {
          const imgRes = await fetch(trackThumbnailUrl, { signal: AbortSignal.timeout(10000) });
          if (imgRes.ok) {
            const rawThumb = Buffer.from(await imgRes.arrayBuffer());
            coverBuf = await sharp(rawThumb).jpeg({ quality: 90 }).toBuffer();
          }
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
          year: trackYear
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
      mediaItems.push({
        type: isVid ? 'video' : 'photo',
        buffer: buf,
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
   * Universal Downloader using yt-dlp + FFmpeg:
   * Handles 1000+ websites, carousels, playlists, and extracts clean MP3 audio tracks!
   */
  async #downloadUniversal(url, { onProgress, platform = 'generic', isYouTube = false }) {
    const tempDir = mkdtempSync(join(tmpdir(), 'lancy_dl_'));
    onProgress?.('Running engine & extracting files… ♡');

    try {
      const args = [
        '--no-warnings',
        '--no-playlist',
        '--write-thumbnail',
        '--js-runtimes', 'node:/usr/bin/node',
        '--ffmpeg-location', '/usr/bin/ffmpeg',
        '--extractor-args', 'youtube:player_client=android,web',
        '--user-agent', 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36',
        '-P', tempDir,
        '-o', '%(autonumber)02d_%(title).50s.%(ext)s',
        url
      ];

      if (isYouTube) {
        // Enforce mp4 and max 1080p for Telegram file limit safety
        args.splice(1, 0, '-f', 'bv*[ext=mp4][height<=1080]+ba[ext=m4a]/b[ext=mp4]/ba/b/best');
      }

      await execFileAsync('yt-dlp', args, { timeout: 90000 });

      const files = readdirSync(tempDir);
      if (files.length === 0) {
        throw new Error('No media files could be downloaded from this link ♡');
      }

      const mediaItems = [];
      let audioTrack = null;
      let title = 'Downloaded Media';

      // Sort files to preserve order
      files.sort();

      for (const f of files) {
        const fullPath = join(tempDir, f);
        const stat = statSync(fullPath);
        if (stat.isDirectory() || stat.size === 0) continue;

        const ext = f.split('.').pop().toLowerCase();
        const buf = readFileSync(fullPath);

        if (['mp4', 'webm', 'mov', 'mkv'].includes(ext)) {
          mediaItems.push({
            type: 'video',
            buffer: buf,
            filename: f,
            mimeType: ext === 'webm' ? 'video/webm' : 'video/mp4'
          });

          // Extract audio from first video with sound
          if (!audioTrack) {
            onProgress?.('Checking video sound track… ♡');
            const extAudio = await this.extractAudioFromFile(fullPath);
            if (extAudio) {
              audioTrack = {
                buffer: extAudio,
                filename: `${f.replace(/\.[^.]+$/, '')}.mp3`,
                title: f.replace(/\.[^.]+$/, ''),
                performer: 'Audio Track'
              };
            }
          }
        } else if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
          mediaItems.push({
            type: 'photo',
            buffer: buf,
            filename: f,
            mimeType: 'image/jpeg'
          });
        } else if (['mp3', 'm4a', 'wav', 'opus'].includes(ext)) {
          if (!audioTrack) {
            audioTrack = {
              buffer: buf,
              filename: `${f.replace(/\.[^.]+$/, '')}.mp3`,
              title: f.replace(/\.[^.]+$/, ''),
              performer: 'Audio Track'
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
        author: 'Social Media',
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
}
