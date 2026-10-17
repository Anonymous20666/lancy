export {
  fetchImageBuffer,
  createSilhouette,
  renderFramedMedia,
  renderGridMask,
  renderMysteryBlur
} from './visuals.js';

import { renderFramedMedia } from './visuals.js';

/**
 * Legacy-compatible wrapper that renders a pure zero-text framed visual.
 */
export async function renderGameCard({
  mediaBuffer = null,
  isSilhouette = false
} = {}) {
  return renderFramedMedia(mediaBuffer, { isSilhouette });
}
