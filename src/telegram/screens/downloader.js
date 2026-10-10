import { RichMessageBuilder, rt, block, richButton, encodeCallback } from '../rich.js';
import { banner, kvTable, statusDot } from '../ui.js';
import { States } from '../../core/stateMachine.js';
import { ProgressTracker } from '../progress.js';
import { logger } from '../../core/logger.js';
import { truncate } from '../../utils/text.js';
import { getLyrics, formatBlockquoteLyrics, chunkLyrics, escapeHtml } from '../../media/lyrics.js';
import { extractMediaForMusicRecognition } from '../../media/recognizer.js';
import { sleep, parseDurationToSeconds } from '../../utils/time.js';

// Global cache for track metadata: lyricKey -> { title, artist }
const lyricsCache = new Map();

export function createDownloaderScreen({ app }) {
  const id = 'downloader';
  const log = logger().child({ module: 'screen:downloader' });

  function renderMainMenu(ctx) {
    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '𓆩♡𓆪 URL DOWNLOADER STUDIO 𓆩♡𓆪',
      'download media from any link with audio extraction ♡'
    ])));
    b.divider();

    b.heading('୨୧ supported platforms', 3);
    b.paragraph(rt.text(
      '• 🎵 TikTok — HD videos without watermark & photo carousels\n' +
      '• 📌 Pinterest — Full carousel albums, HD videos & original pins\n' +
      '• 📸 Instagram — Reels, posts, carousels/albums & stories\n' +
      '• 🎬 YouTube & Shorts — HD videos + clean MP3 audio track\n' +
      '• 🐦 Twitter / X — HD videos & multi-image tweet posts\n' +
      '• 💙 Facebook & CapCut — Reels, videos & template downloads\n' +
      '• 🎧 Spotify — Track info & audio track extraction\n' +
      '• 🌐 Direct Web — Direct MP4 / WebM / JPG / PNG files'
    ));
    b.divider();

    b.table(kvTable([
      ['🎧 Audio Extraction', `${statusDot('online')} Auto-extracts MP3 if sound is present`],
      ['📦 Multi-Content', `${statusDot('online')} Full carousel & album extraction`],
      ['🎀 Delivery Mode', `${statusDot('online')} HD Media Group & Audio`]
    ]), { compact: true });
    b.divider();

    b.buttons([
      richButton.callback('✦ Paste / Send Link', encodeCallback(id, 'input'), { style: 'primary' }),
      richButton.callback('🎵 Play Music', encodeCallback(id, 'play'), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🎙️ Audio Recognition', encodeCallback(id, 'recognize'), { style: 'primary' }),
      richButton.callback('« Dashboard', encodeCallback('dashboard', 'open'))
    ]);

    b.footer(rt.italic('Tip: You can also simply paste any social link directly in chat ♡'));
    b.validate();
    return b.toJSON();
  }

  function renderInputPrompt() {
    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '𓆩♡𓆪 PASTE YOUR MEDIA LINK 𓆩♡𓆪',
      'ready to download & extract ♡'
    ])));
    b.divider();
    b.heading('୨୧ supported platforms & capabilities', 3);
    b.paragraph(rt.text(
      '🌸 🎵 TikTok — HD videos (no watermark) & photo slides/carousels + sound track\n' +
      '🌸 📌 Pinterest — Full carousel albums, high-res photos & video pins\n' +
      '🌸 📸 Instagram — Reels, video posts, multi-photo carousels & stories\n' +
      '🌸 🎬 YouTube — Shorts, standard videos & clean MP3 audio tracks\n' +
      '🌸 🐦 Twitter / X — HD videos, GIFs & multi-image tweet posts\n' +
      '🌸 💙 Facebook & CapCut — Reels, videos & template downloads\n' +
      '🌸 🎧 Spotify & Music Search — Spotify links OR type song name & artist directly\n' +
      '🌸 🌐 Direct Web — Direct MP4 / WebM videos and JPG / PNG images'
    ));
    b.divider();
    b.quote(rt.text(
      '✨ Send any media link OR type any song title/artist to search music!\n' +
      '🎧 If background music or sound is present, Lancy extracts and delivers the MP3 audio track automatically ♡'
    ));
    b.divider();
    b.buttons([
      richButton.callback('✕ Cancel', encodeCallback(id, 'cancel'), { style: 'danger' })
    ]);
    b.validate();
    return b.toJSON();
  }

  function renderMusicSearchPrompt() {
    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '𓆩♡𓆪 PLAY & DOWNLOAD MUSIC 𓆩♡𓆪',
      'search, stream & recognize music ♡'
    ])));
    b.divider();
    b.heading('୨୧ how to play & download', 3);
    b.paragraph(rt.text(
      '• 🎵 Type song title & artist (e.g. Blinding Lights The Weeknd)\n' +
      '• 🎧 Paste a Spotify / YouTube / SoundCloud link\n' +
      '• 🎙️ Forward or send any audio, voice note, or video snippet!'
    ));
    b.divider();
    b.quote(rt.text(
      '✨ Lancy will download the high-speed MP3 track with cover art & lyrics ♡\n' +
      '🎙️ Forwarded audio will be automatically recognized and downloaded!'
    ));
    b.divider();
    b.buttons([
      richButton.callback('🎙️ Audio Recognition', encodeCallback(id, 'recognize'), { style: 'primary' }),
      richButton.callback('« Downloader', encodeCallback(id, 'open'))
    ]);
    b.buttons([
      richButton.callback('✕ Cancel', encodeCallback(id, 'cancel'), { style: 'danger' })
    ]);
    b.validate();
    return b.toJSON();
  }

  function renderAudioRecognitionPrompt() {
    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '𓆩♡𓆪 AUDIO & MUSIC RECOGNITION 𓆩♡𓆪',
      'identify songs from forwarded audio or video ♡'
    ])));
    b.divider();
    b.heading('୨୧ how to recognize music', 3);
    b.paragraph(rt.text(
      '1. 🎧 Forward any audio track, music file, or song snippet to this chat\n' +
      '2. 🎬 Or forward any video (TikTok, Reel, story, etc.) with background music\n' +
      '3. 🎙️ Or record a voice note while the song is playing (speakers, car, TV)!\n\n' +
      '💡 Note: Recognition matches actual song tracks. If humming or recalling lyrics, use Search by Lyrics instead!'
    ));
    b.divider();
    b.quote(rt.text(
      '✨ Lancy listens to the sample, identifies the song title & artist, and automatically downloads the high-speed MP3 track with lyrics! ♡'
    ));
    b.divider();
    b.buttons([
      richButton.callback('🔍 Search by Song / Lyrics', encodeCallback(id, 'play'), { style: 'primary' }),
      richButton.callback('« Downloader', encodeCallback(id, 'open'))
    ]);
    b.buttons([
      richButton.callback('✕ Cancel', encodeCallback(id, 'cancel'), { style: 'danger' })
    ]);
    b.validate();
    return b.toJSON();
  }

  function renderDownloadProgress({ stage, platform, url, elapsedMs = 0, current = 0, total = 0 }) {
    const b = new RichMessageBuilder();
    b.paragraph(rt.bold(banner([
      '𓆩♡𓆪 URL DOWNLOADER 𓆩♡𓆪',
      'processing your media ♡'
    ])));
    b.divider();

    const elapsedSec = (elapsedMs / 1000).toFixed(1);
    b.quote(rt.text(
      `⏳ Stage: ${stage}\n` +
      `🔗 Link: ${truncate(url, 40)}\n` +
      (platform ? `📱 Platform: ${platform.toUpperCase()}\n` : '') +
      (total > 0 ? `📦 Items: ${current}/${total}\n` : '') +
      `⏱ Elapsed: ${elapsedSec}s ♡`
    ));
    b.divider();
    b.paragraph(rt.italic('Fetching full quality files & extracting audio track… ♡'));
    b.validate();
    return b.toJSON();
  }

  async function executeDownload(ctx, url) {
    const screenMsgId = ctx.messageId ?? ctx.sm?.context(ctx.tgId)?.screenMessageId;
    const tracker = new ProgressTracker({
      api: app.telegram.api,
      chatId: ctx.chatId,
      messageId: screenMsgId,
      heartbeatMs: 2000,
      action: 'typing'
    });

    await tracker.live((state, { elapsedMs }) => renderDownloadProgress({ ...state, elapsedMs, url }), {
      stage: ctx.initialStage || 'Analyzing link & detecting platform…',
      platform: '',
      url
    });

    try {
      const result = await app.mediaDownloader.download(url, {
        onProgress: (status) => {
          tracker.set({ stage: status });
        }
      });

      const { mediaItems = [], audioTrack = null, platform = 'Media', title = 'Downloaded Media' } = result;
      tracker.set({ stage: 'Delivering media to chat…', platform, total: mediaItems.length, current: mediaItems.length });

      const hasVideo = mediaItems.some((m) => m.type === 'video');
      tracker.setAction(hasVideo ? 'upload_video' : 'upload_photo');

      // Prepare unified files map and Rich Message following Lancy's signature pattern
      const files = {};
      const b = new RichMessageBuilder();

      b.paragraph(rt.bold(banner([
        `𓆩♡𓆪 ${platform.toUpperCase()} DOWNLOAD 𓆩♡𓆪`,
        'aesthetic media delivery ♡'
      ])));
      b.divider();

      // 1. Embed Downloaded Media (Video / Photo / Collage) inside Rich Message
      if (mediaItems.length === 1) {
        const item = mediaItems[0];
        const field = `${item.type}_0`;
        files[field] = {
          buffer: item.buffer,
          filename: item.filename || `${field}.${item.type === 'video' ? 'mp4' : 'jpg'}`,
          contentType: item.mimeType || (item.type === 'video' ? 'video/mp4' : 'image/jpeg')
        };
        if (item.type === 'video') {
          b.video(`attach://${field}`);
        } else {
          b.photo(`attach://${field}`);
        }
      } else if (mediaItems.length > 1) {
        const allPhotos = mediaItems.every((m) => m.type === 'photo');
        if (allPhotos) {
          // Chunk photos into collages (up to 10 per collage)
          for (let i = 0; i < mediaItems.length; i += 10) {
            const chunk = mediaItems.slice(i, i + 10);
            const chunkBlocks = chunk.map((item, idx) => {
              const globalIdx = i + idx;
              const field = `photo_${globalIdx}`;
              files[field] = {
                buffer: item.buffer,
                filename: item.filename || `${field}.jpg`,
                contentType: item.mimeType || 'image/jpeg'
              };
              return block.photo(`attach://${field}`);
            });
            b.collage(chunkBlocks);
          }
        } else {
          // Mixed videos and photos
          mediaItems.slice(0, 10).forEach((item, idx) => {
            const field = `${item.type}_${idx}`;
            files[field] = {
              buffer: item.buffer,
              filename: item.filename || `${field}.${item.type === 'video' ? 'mp4' : 'jpg'}`,
              contentType: item.mimeType || (item.type === 'video' ? 'video/mp4' : 'image/jpeg')
            };
            if (item.type === 'video') {
              b.video(`attach://${field}`);
            } else {
              b.photo(`attach://${field}`);
            }
          });
        }
      }

      // 2. Embed Audio / Music Track inside the same Rich Message!
      const isMusic = platform.toLowerCase() === 'spotify' || platform.toLowerCase() === 'music-search' || Boolean(result.artist);
      if (audioTrack && audioTrack.buffer) {
        const audioField = 'audio_track';
        files[audioField] = {
          buffer: audioTrack.buffer,
          filename: audioTrack.filename || `${(title || 'soundtrack').replace(/[^\w\s-]/g, '') || 'soundtrack'}.mp3`,
          contentType: 'audio/mpeg'
        };

        const parsedDuration = parseDurationToSeconds(audioTrack.duration || result.duration);
        const audioMediaObj = {
          media: `attach://${audioField}`,
          title: audioTrack.title || result.title || title || 'Audio Track',
          performer: audioTrack.performer || result.artist || result.author || 'Artist',
          ...(parsedDuration > 0 ? { duration: parsedDuration } : {})
        };

        if (isMusic) {
          b.audio(audioMediaObj);
        } else {
          b.audio(audioMediaObj, '🎵 Extracted Video Soundtrack (MP3) ♡');
        }
      }

      // 3. Metadata Table
      b.divider();
      const videoCount = mediaItems.filter((m) => m.type === 'video').length;
      const photoCount = mediaItems.filter((m) => m.type === 'photo').length;

      if (isMusic) {
        const musicRows = [
          ['📱 Platform', 'SPOTIFY / MUSIC ♡'],
          ['🎵 Title', truncate(result.title || title, 40)],
          ['🎧 Artist', truncate(result.artist || result.author || 'Spotify', 36)]
        ];
        if (result.album) musicRows.push(['💿 Album', truncate(result.album, 36)]);
        if (result.year) musicRows.push(['📅 Release', String(result.year)]);
        if (result.duration) musicRows.push(['⏱ Duration', String(result.duration)]);
        musicRows.push(['📦 Audio Quality', 'High-Speed MP3 (192k) + Artwork ♡']);
        b.table(kvTable(musicRows), { compact: true });
      } else {
        b.table(kvTable([
          ['📱 Platform', platform.toUpperCase()],
          ['🏷 Title', truncate(title, 36)],
          ['📦 Media Items', `${mediaItems.length} item(s) (${photoCount} photos, ${videoCount} videos)`],
          ['🎵 Sound / Audio', audioTrack ? 'Extracted & Included (MP3) ♡' : 'None in source']
        ]), { compact: true });
      }
      b.divider();

      // 4. Action Buttons
      const buttons = [
        richButton.callback('📥 Download Link', encodeCallback(id, 'input', ['from_media']), { style: 'primary' })
      ];
      if (isMusic || audioTrack) {
        const lyricKey = Math.random().toString(36).slice(2, 8);
        const songMeta = {
          title: result.title || title,
          artist: result.artist || result.author || ''
        };
        lyricsCache.set(lyricKey, songMeta);
        const db = app.db || ctx.db;
        try {
          db?.run?.(
            'INSERT OR REPLACE INTO bot_settings (key, value_json) VALUES (?, ?)',
            `lyric_${lyricKey}`,
            JSON.stringify(songMeta)
          );
        } catch {}
        buttons.push(richButton.callback('📜 Lyrics', encodeCallback(id, 'lyrics', lyricKey), { style: 'primary' }));
      }
      if (photoCount > 0) {
        buttons.push(richButton.callback('✦ Make Sticker Pack', encodeCallback('stickers', 'open', ['from_media']), { style: 'primary' }));
      }
      b.buttons(buttons);
      b.buttons([
        richButton.callback('🎵 Play Another', encodeCallback(id, 'play', ['from_media']), { style: 'primary' }),
        richButton.callback('« Dashboard', encodeCallback('dashboard', 'open', ['from_media']))
      ]);
      b.footer(rt.italic('Delivered with aesthetic love by Lancy Bot ♡'));
      b.validate();

      // 5. Deliver ONE unified Rich Message directly
      await tracker.finish(b.toJSON(), files);
      if (tracker.messageId) {
        (ctx.controller || app.telegram?.controller)?.markMediaDeliveryMessage?.(tracker.messageId);
        app.telegram?.markMediaDeliveryMessage?.(tracker.messageId);
      }
      await ctx.sm?.reset(ctx.tgId, { reason: 'download_complete' });
    } catch (err) {
      log.error({ err, url }, 'download failed');
      const b = new RichMessageBuilder();
      b.paragraph(rt.bold(banner([
        '𓆩♡𓆪 DOWNLOAD FAILED 𓆩♡𓆪',
        'could not retrieve media ♡'
      ])));
      const rawMsg = err.message || 'Unknown download error';
      let cleanErr = rawMsg;

      if (rawMsg.includes('Instagram profile link detected')) {
        cleanErr = rawMsg;
      } else if (/429|Too Many Requests/i.test(rawMsg)) {
        cleanErr = '🌸 This platform is temporarily rate-limiting requests (HTTP 429). Please wait a moment or send a direct post/reel link ♡';
      } else if (/private video|private account|login required/i.test(rawMsg)) {
        cleanErr = '🔒 This post or account is private. Lancy can only download from public posts and accounts ♡';
      } else if (/404|not found|unavailable/i.test(rawMsg)) {
        cleanErr = '✕ Media not found or removed by the author. Please verify the link and try again ♡';
      } else {
        cleanErr = rawMsg
          .replace(/Command failed:\s*yt-dlp[^\n]*\n?/gi, '')
          .replace(/--js-runtimes\s+node:[^\s]+/gi, '')
          .replace(/\/tmp\/[^\s]+/gi, '')
          .replace(/ERROR:\s*\[[^\]]+\]\s*/gi, '')
          .replace(/ERROR:\s*/gi, '')
          .trim() || rawMsg;
      }

      b.quote(rt.text(`✕ ${cleanErr}\n\nPlease check the link and try again ♡`));
      b.divider();
      b.buttons([
        richButton.callback('🔄 Try Again', encodeCallback(id, 'input'), { style: 'primary' }),
        richButton.callback('« Dashboard', encodeCallback('dashboard', 'open'))
      ]);
      b.validate();
      await tracker.finish(b.toJSON());
      await ctx.sm?.reset(ctx.tgId, { reason: 'download_error' });
    }
  }

  return {
    id,
    async open(ctx) {
      return ctx.editScreen(renderMainMenu(ctx));
    },
    async handle(ctx, action, args) {
      const fromMedia = Boolean(args?.includes('from_media') || ctx.fromMedia || ctx.forceNew);
      switch (action) {
        case 'open':
          if (fromMedia) return ctx.replyRich(renderMainMenu(ctx));
          return this.open(ctx);
        case 'input':
          await ctx.sm?.transition(ctx.tgId, States.URL_DOWNLOADER_INPUT);
          if (fromMedia) return ctx.replyRich(renderInputPrompt());
          return ctx.editScreen(renderInputPrompt());
        case 'play':
          await ctx.sm?.transition(ctx.tgId, States.URL_DOWNLOADER_INPUT);
          if (fromMedia) return ctx.replyRich(renderMusicSearchPrompt());
          return ctx.editScreen(renderMusicSearchPrompt());
        case 'recognize':
          await ctx.sm?.transition(ctx.tgId, States.URL_DOWNLOADER_INPUT);
          if (fromMedia) return ctx.replyRich(renderAudioRecognitionPrompt());
          return ctx.editScreen(renderAudioRecognitionPrompt());
        case 'lyrics': {
          const lyricKey = args[0];
          let cached = lyricsCache.get(lyricKey);
          if (!cached && lyricKey) {
            try {
              const row = (app.db || ctx.db)?.get?.('SELECT value_json FROM bot_settings WHERE key = ?', `lyric_${lyricKey}`);
              if (row?.value_json) {
                cached = JSON.parse(row.value_json);
                lyricsCache.set(lyricKey, cached);
              }
            } catch {}
          }

          // If still not found (e.g. from an older message), inspect message text/caption
          if (!cached || !cached.title || cached.title.toLowerCase() === 'song') {
            const msgText = String(ctx.query?.message?.text || ctx.query?.message?.caption || '');
            const titleMatch = msgText.match(/🎵\s*Title\s*\n\s*([^\n]+)/i);
            const artistMatch = msgText.match(/🎧\s*Artist\s*\n\s*([^\n]+)/i);
            if (titleMatch && titleMatch[1]) {
              cached = {
                title: titleMatch[1].replace(/[…\.]+$/, '').trim(),
                artist: (artistMatch && artistMatch[1]) ? artistMatch[1].replace(/[…\.]+$/, '').trim() : ''
              };
            }
          }

          const songTitle = cached?.title;
          const songArtist = cached?.artist || '';

          if (ctx.query?.id) {
            await ctx.api.answerCallbackQuery(ctx.query.id, { text: 'Retrieving lyrics… ♡' }).catch(() => {});
          }

          if (!songTitle || songTitle.toLowerCase() === 'song') {
            await ctx.api.sendMessage(
              ctx.chatId,
              '♡ Could not find lyrics: song title could not be determined from this card ♡\nTip: You can search lyrics directly with <code>/lyrics &lt;song name&gt;</code> ♡',
              { parse_mode: 'HTML' }
            );
            return;
          }

          const lyricsRes = await getLyrics(songTitle, songArtist);
          if (!lyricsRes.found || !lyricsRes.lyrics) {
            await ctx.api.sendMessage(
              ctx.chatId,
              `♡ Could not find lyrics for "<b>${escapeHtml(songTitle)}</b>" ♡\nTip: You can search lyrics directly with <code>/lyrics &lt;song&gt;</code> ♡`,
              { parse_mode: 'HTML' }
            );
            return;
          }

          // Chunk long lyrics safely to stay under Telegram limit and send continuations
          const chunks = chunkLyrics(lyricsRes.lyrics, 2400);
          const total = chunks.length;

          for (let i = 0; i < total; i++) {
            const isFirst = i === 0;
            const header = total === 1
              ? `𓆩♡𓆪 <b>SONG LYRICS</b> 𓆩♡𓆪\n🎵 <b>${escapeHtml(lyricsRes.title)}</b>` + (lyricsRes.artist ? ` — <i>${escapeHtml(lyricsRes.artist)}</i>` : '') + ` ♡\n\n`
              : `𓆩♡𓆪 <b>SONG LYRICS (${i + 1}/${total})</b> 𓆩♡𓆪\n🎵 <b>${escapeHtml(lyricsRes.title)}</b>` + (lyricsRes.artist ? ` — <i>${escapeHtml(lyricsRes.artist)}</i>` : '') + ` ♡\n\n`;

            const blockquoteHtml = formatBlockquoteLyrics(chunks[i], { expandable: true });
            const messageHtml = `${header}${blockquoteHtml}`;

            try {
              await ctx.api.sendMessage(ctx.chatId, messageHtml, { parse_mode: 'HTML' });
            } catch {
              try {
                await ctx.api.sendMessage(ctx.chatId, `${header}<blockquote>${escapeHtml(chunks[i])}</blockquote>`, { parse_mode: 'HTML' });
              } catch {
                await ctx.api.sendMessage(ctx.chatId, `${header.replace(/<[^>]+>/g, '')}${chunks[i]}`);
              }
            }

            if (total > 1) {
              await sleep(300);
            }
          }
          return;
        }
        case 'cancel':
          await ctx.sm?.reset(ctx.tgId, { reason: 'cancelled' });
          return this.open(ctx);
        case 'execute': {
          const url = args[0];
          if (url) return executeDownload(ctx, url);
          return this.open(ctx);
        }
        default:
          return this.open(ctx);
      }
    },
    executeDownload,
    registerStateHandlers(sm) {
      sm.register(States.URL_DOWNLOADER_INPUT, {
        onEnter: async (sctx) => {
          // Handled in handle('input')
        },
        onMessage: async (sctx, message) => {
          const recMedia = extractMediaForMusicRecognition(message);
          if (recMedia && recMedia.obj?.file_id) {
            const controller = app.telegram?.controller;
            if (controller?.handleAudioRecognition) {
              const ctx = {
                ...sctx,
                chatId: message.chat?.id || sctx.chatId,
                tgId: sctx.tgId || String(message.from?.id),
                api: app.telegram.api,
                message
              };
              await controller.handleAudioRecognition(ctx, recMedia.obj, message, recMedia);
              return true;
            }
          }

          const text = String(message.text || message.caption || '').trim();
          if (!text) return true;
          const match = text.match(/https?:\/\/[^\s]+/i);
          const target = match ? match[0] : text;
          const dlCtx = {
            ...sctx,
            controller: app.telegram?.controller,
            api: app.telegram?.api,
            chatId: message.chat?.id || sctx.chatId,
            tgId: sctx.tgId || String(message.from?.id),
            message
          };
          await executeDownload(dlCtx, target);
          return true;
        },
        onCancel: async (sctx) => {
          await sctx.reset?.({ reason: 'cancelled' });
        }
      });
    }
  };
}
