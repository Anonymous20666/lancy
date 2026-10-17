export {
  fetchImageBuffer,
  createSilhouette,
  renderFramedMedia,
  renderGridMask,
  renderMysteryBlur
} from './visuals.js';

import sharp from 'sharp';
import { renderFramedMedia } from './visuals.js';

function escapeXml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Legacy-compatible wrapper that renders a pure zero-text framed visual.
 */
export async function renderGameCard({
  mediaBuffer = null,
  isSilhouette = false
} = {}) {
  return renderFramedMedia(mediaBuffer, { isSilhouette });
}

/**
 * Generates an end-of-game victory podium graphic card.
 */
export async function renderPodiumCard({
  category = 'TRIVIA BATTLE',
  totalRounds = 10,
  topPlayers = [],
  fastestPlayer = null
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
