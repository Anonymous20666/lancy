"""Lancy protocol-2 authenticated loopback bridge; queue ownership remains in Node.
No bot-token call fallback, no interactive credentials over HTTP, no persistent secrets.
"""
import asyncio
import hmac
import logging
import os
import signal
import time
from pathlib import Path
from aiohttp import web

log = logging.getLogger('lancy.voice')

MESSAGES = {
    'SESSION_NOT_READY': 'No authorized player account is ready. Ask the owner to register one.',
    'POOL_EXHAUSTED': 'All accounts approved for this destination are busy. Try later or select another approved account.',
    'ACCOUNT_UNAVAILABLE': 'The selected account is disabled, unauthorized, or not approved for this destination.',
    'NO_ACTIVE_CALL': 'Start a voice chat or channel live stream first. Lancy will not create one automatically.',
    'PERMISSION_DENIED': 'The playback account must be a member and allowed to speak in this call. Channel streams may require channel administrator/speaker rights.',
    'MEDIA_INVALID': 'The media is outside the managed cache or lacks required streams.',
    'CALL_FAILED': 'Telegram could not complete the call operation. Check account health, membership and call permissions.',
    'INVALID_REQUEST': 'Invalid voice-engine request.',
    'ACCOUNT_LIMIT': 'The playback pool has reached its eight-account limit.',
}

class VoiceFailure(Exception):
    def __init__(self, code): self.code = code

def classify(error):
    if isinstance(error, VoiceFailure): return error.code
    name = type(error).__name__
    if name in {'NoActiveGroupCall', 'GroupCallNotFound', 'NotInCallError'}: return 'NO_ACTIVE_CALL'
    if name in {'ChatAdminRequired', 'UserNotParticipant', 'ChannelPrivate', 'PeerIdInvalid', 'Forbidden', 'ChatWriteForbidden'}: return 'PERMISSION_DENIED'
    if name in {'AuthKeyUnregistered', 'SessionRevoked', 'UserDeactivated', 'Unauthorized', 'BotMethodInvalid'}: return 'SESSION_NOT_READY'
    return 'CALL_FAILED'

class Bridge:
    def __init__(self, root, factory=None):
        self.root = Path(root).resolve()
        self.factory = factory
        self.accounts = {}
        self.calls = {}
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
            self.accounts[alias] = {'alias': alias, 'enabled': bool(data.get('enabled', True)), 'allowed': list(data.get('allowed', [])), 'status': 'connecting', 'lease': None, 'client': None, 'engine': None}
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
                                if remaining is not None and elapsed >= max(0, remaining - 2): call['status'] = 'ended'
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
            if not account['enabled'] or account['lease'] is not None or not account['client']: continue
            try:
                me = await asyncio.wait_for(account['client'].get_me(), 8)
                account['status'] = 'authentication_required' if me.is_bot else 'available'
            except Exception:
                account['status'] = 'authentication_required'

    def public_accounts(self, chat=None):
        return [{'alias': a['alias'], 'enabled': a['enabled'], 'status': 'disabled' if not a['enabled'] else 'busy' if a['lease'] is not None else a['status'], 'destination': a['lease'] if chat is None else None} for a in self.accounts.values() if chat is None or str(chat) in a['allowed'] or '*' in a['allowed']]

    async def configure(self, data):
        alias = str(data.get('alias', ''))
        async with self.lock:
            a = self.accounts.get(alias)
            if not a: raise VoiceFailure('ACCOUNT_UNAVAILABLE')
            if a['lease'] is not None: raise VoiceFailure('POOL_EXHAUSTED')
            if 'allowed' in data: a['allowed'] = list(data['allowed'])
            if 'enabled' in data: a['enabled'] = bool(data['enabled'])
            if data.get('remove'): self.accounts.pop(alias)
        if data.get('remove') and a['client']: await a['client'].stop()
        return {'ok': True}

    async def lease(self, chat, alias=None):
        async with self.lock:
            existing = self.calls.get(chat)
            if existing:
                account = self.accounts[existing['alias']]
                if alias and alias != account['alias']: raise VoiceFailure('ACCOUNT_UNAVAILABLE')
                return account
            candidates = [a for a in self.accounts.values() if a['enabled'] and a['status'] == 'available' and (str(chat) in a['allowed'] or '*' in a['allowed']) and (not alias or a['alias'] == alias)]
            if not candidates: raise VoiceFailure('ACCOUNT_UNAVAILABLE' if alias else 'SESSION_NOT_READY')
            account = next((a for a in candidates if a['lease'] is None), None)
            if not account: raise VoiceFailure('POOL_EXHAUSTED')
            account['lease'] = chat
            return account

    def source(self, value):
        try:
            path = Path(value).resolve(strict=True)
            if not path.is_file() or not path.is_relative_to(self.root) or path.suffix not in {'.mp3', '.mp4'}: raise ValueError()
            return str(path)
        except (ValueError, TypeError, OSError): raise VoiceFailure('MEDIA_INVALID') from None

    async def stream(self, a, chat, call):
        from pytgcalls.types import MediaStream, AudioQuality, VideoQuality, GroupCallConfig
        ff = f'-ss {call["offset"]:.3f}' if call['offset'] else ''
        if call['bass']: ff += ' --audio ---mid -af volume=0.75,bass=g=3:f=100:w=0.5,alimiter=limit=0.95'
        stream = MediaStream(call['path'], audio_parameters=AudioQuality.HIGH, video_parameters=VideoQuality.SD_360p, audio_flags=MediaStream.Flags.REQUIRED, video_flags=MediaStream.Flags.REQUIRED if call['video'] else MediaStream.Flags.IGNORE, ffmpeg_parameters=ff or None)
        await asyncio.wait_for(a['engine'].play(chat, stream, config=GroupCallConfig(auto_start=False)), 40)

    async def resolve_destination(self, client, chat):
        # String sessions do not contain a peer/access-hash cache. Resolve only
        # existing dialog membership; never join/promote an account automatically.
        try:
            await asyncio.wait_for(client.get_chat(chat), 10)
            return
        except Exception as error:
            if type(error).__name__ != 'PeerIdInvalid': raise
        async def hydrate():
            async for dialog in client.get_dialogs(limit=500):
                if dialog.chat.id == chat:
                    await client.get_chat(chat)
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
            call = {'alias': a['alias'], 'path': path, 'video': bool(data.get('video')), 'bass': bool(data.get('bass')), 'is_channel': bool(data.get('is_channel')), 'duration': float(data.get('duration_seconds') or 0), 'offset': 0.0, 'playback_id': str(data['playback_id']), 'status': 'buffering', 'clock_errors': 0, 'position_seconds': None, 'last_known_position': 0.0, 'retries': 0, 'retry_after': 0.0, 'last_progress': time.monotonic()}
            try:
                # get_me confirms runtime authorization; preflight never promotes or joins the group.
                me = await asyncio.wait_for(a['client'].get_me(), 10)
                if me.is_bot: raise VoiceFailure('SESSION_NOT_READY')
                if not self.factory: await self.resolve_destination(a['client'], chat)
                await self.stream(a, chat, call)
                call['status'] = 'playing'; self.calls[chat] = call
                return {'ok': True, 'account_alias': a['alias'], 'status': 'playing'}
            except Exception as error:
                # A failed replacement can leave native media partially changed. Retain lease
                # until leave is confirmed; never advertise that account as free prematurely.
                try:
                    await asyncio.wait_for(a['engine'].leave_call(chat), 15)
                    self.calls.pop(chat, None); a['lease'] = None
                except Exception:
                    call['status'] = 'error'; self.calls[chat] = call
                raise error

    async def control(self, op, data):
        chat = int(data['chat_id'])
        async with self.chat_lock(chat):
            call = self.calls.get(chat)
            if not call:
                if op == 'stop': return {'ok': True, 'status': 'stopped'}
                raise VoiceFailure('NO_ACTIVE_CALL')
            a = self.accounts[call['alias']]; engine = a['engine']
            if op == 'stop':
                try: await asyncio.wait_for(engine.leave_call(chat), 15)
                except Exception as e:
                    if type(e).__name__ not in {'NotInCallError', 'NoActiveGroupCall'}: raise
                self.calls.pop(chat); a['lease'] = None
                return {'ok': True, 'status': 'stopped'}
            if op == 'idle':
                # Empty raw stream replaces FFmpeg sources without leaving the call.
                from pytgcalls.types.raw.stream import Stream
                from pytgcalls.types import GroupCallConfig
                await asyncio.wait_for(engine.play(chat, Stream(), config=GroupCallConfig(auto_start=False)), 10)
                call['status'] = 'idle'; call['playback_id'] = None; call['position_seconds'] = None
            elif op in {'pause', 'resume'}:
                await asyncio.wait_for(getattr(engine, op)(chat), 10)
                call['status'] = 'paused' if op == 'pause' else 'playing'; call['last_progress'] = time.monotonic()
            elif op == 'volume':
                volume = int(data['volume'])
                if not 0 <= volume <= 150: raise VoiceFailure('INVALID_REQUEST')
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
            if not call: return {'ok': True, 'active': False}
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
                        try: await asyncio.wait_for(a['engine'].leave_call(chat), 10)
                        except Exception as leave_error:
                            if classify(leave_error) != 'NO_ACTIVE_CALL': raise
                        self.calls.pop(chat, None); a['lease'] = None
                        return {'ok': True, 'active': False}
                    call['clock_errors'] += 1; call['position_seconds'] = None
                    if call['clock_errors'] >= 3: call['status'] = 'error'
            if call['status'] == 'recovering' and time.monotonic() >= call['retry_after']: call['status'] = 'error'
            if call['status'] == 'error' and call['retries'] < 2 and time.monotonic() < call['retry_after']: call['status'] = 'recovering'
            if call['status'] == 'error' and call['retries'] < 2 and time.monotonic() >= call['retry_after']:
                call['retries'] += 1
                call['offset'] = min(call.get('last_known_position', 0.0), max(0, call['duration'] - 1))
                call['retry_after'] = time.monotonic() + 5 * (2 ** call['retries'])
                try:
                    await self.stream(a, chat, call)
                    call['status'] = 'playing'; call['clock_errors'] = 0
                    call['last_progress'] = time.monotonic()
                except Exception:
                    # Retain the lease while retrying; never hand an uncertain native call
                    # to another destination. Node sees buffering, not a false success.
                    if call['retries'] < 2: call['status'] = 'recovering'
            return {'ok': True, 'active': True, 'info': {k: call.get(k) for k in ['status','playback_id','position_seconds','alias','video','volume']}}

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
        except VoiceFailure as e: return web.json_response({'ok': False, 'error': e.code, 'message': MESSAGES.get(e.code, MESSAGES['CALL_FAILED'])}, status=409)
        except (ValueError, KeyError, TypeError): return web.json_response({'ok': False, 'error': 'INVALID_REQUEST', 'message': MESSAGES['INVALID_REQUEST']}, status=400)
        except Exception as e:
            code = classify(e); log.warning('Voice operation failed kind=%s', type(e).__name__)
            return web.json_response({'ok': False, 'error': code, 'message': MESSAGES.get(code, MESSAGES['CALL_FAILED'])}, status=503)
    app = web.Application(middlewares=[authenticate], client_max_size=32768)
    async def health(request): return web.json_response({'ok': True, 'protocol': 2, 'ready': any(a['status'] == 'available' and a['enabled'] for a in bridge.accounts.values()), 'active_calls_count': len(bridge.calls), 'session_configured': bool(bridge.accounts), 'mode': 'account_pool'})
    async def accounts(request):
        chat = request.query.get('chat_id')
        if request.query.get('refresh') == '1': await bridge.refresh_health()
        return web.json_response({'ok': True, 'accounts': bridge.public_accounts(int(chat) if chat else None)})
    async def register(request): return web.json_response(await bridge.register(await request.json()))
    async def configure(request): return web.json_response(await bridge.configure(await request.json()))
    async def play(request): return web.json_response(await bridge.play(await request.json()))
    async def control(request): return web.json_response(await bridge.control(request.match_info['op'], await request.json()))
    async def status(request): return web.json_response(await bridge.status(int(request.query['chat_id'])))
    app.router.add_get('/health', health); app.router.add_get('/accounts', accounts)
    app.router.add_post('/accounts/register', register); app.router.add_post('/accounts/configure', configure)
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
