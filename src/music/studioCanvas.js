import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { durationText } from './model.js';

const CANVAS_W = 1280;
const CANVAS_H = 720;

function xmlEscape(str) {
  return String(str ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function wrapLines(text, maxChars = 28, maxLines = 2) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return ['Untitled Track'];
  const lines = [];
  let current = '';
  for (const w of words) {
    if (!current) {
      current = w.length > maxChars ? w.slice(0, maxChars - 1) + '…' : w;
    } else if ((current.length + 1 + w.length) <= maxChars) {
      current += ' ' + w;
    } else {
      lines.push(current);
      if (lines.length >= maxLines) break;
      current = w.length > maxChars ? w.slice(0, maxChars - 1) + '…' : w;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    const last = lines[maxLines - 1];
    if (!last.endsWith('…')) {
      lines[maxLines - 1] = last.slice(0, Math.max(1, maxChars - 1)) + '…';
    }
  }
  return lines;
}

function accentForSeed(seedStr) {
  const palettes = [
    { bg1: '#0b1021', bg2: '#1d1138', accent: '#38bdf8', glow: '#a855f7' },
    { bg1: '#120b1f', bg2: '#2e1036', accent: '#f472b6', glow: '#c084fc' },
    { bg1: '#07171f', bg2: '#0f2f3f', accent: '#2dd4bf', glow: '#38bdf8' },
    { bg1: '#181024', bg2: '#2d1b4e', accent: '#fbbf24', glow: '#f472b6' },
    { bg1: '#0b1526', bg2: '#162c49', accent: '#60a5fa', glow: '#34d399' }
  ];
  const hash = createHash('sha256').update(String(seedStr || 'lancy')).digest();
  return palettes[hash[0] % palettes.length];
}

function buildVisualDeskSvg({
  title,
  artist,
  album,
  durationSeconds,
  provider,
  isChannel = false,
  eqPreset = 'off',
  djNote = '',
  nextTitle = '',
  nextArtist = '',
  chapterTitle = '',
  crossfadeSec = 4,
  hasArt = false,
  hasNextArt = false,
  palette
}) {
  const badge = chapterTitle
    ? wrapLines(chapterTitle.toUpperCase(), 38, 1)[0]
    : (isChannel ? 'LIVE CHANNEL AI DJ DESK' : 'LANCY SPOTIFY AI DJ DESK');
  const eqTag = eqPreset && eqPreset !== 'off' ? `${String(eqPreset).toUpperCase()} EQ` : 'FLAT EQ';
  const cfTag = Number(crossfadeSec) > 0 ? `XFADE ${Number(crossfadeSec)}S` : 'CUT';
  const durationLabel = durationText(durationSeconds);
  const titleLine = wrapLines(title || 'Now Playing', 26, 2);
  const artistLine = wrapLines(artist || 'Studio Artist', 32, 1)[0];
  const noteLines = djNote ? wrapLines(djNote, 40, 2) : [];
  const nextTitleLine = wrapLines(nextTitle || 'Curating Next Cut…', 20, 2);
  const nextArtistLine = wrapLines(nextArtist || 'Related Sound', 22, 1)[0];

  const deckAMask = hasArt ? '' : `
    <circle cx="228" cy="300" r="118" fill="rgba(15,23,42,0.86)" stroke="url(#accentGrad)" stroke-width="3.5"/>
    <circle cx="228" cy="300" r="78" fill="rgba(255,255,255,0.04)" stroke="${palette.accent}" stroke-opacity="0.35" stroke-width="1.5"/>
    <circle cx="228" cy="300" r="34" fill="url(#accentGrad)" opacity="0.92"/>
    <circle cx="228" cy="300" r="10" fill="#090d16"/>
  `;

  const deckBMask = hasNextArt ? '' : `
    <circle cx="1052" cy="284" r="90" fill="rgba(15,23,42,0.82)" stroke="${palette.glow}" stroke-opacity="0.65" stroke-width="2.5"/>
    <circle cx="1052" cy="284" r="26" fill="${palette.glow}" opacity="0.72"/>
    <circle cx="1052" cy="284" r="8" fill="#090d16"/>
  `;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_W}" height="${CANVAS_H}" viewBox="0 0 ${CANVAS_W} ${CANVAS_H}">
  <defs>
    <linearGradient id="accentGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="${palette.accent}"/>
      <stop offset="100%" stop-color="${palette.glow}"/>
    </linearGradient>
    <linearGradient id="glassCard" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="rgba(15,23,42,0.78)"/>
      <stop offset="100%" stop-color="rgba(7,11,22,0.86)"/>
    </linearGradient>
  </defs>

  <!-- Outer DJ Console Frame -->
  <rect x="28" y="24" width="1224" height="672" rx="30" fill="url(#glassCard)" stroke="rgba(255,255,255,0.16)" stroke-width="2"/>

  <!-- Top Telemetry Bar -->
  <rect x="52" y="42" width="540" height="36" rx="18" fill="rgba(255,255,255,0.08)" stroke="${palette.accent}" stroke-opacity="0.45" stroke-width="1.2"/>
  <circle cx="74" cy="60" r="6" fill="#22c55e"/>
  <text x="90" y="65" font-family="DejaVu Sans, Liberation Sans, sans-serif" font-size="14" font-weight="700" fill="#f8fafc">${xmlEscape(badge)}</text>

  <rect x="612" y="42" width="196" height="36" rx="18" fill="rgba(255,255,255,0.08)"/>
  <text x="710" y="65" text-anchor="middle" font-family="DejaVu Sans, Liberation Sans, sans-serif" font-size="13" font-weight="700" fill="${palette.accent}">${xmlEscape(`${eqTag} · ${cfTag}`)}</text>

  <rect x="822" y="42" width="220" height="36" rx="18" fill="rgba(255,255,255,0.08)"/>
  <text x="932" y="65" text-anchor="middle" font-family="DejaVu Sans, Liberation Sans, sans-serif" font-size="13" font-weight="700" fill="#cbd5e1">${xmlEscape(String(provider || 'STUDIO').toUpperCase())} · 720p HD</text>

  <rect x="1056" y="42" width="172" height="36" rx="18" fill="url(#accentGrad)" opacity="0.92"/>
  <text x="1142" y="65" text-anchor="middle" font-family="DejaVu Sans, Liberation Sans, sans-serif" font-size="14" font-weight="700" fill="#090d16">LEN ${xmlEscape(durationLabel)}</text>

  <!-- Deck A Left Platter Housing -->
  <rect x="52" y="96" width="352" height="398" rx="24" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.12)" stroke-width="1.5"/>
  <text x="76" y="128" font-family="DejaVu Sans, Liberation Sans, sans-serif" font-size="14" font-weight="700" letter-spacing="1.2" fill="${palette.accent}">DECK A · ON AIR</text>
  <circle cx="228" cy="300" r="134" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="2"/>
  ${deckAMask}
  <text x="228" y="472" text-anchor="middle" font-family="DejaVu Sans, Liberation Sans, sans-serif" font-size="15" font-weight="600" fill="#cbd5e1">${xmlEscape(wrapLines(album || artist || 'Live Mix', 30, 1)[0])}</text>

  <!-- Center Mixer & Spectrum Console -->
  <rect x="420" y="96" width="440" height="398" rx="24" fill="rgba(255,255,255,0.045)" stroke="rgba(255,255,255,0.12)" stroke-width="1.5"/>
  <text x="444" y="138" font-family="DejaVu Sans, Liberation Sans, sans-serif" font-size="27" font-weight="700" fill="#ffffff">${xmlEscape(titleLine[0])}</text>
  ${titleLine[1] ? `<text x="444" y="172" font-family="DejaVu Sans, Liberation Sans, sans-serif" font-size="25" font-weight="700" fill="#e2e8f0">${xmlEscape(titleLine[1])}</text>` : ''}
  <text x="444" y="${titleLine[1] ? 206 : 178}" font-family="DejaVu Sans, Liberation Sans, sans-serif" font-size="21" font-weight="600" fill="${palette.accent}">${xmlEscape(artistLine)}</text>

  ${noteLines.length ? `
    <rect x="442" y="222" width="396" height="58" rx="14" fill="rgba(15,23,42,0.65)" stroke="${palette.accent}" stroke-opacity="0.4" stroke-width="1.2"/>
    <text x="456" y="246" font-family="DejaVu Sans, Liberation Sans, sans-serif" font-size="14" font-weight="600" fill="#e2e8f0">🎙 ${xmlEscape(noteLines[0])}</text>
    ${noteLines[1] ? `<text x="456" y="266" font-family="DejaVu Sans, Liberation Sans, sans-serif" font-size="14" fill="#cbd5e1">${xmlEscape(noteLines[1])}</text>` : ''}
  ` : ''}

  <!-- Spectrum / VU Bay (y=292..424) + Progress & Crossfader Bay (y=432..482) animated live by dj_desk.py -->
  <rect x="442" y="292" width="396" height="132" rx="14" fill="rgba(6,10,20,0.65)" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
  <rect x="442" y="438" width="396" height="10" rx="5" fill="rgba(255,255,255,0.12)"/>
  <text x="442" y="476" font-family="DejaVu Sans, Liberation Sans, sans-serif" font-size="12" font-weight="700" fill="#94a3b8">A</text>
  <rect x="520" y="464" width="240" height="12" rx="6" fill="rgba(255,255,255,0.10)"/>
  <text x="838" y="476" text-anchor="end" font-family="DejaVu Sans, Liberation Sans, sans-serif" font-size="12" font-weight="700" fill="#94a3b8">B</text>

  <!-- Deck B Right Cue Bay -->
  <rect x="876" y="96" width="352" height="398" rx="24" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.12)" stroke-width="1.5"/>
  <text x="900" y="128" font-family="DejaVu Sans, Liberation Sans, sans-serif" font-size="14" font-weight="700" letter-spacing="1.2" fill="${palette.glow}">DECK B · UP NEXT</text>
  <circle cx="1052" cy="284" r="102" fill="none" stroke="rgba(255,255,255,0.10)" stroke-width="1.8"/>
  ${deckBMask}
  <text x="1052" y="424" text-anchor="middle" font-family="DejaVu Sans, Liberation Sans, sans-serif" font-size="18" font-weight="700" fill="#f1f5f9">${xmlEscape(nextTitleLine[0])}</text>
  ${nextTitleLine[1] ? `<text x="1052" y="446" text-anchor="middle" font-family="DejaVu Sans, Liberation Sans, sans-serif" font-size="16" font-weight="600" fill="#cbd5e1">${xmlEscape(nextTitleLine[1])}</text>` : ''}
  <text x="1052" y="${nextTitleLine[1] ? 474 : 454}" text-anchor="middle" font-family="DejaVu Sans, Liberation Sans, sans-serif" font-size="15" font-weight="600" fill="${palette.glow}">${xmlEscape(nextArtistLine)}</text>

  <!-- Bottom Live Karaoke Lyrics Theater -->
  <rect x="52" y="510" width="1176" height="168" rx="22" fill="rgba(6,10,20,0.72)" stroke="${palette.accent}" stroke-opacity="0.32" stroke-width="1.5"/>
  <text x="76" y="538" font-family="DejaVu Sans, Liberation Sans, sans-serif" font-size="12" font-weight="700" letter-spacing="1.4" fill="#94a3b8">LIVE SYNCED LYRICS</text>
</svg>`;
}

function buildOverlaySvg({
  title,
  artist,
  album,
  durationSeconds,
  provider,
  isChannel = false,
  eqPreset = 'off',
  djNote = '',
  hasArt = false,
  palette
}) {
  const badge = isChannel ? 'LANCY · CHANNEL LIVE BROADCAST' : 'LANCY · STUDIO HD AUDIO';
  const eqTag = eqPreset && eqPreset !== 'off' ? `EQ: ${String(eqPreset).toUpperCase()}` : 'STUDIO HD';
  const durationLabel = durationText(durationSeconds);
  const titleLines = wrapLines(title || 'Now Playing', 24, 2);
  const artistLine = wrapLines(artist || 'Studio Artist', 34, 1)[0];
  const albumLine = album ? wrapLines(album, 38, 1)[0] : '';
  const djLines = djNote ? wrapLines(djNote, 42, 2) : [];

  const barHeights = [26, 48, 34, 62, 40, 74, 52, 66, 36, 58, 44, 70, 32, 54, 42, 60, 28, 46];
  const barsSvg = barHeights.map((h, i) => {
    const x = 560 + i * 32;
    const y = 636 - h;
    return `<rect x="${x}" y="${y}" width="16" height="${h}" rx="8" fill="url(#accentGrad)" opacity="${(0.55 + (i % 3) * 0.15).toFixed(2)}"/>`;
  }).join('');

  const artPlaceholder = hasArt ? '' : `
    <rect x="88" y="160" width="400" height="400" rx="34" fill="rgba(255,255,255,0.06)" stroke="url(#accentGrad)" stroke-width="3"/>
    <circle cx="288" cy="360" r="118" fill="rgba(255,255,255,0.05)" stroke="${palette.accent}" stroke-opacity="0.55" stroke-width="3"/>
    <circle cx="288" cy="360" r="46" fill="url(#accentGrad)" opacity="0.88"/>
    <circle cx="288" cy="360" r="14" fill="${palette.bg1}"/>
  `;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_W}" height="${CANVAS_H}" viewBox="0 0 ${CANVAS_W} ${CANVAS_H}">
  <defs>
    <linearGradient id="accentGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="${palette.accent}"/>
      <stop offset="100%" stop-color="${palette.glow}"/>
    </linearGradient>
    <linearGradient id="glassCard" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="rgba(255,255,255,0.09)"/>
      <stop offset="100%" stop-color="rgba(255,255,255,0.02)"/>
    </linearGradient>
  </defs>

  <rect x="44" y="44" width="1192" height="632" rx="36" fill="url(#glassCard)" stroke="rgba(255,255,255,0.14)" stroke-width="2"/>
  ${artPlaceholder}

  <!-- Top Pills -->
  <rect x="560" y="96" width="380" height="40" rx="20" fill="rgba(255,255,255,0.10)" stroke="rgba(255,255,255,0.18)" stroke-width="1.5"/>
  <circle cx="586" cy="116" r="7" fill="${palette.accent}"/>
  <text x="606" y="122" font-family="DejaVu Sans, Liberation Sans, sans-serif" font-size="16" font-weight="700" letter-spacing="1.2" fill="#e2e8f0">${xmlEscape(badge)}</text>

  <rect x="960" y="96" width="144" height="40" rx="20" fill="url(#accentGrad)" opacity="0.92"/>
  <text x="1032" y="122" text-anchor="middle" font-family="DejaVu Sans, Liberation Sans, sans-serif" font-size="15" font-weight="700" fill="#090d16">720p HD</text>

  <rect x="1116" y="96" width="90" height="40" rx="20" fill="rgba(255,255,255,0.12)"/>
  <text x="1161" y="122" text-anchor="middle" font-family="DejaVu Sans, Liberation Sans, sans-serif" font-size="14" font-weight="700" fill="#f8fafc">${xmlEscape(durationLabel)}</text>

  <!-- Track Title & Artist -->
  <text x="560" y="218" font-family="DejaVu Sans, Liberation Sans, sans-serif" font-size="44" font-weight="700" fill="#ffffff">${xmlEscape(titleLines[0])}</text>
  ${titleLines[1] ? `<text x="560" y="274" font-family="DejaVu Sans, Liberation Sans, sans-serif" font-size="44" font-weight="700" fill="#f1f5f9">${xmlEscape(titleLines[1])}</text>` : ''}

  <text x="560" y="${titleLines[1] ? 332 : 284}" font-family="DejaVu Sans, Liberation Sans, sans-serif" font-size="28" font-weight="600" fill="${palette.accent}">${xmlEscape(artistLine)}</text>
  ${albumLine ? `<text x="560" y="${titleLines[1] ? 372 : 326}" font-family="DejaVu Sans, Liberation Sans, sans-serif" font-size="21" fill="#cbd5e1">${xmlEscape(albumLine)}</text>` : ''}

  <!-- Metadata Strip -->
  <rect x="560" y="408" width="628" height="2" fill="rgba(255,255,255,0.12)"/>
  <text x="560" y="446" font-family="DejaVu Sans, Liberation Sans, sans-serif" font-size="18" font-weight="600" fill="#94a3b8">${xmlEscape(`${String(provider || 'STUDIO').toUpperCase()}  •  ${eqTag}`)}</text>

  <!-- AI DJ / Broadcast Note -->
  ${djLines.length ? `
    <rect x="560" y="468" width="628" height="${djLines.length > 1 ? 84 : 56}" rx="18" fill="rgba(15,23,42,0.55)" stroke="${palette.accent}" stroke-opacity="0.45" stroke-width="1.5"/>
    <text x="582" y="501" font-family="DejaVu Sans, Liberation Sans, sans-serif" font-size="19" font-weight="600" fill="#e2e8f0">AI DJ: ${xmlEscape(djLines[0])}</text>
    ${djLines[1] ? `<text x="582" y="531" font-family="DejaVu Sans, Liberation Sans, sans-serif" font-size="19" fill="#cbd5e1">${xmlEscape(djLines[1])}</text>` : ''}
  ` : ''}

  <!-- Crisp Spectrum Visualizer -->
  ${barsSvg}
</svg>`;
}

/**
 * Generates and caches crisp 1280x720 Studio Now-Playing HD frames for audio streams in video calls.
 */
export class StudioCanvas {
  constructor({ cacheDir } = {}) {
    this.cacheDir = cacheDir || null;
  }

  async renderFrame({
    title,
    artist,
    album = '',
    durationSeconds = 0,
    provider = 'music',
    artworkPath = null,
    artworkBuffer = null,
    isChannel = false,
    eqPreset = 'off',
    djNote = '',
    visualDesk = false,
    nextTitle = '',
    nextArtist = '',
    chapterTitle = '',
    crossfadeSec = 4
  } = {}) {
    const palette = accentForSeed(`${title}|${artist}|${provider}`);
    let artSource = artworkBuffer || null;
    if (!artSource && artworkPath && existsSync(artworkPath)) {
      artSource = await readFile(artworkPath).catch(() => null);
    }

    const artHash = artSource
      ? createHash('sha1').update(artSource).digest('hex').slice(0, 12)
      : 'noart';

    const cacheKey = createHash('sha256')
      .update([
        visualDesk ? 'desk2' : 'std',
        title || '',
        artist || '',
        album || '',
        String(Math.round(Number(durationSeconds) || 0)),
        provider || '',
        isChannel ? '1' : '0',
        eqPreset || 'off',
        djNote || '',
        nextTitle || '',
        nextArtist || '',
        chapterTitle || '',
        String(crossfadeSec || 0),
        artHash
      ].join('|'))
      .digest('hex')
      .slice(0, 24);

    if (this.cacheDir) {
      await mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
      const cachedPath = join(this.cacheDir, `canvas-${cacheKey}.png`);
      if (existsSync(cachedPath)) {
        const st = await stat(cachedPath).catch(() => null);
        if (st && st.size > 2048) {
          return cachedPath;
        }
      }
    }

    // Build 1280x720 base ambient backdrop
    let backdrop;
    let sharpArt = null;
    let nextArt = null;
    if (artSource) {
      try {
        backdrop = await sharp(artSource, { limitInputPixels: 16000000 })
          .rotate()
          .resize(CANVAS_W, CANVAS_H, { fit: 'cover', position: 'center' })
          .blur(26)
          .modulate({ brightness: visualDesk ? 0.34 : 0.42, saturation: 1.2 })
          .png()
          .toBuffer();

        if (visualDesk) {
          const discMask = Buffer.from(
            `<svg width="236" height="236"><circle cx="118" cy="118" r="116" fill="#fff"/></svg>`
          );
          sharpArt = await sharp(artSource, { limitInputPixels: 16000000 })
            .rotate()
            .resize(236, 236, { fit: 'cover', position: 'center' })
            .composite([{ input: discMask, blend: 'dest-in' }])
            .png()
            .toBuffer();
        } else {
          const roundedMask = Buffer.from(
            `<svg width="400" height="400"><rect x="0" y="0" width="400" height="400" rx="34" ry="34" fill="#fff"/></svg>`
          );
          sharpArt = await sharp(artSource, { limitInputPixels: 16000000 })
            .rotate()
            .resize(400, 400, { fit: 'cover', position: 'center' })
            .composite([{ input: roundedMask, blend: 'dest-in' }])
            .png()
            .toBuffer();
        }
      } catch {
        backdrop = null;
        sharpArt = null;
      }
    }

    if (!backdrop) {
      const bgSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_W}" height="${CANVAS_H}">
        <defs>
          <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="${palette.bg1}"/>
            <stop offset="100%" stop-color="${palette.bg2}"/>
          </linearGradient>
          <radialGradient id="g1" cx="25%" cy="30%" r="55%">
            <stop offset="0%" stop-color="${palette.glow}" stop-opacity="0.32"/>
            <stop offset="100%" stop-color="${palette.bg1}" stop-opacity="0"/>
          </radialGradient>
          <radialGradient id="g2" cx="80%" cy="75%" r="50%">
            <stop offset="0%" stop-color="${palette.accent}" stop-opacity="0.24"/>
            <stop offset="100%" stop-color="${palette.bg2}" stop-opacity="0"/>
          </radialGradient>
        </defs>
        <rect width="${CANVAS_W}" height="${CANVAS_H}" fill="url(#bg)"/>
        <rect width="${CANVAS_W}" height="${CANVAS_H}" fill="url(#g1)"/>
        <rect width="${CANVAS_W}" height="${CANVAS_H}" fill="url(#g2)"/>
      </svg>`;
      backdrop = await sharp(Buffer.from(bgSvg)).png().toBuffer();
    }

    const overlaySvg = visualDesk
      ? buildVisualDeskSvg({
          title,
          artist,
          album,
          durationSeconds,
          provider,
          isChannel,
          eqPreset,
          djNote,
          nextTitle,
          nextArtist,
          chapterTitle,
          crossfadeSec,
          hasArt: Boolean(sharpArt),
          hasNextArt: Boolean(nextArt),
          palette
        })
      : buildOverlaySvg({
          title,
          artist,
          album,
          durationSeconds,
          provider,
          isChannel,
          eqPreset,
          djNote,
          hasArt: Boolean(sharpArt),
          palette
        });

    const composites = [];
    if (sharpArt) {
      composites.push(
        visualDesk
          ? { input: sharpArt, top: 182, left: 110 }
          : { input: sharpArt, top: 160, left: 88 }
      );
    }
    composites.push({ input: Buffer.from(overlaySvg), top: 0, left: 0 });

    const outBuffer = await sharp(backdrop)
      .composite(composites)
      .png({ compressionLevel: 6 })
      .toBuffer();

    if (this.cacheDir) {
      const cachedPath = join(this.cacheDir, `canvas-${cacheKey}.png`);
      await writeFile(cachedPath, outBuffer, { mode: 0o600 });
      return cachedPath;
    }
    return outBuffer;
  }
}

/**
 * Extracts embedded album artwork (ID3/MP4 cover stream) from a local audio file when present.
 */
export async function extractEmbeddedArtwork(runner, ffmpeg, inputPath, outArtPath) {
  try {
    await runner(ffmpeg, [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-i', inputPath, '-map', '0:v:0', '-frames:v', '1', '-f', 'image2', outArtPath
    ], { timeout: 10000, maxBuffer: 512 * 1024 });
    if (existsSync(outArtPath)) {
      const st = await stat(outArtPath).catch(() => null);
      if (st && st.size > 512) return outArtPath;
    }
  } catch {
    // Embedded cover art is optional.
  }
  return null;
}
