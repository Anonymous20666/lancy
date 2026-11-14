"""Lancy protocol-2 authenticated loopback bridge; queue ownership remains in Node.
No bot-token call fallback, no interactive credentials over HTTP, no persistent secrets.
"""
import asyncio
import hmac
import json
import logging
import os
import shlex
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
    if name in {'NoVideoSourceFound', 'NoAudioSourceFound', 'InvalidVideoProportion'}:
        return 'MEDIA_INVALID'
    return 'CALL_FAILED'

def clear_engine_cache(engine, chat):
    try:
        if hasattr(engine, '_clear_cache'): engine._clear_cache(chat)
    except Exception: pass
    try:
        bind = getattr(getattr(engine, '_app', None), '_bind_client', None)
        if bind and hasattr(bind, '_cache'): bind._cache.drop_cache(chat)
    except Exception: pass

IMAGE_CODECS = {'png', 'jpeg', 'jpg', 'mjpeg', 'webp', 'bmp', 'gif'}


def compute_target_video_size(orig_w, orig_h, max_w, max_h, adjust_by_height=True):
    """Match pytgcalls.ffmpeg.check_stream aspect-ratio rounding so rawvideo matches NTgCalls byte-for-byte."""
    orig_w, orig_h = int(orig_w or 0), int(orig_h or 0)
    if orig_w <= 0 or orig_h <= 0:
        return None
    ratio = float(orig_w) / float(orig_h)
    new_w = min(orig_w, int(max_w))
    new_h = int(new_w / ratio)
    if adjust_by_height and new_h > int(max_h):
        new_h = int(max_h)
        new_w = int(new_h * ratio)
    new_w = new_w - 1 if new_w % 2 else new_w
    new_h = new_h - 1 if new_h % 2 else new_h
    if new_w <= 0 or new_h <= 0:
        return None
    return new_w, new_h


def strip_reconnect_at_eof(cmd_str):
    """Remove -reconnect_at_eof flags from ffmpeg commands so proxied HLS playlists do not loop at EOF."""
    args = shlex.split(str(cmd_str))
    out = []
    skip_next = False
    for tok in args:
        if skip_next:
            skip_next = False
            continue
        if tok == '-reconnect_at_eof':
            skip_next = True
            continue
        out.append(tok)
    return shlex.join(out)


def _upsert_ffmpeg_input_sync_flags(args, *, pre_seek=None, copyts=False):
    """Ensure -copyts and input -ss appear strictly before -i when hybrid synchronized seeking is active."""
    cleaned = []
    skip_next = False
    for tok in args:
        if skip_next:
            skip_next = False
            continue
        if tok == '-copyts':
            continue
        if (pre_seek is not None or copyts) and tok == '-ss':
            skip_next = True
            continue
        cleaned.append(tok)

    prefix = []
    if copyts:
        prefix.append('-copyts')
    if pre_seek is not None and pre_seek > 0.05:
        prefix.extend(['-ss', f'{float(pre_seek):.3f}'])
    if not prefix:
        return cleaned

    out = []
    inserted = False
    for tok in cleaned:
        if not inserted and tok == '-i':
            out.extend(prefix)
            inserted = True
        out.append(tok)
    if not inserted:
        out = prefix + out
    return out


def rewrite_video_ffmpeg_command(
    cmd_str,
    width,
    height,
    *,
    subtitle_path=None,
    stream_index=None,
    video_count=1,
    is_image=False,
    fps=None,
    trim_start=None,
    normalize_pts=False,
    pre_seek=None,
    copyts=False,
):
    """Ensure a single consolidated -vf pipeline outputting exact width:height yuv420p frames aligned to audio PTS."""
    w = max(2, int(width) - (int(width) % 2))
    h = max(2, int(height) - (int(height) % 2))
    vf_parts = []
    if trim_start is not None and not is_image:
        vf_parts.append(f'trim=start={float(trim_start):.3f}')
    if (normalize_pts or trim_start is not None) and not is_image:
        vf_parts.append('setpts=PTS-STARTPTS')
    if fps is not None and not is_image and int(fps) > 0:
        vf_parts.append(f'fps=fps={int(fps)}')
    vf_parts.extend([f'scale={w}:{h}:flags=lanczos', 'setsar=1'])
    if subtitle_path:
        esc_sub = str(subtitle_path).replace('\\', '\\\\').replace(':', '\\:').replace("'", "\\'").replace('[', '\\[').replace(']', '\\]')
        vf_parts.append(f"subtitles='{esc_sub}':force_style='FontSize=20,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&H60000000,BorderStyle=1,Outline=2,Shadow=1,MarginV=22'")
    vf_parts.append('format=yuv420p')
    vf_expr = ','.join(vf_parts)

    args = _upsert_ffmpeg_input_sync_flags(shlex.split(str(cmd_str)), pre_seek=pre_seek, copyts=copyts)
    cleaned = []
    skip_next = False
    has_map = False
    for tok in args:
        if skip_next:
            skip_next = False
            continue
        if tok in {'-vf', '-filter:v', '-reconnect_at_eof'}:
            skip_next = True
            continue
        if tok == '-map':
            has_map = True
        cleaned.append(tok)

    out_args = []
    inserted_map = False
    inserted_vf = False
    for tok in cleaned:
        if not inserted_map and not has_map and stream_index is not None and video_count > 1 and not is_image and tok == '-f':
            out_args.extend(['-map', f'0:{int(stream_index)}'])
            inserted_map = True
        if not inserted_vf and tok.startswith('pipe:'):
            out_args.extend(['-vf', vf_expr])
            inserted_vf = True
        out_args.append(tok)
    if not inserted_vf:
        out_args.extend(['-vf', vf_expr])
    return shlex.join(out_args)


def rewrite_audio_ffmpeg_command(
    cmd_str,
    *,
    stream_index=None,
    audio_count=1,
    pre_seek=None,
    copyts=False,
    trim_start=None,
    normalize_pts=False,
    strip_first_pts_zero=False,
):
    """Align microphone FFmpeg stream selection, trim offset, and PTS to the active video pipeline."""
    args = _upsert_ffmpeg_input_sync_flags(shlex.split(str(cmd_str)), pre_seek=pre_seek, copyts=copyts)
    cleaned = []
    skip_next = False
    af_value = None
    has_map = False
    i = 0
    while i < len(args):
        tok = args[i]
        if skip_next:
            skip_next = False
            i += 1
            continue
        if tok == '-reconnect_at_eof':
            skip_next = True
            i += 1
            continue
        if tok in {'-af', '-filter:a'} and i + 1 < len(args):
            af_value = args[i + 1]
            i += 2
            continue
        if tok == '-map':
            has_map = True
        cleaned.append(tok)
        i += 1

    af_parts = []
    if trim_start is not None:
        af_parts.append(f'atrim=start={float(trim_start):.3f}')
    if normalize_pts or trim_start is not None:
        af_parts.append('asetpts=PTS-STARTPTS')
    base_af = af_value or 'aresample=48000:async=1'
    if strip_first_pts_zero:
        base_af = re.sub(r':first_pts=0\b', '', base_af)
    if af_parts:
        base_af = ','.join(af_parts) + ',' + base_af

    out_args = []
    inserted_map = False
    inserted_af = False
    for tok in cleaned:
        if not inserted_map and tok == '-f':
            if not has_map and stream_index is not None and audio_count > 1:
                out_args.extend(['-map', f'0:{int(stream_index)}'])
            out_args.extend(['-vn', '-sn', '-dn'])
            inserted_map = True
        if not inserted_af and tok.startswith('pipe:'):
            out_args.extend(['-af', base_af])
            inserted_af = True
        out_args.append(tok)
    if not inserted_af:
        out_args.extend(['-af', base_af])
    return shlex.join(out_args)


def _parse_start_time(val):
    try:
        num = float(val)
        if num == num and abs(num) < 1e7:
            return num
    except (TypeError, ValueError):
        pass
    return None


def _pick_primary_audio_stream(audio_streams):
    if not audio_streams:
        return None
    def score(st):
        disp = st.get('disposition') or {}
        tags = st.get('tags') or {}
        lang = str(tags.get('language') or '').lower()
        title = str(tags.get('title') or '').lower()
        pts = 0
        if disp.get('default'):
            pts += 30
        if lang in {'eng', 'en', 'und', ''}:
            pts += 15
        if any(k in title for k in ('commentary', 'description', 'descriptive', 'director')):
            pts -= 50
        return pts
    return max(audio_streams, key=score)


def _parse_fps(raw):
    try:
        s = str(raw or '').strip()
        if not s or s == '0/0':
            return None
        if '/' in s:
            num, den = s.split('/', 1)
            n, d = float(num), float(den)
            val = n / d if d else 0.0
        else:
            val = float(s)
        return round(val, 3) if 1.0 <= val <= 120.0 else None
    except Exception:
        return None


async def probe_media_stream_info(path):
    """Probe primary video and audio stream indices, dimensions, fps, duration, and start timestamps."""
    proc = None
    try:
        proc = await asyncio.create_subprocess_exec(
            'ffprobe', '-v', 'error', '-probesize', '2000000', '-analyzeduration', '2000000',
            '-show_entries', 'stream=index,codec_type,codec_name,width,height,start_time,avg_frame_rate,r_frame_rate',
            '-show_entries', 'stream_tags=language,title:stream_disposition=default,attached_pic:format=start_time,duration',
            '-of', 'json', str(path),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
        info = json.loads((stdout or b'{}').decode('utf-8'))
        all_streams = info.get('streams') or []
        fmt = info.get('format') or {}
        fmt_start = _parse_start_time(fmt.get('start_time'))
        fmt_duration = _parse_start_time(fmt.get('duration'))
        video_streams = [
            s for s in all_streams
            if s.get('codec_type') == 'video' and int(s.get('width') or 0) > 0 and int(s.get('height') or 0) > 0
        ]
        if not video_streams:
            return None
        primary_video = next(
            (s for s in video_streams if not (s.get('disposition') or {}).get('attached_pic') and str(s.get('codec_name') or '').lower() not in IMAGE_CODECS),
            None,
        )
        is_image = primary_video is None
        chosen_video = primary_video or video_streams[0]
        v_idx = chosen_video.get('index')
        v_start = _parse_start_time(chosen_video.get('start_time'))
        if v_start is None:
            v_start = fmt_start
        v_fps = _parse_fps(chosen_video.get('avg_frame_rate')) or _parse_fps(chosen_video.get('r_frame_rate'))

        audio_streams = [s for s in all_streams if s.get('codec_type') == 'audio']
        chosen_audio = _pick_primary_audio_stream(audio_streams)
        a_idx = chosen_audio.get('index') if chosen_audio else None
        a_start = _parse_start_time(chosen_audio.get('start_time')) if chosen_audio else None
        if chosen_audio and a_start is None:
            a_start = fmt_start

        return {
            'width': int(chosen_video['width']),
            'height': int(chosen_video['height']),
            'stream_index': int(v_idx) if v_idx is not None else None,
            'video_count': len(video_streams),
            'is_image': is_image,
            'video_start_time': v_start,
            'fps': v_fps,
            'duration': fmt_duration,
            'audio_stream_index': int(a_idx) if a_idx is not None else None,
            'audio_count': len(audio_streams),
            'audio_start_time': a_start,
        }
    except Exception:
        if proc and proc.returncode is None:
            try: proc.kill()
            except Exception: pass
    return None


async def probe_seek_first_pts(path, seek_sec=0.0):
    """Lightweight fallback probe for first decoded packet PTS near a seek offset."""
    proc = None
    try:
        proc = await asyncio.create_subprocess_exec(
            'ffprobe', '-v', 'error', '-ss', f'{max(0.0, float(seek_sec)):.3f}',
            '-select_streams', 'v:0', '-read_intervals', '%+#2',
            '-show_entries', 'packet=pts_time,dts_time', '-of', 'json', str(path),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=3.5)
        pkts = (json.loads((stdout or b'{}').decode('utf-8')).get('packets') or [])
        if pkts:
            return _parse_start_time(pkts[0].get('pts_time') or pkts[0].get('dts_time'))
    except Exception:
        if proc and proc.returncode is None:
            try: proc.kill()
            except Exception: pass
    return None


async def probe_video_stream_info(path):
    """Probe primary non-attached-pic video stream dimensions asynchronously with a bounded timeout."""
    proc = None
    try:
        proc = await asyncio.create_subprocess_exec(
            'ffprobe', '-v', 'error', '-select_streams', 'v',
            '-show_entries', 'stream=index,codec_name,width,height',
            '-show_entries', 'stream_disposition=attached_pic', '-of', 'json', str(path),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
        info = json.loads((stdout or b'{}').decode('utf-8'))
        streams = [s for s in (info.get('streams') or []) if int(s.get('width') or 0) > 0 and int(s.get('height') or 0) > 0]
        if not streams:
            return None
        primary = next(
            (s for s in streams if not (s.get('disposition') or {}).get('attached_pic') and str(s.get('codec_name') or '').lower() not in IMAGE_CODECS),
            None,
        )
        is_image = primary is None
        chosen = primary or streams[0]
        idx = chosen.get('index')
        return {
            'width': int(chosen['width']),
            'height': int(chosen['height']),
            'stream_index': int(idx) if idx is not None else None,
            'video_count': len(streams),
            'is_image': is_image,
        }
    except Exception:
        if proc and proc.returncode is None:
            try: proc.kill()
            except Exception: pass
    return None


async def probe_video_dimensions(path):
    """Probe raw source video dimensions asynchronously with a short bounded timeout."""
    info = await probe_video_stream_info(path)
    return (info['width'], info['height']) if info else None


class Bridge:
    def __init__(self, root, factory=None):
        self.root = Path(root).resolve()
        self.factory = factory
        self.accounts = {}
        self.calls = {}
        self.prepared = {}
        self.last_failures = {}
        self.last_ended_positions = {}
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
                from pytgcalls.types import StreamEnded, Device, ChatUpdate
                client = Client(f'lancy_{alias}', api_id=int(os.environ['TELEGRAM_API_ID']), api_hash=os.environ['TELEGRAM_API_HASH'], session_string=data['session'], in_memory=True)
                await asyncio.wait_for(client.start(), 30)
                me = getattr(client, 'me', None) or await asyncio.wait_for(client.get_me(), 10)
                if me.is_bot:
                    await client.stop()
                    raise VoiceFailure('SESSION_NOT_READY')
                uid = me.id
                engine = PyTgCalls(client)
                @engine.on_update()
                async def update(_, event):
                    if isinstance(event, ChatUpdate) and bool(event.status & ChatUpdate.Status.LEFT_CALL):
                        await self.handle_chat_update(event.chat_id, str(event.status), expected_alias=alias)
                        return
                    if isinstance(event, StreamEnded) and event.device == Device.MICROPHONE and event.stream_type == StreamEnded.Type.AUDIO:
                        # Native events have no source identity. Do not attach a new track's ID
                        # to a late old event. Corroborate completion against native media time.
                        async with self.chat_lock(event.chat_id):
                            call = self.calls.get(event.chat_id)
                            if not call or call['alias'] != alias or call['status'] != 'playing': return
                            try:
                                elapsed = await engine.time(event.chat_id)
                                pos = max(0.0, float(call.get('offset') or 0.0) + float(elapsed))
                                if pos > 0:
                                    call['last_known_position'] = max(float(call.get('last_known_position') or 0.0), pos)
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
            account.update(client=client, engine=engine, uid=uid, status='available', me_checked_at=(0 if self.factory else time.monotonic()))
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
            if not self.factory and account.get('uid') and account.get('status') == 'available' and time.monotonic() - account.get('me_checked_at', 0) < 30:
                continue
            try:
                me = await asyncio.wait_for(account['client'].get_me(), 8)
                if me.is_bot:
                    account['status'] = 'authentication_required'
                else:
                    account['status'] = 'available'
                    if not self.factory:
                        account['me_checked_at'] = time.monotonic()
            except Exception as error:
                if not self.factory and account.get('uid') and (isinstance(error, TimeoutError) or classify(error) in {'RATE_LIMITED', 'NO_ACTIVE_CALL'}):
                    continue
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
        peer = await asyncio.wait_for(client.resolve_peer(chat), 15)
        if isinstance(peer, raw.types.InputPeerChannel):
            request = raw.functions.channels.GetFullChannel(channel=raw.types.InputChannel(channel_id=peer.channel_id, access_hash=peer.access_hash))
        elif isinstance(peer, raw.types.InputPeerChat):
            request = raw.functions.messages.GetFullChat(chat_id=peer.chat_id)
        else: raise VoiceFailure('PERMISSION_DENIED')
        threshold = 0 if self.factory else 10
        full = await asyncio.wait_for(client.invoke(request, sleep_threshold=threshold), 15)
        return peer, getattr(full.full_chat, 'call', None)

    async def resolve_call_invite_link(self, a, native_call):
        """Fetch or export the real Telegram GroupCall/Livestream invite link via MTProto."""
        if native_call is None or a is None or a.get('client') is None:
            return None
        if self.factory and not getattr(self, 'resolve_call_invite_in_tests', False):
            return None
        try:
            from pyrogram import raw
            call_id = getattr(native_call, 'id', None)
            access_hash = getattr(native_call, 'access_hash', None)
            if call_id is None or access_hash is None:
                return None
            input_call = raw.types.InputGroupCall(id=int(call_id), access_hash=int(access_hash))
            threshold = 0 if self.factory else 10
            try:
                full_call = await asyncio.wait_for(
                    a['client'].invoke(raw.functions.phone.GetGroupCall(call=input_call, limit=1), sleep_threshold=threshold),
                    8,
                )
                link = getattr(getattr(full_call, 'call', None), 'invite_link', None)
                if link and str(link).startswith('https://t.me/'):
                    return str(link)
            except Exception:
                pass
            exported = await asyncio.wait_for(
                a['client'].invoke(raw.functions.phone.ExportGroupCallInvite(call=input_call), sleep_threshold=threshold),
                8,
            )
            link = getattr(exported, 'link', None)
            if link and str(link).startswith('https://t.me/'):
                return str(link)
        except Exception:
            return None
        return None

    async def call_invite_link(self, chat):
        """Return the real MTProto call invite link for an active chat call."""
        chat = int(chat)
        if chat >= 0:
            raise VoiceFailure('INVALID_REQUEST')
        async with self.chat_lock(chat):
            call = self.calls.get(chat)
            if call and call.get('call_invite_link'):
                return {'ok': True, 'call_invite_link': call['call_invite_link']}
            a = self.accounts.get(call['alias']) if call else await self.lease(chat)
            was_leased = call is None and chat not in self.calls
            try:
                native = call.get('native_call') if call else None
                if native is None:
                    await self.resolve_destination(a['client'], chat)
                    _, native = await self.native_call(a['client'], chat)
                link = await self.resolve_call_invite_link(a, native) if native is not None else None
                if call is not None and link:
                    call['call_invite_link'] = link
                return {'ok': True, 'call_invite_link': link}
            finally:
                if was_leased:
                    self.release_destination(a, chat)

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
                    if not self.factory and a.get('uid') and time.monotonic() - a.get('me_checked_at', 0) < 300:
                        return {'ok': True, 'account_alias': a['alias'], 'user_id': a['uid']}
                    me = await asyncio.wait_for(a['client'].get_me(), 10)
                    if me.is_bot: raise VoiceFailure('SESSION_NOT_READY')
                    a['me_checked_at'] = time.monotonic()
                except Exception as error:
                    if not was_prepared:
                        self.prepared.pop(chat, None)
                        self.release_destination(a, chat)
                    if not self.factory and isinstance(error, TimeoutError):
                        raise VoiceFailure('CALL_FAILED') from None
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
                m_inv = re.fullmatch(r'https://t\.me/(?:\+|joinchat/)([A-Za-z0-9_-]{8,200})', invite)
                if not m_inv: raise VoiceFailure('INVALID_REQUEST')
                try:
                    joined = await asyncio.wait_for(a['client'].join_chat(invite), 25)
                    if joined.id != chat: raise VoiceFailure('PERMISSION_DENIED')
                except Exception as error:
                    if type(error).__name__ == 'InviteRequestSent': raise VoiceFailure('JOIN_PENDING') from None
                    if not self.factory and type(error).__name__ in {'AttributeError', 'UserAlreadyParticipant', 'InviteHashExpired', 'InviteHashInvalid'}:
                        try:
                            from pyrogram import raw
                            chk = await asyncio.wait_for(a['client'].invoke(raw.functions.messages.CheckChatInvite(hash=m_inv.group(1)), sleep_threshold=10), 10)
                            if getattr(chk, 'chat', None) is not None and hasattr(a['client'], 'fetch_peers'):
                                await a['client'].fetch_peers([chk.chat])
                        except Exception:
                            pass
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
                if not self.factory:
                    clear_engine_cache(a['engine'], chat)
                    try: await asyncio.wait_for(a['engine'].leave_call(chat), 5)
                    except Exception: pass
                    self.calls.pop(chat, None)
                from pyrogram import raw
                threshold = 0 if self.factory else 10
                vc_title = str(data.get('vc_title') or data.get('title') or '').strip()[:64] or 'Lancy music'
                await asyncio.wait_for(a['client'].invoke(raw.functions.phone.CreateGroupCall(peer=peer, random_id=secrets.randbits(31), title=vc_title), sleep_threshold=threshold), 15)
                _, call = await self.native_call(a['client'], chat)
                if call is None and not self.factory:
                    for _ in range(6):
                        await asyncio.sleep(0.3)
                        _, call = await self.native_call(a['client'], chat)
                        if call is not None: break
                if call is None: raise VoiceFailure('NO_ACTIVE_CALL')
                created = True
            call_invite_link = await self.resolve_call_invite_link(a, call)
            a['managed'].add(chat)
            # Setup is not an active media transport. Retain per-chat membership
            # and routing metadata without reserving a native call.
            self.release_destination(a, chat)
            return {'ok': True, 'account_alias': a['alias'], 'call_ready': True, 'created': created, 'call_invite_link': call_invite_link}

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

    def resolve_media_input(self, data):
        val = str(data.get('stream_url') or '')
        if data.get('remote_proxy') is True and re.fullmatch(r'http://127\.0\.0\.1:\d{2,5}/movie-proxy/[a-f0-9]{16,64}(?:\.(?:m3u8|mpd|mp4|mkv|ts|m4s|aac))?', val):
            return val
        return self.source(val)

    def source_subtitle(self, value):
        if not value: return None
        try:
            path = Path(value).resolve(strict=True)
            if not path.is_file() or not path.is_relative_to(self.root) or path.suffix.lower() not in {'.srt', '.ass', '.vtt'}:
                return None
            return str(path)
        except (ValueError, TypeError, OSError):
            return None

    def prune_shifted_subtitles(self, active_playback_id=None, max_age_sec=3600):
        """Remove stale shifted_*.srt temp files from previous playbacks."""
        try:
            out_dir = self.root / 'subs'
            if not out_dir.is_dir():
                return
            keep_ids = {
                re.sub(r'[^A-Za-z0-9_-]', '', str(c.get('playback_id') or ''))[:24]
                for c in self.calls.values()
                if c.get('playback_id')
            }
            if active_playback_id:
                keep_ids.add(re.sub(r'[^A-Za-z0-9_-]', '', str(active_playback_id))[:24])
            now = time.time()
            for p in out_dir.glob('shifted_*.srt'):
                stem_id = p.stem[len('shifted_'):]
                if stem_id and stem_id in keep_ids:
                    continue
                try:
                    if not active_playback_id or (now - p.stat().st_mtime) > max_age_sec or stem_id not in keep_ids:
                        p.unlink(missing_ok=True)
                except Exception:
                    pass
        except Exception:
            pass

    def shift_subtitle(self, sub_path, offset_sec, playback_id, *, subtitle_offset=0.0):
        """Normalize subtitles to UTF-8 SRT shifted by seek (`offset_sec`) minus manual nudge (`subtitle_offset`)."""
        if not sub_path:
            return None
        try:
            total_shift = float(offset_sec or 0.0) - float(subtitle_offset or 0.0)
            is_srt = str(sub_path).lower().endswith('.srt')
            if abs(total_shift) < 0.01 and is_srt:
                return sub_path
            text = Path(sub_path).read_text(encoding='utf-8', errors='replace').lstrip('\ufeff')
            shift_ms = int(round(total_shift * 1000))
            out_blocks = []
            idx = 1
            def to_ms(ts):
                cleaned = ts.strip()
                m = re.match(r'^(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})$', cleaned)
                if m:
                    return (((int(m[1]) * 60) + int(m[2])) * 60 + int(m[3])) * 1000 + int(m[4].ljust(3, '0')[:3])
                s = re.match(r'^(\d{1,2}):(\d{2})[,.](\d{1,3})$', cleaned)
                if s:
                    return ((int(s[1]) * 60) + int(s[2])) * 1000 + int(s[3].ljust(3, '0')[:3])
                return None
            def fmt_ms(ms):
                ms = max(0, int(ms))
                rem, msec = divmod(ms, 1000)
                rem, sec = divmod(rem, 60)
                hr, mn = divmod(rem, 60)
                return f'{hr:02d}:{mn:02d}:{sec:02d},{msec:03d}'
            for block in re.split(r'\r?\n\r?\n+', text.replace('\r\n', '\n').replace('\r', '\n')):
                lines = [l for l in block.split('\n') if l.strip()]
                if not lines or re.match(r'^(?:WEBVTT|NOTE\b|STYLE\b|REGION\b)', lines[0], re.I):
                    continue
                ti = next((i for i, l in enumerate(lines) if '-->' in l), -1)
                if ti < 0: continue
                parts = [p.strip().split()[0] for p in lines[ti].split('-->')]
                if len(parts) < 2: continue
                st, en = to_ms(parts[0]), to_ms(parts[1])
                if st is None or en is None or en - shift_ms <= 0:
                    continue
                nst = max(0, st - shift_ms)
                nen = max(nst + 250, en - shift_ms)
                body = re.sub(r'<[^>]+>|\{\\[^}]+\}', '', '\n'.join(lines[ti + 1:])).strip()
                if body:
                    out_blocks.append(f'{idx}\n{fmt_ms(nst)} --> {fmt_ms(nen)}\n{body}')
                    idx += 1
            if not out_blocks: return None
            out_dir = self.root / 'subs'
            out_dir.mkdir(parents=True, exist_ok=True)
            safe_id = re.sub(r'[^A-Za-z0-9_-]', '', str(playback_id or 'sub'))[:24] or 'sub'
            out_path = out_dir / f'shifted_{safe_id}.srt'
            out_path.write_text('\n\n'.join(out_blocks) + '\n', encoding='utf-8')
            return str(out_path)
        except Exception:
            return sub_path

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
        threshold = 0 if self.factory else 10
        if input_call is None:
            peer = await self.publisher_step(client.resolve_peer(chat), 'resolve_peer')
            if isinstance(peer, raw.types.InputPeerChannel):
                request = raw.functions.channels.GetFullChannel(channel=raw.types.InputChannel(channel_id=peer.channel_id, access_hash=peer.access_hash))
            elif isinstance(peer, raw.types.InputPeerChat):
                request = raw.functions.messages.GetFullChat(chat_id=peer.chat_id)
            else:
                raise VoiceFailure('PERMISSION_DENIED')
            full = await self.publisher_step(client.invoke(request, sleep_threshold=threshold), 'call_state')
            input_call = getattr(full.full_chat, 'call', None)
            if input_call is None: raise VoiceFailure('NO_ACTIVE_CALL')
        result = await self.publisher_step(client.invoke(raw.functions.phone.GetGroupParticipants(call=input_call, ids=[raw.types.InputPeerSelf()], sources=[], offset='', limit=1), sleep_threshold=threshold), 'self_participant')
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
            threshold = 0 if self.factory else 10
            await self.publisher_step(a['client'].invoke(raw.functions.phone.EditGroupCallParticipant(call=input_call, participant=raw.types.InputPeerSelf(), muted=False), sleep_threshold=threshold),'self_unmute')
        for attempt in range(3):
            input_call, participant = await self.native_publisher(a, chat, input_call)
            if participant is not None and not getattr(participant, 'left', False) and not getattr(participant, 'muted', False) and getattr(participant, 'source', 0):
                call.update(native_call=input_call, publisher_verified=True, publisher_muted=False, publisher_check_after=time.monotonic()+5)
                return
            if attempt < 2: await asyncio.sleep(0.2)
        raise VoiceFailure('PERMISSION_DENIED', {'stage':'verification_failed','present':participant is not None,'muted':bool(getattr(participant,'muted',True)),'can_self_unmute':bool(getattr(participant,'can_self_unmute',False)),'source_present':bool(getattr(participant,'source',0))})

    async def stream(self, a, chat, call):
        from pytgcalls.types import MediaStream, AudioQuality, VideoQuality, GroupCallConfig
        try:
            from pytgcalls.types.raw import Stream, VideoParameters
        except ImportError:
            Stream = None
            VideoParameters = None

        ff = f'-ss {call["offset"]:.3f}' if call['offset'] else ''
        is_channel = bool(call.get('is_channel'))
        has_video = bool(call.get('video'))
        video_active = has_video or is_channel

        # Preserve 6 dB of headroom before PCM16/Opus conversion; no default EQ
        # or loudness maximization. Video-active streams lock playback tempo to 1.0x
        # so audio never races ahead of video (e.g. nightcore/vaporwave on 44.1kHz files).
        eq_preset = str(call.get('eq') or ('bass' if call.get('bass') else 'off')).lower()
        eq_map = {
            'studio': 'equalizer=f=55:width_type=q:w=1.1:g=2.2,equalizer=f=105:width_type=q:w=1.2:g=1.4,equalizer=f=240:width_type=q:w=1.4:g=-1.5,equalizer=f=3600:width_type=h:width=1400:g=1.6,equalizer=f=11000:width_type=h:width=3000:g=1.2,acompressor=threshold=-18dB:ratio=1.5:attack=20:release=180:makeup=1,',
            'bass': 'equalizer=f=55:width_type=q:w=1.1:g=2.8,equalizer=f=105:width_type=q:w=1.2:g=1.8,equalizer=f=240:width_type=q:w=1.4:g=-1.8,equalizer=f=3800:width_type=q:w=1.5:g=1.2,acompressor=threshold=-18dB:ratio=1.5:attack=20:release=180:makeup=1,',
            'clean_bass': 'equalizer=f=55:width_type=q:w=1.1:g=2.8,equalizer=f=105:width_type=q:w=1.2:g=1.8,equalizer=f=240:width_type=q:w=1.4:g=-1.8,equalizer=f=3800:width_type=q:w=1.5:g=1.2,acompressor=threshold=-18dB:ratio=1.5:attack=20:release=180:makeup=1,',
            'vocal': 'highpass=f=140,equalizer=f=3000:width_type=q:w=1.2:g=2.5,',
            'nightcore': 'treble=g=2.5:f=4000,' if video_active else 'aresample=48000,asetrate=48000*1.12,aresample=48000,',
            'vaporwave': 'equalizer=f=120:width_type=q:w=1.2:g=2.0,lowpass=f=9000,' if video_active else 'aresample=48000,asetrate=48000*0.88,aresample=48000,',
            '8d': 'apulsator=hz=0.125,',
        }
        clean_bass_fallback = 'equalizer=f=55:width_type=q:w=1.1:g=2.8,equalizer=f=105:width_type=q:w=1.2:g=1.8,equalizer=f=240:width_type=q:w=1.4:g=-1.8,acompressor=threshold=-18dB:ratio=1.5:attack=20:release=180:makeup=1,'
        eq_filter = eq_map.get(eq_preset, clean_bass_fallback if call.get('bass') else '')
        fade_in = 'afade=t=in:st=0:d=0.25,' if not call['offset'] else ''
        vol_pct = call.get('volume')
        vol_gain = f'volume={max(0, min(200, int(vol_pct))) / 100.0:.4f},' if vol_pct is not None and int(vol_pct) != 100 else ''
        filters = 'volume=0.5011872336,' + eq_filter + vol_gain + fade_in + 'alimiter=limit=0.89:attack=7:release=80:level=0,aresample=48000:async=1:first_pts=0'
        ff += ' --audio ---mid -af ' + filters

        requested_quality = str(call.get('video_quality') or os.environ.get('VOICE_VIDEO_QUALITY') or 'HD_720p')
        video_quality = getattr(VideoQuality, requested_quality, getattr(VideoQuality, 'HD_720p', VideoQuality.SD_360p))
        vq_val = getattr(video_quality, 'value', None)
        if VideoParameters is not None and isinstance(vq_val, tuple) and len(vq_val) >= 3:
            video_params = VideoParameters(vq_val[0], vq_val[1], vq_val[2], adjust_by_height=True)
            max_w, max_h = int(video_params.width), int(video_params.height)
        else:
            video_params = video_quality
            max_w, max_h = 1280, 720

        video_flags = MediaStream.Flags.REQUIRED if video_active else MediaStream.Flags.IGNORE
        if video_active:
            ff += ' --video ---mid -sws_flags lanczos'

        stream = MediaStream(call['path'], audio_parameters=AudioQuality.HIGH, video_parameters=video_params, audio_flags=MediaStream.Flags.REQUIRED, video_flags=video_flags, ffmpeg_parameters=ff or None)
        play_stream = stream
        if Stream is not None and callable(getattr(stream, 'check_stream', None)):
            await stream.check_stream()
            info = (await probe_media_stream_info(call['path'])) or (await probe_video_stream_info(call['path'])) if video_active else None
            sync_trim_start = None
            sync_pre_seek = None
            sync_copyts = False
            sync_normalize_pts = False
            offset_val = float(call.get('offset') or 0.0)
            sub_user_offset = float(call.get('subtitle_offset') or 0.0)
            sub_shift_offset = offset_val
            target_fps = 30
            if getattr(stream, 'camera', None) is not None:
                target_fps = int(getattr(stream.camera.parameters, 'frame_rate', 30) or 30)

            if video_active and info and not info.get('is_image', False):
                v_start = info.get('video_start_time')
                a_start = info.get('audio_start_time')
                if v_start is not None or a_start is not None:
                    if v_start is not None and a_start is not None and abs(v_start - a_start) <= 15.0:
                        common_start = max(v_start, a_start)
                    else:
                        common_start = v_start if v_start is not None else a_start
                    drift = abs((v_start or 0.0) - (a_start or 0.0)) if (v_start is not None and a_start is not None) else 0.0
                    sync_normalize_pts = True
                    if offset_val > 0.05 or drift >= 0.025:
                        sync_copyts = True
                        sync_trim_start = float(common_start) + offset_val
                        sync_pre_seek = max(0.0, offset_val - 8.0) if offset_val > 8.5 else 0.0
                        if v_start is not None:
                            sub_shift_offset = max(0.0, sync_trim_start - float(v_start))

            if offset_val > 0.05 and sync_trim_start is None and not (info and info.get('is_image', False)):
                fallback_start = (await probe_seek_first_pts(call['path'], 0.0)) if video_active else 0.0
                base_start = float(fallback_start) if fallback_start is not None else 0.0
                sync_copyts = True
                sync_trim_start = base_start + offset_val
                sync_pre_seek = max(0.0, offset_val - 8.0) if offset_val > 8.5 else 0.0
                sync_normalize_pts = True
                sub_shift_offset = offset_val

            if getattr(stream, 'microphone', None) is not None and getattr(stream.microphone, 'path', None):
                if video_active and not (info and info.get('is_image', False)):
                    stream.microphone.path = rewrite_audio_ffmpeg_command(
                        stream.microphone.path,
                        stream_index=info.get('audio_stream_index') if info else None,
                        audio_count=info.get('audio_count', 1) if info else 1,
                        pre_seek=sync_pre_seek,
                        copyts=sync_copyts,
                        trim_start=sync_trim_start,
                        normalize_pts=sync_normalize_pts or bool(sync_copyts),
                        strip_first_pts_zero=True,
                    )
                elif offset_val > 0.05:
                    stream.microphone.path = rewrite_audio_ffmpeg_command(
                        stream.microphone.path,
                        pre_seek=offset_val,
                        normalize_pts=True,
                    )
                elif call.get('remote_proxy') or '-reconnect_at_eof' in str(stream.microphone.path):
                    stream.microphone.path = strip_reconnect_at_eof(stream.microphone.path)

            if video_active and getattr(stream, 'camera', None) is not None:
                scaled = compute_target_video_size(info['width'], info['height'], max_w, max_h, adjust_by_height=True) if info else None
                cam_w = int(getattr(stream.camera.parameters, 'width', max_w) or max_w)
                cam_h = int(getattr(stream.camera.parameters, 'height', max_h) or max_h)
                final_w, final_h = scaled if scaled else (max(2, cam_w - (cam_w % 2)), max(2, cam_h - (cam_h % 2)))
                stream.camera.parameters.width = final_w
                stream.camera.parameters.height = final_h
                sub_raw = call.get('subtitle_path')
                active_sub = (
                    self.shift_subtitle(sub_raw, sub_shift_offset, call.get('playback_id'), subtitle_offset=sub_user_offset)
                    if (sub_raw and Path(sub_raw).is_file())
                    else None
                )
                is_img = info.get('is_image', False) if info else False
                stream.camera.path = rewrite_video_ffmpeg_command(
                    stream.camera.path,
                    final_w,
                    final_h,
                    subtitle_path=active_sub,
                    stream_index=info.get('stream_index') if info else None,
                    video_count=info.get('video_count', 1) if info else 1,
                    is_image=is_img,
                    fps=target_fps if not is_img else None,
                    trim_start=sync_trim_start if not is_img else None,
                    normalize_pts=(sync_normalize_pts or not is_img),
                    pre_seek=sync_pre_seek if not is_img else None,
                    copyts=sync_copyts if not is_img else False,
                )
            play_stream = Stream(
                microphone=getattr(stream, 'microphone', None),
                speaker=getattr(stream, 'speaker', None),
                camera=getattr(stream, 'camera', None),
                screen=getattr(stream, 'screen', None),
            )
        await asyncio.wait_for(a['engine'].play(chat, play_stream, config=GroupCallConfig(auto_start=False)), 25)
        if call.get('status') != 'paused':
            try: await asyncio.wait_for(self.ensure_publisher(a, chat, call), 15)
            except VoiceFailure: raise
            except Exception as error: raise VoiceFailure('PUBLISHER_UNVERIFIED', {'stage':'publisher_check','kind':type(error).__name__}) from None

    async def set_group_call_title(self, a, native_call, title):
        """Rename the active Telegram Voice Chat title without failing playback."""
        clean_title = str(title or '').strip()[:64]
        if not clean_title or native_call is None:
            return False
        if self.factory and not getattr(self, 'edit_call_title_in_tests', False):
            return False
        call_id = getattr(native_call, 'id', None)
        access_hash = getattr(native_call, 'access_hash', None)
        if not call_id or access_hash is None:
            return False
        try:
            from pyrogram import raw
            input_call = raw.types.InputGroupCall(id=int(call_id), access_hash=int(access_hash))
            await asyncio.wait_for(
                a['client'].invoke(raw.functions.phone.EditGroupCallTitle(call=input_call, title=clean_title), sleep_threshold=5),
                10,
            )
            return True
        except Exception:
            return False

    async def resolve_destination(self, client, chat):
        # String sessions do not contain a peer/access-hash cache. Resolve only
        # existing dialog membership; never join/promote an account automatically.
        if not self.factory and hasattr(client, 'resolve_peer'):
            try:
                await asyncio.wait_for(client.resolve_peer(chat), 5)
                return
            except Exception as peer_err:
                if type(peer_err).__name__ not in {'PeerIdInvalid', 'ChannelInvalid', 'ChannelPrivate', 'KeyError', 'ValueError', 'AttributeError'}:
                    raise
        try:
            await asyncio.wait_for(client.get_chat(chat), 10)
            return
        except Exception as error:
            if not self.factory and type(error).__name__ == 'AttributeError' and hasattr(client, 'resolve_peer'):
                try:
                    await asyncio.wait_for(client.resolve_peer(chat), 5)
                    return
                except Exception:
                    pass
            if type(error).__name__ not in {'PeerIdInvalid', 'ChannelInvalid', 'ChannelPrivate', 'KeyError', 'ValueError', 'AttributeError'}: raise
        async def hydrate():
            if not self.factory and hasattr(client, 'invoke') and hasattr(client, 'resolve_peer'):
                from pyrogram import raw
                offset_date = 0
                offset_id = 0
                offset_peer = raw.types.InputPeerEmpty()
                for _ in range(5):
                    r = await client.invoke(
                        raw.functions.messages.GetDialogs(
                            offset_date=offset_date,
                            offset_id=offset_id,
                            offset_peer=offset_peer,
                            limit=100,
                            hash=0,
                        ),
                        sleep_threshold=10,
                    )
                    try:
                        await client.resolve_peer(chat)
                        return True
                    except Exception:
                        pass
                    dialogs = getattr(r, 'dialogs', None) or []
                    messages = getattr(r, 'messages', None) or []
                    if not dialogs or not messages:
                        break
                    last_msg = next((m for m in reversed(messages) if getattr(m, 'date', None)), None)
                    if not last_msg:
                        break
                    offset_id = getattr(last_msg, 'id', 0) or 0
                    offset_date = getattr(last_msg, 'date', 0) or 0
                return False
            async for dialog in client.get_dialogs(limit=500):
                if getattr(dialog, 'chat', None) and dialog.chat.id == chat:
                    try:
                        await client.get_chat(chat)
                    except Exception as e:
                        if not self.factory and type(e).__name__ == 'AttributeError': return True
                        raise
                    return True
            return False
        if not await asyncio.wait_for(hydrate(), 25):
            raise VoiceFailure('PERMISSION_DENIED')

    async def play(self, data):
        chat = int(data['chat_id'])
        if chat >= 0 or self.closing: raise VoiceFailure('INVALID_REQUEST')
        async with self.chat_lock(chat):
            path = self.resolve_media_input(data)
            sub_path = self.source_subtitle(data.get('subtitle_path'))
            a = await self.lease(chat, data.get('account_alias'))
            previous = self.calls.get(chat)
            if previous and previous['playback_id'] == data.get('playback_id'): return {'ok': True, 'account_alias': a['alias'], 'status': previous['status']}
            call_duration = float(data.get('duration_seconds') or 0)
            start_sec = max(0.0, float(data.get('start_seconds') or 0.0))
            if call_duration > 0 and start_sec >= call_duration:
                start_sec = max(0.0, call_duration - 2.0)
            vc_title = str(data.get('vc_title') or data.get('title') or '').strip()[:64]
            sub_offset = float(data.get('subtitle_offset') or 0.0)
            created_with_title = False
            call = {'alias': a['alias'], 'path': path, 'subtitle_path': sub_path, 'subtitle_offset': sub_offset, 'video': bool(data.get('video')), 'video_quality': str(data.get('video_quality') or os.environ.get('VOICE_VIDEO_QUALITY') or 'HD_720p'), 'bass': bool(data.get('bass')), 'eq': str(data.get('eq') or ('bass' if data.get('bass') else 'off')), 'is_channel': bool(data.get('is_channel')), 'remote_proxy': bool(data.get('remote_proxy')), 'duration': call_duration, 'offset': start_sec, 'playback_id': str(data['playback_id']), 'status': 'buffering', 'clock_errors': 0, 'position_seconds': start_sec if start_sec > 0 else None, 'last_known_position': start_sec, 'retries': 0, 'retry_after': 0.0, 'last_progress': time.monotonic(), 'vc_title': vc_title}
            if data.get('volume') is not None:
                call['volume'] = int(data['volume'])
            elif previous and 'volume' in previous:
                call['volume'] = int(previous['volume'])
            try:
                # get_me confirms runtime authorization; preflight never promotes or joins the group.
                if self.factory or not a.get('uid') or time.monotonic() - a.get('me_checked_at', 0) >= 300:
                    me = await asyncio.wait_for(a['client'].get_me(), 10)
                    if me.is_bot: raise VoiceFailure('SESSION_NOT_READY')
                    a['me_checked_at'] = time.monotonic()
                can_reuse_call = (
                    not getattr(self, 'auto_create_call_in_tests', False)
                    and previous is not None
                    and previous.get('alias') == a['alias']
                    and previous.get('status') in {'playing', 'paused', 'buffering'}
                    and previous.get('native_call') is not None
                )
                if can_reuse_call:
                    call['native_call'] = previous['native_call']
                elif not self.factory or getattr(self, 'auto_create_call_in_tests', False):
                    await self.resolve_destination(a['client'], chat)
                    try: peer, native = await self.native_call(a['client'], chat)
                    except Exception: peer, native = None, None
                    prev_id = getattr(previous.get('native_call'), 'id', None) if previous else None
                    curr_id = getattr(native, 'id', None) if native else None
                    need_reset = (not self.factory and previous is None) or native is None or (prev_id is not None and curr_id != prev_id)
                    if need_reset:
                        clear_engine_cache(a['engine'], chat)
                        try: await asyncio.wait_for(a['engine'].leave_call(chat), 5)
                        except Exception: pass
                    if peer is not None and native is None:
                        from pyrogram import raw
                        try:
                            await asyncio.wait_for(a['client'].invoke(raw.functions.phone.CreateGroupCall(peer=peer, random_id=secrets.randbits(31), title=vc_title or 'Lancy music'), sleep_threshold=10), 15)
                            created_with_title = bool(vc_title)
                            for _ in range(6):
                                await asyncio.sleep(0.3)
                                _, native = await self.native_call(a['client'], chat)
                                if native is not None: break
                        except Exception as create_err:
                            if type(create_err).__name__ in {'ChatAdminRequired', 'ChannelPrivate', 'ChatWriteForbidden'}:
                                raise VoiceFailure('PERMISSION_DENIED') from None
                            if type(create_err).__name__ == 'FloodWait' and getattr(create_err, 'value', 0) <= 10:
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
                    if (not self.factory or getattr(self, 'auto_create_call_in_tests', False)) and classify(stream_err) in {'NO_ACTIVE_CALL', 'CALL_FAILED', 'PUBLISHER_UNVERIFIED'}:
                        clear_engine_cache(a['engine'], chat)
                        try: await asyncio.wait_for(a['engine'].leave_call(chat), 5)
                        except Exception: pass
                        try: await self.resolve_destination(a['client'], chat)
                        except Exception: pass
                        peer, native = await self.native_call(a['client'], chat)
                        if native is None:
                            from pyrogram import raw
                            try:
                                await asyncio.wait_for(a['client'].invoke(raw.functions.phone.CreateGroupCall(peer=peer, random_id=secrets.randbits(31), title=vc_title or 'Lancy music'), sleep_threshold=10), 15)
                                created_with_title = bool(vc_title)
                                for _ in range(6):
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
                    elif type(stream_err).__name__ == 'FloodWait' and getattr(stream_err, 'value', 0) <= 10:
                        await asyncio.sleep(getattr(stream_err, 'value', 1))
                        await self.stream(a, chat, call)
                    else:
                        raise stream_err
                if vc_title and not created_with_title:
                    await self.set_group_call_title(a, call.get('native_call'), vc_title)
                call_invite_link = await self.resolve_call_invite_link(a, call.get('native_call'))
                if call_invite_link:
                    call['call_invite_link'] = call_invite_link
                self.prune_shifted_subtitles(active_playback_id=call['playback_id'])
                call['status'] = 'playing'; self.calls[chat] = call; self.last_failures.pop(chat, None); self.last_ended_positions.pop(chat, None)
                return {'ok': True, 'account_alias': a['alias'], 'status': 'playing', 'position_seconds': start_sec, 'call_invite_link': call.get('call_invite_link')}
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
                    self.prepared.pop(chat, None); self.last_ended_positions.pop(chat, None)
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
                self.calls.pop(chat, None); self.prepared.pop(chat, None); self.last_ended_positions.pop(chat, None); self.release_destination(a, chat); a.get('group_grants', set()).discard(chat)
                return {'ok': True, 'status': 'stopped'}
            if op == 'idle':
                # Empty raw stream replaces FFmpeg sources without leaving the call.
                from pytgcalls.types.raw.stream import Stream
                from pytgcalls.types import GroupCallConfig
                await asyncio.wait_for(engine.play(chat, Stream(), config=GroupCallConfig(auto_start=False)), 10)
                call['status'] = 'idle'; call['playback_id'] = None; call['position_seconds'] = None
            elif op in {'pause', 'resume'}:
                if op == 'pause' and call.get('status') == 'playing':
                    try:
                        elapsed = float(await asyncio.wait_for(engine.time(chat), 2))
                        paused_pos = max(0.0, float(call.get('offset') or 0.0) + elapsed)
                        if call.get('duration'):
                            paused_pos = min(paused_pos, max(0.0, float(call['duration']) - 1.0))
                        call['last_known_position'] = max(float(call.get('last_known_position') or 0.0), paused_pos)
                        call['position_seconds'] = call['last_known_position']
                    except Exception:
                        pass
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
                if self.factory:
                    await asyncio.wait_for(engine.change_volume_call(chat, volume), 10)
                    call['volume'] = volume
                else:
                    from pyrogram import raw
                    prev_vol = call.get('volume', 100)
                    call['volume'] = volume
                    mtproto_ok = False
                    try:
                        user_peer_cache = getattr(engine, '_cache_user_peer', None)
                        if user_peer_cache is not None and hasattr(user_peer_cache, 'put') and hasattr(user_peer_cache, 'get'):
                            if user_peer_cache.get(chat) is None:
                                user_peer_cache.put(chat, raw.types.InputPeerSelf())
                        bind = getattr(getattr(engine, '_app', None), '_bind_client', None)
                        if bind and hasattr(bind, '_cache') and call.get('native_call') is not None:
                            try: bind._cache.set_cache(chat, call['native_call'])
                            except Exception: pass
                        if volume > 0:
                            await asyncio.wait_for(engine.change_volume_call(chat, volume), 8)
                            mtproto_ok = True
                    except Exception:
                        pass
                    if not mtproto_ok:
                        try:
                            input_call = call.get('native_call')
                            if input_call is None:
                                _, input_call = await self.native_call(a['client'], chat)
                                if input_call is not None: call['native_call'] = input_call
                            if input_call is not None:
                                await asyncio.wait_for(
                                    a['client'].invoke(
                                        raw.functions.phone.EditGroupCallParticipant(
                                            call=input_call,
                                            participant=raw.types.InputPeerSelf(),
                                            muted=(volume == 0),
                                            volume=max(100, volume * 100),
                                        ),
                                        sleep_threshold=10,
                                    ),
                                    8,
                                )
                                mtproto_ok = True
                        except Exception:
                            pass
                    if not mtproto_ok and call.get('status') in {'playing', 'paused'} and prev_vol != volume:
                        try:
                            elapsed = float(await asyncio.wait_for(engine.time(chat), 3))
                        except Exception:
                            elapsed = 0.0
                        new_offset = min(max(0.0, call.get('offset', 0.0) + elapsed), max(0.0, (call.get('duration') or 0.0) - 1.0)) if call.get('duration') else max(0.0, call.get('offset', 0.0) + elapsed)
                        old_offset = call.get('offset', 0.0)
                        was_paused = call.get('status') == 'paused'
                        call['offset'] = new_offset
                        try:
                            await self.stream(a, chat, call)
                            if was_paused:
                                await asyncio.wait_for(engine.pause(chat), 8)
                            call['position_seconds'] = new_offset
                            call['last_progress'] = time.monotonic()
                        except Exception:
                            call['offset'] = old_offset
            elif op == 'subtitle':
                sub_path = self.source_subtitle(data.get('subtitle_path'))
                sub_offset = float(data.get('subtitle_offset')) if data.get('subtitle_offset') is not None else float(call.get('subtitle_offset') or 0.0)
                old_sub = call.get('subtitle_path')
                old_sub_offset = float(call.get('subtitle_offset') or 0.0)
                if (sub_path != old_sub or abs(sub_offset - old_sub_offset) >= 0.005) and call.get('status') in {'playing', 'paused'}:
                    try:
                        elapsed = float(await asyncio.wait_for(engine.time(chat), 3))
                    except Exception:
                        elapsed = 0.0
                    new_offset = max(0.0, call.get('offset', 0.0) + elapsed)
                    old_offset = call.get('offset', 0.0)
                    was_paused = call.get('status') == 'paused'
                    call['subtitle_path'] = sub_path
                    call['subtitle_offset'] = sub_offset
                    call['offset'] = new_offset
                    try:
                        await self.stream(a, chat, call)
                        if was_paused:
                            await asyncio.wait_for(engine.pause(chat), 8)
                        call['position_seconds'] = new_offset
                        call['last_progress'] = time.monotonic()
                    except Exception:
                        call['subtitle_path'] = old_sub
                        call['subtitle_offset'] = old_sub_offset
                        call['offset'] = old_offset
                        raise
                else:
                    call['subtitle_path'] = sub_path
                    call['subtitle_offset'] = sub_offset
            elif op == 'seek':
                position = float(data['seconds'])
                if position < 0 or (call['duration'] > 0 and position >= call['duration']): raise VoiceFailure('INVALID_REQUEST')
                previous_offset = call['offset']; call['offset'] = position; paused = call['status'] == 'paused'
                try: await self.stream(a, chat, call)
                except Exception:
                    call['offset'] = previous_offset
                    raise
                if paused: await asyncio.wait_for(engine.pause(chat), 10)
                call['position_seconds'] = position; call['last_known_position'] = position; call['last_progress'] = time.monotonic()
            return {'ok': True, 'status': call['status'], 'position_seconds': call.get('position_seconds')}

    async def _close_dropped_call(self, a, chat, call, *, reason=None, probe_time=False, emit_event=False, ignore_leave_error=True):
        """Record the last known playback timestamp and release a dropped call cleanly."""
        pos = float(call.get('last_known_position') or call.get('offset') or 0.0)
        engine = a.get('engine') if a else None
        if probe_time and engine is not None and call.get('status') in {'playing', 'paused'}:
            try:
                elapsed = float(await asyncio.wait_for(engine.time(chat), 1.5))
                pos = max(pos, float(call.get('offset') or 0.0) + elapsed)
            except Exception:
                pass
        if call.get('duration'):
            pos = min(pos, max(0.0, float(call['duration']) - 1.0))
        pos = max(0.0, pos)
        if pos > 0:
            self.last_ended_positions[chat] = pos
        if engine is not None:
            clear_engine_cache(engine, chat)
            try:
                await asyncio.wait_for(engine.leave_call(chat), 10)
            except Exception as leave_error:
                if not ignore_leave_error and classify(leave_error) != 'NO_ACTIVE_CALL':
                    raise
        self.calls.pop(chat, None)
        self.prune_shifted_subtitles()
        if a is not None:
            self.release_destination(a, chat)
        if emit_event:
            if self.events.full():
                self.events.get_nowait()
            self.events.put_nowait({
                'chat_id': chat,
                'playback_id': call.get('playback_id'),
                'status': 'call_ended',
                'position_seconds': pos,
                'reason': reason,
            })
        return pos

    async def handle_chat_update(self, chat, reason=None, *, expected_alias=None):
        """Handle an external Telegram voice chat / group call termination event."""
        async with self.chat_lock(chat):
            call = self.calls.get(chat)
            if not call:
                return None
            if expected_alias and call.get('alias') != expected_alias:
                return None
            a = self.accounts.get(call['alias'])
            return await self._close_dropped_call(a, chat, call, reason=reason, probe_time=True, emit_event=True, ignore_leave_error=True)

    async def status(self, chat):
        async with self.chat_lock(chat):
            call = self.calls.get(chat)
            if not call: return {'ok': True, 'active': False, 'last_failure': self.last_failures.get(chat), 'last_position_seconds': self.last_ended_positions.get(chat)}
            a = self.accounts[call['alias']]
            if call['status'] in {'playing', 'paused'}:
                try:
                    elapsed = float(await asyncio.wait_for(a['engine'].time(chat), 5))
                    # Native NTgCalls BaseSink::time returns chrono::seconds, not milliseconds.
                    position = call['offset'] + elapsed
                    if position != call['position_seconds']: call['last_progress'] = time.monotonic()
                    call['position_seconds'] = position; call['last_known_position'] = position; call['clock_errors'] = 0
                    stall_sec = time.monotonic() - call['last_progress']
                    near_end = bool(call['duration'] and position >= max(0, min(call['duration'] - 3.0, call['duration'] * 0.88)))
                    if (call['duration'] and position >= call['duration'] - 0.5) or (near_end and stall_sec > 6):
                        call['status'] = 'ended'
                    elif call['status'] == 'playing' and stall_sec > 25:
                        call['status'] = 'error'
                except Exception as error:
                    if classify(error) == 'NO_ACTIVE_CALL':
                        # Definitive native absence is not a live call merely because
                        # its metadata remains cached. Confirm idempotent departure.
                        pos = await self._close_dropped_call(a, chat, call, reason='NO_ACTIVE_CALL', probe_time=False, emit_event=False, ignore_leave_error=False)
                        return {'ok': True, 'active': False, 'last_position_seconds': pos if pos > 0 else self.last_ended_positions.get(chat)}
                    call['clock_errors'] += 1; call['position_seconds'] = None
                    if call['clock_errors'] >= 3: call['status'] = 'error'
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
                call['offset'] = min(call.get('last_known_position', 0.0), max(0, call['duration'] - 1)) if call.get('duration') else max(0.0, call.get('last_known_position', 0.0))
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
                pos = await self._close_dropped_call(a, chat, call, reason='NO_ACTIVE_CALL', probe_time=False, emit_event=False, ignore_leave_error=True)
                return {'ok': True, 'active': False, 'last_failure': self.last_failures.get(chat), 'last_position_seconds': pos if pos > 0 else self.last_ended_positions.get(chat)}
            return {'ok': True, 'active': True, 'last_failure': self.last_failures.get(chat), 'info': {k: call.get(k) for k in ['status','playback_id','position_seconds','alias','video','volume','publisher_verified','publisher_muted','call_invite_link','subtitle_offset']}}

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
    async def call_invite(request): return web.json_response(await bridge.call_invite_link(int(request.query['chat_id'])))
    app.router.add_get('/events', events)
    app.router.add_get('/health', health); app.router.add_get('/accounts', accounts)
    app.router.add_post('/accounts/register', register); app.router.add_post('/accounts/configure', configure)
    app.router.add_post('/destination/setup', setup); app.router.add_post('/destination/existing-group', existing)
    app.router.add_post('/call/play', play); app.router.add_get('/call/status', status); app.router.add_get('/call/invite-link', call_invite)
    app.router.add_post('/call/{op:pause|resume|stop|idle|volume|seek|subtitle}', control)
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
