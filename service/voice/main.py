"""Lancy protocol-2 authenticated loopback bridge; queue ownership remains in Node.
No bot-token call fallback, no interactive credentials over HTTP, no persistent secrets.
"""
import asyncio
import hmac
import json
import logging
from logging.handlers import RotatingFileHandler
import os
import shlex
import signal
import secrets
import re
import sys
import threading
import time
import uuid
from pathlib import Path
from aiohttp import web

AV_SYNC_SCRIPT = str(Path(__file__).resolve().with_name('av_sync.py'))
AV_HUB_SCRIPT = str(Path(__file__).resolve().with_name('av_hub.py'))
RTMP_HUB_SCRIPT = str(Path(__file__).resolve().with_name('rtmp_hub.py'))
BROWSER_STREAM_SCRIPT = str(Path(__file__).resolve().with_name('browser_stream.py'))
_VOICE_DIR = Path(__file__).resolve().parent
if str(_VOICE_DIR) not in sys.path:
    sys.path.insert(0, str(_VOICE_DIR))
import av_hub
import av_sync
import browser_stream
import rtmp_streamer
import stt_engine
import sub_align
import tts_engine
import voice_listener

_INITIAL_PPID = os.getppid()
_ENV_PARENT_PID = os.environ.get('VOICE_BRIDGE_PARENT_PID')
_EXPECTED_PPID = int(_ENV_PARENT_PID) if (_ENV_PARENT_PID and _ENV_PARENT_PID.isdigit()) else _INITIAL_PPID


def _parent_exited():
    if _EXPECTED_PPID > 1:
        if os.getppid() != _EXPECTED_PPID:
            return True
        try:
            os.kill(_EXPECTED_PPID, 0)
        except ProcessLookupError:
            return True
        except PermissionError:
            pass
    elif _ENV_PARENT_PID:
        return True
    return False


if _ENV_PARENT_PID:
    av_sync._set_pdeathsig(signal.SIGTERM)
    if _parent_exited():
        sys.exit(0)


_CFG_REV_LOCK = threading.Lock()
_CFG_REV_COUNTER = 0


def _write_sub_config(
    sync_id,
    *,
    enabled,
    subtitle_path,
    base_sec,
    subtitle_offset,
    drift_sec_per_sec=0.0,
    drift_anchor_sec=0.0,
    manual_override=False,
    same_route=False,
    auto_normalize=True,
    force_check_seq=0,
    render_screen=True,
    pts_anchored=False,
):
    global _CFG_REV_COUNTER
    cfg_path = av_sync.sub_config_path_for(sync_id)
    with _CFG_REV_LOCK:
        disk_rev = 0
        try:
            if cfg_path.is_file():
                disk_rev = int((json.loads(cfg_path.read_text(encoding='utf-8')) or {}).get('cfg_rev') or 0)
        except Exception:
            disk_rev = 0
        _CFG_REV_COUNTER = max(_CFG_REV_COUNTER, disk_rev) + 1
        cfg_rev = _CFG_REV_COUNTER
    payload = {
        'enabled': bool(enabled and subtitle_path),
        'render_screen': bool(render_screen),
        'pts_anchored': bool(pts_anchored),
        'subtitle_path': str(subtitle_path or ''),
        'base_sec': round(float(base_sec or 0.0), 4),
        'subtitle_offset': round(float(subtitle_offset or 0.0), 3),
        'drift_sec_per_sec': round(sub_align.clamp_drift_rate(drift_sec_per_sec), 6),
        'drift_anchor_sec': round(float(drift_anchor_sec or 0.0), 3),
        'manual_override': bool(manual_override),
        'same_route': bool(same_route),
        'auto_normalize': bool(auto_normalize),
        'force_check_seq': int(force_check_seq or 0),
        'cfg_rev': cfg_rev,
    }
    tmp_path = cfg_path.with_name(f'{cfg_path.name}.{os.getpid()}.tmp')
    tmp_path.write_text(json.dumps(payload), encoding='utf-8')
    os.replace(tmp_path, cfg_path)
    return str(cfg_path)


def _write_dj_desk_config(sync_id, *, enabled=False, duration_sec=180.0, crossfade_sec=4.0, base_sec=0.0):
    cfg_path = av_sync.dj_desk_config_path_for(sync_id)
    payload = {
        'enabled': bool(enabled),
        'duration_sec': max(10.0, float(duration_sec or 180.0)),
        'crossfade_sec': max(0.0, min(12.0, float(crossfade_sec or 0.0))),
        'base_sec': max(0.0, float(base_sec or 0.0)),
    }
    tmp_path = cfg_path.with_name(f'{cfg_path.name}.{os.getpid()}.tmp')
    tmp_path.write_text(json.dumps(payload), encoding='utf-8')
    os.replace(tmp_path, cfg_path)
    return str(cfg_path)


def _read_sub_sync_snapshot(sync_id):
    if not sync_id:
        return None, None
    cfg = None
    st = None
    try:
        cp = av_sync.sub_config_path_for(sync_id)
        if cp.is_file():
            cfg = json.loads(cp.read_text(encoding='utf-8'))
    except Exception:
        cfg = None
    try:
        sp = av_sync.substatus_path_for(sync_id)
        if sp.is_file():
            st = json.loads(sp.read_text(encoding='utf-8'))
    except Exception:
        st = None
    return cfg, st


def _init_sync_state(sync_id, *, paused=False):
    shm_p = av_sync.shm_path_for(sync_id)
    if not sync_id:
        return False
    state = None
    fd = None
    mm = None
    try:
        fd, mm, state = av_sync._open_sync_state(shm_p)
        state.paused = 1 if paused else 0
        state.audio_sec = 0.0
        state.video_sec = 0.0
        state.epoch_pts_sec = 0.0
        state.sync_flags = 0
        state.skew_ms = 0
        if hasattr(state, 'pipeline_delay_sec'):
            state.pipeline_delay_sec = 0.0
        return True
    except Exception:
        return False
    finally:
        state = None
        if mm is not None:
            try:
                mm.close()
            except Exception:
                pass
        if fd is not None:
            try:
                os.close(fd)
            except Exception:
                pass


def _mutate_sync_state(sync_id, mutator):
    shm_p = av_sync.shm_path_for(sync_id)
    if not sync_id or not shm_p.is_file():
        return False
    state = None
    try:
        fd, mm, state = av_sync._open_sync_state(shm_p)
    except Exception:
        return False
    try:
        mutator(state)
        return True
    except Exception:
        return False
    finally:
        state = None
        try:
            mm.close()
        except Exception:
            pass
        try:
            os.close(fd)
        except Exception:
            pass


def _bump_sub_gen(sync_id):
    def _inc(st):
        st.sub_gen = int(st.sub_gen) + 1
    return _mutate_sync_state(sync_id, _inc)


_ISO_LANG_ALIAS = {
    'ja': 'ja', 'jpn': 'ja', 'jap': 'ja', 'japanese': 'ja',
    'en': 'en', 'eng': 'en', 'english': 'en',
    'ko': 'ko', 'kor': 'ko', 'korean': 'ko',
    'zh': 'zh', 'zho': 'zh', 'chi': 'zh', 'cmn': 'zh', 'yue': 'zh', 'chinese': 'zh',
    'es': 'es', 'spa': 'es', 'spanish': 'es',
    'fr': 'fr', 'fra': 'fr', 'fre': 'fr', 'french': 'fr',
    'de': 'de', 'deu': 'de', 'ger': 'de', 'german': 'de',
    'it': 'it', 'ita': 'it', 'italian': 'it',
    'ru': 'ru', 'rus': 'ru', 'russian': 'ru',
    'ar': 'ar', 'ara': 'ar', 'arabic': 'ar',
    'hi': 'hi', 'hin': 'hi', 'hindi': 'hi',
    'pt': 'pt', 'por': 'pt', 'portuguese': 'pt',
    'tr': 'tr', 'tur': 'tr', 'turkish': 'tr',
    'th': 'th', 'tha': 'th', 'thai': 'th',
    'id': 'id', 'ind': 'id', 'indonesian': 'id',
    'vi': 'vi', 'vie': 'vi', 'vietnamese': 'vi',
    'pl': 'pl', 'pol': 'pl', 'polish': 'pl',
    'nl': 'nl', 'nld': 'nl', 'dut': 'nl', 'dutch': 'nl',
    'sv': 'sv', 'swe': 'sv', 'no': 'no', 'nor': 'no', 'da': 'da', 'dan': 'da', 'fi': 'fi', 'fin': 'fi',
    'he': 'he', 'heb': 'he', 'fa': 'fa', 'per': 'fa', 'fas': 'fa',
    'ta': 'ta', 'tam': 'ta', 'te': 'te', 'tel': 'te', 'ml': 'ml', 'mal': 'ml',
}


def _norm_lang(raw):
    s = re.split(r'[-_\s]', str(raw or '').strip().lower())[0]
    if not s or s in {'und', 'auto', 'unknown', 'none'}:
        return ''
    return _ISO_LANG_ALIAS.get(s, s)


def _set_sync_paused(sync_id, paused):
    def _upd(st):
        st.paused = 1 if paused else 0
    return _mutate_sync_state(sync_id, _upd)


def _set_sync_tts_hold(sync_id, hold):
    def _upd(st):
        st.tts_hold = 1 if hold else 0
    return _mutate_sync_state(sync_id, _upd)


def _set_sync_duck(sync_id, active):
    def _upd(st):
        if hasattr(st, 'duck_active'):
            st.duck_active = 1 if active else 0
    return _mutate_sync_state(sync_id, _upd)


def _get_sync_tts_play_end(sync_id):
    shm_p = av_sync.shm_path_for(sync_id)
    if not sync_id or not shm_p.is_file():
        return 0.0
    fd = mm = None
    try:
        fd, mm, st = av_sync._open_sync_state(shm_p)
        return float(getattr(st, 'tts_play_end_mono', 0.0) or 0.0)
    except Exception:
        return 0.0
    finally:
        if mm is not None:
            try: mm.close()
            except Exception: pass
        if fd is not None:
            try: os.close(fd)
            except Exception: pass


def _write_vchud_state(
    sync_id,
    *,
    active=True,
    mode='listening',
    speaker_name='',
    user_text='',
    lancy_text='',
    theme='neon_rose',
    ttl_sec=35.0,
):
    if not sync_id:
        return None
    p = av_sync.vchud_config_path_for(sync_id)
    if not active:
        try:
            p.unlink(missing_ok=True)
        except Exception:
            pass
        return None
    payload = {
        'active': True,
        'mode': str(mode or 'listening'),
        'speaker_name': str(speaker_name or '')[:40],
        'user_text': str(user_text or '')[:180],
        'lancy_text': str(lancy_text or '')[:260],
        'theme': str(theme or 'neon_rose'),
        'updated_at': time.time(),
        'expires_at': time.time() + max(2.5, float(ttl_sec or 35.0)),
    }
    tmp = p.with_suffix('.tmp')
    tmp.write_text(json.dumps(payload), encoding='utf-8')
    os.replace(tmp, p)
    return p


def _read_sync_metrics(sync_id):
    out = {}

    def _rd(st):
        now_m = time.monotonic()
        epoch = max(0.0, float(getattr(st, 'epoch_pts_sec', 0.0) or 0.0))
        a = max(0.0, float(st.audio_sec or 0.0) - epoch)
        v = max(0.0, float(st.video_sec or 0.0) - epoch)
        a_st = int(st.audio_state)
        v_st = int(st.video_state)
        if a_st == 1 and v_st == 1:
            pos = min(a, v) if (a > 0.0 and v > 0.0) else max(a, v)
        elif v_st == 1:
            pos = v
        else:
            pos = a
        hb_ages = []
        a_hb = float(getattr(st, 'audio_hb_mono', 0.0) or 0.0)
        v_hb = float(getattr(st, 'video_hb_mono', 0.0) or 0.0)
        if a_st == 1 and a_hb > 0.0:
            hb_ages.append(max(0.0, now_m - a_hb))
        if v_st == 1 and v_hb > 0.0:
            hb_ages.append(max(0.0, now_m - v_hb))
        hb_age = max(hb_ages) if hb_ages else 0.0
        sync_flags = int(st.sync_flags)
        waiting_mask = int(getattr(st, 'waiting_mask', 0) or 0)
        skew_ms = int(st.skew_ms)
        paused = bool(int(st.paused) == 1)
        stalled = bool((not paused) and hb_age > av_sync.STALL_HEARTBEAT_TIMEOUT_SEC)
        syncing = bool((not paused) and ((sync_flags & 3) != 0 or abs(skew_ms) >= 220))
        if stalled:
            health = 'stalled'
        elif (sync_flags & 3) != 0:
            health = 'syncing'
        elif abs(skew_ms) >= 220:
            health = 'drifted'
        elif abs(skew_ms) >= 110 or (waiting_mask & 3) != 0:
            health = 'correcting'
        else:
            health = 'locked'
        out['media_pts_sec'] = round(max(0.0, pos), 3)
        out['audio_sec'] = round(a, 3)
        out['video_sec'] = round(v, 3)
        out['paused'] = paused
        out['sync_flags'] = sync_flags
        out['waiting_mask'] = waiting_mask
        out['skew_ms'] = skew_ms
        out['audio_state'] = a_st
        out['video_state'] = v_st
        out['hb_age_sec'] = round(hb_age, 2)
        out['syncing'] = syncing
        out['sync_health'] = health
        out['pipeline_delay_sec'] = round(max(0.0, float(getattr(st, 'pipeline_delay_sec', 0.0) or 0.0)), 3)

    if _mutate_sync_state(sync_id, _rd):
        return out
    return None

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
    'POOL_EXHAUSTED': 'All active playback assistants are currently streaming video in other chats. Try again after a show finishes or add another assistant.',
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


def _upsert_ffmpeg_input_sync_flags(args, *, pre_seek=None, copyts=False, input_url=None):
    """Ensure -copyts and input -ss appear strictly before -i when hybrid synchronized seeking is active."""
    cleaned = []
    skip_next = False
    replace_next_input = False
    for tok in args:
        if skip_next:
            skip_next = False
            continue
        if replace_next_input:
            replace_next_input = False
            cleaned.append(str(input_url) if input_url else tok)
            continue
        if tok == '-copyts':
            continue
        if (pre_seek is not None or copyts) and tok == '-ss':
            skip_next = True
            continue
        if tok == '-i' and input_url:
            replace_next_input = True
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
    pts_anchor=None,
    pre_seek=None,
    copyts=False,
    input_url=None,
    skip_scale=False,
):
    """Ensure a single consolidated -vf pipeline outputting exact width:height yuv420p frames aligned to audio PTS."""
    w = max(2, int(width) - (int(width) % 2))
    h = max(2, int(height) - (int(height) % 2))
    vf_parts = []
    if trim_start is not None and not is_image:
        vf_parts.append(f'trim=start={float(trim_start):.3f}')
    if pts_anchor is not None and not is_image:
        vf_parts.append(f'setpts=PTS-{float(pts_anchor):.3f}/TB')
    elif (normalize_pts or trim_start is not None) and not is_image:
        vf_parts.append('setpts=PTS-STARTPTS')
    if fps is not None and not is_image and float(fps) > 0:
        fps_f = float(fps)
        fps_str = str(int(round(fps_f))) if abs(fps_f - round(fps_f)) < 1e-3 else f'{fps_f:.3f}'.rstrip('0').rstrip('.')
        if pts_anchor is not None:
            vf_parts.append(f'fps=fps={fps_str}:start_time=0')
        else:
            vf_parts.append(f'fps=fps={fps_str}')
    if skip_scale and not is_image:
        vf_parts.append('setsar=1')
    else:
        vf_parts.extend([f'scale={w}:{h}:flags=lanczos', 'setsar=1'])
    if subtitle_path:
        esc_sub = str(subtitle_path).replace('\\', '\\\\').replace(':', '\\:').replace("'", "\\'").replace('[', '\\[').replace(']', '\\]')
        vf_parts.append(f"subtitles='{esc_sub}':force_style='FontSize=20,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&H60000000,BorderStyle=1,Outline=2,Shadow=1,MarginV=22'")
    vf_parts.append('format=yuv420p')
    vf_expr = ','.join(vf_parts)

    fps_tok = None
    if fps is not None and not is_image and float(fps) > 0:
        fps_f = float(fps)
        fps_tok = str(int(round(fps_f))) if abs(fps_f - round(fps_f)) < 1e-3 else f'{fps_f:.3f}'.rstrip('0').rstrip('.')

    args = _upsert_ffmpeg_input_sync_flags(shlex.split(str(cmd_str)), pre_seek=pre_seek, copyts=copyts, input_url=input_url)
    cleaned = []
    skip_next = False
    has_map = False
    saw_input_arg = False
    in_output_section = False
    replace_next_r = False
    for tok in args:
        if skip_next:
            skip_next = False
            continue
        if saw_input_arg:
            saw_input_arg = False
            in_output_section = True
            cleaned.append(tok)
            continue
        if replace_next_r:
            replace_next_r = False
            cleaned.append(fps_tok)
            continue
        if tok in {'-vf', '-filter:v', '-reconnect_at_eof'}:
            skip_next = True
            continue
        if tok == '-i':
            saw_input_arg = True
        elif tok == '-r' and in_output_section and fps_tok:
            replace_next_r = True
        elif tok == '-map':
            has_map = True
        cleaned.append(tok)

    out_args = []
    inserted_map = False
    inserted_vf = False
    for tok in cleaned:
        if not inserted_map and tok == '-f':
            if not has_map and stream_index is not None and video_count > 1 and not is_image:
                out_args.extend(['-map', f'0:{int(stream_index)}'])
            out_args.extend(['-an', '-sn', '-dn'])
            inserted_map = True
        if not inserted_vf and tok.startswith('pipe:'):
            out_args.extend(['-vf', vf_expr])
            inserted_vf = True
        out_args.append(tok)
    if not inserted_vf:
        out_args.extend(['-vf', vf_expr])
    return shlex.join(out_args)


def wrap_av_sync_pair(
    audio_cmd,
    video_cmd,
    *,
    frame_bytes,
    fps=30,
    sample_rate=48000,
    channels=2,
    sync_id=None,
    width=0,
    height=0,
    sub_config_path=None,
    dj_config_path=None,
    music_freerun=False,
):
    """Wrap matched microphone/camera FFmpeg commands in a synchronized startup barrier and drift monitor."""
    if not audio_cmd or not video_cmd or int(frame_bytes or 0) <= 0:
        return audio_cmd, video_cmd
    if not os.path.isfile(AV_SYNC_SCRIPT):
        return audio_cmd, video_cmd
    sid = re.sub(r'[^a-zA-Z0-9_-]', '_', str(sync_id or uuid.uuid4().hex))[:64]
    # NTgCalls ShellReader uses boost::process::v2::environment::find_executable(), which
    # expects a bare command name in PATH (like "ffmpeg") rather than a slash path.
    py = 'python3'
    script = shlex.quote(AV_SYNC_SCRIPT)
    eff_fps = max(1.0, float(fps or 30))
    # Lazily prune stale shm & sub config/status files (>30m old)
    shm_dir = Path('/dev/shm') if Path('/dev/shm').is_dir() else Path('/tmp')
    try:
        cutoff = time.time() - 1800
        for pat in ('lancy-av-*.shm', 'lancy-sub-*.json', 'lancy-djdesk-*.json', 'lancy-substatus-*.json'):
            for p in shm_dir.glob(pat):
                try:
                    if p.stat().st_mtime < cutoff:
                        p.unlink(missing_ok=True)
                except Exception:
                    pass
    except Exception:
        pass
    audio_sub_flag = f' --sub-config {shlex.quote(str(sub_config_path))}' if sub_config_path else ''
    audio_dj_flag = f' --dj-config {shlex.quote(str(dj_config_path))}' if dj_config_path else ''
    freerun_flag = ' --music-freerun' if music_freerun else ''
    wrapped_a = (
        f'{py} {script} --role audio --sync-id {shlex.quote(sid)} '
        f'--sample-rate {int(sample_rate)} --channels {int(channels)} --fps {eff_fps:.3f}{audio_sub_flag}{audio_dj_flag}{freerun_flag} -- {audio_cmd}'
    )
    sub_flags = ''
    has_geom = int(width or 0) > 0 and int(height or 0) > 0
    if has_geom and (sub_config_path or dj_config_path):
        sub_flags = f' --width {int(width)} --height {int(height)}'
        if sub_config_path:
            sub_flags += f' --sub-config {shlex.quote(str(sub_config_path))}'
        if dj_config_path:
            sub_flags += f' --dj-config {shlex.quote(str(dj_config_path))}'
    wrapped_v = (
        f'{py} {script} --role video --sync-id {shlex.quote(sid)} '
        f'--frame-bytes {int(frame_bytes)} --fps {eff_fps:.3f}{sub_flags}{freerun_flag} -- {video_cmd}'
    )
    return wrapped_a, wrapped_v


def _extract_av_output_opts(args, *, is_video):
    out_map = None
    vf_val = None
    af_val = None
    fps_val = None
    i = 0
    while i < len(args):
        tok = args[i]
        if tok == '-map' and i + 1 < len(args):
            out_map = args[i + 1]
            i += 2
            continue
        if is_video and tok in {'-vf', '-filter:v'} and i + 1 < len(args):
            vf_val = args[i + 1]
            i += 2
            continue
        if is_video and tok == '-r' and i + 1 < len(args):
            fps_val = args[i + 1]
            i += 2
            continue
        if (not is_video) and tok in {'-af', '-filter:a'} and i + 1 < len(args):
            af_val = args[i + 1]
            i += 2
            continue
        i += 1
    return out_map, vf_val, af_val, fps_val


def build_unified_av_ffmpeg_command(audio_cmd, video_cmd, *, output_format='raw'):
    """Merge matched audio & video FFmpeg commands into ONE single-demuxer FFmpeg command.

    Supports both interleaved `-f nut` (output_format='nut', preserving per-packet PTS)
    and legacy dual-pipe raw (`output_format='raw'` using `av_hub.AUDIO_PIPE_PLACEHOLDER`).
    """
    if not audio_cmd or not video_cmd:
        return None
    try:
        v_args = shlex.split(str(video_cmd))
        a_args = shlex.split(str(audio_cmd))
    except ValueError:
        return None

    if not v_args or not a_args:
        return None
    if os.path.basename(v_args[0]) != 'ffmpeg' or os.path.basename(a_args[0]) != 'ffmpeg':
        return None
    if '-i' not in v_args or '-i' not in a_args:
        return None

    vi = v_args.index('-i')
    ai = a_args.index('-i')
    if vi + 1 >= len(v_args) or ai + 1 >= len(a_args):
        return None
    if v_args[vi + 1] != a_args[ai + 1]:
        return None

    # Require identical input -ss seek offsets before sharing the single demuxer.
    def _pre_ss(prefix):
        for k in range(len(prefix) - 1):
            if prefix[k] == '-ss':
                try:
                    return float(prefix[k + 1])
                except ValueError:
                    return None
        return 0.0

    v_ss = _pre_ss(v_args[:vi])
    a_ss = _pre_ss(a_args[:ai])
    if v_ss is None or a_ss is None or abs(v_ss - a_ss) > 0.02:
        return None

    v_prefix = v_args[:vi + 2]
    v_out = v_args[vi + 2:]
    a_out = list(a_args[ai + 2:])
    if 'pipe:1' not in v_out or 'pipe:1' not in a_out:
        return None

    if str(output_format or 'raw').lower() == 'nut':
        v_map, v_vf, _, v_r = _extract_av_output_opts(v_out, is_video=True)
        a_map, _, a_af, _ = _extract_av_output_opts(a_out, is_video=False)
        out = [
            *v_prefix,
            '-map', v_map or '0:v:0',
            '-map', a_map or '0:a:0',
            '-sn', '-dn',
        ]
        if v_vf:
            out.extend(['-vf', v_vf])
        if v_r:
            out.extend(['-r', v_r])
        if a_af:
            if 'asetpts=PTS-' in a_af and 'asetpts=PTS-STARTPTS' not in a_af:
                a_af = re.sub(r':first_pts=0\b', '', a_af)
            out.extend(['-af', a_af])
        out.extend([
            '-c:v', 'rawvideo', '-pix_fmt', 'yuv420p',
            '-c:a', 'pcm_s16le', '-ac', '2', '-ar', '48000',
            '-write_index', '0',
            '-f', 'nut', 'pipe:1',
        ])
        return shlex.join(out)

    replaced_audio_pipe = False
    for idx in range(len(a_out) - 1, -1, -1):
        if a_out[idx] == 'pipe:1':
            a_out[idx] = av_hub.AUDIO_PIPE_PLACEHOLDER
            replaced_audio_pipe = True
            break
    if not replaced_audio_pipe:
        return None

    return shlex.join([*v_prefix, *v_out, *a_out])


def rewrite_audio_ffmpeg_command(
    cmd_str,
    *,
    stream_index=None,
    audio_count=1,
    pre_seek=None,
    copyts=False,
    trim_start=None,
    normalize_pts=False,
    pts_anchor=None,
    strip_first_pts_zero=False,
    input_url=None,
):
    """Align microphone FFmpeg stream selection, trim offset, and PTS to the active video pipeline."""
    args = _upsert_ffmpeg_input_sync_flags(shlex.split(str(cmd_str)), pre_seek=pre_seek, copyts=copyts, input_url=input_url)
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
    if pts_anchor is not None:
        af_parts.append(f'asetpts=PTS-{float(pts_anchor):.3f}/TB')
    elif normalize_pts or trim_start is not None:
        af_parts.append('asetpts=PTS-STARTPTS')
    base_af = af_value or ('aresample=48000:async=1' if copyts else 'aresample=48000')
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


_DUB_TITLE_RE = re.compile(
    r'\b(?:dub(?:s|bed|bing)?|fandub|dublado|doublage|vff|vfq|vf|truefrench|latino|castellano|voice\s*over|voiceover|(?:english|eng|french|fre|fra|spanish|spa|esp|hindi|hin|german|ger|deu|italian|ita|portuguese|por|russian|rus|arabic|ara|turkish|tur|korean|kor|japanese|jpn|chinese|chi|zho|thai|tha|indonesian|ind|vietnamese|vie|polish|pol|dutch|dut|nld)\s*(?:dub(?:s|bed|bing)?|voice\s*over|voiceover|version))\b',
    re.IGNORECASE,
)


def _is_dub_audio_stream(disp, title, lang='', preferred_lang=None):
    disp = disp or {}
    t = str(title or '')
    if disp.get('dub') or _DUB_TITLE_RE.search(t):
        return True
    pref = _norm_lang(preferred_lang)
    st_lang = _norm_lang(lang)
    if pref and st_lang and st_lang != pref and not disp.get('original'):
        return True
    return False


def _pick_primary_audio_stream(audio_streams, preferred_lang=None):
    if not audio_streams:
        return None
    pref = _norm_lang(preferred_lang)

    def _meta(st):
        disp = st.get('disposition') or {}
        tags = st.get('tags') or {}
        lang = _norm_lang(tags.get('language'))
        title = str(tags.get('title') or tags.get('handler_name') or '').lower()
        is_dub = _is_dub_audio_stream(disp, title, lang=lang, preferred_lang=pref)
        is_orig = bool(disp.get('original')) or (bool(re.search(r'\b(?:main|original|orig|raw|native)\b', title)) and not is_dub)
        is_comm = bool(disp.get('comment') or disp.get('descriptions') or disp.get('visual_impaired')) or any(
            k in title for k in ('commentary', 'description', 'descriptive', 'director', 'audio description')
        )
        return disp, lang, is_dub, is_orig, is_comm

    def score(st):
        disp, lang, is_dub, is_orig, is_comm = _meta(st)
        pts = 0
        if pref:
            if lang == pref:
                pts += 150
            elif lang:
                pts -= 80
        if is_orig:
            pts += 80
        if is_dub:
            pts -= 140
        if is_comm:
            pts -= 120
        if disp.get('default') and not is_dub and not is_comm:
            pts += 15
        try:
            ch = int(st.get('channels') or 0)
            if ch >= 6:
                pts += 4
            elif ch == 2:
                pts += 2
        except Exception:
            pass
        return pts

    chosen = max(audio_streams, key=score)
    return chosen


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


async def probe_media_stream_info(path, preferred_lang=None):
    """Probe primary video and audio stream indices, dimensions, fps, duration, and start timestamps."""
    proc = None
    try:
        proc = await asyncio.create_subprocess_exec(
            'ffprobe', '-v', 'error', '-probesize', '2000000', '-analyzeduration', '2000000',
            '-show_entries', 'stream=index,codec_type,codec_name,width,height,channels,start_time,avg_frame_rate,r_frame_rate',
            '-show_entries', 'stream_tags=language,title,handler_name:stream_disposition=default,original,dub,comment,descriptions,visual_impaired,attached_pic:format=format_name,start_time,duration',
            '-of', 'json', str(path),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
        info = json.loads((stdout or b'{}').decode('utf-8'))
        all_streams = info.get('streams') or []
        fmt = info.get('format') or {}
        fmt_start = _parse_start_time(fmt.get('start_time'))
        fmt_duration = _parse_start_time(fmt.get('duration'))
        fmt_name = str(fmt.get('format_name') or '').lower()
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
        chosen_audio = _pick_primary_audio_stream(audio_streams, preferred_lang=preferred_lang)
        a_idx = chosen_audio.get('index') if chosen_audio else None
        a_start = _parse_start_time(chosen_audio.get('start_time')) if chosen_audio else None
        if chosen_audio and a_start is None:
            a_start = fmt_start
        a_tags = (chosen_audio.get('tags') or {}) if chosen_audio else {}
        a_disp = (chosen_audio.get('disposition') or {}) if chosen_audio else {}
        a_lang = _norm_lang(a_tags.get('language'))
        a_title = str(a_tags.get('title') or a_tags.get('handler_name') or '').lower()
        a_is_dub = _is_dub_audio_stream(a_disp, a_title, lang=a_lang, preferred_lang=preferred_lang)

        return {
            'width': int(chosen_video['width']),
            'height': int(chosen_video['height']),
            'stream_index': int(v_idx) if v_idx is not None else None,
            'video_count': len(video_streams),
            'is_image': is_image,
            'video_start_time': v_start,
            'format_start_time': fmt_start,
            'fps': v_fps,
            'duration': fmt_duration,
            'format_name': fmt_name,
            'audio_stream_index': int(a_idx) if a_idx is not None else None,
            'audio_count': len(audio_streams),
            'audio_start_time': a_start,
            'audio_language': a_lang or None,
            'audio_is_dub': a_is_dub,
        }
    except Exception:
        if proc and proc.returncode is None:
            try: proc.kill()
            except Exception: pass
    return None


async def probe_initial_packet_pts(path, video_stream_index=None, audio_stream_index=None):
    """Probe earliest decoded video & audio packet PTS (seconds) with split-rendition fallback."""
    async def _run_pkt_probe(extra_args, timeout_sec=5.5):
        proc = None
        try:
            proc = await asyncio.create_subprocess_exec(
                'ffprobe', '-v', 'error', *extra_args,
                '-show_entries', 'packet=codec_type,stream_index,pts_time,dts_time',
                '-of', 'csv=p=0', str(path),
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout_sec)
            vv, av = [], []
            for line in (stdout or b'').decode('utf-8', 'replace').splitlines():
                parts = [p.strip() for p in line.split(',')]
                if len(parts) < 3:
                    continue
                ctype = parts[0]
                try:
                    s_idx = int(parts[1])
                except Exception:
                    s_idx = None
                val = _parse_start_time(parts[2])
                if val is None and len(parts) >= 4:
                    val = _parse_start_time(parts[3])
                if val is None:
                    continue
                if ctype == 'video' and (video_stream_index is None or s_idx is None or s_idx == int(video_stream_index)):
                    vv.append(val)
                elif ctype == 'audio' and (audio_stream_index is None or s_idx is None or s_idx == int(audio_stream_index)):
                    av.append(val)
            return vv, av
        except Exception:
            if proc and proc.returncode is None:
                try: proc.kill()
                except Exception: pass
            return [], []

    v_vals, a_vals = await _run_pkt_probe(['-read_intervals', '%+#300'], timeout_sec=6.0)
    if not v_vals or not a_vals:
        followups = []
        if not v_vals:
            v_sel = f'0:{int(video_stream_index)}' if video_stream_index is not None else 'v:0'
            followups.append(('v', _run_pkt_probe(['-select_streams', v_sel, '-read_intervals', '%+#8'], timeout_sec=5.0)))
        if not a_vals:
            a_sel = f'0:{int(audio_stream_index)}' if audio_stream_index is not None else 'a:0'
            followups.append(('a', _run_pkt_probe(['-select_streams', a_sel, '-read_intervals', '%+#12'], timeout_sec=5.0)))
        if followups:
            res_list = await asyncio.gather(*(c for _, c in followups))
            for (kind, _), (fv, fa) in zip(followups, res_list):
                if kind == 'v' and not v_vals:
                    v_vals = fv
                elif kind == 'a' and not a_vals:
                    a_vals = fa
    return (min(v_vals) if v_vals else None), (min(a_vals) if a_vals else None)


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
        self.secondary_tiles = {}
        self.prepared = {}
        self.last_failures = {}
        self.last_ended_positions = {}
        self.events = asyncio.Queue(maxsize=100)
        self.lock = asyncio.Lock()  # only lease assignment/configuration, never network I/O
        self.chat_locks = {}
        self.closing = False
        self._sync_monitor_task = None
        self.sync_monitor_interval_sec = 2.5
        self.allow_auto_resync_in_tests = False
        self.tts = tts_engine.TtsEngine(cache_dir=self.root)
        self.stt = stt_engine.SttEngine(cache_dir=self.root)
        self.enable_gemini_live = (factory is None) and bool(os.environ.get('GEMINI_API_KEY'))
        self.voice_listener = voice_listener.VoiceListenerManager(bridge=self, stt_engine=self.stt)
        self._audio_lang_cache = {}
        self._native_call_cache = {}
        self._native_call_inflight = {}
        self._full_channel_flood_until = {}

    def chat_lock(self, chat): return self.chat_locks.setdefault(chat, asyncio.Lock())

    async def register(self, data):
        import re
        alias = str(data.get('alias', ''))
        if not re.fullmatch(r'[a-z0-9_-]{1,24}', alias): raise VoiceFailure('INVALID_REQUEST')
        async with self.lock:
            existing_acc = self.accounts.get(alias)
            if existing_acc:
                if existing_acc.get('status') == 'authentication_required' and existing_acc.get('client') is None and not existing_acc.get('leases'):
                    self.accounts.pop(alias, None)
                else:
                    raise VoiceFailure('ACCOUNT_UNAVAILABLE')
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
                try:
                    from pytgcalls.types import StreamFrames
                except Exception:
                    StreamFrames = None
                client = Client(f'lancy_{alias}', api_id=int(os.environ['TELEGRAM_API_ID']), api_hash=os.environ['TELEGRAM_API_HASH'], session_string=data['session'], in_memory=True, sleep_threshold=2)
                await asyncio.wait_for(client.start(), 30)
                me = getattr(client, 'me', None) or await asyncio.wait_for(client.get_me(), 10)
                if me.is_bot:
                    await client.stop()
                    raise VoiceFailure('SESSION_NOT_READY')
                uid = me.id
                engine = PyTgCalls(client, cache_duration=180)
                @engine.on_update()
                async def update(_, event):
                    if StreamFrames is not None and isinstance(event, StreamFrames):
                        self.voice_listener.handle_incoming_frames(alias, event.chat_id, event.frames)
                        return
                    if isinstance(event, ChatUpdate) and bool(event.status & ChatUpdate.Status.LEFT_CALL):
                        await self.handle_chat_update(event.chat_id, str(event.status), expected_alias=alias)
                        return
                    if isinstance(event, StreamEnded) and event.device == Device.MICROPHONE and event.stream_type == StreamEnded.Type.AUDIO:
                        # Native events have no source identity. Do not attach a new track's ID
                        # to a late old event. Corroborate completion against native media time.
                        async with self.chat_lock(event.chat_id):
                            call = self.calls.get(event.chat_id)
                            if not call or call['alias'] != alias or call['status'] != 'playing': return
                            if time.monotonic() - float(call.get('last_seek_at') or 0.0) < 2.5:
                                return
                            try:
                                raw_elapsed = float(await engine.time(event.chat_id))
                                base_t = float(call.get('engine_time_base') or 0.0)
                                elapsed = max(0.0, raw_elapsed - base_t) if raw_elapsed >= base_t else raw_elapsed
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
                @client.on_raw_update()
                async def on_raw_vc(_, raw_upd, users=None, chats=None):
                    try:
                        from pyrogram import raw as _raw
                        if isinstance(raw_upd, _raw.types.UpdateGroupCallMessage):
                            await self._handle_group_call_message(alias, raw_upd, users or {}, chats or {})
                    except Exception:
                        pass
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
                if not self.factory and account.get('uid') and (isinstance(error, (TimeoutError, ConnectionError, OSError)) or classify(error) in {'RATE_LIMITED', 'NO_ACTIVE_CALL'}):
                    log.warning('Transient account health check error alias=%s kind=%s', account.get('alias'), type(error).__name__)
                    continue
                log.warning('Account health failed alias=%s kind=%s', account.get('alias'), type(error).__name__)
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

    def _active_video_calls_for_account(self, alias):
        count = 0
        for c in self.calls.values():
            if c.get('alias') == alias and c.get('video') and c.get('status') in {'playing', 'paused', 'buffering'}:
                count += 1
        for tile in self.secondary_tiles.values():
            if tile.get('alias') == alias and tile.get('status') in {'playing', 'paused', 'buffering'}:
                count += 1
        return count

    async def lease(self, chat, alias=None, *, exclude_aliases=None, for_video=False, max_video_calls=None):
        excluded = set(exclude_aliases or ())
        async with self.lock:
            existing = None if excluded else (self.calls.get(chat) or self.prepared.get(chat))
            if existing:
                account = self.accounts.get(existing['alias'])
                if not account or (alias and alias != account['alias']): raise VoiceFailure('ACCOUNT_UNAVAILABLE')
            else:
                candidates = [
                    a for a in self.accounts.values()
                    if a['enabled']
                    and a['status'] == 'available'
                    and a['alias'] not in excluded
                    and self.destination_authorized(a, chat)
                    and (not alias or a['alias'] == alias)
                ]
                if not candidates: raise VoiceFailure('ACCOUNT_UNAVAILABLE' if (alias or excluded) else 'SESSION_NOT_READY')
                if for_video and max_video_calls is not None and int(max_video_calls) >= 1:
                    cap = int(max_video_calls)
                    under_cap = [a for a in candidates if self._active_video_calls_for_account(a['alias']) < cap]
                    if not under_cap:
                        raise VoiceFailure('POOL_EXHAUSTED')
                    candidates = under_cap
                account = min(candidates, key=lambda a: (self._active_video_calls_for_account(a['alias']), len(a['leases']), a['alias']))
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

    def _native_call_cache_key(self, client, chat):
        try:
            cid = int(chat)
        except Exception:
            cid = str(chat)
        return (id(client), cid)

    def _invalidate_native_call_cache(self, client=None, chat=None):
        cache = getattr(self, '_native_call_cache', None)
        if not cache:
            return
        if client is None and chat is None:
            cache.clear()
            return
        if chat is not None and client is not None:
            cache.pop(self._native_call_cache_key(client, chat), None)
            return
        try:
            target_cid = int(chat) if chat is not None else None
        except Exception:
            target_cid = str(chat) if chat is not None else None
        for k in list(cache.keys()):
            if (client is None or k[0] == id(client)) and (target_cid is None or k[1] == target_cid):
                cache.pop(k, None)

    async def native_call(self, client, chat):
        from pyrogram import raw
        now_m = time.monotonic()
        if not hasattr(self, '_native_call_cache'):
            self._native_call_cache = {}
        if not hasattr(self, '_native_call_inflight'):
            self._native_call_inflight = {}
        if not hasattr(self, '_full_channel_flood_until'):
            self._full_channel_flood_until = {}

        ckey = self._native_call_cache_key(client, chat)
        ttl_sec = 0.0 if self.factory else 3.0
        cached = self._native_call_cache.get(ckey)
        if cached and ttl_sec > 0.0 and (now_m - cached[0]) < ttl_sec:
            return cached[1], cached[2]

        client_flood_until = float(self._full_channel_flood_until.get(id(client)) or 0.0)
        if not self.factory and now_m < client_flood_until:
            if cached and (now_m - cached[0]) < 60.0:
                return cached[1], cached[2]
            raise VoiceFailure('RATE_LIMITED', {'retry_after': max(1, int(round(client_flood_until - now_m)))})

        inflight = self._native_call_inflight.get(ckey)
        if inflight is not None and not inflight.done():
            return await inflight

        async def _fetch():
            peer = await asyncio.wait_for(client.resolve_peer(chat), 15)
            if isinstance(peer, raw.types.InputPeerChannel):
                request = raw.functions.channels.GetFullChannel(channel=raw.types.InputChannel(channel_id=peer.channel_id, access_hash=peer.access_hash))
            elif isinstance(peer, raw.types.InputPeerChat):
                request = raw.functions.messages.GetFullChat(chat_id=peer.chat_id)
            else:
                raise VoiceFailure('PERMISSION_DENIED')
            threshold = 0 if self.factory else 2
            try:
                full = await asyncio.wait_for(client.invoke(request, sleep_threshold=threshold), 15)
            except Exception as err:
                if type(err).__name__ == 'FloodWait':
                    wait_sec = max(1, int(getattr(err, 'value', 10) or 10))
                    self._full_channel_flood_until[id(client)] = time.monotonic() + min(wait_sec, 30)
                    stale = self._native_call_cache.get(ckey)
                    if stale and (time.monotonic() - stale[0]) < 60.0:
                        return stale[1], stale[2]
                raise
            call_obj = getattr(full.full_chat, 'call', None)
            self._native_call_cache[ckey] = (time.monotonic(), peer, call_obj)
            if len(self._native_call_cache) > 256:
                self._native_call_cache.pop(next(iter(self._native_call_cache)), None)
            return peer, call_obj

        task = asyncio.create_task(_fetch())
        self._native_call_inflight[ckey] = task
        try:
            return await task
        finally:
            if self._native_call_inflight.get(ckey) is task:
                self._native_call_inflight.pop(ckey, None)

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
            # Private channels/groups reject export with PUBLIC_CHANNEL_MISSING (500);
            # never let Pyrogram retry/back off on it — fall back to the chat link.
            try:
                exported = await asyncio.wait_for(
                    a['client'].invoke(raw.functions.phone.ExportGroupCallInvite(call=input_call), retries=0, sleep_threshold=0),
                    8,
                )
            except TypeError:
                exported = await asyncio.wait_for(
                    a['client'].invoke(raw.functions.phone.ExportGroupCallInvite(call=input_call), sleep_threshold=0),
                    8,
                )
            except Exception:
                return None
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

    @staticmethod
    def _input_group_call(native_call):
        if native_call is None:
            return None
        call_id = getattr(native_call, 'id', None)
        access_hash = getattr(native_call, 'access_hash', None)
        if call_id is None or access_hash is None:
            return None
        from pyrogram import raw
        return raw.types.InputGroupCall(id=int(call_id), access_hash=int(access_hash))

    async def ensure_call_settings(self, a, chat, call, *, messages_enabled=None):
        """Enable/query Telegram Layer 228 native GroupCall settings (in-call messaging)."""
        if a is None or a.get('client') is None or not isinstance(call, dict):
            return {'ok': False, 'reason': 'unavailable'}
        input_call = self._input_group_call(call.get('native_call'))
        if input_call is None:
            return {'ok': False, 'reason': 'no_native_call'}
        from pyrogram import raw
        threshold = 0 if self.factory else 10
        if messages_enabled is None:
            try:
                full_call = await asyncio.wait_for(
                    a['client'].invoke(raw.functions.phone.GetGroupCall(call=input_call, limit=1), sleep_threshold=threshold),
                    8,
                )
                gc = getattr(full_call, 'call', None)
                cur = bool(getattr(gc, 'messages_enabled', False)) if gc is not None else False
                call['messages_enabled'] = cur
                return {'ok': True, 'messages_enabled': cur}
            except Exception as err:
                return {'ok': False, 'reason': classify(err)}
        try:
            await asyncio.wait_for(
                a['client'].invoke(
                    raw.functions.phone.ToggleGroupCallSettings(
                        call=input_call,
                        messages_enabled=bool(messages_enabled),
                    ),
                    sleep_threshold=threshold,
                ),
                8,
            )
            call['messages_enabled'] = bool(messages_enabled)
            return {'ok': True, 'messages_enabled': bool(messages_enabled)}
        except Exception as err:
            if type(err).__name__ in {'ChatAdminRequired', 'RightForbidden', 'ChannelPrivate', 'ChatWriteForbidden'}:
                return {'ok': False, 'code': 'PERMISSION_DENIED', 'messages_enabled': bool(call.get('messages_enabled', False))}
            log.debug('ToggleGroupCallSettings skipped chat=%s err=%s', chat, type(err).__name__)
            return {'ok': False, 'code': classify(err), 'messages_enabled': bool(call.get('messages_enabled', False))}

    async def _ensure_rtmp_chat_participant(self, a, chat, call):
        """Join GroupCall muted/video_stopped when SendGroupCallMessage requires participant membership."""
        if a is None or a.get('client') is None or not isinstance(call, dict):
            return False
        input_call = self._input_group_call(call.get('native_call'))
        if input_call is None:
            return False
        try:
            from pyrogram import raw
            threshold = 0 if self.factory else 10
            await asyncio.wait_for(
                a['client'].invoke(
                    raw.functions.phone.JoinGroupCall(
                        call=input_call,
                        join_as=raw.types.InputPeerSelf(),
                        params=raw.types.DataJSON(data='{}'),
                        muted=True,
                        video_stopped=True,
                    ),
                    sleep_threshold=threshold,
                ),
                8,
            )
            call['_joined_msg_participant'] = True
            return True
        except Exception:
            return False

    async def _handle_group_call_message(self, alias, update, users, chats):
        """Forward incoming Telegram UpdateGroupCallMessage events to Node via /events."""
        from collections import deque
        msg = getattr(update, 'message', None)
        u_call = getattr(update, 'call', None)
        call_id = getattr(u_call, 'id', None)
        if msg is None or call_id is None:
            return
        text_obj = getattr(msg, 'message', None)
        text = str(getattr(text_obj, 'text', None) or text_obj or '').strip()
        if not text:
            return
        from_peer = getattr(msg, 'from_id', None)
        sender_id = (
            getattr(from_peer, 'user_id', None)
            or getattr(from_peer, 'channel_id', None)
            or getattr(from_peer, 'chat_id', None)
        )
        sender_name = None
        if sender_id is not None:
            u = users.get(sender_id) if isinstance(users, dict) else None
            c = chats.get(sender_id) if isinstance(chats, dict) else None
            ent = u or c
            if ent is not None:
                first = str(getattr(ent, 'first_name', '') or '').strip()
                last = str(getattr(ent, 'last_name', '') or '').strip()
                title = str(getattr(ent, 'title', '') or '').strip()
                uname = str(getattr(ent, 'username', '') or '').strip()
                sender_name = ' '.join(x for x in (first, last) if x) or title or (f'@{uname}' if uname else str(sender_id))
        msg_id = getattr(msg, 'id', None)
        acct = self.accounts.get(alias) or {}
        if sender_id is not None and acct.get('uid') == sender_id:
            # Skip our own echoed subtitle/reply messages
            return
        matched_chat = None
        for chat_id, call in list(self.calls.items()):
            nc = call.get('native_call')
            if call.get('alias') == alias and nc is not None and getattr(nc, 'id', None) == call_id:
                matched_chat = chat_id
                seen = call.setdefault('_seen_vc_msg_ids', deque(maxlen=64))
                if msg_id is not None and msg_id in seen:
                    return
                if msg_id is not None:
                    seen.append(msg_id)
                break
        if matched_chat is None:
            return
        if self.events.full():
            try:
                self.events.get_nowait()
            except Exception:
                pass
        self.events.put_nowait({
            'type': 'vc_message',
            'chat_id': int(matched_chat),
            'call_id': int(call_id),
            'message_id': int(msg_id) if msg_id is not None else None,
            'sender_id': int(sender_id) if sender_id is not None else None,
            'sender_name': sender_name,
            'from_admin': bool(getattr(msg, 'from_admin', False)),
            'text': text,
            'date': int(getattr(msg, 'date', 0) or 0),
        })

    async def send_call_message(self, data):
        chat = int(data['chat_id'])
        text = str(data.get('text') or '').strip()
        if chat >= 0 or not text:
            raise VoiceFailure('INVALID_REQUEST')
        text = text[:4096]
        async with self.chat_lock(chat):
            call = self.calls.get(chat)
            if not call or call.get('native_call') is None:
                raise VoiceFailure('NO_ACTIVE_CALL')
            a = self.accounts.get(call['alias'])
            if not a or not a.get('client'):
                raise VoiceFailure('SESSION_NOT_READY')
            input_call = self._input_group_call(call.get('native_call'))
            from pyrogram import raw
            threshold = 0 if self.factory else 10
            req = raw.functions.phone.SendGroupCallMessage(
                call=input_call,
                random_id=secrets.randbits(63),
                message=raw.types.TextWithEntities(text=text, entities=[]),
            )
            try:
                res = await asyncio.wait_for(a['client'].invoke(req, sleep_threshold=threshold), 10)
            except Exception as err:
                err_txt = f'{type(err).__name__} {err}'.upper()
                if call.get('stream_mode') == 'rtmp' and ('JOIN' in err_txt or 'GROUPCALL_FORBIDDEN' in err_txt):
                    joined = await self._ensure_rtmp_chat_participant(a, chat, call)
                    if joined:
                        res = await asyncio.wait_for(
                            a['client'].invoke(
                                raw.functions.phone.SendGroupCallMessage(
                                    call=input_call,
                                    random_id=secrets.randbits(63),
                                    message=raw.types.TextWithEntities(text=text, entities=[]),
                                ),
                                sleep_threshold=threshold,
                            ),
                            10,
                        )
                    else:
                        return {'ok': False, 'code': classify(err), 'error': type(err).__name__}
                else:
                    return {'ok': False, 'code': classify(err), 'error': type(err).__name__}
            sent_ids = []
            for upd in (getattr(res, 'updates', None) or []):
                msg_obj = getattr(upd, 'message', None)
                mid = getattr(msg_obj, 'id', None)
                if mid is not None:
                    sent_ids.append(int(mid))
            return {'ok': True, 'sent': True, 'message_ids': sent_ids}

    async def delete_call_messages(self, data):
        chat = int(data['chat_id'])
        raw_ids = data.get('message_ids') or []
        msg_ids = [int(x) for x in raw_ids if x is not None]
        if chat >= 0 or not msg_ids:
            raise VoiceFailure('INVALID_REQUEST')
        async with self.chat_lock(chat):
            call = self.calls.get(chat)
            if not call or call.get('native_call') is None:
                raise VoiceFailure('NO_ACTIVE_CALL')
            a = self.accounts.get(call['alias'])
            if not a or not a.get('client'):
                raise VoiceFailure('SESSION_NOT_READY')
            input_call = self._input_group_call(call.get('native_call'))
            from pyrogram import raw
            threshold = 0 if self.factory else 10
            try:
                await asyncio.wait_for(
                    a['client'].invoke(
                        raw.functions.phone.DeleteGroupCallMessages(call=input_call, messages=msg_ids),
                        sleep_threshold=threshold,
                    ),
                    8,
                )
                return {'ok': True, 'deleted': len(msg_ids)}
            except Exception as err:
                return {'ok': False, 'code': classify(err), 'error': type(err).__name__}

    async def update_call_settings(self, data):
        chat = int(data['chat_id'])
        if chat >= 0:
            raise VoiceFailure('INVALID_REQUEST')
        async with self.chat_lock(chat):
            call = self.calls.get(chat)
            if not call or call.get('native_call') is None:
                raise VoiceFailure('NO_ACTIVE_CALL')
            a = self.accounts.get(call['alias'])
            if not a or not a.get('client'):
                raise VoiceFailure('SESSION_NOT_READY')
            msg_en = data.get('messages_enabled')
            return await self.ensure_call_settings(a, chat, call, messages_enabled=(None if msg_en is None else bool(msg_en)))

    async def _get_group_call_is_rtmp(self, a, native_call):
        """Inspect whether an active Telegram GroupCall is configured with rtmp_stream=True."""
        if native_call is None or a is None or a.get('client') is None:
            return None
        direct = getattr(native_call, 'rtmp_stream', None)
        if direct is not None:
            return bool(direct)
        try:
            from pyrogram import raw
            call_id = getattr(native_call, 'id', None)
            access_hash = getattr(native_call, 'access_hash', None)
            if call_id is None or access_hash is None:
                return None
            input_call = raw.types.InputGroupCall(id=int(call_id), access_hash=int(access_hash))
            threshold = 0 if self.factory else 10
            full_call = await asyncio.wait_for(
                a['client'].invoke(raw.functions.phone.GetGroupCall(call=input_call, limit=1), sleep_threshold=threshold),
                8,
            )
            gc = getattr(full_call, 'call', None)
            if gc is not None and getattr(gc, 'rtmp_stream', None) is not None:
                return bool(gc.rtmp_stream)
        except Exception:
            pass
        return None

    async def _create_group_call(self, a, chat, peer, *, vc_title=None, rtmp_stream=False):
        from pyrogram import raw
        threshold = 0 if self.factory else 10
        kwargs = {'peer': peer, 'random_id': secrets.randbits(31), 'title': vc_title or 'Lancy music'}
        if rtmp_stream:
            kwargs['rtmp_stream'] = True
        try:
            await asyncio.wait_for(
                a['client'].invoke(raw.functions.phone.CreateGroupCall(**kwargs), sleep_threshold=threshold),
                15,
            )
        except Exception as create_err:
            if type(create_err).__name__ in {'ChatAdminRequired', 'ChannelPrivate', 'ChatWriteForbidden'}:
                raise VoiceFailure('PERMISSION_DENIED') from None
            if type(create_err).__name__ == 'FloodWait' and getattr(create_err, 'value', 0) <= 10:
                await asyncio.sleep(getattr(create_err, 'value', 1))
            else:
                raise
        self._invalidate_native_call_cache(a['client'], chat)
        _, call = await self.native_call(a['client'], chat)
        if call is None and (not self.factory or getattr(self, 'auto_create_call_in_tests', False)):
            poll_wait = 0.05 if self.factory else 0.8
            for _ in range(3):
                await asyncio.sleep(poll_wait)
                self._invalidate_native_call_cache(a['client'], chat)
                _, call = await self.native_call(a['client'], chat)
                if call is not None:
                    break
        return call

    async def _discard_group_call(self, a, native_call):
        if native_call is None or a is None or a.get('client') is None:
            return
        self._invalidate_native_call_cache(a['client'])
        try:
            from pyrogram import raw
            call_id = getattr(native_call, 'id', None)
            access_hash = getattr(native_call, 'access_hash', None)
            if call_id is None or access_hash is None:
                return
            input_call = raw.types.InputGroupCall(id=int(call_id), access_hash=int(access_hash))
            threshold = 0 if self.factory else 10
            await asyncio.wait_for(
                a['client'].invoke(raw.functions.phone.DiscardGroupCall(call=input_call), sleep_threshold=threshold),
                10,
            )
        except Exception:
            pass

    async def _fetch_rtmp_ingest(self, a, peer, *, revoke=False):
        from pyrogram import raw
        threshold = 0 if self.factory else 10
        try:
            res = await asyncio.wait_for(
                a['client'].invoke(
                    raw.functions.phone.GetGroupCallStreamRtmpUrl(peer=peer, revoke=bool(revoke)),
                    sleep_threshold=threshold,
                ),
                12,
            )
        except Exception as err:
            if type(err).__name__ in {'ChatAdminRequired', 'ChannelPrivate', 'ChatWriteForbidden'}:
                raise VoiceFailure('PERMISSION_DENIED') from None
            raise
        url = str(getattr(res, 'url', '') or '').strip()
        key = str(getattr(res, 'key', '') or '').strip()
        if not url or not key:
            raise VoiceFailure('CALL_FAILED')
        target = f"{url.rstrip('/')}/{key.lstrip('/')}"
        return target, url, key

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
            max_vid_raw = data.get('max_video_calls_per_account')
            max_vid_cap = int(max_vid_raw) if max_vid_raw is not None and int(max_vid_raw) > 0 else None
            a = await self.lease(chat, data.get('account_alias'), for_video=bool(data.get('video')), max_video_calls=max_vid_cap)
            await self._stop_secondary_tile_unlocked(chat)
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
            req_mode = str(data.get('stream_mode') or '').strip().lower()
            wants_rtmp = req_mode == 'rtmp'
            explicit_mode = req_mode in {'interactive', 'rtmp'}
            force_switch = bool(data.get('force_switch'))
            await self.resolve_destination(a['client'], chat)
            peer, call = await self.native_call(a['client'], chat)
            created = False
            if call is not None and (force_switch or explicit_mode):
                existing_is_rtmp = await self._get_group_call_is_rtmp(a, call)
                if force_switch or (existing_is_rtmp is not None and existing_is_rtmp != wants_rtmp):
                    old_call = self.calls.pop(chat, None)
                    if old_call:
                        await self._stop_rtmp_proc(old_call, wait_settle=False)
                        self._cleanup_sub_overlay(old_call)
                    if not self.factory:
                        clear_engine_cache(a['engine'], chat)
                        try: await asyncio.wait_for(a['engine'].leave_call(chat), 5)
                        except Exception: pass
                    await self._discard_group_call(a, call)
                    if not self.factory:
                        await asyncio.sleep(0.4)
                    _, call = await self.native_call(a['client'], chat)
            if call is None:
                if not self.factory:
                    clear_engine_cache(a['engine'], chat)
                    try: await asyncio.wait_for(a['engine'].leave_call(chat), 5)
                    except Exception: pass
                    self.calls.pop(chat, None)
                vc_title = str(data.get('vc_title') or data.get('title') or '').strip()[:64] or 'Lancy music'
                call = await self._create_group_call(a, chat, peer, vc_title=vc_title, rtmp_stream=wants_rtmp)
                if call is None: raise VoiceFailure('NO_ACTIVE_CALL')
                created = True
            actual_rtmp = await self._get_group_call_is_rtmp(a, call)
            resolved_mode = 'rtmp' if (actual_rtmp if actual_rtmp is not None else wants_rtmp) else 'interactive'
            if resolved_mode == 'rtmp' and (not self.factory or getattr(self, 'test_rtmp_ingest', False)):
                await self._fetch_rtmp_ingest(a, peer)
            call_invite_link = await self.resolve_call_invite_link(a, call)
            a['managed'].add(chat)
            # Setup is not an active media transport. Retain per-chat membership
            # and routing metadata without reserving a native call.
            self.release_destination(a, chat)
            return {'ok': True, 'account_alias': a['alias'], 'call_ready': True, 'created': created, 'call_invite_link': call_invite_link, 'stream_mode': resolved_mode}

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
            if not path.is_file() or not path.is_relative_to(self.root) or path.suffix.lower() not in {'.srt', '.ass', '.vtt', '.lrc'}:
                return None
            return str(path)
        except (ValueError, TypeError, OSError):
            return None

    def source_dj_image(self, value):
        if not value: return None
        try:
            path = Path(value).resolve(strict=True)
            if not path.is_file() or not path.is_relative_to(self.root) or path.suffix.lower() not in {'.png', '.jpg', '.jpeg', '.webp'}:
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

    def shift_subtitle(self, sub_path, offset_sec, playback_id, *, subtitle_offset=0.0, drift_sec_per_sec=0.0, drift_anchor_sec=0.0):
        """Normalize subtitles to UTF-8 SRT/ASS shifted by seek (`offset_sec`), manual nudge (`subtitle_offset`), and FPS drift."""
        if not sub_path:
            return None
        try:
            seek_s = float(offset_sec or 0.0)
            sub_off_s = float(subtitle_offset or 0.0)
            drift_r = sub_align.clamp_drift_rate(drift_sec_per_sec)
            anchor_s = float(drift_anchor_sec or 0.0)
            total_shift = seek_s - sub_off_s
            p = Path(sub_path)
            raw = p.read_text(encoding='utf-8', errors='replace').lstrip('\ufeff')
            is_ass = p.suffix.lower() in {'.ass', '.ssa'}
            shift_ms = int(round(total_shift * 1000))
            out_dir = self.root / 'subs'
            out_dir.mkdir(parents=True, exist_ok=True)
            safe_id = re.sub(r'[^A-Za-z0-9_-]', '', str(playback_id or 'sub'))[:24] or 'sub'

            def _map_cue_ms(raw_ms):
                if abs(drift_r) < 1e-6:
                    return raw_ms - shift_ms
                t_media = sub_align.inverse_map_sub_ms_to_media_sec(
                    raw_ms,
                    subtitle_offset=sub_off_s,
                    drift_sec_per_sec=drift_r,
                    drift_anchor_sec=anchor_s,
                )
                return int(round((t_media - seek_s) * 1000.0))

            if is_ass and '[Events]' in raw and 'Dialogue:' in raw:
                def fmt_ass_ms(ms):
                    ms = max(0, int(ms))
                    cs = (ms // 10) % 100
                    sec = (ms // 1000) % 60
                    mn = (ms // 60000) % 60
                    hr = ms // 3600000
                    return f'{hr:d}:{mn:02d}:{sec:02d}.{cs:02d}'

                norm_bytes, _ = sub_align._normalize_ass_script(raw)
                lines = norm_bytes.decode('utf-8', errors='replace').split('\n')
                shifted_lines = []
                in_events = False
                cols = None
                kept_dialogue = 0
                for line in lines:
                    s = line.strip()
                    if s.startswith('[') and s.endswith(']'):
                        in_events = (s.lower() == '[events]')
                        if in_events:
                            cols = None
                        shifted_lines.append(line)
                        continue
                    if in_events and s.lower().startswith('format:'):
                        cols = [c.strip().lower() for c in s.split(':', 1)[1].split(',')]
                        shifted_lines.append(line)
                        continue
                    if in_events and s.startswith('Dialogue:'):
                        ef_cols = cols or ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text']
                        body = line.split(':', 1)[1].lstrip()
                        parts = body.split(',', len(ef_cols) - 1)
                        if len(parts) == len(ef_cols):
                            idx_map = {n: i for i, n in enumerate(ef_cols)}
                            si = idx_map.get('start', 1)
                            ei = idx_map.get('end', 2)
                            s_ms = sub_align._parse_ass_ts_ms(parts[si])
                            e_ms = sub_align._parse_ass_ts_ms(parts[ei])
                            if s_ms is None or e_ms is None or _map_cue_ms(e_ms) <= 0:
                                continue
                            nst = max(0, _map_cue_ms(s_ms))
                            nen = max(nst + 250, _map_cue_ms(e_ms))
                            parts[si] = fmt_ass_ms(nst)
                            parts[ei] = fmt_ass_ms(nen)
                            shifted_lines.append('Dialogue: ' + ','.join(parts))
                            kept_dialogue += 1
                            continue
                    shifted_lines.append(line)
                if kept_dialogue > 0:
                    out_path = out_dir / f'shifted_{safe_id}.ass'
                    out_path.write_text('\n'.join(shifted_lines) + '\n', encoding='utf-8')
                    return str(out_path)
                return None

            cues = sub_align.dedupe_overlapping_cues(sub_align.parse_subtitle_cues(raw, is_ass=is_ass), trim_overlaps=True)
            def fmt_ms(ms):
                ms = max(0, int(ms))
                rem, msec = divmod(ms, 1000)
                rem, sec = divmod(rem, 60)
                hr, mn = divmod(rem, 60)
                return f'{hr:02d}:{mn:02d}:{sec:02d},{msec:03d}'
            out_blocks = []
            idx = 1
            for st, en, ass_txt in cues:
                mapped_end = _map_cue_ms(en)
                if mapped_end <= 0:
                    continue
                nst = max(0, _map_cue_ms(st))
                nen = max(nst + 250, mapped_end)
                body = ass_txt.replace(r'\N', '\n')
                body = re.sub(r'\{[^}]+\}', '', body).strip()
                if body and not sub_align.PROMO_SUB_RE.search(body):
                    out_blocks.append(f'{idx}\n{fmt_ms(nst)} --> {fmt_ms(nen)}\n{body}')
                    idx += 1
            if not out_blocks:
                return None
            out_path = out_dir / f'shifted_{safe_id}.srt'
            out_path.write_text('\n\n'.join(out_blocks) + '\n', encoding='utf-8')
            return str(out_path)
        except Exception:
            return sub_path

    def _cleanup_hub(self, call):
        if not isinstance(call, dict):
            return
        proc = call.pop('_hub_proc', None)
        sid = call.pop('_hub_sync_id', None)
        if proc is not None and proc.returncode is None:
            try:
                proc.terminate()
            except Exception:
                pass
        if sid:
            av_hub.cleanup_hub_files(sid)

    async def _stop_rtmp_proc(self, call, *, wait_settle=True):
        if not isinstance(call, dict):
            return
        call['rtmp_gen'] = int(call.get('rtmp_gen') or 0) + 1
        watch = call.pop('_rtmp_watch_task', None)
        if watch is not None and not watch.done():
            watch.cancel()
        stderr_task = call.pop('_rtmp_stderr_task', None)
        if stderr_task is not None and not stderr_task.done():
            stderr_task.cancel()
        proc = call.pop('_rtmp_proc', None)
        had_proc = False
        if proc is not None and proc.returncode is None:
            had_proc = True
            try:
                proc.terminate()
                await asyncio.wait_for(proc.wait(), timeout=2.0)
            except Exception:
                try:
                    proc.kill()
                    await asyncio.wait_for(proc.wait(), timeout=1.0)
                except Exception:
                    pass
        if had_proc and wait_settle:
            await asyncio.sleep(0.15)

    def _cleanup_sub_overlay(self, call, *, unlink_config=True):
        if not isinstance(call, dict):
            return
        self._cleanup_hub(call)
        rtmp_watch = call.pop('_rtmp_watch_task', None)
        if rtmp_watch is not None and not rtmp_watch.done():
            try: rtmp_watch.cancel()
            except Exception: pass
        rtmp_err = call.pop('_rtmp_stderr_task', None)
        if rtmp_err is not None and not rtmp_err.done():
            try: rtmp_err.cancel()
            except Exception: pass
        rtmp_proc = call.pop('_rtmp_proc', None)
        if rtmp_proc is not None and rtmp_proc.returncode is None:
            try: rtmp_proc.terminate()
            except Exception: pass
        task = call.pop('_sub_align_task', None)
        if task is not None and not task.done():
            try:
                task.cancel()
            except Exception:
                pass
        if unlink_config:
            cfg = call.pop('sub_config_path', None)
            if cfg:
                try:
                    Path(cfg).unlink(missing_ok=True)
                except Exception:
                    pass
            dj_cfg = call.pop('dj_config_path', None)
            if dj_cfg:
                try:
                    Path(dj_cfg).unlink(missing_ok=True)
                except Exception:
                    pass
            sid = call.get('av_sync_id')
            if sid:
                for p in (
                    av_sync.shm_path_for(sid),
                    av_sync.substatus_path_for(sid),
                    av_sync.vchud_config_path_for(sid),
                    browser_stream.browser_meta_path_for(sid),
                    browser_stream.browser_stats_path_for(sid),
                ):
                    try:
                        p.unlink(missing_ok=True)
                    except Exception:
                        pass

    def _hot_update_subtitles(self, call):
        sid = call.get('av_sync_id') if isinstance(call, dict) else None
        cfg_path = call.get('sub_config_path') if isinstance(call, dict) else None
        if not sid or not cfg_path:
            return False
        sub_path = call.get('subtitle_path')
        enabled = bool(sub_path and Path(sub_path).is_file())
        _write_sub_config(
            sid,
            enabled=enabled,
            subtitle_path=sub_path,
            base_sec=float(call.get('sub_base_sec') or 0.0),
            subtitle_offset=float(call.get('subtitle_offset') or 0.0),
            drift_sec_per_sec=float(call.get('sub_drift_sec_per_sec') or 0.0),
            drift_anchor_sec=float(call.get('sub_drift_anchor_sec') or 0.0),
            manual_override=bool(call.get('manual_sub_override')),
            same_route=bool(call.get('subtitle_same_route')),
            auto_normalize=True,
            force_check_seq=int(call.get('_sub_force_check_seq') or 0),
            render_screen=bool(call.get('subtitle_render_screen', True)),
            pts_anchored=bool(call.get('_pts_anchored')),
        )
        _bump_sub_gen(sid)
        return True

    def _sync_live_sub_monitor_state(self, call):
        """Pull live checker/normalizer updates written by av_sync/rtmp_hub back onto call state."""
        sid = call.get('av_sync_id') if isinstance(call, dict) else None
        if not sid:
            return None
        cfg, st = _read_sub_sync_snapshot(sid)
        if cfg and not call.get('manual_sub_override') and call.get('subtitle_path'):
            if str(cfg.get('subtitle_path') or '') == str(call.get('subtitle_path') or ''):
                try:
                    cfg_off = float(cfg.get('subtitle_offset') or 0.0)
                    cfg_drift = float(cfg.get('drift_sec_per_sec') or 0.0)
                    cfg_anchor = float(cfg.get('drift_anchor_sec') or 0.0)
                    if abs(cfg_off - float(call.get('subtitle_offset') or 0.0)) >= 0.05:
                        call['subtitle_offset'] = cfg_off
                        call['auto_subtitle_offset'] = cfg_off
                    if abs(cfg_drift - float(call.get('sub_drift_sec_per_sec') or 0.0)) >= 0.0001:
                        call['sub_drift_sec_per_sec'] = cfg_drift
                        call['sub_drift_anchor_sec'] = cfg_anchor
                except Exception:
                    pass
        if isinstance(st, dict) and st.get('status'):
            cur_st = call.get('subtitle_sync')
            cur_ts = float(cur_st.get('updated_at') or 0.0) if isinstance(cur_st, dict) else 0.0
            if float(st.get('updated_at') or 0.0) >= cur_ts:
                call['subtitle_sync'] = st
        return st

    def _apply_probe_sub_result(self, chat, call, res, *, is_same_route=False, force_normalize=False):
        if not isinstance(res, dict):
            return False
        aligned = round(max(-180.0, min(180.0, float(res.get('offset') or 0.0))), 1)
        drift_rate = sub_align.clamp_drift_rate(res.get('drift_sec_per_sec') or 0.0)
        drift_anchor = float(res.get('drift_anchor_sec') or 0.0)
        drift_mpm = round(drift_rate * 60000.0, 2)
        z_val = float(res.get('z_score') or 0.0)
        confident = bool(res.get('confident'))
        manual = bool(call.get('manual_sub_override')) and not force_normalize

        strong_same_route_fix = bool(is_same_route and confident and abs(aligned) >= 0.65 and z_val >= 2.8 and res.get('half_consensus', True))
        should_apply = bool(
            confident
            and not manual
            and (force_normalize or not is_same_route or strong_same_route_fix)
        )
        applied_change = False
        if should_apply:
            cur_off = float(call.get('subtitle_offset') or 0.0)
            cur_drift = float(call.get('sub_drift_sec_per_sec') or 0.0)
            call['auto_subtitle_offset'] = aligned
            if abs(aligned - cur_off) >= 0.4 or abs(drift_rate - cur_drift) >= 0.0005:
                call['subtitle_offset'] = aligned
                call['sub_drift_sec_per_sec'] = drift_rate if abs(drift_rate) >= 0.0005 else 0.0
                call['sub_drift_anchor_sec'] = drift_anchor if abs(drift_rate) >= 0.0005 else 0.0
                self._hot_update_subtitles(call)
                applied_change = True
                log.info(
                    'Auto-normalized subtitles destination=%s offset=%+.1fs drift=%.1fms/min z=%.2f',
                    chat,
                    aligned,
                    drift_mpm,
                    z_val,
                )
        elif confident:
            call['auto_subtitle_offset'] = aligned

        st_label = str(res.get('status') or ('synced' if (confident and abs(aligned) < 0.45) else 'uncertain'))
        if applied_change:
            st_label = 'auto_normalized'
        msg = (
            f'Auto-normalized subtitles ({aligned:+.1f}s' + (f', {drift_mpm:+.0f}ms/min' if abs(drift_rate) >= 0.0005 else '') + ')'
            if applied_change
            else (
                f'Subtitles verified in sync ({aligned:+.1f}s)'
                if st_label == 'synced'
                else (
                    f'Subtitles out of sync (~{aligned:+.1f}s)'
                    if st_label in {'desynced', 'drifted'}
                    else (
                        'Subtitle cut may not match audio'
                        if st_label == 'mismatch'
                        else 'Monitoring live speech for subtitle sync'
                    )
                )
            )
        )
        call['subtitle_sync'] = {
            'status': st_label,
            'checked_at_sec': float(res.get('window_start') or 0.0),
            'residual_sec': 0.0 if applied_change else round(aligned - float(call.get('subtitle_offset') or 0.0), 2),
            'applied_offset_sec': float(call.get('subtitle_offset') or 0.0),
            'suggested_offset_sec': aligned if confident else float(call.get('subtitle_offset') or 0.0),
            'drift_ms_per_min': drift_mpm if should_apply or abs(drift_rate) >= 0.0005 else 0.0,
            'drift_sec_per_sec': float(call.get('sub_drift_sec_per_sec') or 0.0),
            'drift_anchor_sec': float(call.get('sub_drift_anchor_sec') or 0.0),
            'z_score': round(z_val, 2),
            'confident': confident,
            'auto_normalized': applied_change or bool((call.get('subtitle_sync') or {}).get('auto_normalized')),
            'manual_override': manual,
            'message': msg,
            'updated_at': round(time.time(), 3),
        }
        return applied_change

    def _maybe_schedule_sub_align(self, _a, chat, call, *, force_normalize=False):
        old_task = call.pop('_sub_align_task', None)
        if old_task is not None and not old_task.done():
            try:
                old_task.cancel()
            except Exception:
                pass
        if self.factory or not call.get('video'):
            return
        sub_path = call.get('subtitle_path')
        if not sub_path or not Path(sub_path).is_file():
            return
        if call.get('manual_sub_override') and not force_normalize:
            return
        if not call.get('sub_config_path') or not call.get('av_sync_id'):
            return
        if not force_normalize and sub_align.host_load_pressure() >= 0.85:
            # Under tight CPU load, avoid spawning a duplicate FFmpeg probe; LiveSubSyncMonitor handles alignment in-process.
            return
        media_url = str(call.get('path') or '')
        if not media_url:
            return

        target_pid = call.get('playback_id')
        target_sub = sub_path
        is_hls = bool(call.get('_is_hls_proxy'))
        is_same_route = bool(call.get('subtitle_same_route'))
        seek_hint = float(call.get('position_seconds') if force_normalize and call.get('position_seconds') is not None else (call.get('offset') or 0.0))
        origin_pts = call.get('_v0_origin')
        a_stream_idx = (call.get('_probe_info') or {}).get('audio_stream_index')

        async def _align_worker():
            try:
                res = await asyncio.to_thread(
                    sub_align.probe_audio_and_align,
                    media_url,
                    target_sub,
                    seek_offset=seek_hint,
                    is_hls_proxy=is_hls,
                    same_route=is_same_route,
                    audio_stream_index=a_stream_idx,
                    origin_pts_sec=origin_pts,
                )
            except asyncio.CancelledError:
                return
            except Exception:
                return
            if not isinstance(res, dict):
                return
            async with self.chat_lock(chat):
                cur = self.calls.get(chat)
                if (
                    cur is not call
                    or cur.get('playback_id') != target_pid
                    or cur.get('subtitle_path') != target_sub
                    or (cur.get('manual_sub_override') and not force_normalize)
                    or cur.get('status') not in {'playing', 'paused'}
                ):
                    return
                self._sync_live_sub_monitor_state(cur)
                if (
                    not force_normalize
                    and (
                        bool((cur.get('subtitle_sync') or {}).get('auto_normalized'))
                        or abs(float(cur.get('subtitle_offset') or 0.0)) >= 0.45
                    )
                ):
                    return
                self._apply_probe_sub_result(chat, cur, res, is_same_route=is_same_route, force_normalize=force_normalize)

        try:
            call['_sub_align_task'] = asyncio.create_task(_align_worker())
        except Exception:
            pass

    def ensure_sync_monitor(self):
        if self.closing:
            return None
        task = getattr(self, '_sync_monitor_task', None)
        if task is not None and not task.done():
            return task
        try:
            self._sync_monitor_task = asyncio.create_task(self._sync_monitor_loop())
            return self._sync_monitor_task
        except Exception:
            return None

    async def _resync_active_call(self, a, chat, call, *, reason='drift'):
        if not call or call.get('status') != 'playing':
            return False
        pos = max(0.0, float(call.get('last_known_position') or call.get('position_seconds') or call.get('offset') or 0.0))
        if call.get('duration') and float(call['duration']) > 2.0:
            pos = min(pos, max(0.0, float(call['duration']) - 1.5))
        mon = call.setdefault('_sync_mon', {})
        mon['resync_count'] = int(mon.get('resync_count') or 0) + 1
        mon['last_resync_at'] = time.monotonic()
        mon['last_resync_reason'] = str(reason)
        mon['skew_streak'] = 0
        call['offset'] = pos
        call.pop('_landed_offset', None)
        call['last_seek_at'] = time.monotonic()
        if call.get('stream_mode') == 'rtmp':
            call['_rtmp_target'] = None
        await self.stream(a, chat, call)
        call['status'] = 'playing'
        call['clock_errors'] = 0
        call['last_progress'] = time.monotonic()
        log.warning('Auto-resync completed destination=%s reason=%s pos=%.2fs attempt=%s', chat, reason, pos, mon['resync_count'])
        return True

    def _evaluate_call_sync(self, chat, call, metrics=None):
        sid = call.get('av_sync_id')
        if metrics is None and sid:
            metrics = _read_sync_metrics(sid)
        self._sync_live_sub_monitor_state(call)
        hub_proc = call.get('_hub_proc')
        hub_dead = bool(
            hub_proc is not None
            and call.get('stream_mode') != 'rtmp'
            and call.get('status') == 'playing'
            and getattr(hub_proc, 'returncode', None) not in (None, 0)
        )
        mon = call.setdefault('_sync_mon', {
            'health': 'locked',
            'skew_streak': 0,
            'stall_streak': 0,
            'resync_count': 0,
            'last_resync_at': 0.0,
            'last_resync_reason': None,
            'last_log_health': 'locked',
            'checked_at': 0.0,
        })
        now_m = time.monotonic()
        mon['checked_at'] = round(time.time(), 3)
        if not metrics:
            if hub_dead:
                mon['health'] = 'stalled'
                mon['stall_streak'] = int(mon.get('stall_streak') or 0) + 1
                return metrics, 'hub_exited'
            return None, None

        if call.get('music_freerun') or call.get('dj_desk') or call.get('is_music'):
            mon['health'] = 'locked'
            mon['skew_streak'] = 0
            mon['stall_streak'] = 0
            mon['last_log_health'] = 'locked'
            if isinstance(metrics, dict):
                metrics['sync_health'] = 'locked'
                metrics['skew_ms'] = 0
            return metrics, None

        health = str(metrics.get('sync_health') or 'locked')
        skew_ms = int(metrics.get('skew_ms') or 0)
        prev_health = mon.get('last_log_health') or 'locked'
        mon['health'] = 'stalled' if hub_dead else health
        if abs(skew_ms) >= 260 and not metrics.get('paused'):
            mon['skew_streak'] = int(mon.get('skew_streak') or 0) + 1
        else:
            mon['skew_streak'] = 0
        if (health == 'stalled' or hub_dead) and not metrics.get('paused'):
            mon['stall_streak'] = int(mon.get('stall_streak') or 0) + 1
        else:
            mon['stall_streak'] = 0

        if health != prev_health:
            if health in {'drifted', 'stalled'}:
                log.warning(
                    'A/V sync degraded destination=%s health=%s skew=%+dms hb_age=%.1fs flags=%s',
                    chat, health, skew_ms, float(metrics.get('hb_age_sec') or 0.0), int(metrics.get('sync_flags') or 0),
                )
            elif prev_health in {'drifted', 'stalled', 'syncing'} and health == 'locked':
                log.info('A/V sync locked destination=%s skew=%+dms', chat, skew_ms)
            mon['last_log_health'] = health

        since_seek = now_m - float(call.get('last_seek_at') or 0.0)
        since_resync = now_m - float(mon.get('last_resync_at') or 0.0)
        can_resync = (
            call.get('status') == 'playing'
            and not call.get('_live_paused')
            and int(mon.get('resync_count') or 0) < 3
            and since_seek >= 18.0
            and since_resync >= 22.0
            and (not self.factory or bool(getattr(self, 'allow_auto_resync_in_tests', False)))
        )
        trigger_reason = None
        if can_resync:
            if hub_dead:
                trigger_reason = 'hub_exited'
            elif mon['stall_streak'] >= 1:
                trigger_reason = f"hb_stalled_{float(metrics.get('hb_age_sec') or 0.0):.0f}s"
            elif mon['skew_streak'] >= 2:
                trigger_reason = f'sustained_skew_{skew_ms:+d}ms'
        return metrics, trigger_reason

    async def _sync_monitor_loop(self):
        try:
            while not self.closing:
                interval = max(0.05, float(getattr(self, 'sync_monitor_interval_sec', 2.5) or 2.5))
                await asyncio.sleep(interval)
                if self.closing:
                    break
                for chat in list(self.calls):
                    if self.closing:
                        break
                    async with self.chat_lock(chat):
                        call = self.calls.get(chat)
                        if not call or call.get('status') not in {'playing', 'paused'}:
                            continue
                        metrics, reason = self._evaluate_call_sync(chat, call)
                        if reason:
                            a = self.accounts.get(call.get('alias'))
                            if a:
                                try:
                                    await self._resync_active_call(a, chat, call, reason=reason)
                                except Exception as err:
                                    log.warning('Auto-resync failed destination=%s reason=%s err=%s', chat, reason, err)
        except asyncio.CancelledError:
            return

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
            try:
                _, input_call = await self.native_call(client, chat)
            except VoiceFailure as vf:
                if vf.code == 'PERMISSION_DENIED':
                    raise
                raise VoiceFailure('PUBLISHER_UNVERIFIED', {'stage': 'call_state', 'detail': vf.detail or vf.code}) from None
            except Exception as err:
                detail = {'stage': 'call_state', 'kind': type(err).__name__}
                if type(err).__name__ == 'FloodWait':
                    detail['retry_after'] = int(getattr(err, 'value', 0))
                raise VoiceFailure('PUBLISHER_UNVERIFIED', detail) from None
            if input_call is None:
                raise VoiceFailure('NO_ACTIVE_CALL')
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

    async def _resolve_media_sync_plan(self, call, *, base_path, offset_val, max_w, max_h, target_fps=30, video_active=True, probe_any=False):
        """Resolve probed stream geometry, HLS seek deltas, PTS anchoring, and subtitle shift."""
        pref_lang = call.get('preferred_audio_lang')
        info = call.get('_probe_info')
        if info is None and (video_active or probe_any):
            info = (await probe_media_stream_info(base_path, preferred_lang=pref_lang)) or (await probe_video_stream_info(base_path) if video_active else None)
            if info:
                call['_probe_info'] = info
        if info and info.get('duration') and not call.get('duration'):
            try:
                call['duration'] = float(info['duration'])
            except Exception:
                pass
        is_img = info.get('is_image', False) if info else False
        is_hls_proxy = bool(
            call.get('remote_proxy')
            and (
                '.m3u8' in base_path.lower()
                or 'hls' in str((info or {}).get('format_name') or '').lower()
            )
        )
        hls_seek_url = (
            f"{base_path}{'&' if '?' in base_path else '?'}start={offset_val:.3f}"
            if (is_hls_proxy and offset_val > 0.05)
            else None
        )
        sync_trim_start = None
        sync_pre_seek = None
        sync_copyts = False
        sync_normalize_pts = False
        sync_pts_anchor = None
        sync_strip_first_pts_zero = True
        call.pop('_landed_offset', None)
        sub_shift_offset = offset_val

        hls_audio_trim_start = None
        hls_video_trim_start = None
        base_v0_raw = info.get('video_start_time') if info else None
        base_a0_raw = info.get('audio_start_time') if info else None
        fmt_s0_raw = info.get('format_start_time') if info else None

        pkt_v0 = call.get('_v0_origin') if '_v0_origin' in call else None
        pkt_a0 = call.get('_a0_origin') if '_a0_origin' in call else None
        if not is_img and (('_v0_origin' not in call and (is_hls_proxy or base_v0_raw is None)) or (is_hls_proxy and offset_val <= 0.05 and '_a0_origin' not in call)):
            pv0, pa0 = await probe_initial_packet_pts(
                base_path,
                video_stream_index=info.get('stream_index') if info else None,
                audio_stream_index=info.get('audio_stream_index') if info else None,
            )
            if pv0 is not None:
                pkt_v0 = pv0
                call['_v0_origin'] = pv0
            elif base_v0_raw is not None and float(base_v0_raw) >= 0.0:
                pkt_v0 = float(base_v0_raw)
                call['_v0_origin'] = pkt_v0
            else:
                call['_v0_origin'] = 0.0
                pkt_v0 = 0.0
            if pa0 is not None:
                pkt_a0 = pa0
                call['_a0_origin'] = pa0
            elif base_a0_raw is not None and float(base_a0_raw) >= 0.0:
                pkt_a0 = float(base_a0_raw)
                call['_a0_origin'] = pkt_a0

        base_v0 = float(pkt_v0) if (pkt_v0 is not None and float(pkt_v0) >= 0.0) else (float(base_v0_raw) if (base_v0_raw is not None and float(base_v0_raw) >= 0.0) else 0.0)
        if fmt_s0_raw is not None:
            fmt_origin = max(0.0, float(fmt_s0_raw))
        elif pkt_v0 is not None and pkt_a0 is not None:
            fmt_origin = max(0.0, min(float(pkt_v0), float(pkt_a0)))
        elif base_v0_raw is not None and base_a0_raw is not None:
            fmt_origin = max(0.0, min(float(base_v0_raw), float(base_a0_raw)))
        else:
            fmt_origin = base_v0
        call['_is_hls_proxy'] = is_hls_proxy

        if is_hls_proxy and offset_val > 0.05:
            # Loopback HLS playlist is pre-sliced to target segment via ?start=offset_val.
            # Probe actual first packet PTS of video & audio in one parallel batch so -copyts + T_anchor
            # aligns audio & video to the exact same timeline instant even on split/demuxed HLS playlists.
            sync_pre_seek = 0.0
            sync_copyts = False
            sync_trim_start = None
            sync_pts_anchor = None
            sync_normalize_pts = True
            sub_shift_offset = offset_val
            seek_info, (v_pkt, a_pkt), (hdr_v, hdr_a) = await asyncio.gather(
                probe_media_stream_info(hls_seek_url, preferred_lang=pref_lang),
                probe_initial_packet_pts(
                    hls_seek_url,
                    video_stream_index=info.get('stream_index') if info else None,
                    audio_stream_index=info.get('audio_stream_index') if info else None,
                ),
                asyncio.to_thread(sub_align._fetch_hls_skipped_hdrs, hls_seek_url),
            )
            trim_delta_hdr = sub_align._fetch_hls_audio_trim_delta(hls_seek_url)
            if seek_info and not info:
                info = seek_info
                call['_probe_info'] = seek_info

            same_epoch = (
                v_pkt is not None
                and a_pkt is not None
                and abs(float(v_pkt) - float(a_pkt)) <= 20.0
                and (pkt_a0 is None or pkt_v0 is None or abs(float(pkt_v0) - float(pkt_a0)) <= 5.0)
            )
            if same_epoch:
                t_anchor = max(float(v_pkt), float(a_pkt))
                movie_landed = max(0.0, t_anchor - base_v0)
                seg_pts_reset = bool(
                    hdr_v is not None
                    and float(hdr_v) > 1.0
                    and (
                        movie_landed <= 0.1
                        or (float(hdr_v) >= 5.0 and movie_landed < float(hdr_v) * 0.25)
                        or abs(movie_landed - float(hdr_v)) > max(60.0, float(hdr_v) * 0.25)
                    )
                )
                if not seg_pts_reset:
                    sync_copyts = True
                    sync_trim_start = round(max(0.0, t_anchor), 3)
                    sync_pts_anchor = sync_trim_start
                    sync_strip_first_pts_zero = False
                    dur_cap = float(call.get('duration') or 0.0)
                    if dur_cap <= 0.0 or movie_landed <= dur_cap + 15.0:
                        sub_shift_offset = movie_landed
                        call['_landed_offset'] = movie_landed
                else:
                    hdr_delta = float(trim_delta_hdr) if trim_delta_hdr is not None else (
                        (float(hdr_v) - float(hdr_a)) if (hdr_a is not None and hdr_v is not None) else 0.0
                    )
                    pkt_diff = (float(v_pkt) - float(a_pkt))
                    diff = hdr_delta if 0.025 <= hdr_delta <= 15.0 else pkt_diff
                    if 0.025 <= diff <= 15.0:
                        hls_audio_trim_start = round(diff, 3)
                    elif -15.0 <= diff <= -0.025:
                        hls_video_trim_start = round(-diff, 3)
                    sub_shift_offset = max(0.0, float(hdr_v))
                    call['_landed_offset'] = sub_shift_offset
            elif v_pkt is not None and a_pkt is not None and pkt_a0 is not None and pkt_v0 is not None:
                v_el = max(0.0, float(v_pkt) - base_v0)
                a_el = max(0.0, float(a_pkt) - float(pkt_a0))
                t_rel = max(v_el, a_el)
                if (t_rel - a_el) >= 0.025:
                    hls_audio_trim_start = round(min(15.0, t_rel - a_el), 3)
                if (t_rel - v_el) >= 0.025:
                    hls_video_trim_start = round(min(15.0, t_rel - v_el), 3)
                cand = t_rel
                if hdr_v is not None and cand <= 0.1 and float(hdr_v) > 1.0:
                    cand = float(hdr_v)
                sub_shift_offset = cand
                call['_landed_offset'] = cand
            elif seek_info:
                v_s = seek_info.get('video_start_time')
                a_s = seek_info.get('audio_start_time')
                if v_s is not None and a_s is not None:
                    delta = float(v_s) - float(a_s)
                    if 0.025 <= delta <= 15.0:
                        hls_audio_trim_start = round(delta, 3)
                        eff_t = float(v_s)
                    elif -15.0 <= delta <= -0.025:
                        hls_video_trim_start = round(-delta, 3)
                        eff_t = float(a_s)
                    else:
                        eff_t = float(v_s)
                    cand = max(0.0, eff_t - base_v0)
                    if cand <= 0.1 and hdr_v is not None and abs(float(hdr_v) - offset_val) <= 25.0:
                        if hdr_a is not None and 0.025 <= (float(hdr_v) - float(hdr_a)) <= 15.0 and hls_audio_trim_start is None:
                            hls_audio_trim_start = round(float(hdr_v) - float(hdr_a), 3)
                        sub_shift_offset = max(0.0, float(hdr_v))
                        call['_landed_offset'] = sub_shift_offset
                    elif abs(cand - offset_val) <= 25.0:
                        sub_shift_offset = cand
                        call['_landed_offset'] = sub_shift_offset
                elif hdr_v is not None and abs(float(hdr_v) - offset_val) <= 25.0:
                    if hdr_a is not None and 0.025 <= (float(hdr_v) - float(hdr_a)) <= 15.0:
                        hls_audio_trim_start = round(float(hdr_v) - float(hdr_a), 3)
                    sub_shift_offset = max(0.0, float(hdr_v))
                    call['_landed_offset'] = sub_shift_offset
            elif hdr_v is not None and abs(float(hdr_v) - offset_val) <= 25.0:
                if hdr_a is not None and 0.025 <= (float(hdr_v) - float(hdr_a)) <= 15.0:
                    hls_audio_trim_start = round(float(hdr_v) - float(hdr_a), 3)
                sub_shift_offset = max(0.0, float(hdr_v))
                call['_landed_offset'] = sub_shift_offset
        elif is_hls_proxy and not is_img and pkt_v0 is not None and pkt_a0 is not None:
            sync_pre_seek = 0.0
            sync_normalize_pts = True
            if abs(float(pkt_v0) - float(pkt_a0)) >= 0.025 and abs(float(pkt_v0) - float(pkt_a0)) <= 15.0:
                t_anchor = max(float(pkt_v0), float(pkt_a0))
                sync_copyts = True
                sync_trim_start = round(max(0.0, t_anchor), 3)
                sync_pts_anchor = sync_trim_start
                sync_strip_first_pts_zero = False
                sub_shift_offset = max(0.0, t_anchor - base_v0)
        elif info is not None and not info.get('is_image', False):
            # Anchor both FFmpeg pipelines to a single container timestamp T0 via -copyts and PTS-T0/TB
            # while fast-seeking with input -ss so B-frames, edit lists, and delayed audio stay locked within <=1 frame.
            target_t0 = fmt_origin + offset_val
            v_cand = pkt_v0 if pkt_v0 is not None else base_v0_raw
            a_cand = pkt_a0 if pkt_a0 is not None else base_a0_raw
            if (
                offset_val <= 0.05
                and v_cand is not None
                and a_cand is not None
                and abs(float(v_cand) - float(a_cand)) > 0.025
                and abs(max(float(v_cand), float(a_cand)) - fmt_origin) <= 15.0
            ):
                target_t0 = max(float(v_cand), float(a_cand))
            sync_copyts = True
            sync_pre_seek = offset_val if offset_val > 0.05 else 0.0
            sync_trim_start = round(max(0.0, target_t0), 3)
            sync_pts_anchor = sync_trim_start
            sync_normalize_pts = True
            sync_strip_first_pts_zero = False
            sub_shift_offset = max(0.0, float(sync_trim_start) - fmt_origin)
        elif offset_val > 0.05 and not (info and info.get('is_image', False)):
            sync_pre_seek = offset_val
            sync_copyts = False
            sync_trim_start = None
            sync_pts_anchor = None
            sync_normalize_pts = True
            sync_strip_first_pts_zero = True
            sub_shift_offset = offset_val

        is_img = info.get('is_image', False) if info else False
        scaled = compute_target_video_size(info['width'], info['height'], max_w, max_h, adjust_by_height=True) if (info and info.get('width') and info.get('height')) else None
        final_w, final_h = scaled if scaled else (max(2, max_w - (max_w % 2)), max(2, max_h - (max_h % 2)))
        return {
            'info': info,
            'is_img': is_img,
            'is_hls_proxy': is_hls_proxy,
            'hls_seek_url': hls_seek_url,
            'sync_trim_start': sync_trim_start,
            'sync_pre_seek': sync_pre_seek,
            'sync_copyts': sync_copyts,
            'sync_normalize_pts': sync_normalize_pts,
            'sync_pts_anchor': sync_pts_anchor,
            'sync_strip_first_pts_zero': sync_strip_first_pts_zero,
            'hls_audio_trim_start': hls_audio_trim_start,
            'hls_video_trim_start': hls_video_trim_start,
            'sub_shift_offset': sub_shift_offset,
            'final_w': final_w,
            'final_h': final_h,
        }

    async def _start_rtmp_proc(self, a, chat, call, cmd_args, *, is_standby=False):
        """Replace active RTMP pusher process cleanly so Telegram sees one continuous publisher."""
        await self._stop_rtmp_proc(call, wait_settle=True)
        gen = int(call.get('rtmp_gen') or 0) + 1
        call['rtmp_gen'] = gen
        call['_last_rtmp_args'] = list(cmd_args)
        call['rtmp_standby'] = bool(is_standby)
        call['rtmp_started_at'] = time.monotonic()
        call['last_seek_at'] = call['rtmp_started_at']

        if self.factory and not getattr(self, 'spawn_rtmp_in_tests', False):
            hook = getattr(self, 'rtmp_mock_spawn', None)
            if callable(hook):
                res = hook(chat, cmd_args, is_standby=is_standby)
                if asyncio.iscoroutine(res):
                    await res
            call['_rtmp_proc'] = None
            return

        rtmp_target = call.get('_rtmp_target')
        sub_env = None
        if rtmp_target:
            sub_env = dict(os.environ)
            sub_env['LANCY_RTMP_TARGET'] = str(rtmp_target)
        proc = await asyncio.create_subprocess_exec(
            *cmd_args,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
            env=sub_env,
        )
        call['_rtmp_proc'] = proc

        from collections import deque
        err_tail = deque(maxlen=24)

        async def _drain_stderr():
            try:
                while proc.stderr is not None:
                    line = await proc.stderr.readline()
                    if not line:
                        break
                    txt = rtmp_streamer.scrub_rtmp_secret(line.decode('utf-8', 'replace').strip(), rtmp_target)
                    if txt:
                        err_tail.append(txt[:240])
            except Exception:
                pass

        async def _watch_proc():
            try:
                rc = await proc.wait()
            except asyncio.CancelledError:
                return
            except Exception:
                rc = 1
            if stderr_task is not None:
                try:
                    await asyncio.wait_for(stderr_task, timeout=0.5)
                except Exception:
                    pass
            async with self.chat_lock(chat):
                cur = self.calls.get(chat)
                if cur is not call or int(cur.get('rtmp_gen') or 0) != gen:
                    return
                if self.closing:
                    return
                if rc == 0 and cur.get('status') == 'playing' and not is_standby:
                    cur['status'] = 'ended'
                    if self.events.full():
                        self.events.get_nowait()
                    self.events.put_nowait({'chat_id': chat, 'playback_id': cur.get('playback_id'), 'status': 'ended'})
                    return
                if cur.get('status') in {'playing', 'paused'}:
                    if err_tail:
                        log.warning('RTMP ffmpeg exited rc=%s chat=%s tail=%s', rc, chat, ' | '.join(err_tail))
                    try:
                        _, live_native = await self.native_call(a['client'], chat)
                    except Exception:
                        live_native = cur.get('native_call')
                    if live_native is None:
                        await self._close_dropped_call(a, chat, cur, reason='RTMP_CALL_ENDED', probe_time=False, emit_event=True, ignore_leave_error=True)
                    else:
                        cur['status'] = 'error'
                        cur['_rtmp_target'] = None

        stderr_task = asyncio.create_task(_drain_stderr())
        watch_task = asyncio.create_task(_watch_proc())
        call['_rtmp_stderr_task'] = stderr_task
        call['_rtmp_watch_task'] = watch_task

    async def _stream_rtmp(self, a, chat, call):
        """Push one unified H.264 + AAC FLV stream into Telegram's native RTMPS ingest."""
        if not call.get('_rtmp_target'):
            peer = await asyncio.wait_for(a['client'].resolve_peer(chat), 15) if a.get('client') else None
            if peer is None:
                raise VoiceFailure('CALL_FAILED')
            rtmp_target, _, _ = await self._fetch_rtmp_ingest(a, peer)
            call['_rtmp_target'] = rtmp_target

        offset_val = float(call.get('offset') or 0.0)
        base_path = re.sub(r'[?&]start=[0-9.]+', '', str(call.get('path') or ''))
        is_channel = bool(call.get('is_channel'))
        has_video = bool(call.get('video'))
        video_active = has_video or is_channel
        default_quality = 'FHD_1080p' if video_active else 'HD_720p'
        requested_quality = str(call.get('video_quality') or os.environ.get('VOICE_VIDEO_QUALITY') or default_quality)
        q_dims = {'SD_480p': (854, 480), 'HD_720p': (1280, 720), 'FHD_1080p': (1920, 1080)}.get(requested_quality, (1920, 1080) if video_active else (1280, 720))
        plan = await self._resolve_media_sync_plan(
            call,
            base_path=base_path,
            offset_val=offset_val,
            max_w=q_dims[0],
            max_h=q_dims[1],
            target_fps=30,
            video_active=video_active,
            probe_any=True,
        )
        info = plan['info'] or {}
        is_img = plan['is_img']
        is_hls_proxy = plan['is_hls_proxy']
        source_input = plan['hls_seek_url'] or base_path
        src_fps = info.get('fps')
        eff_fps = max(15.0, min(30.0, float(src_fps or 24)))
        final_w, final_h = int(plan['final_w']), int(plan['final_h'])
        scale_needed = not (info and not is_img and int(info.get('width') or 0) == final_w and int(info.get('height') or 0) == final_h)

        # Pick bitrate tier matching actual output resolution so 720p gets high-headroom 720p and 1080p gets true crisp 1080p.
        bitrate_quality = requested_quality
        if requested_quality == 'FHD_1080p' and final_w <= 1280 and final_h <= 720:
            bitrate_quality = 'HD_720p'

        # Adaptive tight-load protection: dynamically scale encoder threads/preset & cap 1080p under multi-stream load.
        active_vids = sum(self._active_video_calls_for_account(al) for al in self.accounts)
        load_ratio = sub_align.host_load_pressure()
        if (active_vids >= 3 or load_ratio >= 0.85) and requested_quality == 'FHD_1080p' and final_w > 1280:
            scaled_down = compute_target_video_size(final_w, final_h, 1280, 720, adjust_by_height=True)
            if scaled_down:
                final_w, final_h = scaled_down
            scale_needed = not (info and not is_img and int(info.get('width') or 0) == final_w and int(info.get('height') or 0) == final_h)
            bitrate_quality = 'HD_720p'
        enc_threads = 2 if (active_vids >= 3 or load_ratio >= 0.75) else (3 if (active_vids >= 2 or load_ratio >= 0.50) else 4)

        has_video_stream = bool(info.get('video_count', 1 if video_active else 0) > 0)
        has_audio_stream = bool(info.get('audio_count', 1) > 0)
        sub_raw = call.get('subtitle_path')
        sub_user_offset = float(call.get('subtitle_offset') or 0.0)
        sub_drift_rate = float(call.get('sub_drift_sec_per_sec') or 0.0)
        sub_drift_anchor = float(call.get('sub_drift_anchor_sec') or 0.0)
        sub_shift_offset = float(plan['sub_shift_offset'])
        call['sub_base_sec'] = sub_shift_offset

        eff_v_trim = plan['hls_video_trim_start'] if (plan['hls_video_trim_start'] is not None and not is_img) else (plan['sync_trim_start'] if not is_img else None)
        eff_a_trim = plan['hls_audio_trim_start'] if (plan['hls_audio_trim_start'] is not None and not is_img) else (plan['sync_trim_start'] if not is_img else None)
        pts_anchor = None if is_img else plan['sync_pts_anchor']
        call['_pts_anchored'] = bool(pts_anchor is not None)

        old_sub_cfg = call.pop('sub_config_path', None)
        if old_sub_cfg:
            try:
                Path(old_sub_cfg).unlink(missing_ok=True)
            except Exception:
                pass
        old_dj_cfg = call.pop('dj_config_path', None)
        if old_dj_cfg:
            try:
                Path(old_dj_cfg).unlink(missing_ok=True)
            except Exception:
                pass
        old_sid = call.get('av_sync_id')
        if old_sid:
            try:
                av_sync.substatus_path_for(old_sid).unlink(missing_ok=True)
            except Exception:
                pass
        call['av_sync_id'] = None

        use_rtmp_hub = bool(video_active and has_video_stream and not is_img and os.path.isfile(RTMP_HUB_SCRIPT))
        if use_rtmp_hub:
            sync_id = uuid.uuid4().hex[:12]
            sub_enabled = bool(sub_raw and Path(sub_raw).is_file())
            cfg_path = _write_sub_config(
                sync_id,
                enabled=sub_enabled,
                subtitle_path=sub_raw,
                base_sec=sub_shift_offset,
                subtitle_offset=sub_user_offset,
                drift_sec_per_sec=sub_drift_rate,
                drift_anchor_sec=sub_drift_anchor,
                manual_override=bool(call.get('manual_sub_override')),
                same_route=bool(call.get('subtitle_same_route')),
                auto_normalize=True,
                force_check_seq=int(call.get('_sub_force_check_seq') or 0),
                render_screen=bool(call.get('subtitle_render_screen', True)),
                pts_anchored=bool(pts_anchor is not None),
            )
            dj_cfg_path = None
            if call.get('dj_desk'):
                dj_cfg_path = _write_dj_desk_config(
                    sync_id,
                    enabled=True,
                    duration_sec=float(call.get('duration') or (info.get('duration') if info else 0) or 180.0),
                    crossfade_sec=float(call.get('crossfade_sec') or 0.0),
                    base_sec=float(offset_val or 0.0),
                )
            _init_sync_state(sync_id, paused=(call.get('status') == 'paused'))
            call['av_sync_id'] = sync_id
            call['sub_config_path'] = cfg_path
            call['dj_config_path'] = dj_cfg_path
            dec_args = rtmp_streamer.build_rtmp_decoder_args(
                source_input,
                has_audio_stream=has_audio_stream,
                width=final_w,
                height=final_h,
                fps=eff_fps,
                video_stream_index=info.get('stream_index'),
                audio_stream_index=info.get('audio_stream_index'),
                video_count=int(info.get('video_count') or 1),
                audio_count=int(info.get('audio_count') or 1),
                pre_seek=0.0 if is_hls_proxy else offset_val,
                copyts=plan['sync_copyts'],
                video_trim_start=eff_v_trim,
                audio_trim_start=eff_a_trim,
                pts_anchor=pts_anchor,
                normalize_pts=plan['sync_normalize_pts'],
                strip_first_pts_zero=plan['sync_strip_first_pts_zero'],
                eq=call.get('eq') or 'off',
                bass=bool(call.get('bass')),
                volume=call.get('volume', 100),
                is_hls_proxy=is_hls_proxy,
                realtime=True,
                scale_needed=scale_needed,
            )
            rtmp_preset = (
                'ultrafast'
                if (active_vids >= 2 or load_ratio >= 0.65)
                else ('superfast' if bitrate_quality == 'FHD_1080p' else 'veryfast')
            )
            cmd_args = [
                sys.executable,
                RTMP_HUB_SCRIPT,
                '--sync-id', sync_id,
                '--width', str(final_w),
                '--height', str(final_h),
                '--fps', f'{eff_fps:.3f}',
                '--video-quality', bitrate_quality,
                '--preset', rtmp_preset,
                '--threads', str(enc_threads),
                '--sub-config', cfg_path,
                *(['--dj-config', dj_cfg_path] if dj_cfg_path else []),
                '--rtmp-env', 'LANCY_RTMP_TARGET',
                *(['--no-audio-eof'] if not has_audio_stream else []),
                '--',
                *dec_args,
            ]
        else:
            active_sub = (
                self.shift_subtitle(
                    sub_raw,
                    sub_shift_offset,
                    call.get('playback_id'),
                    subtitle_offset=sub_user_offset,
                    drift_sec_per_sec=sub_drift_rate,
                    drift_anchor_sec=sub_drift_anchor,
                )
                if (sub_raw and Path(sub_raw).is_file())
                else None
            )
            cmd_args = rtmp_streamer.build_rtmp_ffmpeg_args(
                source_input,
                call['_rtmp_target'],
                video=video_active,
                has_video_stream=has_video_stream,
                has_audio_stream=has_audio_stream,
                is_image=is_img,
                width=final_w,
                height=final_h,
                fps=eff_fps,
                video_quality=bitrate_quality,
                video_stream_index=info.get('stream_index'),
                audio_stream_index=info.get('audio_stream_index'),
                video_count=int(info.get('video_count') or 1),
                audio_count=int(info.get('audio_count') or 1),
                subtitle_path=active_sub,
                pre_seek=0.0 if is_hls_proxy else offset_val,
                copyts=plan['sync_copyts'] if not is_img else False,
                video_trim_start=eff_v_trim,
                audio_trim_start=eff_a_trim,
                pts_anchor=pts_anchor,
                normalize_pts=(plan['sync_normalize_pts'] and not is_img),
                strip_first_pts_zero=plan['sync_strip_first_pts_zero'],
                eq=call.get('eq') or 'off',
                bass=bool(call.get('bass')),
                volume=call.get('volume', 100),
                is_hls_proxy=is_hls_proxy,
            )
        call['publisher_verified'] = True
        call['publisher_muted'] = False
        await self._start_rtmp_proc(a, chat, call, cmd_args, is_standby=False)

    async def stream(self, a, chat, call):
        if call.get('stream_mode') == 'rtmp':
            return await self._stream_rtmp(a, chat, call)

        from pytgcalls.types import MediaStream, AudioQuality, VideoQuality, GroupCallConfig
        try:
            from pytgcalls.types.raw import Stream, VideoParameters
        except ImportError:
            Stream = None
            VideoParameters = None

        offset_val = float(call.get('offset') or 0.0)
        base_path = re.sub(r'[?&]start=[0-9.]+', '', str(call.get('path') or ''))
        cached_info = call.get('_probe_info')
        known_hls_proxy = bool(
            call.get('remote_proxy')
            and (
                '.m3u8' in base_path.lower()
                or 'hls' in str((cached_info or {}).get('format_name') or '').lower()
            )
        )
        effective_path = (
            f"{base_path}{'&' if '?' in base_path else '?'}start={offset_val:.3f}"
            if (known_hls_proxy and offset_val > 0.05)
            else base_path
        )
        ff = f'-ss {offset_val:.3f}' if (offset_val > 0.05 and not known_hls_proxy) else ''
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
        cf_sec = max(0.0, min(8.0, float(call.get('crossfade_sec') or 0.0)))
        fade_in_dur = min(1.2, cf_sec) if (cf_sec > 0.2 and call.get('dj_desk')) else 0.25
        fade_in = f'afade=t=in:st=0:d={fade_in_dur:.2f},' if not call['offset'] else ''
        dur_f = float(call.get('duration') or 0.0)
        fade_out = (
            f'afade=t=out:st={max(1.0, dur_f - cf_sec):.2f}:d={min(4.0, cf_sec):.2f},'
            if (call.get('dj_desk') and cf_sec > 0.5 and dur_f > (cf_sec + 6.0) and not call['offset'])
            else ''
        )
        vol_pct = call.get('volume')
        vol_gain = f'volume={max(0, min(200, int(vol_pct))) / 100.0:.4f},' if vol_pct is not None and int(vol_pct) != 100 else ''
        headroom_prefix = 'volume=0.5011872336,' if (eq_filter or vol_gain) else ''
        limiter_suffix = 'alimiter=limit=0.89:attack=7:release=80:level=0,' if (eq_filter or vol_gain) else ''
        is_hls_src = bool(call.get('_is_hls_proxy') or '/movie-proxy/' in str(call.get('path') or ''))
        resample_mode = 'aresample=48000:async=1:first_pts=0' if is_hls_src else 'aresample=48000:first_pts=0'
        filters = headroom_prefix + eq_filter + vol_gain + fade_in + fade_out + limiter_suffix + resample_mode
        ff += ' --audio ---mid -af ' + filters

        requested_quality = str(call.get('video_quality') or os.environ.get('VOICE_VIDEO_QUALITY') or 'HD_720p')
        if video_active and requested_quality == 'FHD_1080p':
            active_vids = sum(self._active_video_calls_for_account(al) for al in self.accounts)
            load_ratio = sub_align.host_load_pressure()
            if active_vids >= 2 or load_ratio >= 0.55:
                # Cap WebRTC 1080p down to 720p when multiple video streams or tight CPU load would stutter frames.
                requested_quality = 'HD_720p'
        video_quality = getattr(VideoQuality, requested_quality, getattr(VideoQuality, 'HD_720p', VideoQuality.SD_360p))
        vq_val = getattr(video_quality, 'value', None)
        if VideoParameters is not None and isinstance(vq_val, tuple) and len(vq_val) >= 3:
            vq_fps = min(30, max(15, int(vq_val[2])))
            video_params = VideoParameters(vq_val[0], vq_val[1], vq_fps, adjust_by_height=True)
            max_w, max_h = int(video_params.width), int(video_params.height)
        else:
            video_params = video_quality
            max_w, max_h = 1280, 720

        video_flags = MediaStream.Flags.REQUIRED if video_active else MediaStream.Flags.IGNORE
        if video_active:
            ff += ' --video ---mid -sws_flags lanczos'

        stream = MediaStream(effective_path, audio_parameters=AudioQuality.HIGH, video_parameters=video_params, audio_flags=MediaStream.Flags.REQUIRED, video_flags=video_flags, ffmpeg_parameters=ff or None)
        play_stream = stream
        if Stream is not None and callable(getattr(stream, 'check_stream', None)):
            await stream.check_stream()
            target_fps = 30
            if getattr(stream, 'camera', None) is not None:
                raw_fps = int(getattr(stream.camera.parameters, 'frame_rate', 30) or 30)
                target_fps = max(15, min(30, raw_fps))
                if hasattr(stream.camera.parameters, 'frame_rate') and raw_fps != target_fps:
                    stream.camera.parameters.frame_rate = target_fps
            plan = await self._resolve_media_sync_plan(
                call,
                base_path=base_path,
                offset_val=offset_val,
                max_w=max_w,
                max_h=max_h,
                target_fps=target_fps,
                video_active=video_active,
            )
            info = plan['info']
            is_hls_proxy = plan['is_hls_proxy']
            hls_seek_url = plan['hls_seek_url']
            sync_trim_start = plan['sync_trim_start']
            sync_pre_seek = plan['sync_pre_seek']
            sync_copyts = plan['sync_copyts']
            sync_normalize_pts = plan['sync_normalize_pts']
            sync_pts_anchor = plan['sync_pts_anchor']
            sync_strip_first_pts_zero = plan['sync_strip_first_pts_zero']
            hls_audio_trim_start = plan['hls_audio_trim_start']
            hls_video_trim_start = plan['hls_video_trim_start']
            sub_shift_offset = plan['sub_shift_offset']
            sub_user_offset = float(call.get('subtitle_offset') or 0.0)

            if getattr(stream, 'microphone', None) is not None and getattr(stream.microphone, 'path', None):
                if video_active and not (info and info.get('is_image', False)):
                    stream.microphone.path = rewrite_audio_ffmpeg_command(
                        stream.microphone.path,
                        stream_index=info.get('audio_stream_index') if info else None,
                        audio_count=info.get('audio_count', 1) if info else 1,
                        pre_seek=sync_pre_seek,
                        copyts=sync_copyts,
                        trim_start=hls_audio_trim_start if hls_audio_trim_start is not None else sync_trim_start,
                        normalize_pts=sync_normalize_pts or bool(sync_copyts),
                        pts_anchor=sync_pts_anchor,
                        strip_first_pts_zero=sync_strip_first_pts_zero,
                        input_url=hls_seek_url,
                    )
                elif offset_val > 0.05:
                    stream.microphone.path = rewrite_audio_ffmpeg_command(
                        stream.microphone.path,
                        pre_seek=0.0 if is_hls_proxy else offset_val,
                        normalize_pts=True,
                        input_url=hls_seek_url,
                    )
                elif call.get('remote_proxy') or '-reconnect_at_eof' in str(stream.microphone.path):
                    stream.microphone.path = strip_reconnect_at_eof(stream.microphone.path)

            if video_active and getattr(stream, 'camera', None) is not None:
                cam_w = int(getattr(stream.camera.parameters, 'width', max_w) or max_w)
                cam_h = int(getattr(stream.camera.parameters, 'height', max_h) or max_h)
                final_w, final_h = (plan['final_w'], plan['final_h']) if info else (max(2, cam_w - (cam_w % 2)), max(2, cam_h - (cam_h % 2)))
                stream.camera.parameters.width = final_w
                stream.camera.parameters.height = final_h
                src_fps = (info or {}).get('fps')
                if not plan.get('is_img') and src_fps and 18.0 <= float(src_fps) <= 25.5 and hasattr(stream.camera.parameters, 'frame_rate'):
                    cinema_fps = 24 if float(src_fps) <= 24.5 else 25
                    target_fps = cinema_fps
                    stream.camera.parameters.frame_rate = cinema_fps
                sub_raw = call.get('subtitle_path')
                is_img = plan['is_img']
                has_paired_av = bool(
                    getattr(stream, 'microphone', None) is not None
                    and getattr(stream.microphone, 'path', None)
                    and not is_img
                    and os.path.isfile(AV_SYNC_SCRIPT)
                )
                old_sub_cfg = call.pop('sub_config_path', None)
                if old_sub_cfg:
                    try:
                        Path(old_sub_cfg).unlink(missing_ok=True)
                    except Exception:
                        pass
                old_dj_cfg = call.pop('dj_config_path', None)
                if old_dj_cfg:
                    try:
                        Path(old_dj_cfg).unlink(missing_ok=True)
                    except Exception:
                        pass
                old_sid = call.get('av_sync_id')
                if old_sid:
                    try:
                        av_sync.substatus_path_for(old_sid).unlink(missing_ok=True)
                    except Exception:
                        pass
                call['av_sync_id'] = None
                sub_drift_rate = float(call.get('sub_drift_sec_per_sec') or 0.0)
                sub_drift_anchor = float(call.get('sub_drift_anchor_sec') or 0.0)
                dj_desk_on = bool(call.get('dj_desk'))
                dj_desk_img = call.get('dj_desk_image') if dj_desk_on else None
                dj_desk_override = bool(dj_desk_on and dj_desk_img and Path(dj_desk_img).is_file())
                if dj_desk_on:
                    desk_fps = 20 if sub_align.host_load_pressure() < 0.70 else 12
                    target_fps = desk_fps
                    if hasattr(stream.camera.parameters, 'frame_rate'):
                        stream.camera.parameters.frame_rate = desk_fps
                has_paired_av = bool(
                    getattr(stream, 'microphone', None) is not None
                    and getattr(stream.microphone, 'path', None)
                    and (not is_img or dj_desk_on)
                    and os.path.isfile(AV_SYNC_SCRIPT)
                )
                active_sub = (
                    self.shift_subtitle(
                        sub_raw,
                        sub_shift_offset,
                        call.get('playback_id'),
                        subtitle_offset=sub_user_offset,
                        drift_sec_per_sec=sub_drift_rate,
                        drift_anchor_sec=sub_drift_anchor,
                    )
                    if (not has_paired_av and sub_raw and Path(sub_raw).is_file())
                    else None
                )
                eff_video_trim = hls_video_trim_start if (hls_video_trim_start is not None and not is_img) else (sync_trim_start if not is_img else None)
                eff_video_anchor = None if (is_img or dj_desk_override) else sync_pts_anchor
                skip_scale = bool(info and not is_img and not dj_desk_override and int(info.get('width') or 0) == int(final_w) and int(info.get('height') or 0) == int(final_h))
                if dj_desk_override:
                    dur_pad = min(14400.0, max(30.0, float(call.get('duration') or (info.get('duration') if info else 0) or 300.0) + 12.0))
                    stream.camera.path = (
                        f'ffmpeg -nostdin -hide_banner -loglevel error '
                        f'-re -loop 1 -framerate {int(target_fps)} -i {shlex.quote(dj_desk_img)} '
                        f'-t {dur_pad:.2f} -an -sn -dn '
                        f'-vf scale={int(final_w)}:{int(final_h)}:flags=lanczos,setsar=1,format=yuv420p '
                        f'-f rawvideo -pix_fmt yuv420p pipe:1'
                    )
                else:
                    stream.camera.path = rewrite_video_ffmpeg_command(
                        stream.camera.path,
                        final_w,
                        final_h,
                        subtitle_path=active_sub,
                        stream_index=info.get('stream_index') if info else None,
                        video_count=info.get('video_count', 1) if info else 1,
                        is_image=is_img,
                        fps=target_fps if (not is_img or dj_desk_on) else None,
                        trim_start=eff_video_trim,
                        normalize_pts=(sync_normalize_pts or not is_img),
                        pts_anchor=eff_video_anchor,
                        pre_seek=sync_pre_seek if not is_img else None,
                        copyts=sync_copyts if not is_img else False,
                        input_url=hls_seek_url if not is_img else None,
                        skip_scale=skip_scale,
                    )
                if getattr(stream, 'microphone', None) is not None and getattr(stream.microphone, 'path', None) and getattr(stream.camera, 'path', None):
                    pair_id = f"{call.get('playback_id') or abs(int(chat))}-{uuid.uuid4().hex[:8]}"
                    sid = re.sub(r'[^a-zA-Z0-9_-]', '_', pair_id)[:64]
                    sub_cfg_path = None
                    dj_cfg_path = None
                    if (not is_img or dj_desk_on) and os.path.isfile(AV_SYNC_SCRIPT):
                        sub_cfg_path = _write_sub_config(
                            sid,
                            enabled=bool(sub_raw and Path(sub_raw).is_file()),
                            subtitle_path=sub_raw,
                            base_sec=sub_shift_offset,
                            subtitle_offset=sub_user_offset,
                            drift_sec_per_sec=sub_drift_rate,
                            drift_anchor_sec=sub_drift_anchor,
                            manual_override=bool(call.get('manual_sub_override')),
                            same_route=bool(call.get('subtitle_same_route')),
                            auto_normalize=True,
                            force_check_seq=int(call.get('_sub_force_check_seq') or 0),
                            render_screen=bool(call.get('subtitle_render_screen', True)),
                            pts_anchored=bool(eff_video_anchor is not None),
                        )
                        if dj_desk_on:
                            dj_cfg_path = _write_dj_desk_config(
                                sid,
                                enabled=True,
                                duration_sec=float(call.get('duration') or (info.get('duration') if info else 0) or 180.0),
                                crossfade_sec=float(call.get('crossfade_sec') or 0.0),
                                base_sec=float(offset_val or 0.0),
                            )
                        call['av_sync_id'] = sid
                        call['sub_config_path'] = sub_cfg_path
                        call['dj_config_path'] = dj_cfg_path
                        call['sub_base_sec'] = float(sub_shift_offset)
                        call['_pts_anchored'] = bool(eff_video_anchor is not None)

                    wrap_a_in = stream.microphone.path
                    wrap_v_in = stream.camera.path
                    music_freerun = bool(dj_desk_on or dj_desk_override or call.get('is_music') or call.get('music_freerun'))
                    call['music_freerun'] = music_freerun
                    is_real_engine = (not self.factory) and type(a.get('engine')).__module__.startswith('pytgcalls')
                    if (is_real_engine or getattr(self, 'use_av_hub_in_tests', False)) and not is_img and not music_freerun and not dj_desk_override and os.path.isfile(AV_HUB_SCRIPT):
                        unified_cmd = build_unified_av_ffmpeg_command(wrap_a_in, wrap_v_in, output_format='nut')
                        if unified_cmd:
                            self._cleanup_hub(call)
                            hub_proc = await asyncio.create_subprocess_exec(
                                sys.executable, AV_HUB_SCRIPT, '--role', 'hub', '--sync-id', sid, '--',
                                *shlex.split(unified_cmd),
                                stdin=asyncio.subprocess.DEVNULL,
                                stdout=asyncio.subprocess.DEVNULL,
                                stderr=asyncio.subprocess.DEVNULL,
                            )
                            call['_hub_proc'] = hub_proc
                            call['_hub_sync_id'] = sid
                            wrap_a_in = f"python3 {shlex.quote(AV_HUB_SCRIPT)} --role read-audio --sync-id {shlex.quote(sid)}"
                            wrap_v_in = f"python3 {shlex.quote(AV_HUB_SCRIPT)} --role read-video --sync-id {shlex.quote(sid)}"

                    stream.microphone.path, stream.camera.path = wrap_av_sync_pair(
                        wrap_a_in,
                        wrap_v_in,
                        frame_bytes=final_w * final_h * 3 // 2,
                        fps=target_fps if (not is_img or dj_desk_on) else 30,
                        sync_id=sid,
                        width=final_w if (sub_cfg_path or dj_cfg_path) else 0,
                        height=final_h if (sub_cfg_path or dj_cfg_path) else 0,
                        sub_config_path=sub_cfg_path,
                        dj_config_path=dj_cfg_path,
                        music_freerun=music_freerun,
                    )
            elif (
                getattr(stream, 'microphone', None) is not None
                and getattr(stream.microphone, 'path', None)
                and not call.get('av_sync_id')
                and os.path.isfile(AV_SYNC_SCRIPT)
            ):
                pair_id = f"{call.get('playback_id') or abs(int(chat))}-{uuid.uuid4().hex[:8]}"
                sid = re.sub(r'[^a-zA-Z0-9_-]', '_', pair_id)[:64]
                call['av_sync_id'] = sid
                call['music_freerun'] = True
                stream.microphone.path = (
                    f"{shlex.quote(sys.executable)} {shlex.quote(AV_SYNC_SCRIPT)} "
                    f"--role audio --audio-only --music-freerun --sync-id {shlex.quote(sid)} "
                    f"-- {stream.microphone.path}"
                )
            play_stream = Stream(
                microphone=getattr(stream, 'microphone', None),
                speaker=getattr(stream, 'speaker', None),
                camera=getattr(stream, 'camera', None),
                screen=getattr(stream, 'screen', None),
            )
        call['last_seek_at'] = time.monotonic()
        await asyncio.wait_for(a['engine'].play(chat, play_stream, config=GroupCallConfig(auto_start=False)), 25)
        try:
            t_after = float(await asyncio.wait_for(a['engine'].time(chat), 1.5))
            call['engine_time_base'] = t_after if t_after >= 0.5 else 0.0
        except Exception:
            call['engine_time_base'] = 0.0
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

    async def _call_elapsed_seconds(self, engine, chat, call, *, timeout=3.0):
        if call.get('stream_mode') == 'rtmp':
            if call.get('status') in {'playing', 'paused'} and not call.get('rtmp_standby'):
                sid = call.get('av_sync_id')
                if sid:
                    metrics = _read_sync_metrics(sid)
                    if metrics and int(metrics.get('video_state') or 0) != 0:
                        return max(0.0, float(metrics.get('media_pts_sec') or 0.0))
            if call.get('status') == 'playing' and not call.get('rtmp_standby'):
                return max(0.0, time.monotonic() - float(call.get('rtmp_started_at') or time.monotonic()))
            return 0.0
        raw_elapsed = float(await asyncio.wait_for(engine.time(chat), timeout))
        base_t = float(call.get('engine_time_base') or 0.0)
        return max(0.0, raw_elapsed - base_t) if raw_elapsed >= base_t else raw_elapsed

    async def play(self, data):
        chat = int(data['chat_id'])
        if chat >= 0 or self.closing: raise VoiceFailure('INVALID_REQUEST')
        async with self.chat_lock(chat):
            path = self.resolve_media_input(data)
            sub_path = self.source_subtitle(data.get('subtitle_path'))
            max_vid_raw = data.get('max_video_calls_per_account')
            max_vid_cap = int(max_vid_raw) if max_vid_raw is not None and int(max_vid_raw) > 0 else None
            a = await self.lease(chat, data.get('account_alias'), for_video=bool(data.get('video')), max_video_calls=max_vid_cap)
            await self._stop_secondary_tile_unlocked(chat)
            previous = self.calls.get(chat)
            if previous and previous['playback_id'] == data.get('playback_id'): return {'ok': True, 'account_alias': a['alias'], 'status': previous['status'], 'stream_mode': previous.get('stream_mode', 'interactive')}
            req_mode = str(data.get('stream_mode') or '').strip().lower()
            stream_mode = req_mode if req_mode in {'interactive', 'rtmp'} else (previous.get('stream_mode', 'interactive') if previous else 'interactive')
            wants_rtmp = stream_mode == 'rtmp'
            call_duration = float(data.get('duration_seconds') or 0)
            start_sec = max(0.0, float(data.get('start_seconds') or 0.0))
            if call_duration > 0 and start_sec >= call_duration:
                start_sec = max(0.0, call_duration - 2.0)
            vc_title = str(data.get('vc_title') or data.get('title') or '').strip()[:64]
            sub_offset = float(data.get('subtitle_offset') or 0.0)
            sub_same_route = bool(data.get('subtitle_same_route'))
            sub_render_screen = bool(data.get('subtitle_render_screen', True))
            sub_drift_rate = sub_align.clamp_drift_rate(data.get('sub_drift_sec_per_sec') or 0.0)
            sub_drift_anchor = float(data.get('sub_drift_anchor_sec') or 0.0)
            pref_audio_lang = _norm_lang(data.get('preferred_audio_lang') or data.get('original_language'))
            dj_desk_on = bool(data.get('dj_desk'))
            is_music = bool(data.get('is_music')) or dj_desk_on
            dj_desk_img = self.source_dj_image(data.get('dj_desk_image')) if dj_desk_on else None
            crossfade_sec = max(0.0, min(12.0, float(data.get('crossfade_sec') or 0.0)))
            created_with_title = False
            if previous:
                if previous.get('stream_mode') == 'rtmp':
                    await self._stop_rtmp_proc(previous, wait_settle=(stream_mode != 'rtmp'))
                self._cleanup_sub_overlay(previous)
            call = {'alias': a['alias'], 'path': path, 'stream_mode': stream_mode, 'preferred_audio_lang': pref_audio_lang, 'reject_dub': bool(data.get('reject_dub')), 'subtitle_path': sub_path, 'subtitle_offset': sub_offset, 'subtitle_same_route': sub_same_route, 'subtitle_render_screen': sub_render_screen, 'sub_drift_sec_per_sec': sub_drift_rate, 'sub_drift_anchor_sec': sub_drift_anchor, 'manual_sub_override': bool(data.get('subtitle_manual_override', False)), 'auto_subtitle_offset': None, 'dj_desk': dj_desk_on, 'is_music': is_music, 'music_freerun': is_music, 'dj_desk_image': dj_desk_img, 'crossfade_sec': crossfade_sec, 'video': bool(data.get('video')), 'video_quality': str(data.get('video_quality') or os.environ.get('VOICE_VIDEO_QUALITY') or 'HD_720p'), 'bass': bool(data.get('bass')), 'eq': str(data.get('eq') or ('bass' if data.get('bass') else 'off')), 'is_channel': bool(data.get('is_channel')), 'remote_proxy': bool(data.get('remote_proxy')), 'duration': call_duration, 'offset': start_sec, 'playback_id': str(data['playback_id']), 'status': 'buffering', 'clock_errors': 0, 'position_seconds': start_sec if start_sec > 0 else None, 'last_known_position': start_sec, 'retries': 0, 'retry_after': 0.0, 'last_progress': time.monotonic(), 'vc_title': vc_title}
            if previous and previous.get('stream_mode') == 'rtmp' and stream_mode == 'rtmp' and previous.get('_rtmp_target'):
                call['_rtmp_target'] = previous['_rtmp_target']
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
                    and previous.get('stream_mode', 'interactive') == stream_mode
                    and previous.get('status') in {'playing', 'paused', 'buffering', 'idle'}
                    and previous.get('native_call') is not None
                )
                if can_reuse_call:
                    call['native_call'] = previous['native_call']
                elif not self.factory or getattr(self, 'auto_create_call_in_tests', False) or wants_rtmp:
                    await self.resolve_destination(a['client'], chat)
                    try: peer, native = await self.native_call(a['client'], chat)
                    except Exception: peer, native = None, None
                    if native is not None and (req_mode in {'interactive', 'rtmp'} or previous is None or previous.get('stream_mode') != stream_mode):
                        existing_is_rtmp = await self._get_group_call_is_rtmp(a, native)
                        if existing_is_rtmp is not None and existing_is_rtmp != wants_rtmp:
                            if not self.factory:
                                clear_engine_cache(a['engine'], chat)
                                try: await asyncio.wait_for(a['engine'].leave_call(chat), 5)
                                except Exception: pass
                            await self._discard_group_call(a, native)
                            if not self.factory:
                                await asyncio.sleep(0.6)
                                try:
                                    _, chk_native = await self.native_call(a['client'], chat)
                                    if chk_native is not None:
                                        await self._discard_group_call(a, chk_native)
                                        await asyncio.sleep(0.4)
                                except Exception:
                                    pass
                            native = None
                    prev_id = getattr(previous.get('native_call'), 'id', None) if previous else None
                    curr_id = getattr(native, 'id', None) if native else None
                    need_reset = (not self.factory and previous is None) or native is None or (prev_id is not None and curr_id != prev_id)
                    if need_reset and not wants_rtmp:
                        clear_engine_cache(a['engine'], chat)
                        try: await asyncio.wait_for(a['engine'].leave_call(chat), 5)
                        except Exception: pass
                    if peer is not None and native is None:
                        native = await self._create_group_call(a, chat, peer, vc_title=vc_title, rtmp_stream=wants_rtmp)
                        created_with_title = bool(vc_title and native is not None)
                    if native is not None:
                        call['native_call'] = native
                        if wants_rtmp and not call.get('_rtmp_target') and peer is not None and (not self.factory or getattr(self, 'test_rtmp_ingest', False)):
                            rtmp_target, _, _ = await self._fetch_rtmp_ingest(a, peer)
                            call['_rtmp_target'] = rtmp_target
                        elif wants_rtmp and self.factory and not call.get('_rtmp_target'):
                            call['_rtmp_target'] = 'rtmps://mock-tg-rtmp.local/live/mock-key'
                        bind = getattr(getattr(a['engine'], '_app', None), '_bind_client', None)
                        if not wants_rtmp and bind and hasattr(bind, '_cache'):
                            try:
                                bind._cache.drop_cache(chat)
                                bind._cache.set_cache(chat, native)
                            except Exception: pass
                    elif not call.get('native_call'):
                        raise VoiceFailure('NO_ACTIVE_CALL')
                try:
                    await self.stream(a, chat, call)
                except Exception as stream_err:
                    if (not wants_rtmp) and (not self.factory or getattr(self, 'auto_create_call_in_tests', False)) and classify(stream_err) in {'NO_ACTIVE_CALL', 'CALL_FAILED', 'PUBLISHER_UNVERIFIED'}:
                        clear_engine_cache(a['engine'], chat)
                        try: await asyncio.wait_for(a['engine'].leave_call(chat), 5)
                        except Exception: pass
                        try: await self.resolve_destination(a['client'], chat)
                        except Exception: pass
                        peer, native = await self.native_call(a['client'], chat)
                        if native is None and peer is not None:
                            try:
                                native = await self._create_group_call(a, chat, peer, vc_title=vc_title, rtmp_stream=False)
                                created_with_title = bool(vc_title and native is not None)
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
                    elif type(stream_err).__name__ in {'NoVideoSourceFound', 'InvalidVideoProportion'} and (call.get('video') or call.get('dj_desk')) and (call.get('is_music') or not call.get('is_channel')):
                        log.warning('Video source unavailable for chat=%s (%s); falling back to audio-only stream', chat, type(stream_err).__name__)
                        call['video'] = False
                        call['dj_desk'] = False
                        call['dj_desk_image'] = None
                        await self.stream(a, chat, call)
                    elif type(stream_err).__name__ == 'FloodWait' and getattr(stream_err, 'value', 0) <= 10:
                        await asyncio.sleep(getattr(stream_err, 'value', 1))
                        await self.stream(a, chat, call)
                    else:
                        raise stream_err
                if vc_title and not created_with_title:
                    await self.set_group_call_title(a, call.get('native_call'), vc_title)
                if call.get('native_call') is not None and (not self.factory or getattr(self, 'test_call_settings', False) or data.get('messages_enabled') is not None):
                    msg_pref = data.get('messages_enabled')
                    await self.ensure_call_settings(a, chat, call, messages_enabled=(True if msg_pref is None else bool(msg_pref)))
                call_invite_link = await self.resolve_call_invite_link(a, call.get('native_call'))
                if call_invite_link:
                    call['call_invite_link'] = call_invite_link
                self.prune_shifted_subtitles(active_playback_id=call['playback_id'])
                landed_pos = float(call.get('_landed_offset')) if call.get('_landed_offset') is not None else start_sec
                if call.get('_landed_offset') is not None:
                    call['offset'] = landed_pos
                    if landed_pos > 0:
                        call['position_seconds'] = landed_pos
                        call['last_known_position'] = landed_pos
                call['status'] = 'playing'; self.calls[chat] = call; self.last_failures.pop(chat, None); self.last_ended_positions.pop(chat, None)
                self._maybe_schedule_sub_align(a, chat, call)
                self.ensure_sync_monitor()
                if bool(data.get('voice_ai_enabled', True)):
                    auth_ids = data.get('voice_authorized_ids')
                    await self.voice_listener.start_chat(
                        chat,
                        a['alias'],
                        enabled=True,
                        authorized_user_ids=auth_ids if isinstance(auth_ids, list) else None,
                        enforce_auth=bool(data.get('voice_enforce_auth', False)),
                    )
                else:
                    await self.voice_listener.stop_chat(chat)
                probe_meta = call.get('_probe_info') or {}
                return {
                    'ok': True,
                    'account_alias': a['alias'],
                    'status': 'playing',
                    'position_seconds': landed_pos,
                    'call_invite_link': call.get('call_invite_link'),
                    'stream_mode': stream_mode,
                    'messages_enabled': call.get('messages_enabled'),
                    'audio_language': probe_meta.get('audio_language'),
                    'audio_is_dub': bool(probe_meta.get('audio_is_dub')),
                }
            except Exception as error:
                if call.get('stream_mode') == 'rtmp':
                    await self._stop_rtmp_proc(call, wait_settle=False)
                self._cleanup_sub_overlay(call)
                self.remember_failure(chat, error)
                # A failed replacement can leave native media partially changed. Retain lease
                # until this chat's leave is confirmed; sibling calls remain independent.
                try:
                    if call.get('stream_mode') != 'rtmp':
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
            is_rtmp = call.get('stream_mode') == 'rtmp'
            hot_paused = False
            hot_resumed = False
            if op == 'stop':
                await self._stop_secondary_tile_unlocked(chat)
                if self.voice_listener:
                    await self.voice_listener.stop_chat(chat)
                if is_rtmp:
                    await self._stop_rtmp_proc(call, wait_settle=False)
                self._cleanup_sub_overlay(call)
                clear_engine_cache(engine, chat)
                if is_rtmp:
                    if not self.factory or getattr(self, 'auto_create_call_in_tests', False):
                        await self._discard_group_call(a, call.get('native_call'))
                else:
                    try: await asyncio.wait_for(engine.leave_call(chat), 15)
                    except Exception as e:
                        if classify(e) != 'NO_ACTIVE_CALL': raise
                if data.get('leave_membership'): await self.leave_membership(a, chat)
                self.calls.pop(chat, None); self.prepared.pop(chat, None); self.last_ended_positions.pop(chat, None); self.release_destination(a, chat); a.get('group_grants', set()).discard(chat)
                return {'ok': True, 'status': 'stopped'}
            if op == 'idle':
                await self._stop_secondary_tile_unlocked(chat)
                self._cleanup_sub_overlay(call)
                if is_rtmp:
                    call['status'] = 'idle'; call['playback_id'] = None; call['position_seconds'] = None
                    if call.get('_rtmp_target'):
                        await self._start_rtmp_proc(a, chat, call, rtmp_streamer.build_rtmp_standby_args(call['_rtmp_target']), is_standby=True)
                else:
                    # Empty raw stream replaces FFmpeg sources without leaving the call.
                    from pytgcalls.types.raw.stream import Stream
                    from pytgcalls.types import GroupCallConfig
                    await asyncio.wait_for(engine.play(chat, Stream(), config=GroupCallConfig(auto_start=False)), 10)
                    call['status'] = 'idle'; call['playback_id'] = None; call['position_seconds'] = None
            elif op in {'pause', 'resume'}:
                rtmp_proc = call.get('_rtmp_proc')
                rtmp_hub_live = bool(is_rtmp and call.get('av_sync_id') and not call.get('rtmp_standby') and (
                    (self.factory and getattr(self, 'rtmp_mock_spawn', None) is not None)
                    or (self.factory and call.get('_rtmp_proc') is None and call.get('av_sync_id'))
                    or (rtmp_proc is not None and rtmp_proc.returncode is None)
                ))
                was_paused = (call.get('status') == 'paused')
                was_muted_live = bool(call.get('publisher_muted') and not was_paused)
                if op == 'pause' and call.get('status') in {'playing', 'recovering', 'error'}:
                    if call.get('publisher_muted'):
                        call['publisher_muted_while_paused'] = True
                    try:
                        elapsed = await self._call_elapsed_seconds(engine, chat, call, timeout=2.0)
                        paused_pos = max(0.0, float(call.get('offset') or 0.0) + elapsed)
                        if call.get('duration'):
                            paused_pos = min(paused_pos, max(0.0, float(call['duration']) - 1.0))
                        call['last_known_position'] = max(float(call.get('last_known_position') or 0.0), paused_pos)
                        if not call.get('publisher_muted'):
                            call['position_seconds'] = call['last_known_position']
                        if is_rtmp and not rtmp_hub_live:
                            call['offset'] = call['last_known_position']
                    except Exception:
                        pass
                if is_rtmp:
                    if op == 'pause':
                        call['status'] = 'paused'
                        if rtmp_hub_live:
                            _set_sync_paused(call.get('av_sync_id'), True)
                            hot_paused = True
                        elif call.get('_rtmp_target'):
                            await self._start_rtmp_proc(a, chat, call, rtmp_streamer.build_rtmp_standby_args(call['_rtmp_target']), is_standby=True)
                    else:
                        call['status'] = 'playing'
                        if rtmp_hub_live:
                            _set_sync_paused(call.get('av_sync_id'), False)
                            hot_resumed = True
                        else:
                            call['offset'] = float(call.get('last_known_position') or call.get('offset') or 0.0)
                            await self._stream_rtmp(a, chat, call)
                else:
                    if call.get('av_sync_id'):
                        _set_sync_tts_hold(call.get('av_sync_id'), False)
                        if op == 'pause':
                            _mutate_sync_state(call.get('av_sync_id'), lambda st: setattr(st, 'sync_flags', int(st.sync_flags) | 4))
                            if not self.factory:
                                await asyncio.sleep(0.08)
                        _set_sync_paused(call.get('av_sync_id'), op == 'pause')
                    hub_proc = call.get('_hub_proc')
                    hub_dead = bool(op == 'resume' and hub_proc is not None and getattr(hub_proc, 'returncode', None) is not None)
                    locally_paused = was_paused
                    if op == 'resume' and not locally_paused:
                        binding = getattr(engine, '_binding', None)
                        if binding is not None and hasattr(binding, 'get_state'):
                            try:
                                b_state = await asyncio.wait_for(binding.get_state(chat), 3)
                                locally_paused = bool(getattr(b_state, 'paused', False))
                            except Exception:
                                pass
                    if hub_dead and call.get('path'):
                        call['offset'] = float(call.get('last_known_position') or call.get('offset') or 0.0)
                        call['status'] = 'playing'
                        call['publisher_muted_while_paused'] = False
                        await self.stream(a, chat, call)
                    else:
                        try:
                            if op == 'pause' or locally_paused or not was_muted_live:
                                await asyncio.wait_for(getattr(engine, op)(chat), 10)
                            if op == 'resume':
                                await asyncio.wait_for(self.ensure_publisher(a, chat, call), 12)
                                call['publisher_muted_while_paused'] = False
                        except Exception as resume_err:
                            if op == 'resume' and call.get('path') and (not isinstance(resume_err, VoiceFailure) or resume_err.code != 'PERMISSION_DENIED'):
                                try:
                                    call['offset'] = float(call.get('last_known_position') or call.get('offset') or 0.0)
                                    call['status'] = 'playing'
                                    call['publisher_muted_while_paused'] = False
                                    await self.stream(a, chat, call)
                                except Exception:
                                    try: await asyncio.wait_for(engine.pause(chat), 8)
                                    except Exception: pass
                                    if call.get('av_sync_id'):
                                        _set_sync_paused(call.get('av_sync_id'), True)
                                    raise
                            else:
                                if op == 'resume' and (was_paused or locally_paused):
                                    try: await asyncio.wait_for(engine.pause(chat), 8)
                                    except Exception: pass
                                    if call.get('av_sync_id'):
                                        _set_sync_paused(call.get('av_sync_id'), True)
                                raise
                call['status'] = 'paused' if op == 'pause' else 'playing'; call['last_progress'] = time.monotonic()
                if self.voice_listener:
                    try:
                        if op == 'resume':
                            self.voice_listener.note_user_resume(chat)
                        else:
                            self.voice_listener.note_user_pause(chat)
                    except Exception:
                        pass
                if op == 'resume':
                    call['publisher_muted'] = False
                    call['publisher_verified'] = True
                    if call.get('position_seconds') is None and call.get('last_known_position') is not None:
                        call['position_seconds'] = call.get('last_known_position')
                tile = self.secondary_tiles.get(chat)
                if tile:
                    a2 = self.accounts.get(tile.get('alias'))
                    eng2 = a2.get('engine') if a2 else None
                    if eng2 is not None and hasattr(eng2, op):
                        try:
                            await asyncio.wait_for(getattr(eng2, op)(chat), 6)
                            tile['status'] = call['status']
                        except Exception:
                            pass
            elif op == 'volume':
                volume = int(data['volume'])
                if not 0 <= volume <= 200: raise VoiceFailure('INVALID_REQUEST')
                if is_rtmp:
                    prev_vol = call.get('volume', 100)
                    call['volume'] = volume
                    if call.get('status') == 'playing' and prev_vol != volume:
                        elapsed = await self._call_elapsed_seconds(engine, chat, call, timeout=2.0)
                        new_offset = min(max(0.0, call.get('offset', 0.0) + elapsed), max(0.0, (call.get('duration') or 0.0) - 1.0)) if call.get('duration') else max(0.0, call.get('offset', 0.0) + elapsed)
                        call['offset'] = new_offset
                        await self._stream_rtmp(a, chat, call)
                        call['position_seconds'] = new_offset
                        call['last_progress'] = time.monotonic()
                elif self.factory:
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
                            elapsed = await self._call_elapsed_seconds(engine, chat, call, timeout=3.0)
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
                old_render_screen = bool(call.get('subtitle_render_screen', True))
                new_render_screen = bool(data.get('subtitle_render_screen')) if data.get('subtitle_render_screen') is not None else old_render_screen
                sub_swapped = (sub_path != old_sub)
                render_changed = (new_render_screen != old_render_screen)
                call['subtitle_render_screen'] = new_render_screen
                manual_flag = data.get('subtitle_manual_override')
                if manual_flag is not None:
                    call['manual_sub_override'] = bool(manual_flag)
                elif sub_swapped:
                    call['manual_sub_override'] = False
                elif data.get('subtitle_offset') is not None and abs(sub_offset - old_sub_offset) >= 0.005:
                    call['manual_sub_override'] = True
                if data.get('subtitle_same_route') is not None:
                    call['subtitle_same_route'] = bool(data.get('subtitle_same_route'))
                changed = (sub_swapped or render_changed or abs(sub_offset - old_sub_offset) >= 0.005)
                if sub_swapped:
                    call['auto_subtitle_offset'] = None
                    call['sub_drift_sec_per_sec'] = sub_align.clamp_drift_rate(data.get('sub_drift_sec_per_sec') or 0.0)
                    call['sub_drift_anchor_sec'] = float(data.get('sub_drift_anchor_sec') or 0.0)
                    call['subtitle_sync'] = None
                    call['_sub_force_check_seq'] = int(call.get('_sub_force_check_seq') or 0) + 1
                else:
                    if data.get('sub_drift_sec_per_sec') is not None:
                        call['sub_drift_sec_per_sec'] = sub_align.clamp_drift_rate(data.get('sub_drift_sec_per_sec') or 0.0)
                    if data.get('sub_drift_anchor_sec') is not None:
                        call['sub_drift_anchor_sec'] = float(data.get('sub_drift_anchor_sec') or 0.0)
                    if abs(sub_offset - old_sub_offset) >= 0.005 and isinstance(call.get('subtitle_sync'), dict):
                        call['subtitle_sync'] = {
                            **call['subtitle_sync'],
                            'applied_offset_sec': sub_offset,
                            'manual_override': bool(call.get('manual_sub_override')),
                            'updated_at': round(time.time(), 3),
                        }
                if call.get('sub_config_path') and call.get('av_sync_id') and call.get('status') in {'playing', 'paused'}:
                    call['subtitle_path'] = sub_path
                    call['subtitle_offset'] = sub_offset
                    self._hot_update_subtitles(call)
                    if sub_swapped and sub_path and not call.get('manual_sub_override'):
                        self._maybe_schedule_sub_align(a, chat, call)
                    return {
                        'ok': True,
                        'status': call['status'],
                        'position_seconds': call.get('position_seconds'),
                        'hot_reloaded': True,
                        'subtitle_offset': call.get('subtitle_offset'),
                        'sub_drift_sec_per_sec': float(call.get('sub_drift_sec_per_sec') or 0.0),
                        'sub_drift_anchor_sec': float(call.get('sub_drift_anchor_sec') or 0.0),
                        'subtitle_sync': call.get('subtitle_sync'),
                    }
                elif changed and call.get('status') in {'playing', 'paused'}:
                    try:
                        elapsed = await self._call_elapsed_seconds(engine, chat, call, timeout=3.0)
                    except Exception:
                        elapsed = 0.0
                    new_offset = max(0.0, call.get('offset', 0.0) + elapsed)
                    old_offset = call.get('offset', 0.0)
                    was_paused = call.get('status') == 'paused'
                    call['subtitle_path'] = sub_path
                    call['subtitle_offset'] = sub_offset
                    call['offset'] = new_offset
                    try:
                        if not (is_rtmp and was_paused):
                            await self.stream(a, chat, call)
                            if was_paused and not is_rtmp:
                                await asyncio.wait_for(engine.pause(chat), 8)
                        call['position_seconds'] = new_offset
                        call['last_progress'] = time.monotonic()
                    except Exception:
                        call['subtitle_path'] = old_sub
                        call['subtitle_offset'] = old_sub_offset
                        call['offset'] = old_offset
                        raise
                    if sub_swapped and sub_path and not call.get('manual_sub_override'):
                        self._maybe_schedule_sub_align(a, chat, call)
                else:
                    call['subtitle_path'] = sub_path
                    call['subtitle_offset'] = sub_offset
            elif op == 'subcheck':
                sub_path = call.get('subtitle_path')
                auto_fix = bool(data.get('auto_fix', True))
                if not sub_path or not Path(sub_path).is_file():
                    call['subtitle_sync'] = {
                        'status': 'none',
                        'message': 'No subtitle track active',
                        'updated_at': round(time.time(), 3),
                    }
                    return {
                        'ok': True,
                        'status': call['status'],
                        'position_seconds': call.get('position_seconds'),
                        'subtitle_offset': float(call.get('subtitle_offset') or 0.0),
                        'auto_subtitle_offset': call.get('auto_subtitle_offset'),
                        'sub_drift_sec_per_sec': float(call.get('sub_drift_sec_per_sec') or 0.0),
                        'sub_drift_anchor_sec': float(call.get('sub_drift_anchor_sec') or 0.0),
                        'subtitle_sync': call['subtitle_sync'],
                    }
                old_align_task = call.pop('_sub_align_task', None)
                if old_align_task is not None and not old_align_task.done():
                    try:
                        old_align_task.cancel()
                    except Exception:
                        pass
                if auto_fix:
                    call['manual_sub_override'] = False
                call['_sub_force_check_seq'] = int(call.get('_sub_force_check_seq') or 0) + 1
                self._hot_update_subtitles(call)
                probe_res = None
                probe_fn = getattr(self, 'sub_align_probe', None)
                media_url = str(call.get('path') or '')
                is_same_route = bool(call.get('subtitle_same_route'))
                if callable(probe_fn):
                    try:
                        maybe = probe_fn(
                            media_url,
                            sub_path,
                            seek_offset=float(call.get('position_seconds') or call.get('offset') or 0.0),
                            is_hls_proxy=bool(call.get('_is_hls_proxy')),
                            same_route=is_same_route,
                        )
                        probe_res = await maybe if asyncio.iscoroutine(maybe) else maybe
                    except Exception:
                        probe_res = None
                elif not self.factory and media_url:
                    try:
                        probe_res = await asyncio.wait_for(
                            asyncio.to_thread(
                                sub_align.probe_audio_and_align,
                                media_url,
                                sub_path,
                                seek_offset=float(call.get('position_seconds') or call.get('offset') or 0.0),
                                is_hls_proxy=bool(call.get('_is_hls_proxy')),
                                same_route=is_same_route,
                                audio_stream_index=(call.get('_probe_info') or {}).get('audio_stream_index'),
                                origin_pts_sec=call.get('_v0_origin'),
                            ),
                            timeout=28.0,
                        )
                    except Exception as err:
                        log.warning('subcheck probe did not complete destination=%s err=%s', chat, type(err).__name__)
                        probe_res = None
                self._sync_live_sub_monitor_state(call)
                if isinstance(probe_res, dict) and (probe_res.get('confident') or not isinstance(call.get('subtitle_sync'), dict)):
                    self._apply_probe_sub_result(
                        chat,
                        call,
                        probe_res,
                        is_same_route=is_same_route,
                        force_normalize=auto_fix,
                    )
                self._sync_live_sub_monitor_state(call)
                if call.get('subtitle_sync') is None:
                    call['subtitle_sync'] = {
                        'status': 'monitoring',
                        'applied_offset_sec': float(call.get('subtitle_offset') or 0.0),
                        'drift_sec_per_sec': float(call.get('sub_drift_sec_per_sec') or 0.0),
                        'drift_anchor_sec': float(call.get('sub_drift_anchor_sec') or 0.0),
                        'message': 'Live speech sync check triggered',
                        'updated_at': round(time.time(), 3),
                    }
                return {
                    'ok': True,
                    'status': call['status'],
                    'position_seconds': call.get('position_seconds'),
                    'subtitle_offset': float(call.get('subtitle_offset') or 0.0),
                    'auto_subtitle_offset': call.get('auto_subtitle_offset'),
                    'sub_drift_sec_per_sec': float(call.get('sub_drift_sec_per_sec') or 0.0),
                    'sub_drift_anchor_sec': float(call.get('sub_drift_anchor_sec') or 0.0),
                    'subtitle_sync': call.get('subtitle_sync'),
                }
            elif op == 'seek':
                position = float(data['seconds'])
                if position < 0 or (call['duration'] > 0 and position >= call['duration']): raise VoiceFailure('INVALID_REQUEST')
                previous_offset = call['offset']; call['offset'] = position; paused = call['status'] == 'paused'
                call.pop('_landed_offset', None)
                call['last_seek_at'] = time.monotonic()
                if abs(position - previous_offset) >= 15.0:
                    call['_sub_force_check_seq'] = int(call.get('_sub_force_check_seq') or 0) + 1
                try:
                    await self.stream(a, chat, call)
                except Exception:
                    call['offset'] = previous_offset
                    raise
                if paused:
                    if call.get('av_sync_id'):
                        _set_sync_paused(call.get('av_sync_id'), True)
                    if not is_rtmp:
                        await asyncio.wait_for(engine.pause(chat), 10)
                landed_pos = float(call.get('_landed_offset')) if call.get('_landed_offset') is not None else position
                call['offset'] = landed_pos; call['position_seconds'] = landed_pos; call['last_known_position'] = landed_pos; call['last_progress'] = time.monotonic()
                if call.get('subtitle_path') and not call.get('manual_sub_override') and (call.get('auto_subtitle_offset') is None or abs(landed_pos - previous_offset) >= 15.0):
                    if abs(landed_pos - previous_offset) >= 15.0:
                        call['auto_subtitle_offset'] = None
                        call['subtitle_sync'] = None
                    self._maybe_schedule_sub_align(a, chat, call)
            res = {'ok': True, 'status': call['status'], 'position_seconds': call.get('position_seconds'), 'stream_mode': call.get('stream_mode', 'interactive')}
            if hot_paused:
                res['hot_paused'] = True
            if hot_resumed:
                res['hot_resumed'] = True
            return res

    async def _close_dropped_call(self, a, chat, call, *, reason=None, probe_time=False, emit_event=False, ignore_leave_error=True):
        """Record the last known playback timestamp and release a dropped call cleanly."""
        pos = float(call.get('last_known_position') or call.get('offset') or 0.0)
        engine = a.get('engine') if a else None
        if probe_time and (engine is not None or call.get('stream_mode') == 'rtmp') and call.get('status') in {'playing', 'paused'}:
            try:
                elapsed = await self._call_elapsed_seconds(engine, chat, call, timeout=1.5)
                pos = max(pos, float(call.get('offset') or 0.0) + elapsed)
            except Exception:
                pass
        if call.get('duration'):
            pos = min(pos, max(0.0, float(call['duration']) - 1.0))
        pos = max(0.0, pos)
        if pos > 0:
            self.last_ended_positions[chat] = pos
        if call.get('stream_mode') == 'rtmp':
            await self._stop_rtmp_proc(call, wait_settle=False)
        elif engine is not None:
            clear_engine_cache(engine, chat)
            try:
                await asyncio.wait_for(engine.leave_call(chat), 10)
            except Exception as leave_error:
                if not ignore_leave_error and classify(leave_error) != 'NO_ACTIVE_CALL':
                    raise
        self._cleanup_sub_overlay(call)
        await self._stop_secondary_tile_unlocked(chat)
        try:
            await self.voice_listener.stop_chat(chat)
        except Exception:
            pass
        self._invalidate_native_call_cache(a.get('client') if a else None, chat)
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
            await self.voice_listener.stop_chat(chat)
            return await self._close_dropped_call(a, chat, call, reason=reason, probe_time=True, emit_event=True, ignore_leave_error=True)

    async def status(self, chat):
        async with self.chat_lock(chat):
            call = self.calls.get(chat)
            if not call: return {'ok': True, 'active': False, 'last_failure': self.last_failures.get(chat), 'last_position_seconds': self.last_ended_positions.get(chat)}
            a = self.accounts[call['alias']]
            is_rtmp = call.get('stream_mode') == 'rtmp'
            if call['status'] in {'playing', 'paused'}:
                try:
                    elapsed = await self._call_elapsed_seconds(a['engine'], chat, call, timeout=5.0)
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
            elif call['status'] == 'error' and call.get('publisher_muted'):
                # Keep tracking live elapsed position while Telegram mutes the account
                # so the progress indicator and resume timestamp never regress to 0:00.
                try:
                    elapsed = await self._call_elapsed_seconds(a['engine'], chat, call, timeout=3.0)
                    position = float(call.get('offset') or 0.0) + elapsed
                    call['last_known_position'] = max(float(call.get('last_known_position') or 0.0), position)
                    call['clock_errors'] = 0
                except Exception as error:
                    if classify(error) == 'NO_ACTIVE_CALL':
                        pos = await self._close_dropped_call(a, chat, call, reason='NO_ACTIVE_CALL', probe_time=False, emit_event=False, ignore_leave_error=False)
                        return {'ok': True, 'active': False, 'last_position_seconds': pos if pos > 0 else self.last_ended_positions.get(chat)}
            if not is_rtmp and not call.get('is_channel') and call.get('native_call') is not None and time.monotonic() >= call.get('publisher_check_after', 0):
                if call['status'] == 'playing':
                    call['publisher_check_after'] = time.monotonic() + 5
                    try:
                        _, participant = await self.native_publisher(a, chat, call['native_call'])
                    except Exception:
                        participant = None
                    if participant is not None and (getattr(participant, 'left', False) or getattr(participant, 'muted', False)):
                        # Do not fight subsequent moderator mute actions or discard songs.
                        call.update(
                            status='error',
                            publisher_muted=True,
                            publisher_verified=False,
                            position_seconds=None,
                            publisher_muted_can_self_unmute=bool(getattr(participant, 'can_self_unmute', False)),
                            publisher_muted_while_paused=False,
                        )
                elif call.get('publisher_muted') and call['status'] in {'error', 'paused'}:
                    call['publisher_check_after'] = time.monotonic() + 5
                    try:
                        _, participant = await self.native_publisher(a, chat, call['native_call'])
                    except Exception:
                        participant = None
                    if participant is not None and not getattr(participant, 'left', False):
                        srv_muted = bool(getattr(participant, 'muted', False))
                        can_unmute = bool(getattr(participant, 'can_self_unmute', False))
                        was_can_unmute = call.get('publisher_muted_can_self_unmute')
                        admin_granted_speak = bool(srv_muted and can_unmute and (was_can_unmute is False))
                        if not srv_muted or admin_granted_speak:
                            try:
                                await asyncio.wait_for(self.ensure_publisher(a, chat, call), 12)
                                restored_status = 'paused' if (call.get('status') == 'paused' or call.get('publisher_muted_while_paused')) else 'playing'
                                call.update(
                                    status=restored_status,
                                    publisher_muted=False,
                                    publisher_verified=True,
                                    publisher_muted_while_paused=False,
                                    clock_errors=0,
                                    last_progress=time.monotonic(),
                                )
                                try:
                                    elapsed = await self._call_elapsed_seconds(a['engine'], chat, call, timeout=2.0)
                                    pos_now = float(call.get('offset') or 0.0) + elapsed
                                    call['position_seconds'] = pos_now
                                    call['last_known_position'] = max(float(call.get('last_known_position') or 0.0), pos_now)
                                except Exception:
                                    if call.get('last_known_position') is not None:
                                        call['position_seconds'] = call.get('last_known_position')
                            except Exception:
                                call['publisher_muted_can_self_unmute'] = can_unmute
                        else:
                            call['publisher_muted_can_self_unmute'] = can_unmute
            if call['status'] == 'recovering' and time.monotonic() >= call['retry_after']: call['status'] = 'error'
            if call['status'] == 'error' and not call.get('publisher_muted') and call['retries'] < 2 and time.monotonic() < call['retry_after']: call['status'] = 'recovering'
            if call['status'] == 'error' and not call.get('publisher_muted') and call['retries'] < 2 and time.monotonic() >= call['retry_after']:
                call['retries'] += 1
                call['offset'] = min(call.get('last_known_position', 0.0), max(0, call['duration'] - 1)) if call.get('duration') else max(0.0, call.get('last_known_position', 0.0))
                call['retry_after'] = time.monotonic() + 5 * (2 ** call['retries'])
                try:
                    clear_engine_cache(a['engine'], chat)
                    self._invalidate_native_call_cache(a['client'], chat)
                    peer, native = await self.native_call(a['client'], chat)
                    if native is not None:
                        bind = getattr(getattr(a['engine'], '_app', None), '_bind_client', None)
                        if not is_rtmp and bind and hasattr(bind, '_cache'):
                            try:
                                bind._cache.drop_cache(chat)
                                bind._cache.set_cache(chat, native)
                            except Exception: pass
                        call['native_call'] = native
                    elif is_rtmp:
                        raise VoiceFailure('NO_ACTIVE_CALL')
                    if is_rtmp:
                        call['_rtmp_target'] = None
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
            self._sync_live_sub_monitor_state(call)
            info_out = {k: call.get(k) for k in ['status','playback_id','position_seconds','last_known_position','alias','video','volume','publisher_verified','publisher_muted','call_invite_link','subtitle_offset','auto_subtitle_offset','subtitle_same_route','sub_drift_sec_per_sec','sub_drift_anchor_sec','stream_mode','messages_enabled']}
            if call.get('publisher_muted'):
                info_out['publisher_can_self_unmute'] = bool(call.get('publisher_muted_can_self_unmute'))
            if call.get('subtitle_sync') is not None:
                info_out['subtitle_sync'] = call.get('subtitle_sync')
            probe_meta = call.get('_probe_info') or {}
            info_out['audio_language'] = probe_meta.get('audio_language')
            info_out['audio_is_dub'] = bool(probe_meta.get('audio_is_dub'))
            if call.get('av_sync_id'):
                sync_m = _read_sync_metrics(call.get('av_sync_id'))
                if sync_m is not None:
                    self._evaluate_call_sync(chat, call, metrics=sync_m)
                    mon = call.get('_sync_mon') or {}
                    sync_m['monitored'] = True
                    sync_m['resync_count'] = int(mon.get('resync_count') or 0)
                    if mon.get('last_resync_reason'):
                        sync_m['last_resync_reason'] = mon.get('last_resync_reason')
                    if mon.get('checked_at'):
                        sync_m['checked_at'] = mon.get('checked_at')
                    info_out['av_sync'] = sync_m
                    if is_rtmp:
                        info_out['rtmp_pipeline_delay_sec'] = float(sync_m.get('pipeline_delay_sec') or 0.0)
            tile = self.secondary_tiles.get(chat)
            if tile:
                info_out['secondary_tile'] = {
                    'alias': tile.get('alias'),
                    'language': tile.get('language'),
                    'label': tile.get('label'),
                    'status': tile.get('status'),
                }
            return {'ok': True, 'active': True, 'last_failure': self.last_failures.get(chat), 'info': info_out}

    async def _stop_secondary_tile_unlocked(self, chat):
        tile = self.secondary_tiles.pop(chat, None)
        if not tile:
            return False
        self._cleanup_sub_overlay(tile)
        a2 = self.accounts.get(tile.get('alias'))
        eng2 = a2.get('engine') if a2 else None
        if eng2 is not None:
            clear_engine_cache(eng2, chat)
            try:
                await asyncio.wait_for(eng2.leave_call(chat), 10)
            except Exception:
                pass
        if a2 is not None:
            self.release_destination(a2, chat)
        return True

    async def start_secondary_tile(self, data):
        chat = int(data['chat_id'])
        if chat >= 0 or self.closing:
            raise VoiceFailure('INVALID_REQUEST')
        sub_path = self.source_subtitle(data.get('subtitle_path'))
        if not sub_path:
            raise VoiceFailure('INVALID_REQUEST')
        async with self.chat_lock(chat):
            call = self.calls.get(chat)
            if not call or call.get('status') not in {'playing', 'paused'}:
                raise VoiceFailure('NO_ACTIVE_CALL')
            if call.get('is_channel') or call.get('stream_mode') == 'rtmp' or not call.get('video'):
                raise VoiceFailure('INVALID_REQUEST')
            await self._stop_secondary_tile_unlocked(chat)
            primary_a = self.accounts.get(call['alias'])
            elapsed = 0.0
            if primary_a and primary_a.get('engine') is not None:
                try:
                    elapsed = await self._call_elapsed_seconds(primary_a['engine'], chat, call, timeout=2.0)
                except Exception:
                    elapsed = 0.0
            sync_pos = max(0.0, float(call.get('offset') or 0.0) + elapsed)
            max_vid_raw = data.get('max_video_calls_per_account')
            max_vid_cap = int(max_vid_raw) if max_vid_raw is not None and int(max_vid_raw) > 0 else None
            a2 = await self.lease(
                chat,
                data.get('account_alias'),
                exclude_aliases={call['alias']},
                for_video=True,
                max_video_calls=max_vid_cap,
            )
            tile = {
                'alias': a2['alias'],
                'path': call['path'],
                'remote_proxy': call.get('remote_proxy', False),
                'video': True,
                'video_quality': call.get('video_quality') or 'HD_720p',
                'subtitle_path': sub_path,
                'subtitle_offset': float(data.get('subtitle_offset') or 0.0),
                'subtitle_same_route': False,
                'subtitle_render_screen': True,
                'sub_drift_sec_per_sec': 0.0,
                'sub_drift_anchor_sec': 0.0,
                'manual_sub_override': True,
                'language': str(data.get('language') or 'sub'),
                'label': str(data.get('label') or 'Secondary Subtitles')[:64],
                'offset': sync_pos,
                'status': 'playing' if call.get('status') == 'playing' else 'paused',
                'is_channel': False,
            }
            try:
                if self.factory:
                    if hasattr(a2['engine'], 'play'):
                        await asyncio.wait_for(a2['engine'].play(chat, f'secondary:{sub_path}'), 15)
                else:
                    from pytgcalls.types import MediaStream, VideoQuality, GroupCallConfig
                    base_path = re.sub(r'[?&]start=[0-9.]+', '', str(call['path'] or ''))
                    known_hls = bool(call.get('remote_proxy') and '.m3u8' in base_path.lower())
                    eff_path = f"{base_path}{'&' if '?' in base_path else '?'}start={sync_pos:.3f}" if (known_hls and sync_pos > 0.05) else base_path
                    ff = f'-ss {sync_pos:.3f}' if (sync_pos > 0.05 and not known_hls) else ''
                    info = await self.inspect_media(eff_path, False)
                    active_sub = await self._prepare_subtitle_overlay_for_call(tile, sub_path, base_sec=0.0 if (known_hls and sync_pos > 0.05) else sync_pos, info=info)
                    vf = build_video_subtitle_filter(active_sub) if active_sub else ''
                    if vf:
                        ff = f'{ff} --video ---mid -vf {shlex.quote(vf)}'.strip()
                    vq = VideoQuality.HD_720p if str(tile['video_quality']) != 'SD_480p' else VideoQuality.SD_480p
                    stream = MediaStream(eff_path, audio_parameters=None, video_parameters=vq, ffmpeg_parameters=ff or None, video_flags=MediaStream.Flags.REQUIRED)
                    await asyncio.wait_for(a2['engine'].play(chat, stream, config=GroupCallConfig(join_muted=True, auto_start=False)), 20)
                    if call.get('status') == 'paused' and hasattr(a2['engine'], 'pause'):
                        await asyncio.wait_for(a2['engine'].pause(chat), 5)
            except Exception:
                self._cleanup_sub_overlay(tile)
                self.release_destination(a2, chat)
                raise
            self.secondary_tiles[chat] = tile
            return {
                'ok': True,
                'account_alias': a2['alias'],
                'language': tile['language'],
                'label': tile['label'],
                'position_seconds': sync_pos,
            }

    async def stop_secondary_tile(self, data):
        chat = int(data['chat_id'])
        if chat >= 0 or self.closing:
            raise VoiceFailure('INVALID_REQUEST')
        async with self.chat_lock(chat):
            stopped = await self._stop_secondary_tile_unlocked(chat)
            return {'ok': True, 'stopped': stopped}

    async def start_browser_live(self, data):
        chat = int(data['chat_id'])
        if chat >= 0 or self.closing:
            raise VoiceFailure('INVALID_REQUEST')
        sc_url = str(data.get('screencast_url') or '').strip()
        if not re.fullmatch(r'https?://[^\s\'"`<>]+', sc_url):
            raise VoiceFailure('INVALID_REQUEST')
        width = max(320, min(1920, int(data.get('width') or 1280))) & ~1
        height = max(180, min(1080, int(data.get('height') or 720))) & ~1
        fps = max(5, min(30, int(round(float(data.get('fps') or 15)))))

        async with self.chat_lock(chat):
            max_vid_raw = data.get('max_video_calls_per_account')
            max_vid_cap = int(max_vid_raw) if max_vid_raw is not None and int(max_vid_raw) > 0 else None
            a = await self.lease(chat, data.get('account_alias'), for_video=True, max_video_calls=max_vid_cap)
            await self._stop_secondary_tile_unlocked(chat)
            previous = self.calls.get(chat)
            req_mode = str(data.get('stream_mode') or '').strip().lower()
            stream_mode = req_mode if req_mode in {'interactive', 'rtmp'} else (previous.get('stream_mode', 'interactive') if previous else 'interactive')
            wants_rtmp = stream_mode == 'rtmp'
            vc_title = str(data.get('vc_title') or 'Lancy Browser Live').strip()[:64]

            if previous:
                if previous.get('stream_mode') == 'rtmp':
                    await self._stop_rtmp_proc(previous, wait_settle=(stream_mode != 'rtmp'))
                self._cleanup_sub_overlay(previous)

            sid = re.sub(r'[^a-zA-Z0-9_-]', '_', f'blive-{abs(chat)}-{uuid.uuid4().hex[:8]}')[:64]
            meta_file = str(browser_stream.write_browser_meta(sid, data))
            stats_file = str(browser_stream.browser_stats_path_for(sid))
            _init_sync_state(sid, paused=False)

            call = {
                'alias': a['alias'],
                'path': sc_url,
                'stream_mode': stream_mode,
                'video': True,
                'video_quality': 'HD_720p',
                'is_channel': False,
                'remote_proxy': False,
                'is_music': False,
                'music_freerun': True,
                'dj_desk': False,
                'browser_live': {
                    'screencast_url': sc_url,
                    'mcp_session_id': str(data.get('mcp_session_id') or ''),
                    'domain': str(data.get('domain') or 'browser'),
                    'task': str(data.get('task') or 'Lancy Browser'),
                    'action': str(data.get('action') or 'Live'),
                    'state': str(data.get('state') or 'LIVE').upper(),
                    'meta_file': meta_file,
                    'stats_file': stats_file,
                    'width': width,
                    'height': height,
                    'fps': fps,
                },
                'av_sync_id': sid,
                'duration': 0.0,
                'offset': 0.0,
                'playback_id': str(data.get('playback_id') or sid),
                'status': 'buffering',
                'clock_errors': 0,
                'position_seconds': 0.0,
                'last_known_position': 0.0,
                'retries': 0,
                'retry_after': 0.0,
                'last_progress': time.monotonic(),
                'vc_title': vc_title,
            }

            try:
                if self.factory or not a.get('uid') or time.monotonic() - a.get('me_checked_at', 0) >= 300:
                    me = await asyncio.wait_for(a['client'].get_me(), 10)
                    if me.is_bot:
                        raise VoiceFailure('SESSION_NOT_READY')
                    a['me_checked_at'] = time.monotonic()

                can_reuse = (
                    not getattr(self, 'auto_create_call_in_tests', False)
                    and previous is not None
                    and previous.get('alias') == a['alias']
                    and previous.get('stream_mode', 'interactive') == stream_mode
                    and previous.get('status') in {'playing', 'paused', 'buffering', 'idle'}
                    and previous.get('native_call') is not None
                )
                if can_reuse:
                    call['native_call'] = previous['native_call']
                elif not self.factory or getattr(self, 'auto_create_call_in_tests', False) or wants_rtmp:
                    await self.resolve_destination(a['client'], chat)
                    try:
                        peer, native = await self.native_call(a['client'], chat)
                    except Exception:
                        peer, native = None, None
                    if peer is not None and native is None:
                        native = await self._create_group_call(a, chat, peer, vc_title=vc_title, rtmp_stream=wants_rtmp)
                    if native is not None:
                        call['native_call'] = native
                        if wants_rtmp and not call.get('_rtmp_target') and peer is not None and (not self.factory or getattr(self, 'test_rtmp_ingest', False)):
                            rtmp_target, _, _ = await self._fetch_rtmp_ingest(a, peer)
                            call['_rtmp_target'] = rtmp_target
                        elif wants_rtmp and self.factory and not call.get('_rtmp_target'):
                            call['_rtmp_target'] = 'rtmps://mock-tg-rtmp.local/live/mock-key'
                    elif not call.get('native_call'):
                        raise VoiceFailure('NO_ACTIVE_CALL')

                if wants_rtmp:
                    dec_args = [
                        sys.executable, BROWSER_STREAM_SCRIPT,
                        '--role', 'nut',
                        '--screencast-url', sc_url,
                        '--meta-file', meta_file,
                        '--width', str(width),
                        '--height', str(height),
                        '--fps', str(fps),
                    ]
                    cmd_args = [
                        sys.executable, RTMP_HUB_SCRIPT,
                        '--sync-id', sid,
                        '--width', str(width),
                        '--height', str(height),
                        '--fps', str(fps),
                        '--video-quality', 'HD_720p',
                        '--preset', 'ultrafast',
                        '--threads', '4',
                        '--rtmp-env', 'LANCY_RTMP_TARGET',
                        '--no-audio-eof',
                        '--', *dec_args,
                    ]
                    env = dict(os.environ)
                    env['LANCY_RTMP_TARGET'] = call.get('_rtmp_target') or ''
                    if data.get('api_token'):
                        env['BROWSEROS_API_TOKEN'] = str(data['api_token'])
                    proc = await asyncio.create_subprocess_exec(
                        *cmd_args,
                        stdin=asyncio.subprocess.DEVNULL,
                        stdout=asyncio.subprocess.DEVNULL,
                        stderr=asyncio.subprocess.PIPE,
                        env=env,
                    )
                    call['_rtmp_proc'] = proc
                    call['_rtmp_stderr'] = asyncio.create_task(self._drain_rtmp_stderr(chat, proc))
                    call['rtmp_standby'] = False
                elif self.factory:
                    await asyncio.wait_for(a['engine'].play(chat, call['browser_live']), 15)
                else:
                    from pytgcalls.types import GroupCallConfig
                    from pytgcalls.types.raw import Stream, AudioStream, VideoStream, AudioParameters, VideoParameters
                    from ntgcalls import MediaSource

                    a_in = f'{shlex.quote(sys.executable)} {shlex.quote(BROWSER_STREAM_SCRIPT)} --role audio'
                    v_in = (
                        f'{shlex.quote(sys.executable)} {shlex.quote(BROWSER_STREAM_SCRIPT)} '
                        f'--role video --screencast-url {shlex.quote(sc_url)} '
                        f'--meta-file {shlex.quote(meta_file)} --stats-file {shlex.quote(stats_file)} '
                        f'--width {width} --height {height} --fps {fps}'
                    )
                    wrapped_a, wrapped_v = wrap_av_sync_pair(
                        a_in,
                        v_in,
                        frame_bytes=width * height * 3 // 2,
                        fps=float(fps),
                        sync_id=sid,
                        music_freerun=True,
                    )
                    play_stream = Stream(
                        microphone=AudioStream(MediaSource.SHELL, wrapped_a, AudioParameters(bitrate=48000, channels=2)),
                        screen=VideoStream(MediaSource.SHELL, wrapped_v, VideoParameters(width=width, height=height, frame_rate=fps, adjust_by_height=False)),
                    )
                    await asyncio.wait_for(a['engine'].play(chat, play_stream, config=GroupCallConfig(auto_start=False)), 25)
                    log.info('browser_live started chat=%s mode=%s sid=%s url=%s', chat, stream_mode, sid, sc_url)
                    try:
                        await asyncio.wait_for(self.ensure_publisher(a, chat, call), 15)
                    except Exception as pub_err:
                        log.warning('browser_live ensure_publisher chat=%s err=%s', chat, type(pub_err).__name__)
            except Exception:
                self._cleanup_sub_overlay(call)
                if previous is None:
                    self.release_destination(a, chat)
                raise

            call['status'] = 'playing'
            call['started_at'] = time.monotonic()
            call['last_progress'] = time.monotonic()
            self.calls[chat] = call
            if self.voice_listener and (data.get('voice_ai_enabled') is not False):
                try:
                    if isinstance(data.get('voice_authorized_ids'), list):
                        self.voice_listener.set_authorized_ids(chat, data.get('voice_authorized_ids'))
                    await self.voice_listener.start_chat(chat, a['alias'], enabled=True, force_record=True)
                except Exception:
                    pass
            return {
                'ok': True,
                'chat_id': chat,
                'sync_id': sid,
                'account_alias': a['alias'],
                'stream_mode': stream_mode,
                'width': width,
                'height': height,
                'fps': fps,
            }

    async def update_browser_live_meta(self, data):
        chat = int(data['chat_id'])
        call = self.calls.get(chat)
        if not call or not call.get('browser_live'):
            return {'ok': False, 'error': 'NO_BROWSER_LIVE'}
        sid = call.get('av_sync_id')
        bl = call['browser_live']
        for k in ('domain', 'url', 'task', 'action', 'state', 'step'):
            if k in data and data[k] is not None:
                bl[k] = str(data[k])
        if sid:
            browser_stream.write_browser_meta(sid, bl)
        stats = None
        sp = bl.get('stats_file')
        if sp and os.path.isfile(sp):
            try:
                stats = json.loads(Path(sp).read_text(encoding='utf-8'))
            except Exception:
                stats = None
        return {'ok': True, 'sync_id': sid, 'meta': {k: bl.get(k) for k in ('domain', 'task', 'action', 'state', 'step')}, 'stats': stats}

    async def stop_browser_live(self, data):
        chat = int(data['chat_id'])
        keep_call = bool(data.get('keep_call', False))
        if keep_call:
            async with self.chat_lock(chat):
                call = self.calls.get(chat)
                if not call or not call.get('browser_live'):
                    return {'ok': True, 'stopped': False}
                call.pop('browser_live', None)
                return {'ok': True, 'stopped': True, 'kept_call': True}
        async with self.chat_lock(chat):
            call = self.calls.get(chat)
            if not call or not call.get('browser_live'):
                return {'ok': True, 'stopped': False}
        res = await self.control('stop', {'chat_id': chat})
        return {'ok': bool(res.get('ok')), 'stopped': True, 'kept_call': False}

    async def speak_in_call(self, data):
        chat = int(data['chat_id'])
        text = str(data.get('text') or '').strip()
        if chat >= 0 or not text or self.closing:
            raise VoiceFailure('INVALID_REQUEST')
        t_start = time.monotonic()
        voice = data.get('voice')
        rate = data.get('rate')
        append_mode = bool(data.get('append_mode'))
        barge_in_clear = bool(data.get('barge_in_clear'))
        use_streaming_tts = (
            type(getattr(self.tts, 'synthesize_pcm', None)).__name__ == 'method'
            and hasattr(self.tts, 'synthesize_stream_pcm')
        )

        # Peek call sync context quickly before acquiring write path for streaming vs single-shot
        call_snap = self.calls.get(chat)
        if not call_snap:
            raise VoiceFailure('NO_ACTIVE_CALL')
        sync_id = call_snap.get('av_sync_id')
        st_listen = self.voice_listener.states.get(chat)
        init_barge_seq = int(getattr(st_listen, 'barge_in_seq', 0)) if st_listen else 0

        if use_streaming_tts and sync_id and call_snap.get('stream_mode') != 'rtmp':
            q_dir = av_sync.tts_queue_dir_for(sync_id)
            q_dir.mkdir(parents=True, exist_ok=True)
            total_bytes = 0
            chunks_written = 0
            first_chunk_ms = None
            aborted_by_barge_in = False
            async for chunk in self.tts.synthesize_stream_pcm(text, voice=voice, rate=rate, chunk_ms=60):
                if not chunk:
                    continue
                if st_listen and int(getattr(st_listen, 'barge_in_seq', 0)) != init_barge_seq:
                    aborted_by_barge_in = True
                    break
                if chunks_written == 0:
                    first_chunk_ms = round((time.monotonic() - t_start) * 1000.0, 1)
                    if barge_in_clear:
                        av_sync.clear_tts_queue(sync_id)
                    is_paused_hold = (call_snap.get('status') == 'paused')
                    _write_vchud_state(
                        sync_id,
                        active=True,
                        mode='speaking',
                        speaker_name=data.get('speaker_name') or call_snap.get('_hud_speaker') or '',
                        user_text=data.get('user_text') or call_snap.get('_hud_user_text') or '',
                        lancy_text=data.get('lancy_text') or text,
                        theme=data.get('hud_theme') or call_snap.get('_hud_theme') or 'neon_rose',
                        ttl_sec=(35.0 if is_paused_hold else 8.0),
                    )
                    a = self.accounts.get(call_snap['alias'])
                    if is_paused_hold and a and a.get('engine') and not self.factory:
                        def _chk_stream(st):
                            if int(st.tts_hold) == 0:
                                st.tts_hold = 1
                                st.paused = 1
                        _mutate_sync_state(sync_id, _chk_stream)
                        try:
                            await asyncio.wait_for(a['engine'].resume(chat), 5.0)
                        except Exception:
                            pass
                fname = f'{time.monotonic_ns():020d}_{chunks_written:04d}_{secrets.token_hex(2)}.pcm'
                tmp_f = q_dir / f'.{fname}.tmp'
                final_f = q_dir / fname
                tmp_f.write_bytes(chunk)
                os.replace(tmp_f, final_f)
                chunks_written += 1
                total_bytes += len(chunk)
                chunk_dur = len(chunk) / float(av_sync.PCM_BYTES_PER_SEC)
                self.voice_listener.set_echo_guard(chat, chunk_dur, extend=(append_mode or chunks_written > 1))
            if not total_bytes and not aborted_by_barge_in:
                return {'ok': False, 'error': 'TTS_EMPTY'}
            dur_sec = round(total_bytes / float(av_sync.PCM_BYTES_PER_SEC), 3)
            return {
                'ok': True,
                'mode': 'av_sync_mix_stream',
                'duration_sec': dur_sec,
                'chunks': chunks_written,
                'first_audio_latency_ms': first_chunk_ms,
                'aborted_by_barge_in': aborted_by_barge_in,
            }

        pcm = await self.tts.synthesize_pcm(text, voice=voice, rate=rate)
        if not pcm:
            return {'ok': False, 'error': 'TTS_EMPTY'}
        first_chunk_ms = round((time.monotonic() - t_start) * 1000.0, 1)
        dur_sec = round(len(pcm) / float(av_sync.PCM_BYTES_PER_SEC), 3)
        async with self.chat_lock(chat):
            call = self.calls.get(chat)
            if not call:
                raise VoiceFailure('NO_ACTIVE_CALL')
            sync_id = call.get('av_sync_id')
            if barge_in_clear and sync_id:
                av_sync.clear_tts_queue(sync_id)
            self.voice_listener.set_echo_guard(chat, dur_sec, extend=append_mode)
            if sync_id and call.get('stream_mode') != 'rtmp':
                q_dir = av_sync.tts_queue_dir_for(sync_id)
                q_dir.mkdir(parents=True, exist_ok=True)
                fname = f'{time.monotonic_ns():020d}_{secrets.token_hex(3)}.pcm'
                tmp_f = q_dir / f'.{fname}.tmp'
                final_f = q_dir / fname
                tmp_f.write_bytes(pcm)
                os.replace(tmp_f, final_f)
                # Update live VC screen dialogue HUD as she speaks!
                is_paused_hold = (call.get('status') == 'paused')
                _write_vchud_state(
                    sync_id,
                    active=True,
                    mode='speaking',
                    speaker_name=data.get('speaker_name') or call.get('_hud_speaker') or '',
                    user_text=data.get('user_text') or call.get('_hud_user_text') or '',
                    lancy_text=data.get('lancy_text') or text,
                    theme=data.get('hud_theme') or call.get('_hud_theme') or 'neon_rose',
                    ttl_sec=(35.0 if is_paused_hold else max(3.5, dur_sec + 1.8)),
                )
                # Ensure pipe is flowing if previously hard-paused via engine.pause
                a = self.accounts.get(call['alias'])
                if call.get('status') == 'paused' and a and a.get('engine') and not self.factory:
                    def _chk(st):
                        if int(st.tts_hold) == 0:
                            st.tts_hold = 1
                            st.paused = 1
                    _mutate_sync_state(sync_id, _chk)
                    try:
                        await asyncio.wait_for(a['engine'].resume(chat), 5.0)
                    except Exception:
                        pass
                return {'ok': True, 'mode': 'av_sync_mix', 'duration_sec': dur_sec, 'first_audio_latency_ms': first_chunk_ms}

            # Fallback for idle / audio-only call without av_sync
            if call.get('status') == 'idle' and not self.factory and call.get('stream_mode') != 'rtmp':
                a = self.accounts.get(call['alias'])
                engine = a.get('engine') if a else None
                if engine is not None:
                    wav_path = await self.tts.synthesize_wav(text, voice=voice, rate=rate)
                    if wav_path and wav_path.is_file():
                        from pytgcalls.types import MediaStream, AudioQuality, GroupCallConfig
                        ms = MediaStream(str(wav_path), audio_parameters=AudioQuality.HIGH, video_flags=MediaStream.Flags.IGNORE)
                        await asyncio.wait_for(engine.play(chat, ms, config=GroupCallConfig(auto_start=False)), 12.0)
                        return {'ok': True, 'mode': 'direct_stream', 'duration_sec': dur_sec, 'first_audio_latency_ms': first_chunk_ms}
            return {'ok': True, 'mode': 'queued_noop', 'duration_sec': dur_sec, 'first_audio_latency_ms': first_chunk_ms}

    async def barge_in_call(self, data):
        chat = int(data['chat_id'])
        if chat >= 0 or self.closing:
            raise VoiceFailure('INVALID_REQUEST')
        user_id = int(data['user_id']) if data.get('user_id') is not None else None
        cleared = self.voice_listener.trigger_barge_in(chat, user_id=user_id)
        return {'ok': True, 'cleared': bool(cleared)}

    async def set_listen_state(self, data):
        chat = int(data['chat_id'])
        if chat >= 0 or self.closing:
            raise VoiceFailure('INVALID_REQUEST')
        mode = str(data.get('mode') or 'config').strip().lower()
        active = bool(data.get('active', mode == 'start'))
        duration_sec = float(data.get('duration_sec') or 28.0)
        active_uid = int(data['active_user_id']) if data.get('active_user_id') is not None else None
        pause_media = data.get('pause_media')
        resume_media = data.get('resume_media')
        enabled = data.get('enabled')
        auth_ids = data.get('authorized_user_ids')
        enforce_auth = data.get('enforce_auth')

        async with self.chat_lock(chat):
            call = self.calls.get(chat)
            if not call:
                raise VoiceFailure('NO_ACTIVE_CALL')
            if enabled is False:
                await self.voice_listener.stop_chat(chat)
                call['voice_ai_enabled'] = False
                return {'ok': True, 'enabled': False, 'active': False}
            if enabled is True or chat not in self.voice_listener.states:
                call['voice_ai_enabled'] = True
                await self.voice_listener.start_chat(
                    chat,
                    call['alias'],
                    enabled=True,
                    authorized_user_ids=auth_ids if isinstance(auth_ids, list) else None,
                    enforce_auth=bool(enforce_auth) if enforce_auth is not None else False,
                )
            st = self.voice_listener.states.get(chat)
            if st:
                if isinstance(auth_ids, list):
                    st.authorized_user_ids = {int(x) for x in auth_ids if int(x or 0) > 0}
                if enforce_auth is not None:
                    st.enforce_auth = bool(enforce_auth)
                if data.get('voice'):
                    new_v = str(data.get('voice')).strip()
                    if new_v and new_v != st.voice_name:
                        st.voice_name = new_v
                        if st.live_session is not None and bool(getattr(self, 'enable_gemini_live', False)):
                            asyncio.create_task(self.voice_listener._start_live_session(chat, st))
            self.voice_listener.set_listening_window(chat, active=active, duration_sec=duration_sec, active_user_id=active_uid)

            sync_id = call.get('av_sync_id')
            if data.get('speaker_name'):
                call['_hud_speaker'] = str(data.get('speaker_name'))[:40]
            if data.get('user_text'):
                call['_hud_user_text'] = str(data.get('user_text'))[:180]
            if data.get('hud_theme'):
                call['_hud_theme'] = str(data.get('hud_theme'))[:32]
            a = self.accounts.get(call['alias'])
            engine = a.get('engine') if a else None
            if pause_media is True and call.get('status') == 'playing':
                try:
                    elapsed = await self._call_elapsed_seconds(engine, chat, call, timeout=2.0)
                    pos = max(0.0, float(call.get('offset') or 0.0) + elapsed)
                    call['last_known_position'] = max(float(call.get('last_known_position') or 0.0), pos)
                    call['position_seconds'] = call['last_known_position']
                except Exception:
                    pass
                if sync_id and call.get('stream_mode') != 'rtmp':
                    _set_sync_tts_hold(sync_id, True)
                    _set_sync_paused(sync_id, True)
                    _write_vchud_state(
                        sync_id,
                        active=True,
                        mode='listening',
                        speaker_name=call.get('_hud_speaker') or '',
                        user_text=call.get('_hud_user_text') or '',
                        lancy_text=data.get('lancy_text') or '',
                        theme=call.get('_hud_theme') or 'neon_rose',
                        ttl_sec=max(32.0, duration_sec),
                    )
                    call['status'] = 'paused'
                elif engine is not None and call.get('stream_mode') != 'rtmp':
                    try:
                        await asyncio.wait_for(engine.pause(chat), 6.0)
                        call['status'] = 'paused'
                    except Exception:
                        pass
            elif active and sync_id and call.get('status') == 'paused' and (data.get('user_text') or data.get('lancy_text')):
                _write_vchud_state(
                    sync_id,
                    active=True,
                    mode='speaking' if data.get('lancy_text') else 'listening',
                    speaker_name=call.get('_hud_speaker') or '',
                    user_text=call.get('_hud_user_text') or '',
                    lancy_text=data.get('lancy_text') or '',
                    theme=call.get('_hud_theme') or 'neon_rose',
                    ttl_sec=max(28.0, duration_sec),
                )
            elif resume_media is True and call.get('status') == 'paused':
                if sync_id and call.get('stream_mode') != 'rtmp':
                    _set_sync_tts_hold(sync_id, False)
                    _set_sync_paused(sync_id, False)
                    _write_vchud_state(sync_id, active=False)
                    call['status'] = 'playing'
                    call['last_progress'] = time.monotonic()
                elif engine is not None and call.get('stream_mode') != 'rtmp':
                    try:
                        await asyncio.wait_for(engine.resume(chat), 6.0)
                        call['status'] = 'playing'
                        call['last_progress'] = time.monotonic()
                    except Exception:
                        pass

            return {
                'ok': True,
                'enabled': bool(call.get('voice_ai_enabled', True)),
                'active': bool(active),
                'status': call.get('status'),
            }

    async def get_call_participants(self, chat):
        cid = int(chat)
        st = self.voice_listener.states.get(cid)
        if not st:
            return {'ok': True, 'participants': {}, 'participant_list': []}
        mapping = await self.voice_listener.refresh_participants(cid, force=True)
        plist = [
            {
                'ssrc': int(src),
                'user_id': int(uid),
                'display_name': st.uid_to_name.get(int(uid)) or f'User {uid}',
            }
            for src, uid in mapping.items()
        ]
        return {'ok': True, 'participants': {str(k): int(v) for k, v in mapping.items()}, 'participant_list': plist}

    async def stt_transcribe(self, data):
        import tempfile
        file_path = str(data.get('file_path') or '').strip()
        if not file_path:
            raise VoiceFailure('INVALID_REQUEST')
        src_path = Path(file_path).resolve()
        cache_attr = getattr(self, 'cache_root', None) or getattr(self, 'cache_dir', None) or getattr(getattr(self, 'tts', None), 'cache_dir', None)
        allowed_roots = [Path(tempfile.gettempdir()).resolve(), Path('/tmp').resolve(), Path('/data/tmp').resolve()]
        if cache_attr:
            allowed_roots.append(Path(cache_attr).resolve())
        if not any(src_path == root or root in src_path.parents for root in allowed_roots) or not src_path.is_file():
            raise VoiceFailure('INVALID_REQUEST')
        proc = await asyncio.create_subprocess_exec(
            'ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error',
            '-i', str(src_path),
            '-vn', '-sn', '-dn',
            '-f', 's16le', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1',
            'pipe:1',
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        pcm, stderr = await asyncio.wait_for(proc.communicate(), timeout=20.0)
        if proc.returncode != 0 or not pcm:
            log.debug('Voice note ffmpeg decode empty/err: %s', (stderr or b'').decode('utf-8', 'replace')[:120])
            return {'ok': True, 'text': '', 'raw_text': '', 'confidence': 0.0, 'low_confidence': True, 'empty': True}
        res = await self.stt.transcribe(
            pcm,
            sample_rate=16000,
            channels=1,
            context_hint=str(data.get('context_hint') or ''),
            active_session=bool(data.get('active_session', True)),
        )
        if res is None:
            return {'ok': True, 'text': '', 'raw_text': '', 'confidence': 0.0, 'low_confidence': True, 'empty': True}
        return {
            'ok': True,
            'text': res.text,
            'raw_text': res.raw_text,
            'confidence': res.confidence,
            'low_confidence': res.low_confidence,
            'is_wake': res.is_wake,
            'is_listen_command': res.is_listen_command,
            'duration_sec': res.duration_sec,
            'empty': False,
        }

    async def tts_synthesize_ogg(self, data):
        import base64
        text = str(data.get('text') or '').strip()
        if not text:
            raise VoiceFailure('INVALID_REQUEST')
        ogg = await self.tts.synthesize_ogg_opus(
            text,
            voice=data.get('voice') or None,
            rate=data.get('rate') or None,
        )
        if not ogg:
            return {'ok': False, 'error': 'TTS_EMPTY'}
        return {'ok': True, 'ogg_base64': base64.b64encode(ogg).decode('ascii'), 'bytes': len(ogg)}

    async def submit_live_tool_result(self, data):
        chat = int(data['chat_id'])
        call_id = str(data.get('call_id') or '').strip()
        name = str(data.get('name') or '').strip()
        response = data.get('response')
        if not name or self.closing:
            raise VoiceFailure('INVALID_REQUEST')
        sent = await self.voice_listener.submit_live_tool_result(chat, call_id, name, response)
        return {'ok': True, 'sent': bool(sent)}

    async def push_live_context(self, data):
        chat = int(data['chat_id'])
        summary = str(data.get('summary') or '').strip()
        if chat >= 0 or not summary or self.closing:
            return {'ok': False}
        sent = await self.voice_listener.push_context_update(chat, summary, trigger_turn=bool(data.get('trigger_turn')))
        return {'ok': True, 'sent': bool(sent)}

    async def _fetch_bytes_with_fallback(self, target_url, headers=None, timeout_sec=6.0):
        import urllib.request
        import urllib.parse
        hdr_variants = []
        if isinstance(headers, dict) and headers:
            hdr_variants.append(dict(headers))
        hdr_variants.extend([
            {'Referer': 'https://p.10010.top/', 'Origin': 'https://p.10010.top'},
            {'Referer': 'https://player.cinezo.live/', 'Origin': 'https://player.cinezo.live'},
            {},
        ])
        urls_to_try = [str(target_url)]
        if 'sacdn.hakunaymatata.com' in str(target_url) and 'dash-hls-bridge' not in str(target_url):
            urls_to_try.append(
                'https://dash-hls-bridge.johndoesdmc.workers.dev/?url='
                + urllib.parse.quote(str(target_url), safe='')
            )

        def _sync_get():
            for cand_u in urls_to_try:
                for hdr in hdr_variants:
                    req_hdrs = {
                        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
                        **{str(k): str(v) for k, v in hdr.items() if k and v is not None},
                    }
                    try:
                        req = urllib.request.Request(cand_u, headers=req_hdrs)
                        with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
                            if 200 <= getattr(resp, 'status', 200) < 300:
                                return resp.read(), getattr(resp, 'url', cand_u)
                    except Exception:
                        continue
            return None, str(target_url)

        return await asyncio.to_thread(_sync_get)

    async def _extract_hls_audio_sample_bytes(self, playlist_url, headers=None, offset_sec=75):
        import urllib.parse
        raw, final_url = await self._fetch_bytes_with_fallback(playlist_url, headers=headers, timeout_sec=6.0)
        if not raw:
            return None
        text = raw.decode('utf-8', errors='replace')
        if '#EXTM3U' not in text:
            return None

        # Follow master -> primary/audio media playlist
        if '#EXT-X-STREAM-INF' in text:
            audio_uri = None
            first_var = None
            lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
            for i, ln in enumerate(lines):
                if ln.startswith('#EXT-X-MEDIA:') and 'TYPE=AUDIO' in ln.upper():
                    m = re.search(r'URI="([^"]+)"', ln, re.I)
                    if m:
                        audio_uri = urllib.parse.urljoin(final_url, m.group(1))
                        if 'DEFAULT=YES' in ln.upper():
                            break
                elif ln.startswith('#EXT-X-STREAM-INF:') and not first_var:
                    for j in range(i + 1, len(lines)):
                        if not lines[j].startswith('#'):
                            first_var = urllib.parse.urljoin(final_url, lines[j])
                            break
            target_pl = audio_uri or first_var
            if not target_pl:
                return None
            raw, final_url = await self._fetch_bytes_with_fallback(target_pl, headers=headers, timeout_sec=6.0)
            if not raw:
                return None
            text = raw.decode('utf-8', errors='replace')

        lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
        init_uri = None
        segments = []
        pending_dur = 5.0
        for ln in lines:
            if ln.startswith('#EXT-X-MAP:'):
                m = re.search(r'URI="([^"]+)"', ln, re.I)
                if m:
                    init_uri = urllib.parse.urljoin(final_url, m.group(1))
            elif ln.startswith('#EXTINF:'):
                m = re.match(r'#EXTINF:([0-9.]+)', ln, re.I)
                if m:
                    try:
                        pending_dur = max(0.5, float(m.group(1)))
                    except Exception:
                        pending_dur = 5.0
            elif not ln.startswith('#'):
                segments.append((pending_dur, urllib.parse.urljoin(final_url, ln)))
                pending_dur = 5.0

        if not segments:
            return None

        # Jump past intro/opening credits to offset_sec and collect ~20-25s of contiguous segments
        elapsed = 0.0
        start_idx = 0
        for idx, (dur, _) in enumerate(segments):
            if elapsed >= float(offset_sec):
                start_idx = idx
                break
            elapsed += dur
        if start_idx >= len(segments):
            start_idx = max(0, len(segments) // 3)
        chosen = segments[start_idx:start_idx + 5]
        if not chosen:
            chosen = segments[:4]

        chunks = []
        if init_uri:
            init_bytes, _ = await self._fetch_bytes_with_fallback(init_uri, headers=headers, timeout_sec=5.0)
            if init_bytes:
                chunks.append(init_bytes)
        seg_results = await asyncio.gather(
            *[self._fetch_bytes_with_fallback(u, headers=headers, timeout_sec=5.0) for _, u in chosen],
            return_exceptions=True,
        )
        for item in seg_results:
            if isinstance(item, tuple) and item[0]:
                chunks.append(item[0])
        if not chunks:
            return None
        return b''.join(chunks)

    async def verify_audio_language(self, data):
        url = str(data.get('url') or '').strip()
        if not url or not re.match(r'^https?://', url, re.I):
            raise VoiceFailure('INVALID_REQUEST')
        headers = data.get('headers') if isinstance(data.get('headers'), dict) else {}
        offset_sec = max(0, min(600, int(data.get('offset_sec') if data.get('offset_sec') is not None else 75)))
        now = time.monotonic()
        cached = self._audio_lang_cache.get(url)
        if cached and (now - cached[0]) < 600.0:
            return dict(cached[1])
        hdr_lines = ''.join(
            f'{k}: {str(v).strip()}\r\n'
            for k, v in headers.items()
            if k and v is not None and str(v).strip()
        )
        # Try offset window first, then a deeper dialogue window (165s) and near-start fallback so quiet intros/credits never hide spoken audio.
        offsets_to_try = [offset_sec]
        if offset_sec < 140:
            offsets_to_try.append(165)
        if offset_sec > 20:
            offsets_to_try.append(15)

        best_res = {'ok': True, 'language': None, 'probability': 0.0, 'speech_detected': False, 'sample_text': ''}
        looks_hls = bool('.m3u8' in url.lower() or '/m/' in url.lower())
        if not hasattr(self, '_audio_lang_sem'):
            self._audio_lang_sem = asyncio.Semaphore(1)
        if sub_align.host_load_pressure() >= 0.92:
            offsets_to_try = offsets_to_try[:1]
        async with self._audio_lang_sem:
            for off in offsets_to_try:
                raw_sample = None
                if looks_hls:
                    raw_sample = await self._extract_hls_audio_sample_bytes(url, headers=headers, offset_sec=off)

                if raw_sample:
                    cmd = [
                        'ffmpeg', '-nostdin', '-v', 'error',
                        '-i', 'pipe:0',
                        '-vn', '-sn', '-dn',
                        '-t', '22',
                        '-f', 's16le', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1',
                        'pipe:1',
                    ]
                else:
                    cmd = ['ffmpeg', '-nostdin', '-v', 'error']
                    if hdr_lines:
                        cmd.extend(['-headers', hdr_lines])
                    cmd.extend([
                        '-user_agent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
                        '-ss', str(off),
                        '-i', url,
                        '-vn', '-sn', '-dn',
                        '-t', '18',
                        '-f', 's16le', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1',
                        'pipe:1',
                    ])

                proc = None
                try:
                    proc = await asyncio.create_subprocess_exec(
                        *cmd,
                        stdin=asyncio.subprocess.PIPE if raw_sample else asyncio.subprocess.DEVNULL,
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.PIPE,
                    )
                    stdout, _ = await asyncio.wait_for(
                        proc.communicate(input=raw_sample if raw_sample else None),
                        timeout=9.0,
                    )
                    if len(stdout) >= 32000:
                        res = await self.stt.detect_spoken_language(stdout, sample_rate=16000, channels=1)
                        if res.get('speech_detected'):
                            best_res = res
                            break
                        if (res.get('probability') or 0.0) > (best_res.get('probability') or 0.0):
                            best_res = res
                except Exception:
                    if proc is not None and proc.returncode is None:
                        try:
                            proc.kill()
                            await proc.wait()
                        except Exception:
                            pass
        if len(self._audio_lang_cache) > 256:
            self._audio_lang_cache.clear()
        self._audio_lang_cache[url] = (now, dict(best_res))
        return best_res

    async def ensure_engine_resumed(self, chat_id: int) -> bool:
        """Resume PyTgCalls capture if an earlier paused seek paused the engine."""
        chat = int(chat_id)
        call = self.calls.get(chat) or {}
        if not call or call.get('stream_mode') == 'rtmp':
            return False
        acct = self.accounts.get(call.get('alias'))
        engine = acct.get('engine') if acct else None
        if engine is None or self.factory:
            return False
        try:
            binding = getattr(engine, '_binding', None)
            if binding is not None and hasattr(binding, 'get_state'):
                b_state = await asyncio.wait_for(binding.get_state(chat), 1.5)
                if b_state is not None and not (
                    getattr(b_state, 'paused', False)
                    or getattr(b_state, 'muted', False)
                    or getattr(b_state, 'video_paused', False)
                    or getattr(b_state, 'presentation_paused', False)
                ):
                    return True
            await asyncio.wait_for(engine.resume(chat), 2.5)
            call['last_progress'] = time.monotonic()
            return True
        except Exception:
            return False

    async def shutdown(self):
        self.closing = True
        if self.voice_listener:
            await self.voice_listener.stop_all()
        mon_task = getattr(self, '_sync_monitor_task', None)
        if mon_task is not None and not mon_task.done():
            mon_task.cancel()
            await asyncio.gather(mon_task, return_exceptions=True)
        for chat in list(self.secondary_tiles):
            try: await self._stop_secondary_tile_unlocked(chat)
            except Exception: pass
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
            code = classify(e)
            payload = {'ok': False, 'error': code, 'message': MESSAGES.get(code, MESSAGES['CALL_FAILED']), 'error_kind': type(e).__name__}
            if type(e).__name__ == 'ShellError':
                payload['error_detail'] = str(e)[:240]
            log.warning('Voice operation failed kind=%s', type(e).__name__)
            return web.json_response(payload, status=503)
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
    async def call_settings(request): return web.json_response(await bridge.update_call_settings(await request.json()))
    async def call_message(request): return web.json_response(await bridge.send_call_message(await request.json()))
    async def call_messages_delete(request): return web.json_response(await bridge.delete_call_messages(await request.json()))
    async def secondary_tile_start(request): return web.json_response(await bridge.start_secondary_tile(await request.json()))
    async def secondary_tile_stop(request): return web.json_response(await bridge.stop_secondary_tile(await request.json()))
    async def browser_live_start(request): return web.json_response(await bridge.start_browser_live(await request.json()))
    async def browser_live_meta(request): return web.json_response(await bridge.update_browser_live_meta(await request.json()))
    async def browser_live_stop(request): return web.json_response(await bridge.stop_browser_live(await request.json()))
    async def call_speak(request): return web.json_response(await bridge.speak_in_call(await request.json()))
    async def call_barge_in(request): return web.json_response(await bridge.barge_in_call(await request.json()))
    async def call_live_tool_result(request): return web.json_response(await bridge.submit_live_tool_result(await request.json()))
    async def call_live_context(request): return web.json_response(await bridge.push_live_context(await request.json()))
    async def call_listen(request): return web.json_response(await bridge.set_listen_state(await request.json()))
    async def call_participants(request): return web.json_response(await bridge.get_call_participants(int(request.query['chat_id'])))
    async def stt_transcribe(request): return web.json_response(await bridge.stt_transcribe(await request.json()))
    async def tts_synthesize(request): return web.json_response(await bridge.tts_synthesize_ogg(await request.json()))
    async def verify_audio_lang(request): return web.json_response(await bridge.verify_audio_language(await request.json()))
    app.router.add_get('/events', events)
    app.router.add_get('/health', health); app.router.add_get('/accounts', accounts)
    app.router.add_post('/accounts/register', register); app.router.add_post('/accounts/configure', configure)
    app.router.add_post('/destination/setup', setup); app.router.add_post('/destination/existing-group', existing)
    app.router.add_post('/call/play', play); app.router.add_get('/call/status', status); app.router.add_get('/call/invite-link', call_invite)
    app.router.add_post('/call/settings', call_settings); app.router.add_post('/call/message', call_message); app.router.add_post('/call/messages/delete', call_messages_delete)
    app.router.add_post('/call/secondary-tile/start', secondary_tile_start); app.router.add_post('/call/secondary-tile/stop', secondary_tile_stop)
    app.router.add_post('/call/browser-live/start', browser_live_start); app.router.add_post('/call/browser-live/meta', browser_live_meta); app.router.add_post('/call/browser-live/stop', browser_live_stop)
    app.router.add_post('/call/speak', call_speak); app.router.add_post('/call/barge_in', call_barge_in); app.router.add_post('/call/live-tool-result', call_live_tool_result); app.router.add_post('/call/live-context', call_live_context); app.router.add_post('/call/listen', call_listen); app.router.add_get('/call/participants', call_participants)
    app.router.add_post('/stt/transcribe', stt_transcribe); app.router.add_post('/tts/synthesize', tts_synthesize)
    app.router.add_post('/verify-audio-lang', verify_audio_lang)
    app.router.add_post('/call/{op:pause|resume|stop|idle|volume|seek|subtitle|subcheck}', control)
    async def cleanup(_): await bridge.shutdown()
    app.on_cleanup.append(cleanup)
    return app

def _reap_orphan_media_pipelines() -> int:
    """Kill av_hub/av_sync pipelines left behind by a previous (crashed) voice service.

    Orphans are re-parented to PID 1 and keep decoding movies forever, stealing CPU
    from the live pipeline and causing constant A/V drift/resync.
    """
    me = os.getpid()
    killed = 0
    try:
        proc_root = Path('/proc')
        for p in proc_root.iterdir():
            if not p.name.isdigit() or int(p.name) == me:
                continue
            try:
                cmd = (p / 'cmdline').read_bytes().replace(b'\x00', b' ').decode('utf-8', 'replace')
                if 'service/voice/av_hub.py' not in cmd and 'service/voice/av_sync.py' not in cmd:
                    continue
                stat = (p / 'stat').read_text()
                ppid = int(stat.rsplit(')', 1)[1].split()[1])
                if ppid != 1:
                    continue
                os.kill(int(p.name), signal.SIGKILL)
                killed += 1
            except Exception:
                continue
    except Exception:
        return killed
    if killed:
        log.warning('Reaped %d orphaned media pipeline process(es) from a previous voice service run', killed)
    return killed


async def main():
    handlers = [logging.StreamHandler(sys.stderr)]
    try:
        log_dir = Path(os.environ['MUSIC_CACHE_DIR']).resolve().parent / 'logs'
        log_dir.mkdir(parents=True, exist_ok=True)
        handlers.append(RotatingFileHandler(log_dir / 'voice.log', maxBytes=5 * 1024 * 1024, backupCount=3, encoding='utf-8'))
    except Exception:
        pass
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(name)s %(message)s', handlers=handlers, force=True)
    host = os.environ.get('VOICE_BRIDGE_HOST', '127.0.0.1')
    if host not in {'127.0.0.1', '::1'}: raise RuntimeError('Voice bridge must bind loopback')
    bridge = Bridge(os.environ['MUSIC_CACHE_DIR'])
    app = make_app(bridge, os.environ.get('VOICE_BRIDGE_TOKEN', ''))
    # Access logs disabled: no credential-bearing request data or URLs.
    av_sync._set_pdeathsig(signal.SIGTERM)
    if _parent_exited():
        return
    _reap_orphan_media_pipelines()
    runner = web.AppRunner(app, access_log=None); await runner.setup()
    if _parent_exited():
        await runner.cleanup()
        return
    await web.TCPSite(runner, host, int(os.environ.get('VOICE_BRIDGE_PORT', '3056'))).start()
    done = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT): loop.add_signal_handler(sig, done.set)
    async def watch_parent():
        while not done.is_set():
            await asyncio.sleep(0.5)
            if _parent_exited():
                done.set()
    watcher = asyncio.create_task(watch_parent())
    try: await done.wait()
    finally:
        watcher.cancel()
        await asyncio.gather(watcher, return_exceptions=True)
        await runner.cleanup()

if __name__ == '__main__': asyncio.run(main())
