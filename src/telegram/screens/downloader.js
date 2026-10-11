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
import { checkChatMediaPermissions, formatMediaRestrictedNotice, isPermissionError } from '../permissions.js';

// Global cache for track metadata: lyricKey -> { title, artist }
const lyricsCache = new Map();

// Global cache for track audio and metadata: audioKey -> Buffer / Object
const trackAudioCache = new Map();
const audioMetaCache = new Map();
const imageStickerCache = new Map();
const albumCache = new Map();

function saveMediaImages(key, items) {
  if (imageStickerCache.size > 50) {
    const oldestKey = imageStickerCache.keys().next().value;
    imageStickerCache.delete(oldestKey);
  }
  imageStickerCache.set(key, items);
  try {
    const maxCount = Math.min(items.length, 100);
    for (let i = 0; i < maxCount; i++) {
      writeFileSync(join(tmpdir(), `lancy_img_${key}_${i}.jpg`), items[i].buffer);
    }
    writeFileSync(join(tmpdir(), `lancy_img_${key}_meta.json`), JSON.stringify({ count: maxCount }));
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

function saveAlbum(key, data) {
  if (albumCache.size > 50) {
    const oldestKey = albumCache.keys().next().value;
    albumCache.delete(oldestKey);
  }
  albumCache.set(key, data);
  try {
    const meta = {
      platform: data.platform || 'Media',
      title: data.title || 'Downloaded Media',
      totalCount: data.mediaItems?.length || 0,
      audioKey: data.audioKey || null,
      imageKey: data.imageKey || null,
      audioTitle: data.audioTrack?.title || null,
      audioPerformer: data.audioTrack?.performer || null
    };
    writeFileSync(join(tmpdir(), `lancy_album_${key}_meta.json`), JSON.stringify(meta));
    if (Array.isArray(data.mediaItems)) {
      const maxSave = Math.min(data.mediaItems.length, 100);
      for (let i = 0; i < maxSave; i++) {
        const item = data.mediaItems[i];
        const ext = item.type === 'video' ? 'mp4' : 'jpg';
        writeFileSync(join(tmpdir(), `lancy_album_${key}_${i}.${ext}`), item.buffer);
      }
    }
    if (data.audioTrack?.buffer) {
      writeFileSync(join(tmpdir(), `lancy_album_${key}_audio.mp3`), data.audioTrack.buffer);
    }
  } catch {}
}

function getAlbum(key) {
  let album = albumCache.get(key);
  if (!album && key) {
    try {
      const metaPath = join(tmpdir(), `lancy_album_${key}_meta.json`);
      if (existsSync(metaPath)) {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
        const mediaItems = [];
        for (let i = 0; i < (meta.totalCount || 0); i++) {
          const vidPath = join(tmpdir(), `lancy_album_${key}_${i}.mp4`);
          const imgPath = join(tmpdir(), `lancy_album_${key}_${i}.jpg`);
          if (existsSync(vidPath)) {
            mediaItems.push({ type: 'video', buffer: readFileSync(vidPath), filename: `media_${i}.mp4`, mimeType: 'video/mp4' });
          } else if (existsSync(imgPath)) {
            mediaItems.push({ type: 'photo', buffer: readFileSync(imgPath), filename: `media_${i}.jpg`, mimeType: 'image/jpeg' });
          }
        }
        let audioTrack = null;
        const audioPath = join(tmpdir(), `lancy_album_${key}_audio.mp3`);
        if (existsSync(audioPath)) {
          audioTrack = {
            buffer: readFileSync(audioPath),
            filename: 'audio.mp3',
            title: meta.audioTitle || 'Audio Track',
            performer: meta.audioPerformer || 'Artist'
          };
        }
        album = {
          platform: meta.platform || 'Media',
          title: meta.title || 'Downloaded Media',
          mediaItems,
          audioTrack,
          audioKey: meta.audioKey,
          imageKey: meta.imageKey
        };
        albumCache.set(key, album);
      }
    } catch {}
  }
  return album;
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
      richButton.callback('🎬 TikTok Search', encodeCallback(id, 'tiktokSearch'), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🎵 Play Music', encodeCallback(id, 'play'), { style: 'primary' }),
      richButton.callback('📜 Search Lyrics', encodeCallback(id, 'searchLyrics'), { style: 'primary' })
    ]);
    b.buttons([
      richButton.callback('🎙️ Audio Recognition', encodeCallback(id, 'recognize'), { style: 'primary' }),
      richButton.callback('« Dashboard', encodeCallback('dashboard', 'open'))
    ]);

    b.footer(rt.italic('Tip: You can also simply paste any social link directly in chat ♡'));
    b.validate();
    return b.toJSON();
  }

  function renderTikTokSearchPrompt(ctx = null) {
    const b = new RichMessageBuilder();
    const botUser = ctx?.bot?.botUsername || 'Lancy_easy_bot';
    b.paragraph(rt.bold(banner([
      '𓆩♡𓆪 TIKTOK STUDIO & SEARCH 𓆩♡𓆪',
      'search viral clips & download HD without watermark ♡'
    ])));
    b.divider();
    b.heading('୨୧ how to search & download', 3);
    b.paragraph(rt.text(
      '• 🔍 Send any keyword or topic (e.g. "dance tutorial", "funny cats") to search clips\n' +
      '• 📥 Or paste any TikTok video URL to download immediately with no watermark\n' +
      '• 📸 TikTok photo carousels & slideshows are fully supported with music extraction\n' +
      '• 📱 Live in chat: Type @' + botUser + ' tt <topic> in any chat or group!'
    ));
    b.divider();
    b.quote(rt.text(
      '✨ Tip: Every video downloaded is 100% clean without watermark, and background music is automatically extracted as MP3! ♡'
    ));
    b.divider();
    b.buttons([
      richButton.switchInlineCurrent('🎬 Search TikTok Live', 'tt '),
      richButton.callback('✕ Cancel', encodeCallback(id, 'cancel'), { style: 'danger' })
    ]);
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

  function renderLyricsSearchPrompt(ctx = null) {
    const b = new RichMessageBuilder();
    const isGroup = Boolean(ctx?.isGroup);

    b.header('𓆩♡𓆪 SEARCH SONG LYRICS 𓆩♡𓆪', 1);
    b.divider();
    b.heading('୨୧ search any song lyrics', 3);
    if (isGroup) {
      b.paragraph(rt.text(
        '• 🎵 Type /lyrics <song title> directly in this chat\n' +
        '• 📝 Or reply to this card with any song title, artist, or lyric verse snippet!'
      ));
    } else {
      b.paragraph(rt.text(
        '• 🎵 Type song title & artist (e.g. Blinding Lights The Weeknd)\n' +
        '• 📝 Or paste any verse or chorus lyrics snippet!'
      ));
    }
    b.divider();
    b.quote(rt.text(
      '✨ Lancy will fetch full lyrics with album artwork & metadata ♡'
    ));
    b.divider();
    b.buttons([
      richButton.callback('🎵 Play Music', encodeCallback(id, 'play'), { style: 'primary' }),
      richButton.callback('« Downloader', encodeCallback(id, 'open'))
    ]);
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

    b.header('𓆩♡𓆪 PLAY & DOWNLOAD MUSIC 𓆩♡𓆪', 1);
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
      richButton.callback('📜 Search Lyrics', encodeCallback(id, 'searchLyrics'), { style: 'primary' })
    ]);
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
    b.header('𓆩♡𓆪 URL DOWNLOADER 𓆩♡𓆪', 1);
    b.paragraph(rt.italic('₊˚⊹♡  processing your media  ˙ᵕ˙'));
    b.divider();

    const elapsedSec = Math.max(1, Math.round(elapsedMs / 1000));
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

  const SLIDESHOW_PAGE_SIZE = 10;

  function buildDeliveryRichMessage({
    mediaItems = [],
    audioTrack = null,
    platform = 'Media',
    title = 'Downloaded Media',
    result = {},
    ctx,
    offset = 0,
    albumKey = null,
    imageKey = null,
    audioKey = null,
    lyrics = null
  }) {
    const files = {};
    const b = new RichMessageBuilder();

    b.header(`𓆩♡𓆪 ${platform.toUpperCase()} DOWNLOAD 𓆩♡𓆪`, 1);
    b.paragraph(rt.italic('₊˚⊹♡ aesthetic media delivery ♡ ˙ᵕ˙'));
    b.divider();

    // 1. Embed Downloaded Media (Video / Photo / Single Slideshow block) inside Rich Message
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
      // Telegram Bot API allows AT MOST ONE slideshow / media group block per message (max 10 items).
      // We slice exactly one page (up to 10 items) for this message to prevent client button detachment:
      const pageSlice = mediaItems.slice(offset, offset + SLIDESHOW_PAGE_SIZE);
      const chunkBlocks = pageSlice.map((item, idx) => {
        const globalIdx = offset + idx;
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

    // 2. Embed Audio / Music Track inside the same Rich Message!
    const isMusic = platform.toLowerCase() === 'spotify' || platform.toLowerCase() === 'music-search' || Boolean(result?.artist);
    if (audioTrack && audioTrack.buffer) {
      const audioField = 'audio_track';
      files[audioField] = {
        buffer: audioTrack.buffer,
        filename: audioTrack.filename || `${(title || 'soundtrack').replace(/[^\w\s-]/g, '') || 'soundtrack'}.mp3`,
        contentType: 'audio/mpeg'
      };

      const parsedDuration = parseDurationToSeconds(audioTrack.duration || result?.duration);
      const audioMediaObj = {
        media: `attach://${audioField}`,
        title: audioTrack.title || result?.title || title || 'Audio Track',
        performer: audioTrack.performer || result?.artist || result?.author || 'Artist',
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
        ['🎵 Title', truncate(result?.title || title, 40)],
        ['🎧 Artist', truncate(result?.artist || result?.author || 'Spotify', 36)]
      ];
      if (result?.album) musicRows.push(['💿 Album', truncate(result.album, 36)]);
      if (result?.year) musicRows.push(['📅 Release', String(result.year)]);
      if (result?.duration) musicRows.push(['⏱ Duration', String(result.duration)]);
      musicRows.push(['📦 Audio Quality', 'High-Speed MP3 (192k) + Artwork ♡']);
      if (ctx?.isGroup) {
        musicRows.push(['👤 Requested By', ctx.user?.first_name ? `${ctx.user.first_name}` : 'Member']);
      }
      b.table(kvTable(musicRows), { compact: true });
      if (lyrics) {
        b.expandableBlockquote(`📜 Lyrics • ${truncate(result?.title || title, 36)}\n\n${lyrics}`);
      }
    } else {
      const isPaged = mediaItems.length > SLIDESHOW_PAGE_SIZE;
      const rangeText = isPaged ? ` • Showing ${offset + 1}–${Math.min(offset + SLIDESHOW_PAGE_SIZE, mediaItems.length)}` : '';
      const metaRows = [
        ['📱 Platform', platform.toUpperCase()],
        ['🏷 Title', truncate(title, 36)],
        ['📦 Media Items', `${mediaItems.length} item(s) (${photoCount} photos, ${videoCount} videos)${rangeText}`],
        ['🎵 Sound / Audio', audioTrack ? 'Extracted & Included (MP3) ♡' : 'None in source']
      ];
      if (ctx?.isGroup) {
        metaRows.push(['👤 Requested By', ctx.user?.first_name ? `${ctx.user.first_name}` : 'Member']);
      }
      b.table(kvTable(metaRows), { compact: true });
    }
    b.divider();

    // 4. Audio Action Row (send audio / recognize)
    const audioActionRow = [];
    if (audioKey) {
      audioActionRow.push(
        richButton.callback('🎵 Send Audio File', encodeCallback(id, 'send_audio', audioKey), { style: 'primary' })
      );
    }
    if (isMusic) {
      const lyricKey = Math.random().toString(36).slice(2, 8);
      const songMeta = {
        title: result?.title || title,
        artist: result?.artist || result?.author || ''
      };
      lyricsCache.set(lyricKey, songMeta);
      const db = app.db || ctx?.db;
      try {
        db?.run?.(
          'INSERT OR REPLACE INTO bot_settings (key, value_json) VALUES (?, ?)',
          `lyric_${lyricKey}`,
          JSON.stringify(songMeta)
        );
      } catch {}
    } else if (audioKey) {
      audioActionRow.push(
        richButton.callback('🎙️ Recognize Music / Identify Song', encodeCallback(id, 'identify', audioKey), { style: 'primary' })
      );
    }

    if (audioActionRow.length > 0) {
      b.buttons(audioActionRow);
    }

    // 5. Album Pagination Row (when total media > 10)
    if (mediaItems.length > SLIDESHOW_PAGE_SIZE && albumKey) {
      const hasPrev = offset > 0;
      const hasNext = offset + SLIDESHOW_PAGE_SIZE < mediaItems.length;
      const prevOffset = Math.max(0, offset - SLIDESHOW_PAGE_SIZE);
      const nextOffset = offset + SLIDESHOW_PAGE_SIZE;
      const nextBatch = Math.min(SLIDESHOW_PAGE_SIZE, mediaItems.length - nextOffset);

      if (hasPrev && hasNext) {
        b.buttons([
          richButton.callback(`← Prev (${prevOffset + 1}–${offset})`, encodeCallback(id, 'prevSlide', albumKey, String(prevOffset)), { style: 'primary' }),
          richButton.callback(`Next (${nextOffset + 1}–${Math.min(nextOffset + SLIDESHOW_PAGE_SIZE, mediaItems.length)}) →`, encodeCallback(id, 'moreSlide', albumKey, String(nextOffset)), { style: 'primary' })
        ]);
      } else if (hasNext) {
        b.buttons([
          richButton.callback(`🖼 Next ${nextBatch} Slides (${nextOffset + 1}–${Math.min(nextOffset + SLIDESHOW_PAGE_SIZE, mediaItems.length)}) →`, encodeCallback(id, 'moreSlide', albumKey, String(nextOffset)), { style: 'primary' })
        ]);
      } else if (hasPrev) {
        b.buttons([
          richButton.callback(`← 🖼 Prev Slides (${prevOffset + 1}–${offset})`, encodeCallback(id, 'prevSlide', albumKey, String(prevOffset)), { style: 'primary' })
        ]);
      }
    }

    // 6. Action Buttons
    const mediaRow = [
      richButton.callback('📥 Download Link', encodeCallback(id, 'input', 'from_media'), { style: 'primary' })
    ];
    const keyForStickers = imageKey || albumKey;
    if (photoCount > 0 && keyForStickers) {
      mediaRow.push(
        richButton.callback(
          photoCount > 1 ? `🎨 Turn to Sticker (${photoCount})` : '🎨 Turn to Sticker',
          encodeCallback(id, 'to_sticker', keyForStickers, 'from_media'),
          { style: 'primary' }
        )
      );
      mediaRow.push(
        richButton.callback('✦ Sticker Pack', encodeCallback('stickers', 'open', 'from_media'), { style: 'primary' })
      );
    }
    b.buttons(mediaRow);

    b.buttons([
      richButton.callback('🎵 Play Another', encodeCallback(id, 'play', 'from_media'), { style: 'primary' }),
      richButton.callback('« Dashboard', encodeCallback('dashboard', 'open', 'from_media'), { style: 'primary' })
    ]);
    b.footer(rt.italic(`Delivered with aesthetic love by ${ctx?.botName || 'Lancy Bot'} ♡`));
    b.validate();

    return { rich: b.toJSON(), files };
  }

  async function executeDownload(ctx, url) {
    const isGroup = Boolean(ctx.isGroup);
    const forceNew = Boolean(ctx.forceNew);
    const api = ctx.api || app.telegram?.api;

    // Pre-flight permission check for group chats to prevent entering download/retry loops
    // when admin permissions restrict non-admin bots from sending media.
    if (isGroup && api) {
      const isMusicQuery = !/^https?:\/\//i.test(url);
      const caps = await checkChatMediaPermissions(api, ctx.chatId);
      if (!isMusicQuery && !caps.canSendVideos && !caps.canSendPhotos) {
        const botUser = ctx.botUsername || app.telegram?.botUsername || 'Lancy_easy_bot';
        const notice = formatMediaRestrictedNotice({
          botUsername: botUser,
          url,
          mediaType: 'photos or videos',
          actionTitle: 'Get in Private DM'
        });
        await api.sendMessage(ctx.chatId, notice.text, {
          parse_mode: 'HTML',
          reply_markup: notice.reply_markup
        }).catch(() => {});
        return;
      }
      if (isMusicQuery && !caps.canSendAudios && !caps.canSendMedia) {
        const botUser = ctx.botUsername || app.telegram?.botUsername || 'Lancy_easy_bot';
        const notice = formatMediaRestrictedNotice({
          botUsername: botUser,
          url,
          mediaType: 'audio files',
          actionTitle: 'Play in Private DM'
        });
        await api.sendMessage(ctx.chatId, notice.text, {
          parse_mode: 'HTML',
          reply_markup: notice.reply_markup
        }).catch(() => {});
        return;
      }
    }

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

      const isMusic = platform.toLowerCase() === 'spotify' || platform.toLowerCase() === 'music-search' || Boolean(result.artist);
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

      const albumKey = mediaItems.length > 1 ? Math.random().toString(36).slice(2, 8) : null;
      if (albumKey) {
        saveAlbum(albumKey, { mediaItems, audioTrack, platform, title, result, audioKey, imageKey });
      }

      // Fetch lyrics if music track
      let lyricsText = result.lyrics || null;
      if (isMusic && !lyricsText) {
        try {
          const songTitle = result.title || title;
          const songArtist = result.artist || result.author || '';
          const lRes = await Promise.race([
            getLyrics(songTitle, songArtist),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
          ]);
          if (lRes?.found && lRes.lyrics) {
            lyricsText = lRes.lyrics;
          }
        } catch {}
      }

      const { rich, files } = buildDeliveryRichMessage({
        mediaItems,
        audioTrack,
        platform,
        title,
        result,
        ctx,
        offset: 0,
        albumKey,
        imageKey,
        audioKey,
        lyrics: lyricsText
      });

      // Deliver Media
      let sent = null;
      if (isGroup && audioTrack && audioTrack.buffer) {
        const caps = await checkChatMediaPermissions(ctx.api || app.telegram?.api, ctx.chatId);
        if (caps.canSendAudios && !caps.canSendPhotos) {
          await tracker.cleanup();
          const cleanFilename = `${(title || 'audio').replace(/[^\w\s-]/g, '') || 'audio'}.mp3`;
          const songTitle = audioTrack.title || result.title || title || 'Audio Track';
          const songArtist = audioTrack.performer || result.artist || result.author || 'Artist';
          const album = result.album || null;
          const durStr = result.duration || (audioTrack.duration ? `${Math.floor(audioTrack.duration / 60)}:${String(audioTrack.duration % 60).padStart(2, '0')}` : null);
          const requester = ctx.user?.first_name || null;

          let metaBlock = `🎵 <b>Title:</b> ${escapeHtml(songTitle)}\n` +
            `🎧 <b>Artist:</b> ${escapeHtml(songArtist)}\n`;
          if (album) metaBlock += `💿 <b>Album:</b> ${escapeHtml(album)}\n`;
          if (durStr) metaBlock += `⏱ <b>Duration:</b> ${escapeHtml(durStr)}\n`;
          if (requester) metaBlock += `👤 <b>Requested by:</b> ${escapeHtml(requester)}\n`;

          const topHeader = `🎵 <b>${escapeHtml(songTitle)}</b> — <i>${escapeHtml(songArtist)}</i>`;
          const normalQuote = `<blockquote>\n${metaBlock.trim()}\n</blockquote>`;

          let lyricSnippet = '';
          let sendFollowupLyrics = false;
          if (lyricsText) {
            const availLen = Math.max(0, 950 - normalQuote.length - topHeader.length - 30);
            if (lyricsText.length <= availLen) {
              lyricSnippet = `\n<blockquote expandable>\n📜 <b>Lyrics:</b>\n${escapeHtml(lyricsText)}\n</blockquote>`;
            } else {
              sendFollowupLyrics = true;
            }
          }

          const caption = `${topHeader}\n${normalQuote}${lyricSnippet}`;

          sent = await (ctx.api || app.telegram?.api).sendAudio(ctx.chatId, audioTrack.buffer, {
            title: songTitle,
            performer: songArtist,
            caption,
            parse_mode: 'HTML',
            filename: cleanFilename
          }).catch(() => null);

          if (sent && sendFollowupLyrics && lyricsText) {
            const fullLyricsQuote = `<blockquote expandable>\n📜 <b>Lyrics • ${escapeHtml(songTitle)} — ${escapeHtml(songArtist)}</b>\n\n${escapeHtml(lyricsText)}\n</blockquote>`;
            await (ctx.api || app.telegram?.api).sendMessage(ctx.chatId, fullLyricsQuote, {
              parse_mode: 'HTML',
              reply_to_message_id: sent.message_id
            }).catch(() => null);
          }
        }
      }

      if (!sent) {
        sent = await tracker.finish(rich, files);
      }
      if (tracker.messageId && sent && !sent.permissionError) {
        (ctx.controller || app.telegram?.controller)?.markMediaDeliveryMessage?.(tracker.messageId);
        app.telegram?.markMediaDeliveryMessage?.(tracker.messageId);
        (ctx.controller || app.telegram?.controller)?.userScreenMessage?.set?.(ctx.tgId, { chatId: ctx.chatId, messageId: tracker.messageId });
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
          if (parsedDur > 0 && parsedDur < 45) {
            // Strictly reject preview snippets from being cached
            return;
          }
          const sql = 'INSERT OR REPLACE INTO cached_audio_tracks (query, file_id, title, artist, duration) VALUES (?, ?, ?, ?, ?)';
          const cleanQuery = (url || '').toLowerCase().trim();
          const cleanTitle = (songTitle || '').toLowerCase().trim();
          const cleanArtist = (songPerformer || '').toLowerCase().trim();
          const dbExec = (q, f, t, a, d) => {
            if (typeof db?.run === 'function') db.run(sql, q, f, t, a, d);
            else if (typeof db?.prepare === 'function') db.prepare(sql).run(q, f, t, a, d);
          };
          if (cleanQuery) dbExec(cleanQuery, richAudioFileId, songTitle, songPerformer, parsedDur);
          if (cleanTitle && cleanTitle !== cleanQuery) {
            dbExec(cleanTitle, richAudioFileId, songTitle, songPerformer, parsedDur);
          }
          if (cleanTitle && cleanArtist) {
            const combo1 = `${cleanTitle} ${cleanArtist}`.trim();
            const combo2 = `${cleanArtist} ${cleanTitle}`.trim();
            if (combo1 !== cleanQuery && combo1 !== cleanTitle) dbExec(combo1, richAudioFileId, songTitle, songPerformer, parsedDur);
            if (combo2 !== cleanQuery && combo2 !== cleanTitle && combo2 !== combo1) dbExec(combo2, richAudioFileId, songTitle, songPerformer, parsedDur);
          }
        } catch {}
      }

      await ctx.sm?.reset(ctx.tgId, { reason: 'download_complete' });
    } catch (err) {
      log.error({ err, url }, 'download failed');
      if (isPermissionError(err)) {
        await tracker.cleanup();
        const botUser = ctx.botUsername || app.telegram?.botUsername || 'Lancy_easy_bot';
        const notice = formatMediaRestrictedNotice({
          botUsername: botUser,
          url,
          mediaType: 'photos or videos',
          actionTitle: 'Get in Private DM'
        });
        await (ctx.api || app.telegram?.api).sendMessage(ctx.chatId, notice.text, {
          parse_mode: 'HTML',
          reply_markup: notice.reply_markup
        }).catch(() => {});
        await ctx.sm?.reset(ctx.tgId, { reason: 'download_permission_denied' });
        return;
      }
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

  async function executeTikTokSearch(ctx, query) {
    const q = String(query || '').trim();
    if (!q) return;
    const isGroup = Boolean(ctx.isGroup);
    const forceNew = Boolean(ctx.forceNew);
    const api = ctx.api || app.telegram?.api;

    if (isGroup && api) {
      const caps = await checkChatMediaPermissions(api, ctx.chatId);
      if (!caps.canSendVideos) {
        const botUser = ctx.botUsername || app.telegram?.botUsername || 'Lancy_easy_bot';
        const notice = formatMediaRestrictedNotice({
          botUsername: botUser,
          url: null,
          mediaType: 'video clips',
          actionTitle: 'Search in Private DM'
        });
        await api.sendMessage(ctx.chatId, notice.text, {
          parse_mode: 'HTML',
          reply_markup: notice.reply_markup
        }).catch(() => {});
        return;
      }
    }

    const screenMsgId = (isGroup || forceNew) ? null : (ctx.messageId ?? ctx.sm?.context(ctx.tgId)?.screenMessageId);
    const tracker = new ProgressTracker({
      api: ctx.api || app.telegram.api,
      chatId: ctx.chatId,
      messageId: screenMsgId,
      heartbeatMs: 2000,
      action: 'typing'
    });

    try {
      tracker.set({ stage: 'search', text: `Searching TikTok clips for "${truncate(q, 30)}"… ♡` });
      let vids = [];
      try {
        const { searchYouTubeFast } = await import('../bot.js');
        vids = await searchYouTubeFast(q + ' tiktok');
      } catch {}
      if (!vids.length) {
        try {
          const { yts } = await import('btch-downloader');
          const res = await yts(q + ' tiktok');
          vids = res?.result?.videos || res?.result?.all || [];
        } catch {}
      }

      if (!vids.length) {
        const b = new RichMessageBuilder();
        b.paragraph(rt.bold(banner([
          '𓆩♡𓆪 TIKTOK SEARCH 𓆩♡𓆪',
          'no matching clips found ♡'
        ])));
        b.divider();
        b.quote(rt.text(`Could not find clips for "${truncate(q, 30)}".\nTip: You can paste any TikTok video URL directly in chat to download without watermark! ♡`));
        b.divider();
        b.buttons([
          richButton.callback('🎬 Search Another Topic', encodeCallback(id, 'tiktokSearch'), { style: 'primary' }),
          richButton.callback('« Downloader Studio', encodeCallback(id, 'open'))
        ]);
        b.validate();
        await tracker.finish(b.toJSON());
        return;
      }

      const b = new RichMessageBuilder();
      b.paragraph(rt.bold(banner([
        '𓆩♡𓆪 TIKTOK SEARCH RESULTS 𓆩♡𓆪',
        `trending clips for "${truncate(q, 24)}" ♡`
      ])));
      b.divider();

      const topClips = vids.slice(0, 5);
      for (let i = 0; i < topClips.length; i++) {
        const v = topClips[i];
        const duration = v.timestamp || v.duration?.timestamp || 'HD Clip';
        const views = v.views ? `${Number(v.views).toLocaleString()} views` : 'Trending';
        b.paragraph(rt.concat(
          rt.bold(`${i + 1}. ${truncate(v.title || 'TikTok Video', 45)}\n`),
          rt.italic(`⏱ ${duration} • 👁 ${views}`)
        ));
      }
      b.divider();

      const botUsername = ctx.bot?.botUsername || app?.telegram?.botUsername || 'Lancy_easy_bot';
      for (let i = 0; i < Math.min(topClips.length, 3); i++) {
        const v = topClips[i];
        const vId = v.videoId || (v.url ? v.url.split('v=')[1] : null);
        if (vId) {
          b.buttons([
            richButton.callback(
              `✨ 📥 Download Clip ${i + 1} (${truncate(v.title || '', 20)}) ♡`,
              encodeCallback(id, 'execVid', vId),
              { style: 'primary' }
            )
          ]);
        }
      }

      b.buttons([
        richButton.callback('🎬 Search Another Topic', encodeCallback(id, 'tiktokSearch'), { style: 'primary' }),
        richButton.callback('« Downloader Studio', encodeCallback(id, 'open'))
      ]);
      b.footer(rt.italic('Tip: You can also paste any TikTok video URL directly in chat ♡'));
      b.validate();

      await tracker.finish(b.toJSON());
    } catch (err) {
      log.error({ err: err?.message, query }, 'tiktok search error');
      const b = new RichMessageBuilder();
      b.heading('🎬 TIKTOK SEARCH', 2);
      b.paragraph(rt.italic(`Search could not be completed. You can paste any TikTok URL directly to download! ♡`));
      b.divider();
      b.buttons([richButton.callback('« Downloader Studio', encodeCallback(id, 'open'))]);
      b.validate();
      await tracker.finish(b.toJSON());
    }
  }

  async function executeLyricsSearch(ctx, query) {
    const cleanQuery = String(query || '').trim();
    if (!cleanQuery) return;

    const api = ctx.api || app.telegram?.api;
    const tracker = new ProgressTracker({
      api,
      chatId: ctx.chatId,
      messageId: ctx.isGroup ? null : (ctx.messageId ?? ctx.sm?.context(ctx.tgId)?.screenMessageId),
      heartbeatMs: 2000,
      action: 'typing'
    });

    await tracker.live(() => ({
      blocks: [
        block.heading('𓆩♡𓆪 SEARCHING LYRICS 𓆩♡𓆪', 1),
        block.paragraph(rt.italic(`Searching lyrics for "${truncate(cleanQuery, 40)}"… ♡`))
      ]
    }));

    try {
      const lyricsRes = await getLyrics(cleanQuery);
      if (!lyricsRes.found || !lyricsRes.lyrics) {
        await tracker.cleanup();
        await api.sendMessage(
          ctx.chatId,
          `<blockquote>♡ Could not find lyrics for "<b>${escapeHtml(cleanQuery)}</b>" ♡\nPlease check the spelling or send a longer lyric snippet!</blockquote>`,
          {
            parse_mode: 'HTML',
            reply_markup: inlineKeyboard([
              [ikButton('🔍 Try Another Search', encodeCallback(id, 'searchLyrics')), ikButton('« Downloader', encodeCallback(id, 'open'))]
            ])
          }
        );
        return;
      }

      let trackTitle = lyricsRes.title || cleanQuery;
      let trackArtist = lyricsRes.artist || 'Artist';
      let albumTitle = lyricsRes.album || null;
      let coverUrl = null;
      let coverBuf = null;

      try {
        const dzRes = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(`${trackTitle} ${trackArtist}`)}&limit=1`, {
          signal: AbortSignal.timeout(4000)
        });
        if (dzRes.ok) {
          const dzData = await dzRes.json();
          const first = dzData.data?.[0];
          if (first) {
            trackTitle = first.title || trackTitle;
            trackArtist = first.artist?.name || trackArtist;
            albumTitle = first.album?.title || albumTitle;
            coverUrl = first.album?.cover_big || first.album?.cover_medium;
          }
        }
      } catch {}

      if (coverUrl) {
        try {
          const imgRes = await fetch(coverUrl, { signal: AbortSignal.timeout(5000) });
          if (imgRes.ok) {
            const ab = await imgRes.arrayBuffer();
            coverBuf = Buffer.from(ab);
          }
        } catch {}
      }

      const b = new RichMessageBuilder();
      const files = {};
      b.header('𓆩♡𓆪 SONG LYRICS 𓆩♡𓆪', 1);
      b.divider();

      if (coverBuf) {
        files['cover_photo'] = { buffer: coverBuf, filename: 'cover.jpg', contentType: 'image/jpeg' };
        b.photo('attach://cover_photo');
      }

      const metaRows = [
        ['🎵 Title', truncate(trackTitle, 40)],
        ['🎧 Artist', truncate(trackArtist, 36)]
      ];
      if (albumTitle) metaRows.push(['💿 Album', truncate(albumTitle, 36)]);
      metaRows.push(['📜 Source', lyricsRes.source?.toUpperCase() || 'LRCLIB']);
      b.table(kvTable(metaRows), { compact: true });
      b.divider();

      b.expandableBlockquote(`📜 Lyrics • ${trackTitle}\n\n${lyricsRes.lyrics}`);
      b.divider();

      const dlQuery = `${trackTitle} ${trackArtist}`.trim();
      b.buttons([
        richButton.callback('🎵 Download / Play Track', encodeCallback(id, 'execute', dlQuery), { style: 'primary' }),
        richButton.callback('🔍 Search Another Lyrics', encodeCallback(id, 'searchLyrics'), { style: 'primary' })
      ]);
      b.buttons([
        richButton.callback('« Downloader Menu', encodeCallback(id, 'open'))
      ]);
      b.validate();

      await tracker.finish(b.toJSON(), files);
    } catch (err) {
      await tracker.cleanup();
      await api.sendMessage(
        ctx.chatId,
        `<blockquote>✕ An error occurred while searching lyrics: ${escapeHtml(err.message)}</blockquote>`,
        { parse_mode: 'HTML' }
      );
    }
  }

  return {
    id,
    executeDownload,
    executeTikTokSearch,
    executeLyricsSearch,
    async open(ctx) {
      return ctx.editScreen(renderMainMenu(ctx));
    },
    async handle(ctx, action, args) {
      const fromMedia = Boolean(args?.includes('from_media') || ctx.fromMedia || ctx.forceNew);
      switch (action) {
        case 'open':
          if (fromMedia) {
            try {
              return await ctx.replyRich(renderMainMenu(ctx));
            } catch {
              return await ctx.reply('𓆩♡𓆪 URL DOWNLOADER STUDIO 𓆩♡𓆪\nSend any media link or use /grab <url> ♡');
            }
          }
          return this.open(ctx);
        case 'input':
          await ctx.sm?.transition(ctx.tgId, States.URL_DOWNLOADER_INPUT, { context: { mode: 'url' } });
          if (fromMedia) {
            try {
              return await ctx.replyRich(renderInputPrompt());
            } catch {
              return await ctx.reply('🌸 Send any media link to download, or use /grab <url> ♡');
            }
          }
          return ctx.editScreen(renderInputPrompt());
        case 'tiktokSearch':
          await ctx.sm?.transition(ctx.tgId, States.TIKTOK_SEARCH_INPUT, { context: { mode: 'tiktok' } });
          if (fromMedia) {
            try {
              return await ctx.replyRich(renderTikTokSearchPrompt(ctx));
            } catch {
              return await ctx.reply('🎬 Send any topic to search TikTok clips, or use /tt <topic> ♡');
            }
          }
          return ctx.editScreen(renderTikTokSearchPrompt(ctx));
        case 'play':
          await ctx.sm?.transition(ctx.tgId, States.MUSIC_SEARCH_INPUT, { context: { mode: 'music' } });
          if (fromMedia) {
            try {
              return await ctx.replyRich(renderMusicSearchPrompt(ctx));
            } catch {
              return await ctx.reply('🎵 Send song title or artist to search & play music, or use /play <song> ♡');
            }
          }
          return ctx.editScreen(renderMusicSearchPrompt(ctx));
        case 'searchLyrics':
          await ctx.sm?.transition(ctx.tgId, States.URL_DOWNLOADER_INPUT, { context: { mode: 'lyrics' } });
          if (fromMedia) {
            try {
              return await ctx.replyRich(renderLyricsSearchPrompt(ctx));
            } catch {
              return await ctx.reply('📜 Send song title or lyrics snippet to search lyrics ♡');
            }
          }
          return ctx.editScreen(renderLyricsSearchPrompt(ctx));
        case 'recognize':
          await ctx.sm?.transition(ctx.tgId, States.MUSIC_SEARCH_INPUT, { context: { mode: 'music' } });
          if (fromMedia) {
            try {
              return await ctx.replyRich(renderAudioRecognitionPrompt());
            } catch {
              return await ctx.reply('🎙️ Send voice note or audio clip to identify music ♡');
            }
          }
          return ctx.editScreen(renderAudioRecognitionPrompt());
        case 'more_slide':
        case 'moreSlide':
        case 'prev_slide':
        case 'prevSlide': {
          const albumKey = args[0];
          const offset = Math.max(0, Number(args[1] || 0));
          if (ctx.query?.id) {
            await ctx.api.answerCallbackQuery(ctx.query.id).catch(() => {});
          }
          const album = getAlbum(albumKey);
          if (!album || !album.mediaItems?.length) {
            await ctx.api.answerCallbackQuery(ctx.query.id, {
              text: '♡ Slide album session expired. Send link again to browse! ♡',
              showAlert: true
            }).catch(() => {});
            return;
          }

          const { rich, files } = buildDeliveryRichMessage({
            ...album,
            ctx,
            offset,
            albumKey,
            audioKey: album.audioKey,
            imageKey: album.imageKey
          });

          const chatId = ctx.chatId;
          const targetMsgId = ctx.query?.message?.message_id || ctx.messageId;

          try {
            const sent = await ctx.api.sendRichMessage(chatId, rich, {}, files);
            if (sent?.message_id) {
              if (targetMsgId && sent.message_id !== targetMsgId) {
                await ctx.api.deleteMessage(chatId, targetMsgId).catch(() => {});
              }
              ctx.controller?.markMediaDeliveryMessage?.(sent.message_id);
              app.telegram?.markMediaDeliveryMessage?.(sent.message_id);
              ctx.controller?.userScreenMessage?.set?.(ctx.tgId, { chatId, messageId: sent.message_id });
            }
          } catch (err) {
            log.warn({ err }, 'failed to page slide album');
          }
          return;
        }
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

          // If still not found (e.g. from an older message), inspect message text/caption first
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

          // If still not found (e.g. from deep-link), inspect lyricKey
          if ((!cached || !cached.title) && lyricKey) {
            const cleanKeyTitle = String(lyricKey).replace(/_/g, ' ').trim();
            if (cleanKeyTitle.length > 1 && !/^[0-9a-f]{6,}$/i.test(lyricKey) && !lyricKey.includes('key')) {
              cached = { title: cleanKeyTitle, artist: '' };
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
        case 'live_audio': {
          const videoId = args[0];
          if (ctx.query?.id) {
            await ctx.api.answerCallbackQuery(ctx.query.id, { text: '🎵 Fetching full MP3 file now… ♡' }).catch(() => {});
          }

          const db = app.db || ctx.db;
          const botUser = ctx.botUsername || app.telegram?.botUsername || 'Lancy_easy_bot';
          const inlineMsgId = ctx.query?.inline_message_id;
          const targetChatId = ctx.chatId || ctx.query?.message?.chat?.id;

          // 1. Check if track is already cached in SQLite
          let cached = null;
          if (videoId) {
            try {
              cached = db.prepare(
                'SELECT file_id, title, artist, duration, query FROM cached_audio_tracks WHERE query = ? OR file_id LIKE ? LIMIT 1'
              ).get(videoId, `%${videoId}%`);
            } catch {}
          }

          if (cached?.file_id) {
            const durSec = cached.duration || 0;
            const min = Math.floor(durSec / 60);
            const sec = String(durSec % 60).padStart(2, '0');
            const durStr = durSec > 0 ? `${min}:${sec}` : 'HD Audio';
            const songTitle = cached.title || 'Audio Track';
            const songArtist = cached.artist || 'Music';
            const caption = `🎵 <b>${escapeHtml(songTitle)}</b> — <i>${escapeHtml(songArtist)}</i>\n<blockquote expandable>⏱ <b>Duration:</b> ${durStr} • 🎧 <b>Quality:</b> 320 kbps HD\n✨ <i>Full Audio (100%) via @${botUser} ♡</i></blockquote>`;

            // If triggered from inline message, upgrade the message inline!
            if (inlineMsgId) {
              try {
                await ctx.api.call('editMessageMedia', {
                  inline_message_id: inlineMsgId,
                  media: {
                    type: 'audio',
                    media: cached.file_id,
                    title: songTitle,
                    performer: songArtist,
                    caption,
                    parse_mode: 'HTML'
                  },
                  reply_markup: {
                    inline_keyboard: [
                      [
                        {
                          text: '📜 Lyrics & Info ♡',
                          url: `https://t.me/${botUser}?start=lyrics_${encodeURIComponent(songTitle.replace(/\s+/g, '_')).slice(0, 32)}`,
                          style: 'primary'
                        }
                      ],
                      [
                        {
                          text: '🎵 Search Music Live',
                          switch_inline_query_current_chat: '',
                          style: 'primary'
                        }
                      ]
                    ]
                  }
                });
                return;
              } catch {}
            }

            // Otherwise deliver audio to the chat
            if (targetChatId) {
              await ctx.api.sendChatAction(targetChatId, 'upload_voice').catch(() => {});
              const sent = await ctx.api.sendAudio(targetChatId, cached.file_id, {
                title: songTitle,
                performer: songArtist,
                caption,
                parse_mode: 'HTML',
                ...(durSec > 0 ? { duration: durSec } : {}),
                reply_markup: {
                  inline_keyboard: [
                    [
                      {
                        text: '📜 Lyrics & Info ♡',
                        url: `https://t.me/${botUser}?start=lyrics_${encodeURIComponent(songTitle.replace(/\s+/g, '_')).slice(0, 32)}`,
                        style: 'primary'
                      }
                    ],
                    [
                      {
                        text: '🎵 Search Music Live',
                        switch_inline_query_current_chat: '',
                        style: 'primary'
                      }
                    ]
                  ]
                }
              });
              if (sent?.message_id) {
                (ctx.controller || app.telegram?.controller)?.markMediaDeliveryMessage?.(sent.message_id);
                app.telegram?.markMediaDeliveryMessage?.(sent.message_id);
              }
              return;
            }
          }

          // 2. Not cached yet — download track via mediaDownloader
          if (targetChatId) {
            await ctx.api.sendChatAction(targetChatId, 'upload_voice').catch(() => {});
          }

          const downloadTarget = videoId?.startsWith('http') ? videoId : `https://www.youtube.com/watch?v=${videoId}`;
          let downloadRes = null;
          try {
            downloadRes = await app.mediaDownloader?.download?.(downloadTarget);
          } catch {}

          if (!downloadRes?.audioTrack?.buffer) {
            if (targetChatId) {
              await ctx.api.sendMessage(
                targetChatId,
                '<blockquote>⚠️ <i>Could not download this audio track right now. Please try searching again! ♡</i></blockquote>',
                { parse_mode: 'HTML' }
              );
            }
            return;
          }

          const durSec = downloadRes.duration ? parseDurationToSeconds(downloadRes.duration) : 0;
          const min = Math.floor(durSec / 60);
          const sec = String(durSec % 60).padStart(2, '0');
          const durStr = durSec > 0 ? `${min}:${sec}` : 'HD Audio';
          const songTitle = downloadRes.title || 'Audio Track';
          const songArtist = downloadRes.artist || downloadRes.author || 'Music';
          const caption = `🎵 <b>${escapeHtml(songTitle)}</b> — <i>${escapeHtml(songArtist)}</i>\n<blockquote expandable>⏱ <b>Duration:</b> ${durStr} • 🎧 <b>Quality:</b> 320 kbps HD\n✨ <i>Full Audio (100%) via @${botUser} ♡</i></blockquote>`;

          // If triggered from inline message, upload via owner/bot to get file_id then upgrade inline message!
          if (inlineMsgId) {
            const ownerId = (ctx.settings?.get?.('telegram.ownerIds') || [])[0] || 8380969639;
            const tempSent = await ctx.api.sendAudio(ownerId, downloadRes.audioTrack.buffer, {
              title: songTitle,
              performer: songArtist,
              ...(durSec > 0 ? { duration: durSec } : {}),
              disable_notification: true
            }).catch(() => null);

            if (tempSent?.audio?.file_id) {
              const fileId = tempSent.audio.file_id;
              if (tempSent.message_id) {
                await ctx.api.call('deleteMessage', { chat_id: ownerId, message_id: tempSent.message_id }).catch(() => {});
              }

              // Cache in SQLite
              try {
                const sql = 'INSERT OR REPLACE INTO cached_audio_tracks (query, file_id, title, artist, duration) VALUES (?, ?, ?, ?, ?)';
                if (videoId) db.prepare(sql).run(videoId, fileId, songTitle, songArtist, durSec);
                db.prepare(sql).run(songTitle.toLowerCase().trim(), fileId, songTitle, songArtist, durSec);
                if (songArtist && songArtist !== 'Music') {
                  db.prepare(sql).run(`${songTitle.toLowerCase().trim()} ${songArtist.toLowerCase().trim()}`, fileId, songTitle, songArtist, durSec);
                }
              } catch {}

              try {
                await ctx.api.call('editMessageMedia', {
                  inline_message_id: inlineMsgId,
                  media: {
                    type: 'audio',
                    media: fileId,
                    title: songTitle,
                    performer: songArtist,
                    caption,
                    parse_mode: 'HTML'
                  },
                  reply_markup: {
                    inline_keyboard: [
                      [
                        {
                          text: '📜 Lyrics & Info ♡',
                          url: `https://t.me/${botUser}?start=lyrics_${encodeURIComponent(songTitle.replace(/\s+/g, '_')).slice(0, 32)}`,
                          style: 'primary'
                        }
                      ],
                      [
                        {
                          text: '🎵 Search Music Live',
                          switch_inline_query_current_chat: '',
                          style: 'primary'
                        }
                      ]
                    ]
                  }
                });
                return;
              } catch {}
            }
          }

          // Deliver directly to target chat
          const destinationChat = targetChatId || ctx.tgId;
          if (destinationChat) {
            const sent = await ctx.api.sendAudio(destinationChat, downloadRes.audioTrack.buffer, {
              title: songTitle,
              performer: songArtist,
              caption,
              parse_mode: 'HTML',
              ...(durSec > 0 ? { duration: durSec } : {}),
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: '📜 Lyrics & Info ♡',
                      url: `https://t.me/${botUser}?start=lyrics_${encodeURIComponent(songTitle.replace(/\s+/g, '_')).slice(0, 32)}`,
                      style: 'primary'
                    }
                  ],
                  [
                    {
                      text: '🎵 Search Music Live',
                      switch_inline_query_current_chat: '',
                      style: 'primary'
                    }
                  ]
                ]
              }
            });

            if (sent?.message_id) {
              (ctx.controller || app.telegram?.controller)?.markMediaDeliveryMessage?.(sent.message_id);
              app.telegram?.markMediaDeliveryMessage?.(sent.message_id);
            }

            if (sent?.audio?.file_id) {
              const fileId = sent.audio.file_id;
              try {
                const sql = 'INSERT OR REPLACE INTO cached_audio_tracks (query, file_id, title, artist, duration) VALUES (?, ?, ?, ?, ?)';
                if (videoId) db.prepare(sql).run(videoId, fileId, songTitle, songArtist, durSec);
                db.prepare(sql).run(songTitle.toLowerCase().trim(), fileId, songTitle, songArtist, durSec);
                if (songArtist && songArtist !== 'Music') {
                  db.prepare(sql).run(`${songTitle.toLowerCase().trim()} ${songArtist.toLowerCase().trim()}`, fileId, songTitle, songArtist, durSec);
                }
              } catch {}
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
              const dur = meta.duration || 0;
              if (dur > 0 && dur < 45) return; // Do NOT cache preview snippets
              const db = app.db || ctx.db;
              try {
                const sql = 'INSERT OR REPLACE INTO cached_audio_tracks (query, file_id, title, artist, duration) VALUES (?, ?, ?, ?, ?)';
                const cleanQuery = songTitle.toLowerCase().trim();
                const cleanArtist = songPerformer !== 'Artist' ? songPerformer : null;
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

          if (hintTitle && !/^original sound/i.test(hintTitle)) {
            const query = `${hintTitle} ${hintPerformer}`.trim();
            const dlCtx = {
              ...ctx,
              messageId: progressMsg?.message_id,
              initialStage: `Identified from soundtrack: "${hintTitle}" ♡`
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
          const rawOffset = parseInt(args[1], 10);
          const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
          let images = getMediaImages(imageKey);
          if (!images || images.length === 0) {
            const album = getAlbum(imageKey);
            if (album?.mediaItems) {
              images = album.mediaItems.filter((m) => m.type === 'photo');
            }
          }

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

          const STICKER_BATCH = 10;
          const currentBatch = images.slice(offset, offset + STICKER_BATCH);
          let successCount = 0;
          for (let i = 0; i < currentBatch.length; i++) {
            try {
              const stickerRes = await toTelegramStaticSticker(currentBatch[i].buffer);
              if (stickerRes?.buffer) {
                await ctx.api.sendSticker(ctx.chatId, stickerRes.buffer, { emoji: '✨' });
                successCount++;
              }
            } catch (err) {
              log.debug({ err: err?.message, idx: offset + i }, 'failed to convert image to sticker');
            }
          }

          if (successCount > 0) {
            const b = new RichMessageBuilder();
            const totalConverted = offset + successCount;
            b.paragraph(rt.bold(`✨ Created ${successCount} aesthetic sticker${successCount > 1 ? 's' : ''}! ♡`));
            b.paragraph(rt.text(`Delivered directly above as native Telegram stickers (${totalConverted} of ${images.length} photos converted) ˙ᵕ˙`));
            b.divider();
            const stickerBtns = [];
            const remaining = images.length - totalConverted;
            if (remaining > 0) {
              stickerBtns.push(
                richButton.callback(
                  `🎨 Convert Next ${Math.min(STICKER_BATCH, remaining)} Stickers`,
                  encodeCallback(id, 'to_sticker', imageKey, String(totalConverted), 'from_media'),
                  { style: 'primary' }
                )
              );
            }
            stickerBtns.push(
              richButton.callback('✦ Save to Sticker Pack', encodeCallback('stickers', 'open', 'from_media'), { style: 'primary' })
            );
            stickerBtns.push(
              richButton.callback('« Dashboard', encodeCallback('dashboard', 'open', 'from_media'))
            );
            b.buttons(stickerBtns);
            await ctx.replyRich(b.toJSON()).catch(async () => {
              await ctx.reply(`✨ Created ${successCount} aesthetic sticker${successCount > 1 ? 's' : ''} above! ♡`);
            });
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
        case 'execVid': {
          const vidId = args[0];
          if (vidId) return executeDownload(ctx, `https://youtube.com/watch?v=${vidId}`);
          return this.open(ctx);
        }
        default:
          return this.open(ctx);
      }
    },
    executeDownload,
    executeTikTokSearch,
    executeLyricsSearch,
    registerStates(sm) {
      return this.registerStateHandlers(sm);
    },
    registerStateHandlers(sm) {
      sm.register(States.URL_DOWNLOADER_INPUT, {
        onEnter: async (sctx) => {
          // Handled in handle('input')
        },
        onMessage: async (sctx, message) => {
          const recMedia = extractMediaForMusicRecognition(message);
          if (recMedia && recMedia.obj?.file_id) {
            if (sctx.isGroup && !sctx.isReplyToBot && !sctx.isTag) {
              return false;
            }
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

          const dlCtx = {
            ...sctx,
            controller: sctx.controller || app.telegram?.controller,
            api: sctx.api || app.telegram?.api,
            chatId: message.chat?.id || sctx.chatId,
            tgId: sctx.tgId || String(message.from?.id),
            message
          };

          if (sctx.context?.mode === 'lyrics') {
            await executeLyricsSearch(dlCtx, text);
            return true;
          }

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
            if (sctx.isGroup && !sctx.isReplyToBot && !sctx.isTag) {
              return false;
            }
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

      sm.register(States.TIKTOK_SEARCH_INPUT, {
        onEnter: async (sctx) => {
          // Handled in handle('tiktokSearch')
        },
        onMessage: async (sctx, message) => {
          const text = String(message.text || message.caption || '').trim();
          if (!text) return true;
          const match = text.match(/https?:\/\/[^\s]+/i);
          const dlCtx = {
            ...sctx,
            controller: sctx.controller || app.telegram?.controller,
            api: sctx.api || app.telegram?.api,
            chatId: message.chat?.id || sctx.chatId,
            tgId: sctx.tgId || String(message.from?.id),
            message
          };
          await sctx.reset?.({ reason: 'tiktok_search_started' });
          if (match) {
            await executeDownload(dlCtx, match[0]);
          } else {
            await executeTikTokSearch(dlCtx, text);
          }
          return true;
        },
        onCancel: async (sctx) => {
          await sctx.reset?.({ reason: 'cancelled' });
        }
      });
    }
  };
}
