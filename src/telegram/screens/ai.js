import { RichMessageBuilder, rt, richButton, encodeCallback } from '../rich.js';
import { navButtons, kvTable, ACCENT, SPARK } from '../ui.js';
import { States } from '../../core/stateMachine.js';
import { truncate } from '../../utils/text.js';

const AI_STYLES = ['girly', 'soft', 'cute', 'elegant', 'gen-z', 'gothic', 'anime', 'minimal', 'premium', 'chaotic'];

/**
 * AI Assistant screen — a chat that feels like talking to Lancy.
 * The AI runs in its own worker and never blocks anything else.
 * It can suggest and write — it can never publish or change security.
 */
export function createAIScreen({ app }) {
  const id = 'ai';

  async function openChat(ctx) {
    const status = await app.ai.status().catch(() => ({ enabled: false }));
    await ctx.sm.transition(ctx.tgId, States.AI_CHAT, {
      context: { history: [] },
      chatId: ctx.chatId,
      screenMessageId: ctx.messageId
    });
    const b = new RichMessageBuilder();
    b.heading(`${SPARK} AI ASSISTANT`, 1);
    b.table(kvTable([
      ['Status', status.enabled ? (status.available ? '🟢 online' : '🟡 fallback mode') : 'off'],
      ['Provider', status.provider ?? '—'],
      ['Style', ctx.settings.get('ai.style') ?? 'girly']
    ]), { compact: true });
    b.divider();
    b.paragraph(rt.italic('talk to me ♡ I can write captions, titles, descriptions — or just chat.'));
    b.paragraph(rt.italic('I never publish anything or change security settings — that is always you ♡'));
    b.divider();
    b.paragraph(rt.bold('styles:'));
    for (let i = 0; i < AI_STYLES.length; i += 4) {
      b.buttons(AI_STYLES.slice(i, i + 4).map((s) =>
        richButton.callback(s, encodeCallback(id, 'style', s))));
    }
    b.divider();
    b.paragraph(rt.italic('quick actions:'));
    b.buttons([
      richButton.callback('✦ Caption', encodeCallback(id, 'action', 'caption')),
      richButton.callback('♡ Title', encodeCallback(id, 'action', 'title')),
      richButton.callback('✎ Rewrite', encodeCallback(id, 'action', 'rewrite'))
    ]);
    b.buttons([
      richButton.callback('🗑 Clear Chat', encodeCallback(id, 'clear')),
      richButton.callback('✦ Home', encodeCallback('dashboard', 'open'))
    ]);
    b.validate();
    await editOrSend(ctx, b.toJSON());
  }

  async function editOrSend(ctx, rich) {
    if (ctx.messageId && ctx.message) {
      await ctx.api.editMessageRich(ctx.chatId, ctx.messageId, rich).catch(async () => {
        await ctx.api.sendRichMessage(ctx.chatId, rich);
      });
    } else {
      await ctx.api.sendRichMessage(ctx.chatId, rich);
    }
  }

  async function onChatMessage(sctx, text) {
    const history = (sctx.context.history ?? []).slice(-10);
    await app.telegram.api.sendChatAction(sctx.chatId, 'typing');
    try {
      const { text: reply, provider } = await app.ai.chat(text, {
        style: app.settings.get('ai.style'),
        history
      });
      history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
      sctx.update({ history });
      await app.telegram.api.sendMessage(sctx.chatId, reply);
    } catch (error) {
      await app.telegram.api.sendMessage(sctx.chatId, `♡ ${error?.userMessage ?? 'the AI is resting right now — try again in a moment.'}`);
    }
  }

  async function onQuickAction(ctx, action) {
    const prompts = {
      caption: 'write a caption for a sticker pack about "gojo" — 80 stickers, cute but not cringe',
      title: 'suggest a cute pack title for "gojo" stickers',
      rewrite: 'rewrite this more elegantly: "lol this pack is so cute download it"'
    };
    await ctx.sm.transition(ctx.tgId, States.AI_CHAT, {
      context: { history: [] },
      chatId: ctx.chatId,
      screenMessageId: ctx.messageId
    });
    await ctx.reply('♡ thinking…');
    try {
      const { text: reply } = await app.ai.chat(prompts[action], { style: ctx.settings.get('ai.style') });
      await ctx.reply(reply);
    } catch (error) {
      await ctx.reply('♡ the AI is resting — try again in a moment.');
    }
  }

  function registerStateHandlers(sm) {
    sm.register(States.AI_CHAT, {
      onMessage: async (sctx, message) => {
        const text = (message.text ?? '').trim();
        if (!text) return false;
        await onChatMessage(sctx, text);
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
      await openChat(ctx);
    },
    async handle(ctx, action, args) {
      switch (action) {
        case 'open':
          return openChat(ctx);
        case 'style': {
          const style = args[0];
          if (!AI_STYLES.includes(style)) return;
          const result = ctx.settings.set('ai.style', style);
          if (result.hotReloaded) app.ai.reconfigure?.();
          await ctx.reply(`♡ style set to ${style}${result.restartRequired ? ' (applies after restart)' : ''} ♡`);
          return openChat(ctx);
        }
        case 'action':
          return onQuickAction(ctx, args[0]);
        case 'clear':
          await ctx.sm.update(ctx.tgId, { history: [] });
          return ctx.reply('♡ chat cleared ♡');
        case 'back':
        case 'cancel':
          await ctx.sm.cancel(ctx.tgId);
          return ctx.screens.get('dashboard').open(ctx);
        default:
          return openChat(ctx);
      }
    }
  };
}
