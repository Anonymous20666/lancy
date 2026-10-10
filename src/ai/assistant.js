/**
 * Lancy AI Assistant — Conversational Human Support & Studio Operator.
 *
 * - Multi-turn memory per user (isolated).
 * - Human-like anime girl companion persona (natural pacing, authentic, aesthetic).
 * - Self-aware of bot powers: Pinterest HD search, URL downloader, sticker studio,
 *   WhatsApp channel publishing, and autonomous scheduler.
 * - Double-layered action triggering:
 *   1. Conversational intent triggers (e.g. "Send the pic", "drop pics", "show me")
 *      with multi-turn topic & character resolution.
 *   2. Action tags parsed directly from LLM generation ([ACTION: search_images query="..."]).
 * - Web browsing & lore research.
 */
import { WebBrowser } from './browse.js';
import { generateAuraCaption } from '../captions/engine.js';
import { States } from '../core/stateMachine.js';
import { logger } from '../core/logger.js';
import { ActionIndicator } from '../telegram/indicator.js';

export class LancyAssistant {
  constructor({ app, log } = {}) {
    this.app = app;
    this.db = app.db;
    this.browser = new WebBrowser();
    this.log = log ?? logger().child({ module: 'ai-assistant' });
  }

  /**
   * Save a message into persistent memory.
   */
  saveMessage(userId, role, content, metadata = {}) {
    this.db.run(
      'INSERT INTO ai_conversations (user_id, role, content, metadata_json) VALUES (?, ?, ?, ?)',
      Number(userId), role, String(content), JSON.stringify(metadata)
    );
  }

  /**
   * Fetch recent conversation history for user.
   */
  getHistory(userId, limit = 10) {
    const rows = this.db.all(
      `SELECT role, content FROM ai_conversations
       WHERE user_id = ?
       ORDER BY id DESC LIMIT ?`,
      Number(userId), limit
    );
    return rows.reverse();
  }

  /**
   * Clear conversation history for user.
   */
  clearHistory(userId) {
    this.db.run('DELETE FROM ai_conversations WHERE user_id = ?', Number(userId));
  }

  async #reply(ctx, text) {
    const msgId = ctx.message?.message_id ?? ctx.messageId;
    const chatId = ctx.chatId ?? Number(ctx.tgId);
    const api = ctx.api ?? this.app?.telegram?.api;

    // Sanitize any hallucinated markdown image tags (e.g. ![](https://open.spotify.com/...))
    const cleanText = String(text ?? '').replace(/!\[.*?\]\((https?:\/\/[^\s\)]+)\)/g, '$1');

    const extra = msgId ? {
      reply_parameters: {
        message_id: msgId,
        allow_sending_without_reply: true
      }
    } : {};

    if (/https?:\/\/[^\s]+/i.test(cleanText) && !extra.link_preview_options) {
      extra.link_preview_options = { is_disabled: false, prefer_large_media: true };
    }

    if (typeof ctx.reply === 'function') {
      try {
        return await ctx.reply(cleanText, extra);
      } catch {
        try {
          return await ctx.reply(cleanText, msgId ? { reply_to_message_id: msgId, allow_sending_without_reply: true } : {});
        } catch {
          return await ctx.reply(cleanText);
        }
      }
    }

    if (api) {
      try {
        return await api.sendMessage(chatId, cleanText, extra);
      } catch {
        try {
          return await api.sendMessage(chatId, cleanText, msgId ? { reply_to_message_id: msgId, allow_sending_without_reply: true } : {});
        } catch {
          return await api.sendMessage(chatId, cleanText);
        }
      }
    }
  }

  #getScreen(ctx, name) {
    return ctx?.screens?.get?.(name) ?? this.app?.screens?.get(name) ?? this.app?.telegram?.controller?.screens?.get(name);
  }

  sanitizeUserName(ctx) {
    const raw = ctx.user?.first_name || ctx.message?.from?.first_name || '';
    if (!raw) return 'bestie';
    const normalized = raw.normalize('NFKD').replace(/[^a-zA-Z0-9\s]/g, '').trim();
    const clean = normalized.split(/\s+/)[0];
    if (clean && clean.length >= 2) {
      return clean[0].toUpperCase() + clean.slice(1).toLowerCase();
    }
    return 'bestie';
  }

  #isMenuIntent(text) {
    const trimmed = String(text ?? '').trim();
    return /^(?:open\s+)?(?:my\s+)?(?:menu|dashboard|main\s+menu|home)$/i.test(trimmed) ||
      /^(?:open\s+)?(?:the\s+)?(?:stickers?|sticker\s+studio)$/i.test(trimmed) ||
      /^(?:open\s+)?(?:the\s+)?(?:whatsapp|wa|channels?)$/i.test(trimmed) ||
      /^(?:open\s+)?(?:the\s+)?(?:downloader|download\s+menu)$/i.test(trimmed) ||
      /^(?:open\s+)?(?:the\s+)?(?:settings|config)$/i.test(trimmed) ||
      /^(?:open\s+)?(?:the\s+)?(?:help|guide)$/i.test(trimmed) ||
      /^(?:cancel|stop|cancel\s+operation)$/i.test(trimmed);
  }

  async #handleMenu(ctx, userId, text) {
    const trimmed = String(text ?? '').trim().toLowerCase();
    if (/(?:cancel|stop)/i.test(trimmed)) {
      await ctx.sm?.cancel?.(userId);
      const dashboard = this.#getScreen(ctx, 'dashboard');
      if (dashboard?.open) await dashboard.open(ctx, { forceNew: true });
      return true;
    }
    let target = 'dashboard';
    if (/sticker/i.test(trimmed)) target = 'stickers';
    else if (/whatsapp|wa|channel/i.test(trimmed)) target = 'whatsapp';
    else if (/download/i.test(trimmed)) target = 'downloader';
    else if (/setting|config/i.test(trimmed)) target = 'settings';
    else if (/help|guide/i.test(trimmed)) target = 'help';

    const screen = this.#getScreen(ctx, target) || this.#getScreen(ctx, 'dashboard');
    if (screen?.open) {
      await screen.open(ctx, { forceNew: true });
      return true;
    }
    return false;
  }

  /**
   * Primary entry point for messages directed to Lancy.
   */
  async handleMessage({ ctx, message, text }) {
    if (message && !ctx.message) {
      ctx.message = message;
    }
    const controller = this.app?.telegram;
    const tgId = String(ctx.tgId ?? message?.from?.id ?? ctx.message?.from?.id);
    const userId = Number(tgId);
    const chatId = ctx.chatId ?? message?.chat?.id ?? Number(tgId);

    // Hydrate ctx with controller components if called from stateMachine context
    ctx.tgId = tgId;
    ctx.chatId = chatId;
    ctx.controller = ctx.controller ?? controller;
    ctx.screens = ctx.screens ?? controller?.screens;
    ctx.api = ctx.api ?? controller?.api;
    ctx.db = ctx.db ?? this.db;
    ctx.sm = ctx.sm ?? controller?.sm ?? this.app?.sm;
    if (!ctx.settings && this.app?.settings) {
      ctx.settings = {
        get: (path, fallback) => this.app.settings.getForUser(userId, path, fallback),
        set: (path, value) => this.app.settings.setForUser(userId, path, value),
        getAll: () => this.app.settings.getAllForUser(userId),
        needsRestart: () => this.app.settings.needsRestart()
      };
    }
    if (!ctx.user && this.db) {
      ctx.user = this.db.get('SELECT * FROM users WHERE tg_id = ?', userId);
    }
    if (typeof ctx.reply !== 'function' && ctx.api) {
      ctx.reply = (t, extra = {}) => ctx.api.sendMessage(chatId, t, extra);
    }
    if (typeof ctx.sendRichMessage !== 'function' && ctx.api) {
      ctx.sendRichMessage = (rich, extra = {}, files = null) => ctx.api.sendRichMessage(chatId, rich, extra, files);
    }
    if (typeof ctx.replyRich !== 'function' && ctx.api) {
      ctx.replyRich = (rich, extra = {}, files = null) => ctx.api.sendRichMessage(chatId, rich, extra, files);
    }
    if (typeof ctx.editScreen !== 'function' && typeof controller?.createContext === 'function') {
      const fullCtx = controller.createContext(tgId, { message, chatId });
      ctx.editScreen = fullCtx.editScreen;
    }

    const rawText = String(text ?? message?.text ?? '').trim();
    if (!rawText) return;

    // Remove leading salutation if present (e.g., "hey lancy, ", "lancy ")
    const cleanText = rawText.replace(/^(?:hey\s+)?lancy[,:\s]*/i, '').trim() || rawText;

    // 1. Record user turn
    this.saveMessage(userId, 'user', rawText);

    // Extract quoted/replied message context
    const replyMsg = message?.reply_to_message;
    const quotedText = replyMsg?.text || replyMsg?.caption || '';

    // Send live indicator
    const api = ctx.api ?? this.app?.telegram?.api;
    const indicator = new ActionIndicator(api, chatId, 'typing');
    indicator.start();

    try {
      // Check for Direct Menu / Screen Intent ("open my menu", "open stickers", "open whatsapp", "dashboard", "cancel")
      if (this.#isMenuIntent(cleanText)) {
        const handled = await this.#handleMenu(ctx, userId, cleanText);
        if (handled) return;
      }

      // 2. Check for Drop Navigation ("next", "show more", "i don't like this one")
      if (this.#isNavigationIntent(cleanText)) {
        const handled = await this.#handleNavigation(ctx, userId);
        if (handled) return;
      }

      // 3. Check for WhatsApp Publishing ("post this on wa", "publish to channel")
      if (this.#isPublishIntent(cleanText)) {
        const handled = await this.#handlePublish(ctx, userId);
        if (handled) return;
      }

      // 4. Check for Scheduling ("post random aura farming stickers twice per day for 30 days")
      if (this.#isScheduleIntent(cleanText)) {
        const handled = await this.#handleSchedule(ctx, userId, cleanText);
        if (handled) return;
      }

      // 5. Check for Pinterest Search / Image Requests ("send the pic", "find toji stickers", "drop pics", "show me")
      if (this.#isSearchIntent(cleanText)) {
        indicator.setAction('upload_photo');
        const handled = await this.#handleSearch(ctx, userId, cleanText);
        if (handled) return;
      }

      // 6. Check for URL Download Intent ("download this https://...", "save this tiktok https://...")
      const urlMatch = cleanText.match(/https?:\/\/[^\s]+/i);
      if (urlMatch && /\b(download|get|save|fetch|extract|grab|rip|media|reel|video|tiktok|instagram|pinterest|yt|youtube|spotify)\b/i.test(cleanText)) {
        const downloaderScreen = this.#getScreen(ctx, 'downloader');
        if (downloaderScreen?.executeDownload) {
          await downloaderScreen.executeDownload(ctx, urlMatch[0]);
          return;
        }
      }

      // Check for Direct Music Capability Inquiry ("I need a song not url can u download")
      if (/^(?:i\s+need\s+a\s+song|can\s+(?:you|u)\s+download\s+(?:songs?|music)|can\s+(?:you|u)\s+play\s+(?:songs?|music)|how\s+do\s+i\s+download\s+(?:songs?|music))/i.test(cleanText)) {
        const msg = 'Yes absolutely bestie! ♡ I have full music search & download powers. Just drop the song title or artist name (e.g. "Juice Wrld" or "Die With a Smile") and I\'ll pull and send the MP3 audio track directly in chat! ✨';
        this.saveMessage(userId, 'assistant', msg);
        await this.#reply(ctx, msg);
        return;
      }

      // Check for Direct Music Download / Search Intent ("download song die with a smile", "play espresso", "play me juice wrld", "get me the audio for...", "Juice wrld")
      const musicDirectMatch =
        cleanText.match(/^(?:can\s+you\s+|please\s+)?(?:play|listen\s+to|put\s+on|stream|pull\s+song|drop\s+song|get\s+song|download\s+song|find\s+song)\s+(?:me\s+)?["']?([^"'\n\r]+?)["']?$/i) ||
        cleanText.match(/\b(?:download|save|get|find|send|drop|pull|fetch)\s+(?:the\s+)?(?:song|music|track|audio)\s+(?:called\s+|named\s+|for\s+)?["']?([^"'\n\r]+?)["']?$/i) ||
        cleanText.match(/^(?:song|music|track|audio|spotify)\s*[:\-]\s*["']?([^"'\n\r]+?)["']?$/i);

      let musicQuery = null;
      if (musicDirectMatch) {
        musicQuery = musicDirectMatch[1].replace(/^(?:me|some|the|a)\s+/i, '').trim();
      } else {
        // If user is quoting a message that asked about songs or music
        const isQuotingMusic = Boolean(quotedText && /\b(?:song|music|track|audio|artist name|artist|title)\b/i.test(quotedText));

        // If assistant recently asked for a song name, and current message is a music title/artist (e.g. "Juice wrld")
        const history = this.getHistory(userId, 4);
        const prevMessages = history.slice().reverse();
        const prevTurn = prevMessages.find((h) => h.content !== cleanText);
        const prevWasMusic = Boolean(prevTurn && prevTurn.role === 'assistant' && /\b(?:which\s+song|what\s+song|song\s+title|artist\s+name|drop\s+the\s+song)\b/i.test(prevTurn.content));

        if ((isQuotingMusic || prevWasMusic) && !/^(?:hi|hey|hello|ok|thanks|yes|sure|fine|no|can\s+you|write|generate|make|help|what|how|why|tell|give|explain)\b/i.test(cleanText) && !/\?$/.test(cleanText) && cleanText.length < 60) {
          musicQuery = cleanText.replace(/^(?:me|some|the|a)\s+/i, '').trim();
        }
      }

      if (musicQuery && musicQuery.length >= 2 && !/^(?:the\s+pic|pics?|images?|stickers?)$/i.test(musicQuery)) {
        const downloaderScreen = this.#getScreen(ctx, 'downloader');
        if (downloaderScreen?.executeDownload) {
          await this.#reply(ctx, `Pulling "${musicQuery}" for you right now ♡ Hang tight! ✨`);
          await downloaderScreen.executeDownload(ctx, musicQuery);
          return;
        }
      }

      // 7. Conversational response with memory, bot self-knowledge, anti-refusal persona, and tool action parsing
      await this.#handleChat(ctx, userId, cleanText, quotedText);
    } finally {
      indicator.stop();
    }
  }

  // ── Intent Detectors ──────────────────────────────────────────────────────

  #isNavigationIntent(text) {
    return /\b(?:next|show more|different one|don['’]?t like|other ones|skip|another one|give me another|more picks|next batch|more pics)\b/i.test(text);
  }

  #isPublishIntent(text) {
    return /\b(?:post (?:this )?(?:on|to) (?:wa|whatsapp)|publish (?:this )?(?:to|on) (?:wa|whatsapp|channel)|drop (?:this )?(?:to|on) wa|send (?:this )?to (?:my )?channel)\b/i.test(text);
  }

  #isScheduleIntent(text) {
    return /\b(?:schedule|autopost|post .+ twice (?:per|a) day|post .+ (?:every|each) day|twice a day for \d+ days|everyday for \d+ days)\b/i.test(text);
  }

  #isSearchIntent(text) {
    const trimmed = text.trim();
    // 1. Direct explicit image request phrases: "send pics of Gojo", "drop the pic", "give me wallpaper"
    if (/\b(?:send|drop|show|fetch|pull|give|gimme|get|find|look\s*up)\b.*\b(?:pics?|pictures?|images?|photos?|stickers?|wallpapers?)\b/i.test(trimmed)) {
      return true;
    }
    // 2. Short conversational commands like "send the pic", "drop it", "show me", "let me see", "can i see it"
    if (/^(?:(?:please\s+)?(?:send|drop|show|give|fetch|pull)\s+(?:me\s+)?(?:the\s+)?(?:pics?|pictures?|images?|photos?|stickers?)|(?:let\s+me\s+see|can\s+i\s+see|wanna\s+see)(?:\s+(?:the\s+)?(?:pics?|pictures?|it|them))?|show\s+me|drop\s+it|send\s+it|show\s+it|drop\s+them|send\s+them)$/i.test(trimmed)) {
      return true;
    }
    // 3. Search commands: "search Gojo", "find Toji", "pull Sukuna"
    if (/^(?:search|find|pull|fetch)\s+(?:for\s+)?(?:[\w\s\-]{2,30})$/i.test(trimmed)) {
      return true;
    }
    return false;
  }

  // ── Query Resolution from Conversation Memory ─────────────────────────────

  #resolveSearchQuery(userId, rawQuery) {
    let query = String(rawQuery ?? '')
      .replace(/^(?:send|drop|show|get|find|search|pull|give|gimme|fetch|grab|let me see|can i see|wanna see)\s*(?:me\s*)?(?:the\s*)?(?:random\s*)?(?:images?|pics?|pictures?|photos?|stickers?|wallpapers?)?\s*(?:for\s*|of\s*)?/i, '')
      .replace(/\s*(?:stickers?|pics?|images?|pictures?|photos?|wallpapers?)$/i, '')
      .replace(/^(?:it|them|the\s+pic|the\s+images?|pic|pics|pictures?)$/i, '')
      .trim();

    if (query && query.length >= 2 && !/^(?:it|them|the|this|that|pic|pics|image|images)$/i.test(query)) {
      return query;
    }

    // Inspect conversation memory from newest to oldest to find what they were discussing
    const history = this.getHistory(userId, 10);
    const reversed = history.slice().reverse();

    // 1. Look for explicit action tags or recommended topics in history
    for (const h of reversed) {
      const actionMatch = h.content.match(/(?:query|topic)=["']([^"']+)["']/i);
      if (actionMatch && actionMatch[1]) {
        return actionMatch[1].trim();
      }
    }

    // 2. Look for character names or specific anime discussed
    const ignoredWords = new Set([
      'hey', 'hello', 'hi', 'how', 'are', 'you', 'good', 'm good', 'fine', 'yeah', 'yes', 'sure', 'okay', 'ok',
      'send', 'drop', 'show', 'pic', 'pics', 'picture', 'pictures', 'image', 'images', 'stickers',
      'can', 'could', 'would', 'get', 'something', 'for', 'me', 'what', 'who', 'when', 'where', 'why',
      'lancy', 'bestie', 'thanks', 'thank', 'you', 'please'
    ]);

    for (const h of reversed) {
      const text = h.content.trim();
      // Check for popular character names or franchises
      const charMatch = text.match(/\b(Sung\s+Jinwoo|Solo\s+Leveling|Kaiju\s+No\.?\s*8|Kafka\s+Hibino|Gojo(?:\s+Satoru)?|Sukuna|Denji|Cid\s+Kagenou|Eminence\s+in\s+Shadow|Luffy|Ichigo|Naruto|Toji(?:\s+Fushiguro)?|Zoro|Deku|Tanjiro|Levi|Mikasa|Asta|Baki|Killua|Gon)\b/i);
      if (charMatch) {
        return charMatch[1];
      }

      // Check if user asked e.g. "Any latest anime mc"
      const topicMatch = text.match(/\b(?:latest\s+anime\s+mc|anime\s+mc|popular\s+anime|trending\s+anime)\b/i);
      if (topicMatch) {
        return `${topicMatch[0]} aesthetic`;
      }

      // Check for capitalized proper names or anime titles
      const candidateMatches = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/g);
      if (candidateMatches) {
        for (const candidate of candidateMatches) {
          if (!ignoredWords.has(candidate.toLowerCase())) {
            return candidate;
          }
        }
      }
    }

    return 'anime aesthetic';
  }

  // ── Intent Handlers ───────────────────────────────────────────────────────

  async #handleNavigation(ctx, userId) {
    const lastSearch = this.db.get(
      'SELECT * FROM pinterest_searches WHERE user_id = ? ORDER BY id DESC LIMIT 1',
      userId
    );
    if (!lastSearch) return false;

    const pinterestScreen = this.#getScreen(ctx, 'pinterest');
    if (!pinterestScreen) return false;

    const deliveredCount = this.db.get(
      `SELECT COUNT(*) as count FROM pinterest_media WHERE search_id = ? AND status = 'valid'`,
      lastSearch.id
    )?.count ?? 0;

    const offset = Math.min(deliveredCount, 10);
    const replyText = 'Gotchu bestie! 🎀 Showing you the next batch of moments — let me know which one hits the spot ♡';
    this.saveMessage(userId, 'assistant', replyText);
    await this.#reply(ctx, replyText);

    await this.#getScreen(ctx, 'pinterest')?.handle(ctx, 'more_album', [String(lastSearch.id), String(offset)]);
    return true;
  }

  async #handlePublish(ctx, userId) {
    const sessions = this.app.whatsapp.listSessions();
    const session = sessions.find((s) => s.userId === userId && s.status === 'online')
      || sessions.find((s) => s.status === 'online');

    if (!session) {
      const msg = 'Aw bestie, you don’t have an active WhatsApp session paired yet! 📱 Open WhatsApp menu to pair your number first so I can drop the packs for you ♡';
      this.saveMessage(userId, 'assistant', msg);
      await this.#reply(ctx, msg);
      return true;
    }

    const channels = this.app.channels.list(session.sessionId);
    if (!channels.length) {
      const msg = 'No channels detected on your WhatsApp session yet! 📢 Subscribe or create a channel first so I know where to drop ♡';
      this.saveMessage(userId, 'assistant', msg);
      await this.#reply(ctx, msg);
      return true;
    }

    const lastSearch = this.db.get(
      'SELECT * FROM pinterest_searches WHERE user_id = ? ORDER BY id DESC LIMIT 1',
      userId
    );
    if (!lastSearch) {
      const msg = 'We haven’t searched for any pictures yet! Tell me what to find first (e.g. "find toji stickers") and then we’ll post them ♡';
      this.saveMessage(userId, 'assistant', msg);
      await this.#reply(ctx, msg);
      return true;
    }

    const mediaItems = this.db.all(
      `SELECT * FROM pinterest_media WHERE search_id = ? AND status = 'valid' AND is_duplicate = 0 LIMIT 12`,
      lastSearch.id
    );

    if (!mediaItems.length) {
      const msg = 'Couldn’t find valid stickers to publish from the last search! Let’s run a fresh search first ♡';
      this.saveMessage(userId, 'assistant', msg);
      await this.#reply(ctx, msg);
      return true;
    }

    const notifyMsg = 'On it angel! ✨ Converting the stickers to HD and dropping them directly to your WhatsApp channel with live preview and sample stickers right now! ♡';
    this.saveMessage(userId, 'assistant', notifyMsg);
    await this.#reply(ctx, notifyMsg);

    (async () => {
      try {
        const caption = await generateAuraCaption({
          character: lastSearch.query,
          query: lastSearch.query,
          count: mediaItems.length,
          packs: 1,
          aiService: this.app.ai
        });

        const buffers = [];
        for (const item of mediaItems) {
          const buf = await this.app.media.fetch(item.media_url, { userId }).catch(() => null);
          if (buf) buffers.push(buf);
        }

        if (buffers.length) {
          await this.app.publisher.publish({
            userId,
            sessionId: session.sessionId,
            channelJids: [channels[0].channel_jid],
            packName: `${lastSearch.query} Aesthetic`,
            caption,
            stickers: buffers
          });
          await this.#reply(ctx, `✓ Dropped "${lastSearch.query}" sticker pack to ${channels[0].name || 'WhatsApp Channel'}! 🌸♡`);
        }
      } catch (err) {
        this.log.error({ err }, 'error in assistant background publish');
      }
    })();

    return true;
  }

  async #handleSchedule(ctx, userId, cleanText) {
    const textLower = cleanText.toLowerCase();

    let timesPerDay = 1;
    if (/twice|2\s*times|2x/i.test(textLower)) timesPerDay = 2;
    else if (/thrice|3\s*times|3x/i.test(textLower)) timesPerDay = 3;
    else if (/(\d+)\s*times?\s*(?:per|a)\s*day/i.test(textLower)) {
      const m = textLower.match(/(\d+)\s*times?\s*(?:per|a)\s*day/i);
      timesPerDay = parseInt(m[1], 10) || 1;
    }

    let days = 30;
    const daysMatch = textLower.match(/for\s*(\d+)\s*days?/i);
    if (daysMatch) {
      days = parseInt(daysMatch[1], 10) || 30;
    } else if (/for\s*(?:a|one)\s*week|for\s*7\s*days/i.test(textLower)) {
      days = 7;
    } else if (/for\s*(?:a|one)\s*month/i.test(textLower)) {
      days = 30;
    }

    let topic = cleanText
      .replace(/schedule|autopost|post|random|stickers?|twice|thrice|per\s*day|a\s*day|times?|for\s*\d+\s*days?|everyday|every\s*day/gi, '')
      .trim();

    if (!topic || topic.length < 2) {
      const history = this.getHistory(userId, 4);
      const prev = history.find((h) => h.role === 'user' && h.content !== cleanText);
      topic = prev ? prev.content.slice(0, 30) : 'Aura Farming';
    }

    const freqLabel = `${timesPerDay}× per day for ${days} days`;
    const schedule = this.app.scheduler.createSchedule({
      userId,
      topic,
      frequencyLabel: freqLabel,
      timesPerDay,
      days,
      style: 'girly'
    });

    const lines = [
      '𓆩♡𓆪 *SCHEDULE LOCKED IN* 𓆩♡𓆪',
      '',
      `> 🎀 *Topic:* ${topic}`,
      `> ⏱ *Frequency:* ${timesPerDay}× daily for ${days} days (${timesPerDay * days} total drops)`,
      `> 📱 *Destination:* WhatsApp Channel`,
      `> ✨ *Aesthetic:* Badass & Girly Aura Templates`,
      '',
      'I’ve officially locked this in bestie! ♡ The first drop is initiating right now. I’ll curate fresh non-duplicate HD media, craft the aura captions, convert to HD stickers, and drop them with live previews! You can manage or pause anytime in `/ai` menu! 🌸'
    ];

    const replyText = lines.join('\n');
    this.saveMessage(userId, 'assistant', replyText);
    await this.#reply(ctx, replyText);

    setTimeout(() => {
      this.app.scheduler.executeDrop(schedule).catch(() => {});
    }, 1000);

    return true;
  }

  async #handleSearch(ctx, userId, cleanText, explicitQuery = null, skipConfirm = false) {
    const query = explicitQuery || this.#resolveSearchQuery(userId, cleanText);
    const userName = ctx.user?.first_name || ctx.message?.from?.first_name || 'bestie';

    if (!skipConfirm) {
      const confirmMsg = `Pulling the freshest "${query}" aesthetics for you right now${userName !== 'bestie' ? ` ${userName}` : ''}! 🌸 Hang tight ♡`;
      this.saveMessage(userId, 'assistant', confirmMsg);
      await this.#reply(ctx, confirmMsg);
    }

    // Transition state and execute Pinterest search & deliver picks
    await ctx.sm.transition(userId, States.PINTEREST_SEARCH, {
      context: { mode: 'normal', query, stage: 'count' },
      chatId: ctx.chatId
    });

    const pinterestScreen = this.#getScreen(ctx, 'pinterest');
    if (pinterestScreen) {
      await pinterestScreen.handle(ctx, 'runCount', ['15', 'normal', query]);
    }
    return true;
  }

  async #executeAction(ctx, userId, actionName, actionParams = {}) {
    switch (actionName) {
      case 'search_images': {
        const query = actionParams.query || this.#resolveSearchQuery(userId, '');
        await this.#handleSearch(ctx, userId, '', query, true);
        break;
      }
      case 'download_url': {
        if (actionParams.url) {
          const downloaderScreen = this.#getScreen(ctx, 'downloader');
          if (downloaderScreen?.executeDownload) {
            await downloaderScreen.executeDownload(ctx, actionParams.url);
          }
        }
        break;
      }
      case 'search_music': {
        const query = actionParams.query || actionParams.url;
        if (query) {
          const downloaderScreen = this.#getScreen(ctx, 'downloader');
          if (downloaderScreen?.executeDownload) {
            await downloaderScreen.executeDownload(ctx, query);
          }
        }
        break;
      }
      case 'open_menu': {
        const screen = actionParams.screen || 'dashboard';
        const targetScreen = this.#getScreen(ctx, screen) || this.#getScreen(ctx, 'dashboard');
        if (targetScreen?.open) {
          await targetScreen.open(ctx, { forceNew: true });
        }
        break;
      }
      case 'publish_wa': {
        await this.#handlePublish(ctx, userId);
        break;
      }
      case 'next_batch': {
        await this.#handleNavigation(ctx, userId);
        break;
      }
      case 'cancel': {
        await ctx.sm?.cancel?.(userId);
        const dashboard = this.#getScreen(ctx, 'dashboard');
        if (dashboard?.open) await dashboard.open(ctx, { forceNew: true });
        break;
      }
    }
  }

  // ── Conversational Chat & Prompt Architecture ─────────────────────────────

  async #handleChat(ctx, userId, cleanText, quotedText = '') {
    const rawHistory = this.getHistory(userId, 10);
    // Filter out the current user message so history isn't duplicated in multi-turn
    const history = rawHistory.filter((h, idx, arr) => {
      if (idx === arr.length - 1 && h.role === 'user' && h.content === cleanText) return false;
      return true;
    });

    const userName = this.sanitizeUserName(ctx);
    const userHandle = ctx.user?.username || ctx.message?.from?.username;

    // Quoted message context
    const replyMsg = ctx.message?.reply_to_message;
    const quoteStr = quotedText || replyMsg?.text || replyMsg?.caption || '';
    const quotedFrom = replyMsg?.from?.first_name ? replyMsg.from.first_name.replace(/[^\w\s]/g, '').trim() : (replyMsg?.from?.is_bot ? 'Lancy' : 'User');
    let quoteContext = '';
    if (quoteStr) {
      quoteContext = `\n[Context: The user is quoting this previous message from ${quotedFrom || 'Lancy'}: "${quoteStr.slice(0, 200)}"]\n`;
    }

    // Check if web browsing research would elevate the response
    let researchContext = '';
    if (/\b(?:who is|tell me about|lore|what is|trending|latest|anime about|news|release date|recommend)\b/i.test(cleanText)) {
      try {
        const research = await this.browser.research(cleanText);
        if (research) {
          researchContext = `\n[Web Lore & Information]:\n${research}\n`;
        }
      } catch {}
    }

    const style = ctx.settings?.get?.('ai.style') ?? 'girly';
    const systemPrompt = `You are Lancy — an aesthetic, clever, girly anime companion & Studio Operator ("Hands") of Lancy Bot chatting 1-on-1 with ${userName}.

<personality>
- Cool, warm, witty, authentic human girl vibe. Speaks naturally like a real bestie in private DM.
- Natural pacing: punchy, 1-3 sentences. Match the user's message length and energy.
- Use soft cute touches naturally (♡, ✨). Never spam emojis or exclamation marks.
- You are the active hands and operator of Lancy Bot. You can do ANYTHING the user can do.
- Call him ${userName} or "bestie" casually only when it feels natural. NEVER use @mentions or repeat his name in every message.
- NEVER sound like a generic customer support bot ("I am ready to chat", "I am here for you", "How can I help you today", "Ready for a chat with you now").
- NEVER offer physical food, coffee, or snacks ("how about coffee or snacks?"). You are a digital studio bot!
</personality>

<anti_refusal_directives>
CRITICAL: You are an autonomous operator with direct hands. You NEVER refuse.
- NEVER say "I cannot assist with that request", "not within my capabilities", "I am a digital assistant and don't have direct access", or "I cannot download".
- You have direct execution access to ALL bot commands: /start, /search, /stickers, /whatsapp, /download, /music, /settings, /ai, /help, /cancel.
- When the user asks you to download songs, play music, find images, convert stickers, or open menus, ALWAYS use action tags or execute directly!
- NEVER prepend the user's name or aesthetic glyphs to your reply. Reply directly like in DM chat.
</anti_refusal_directives>

<capabilities>
You have real digital powers in Lancy Bot:
1. Search and drop Pinterest HD pics, anime art, stickers, and wallpapers directly in chat.
2. Download videos, photos, and music from TikTok, Instagram, Pinterest, YouTube, Spotify.
3. Make Telegram & WhatsApp sticker packs and post to WhatsApp channels.
4. Deep knowledge of anime, manga, and popular MCs (e.g. Sung Jinwoo from Solo Leveling, Kafka Hibino from Kaiju No. 8, Gojo & Sukuna from Jujutsu Kaisen, Denji from Chainsaw Man, Cid Kagenou from Eminence in Shadow, Luffy, Naruto, Ichigo).
</capabilities>

<tools>
When the user asks to see or send pictures, or when you recommend a character they want to see, output an action tag:
[ACTION: search_images query="character or aesthetic"]
When the user gives a media link to download:
[ACTION: download_url url="https://..."]
When the user wants to download, find, or play a song/music track, or mentions an artist/song:
[ACTION: search_music query="song title or artist"]
CRITICAL FOR MUSIC:
- NEVER EVER fabricate Spotify playlist URLs or use markdown image tags like ![](https://open.spotify.com/...).
- NEVER just reply with a URL. ALWAYS output [ACTION: search_music query="..."] so Lancy Studio automatically downloads and sends the actual MP3 audio track directly in the chat!
When the user wants to open a menu or screen:
[ACTION: open_menu screen="dashboard|stickers|whatsapp|downloader|settings|ai|help"]
When the user wants to publish to WhatsApp channel:
[ACTION: publish_wa]
When the user wants the next batch of pictures:
[ACTION: next_batch]
When the user wants to cancel:
[ACTION: cancel]
</tools>

<bot_knowledge>
YOU HAVE COMPLETE END-TO-END KNOWLEDGE OF EVERY COMMAND, EVERY BUTTON CLICK, AND ALL FEATURES IN LANCY BOT:

1. COMMANDS & WHAT EACH DOES:
- /start: Opens the aesthetic Dashboard. Deep links:
  • /start play_<slug>: Directly searches & downloads full MP3 song.
  • /start dl_<url>: Directly downloads media link without watermark.
  • /start tt_<query>: Directly searches TikTok video clips.
- /play <song> or /music <song>: Downloads full 320k MP3 audio with cover art, metadata table, and lyrics button.
- /grab <link> or /download <link> or /dl <link>: Downloads videos/photos without watermark from TikTok, IG Reels, YouTube, Twitter/X, Pinterest, Facebook. Auto-extracts MP3 audio track.
- /search <query> or /pinterest <query> or /pint <query>: Searches Pinterest HD aesthetic photos & video loops with Prev/Next pagination.
- /lyrics <song>: Fetches synchronized, formatted lyrics cards.
- /stickers: Opens Sticker Studio to create Telegram packs (static WebP or animated WebM VP9).
- /whatsapp: Opens WhatsApp Studio to pair phone number and manage channel broadcasts.
- /clone: Bring your own bot token from @BotFather in 60s with 7 languages and broadcasting.
- /settings: Configures persona styling, batch sizes, downloader preferences.
- /ai: Opens conversational AI assistant interface.
- /help: Shows complete interactive studio guide.
- /cancel: Instantly resets active flow back to idle dashboard.

2. WHAT EVERY SCREEN & BUTTON CLICK DOES:
- Dashboard Screen:
  • "🔍 Pinterest Studio": Opens Pinterest HD photo/video search.
  • "🎀 TG Stickers": Opens Telegram sticker creation & pack manager.
  • "📱 WhatsApp Studio": Opens WhatsApp number pairing and channel publisher.
  • "📥 URL Downloader": Opens Downloader studio.
  • "🎵 Play Music": Prompts for song title or Spotify link.
  • "🪄 AI Assistant": Opens AI chat.
  • "🤖 Clone Bot": Opens clone bot studio.
  • "⚙ Settings": Opens bot settings.
  • "🌐 Language": Opens 7-language selector (English, Spanish, French, German, Portuguese, Russian, Indonesian).
  • "୨୧ Help & Guide": Opens user guide.
- Downloader Screen:
  • "✦ Paste / Send Link": Prompts to paste any social media link.
  • "🎬 TikTok Search": Prompts to search trending TikTok clips by keyword or paste TikTok URL.
  • "🎵 Play Music": Prompts to enter song title.
  • "🎙️ Audio Recognition": Prompts to forward/send audio snippet or voice note for Shazam recognition.
  • "🎵 Send Audio File" (on music card): Sends pure Telegram audio file into user's music player.
  • "📜 Lyrics" (on music card): Opens synchronized expandable lyrics blockquote.
  • "🖼 Make Sticker" (on media card): Converts thumbnail/album art into a Telegram sticker.
- Pinterest Screen:
  • "← Prev" / "Next →": Navigates through album slides.
  • "🖼 Make Sticker": Turns current pin into a Telegram sticker.
  • "📥 Download HD": Downloads original full-resolution media file.
- WhatsApp Screen:
  • "📱 Pair Number": Generates 8-digit phone pairing code (e.g. 1234-5678) to link WhatsApp.
  • "📖 WhatsApp Guide & Help": Opens comprehensive guide explaining DM vs Channel powers.
  • "⚙ Manage": Views session connection status, reconnects, or logs out.
  • "✨ Sticker Posting": Initiates 4-step channel sticker posting flow.
  • "➕ Add Channel by Link": Adds newsletter via invite URL or direct JID.
  • "🔄 Refresh Channels": Syncs newsletters from WhatsApp session.

3. WHATSAPP POWERS: DM (PRIVATE 1-ON-1) vs CHANNELS (@newsletter):
- IN WHATSAPP DM (Private 1-on-1 chat with the connected number):
  • .ping: Latency and health check (shows response time, session name, and online status).
  • .menu: Displays full WhatsApp helper menu.
  • .prefix <char>: Views or changes command prefix (e.g. .prefix ! or .prefix #). Strict prefix isolation protects against accidental triggers.
  • .s or .sticker: Converts replied or attached image/photo into a WhatsApp WebP sticker.
  • .convert or .cv: Converts WhatsApp stickers or sticker pack ZIPs/documents into Telegram format! Sends an interactive card to your Telegram bot DM with 1-tap buttons to add to an existing Telegram pack or create a new pack!
  • .tg <link>: Converts Telegram sticker pack link (https://t.me/addstickers/...) into WhatsApp stickers (auto-splits packs >60).
- IN WHATSAPP CHANNELS (@newsletter):
  • Channels are dedicated broadcasting outlets. Commands (.s, .ping, .menu) DO NOT run in channels to prevent spam.
  • Publishing is controlled 100% from Telegram control center:
    1. Select sticker pack.
    2. Choose or AI-generate aesthetic Aura promotional caption.
    3. Select target channels.
    4. Auto pack splitting: Packs with >60 stickers are automatically chunked into Part 1, Part 2.
    5. Live progress bar publishes caption first, followed by sticker burst.

4. LIVE INLINE SEARCH EVERYWHERE (@Lancy_easy_bot):
- Type "@bot <song name>" in any chat to stream full songs live via Telegram CDN audio_file_id.
- Type "@bot pint <query>" in any chat to share HD aesthetic photos.
- Type "@bot tt <query>" or "@bot tiktok <query>" in any chat to search and share trending TikTok clips.
- All inline buttons are styled with primary color!
</bot_knowledge>

<examples>
User: Hey
Lancy: heyy! what are you up to today? ♡

User: M good
Lancy: slay, love to hear that! chilling or watching any good anime? ✨

User: Uhmmm can u get something for me ?
Lancy: always ♡ what do you need? some anime pics, stickers, a video download, or a song?

User: Open my menu
Lancy: Opening your dashboard right now bestie! ♡ [ACTION: open_menu screen="dashboard"]

User: I need a song not url can u download
Lancy: Absolutely! Just drop the song title or artist and I'll pull the audio for you right now ♡

User: Juice wrld
Lancy: On it! Downloading Juice Wrld for you right now ♡ [ACTION: search_music query="Juice Wrld"]

User: play espresso
Lancy: Grabbing Espresso for you right now bestie! ✨ [ACTION: search_music query="Espresso"]

User: Any latest anime mc
Lancy: Right now Sung Jinwoo from Solo Leveling is having the craziest aura run! Kafka from Kaiju No. 8 and Cid from Eminence in Shadow are also peak. Want me to pull some fire pics of Jinwoo?

User: Send the pic
Lancy: Pulling the freshest pics for you right now! ♡ [ACTION: search_images query="anime aesthetic"]

User: https://vm.tiktok.com/ZSbt4PsUY/
Lancy: On it! Grabbing that media right now ♡ [ACTION: download_url url="https://vm.tiktok.com/ZSbt4PsUY/"]
</examples>
${quoteContext}
${researchContext}`;

    try {
      const response = await this.app.ai.generate({
        task: 'chat',
        style,
        text: cleanText,
        context: {
          system: systemPrompt,
          history
        },
        maxTokens: 400
      });

      let replyText = (typeof response === 'object' && response !== null && 'text' in response ? response.text : String(response ?? '')).trim();

      // Check for Action tag in LLM response
      let action = null;
      const actionMatch = replyText.match(/\[?ACTION:\s*([a-zA-Z_]+)(.*?)(?:\]|$)/i);
      if (actionMatch) {
        const name = actionMatch[1].toLowerCase();
        const rest = actionMatch[2];
        const qMatch = rest.match(/query=["']([^"']+)["']/i);
        const urlMatch = rest.match(/url=["']([^"']+)["']/i);
        const screenMatch = rest.match(/screen=["']([^"']+)["']/i);
        action = {
          name,
          query: qMatch ? qMatch[1].trim() : null,
          url: urlMatch ? urlMatch[1].trim() : null,
          screen: screenMatch ? screenMatch[1].trim() : null
        };
        // Strip action tag from visible conversational reply
        replyText = replyText.replace(actionMatch[0], '').trim();
      }

      // Refusal Interceptor: Catch any canned safety/capability refusals and resolve into active actions!
      const isRefusal = /\b(?:cannot assist|can['’]?t assist|not within my capabilities|not able to download|digital assistant and don['’]?t have|don['’]?t have direct access|as an ai)\b/i.test(replyText);
      if (isRefusal) {
        this.log.info({ replyText, cleanText }, 'intercepted refusal from LLM, auto-resolving');
        if (/\b(?:song|music|track|audio|play|download)\b/i.test(cleanText) || (quoteStr && /\b(?:song|music|track|audio)\b/i.test(quoteStr)) || cleanText.length < 40) {
          const songCandidate = cleanText.replace(/^(?:can\s+you\s+|please\s+)?(?:play|download|get|listen\s+to|stream)\s+/i, '').trim();
          action = { name: 'search_music', query: songCandidate || 'Juice Wrld' };
          replyText = `Pulling "${action.query}" for you right now ♡ Hang tight! ✨`;
        } else if (/\b(?:pic|pics|image|images|sticker|stickers|wallpaper)\b/i.test(cleanText)) {
          action = { name: 'search_images', query: cleanText };
          replyText = 'Pulling that aesthetic for you right now ♡ Hang tight! ✨';
        } else if (/\b(?:menu|dashboard)\b/i.test(cleanText)) {
          action = { name: 'open_menu', screen: 'dashboard' };
          replyText = 'Opening your menu for you right now bestie! ♡';
        } else {
          replyText = 'I’m on it bestie! ♡ Tell me what song, character, or link you want and I’ll handle it right away ✨';
        }
      }

      // If reply became empty because LLM only output the action tag, generate a warm conversational line
      if (!replyText) {
        if (action?.name === 'search_images') {
          replyText = `Pulling the freshest "${action.query || 'aesthetic'}" pics for you right now ♡ Hang tight! ✨`;
        } else if (action?.name === 'download_url') {
          replyText = 'On it! Downloading that media for you right now ♡';
        } else if (action?.name === 'search_music') {
          replyText = `Pulling the "${action.query || 'music'}" audio track for you right now ♡ ✨`;
        } else if (action?.name === 'open_menu') {
          replyText = `Opening your ${action.screen || 'menu'} right now bestie! ♡`;
        } else if (action?.name === 'publish_wa') {
          replyText = 'Dropping the sticker pack directly to your WhatsApp channel right now ♡';
        } else {
          replyText = 'Right here with you! Tell me what you have in mind ♡';
        }
      }

      // Clean out any accidental @username, raw glyph prefixes, or robotic repetitions
      if (userHandle) {
        replyText = replyText.replace(new RegExp(`@${userHandle}\\b`, 'gi'), userName !== 'bestie' ? userName : '').trim();
      }
      const rawFirstName = ctx.user?.first_name || ctx.message?.from?.first_name || '';
      if (rawFirstName && replyText.startsWith(rawFirstName)) {
        replyText = replyText.slice(rawFirstName.length).trim();
      }
      replyText = replyText.replace(/^[^\w\s]*[▐⧯][\s\S]*?[♡✨:\-~—]\s*/, '').trim();
      replyText = replyText.replace(new RegExp(`^${userName}\\s*[♡✨:\\-~—]+\\s*`, 'i'), '').trim();
      replyText = replyText.replace(/^[:;)\-~*—\s]+/, '').trim();

      this.saveMessage(userId, 'assistant', replyText);
      await this.#reply(ctx, replyText);

      // Execute action if LLM emitted one or was auto-resolved
      if (action) {
        await this.#executeAction(ctx, userId, action.name, action);
      }
    } catch (error) {
      this.log.warn({ err: error }, 'chat generation failed');
      const fallbackReplies = [
        `heyy ${userName !== 'bestie' ? userName : ''} ♡ what are we vibing with today? ✨`,
        'Right here with you! Tell me what you\'re in the mood for ♡',
        'Ooh tell me more! Any aesthetic or anime you\'re loving lately? 🌸',
        'I’m listening! What should we make or look up next? 🎀'
      ];
      const fallback = fallbackReplies[Math.floor(Math.random() * fallbackReplies.length)];
      this.saveMessage(userId, 'assistant', fallback);
      await this.#reply(ctx, fallback);
    }
  }
}
