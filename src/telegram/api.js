import { openAsBlob, existsSync, statSync } from 'node:fs';
import { logger } from '../core/logger.js';
import { sleep } from '../utils/time.js';
import { RichMessageBuilder } from './rich.js';
import { CUSTOM_EMOJI_MAP, enhanceHtmlWithCustomEmojis, extractCustomEmojiEntities, getCustomEmojiId } from './customEmoji.js';

const VERIFIED_CUSTOM_EMOJI_IDS = new Set(Object.values(CUSTOM_EMOJI_MAP).map((id) => String(id)));
const RICH_EMOJI_ERROR_RE = /RICH_MESSAGE_EMOJI_INVALID|CUSTOM_EMOJI|EMOJI_INVALID|BUTTON_ICON_INVALID|DOCUMENT_INVALID/i;

function applyCustomEmojisToOutgoingParams(params, { isCaption = false } = {}) {
  if (!params || typeof params !== 'object') return params;
  const skip = Boolean(params.skip_custom_emojis);
  if ('skip_custom_emojis' in params) delete params.skip_custom_emojis;
  if (skip) return params;

  const field = isCaption ? 'caption' : 'text';
  const entitiesField = isCaption ? 'caption_entities' : 'entities';
  if (typeof params[field] !== 'string' || !params[field]) return params;
  if (Array.isArray(params[entitiesField])) return params;

  const parseMode = typeof params.parse_mode === 'string' ? params.parse_mode.trim().toUpperCase() : '';
  if (parseMode === 'HTML') {
    params[field] = enhanceHtmlWithCustomEmojis(params[field]);
  } else if (!parseMode) {
    const { entities } = extractCustomEmojiEntities(params[field]);
    if (entities.length > 0) {
      params[entitiesField] = entities;
    }
  }
  return params;
}

/**
 * Minimal, precise Telegram Bot API client (Bot API 10.3).
 *
 * We deliberately talk to the HTTP API directly instead of relying on a
 * wrapper library: Rich Messages (sendRichMessage / editMessageText with
 * rich_message) are brand new in Bot API 10.1–10.3 and library support is
 * uneven. This client supports JSON and multipart uploads natively.
 */
function sanitizeInlineResults(results) {
  if (!Array.isArray(results)) return results;
  return results.map(item => {
    if (!item || typeof item !== 'object') return item;
    const sanitized = { ...item };
    if (typeof sanitized.title === 'string') {
      sanitized.title = [...sanitized.title.toWellFormed()].slice(0, 64).join('').trim().toWellFormed();
    }
    if (typeof sanitized.description === 'string') {
      sanitized.description = [...sanitized.description.toWellFormed()].slice(0, 100).join('').trim().toWellFormed();
    }
    if (typeof sanitized.caption === 'string') {
      sanitized.caption = [...sanitized.caption.toWellFormed()].slice(0, 1024).join('').toWellFormed();
    }
    if (sanitized.reply_markup?.inline_keyboard) {
      sanitized.reply_markup = {
        ...sanitized.reply_markup,
        inline_keyboard: sanitized.reply_markup.inline_keyboard.map(row =>
          Array.isArray(row) ? row.map(btn => {
            if (!btn || typeof btn !== 'object') return btn;
            const b = { ...btn };
            if (typeof b.text === 'string') {
              b.text = [...b.text.toWellFormed()].slice(0, 64).join('').trim().toWellFormed();
            }
            if (typeof b.switch_inline_query_current_chat === 'string') {
              b.switch_inline_query_current_chat = [...b.switch_inline_query_current_chat.toWellFormed()].slice(0, 64).join('').toWellFormed();
            }
            if (typeof b.switch_inline_query === 'string') {
              b.switch_inline_query = [...b.switch_inline_query.toWellFormed()].slice(0, 64).join('').toWellFormed();
            }
            return b;
          }) : row
        )
      };
    }
    return sanitized;
  });
}

function stripCustomEmojisFromRichPayload(node, { onlyButtons = false, allowedIds = null, inButtons = false } = {}) {
  if (node == null || typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    const mapped = node.map((item) => stripCustomEmojisFromRichPayload(item, { onlyButtons, allowedIds, inButtons }));
    const coalesced = [];
    for (const item of mapped) {
      if (typeof item === 'string' && coalesced.length > 0 && typeof coalesced[coalesced.length - 1] === 'string') {
        coalesced[coalesced.length - 1] += item;
      } else {
        coalesced.push(item);
      }
    }
    return coalesced.length === 1 && typeof coalesced[0] === 'string' ? coalesced[0] : coalesced;
  }
  const hereButtons = inButtons || node.type === 'buttons';
  if (node.type === 'custom_emoji') {
    const shouldStrip = onlyButtons
      ? hereButtons
      : (allowedIds ? !allowedIds.has(String(node.custom_emoji_id || '')) : true);
    if (shouldStrip) {
      return typeof node.alternative_text === 'string' ? node.alternative_text : '';
    }
    return node;
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'icon_custom_emoji_id') {
      const stripIcon = onlyButtons ? true : (allowedIds ? !allowedIds.has(String(v || '')) : true);
      if (stripIcon) continue;
    }
    out[k] = stripCustomEmojisFromRichPayload(v, { onlyButtons, allowedIds, inButtons: hereButtons });
  }
  return out;
}

export class TelegramAPI {
  /**
   * baseUrl defaults to TELEGRAM_API_BASE_URL so a self-hosted Bot API server
   * (telegram-bot-api --local, 2000 MB uploads) is used by the main bot and clones.
   */
  constructor(token, { baseUrl = process.env.TELEGRAM_API_BASE_URL || 'https://api.telegram.org', timeoutMs = 60000, log } = {}) {
    if (!token) throw new Error('TelegramAPI: BOT_TOKEN is required');
    this.token = token;
    this.apiRoot = String(baseUrl).replace(/\/+$/, '');
    this.isLocalServer = this.apiRoot !== 'https://api.telegram.org';
    this.baseUrl = `${this.apiRoot}/bot${token}`;
    this.timeoutMs = timeoutMs;
    this.log = log ?? logger().child({ module: 'telegram-api' });
    this.me = null;
    this.lastChatAction = new Map(); // chatId -> { action, at }
    this.chatFloodUntil = new Map(); // chatId -> epochMs
    this.globalFloodUntil = 0;
  }

  async call(method, params = {}, { files = null, timeoutMs = this.timeoutMs, dropOnFloodWait = false } = {}) {
    if (method === 'sendChatAction') {
      dropOnFloodWait = true;
    }
    const isNonBlockingMethod = /^(answerCallbackQuery|answerInlineQuery|getChat|getChatMember|getChatAdministrators|getMe|getFile|deleteMessage|pinChatMessage|unpinChatMessage|exportChatInviteLink|createChatInviteLink)$/i.test(method);
    const isEditMethod = /^editMessage/i.test(method);
    const chatKey = params?.chat_id !== undefined && params?.chat_id !== null ? String(params.chat_id) : null;
    const rateKey = isEditMethod && chatKey && params?.message_id
      ? `edit:${chatKey}:${params.message_id}`
      : chatKey;
    const now = Date.now();
    const floodUntil = isNonBlockingMethod
      ? 0
      : Math.max(this.globalFloodUntil, rateKey ? (this.chatFloodUntil.get(rateKey) || 0) : 0);
    if (floodUntil > now) {
      if (dropOnFloodWait) {
        const err = new Error(`Telegram ${method}: skipped during active flood wait`);
        err.code = 'FLOOD_WAIT';
        err.retryAfter = Math.ceil((floodUntil - now) / 1000);
        throw err;
      }
      const waitMs = Math.min(6000, floodUntil - now);
      if (waitMs > 0) await sleep(waitMs);
    }

    if (method === 'answerInlineQuery' && Array.isArray(params?.results)) {
      params = { ...params, results: sanitizeInlineResults(params.results) };
    }
    const url = `${this.baseUrl}/${method}`;
    let body;
    let headers = {};
    let totalUploadBytes = 0;
    if (files && Object.keys(files).length > 0) {
      const form = new FormData();
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;
        form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
      }
      for (const [field, file] of Object.entries(files)) {
        if (!file) continue;
        const { buffer, filePath, blob, filename = field, contentType = 'application/octet-stream' } = file;
        if (blob) {
          totalUploadBytes += Number(blob.size) || 0;
          form.append(field, blob, filename);
        } else if (filePath && existsSync(filePath)) {
          try { totalUploadBytes += statSync(filePath).size; } catch {}
          const fileBlob = await openAsBlob(filePath, { type: contentType });
          form.append(field, fileBlob, filename);
        } else if (buffer !== undefined && buffer !== null) {
          totalUploadBytes += Number(buffer.byteLength ?? buffer.length) || 0;
          form.append(field, new Blob([buffer], { type: contentType }), filename);
        }
      }
      body = form;
    } else {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(params);
    }

    const effectiveTimeoutMs = totalUploadBytes > 15 * 1024 * 1024
      ? Math.max(timeoutMs, 900000)
      : timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), effectiveTimeoutMs);
    let response;
    try {
      response = await fetch(url, { method: 'POST', body, headers, signal: controller.signal });
    } catch (error) {
      clearTimeout(timer);
      if (this.isLocalServer && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(this.apiRoot) && totalUploadBytes <= 48 * 1024 * 1024) {
        try {
          const fallbackUrl = `https://api.telegram.org/bot${this.token}/${method}`;
          const fbCtrl = new AbortController();
          const fbTimer = setTimeout(() => fbCtrl.abort(), effectiveTimeoutMs);
          try {
            response = await fetch(fallbackUrl, { method: 'POST', body, headers, signal: fbCtrl.signal });
          } finally {
            clearTimeout(fbTimer);
          }
        } catch {}
      }
      if (!response) {
        const err = new Error(`Telegram request failed (${method}): ${error.message}`);
        err.code = 'NETWORK';
        err.retryable = true;
        throw err;
      }
    }
    clearTimeout(timer);

    const data = await response.json().catch(() => ({}));
    if (!data.ok) {
      const err = new Error(`Telegram ${method}: ${data.description ?? response.statusText}`);
      err.code = 'TELEGRAM';
      err.description = data.description;
      err.errorCode = data.error_code;
      err.parameters = data.parameters;
      err.retryable = data.error_code === 429 || (data.error_code >= 500 && data.error_code < 600);
      // Flood wait handling: if caller requests dropping on flood wait, immediately reject without blocking
      if (data.error_code === 429 && data.parameters?.retry_after) {
        const rawRetry = Math.max(1, Number(data.parameters.retry_after) || 1);
        const wait = Math.min(8, rawRetry);
        const until = Date.now() + wait * 1000;
        if (rateKey) {
          this.chatFloodUntil.set(rateKey, Math.max(this.chatFloodUntil.get(rateKey) || 0, until));
          if (this.chatFloodUntil.size > 500) {
            const cur = Date.now();
            for (const [k, exp] of this.chatFloodUntil) {
              if (exp <= cur) this.chatFloodUntil.delete(k);
            }
          }
        } else if (!isNonBlockingMethod) {
          this.globalFloodUntil = Math.max(this.globalFloodUntil, until);
        }
        if (dropOnFloodWait || isNonBlockingMethod) {
          err.code = 'FLOOD_WAIT';
          err.retryAfter = data.parameters.retry_after;
          throw err;
        }
        err._floodAttempts = (params.__floodAttempts ?? 0);
        if (err._floodAttempts >= 1 || rawRetry > 10) { throw err; }
        this.log.warn({ method, wait }, 'flood wait — backing off');
        await sleep(wait * 1000);
        return this.call(method, { ...params, __floodAttempts: err._floodAttempts + 1 }, { files, timeoutMs, dropOnFloodWait });
      }
      throw err;
    }
    return data.result;
  }

  // ── Core ──────────────────────────────────────────────────────────────
  getMe() {
    return this.call('getMe').then((me) => {
      this.me = me;
      return me;
    });
  }

  getChat(chatId) {
    return this.call('getChat', { chat_id: chatId });
  }

  getChatMember(chatId, userId) {
    return this.call('getChatMember', { chat_id: chatId, user_id: userId });
  }

  getChatAdministrators(chatId) {
    return this.call('getChatAdministrators', { chat_id: chatId });
  }

  get botUsername() {
    return this.me?.username ?? '';
  }

  sendMessage(chatId, text, extra = {}) {
    const params = applyCustomEmojisToOutgoingParams({ chat_id: chatId, text, ...extra });
    if (/https?:\/\/[^\s]+/i.test(text) && !params.link_preview_options && params.disable_web_page_preview === undefined) {
      params.link_preview_options = { is_disabled: false, prefer_large_media: true };
    }
    return this.call('sendMessage', params);
  }

  async #callRichWithEmojiFallback(method, baseParams, payload, callOpts = {}) {
    try {
      return await this.call(method, { ...baseParams, rich_message: payload }, callOpts);
    } catch (err) {
      const desc = String(err?.description || err?.message || '');
      if (!RICH_EMOJI_ERROR_RE.test(desc)) throw err;
      this.log?.warn?.({ method, chatId: baseParams?.chat_id, err: desc }, 'Rich custom emoji rejected by Telegram; applying tiered fallback');
      const noButtons = stripCustomEmojisFromRichPayload(payload, { onlyButtons: true });
      const candidates = [
        noButtons,
        stripCustomEmojisFromRichPayload(payload, { onlyButtons: false, allowedIds: VERIFIED_CUSTOM_EMOJI_IDS }),
        stripCustomEmojisFromRichPayload(noButtons, { onlyButtons: false, allowedIds: VERIFIED_CUSTOM_EMOJI_IDS }),
        stripCustomEmojisFromRichPayload(payload)
      ];
      let prevJson = JSON.stringify(payload);
      let lastErr = err;
      for (const candidate of candidates) {
        const nextJson = JSON.stringify(candidate);
        if (nextJson === prevJson) continue;
        prevJson = nextJson;
        try {
          return await this.call(method, { ...baseParams, rich_message: candidate }, callOpts);
        } catch (retryErr) {
          lastErr = retryErr;
          if (!RICH_EMOJI_ERROR_RE.test(String(retryErr?.description || retryErr?.message || ''))) {
            throw retryErr;
          }
        }
      }
      throw lastErr;
    }
  }

  /** Bot API 10.1+: send a Rich Message. rich_message = InputRichMessage or { html: '...' } */
  async sendRichMessage(chatId, richMessage, extra = {}, files = null) {
    let payload = richMessage;
    if (typeof richMessage === 'string') {
      payload = RichMessageBuilder.fromHtml(richMessage).toJSON();
    } else if (richMessage && typeof richMessage.html === 'string') {
      payload = RichMessageBuilder.fromHtml(richMessage.html).toJSON();
    }
    return this.#callRichWithEmojiFallback('sendRichMessage', { chat_id: chatId, ...extra }, payload, { files });
  }

  /** Bot API 10.3+: send an ephemeral rich notice/card to a single user inside a group/chat. */
  sendEphemeralRichNotice(chatId, { receiverUserId, callbackQueryId = null, replaceCallbackQueryMessage = false } = {}, richMessage, extra = {}, files = null) {
    const ephemeralParams = {};
    if (receiverUserId !== undefined && receiverUserId !== null) {
      ephemeralParams.receiver_user_id = Number(receiverUserId);
    }
    if (callbackQueryId) {
      ephemeralParams.callback_query_id = String(callbackQueryId);
    }
    if (replaceCallbackQueryMessage) {
      ephemeralParams.replace_callback_query_message = true;
    }
    return this.sendRichMessage(
      chatId,
      richMessage,
      {
        ephemeral_message_parameters: ephemeralParams,
        ...extra
      },
      files
    );
  }

  /** Bot API 10.3+: edit an ephemeral rich message for a single user. */
  editEphemeralMessageText(chatId, receiverUserId, ephemeralMessageId, richMessage, extra = {}, files = null) {
    let payload = richMessage;
    if (typeof richMessage === 'string') {
      payload = RichMessageBuilder.fromHtml(richMessage).toJSON();
    } else if (richMessage && typeof richMessage.html === 'string') {
      payload = RichMessageBuilder.fromHtml(richMessage.html).toJSON();
    }
    return this.call(
      'editEphemeralMessageText',
      {
        chat_id: chatId,
        receiver_user_id: Number(receiverUserId),
        ephemeral_message_id: Number(ephemeralMessageId),
        rich_message: payload,
        ...extra
      },
      { files }
    );
  }

  /** Bot API 10.3+: delete an ephemeral message for a single user. */
  deleteEphemeralMessage(chatId, receiverUserId, ephemeralMessageId) {
    return this.call('deleteEphemeralMessage', {
      chat_id: chatId,
      receiver_user_id: Number(receiverUserId),
      ephemeral_message_id: Number(ephemeralMessageId)
    });
  }

  /** Edit a message's rich content (Bot API 10.1+ rich_message param). */
  async editMessageRich(chatId, messageId, richMessage, extra = {}, files = null) {
    let payload = richMessage;
    if (typeof richMessage === 'string') {
      payload = RichMessageBuilder.fromHtml(richMessage).toJSON();
    } else if (richMessage && typeof richMessage.html === 'string') {
      payload = RichMessageBuilder.fromHtml(richMessage.html).toJSON();
    }
    const { dropOnFloodWait: rawDrop, ...restExtra } = (extra && typeof extra === 'object') ? extra : {};
    const dropOnFloodWait = Boolean(rawDrop);
    return this.#callRichWithEmojiFallback(
      'editMessageText',
      { chat_id: chatId, message_id: messageId, ...restExtra },
      payload,
      { files, dropOnFloodWait }
    );
  }

  editMessageText(chatId, messageId, text, extra = {}) {
    const params = applyCustomEmojisToOutgoingParams({ chat_id: chatId, message_id: messageId, text, ...extra });
    if (/https?:\/\/[^\s]+/i.test(text) && !params.link_preview_options && params.disable_web_page_preview === undefined) {
      params.link_preview_options = { is_disabled: false, prefer_large_media: true };
    }
    return this.call('editMessageText', params);
  }

  editMessageReplyMarkup(chatId, messageId, replyMarkup) {
    return this.call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup });
  }

  editMessageMedia(params, extra = {}) {
    return this.call('editMessageMedia', { ...params, ...extra });
  }

  editMessageCaption(params, extra = {}) {
    return this.call('editMessageCaption', applyCustomEmojisToOutgoingParams({ ...params, ...extra }, { isCaption: true }));
  }

  async setMessageReaction(chatId, messageId, reactions = [], extra = {}) {
    const list = Array.isArray(reactions) ? reactions : [reactions];
    const resolved = [];
    const standardFallback = [];
    for (const item of list) {
      if (!item) continue;
      if (typeof item === 'object' && item.type) {
        resolved.push(item);
        if (item.type === 'emoji' && item.emoji) standardFallback.push(item);
        continue;
      }
      const raw = String(item).trim();
      if (!raw) continue;
      if (/^\d+$/.test(raw)) {
        resolved.push({ type: 'custom_emoji', custom_emoji_id: raw });
        continue;
      }
      const customId = extra.preferCustom !== false ? getCustomEmojiId(raw) : null;
      if (customId) {
        resolved.push({ type: 'custom_emoji', custom_emoji_id: String(customId) });
      } else {
        resolved.push({ type: 'emoji', emoji: raw });
      }
      standardFallback.push({ type: 'emoji', emoji: raw });
    }
    const { preferCustom: _pc, ...restExtra } = extra && typeof extra === 'object' ? extra : {};
    try {
      return await this.call('setMessageReaction', {
        chat_id: chatId,
        message_id: messageId,
        reaction: resolved,
        ...restExtra
      });
    } catch (err) {
      if (standardFallback.length > 0 && resolved.some((r) => r.type === 'custom_emoji') && /reaction|custom_emoji|emoji/i.test(String(err?.description || err?.message || ''))) {
        return this.call('setMessageReaction', {
          chat_id: chatId,
          message_id: messageId,
          reaction: standardFallback,
          ...restExtra
        });
      }
      throw err;
    }
  }

  /** Bot API 9.5+/10.4: stream partial message drafts in private chat while AI generates a reply. */
  sendMessageDraft(chatId, draftId, text, extra = {}) {
    const params = applyCustomEmojisToOutgoingParams({
      chat_id: chatId,
      draft_id: Number(draftId) || 1,
      text: String(text || '').slice(0, 4096),
      ...extra
    });
    return this.call('sendMessageDraft', params, { dropOnFloodWait: true });
  }

  /** Bot API 10.4: send an interactive HTML Widget message (DM only in Telegram production). */
  sendWidget(chatId, html, extra = {}) {
    return this.call('sendWidget', {
      chat_id: chatId,
      html: String(html || ''),
      ...extra
    });
  }

  /** Bot API 10.4: resend a shared widget previously created by the bot. */
  sendSharedWidget(chatId, widgetId, extra = {}) {
    return this.call('sendSharedWidget', {
      chat_id: chatId,
      widget_id: String(widgetId),
      ...extra
    });
  }

  /** Bot API 10.4: answer an incoming WidgetQuery or SharedWidgetQuery. */
  answerWidgetQuery(widgetQueryId, extra = {}) {
    return this.call('answerWidgetQuery', {
      widget_query_id: String(widgetQueryId),
      ...extra
    });
  }

  /** Bot API 10.4: update the data payload of an existing widget message. */
  editMessageWidgetData(chatId, messageId, data, extra = {}) {
    return this.call('editMessageWidgetData', {
      chat_id: chatId,
      message_id: messageId,
      data: typeof data === 'string' ? data : JSON.stringify(data || {}),
      ...extra
    });
  }

  /** Bot API 10.4: update a shared widget's public data payload. */
  editSharedWidgetData(widgetId, data, extra = {}) {
    return this.call('editSharedWidgetData', {
      widget_id: String(widgetId),
      data: typeof data === 'string' ? data : JSON.stringify(data || {}),
      ...extra
    });
  }

  sendMediaGroup(chatId, media, extra = {}, files = null) {
    return this.call('sendMediaGroup', { chat_id: chatId, media, ...extra }, { files });
  }

  sendPhoto(chatId, photo, extra = {}, files = null) {
    const cleanExtra = applyCustomEmojisToOutgoingParams({ ...extra }, { isCaption: true });
    if (Buffer.isBuffer(photo)) {
      const filename = cleanExtra.filename ?? 'photo.jpg';
      const contentType = cleanExtra.contentType ?? (filename.endsWith('.png') ? 'image/png' : 'image/jpeg');
      return this.call('sendPhoto', { chat_id: chatId, photo: 'attach://photo', ...cleanExtra }, {
        files: { photo: { buffer: photo, filename, contentType } }
      });
    }
    const params = { chat_id: chatId, ...cleanExtra };
    if (files?.photo) {
      params.photo = 'attach://photo';
      return this.call('sendPhoto', params, { files });
    }
    params.photo = photo;
    return this.call('sendPhoto', params);
  }

  sendVideo(chatId, video, extra = {}, files = null) {
    const cleanExtra = applyCustomEmojisToOutgoingParams({ ...extra }, { isCaption: true });
    if (Buffer.isBuffer(video)) {
      return this.call('sendVideo', { chat_id: chatId, video: 'attach://video', ...cleanExtra }, {
        files: { video: { buffer: video, filename: cleanExtra.filename ?? 'video.mp4', contentType: 'video/mp4' } }
      });
    }
    if (video && typeof video === 'object' && video.filePath) {
      return this.call('sendVideo', { chat_id: chatId, video: 'attach://video', ...cleanExtra }, {
        files: { video: { filePath: video.filePath, filename: video.filename ?? cleanExtra.filename ?? 'video.mp4', contentType: video.contentType ?? 'video/mp4' } }
      });
    }
    const params = { chat_id: chatId, ...cleanExtra };
    if (files?.video) {
      params.video = 'attach://video';
      return this.call('sendVideo', params, { files });
    }
    params.video = video;
    return this.call('sendVideo', params);
  }

  sendAnimation(chatId, animation, extra = {}, files = null) {
    const cleanExtra = applyCustomEmojisToOutgoingParams({ ...extra }, { isCaption: true });
    if (Buffer.isBuffer(animation)) {
      return this.call('sendAnimation', { chat_id: chatId, animation: 'attach://animation', ...cleanExtra }, {
        files: { animation: { buffer: animation, filename: cleanExtra.filename ?? 'animation.mp4', contentType: 'video/mp4' } }
      });
    }
    const params = { chat_id: chatId, ...cleanExtra };
    if (files?.animation) {
      params.animation = 'attach://animation';
      return this.call('sendAnimation', params, { files });
    }
    params.animation = animation;
    return this.call('sendAnimation', params);
  }

  sendAudio(chatId, audio, extra = {}, files = null) {
    const cleanExtra = applyCustomEmojisToOutgoingParams({ ...extra }, { isCaption: true });
    const { filename = 'audio.mp3', thumbnail = null, ...restExtra } = cleanExtra;
    const allFiles = files ? { ...files } : {};
    const params = { chat_id: chatId, ...restExtra };

    if (Buffer.isBuffer(audio)) {
      params.audio = 'attach://audio';
      allFiles.audio = { buffer: audio, filename, contentType: 'audio/mpeg' };
    } else if (allFiles.audio) {
      params.audio = 'attach://audio';
    } else {
      params.audio = audio;
    }

    if (Buffer.isBuffer(thumbnail)) {
      params.thumbnail = 'attach://thumbnail';
      allFiles.thumbnail = { buffer: thumbnail, filename: 'thumb.jpg', contentType: 'image/jpeg' };
    } else if (thumbnail) {
      params.thumbnail = thumbnail;
    }

    if (Object.keys(allFiles).length > 0) {
      return this.call('sendAudio', params, { files: allFiles });
    }
    return this.call('sendAudio', params);
  }

  sendVoice(chatId, voice, extra = {}, files = null) {
    const cleanExtra = applyCustomEmojisToOutgoingParams({ ...extra }, { isCaption: true });
    const { filename = 'voice.ogg', contentType = 'audio/ogg', ...restExtra } = cleanExtra;
    const allFiles = files ? { ...files } : {};
    const params = { chat_id: chatId, ...restExtra };
    if (Buffer.isBuffer(voice)) {
      params.voice = 'attach://voice';
      allFiles.voice = { buffer: voice, filename, contentType };
    } else if (allFiles.voice) {
      params.voice = 'attach://voice';
    } else {
      params.voice = voice;
    }
    if (Object.keys(allFiles).length > 0) {
      return this.call('sendVoice', params, { files: allFiles });
    }
    return this.call('sendVoice', params);
  }

  sendDocument(chatId, document, extra = {}, files = null) {
    const cleanExtra = applyCustomEmojisToOutgoingParams({ ...extra }, { isCaption: true });
    const { filename = 'file.bin', contentType = 'application/octet-stream', ...restExtra } = cleanExtra;
    const allFiles = files ? { ...files } : {};
    const params = { chat_id: chatId, ...restExtra };

    if (Buffer.isBuffer(document)) {
      params.document = 'attach://document';
      allFiles.document = { buffer: document, filename, contentType };
    } else if (allFiles.document) {
      params.document = 'attach://document';
    } else {
      params.document = document;
    }

    if (Object.keys(allFiles).length > 0) {
      return this.call('sendDocument', params, { files: allFiles });
    }
    return this.call('sendDocument', params);
  }

  sendSticker(chatId, sticker, extra = {}) {
    if (Buffer.isBuffer(sticker) || (typeof sticker === 'object' && sticker !== null && (sticker.buffer || sticker.filePath))) {
      const isVideo = extra.is_video || extra.isVideo;
      const isAnimated = extra.is_animated || extra.isAnimated;
      const ext = isAnimated ? 'tgs' : (isVideo ? 'webm' : 'webp');
      const contentType = isAnimated ? 'application/x-tgsticker' : (isVideo ? 'video/webm' : 'image/webp');
      const filename = sticker?.filename ?? `sticker.${ext}`;
      const fileSpec = Buffer.isBuffer(sticker)
        ? { buffer: sticker, filename, contentType }
        : { ...sticker, filename, contentType };
      const { is_video, isVideo: _iv, is_animated, isAnimated: _ia, ...cleanExtra } = extra;
      return this.call('sendSticker', { chat_id: chatId, sticker: 'attach://sticker', ...cleanExtra }, {
        files: { sticker: fileSpec }
      });
    }
    return this.call('sendSticker', { chat_id: chatId, sticker, ...extra });
  }

  sendChatAction(chatId, action = 'typing', { minIntervalMs = 4000 } = {}) {
    if (chatId === undefined || chatId === null) return Promise.resolve(null);
    const key = String(chatId);
    const now = Date.now();
    const floodUntil = Math.max(this.globalFloodUntil, this.chatFloodUntil.get(key) || 0);
    if (floodUntil > now) return Promise.resolve(null);
    const prev = this.lastChatAction.get(key);
    if (prev && (now - prev.at) < minIntervalMs && prev.action === action) {
      return Promise.resolve(null);
    }
    if (prev && (now - prev.at) < 1800) {
      return Promise.resolve(null);
    }
    this.lastChatAction.set(key, { action, at: now });
    if (this.lastChatAction.size > 1000) {
      for (const [k, v] of this.lastChatAction) {
        if (now - v.at > 30000) this.lastChatAction.delete(k);
      }
    }
    return this.call('sendChatAction', { chat_id: chatId, action }, { dropOnFloodWait: true }).catch(() => null);
  }

  answerCallbackQuery(id, { text, showAlert = false, show_alert = false, url, cacheTime = 0, cache_time = 0 } = {}) {
    if (!id) return Promise.resolve();
    if (!this.answeredCallbackIds) this.answeredCallbackIds = new Set();
    const key = String(id);
    if (this.answeredCallbackIds.has(key)) return Promise.resolve();
    this.answeredCallbackIds.add(key);
    if (this.answeredCallbackIds.size > 2000) {
      const first = this.answeredCallbackIds.values().next().value;
      if (first !== undefined) this.answeredCallbackIds.delete(first);
    }
    const isAlert = Boolean(show_alert || showAlert);
    return this.call('answerCallbackQuery', {
      callback_query_id: id, text, show_alert: isAlert, url, cache_time: cache_time || cacheTime
    }).catch(() => {});
  }

  deleteMessage(chatId, messageId) {
    return this.call('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => null);
  }

  pinChatMessage(chatId, messageId, { disableNotification = true } = {}) {
    return this.call('pinChatMessage', { chat_id: chatId, message_id: messageId, disable_notification: disableNotification }).catch(() => null);
  }

  unpinChatMessage(chatId, messageId = undefined) {
    const params = { chat_id: chatId };
    if (messageId !== undefined && messageId !== null) params.message_id = messageId;
    return this.call('unpinChatMessage', params).catch(() => null);
  }

  sendInvoice(chatId, { title, description, payload, currency = 'XTR', prices = [], startParameter = undefined, replyToMessageId = undefined } = {}) {
    return this.call('sendInvoice', {
      chat_id: chatId,
      title: String(title || '').slice(0, 32),
      description: String(description || '').slice(0, 255),
      payload: String(payload || ''),
      currency: String(currency || 'XTR'),
      prices,
      ...(currency === 'XTR' ? {} : { provider_token: '' }),
      ...(startParameter ? { start_parameter: startParameter } : {}),
      ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {})
    });
  }

  answerPreCheckoutQuery(preCheckoutQueryId, ok = true, errorMessage = undefined) {
    return this.call('answerPreCheckoutQuery', {
      pre_checkout_query_id: preCheckoutQueryId,
      ok: Boolean(ok),
      ...(!ok && errorMessage ? { error_message: String(errorMessage).slice(0, 255) } : {})
    });
  }

  refundStarPayment(userId, telegramPaymentChargeId) {
    return this.call('refundStarPayment', {
      user_id: Number(userId),
      telegram_payment_charge_id: String(telegramPaymentChargeId)
    });
  }

  sendPoll(chatId, question, options, extra = {}) {
    const opts = Array.isArray(options)
      ? options.map((o) => (typeof o === 'string' ? { text: o } : o))
      : [];
    return this.call('sendPoll', {
      chat_id: chatId,
      question,
      options: opts,
      ...extra
    });
  }

  stopPoll(chatId, messageId, extra = {}) {
    return this.call('stopPoll', { chat_id: chatId, message_id: messageId, ...extra });
  }

  getUserProfilePhotos(userId, extra = {}) {
    return this.call('getUserProfilePhotos', { user_id: userId, ...extra });
  }

  getFile(fileId) {
    return this.call('getFile', { file_id: fileId });
  }

  /** Resolve a getFile path: --local servers return an absolute path on disk. */
  async readFileBytes(filePath, { maxBytes = Infinity, signal } = {}) {
    if (this.isLocalServer && String(filePath).startsWith('/')) {
      const { stat, readFile } = await import('node:fs/promises');
      const { resolve } = await import('node:path');
      const full = resolve(filePath);
      const allowedRoots = [
        process.env.TELEGRAM_LOCAL_FILES_ROOT || '/var/lib/telegram-bot-api',
        '/var/lib/telegram-bot-api',
        '/data/telegram-bot-api'
      ].map((r) => resolve(r) + '/');
      if (!allowedRoots.some((rootPrefix) => full.startsWith(rootPrefix))) {
        throw new Error('Telegram local file is outside the configured Bot API data directory');
      }
      if ((await stat(full)).size > maxBytes) throw new Error('Telegram file exceeds the size limit');
      return readFile(full);
    }
    const response = await fetch(`${this.apiRoot}/file/bot${this.token}/${filePath}`, { signal, redirect: 'error' });
    if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  async downloadFile(filePath) {
    return this.readFileBytes(filePath);
  }

  setMyCommands(commands, extra = {}) {
    return this.call('setMyCommands', { commands, ...extra });
  }

  // ── Stickers & Custom Emojis ──────────────────────────────────────────
  getStickerSet(name) {
    return this.call('getStickerSet', { name });
  }

  getCustomEmojiStickers(customEmojiIds = []) {
    const ids = Array.isArray(customEmojiIds) ? customEmojiIds.filter(Boolean).map(String) : [];
    return this.call('getCustomEmojiStickers', { custom_emoji_ids: ids });
  }

  /** Normalize an InputSticker's file payload (buffer or filePath) into multipart attach. */
  #attachInputSticker(sticker, fieldName, files) {
    const out = { ...sticker };
    const src = sticker?.sticker;
    if (src && typeof src === 'object' && (src.buffer || src.filePath)) {
      const format = out.format || 'static';
      const defaultExt = format === 'video' ? 'webm' : (format === 'animated' ? 'tgs' : 'webp');
      const filename = src.filename ?? `${fieldName}.${defaultExt}`;
      const defaultMime = format === 'video'
        ? 'video/webm'
        : (format === 'animated' ? 'application/x-tgsticker' : (filename.endsWith('.png') ? 'image/png' : 'image/webp'));
      files[fieldName] = {
        ...(src.buffer ? { buffer: src.buffer } : { filePath: src.filePath }),
        filename,
        contentType: src.contentType ?? defaultMime
      };
      out.sticker = `attach://${fieldName}`;
    }
    return out;
  }

  /**
   * createNewStickerSet — current Bot API: `stickers` is a list of 1..N
   * InputSticker (initial limit is lower than the total set limit — we keep
   * it configurable and default to 1; the rest go through addStickerToSet).
   */
  createNewStickerSet({ userId, name, title, stickers, stickerType = 'regular', needsRepainting }) {
    const params = {
      user_id: userId,
      name,
      title,
      stickers,
      sticker_type: stickerType === 'emoji' ? 'custom_emoji' : stickerType
    };
    if (needsRepainting !== undefined) params.needs_repainting = needsRepainting;
    const files = {};
    params.stickers = stickers.map((sticker, index) => this.#attachInputSticker(sticker, `sticker_${index}`, files));
    return this.call('createNewStickerSet', params, { files: Object.keys(files).length ? files : null });
  }

  addStickerToSet({ userId, name, sticker }) {
    const files = {};
    const params = {
      user_id: userId,
      name,
      sticker: this.#attachInputSticker(sticker, 'sticker_file', files)
    };
    return this.call('addStickerToSet', params, { files: Object.keys(files).length ? files : null });
  }

  replaceStickerInSet({ userId, name, oldSticker, sticker }) {
    const files = {};
    const params = {
      user_id: userId,
      name,
      old_sticker: oldSticker,
      sticker: this.#attachInputSticker(sticker, 'sticker_file', files)
    };
    return this.call('replaceStickerInSet', params, { files: Object.keys(files).length ? files : null });
  }

  deleteStickerFromSet(sticker) {
    return this.call('deleteStickerFromSet', { sticker });
  }

  setStickerPositionInSet({ sticker, position }) {
    return this.call('setStickerPositionInSet', { sticker, position: Number(position) });
  }

  setStickerSetTitle({ name, title }) {
    return this.call('setStickerSetTitle', { name, title });
  }

  setStickerSetThumbnail({ name, userId, thumbnail, format }) {
    const params = { name, user_id: userId };
    if (format) params.format = format;
    const files = {};
    if (thumbnail && typeof thumbnail === 'object' && (thumbnail.buffer || thumbnail.filePath)) {
      files.thumbnail = {
        ...(thumbnail.buffer ? { buffer: thumbnail.buffer } : { filePath: thumbnail.filePath }),
        filename: thumbnail.filename ?? 'thumb.webp',
        contentType: thumbnail.contentType ?? (format === 'video' ? 'video/webm' : 'image/webp')
      };
      params.thumbnail = 'attach://thumbnail';
    } else if (thumbnail) {
      params.thumbnail = thumbnail;
    }
    return this.call('setStickerSetThumbnail', params, { files: Object.keys(files).length ? files : null });
  }

  setCustomEmojiStickerSetThumbnail({ name, customEmojiId = '' } = {}) {
    const params = { name };
    if (customEmojiId) params.custom_emoji_id = String(customEmojiId);
    return this.call('setCustomEmojiStickerSetThumbnail', params);
  }

  deleteStickerSet(name) {
    return this.call('deleteStickerSet', { name });
  }

  // ── Polling ───────────────────────────────────────────────────────────
  async poll({ offset, timeout = 30, signal } = {}) {
    const params = {
      offset,
      timeout,
      allowed_updates: [
        'message',
        'callback_query',
        'edited_message',
        'channel_post',
        'edited_channel_post',
        'inline_query',
        'chosen_inline_result',
        'chat_member',
        'my_chat_member',
        'chat_join_request',
        'poll',
        'poll_answer',
        'pre_checkout_query'
      ]
    };
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await this.call('getUpdates', params, { timeoutMs: (timeout + 10) * 1000 });
    } catch (error) {
      if (error.name === 'AbortError' || signal?.aborted) return [];
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }
}
