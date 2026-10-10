/** Typography helpers for Lancy's girly, polished UI. No emoji spam. */

export const DIVIDER = '──────────────';
export const THICK_DIVIDER = '━━━━━━━━━━━━━━';
export const THIN_DIVIDER = '· · · · · · · · · ·';

export function truncate(str, max = 200) {
  if (!str) return '';
  const chars = Array.from(String(str));
  if (chars.length <= max) return chars.join('');
  return chars.slice(0, Math.max(0, max - 1)).join('') + '…';
}

export function box(lines, { width = 30 } = {}) {
  const inner = Math.max(width, ...lines.map((l) => [...l].length));
  const top = `╭${'─'.repeat(inner + 2)}╮`;
  const bottom = `╰${'─'.repeat(inner + 2)}╯`;
  const body = lines.map((l) => `│ ${l.padEnd(inner)} │`);
  return [top, ...body, bottom].join('\n');
}

export function center(text, width = 28) {
  const len = [...text].length;
  if (len >= width) return text;
  const left = Math.floor((width - len) / 2);
  return ' '.repeat(left) + text + ' '.repeat(width - len - left);
}

/** A soft progress bar: ██████████░░░░ 68% */
export function progressBar(ratio, { width = 12, filled = '█', empty = '░' } = {}) {
  const r = Math.max(0, Math.min(1, ratio));
  const filledCount = Math.round(r * width);
  return `${filled.repeat(filledCount)}${empty.repeat(width - filledCount)} ${Math.round(r * 100)}%`;
}

export function padLabel(label, value, { width = 14 } = {}) {
  return `${label.padEnd(width)} ${value}`;
}

/** Escape for Telegram HTML parse mode (used in captions/legacy text). */
export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Strip characters Telegram inline keyboards / callback data cannot carry. */
export function slugify(str) {
  return String(str)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

export function randomId(prefix = '') {
  return prefix + Math.random().toString(36).slice(2, 10);
}

/** Title-case a query for pack titles: "gojo satoru" -> "Gojo Satoru" */
export function titleCase(str) {
  return String(str)
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.length <= 2 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

/** Pluralize helper: sticker(2) -> "2 stickers" */
export function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "08 Oct 2026 • 14:38" */
export function formatDateTime(date = new Date(), timeZone = 'UTC') {
  const d = date instanceof Date ? date : new Date(date);
  const p = (n) => String(n).padStart(2, '0');
  let day, month, year, hours, minutes;
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone, day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false
    });
    const parts = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
    day = parts.day; month = parts.month; year = parts.year;
    hours = parts.hour; minutes = parts.minute;
  } catch {
    day = p(d.getUTCDate()); month = MONTHS[d.getUTCMonth()]; year = d.getUTCFullYear();
    hours = p(d.getUTCHours()); minutes = p(d.getUTCMinutes());
  }
  return `${day} ${month} ${year} • ${hours}:${minutes}`;
}

export function formatDate(date = new Date(), timeZone = 'UTC') {
  return formatDateTime(date, timeZone).split(' • ')[0];
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

/** Friendly relative time: "just now", "5m ago", "2h ago" */
export function timeAgo(date) {
  const diff = (Date.now() - new Date(date).getTime()) / 1000;
  if (diff < 45) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/** Join lines, collapsing 3+ blank lines into one. */
export function tidy(text) {
  return String(text).replace(/\n{3,}/g, '\n\n').trim();
}
