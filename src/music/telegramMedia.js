import {audioFileId} from './preview.js';
import {mkdir,open,stat,unlink,rename,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {normalizeTrack,MusicError} from './model.js';

/** Bot-API files only: bounded intake, no arbitrary URLs and no credential URLs in tracks/logs. */
export class TelegramMedia {
 constructor(library){this.library=library;this.items=new Map();}
 async import(api,message,{video=null}={}){
  if(!message?.audio&&!message?.voice&&!message?.video&&!message?.video_note&&!message?.document){const fileId=audioFileId(message);if(fileId)message={...message,audio:{file_id:fileId,title:'Shared full recording'}};}
  const doc=message?.document,visual=message?.video||message?.video_note||(/^video\//.test(doc?.mime_type||'')?doc:null);
  const audio=message?.audio||message?.voice||(/^audio\//.test(doc?.mime_type||'')?doc:null),file=visual||audio;
  if(!file?.file_id)throw new MusicError('REPLY_MEDIA','Reply /stream to an audio, voice message or video.');
  const max=api.isLocalServer?Math.max(this.library.maxBytes,this.library.videoMaxBytes||0):Math.min(this.library.maxBytes,20*1024*1024);if(file.file_size>max)throw new MusicError('FILE_TOO_LARGE',api.isLocalServer?`Reply with media up to ${Math.floor(max/1048576)} MB.`:'Reply with media up to 20 MB for Telegram cloud downloads.');
  const wantsVideo=video===null?Boolean(visual):Boolean(video);if(wantsVideo&&!visual)throw new MusicError('VIDEO_REQUIRED','Reply /vidc to an actual video, or search for a permitted video.');
  const id=createHash('sha256').update(`${api.me?.id}:${file.file_unique_id||file.file_id}`).digest('hex');
  return this.library.locks.run('downloads',async()=>{
   if(this.library.closed)throw new MusicError('SHUTTING_DOWN','Music is shutting down.');
   if(this.items.get(id)?.[wantsVideo?'video':'audio']&&this.library.active.has(this.items.get(id)[wantsVideo?'video':'audio'].key))return this.acquire({providerId:id},{video:wantsVideo});
   if(this.items.size>=200&&!this.items.has(id)){const evict=[...this.items].find(([,r])=>Object.values(r).every(x=>!this.library.refs.get(x.key)));if(!evict)throw new MusicError('UPLOAD_LIMIT','Shared-media storage is busy. Clear an unused queue first.');this.items.delete(evict[0]);}
   await this.library.cleanup();await mkdir(this.library.root,{recursive:true,mode:0o700});
   let used=0;for(const name of await readdir(this.library.root))used+=(await stat(join(this.library.root,name))).size;
   if(used+this.library.maxBytes*3>this.library.quotaBytes)throw new MusicError('CACHE_FULL','Music storage is busy. Try again after queued tracks finish.');
   const prefix=join(this.library.root,`.partial-${randomUUID()}`),source=prefix+'.source',written=[];
   try{
    const meta=await api.getFile(file.file_id),path=meta.file_path;
     if(api.isLocalServer&&String(path||'').startsWith('/')){
      if(meta.file_size>max)throw new MusicError('TELEGRAM_FILE','Telegram could not provide a safe file within the download limit.');
      const bytes=await api.readFileBytes(path,{maxBytes:max});const out=await open(source,'wx',0o600);try{await out.write(bytes);}finally{await out.close();}
     }else{
     if(!path||!/^[-A-Za-z0-9_/.]+$/.test(path)||path.split('/').some(x=>!x||x==='..')||meta.file_size>max)throw new MusicError('TELEGRAM_FILE','Telegram could not provide a safe file within the download limit.');
     const response=await fetch(`${api.apiRoot||'https://api.telegram.org'}/file/bot${api.token}/${path}`,{signal:AbortSignal.timeout(60000),redirect:'error'});
     if(!response.ok||Number(response.headers.get('content-length'))>max)throw new MusicError('TELEGRAM_FILE','Telegram could not deliver this file within the size limit.');
     const out=await open(source,'wx',0o600);let bytes=0;
     try{for await(const chunk of response.body){bytes+=chunk.length;if(bytes>max){await response.body.cancel?.().catch(()=>{});throw new MusicError('FILE_TOO_LARGE','Telegram media exceeded the size limit.');}await out.write(chunk);}}finally{await out.close();}
     }
    const checked=JSON.parse((await this.library.runner('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_type','-of','json',source],{timeout:15000})).stdout),duration=Number(checked.format?.duration);
    if(!Number.isFinite(duration)||duration<=0||duration>7200||!checked.streams?.some(s=>s.codec_type==='audio')||(wantsVideo&&!checked.streams.some(s=>s.codec_type==='video')))throw new MusicError('INVALID_MEDIA','Media must have playable audio, a known duration up to two hours, and video when requested.');
    const title=String(file.title||file.file_name||message.caption||'Shared recording').replace(/\.(mp3|mp4|ogg|m4a|wav|webm)$/i,'').slice(0,160),artist=String(file.performer||message.from?.first_name||'Shared in Telegram').slice(0,100);
    const records=this.items.get(id)||{};
    for(const isVideo of [false,...(wantsVideo?[true]:[])]){
     if(records[isVideo?'video':'audio']&&this.library.active.has(records[isVideo?'video':'audio'].key))continue;
     const key=createHash('sha256').update(`telegram:${id}:${isVideo}`).digest('hex'),ext=isVideo?'mp4':'mp3',tmp=prefix+'.'+ext,target=join(this.library.root,key+'.'+ext);
     const args=['-nostdin','-hide_banner','-loglevel','error','-y','-i',source];
     if(isVideo)args.push('-map','0:v:0','-map','0:a:0','-vf','scale=-2:360,fps=24','-c:v','libx264','-preset','veryfast','-crf','25','-c:a','aac','-b:a','160k','-movflags','+faststart');
     else args.push('-map','0:a:0','-vn','-c:a','libmp3lame','-q:a','2');
     args.push('-ar','48000','-ac','2','-fs',String(this.library.maxBytes),tmp);await this.library.runner(this.library.ffmpeg,args,{timeout:180000,maxBuffer:1024*1024});
     const verified=JSON.parse((await this.library.runner('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_type','-of','json',tmp],{timeout:15000})).stdout);
     if(!verified.streams?.some(s=>s.codec_type==='audio')||(isVideo&&!verified.streams.some(s=>s.codec_type==='video'))||Number(verified.format?.duration)<duration-1||(await stat(tmp)).size>=this.library.maxBytes)throw new MusicError('INVALID_MEDIA','The converted recording was incomplete.');
     await rename(tmp,target);written.push(target);
     const track=normalizeTrack({providerId:id,title,artist,durationSeconds:duration,filePath:target,mediaType:isVideo?'video':'audio',availability:'resolved',capabilities:{stream:true,download:true,seek:true,video:isVideo}},'telegram');
     records[isVideo?'video':'audio']={key,filePath:target,track};
    }
    this.items.set(id,records);for(const record of Object.values(records))this.library.active.set(record.key,record);
    return this.acquire({providerId:id},{video:wantsVideo});
   }catch(error){for(const path of written)await unlink(path).catch(()=>{});if(error instanceof MusicError)throw error;throw new MusicError('TELEGRAM_MEDIA_FAILED','The replied media could not be downloaded or decoded. The queue was not changed.');}
   finally{for(const name of await readdir(this.library.root))if(name.startsWith(prefix.split('/').at(-1)))await unlink(join(this.library.root,name)).catch(()=>{});}
  });
 }
 async acquire(track,{video=false}={}){
  const record=this.items.get(track.providerId)?.[video?'video':'audio'];
  if(!record||!this.library.active.has(record.key))throw new MusicError('SHARED_MEDIA_EXPIRED','That shared recording has expired. Reply /stream to the original media again.');
  this.library.refs.set(record.key,(this.library.refs.get(record.key)||0)+1);let released=false;
  return {...record,release:()=>{if(!released){released=true;this.library.refs.set(record.key,Math.max(0,(this.library.refs.get(record.key)||1)-1));}}};
 }
}
