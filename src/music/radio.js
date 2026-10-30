import {MusicError} from './model.js';
// A broad, paginated catalog, not a claim to enumerate every musical category.
export const RADIO_CATEGORIES=['Afrobeats','Afropop','Amapiano','Afro house','Highlife','Fuji','Gospel','Hip hop','Rap','Trap','Drill','R&B','Soul','Pop','Dance pop','K-pop','J-pop','Latin pop','Reggaeton','Dancehall','Reggae','Rock','Alternative rock','Indie rock','Metal','Punk','Jazz','Blues','Funk','Disco','House','Deep house','Techno','Trance','EDM','Dubstep','Drum and bass','UK garage','Lo-fi','Chillhop','Ambient','Classical','Piano','Instrumental','Acoustic','Country','Folk','World music','Bossa nova','Sad songs','Love songs','Heartbreak','Workout','Party','Sleep','Study','Gaming','Throwbacks','Phonk','Soundtracks'];
export class InfiniteRadio {
 constructor({app}){this.app=app;}
 configure(s,queries,{video=null}={}){queries=[...new Set(queries.map(q=>String(q).trim().slice(0,120)).filter(Boolean))];if(!queries.length||queries.length>5)throw new MusicError('RADIO_SELECTION','Choose one to five categories/custom searches.');const wantsVideo=video!==null?Boolean(video):Boolean(s.radioVideo);s.radio={enabled:true,queries,cursor:0,seen:[],offsets:{},misses:0,notice:null,video:wantsVideo};}
 stop(s){if(s.radio)s.radio.enabled=false;}
 async refill(s){
  const r=s.radio;if(!r?.enabled||s.upcoming.length>=3)return;
  const excluded=new Set([s.currentTrack?.id,...s.upcoming.map(t=>t.id),...s.history.map(t=>t.id),...r.seen]);
  try{
   for(let attempt=0;attempt<Math.min(3,r.queries.length);attempt++){
    if(this.app.musicQueueManager.closed||!r.enabled||s.radio!==r)return;
    const query=r.queries[r.cursor++%r.queries.length],offset=r.offsets[query]||0;
    const isVideo=Boolean(r.video||s.radioVideo);
    const hasAdapters=Boolean(this.app.musicProviders?.adapters);
    const isCompilationOrLive=title=>/\b(24\/7|\d+\s*hours?|full\s*album|compilation|non[\s-]*stop|megamix|long\s*playlist|livestream|\blive\s*(now|stream)?\b|meditation\s*music\b.*relaxing|zen\s*music\b.*relaxing|relaxing\s*music.*hours?|sleep\s*music.*hours?)\b/i.test(String(title||''));
    const filterRadio=(items,maxSec=720)=>(items||[]).filter(t=>!excluded.has(t.id)&&t.availability!=='unavailable'&&t.streamable!==false&&!t.isLive&&t.duration!=='LIVE'&&t.duration!=='HD'&&!isCompilationOrLive(t.title)&&(!hasAdapters||(Number.isFinite(t.durationSeconds)&&t.durationSeconds>=40&&t.durationSeconds<=maxSec)));
    let page;
    try {
      page=await this.app.musicProviders.search(query,{offset,limit:hasAdapters?10:5,video:isVideo,radio:true,filterDuration:'medium'});
    } catch(searchErr) {
      if(hasAdapters){
        page=await this.app.musicProviders.search(`${query} hits`,{offset:0,limit:10,radio:true,filterDuration:'medium'}).catch(()=>null);
      }
      if(!page)throw searchErr;
    }
    if(!r.enabled||s.radio!==r||this.app.musicQueueManager.closed)return;
    r.offsets[query]=page.nextOffset??0;
    let tracks=filterRadio(page.items,720);
    if(!tracks.length&&hasAdapters){
      for(const suffix of ['songs','hits','track','official audio']){
        const altPage=await this.app.musicProviders.search(`${query} ${suffix}`,{offset:0,limit:10,video:isVideo,radio:true,filterDuration:'medium'}).catch(()=>null);
        tracks=filterRadio(altPage?.items,720);
        if(tracks.length)break;
      }
      if(!tracks.length){
        const altPage=await this.app.musicProviders.search(`${query} instrumental track`,{offset:0,limit:10,video:isVideo,radio:true,filterDuration:'medium'}).catch(()=>null);
        tracks=filterRadio(altPage?.items,900);
      }
    }
    for(let i=tracks.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[tracks[i],tracks[j]]=[tracks[j],tracks[i]];}
    for(const t of tracks.slice(0,Math.min(3,100-s.upcoming.length))){this.app.musicQueueManager.enqueue(s.chatId,{...t,mediaType:isVideo?'video':'audio',requester:'Infinite radio'});r.seen.push(t.id);excluded.add(t.id);}
    r.seen=r.seen.slice(-300);
    if(tracks.length){r.misses=0;r.notice=null;return;}
   }
    if(r.seen.length && r.misses === 0){
      r.offsets={};
      r.seen=[];
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
