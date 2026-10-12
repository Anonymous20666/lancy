import { RichMessageBuilder, rt, richButton, encodeCallback } from '../rich.js';
import { navButtons, banner, ACCENT, SPARK } from '../ui.js';
import { States } from '../../core/stateMachine.js';
import { logger } from '../../core/logger.js';

/**
 * Helper to format "HH:MM" (24h) into clean 12-hour AM/PM string.
 */
function formatTime12h(timeStr = '09:00') {
  const parts = String(timeStr).split(':');
  let h = Number(parts[0]) || 0;
  const m = Number(parts[1]) || 0;
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  h = h ? h : 12;
  const mPad = String(m).padStart(2, '0');
  return `${h}:${mPad} ${ampm}`;
}

/**
 * Adds or subtracts minutes from a "HH:MM" string, wrapping around 24 hours.
 */
function adjustTime(timeStr = '09:00', deltaMinutes = 0) {
  const parts = String(timeStr).split(':');
  let h = Number(parts[0]) || 0;
  let m = Number(parts[1]) || 0;

  let total = h * 60 + m + deltaMinutes;
  while (total < 0) total += 24 * 60;
  total = total % (24 * 60);

  const newH = Math.floor(total / 60);
  const newM = total % 60;
  return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`;
}

/**
 * AutoPost screen — wizard to schedule multi-day automated sticker drops across WhatsApp & Telegram channels.
 */
export function createAutoPostScreen({ app }) {
  const id = 'autopost';
  const log = logger().child({ screen: 'autopost' });

  // In-memory per-user wizard selection state
  const selections = new Map();

  function getSelection(tgId) {
    const key = String(tgId);
    let sel = selections.get(key);
    if (!sel) {
      sel = {
        platform: 'telegram', // 'telegram' | 'whatsapp' | 'both'
        tgChannels: [],
        waChannels: [],
        days: 5,
        timesPerDay: 2,
        slots: {
          morning: '09:00',
          afternoon: '14:00',
          evening: '20:00'
        },
        activeClockSlot: 'morning',
        contentMode: 'ai', // 'ai' | 'packs'
        selectedPackIds: [],
        aiTopic: 'Aesthetic Anime Art',
        aiPrompt: null,
        customCaption: null
      };
      selections.set(key, sel);
    }
    return sel;
  }

  function clearSelection(tgId) {
    selections.delete(String(tgId));
  }

  async function editOrSend(ctx, rich, files = null) {
    if (typeof ctx?.editScreen === 'function') {
      return ctx.editScreen(rich, {}, files);
    }
    const chatId = ctx?.chat?.id ?? ctx?.chatId ?? ctx?.from?.id ?? ctx?.tgId;
    const messageId = ctx?.message?.message_id ?? ctx?.messageId ?? ctx?.sm?.context?.(ctx?.tgId)?.screenMessageId;
    if (messageId && chatId) {
      try {
        return await app.telegram.api.editMessageRich(chatId, messageId, rich, {}, files);
      } catch (err) {
        if (!/message is not modified/i.test(err?.message)) {
          return await app.telegram.api.sendRichMessage(chatId, rich, {}, files);
        }
        return;
      }
    }
    if (chatId) {
      return await app.telegram.api.sendRichMessage(chatId, rich, {}, files);
    }
  }

  // ── Step 1: Platform Selection ─────────────────────────────────────────
  async function renderPlatformPicker(ctx) {
    const tgId = String(ctx.tgId);
    const sel = getSelection(tgId);

    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '𓆩♡𓆪 AUTO POST SCHEDULER 𓆩♡𓆪',
      'step 1 of 5 — choose destination platform ♡'
    ])));
    b.divider();
    b.paragraph(rt.italic('Schedule automated sticker drops across your channels! Pick where to post:'));

    const isTg = sel.platform === 'telegram';
    const isWa = sel.platform === 'whatsapp';
    const isBoth = sel.platform === 'both';

    b.buttons([
      richButton.callback(`${isTg ? '🔘' : '⚪'} 📢 Telegram Channels`, encodeCallback(id, 'set_platform', 'telegram'), {
        style: isTg ? 'success' : 'primary'
      })
    ]);
    b.buttons([
      richButton.callback(`${isWa ? '🔘' : '⚪'} 📱 WhatsApp Channels`, encodeCallback(id, 'set_platform', 'whatsapp'), {
        style: isWa ? 'success' : 'primary'
      })
    ]);
    b.buttons([
      richButton.callback(`${isBoth ? '🔘' : '⚪'} 🌐 Both (Cross-Post TG & WA)`, encodeCallback(id, 'set_platform', 'both'), {
        style: isBoth ? 'success' : 'primary'
      })
    ]);

    b.divider();
    b.buttons([
      richButton.callback('Next: Target Channels ➔', encodeCallback(id, 'to_channels'), { style: 'success' })
    ]);
    b.buttons([
      richButton.callback('📋 My Active Schedules', encodeCallback(id, 'view_schedules')),
      richButton.callback('🏠 Home', encodeCallback('dashboard', 'open'))
    ]);
    b.validate();
    return editOrSend(ctx, b.toJSON());
  }

  // ── Step 2: Channel Selection ──────────────────────────────────────────
  async function renderChannelPicker(ctx) {
    const tgId = String(ctx.tgId);
    const userId = Number(tgId);
    const sel = getSelection(tgId);

    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '𓆩♡𓆪 TARGET CHANNELS 𓆩♡𓆪',
      'step 2 of 5 — pick destination channels ♡'
    ])));
    b.divider();

    // 1. Telegram Channels
    if (sel.platform === 'telegram' || sel.platform === 'both') {
      b.heading('📢 TELEGRAM CHANNELS', 3);
      const tgChs = app.db.getTelegramChannels(userId);

      if (!tgChs.length) {
        b.paragraph(rt.text('No Telegram channels connected yet! Add the bot as an Administrator in your channel, or tap "➕ Add TG Channel" below.'));
      } else {
        for (const ch of tgChs) {
          const isSelected = sel.tgChannels.includes(ch.channel_id);
          const radio = isSelected ? '🔘' : '⚪';
          const tag = ch.username ? `@${ch.username}` : `ID: ${ch.channel_id}`;
          b.buttons([
            richButton.callback(`${radio} ${ch.title} (${tag})`, encodeCallback(id, 'toggle_tg_ch', ch.channel_id), {
              style: isSelected ? 'success' : 'primary'
            })
          ]);
        }
      }

      b.buttons([
        richButton.callback('➕ Add TG Channel', encodeCallback('channel_post', 'add_channel'))
      ]);
      b.divider();
    }

    // 2. WhatsApp Channels
    if (sel.platform === 'whatsapp' || sel.platform === 'both') {
      b.heading('📱 WHATSAPP CHANNELS', 3);
      const waSessions = app.whatsapp?.listSessions?.()?.filter((s) => s.userId === userId && s.status === 'online') || [];
      const waChs = [];
      for (const s of waSessions) {
        const list = app.channels?.list?.(s.sessionId) || [];
        for (const c of list) {
          waChs.push({ ...c, sessionId: s.sessionId });
        }
      }

      if (!waChs.length) {
        b.paragraph(rt.text('No WhatsApp channels found for active sessions. Make sure your WhatsApp session is online in WhatsApp Studio.'));
      } else {
        for (const ch of waChs) {
          const isSelected = sel.waChannels.includes(ch.channel_jid);
          const radio = isSelected ? '🔘' : '⚪';
          b.buttons([
            richButton.callback(`${radio} 📱 ${ch.name || ch.channel_jid}`, encodeCallback(id, 'toggle_wa_ch', ch.channel_jid), {
              style: isSelected ? 'success' : 'primary'
            })
          ]);
        }
      }
      b.divider();
    }

    const hasAny = (sel.tgChannels.length > 0 || sel.waChannels.length > 0);

    if (hasAny) {
      b.buttons([
        richButton.callback('Next: Schedule Days ➔', encodeCallback(id, 'to_days'), { style: 'success' })
      ]);
    }

    b.buttons([
      richButton.callback('« Platform', encodeCallback(id, 'open')),
      richButton.callback('🏠 Home', encodeCallback('dashboard', 'open'))
    ]);
    b.validate();
    return editOrSend(ctx, b.toJSON());
  }

  // ── Step 3: Days Selection (Calendar) ──────────────────────────────────
  async function renderDaysPicker(ctx) {
    const tgId = String(ctx.tgId);
    const sel = getSelection(tgId);

    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '𓆩♡𓆪 SCHEDULE DURATION 𓆩♡𓆪',
      'step 3 of 5 — how many days? ♡'
    ])));
    b.divider();

    const endDate = new Date(Date.now() + (sel.days || 5) * 86400 * 1000).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric'
    });

    b.paragraph(rt.concat(
      rt.bold('Active Duration: '), rt.text(`${sel.days} Days\n`),
      rt.bold('Schedule Window: '), rt.text(`Today until ${endDate} ♡`)
    ));
    b.spacer();
    b.paragraph(rt.italic('Pick your campaign duration using the quick buttons below:'));

    const is5 = sel.days === 5;
    const is10 = sel.days === 10;
    const is20 = sel.days === 20;
    const is30 = sel.days === 30;

    b.buttons([
      richButton.callback(`${is5 ? '🔘' : '⚪'} 5 Days`, encodeCallback(id, 'set_days', 5), { style: is5 ? 'success' : 'primary' }),
      richButton.callback(`${is10 ? '🔘' : '⚪'} 10 Days`, encodeCallback(id, 'set_days', 10), { style: is10 ? 'success' : 'primary' })
    ]);
    b.buttons([
      richButton.callback(`${is20 ? '🔘' : '⚪'} 20 Days`, encodeCallback(id, 'set_days', 20), { style: is20 ? 'success' : 'primary' }),
      richButton.callback(`${is30 ? '🔘' : '⚪'} 30 Days (Select All)`, encodeCallback(id, 'set_days', 30), { style: is30 ? 'success' : 'primary' })
    ]);
    b.buttons([
      richButton.callback('✏️ Custom Days...', encodeCallback(id, 'custom_days'))
    ]);

    b.divider();
    b.buttons([
      richButton.callback('Next: Times Per Day ➔', encodeCallback(id, 'to_slots'), { style: 'success' })
    ]);
    b.buttons([
      richButton.callback('« Channels', encodeCallback(id, 'to_channels')),
      richButton.callback('🏠 Home', encodeCallback('dashboard', 'open'))
    ]);
    b.validate();
    return editOrSend(ctx, b.toJSON());
  }

  // ── Step 4: Times Per Day & Slots Overview ─────────────────────────────
  async function renderSlotsPicker(ctx) {
    const tgId = String(ctx.tgId);
    const sel = getSelection(tgId);

    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '𓆩♡𓆪 POST FREQUENCY & TIMES 𓆩♡𓆪',
      'step 4 of 5 — set post times per day ♡'
    ])));
    b.divider();

    b.paragraph(rt.italic('How many times per day do you want the bot to post?'));

    const is1 = sel.timesPerDay === 1;
    const is2 = sel.timesPerDay === 2;
    const is3 = sel.timesPerDay === 3;

    b.buttons([
      richButton.callback(`${is1 ? '🔘' : '⚪'} 1 Post / Day`, encodeCallback(id, 'set_freq', 1), { style: is1 ? 'success' : 'primary' }),
      richButton.callback(`${is2 ? '🔘' : '⚪'} 2 Posts / Day`, encodeCallback(id, 'set_freq', 2), { style: is2 ? 'success' : 'primary' }),
      richButton.callback(`${is3 ? '🔘' : '⚪'} 3 Posts / Day`, encodeCallback(id, 'set_freq', 3), { style: is3 ? 'success' : 'primary' })
    ]);

    b.divider();
    b.heading('⏰ ACTIVE TIME SLOTS', 3);

    // Slot 1: Morning
    const mStr = formatTime12h(sel.slots.morning);
    b.paragraph(rt.concat(rt.bold('🌅 Morning: '), rt.text(`${mStr} (${sel.slots.morning})`)));
    b.buttons([
      richButton.callback(`🌅 Adjust Morning Clock (${mStr})`, encodeCallback(id, 'open_clock', 'morning'), { style: 'primary' })
    ]);

    // Slot 2: Afternoon (if >= 2)
    if (sel.timesPerDay >= 2) {
      const aStr = formatTime12h(sel.slots.afternoon);
      b.paragraph(rt.concat(rt.bold('☀️ Afternoon: '), rt.text(`${aStr} (${sel.slots.afternoon})`)));
      b.buttons([
        richButton.callback(`☀️ Adjust Afternoon Clock (${aStr})`, encodeCallback(id, 'open_clock', 'afternoon'), { style: 'primary' })
      ]);
    }

    // Slot 3: Evening (if >= 3)
    if (sel.timesPerDay >= 3) {
      const eStr = formatTime12h(sel.slots.evening);
      b.paragraph(rt.concat(rt.bold('🌙 Evening: '), rt.text(`${eStr} (${sel.slots.evening})`)));
      b.buttons([
        richButton.callback(`🌙 Adjust Evening Clock (${eStr})`, encodeCallback(id, 'open_clock', 'evening'), { style: 'primary' })
      ]);
    }

    const totalDrops = (sel.days || 5) * (sel.timesPerDay || 2);
    b.divider();
    b.paragraph(rt.concat(
      rt.bold('📊 Total Drops in Campaign: '),
      rt.bold(`${totalDrops} sticker packs `),
      rt.text('scheduled ♡')
    ));

    b.divider();
    b.buttons([
      richButton.callback('Next: Content Strategy ➔', encodeCallback(id, 'to_content'), { style: 'success' })
    ]);
    b.buttons([
      richButton.callback('« Days', encodeCallback(id, 'to_days')),
      richButton.callback('🏠 Home', encodeCallback('dashboard', 'open'))
    ]);
    b.validate();
    return editOrSend(ctx, b.toJSON());
  }

  // ── Step 4b: Interactive Clock Picker ─────────────────────────────────
  async function renderClockPicker(ctx, slotName = 'morning') {
    const tgId = String(ctx.tgId);
    const sel = getSelection(tgId);
    sel.activeClockSlot = slotName;

    const currentTime = sel.slots[slotName] || '09:00';
    const formatted = formatTime12h(currentTime);
    const slotLabel = slotName === 'morning' ? '🌅 MORNING' : slotName === 'afternoon' ? '☀️ AFTERNOON' : '🌙 EVENING';

    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '𓆩♡𓆪 CLOCK TIME PICKER 𓆩♡𓆪',
      `adjusting ${slotName} post time ♡`
    ])));
    b.divider();

    b.quote(rt.concat(
      rt.bold(`⏰ SET ${slotLabel} POST TIME\n\n`),
      rt.text('Current Setting: '), rt.bold(formatted), rt.text(` (${currentTime} 24h)\n\n`),
      rt.text('Use the buttons below to increase (+) or reduce (-) the posting time:')
    ));

    b.divider();
    // Buttons to add / reduce hours and minutes
    b.buttons([
      richButton.callback('🔼 +1 Hour', encodeCallback(id, 'clock_adj', slotName, 60)),
      richButton.callback('🔼 +15 Min', encodeCallback(id, 'clock_adj', slotName, 15))
    ]);
    b.buttons([
      richButton.callback('🔽 -1 Hour', encodeCallback(id, 'clock_adj', slotName, -60)),
      richButton.callback('🔽 -15 Min', encodeCallback(id, 'clock_adj', slotName, -15))
    ]);
    b.buttons([
      richButton.callback('🔼 +5 Min', encodeCallback(id, 'clock_adj', slotName, 5)),
      richButton.callback('🔽 -5 Min', encodeCallback(id, 'clock_adj', slotName, -5))
    ]);

    b.divider();
    b.buttons([
      richButton.callback(`✓ Done & Save ${slotLabel} (${formatted})`, encodeCallback(id, 'to_slots'), { style: 'success' })
    ]);
    b.validate();
    return editOrSend(ctx, b.toJSON());
  }

  // ── Step 5: Content Strategy (Existing Packs or AI Curator) ────────────
  async function renderContentPicker(ctx) {
    const tgId = String(ctx.tgId);
    const userId = Number(tgId);
    const sel = getSelection(tgId);
    const totalDrops = (sel.days || 5) * (sel.timesPerDay || 2);

    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '𓆩♡𓆪 CONTENT STRATEGY 𓆩♡𓆪',
      'step 5 of 5 — choose content source ♡'
    ])));
    b.divider();

    b.paragraph(rt.concat(
      rt.bold('Campaign Scale: '), rt.bold(`${totalDrops} posts needed `), rt.text(`(${sel.days} days × ${sel.timesPerDay}/day)\n`),
      rt.bold('Active Mode: '), rt.text(sel.contentMode === 'ai' ? '🪄 Autonomous AI Curator' : '📦 Curated Existing Packs')
    ));
    b.spacer();
    b.paragraph(rt.italic('How would you like the bot to supply sticker packs for this schedule?'));

    const isAi = sel.contentMode === 'ai';
    const isPacks = sel.contentMode === 'packs';

    b.buttons([
      richButton.callback(`${isAi ? '🔘' : '⚪'} 🪄 Ask AI / Auto-Generate Packs`, encodeCallback(id, 'set_content_ai'), {
        style: isAi ? 'success' : 'primary'
      })
    ]);

    b.buttons([
      richButton.callback(`${isPacks ? '🔘' : '⚪'} 📦 Select Existing Sticker Packs`, encodeCallback(id, 'set_content_packs'), {
        style: isPacks ? 'success' : 'primary'
      })
    ]);

    b.divider();

    if (isAi) {
      b.heading('🪄 AUTONOMOUS AI CURATION', 3);
      b.quote(rt.concat(
        rt.bold('Topic / Theme: '), rt.text(`${sel.aiTopic}\n`),
        rt.text('The AI will autonomously scour Pinterest, convert aesthetic media into HD packs, craft custom captions, and publish by the scheduled time!')
      ));
      b.buttons([
        richButton.callback('💬 Chat with AI to Customize Themes', encodeCallback(id, 'chat_ai'), { style: 'primary' })
      ]);
    } else {
      b.heading('📦 EXISTING PACK SELECTION', 3);
      const userPacks = app.packs.listPacks(userId, { limit: 10 }).packs;
      b.paragraph(rt.concat(
        rt.text('Selected Packs: '), rt.bold(`${sel.selectedPackIds.length} / ${totalDrops}`), rt.text(' selected.')
      ));
      for (const p of userPacks.slice(0, 5)) {
        const isSelected = sel.selectedPackIds.includes(p.id);
        const radio = isSelected ? '🔘' : '⚪';
        b.buttons([
          richButton.callback(`${radio} ${p.tg_title} (${p.count})`, encodeCallback(id, 'toggle_pack', p.id), {
            style: isSelected ? 'success' : 'primary'
          })
        ]);
      }
    }

    b.divider();
    b.buttons([
      richButton.callback('Next: Review & Confirm ➔', encodeCallback(id, 'to_preview'), { style: 'success' })
    ]);
    b.buttons([
      richButton.callback('« Post Times', encodeCallback(id, 'to_slots')),
      richButton.callback('🏠 Home', encodeCallback('dashboard', 'open'))
    ]);
    b.validate();
    return editOrSend(ctx, b.toJSON());
  }

  // ── Step 6: Review & Confirmation Preview ──────────────────────────────
  async function renderPreview(ctx) {
    const tgId = String(ctx.tgId);
    const sel = getSelection(tgId);
    const totalDrops = (sel.days || 5) * (sel.timesPerDay || 2);

    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '𓆩♡𓆪 CAMPAIGN SUMMARY 𓆩♡𓆪',
      'review schedule & launch ♡'
    ])));
    b.divider();

    const endDate = new Date(Date.now() + (sel.days || 5) * 86400 * 1000).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric'
    });

    const mTime = formatTime12h(sel.slots.morning);
    const aTime = sel.timesPerDay >= 2 ? ` • ☀️ ${formatTime12h(sel.slots.afternoon)}` : '';
    const eTime = sel.timesPerDay >= 3 ? ` • 🌙 ${formatTime12h(sel.slots.evening)}` : '';
    const slotsLine = `🌅 ${mTime}${aTime}${eTime}`;

    b.quote(rt.concat(
      rt.bold('🌐 Platforms: '), rt.text(`${(sel.platform || 'telegram').toUpperCase()}\n`),
      rt.bold('📅 Duration: '), rt.text(`${sel.days} Days (until ${endDate})\n`),
      rt.bold('⏰ Daily Schedule: '), rt.text(`${slotsLine}\n`),
      rt.bold('📦 Content Mode: '), rt.text(`${sel.contentMode === 'ai' ? `AI Curator ("${sel.aiTopic}")` : 'Curated Packs'}\n`),
      rt.bold('🚀 Total Drops: '), rt.bold(`${totalDrops} Posts Scheduled`)
    ));

    b.divider();
    b.buttons([
      richButton.callback('🚀 LAUNCH AUTO POST CAMPAIGN', encodeCallback(id, 'launch_campaign'), { style: 'success' })
    ]);
    b.buttons([
      richButton.callback('« Edit Slots', encodeCallback(id, 'to_slots')),
      richButton.callback('« Edit Content', encodeCallback(id, 'to_content'))
    ]);
    b.buttons([
      richButton.callback('✕ Cancel', encodeCallback(id, 'cancel'), { style: 'danger' })
    ]);
    b.validate();
    return editOrSend(ctx, b.toJSON());
  }

  // ── View Active Schedules ──────────────────────────────────────────────
  async function renderActiveSchedules(ctx) {
    const tgId = String(ctx.tgId);
    const userId = Number(tgId);
    const schedules = app.scheduler.getUserSchedules(userId);

    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '𓆩♡𓆪 MY ACTIVE SCHEDULES 𓆩♡𓆪',
      'campaign control center ♡'
    ])));
    b.divider();

    if (!schedules.length) {
      b.paragraph(rt.italic('You have no active auto-post schedules running.'));
    } else {
      for (const s of schedules) {
        const statusBadge = s.status === 'active' ? '🟢 Active' : s.status === 'paused' ? '⏸ Paused' : '✅ Completed';
        b.blockquote(
          `🌸 <b>${s.topic}</b> (${statusBadge})\n` +
          `• Progress: ${s.runs_completed} / ${s.total_runs} drops\n` +
          `• Next Drop: ${s.next_run_at ? new Date(s.next_run_at).toLocaleString() : 'Done'}`
        );
        b.buttons([
          s.status === 'active'
            ? richButton.callback('⏸ Pause', encodeCallback(id, 'pause_sched', s.id))
            : richButton.callback('▶ Resume', encodeCallback(id, 'resume_sched', s.id), { style: 'success' }),
          richButton.callback('🗑 Delete', encodeCallback(id, 'del_sched', s.id), { style: 'danger' })
        ]);
      }
    }

    b.divider();
    b.buttons([
      richButton.callback('➕ New Auto Post', encodeCallback(id, 'open'), { style: 'primary' }),
      richButton.callback('🏠 Home', encodeCallback('dashboard', 'open'))
    ]);
    b.validate();
    return editOrSend(ctx, b.toJSON());
  }

  // ── Launch Campaign Handler ───────────────────────────────────────────
  async function launchCampaign(ctx) {
    const tgId = String(ctx.tgId);
    const userId = Number(tgId);
    const sel = getSelection(tgId);

    const scheduleTimes = [sel.slots.morning];
    if (sel.timesPerDay >= 2) scheduleTimes.push(sel.slots.afternoon);
    if (sel.timesPerDay >= 3) scheduleTimes.push(sel.slots.evening);

    const freqLabel = `${sel.timesPerDay}× daily for ${sel.days} days (${scheduleTimes.map(formatTime12h).join(', ')})`;

    const tgChannelId = sel.tgChannels[0] || null;
    const waChannelJid = sel.waChannels[0] || null;

    const created = app.scheduler.createSchedule({
      userId,
      topic: sel.aiTopic || 'Aesthetic Stickers',
      frequencyLabel: freqLabel,
      timesPerDay: sel.timesPerDay,
      days: sel.days,
      platform: sel.platform,
      tgChannelId,
      channelJid: waChannelJid,
      packIds: sel.selectedPackIds,
      scheduleTimes,
      contentMode: sel.contentMode,
      customCaption: sel.customCaption,
      aiPrompt: sel.aiPrompt || sel.aiTopic,
      startImmediate: true
    });

    const bDone = new RichMessageBuilder();
    bDone.paragraph(rt.bold(banner([
      '🎉 CAMPAIGN LAUNCHED! 🎉',
      'auto posting is now live ♡'
    ])));
    bDone.divider();
    bDone.paragraph(rt.concat(
      rt.bold('Topic: '), rt.text(`${created.topic}\n`),
      rt.bold('Frequency: '), rt.text(`${created.frequency_label}\n`),
      rt.bold('Total Runs: '), rt.text(`${created.total_runs} posts scheduled\n`),
      rt.bold('First Run: '), rt.text('Initiating now in the background! ♡')
    ));
    bDone.divider();
    bDone.buttons([
      richButton.callback('📋 View Active Schedules', encodeCallback(id, 'view_schedules'), { style: 'primary' }),
      richButton.callback('🏠 Home', encodeCallback('dashboard', 'open'))
    ]);
    bDone.validate();
    await editOrSend(ctx, bDone.toJSON());

    clearSelection(tgId);
  }

  // ── State Machine Handlers ─────────────────────────────────────────────
  if (app.sm) {
    // Custom days number input handler
    app.sm.register(States.AUTOPOST_CUSTOM_DAYS, {
      onMessage: async (sctx, message) => {
        const text = (message.text ?? '').trim();
        const num = parseInt(text, 10);
        if (isNaN(num) || num < 1 || num > 365) {
          await app.telegram.api.sendMessage(sctx.chatId, '<blockquote>✕ Please send a valid number of days between 1 and 365 ♡</blockquote>', { parse_mode: 'HTML' });
          return true;
        }
        const sel = getSelection(sctx.tgId);
        sel.days = num;
        await app.sm.reset(sctx.tgId, { reason: 'custom-days-set' });
        await renderDaysPicker({ ...sctx, tgId: sctx.tgId });
        return true;
      }
    });

    // AI Chat Theme input handler
    app.sm.register(States.AUTOPOST_AI_CHAT, {
      onMessage: async (sctx, message) => {
        const text = (message.text ?? '').trim();
        if (!text) return false;
        const sel = getSelection(sctx.tgId);
        sel.aiTopic = text;
        sel.aiPrompt = text;
        await app.sm.reset(sctx.tgId, { reason: 'ai-theme-set' });

        await app.telegram.api.sendMessage(
          sctx.chatId,
          `<blockquote>✨ <b>Theme locked in: "${text}"!</b>\n\nI'll curate this aesthetic for the scheduled campaign! Returning to preview... ♡</blockquote>`,
          { parse_mode: 'HTML' }
        );
        await renderContentPicker({ ...sctx, tgId: sctx.tgId });
        return true;
      }
    });
  }

  // ── Screen Interface ───────────────────────────────────────────────────
  return {
    id,
    async open(ctx) {
      await renderPlatformPicker(ctx);
    },
    async handle(ctx, action, args = []) {
      const tgId = String(ctx.tgId);
      const sel = getSelection(tgId);

      switch (action) {
        case 'open':
          return renderPlatformPicker(ctx);

        case 'set_platform': {
          sel.platform = args[0] || 'telegram';
          return renderPlatformPicker(ctx);
        }

        case 'to_channels':
          return renderChannelPicker(ctx);

        case 'toggle_tg_ch': {
          const chId = Number(args[0]);
          if (sel.tgChannels.includes(chId)) {
            sel.tgChannels = sel.tgChannels.filter((c) => c !== chId);
          } else {
            sel.tgChannels.push(chId);
          }
          return renderChannelPicker(ctx);
        }

        case 'toggle_wa_ch': {
          const jid = args[0];
          if (sel.waChannels.includes(jid)) {
            sel.waChannels = sel.waChannels.filter((c) => c !== jid);
          } else {
            sel.waChannels.push(jid);
          }
          return renderChannelPicker(ctx);
        }

        case 'to_days':
          return renderDaysPicker(ctx);

        case 'set_days': {
          sel.days = Number(args[0]) || 5;
          return renderDaysPicker(ctx);
        }

        case 'custom_days': {
          await app.sm.transition(tgId, States.AUTOPOST_CUSTOM_DAYS, {
            chatId: ctx.chatId,
            screenMessageId: ctx.messageId
          });
          const b = new RichMessageBuilder();
          b.paragraph(rt.bold(banner([
            '𓆩♡𓆪 CUSTOM DURATION 𓆩♡𓆪',
            'type number of days ♡'
          ])));
          b.divider();
          b.paragraph(rt.text('Send the number of days you want to schedule (e.g. <code>7</code>, <code>14</code>, <code>45</code>):'));
          b.divider();
          b.buttons([
            richButton.callback('« Cancel', encodeCallback(id, 'to_days'))
          ]);
          b.validate();
          return editOrSend(ctx, b.toJSON());
        }

        case 'to_slots':
          return renderSlotsPicker(ctx);

        case 'set_freq': {
          sel.timesPerDay = Number(args[0]) || 2;
          return renderSlotsPicker(ctx);
        }

        case 'open_clock': {
          const slot = args[0] || 'morning';
          return renderClockPicker(ctx, slot);
        }

        case 'clock_adj': {
          const slot = args[0] || 'morning';
          const delta = Number(args[1]) || 0;
          sel.slots[slot] = adjustTime(sel.slots[slot], delta);
          return renderClockPicker(ctx, slot);
        }

        case 'to_content':
          return renderContentPicker(ctx);

        case 'set_content_ai': {
          sel.contentMode = 'ai';
          return renderContentPicker(ctx);
        }

        case 'set_content_packs': {
          sel.contentMode = 'packs';
          return renderContentPicker(ctx);
        }

        case 'toggle_pack': {
          const pId = Number(args[0]);
          if (sel.selectedPackIds.includes(pId)) {
            sel.selectedPackIds = sel.selectedPackIds.filter((p) => p !== pId);
          } else {
            sel.selectedPackIds.push(pId);
          }
          return renderContentPicker(ctx);
        }

        case 'chat_ai': {
          await app.sm.transition(tgId, States.AUTOPOST_AI_CHAT, {
            chatId: ctx.chatId,
            screenMessageId: ctx.messageId
          });
          const totalDrops = (sel.days || 5) * (sel.timesPerDay || 2);
          const b = new RichMessageBuilder();
          b.paragraph(rt.bold(banner([
            '𓆩♡𓆪 AI THEME BRIEF 𓆩♡𓆪',
            'chat with ai curator ♡'
          ])));
          b.divider();
          b.blockquote(
            `🪄 <b>Hi bestie! I see you are scheduling ${totalDrops} posts across ${sel.days} days!</b>\n\n` +
            `What aesthetic theme, characters, or vibes would you love me to curate for this campaign?\n\n` +
            `<i>(Examples: "Cute pastel anime", "Vintage cyberpunk", "Lofi cats", or "Surprise me with trending vibes")</i>`
          );
          b.divider();
          b.buttons([
            richButton.callback('« Cancel', encodeCallback(id, 'to_content'))
          ]);
          b.validate();
          return editOrSend(ctx, b.toJSON());
        }

        case 'to_preview':
          return renderPreview(ctx);

        case 'launch_campaign':
          return launchCampaign(ctx);

        case 'view_schedules':
          return renderActiveSchedules(ctx);

        case 'pause_sched': {
          const sId = Number(args[0]);
          app.scheduler.pauseSchedule(sId, Number(tgId));
          return renderActiveSchedules(ctx);
        }

        case 'resume_sched': {
          const sId = Number(args[0]);
          app.scheduler.resumeSchedule(sId, Number(tgId));
          return renderActiveSchedules(ctx);
        }

        case 'del_sched': {
          const sId = Number(args[0]);
          app.scheduler.deleteSchedule(sId, Number(tgId));
          return renderActiveSchedules(ctx);
        }

        case 'cancel':
          clearSelection(tgId);
          return ctx.screens.get('dashboard')?.open(ctx);

        default:
          return renderPlatformPicker(ctx);
      }
    }
  };
}
