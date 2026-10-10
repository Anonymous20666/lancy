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
 * Recognize song/music from an audio or video buffer/file using Shazam + AudD fallback
 */
export async function recognizeAudio(input, { timeoutMs = 25000, extension = '' } = {}) {
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

                  log.info({ title: track.title, artist: track.subtitle }, 'song recognized via Shazam');
                  return {
                    success: true,
                    engine: 'shazam',
                    title: track.title,
                    artist: track.subtitle || 'Unknown Artist',
                    album,
                    year,
                    artwork,
                    songUrl: track.url || null
                  };
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

          log.info({ title: track.title, artist: track.subtitle }, 'song recognized via Shazam fallback');
          return {
            success: true,
            engine: 'shazam',
            title: track.title,
            artist: track.subtitle || 'Unknown Artist',
            album,
            year,
            artwork,
            songUrl: track.url || null
          };
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

    // 3. Engine B: AudD Fallback
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
          log.info({ title: res.title, artist: res.artist }, 'song recognized via AudD');
          return {
            success: true,
            engine: 'audd',
            title: res.title,
            artist: res.artist || 'Unknown Artist',
            album: res.album,
            year: res.release_date?.slice(0, 4),
            artwork: null,
            songUrl: res.song_link || null
          };
        }
      }
    } catch (audErr) {
      log.debug({ err: audErr.message }, 'AudD fallback attempt failed');
    }

    return {
      success: false,
      reason: 'Could not match audio to any known track'
    };
  } finally {
    try { if (existsSync(tempInput)) unlinkSync(tempInput); } catch {}
    try { if (existsSync(tempSample)) unlinkSync(tempSample); } catch {}
    try { if (existsSync(tempSample2)) unlinkSync(tempSample2); } catch {}
    try { if (existsSync(tempSample3)) unlinkSync(tempSample3); } catch {}
  }
}
