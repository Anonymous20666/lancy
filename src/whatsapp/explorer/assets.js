import { spawnSync } from 'node:child_process';
import sharp from 'sharp';

/**
 * PlogmeExplorerAssets — on-demand generator for genuine, playback-ready
 * media assets used to deliver real live WhatsApp messages during explorer tests.
 */
export class PlogmeExplorerAssets {
  /** Generate a real 800x800 gradient JPEG image with crisp vector text */
  static async generateTestImageBuffer({ title = 'PLOGME TEST LAB', subtitle = 'Verified Live Image Payload' } = {}) {
    const timestamp = new Date().toISOString();
    const svg = `<svg width="800" height="800" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#4a00e0"/>
          <stop offset="50%" stop-color="#8e2de2"/>
          <stop offset="100%" stop-color="#f107a3"/>
        </linearGradient>
      </defs>
      <rect width="800" height="800" rx="40" fill="url(#g)"/>
      <circle cx="400" cy="220" r="80" fill="#ffffff" fill-opacity="0.2"/>
      <text x="400" y="245" font-size="72" text-anchor="middle" fill="#ffffff" font-family="sans-serif">📸</text>
      <text x="400" y="380" font-size="52" font-weight="bold" text-anchor="middle" fill="#ffffff" font-family="sans-serif">✦ ${title} ✦</text>
      <text x="400" y="450" font-size="32" text-anchor="middle" fill="#f8f9fa" font-family="sans-serif">${subtitle}</text>
      <rect x="150" y="520" width="500" height="60" rx="15" fill="#ffffff" fill-opacity="0.25"/>
      <text x="400" y="560" font-size="24" font-weight="600" text-anchor="middle" fill="#ffffff" font-family="monospace">${timestamp}</text>
    </svg>`;
    return await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
  }

  /** Generate a second image buffer for album testing */
  static async generateSecondaryImageBuffer() {
    const svg = `<svg width="800" height="800" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="g2" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#00b894"/>
          <stop offset="100%" stop-color="#0984e3"/>
        </linearGradient>
      </defs>
      <rect width="800" height="800" rx="40" fill="url(#g2)"/>
      <text x="400" y="245" font-size="72" text-anchor="middle" fill="#ffffff" font-family="sans-serif">🖼️</text>
      <text x="400" y="380" font-size="52" font-weight="bold" text-anchor="middle" fill="#ffffff" font-family="sans-serif">✦ ALBUM ITEM 2 ✦</text>
      <text x="400" y="450" font-size="32" text-anchor="middle" fill="#f8f9fa" font-family="sans-serif">Multi-Media Grouping</text>
    </svg>`;
    return await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
  }

  /** Generate a real 512x512 WebP sticker with transparent background */
  static async generateTestStickerBuffer({ label = 'PLOGME', sub = 'STICKER' } = {}) {
    const svg = `<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
      <rect width="512" height="512" rx="100" fill="#6c5ce7"/>
      <circle cx="256" cy="180" r="70" fill="#ffffff" fill-opacity="0.3"/>
      <text x="256" y="205" font-size="70" text-anchor="middle" fill="#ffffff" font-family="sans-serif">✨</text>
      <text x="256" y="320" font-size="52" font-weight="bold" text-anchor="middle" fill="#ffffff" font-family="sans-serif">${label}</text>
      <text x="256" y="390" font-size="38" font-weight="600" text-anchor="middle" fill="#ffeaa7" font-family="sans-serif">${sub}</text>
    </svg>`;
    return await sharp(Buffer.from(svg)).webp({ quality: 90 }).toBuffer();
  }

  /** Generate a real playable 2-second MP4 video */
  static generateTestVideoBuffer() {
    const res = spawnSync('ffmpeg', [
      '-y',
      '-f', 'lavfi',
      '-i', 'testsrc=duration=2:size=320x320:rate=15',
      '-pix_fmt', 'yuv420p',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-movflags', 'frag_keyframe+empty_moov',
      '-f', 'mp4',
      'pipe:1'
    ], { maxBuffer: 10 * 1024 * 1024 });

    if (res.status !== 0 || !res.stdout || res.stdout.length === 0) {
      throw new Error(`ffmpeg failed to generate test video: ${res.stderr?.toString() || 'unknown error'}`);
    }
    return res.stdout;
  }

  /** Generate a real playable 2-second MP3 audio clip */
  static generateTestAudioBuffer() {
    const res = spawnSync('ffmpeg', [
      '-y',
      '-f', 'lavfi',
      '-i', 'sine=frequency=523:duration=2',
      '-c:a', 'libmp3lame',
      '-b:a', '64k',
      '-f', 'mp3',
      'pipe:1'
    ], { maxBuffer: 10 * 1024 * 1024 });

    if (res.status !== 0 || !res.stdout || res.stdout.length === 0) {
      throw new Error(`ffmpeg failed to generate test audio: ${res.stderr?.toString() || 'unknown error'}`);
    }
    return res.stdout;
  }

  /** Generate a real playable 2-second Opus PTT (Voice Note) clip */
  static generateTestVoiceNoteBuffer() {
    const res = spawnSync('ffmpeg', [
      '-y',
      '-f', 'lavfi',
      '-i', 'sine=frequency=440:duration=2',
      '-c:a', 'libopus',
      '-b:a', '32k',
      '-f', 'ogg',
      'pipe:1'
    ], { maxBuffer: 10 * 1024 * 1024 });

    if (res.status !== 0 || !res.stdout || res.stdout.length === 0) {
      // Fallback to MP3 if ogg/opus is unavailable
      return this.generateTestAudioBuffer();
    }
    return res.stdout;
  }

  /** Generate a real JSON document buffer */
  static generateTestDocumentBuffer() {
    const data = {
      manifest: 'plogme-baileys-explorer',
      version: '2.0.7',
      timestamp: new Date().toISOString(),
      status: 'VERIFIED-LIVE',
      testType: 'DOCUMENT_PAYLOAD',
      capabilities: [
        'messages',
        'media-image',
        'media-video',
        'media-audio',
        'stickers',
        'polls',
        'rich-copy-buttons'
      ]
    };
    return Buffer.from(JSON.stringify(data, null, 2), 'utf-8');
  }

  /** Generate a real vCard 3.0 contact string */
  static generateTestVCard() {
    return [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Plogme Explorer Lab',
      'ORG:Lancy Bot Services;',
      'TEL;type=CELL;type=VOICE;waid=2348164167112:+234 816 416 7112',
      'EMAIL:explorer@plogme.local',
      'NOTE:Verified Live Contact Payload from Plogme Test Lab',
      'END:VCARD'
    ].join('\n');
  }
}
