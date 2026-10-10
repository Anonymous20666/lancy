import { RichMessageBuilder, rt, richButton, block, inlineKeyboard, ikButton, encodeCallback } from './rich.js';
import { progressBar, formatBytes, formatDateTime, truncate, pluralize } from '../utils/text.js';

/**
 * Lancy UI design system — the shared vocabulary every screen is built from.
 * Girly, polished, organized: headings, dividers, compact tables, one
 * accent emoji per section, never an emoji explosion.
 */

export const ACCENT = '♡';
export const SPARK = '✦';
export const TEDDY = 'ʕ•ᴥ•ʔ';
export const TEDDY_CUTE = '૮꒰ ˶• ༝ •˶꒱ა';
export const GOTHIC_CROSS = '♰';
export const GOTHIC_STAR = '⛧';
export const BOW = '୨୧';
export const WINGS = '𓆩♡𓆪';
export const SPARKLE = '₊˚⊹♡';

export function header(title, { emoji = WINGS } = {}) {
  return [`${emoji} ${String(title).toUpperCase()} ${emoji}`];
}

export function banner(lines) {
  // Ornate gothic/girly heavy aesthetic header
  const textLines = lines.map(String);
  const top = `୨୧ ━━━ 𓆩♡𓆪 ━━━━━━━━━━━━━━ 𓆩♡𓆪 ━━━ ୨୧`;
  const bottom = `୨୧ ━━━━━━━━━ ૮꒰ ˶• ༝ •˶꒱ა ━━━━━━━━━ ୨୧`;
  const body = textLines.map((l) => `    ₊˚⊹♡  ${l}  ˙ᵕ˙`);
  return [top, ...body, bottom].join('\n');
}

export function gothicCard(title, subtitle) {
  return [
    `୨୧ ━━━━━━━ 𓆩♡𓆪 ━━━━━━━ ୨୧`,
    `   ⛧ ${String(title).toUpperCase()} ⛧`,
    subtitle ? `   ૮꒰ ˶• ༝ •˶꒱ა ${subtitle}` : '',
    `୨୧ ━━━━━━━━━━━━━━━━━━━━ ୨୧`
  ].filter(Boolean).join('\n');
}

/** Status dot for sessions/channels. */
export function statusDot(status) {
  switch (status) {
    case 'online': return '🟢';
    case 'connecting':
    case 'pairing':
    case 'reconnecting': return '🟡';
    case 'logged_out': return '🔴';
    default: return '⚪';
  }
}

/** Compact key/value table rows for a rich table block. */
export function kvRows(pairs) {
  return pairs
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([label, value]) => [
      { text: rt.concat(rt.text(`${label}`), rt.italic(rt.text(''))), is_header: false, align: 'left', valign: 'middle' },
      { text: rt.bold(String(value)), align: 'right', valign: 'middle' }
    ]);
}

/** Simple two-column table (label dim, value bold). */
export function kvTable(pairs) {
  return pairs
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([label, value]) => [
      { text: label, align: 'left', valign: 'middle' },
      { text: rt.bold(String(value)), align: 'left', valign: 'middle' }
    ]);
}

/** Standard navigation buttons for rich messages. */
export function navButtons(screen, { back = true, cancel = false, home = false } = {}) {
  const buttons = [];
  if (back) buttons.push(richButton.callback('« Back', encodeCallback(screen, 'back'), { style: 'primary' }));
  if (home) buttons.push(richButton.callback('✦ Home', encodeCallback('dashboard', 'open'), { style: 'primary' }));
  if (cancel) buttons.push(richButton.callback('✕ Cancel', encodeCallback(screen, 'cancel'), { style: 'danger' }));
  return buttons;
}

/** Paginator buttons. */
export function pagerButtons(screen, page, totalPages, extra = []) {
  const row = [];
  if (page > 0) row.push(richButton.callback('← Prev', encodeCallback(screen, 'page', page - 1), { style: 'primary' }));
  row.push(...extra);
  if (page < totalPages - 1) row.push(richButton.callback('Next →', encodeCallback(screen, 'page', page + 1), { style: 'primary' }));
  return row;
}

/** A progress section: stage lines with bars. */
export function progressSection(stages) {
  return stages.map((s) => {
    const bar = progressBar(s.ratio, { width: 10 });
    const icon = s.ratio >= 1 ? '✓' : s.ratio > 0 ? '…' : ' ';
    return ` ${icon} ${s.label}\n   ${bar}`;
  }).join('\n\n');
}

/** Format a sticker pack card. */
export function packCard(pack, { timeZone } = {}) {
  const b = new RichMessageBuilder();
  b.heading(`${SPARK} ${pack.title}`, 2);
  b.table(kvTable([
    ['Created', formatDateTime(new Date(pack.createdAt), timeZone)],
    ['Search', pack.query || '—'],
    ['Stickers', String(pack.count)],
    ['Type', pack.stickerType ?? 'static'],
    ['Link', pack.link ? rt.url('t.me', pack.link) : '—']
  ]), { compact: true });
  return b;
}

/** Inline keyboard pagination helper. */
export function inlinePager(screen, page, totalPages) {
  const rows = [];
  const row = [];
  if (page > 0) row.push(ikButton('← Prev', encodeCallback(screen, 'page', page - 1), { style: 'primary' }));
  row.push(ikButton(`${page + 1} / ${totalPages}`, encodeCallback(screen, 'noop'), { style: 'primary' }));
  if (page < totalPages - 1) row.push(ikButton('Next →', encodeCallback(screen, 'page', page + 1), { style: 'primary' }));
  rows.push(row);
  return inlineKeyboard(rows);
}

export { RichMessageBuilder, rt, richButton, block, inlineKeyboard, ikButton, encodeCallback, progressBar, truncate, pluralize, formatBytes, formatDateTime };
