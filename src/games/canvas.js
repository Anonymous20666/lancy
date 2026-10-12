import sharp from 'sharp';

/**
 * Escapes XML/SVG special characters.
 */
function escapeXml(unsafe = '') {
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Turns an image buffer with transparency into a dark mystery silhouette.
 */
export async function createSilhouette(imageBuffer) {
  try {
    const { data, info } = await sharp(imageBuffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 35) {
        data[i] = 16;     // Very dark purple-black
        data[i + 1] = 12;
        data[i + 2] = 24;
        data[i + 3] = 255;
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
 * Generates an ultra-crisp 1000x600 visual game card with Lancy aesthetics.
 */
export async function renderGameCard({
  category = 'GUESS THE ITEM',
  categoryIcon = '🎮',
  round = 1,
  totalRounds = 10,
  difficulty = 'MEDIUM',
  mediaBuffer = null,
  promptText = 'Type your answer in chat! Fastest chatter wins +120 XP ♡',
  timerText = '30s Smart Timer',
  isSilhouette = false,
  modifier = null // e.g. 'SPEED BLITZ 🔥' or 'SUDDEN DEATH 💣'
} = {}) {
  const diffStars = difficulty === 'HARD' ? '⭐⭐⭐' : difficulty === 'EASY' ? '⭐' : '⭐⭐';
  const categoryLabel = `${categoryIcon} ${category}`.toUpperCase();
  const roundLabel = `ROUND ${round}/${totalRounds} • ${diffStars} ${difficulty}`.toUpperCase();

  const modifierBanner = modifier ? `
    <rect x="360" y="95" width="280" height="38" rx="19" fill="#ff2e63" stroke="#ffe066" stroke-width="1.5"/>
    <text x="500" y="120" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="13" font-weight="bold" fill="#ffffff" letter-spacing="1.5">${escapeXml(modifier)}</text>
  ` : '';

  const cardSvg = `
  <svg width="1000" height="600" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#110e19"/>
        <stop offset="45%" stop-color="#211833"/>
        <stop offset="100%" stop-color="#0e0b16"/>
      </linearGradient>
      <linearGradient id="cardGlow" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#ff7eb3"/>
        <stop offset="50%" stop-color="#be93fd"/>
        <stop offset="100%" stop-color="#7afcff"/>
      </linearGradient>
      <linearGradient id="boxInner" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stop-color="#1c152a"/>
        <stop offset="100%" stop-color="#140f20"/>
      </linearGradient>
      <filter id="softGlow" x="-10%" y="-10%" width="120%" height="120%">
        <feGaussianBlur stdDeviation="6" result="blur"/>
        <feComposite in="SourceGraphic" in2="blur" operator="over"/>
      </filter>
    </defs>

    <!-- Background -->
    <rect width="1000" height="600" fill="url(#bg)"/>

    <!-- Outer Aesthetic Border -->
    <rect x="24" y="24" width="952" height="552" rx="28" fill="none" stroke="url(#cardGlow)" stroke-width="2.5" opacity="0.7"/>

    <!-- Lancy Girly Header -->
    <text x="500" y="68" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="19" font-weight="bold" fill="#ffb6d9" letter-spacing="4">୨୧ ━━━ 𓆩♡𓆪 LANCY GAME ARENA 𓆩♡𓆪 ━━━ ୨୧</text>

    <!-- Category Pill -->
    <rect x="55" y="95" width="260" height="38" rx="19" fill="#2d2047" stroke="#ff7eb3" stroke-width="1.5"/>
    <text x="185" y="120" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="13" font-weight="bold" fill="#ffffff" letter-spacing="1">${escapeXml(categoryLabel)}</text>

    <!-- Optional Modifier Badge -->
    ${modifierBanner}

    <!-- Round & Difficulty Pill -->
    <rect x="685" y="95" width="260" height="38" rx="19" fill="#2d2047" stroke="#7afcff" stroke-width="1.5"/>
    <text x="815" y="120" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="13" font-weight="bold" fill="#7afcff" letter-spacing="1">${escapeXml(roundLabel)}</text>

    <!-- Central Showcase Frame (560 x 350) -->
    <rect x="220" y="150" width="560" height="350" rx="22" fill="url(#boxInner)" stroke="#493766" stroke-width="2"/>

    <!-- Footer Bar -->
    <rect x="180" y="525" width="640" height="42" rx="21" fill="#1b1428" stroke="#3b2b54" stroke-width="1.2"/>
    <text x="500" y="551" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="14" fill="#d9d0e8">
      ⏱️ <tspan fill="#ffe066" font-weight="bold">${escapeXml(timerText)}</tspan> • <tspan fill="#ffffff">${escapeXml(promptText)}</tspan>
    </text>
  </svg>
  `;

  const baseCard = await sharp(Buffer.from(cardSvg)).png().toBuffer();

  if (mediaBuffer) {
    let processedMedia = mediaBuffer;
    if (isSilhouette) {
      processedMedia = await createSilhouette(mediaBuffer);
    }

    // Resize media to fit neatly within 500x310 inside the 560x350 box
    const fittedMedia = await sharp(processedMedia)
      .resize(500, 310, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();

    const { width: mw, height: mh } = await sharp(fittedMedia).metadata();
    const targetX = Math.round(220 + (560 - (mw || 500)) / 2);
    const targetY = Math.round(150 + (350 - (mh || 310)) / 2);

    return await sharp(baseCard)
      .composite([{ input: fittedMedia, top: targetY, left: targetX }])
      .png()
      .toBuffer();
  }

  return baseCard;
}

/**
 * Generates an end-of-game victory podium graphic card.
 */
export async function renderPodiumCard({
  category = 'TRIVIA BATTLE',
  totalRounds = 10,
  topPlayers = [], // [{ rank: 1, name: 'Alex', score: 450, streak: 3 }, ...]
  fastestPlayer = null // { name: 'Pappy', ms: 1200 }
} = {}) {
  const p1 = topPlayers[0] || { name: 'No Winner', score: 0 };
  const p2 = topPlayers[1] || null;
  const p3 = topPlayers[2] || null;

  const podiumSvg = `
  <svg width="1000" height="600" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="podiumBg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#140f1f"/>
        <stop offset="50%" stop-color="#2a1b3d"/>
        <stop offset="100%" stop-color="#100b1a"/>
      </linearGradient>
      <linearGradient id="gold" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#ffe066"/>
        <stop offset="100%" stop-color="#f5a623"/>
      </linearGradient>
      <linearGradient id="silver" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#e0e0e0"/>
        <stop offset="100%" stop-color="#9e9e9e"/>
      </linearGradient>
      <linearGradient id="bronze" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#f5a677"/>
        <stop offset="100%" stop-color="#b06030"/>
      </linearGradient>
    </defs>

    <rect width="1000" height="600" fill="url(#podiumBg)"/>
    <rect x="25" y="25" width="950" height="550" rx="28" fill="none" stroke="url(#gold)" stroke-width="2.5" opacity="0.6"/>

    <text x="500" y="70" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="20" font-weight="bold" fill="#ffb6d9" letter-spacing="4">🏆 GAME OVER • MATCH PODIUM 🏆</text>
    <text x="500" y="105" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="14" fill="#a59cb8">${escapeXml(category)} • ${totalRounds} Rounds Completed</text>

    <!-- 1st Place (Center Pillar) -->
    <rect x="390" y="220" width="220" height="260" rx="16" fill="#2d2244" stroke="url(#gold)" stroke-width="3"/>
    <text x="500" y="200" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="40">👑</text>
    <text x="500" y="260" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="32" font-weight="bold" fill="url(#gold)">1ST</text>
    <text x="500" y="310" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="19" font-weight="bold" fill="#ffffff">${escapeXml(p1.name)}</text>
    <text x="500" y="350" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="24" font-weight="bold" fill="#ffe066">${p1.score} PTS</text>

    <!-- 2nd Place (Left Pillar) -->
    ${p2 ? `
    <rect x="140" y="280" width="210" height="200" rx="16" fill="#221936" stroke="url(#silver)" stroke-width="2"/>
    <text x="245" y="325" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="28" font-weight="bold" fill="url(#silver)">2ND</text>
    <text x="245" y="370" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="17" font-weight="bold" fill="#ffffff">${escapeXml(p2.name)}</text>
    <text x="245" y="410" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="20" font-weight="bold" fill="#e0e0e0">${p2.score} PTS</text>
    ` : ''}

    <!-- 3rd Place (Right Pillar) -->
    ${p3 ? `
    <rect x="650" y="320" width="210" height="160" rx="16" fill="#221936" stroke="url(#bronze)" stroke-width="2"/>
    <text x="755" y="365" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="26" font-weight="bold" fill="url(#bronze)">3RD</text>
    <text x="755" y="405" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="16" font-weight="bold" fill="#ffffff">${escapeXml(p3.name)}</text>
    <text x="755" y="440" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="19" font-weight="bold" fill="#f5a677">${p3.score} PTS</text>
    ` : ''}

    <!-- Footer speed badge -->
    <rect x="250" y="515" width="500" height="40" rx="20" fill="#1b1428" stroke="#3b2b54" stroke-width="1.2"/>
    <text x="500" y="540" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="14" fill="#d9d0e8">
      ${fastestPlayer ? `⚡ Fastest Sniped: <tspan fill="#7afcff" font-weight="bold">${escapeXml(fastestPlayer.name)} in ${(fastestPlayer.ms / 1000).toFixed(1)}s</tspan>!` : '🌟 Awesome game everyone! Points added to group leaderboard!'}
    </text>
  </svg>
  `;

  return await sharp(Buffer.from(podiumSvg)).png().toBuffer();
}
