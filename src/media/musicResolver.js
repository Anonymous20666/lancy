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
import { createWriteStream, existsSync, statSync, unlinkSync, renameSync } from 'node:fs';
import { createDecipheriv } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

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

/** ── metadata (title/artist/explicit/duration) ─────────────────────── */
async function deezerMatch(query) {
    try {
        const res = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=5`, { signal: AbortSignal.timeout(4500) });
        if (!res.ok) return null;
        const rows = (await res.json()).data ?? [];
        if (!rows.length) return null;
        const wantX = wantsExplicit(query);
        rows.sort((a, b) => (Number(b.rank ?? 0) * (wantX && b.explicit_lyrics ? 1.25 : 1)) - (Number(a.rank ?? 0) * (wantX && a.explicit_lyrics ? 1.25 : 1)));
        const t = rows[0];
        return { title: t.title, artist: t.artist?.name, duration: t.duration ?? 0, explicit: Boolean(t.explicit_lyrics), cover: t.album?.cover_big || t.album?.cover_medium || null, source: 'deezer' };
    } catch { return null; }
}

async function itunesMatch(query) {
    try {
        const res = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&limit=5`, { signal: AbortSignal.timeout(4500) });
        if (!res.ok) return null;
        const rows = (await res.json()).results ?? [];
        if (!rows.length) return null;
        const t = rows[0];
        return { title: t.trackName, artist: t.artistName, duration: Math.round((t.trackTimeMillis ?? 0) / 1000), explicit: t.trackExplicitness === 'explicit', cover: t.artworkUrl100?.replace('100x100', '600x600') || null, source: 'itunes' };
    } catch { return null; }
}

export async function resolveMetadata(query) {
    const [dz, it] = await Promise.all([deezerMatch(query), itunesMatch(query)]);
    return ((dz?.duration ?? 0) >= 45 ? dz : (it ?? dz)) ?? null;
}

/** ── source 1: YouTube via residential proxy ───────────────────────── */
async function ytDlpMp3(url, tempPath, { minSeconds = 45, timeoutMs = 90000 } = {}) {
    const run = (proxy) => execFileAsync('yt-dlp', [
        '--no-warnings', '--no-playlist',
        ...(proxy ? ['--proxy', proxy] : []),
        '-N', '4', '--max-filesize', '80M',
        '--js-runtimes', 'node:/usr/bin/node',
        '--match-filter', `duration>=${minSeconds}`,
        '-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '2',
        '-o', tempPath, url,
    ], { timeout: timeoutMs });
    try { await run(RESIDENTIAL_PROXY); } catch { await sleep(800); await run(null); }
    return existsSync(tempPath) && statSync(tempPath).size > 20000;
}

async function ytSearchId(query, minSeconds) {
    try {
        const { searchYouTubeFast } = await import('./youtubeSearch.js');
        const seen = new Set();
        // regional catalog first (NG), then global US — merged
        for (const gl of ['NG', 'US']) {
            let results = [];
            try { results = await searchYouTubeFast(query, gl); } catch {}
            for (const v of results) {
                const id = v.videoId ?? v.id ?? null;
                if (!id || seen.has(id)) continue;
                seen.add(id);
                const secs = Number(v.durationSeconds ?? v.duration ?? 0);
                if (secs === 0 || secs >= minSeconds) return id;
            }
        }
        return null;
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
            .map((r) => ({ title: String(r.title ?? '').replace(/&quot;/g, '"').replace(/&amp;/g, '&'), artist: r.primaryArtists ?? 'Music', duration: Number(r.duration ?? 0), enc: r.encrypted_media_url }))
            .filter((r) => r.enc);
        const best = rows.find((r) => r.duration >= 45) ?? rows[0];
        if (!best) return null;
        const url = decryptJioUrl(best.enc);
        if (!url) return null;
        return { title: best.title, artist: best.artist, duration: best.duration, url };
    } catch { return null; }
}

async function jiosaavnDownload(track, tempPath) {
    try {
        const res = await fetch(track.url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(90000) });
        if (!res.ok || !res.body) return false;
        await pipeline(Readable.fromWeb(res.body), createWriteStream(tempPath));
        if (!existsSync(tempPath) || statSync(tempPath).size < 200000) return false;
        // jiosaavn serves m4a/mp4 — normalize to mp3
        try {
            await execFileAsync('ffmpeg', ['-y', '-i', tempPath, '-c:a', 'libmp3lame', '-q:a', '2', `${tempPath}.mp3`], { timeout: 60000 });
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
    const tracks = (data?.data ?? []).filter((t) => t?.is_streamable !== false && (t?.duration ?? 0) >= 60);
    if (!tracks.length) return null;
    tracks.sort((a, b) => Number(b.play_count ?? 0) - Number(a.play_count ?? 0));
    return tracks[0] ?? null;
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
export async function resolveAndDownloadAudio({ query, trackId, tempPath, ffmpegPath = 'ffmpeg', minSeconds = 45 }) {
    const meta = await resolveMetadata(query);
    const rawQuery = String(query ?? '').replace(/\.mp3$/i, '').replace(/_/g, ' ').trim();
    const searchQuery = meta ? `${meta.artist} ${meta.title}`.trim() : rawQuery;
    const attempts = [];

    if (trackId && /^[a-zA-Z0-9_-]{11}$/.test(trackId)) {
        attempts.push({ name: 'youtube-id', run: () => ytDlpMp3(`https://www.youtube.com/watch?v=${trackId}`, tempPath, { minSeconds }) });
    } else {
        // exact metadata title+artist first (best for long-tail/meme tracks)
        if (meta) {
            const ytIdMeta = await ytSearchId(searchQuery, minSeconds);
            if (ytIdMeta) attempts.push({ name: 'youtube-search', run: () => ytDlpMp3(`https://www.youtube.com/watch?v=${ytIdMeta}`, tempPath, { minSeconds }) });
        }
        const ytIdRaw = await ytSearchId(rawQuery, minSeconds);
        if (ytIdRaw) attempts.push({ name: 'youtube-search-raw', run: () => ytDlpMp3(`https://www.youtube.com/watch?v=${ytIdRaw}`, tempPath, { minSeconds }) });
    }

    attempts.push({
        name: 'youtube-direct',
        run: async () => {
            if (meta && (await ytDlpMp3(`ytsearch3:${searchQuery}`, tempPath, { minSeconds }))) return true;
            return ytDlpMp3(`ytsearch3:${rawQuery || searchQuery}`, tempPath, { minSeconds });
        },
    });

    attempts.push({
        name: 'jiosaavn',
        run: async () => {
            const t = await jiosaavnPick(rawQuery);
            if (!t) return false;
            const ok = await jiosaavnDownload(t, tempPath);
            if (ok) {
                try {
                    await execFileAsync(ffmpegPath, ['-y', '-i', tempPath, '-metadata', `title=${t.title}`, '-metadata', `artist=${t.artist}`, '-id3v2_version', '3', '-c', 'copy', `${tempPath}.tag.mp3`], { timeout: 30000 });
                    unlinkSync(tempPath);
                    renameSync(`${tempPath}.tag.mp3`, tempPath);
                } catch {}
            }
            return ok;
        },
    });

    attempts.push({
        name: 'soundcloud',
        run: () => ytDlpMp3(`scsearch3:${meta ? searchQuery : (rawQuery || searchQuery)}`, tempPath, { minSeconds, timeoutMs: 75000 }),
    });

    attempts.push({
        name: 'audius',
        run: async () => {
            const t = await audiusPick(searchQuery || rawQuery);
            if (!t) return false;
            const ok = await audiusDownload(t, tempPath);
            if (ok) {
                try {
                    await execFileAsync(ffmpegPath, ['-y', '-i', tempPath, '-metadata', `title=${t.title}`, '-metadata', `artist=${t.user?.name || 'Unknown'}`, '-id3v2_version', '3', '-c', 'copy', `${tempPath}.tag.mp3`], { timeout: 30000 });
                    unlinkSync(tempPath);
                    renameSync(`${tempPath}.tag.mp3`, tempPath);
                } catch {}
            }
            return ok;
        },
    });

    for (const attempt of attempts) {
        try {
            if (!(await attempt.run())) continue;
            const dur = await durationOf(tempPath, ffmpegPath);
            if (dur !== null && dur < minSeconds) {
                try { unlinkSync(tempPath); } catch {}
                continue;
            }
            return { ok: true, source: attempt.name, meta: { ...(meta ?? {}), title: meta?.title ?? rawQuery, artist: meta?.artist ?? 'Music' } };
        } catch {}
    }
    return { ok: false, source: null, meta };
}
