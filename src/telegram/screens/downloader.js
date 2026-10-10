import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { RichMessageBuilder, rt, block, richButton, encodeCallback } from '../rich.js';
import { banner, kvTable, statusDot } from '../ui.js';
import { States } from '../../core/stateMachine.js';
import { ProgressTracker } from '../progress.js';
import { logger } from '../../core/logger.js';
import { truncate } from '../../utils/text.js';
import { getLyrics, formatBlockquoteLyrics, chunkLyrics, escapeHtml } from '../../media/lyrics.js';
import { extractMediaForMusicRecognition, recognizeAudio } from '../../media/recognizer.js';
import { sleep, parseDurationToSeconds } from '../../utils/time.js';
import { toTelegramStaticSticker } from '../../media/convert.js';

// Global cache for track metadata: lyricKey -> { title, artist }
const lyricsCache = new Map();

// Global cache for track audio and metadata: audioKey -> Buffer / Object
const trackAudioCache = new Map();
const audioMetaCache = new Map();
const imageStickerCache = new Map();

function saveMediaImages(key, items) {
  if (imageStickerCache.size > 50) {
    const oldestKey = imageStickerCache.keys().next().value;
    imageStickerCache.delete(oldestKey);
  }
  imageStickerCache.set(key, items);
  try {
    for (let i = 0; i < Math.min(items.length, 15); i++) {
      writeFileSync(join(tmpdir(), `lancy_img_${key}_${i}.jpg`), items[i].buffer);
    }
    writeFileSync(join(tmpdir(), `lancy_img_${key}_meta.json`), JSON.stringify({ count: Math.min(items.length, 15) }));
  } catch {}
}

function getMediaImages(key) {
  let items = imageStickerCache.get(key);
  if (!items && key) {
    try {
      const metaPath = join(tmpdir(), `lancy_img_${key}_meta.json`);
      if (existsSync(metaPath)) {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
        items = [];
        for (let i = 0; i < (meta.count || 0); i++) {
          const imgPath = join(tmpdir(), `lancy_img_${key}_${i}.jpg`);
          if (existsSync(imgPath)) {
            items.push({ buffer: readFileSync(imgPath) });
          }
        }
        if (items.length > 0) imageStickerCache.set(key, items);
      }
    } catch {}
  }
  return items || [];
}

function saveTrackAudio(key, buffer, meta = null, thumb = null) {
  if (trackAudioCache.size > 50) {
    const oldestKey = trackAudioCache.keys().next().value;
    trackAudioCache.delete(oldestKey);
    audioMetaCache.delete(oldestKey);
  }
  trackAudioCache.set(key, buffer);
  if (meta) {
    const fullMeta = { ...meta, ...(thumb ? { thumb } : {}) };
    audioMetaCache.set(key, fullMeta);
  }
  try {
    writeFileSync(join(tmpdir(), `lancy_track_${key}.mp3`), buffer);
    if (meta) {
      const serializableMeta = { ...meta };
      delete serializableMeta.thumb;
      writeFileSync(join(tmpdir(), `lancy_meta_${key}.json`), JSON.stringify(serializableMeta));
    }
    if (thumb) {
      writeFileSync(join(tmpdir(), `lancy_thumb_${key}.jpg`), thumb);
    }
  } catch {}
}

function getTrackAudio(key) {
  let buf = trackAudioCache.get(key);
  if (!buf && key) {
    try {
      const filePath = join(tmpdir(), `lancy_track_${key}.mp3`);
      if (existsSync(filePath)) {
        buf = readFileSync(filePath);
        trackAudioCache.set(key, buf);
      }
    } catch {}
  }
  return buf;
}

function getTrackMeta(key, db = null) {
  let meta = audioMetaCache.get(key);
  if (!meta && key) {
    try {
      const metaPath = join(tmpdir(), `lancy_meta_${key}.json`);
      if (existsSync(metaPath)) {
        meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      }
    } catch {}
    if (!meta && db) {
      try {
        const row = db.get?.('SELECT value_json FROM bot_settings WHERE key = ?', `audio_meta_${key}`);
        if (row?.value_json) {
          meta = JSON.parse(row.value_json);
        }
      } catch {}
    }
    if (meta) {
      try {
        const thumbPath = join(tmpdir(), `lancy_thumb_${key}.jpg`);
        if (existsSync(thumbPath)) {
          meta.thumb = readFileSync(thumbPath);
        }
      } catch {}
      audioMetaCache.set(key, meta);
    }
  }
  return meta;
}

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
      '✨ Send any media link, type /grab <link>, or type any song title/artist to search music!\n' +
      '🎧 If background music or sound is present, Lancy extracts and delivers the MP3 audio track automatically ♡'
    ));
    b.divider();
    b.buttons([
      richButton.callback('✕ Cancel', encodeCallback(id, 'cancel'), { style: 'danger' })
    ]);
    b.validate();
    return b.toJSON();
  }

  function renderMusicSearchPrompt(ctx = null) {
    const b = new RichMessageBuilder();
    const botName = ctx?.bot?.botName || ctx?.botName || 'Lancy';
    const isGroup = Boolean(ctx?.isGroup);

    b.paragraph(rt.bold(banner([
      '𓆩♡𓆪 PLAY & DOWNLOAD MUSIC 𓆩♡𓆪',
      'search, stream & recognize music ♡'
    ])));
    b.divider();
    b.heading('୨୧ how to play & download', 3);
    if (isGroup) {
      b.paragraph(rt.text(
        '• 🎵 Type /play <song title> directly in this chat\n' +
        '• 🔍 Tap "Search Music Live" below to search right from your chat box!\n' +
        '• 🎧 Or reply to this card with any song title or Spotify link\n' +
        '• 🎙️ Forward or send any audio, voice note, or video snippet!'
      ));
    } else {
      b.paragraph(rt.text(
        '• 🎵 Type song title & artist (e.g. Blinding Lights The Weeknd)\n' +
        '• 🎧 Paste a Spotify / YouTube / SoundCloud link\n' +
        '• 🎙️ Forward or send any audio, voice note, or video snippet!'
      ));
    }
    b.divider();
    b.quote(rt.text(
      `✨ ${botName} will download the high-speed MP3 track with cover art & lyrics ♡\n` +
      '🎙️ Forwarded audio will be automatically recognized and downloaded!'
    ));
    b.divider();
    b.buttons([
      richButton.switchInlineCurrent('🔍 Search Music Live', ''),
      richButton.callback('🎙️ Audio Recognition', encodeCallback(id, 'recognize'), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('« Downloader', encodeCallback(id, 'open')),
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
    const isGroup = Boolean(ctx.isGroup);
    const forceNew = Boolean(ctx.forceNew);
    const screenMsgId = (isGroup || forceNew) ? null : (ctx.messageId ?? ctx.sm?.context(ctx.tgId)?.screenMessageId);
    const tracker = new ProgressTracker({
      api: ctx.api || app.telegram.api,
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

      b.header(`𓆩♡𓆪 ${platform.toUpperCase()} DOWNLOAD 𓆩♡𓆪`, 1);
      b.paragraph(rt.italic('₊˚⊹♡ aesthetic media delivery ♡ ˙ᵕ˙'));
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
        // Chunk media into swipeable slideshows (up to 10 items per slideshow)
        for (let i = 0; i < mediaItems.length; i += 10) {
          const chunk = mediaItems.slice(i, i + 10);
          const chunkBlocks = chunk.map((item, idx) => {
            const globalIdx = i + idx;
            const field = `${item.type}_${globalIdx}`;
            files[field] = {
              buffer: item.buffer,
              filename: item.filename || `${field}.${item.type === 'video' ? 'mp4' : 'jpg'}`,
              contentType: item.mimeType || (item.type === 'video' ? 'video/mp4' : 'image/jpeg')
            };
            return item.type === 'video' ? block.video(`attach://${field}`) : block.photo(`attach://${field}`);
          });
          b.slideshow(chunkBlocks);
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
        if (ctx.isGroup) {
          musicRows.push(['👤 Requested By', ctx.user?.first_name ? `${ctx.user.first_name}` : 'Member']);
        }
        b.table(kvTable(musicRows), { compact: true });
      } else {
        const metaRows = [
          ['📱 Platform', platform.toUpperCase()],
          ['🏷 Title', truncate(title, 36)],
          ['📦 Media Items', `${mediaItems.length} item(s) (${photoCount} photos, ${videoCount} videos)`],
          ['🎵 Sound / Audio', audioTrack ? 'Extracted & Included (MP3) ♡' : 'None in source']
        ];
        if (ctx.isGroup) {
          metaRows.push(['👤 Requested By', ctx.user?.first_name ? `${ctx.user.first_name}` : 'Member']);
        }
        b.table(kvTable(metaRows), { compact: true });
      }
      b.divider();

      // 4. Action Buttons
      const photoItem = mediaItems.find((m) => m.type === 'photo');
      const photoItems = mediaItems.filter((m) => m.type === 'photo');
      const thumbBuf = photoItem?.buffer || null;

      let imageKey = null;
      if (photoItems.length > 0) {
        imageKey = Math.random().toString(36).slice(2, 8);
        saveMediaImages(imageKey, photoItems);
      }

      let audioKey = null;
      if (audioTrack && audioTrack.buffer) {
        audioKey = Math.random().toString(36).slice(2, 8);
        const parsedDuration = parseDurationToSeconds(audioTrack.duration || result.duration);
        const audioMeta = {
          title: audioTrack.title || result.title || title || 'Audio Track',
          performer: audioTrack.performer || result.artist || result.author || (isMusic ? 'Spotify' : 'Soundtrack'),
          duration: parsedDuration > 0 ? parsedDuration : undefined,
          filename: audioTrack.filename || `${(title || 'soundtrack').replace(/[^\w\s-]/g, '') || 'soundtrack'}.mp3`,
          album: result.album || null,
          year: result.year || null,
          platform: isMusic ? 'SPOTIFY / MUSIC ♡' : platform.toUpperCase(),
          requestedBy: ctx.isGroup && ctx.user?.first_name ? ctx.user.first_name : null
        };
        saveTrackAudio(audioKey, audioTrack.buffer, audioMeta, thumbBuf);
        const db = app.db || ctx.db;
        try {
          db?.run?.(
            'INSERT OR REPLACE INTO bot_settings (key, value_json) VALUES (?, ?)',
            `audio_meta_${audioKey}`,
            JSON.stringify(audioMeta)
          );
        } catch {}
      }

      const audioActionRow = [];
      if (audioKey) {
        audioActionRow.push(
          richButton.callback('🎵 Send Audio File', encodeCallback(id, 'send_audio', audioKey), { style: 'primary' })
        );
      }
      if (isMusic) {
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
        audioActionRow.push(
          richButton.callback('📜 Lyrics', encodeCallback(id, 'lyrics', lyricKey), { style: 'primary' })
        );
      } else if (audioKey) {
        audioActionRow.push(
          richButton.callback('🎧 Identify Song', encodeCallback(id, 'identify', audioKey), { style: 'primary' })
        );
      }

      if (audioActionRow.length > 0) {
        b.buttons(audioActionRow);
      }

      const mediaRow = [
        richButton.callback('📥 Download Link', encodeCallback(id, 'input', ['from_media']), { style: 'primary' })
      ];
      if (photoCount > 0 && imageKey) {
        mediaRow.push(
          richButton.callback(
            photoCount > 1 ? `🎨 Turn to Sticker (${photoCount})` : '🎨 Turn to Sticker',
            encodeCallback(id, 'to_sticker', imageKey, 'from_media'),
            { style: 'primary' }
          )
        );
        mediaRow.push(
          richButton.callback('✦ Sticker Pack', encodeCallback('stickers', 'open', ['from_media']), { style: 'primary' })
        );
      }
      b.buttons(mediaRow);

      b.buttons([
        richButton.callback('🎵 Play Another', encodeCallback(id, 'play', ['from_media']), { style: 'primary' }),
        richButton.callback('« Dashboard', encodeCallback('dashboard', 'open', ['from_media']), { style: 'primary' })
      ]);
      b.footer(rt.italic(`Delivered with aesthetic love by ${ctx.botName || 'Lancy Bot'} ♡`));
      b.validate();

      // 5. Deliver Rich Message
      const sent = await tracker.finish(b.toJSON(), files);
      if (tracker.messageId) {
        (ctx.controller || app.telegram?.controller)?.markMediaDeliveryMessage?.(tracker.messageId);
        app.telegram?.markMediaDeliveryMessage?.(tracker.messageId);
      }

      // Auto-cache audio track in SQLite cached_audio_tracks for instant live inline playback
      let richAudioFileId = sent?.audio?.file_id || sent?.document?.file_id;
      if (!richAudioFileId && Array.isArray(sent?.rich_message?.blocks)) {
        for (const blk of sent.rich_message.blocks) {
          if (blk.type === 'audio' && blk.audio?.file_id) {
            richAudioFileId = blk.audio.file_id;
            break;
          }
        }
      }

      if (richAudioFileId && (isMusic || audioTrack)) {
        const db = app.db || ctx.db;
        try {
          const songTitle = result.title || title || 'Audio Track';
          const songPerformer = result.artist || result.author || null;
          const parsedDur = parseDurationToSeconds(audioTrack?.duration || result.duration) || 0;
          const sql = 'INSERT OR REPLACE INTO cached_audio_tracks (query, file_id, title, artist, duration) VALUES (?, ?, ?, ?, ?)';
          const cleanQuery = (url || '').toLowerCase().trim();
          if (typeof db?.run === 'function') {
            db.run(sql, cleanQuery, richAudioFileId, songTitle, songPerformer, parsedDur);
            if (songTitle && songTitle.toLowerCase() !== cleanQuery) {
              db.run(sql, songTitle.toLowerCase().trim(), richAudioFileId, songTitle, songPerformer, parsedDur);
            }
          } else if (typeof db?.prepare === 'function') {
            db.prepare(sql).run(cleanQuery, richAudioFileId, songTitle, songPerformer, parsedDur);
            if (songTitle && songTitle.toLowerCase() !== cleanQuery) {
              db.prepare(sql).run(songTitle.toLowerCase().trim(), richAudioFileId, songTitle, songPerformer, parsedDur);
            }
          }
        } catch {}
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
          await ctx.sm?.transition(ctx.tgId, States.URL_DOWNLOADER_INPUT, { context: { mode: 'url' } });
          if (fromMedia) return ctx.replyRich(renderInputPrompt());
          return ctx.editScreen(renderInputPrompt());
        case 'play':
          await ctx.sm?.transition(ctx.tgId, States.MUSIC_SEARCH_INPUT, { context: { mode: 'music' } });
          if (fromMedia) return ctx.replyRich(renderMusicSearchPrompt(ctx));
          return ctx.editScreen(renderMusicSearchPrompt(ctx));
        case 'recognize':
          await ctx.sm?.transition(ctx.tgId, States.MUSIC_SEARCH_INPUT, { context: { mode: 'music' } });
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
            const errSent = await ctx.api.sendMessage(
              ctx.chatId,
              '<blockquote>♡ Could not find lyrics: song title could not be determined from this card ♡\nTip: You can search lyrics directly with <code>/lyrics &lt;song name&gt;</code> ♡</blockquote>',
              { parse_mode: 'HTML' }
            );
            if (errSent?.message_id && typeof ctx.api.deleteMessage === 'function') {
              setTimeout(() => {
                ctx.api.deleteMessage(ctx.chatId, errSent.message_id).catch(() => {});
              }, 12000)?.unref?.();
            }
            return;
          }

          const lyricsRes = await getLyrics(songTitle, songArtist);
          if (!lyricsRes.found || !lyricsRes.lyrics) {
            const errSent = await ctx.api.sendMessage(
              ctx.chatId,
              `<blockquote>♡ Could not find lyrics for "<b>${escapeHtml(songTitle)}</b>" ♡\nTip: You can search lyrics directly with <code>/lyrics &lt;song&gt;</code> ♡</blockquote>`,
              { parse_mode: 'HTML' }
            );
            if (errSent?.message_id && typeof ctx.api.deleteMessage === 'function') {
              setTimeout(() => {
                ctx.api.deleteMessage(ctx.chatId, errSent.message_id).catch(() => {});
              }, 12000)?.unref?.();
            }
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
        case 'send_audio': {
          const audioKey = args[0];
          if (ctx.query?.id) {
            await ctx.api.answerCallbackQuery(ctx.query.id, { text: '🎵 Sending audio file… ♡' }).catch(() => {});
          }

          let audioBuf = getTrackAudio(audioKey);
          if (!audioBuf) {
            const msg = ctx.query?.message;
            const audioFileId = msg?.audio?.file_id || msg?.voice?.file_id;
            if (audioFileId) {
              try {
                const fileInfo = await ctx.api.getFile(audioFileId);
                if (fileInfo?.file_path) {
                  audioBuf = await ctx.api.downloadFile(fileInfo.file_path);
                }
              } catch {}
            }
          }

          if (!audioBuf || audioBuf.length === 0) {
            const errSent = await ctx.api.sendMessage(
              ctx.chatId,
              '<blockquote>♡ Could not find audio file cache for this track ♡\nTip: You can re-download it or search directly with <code>/play &lt;song&gt;</code> ♡</blockquote>',
              { parse_mode: 'HTML' }
            );
            if (errSent?.message_id && typeof ctx.api.deleteMessage === 'function') {
              setTimeout(() => {
                ctx.api.deleteMessage(ctx.chatId, errSent.message_id).catch(() => {});
              }, 12000)?.unref?.();
            }
            return;
          }

          const meta = getTrackMeta(audioKey, app.db || ctx.db) || {};
          let songTitle = meta.title;
          let songPerformer = meta.performer || meta.artist;

          if (!songTitle || songTitle === 'Audio Track') {
            const msgText = String(ctx.query?.message?.text || ctx.query?.message?.caption || '');
            const titleMatch = msgText.match(/🎵\s*Title\s*\n\s*([^\n]+)/i);
            const artistMatch = msgText.match(/🎧\s*Artist\s*\n\s*([^\n]+)/i);
            if (titleMatch && titleMatch[1]) {
              songTitle = titleMatch[1].replace(/[…\.]+$/, '').trim();
            }
            if (artistMatch && artistMatch[1]) {
              songPerformer = artistMatch[1].replace(/[…\.]+$/, '').trim();
            }
          }

          songTitle = songTitle || 'Audio Track';
          songPerformer = songPerformer || 'Artist';

          await ctx.api.sendChatAction(ctx.chatId, 'upload_document').catch(() => {});

          const cleanFilename = meta.filename || `${songTitle.replace(/[^\w\s-]/g, '') || 'audio'}.mp3`;
          const caption = `🎵 <b>${escapeHtml(songTitle)}</b>` +
            (songPerformer && songPerformer !== 'Artist' ? ` — <i>${escapeHtml(songPerformer)}</i>` : '') +
            `\n<blockquote expandable>` +
            `📱 <b>Platform:</b> ${escapeHtml(meta.platform || 'SPOTIFY / MUSIC ♡')}\n` +
            (meta.album ? `💿 <b>Album:</b> ${escapeHtml(meta.album)}\n` : '') +
            (meta.year ? `📅 <b>Release:</b> ${escapeHtml(String(meta.year))}\n` : '') +
            (meta.duration ? `⏱ <b>Duration:</b> ${Math.floor(meta.duration / 60)}:${String(meta.duration % 60).padStart(2, '0')}\n` : '') +
            `📦 <b>Audio Quality:</b> High-Speed MP3 (192k) + Artwork ♡` +
            (meta.requestedBy ? `\n👤 <b>Requested By:</b> ${escapeHtml(meta.requestedBy)}` : '') +
            `</blockquote>`;

          const registerSentAudio = (sent) => {
            if (!sent) return;
            if (sent.message_id) {
              (ctx.controller || app.telegram?.controller)?.markMediaDeliveryMessage?.(sent.message_id);
              app.telegram?.markMediaDeliveryMessage?.(sent.message_id);
            }
            let fileId = sent.audio?.file_id || sent.document?.file_id;
            if (!fileId && Array.isArray(sent.rich_message?.blocks)) {
              for (const blk of sent.rich_message.blocks) {
                if (blk.type === 'audio' && blk.audio?.file_id) {
                  fileId = blk.audio.file_id;
                  break;
                }
              }
            }
            if (fileId) {
              const db = app.db || ctx.db;
              try {
                const sql = 'INSERT OR REPLACE INTO cached_audio_tracks (query, file_id, title, artist, duration) VALUES (?, ?, ?, ?, ?)';
                const cleanQuery = songTitle.toLowerCase().trim();
                const cleanArtist = songPerformer !== 'Artist' ? songPerformer : null;
                const dur = meta.duration || 0;
                if (typeof db?.run === 'function') {
                  db.run(sql, cleanQuery, fileId, songTitle, cleanArtist, dur);
                } else if (typeof db?.prepare === 'function') {
                  db.prepare(sql).run(cleanQuery, fileId, songTitle, cleanArtist, dur);
                }
              } catch {}
            }
          };

          try {
            const sentAudio = await ctx.api.sendAudio(
              ctx.chatId,
              audioBuf,
              {
                title: songTitle,
                performer: songPerformer,
                ...(meta.duration ? { duration: meta.duration } : {}),
                ...(meta.thumb ? { thumbnail: meta.thumb } : {}),
                filename: cleanFilename,
                caption,
                parse_mode: 'HTML'
              }
            );
            registerSentAudio(sentAudio);
          } catch (err) {
            log.warn({ err, audioKey }, 'sendAudio with thumb failed, retrying without thumb');
            try {
              const sentDoc = await ctx.api.sendAudio(
                ctx.chatId,
                audioBuf,
                {
                  title: songTitle,
                  performer: songPerformer,
                  ...(meta.duration ? { duration: meta.duration } : {}),
                  filename: cleanFilename,
                  caption,
                  parse_mode: 'HTML'
                }
              );
              registerSentAudio(sentDoc);
            } catch (docErr) {
              log.error({ docErr, audioKey }, 'sendAudio failed completely');
              const errSent = await ctx.api.sendMessage(
                ctx.chatId,
                '<blockquote>♡ Could not send audio file right now. Please try again in a moment ♡</blockquote>',
                { parse_mode: 'HTML' }
              );
              if (errSent?.message_id && typeof ctx.api.deleteMessage === 'function') {
                setTimeout(() => {
                  ctx.api.deleteMessage(ctx.chatId, errSent.message_id).catch(() => {});
                }, 12000)?.unref?.();
              }
            }
          }
          return;
        }
        case 'identify': {
          const trackKey = args[0];
          if (ctx.query?.id) {
            await ctx.api.answerCallbackQuery(ctx.query.id, { text: '🎧 Listening to video soundtrack… ♡' }).catch(() => {});
          }

          let progressMsg = null;
          try {
            progressMsg = await ctx.api.sendMessage(
              ctx.chatId,
              '🎧 <b>Listening to video soundtrack…</b>\nAnalyzing audio to identify the song ♡',
              { parse_mode: 'HTML' }
            );
          } catch {
            progressMsg = await ctx.api.sendMessage(
              ctx.chatId,
              '🎧 Listening to video soundtrack and identifying song… ♡'
            ).catch(() => null);
          }

          let audioBuf = getTrackAudio(trackKey);
          if (!audioBuf) {
            const msg = ctx.query?.message;
            const audioFileId = msg?.audio?.file_id || msg?.voice?.file_id;
            if (audioFileId) {
              try {
                const fileInfo = await ctx.api.getFile(audioFileId);
                if (fileInfo?.file_path) {
                  audioBuf = await ctx.api.downloadFile(fileInfo.file_path);
                }
              } catch {}
            }
          }

          if (!audioBuf || audioBuf.length === 0) {
            const errorText = `<blockquote>୨୧ Could not retrieve the soundtrack for this video ♡\n` +
              `Tip: You can search directly by typing <code>/play &lt;song name or lyrics&gt;</code> ♡</blockquote>`;
            if (progressMsg?.message_id) {
              await ctx.api.editMessageText(ctx.chatId, progressMsg.message_id, errorText, {
                parse_mode: 'HTML',
                reply_markup: {
                  inline_keyboard: [
                    [{ text: '🔍 Search by Song / Lyrics', callback_data: 'l1:downloader:play' }],
                    [{ text: '« Menu', callback_data: 'l1:dashboard:open' }]
                  ]
                }
              }).catch(() => {});
              if (typeof ctx.api.deleteMessage === 'function') {
                setTimeout(() => {
                  ctx.api.deleteMessage(ctx.chatId, progressMsg.message_id).catch(() => {});
                }, 12000)?.unref?.();
              }
            }
            return;
          }

          const meta = getTrackMeta(trackKey, app.db || ctx.db) || {};
          const hintTitle = meta.title && meta.title !== 'Audio Track' ? meta.title : '';
          const hintPerformer = meta.performer && meta.performer !== 'Soundtrack' && meta.performer !== 'Artist' ? meta.performer : '';

          const recResult = await recognizeAudio(audioBuf, {
            extension: '.mp3',
            hintTitle,
            hintPerformer
          });
          if (recResult?.success && recResult.title) {
            const { title, artist } = recResult;
            const query = `${title} ${artist || ''}`.trim();
            const dlCtx = {
              ...ctx,
              messageId: progressMsg?.message_id,
              initialStage: `Identified: "${title}" by ${artist || 'Unknown'} ♡`
            };
            await executeDownload(dlCtx, query);
            return;
          }

          const notFoundText = `<blockquote>୨୧ Could not recognize the music in this video soundtrack ♡\n\n` +
            `💡 <b>Why this happens:</b>\n` +
            `• Background audio may be distorted, pitched, shortened, or spoken over.\n\n` +
            `✨ <b>Know any words or lyrics?</b> Tap <b>🔍 Search by Lyrics</b> below or type <code>/play &lt;lyrics&gt;</code> to download it directly! ♡</blockquote>`;

          if (progressMsg?.message_id) {
            await ctx.api.editMessageText(ctx.chatId, progressMsg.message_id, notFoundText, {
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🔍 Search by Lyrics or Title', callback_data: 'l1:downloader:play' }],
                  [{ text: '« Menu', callback_data: 'l1:dashboard:open' }]
                ]
              }
            }).catch(() => {});
            if (typeof ctx.api.deleteMessage === 'function') {
              setTimeout(() => {
                ctx.api.deleteMessage(ctx.chatId, progressMsg.message_id).catch(() => {});
              }, 15000)?.unref?.();
            }
          }
          return;
        }
        case 'to_sticker': {
          const imageKey = (args[0] || '').split(',')[0];
          let images = getMediaImages(imageKey);

          if (ctx.query?.id) {
            await ctx.api.answerCallbackQuery(ctx.query.id, { text: '🎨 Turning into sticker(s)… ♡' }).catch(() => {});
          }

          if (!images || images.length === 0) {
            const replyMsg = ctx.query?.message;
            if (Array.isArray(replyMsg?.photo) && replyMsg.photo.length > 0) {
              try {
                const bestPhoto = replyMsg.photo[replyMsg.photo.length - 1];
                const fileInfo = await ctx.api.getFile(bestPhoto.file_id);
                if (fileInfo?.file_path) {
                  const buf = await ctx.api.downloadFile(fileInfo.file_path);
                  if (buf) images = [{ buffer: buf }];
                }
              } catch {}
            }
          }

          if (!images || images.length === 0) {
            await ctx.api.sendMessage(
              ctx.chatId,
              '<blockquote>♡ Could not retrieve image buffer for sticker conversion. Send the photo directly to me and I will turn it into a sticker! ♡</blockquote>',
              { parse_mode: 'HTML' }
            ).catch(() => {});
            return;
          }

          let successCount = 0;
          for (let i = 0; i < Math.min(images.length, 10); i++) {
            try {
              const stickerRes = await toTelegramStaticSticker(images[i].buffer);
              if (stickerRes?.buffer) {
                await ctx.api.sendSticker(ctx.chatId, stickerRes.buffer, { emoji: '✨' });
                successCount++;
              }
            } catch (err) {
              log.debug({ err: err?.message, idx: i }, 'failed to convert image to sticker');
            }
          }

          if (successCount > 0) {
            const b = new RichMessageBuilder();
            b.paragraph(rt.bold(`✨ Created ${successCount} aesthetic sticker${successCount > 1 ? 's' : ''}! ♡`));
            b.paragraph(rt.text('Delivered directly above as native Telegram stickers ˙ᵕ˙'));
            b.divider();
            b.buttons([
              richButton.callback('✦ Save to Sticker Pack', encodeCallback('stickers', 'open', ['from_media']), { style: 'primary' }),
              richButton.callback('« Dashboard', encodeCallback('dashboard', 'open', ['from_media']))
            ]);
            await ctx.replyRich(b.toJSON()).catch(() => {});
          } else {
            await ctx.api.sendMessage(
              ctx.chatId,
              '<blockquote>✕ Could not convert image to sticker format. Please try another image ♡</blockquote>',
              { parse_mode: 'HTML' }
            ).catch(() => {});
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
                api: sctx.api || app.telegram.api,
                message
              };
              await controller.handleAudioRecognition(ctx, recMedia.obj, message, recMedia);
              return true;
            }
          }

          const text = String(message.text || message.caption || '').trim();
          if (!text) return true;
          const match = text.match(/https?:\/\/[^\s]+/i);
          if (sctx.context?.mode === 'url' && !match) {
            const b = new RichMessageBuilder();
            b.paragraph(rt.bold(banner([
              '𓆩♡𓆪 URL DOWNLOADER 𓆩♡𓆪',
              'valid link required ♡'
            ])));
            b.divider();
            b.paragraph(rt.text('୨୧ Please provide a valid media link starting with http:// or https:// ♡'));
            b.quote(rt.italic('Tip: To search and download music by song name or lyrics, tap 🎵 Play Music below or type /play <song>!'));
            b.divider();
            b.buttons([
              richButton.callback('🎵 Play Music', encodeCallback(id, 'play'), { style: 'primary' }),
              richButton.callback('« Downloader', encodeCallback(id, 'open'))
            ]);
            b.buttons([
              richButton.callback('✕ Cancel', encodeCallback(id, 'cancel'), { style: 'danger' })
            ]);
            b.validate();
            const api = sctx.api || app.telegram.api;
            await api.sendRichMessage(sctx.chatId, b.toJSON()).catch(async () => {
              await api.sendMessage(
                sctx.chatId,
                `୨୧ Please provide a valid media link starting with http:// or https:// ♡\n` +
                `Tip: To search & play music, use 🎵 Play Music from the menu or type /play <song name> ♡`
              ).catch(() => {});
            });
            return true;
          }

          const target = match ? match[0] : text;
          const dlCtx = {
            ...sctx,
            controller: sctx.controller || app.telegram?.controller,
            api: sctx.api || app.telegram?.api,
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

      sm.register(States.MUSIC_SEARCH_INPUT, {
        onEnter: async (sctx) => {
          // Handled in handle('play')
        },
        onMessage: async (sctx, message) => {
          const recMedia = extractMediaForMusicRecognition(message);
          if (recMedia && recMedia.obj?.file_id) {
            const controller = sctx.controller || app.telegram?.controller;
            if (controller?.handleAudioRecognition) {
              const ctx = {
                ...sctx,
                chatId: message.chat?.id || sctx.chatId,
                tgId: sctx.tgId || String(message.from?.id),
                api: sctx.api || app.telegram.api,
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
            controller: sctx.controller || app.telegram?.controller,
            api: sctx.api || app.telegram?.api,
            chatId: message.chat?.id || sctx.chatId,
            tgId: sctx.tgId || String(message.from?.id),
            message
          };
          await sctx.reset?.({ reason: 'download_started' });
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
