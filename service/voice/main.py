"""Lancy protocol-2 authenticated loopback bridge; queue ownership remains in Node.
No bot-token call fallback, no interactive credentials over HTTP, no persistent secrets.
"""
import asyncio
import hmac
import logging
import os
import signal
import secrets
import re
import time
from pathlib import Path
from aiohttp import web

log = logging.getLogger('lancy.voice')

MESSAGES = {
    'SESSION_NOT_READY': 'No authorized player account is ready. Ask the owner to register one.',
    'ACCOUNT_IN_USE': 'Stop this account’s active calls and prepared destinations before changing or removing it.',
    'ACCOUNT_UNAVAILABLE': 'The selected account is disabled, unauthorized, or not approved for this destination.',
    'NO_ACTIVE_CALL': 'No active call. A verified administrator can run /vc for audio or /vidc for video to prepare the assistant and create one.',
    'JOIN_PENDING': 'Telegram requires approval before the assistant can join. Approve its join request, then retry /vc.',
    'MEMBERSHIP_LEAVE_FAILED': 'The call stopped, but assistant group departure was not confirmed. Cleanup will retry.',
    'PERMISSION_DENIED': 'The playback account must be a member and allowed to speak in this call. Channel streams may require channel administrator/speaker rights.',
    'PUBLISHER_UNVERIFIED': 'Telegram publisher verification failed. The queue is retained. Check speaking permission and retry playback.',
    'MEDIA_INVALID': 'The media is outside the managed cache or lacks required streams.',
    'RATE_LIMITED': 'Telegram rate-limited call operations for this chat. Retrying shortly.',
    'CALL_FAILED': 'Telegram could not complete the call operation. Check account health, membership and call permissions.',
    'INVALID_REQUEST': 'Invalid voice-engine request.',
    'ACCOUNT_LIMIT': 'The playback pool has reached its eight-account limit.',
}

class VoiceFailure(Exception):
    def __init__(self, code, publisher_state=None): self.code = code; self.publisher_state = publisher_state

def classify(error):
    if isinstance(error, VoiceFailure): return error.code
    name = type(error).__name__
    msg = str(getattr(error, 'MESSAGE', '') or getattr(error, 'message', '') or error).upper()
    if name == 'FloodWait': return 'RATE_LIMITED'
    if name in {'TimeoutError', 'TimedOutAnswer', 'ConnectionNotFound', 'NoActiveGroupCall', 'GroupCallNotFound', 'NotInCallError', 'CallNotFound', 'CallAlreadyEnded', 'GroupCallInvalid', 'CallNotConnected', 'GroupCallDiscarded', 'CallDiscarded', 'NoActiveCall'} or any(x in msg for x in {'GROUPCALL_ALREADY_DISCARDED', 'GROUPCALL_INVALID', 'GROUPCALL_NOT_FOUND', 'NO_ACTIVE_GROUP_CALL', 'NO ACTIVE CALL', 'CONNECTION NOT FOUND', 'CONNECTIONNOTFOUND', 'TIMED OUT', 'TIMEOUT'}):
        return 'NO_ACTIVE_CALL'
    if name in {'ChatAdminRequired', 'UserNotParticipant', 'ChannelPrivate', 'PeerIdInvalid', 'Forbidden', 'ChatWriteForbidden', 'ChatAdminInviteRequired'} or any(x in msg for x in {'CHAT_ADMIN_REQUIRED', 'USER_NOT_PARTICIPANT', 'FORBIDDEN', 'CHANNEL_PRIVATE', 'PEER_ID_INVALID'}):
        return 'PERMISSION_DENIED'
    if name in {'AuthKeyUnregistered', 'SessionRevoked', 'UserDeactivated', 'Unauthorized', 'BotMethodInvalid'} or any(x in msg for x in {'AUTH_KEY_UNREGISTERED', 'SESSION_REVOKED', 'USER_DEACTIVATED'}):
        return 'SESSION_NOT_READY'
    return 'CALL_FAILED'

def clear_engine_cache(engine, chat):
    try:
        if hasattr(engine, '_clear_cache'): engine._clear_cache(chat)
    except Exception: pass
    try:
        bind = getattr(getattr(engine, '_app', None), '_bind_client', None)
        if bind and hasattr(bind, '_cache'): bind._cache.drop_cache(chat)
    except Exception: pass

class Bridge:
    def __init__(self, root, factory=None):
        self.root = Path(root).resolve()
        self.factory = factory
        self.accounts = {}
        self.calls = {}
        self.prepared = {}
        self.last_failures = {}
        self.events = asyncio.Queue(maxsize=100)
        self.lock = asyncio.Lock()  # only lease assignment/configuration, never network I/O
        self.chat_locks = {}
        self.closing = False

    def chat_lock(self, chat): return self.chat_locks.setdefault(chat, asyncio.Lock())

    async def register(self, data):
        import re
        alias = str(data.get('alias', ''))
        if not re.fullmatch(r'[a-z0-9_-]{1,24}', alias): raise VoiceFailure('INVALID_REQUEST')
        async with self.lock:
            if alias in self.accounts: raise VoiceFailure('ACCOUNT_UNAVAILABLE')
            if len(self.accounts) >= 8: raise VoiceFailure('ACCOUNT_LIMIT')
            self.accounts[alias] = {'alias': alias, 'enabled': bool(data.get('enabled', True)), 'allowed': list(data.get('allowed', [])), 'status': 'connecting', 'leases': set(), 'client': None, 'engine': None, 'managed': set(int(x) for x in data.get('managed_destinations', [])), 'denied': list(data.get('denied', [])), 'group_grants': set(), 'member_fallback_enabled': bool(data.get('allow_existing_member_groups', False))}
        account = self.accounts[alias]
        try:
            if self.factory:
                client, engine, uid = await self.factory(alias, data['session'])
            else:
                from pyrogram import Client
                from pytgcalls import PyTgCalls
                from pytgcalls.types import StreamEnded, Device
                client = Client(f'lancy_{alias}', api_id=int(os.environ['TELEGRAM_API_ID']), api_hash=os.environ['TELEGRAM_API_HASH'], session_string=data['session'], in_memory=True)
                await asyncio.wait_for(client.start(), 30)
                me = await client.get_me()
                if me.is_bot:
                    await client.stop()
                    raise VoiceFailure('SESSION_NOT_READY')
                uid = me.id
                engine = PyTgCalls(client)
                @engine.on_update()
                async def update(_, event):
                    if isinstance(event, StreamEnded) and event.device == Device.MICROPHONE and event.stream_type == StreamEnded.Type.AUDIO:
                        # Native events have no source identity. Do not attach a new track's ID
                        # to a late old event. Corroborate completion against native media time.
                        async with self.chat_lock(event.chat_id):
                            call = self.calls.get(event.chat_id)
                            if not call or call['alias'] != alias or call['status'] != 'playing': return
                            try:
                                elapsed = await engine.time(event.chat_id)
                                remaining = call['duration'] - call['offset'] if call['duration'] else None
                                if remaining is not None and elapsed >= max(0, remaining - min(1.0, remaining / 2)):
                                    call['status'] = 'ended'
                                    if self.events.full(): self.events.get_nowait()
                                    self.events.put_nowait({'chat_id': event.chat_id, 'playback_id': call['playback_id'], 'status': 'ended'})
                            except Exception:
                                call['clock_errors'] += 1
                await asyncio.wait_for(engine.start(), 30)
            if any(a.get('uid') == uid for a in self.accounts.values() if a is not account):
                await client.stop()
                raise VoiceFailure('ACCOUNT_UNAVAILABLE')
            account.update(client=client, engine=engine, uid=uid, status='available')
        except Exception as error:
            if 'client' in locals() and client:
                try: await client.stop()
                except Exception: pass
            account['status'] = 'authentication_required'
            log.warning('Account startup failed alias=%s kind=%s', alias, type(error).__name__)
            raise VoiceFailure(classify(error)) from None
        return {'ok': True, 'alias': alias}

    async def refresh_health(self):
        for account in list(self.accounts.values()):
            if not account['enabled'] or bool(account['leases']) or not account['client']: continue
            try:
                me = await asyncio.wait_for(account['client'].get_me(), 8)
                account['status'] = 'authentication_required' if me.is_bot else 'available'
            except Exception:
                account['status'] = 'authentication_required'

    def public_accounts(self, chat=None):
        result = []
        for a in self.accounts.values():
            if chat is not None and not self.destination_authorized(a, chat): continue
            destinations = sorted(c for c, call in self.calls.items() if call['alias'] == a['alias'])
            result.append({'alias': a['alias'], 'enabled': a['enabled'],
                           'status': 'disabled' if not a['enabled'] else a['status'],
                           'active_calls': len(destinations) if chat is None else int(chat in destinations),
                           'destinations': destinations if chat is None else None})
        return result

    async def configure(self, data):
        alias = str(data.get('alias', ''))
        async with self.lock:
            a = self.accounts.get(alias)
            if not a: raise VoiceFailure('ACCOUNT_UNAVAILABLE')
            if (data.get('remove') or data.get('enabled') is False) and (a['leases'] or any(p['alias'] == alias for p in self.prepared.values())):
                raise VoiceFailure('ACCOUNT_IN_USE')
            if 'allowed' in data: a['allowed'] = list(data['allowed'])
            if 'denied' in data: a['denied'] = list(data['denied'])
            if 'enabled' in data: a['enabled'] = bool(data['enabled'])
            if data.get('remove'): self.accounts.pop(alias)
        if data.get('remove') and a['client']: await a['client'].stop()
        return {'ok': True}

    def owner_allowed(self, a, chat):
        return str(chat) not in a.get('denied', []) and (str(chat) in a['allowed'] or '*' in a['allowed'])

    def destination_authorized(self, a, chat):
        return str(chat) not in a.get('denied', []) and (self.owner_allowed(a, chat) or chat in a.get('group_grants', set()))

    async def verify_existing_group_member(self, a, chat):
        # Self-only read operations. Never join, invite, promote or create here.
        await self.resolve_destination(a['client'], chat)
        try:
            info = await asyncio.wait_for(a['client'].get_chat(chat), 8)
            kind = getattr(info.type, 'value', info.type)
            if kind not in {'group', 'supergroup'}: raise VoiceFailure('PERMISSION_DENIED')
        except Exception as error:
            if self.factory or type(error).__name__ != 'AttributeError': raise
        member = await asyncio.wait_for(a['client'].get_chat_member(chat, a['uid']), 8)
        status = getattr(member.status, 'value', member.status)
        if status not in {'owner', 'creator', 'administrator', 'member'} and not (status == 'restricted' and getattr(member, 'is_member', False)):
            raise VoiceFailure('PERMISSION_DENIED')

    async def existing_group_accounts(self, data):
        chat = int(data['chat_id'])
        if chat >= 0 or self.closing: raise VoiceFailure('INVALID_REQUEST')
        limit = asyncio.Semaphore(4)
        async def candidate(a):
            if not a.get('member_fallback_enabled') or not a['enabled'] or a['status'] != 'available' or str(chat) in a.get('denied', []): return None
            async with limit:
                try: await asyncio.wait_for(self.verify_existing_group_member(a, chat), 25)
                except Exception: return None
            async with self.lock:
                if self.accounts.get(a['alias']) is not a or not a['enabled']: return None
                a['group_grants'].add(chat)
            return {'alias': a['alias'], 'user_id': a['uid']}
        results = await asyncio.gather(*(candidate(a) for a in list(self.accounts.values())))
        return {'ok': True, 'accounts': [a for a in results if a]}

    async def lease(self, chat, alias=None):
        async with self.lock:
            existing = self.calls.get(chat) or self.prepared.get(chat)
            if existing:
                account = self.accounts.get(existing['alias'])
                if not account or (alias and alias != account['alias']): raise VoiceFailure('ACCOUNT_UNAVAILABLE')
            else:
                candidates = [a for a in self.accounts.values() if a['enabled'] and a['status'] == 'available' and self.destination_authorized(a, chat) and (not alias or a['alias'] == alias)]
                if not candidates: raise VoiceFailure('ACCOUNT_UNAVAILABLE' if alias else 'SESSION_NOT_READY')
                account = min(candidates, key=lambda a: len(a['leases']))
            if not account['enabled'] or account['status'] != 'available' or not self.destination_authorized(account, chat): raise VoiceFailure('ACCOUNT_UNAVAILABLE')
        if not self.owner_allowed(account, chat):
            try: await asyncio.wait_for(self.verify_existing_group_member(account, chat), 25)
            except Exception:
                account['group_grants'].discard(chat)
                raise VoiceFailure('PERMISSION_DENIED') from None
        async with self.lock:
            if self.accounts.get(account['alias']) is not account or not account['enabled'] or not self.destination_authorized(account, chat): raise VoiceFailure('ACCOUNT_UNAVAILABLE')
            account['leases'].add(chat)
            return account

    def remember_failure(self, chat, error):
        if len(self.last_failures) >= 1000: self.last_failures.pop(next(iter(self.last_failures)))
        self.last_failures[chat] = {'code': classify(error), 'kind': type(error).__name__, 'at': int(time.time())}

    def release_destination(self, a, chat):
        # Keep an uncertain/active call reserved; never touch a sibling chat.
        if chat not in self.calls:
            a['leases'].discard(chat)

    async def native_call(self, client, chat):
        from pyrogram import raw
        peer = await asyncio.wait_for(client.resolve_peer(chat), 10)
        if isinstance(peer, raw.types.InputPeerChannel):
            request = raw.functions.channels.GetFullChannel(channel=raw.types.InputChannel(channel_id=peer.channel_id, access_hash=peer.access_hash))
        elif isinstance(peer, raw.types.InputPeerChat):
            request = raw.functions.messages.GetFullChat(chat_id=peer.chat_id)
        else: raise VoiceFailure('PERMISSION_DENIED')
        full = await asyncio.wait_for(client.invoke(request, sleep_threshold=0), 10)
        return peer, getattr(full.full_chat, 'call', None)

    async def setup(self, data):
        chat = int(data['chat_id']); stage = data.get('stage')
        if chat >= 0 or self.closing: raise VoiceFailure('INVALID_REQUEST')
        async with self.chat_lock(chat):
            if stage == 'release':
                if chat not in self.calls:
                    p = self.prepared.pop(chat, None)
                    if p:
                        a = self.accounts[p['alias']]
                        self.release_destination(a, chat)
                return {'ok': True}
            was_prepared = chat in self.prepared or chat in self.calls
            a = await self.lease(chat, data.get('account_alias'))
            self.prepared.setdefault(chat, {'alias': a['alias']})
            if stage == 'identity':
                try:
                    me = await asyncio.wait_for(a['client'].get_me(), 10)
                    if me.is_bot: raise VoiceFailure('SESSION_NOT_READY')
                except Exception:
                    if not was_prepared:
                        self.prepared.pop(chat, None)
                        self.release_destination(a, chat)
                    raise
                return {'ok': True, 'account_alias': a['alias'], 'user_id': me.id}
            if stage == 'manage':
                if not self.factory or getattr(self, 'auto_create_call_in_tests', False):
                    await self.resolve_destination(a['client'], chat)
                a['managed'].add(chat)
                return {'ok': True, 'account_alias': a['alias']}
            if stage == 'join':
                if not self.owner_allowed(a, chat): raise VoiceFailure('PERMISSION_DENIED')
                invite = str(data.get('invite_link', ''))
                if not re.fullmatch(r'https://t\.me/(?:\+|joinchat/)[A-Za-z0-9_-]{8,200}', invite): raise VoiceFailure('INVALID_REQUEST')
                try:
                    joined = await asyncio.wait_for(a['client'].join_chat(invite), 25)
                    if joined.id != chat: raise VoiceFailure('PERMISSION_DENIED')
                except Exception as error:
                    if type(error).__name__ == 'InviteRequestSent': raise VoiceFailure('JOIN_PENDING') from None
                    if not self.factory and type(error).__name__ in {'AttributeError', 'InviteHashExpired', 'InviteHashInvalid'}:
                        await self.resolve_destination(a['client'], chat)
                    elif type(error).__name__ != 'UserAlreadyParticipant': raise
                if not self.factory or getattr(self, 'auto_create_call_in_tests', False):
                    await self.resolve_destination(a['client'], chat)
                a['managed'].add(chat)
                return {'ok': True, 'account_alias': a['alias']}
            if stage != 'start' or data.get('create') is not True: raise VoiceFailure('INVALID_REQUEST')
            await self.resolve_destination(a['client'], chat)
            peer, call = await self.native_call(a['client'], chat)
            created = False
            if call is None:
                from pyrogram import raw
                await asyncio.wait_for(a['client'].invoke(raw.functions.phone.CreateGroupCall(peer=peer, random_id=secrets.randbits(31), title='Lancy music'), sleep_threshold=0), 15)
                _, call = await self.native_call(a['client'], chat)
                if call is None and not self.factory:
                    for _ in range(3):
                        await asyncio.sleep(0.3)
                        _, call = await self.native_call(a['client'], chat)
                        if call is not None: break
                if call is None: raise VoiceFailure('NO_ACTIVE_CALL')
                created = True
            a['managed'].add(chat)
            # Setup is not an active media transport. Retain per-chat membership
            # and routing metadata without reserving a native call.
            self.release_destination(a, chat)
            return {'ok': True, 'account_alias': a['alias'], 'call_ready': True, 'created': created}

    async def leave_membership(self, a, chat):
        if chat not in a.get('managed', set()): return
        if not self.factory and os.environ.get('MUSIC_KEEP_GROUP_MEMBERSHIP', '1') == '1':
            a['managed'].discard(chat)
            return
        try: await asyncio.wait_for(a['client'].leave_chat(chat, delete=False), 15)
        except Exception as error:
            if type(error).__name__ not in {'UserNotParticipant', 'UserNotParticipantError'}: raise VoiceFailure('MEMBERSHIP_LEAVE_FAILED') from None
        a['managed'].discard(chat)

    def source(self, value):
        try:
            path = Path(value).resolve(strict=True)
            if not path.is_file() or not path.is_relative_to(self.root) or path.suffix not in {'.mp3', '.mp4'}: raise ValueError()
            return str(path)
        except (ValueError, TypeError, OSError): raise VoiceFailure('MEDIA_INVALID') from None

    async def publisher_step(self, operation, stage, timeout=8):
        try: return await asyncio.wait_for(operation, timeout)
        except VoiceFailure: raise
        except Exception as error:
            detail={'stage':stage,'kind':type(error).__name__}
            if type(error).__name__=='FloodWait': detail['retry_after']=int(getattr(error,'value',0))
            raise VoiceFailure('PUBLISHER_UNVERIFIED',detail) from None

    async def native_publisher(self, a, chat, input_call=None):
        """Fresh, self-only Telegram publisher state; never enumerate listener identities."""
        from pyrogram import raw
        client = a['client']
        if input_call is None:
            peer = await self.publisher_step(client.resolve_peer(chat), 'resolve_peer')
            if isinstance(peer, raw.types.InputPeerChannel):
                request = raw.functions.channels.GetFullChannel(channel=raw.types.InputChannel(channel_id=peer.channel_id, access_hash=peer.access_hash))
            elif isinstance(peer, raw.types.InputPeerChat):
                request = raw.functions.messages.GetFullChat(chat_id=peer.chat_id)
            else:
                raise VoiceFailure('PERMISSION_DENIED')
            full = await self.publisher_step(client.invoke(request, sleep_threshold=0), 'call_state')
            input_call = getattr(full.full_chat, 'call', None)
            if input_call is None: raise VoiceFailure('NO_ACTIVE_CALL')
        result = await self.publisher_step(client.invoke(raw.functions.phone.GetGroupParticipants(call=input_call, ids=[raw.types.InputPeerSelf()], sources=[], offset='', limit=1), sleep_threshold=0), 'self_participant')
        participant = next((p for p in result.participants if getattr(p, 'is_self', False) or getattr(p.peer, 'user_id', None) == a['uid']), None)
        return input_call, participant

    async def ensure_publisher(self, a, chat, call):
        # Join/play acceptance alone can leave NTgCalls' microphone muted. Only
        # explicitly requested start/resume/seek/recovery may self-unmute. Never
        # promote an account or override a moderator's cannot-self-unmute state.
        if call.get('is_channel'):
            binding = getattr(a['engine'], '_binding', None)
            state = await self.publisher_step(binding.get_state(chat), 'local_state', 3) if binding else None
            if state is None or getattr(state, 'muted', True):
                await self.publisher_step(a['engine'].unmute(chat), 'local_unmute')
            call.update(native_call=call.get('native_call'), publisher_verified=True, publisher_muted=False, publisher_check_after=time.monotonic() + 3600)
            return
        from pyrogram import raw
        input_call, participant = await self.native_publisher(a, chat, call.get('native_call'))
        if participant is None or getattr(participant, 'left', False): raise VoiceFailure('PERMISSION_DENIED', {'stage':'self_missing'})
        if getattr(participant, 'muted', False) and not getattr(participant, 'can_self_unmute', False): raise VoiceFailure('PERMISSION_DENIED', {'stage':'self_locked','muted':True,'can_self_unmute':False,'min':bool(getattr(participant,'min',False))})
        # NTgCalls 3.0 exposes the actual capture mute bit through get_state.
        # Avoid repeating a no-op native transition on every source replacement.
        binding=getattr(a['engine'],'_binding',None)
        state=await self.publisher_step(binding.get_state(chat),'local_state',3) if binding else None
        if state is None or getattr(state,'muted',True):
            await self.publisher_step(a['engine'].unmute(chat),'local_unmute')
        if getattr(participant, 'muted', False):
            await self.publisher_step(a['client'].invoke(raw.functions.phone.EditGroupCallParticipant(call=input_call, participant=raw.types.InputPeerSelf(), muted=False), sleep_threshold=0),'self_unmute')
        for attempt in range(3):
            input_call, participant = await self.native_publisher(a, chat, input_call)
            if participant is not None and not getattr(participant, 'left', False) and not getattr(participant, 'muted', False) and getattr(participant, 'source', 0):
                call.update(native_call=input_call, publisher_verified=True, publisher_muted=False, publisher_check_after=time.monotonic()+5)
                return
            if attempt < 2: await asyncio.sleep(0.2)
        raise VoiceFailure('PERMISSION_DENIED', {'stage':'verification_failed','present':participant is not None,'muted':bool(getattr(participant,'muted',True)),'can_self_unmute':bool(getattr(participant,'can_self_unmute',False)),'source_present':bool(getattr(participant,'source',0))})

    async def stream(self, a, chat, call):
        from pytgcalls.types import MediaStream, AudioQuality, VideoQuality, GroupCallConfig
        ff = f'-ss {call["offset"]:.3f}' if call['offset'] else ''
        # Preserve 6 dB of headroom before PCM16/Opus conversion; no default EQ
        # or loudness maximization. The limiter is a safety ceiling, not a cure
        # for network loss, codec damage, or an already distorted recording.
        eq_preset = str(call.get('eq') or ('bass' if call.get('bass') else 'off')).lower()
        eq_map = {
            'bass': 'bass=g=4:f=100:w=0.5,',
            'vocal': 'highpass=f=160,equalizer=f=3000:width_type=q:w=1.2:g=3,',
            'nightcore': 'asetrate=48000*1.18,aresample=48000,atempo=1.04,',
            'vaporwave': 'asetrate=48000*0.85,aresample=48000,',
            '8d': 'apulsator=hz=0.125,',
        }
        eq_filter = eq_map.get(eq_preset, 'bass=g=3:f=100:w=0.5,' if call.get('bass') else '')
        filters = 'volume=0.5011872336,' + eq_filter + 'alimiter=limit=0.95:level=0,aresample=48000'
        ff += ' --audio ---mid -af ' + filters
        is_channel = bool(call.get('is_channel'))
        has_video = bool(call.get('video') or (is_channel and str(call.get('path', '')).endswith('.mp4')))
        video_flags = MediaStream.Flags.REQUIRED if has_video else MediaStream.Flags.IGNORE
        stream = MediaStream(call['path'], audio_parameters=AudioQuality.HIGH, video_parameters=VideoQuality.SD_360p, audio_flags=MediaStream.Flags.REQUIRED, video_flags=video_flags, ffmpeg_parameters=ff or None)
        await asyncio.wait_for(a['engine'].play(chat, stream, config=GroupCallConfig(auto_start=False)), 15)
        if call.get('status') != 'paused':
            try: await asyncio.wait_for(self.ensure_publisher(a, chat, call), 12)
            except VoiceFailure: raise
            except Exception as error: raise VoiceFailure('PUBLISHER_UNVERIFIED', {'stage':'publisher_check','kind':type(error).__name__}) from None

    async def resolve_destination(self, client, chat):
        # String sessions do not contain a peer/access-hash cache. Resolve only
        # existing dialog membership; never join/promote an account automatically.
        try:
            await asyncio.wait_for(client.get_chat(chat), 10)
            return
        except Exception as error:
            if not self.factory and type(error).__name__ == 'AttributeError':
                try:
                    await asyncio.wait_for(client.resolve_peer(chat), 5)
                    return
                except Exception:
                    pass
            if type(error).__name__ not in {'PeerIdInvalid', 'ChannelInvalid', 'ChannelPrivate', 'KeyError', 'ValueError', 'AttributeError'}: raise
        async def hydrate():
            async for dialog in client.get_dialogs(limit=500):
                if getattr(dialog, 'chat', None) and dialog.chat.id == chat:
                    try:
                        await client.get_chat(chat)
                    except Exception as e:
                        if not self.factory and type(e).__name__ == 'AttributeError': return True
                        raise
                    return True
            return False
        if not await asyncio.wait_for(hydrate(), 15):
            raise VoiceFailure('PERMISSION_DENIED')

    async def play(self, data):
        chat = int(data['chat_id'])
        if chat >= 0 or self.closing: raise VoiceFailure('INVALID_REQUEST')
        async with self.chat_lock(chat):
            path = self.source(data['stream_url'])
            a = await self.lease(chat, data.get('account_alias'))
            previous = self.calls.get(chat)
            if previous and previous['playback_id'] == data.get('playback_id'): return {'ok': True, 'account_alias': a['alias'], 'status': previous['status']}
            call = {'alias': a['alias'], 'path': path, 'video': bool(data.get('video')), 'bass': bool(data.get('bass')), 'eq': str(data.get('eq') or ('bass' if data.get('bass') else 'off')), 'is_channel': bool(data.get('is_channel')), 'duration': float(data.get('duration_seconds') or 0), 'offset': 0.0, 'playback_id': str(data['playback_id']), 'status': 'buffering', 'clock_errors': 0, 'position_seconds': None, 'last_known_position': 0.0, 'retries': 0, 'retry_after': 0.0, 'last_progress': time.monotonic()}
            if previous:
                clear_engine_cache(a['engine'], chat)
                try: await asyncio.wait_for(a['engine'].leave_call(chat), 5)
                except Exception: pass
            try:
                # get_me confirms runtime authorization; preflight never promotes or joins the group.
                me = await asyncio.wait_for(a['client'].get_me(), 10)
                if me.is_bot: raise VoiceFailure('SESSION_NOT_READY')
                if not self.factory or getattr(self, 'auto_create_call_in_tests', False):
                    await self.resolve_destination(a['client'], chat)
                    try: peer, native = await self.native_call(a['client'], chat)
                    except Exception: peer, native = None, None
                    if peer is not None and native is None:
                        from pyrogram import raw
                        try:
                            await asyncio.wait_for(a['client'].invoke(raw.functions.phone.CreateGroupCall(peer=peer, random_id=secrets.randbits(31), title='Lancy music'), sleep_threshold=5), 15)
                            for _ in range(4):
                                await asyncio.sleep(0.3)
                                _, native = await self.native_call(a['client'], chat)
                                if native is not None: break
                        except Exception as create_err:
                            if type(create_err).__name__ in {'ChatAdminRequired', 'ChannelPrivate', 'ChatWriteForbidden'}:
                                raise VoiceFailure('PERMISSION_DENIED') from None
                            if type(create_err).__name__ == 'FloodWait' and getattr(create_err, 'value', 0) <= 5:
                                await asyncio.sleep(getattr(create_err, 'value', 1))
                                _, native = await self.native_call(a['client'], chat)
                    if native is not None:
                        call['native_call'] = native
                        bind = getattr(getattr(a['engine'], '_app', None), '_bind_client', None)
                        if bind and hasattr(bind, '_cache'):
                            try:
                                bind._cache.drop_cache(chat)
                                bind._cache.set_cache(chat, native)
                            except Exception: pass
                    elif not call.get('native_call'):
                        raise VoiceFailure('NO_ACTIVE_CALL')
                try:
                    await self.stream(a, chat, call)
                except Exception as stream_err:
                    if (not self.factory or getattr(self, 'auto_create_call_in_tests', False)) and classify(stream_err) == 'NO_ACTIVE_CALL':
                        clear_engine_cache(a['engine'], chat)
                        try: await asyncio.wait_for(a['engine'].leave_call(chat), 5)
                        except Exception: pass
                        peer, native = await self.native_call(a['client'], chat)
                        if native is None:
                            from pyrogram import raw
                            try:
                                await asyncio.wait_for(a['client'].invoke(raw.functions.phone.CreateGroupCall(peer=peer, random_id=secrets.randbits(31), title='Lancy music'), sleep_threshold=5), 15)
                                for _ in range(4):
                                    await asyncio.sleep(0.3)
                                    _, native = await self.native_call(a['client'], chat)
                                    if native is not None: break
                            except Exception: pass
                        if native is not None:
                            bind = getattr(getattr(a['engine'], '_app', None), '_bind_client', None)
                            if bind and hasattr(bind, '_cache'):
                                try:
                                    bind._cache.drop_cache(chat)
                                    bind._cache.set_cache(chat, native)
                                except Exception: pass
                            call['native_call'] = native
                            await self.stream(a, chat, call)
                        else:
                            raise stream_err
                    elif type(stream_err).__name__ == 'FloodWait' and getattr(stream_err, 'value', 0) <= 5:
                        await asyncio.sleep(getattr(stream_err, 'value', 1))
                        await self.stream(a, chat, call)
                    else:
                        raise stream_err
                call['status'] = 'playing'; self.calls[chat] = call; self.last_failures.pop(chat, None)
                return {'ok': True, 'account_alias': a['alias'], 'status': 'playing'}
            except Exception as error:
                self.remember_failure(chat, error)
                # A failed replacement can leave native media partially changed. Retain lease
                # until this chat's leave is confirmed; sibling calls remain independent.
                try:
                    await asyncio.wait_for(a['engine'].leave_call(chat), 15)
                    self.calls.pop(chat, None); self.release_destination(a, chat)
                except Exception:
                    call['status'] = 'error'; self.calls[chat] = call
                raise error

    async def control(self, op, data):
        chat = int(data['chat_id'])
        async with self.chat_lock(chat):
            call = self.calls.get(chat)
            if not call:
                if op == 'stop':
                    prepared = self.prepared.get(chat)
                    a = self.accounts.get(prepared['alias']) if prepared else next((x for x in self.accounts.values() if chat in x.get('managed', set())), None)
                    if a and data.get('leave_membership'): await self.leave_membership(a, chat)
                    self.prepared.pop(chat, None)
                    if a: self.release_destination(a, chat); a.get('group_grants', set()).discard(chat)
                    return {'ok': True, 'status': 'stopped'}
                raise VoiceFailure('NO_ACTIVE_CALL')
            a = self.accounts[call['alias']]; engine = a['engine']
            if op == 'stop':
                clear_engine_cache(engine, chat)
                try: await asyncio.wait_for(engine.leave_call(chat), 15)
                except Exception as e:
                    if classify(e) != 'NO_ACTIVE_CALL': raise
                if data.get('leave_membership'): await self.leave_membership(a, chat)
                self.calls.pop(chat, None); self.prepared.pop(chat, None); self.release_destination(a, chat); a.get('group_grants', set()).discard(chat)
                return {'ok': True, 'status': 'stopped'}
            if op == 'idle':
                # Empty raw stream replaces FFmpeg sources without leaving the call.
                from pytgcalls.types.raw.stream import Stream
                from pytgcalls.types import GroupCallConfig
                await asyncio.wait_for(engine.play(chat, Stream(), config=GroupCallConfig(auto_start=False)), 10)
                call['status'] = 'idle'; call['playback_id'] = None; call['position_seconds'] = None
            elif op in {'pause', 'resume'}:
                await asyncio.wait_for(getattr(engine, op)(chat), 10)
                if op == 'resume':
                    try: await asyncio.wait_for(self.ensure_publisher(a, chat, call), 12)
                    except Exception:
                        try: await asyncio.wait_for(engine.pause(chat), 8)
                        except Exception: pass
                        raise
                call['status'] = 'paused' if op == 'pause' else 'playing'; call['last_progress'] = time.monotonic()
            elif op == 'volume':
                volume = int(data['volume'])
                if not 0 <= volume <= 200: raise VoiceFailure('INVALID_REQUEST')
                await asyncio.wait_for(engine.change_volume_call(chat, volume), 10); call['volume'] = volume
            elif op == 'seek':
                position = float(data['seconds'])
                if not 0 <= position < call['duration']: raise VoiceFailure('INVALID_REQUEST')
                previous_offset = call['offset']; call['offset'] = position; paused = call['status'] == 'paused'
                try: await self.stream(a, chat, call)
                except Exception:
                    call['offset'] = previous_offset
                    raise
                if paused: await asyncio.wait_for(engine.pause(chat), 10)
                call['position_seconds'] = None; call['last_progress'] = time.monotonic()
            return {'ok': True, 'status': call['status'], 'position_seconds': call.get('position_seconds')}

    async def status(self, chat):
        async with self.chat_lock(chat):
            call = self.calls.get(chat)
            if not call: return {'ok': True, 'active': False, 'last_failure': self.last_failures.get(chat)}
            a = self.accounts[call['alias']]
            if call['status'] in {'playing', 'paused'}:
                try:
                    elapsed = float(await asyncio.wait_for(a['engine'].time(chat), 5))
                    # Native NTgCalls BaseSink::time returns chrono::seconds, not milliseconds.
                    position = call['offset'] + elapsed
                    if position != call['position_seconds']: call['last_progress'] = time.monotonic()
                    call['position_seconds'] = position; call['last_known_position'] = position; call['clock_errors'] = 0
                    if call['duration'] and position >= call['duration'] - 0.5: call['status'] = 'ended'
                    elif call['status'] == 'playing' and time.monotonic() - call['last_progress'] > 60: call['status'] = 'error'
                except Exception as error:
                    if classify(error) == 'NO_ACTIVE_CALL':
                        # Definitive native absence is not a live call merely because
                        # its metadata remains cached. Confirm idempotent departure.
                        clear_engine_cache(a['engine'], chat)
                        try: await asyncio.wait_for(a['engine'].leave_call(chat), 10)
                        except Exception as leave_error:
                            if classify(leave_error) != 'NO_ACTIVE_CALL': raise
                        self.calls.pop(chat, None); self.release_destination(a, chat)
                        return {'ok': True, 'active': False}
                    call['clock_errors'] += 1; call['position_seconds'] = None
                    if call['clock_errors'] >= 10: call['status'] = 'error'
            if call['status'] == 'playing' and not call.get('is_channel') and call.get('native_call') is not None and time.monotonic() >= call.get('publisher_check_after', 0):
                call['publisher_check_after'] = time.monotonic() + 5
                try:
                    _, participant = await self.native_publisher(a, chat, call['native_call'])
                except Exception:
                    participant = None
                if participant is not None and (getattr(participant, 'left', False) or getattr(participant, 'muted', False)):
                    # Do not fight subsequent moderator mute actions or discard songs.
                    call.update(status='error', publisher_muted=True, publisher_verified=False, position_seconds=None)
            if call['status'] == 'recovering' and time.monotonic() >= call['retry_after']: call['status'] = 'error'
            if call['status'] == 'error' and not call.get('publisher_muted') and call['retries'] < 2 and time.monotonic() < call['retry_after']: call['status'] = 'recovering'
            if call['status'] == 'error' and not call.get('publisher_muted') and call['retries'] < 2 and time.monotonic() >= call['retry_after']:
                call['retries'] += 1
                call['offset'] = min(call.get('last_known_position', 0.0), max(0, call['duration'] - 1))
                call['retry_after'] = time.monotonic() + 5 * (2 ** call['retries'])
                try:
                    clear_engine_cache(a['engine'], chat)
                    peer, native = await self.native_call(a['client'], chat)
                    if native is not None:
                        bind = getattr(getattr(a['engine'], '_app', None), '_bind_client', None)
                        if bind and hasattr(bind, '_cache'):
                            try:
                                bind._cache.drop_cache(chat)
                                bind._cache.set_cache(chat, native)
                            except Exception: pass
                        call['native_call'] = native
                    await self.stream(a, chat, call)
                    call['status'] = 'playing'; call['clock_errors'] = 0
                    call['last_progress'] = time.monotonic()
                    self.last_failures.pop(chat, None)
                except Exception as error:
                    self.remember_failure(chat, error)
                    # Retain this destination's lease while retrying. Never mutate another
                    # chat's source or state. Node sees buffering, not a false success.
                    if call['retries'] < 2: call['status'] = 'recovering'
            if call.get('status') == 'error' and call.get('retries', 0) >= 2 and time.monotonic() >= call.get('retry_after', 0) and classify(self.last_failures.get(chat, {}).get('code')) == 'NO_ACTIVE_CALL':
                clear_engine_cache(a['engine'], chat)
                try: await asyncio.wait_for(a['engine'].leave_call(chat), 5)
                except Exception: pass
                self.calls.pop(chat, None); self.release_destination(a, chat)
                return {'ok': True, 'active': False, 'last_failure': self.last_failures.get(chat)}
            return {'ok': True, 'active': True, 'last_failure': self.last_failures.get(chat), 'info': {k: call.get(k) for k in ['status','playback_id','position_seconds','alias','video','volume','publisher_verified','publisher_muted']}}

    async def shutdown(self):
        self.closing = True
        for chat in list(self.calls):
            try: await self.control('stop', {'chat_id': chat})
            except Exception: log.warning('Call cleanup failed destination=%s', chat)
        for a in self.accounts.values():
            if a['client']:
                try: await asyncio.wait_for(a['client'].stop(), 15)
                except Exception: log.warning('Client cleanup failed alias=%s', a['alias'])


def make_app(bridge, token):
    if not token or len(token) < 32: raise RuntimeError('VOICE_BRIDGE_TOKEN must contain at least 32 characters')
    @web.middleware
    async def authenticate(request, handler):
        if not hmac.compare_digest(request.headers.get('Authorization', ''), f'Bearer {token}'):
            return web.json_response({'ok': False, 'error': 'UNAUTHORIZED'}, status=401)
        try: return await handler(request)
        except VoiceFailure as e: return web.json_response({'ok': False, 'error': e.code, 'message': MESSAGES.get(e.code, MESSAGES['CALL_FAILED']), 'publisher_state':e.publisher_state}, status=409)
        except (ValueError, KeyError, TypeError): return web.json_response({'ok': False, 'error': 'INVALID_REQUEST', 'message': MESSAGES['INVALID_REQUEST']}, status=400)
        except Exception as e:
            code = classify(e); log.warning('Voice operation failed kind=%s', type(e).__name__)
            return web.json_response({'ok': False, 'error': code, 'message': MESSAGES.get(code, MESSAGES['CALL_FAILED']), 'error_kind':type(e).__name__}, status=503)
    app = web.Application(middlewares=[authenticate], client_max_size=32768)
    async def health(request): return web.json_response({'ok': True, 'protocol': 2, 'ready': any(a['status'] == 'available' and a['enabled'] for a in bridge.accounts.values()), 'active_calls_count': len(bridge.calls), 'session_configured': bool(bridge.accounts), 'mode': 'account_pool'})
    async def events(request):
        try: first = await asyncio.wait_for(bridge.events.get(), 20)
        except asyncio.TimeoutError: return web.json_response({'ok': True, 'events': []})
        batch = [first]
        while not bridge.events.empty() and len(batch) < 16: batch.append(bridge.events.get_nowait())
        return web.json_response({'ok': True, 'events': batch})
    async def accounts(request):
        chat = request.query.get('chat_id')
        if request.query.get('refresh') == '1': await bridge.refresh_health()
        return web.json_response({'ok': True, 'accounts': bridge.public_accounts(int(chat) if chat else None)})
    async def register(request): return web.json_response(await bridge.register(await request.json()))
    async def configure(request): return web.json_response(await bridge.configure(await request.json()))
    async def existing(request): return web.json_response(await bridge.existing_group_accounts(await request.json()))
    async def setup(request): return web.json_response(await bridge.setup(await request.json()))
    async def play(request): return web.json_response(await bridge.play(await request.json()))
    async def control(request): return web.json_response(await bridge.control(request.match_info['op'], await request.json()))
    async def status(request): return web.json_response(await bridge.status(int(request.query['chat_id'])))
    app.router.add_get('/events', events)
    app.router.add_get('/health', health); app.router.add_get('/accounts', accounts)
    app.router.add_post('/accounts/register', register); app.router.add_post('/accounts/configure', configure)
    app.router.add_post('/destination/setup', setup); app.router.add_post('/destination/existing-group', existing)
    app.router.add_post('/call/play', play); app.router.add_get('/call/status', status)
    app.router.add_post('/call/{op:pause|resume|stop|idle|volume|seek}', control)
    async def cleanup(_): await bridge.shutdown()
    app.on_cleanup.append(cleanup)
    return app

async def main():
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(name)s %(message)s')
    host = os.environ.get('VOICE_BRIDGE_HOST', '127.0.0.1')
    if host not in {'127.0.0.1', '::1'}: raise RuntimeError('Voice bridge must bind loopback')
    bridge = Bridge(os.environ['MUSIC_CACHE_DIR'])
    app = make_app(bridge, os.environ.get('VOICE_BRIDGE_TOKEN', ''))
    # Access logs disabled: no credential-bearing request data or URLs.
    runner = web.AppRunner(app, access_log=None); await runner.setup()
    await web.TCPSite(runner, host, int(os.environ.get('VOICE_BRIDGE_PORT', '3056'))).start()
    done = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT): loop.add_signal_handler(sig, done.set)
    parent = os.getppid()
    async def watch_parent():
        while not done.is_set():
            await asyncio.sleep(5)
            if os.getppid() != parent: done.set()
    watcher = asyncio.create_task(watch_parent())
    try: await done.wait()
    finally:
        watcher.cancel()
        await asyncio.gather(watcher, return_exceptions=True)
        await runner.cleanup()

if __name__ == '__main__': asyncio.run(main())
