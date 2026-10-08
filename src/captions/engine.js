/**
 * Caption engine — template-driven, variable-driven, never hard-coded.
 *
 * Supported variables:
 *   {{title}} {{query}} {{stickers}} {{packs}} {{creator}} {{date}}
 *   {{pack_name}} {{source}} {{telegram_link}} {{session_name}}
 *   {{pack_01_count}} … (per physical pack, when relevant)
 *
 * Unknown variables render as empty — we never leak "{{undefined}}".
 */
import { formatDate } from '../utils/text.js';

export const CAPTION_VARIABLES = [
  'title', 'query', 'stickers', 'packs', 'creator', 'date',
  'pack_name', 'source', 'telegram_link', 'session_name', 'cta', 'footer'
];

export class CaptionEngine {
  constructor({ settings, templates } = {}) {
    this.settings = settings;
    this.templates = templates;
  }

  /**
   * Render a template with variables.
   * @param {string} templateText
   * @param {object} vars
   */
  render(templateText, vars = {}) {
    if (!templateText) return '';
    const context = this.#buildContext(vars);
    return String(templateText).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
      const value = context[key];
      return value === undefined || value === null ? '' : String(value);
    });
  }

  #buildContext(vars) {
    const now = new Date();
    const tz = this.settings?.get('general.timezone') ?? 'UTC';
    const packs = Number(vars.packs ?? 1);
    const context = {
      title: vars.title ?? this.settings?.get('captions.defaultTitle') ?? '{{query}} Collection',
      query: vars.query ?? '',
      stickers: vars.stickers ?? 0,
      packs: String(packs).padStart(2, '0'),
      creator: vars.creator ?? this.settings?.get('general.defaultCreatorName') ?? 'Lancy',
      date: vars.date ?? formatDate(now, tz),
      pack_name: vars.packName ?? vars.pack_name ?? '',
      source: vars.source ?? 'Pinterest',
      telegram_link: vars.telegramLink ?? vars.telegram_link ?? '',
      session_name: vars.sessionName ?? vars.session_name ?? '',
      cta: vars.cta ?? this.settings?.get('captions.cta') ?? 'download • use • enjoy ♡',
      footer: vars.footer ?? this.settings?.get('captions.creatorFooter') ?? 'made with love ♡'
    };
    // Resolve variables inside the title template (single pass, no recursion).
    if (typeof context.title === 'string' && context.title.includes('{{')) {
      context.title = context.title.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (m, key) => {
        const v = context[key];
        return v === undefined || v === null ? '' : String(v);
      });
    }
    // Per-pack counts: {{pack_01_count}} etc.
    if (Array.isArray(vars.packSizes)) {
      vars.packSizes.forEach((count, i) => {
        context[`pack_${String(i + 1).padStart(2, '0')}_count`] = count;
      });
    }
    return context;
  }

  /** Render the default template from settings/templates. */
  renderDefault(vars = {}) {
    const templateName = this.settings?.get('captions.defaultTemplate') ?? 'default';
    const template = this.templates?.get(templateName) ?? this.templates?.get('default');
    if (!template) throw new Error(`Caption template "${templateName}" not found`);
    return this.render(template, vars);
  }
}

/** Validate a template: balanced braces, known-ish variables (warn only). */
export function validateTemplate(template) {
  const problems = [];
  const opens = (template.match(/\{\{/g) ?? []).length;
  const closes = (template.match(/\}\}/g) ?? []).length;
  if (opens !== closes) problems.push(`Unbalanced braces: ${opens} "{{" vs ${closes} "}}"`);
  const vars = [...template.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]);
  const unknown = vars.filter((v) => !CAPTION_VARIABLES.includes(v) && !/^pack_\d{2}_count$/.test(v));
  if (unknown.length) problems.push(`Unknown variables: ${[...new Set(unknown)].join(', ')}`);
  return { valid: problems.length === 0, problems, variables: [...new Set(vars)] };
}
