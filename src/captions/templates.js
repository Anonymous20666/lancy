/**
 * Built-in caption templates. The Owl House example from the brief is only
 * an EXAMPLE — everything here is template-driven and configurable.
 */
export const BUILTIN_TEMPLATES = {
  aesthetic: `╭━━━ ⋆｡˚❀˚｡⋆ ━━━╮
💠 {{styled_character}}
╰━━━ ⋆｡˚❀˚｡⋆ ━━━╯

╭───────────────╮
│ 💠 𝐒𝐓𝐈𝐂𝐊𝐄𝐑𝐒  •  {{stickers}}
│ 📦 𝐏𝐀𝐂𝐊𝐒       •  {{packs}}
╰───────────────╯

╭─━━━━━━━♡━━━━━━━─╮
✨ {{headline}} ✨
╰─━━━━━━━♡━━━━━━━─╯

{{description}}

   💌 {{cta}}

╭───────────────╮
❤️ 𝐒𝐇𝐀𝐑𝐄   •   💠 𝐑𝐄𝐀𝐂𝐓
🌸 𝐅𝐎𝐋𝐋𝐎𝐖
╰───────────────╯

    𓆩♡𓆪 𝐂𝐑𝐄𝐀𝐓𝐄𝐃 & 𝐃𝐄𝐒𝐈𝐆𝐍𝐄𝐃 𝐁𝐘
          {{footer}}`,

  default: `╭━━━ ⋆｡˚❀˚｡⋆ ━━━╮
💠 {{styled_character}}
╰━━━ ⋆｡˚❀˚｡⋆ ━━━╯

╭───────────────╮
│ 💠 𝐒𝐓𝐈𝐂𝐊𝐄𝐑𝐒  •  {{stickers}}
│ 📦 𝐏𝐀𝐂𝐊𝐒       •  {{packs}}
╰───────────────╯

╭─━━━━━━━♡━━━━━━━─╮
✨ {{headline}} ✨
╰─━━━━━━━♡━━━━━━━─╯

{{description}}

   💌 {{cta}}

╭───────────────╮
❤️ 𝐒𝐇𝐀𝐑𝐄   •   💠 𝐑𝐄𝐀𝐂𝐓
🌸 𝐅𝐎𝐋𝐋𝐎𝐖
╰───────────────╯

    𓆩♡𓆪 𝐂𝐑𝐄𝐀𝐓𝐄𝐃 & 𝐃𝐄𝐒𝐈𝐆𝐍𝐄𝐃 𝐁𝐘
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

{{footer}}`,

  badass: `╭─── ⚔️ ⋆｡˚✦˚｡⋆ ⚔️ ───╮
  🗡️ {{styled_title}}
╰─── ⚔️ ⋆｡˚✦˚｡⋆ ⚔️ ───╯

╭──────────────╮
│ ⚔️ 𝐒𝐓𝐈𝐂𝐊𝐄𝐑𝐒 • {{stickers}}
│ 📦 𝐏𝐀𝐂𝐊𝐒 • {{packs}}
╰──────────────╯

╭─── ⋆｡˚⚔️˚｡⋆ ───╮
  ✨ {{headline}} ✨
╰─── ⋆｡˚⚔️˚｡⋆ ───╯

{{description}}

💌 {{cta}}

╭──────────────╮
│ ❤️ 𝐒𝐇𝐀𝐑𝐄 • ⚔️ 𝐑𝐄𝐀𝐂𝐓
│ 🌸 𝐅𝐎𝐋𝐋𝐎𝐖
╰──────────────╯

    𓆩♡𓆪 𝐂𝐑𝐄𝐀𝐓𝐄𝐃 & 𝐃𝐄𝐒𝐈𝐆𝐍𝐄𝐃 𝐁𝐘
        {{footer}}`,

  blossom: `┏━━━━ 🌸 ━━━━┓
💠 {{styled_title}}
┗━━━━ 🌸 ━━━━┛

┌───────────────────┐
│ 💠 𝐒𝐓𝐈𝐂𝐊𝐄𝐑𝐒 • {{stickers}}
│ 📦 𝐏𝐀𝐂𝐊𝐒 • {{packs}}
└───────────────────┘

┌─── ⋆｡˚♡˚｡⋆ ───┐
│ ✨ {{headline}} ✨
└─── ⋆｡˚♡˚｡⋆ ───┘

{{description}}

💌 {{cta}}

┌───────────────────┐
│ ❤️ 𝐒𝐇𝐀𝐑𝐄 • 💠 𝐑𝐄𝐀𝐂𝐓
│ 🌸 𝐅𝐎𝐋𝐋𝐎𝐖
└───────────────────┘

    𓆩♡𓆪 𝐂𝐑𝐄𝐀𝐓𝐄𝐃 & 𝐃𝐄𝐒𝐈𝐆𝐍𝐄𝐃 𝐁𝐘
        {{footer}}`,

  cyber: `╔════ ✦ ════╗
  ✦ {{styled_title}} ✦
╚════ ✦ ════╝

┌───────────────────┐
│ ✦ 𝐒𝐓𝐈𝐂𝐊𝐄𝐑𝐒 • {{stickers}}
│ 📦 𝐏𝐀𝐂𝐊𝐒 • {{packs}}
└───────────────────┘

┏─── ⋆｡˚★˚｡⋆ ───┓
  ✨ {{headline}} ✨
┗─── ⋆｡˚★˚｡⋆ ───┛

{{description}}

💌 {{cta}}

┌───────────────────┐
│ ❤️ 𝐒𝐇𝐀𝐑𝐄 • ✦ 𝐑𝐄𝐀𝐂𝐓
│ 🌸 𝐅𝐎𝐋𝐋𝐎𝐖
└───────────────────┘

    𓆩♡𓆪 𝐂𝐑𝐄𝐀𝐓𝐄𝐃 & 𝐃𝐄𝐒𝐈𝐆𝐍𝐄𝐃 𝐁𝐘
        {{footer}}`,

  royal: `⚜️ ━━━━━ ✦ ━━━━━ ⚜️
  👑 {{styled_title}}
⚜️ ━━━━━ ✦ ━━━━━ ⚜️

╭──────────────╮
│ ⚜️ 𝐒𝐓𝐈𝐂𝐊𝐄𝐑𝐒 • {{stickers}}
│ 📦 𝐏𝐀𝐂𝐊𝐒 • {{packs}}
╰──────────────╯

╭─── ⋆｡˚👑˚｡⋆ ───╮
  ✨ {{headline}} ✨
╰─── ⋆｡˚👑˚｡⋆ ───╯

{{description}}

💌 {{cta}}

╭──────────────╮
│ ❤️ 𝐒𝐇𝐀𝐑𝐄 • ⚜️ 𝐑𝐄𝐀𝐂𝐓
│ 🌸 𝐅𝐎𝐋𝐋𝐎𝐖
╰──────────────╯

    𓆩♡𓆪 𝐂𝐑𝐄𝐀𝐓𝐄𝐃 & 𝐃𝐄𝐒𝐈𝐆𝐍𝐄𝐃 𝐁𝐘
        {{footer}}`,

  bloom_crating: `˚ ༘♡ ⋆｡˚ ❀ ˚ ༘♡ ⋆｡˚
🌸 {{styled_character}} 🌸
    ─── ⋆⋅ 𓆩♡𓆪 ⋅⋆ ───

  ┌ 🦋 {{kind_label}} ┈ {{stickers}}
  ├ 🎀 𝐏𝐀𝐂𝐊𝐒  ┈ {{packs}}
  └ ✨ 𝐕𝐈𝐁𝐄𝐒  ┈ {{vibes}}

꒰ა {{tagline_styled}} ໒꒱

{{description}}

  ╭──────────────────╮
     🎀 𝐓𝐀𝐏 • 𝐀𝐃𝐃 • 𝐄𝐍𝐉𝐎𝐘
  ╰──────────────────╯

   💕 𝐒𝐡𝐚𝐫𝐞  |  🌸 𝐑𝐞𝐚𝐜𝐭  |  🦋 𝐅𝐨𝐥𝐥𝐨𝐰
     crafted by • {{footer_smallcaps}} 🌺`,

  angelic_ribbon: `︵‿︵‿୨♡୧‿︵‿︵
🎀 {{styled_character}} 🎀
   ┄┄┄ ୨୧ ┄┄┄

  ╭ 🕊 {{kind_label}} : {{stickers}}
  ├ 🌸 𝐏𝐀𝐂𝐊𝐒   : {{packs}}
  ╰ ✨ 𝐕𝐈𝐁𝐄𝐒   : {{vibes}}

꒰ {{tagline_styled}} ꒱

{{description}}

  [ ✦ 𝐓𝐀𝐏 𝐁𝐄𝐋𝐎𝐖 𝐓𝐎 𝐀𝐃𝐃 ✦ ]
    crafted by • {{footer_smallcaps}} 🤍`,

  dark_luxe: `━━━━━━ ⋆⋅ ❖ ⋅⋆ ━━━━━━
  🖤 {{styled_title}} 🖤
━━━━━━ ⋆⋅ ❖ ⋅⋆ ━━━━━━

  ┌ 🗡 {{kind_label}} ┈ {{stickers}}
  ├ 🕯 𝐏𝐀𝐂𝐊𝐒  ┈ {{packs}}
  └ 🥀 𝐀𝐔𝐑𝐀   ┈ {{vibes}}

{{description}}

  ╭──────────────────╮
     🖤 𝐈𝐍𝐒𝐓𝐀𝐋𝐋 • 𝐅𝐋𝐄𝐗 • 𝐄𝐍𝐉𝐎𝐘
  ╰──────────────────╯
    curated by • {{footer_smallcaps}} ❖`,

  minimal_pill: `✦ {{styled_character}}
{{kind_label}} • {{stickers}}  |  𝐏𝐀𝐂𝐊𝐒 • {{packs}}

{{description}}

  ── 🎀 𝐓𝐀𝐏 • 𝐀𝐃𝐃 • 𝐄𝐍𝐉𝐎𝐘 ──
    by {{footer_smallcaps}} ♡`,

  y2k_pixel: `*:･ﾟ✧*:･ﾟ✧ ₊˚⊹ 👾 ⊹˚₊
★ {{styled_title}} ★
   ══════════════

  ▸ 💎 {{kind_label}} [ {{stickers}} ]
  ▸ 🪩 𝐏𝐀𝐂𝐊𝐒 [ {{packs}} ]
  ▸ ⚡ 𝐌𝐎𝐎𝐃  [ {{vibes}} ]

{{description}}

  [̲̅T][̲̅A][̲̅P] • [̲̅A][̲̅D][̲̅D] • [̲̅E][̲̅N][̲̅J][̲̅O][̲̅Y]
   made by • {{footer_smallcaps}} 👾`
};

/** Template store: built-ins + unlimited user/AI templates persisted in the DB. */
export class TemplateStore {
  constructor(db, { userId = null } = {}) {
    this.db = db;
    this.userId = userId;
  }

  get(name) {
    if (this.db && this.userId != null) {
      const custom = this.db.get(
        'SELECT template FROM caption_templates WHERE name = ? AND user_id = ? ORDER BY id DESC LIMIT 1',
        name, this.userId
      );
      if (custom?.template) return custom.template;
    }
    if (BUILTIN_TEMPLATES[name]) return BUILTIN_TEMPLATES[name];
    const shared = this.db?.get(
      'SELECT template FROM caption_templates WHERE name = ? AND user_id IS NULL ORDER BY id DESC LIMIT 1',
      name
    );
    return shared?.template ?? null;
  }

  list() {
    const custom = this.db && this.userId != null
      ? this.db.all('SELECT name, is_default, created_at FROM caption_templates WHERE user_id = ? ORDER BY created_at DESC, id DESC', this.userId)
      : [];
    const customDefault = custom.some((r) => r.is_default);
    const seen = new Set();
    const out = [];
    for (const row of custom) {
      if (seen.has(row.name)) continue;
      seen.add(row.name);
      out.push({ name: row.name, builtin: false, is_default: Boolean(row.is_default) });
    }
    for (const name of Object.keys(BUILTIN_TEMPLATES)) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, builtin: true, is_default: !customDefault && name === 'bloom_crating' });
    }
    return out;
  }

  getDefaultName() {
    if (this.db && this.userId != null) {
      const row = this.db.get(
        'SELECT name FROM caption_templates WHERE user_id = ? AND is_default = 1 ORDER BY id DESC LIMIT 1',
        this.userId
      );
      if (row?.name) return row.name;
    }
    return 'bloom_crating';
  }

  save(name, template, { isDefault = false } = {}) {
    if (!this.db || this.userId == null) throw new Error('Template persistence requires a DB and user');
    const cleanName = String(name || '').trim().slice(0, 64);
    if (!cleanName) throw new Error('Template name is required');
    const existing = this.db.get(
      'SELECT id FROM caption_templates WHERE user_id = ? AND name = ? LIMIT 1',
      this.userId, cleanName
    );
    if (existing?.id) {
      this.db.run(
        'UPDATE caption_templates SET template = ?, is_default = ? WHERE id = ?',
        template, isDefault ? 1 : 0, existing.id
      );
    } else {
      this.db.run(
        'INSERT INTO caption_templates (user_id, name, template, is_default) VALUES (?, ?, ?, ?)',
        this.userId, cleanName, template, isDefault ? 1 : 0
      );
    }
    if (isDefault) {
      this.db.run('UPDATE caption_templates SET is_default = 0 WHERE user_id = ? AND name != ?', this.userId, cleanName);
    }
    return { name: cleanName, template, isDefault };
  }

  delete(name) {
    if (!this.db || this.userId == null || !name) return false;
    const res = this.db.run('DELETE FROM caption_templates WHERE user_id = ? AND name = ?', this.userId, name);
    return Number(res?.changes || 0) > 0;
  }
}
