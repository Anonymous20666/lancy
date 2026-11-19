/**
 * Lancy multi-source FULL-LENGTH music resolver.
 * Sources (all full-length, each duration-validated >= minSeconds):
 *   1. YouTube  — yt-dlp via the rotating RESIDENTIAL proxy (beats bot-checks)
 *   2. JioSaavn — direct API, DES-decrypted CDN urls (160/320kbps)
 *   3. Audius   — public full streams, explicit-friendly
 * Explicit/18+ queries are allowed and preferred where flagged.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream, existsSync, statSync, unlinkSync, renameSync, copyFileSync } from 'node:fs';
import { createDecipheriv } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { resolveFfmpegPath } from './convert.js';

const execFileAsync = promisify(execFile);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const RESIDENTIAL_PROXY = process.env.LANCY_RESIDENTIAL_PROXY ?? 'http://127.0.0.1:8888';
const AUDIUS_HOSTS = [
    'https://discoveryprovider.audius.co',
    'https://audius-discovery-1.altego.net',
    'https://discovery-au-02.audius.openplayer.org',
];
const JIO_KEY = Buffer.from('38346591', 'utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wantsExplicit = (q) => /\b(explicit|18\+|uncensored|dirty|nsfw|x[- ]?rated)\b/i.test(String(q || ''));

const metadataCache = new Map();
const METADATA_TTL_MS = 10 * 60 * 1000;
const proxyStatusCache = new Map();
const PROXY_STATUS_TTL_MS = 60 * 1000;

export async function isProxyReachable(proxyUrl, timeoutMs = 150) {
    if (!proxyUrl) return false;
    const now = Date.now();
    const cached = proxyStatusCache.get(proxyUrl);
    if (cached && now - cached.at < PROXY_STATUS_TTL_MS) {
        return cached.ok;
    }
    let host = '127.0.0.1';
    let port = 8888;
    try {
        const parsed = new URL(proxyUrl.replace(/^socks5h?:\/\//i, 'http://'));
        host = parsed.hostname || '127.0.0.1';
        port = Number(parsed.port) || 8888;
    } catch {
        return false;
    }
    const ok = await new Promise((resolve) => {
        const socket = createConnection({ host, port });
        let settled = false;
        const finish = (val) => {
            if (settled) return;
            settled = true;
            try { socket.destroy(); } catch {}
            resolve(val);
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
    });
    proxyStatusCache.set(proxyUrl, { ok, at: now });
    return ok;
}

/** ── metadata (title/artist/explicit/duration) ─────────────────────── */
function metadataTokenScore(query, title, artist) {
    const q = String(query || '').toLowerCase();
    const tokens = [...new Set(q.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length >= 2))];
    if (!tokens.length) return 0;
    const text = `${title || ''} ${artist || ''}`.toLowerCase();
    let score = 0;
    for (const tok of tokens) {
        if (text.includes(tok)) score += 25;
    }
    const extraRe = /\b(beat|type\s*beat|tribute|lofi|lo-fi|acoustic|remix|slowed|reverb|karaoke|instrumental|cover|sped\s*up|nightcore)\b/i;
    if (!extraRe.test(q) && extraRe.test(text)) {
        score -= 45;
    }
    return score;
}

async function deezerMatch(query) {
    try {
        const res = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=10`, { signal: AbortSignal.timeout(4500) });
        if (!res.ok) return null;
        const rows = (await res.json()).data ?? [];
        if (!rows.length) return null;
        const wantX = wantsExplicit(query);
        const scored = rows.map((r) => {
            const rel = metadataTokenScore(query, r.title, r.artist?.name);
            const popBoost = Math.log10(Math.max(10, Number(r.rank ?? 10))) * 4;
            const bonus = (wantX && r.explicit_lyrics ? 6 : 0) + ((r.duration ?? 0) >= 45 ? 10 : -50) + popBoost;
            return { r, rel: rel + bonus, rank: Number(r.rank ?? 0) };
        });
        scored.sort((a, b) => (b.rel - a.rel) || (b.rank - a.rank));
        const t = scored[0].r;
        return { title: t.title, artist: t.artist?.name, duration: t.duration ?? 0, explicit: Boolean(t.explicit_lyrics), cover: t.album?.cover_big || t.album?.cover_medium || null, source: 'deezer', _rel: scored[0].rel };
    } catch { return null; }
}

async function itunesMatch(query) {
    try {
        const res = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&limit=10`, { signal: AbortSignal.timeout(4500) });
        if (!res.ok) return null;
        const rows = (await res.json()).results ?? [];
        if (!rows.length) return null;
        const wantX = wantsExplicit(query);
        const scored = rows.map((r) => {
            const dur = Math.round((r.trackTimeMillis ?? 0) / 1000);
            const rel = metadataTokenScore(query, r.trackName, r.artistName);
            const bonus = (wantX && r.trackExplicitness === 'explicit' ? 8 : 0) + (dur >= 45 ? 10 : -50);
            return { r, rel: rel + bonus, dur };
        });
        scored.sort((a, b) => b.rel - a.rel);
        const best = scored[0];
        const t = best.r;
        return { title: t.trackName, artist: t.artistName, duration: best.dur, explicit: t.trackExplicitness === 'explicit', cover: t.artworkUrl100?.replace('100x100', '600x600') || null, source: 'itunes', _rel: best.rel };
    } catch { return null; }
}

export async function resolveMetadata(query) {
    const cacheKey = String(query || '').trim().toLowerCase();
    if (!cacheKey) return null;
    const now = Date.now();
    const cached = metadataCache.get(cacheKey);
    if (cached && now - cached.at < METADATA_TTL_MS) {
        return cached.value;
    }
    const [dz, it] = await Promise.all([deezerMatch(query), itunesMatch(query)]);
    let picked = null;
    if (dz && it) {
        const dzOk = (dz.duration ?? 0) >= 45;
        const itOk = (it.duration ?? 0) >= 45;
        if (dzOk && !itOk) picked = dz;
        else if (itOk && !dzOk) picked = it;
        else picked = (it._rel ?? 0) > (dz._rel ?? 0) ? it : dz;
    } else {
        picked = dz || it || null;
    }
    const value = picked ? (({ _rel, ...rest }) => rest)(picked) : null;
    if (value) {
        metadataCache.set(cacheKey, { value, at: now });
        if (metadataCache.size > 300) {
            const firstKey = metadataCache.keys().next().value;
            metadataCache.delete(firstKey);
        }
    }
    return value;
}

/** ── source 1: YouTube / SoundCloud yt-dlp audio extractor ──────── */
async function ytDlpMp3(url, tempPath, { minSeconds = 45, timeoutMs = 90000, ffmpegPath = 'ffmpeg' } = {}) {
    const outStem = tempPath.replace(/\.(?:mp3|source)$/i, '');
    const outTemplate = `${outStem}.%(ext)s`;
    const isMultiSearch = /^(?:scsearch|ytsearch)[2-9]\d*:/i.test(String(url || ''));
    const resolvedFfmpeg = resolveFfmpegPath(ffmpegPath !== 'ffmpeg' ? ffmpegPath : '') || ffmpegPath;
    const run = (proxy) => execFileAsync('yt-dlp', [
        '--ignore-errors',
        '--no-warnings', '--no-playlist',
        ...(isMultiSearch ? ['--max-downloads', '1'] : []),
        ...(proxy ? ['--proxy', proxy] : []),
        ...(resolvedFfmpeg ? ['--ffmpeg-location', resolvedFfmpeg] : []),
        '-N', '4', '--max-filesize', '80M',
        '--js-runtimes', 'node:/usr/bin/node',
        '--match-filter', `duration>=${minSeconds} & duration<=1200`,
        '-f', 'ba[ext=m4a]/ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '2',
        '-o', outTemplate, url,
    ], { timeout: timeoutMs }).catch((err) => {
        // Note: yt-dlp exits with code 101 when --max-downloads 1 is reached or code 1 when an earlier item in scsearch5 was DRM-skipped
        if (existsSync(`${outStem}.mp3`) || existsSync(tempPath)) return { stdout: '' };
        throw err;
    });
    if (!/^scsearch/i.test(String(url || '')) && await isProxyReachable(RESIDENTIAL_PROXY)) {
        try {
            await run(RESIDENTIAL_PROXY);
        } catch {
            await sleep(400);
            await run(null);
        }
    } else {
        await run(null);
    }
    if (!existsSync(tempPath) && existsSync(`${outStem}.mp3`)) {
        try { renameSync(`${outStem}.mp3`, tempPath); } catch {}
    }
    return existsSync(tempPath) && statSync(tempPath).size > 20000;
}

const UNDESIRED_EDIT_RE = /\b(slowed|reverb|nightcore|sped\s*up|8d\s*audio|karaoke|instrumental|reaction|teaser|shorts|cover|bass\s*boosted|tiktok\s*version)\b/i;

function scoreTrackCandidate(query, title, author = '', durationSec = 0) {
    const q = String(query || '').toLowerCase();
    const text = `${title || ''} ${author || ''}`.toLowerCase();
    const tokens = q.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length >= 2);
    let score = 0;
    let hits = 0;
    for (const tok of tokens) {
        if (text.includes(tok)) {
            hits++;
            score += 20;
        }
    }
    if (tokens.length > 0 && hits === 0) return -100;
    if (/\b(official audio|topic|audio)\b/i.test(text)) score += 18;
    else if (/\b(official lyric|lyrics)\b/i.test(text)) score += 10;
    else if (/\b(official video|official music video)\b/i.test(text)) score += 5;

    if (!UNDESIRED_EDIT_RE.test(q) && UNDESIRED_EDIT_RE.test(text)) score -= 45;
    if (durationSec > 0 && durationSec < 45) score -= 80;
    if (durationSec >= 90 && durationSec <= 480) score += 8;
    if (durationSec > 900) score -= 40;
    return score;
}

async function ytSearchId(query, minSeconds) {
    try {
        const { searchYouTubeFast } = await import('./youtubeSearch.js');
        const settled = await Promise.allSettled([
            searchYouTubeFast(query, 'NG'),
            searchYouTubeFast(query, 'US'),
        ]);
        const seen = new Set();
        const candidates = [];
        for (const r of settled) {
            if (r.status !== 'fulfilled' || !Array.isArray(r.value)) continue;
            for (const v of r.value) {
                const id = v.videoId ?? v.id ?? null;
                if (!id || seen.has(id)) continue;
                seen.add(id);
                const secs = Number(v.durationSeconds ?? v.duration ?? 0);
                if (secs > 0 && secs < minSeconds) continue;
                candidates.push({
                    id,
                    score: scoreTrackCandidate(query, v.title, v.author, secs),
                });
            }
        }
        if (!candidates.length) return null;
        candidates.sort((a, b) => b.score - a.score);
        return candidates[0].id;
    } catch { return null; }
}

/** ── source 2: JioSaavn (DES-decrypted full CDN urls) ──────────────── */
function decryptJioUrl(enc) {
    try {
        const d = createDecipheriv('des-ecb', JIO_KEY, Buffer.alloc(8));
        const out = Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
        let url = String(out).split('<')[0].trim();
        url = url.replace('_96.', '_320.').replace('96.mp4', '320.mp4');
        return url.startsWith('http') ? url : null;
    } catch { return null; }
}

async function jiosaavnPick(query) {
    try {
        const res = await fetch(`https://www.jiosaavn.com/api.php?__call=search.getResults&_format=json&_marker=0&api_version=4&ctx=web6dot0&n=8&q=${encodeURIComponent(query)}`, {
            headers: { 'user-agent': UA }, signal: AbortSignal.timeout(6000),
        });
        if (!res.ok) return null;
        const data = await res.json();
        const rows = (data.results ?? [])
            .map((r) => {
                const artistFromMap = Array.isArray(r?.more_info?.artistMap?.primary_artists)
                    ? r.more_info.artistMap.primary_artists.map((a) => a?.name).filter(Boolean).join(', ')
                    : '';
                return {
                    title: String(r.title ?? '').replace(/&quot;/g, '"').replace(/&amp;/g, '&'),
                    artist: String(r.primaryArtists || artistFromMap || r.subtitle || 'Music').replace(/&quot;/g, '"').replace(/&amp;/g, '&'),
                    duration: Number(r.duration || r?.more_info?.duration || 0),
                    enc: r.encrypted_media_url || r?.more_info?.encrypted_media_url || null
                };
            })
            .filter((r) => r.enc && r.duration >= 45)
            .map((r) => ({ ...r, score: scoreTrackCandidate(query, r.title, r.artist, r.duration) }))
            .filter((r) => r.score >= 30)
            .sort((a, b) => b.score - a.score);
        const best = rows[0];
        if (!best) return null;
        const url = decryptJioUrl(best.enc);
        if (!url) return null;
        return { title: best.title, artist: best.artist, duration: best.duration, url };
    } catch { return null; }
}

async function jiosaavnDownload(track, tempPath, ffmpegPath = 'ffmpeg') {
    try {
        const res = await fetch(track.url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(90000) });
        if (!res.ok || !res.body) return false;
        await pipeline(Readable.fromWeb(res.body), createWriteStream(tempPath));
        if (!existsSync(tempPath) || statSync(tempPath).size < 200000) return false;
        // jiosaavn serves m4a/mp4 — normalize to mp3
        const resolvedFfmpeg = resolveFfmpegPath(ffmpegPath !== 'ffmpeg' ? ffmpegPath : '') || ffmpegPath || 'ffmpeg';
        try {
            await execFileAsync(resolvedFfmpeg, ['-y', '-i', tempPath, '-c:a', 'libmp3lame', '-q:a', '2', `${tempPath}.mp3`], { timeout: 60000 });
            unlinkSync(tempPath);
            renameSync(`${tempPath}.mp3`, tempPath);
        } catch {}
        return existsSync(tempPath) && statSync(tempPath).size > 100000;
    } catch { return false; }
}

/** ── source 3: Audius ──────────────────────────────────────────────── */
async function audiusApi(path) {
    for (const host of AUDIUS_HOSTS) {
        try {
            const res = await fetch(`${host}${path}${path.includes('?') ? '&' : '?'}app_name=LancyBot`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(5000) });
            if (!res.ok) continue;
            return await res.json();
        } catch {}
    }
    return null;
}

async function audiusPick(query) {
    const data = await audiusApi(`/v1/tracks/search?query=${encodeURIComponent(query)}`);
    const tracks = (data?.data ?? [])
        .filter((t) => t?.is_streamable !== false && (t?.duration ?? 0) >= 60)
        .map((t) => ({ t, score: scoreTrackCandidate(query, t.title, t.user?.name, Number(t.duration ?? 0)) }))
        .filter((x) => x.score >= 0)
        .sort((a, b) => (b.score - a.score) || (Number(b.t.play_count ?? 0) - Number(a.t.play_count ?? 0)));
    return tracks[0]?.t ?? null;
}

export async function audiusTrending(genre) {
    const data = await audiusApi(`/v1/tracks/trending${genre ? `?genre=${encodeURIComponent(genre)}` : ''}&time=week`);
    return (data?.data ?? []).slice(0, 20).map((t) => ({ id: t.id, title: t.title, artist: t.user?.name, duration: t.duration, explicit: Boolean(t.is_explicit ?? t.explicit) }));
}

async function audiusDownload(track, tempPath) {
    for (const host of AUDIUS_HOSTS) {
        try {
            const res = await fetch(`${host}/v1/tracks/${track.id}/stream?app_name=LancyBot`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(90000) });
            if (!res.ok || !res.body) continue;
            await pipeline(Readable.fromWeb(res.body), createWriteStream(tempPath));
            if (existsSync(tempPath) && statSync(tempPath).size > 200000) return true;
        } catch {}
    }
    try { unlinkSync(tempPath); } catch {}
    return false;
}

/** ── source 4: Spotify / Apple Music / Audiomack / SoundCloud (social-dl & btch-downloader) ── */
export async function resolveSocialOrSpotifyAudio(trackOrUrl, tempPath, { minSeconds = 35, ffmpegPath = 'ffmpeg', onProgress = null } = {}) {
    try {
        const socialDl = await import('social-dl').catch(() => null);
        const btchMod = await import('btch-downloader').catch(() => null);
        const btch = btchMod?.default || btchMod;

        const sourceRef = String(typeof trackOrUrl === 'string' ? trackOrUrl : (trackOrUrl?.sourceRef || '')).trim();
        const title = String(trackOrUrl?.title || '').trim();
        const artist = String(trackOrUrl?.artist || '').trim();

        // 1. Direct Spotify URL via social-dl or btch-downloader
        if (/open\.spotify\.com\/track\/|spotify\.link\/|spoti\.fi\//i.test(sourceRef)) {
            onProgress?.('Resolving Spotify track stream… ♡');
            if (btch?.spotify) {
                const sp = await Promise.race([
                    btch.spotify(sourceRef),
                    sleep(10000).then(() => null)
                ]).catch(() => null);
                const audioUrl = sp?.res_data?.formats?.[0]?.url || sp?.res_data?.url || sp?.result?.url || sp?.url;
                if (audioUrl && /^https?:\/\//i.test(audioUrl)) {
                    const res = await fetch(audioUrl, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(45000) });
                    if (res.ok && res.body) {
                        await pipeline(Readable.fromWeb(res.body), createWriteStream(tempPath));
                        if (existsSync(tempPath) && statSync(tempPath).size > 100000) return { ok: true, source: 'spotify-btch' };
                    }
                }
            }
            if (socialDl?.spotifySave) {
                await socialDl.spotifySave(sourceRef, tempPath).catch(() => null);
                if (existsSync(tempPath) && statSync(tempPath).size > 100000) return { ok: true, source: 'spotify-social-dl' };
            }
        }

        // 2. Direct Apple Music URL via social-dl
        if (/music\.apple\.com\//i.test(sourceRef) && socialDl?.applemusicSave) {
            onProgress?.('Resolving Apple Music stream… ♡');
            await socialDl.applemusicSave(sourceRef, tempPath).catch(() => null);
            if (existsSync(tempPath) && statSync(tempPath).size > 100000) return { ok: true, source: 'applemusic-social-dl' };
        }

        // 3. Direct Audiomack URL via social-dl
        if (/audiomack\.com\//i.test(sourceRef) && socialDl?.audiomackSave) {
            onProgress?.('Resolving Audiomack stream… ♡');
            await socialDl.audiomackSave(sourceRef, tempPath).catch(() => null);
            if (existsSync(tempPath) && statSync(tempPath).size > 100000) return { ok: true, source: 'audiomack-social-dl' };
        }

        // 4. Direct SoundCloud URL via btch-downloader
        if (/soundcloud\.com\//i.test(sourceRef) && btch?.soundcloud) {
            onProgress?.('Resolving SoundCloud stream… ♡');
            const sc = await Promise.race([
                btch.soundcloud(sourceRef),
                sleep(10000).then(() => null)
            ]).catch(() => null);
            const audioUrl = sc?.result?.audio || sc?.result?.url || sc?.url;
            if (audioUrl && /^https?:\/\//i.test(audioUrl)) {
                const res = await fetch(audioUrl, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(45000) });
                if (res.ok && res.body) {
                    await pipeline(Readable.fromWeb(res.body), createWriteStream(tempPath));
                    if (existsSync(tempPath) && statSync(tempPath).size > 100000) return { ok: true, source: 'soundcloud-btch' };
                }
            }
        }

        // 5. Catalog Metadata Confidence Match via social-dl matchAudioSource + saveMatchedAudio
        if (title && socialDl?.matchAudioSource && socialDl?.saveMatchedAudio) {
            onProgress?.(`Matching studio audio source for "${artist ? `${artist} - ` : ''}${title}"… ♡`);
            const match = await Promise.race([
                socialDl.matchAudioSource({
                    title,
                    artist: artist || 'Music',
                    durationSeconds: Number(trackOrUrl?.durationSeconds) || undefined
                }),
                sleep(12000).then(() => null)
            ]).catch(() => null);
            if (match?.url) {
                await socialDl.saveMatchedAudio({ matchedSource: match }, tempPath).catch(() => null);
                if (existsSync(tempPath) && statSync(tempPath).size > 100000) {
                    return { ok: true, source: `spotify-match:${match.platform || 'studio'}` };
                }
            }
        }
    } catch {}
    return { ok: false, source: null };
}

/** ── duration validation (preview killer) ──────────────────────────── */
async function durationOf(file, ffmpeg = 'ffmpeg') {
    try {
        await execFileAsync(ffmpeg, ['-i', file, '-f', 'null', '-'], { timeout: 20000 });
        return null;
    } catch (e) {
        const m = String(e.stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+)/);
        if (!m) return null;
        return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    }
}

/**
 * Resolve + download a FULL track as MP3.
 * Returns { ok, source, meta }.
 */
export async function resolveAndDownloadAudio({
    query,
    trackId,
    tempPath,
    ffmpegPath = 'ffmpeg',
    minSeconds = 45,
    meta: preResolvedMeta = undefined,
    skipYouTube = false,
    onProgress = null
}) {
    const resolvedFfmpeg = resolveFfmpegPath(ffmpegPath !== 'ffmpeg' ? ffmpegPath : '') || ffmpegPath || 'ffmpeg';
    const rawQuery = String(query ?? '').replace(/\.mp3$/i, '').replace(/_/g, ' ').trim();
    const hasValidYtId = Boolean(trackId && /^[a-zA-Z0-9_-]{11}$/.test(trackId));

    // Instant disk cache reuse when resolved by exact YouTube ID
    if (hasValidYtId) {
        const cachedTrackPath = join('/data/audio_cache', `${trackId}.mp3`);
        if (existsSync(cachedTrackPath) && statSync(cachedTrackPath).size > 50000) {
            try {
                copyFileSync(cachedTrackPath, tempPath);
                const cachedDur = await durationOf(tempPath, resolvedFfmpeg);
                if (cachedDur === null || cachedDur >= minSeconds) {
                    const metaFast = preResolvedMeta !== undefined ? preResolvedMeta : null;
                    return { ok: true, source: 'disk-cache', meta: { ...(metaFast ?? {}), title: metaFast?.title ?? rawQuery, artist: metaFast?.artist ?? 'Music' } };
                }
                try { unlinkSync(tempPath); } catch {}
            } catch {}
        }
    }

    onProgress?.('Searching source & resolving metadata… ♡');
    const [metaSettled, rawYtIdSettled, proxyUpSettled] = await Promise.allSettled([
        preResolvedMeta !== undefined ? Promise.resolve(preResolvedMeta) : resolveMetadata(query),
        (!hasValidYtId && !skipYouTube && rawQuery) ? ytSearchId(rawQuery, minSeconds) : Promise.resolve(null),
        skipYouTube ? Promise.resolve(false) : isProxyReachable(RESIDENTIAL_PROXY),
    ]);
    const meta = metaSettled.status === 'fulfilled' ? metaSettled.value : null;
    const rawYtId = rawYtIdSettled.status === 'fulfilled' ? rawYtIdSettled.value : null;
    const proxyUp = proxyUpSettled.status === 'fulfilled' ? proxyUpSettled.value : false;

    const searchQuery = meta ? `${meta.artist} ${meta.title}`.trim() : rawQuery;
    const attempts = [];
    const triedYtIds = new Set();

    // 1. Direct Spotify / Apple Music / Audiomack / SoundCloud URLs first (fast direct link resolution)
    const directSocialRef = String(meta?.sourceRef || '').trim();
    if (/open\.spotify\.com\/track\/|spotify\.link\/|spoti\.fi\/|music\.apple\.com\/|audiomack\.com\/|soundcloud\.com\//i.test(directSocialRef)) {
        attempts.push({
            name: 'spotify-social',
            run: async () => {
                const res = await resolveSocialOrSpotifyAudio({
                    title: meta?.title || rawQuery,
                    artist: meta?.artist || '',
                    sourceRef: directSocialRef,
                    durationSeconds: meta?.durationSeconds || meta?.duration || undefined
                }, tempPath, { minSeconds, ffmpegPath: resolvedFfmpeg, onProgress });
                return Boolean(res?.ok);
            }
        });
    }

    // 2. Race JioSaavn 320kbps + Audius track discovery in parallel (<2.5s total) so non-hits fail fast
    const primaryQ = searchQuery || rawQuery;
    const [jioSettled, audiusSettled] = await Promise.allSettled([
        primaryQ ? jiosaavnPick(primaryQ) : Promise.resolve(null),
        primaryQ ? audiusPick(primaryQ) : Promise.resolve(null)
    ]);
    const jioTrack = jioSettled.status === 'fulfilled' ? jioSettled.value : null;
    const audiusTrack = audiusSettled.status === 'fulfilled' ? audiusSettled.value : null;

    if (jioTrack) {
        attempts.push({
            name: 'jiosaavn',
            run: async () => {
                onProgress?.(`Downloading 320kbps studio track "${jioTrack.title}"… ♡`);
                const ok = await jiosaavnDownload(jioTrack, tempPath, resolvedFfmpeg);
                if (ok) {
                    try {
                        await execFileAsync(resolvedFfmpeg, ['-y', '-i', tempPath, '-metadata', `title=${jioTrack.title}`, '-metadata', `artist=${jioTrack.artist}`, '-id3v2_version', '3', '-c', 'copy', `${tempPath}.tag.mp3`], { timeout: 30000 });
                        unlinkSync(tempPath);
                        renameSync(`${tempPath}.tag.mp3`, tempPath);
                    } catch {}
                }
                return ok;
            },
        });
    }

    if (audiusTrack) {
        attempts.push({
            name: 'audius',
            run: async () => {
                onProgress?.(`Downloading full track "${audiusTrack.title}"… ♡`);
                const ok = await audiusDownload(audiusTrack, tempPath);
                if (ok) {
                    try {
                        await execFileAsync(resolvedFfmpeg, ['-y', '-i', tempPath, '-metadata', `title=${audiusTrack.title}`, '-metadata', `artist=${audiusTrack.user?.name || 'Unknown'}`, '-id3v2_version', '3', '-c', 'copy', `${tempPath}.tag.mp3`], { timeout: 30000 });
                        unlinkSync(tempPath);
                        renameSync(`${tempPath}.tag.mp3`, tempPath);
                    } catch {}
                }
                return ok;
            },
        });
    }

    // 3. SoundCloud fast full-track search (minSeconds automatically skips 30s Go+ previews)
    attempts.push({
        name: 'soundcloud',
        run: async () => {
            const q1 = meta ? searchQuery : (rawQuery || searchQuery);
            if (await ytDlpMp3(`scsearch6:${q1}`, tempPath, { minSeconds, timeoutMs: 35000, ffmpegPath: resolvedFfmpeg })) return true;
            if (rawQuery && rawQuery !== q1) {
                return await ytDlpMp3(`scsearch6:${rawQuery}`, tempPath, { minSeconds, timeoutMs: 35000, ffmpegPath: resolvedFfmpeg });
            }
            return false;
        }
    });

    // 2. Last-resort fallback only if direct music engines miss
    if (!skipYouTube || proxyUp) {
        if (hasValidYtId) {
            triedYtIds.add(trackId);
            attempts.push({ name: 'youtube-id', run: () => ytDlpMp3(`https://www.youtube.com/watch?v=${trackId}`, tempPath, { minSeconds, ffmpegPath: resolvedFfmpeg }) });
        } else {
            if (meta && searchQuery.toLowerCase() !== rawQuery.toLowerCase()) {
                const ytIdMeta = await ytSearchId(searchQuery, minSeconds);
                if (ytIdMeta && !triedYtIds.has(ytIdMeta)) {
                    triedYtIds.add(ytIdMeta);
                    attempts.push({ name: 'youtube-search', run: () => ytDlpMp3(`https://www.youtube.com/watch?v=${ytIdMeta}`, tempPath, { minSeconds, ffmpegPath: resolvedFfmpeg }) });
                }
            }
            if (rawYtId && !triedYtIds.has(rawYtId)) {
                triedYtIds.add(rawYtId);
                attempts.push({ name: 'youtube-search-raw', run: () => ytDlpMp3(`https://www.youtube.com/watch?v=${rawYtId}`, tempPath, { minSeconds, ffmpegPath: resolvedFfmpeg }) });
            }
        }

        if (triedYtIds.size === 0) {
            attempts.push({
                name: 'youtube-direct',
                run: async () => {
                    if (meta && (await ytDlpMp3(`ytsearch1:${searchQuery}`, tempPath, { minSeconds, ffmpegPath: resolvedFfmpeg }))) return true;
                    return ytDlpMp3(`ytsearch1:${rawQuery || searchQuery}`, tempPath, { minSeconds, ffmpegPath: resolvedFfmpeg });
                },
            });
        }
    }

    for (const attempt of attempts) {
        try {
            if (!(await attempt.run())) continue;
            onProgress?.('Processing audio & verifying track duration… ♡');
            const dur = await durationOf(tempPath, resolvedFfmpeg);
            if (dur !== null && dur < minSeconds) {
                try { unlinkSync(tempPath); } catch {}
                continue;
            }
            return { ok: true, source: attempt.name, meta: { ...(meta ?? {}), title: meta?.title ?? rawQuery, artist: meta?.artist ?? 'Music' } };
        } catch {}
    }
    return { ok: false, source: null, meta };
}
