import {randomBytes} from 'node:crypto';
import {MusicError,KeyedLock} from './model.js';
export function channelReference(value,message={}) {
  const forwarded=message.forward_origin?.type==='channel'?message.forward_origin.chat:message.forward_from_chat;
  if(forwarded?.type==='channel'&&Number.isSafeInteger(forwarded.id))return forwarded.id;
  let target=String(value||'').trim();
  const link=target.match(/^https:\/\/(?:www\.)?t\.me\/(?:s\/)?([A-Za-z][\w]{3,31})(?:\/\d+)?\/?$/i);
  const privatePost=target.match(/^https:\/\/t\.me\/c\/([1-9]\d{3,13})(?:\/\d+)?\/?$/i);
  if(link)target='@'+link[1];if(privatePost)target='-100'+privatePost[1];
  if(/^@[A-Za-z][\w]{3,31}$/.test(target))return target;
  if(/^-[1-9]\d{3,15}$/.test(target)&&Number.isSafeInteger(Number(target)))return Number(target);
  throw new MusicError('INVALID_DESTINATION','Send a channel @name/link, a negative channel ID, or forward an original channel post. Hidden forward origins and invitation-only links cannot prove a channel’s identity; use its ID instead.');
}
export class SavedChannels {
 constructor({service}){this.service=service;this.db=service.app.db;this.sessions=new Map();this.lock=new KeyedLock();}
 key(ctx){if(Number(ctx.chatId)<=0||Number(ctx.chatId)!==Number(ctx.tgId))throw new MusicError('CHANNEL_DM_REQUIRED','Open Channel Play in your own bot DM.');return `music.channels.${this.service.botKey(ctx)}.${ctx.tgId}`;}
 list(ctx){return this.db.getSetting(this.key(ctx),[]);}
 async save(ctx,id){return this.lock.run(this.key(ctx),async()=>{const chat=await ctx.api.getChat(id);if(chat.type!=='channel')throw new MusicError('CHANNEL_REQUIRED','Channel Play saves channels, not groups.');await this.service.authorize(ctx,true,chat.id);const list=this.list(ctx).filter(c=>c.id!==chat.id);if(list.length>=50)throw new MusicError('CHANNEL_LIMIT','Save up to 50 channels; remove an unused entry first.');list.push({id:chat.id,title:String(chat.title||'Channel').slice(0,160),username:chat.username||null,verifiedAt:Date.now()});this.db.setSetting(this.key(ctx),list);return chat;});}
 async remove(ctx,id){return this.lock.run(this.key(ctx),async()=>{this.db.setSetting(this.key(ctx),this.list(ctx).filter(c=>c.id!==id));});}
 create(ctx){this.key(ctx);for(const [id,s]of this.sessions)if(s.expires<Date.now())this.sessions.delete(id);if(this.sessions.size>=300)this.sessions.delete(this.sessions.keys().next().value);const s={id:randomBytes(6).toString('base64url'),user:String(ctx.tgId),bot:this.service.botKey(ctx),chat:Number(ctx.chatId),messageId:null,revision:0,page:0,expires:Date.now()+600000};this.sessions.set(s.id,s);return s;}
 resolve(ctx,token,revision){const s=this.sessions.get(token);if(!s||s.expires<Date.now()||s.user!==String(ctx.tgId)||s.bot!==this.service.botKey(ctx)||s.chat!==Number(ctx.chatId)||s.messageId!==ctx.messageId||s.revision!==Number(revision))throw new MusicError('CHANNEL_MENU_EXPIRED','Open Channel Play again and use your own latest menu.');return s;}
}
