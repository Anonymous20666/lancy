import { KeyedLock, MusicError } from './model.js';

/** Telegram membership/call changes only follow a fresh authorized setup request. */
export class CallSetup {
  constructor({service}) { this.service=service;this.app=service.app;this.lock=new KeyedLock(); }
  managed() { return this.app.db.getSetting('music.managedMemberships',{}); }
  remember(id,alias,isChannel) {
    const entries=this.managed();entries[id]={alias,isChannel,approvedAt:Date.now()};this.app.db.setSetting('music.managedMemberships',entries);
    const s=this.app.musicQueueManager.getSession(id);s.prepared=true;s.accountAlias=alias;s.isChannel=isChannel;this.app.musicQueueManager.armPreparedIdle(id);
  }
  forget(id) { const entries=this.managed();delete entries[id];this.app.db.setSetting('music.managedMemberships',entries); }
  async prepare(ctx,id=this.service.destination(ctx)) {
    return this.lock.run(Number(id),async()=>{
      const state=this.app.musicQueueManager.getSession(id),generation=state.stopGeneration||0;
      const current=()=>{if((state.stopGeneration||0)!==generation)throw new MusicError('SETUP_CANCELLED','Assistant setup was cancelled by Stop.');};
      const checked=async operation=>{const result=await operation;current();return result;};
      try{await checked(this.service.authorize(ctx,true,id));}catch(error){if(error.code==='BOT_ADMIN_REQUIRED')throw new MusicError('BOT_SETUP_PERMISSIONS','Make Lancy a channel administrator with Invite users, Add new administrators and Manage video chats / live streams. Then retry setup.');throw error;}
      const chat=await checked(ctx.api.getChat(id)),botId=ctx.api.me?.id || (await ctx.api.getMe?.().catch(()=>null))?.id;
      const bot=botId?await ctx.api.getChatMember(id,botId).catch(()=>null):null;
      const missing=[];
      if(!bot||!['administrator','creator'].includes(bot.status))missing.push('administrator');
      if(!bot||!['administrator','creator'].includes(bot.status))for(const label of ['Invite users','Add new administrators','Manage video chats / live streams'])missing.push(label);
      if(missing.length)throw new MusicError('BOT_SETUP_PERMISSIONS',`Make Lancy an administrator in ${chat.title||'this chat'} and grant: ${missing.join(', ')}. Then retry /vc (audio) or /vidc (video). Pin permission is optional.`);
      await checked(this.service.accounts.sync());
      const voice=this.app.voiceClient;
      let existingOnly=false;
      if(typeof voice.accounts==='function'){
        let pool=await checked(voice.accounts(id));
        if(!pool.accounts.some(a=>a.enabled&&['available','busy'].includes(a.status))){
          if(chat.type!=='channel'&&this.app.settings?.get('music.allowExistingGroupMembers')===true&&typeof voice.existingGroupAccounts==='function'){
            const candidates=await checked(voice.existingGroupAccounts(id));existingOnly=true;
            if(!candidates.accounts?.length)throw new MusicError('EXISTING_ASSISTANT_REQUIRED',`No ready owner-registered assistant is already a member of this group (${id}). Add the registered assistant yourself, or ask the owner to approve this exact group. Lancy will not join an unapproved group.`);
            pool=await checked(voice.accounts(id));
          }
          if(!pool.accounts.some(a=>a.enabled&&['available','busy'].includes(a.status)))throw new MusicError('ACCOUNT_UNAVAILABLE',`No enabled playback account is approved for ${id}. Group administration is separate from account approval; the owner can use /accounts allow ACCOUNT_ALIAS ${id}.`);
        }
      }
      let identity,link,managed=false;
      try {
        identity=await voice.setup(id,'identity',{account_alias:this.app.musicQueueManager.getSession(id).preferredAccount||undefined});current();
        let member=await checked(ctx.api.getChatMember(id,identity.user_id).catch(()=>null));
        if(member?.status==='kicked')throw new MusicError('ASSISTANT_BANNED','Unban the owner-approved assistant before trying setup again.');
        if(!member||['left','restricted'].includes(member.status)&&!member.is_member){
          if(existingOnly)throw new MusicError('EXISTING_ASSISTANT_REQUIRED','The assistant is no longer in this group. Add it yourself or ask the owner to approve rejoining.');
          if(bot.status!=='creator'&&!bot.can_invite_users)throw new MusicError('BOT_SETUP_PERMISSIONS','The assistant is absent. Grant Lancy Invite users, or add the registered assistant yourself.');
          link=await ctx.api.call('createChatInviteLink',{chat_id:id,name:'Lancy playback setup'});
          current();if(!link?.invite_link)throw new MusicError('INVITE_FAILED','Telegram did not return an assistant invitation.');
          this.remember(id,identity.account_alias,chat.type==='channel');managed=true;
          try {
            await checked(voice.setup(id,'join',{invite_link:link.invite_link}));
          } catch (joinErr) {
            const after=await ctx.api.getChatMember(id,identity.user_id).catch(()=>null);
            if(!after||!['member','administrator','creator','restricted'].includes(after.status)||(after.status==='restricted'&&!after.is_member))throw joinErr;
          }
          this.remember(id,identity.account_alias,chat.type==='channel');managed=true;
          member=await checked(ctx.api.getChatMember(id,identity.user_id));
          if(!member||!['member','administrator','creator','restricted'].includes(member.status)||(member.status==='restricted'&&!member.is_member)){
            await new Promise(r=>setTimeout(r,300));
            member=await checked(ctx.api.getChatMember(id,identity.user_id));
          }
        }
        if(!member||!['member','administrator','creator','restricted'].includes(member.status)||(member.status==='restricted'&&!member.is_member))throw new MusicError('ASSISTANT_MEMBERSHIP','Assistant membership could not be verified.');
        await checked(voice.setup(id,'manage'));this.remember(id,identity.account_alias,chat.type==='channel');managed=true;
        const hasCallRights=m=>Boolean(m?.can_manage_video_chats||m?.can_manage_voice_chats);
        if(member.status!=='creator'&&!(member.status==='administrator'&&hasCallRights(member))){
          if(bot.status!=='creator'&&(!bot.can_promote_members||!hasCallRights(bot)))throw new MusicError('BOT_SETUP_PERMISSIONS','The assistant needs call rights. Grant Lancy Add new administrators and Manage video chats, or have an administrator grant the assistant Manage video chats directly.');
          if(member.status==='administrator'&&member.can_be_edited===false)throw new MusicError('ASSISTANT_ADMIN_LOCKED','An administrator who can edit the assistant must grant it Manage video chats. Lancy cannot override another administrator’s role.');
          const ok=await ctx.api.call('promoteChatMember',{chat_id:id,user_id:identity.user_id,can_manage_chat:true,can_manage_video_chats:true});
          current();if(ok!==true)throw new MusicError('PROMOTION_FAILED','Telegram did not confirm the assistant’s call-management permission.');
          member=await checked(ctx.api.getChatMember(id,identity.user_id));
          if(!['administrator','creator'].includes(member?.status)||(member.status!=='creator'&&!hasCallRights(member))){
            await new Promise(r=>setTimeout(r,300));
            member=await checked(ctx.api.getChatMember(id,identity.user_id));
          }
          if(!['administrator','creator'].includes(member.status)||member.status!=='creator'&&!hasCallRights(member))throw new MusicError('PROMOTION_FAILED','The assistant’s call-management permission could not be verified.');
        }
        current();const result=await checked(voice.setup(id,'start',{create:true}));
        const s=this.app.musicQueueManager.getSession(id);s.destinationTitle=chat.title||String(id);s.isChannel=chat.type==='channel';s.lastError=null;s.lastNotice=result.created?'Assistant ready · a new call/broadcast was created. Add a recording to start playback.':'Assistant ready · reusing the existing call. Add a recording or use the current player.';
        return {...result,destination:id};
      }catch(error){
        if(identity&&!managed)await voice.setup(id,'release').catch(()=>{});
        throw error;
      }finally{
        if(link?.invite_link)await ctx.api.call('revokeChatInviteLink',{chat_id:id,invite_link:link.invite_link}).catch(()=>{});
      }
    });
  }
}
