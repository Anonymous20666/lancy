import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { boundedFetchFile } from './library.js';
import { richButton, encodeCallback } from '../telegram/rich.js';

/** Cover art only. No new search, source substitution, cookies or credentials.
 * DNS pinning, public-only HTTPS, bounded bytes, bounded pixels and an abortable
 * request keep provider-supplied artwork from becoming a private-network fetch. */
export async function recordingArtwork(track, { fetchFile = boundedFetchFile } = {}) {
  if (!track.artwork) return null;
  const root = await mkdtemp(join(tmpdir(), 'lancy-recording-cover-'));
  try {
    const path = join(root, 'cover');
    await fetchFile(track.artwork, path, 4 * 1024 * 1024, 0, {signal:AbortSignal.timeout(4000)});
    const buffer = await sharp(await readFile(path), {limitInputPixels:16000000})
      .rotate().resize({width:1280,height:1280,fit:'inside',withoutEnlargement:true}).jpeg({quality:88}).toBuffer();
    return {buffer, filename:'recording-cover.jpg', mimeType:'image/jpeg'};
  } catch {
    // A missing/blocked cover must not discard a valid full recording.
    return null;
  } finally {
    await rm(root, {recursive:true, force:true});
  }
}

export async function originalPlayDelivery({app,ctx,track,audio,lyrics,cardToken,allowArtwork=true,artworkLoader=recordingArtwork}) {
  const original = app.screens.get('downloader');
  if (typeof original?.renderRecordingCard !== 'function') {
    // Compatibility for existing injected controllers/tests with no downloader.
    // The composition root always registers the original downloader screen.
    return {rich:app.screens.get('music').renderListen(track,'attach://music_full_audio',{cardToken,lyrics}),files:{music_full_audio:audio}};
  }
  const artwork = allowArtwork ? await artworkLoader(track) : null;
  return original.renderRecordingCard({ctx,track,audio,artwork,lyrics,
    queueButton:cardToken ? richButton.callback('Add to VC queue',encodeCallback('music','listenq',cardToken)) : null});
}
