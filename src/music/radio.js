import {MusicError} from './model.js';
import {getArtistCatalogAndRelated, isLikelyArtistQuery, getTrendingCharts} from './charts.js';
import {isNonMusicOrNews} from '../media/youtubeSearch.js';
// A broad, paginated catalog, not a claim to enumerate every musical category.
export const RADIO_CATEGORIES=['Afrobeats','Afropop','Amapiano','Afro house','Highlife','Fuji','Gospel','Hip hop','Rap','Trap','Drill','R&B','Soul','Pop','Dance pop','K-pop','J-pop','Latin pop','Reggaeton','Dancehall','Reggae','Rock','Alternative rock','Indie rock','Metal','Punk','Jazz','Blues','Funk','Disco','House','Deep house','Techno','Trance','EDM','Dubstep','Drum and bass','UK garage','Lo-fi','Chillhop','Ambient','Classical','Piano','Instrumental','Acoustic','Country','Folk','World music','Bossa nova','Sad songs','Love songs','Heartbreak','Workout','Party','Sleep','Study','Gaming','Throwbacks','Phonk','Soundtracks'];
const STATIC_OR_TALK_RE = /\b(official\s*audio|audio\s*only|lyric\s*video|lyrics|visualizer|reaction|interview|podcast|review|explained|how to|tutorial)\b/i;
const OFFICIAL_MV_RE = /\b(official\s*(music\s*)?video|\bmusic\s*video\b|\bofficial\s*video\b|\bm\/?v\b)\b/i;

function normPrimaryArtist(artist) {
  return String(artist || '')
    .toLowerCase()
    .replace(/\s*-\s*topic$/i, '')
    .split(/[,&]|\s+x\s+|\b(?:ft|feat)\.?\b/i)[0]
    .replace(/[^a-z0-9]/g, '');
}

export function normTrackTitleKey(artist, title) {
  const cleanTitle = String(title || '')
    .toLowerCase()
    .replace(/\[(?:official|lyric|audio|music\s*video|visualizer|hd|4k|explicit)[^\]]*\]/gi, '')
    .replace(/\((?:official|lyric|audio|music\s*video|visualizer|feat\.?|ft\.?|with|explicit|clean)[^)]*\)/gi, '')
    .replace(/[^a-z0-9]/g, '');
  const a = normPrimaryArtist(artist);
  return a && cleanTitle && cleanTitle.length >= 2 ? `${a}::${cleanTitle}` : '';
}

function trackMatchesArtist(track, targetArtist) {
  if (!track || !targetArtist) return true;
  const targetNorm = normPrimaryArtist(targetArtist);
  if (!targetNorm) return true;
  const trackArtistNorm = normPrimaryArtist(track.artist);
  if (trackArtistNorm && (trackArtistNorm === targetNorm || trackArtistNorm.includes(targetNorm) || targetNorm.includes(trackArtistNorm))) return true;
  const fullArtist = String(track.artist || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const fullTitle = String(track.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return fullArtist.includes(targetNorm) || fullTitle.includes(targetNorm);
}

/**
 * Deterministically order category tracks from trending & popular recent hits
 * into established hits and then older classics (never random shuffle).
 * Also deprioritizes static Topic/lyric uploads when real music videos are requested.
 */
export function rankTracksTrendingToOld(tracks = [], { isVideo = false } = {}) {
  const list = Array.isArray(tracks) ? [...tracks] : [];
  if (list.length <= 1) return list;
  const hasRankSignals = list.some(t => Number(t?.viewCount) > 0 || (t?.publishedAgeDays != null && Number.isFinite(Number(t.publishedAgeDays))));
  if (!hasRankSignals && !isVideo) return list;

  const entryScore = (t) => {
    const title = String(t?.title || '');
    const artist = String(t?.artist || '');
    const views = Math.max(0, Number(t?.viewCount) || 0);
    const hasAge = t?.publishedAgeDays != null && Number.isFinite(Number(t.publishedAgeDays));
    const ageDays = hasAge ? Math.max(0, Number(t.publishedAgeDays)) : null;

    let mvPenalty = 0;
    if (isNonMusicOrNews(title, artist)) {
      mvPenalty += 5;
    } else if (isVideo) {
      if (/\s-\s*topic$/i.test(artist) || STATIC_OR_TALK_RE.test(title)) mvPenalty += 2;
      else if (!OFFICIAL_MV_RE.test(title) && !t?.isArtistChannel && views > 0 && views < 50_000) mvPenalty += 1;
    } else if (/\b(reaction|interview|podcast|review|explained|tutorial)\b/i.test(title)) {
      mvPenalty += 2;
    }

    // Tier 0: Current Trending / Recent Popular Hits (<= 2 years & >= 500k views)
    // Tier 1: Recent Smash Hits (<= 5 years & >= 1M views, or <= 2 years >= 50k views)
    // Tier 2: Older Classics & Throwbacks (> 5 years, ordered newer-to-older weighted by popularity)
    // Tier 3: Static uploads / commentary / unverified low-view clips when video hits exist
    let tier = 2;
    if (mvPenalty >= 5) {
      tier = 9;
    } else if (mvPenalty >= 2) {
      tier = 3;
    } else if (ageDays !== null && ageDays <= 730 && views >= 500_000) {
      tier = 0;
    } else if ((ageDays !== null && ageDays <= 1825 && views >= 1_000_000) || (ageDays !== null && ageDays <= 730 && views >= 50_000)) {
      tier = 1;
    } else if (views >= 500_000 || ageDays === null) {
      tier = 2;
    } else {
      tier = 3;
    }

    const mvBonus = isVideo && OFFICIAL_MV_RE.test(title) ? 1.5 : 0;
    const ageYears = ageDays !== null ? ageDays / 365 : 5;
    const pop = Math.log10(views + 10);
    // Higher withinScore plays earlier inside its tier: high views + newer age wins over oldest clips
    const withinScore = pop + mvBonus - ageYears * (tier === 0 ? 0.35 : tier === 1 ? 0.45 : 0.65);
    return { tier, withinScore, views, ageYears };
  };

  const decorated = list.map((t, idx) => ({ t, idx, ...entryScore(t) }));
  decorated.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (Math.abs(b.withinScore - a.withinScore) > 0.05) return b.withinScore - a.withinScore;
    if (b.views !== a.views) return b.views - a.views;
    return a.idx - b.idx;
  });

  // Spread identical lead artists mildly (lookahead window of 3) without disturbing trending -> old era flow
  const ordered = [];
  const remaining = [...decorated];
  let lastArtist = '';
  while (remaining.length) {
    let pickIdx = 0;
    if (lastArtist) {
      const topTier = remaining[0].tier;
      const alt = remaining.slice(0, 4).findIndex(cand => {
        if (cand.tier > topTier) return false;
        const a = normPrimaryArtist(cand.t.artist);
        return a && a !== lastArtist;
      });
      if (alt > 0) pickIdx = alt;
    }
    const [chosen] = remaining.splice(pickIdx, 1);
    ordered.push(chosen.t);
    lastArtist = normPrimaryArtist(chosen.t.artist);
  }
  return ordered;
}

export class InfiniteRadio {
 constructor({app, artistResolver = null}){this.app=app;this.artistResolver=artistResolver;}
 configure(s,queries,{video=null}={}){queries=[...new Set(queries.map(q=>String(q).trim().slice(0,120)).filter(Boolean))];if(!queries.length||queries.length>5)throw new MusicError('RADIO_SELECTION','Choose one to five categories/custom searches.');const ytEnabled=Boolean(this.app?.musicProviders?.get?.('youtube')?.enabled);const wantsVideo=video!==null?Boolean(video):Boolean(s.radioVideo||ytEnabled);if(video!==null||wantsVideo)s.radioVideo=wantsVideo;s.radio={enabled:true,queries,seedQueries:[...queries],cursor:0,seen:[],seenTitles:[],offsets:{},passCounts:{},buffers:{},artistPlans:{},artistDepths:{},exhaustedArtists:[],misses:0,notice:null,video:wantsVideo};}
 stop(s){if(s.radio)s.radio.enabled=false;}
 async #resolveArtist(query){
  const resolver=this.app?.music?.artistResolver||this.artistResolver||getArtistCatalogAndRelated;
  return await Promise.resolve(resolver(query,{knownCategories:RADIO_CATEGORIES})).catch(()=>null);
 }
 #enqueueItems(s,r,items,isVideo,excluded,excludedTitles){
  let added=0;const remaining=[];
  for(const t of items){
   if(!t?.id||excluded.has(t.id))continue;
   const tKey=normTrackTitleKey(t.artist,t.title);
   if(tKey&&excludedTitles.has(tKey))continue;
   if(added<3){
    this.app.musicQueueManager.enqueue(s.chatId,{...t,mediaType:isVideo?'video':'audio',requester:'Infinite radio'});
    r.seen.push(t.id);excluded.add(t.id);
    if(tKey){r.seenTitles.push(tKey);excludedTitles.add(tKey);}
    added++;
   }else{
    remaining.push(t);
   }
  }
  r.seen=r.seen.slice(-350);
  r.seenTitles=r.seenTitles.slice(-350);
  return {added,remaining};
 }
 async refill(s){
  const r=s.radio;if(!r?.enabled||s.upcoming.length>=4)return;
  if(!r.passCounts)r.passCounts={};
  if(!r.buffers)r.buffers={};
  if(!r.artistPlans)r.artistPlans={};
  if(!r.artistDepths)r.artistDepths={};
  if(!r.exhaustedArtists)r.exhaustedArtists=[];
  if(!r.seenTitles)r.seenTitles=[];
  const excluded=new Set([s.currentTrack?.id,...s.upcoming.map(t=>t.id),...s.history.map(t=>t.id),...r.seen].filter(Boolean));
  const excludedTitles=new Set([
   s.currentTrack,
   ...(s.upcoming||[]),
   ...(s.history||[])
  ].map(t=>normTrackTitleKey(t?.artist,t?.title)).concat(r.seenTitles).filter(Boolean));
  try{
   const isVideo=r.video!==undefined?Boolean(r.video):Boolean(s.radioVideo);
   const variations=isVideo?['songs','trending hits','official music video','classic hits','throwback hits']:['songs','trending hits','hits','official audio','classic hits'];
   const hasAdapters=Boolean(this.app.musicProviders?.adapters);
   const isCompilationOrLive=title=>/\b(24\/7|\d+\s*hours?|full\s*album|compilation|non[\s-]*stop|megamix|long\s*playlist|livestream|\blive\s*(now|stream)?\b|meditation\s*music\b.*relaxing|zen\s*music\b.*relaxing|relaxing\s*music.*hours?|sleep\s*music.*hours?)\b/i.test(String(title||''));
   const filterRadio=(items,maxSec=720)=>(items||[]).filter(t=>{
    if(!t?.id||excluded.has(t.id)||t.availability==='unavailable'||t.streamable===false||t.isLive||t.duration==='LIVE'||t.duration==='HD'||isCompilationOrLive(t.title)||isNonMusicOrNews(t.title,t.artist))return false;
    if(hasAdapters&&(!Number.isFinite(t.durationSeconds)||t.durationSeconds<40||t.durationSeconds>maxSec))return false;
    const tKey=normTrackTitleKey(t.artist,t.title);
    if(tKey&&excludedTitles.has(tKey))return false;
    return true;
   });

   let artistExpansions=0;
   let preserveTransitionNotice=false;
   for(let attempt=0;attempt<Math.min(3,r.queries.length);attempt++){
    if(this.app.musicQueueManager.closed||!r.enabled||s.radio!==r||!r.queries.length)return;
    const idx=r.cursor%r.queries.length;
    const query=r.queries[idx];
    r.cursor++;

    // 1. Reuse buffered tracks before running fresh searches
    if(Array.isArray(r.buffers[query])&&r.buffers[query].length){
     const freshBuf=filterRadio(r.buffers[query],720);
     const {added,remaining}=this.#enqueueItems(s,r,freshBuf,isVideo,excluded,excludedTitles);
     r.buffers[query]=remaining;
     if(added>0){r.misses=0;return;}
    }

    // 2. Artist A-to-Z catalog -> auto-expand into related similar artists in same category
    if(!r.artistPlans[query]){
     if(isLikelyArtistQuery(query,RADIO_CATEGORIES)){
      const planRes=await this.#resolveArtist(query);
      if(!r.enabled||s.radio!==r||this.app.musicQueueManager.closed)return;
      r.artistPlans[query]=planRes?.found&&planRes.artist
       ?{checked:true,found:true,artist:planRes.artist,genre:planRes.genre||'',catalog:Array.isArray(planRes.tracks)?planRes.tracks:[],catalogCursor:0,relatedArtists:Array.isArray(planRes.relatedArtists)?planRes.relatedArtists:[],providerPass:0,expandedToRelated:false,depth:r.artistDepths[query]||0}
       :{checked:true,found:false};
     }else{
      r.artistPlans[query]={checked:true,found:false};
     }
    }

    const plan=r.artistPlans[query];
    if(plan?.found&&!plan.expandedToRelated){
     const gathered=[];
     const gatheredIds=new Set();
     const gatheredTitles=new Set();
     for(let round=0;round<2&&plan.catalogCursor<plan.catalog.length&&gathered.length<3;round++){
      const searchBatch=[];
      while(plan.catalogCursor<plan.catalog.length&&searchBatch.length<3){
       const entry=plan.catalog[plan.catalogCursor++];
       const entryKey=normTrackTitleKey(entry.artist||plan.artist,entry.title);
       if(!entry?.title||(entryKey&&(excludedTitles.has(entryKey)||gatheredTitles.has(entryKey))))continue;
       searchBatch.push(entry);
      }
      if(!searchBatch.length)break;
      const pages=await Promise.all(
       searchBatch.map(entry=>
        this.app.musicProviders.search(`${plan.artist} ${entry.title}`,{offset:0,limit:3,video:isVideo,radio:true,filterDuration:'medium'}).catch(()=>null)
       )
      );
      if(!r.enabled||s.radio!==r||this.app.musicQueueManager.closed)return;
      for(const pg of pages){
       const candidates=filterRadio(pg?.items,720).filter(t=>!gatheredIds.has(t.id)&&(!hasAdapters||trackMatchesArtist(t,plan.artist)));
       const ranked=rankTracksTrendingToOld(candidates,{isVideo});
       const pick=ranked[0];
       if(pick){
        gatheredIds.add(pick.id);
        const pk=normTrackTitleKey(pick.artist,pick.title);
        if(pk)gatheredTitles.add(pk);
        gathered.push(pick);
       }
      }
     }

     if(!gathered.length&&plan.providerPass<2){
      const qDirect=plan.providerPass===0?plan.artist:`${plan.artist} classic hits`;
      plan.providerPass++;
      const offset=r.offsets[query]||0;
      const page=await this.app.musicProviders.search(qDirect,{offset,limit:hasAdapters?12:5,video:isVideo,radio:true,filterDuration:'medium'}).catch(()=>null);
      if(!r.enabled||s.radio!==r||this.app.musicQueueManager.closed)return;
      if(page){
       r.offsets[query]=page.nextOffset??(offset+(page.items?.length||0));
       let items=filterRadio(page.items,720).filter(t=>!gatheredIds.has(t.id));
       const strictArtist=items.filter(t=>trackMatchesArtist(t,plan.artist));
       if(strictArtist.length)items=strictArtist;
       gathered.push(...rankTracksTrendingToOld(items,{isVideo}));
      }
     }

     if(gathered.length){
      const {added,remaining}=this.#enqueueItems(s,r,gathered,isVideo,excluded,excludedTitles);
      r.buffers[query]=remaining;
      if(added>0){r.misses=0;if(!preserveTransitionNotice)r.notice=null;return;}
     }

     // Artist catalog exhausted -> transition smoothly into related / fans-also-like artists in same category
     plan.expandedToRelated=true;
     const doneArtistNorm=normPrimaryArtist(plan.artist);
     if(doneArtistNorm&&!r.exhaustedArtists.includes(doneArtistNorm))r.exhaustedArtists.push(doneArtistNorm);
     let peerNames=(plan.relatedArtists||[]).map(a=>a?.name||a).filter(Boolean);
     if(!peerNames.length&&plan.genre){
      const chartPeers=await getTrendingCharts({genre:plan.genre,limit:15}).catch(()=>[]);
      peerNames=chartPeers.filter(x=>(x?.genrePriority||0)>=1).map(x=>String(x.artist||'').split(/[,&]|feat\.?|ft\./i)[0].trim()).filter(Boolean);
     }
     const existingQueryNorms=new Set(r.queries.map(normPrimaryArtist).concat(r.exhaustedArtists));
     const nextPeers=[];
     for(const name of peerNames){
      const pn=normPrimaryArtist(name);
      if(!pn||existingQueryNorms.has(pn))continue;
      existingQueryNorms.add(pn);
      nextPeers.push(name);
      if(nextPeers.length>=4)break;
     }
     if(nextPeers.length){
      delete r.buffers[query];
      const replaceAt=r.queries.indexOf(query);
      if(replaceAt>=0){
       r.queries.splice(replaceAt,1,...nextPeers);
       r.cursor=replaceAt;
      }else{
       r.queries.push(...nextPeers);
      }
      r.queries=r.queries.slice(0,8);
      for(const peer of nextPeers)r.artistDepths[peer]=(plan.depth||0)+1;
      r.notice=`Played all ${plan.artist} catalog — continuing with related ${plan.genre||'category'} artists: ${nextPeers.slice(0,3).join(', ')}.`;
      preserveTransitionNotice=true;
      if(artistExpansions++<1)attempt--;
      continue;
     }
    }

    // 3. Standard category or general search refill
    const offset=r.offsets[query]||0;
    const pass=r.passCounts[query]||0;r.passCounts[query]=pass+1;
    const eraQueries=['classic hits','throwbacks','old school hits'];
    const isOldExplicit=/\b(classic|throwback|old|80s|90s|2000s|00s)\b/i.test(query);
    const effectiveQuery=(pass>=2&&!isOldExplicit)?`${query} ${eraQueries[(pass-2)%eraQueries.length]}`:query;
    let page=null;
    try {
      page=await this.app.musicProviders.search(effectiveQuery,{offset,limit:hasAdapters?12:5,video:isVideo,radio:true,filterDuration:'medium'});
    } catch(searchErr) {
      if(hasAdapters){
        page=await this.app.musicProviders.search(`${query} hits`,{offset:0,limit:12,video:isVideo,radio:true,filterDuration:'medium'}).catch(()=>null);
      }
      if(!page)throw searchErr;
    }
    if(!r.enabled||s.radio!==r||this.app.musicQueueManager.closed)return;
    r.offsets[query]=page.nextOffset??0;
    let tracks=filterRadio(page.items,720);
    if(!tracks.length&&hasAdapters){
      for(let vi=0;vi<variations.length;vi++){
        const suffix=variations[vi];
        const altPage=await this.app.musicProviders.search(`${query} ${suffix}`,{offset:0,limit:12,video:isVideo,radio:true,filterDuration:'medium'}).catch(()=>null);
        tracks=filterRadio(altPage?.items,720);
        if(tracks.length)break;
      }
      if(!tracks.length){
        const altPage=await this.app.musicProviders.search(`${query} instrumental track`,{offset:0,limit:12,video:isVideo,radio:true,filterDuration:'medium'}).catch(()=>null);
        tracks=filterRadio(altPage?.items,900);
      }
    }
    tracks=rankTracksTrendingToOld(tracks,{isVideo});
    const {added,remaining}=this.#enqueueItems(s,r,tracks,isVideo,excluded,excludedTitles);
    r.buffers[query]=remaining.slice(0,18);
    if(added>0){r.misses=0;if(!preserveTransitionNotice)r.notice=null;return;}
   }
    if(r.seen.length && r.misses === 0){
      r.offsets={};
      r.passCounts={};
      r.buffers={};
      r.seen=[];
      r.seenTitles=[];
      r.misses++;
    } else {
      r.misses++;
      r.notice='No new permitted tracks found. Try another category or custom search.';
      if(r.misses>=2) r.enabled=false;
    }
  }catch(error){
    r.enabled=false;
    r.notice=error instanceof MusicError?error.message:'Autoplay paused because the catalog is unavailable. Your existing queue is retained.';
  }
 }
}
