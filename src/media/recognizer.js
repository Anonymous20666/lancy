import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { Shazam } from 'node-shazam';
import { logger } from '../core/logger.js';

const execFileAsync = promisify(execFile);
const log = logger().child({ module: 'media:recognizer' });

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

  let inputFile = tempInput;

  try {
    if (Buffer.isBuffer(input)) {
      writeFileSync(tempInput, input);
    } else if (typeof input === 'string') {
      inputFile = input;
    } else {
      throw new Error('Invalid input for audio recognition: must be Buffer or file path');
    }

    // Helper to query Shazam with a given sample
    async function queryShazam(samplePath) {
      try {
        const shazam = new Shazam();
        const shazamRes = await shazam.recognise(samplePath);
        if (shazamRes?.track?.title) {
          const track = shazamRes.track;
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
      } catch (shazamErr) {
        log.debug({ err: shazamErr.message }, 'Shazam recognition attempt failed or timed out');
      }
      return null;
    }

    // 1. Extract 20 seconds of clean 44.1kHz MP3 using FFmpeg (offset 0s)
    let extracted = false;
    try {
      await execFileAsync('ffmpeg', [
        '-y',
        '-i', inputFile,
        '-ss', '0',
        '-t', '20',
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

    // 2. Engine A: Shazam Recognition on primary sample
    let result = await queryShazam(tempSample);
    if (result) return result;

    // 2b. Secondary sample at offset 8s (in case video starts with intro, silence, or speech)
    try {
      await execFileAsync('ffmpeg', [
        '-y',
        '-i', inputFile,
        '-ss', '8',
        '-t', '20',
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

    // 3. Engine B: AudD Fallback
    try {
      const { readFileSync } = await import('node:fs');
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
  }
}
