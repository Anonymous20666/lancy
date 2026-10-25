import { MusicError, KeyedLock } from './model.js';
const norm = s => String(s || '').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
export function matchLyrics(track, records) {
  if (!track.title || !track.artist || /^(music|unknown|artist)$/i.test(track.artist)) return null;
  const candidates = records.filter(r => norm(r.trackName) === norm(track.title) && norm(r.artistName) === norm(track.artist) && (!track.durationSeconds || (Number.isFinite(r.duration) && Math.abs(r.duration-track.durationSeconds) <= 4)) && (r.plainLyrics || r.syncedLyrics || r.instrumental));
  const identities = new Set(candidates.map(r => `${norm(r.albumName)}:${Math.round(r.duration || 0)}:${r.plainLyrics || r.syncedLyrics || 'instrumental'}`));
  return identities.size === 1 ? candidates[0] : null;
}
export class MatchedLyrics {
  constructor({ fetcher = fetch } = {}) { this.fetcher=fetcher; this.cache=new Map(); this.cooldown=0; this.lock=new KeyedLock(); }
  async get(track) {
    if (!track?.artist || !track?.title) return { found:false, reason:'The track does not have reliable title and artist metadata.' };
    const key=`${track.id}:${track.durationSeconds || ''}`;
    if (this.cache.has(key)) return this.cache.get(key);
    return this.lock.run('provider', async () => {
      if (Date.now() < this.cooldown) throw new MusicError('LYRICS_RATE_LIMIT','Lyrics are temporarily rate limited. Try later.');
      const q=new URLSearchParams({ track_name:track.title, artist_name:track.artist });
      const r=await this.fetcher(`https://lrclib.net/api/search?${q}`, { headers:{'User-Agent':'Lancy/1.0 (https://github.com/Anonymous20666/lancy)'}, signal:AbortSignal.timeout(8000) });
      this.cooldown=Date.now()+300;
      if (r.status===429 || r.status===503) { this.cooldown=Date.now()+Math.max(1,Number(r.headers.get('retry-after')) || 60)*1000; throw new MusicError('LYRICS_RATE_LIMIT','Lyrics are temporarily unavailable. Try again later.'); }
      if (!r.ok) return { found:false, reason:'The lyrics provider is unavailable.' };
      const record=matchLyrics(track,await r.json());
      const result=record ? { found:true, title:record.trackName, artist:record.artistName, instrumental:Boolean(record.instrumental), text:record.plainLyrics || String(record.syncedLyrics || '').replace(/\[\d{1,2}:\d{2}(?:\.\d+)?\]/g,''), syncedLyrics:record.syncedLyrics || null, source:'LRCLIB' } : { found:false, reason:'No unambiguous title, artist and duration match was found.' };
      this.cache.set(key,result); if(this.cache.size>200)this.cache.delete(this.cache.keys().next().value); return result;
    });
  }
}

export function parseSyncedLyrics(syncedLyrics) {
  if (!syncedLyrics || typeof syncedLyrics !== 'string') return [];
  const cues = [];
  for (const raw of syncedLyrics.split(/\r?\n/)) {
    const match = raw.match(/^\s*\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]\s*(.*)$/);
    if (!match) continue;
    const mins = Number(match[1]);
    const secs = Number(match[2]);
    const frac = match[3] ? Number(match[3].padEnd(3, '0')) / 1000 : 0;
    const text = match[4].trim();
    if (text) cues.push({ time: mins * 60 + secs + frac, text });
  }
  return cues.sort((a, b) => a.time - b.time);
}

export function currentLyricWindow(syncedLyrics, positionSeconds) {
  if (!Number.isFinite(positionSeconds) || positionSeconds < 0) return null;
  const cues = parseSyncedLyrics(syncedLyrics);
  if (!cues.length) return null;
  let activeIndex = -1;
  for (let i = 0; i < cues.length; i++) {
    if (cues[i].time <= positionSeconds + 0.35) activeIndex = i;
    else break;
  }
  if (activeIndex < 0) activeIndex = 0;
  const prev = activeIndex > 0 ? `  ${cues[activeIndex - 1].text}` : null;
  const curr = `▶ ${cues[activeIndex].text}`;
  const next = activeIndex + 1 < cues.length ? `  ${cues[activeIndex + 1].text}` : null;
  return [prev, curr, next].filter(Boolean).join('\n');
}
