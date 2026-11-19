import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveFfmpegPath } from './convert.js';
import { isProxyReachable } from './musicResolver.js';

const execFileAsync = promisify(execFile);
const TRAILER_CACHE_DIR = join(tmpdir(), 'lancy_movie_trailers');
const RESIDENTIAL_PROXY = process.env.LANCY_RESIDENTIAL_PROXY ?? 'http://127.0.0.1:8888';

const inflightDownloads = new Map(); // trailerKey -> Promise<result|null>
const localClipCache = new Map(); // youtubeId -> { filePath, durationSeconds, width, height, sizeBytes, expiresAt }

export function buildTrailerItemKey(item = {}) {
  const type = String(item?.type || 'movie').toLowerCase() === 'tv' ? 'tv' : 'movie';
  const stableId = item?.tmdbId || item?.imdbId || item?.id || '';
  if (stableId && !/^temp/i.test(String(stableId))) {
    return `${type}:${String(stableId).toLowerCase().trim()}`;
  }
  const titleNorm = String(item?.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const year = item?.year ? String(item.year) : '';
  return createHash('sha1').update(`${type}:${titleNorm}:${year}`).digest('hex').slice(0, 16);
}

export function getCachedTrailerFileId(db, item = {}, botKey = 'default') {
  if (!db?.getSetting || !item || item.adult || item.isAdultCatalogItem) return null;
  const key = `trailer:fid:${botKey || 'default'}:${buildTrailerItemKey(item)}`;
  const cached = db.getSetting(key, null);
  if (cached && typeof cached === 'object' && cached.fileId) {
    return cached;
  }
  return null;
}

export function saveCachedTrailerFileId(db, item = {}, botKey = 'default', payload = {}) {
  if (!db?.setSetting || !item || !payload?.fileId) return;
  const key = `trailer:fid:${botKey || 'default'}:${buildTrailerItemKey(item)}`;
  db.setSetting(key, {
    fileId: String(payload.fileId),
    youtubeId: payload.youtubeId || null,
    url: payload.url || (payload.youtubeId ? `https://www.youtube.com/watch?v=${payload.youtubeId}` : null),
    title: payload.title || null,
    durationSeconds: Number(payload.durationSeconds) || null,
    updatedAt: Date.now()
  });
}

async function probeVideoMeta(filePath) {
  try {
    const ffmpeg = resolveFfmpegPath();
    const candidateProbe = ffmpeg.replace(/ffmpeg$/, 'ffprobe');
    const ffprobe = candidateProbe !== ffmpeg && existsSync(candidateProbe) ? candidateProbe : 'ffprobe';
    const { stdout } = await execFileAsync(ffprobe, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,codec_name:format=duration',
      '-of', 'json',
      filePath
    ], { timeout: 5000 });
    const parsed = JSON.parse(stdout || '{}');
    const st = parsed?.streams?.[0] || {};
    const dur = Math.round(Number(parsed?.format?.duration || 0));
    return {
      width: Number(st.width) || null,
      height: Number(st.height) || null,
      codec: st.codec_name || null,
      durationSeconds: dur > 0 ? dur : null
    };
  } catch {
    return { width: null, height: null, codec: null, durationSeconds: null };
  }
}

async function ensureFastStartMp4(inputPath, outPath) {
  try {
    const ffmpeg = resolveFfmpegPath();
    await execFileAsync(ffmpeg, [
      '-y',
      '-i', inputPath,
      '-c', 'copy',
      '-movflags', '+faststart',
      '-f', 'mp4',
      outPath
    ], { timeout: 15000 });
    if (existsSync(outPath) && statSync(outPath).size > 8192) {
      return outPath;
    }
  } catch {}
  return inputPath;
}

async function defaultDownloadTrailerClip(youtubeId, { maxBytes = 25 * 1024 * 1024 } = {}) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(String(youtubeId || ''))) return null;
  const now = Date.now();
  const cached = localClipCache.get(youtubeId);
  if (cached && cached.expiresAt > now && cached.filePath && existsSync(cached.filePath)) {
    return cached;
  }

  mkdirSync(TRAILER_CACHE_DIR, { recursive: true });
  const rawOut = join(TRAILER_CACHE_DIR, `${youtubeId}_${now}_raw.mp4`);
  const fastOut = join(TRAILER_CACHE_DIR, `${youtubeId}_${now}.mp4`);
  const url = `https://www.youtube.com/watch?v=${youtubeId}`;

  const proxyOk = await isProxyReachable(RESIDENTIAL_PROXY, 180).catch(() => false);
  const cookiePath = ['/data/projects/lancy/cookies.txt', '/data/cookies.txt'].find((p) => existsSync(p));
  const ffmpeg = resolveFfmpegPath();

  const runDl = async (useProxy) => {
    const args = [
      '--no-warnings',
      '--no-playlist',
      '--ffmpeg-location', ffmpeg,
      '-N', '4',
      '--max-filesize', '28M',
      '--js-runtimes', 'node:/usr/bin/node',
      '-f', 'bv*[height<=480][vcodec^=avc1][ext=mp4]+ba[ext=m4a]/b[height<=480][ext=mp4]/bv*[height<=480]+ba/b[height<=480]/b[ext=mp4]/b',
      '--merge-output-format', 'mp4',
      '-o', rawOut
    ];
    if (useProxy && proxyOk) args.push('--proxy', RESIDENTIAL_PROXY);
    if (cookiePath) args.push('--cookies', cookiePath);
    args.push(url);
    await execFileAsync('yt-dlp', args, { timeout: 35000 });
  };

  try {
    try {
      await runDl(true);
    } catch {
      if (proxyOk) {
        try { rmSync(rawOut, { force: true }); } catch {}
        await runDl(false);
      } else {
        throw new Error('yt-dlp trailer download failed');
      }
    }

    if (!existsSync(rawOut)) return null;
    const rawSize = statSync(rawOut).size;
    if (rawSize < 8192 || rawSize > maxBytes * 1.15) {
      try { unlinkSync(rawOut); } catch {}
      return null;
    }

    const finalPath = await ensureFastStartMp4(rawOut, fastOut);
    if (finalPath !== rawOut) {
      try { unlinkSync(rawOut); } catch {}
    }
    const finalSize = statSync(finalPath).size;
    if (finalSize < 8192 || finalSize > maxBytes) {
      try { unlinkSync(finalPath); } catch {}
      return null;
    }
    const meta = await probeVideoMeta(finalPath);
    if (meta.durationSeconds && meta.durationSeconds > 360) {
      try { unlinkSync(finalPath); } catch {}
      return null;
    }

    const entry = {
      filePath: finalPath,
      filename: `trailer_${youtubeId}.mp4`,
      contentType: 'video/mp4',
      sizeBytes: finalSize,
      durationSeconds: meta.durationSeconds,
      width: meta.width,
      height: meta.height,
      expiresAt: Date.now() + 15 * 60_000
    };
    localClipCache.set(youtubeId, entry);
    setTimeout(() => {
      const cur = localClipCache.get(youtubeId);
      if (cur && cur.filePath === finalPath && cur.expiresAt <= Date.now()) {
        localClipCache.delete(youtubeId);
      }
      try { if (existsSync(finalPath)) unlinkSync(finalPath); } catch {}
    }, 15 * 60_000 + 2000).unref?.();
    return entry;
  } catch {
    try { if (existsSync(rawOut)) unlinkSync(rawOut); } catch {}
    try { if (existsSync(fastOut)) unlinkSync(fastOut); } catch {}
    return null;
  }
}

export async function prepareMovieTrailerPreview({
  movieApi,
  db = null,
  item = {},
  botKey = 'default',
  maxBytes = 25 * 1024 * 1024,
  downloadClipImpl = null,
  log = null
} = {}) {
  if (!item || item.adult || item.isAdultCatalogItem) return null;

  const cachedFid = getCachedTrailerFileId(db, item, botKey);
  if (cachedFid?.fileId) {
    return {
      ok: true,
      fromCache: true,
      fileId: cachedFid.fileId,
      youtubeId: cachedFid.youtubeId || null,
      url: cachedFid.url || null,
      title: cachedFid.title || `${item.title || 'Movie'} · Official Trailer`,
      durationSeconds: cachedFid.durationSeconds || null
    };
  }

  const dedupeKey = `${botKey || 'default'}:${buildTrailerItemKey(item)}`;
  if (inflightDownloads.has(dedupeKey)) {
    return await inflightDownloads.get(dedupeKey);
  }

  const job = (async () => {
    try {
      const meta = await movieApi?.resolveTrailer?.(item).catch(() => null);
      if (!meta?.youtubeId) return null;

      const dlFn = typeof downloadClipImpl === 'function' ? downloadClipImpl : defaultDownloadTrailerClip;
      const clip = await dlFn(meta.youtubeId, { maxBytes }).catch(() => null);
      if (!clip?.filePath && !clip?.buffer) {
        return {
          ok: false,
          youtubeId: meta.youtubeId,
          url: meta.url,
          title: meta.title || `${item.title || 'Movie'} · Official Trailer`
        };
      }
      return {
        ok: true,
        fromCache: false,
        youtubeId: meta.youtubeId,
        url: meta.url,
        title: meta.title || `${item.title || 'Movie'} · Official Trailer`,
        durationSeconds: clip.durationSeconds || meta.durationSeconds || null,
        width: clip.width || null,
        height: clip.height || null,
        filePath: clip.filePath || null,
        buffer: clip.buffer || null,
        filename: clip.filename || `trailer_${meta.youtubeId}.mp4`,
        contentType: clip.contentType || 'video/mp4'
      };
    } catch (err) {
      log?.debug?.({ err: err?.message }, 'trailer preview preparation failed');
      return null;
    } finally {
      inflightDownloads.delete(dedupeKey);
    }
  })();

  inflightDownloads.set(dedupeKey, job);
  return await job;
}
