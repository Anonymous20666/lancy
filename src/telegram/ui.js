import { RichMessageBuilder, rt, richButton, block, inlineKeyboard, ikButton, encodeCallback } from './rich.js';
import { progressBar, formatBytes, formatDateTime, truncate, pluralize } from '../utils/text.js';

/**
 * Lancy UI design system — the shared vocabulary every screen is built from.
 * Girly, polished, organized: headings, dividers, compact tables, one
 * accent emoji per section, never an emoji explosion.
 */

export const ACCENT = '♡';
export const SPARK = '✦';

export function header(title, { emoji = SPARK } = {}) {
  return [`${emoji} ${String(title).toUpperCase()} ${emoji}`];
}

export function banner(lines) {
  // ╭───╮ boxed banner for hero moments (dashboard, completion)
  const width = Math.max(...lines.map((l) => [...l].length), 24);
  const top = `╭${'─'.repeat(width + 2)}╮`;
  const bottom = `╰${'─'.repeat(width + 2)}╯`;
  const body = lines.map((l) => {
    const len = [...l].length;
    const left = Math.floor((width - len) / 2);
    return `│${' '.repeat(left + 1)}${l}${' '.repeat(width - len - left + 1)}│`;
  });
  return [top, ...body, bottom].join('\n');
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
  if (back) buttons.push(richButton.callback(`${ACCENT} Back`, encodeCallback(screen, 'back')));
  if (home) buttons.push(richButton.callback(`${SPARK} Home`, encodeCallback('dashboard', 'open')));
  if (cancel) buttons.push(richButton.callback('✕ Cancel', encodeCallback(screen, 'cancel'), { style: 'danger' }));
  return buttons;
}

/** Paginator buttons. */
export function pagerButtons(screen, page, totalPages, extra = []) {
  const row = [];
  if (page > 0) row.push(richButton.callback('← Prev', encodeCallback(screen, 'page', page - 1)));
  row.push(...extra);
  if (page < totalPages - 1) row.push(richButton.callback('Next →', encodeCallback(screen, 'page', page + 1)));
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
  if (page > 0) row.push(ikButton('← Prev', encodeCallback(screen, 'page', page - 1)));
  row.push(ikButton(`${page + 1} / ${totalPages}`, encodeCallback(screen, 'noop')));
  if (page < totalPages - 1) row.push(ikButton('Next →', encodeCallback(screen, 'page', page + 1)));
  rows.push(row);
  return inlineKeyboard(rows);
}

export { RichMessageBuilder, rt, richButton, block, inlineKeyboard, ikButton, encodeCallback, progressBar, truncate, pluralize, formatBytes, formatDateTime };
