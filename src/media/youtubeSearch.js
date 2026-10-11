/**
 * Fast YouTube InnerTube Video & Music Search
 * Uses lightweight JSON endpoint (<100ms) with zero heavy browser emulation.
 */
export async function searchYouTubeFast(query) {
  const clean = String(query || '').trim();
  if (!clean) return [];
  try {
    const res = await fetch('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: '2.20240101.00.00',
            hl: 'en',
            gl: 'US'
          }
        },
        query: clean
      }),
      signal: AbortSignal.timeout(2500)
    });
    const data = await res.json();
    const videos = [];
    const seen = new Set();

    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (node.videoId && (node.title || node.headline)) {
        let vid = String(node.videoId).replace(/^shorts-lockup-/, '').replace(/^shorts-shelf-item-/, '');
        if (vid.length === 11 && !seen.has(vid)) {
          seen.add(vid);
          const title = node.title?.runs?.[0]?.text || node.title?.simpleText || node.headline?.simpleText || '';
          const duration = node.lengthText?.simpleText || 'HD';
          const views = node.viewCountText?.simpleText || node.shortViewCountText?.simpleText || '';
          const author = node.ownerText?.runs?.[0]?.text || node.shortBylineText?.runs?.[0]?.text || 'Music';
          const thumb = node.thumbnail?.thumbnails?.pop()?.url || `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;
          if (title) {
            videos.push({ videoId: vid, title, duration, views, author, thumb });
          }
        }
      } else if (node.shortsLockupViewModel) {
        const vm = node.shortsLockupViewModel;
        let vid = String(vm.entityId || '').replace(/^shorts-lockup-/, '').replace(/^shorts-shelf-item-/, '');
        if (!vid && vm.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId) {
          vid = vm.onTap.innertubeCommand.reelWatchEndpoint.videoId;
        }
        if (vid && vid.length === 11 && !seen.has(vid)) {
          seen.add(vid);
          const title = vm.overlayMetadata?.primaryText?.content || '';
          const views = vm.overlayMetadata?.secondaryText?.content || '';
          const thumb = vm.thumbnail?.sources?.pop()?.url || `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;
          if (title) {
            videos.push({ videoId: vid, title, duration: 'Short', views, author: 'Shorts', thumb });
          }
        }
      }
      for (const k of Object.keys(node)) {
        walk(node[k]);
      }
    }

    walk(data);
    if (videos.length > 0) return videos;
  } catch {}

  try {
    const { yts } = await import('btch-downloader');
    const res = await yts(clean);
    const vids = res?.result?.videos || res?.result?.all || [];
    return vids.map(v => ({
      videoId: v.videoId || (v.url ? v.url.split('v=')[1] : ''),
      title: v.title || clean,
      duration: v.timestamp || v.duration?.timestamp || 'HD',
      views: v.views ? String(v.views) : '',
      author: v.author?.name || 'Music',
      thumb: v.thumbnail || v.image || ''
    })).filter(v => Boolean(v.videoId));
  } catch {
    return [];
  }
}
