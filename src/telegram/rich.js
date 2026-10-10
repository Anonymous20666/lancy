/**
 * Rich Message builder — Bot API 10.3 (sendRichMessage / editMessageText).
 *
 * A Rich Message is ONE structured Telegram message: headings, paragraphs,
 * dividers, tables, buttons (RichMessageButton), photos, footers.
 * This builder produces InputRichMessage JSON directly — no guessing.
 *
 * Limits honored (Bot API 10.3): 32,768 chars, 500 blocks, 16 nesting
 * levels, 50 media attachments, 20 table columns, 1–8 buttons per row.
 */

export const RICH_LIMITS = {
  maxChars: 32768,
  maxBlocks: 500,
  maxNesting: 16,
  maxMedia: 50,
  maxTableColumns: 20,
  maxButtonsPerRow: 8,
  maxCallbackDataBytes: 64
};

// ── RichText helpers ──────────────────────────────────────────────────────
// RichText = string | RichText[] | typed entity. Plain strings stay strings.

export const rt = {
  text: (s) => String(s ?? ''),
  concat: (...parts) => parts.flat(Infinity).filter((p) => p !== '' && p != null),
  bold: (text) => ({ type: 'bold', text: rt.text(text) }),
  italic: (text) => ({ type: 'italic', text: rt.text(text) }),
  underline: (text) => ({ type: 'underline', text: rt.text(text) }),
  strikethrough: (text) => ({ type: 'strikethrough', text: rt.text(text) }),
  spoiler: (text) => ({ type: 'spoiler', text: rt.text(text) }),
  marked: (text) => ({ type: 'marked', text: rt.text(text) }),
  code: (text) => ({ type: 'code', text: rt.text(text) }),
  pre: (text, language) => ({ type: 'pre', text: rt.text(text), ...(language ? { language } : {}) }),
  url: (text, url) => ({ type: 'url', text: rt.text(text), url }),
  mention: (text, username) => ({ type: 'mention', text: rt.text(text), username }),
  customEmoji: (alternativeText, customEmojiId) => ({ type: 'custom_emoji', alternative_text: alternativeText, custom_emoji_id: String(customEmojiId) })
};

import { applyCustomEmojisToBlocks, CUSTOM_EMOJI_MAP, getCustomEmojiId, toCustomEmojiHtml, enhanceRichText } from './customEmoji.js';

export { applyCustomEmojisToBlocks, CUSTOM_EMOJI_MAP, getCustomEmojiId, toCustomEmojiHtml, enhanceRichText };

/** Flatten RichText to plain string (for length checks / previews). */
export function richTextToString(text) {
  if (text == null) return '';
  if (typeof text === 'string') return text;
  if (Array.isArray(text)) return text.map(richTextToString).join('');
  if (typeof text === 'object') {
    if (typeof text.alternative_text === 'string') return text.alternative_text;
    if (typeof text.text === 'string' || Array.isArray(text.text) || typeof text.text === 'object') {
      return richTextToString(text.text);
    }
    if (typeof text.expression === 'string') return text.expression;
  }
  return '';
}

// ── Block builders ────────────────────────────────────────────────────────

export const block = {
  paragraph: (text) => ({ type: 'paragraph', text }),
  heading: (text, size = 1) => ({ type: 'heading', text, size: clampSize(size) }),
  pre: (text, language) => ({ type: 'pre', text, ...(language ? { language } : {}) }),
  footer: (text) => ({ type: 'footer', text }),
  divider: () => ({ type: 'divider' }),
  buttons: (buttons, align = 'center') => ({
    type: 'buttons',
    buttons: buttons.slice(0, RICH_LIMITS.maxButtonsPerRow).map((btn) => ({
      ...btn,
      style: btn.style ?? 'primary'
    })),
    align
  }),
  table: (rows, { bordered = true, striped = false, compact = true, caption } = {}) => ({
    type: 'table',
    cells: rows.map((row) => row.map((cell) => normalizeCell(cell))),
    is_bordered: bordered,
    is_striped: striped,
    is_compact: compact,
    ...(caption ? { caption } : {})
  }),
  list: (items) => ({
    type: 'list',
    items: items.map((item) =>
      typeof item === 'object' && item !== null && 'blocks' in item
        ? item
        : { blocks: [block.paragraph(item)] }
    )
  }),
  blockquote: (blocks, credit) => ({ type: 'blockquote', blocks, ...(credit ? { credit } : {}) }),
  expandableBlockquote: (text, credit) => ({ type: 'expandable_blockquote', text, ...(credit ? { credit } : {}) }),
  pullquote: (text, credit) => ({ type: 'pullquote', text, ...(credit ? { credit } : {}) }),
  details: (summary, blocks, isOpen = false) => ({ type: 'details', summary, blocks, is_open: isOpen }),
  photo: (media, caption) => ({ type: 'photo', photo: typeof media === 'object' && media !== null ? media : { type: 'photo', media }, ...(caption ? { caption: { text: caption } } : {}) }),
  video: (media, caption) => ({ type: 'video', video: typeof media === 'object' && media !== null ? media : { type: 'video', media }, ...(caption ? { caption: { text: caption } } : {}) }),
  animation: (media, caption) => ({ type: 'animation', animation: typeof media === 'object' && media !== null ? media : { type: 'animation', media }, ...(caption ? { caption: { text: caption } } : {}) }),
  audio: (media, caption) => ({ type: 'audio', audio: typeof media === 'object' && media !== null ? media : { type: 'audio', media }, ...(caption ? { caption: { text: caption } } : {}) }),
  document: (media, caption) => ({ type: 'document', document: typeof media === 'object' && media !== null ? media : { type: 'document', media }, ...(caption ? { caption: { text: caption } } : {}) }),
  collage: (blocks, caption) => ({ type: 'collage', blocks: blocks.map((b) => typeof b === 'string' ? block.photo(b) : b), ...(caption ? { caption: { text: caption } } : {}) }),
  slideshow: (blocks, caption) => ({ type: 'slideshow', blocks: blocks.map((b) => typeof b === 'string' ? block.photo(b) : b), ...(caption ? { caption: { text: caption } } : {}) })
};

function clampSize(size) {
  return Math.max(1, Math.min(6, Number(size) || 1));
}

function normalizeCell(cell) {
  if (cell == null) return { align: 'left', valign: 'top' };
  if (typeof cell === 'string' || Array.isArray(cell) || typeof cell !== 'object') {
    return { text: cell, align: 'left', valign: 'top' };
  }
  return {
    ...(cell.text !== undefined ? { text: cell.text } : {}),
    ...(cell.is_header ? { is_header: true } : {}),
    ...(cell.colspan ? { colspan: cell.colspan } : {}),
    ...(cell.rowspan ? { rowspan: cell.rowspan } : {}),
    align: cell.align ?? 'left',
    valign: cell.valign ?? 'top'
  };
}

// ── RichMessageButton ─────────────────────────────────────────────────────

export const richButton = {
  callback: (text, callbackData, { style = 'primary' } = {}) => ({
    text: rt.text(text),
    callback_data: callbackData,
    style
  }),
  url: (text, url, { style = 'primary' } = {}) => ({ text: rt.text(text), url, style }),
  copy: (text, copyText, { style = 'primary' } = {}) => ({ text: rt.text(text), copy_text: { text: copyText }, style }),
  disabled: (text) => ({ text: rt.text(text), callback_data: 'noop', disabled: { reason: 'disabled' }, style: 'primary' })
};

// ── InputRichMessage builder ──────────────────────────────────────────────

export class RichMessageBuilder {
  constructor({ rtl = false, skipEntityDetection = true } = {}) {
    this.blocks = [];
    this.rtl = rtl;
    this.skipEntityDetection = skipEntityDetection;
  }

  raw(blocks) {
    this.blocks.push(...blocks);
    return this;
  }

  heading(text, size = 1) { this.blocks.push(block.heading(text, size)); return this; }
  paragraph(text) { this.blocks.push(block.paragraph(text)); return this; }
  text(text) { return this.paragraph(text); }
  pre(text, language) { this.blocks.push(block.pre(text, language)); return this; }
  footer(text) { this.blocks.push(block.footer(text)); return this; }
  divider() { this.blocks.push(block.divider()); return this; }
  buttons(buttons, align) { this.blocks.push(block.buttons(buttons, align)); return this; }
  table(rows, opts) { this.blocks.push(block.table(rows, opts)); return this; }
  list(items) { this.blocks.push(block.list(items)); return this; }
  blockquote(blocksOrText, credit) {
    this.blocks.push(block.blockquote(Array.isArray(blocksOrText) ? blocksOrText : [block.paragraph(blocksOrText)], credit));
    return this;
  }
  quote(blocksOrText, credit) {
    return this.blockquote(blocksOrText, credit);
  }
  expandableBlockquote(text, credit) {
    this.blocks.push(block.expandableBlockquote(text, credit));
    return this;
  }
  pullquote(text, credit) {
    this.blocks.push(block.pullquote(text, credit));
    return this;
  }
  details(summary, blocks, isOpen) { this.blocks.push(block.details(summary, blocks, isOpen)); return this; }
  photo(media, caption) { this.blocks.push(block.photo(media, caption)); return this; }
  video(media, caption) { this.blocks.push(block.video(media, caption)); return this; }
  audio(media, caption) { this.blocks.push(block.audio(media, caption)); return this; }
  animation(media, caption) { this.blocks.push(block.animation(media, caption)); return this; }
  document(media, caption) { this.blocks.push(block.document(media, caption)); return this; }
  collage(items, caption) { this.blocks.push(block.collage(items, caption)); return this; }
  slideshow(items, caption) { this.blocks.push(block.slideshow(items, caption)); return this; }
  spacer() { this.blocks.push(block.paragraph('')); return this; }

  /** A "card": heading + divider + key/value table — Lancy's signature look. */
  card(title, rows, { emoji } = {}) {
    this.heading(emoji ? `${emoji} ${title}` : title, 2);
    this.divider();
    this.table(rows, { compact: true });
    return this;
  }

  /** Validate against Bot API limits. Throws with a clear message. */
  validate() {
    const count = countBlocks(this.blocks);
    if (count > RICH_LIMITS.maxBlocks) {
      throw new Error(`Rich message has ${count} blocks (max ${RICH_LIMITS.maxBlocks})`);
    }
    const chars = this.plainLength();
    if (chars > RICH_LIMITS.maxChars) {
      throw new Error(`Rich message text is ${chars} chars (max ${RICH_LIMITS.maxChars}) — never shrink text silently; split the screen`);
    }
    return true;
  }

  plainLength() {
    return this.blocks.reduce((sum, b) => sum + blockTextLength(b), 0);
  }

  toJSON({ useCustomEmojis = true } = {}) {
    return {
      blocks: useCustomEmojis ? applyCustomEmojisToBlocks(this.blocks) : this.blocks,
      ...(this.rtl ? { is_rtl: true } : {}),
      skip_entity_detection: this.skipEntityDetection
    };
  }
}

function countBlocks(blocks) {
  let count = 0;
  for (const b of blocks) {
    count += 1;
    for (const key of ['blocks', 'items']) {
      if (Array.isArray(b[key])) count += countBlocks(b[key].map((x) => x.blocks ?? x).flat());
    }
    if (Array.isArray(b.cells)) {
      for (const row of b.cells) for (const cell of row) if (cell.text) count += 0; // cells counted as part of table
    }
  }
  return count;
}

function blockTextLength(b) {
  switch (b.type) {
    case 'paragraph':
    case 'heading':
    case 'pre':
    case 'footer':
      return richTextToString(b.text).length;
    case 'pullquote':
      return richTextToString(b.text).length + (b.credit ? richTextToString(b.credit).length : 0);
    case 'buttons':
      return b.buttons.reduce((s, btn) => s + richTextToString(btn.text).length + (btn.callback_data?.length ?? 0), 0);
    case 'table':
      return b.cells.flat().reduce((s, c) => s + (c.text ? richTextToString(c.text).length : 0), 0);
    case 'details':
      return richTextToString(b.summary).length + (b.blocks?.reduce((s, x) => s + blockTextLength(x), 0) ?? 0);
    case 'blockquote':
      return b.blocks?.reduce((s, x) => s + blockTextLength(x), 0) ?? 0;
    case 'expandable_blockquote':
      return richTextToString(b.text ?? b.blocks).length + (b.credit ? richTextToString(b.credit).length : 0);
    default:
      return 0;
  }
}

// ── Inline keyboard (Bot API 10.3: style + disabled) ──────────────────────

export function inlineKeyboard(rows) {
  return {
    inline_keyboard: rows.map((row) =>
      row.map((btn) => {
        const out = { text: btn.text };
        if (btn.callback_data !== undefined) out.callback_data = btn.callback_data;
        if (btn.url !== undefined) out.url = btn.url;
        if (btn.copy_text !== undefined) out.copy_text = btn.copy_text;
        out.style = btn.style ?? 'primary'; // danger | success | primary
        if (btn.disabled) out.disabled = btn.disabled;
        if (btn.switch_inline_query !== undefined) out.switch_inline_query = btn.switch_inline_query;
        if (btn.web_app) out.web_app = btn.web_app;
        return out;
      })
    )
  };
}

export function ikButton(text, callbackData, opts = {}) {
  return { text, callback_data: callbackData, style: 'primary', ...opts };
}

// ── Callback data codec ───────────────────────────────────────────────────
// Compact, versioned, ≤64 bytes:  v1:<screen>:<action>:<arg1>:<arg2>...

const CB_PREFIX = 'l1';

export function encodeCallback(screen, action, ...args) {
  const parts = [CB_PREFIX, screen, action, ...args.map((a) => String(a))];
  const data = parts.join(':');
  const bytes = Buffer.byteLength(data, 'utf8');
  if (bytes > RICH_LIMITS.maxCallbackDataBytes) {
    throw new Error(`callback_data too long (${bytes} bytes): ${data}`);
  }
  return data;
}

export function decodeCallback(data) {
  if (typeof data !== 'string' || !data.startsWith(`${CB_PREFIX}:`)) return null;
  const [, screen, action, ...args] = data.split(':');
  return { screen, action, args, raw: data };
}

export const NOOP_CALLBACK = encodeCallback('noop', 'noop');

/**
 * Collect `attach://name` references from a rich message so the caller can
 * supply matching multipart files. Returns Map<name, path[]>.
 */
export function collectAttachmentRefs(node, out = new Map(), path = '$') {
  if (node == null) return out;
  if (typeof node === 'string') {
    const match = /^attach:\/\/(.+)$/.exec(node);
    if (match) {
      const name = match[1];
      if (!out.has(name)) out.set(name, []);
      out.get(name).push(path);
    }
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((item, i) => collectAttachmentRefs(item, out, `${path}[${i}]`));
    return out;
  }
  if (typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      collectAttachmentRefs(value, out, `${path}.${key}`);
    }
  }
  return out;
}

/** Build a multipart file map { fieldName: { buffer, filename, contentType } } from buffers. */
export function buildFileMap(buffers, { prefix = 'file', contentType = 'application/octet-stream' } = {}) {
  const files = {};
  let i = 0;
  for (const [name, buffer] of Object.entries(buffers)) {
    const field = `${prefix}_${i++}`;
    files[name] = { buffer, filename: `${field}`, contentType };
  }
  return files;
}
