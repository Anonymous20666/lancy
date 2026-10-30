import { TelegramMedia } from './telegramMedia.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, stat, unlink, rename } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { KeyedLock, MusicError } from './model.js';
const exec = promisify(execFile);
export function publicIPv4(ip) {
  const p = ip.split('.').map(Number);
  return p.length === 4 && p.every(n => Number.isInteger(n) && n >= 0 && n <= 255) && ![0,10,127].includes(p[0]) && !(p[0] === 169 && p[1] === 254) && !(p[0] === 172 && p[1] >= 16 && p[1] <= 31) && !(p[0] === 192 && p[1] === 168) && !(p[0] === 100 && p[1] >= 64 && p[1] <= 127) && p[0] < 224 && !(p[0] === 198 && [18,19].includes(p[1]));
}
/** Pin DNS results into the TLS connection. Redirects are revalidated; no private networking. */
export async function boundedFetchFile(url, path, maxBytes, redirects = 0, { signal } = {}) {
  signal?.throwIfAborted();
  if (redirects > 4) throw new MusicError('REDIRECT_LIMIT', 'Media redirected too many times.');
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) throw new MusicError('UNSAFE_SOURCE', 'Unsafe media source.');
  const addresses = await lookup(u.hostname, { all: true, family: 4 });
  signal?.throwIfAborted();
  if (!addresses.length || addresses.some(a => !publicIPv4(a.address))) throw new MusicError('UNSAFE_SOURCE', 'Private media sources are not accepted.');
  const response = await new Promise((ok, reject) => {
    const req = https.get(u, { signal, lookup: (_host, options, cb) => cb(null, ...(options?.all ? [[addresses[0]]] : [addresses[0].address, 4])), headers: { 'User-Agent': 'Lancy/1.0' } }, ok);
    req.setTimeout(30000, () => req.destroy(new Error('Media request timeout'))); req.on('error', reject);
  });
  if ([301,302,303,307,308].includes(response.statusCode)) { response.resume(); return boundedFetchFile(new URL(response.headers.location, u).href, path, maxBytes, redirects + 1, { signal }); }
  if (response.statusCode !== 200 || Number(response.headers['content-length']) > maxBytes) { response.destroy(); throw new MusicError('DOWNLOAD_FAILED', 'The provider could not deliver a file within the size limit.'); }
  let bytes = 0;
  const bound = new Transform({ transform(chunk, _, cb) { bytes += chunk.length; cb(bytes > maxBytes ? new MusicError('FILE_TOO_LARGE', 'The media file exceeds the size limit.') : null, chunk); } });
  const deadline = setTimeout(() => response.destroy(new Error('Download deadline exceeded')), 120000);
  try { await pipeline(response, bound, createWriteStream(path, { mode: 0o600, flags: 'wx' }), { signal }); } finally { clearTimeout(deadline); }
}
export class MediaLibrary {
  constructor({ root, providers, ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg', runner = exec, maxBytes = 48 * 1024 * 1024, videoMaxBytes = maxBytes, quotaBytes = 512 * 1024 * 1024, ttlMs = 86400000 } = {}) {
    if (![maxBytes,quotaBytes,ttlMs].every(n=>Number.isFinite(n)&&n>0)||maxBytes>150*1024*1024||quotaBytes<maxBytes*3)throw new MusicError('INVALID_CONFIGURATION','Music storage limits must be positive, with space for at least three maximum-size files.');
    this.root = resolve(root); this.providers = providers; this.ffmpeg = ffmpeg; this.runner = runner; this.maxBytes = maxBytes; this.quotaBytes = quotaBytes; this.ttlMs = ttlMs; this.locks = new KeyedLock(); this.videoMaxBytes = Math.max(maxBytes, Math.min(Number(videoMaxBytes) || maxBytes, 2048 * 1024 * 1024, Math.floor(quotaBytes / 2))); this.active = new Map(); this.refs = new Map(); this.closed = false;this.telegram=new TelegramMedia(this);
  }
  importTelegram(api,message,options={}) { return this.telegram.import(api,message,options); }
  async acquire(track, { video = false, download = false } = {}) {
    if (this.closed) throw new MusicError('SHUTTING_DOWN', 'Music is shutting down.');
    if(track.provider==='telegram')return this.telegram.acquire(track,{video,download});
    const adapter = this.providers.get(track.provider);
    if (track.provider === 'youtube') adapter.assertEnabled?.();
    // Permission checks run before the decoder lock; a slow preview API cannot
    // hold up the next VC track. Revalidate even for a cached downloadable file.
    const permitted = download && track.provider === 'audius' ? await adapter.media(track, { download: true }) : null;
    let key = createHash('sha256').update(`${track.id}:${video}:${download}`).digest('hex');
    return this.locks.run(key, async () => {
      if (this.closed) throw new MusicError('SHUTTING_DOWN', 'Music is shutting down.');
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const filePath = join(this.root, `${key}.${video ? 'mp4' : 'mp3'}`);
      let result = this.active.get(key);
      if (!result && existsSync(filePath)) {
        try {
          const st = await stat(filePath);
          if (st.size > 1024) {
            const probe = await this.runner(this.ffmpeg.replace(/ffmpeg$/, 'ffprobe'), ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', filePath], { timeout: 10000 }).catch(() => null);
            if (probe?.stdout) {
              const info = JSON.parse(probe.stdout);
              const duration = Number(info.format?.duration);
              if (Number.isFinite(duration) && duration > 0 && info.streams?.some(s => s.codec_type === 'audio')) {
                result = { key, filePath, track: { ...track, durationSeconds: duration, filePath, availability: 'resolved', mediaType: video ? 'video' : 'audio', capabilities: { stream: true, download: download || ['youtube', 'music'].includes(track.provider), seek: true, video } } };
                this.active.set(key, result);
              }
            }
          }
        } catch {}
      }
      if (!result && download && !video) {
        const streamKey = createHash('sha256').update(`${track.id}:false:false`).digest('hex');
        const cached = this.active.get(streamKey);
        // Reuse a complete, probed audio recording only AFTER download consent.
        // Video is never passed off as an MP3; its audio is resolved separately.
        const knownDuration = cached && (Object.hasOwn(cached.track, 'sourceDurationSeconds') ? cached.track.sourceDurationSeconds : cached.track.durationSeconds);
        const complete = cached && (!permitted?.track.durationSeconds || Math.abs(permitted.track.durationSeconds - cached.track.durationSeconds) <= 4);
        if (complete && (['youtube', 'music'].includes(track.provider) || permitted) && (permitted?.track.durationSeconds || knownDuration)) {
          result = cached; key = streamKey;
        }
      }
      if (!result) {
        const limit = video ? this.videoMaxBytes : this.maxBytes; const prefix = join(this.root, `.partial-${randomUUID()}`); const source = `${prefix}.source`; const output = `${prefix}.${video ? 'mp4' : 'mp3'}`;
        try {
          const required = Math.max(limit, this.maxBytes * 3);
          const used = await this.locks.run('cleanup', () => this.cleanup(required));
          if (used + required > this.quotaBytes) throw new MusicError('CACHE_FULL', 'Music storage is busy. Try again after active tracks finish.');
          let meta;
          let artworkFile = null;
          if (['youtube', 'music'].includes(track.provider)) meta = await adapter.download(track, source, { video, maxBytes: limit });
          else {
            const media = permitted || await adapter.media(track, { download }); meta = media.track;
            await boundedFetchFile(media.url, source, limit);
            if (video && (meta.artwork || track.artwork)) {
              artworkFile = `${prefix}.art`;
              try { await boundedFetchFile(meta.artwork || track.artwork, artworkFile, 5 * 1024 * 1024); } catch { artworkFile = null; }
            }
          }
          if (download && !meta.durationSeconds) throw new MusicError('DURATION_UNVERIFIED', 'The provider did not supply a reliable full duration. Choose another recording for full-song listening/download.');
          const candidates = (await readdir(this.root)).filter(f => f.startsWith(prefix.split('/').at(-1)) && f.includes('.source'));
          if (candidates.length !== 1) throw new MusicError('SOURCE_MISSING', 'The selected source did not produce one usable media file.');
          const input = join(this.root, candidates[0]);
          if ((await stat(input)).size > limit) throw new MusicError('FILE_TOO_LARGE', 'Media exceeds the file limit.');
          let hasVideoInSource = false;
          let canStreamCopyVideo = false;
          if (video) {
            try {
              const probeIn = await this.runner(this.ffmpeg.replace(/ffmpeg$/, 'ffprobe'), ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,height', '-of', 'json', input], { timeout: 10000 });
              const inInfo = JSON.parse(probeIn.stdout);
              const vStream = inInfo.streams?.find(s => s.codec_type === 'video');
              hasVideoInSource = Boolean(vStream);
              canStreamCopyVideo = Boolean(vStream && vStream.codec_name === 'h264' && Number(vStream.height) > 0 && Number(vStream.height) <= 480);
            } catch { hasVideoInSource = false; }
            if (!hasVideoInSource && !artworkFile && (meta.artwork || track.artwork)) {
              artworkFile = `${prefix}.art`;
              try { await boundedFetchFile(meta.artwork || track.artwork, artworkFile, 5 * 1024 * 1024); } catch { artworkFile = null; }
            }
          }
          const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y'];
          if (video) {
            if (hasVideoInSource && canStreamCopyVideo) {
              args.push('-i', input, '-t', '7200', '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart');
            } else if (hasVideoInSource) {
              args.push('-i', input, '-t', '7200', '-map', '0:v:0', '-map', '0:a:0', '-vf', 'scale=-2:360,fps=24', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '25', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart');
            } else if (artworkFile && existsSync(artworkFile)) {
              args.push('-loop', '1', '-r', '15', '-i', artworkFile, '-i', input, '-t', '7200', '-map', '0:v:0', '-map', '1:a:0', '-vf', 'scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,format=yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-crf', '26', '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart');
            } else {
              args.push('-f', 'lavfi', '-i', 'color=c=0x0f172a:s=640x360:r=15', '-i', input, '-t', '7200', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-crf', '26', '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart');
            }
          } else {
            args.push('-i', input, '-t', '7200', '-map', '0:a:0', '-vn', '-c:a', 'libmp3lame', '-q:a', '2');
          }
          args.push('-ar', '48000', '-ac', '2', '-metadata', `title=${meta.title}`, '-metadata', `artist=${meta.artist || ''}`, '-fs', String(limit), output);
          await this.runner(this.ffmpeg, args, { timeout: 180000 + Math.min(7200, Number(meta.durationSeconds) || 0) * (video ? 1500 : 200), maxBuffer: 1024 * 1024 });
          const probe = await this.runner('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', output], { timeout: 15000 });
          const info = JSON.parse(probe.stdout); const duration = Number(info.format?.duration); const size = (await stat(output)).size;
          if (!Number.isFinite(duration) || duration <= 0 || !info.streams?.some(s => s.codec_type === 'audio') || (video && !info.streams.some(s => s.codec_type === 'video')) || size >= limit || (meta.durationSeconds && duration < Math.min(meta.durationSeconds - 20, meta.durationSeconds * 0.7))) throw new MusicError('INVALID_MEDIA', 'The selected file is incomplete or missing the required media streams.');
          await rename(output, filePath);
          result = { key, filePath, track: { ...meta, sourceDurationSeconds: meta.durationSeconds, durationSeconds: duration, filePath, availability: 'resolved', mediaType: video ? 'video' : 'audio', capabilities: { stream: true, download: download || meta.downloadable === true || ['youtube', 'music'].includes(track.provider), seek: true, video } } }; this.active.set(key, result);
        } catch (error) {
          if (error instanceof MusicError) throw error;
          throw new MusicError('RESOLUTION_FAILED', 'The selected recording could not be downloaded or decoded. Try another permitted result.');
        } finally {
          for (const f of await readdir(this.root)) if (f.startsWith(prefix.split('/').at(-1))) await unlink(join(this.root, f)).catch(() => {});
        }
      }
      this.refs.set(key, (this.refs.get(key) || 0) + 1);
      let released = false;
      return { ...result, release: () => { if (!released) { released = true; this.refs.set(key, Math.max(0, (this.refs.get(key) || 1) - 1)); } } };
    });
  }
  async warm(track, options = {}) {
    const m = await this.acquire(track, options);
    m.release();
    return m;
  }
  async cleanup(requiredBytes = 0) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const files = await Promise.all((await readdir(this.root)).map(async name => ({ name, ...(await stat(join(this.root, name))) })));
    let bytes = files.reduce((s, f) => s + f.size, 0);
    const targetBytes = Math.max(0, this.quotaBytes - requiredBytes);
    for (const f of files.sort((a,b) => a.mtimeMs - b.mtimeMs)) {
      if (f.name.startsWith('.partial-')) {
        if (Date.now() - f.mtimeMs > 1800000) {
          await unlink(join(this.root, f.name)).catch(() => {});
          bytes -= f.size;
        }
        continue;
      }
      const key = f.name.split('.')[0];
      if (!this.refs.get(key) && (Date.now() - f.mtimeMs > this.ttlMs || bytes > targetBytes)) {
        await unlink(join(this.root, f.name)).catch(() => {});
        bytes -= f.size;
        this.active.delete(key);
        this.refs.delete(key);
      }
    }
    return bytes;
  }
  async shutdown() { this.closed = true; await this.locks.run('downloads', () => this.cleanup()); }
}
