import {MusicError} from './model.js';
// A broad, paginated catalog, not a claim to enumerate every musical category.
export const RADIO_CATEGORIES=['Afrobeats','Afropop','Amapiano','Afro house','Highlife','Fuji','Gospel','Hip hop','Rap','Trap','Drill','R&B','Soul','Pop','Dance pop','K-pop','J-pop','Latin pop','Reggaeton','Dancehall','Reggae','Rock','Alternative rock','Indie rock','Metal','Punk','Jazz','Blues','Funk','Disco','House','Deep house','Techno','Trance','EDM','Dubstep','Drum and bass','UK garage','Lo-fi','Chillhop','Ambient','Classical','Piano','Instrumental','Acoustic','Country','Folk','World music','Bossa nova','Sad songs','Love songs','Heartbreak','Workout','Party','Sleep','Study','Gaming','Throwbacks','Phonk','Soundtracks'];
export class InfiniteRadio {
 constructor({app}){this.app=app;}
 configure(s,queries,{video=null}={}){queries=[...new Set(queries.map(q=>String(q).trim().slice(0,120)).filter(Boolean))];if(!queries.length||queries.length>5)throw new MusicError('RADIO_SELECTION','Choose one to five categories/custom searches.');const wantsVideo=video!==null?Boolean(video):Boolean(s.isChannel||s.radioVideo);s.radio={enabled:true,queries,cursor:0,seen:[],offsets:{},misses:0,notice:null,video:wantsVideo};}
 stop(s){if(s.radio)s.radio.enabled=false;}
 async refill(s){
  const r=s.radio;if(!r?.enabled||s.upcoming.length>=3)return;
  const excluded=new Set([s.currentTrack?.id,...s.upcoming.map(t=>t.id),...s.history.map(t=>t.id),...r.seen]);
  try{
   for(let attempt=0;attempt<Math.min(3,r.queries.length);attempt++){
    if(this.app.musicQueueManager.closed||!r.enabled||s.radio!==r)return;
    const query=r.queries[r.cursor++%r.queries.length],offset=r.offsets[query]||0;
    const page=await this.app.musicProviders.search(query,{offset,limit:5});
    if(!r.enabled||s.radio!==r||this.app.musicQueueManager.closed)return;
    r.offsets[query]=page.nextOffset??0;
    const tracks=page.items.filter(t=>!excluded.has(t.id)&&t.availability!=='unavailable');
    for(let i=tracks.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[tracks[i],tracks[j]]=[tracks[j],tracks[i]];}
    const isVideo=Boolean(r.video||s.isChannel||s.radioVideo);
    for(const t of tracks.slice(0,Math.min(3,100-s.upcoming.length))){this.app.musicQueueManager.enqueue(s.chatId,{...t,mediaType:isVideo?'video':'audio',requester:'Infinite radio'});r.seen.push(t.id);excluded.add(t.id);}
    r.seen=r.seen.slice(-300);
    if(tracks.length){r.misses=0;r.notice=null;return;}
   }
   r.offsets={};
   r.seen=[];
   r.misses=0;
   r.notice=null;
  }catch(error){
   r.notice=error instanceof MusicError?error.message:'Refilling infinite radio stream…';
  }
 }
}
