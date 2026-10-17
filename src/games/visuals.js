import sharp from 'sharp';

/**
 * Resilient live image fetcher with browser User-Agent & timeout.
 */
export async function fetchImageBuffer(url, timeoutMs = 4500) {
  if (!url) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
      }
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const raw = Buffer.from(await res.arrayBuffer());
    if (!raw || raw.length < 100) return null;
    const head = raw.subarray(0, 160).toString('utf8');
    const isSvg = head.includes('<svg') || String(url).includes('simpleicons.org');
    if (isSvg) {
      return await sharp(raw, { failOn: 'none', density: 600 })
        .resize(340, 340, { fit: 'inside', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();
    }
    // Normalize to PNG buffer via sharp so downstream compositing never fails on SVG/WebP/AVIF
    return await sharp(raw, { failOn: 'none' }).png().toBuffer();
  } catch {
    return null;
  }
}

/**
 * Turns an image buffer into a glowing dark-purple mystery silhouette.
 * Works on both transparent cutouts and solid-background portraits (via edge/luma contrast).
 */
export async function createSilhouette(imageBuffer) {
  try {
    const { data, info } = await sharp(imageBuffer)
      .resize(520, 420, { fit: 'inside' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Check if image actually has transparent pixels
    let transparentPixels = 0;
    const totalPixels = info.width * info.height;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) transparentPixels++;
    }

    const hasAlphaCutout = transparentPixels > totalPixels * 0.08;

    if (hasAlphaCutout) {
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] > 40) {
          data[i] = 24;     // Deep cyber-violet silhouette
          data[i + 1] = 14;
          data[i + 2] = 38;
          data[i + 3] = 255;
        }
      }
    } else {
      // For non-transparent portraits (like MAL/AniList character JPEGs),
      // apply high-contrast duotone shadow mask so features are mysterious but recognizable
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const luma = 0.299 * r + 0.587 * g + 0.114 * b;
        if (luma < 145) {
          data[i] = 18;
          data[i + 1] = 11;
          data[i + 2] = 30;
        } else {
          data[i] = 235;
          data[i + 1] = 120;
          data[i + 2] = 190;
        }
      }
    }

    return await sharp(data, {
      raw: { width: info.width, height: info.height, channels: 4 }
    }).png().toBuffer();
  } catch {
    return imageBuffer;
  }
}

/**
 * Pure Vector Studio Backdrop (900x560) — ZERO <text> tags, ZERO font/ASCII dependencies!
 * All typography lives natively inside Telegram Bot API 10.3 Rich Message blocks.
 */
function buildStudioBackdropSvg(width = 900, height = 560, accent = 'pink') {
  const c1 = accent === 'cyan' ? '#7afcff' : accent === 'gold' ? '#ffe066' : '#ff7eb3';
  const c2 = accent === 'cyan' ? '#be93fd' : accent === 'gold' ? '#ff7eb3' : '#be93fd';
  const c3 = accent === 'cyan' ? '#ff7eb3' : accent === 'gold' ? '#7afcff' : '#7afcff';

  return `
  <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#100b18"/>
        <stop offset="50%" stop-color="#1d142d"/>
        <stop offset="100%" stop-color="#0c0813"/>
      </linearGradient>
      <linearGradient id="neonBorder" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="${c1}"/>
        <stop offset="50%" stop-color="${c2}"/>
        <stop offset="100%" stop-color="${c3}"/>
      </linearGradient>
      <radialGradient id="centerGlow" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="${c1}" stop-opacity="0.18"/>
        <stop offset="60%" stop-color="${c2}" stop-opacity="0.06"/>
        <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="innerStage" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stop-color="#1b1329"/>
        <stop offset="100%" stop-color="#120c1c"/>
      </linearGradient>
    </defs>

    <!-- Main Dark Velvet Background -->
    <rect width="${width}" height="${height}" fill="url(#bg)"/>
    <circle cx="${width / 2}" cy="${height / 2}" r="${Math.min(width, height) * 0.48}" fill="url(#centerGlow)"/>

    <!-- Decorative Corner Sparkles (Pure Vector Paths - Zero Fonts) -->
    <path d="M 65 45 L 70 58 L 83 63 L 70 68 L 65 81 L 60 68 L 47 63 L 60 58 Z" fill="${c1}" opacity="0.65"/>
    <path d="M ${width - 65} 45 L ${width - 60} 58 L ${width - 47} 63 L ${width - 60} 68 L ${width - 65} 81 L ${width - 70} 68 L ${width - 83} 63 L ${width - 70} 58 Z" fill="${c3}" opacity="0.65"/>
    <path d="M 65 ${height - 81} L 70 ${height - 68} L 83 ${height - 63} L 70 ${height - 58} L 65 ${height - 45} L 60 ${height - 58} L 47 ${height - 63} L 60 ${height - 68} Z" fill="${c3}" opacity="0.5"/>
    <path d="M ${width - 65} ${height - 81} L ${width - 60} ${height - 68} L ${width - 47} ${height - 63} L ${width - 60} ${height - 58} L ${width - 65} ${height - 45} L ${width - 70} ${height - 58} L ${width - 83} ${height - 63} L ${width - 70} ${height - 68} Z" fill="${c1}" opacity="0.5"/>

    <!-- Outer Neon Frame -->
    <rect x="20" y="20" width="${width - 40}" height="${height - 40}" rx="28" fill="none" stroke="url(#neonBorder)" stroke-width="2.5" opacity="0.8"/>

    <!-- Inner Showcase Stage -->
    <rect x="90" y="45" width="${width - 180}" height="${height - 90}" rx="22" fill="url(#innerStage)" stroke="#392852" stroke-width="2"/>
  </svg>`;
}

/**
 * Frames any live image (Flag, Anime Character, Car/Brand Logo, Artwork) onto
 * Lancy's zero-text dark-neon studio canvas.
 */
export async function renderFramedMedia(imageBuffer, {
  isSilhouette = false,
  accent = 'pink',
  padding = 30
} = {}) {
  const width = 900;
  const height = 560;
  const stageW = width - 180 - padding * 2;
  const stageH = height - 90 - padding * 2;

  const baseBuffer = await sharp(Buffer.from(buildStudioBackdropSvg(width, height, accent))).png().toBuffer();
  if (!imageBuffer) return baseBuffer;

  try {
    let source = imageBuffer;
    if (isSilhouette) {
      source = await createSilhouette(imageBuffer);
    }

    const fitted = await sharp(source, { failOn: 'none' })
      .resize(stageW, stageH, { fit: 'inside', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();

    const meta = await sharp(fitted).metadata();
    const mw = meta.width || stageW;
    const mh = meta.height || stageH;

    // Add rounded corners to rectangular photos
    const roundedMask = Buffer.from(
      `<svg width="${mw}" height="${mh}"><rect x="0" y="0" width="${mw}" height="${mh}" rx="16" ry="16" fill="#fff"/></svg>`
    );
    const roundedMedia = await sharp(fitted)
      .composite([{ input: roundedMask, blend: 'dest-in' }])
      .png()
      .toBuffer();

    const left = Math.round((width - mw) / 2);
    const top = Math.round((height - mh) / 2);

    return await sharp(baseBuffer)
      .composite([{ input: roundedMedia, left, top }])
      .jpeg({ quality: 90 })
      .toBuffer();
  } catch {
    return baseBuffer;
  }
}

/**
 * Renders a 3x3 Grid Quiz image where unrevealed tiles (0..8) are masked by
 * sleek geometric neon tiles (zero text/font dependency!).
 */
export async function renderGridMask(imageBuffer, revealedTiles = [4]) {
  const width = 900;
  const height = 560;
  const gridW = 690;
  const gridH = 450;
  const startX = Math.round((width - gridW) / 2);
  const startY = Math.round((height - gridH) / 2);
  const cellW = Math.floor(gridW / 3);
  const cellH = Math.floor(gridH / 3);

  const baseBuffer = await sharp(Buffer.from(buildStudioBackdropSvg(width, height, 'cyan'))).png().toBuffer();
  if (!imageBuffer) return baseBuffer;

  try {
    const fittedPhoto = await sharp(imageBuffer, { failOn: 'none' })
      .resize(gridW, gridH, { fit: 'cover', position: 'attention' })
      .png()
      .toBuffer();

    const revealedSet = new Set((revealedTiles || []).map(Number));

    // Build SVG overlay for the 3x3 grid lines + hidden tile covers
    let tilesSvg = '';
    for (let idx = 0; idx < 9; idx++) {
      const row = Math.floor(idx / 3);
      const col = idx % 3;
      const x = col * cellW;
      const y = row * cellH;
      const cx = x + cellW / 2;
      const cy = y + cellH / 2;

      if (!revealedSet.has(idx)) {
        // Draw dots representing tile number (idx + 1) in pure vector circles so no font is needed!
        const count = idx + 1;
        const dots = [];
        const dotSpacing = 14;
        const startDotX = cx - ((count - 1) * dotSpacing) / 2;
        for (let d = 0; d < count; d++) {
          dots.push(`<circle cx="${startDotX + d * dotSpacing}" cy="${cy + 26}" r="4" fill="#7afcff" opacity="0.85"/>`);
        }

        tilesSvg += `
          <g>
            <rect x="${x + 3}" y="${y + 3}" width="${cellW - 6}" height="${cellH - 6}" rx="12" fill="#181126" stroke="#ff7eb3" stroke-width="2"/>
            <path d="M ${cx} ${cy - 22} L ${cx + 6} ${cy - 8} L ${cx + 20} ${cy - 2} L ${cx + 6} ${cy + 4} L ${cx} ${cy + 18} L ${cx - 6} ${cy + 4} L ${cx - 20} ${cy - 2} L ${cx - 6} ${cy - 8} Z" fill="#be93fd" opacity="0.75"/>
            ${dots.join('')}
          </g>
        `;
      } else {
        // Subtle border around revealed tile
        tilesSvg += `<rect x="${x + 2}" y="${y + 2}" width="${cellW - 4}" height="${cellH - 4}" rx="10" fill="none" stroke="#7afcff" stroke-width="1.5" opacity="0.45"/>`;
      }
    }

    const maskOverlay = await sharp(
      Buffer.from(`<svg width="${gridW}" height="${gridH}" xmlns="http://www.w3.org/2000/svg">${tilesSvg}</svg>`)
    ).png().toBuffer();

    const combinedGrid = await sharp(fittedPhoto)
      .composite([{ input: maskOverlay, left: 0, top: 0 }])
      .png()
      .toBuffer();

    return await sharp(baseBuffer)
      .composite([{ input: combinedGrid, left: startX, top: startY }])
      .jpeg({ quality: 90 })
      .toBuffer();
  } catch {
    return baseBuffer;
  }
}

/**
 * Renders a Picture Guessing mystery image with progressive pixelation / zoom stages:
 * stage 0 = heavy pixelation (initial)
 * stage 1 = medium pixelation (hint 1)
 * stage 2 = light pixelation (hint 2)
 * stage 3 = crystal clear HD (revealed)
 */
export async function renderMysteryBlur(imageBuffer, stage = 0) {
  if (!imageBuffer) return renderFramedMedia(null);
  try {
    if (stage >= 3) {
      return await renderFramedMedia(imageBuffer, { accent: 'gold' });
    }

    const pixelGridSize = stage === 0 ? 22 : stage === 1 ? 46 : 88;
    const tiny = await sharp(imageBuffer, { failOn: 'none' })
      .resize(pixelGridSize, pixelGridSize, { fit: 'inside' })
      .png()
      .toBuffer();

    const pixelated = await sharp(tiny)
      .resize(680, 440, { fit: 'inside', kernel: sharp.kernel.nearest })
      .png()
      .toBuffer();

    return await renderFramedMedia(pixelated, { accent: stage === 0 ? 'pink' : 'cyan' });
  } catch {
    return await renderFramedMedia(imageBuffer);
  }
}

/**
 * Pure Geometric SVG <path> Atlas for A–Z (Normalized 24x28 box).
 * Zero <text> tags — 100% immune to missing Linux fonts or broken glyph boxes!
 */
export const VECTOR_LETTER_PATHS = {
  A: 'M 4 24 L 12 4 L 20 24 M 6.8 17.5 L 17.2 17.5',
  B: 'M 5.5 4 L 5.5 24 M 5.5 4 L 13.8 4 C 17.5 4 19.5 6 19.5 8.8 C 19.5 11.5 17.5 13.5 13.8 13.5 L 5.5 13.5 M 5.5 13.5 L 14.2 13.5 C 18 13.5 20 15.6 20 18.8 C 20 22 17.8 24 14.2 24 L 5.5 24',
  C: 'M 19.5 7.5 C 17.8 5 15.2 4 12.2 4 C 7.2 4 4.5 8 4.5 14 C 4.5 20 7.2 24 12.2 24 C 15.2 24 17.8 23 19.5 20.5',
  D: 'M 5 4 L 12.2 4 C 17.5 4 20 8 20 14 C 20 20 17.5 24 12.2 24 L 5 24 Z',
  E: 'M 19 4 L 5.5 4 L 5.5 24 L 19 24 M 5.5 14 L 16.5 14',
  F: 'M 19 4 L 5.5 4 L 5.5 24 M 5.5 14 L 16.5 14',
  G: 'M 19.5 7.5 C 17.8 5 15.2 4 12.2 4 C 7.2 4 4.5 8 4.5 14 C 4.5 20 7.2 24 12.5 24 C 16.8 24 19.5 21.5 19.5 17.8 L 19.5 14.5 L 13 14.5',
  H: 'M 5 4 L 5 24 M 19 4 L 19 24 M 5 14 L 19 14',
  I: 'M 8 4 L 16 4 M 12 4 L 12 24 M 8 24 L 16 24',
  J: 'M 16.5 4 L 16.5 18.5 C 16.5 22 14 24 10.5 24 C 7.5 24 5.5 22 5 19',
  K: 'M 5.5 4 L 5.5 24 M 19 4 L 6.5 15 M 10 12 L 19.5 24',
  L: 'M 6 4 L 6 24 L 19 24',
  M: 'M 4 24 L 4 4 L 12 16.2 L 20 4 L 20 24',
  N: 'M 5 24 L 5 4 L 19 24 L 19 4',
  O: 'M 12 4 C 17 4 20 8 20 14 C 20 20 17 24 12 24 C 7 24 4 20 4 14 C 4 8 7 4 12 4 Z',
  P: 'M 5.5 24 L 5.5 4 L 14 4 C 17.8 4 20 6.5 20 9.8 C 20 13.2 17.8 15.5 14 15.5 L 5.5 15.5',
  Q: 'M 12 4 C 17 4 20 8 20 14 C 20 20 17 24 12 24 C 7 24 4 20 4 14 C 4 8 7 4 12 4 Z M 14.5 17.5 L 20.5 24.5',
  R: 'M 5.5 24 L 5.5 4 L 14 4 C 17.8 4 20 6.3 20 9.5 C 20 12.8 17.8 15 14 15 L 5.5 15 M 13 15 L 19.5 24',
  S: 'M 19 7.2 C 17.5 4.8 15 4 12 4 C 7.8 4 5 6 5 9 C 5 12.2 8.2 13.2 12.5 14.2 C 16.8 15.2 19.5 16.5 19.5 19.8 C 19.5 22.5 16.5 24 12 24 C 8.2 24 5.5 22.8 4.5 20.2',
  T: 'M 4 4 L 20 4 M 12 4 L 12 24',
  U: 'M 5 4 L 5 17 C 5 21.5 7.8 24 12 24 C 16.2 24 19 21.5 19 17 L 19 4',
  V: 'M 4.5 4 L 12 24 L 19.5 4',
  W: 'M 3.5 4 L 7.8 24 L 12 11 L 16.2 24 L 20.5 4',
  X: 'M 4.5 4 L 19.5 24 M 19.5 4 L 4.5 24',
  Y: 'M 4.5 4 L 12 14.5 L 19.5 4 M 12 14.5 L 12 24',
  Z: 'M 4.5 4 L 19.5 4 L 4.5 24 L 19.5 24'
};

const STRIKE_PALETTE = [
  '#00f5d4',
  '#ff7eb3',
  '#fee440',
  '#7afcff',
  '#be93fd',
  '#00bbf9',
  '#f15bb5',
  '#38b000',
  '#ff9f1c',
  '#ff595e'
];

/**
 * Renders the 8x8 (or NxN) Lancy Word Grid image using 100% pure vector letter paths
 * plus glowing neon strike-through capsules for every found word!
 */
export async function renderWordGrid({ grid = [], foundWords = [] } = {}) {
  const rows = grid.length || 8;
  const cols = (grid[0] && grid[0].length) || 8;
  const canvasSize = 840;
  const pad = 44;
  const boardSize = canvasSize - pad * 2;
  const cellSize = boardSize / cols;

  let gridCellsSvg = '';
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = pad + c * cellSize;
      const y = pad + r * cellSize;
      gridCellsSvg += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${cellSize.toFixed(1)}" height="${cellSize.toFixed(1)}" fill="none" stroke="#1e3148" stroke-width="2.2"/>`;
    }
  }

  // Highlight strike-through capsules for found words
  let strikesSvg = '';
  foundWords.forEach((fw, idx) => {
    const color = fw.color || STRIKE_PALETTE[idx % STRIKE_PALETTE.length];
    const x1 = pad + (fw.c0 + 0.5) * cellSize;
    const y1 = pad + (fw.r0 + 0.5) * cellSize;
    const x2 = pad + (fw.c1 + 0.5) * cellSize;
    const y2 = pad + (fw.r1 + 0.5) * cellSize;
    strikesSvg += `
      <line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"
            stroke="${color}" stroke-width="${(cellSize * 0.62).toFixed(1)}" stroke-linecap="round" opacity="0.28"/>
      <line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"
            stroke="${color}" stroke-width="4" stroke-linecap="round" opacity="0.75"/>
    `;
  });

  // Render every letter A-Z using pure vector paths
  let lettersSvg = '';
  const scale = (cellSize * 0.44) / 28;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const ch = String(grid[r]?.[c] || 'A').toUpperCase();
      const d = VECTOR_LETTER_PATHS[ch] || VECTOR_LETTER_PATHS.O;
      const cx = pad + (c + 0.5) * cellSize;
      const cy = pad + (r + 0.5) * cellSize;
      const tx = cx - 12 * scale;
      const ty = cy - 14 * scale;

      lettersSvg += `
        <g transform="translate(${tx.toFixed(2)}, ${ty.toFixed(2)}) scale(${scale.toFixed(3)})">
          <path d="${d}" fill="none" stroke="#f1f5f9" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>
        </g>
      `;
    }
  }

  const svg = `
  <svg width="${canvasSize}" height="${canvasSize}" viewBox="0 0 ${canvasSize} ${canvasSize}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="wgBg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#0b131e"/>
        <stop offset="50%" stop-color="#101b2b"/>
        <stop offset="100%" stop-color="#091019"/>
      </linearGradient>
      <linearGradient id="wgBorder" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#2c4464"/>
        <stop offset="50%" stop-color="#3b5980"/>
        <stop offset="100%" stop-color="#253b56"/>
      </linearGradient>
    </defs>

    <!-- Outer Dark Slate Card -->
    <rect width="${canvasSize}" height="${canvasSize}" rx="22" fill="url(#wgBg)"/>
    <rect x="14" y="14" width="${canvasSize - 28}" height="${canvasSize - 28}" rx="18" fill="none" stroke="#18273a" stroke-width="2"/>

    <!-- Grid Cells -->
    ${gridCellsSvg}

    <!-- Outer Grid Frame -->
    <rect x="${pad}" y="${pad}" width="${boardSize}" height="${boardSize}" rx="6" fill="none" stroke="url(#wgBorder)" stroke-width="3.5"/>

    <!-- Found Word Neon Strike-Through Capsules -->
    ${strikesSvg}

    <!-- Crisp Pure-Vector Letters -->
    ${lettersSvg}
  </svg>`;

  return await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
}

/**
 * Renders a 100% text-free Car or Global Brand Symbol onto Lancy's dark-neon studio stage.
 * Supports either pure inline SVG path symbols OR cropping out wordmarks from PNGs.
 */
export async function renderBrandSymbolCard(item = {}) {
  const width = 900;
  const height = 560;

  if (item.svgPath) {
    const vb = item.viewBox || '0 0 24 24';
    const fill = item.color || '#f8fafc';
    const symbolSvg = `
      <svg width="320" height="320" viewBox="${vb}" xmlns="http://www.w3.org/2000/svg">
        <path d="${item.svgPath}" fill="${fill}"/>
      </svg>
    `;
    const symbolBuf = await sharp(Buffer.from(symbolSvg)).png().toBuffer();
    return await renderFramedMedia(symbolBuf, { accent: 'cyan', padding: 55 });
  }

  if (item.imageUrl) {
    const rawBuf = await fetchImageBuffer(item.imageUrl);
    if (!rawBuf) return await renderFramedMedia(null, { accent: 'cyan' });

    let processed = rawBuf;
    if (item.cropBox) {
      try {
        const meta = await sharp(rawBuf).metadata();
        if (meta.width && meta.height) {
          const left = Math.round((item.cropBox.left || 0) * meta.width);
          const top = Math.round((item.cropBox.top || 0) * meta.height);
          const w = Math.round(((item.cropBox.right ?? 1) - (item.cropBox.left || 0)) * meta.width);
          const h = Math.round(((item.cropBox.bottom ?? 1) - (item.cropBox.top || 0)) * meta.height);
          if (w > 20 && h > 20) {
            processed = await sharp(rawBuf).extract({ left, top, width: w, height: h }).png().toBuffer();
          }
        }
      } catch {}
    }
    return await renderFramedMedia(processed, { accent: 'cyan', padding: 45 });
  }

  return await renderFramedMedia(null, { accent: 'cyan', width, height });
}

const POKEMON_TYPE_COLORS = {
  Fire: ['#ff595e', '#ff9f1c'],
  Water: ['#00bbf9', '#00f5d4'],
  Electric: ['#fee440', '#ff9f1c'],
  Grass: ['#00f5d4', '#38b000'],
  Psychic: ['#ff7eb3', '#f15bb5'],
  Ghost: ['#9b5de5', '#7b2cbf'],
  Dark: ['#7b2cbf', '#3a0ca3'],
  Dragon: ['#4361ee', '#f72585'],
  Ice: ['#7afcff', '#00bbf9'],
  Fairy: ['#ff7eb3', '#fbcfe8'],
  Fighting: ['#ef476f', '#ff9f1c'],
  Steel: ['#94a3b8', '#cbd5e1'],
  Normal: ['#cbd5e1', '#7afcff']
};

/**
 * Renders the custom Pokéball Studio Arena card for "Who's That Pokémon?!" & Shiny Reveals.
 */
export async function renderPokemonArenaCard(imageBuffer, {
  isSilhouette = true,
  isShiny = false,
  primaryType = 'Electric'
} = {}) {
  const width = 900;
  const height = 560;
  const [c1, c2] = isShiny
    ? ['#ffd700', '#ff7eb3']
    : (POKEMON_TYPE_COLORS[primaryType] || ['#ff7eb3', '#7afcff']);

  const arenaSvg = `
  <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="pkBg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#0c0a18"/>
        <stop offset="50%" stop-color="#17132c"/>
        <stop offset="100%" stop-color="#090712"/>
      </linearGradient>
      <radialGradient id="pkAura" cx="50%" cy="50%" r="48%">
        <stop offset="0%" stop-color="${c1}" stop-opacity="${isSilhouette ? '0.32' : '0.42'}"/>
        <stop offset="55%" stop-color="${c2}" stop-opacity="0.12"/>
        <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="pkBorder" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="${c1}"/>
        <stop offset="100%" stop-color="${c2}"/>
      </linearGradient>
    </defs>

    <rect width="${width}" height="${height}" fill="url(#pkBg)"/>
    <circle cx="${width / 2}" cy="${height / 2}" r="250" fill="url(#pkAura)"/>

    <!-- Inner Arena Stage -->
    <rect x="75" y="40" width="${width - 150}" height="${height - 80}" rx="26" fill="#130f24" fill-opacity="0.65" stroke="url(#pkBorder)" stroke-width="2.5"/>

    <!-- Subtle Vector Pokéball Emblem in Center -->
    <g opacity="0.16" transform="translate(${width / 2}, ${height / 2})">
      <circle cx="0" cy="0" r="185" fill="none" stroke="${c1}" stroke-width="10"/>
      <line x1="-185" y1="0" x2="-52" y2="0" stroke="${c1}" stroke-width="10"/>
      <line x1="52" y1="0" x2="185" y2="0" stroke="${c1}" stroke-width="10"/>
      <circle cx="0" cy="0" r="52" fill="none" stroke="${c2}" stroke-width="10"/>
      <circle cx="0" cy="0" r="24" fill="${c1}"/>
    </g>

    <!-- Sparkle Stars -->
    <path d="M 135 95 L 142 112 L 159 119 L 142 126 L 135 143 L 128 126 L 111 119 L 128 112 Z" fill="${c1}" opacity="0.8"/>
    <path d="M ${width - 135} 95 L ${width - 128} 112 L ${width - 111} 119 L ${width - 128} 126 L ${width - 135} 143 L ${width - 142} 126 L ${width - 159} 119 L ${width - 142} 112 Z" fill="${c2}" opacity="0.8"/>
    ${isShiny ? `
      <path d="M 220 150 L 225 164 L 239 169 L 225 174 L 220 188 L 215 174 L 201 169 L 215 164 Z" fill="#ffd700" opacity="0.95"/>
      <path d="M 680 155 L 685 169 L 699 174 L 685 179 L 680 193 L 675 179 L 661 174 L 675 169 Z" fill="#ffd700" opacity="0.95"/>
      <path d="M 240 410 L 244 420 L 254 424 L 244 428 L 240 438 L 236 428 L 226 424 L 236 420 Z" fill="#ffd700" opacity="0.85"/>
    ` : ''}
  </svg>`;

  const baseBuffer = await sharp(Buffer.from(arenaSvg)).png().toBuffer();
  if (!imageBuffer) return baseBuffer;

  try {
    let sprite = imageBuffer;
    if (isSilhouette) {
      // High-contrast dark-indigo Pokémon silhouette with crisp edges
      const { data, info } = await sharp(imageBuffer)
        .resize(410, 410, { fit: 'inside' })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] > 35) {
          data[i] = 18;
          data[i + 1] = 22;
          data[i + 2] = 44;
          data[i + 3] = 255;
        }
      }
      sprite = await sharp(data, {
        raw: { width: info.width, height: info.height, channels: 4 }
      }).png().toBuffer();
    } else {
      sprite = await sharp(imageBuffer, { failOn: 'none' })
        .resize(420, 420, { fit: 'inside' })
        .png()
        .toBuffer();
    }

    const meta = await sharp(sprite).metadata();
    const left = Math.round((width - (meta.width || 410)) / 2);
    const top = Math.round((height - (meta.height || 410)) / 2);

    return await sharp(baseBuffer)
      .composite([{ input: sprite, left, top }])
      .jpeg({ quality: 92 })
      .toBuffer();
  } catch {
    return baseBuffer;
  }
}

