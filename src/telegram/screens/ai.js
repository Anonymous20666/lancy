import { RichMessageBuilder, rt, richButton, encodeCallback } from '../rich.js';
import { navButtons, kvTable, banner, ACCENT, SPARK } from '../ui.js';
import { States } from '../../core/stateMachine.js';
import { truncate } from '../../utils/text.js';

const AI_STYLES = ['girly', 'soft', 'cute', 'elegant', 'gen-z', 'gothic', 'anime', 'minimal', 'premium', 'chaotic'];

/**
 * AI Assistant Screen — Aesthetic Human Support & Studio Operator.
 * Allows toggling AI on/off, managing conversation memory, styles,
 * and autonomous scheduled sticker drops.
 */
export function createAIScreen({ app }) {
  const id = 'ai';

  async function openScreen(ctx) {
    const userId = Number(ctx.tgId);
    await ctx.sm.transition(ctx.tgId, States.AI_CHAT, {
      context: { history: [] },
      chatId: ctx.chatId,
      screenMessageId: ctx.messageId
    });
    const enabled = ctx.settings.get('ai.assistantEnabled') ?? true;
    const style = ctx.settings.get('ai.style') ?? 'girly';
    const status = await app.ai.status().catch(() => ({ enabled: false }));
    const schedules = app.scheduler ? app.scheduler.getUserSchedules(userId) : [];
    const activeSchedules = schedules.filter((s) => s.status === 'active');

    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '𓆩♡𓆪 LANCY AI ASSISTANT 𓆩♡𓆪',
      'aesthetic creative bestie & studio operator ♡'
    ])));
    b.divider();

    b.table(kvTable([
      ['ʕ•ᴥ•ʔ Assistant', enabled ? '🟢 Active (Listening)' : '🔴 Inactive (Off)'],
      ['˙ᵕ˙ Provider', status.available ? `${status.provider} (${app.settings.get('ai.model') || 'local'})` : '🟡 fallback'],
      ['୨୧ Persona', style],
      ['⏰ Schedules', `${activeSchedules.length} active drop(s)`]
    ]), { compact: true });
    b.divider();

    b.paragraph(rt.bold('💬 HOW TO TALK TO ME:'));
    b.paragraph(rt.italic('> • Quote / reply to any bot or AI message in chat!'));
    b.paragraph(rt.italic('> • Or mention "lancy" in any message (e.g. "hey lancy...")'));
    b.paragraph(rt.italic('> • I can chat, search Pinterest, drop sticker packs,'));
    b.paragraph(rt.italic('>   paginate drops ("next"), and schedule daily autoposts! ♡'));
    b.divider();

    // Toggle button
    b.buttons([
      richButton.callback(
        enabled ? '🟢 AI Assistant: ON (Tap to Turn OFF)' : '🔴 AI Assistant: OFF (Tap to Turn ON)',
        encodeCallback(id, 'toggle'),
        { style: enabled ? 'success' : 'danger' }
      )
    ]);

    b.buttons([
      richButton.callback('💬 Chat with Lancy', encodeCallback(id, 'chat_prompt')),
      richButton.callback(`⏰ Schedules (${activeSchedules.length})`, encodeCallback(id, 'schedules'))
    ]);

    b.buttons([
      richButton.callback('🎀 Persona Style', encodeCallback(id, 'style_menu')),
      richButton.callback('🗑 Clear Memory', encodeCallback(id, 'clear'), { style: 'danger' })
    ]);

    b.buttons([
      richButton.callback('✦ Home', encodeCallback('dashboard', 'open'))
    ]);

    b.validate();
    return editOrSend(ctx, b.toJSON());
  }

  async function openSchedules(ctx) {
    const userId = Number(ctx.tgId);
    const schedules = app.scheduler ? app.scheduler.getUserSchedules(userId) : [];

    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '𓆩♡𓆪 SCHEDULED AUTOPOSTS 𓆩♡𓆪',
      'autonomous drops from Pinterest to WhatsApp ♡'
    ])));
    b.divider();

    if (!schedules.length) {
      b.paragraph(rt.italic('No scheduled drops yet!'));
      b.paragraph(rt.text('To schedule, chat with Lancy anytime:'));
      b.paragraph(rt.code('hey lancy, post random aura farming stickers twice per day for 30 days'));
    } else {
      for (const s of schedules.slice(0, 5)) {
        const statusEmoji = s.status === 'active' ? '🟢' : (s.status === 'paused' ? '⏸' : '✓');
        b.paragraph(rt.bold(`${statusEmoji} ${s.topic}`));
        b.quote(rt.concat(
          rt.text(`⏱ ${s.frequency_label}\n`),
          rt.text(`📊 Progress: ${s.runs_completed} of ${s.total_runs} drops completed`),
          s.status === 'active' ? rt.text(`\n⏳ Next drop: ${s.next_run_at ? new Date(s.next_run_at).toLocaleString() : 'soon'}`) : rt.text('')
        ));
        if (s.status === 'active') {
          b.buttons([
            richButton.callback('⏸ Pause', encodeCallback(id, 'sched_pause', String(s.id))),
            richButton.callback('🗑 Delete', encodeCallback(id, 'sched_del', String(s.id)), { style: 'danger' })
          ]);
        } else if (s.status === 'paused') {
          b.buttons([
            richButton.callback('▶ Resume', encodeCallback(id, 'sched_resume', String(s.id))),
            richButton.callback('🗑 Delete', encodeCallback(id, 'sched_del', String(s.id)), { style: 'danger' })
          ]);
        }
        b.divider();
      }
    }

    b.buttons([
      richButton.callback('← Back to AI Menu', encodeCallback(id, 'open')),
      richButton.callback('✦ Home', encodeCallback('dashboard', 'open'))
    ]);

    b.validate();
    return editOrSend(ctx, b.toJSON());
  }

  async function openStyleMenu(ctx) {
    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '𓆩♡𓆪 PERSONA STYLE 𓆩♡𓆪',
      'pick Lancy’s aesthetic vibe ♡'
    ])));
    b.divider();
    b.paragraph(rt.italic('Select an aesthetic personality style:'));
    for (let i = 0; i < AI_STYLES.length; i += 4) {
      b.buttons(AI_STYLES.slice(i, i + 4).map((s) =>
        richButton.callback(s, encodeCallback(id, 'set_style', s))));
    }
    b.divider();
    b.buttons([
      richButton.callback('← Back to AI Menu', encodeCallback(id, 'open'))
    ]);
    b.validate();
    return editOrSend(ctx, b.toJSON());
  }

  async function editOrSend(ctx, rich) {
    return ctx.editScreen(rich);
  }

  function registerStateHandlers(sm) {
    sm.register(States.AI_CHAT, {
      onMessage: async (sctx, message) => {
        const text = (message.text ?? '').trim();
        if (!text) return false;
        if (app.assistant) {
          const ctx = (typeof app.telegram?.controller?.createContext === 'function')
            ? app.telegram.controller.createContext(sctx.tgId, { message, chatId: sctx.chatId })
            : (typeof app.telegram?.createContext === 'function')
              ? app.telegram.createContext(sctx.tgId, { message, chatId: sctx.chatId })
              : sctx;
          ctx.sm = sm;
          ctx.message = message;
          await app.assistant.handleMessage({ ctx, message, text });
        }
        return true;
      },
      onTimeout: async (sctx) => {
        await app.telegram.api.sendMessage(sctx.chatId, '♡ our chat timed out — say hi again ♡').catch(() => {});
      }
    });
  }

  return {
    id,
    registerStateHandlers,
    async open(ctx) {
      await openScreen(ctx);
    },
    async handle(ctx, action, args) {
      const userId = Number(ctx.tgId);
      switch (action) {
        case 'open':
          return openScreen(ctx);
        case 'toggle': {
          const current = ctx.settings.get('ai.assistantEnabled') ?? true;
          const nextVal = !current;
          ctx.settings.set('ai.assistantEnabled', nextVal);
          if (ctx.query?.id) await ctx.api.answerCallbackQuery(ctx.query.id, { text: nextVal ? '🟢 AI Assistant turned ON ♡' : '🔴 AI Assistant turned OFF ♡' });
          return openScreen(ctx);
        }
        case 'chat_prompt': {
          await ctx.sm.transition(ctx.tgId, States.AI_CHAT, {
            context: {},
            chatId: ctx.chatId,
            screenMessageId: ctx.messageId
          });
          return ctx.reply('heyyy bestie ♡ tell me what’s on your mind or what you want to create today! ✨');
        }
        case 'schedules':
          return openSchedules(ctx);
        case 'sched_pause': {
          const schedId = Number(args[0]);
          app.scheduler?.pauseSchedule(schedId, userId);
          if (ctx.query?.id) await ctx.api.answerCallbackQuery(ctx.query.id, { text: '⏸ Schedule paused ♡' });
          return openSchedules(ctx);
        }
        case 'sched_resume': {
          const schedId = Number(args[0]);
          app.scheduler?.resumeSchedule(schedId, userId);
          if (ctx.query?.id) await ctx.api.answerCallbackQuery(ctx.query.id, { text: '▶ Schedule resumed ♡' });
          return openSchedules(ctx);
        }
        case 'sched_del': {
          const schedId = Number(args[0]);
          app.scheduler?.deleteSchedule(schedId, userId);
          if (ctx.query?.id) await ctx.api.answerCallbackQuery(ctx.query.id, { text: '🗑 Schedule deleted ♡' });
          return openSchedules(ctx);
        }
        case 'style_menu':
          return openStyleMenu(ctx);
        case 'set_style': {
          const style = args[0];
          if (!AI_STYLES.includes(style)) return;
          ctx.settings.set('ai.style', style);
          if (ctx.query?.id) await ctx.api.answerCallbackQuery(ctx.query.id, { text: `♡ Style set to ${style} ♡` });
          return openScreen(ctx);
        }
        case 'clear':
          app.assistant?.clearHistory(userId);
          if (ctx.query?.id) await ctx.api.answerCallbackQuery(ctx.query.id, { text: '✓ Conversation memory cleared ♡' });
          return openScreen(ctx);
        case 'back':
        case 'cancel':
          await ctx.sm.cancel(ctx.tgId);
          return ctx.screens.get('dashboard').open(ctx);
        default:
          return openScreen(ctx);
      }
    }
  };
}
