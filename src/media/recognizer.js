import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import { Shazam } from 'node-shazam';
import { recognizeBytes } from 'shazamio-core';
import { logger } from '../core/logger.js';

const execFileAsync = promisify(execFile);
const log = logger().child({ module: 'media:recognizer' });

function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  }).toUpperCase();
}

/**
 * Detect if an incoming Telegram message contains an audio, voice note, or video suitable for music recognition.
 */
export function extractMediaForMusicRecognition(message) {
  if (!message) return null;
  if (message.voice) return { obj: message.voice, type: 'voice', label: 'voice note' };
  if (message.audio) return { obj: message.audio, type: 'audio', label: 'audio file' };
  if (message.video) return { obj: message.video, type: 'video', label: 'video' };
  if (message.video_note) return { obj: message.video_note, type: 'video_note', label: 'video note' };

  if (message.document) {
    const doc = message.document;
    const mime = (doc.mime_type || '').toLowerCase();
    const name = (doc.file_name || '').toLowerCase();
    const isVideo = mime.startsWith('video/') || /\.(mp4|mov|mkv|webm|avi|flv|3gp|wmv)$/i.test(name);
    const isAudio = mime.startsWith('audio/') || /\.(mp3|m4a|wav|aac|flac|ogg|oga|opus|wma)$/i.test(name);
    if (isVideo) return { obj: doc, type: 'video', label: 'video file' };
    if (isAudio) return { obj: doc, type: 'audio', label: 'audio file' };
  }

  return null;
}

/**
 * Cross-verify candidate against Deezer & iTunes / Apple Music catalogs.
 * Returns verified official metadata with stream popularity score, or null if unverified.
 */
export async function verifyWithCatalog(title, artist, { hintTitle = '', hintPerformer = '' } = {}) {
  if (!title && !hintTitle) return null;
  const cleanTitle = (title || '')
    .replace(/\(.*?\)/g, '')
    .replace(/\[.*?\]/g, '')
    .trim();
  const cleanArtist = (artist || '')
    .replace(/\(.*?\)/g, '')
    .replace(/\[.*?\]/g, '')
    .trim();

  // 1. Check Deezer catalog (includes track popularity rank)
  if (cleanTitle) {
    try {
      const q = cleanArtist ? `${cleanTitle} ${cleanArtist}` : cleanTitle;
      const res = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(q)}`, {
        signal: AbortSignal.timeout(6000)
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.data) && data.data.length > 0) {
          for (const item of data.data.slice(0, 5)) {
            const itemTitle = (item.title || '').toLowerCase();
            const itemArtist = (item.artist?.name || '').toLowerCase();
            const targetTitle = cleanTitle.toLowerCase();
            const targetArtist = cleanArtist.toLowerCase();

            const titleMatch = itemTitle.includes(targetTitle) || targetTitle.includes(itemTitle);
            const artistMatch = !targetArtist || itemArtist.includes(targetArtist) || targetArtist.includes(itemArtist);

            // Must match title and artist OR have a strong popularity rank (>= 10,000)
            if ((titleMatch && artistMatch && (item.rank ?? 0) >= 10000) || (titleMatch && (item.rank ?? 0) >= 40000)) {
              return {
                verified: true,
                engine: 'catalog:deezer',
                title: item.title,
                artist: item.artist?.name || artist,
                album: item.album?.title || null,
                artwork: item.album?.cover_xl || item.album?.cover_big || null,
                rank: item.rank || 0,
                duration: item.duration || null,
                previewUrl: item.preview || null
              };
            }
          }
        }
      }
    } catch (err) {
      log.debug({ err: err.message }, 'Deezer catalog verification attempt failed');
    }
  }

  // 2. Check iTunes / Apple Music catalog
  if (cleanTitle) {
    try {
      const itunesQuery = cleanArtist ? `${cleanTitle} ${cleanArtist}` : cleanTitle;
      const res = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(itunesQuery)}&entity=song&limit=5`, {
        signal: AbortSignal.timeout(6000)
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.results) && data.results.length > 0) {
          for (const item of data.results) {
            const itemTitle = (item.trackName || '').toLowerCase();
            const itemArtist = (item.artistName || '').toLowerCase();
            const targetTitle = cleanTitle.toLowerCase();
            const targetArtist = cleanArtist.toLowerCase();

            const titleMatch = itemTitle.includes(targetTitle) || targetTitle.includes(itemTitle);
            const artistMatch = !targetArtist || itemArtist.includes(targetArtist) || targetArtist.includes(itemArtist);

            if (titleMatch && artistMatch) {
              return {
                verified: true,
                engine: 'catalog:itunes',
                title: item.trackName,
                artist: item.artistName || artist,
                album: item.collectionName || null,
                artwork: item.artworkUrl100?.replace('100x100bb', '600x600bb') || null,
                rank: 100000,
                year: item.releaseDate ? item.releaseDate.slice(0, 4) : null,
                previewUrl: item.previewUrl || null
              };
            }
          }
        }
      }
    } catch (err) {
      log.debug({ err: err.message }, 'iTunes catalog verification attempt failed');
    }
  }

  // 3. Fallback to media soundtrack hint if provided
  if (hintTitle && !/^original\s*sound/i.test(hintTitle.trim())) {
    try {
      const cleanHint = hintTitle.replace(/\s*-\s*[a-zA-Z0-9_]+$/, '').trim();
      const res = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(cleanHint)}`, {
        signal: AbortSignal.timeout(6000)
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.data) && data.data.length > 0) {
          const top = data.data[0];
          if ((top.rank ?? 0) >= 30000) {
            return {
              verified: true,
              engine: 'catalog:hint',
              title: top.title,
              artist: top.artist?.name || hintPerformer,
              album: top.album?.title || null,
              artwork: top.album?.cover_xl || top.album?.cover_big || null,
              rank: top.rank || 0,
              duration: top.duration || null,
              previewUrl: top.preview || null
            };
          }
        }
      }
    } catch {}
  }

  return null;
}

/**
 * Recognize song/music from an audio or video buffer/file using Shazam + catalog verification
 */
export async function recognizeAudio(input, { timeoutMs = 25000, extension = '', hintTitle = '', hintPerformer = '' } = {}) {
  const rand = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const ext = extension ? (extension.startsWith('.') ? extension : `.${extension}`) : '.dat';
  const tempInput = join(tmpdir(), `lancy_rec_in_${rand}${ext}`);
  const tempSample = join(tmpdir(), `lancy_rec_sample_${rand}.mp3`);
  const tempSample2 = join(tmpdir(), `lancy_rec_sample2_${rand}.mp3`);
  const tempSample3 = join(tmpdir(), `lancy_rec_sample3_${rand}.mp3`);

  let inputFile = tempInput;

  try {
    if (Buffer.isBuffer(input)) {
      writeFileSync(tempInput, input);
    } else if (typeof input === 'string') {
      inputFile = input;
    } else {
      throw new Error('Invalid input for audio recognition: must be Buffer or file path');
    }

    // Measure media duration if possible
    let mediaDuration = 0;
    try {
      const { stdout } = await execFileAsync('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        inputFile
      ], { timeout: 5000 });
      mediaDuration = parseFloat(stdout.trim()) || 0;
    } catch {}

    // Helper to query Shazam with a given sample
    async function queryShazam(samplePath) {
      if (!existsSync(samplePath)) return null;

      // Tier 1: Exhaustive signature check with shazamio-core
      try {
        const sampleBuf = readFileSync(samplePath);
        let signatures = null;
        try {
          signatures = recognizeBytes(sampleBuf, 0, Number.MAX_SAFE_INTEGER);
        } catch {}

        if (signatures && signatures.length > 0) {
          // Reorder signatures: start in center, fan outward
          const mid = Math.floor(signatures.length / 2);
          const indices = [mid];
          let left = mid - 1;
          let right = mid + 1;
          while (left >= 0 || right < signatures.length) {
            if (right < signatures.length) indices.push(right++);
            if (left >= 0) indices.push(left--);
          }

          for (const i of indices) {
            const sig = signatures[i];
            const data = {
              timezone: 'Europe/Paris',
              signature: {
                uri: sig.uri,
                samplems: sig.samplems
              },
              timestamp: Date.now(),
              context: {},
              geolocation: {}
            };

            const tagUrl = `https://amp.shazam.com/discovery/v5/en/US/iphone/-/tag/${uuidv4()}/${uuidv4()}?sync=true&webv3=true&sampling=true&connected=&shazamapiversion=v3&sharehub=true&hubv5minorversion=v5.1&hidelb=true&video=v3`;
            try {
              const res = await fetch(tagUrl, {
                method: 'POST',
                headers: {
                  'User-Agent': 'Shazam/3679 CFNetwork/1408.0.4 Darwin/22.5.0',
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify(data),
                signal: AbortSignal.timeout(5000)
              });
              if (res.ok) {
                const json = await res.json();
                if (json?.matches?.length > 0 && json.track?.title) {
                  const track = json.track;
                  const songSection = track.sections?.find((s) => s.type === 'SONG');
                  const album = songSection?.metadata?.find((m) => m.title === 'Album')?.text;
                  const year = songSection?.metadata?.find((m) => m.title === 'Released')?.text;
                  const artwork = track.images?.coverart || track.images?.background || null;

                  // Cross-verify with streaming catalogs to ensure it's not a fake or obscure collision
                  const verified = await verifyWithCatalog(track.title, track.subtitle, { hintTitle, hintPerformer });
                  if (verified) {
                    log.info({ title: verified.title, artist: verified.artist, rank: verified.rank }, 'song recognized and verified in catalog');
                    return {
                      success: true,
                      engine: verified.engine || 'shazam+catalog',
                      title: verified.title || track.title,
                      artist: verified.artist || track.subtitle || 'Unknown Artist',
                      album: verified.album || album || null,
                      year: verified.year || year || null,
                      artwork: verified.artwork || artwork || null,
                      songUrl: track.url || null,
                      rank: verified.rank || 0,
                      verified: true
                    };
                  }
                }
              }
            } catch {}
          }
        }
      } catch (err) {
        log.debug({ err: err.message }, 'exhaustive shazam check attempt failed');
      }

      // Tier 2: Library fallback
      try {
        const shazam = new Shazam();
        const shazamRes = await shazam.recognise(samplePath);
        if (shazamRes?.track?.title) {
          const track = shazamRes.track;
          const songSection = track.sections?.find((s) => s.type === 'SONG');
          const album = songSection?.metadata?.find((m) => m.title === 'Album')?.text;
          const year = songSection?.metadata?.find((m) => m.title === 'Released')?.text;
          const artwork = track.images?.coverart || track.images?.background || null;

          const verified = await verifyWithCatalog(track.title, track.subtitle, { hintTitle, hintPerformer });
          if (verified) {
            log.info({ title: verified.title, artist: verified.artist, rank: verified.rank }, 'song recognized via Shazam fallback and verified');
            return {
              success: true,
              engine: verified.engine || 'shazam+catalog',
              title: verified.title || track.title,
              artist: verified.artist || track.subtitle || 'Unknown Artist',
              album: verified.album || album || null,
              year: verified.year || year || null,
              artwork: verified.artwork || artwork || null,
              songUrl: track.url || null,
              rank: verified.rank || 0,
              verified: true
            };
          }
        }
      } catch (shazamErr) {
        log.debug({ err: shazamErr.message }, 'node-shazam recognition attempt failed or timed out');
      }
      return null;
    }

    // 1. Extract 20 seconds of normalized 44.1kHz MP3 using FFmpeg (offset 0s, dynamic loudness normalization)
    let extracted = false;
    try {
      await execFileAsync('ffmpeg', [
        '-y',
        '-i', inputFile,
        '-ss', '0',
        '-t', '20',
        '-af', 'dynaudnorm=f=150:g=15,volume=2.0',
        '-vn',
        '-ar', '44100',
        '-ac', '2',
        '-b:a', '128k',
        tempSample
      ], { timeout: 10000 });
      extracted = existsSync(tempSample);
    } catch (ffErr) {
      log.warn({ err: ffErr.message }, 'ffmpeg conversion for audio recognition failed');
      return { success: false, reason: 'Failed to extract audio track from media' };
    }

    if (!extracted) {
      return { success: false, reason: 'Failed to generate audio sample' };
    }

    // 2. Engine A: Shazam Recognition on primary normalized sample
    let result = await queryShazam(tempSample);
    if (result) return result;

    // 2b. Secondary sample at offset if duration allows (skips intro/speech/recording tap)
    if (mediaDuration === 0 || mediaDuration > 4) {
      const offset = mediaDuration > 0 ? Math.min(3, Math.floor(mediaDuration * 0.25)) : 3;
      try {
        await execFileAsync('ffmpeg', [
          '-y',
          '-i', inputFile,
          '-ss', String(offset),
          '-t', '20',
          '-af', 'dynaudnorm=f=150:g=15,volume=2.0',
          '-vn',
          '-ar', '44100',
          '-ac', '2',
          '-b:a', '128k',
          tempSample2
        ], { timeout: 10000 });
        if (existsSync(tempSample2)) {
          result = await queryShazam(tempSample2);
          if (result) return result;
        }
      } catch {}
    }

    // 2c. Tertiary sample with high gain boost for quiet voice notes
    try {
      await execFileAsync('ffmpeg', [
        '-y',
        '-i', inputFile,
        '-ss', '0',
        '-t', '20',
        '-af', 'highpass=f=80,volume=3.5,dynaudnorm=f=100:g=20',
        '-vn',
        '-ar', '44100',
        '-ac', '2',
        '-b:a', '128k',
        tempSample3
      ], { timeout: 10000 });
      if (existsSync(tempSample3)) {
        result = await queryShazam(tempSample3);
        if (result) return result;
      }
    } catch {}

    // 3. Engine B: AudD Fallback with catalog verification
    try {
      const sampleBuf = readFileSync(tempSample);
      const formData = new FormData();
      formData.append('api_token', 'test');
      formData.append('file', new Blob([sampleBuf], { type: 'audio/mpeg' }), 'sample.mp3');

      const audRes = await fetch('https://api.audd.io/', {
        method: 'POST',
        body: formData,
        signal: AbortSignal.timeout(10000)
      });

      if (audRes.ok) {
        const audData = await audRes.json();
        if (audData?.status === 'success' && audData?.result?.title) {
          const res = audData.result;
          const verified = await verifyWithCatalog(res.title, res.artist, { hintTitle, hintPerformer });
          if (verified) {
            log.info({ title: verified.title, artist: verified.artist, rank: verified.rank }, 'song recognized via AudD and verified in catalog');
            return {
              success: true,
              engine: verified.engine || 'audd+catalog',
              title: verified.title,
              artist: verified.artist || res.artist || 'Unknown Artist',
              album: verified.album || res.album || null,
              year: verified.year || res.release_date?.slice(0, 4) || null,
              artwork: verified.artwork || null,
              songUrl: res.song_link || null,
              rank: verified.rank || 0,
              verified: true
            };
          }
        }
      }
    } catch (audErr) {
      log.debug({ err: audErr.message }, 'AudD fallback attempt failed');
    }

    // 4. Fallback: Soundtrack metadata hint cross-verified against catalog
    if (hintTitle && !/^original\s*sound/i.test(hintTitle.trim())) {
      const hintVerified = await verifyWithCatalog(hintTitle, hintPerformer, { hintTitle, hintPerformer });
      if (hintVerified) {
        log.info({ title: hintVerified.title, artist: hintVerified.artist, rank: hintVerified.rank }, 'song verified via media soundtrack hint');
        return {
          success: true,
          engine: hintVerified.engine || 'catalog:hint',
          title: hintVerified.title,
          artist: hintVerified.artist,
          album: hintVerified.album,
          year: hintVerified.year || null,
          artwork: hintVerified.artwork,
          songUrl: null,
          rank: hintVerified.rank || 0,
          verified: true
        };
      }
    }

    return {
      success: false,
      reason: 'Could not match audio to any verified commercial track'
    };
  } finally {
    try { if (existsSync(tempInput)) unlinkSync(tempInput); } catch {}
    try { if (existsSync(tempSample)) unlinkSync(tempSample); } catch {}
    try { if (existsSync(tempSample2)) unlinkSync(tempSample2); } catch {}
    try { if (existsSync(tempSample3)) unlinkSync(tempSample3); } catch {}
  }
}
