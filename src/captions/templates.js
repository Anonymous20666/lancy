/**
 * Built-in caption templates. The Owl House example from the brief is only
 * an EXAMPLE — everything here is template-driven and configurable.
 */
export const BUILTIN_TEMPLATES = {
  default: `✦ {{title}} ✦

╭───────────────╮
│ ♡ STICKERS • {{stickers}}
│ ▣ PACKS • {{packs}}
╰───────────────╯

A little pack of hand-picked moments, made with love ♡

💌 {{cta}}

{{footer}}`,

  minimal: `✦ {{title}}
{{stickers}} stickers • {{packs}} pack(s)
{{telegram_link}}

{{footer}}`,

  premium: `━━━━ ✦ {{title}} ✦ ━━━━

A curated sticker collection — {{stickers}} stickers across {{packs}} pack(s).

♡ Download • Use • Enjoy
{{telegram_link}}

{{footer}}`,

  playful: `heyyy bestie ♡

your new {{title}} pack is READY ✨
{{stickers}} stickers • {{packs}} pack(s)

{{telegram_link}}

{{footer}}`
};

/** Template store: built-ins + user templates persisted in the DB. */
export class TemplateStore {
  constructor(db, { userId = null } = {}) {
    this.db = db;
    this.userId = userId;
  }

  get(name) {
    if (BUILTIN_TEMPLATES[name]) return BUILTIN_TEMPLATES[name];
    const row = this.db?.get(
      'SELECT template FROM caption_templates WHERE name = ? AND (user_id = ? OR user_id IS NULL)',
      name, this.userId ?? -1
    );
    return row?.template ?? null;
  }

  list() {
    const custom = this.db
      ? this.db.all('SELECT name, is_default, created_at FROM caption_templates WHERE user_id = ? ORDER BY created_at DESC', this.userId ?? -1)
      : [];
    return [
      ...Object.keys(BUILTIN_TEMPLATES).map((name) => ({ name, builtin: true, is_default: name === 'default' })),
      ...custom.map((row) => ({ name: row.name, builtin: false, is_default: !!row.is_default }))
    ];
  }

  save(name, template, { isDefault = false } = {}) {
    if (!this.db || this.userId == null) throw new Error('Template persistence requires a DB and user');
    this.db.run(
      'INSERT INTO caption_templates (user_id, name, template, is_default) VALUES (?, ?, ?, ?)',
      this.userId, name, template, isDefault ? 1 : 0
    );
    if (isDefault) {
      this.db.run('UPDATE caption_templates SET is_default = 0 WHERE user_id = ? AND name != ?', this.userId, name);
    }
    return { name, template, isDefault };
  }
}
