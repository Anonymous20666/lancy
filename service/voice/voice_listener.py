"""Live PyTgCalls incoming microphone capture, SSRC speaker mapping & VAD.

Captures incoming WebRTC participant audio frames per chat without disturbing
the outgoing stream, maps each SSRC stream back to its Telegram ``user_id``
using ``GroupCallParticipant.source``, segments speech utterances via low-CPU
RMS VAD, runs STT via :class:`SttEngine`, and emits structured
``vc_voice_transcript`` events to the Node.js LancyAgent.
"""

from __future__ import annotations

import asyncio
from collections import deque
from dataclasses import dataclass, field
import logging
import os
import re
import secrets
import time
import numpy as np

log = logging.getLogger('voice.listener')

VAD_FRAME_SILENCE_SEC = 0.85
VAD_IDLE_SILENCE_SEC = 0.50
VAD_INCOMPLETE_HOLD_SEC = 1.95
VAD_MAX_MERGED_TURN_SEC = 14.0
VAD_MIN_SPEECH_SEC = 0.28
VAD_MAX_UTTERANCE_SEC = 11.5
VAD_RMS_THRESHOLD = 0.014
PRE_ROLL_CHUNKS = 8

_COMPLETE_SHORT_UTT_RE = re.compile(
    r'^(?:(?:hey|hi|yo|ok|okay|abeg)\s+)?lancy(?:\s*,?\s*(?:listen|abeg\s+listen|hear\s+me))?'
    r'|^(?:pause|resume|skip|next|previous|prev|mute|unmute|stop|leave|yes|yeah|yep|yup|no|nope|done|carry\s+on|continue|go\s+ahead|that\'?s\s+all|thats\s+all|hi|hello|hey|yo|cool|nice|alright|louder|quieter)[.!?,\s]*$',
    re.IGNORECASE,
)
_TRAILING_INCOMPLETE_RE = re.compile(
    r'(?:\b(?:and|or|but|then|also|plus|so|because|cos|to|for|from|with|of|on|in|at|the|a|an|that|this|my|your|uh|um|erm|eh|like|wait|abeg|make|tryna|want\s+to|trying\s+to|gonna|going\s+to)'
    r'|\b(?:play|search|find|lower|reduce|decrease|increase|raise|turn|skip\s+to|go\s+to|jump\s+to|seek\s+to|send|download|change|switch|put\s+on|give\s+me|open|check|tell))\s*[.,…\-]*$',
    re.IGNORECASE,
)


def is_incomplete_turn(text: str) -> bool:
    """Heuristic check for mid-thought pauses so Lancy waits for the user to finish speaking."""
    clean = re.sub(r'\s+', ' ', str(text or '')).strip()
    if not clean:
        return False
    if _COMPLETE_SHORT_UTT_RE.match(clean):
        return False
    if clean.endswith('...') or clean.endswith('…'):
        return True
    if _TRAILING_INCOMPLETE_RE.search(clean):
        return True
    words = clean.split()
    # Single hesitation word or filler in an active session shouldn't trigger an immediate AI turn.
    if len(words) <= 1:
        return True
    return False


@dataclass
class PendingTurnBuffer:
    ssrc: int
    uid: int | None = None
    pcm_chunks: list[bytes] = field(default_factory=list)
    sample_rate: int = 36000
    channels: int = 1
    started_mono: float = 0.0
    updated_mono: float = 0.0
    last_text: str = ''
    segments: int = 0
    low_confidence: bool = False
    confidence: float = 1.0
    avg_logprob: float = -0.3
    no_speech_prob: float = 0.0
    is_wake: bool = False
    is_listen_command: bool = False
    duration_sec: float = 0.0
    sender_name: str = ''
    simultaneous_speakers: list[str] = field(default_factory=list)


@dataclass
class SpeakerBuffer:
    ssrc: int
    sample_rate: int = 36000
    channels: int = 1
    pre_roll: deque = field(default_factory=lambda: deque(maxlen=PRE_ROLL_CHUNKS))
    live_preroll: deque = field(default_factory=lambda: deque(maxlen=4))
    chunks: list[bytes] = field(default_factory=list)
    total_bytes: int = 0
    in_speech: bool = False
    speech_started_mono: float = 0.0
    last_voice_mono: float = 0.0
    noise_floor: float = 0.004
    barge_frames: int = 0


@dataclass
class ChatListenState:
    chat_id: int
    alias: str
    enabled: bool = True
    recording_started: bool = False
    active_until_mono: float = 0.0
    active_user_id: int | None = None
    authorized_user_ids: set[int] = field(default_factory=set)
    enforce_auth: bool = False
    echo_guard_until_mono: float = 0.0
    barge_in_seq: int = 0
    record_sample_rate: int = 36000
    record_channels: int = 1
    ssrc_to_uid: dict[int, int] = field(default_factory=dict)
    uid_to_name: dict[int, str] = field(default_factory=dict)
    last_part_refresh_mono: float = 0.0
    live_session: object | None = None
    live_audio_queue: asyncio.Queue | None = None
    live_sender_task: asyncio.Task | None = None
    active_persona: str = 'pappy'
    speaker_persona: dict[int, str] = field(default_factory=dict)
    persona_sessions: dict[str, object] = field(default_factory=dict)
    pending_tool_sessions: dict[str, object] = field(default_factory=dict)
    recent_room_log: deque = field(default_factory=lambda: deque(maxlen=10))
    live_out_buf: bytearray = field(default_factory=bytearray)
    live_pcm_seq: int = 0
    logged_ssrcs: set[int] = field(default_factory=set)
    paused_by_live: bool = False
    ducked_by_live: bool = False
    paused_track_id: str = ''
    live_ntg_resumed: bool = False
    live_tail_flushed: bool = False
    live_stream_active: bool = False
    last_live_turn_mono: float = 0.0
    last_user_speech_mono: float = 0.0
    live_engaged_until_mono: float = 0.0
    voice_name: str = ''
    buffers: dict[int, SpeakerBuffer] = field(default_factory=dict)
    pending_turns: dict[int, PendingTurnBuffer] = field(default_factory=dict)


class VoiceListenerManager:
    def __init__(self, *, bridge, stt_engine):
        self.bridge = bridge
        self.stt = stt_engine
        self.states: dict[int, ChatListenState] = {}
        self._tasks: set[asyncio.Task] = set()
        self._flush_task: asyncio.Task | None = None

    def ensure_flush_loop(self):
        if self._flush_task is not None and not self._flush_task.done():
            return
        self._flush_task = asyncio.create_task(self._periodic_flush_loop())

    async def stop_all(self):
        if self._flush_task is not None and not self._flush_task.done():
            self._flush_task.cancel()
            await asyncio.gather(self._flush_task, return_exceptions=True)
        for task in list(self._tasks):
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        for st in list(self.states.values()):
            await self._stop_live_session(st)
        self._tasks.clear()
        self.states.clear()

    async def _stop_live_session(self, st: ChatListenState):
        if st.live_sender_task is not None and not st.live_sender_task.done():
            st.live_sender_task.cancel()
            await asyncio.gather(st.live_sender_task, return_exceptions=True)
        st.live_sender_task = None
        st.live_audio_queue = None
        closed_objs = set()
        for sess_obj in [st.live_session, *list(st.persona_sessions.values())]:
            if sess_obj is not None and id(sess_obj) not in closed_objs:
                closed_objs.add(id(sess_obj))
                try:
                    await sess_obj.close()
                except Exception:
                    pass
        st.live_session = None
        st.persona_sessions.clear()
        st.pending_tool_sessions.clear()

    async def _start_live_session(self, cid: int, st: ChatListenState):
        """Connect a persistent Gemini 3.8 Live multi-persona session pool for bidirectional VC."""
        try:
            import av_sync
            import gemini_live
        except Exception:
            return
        await self._stop_live_session(st)
        call = (self.bridge.calls.get(cid) or {}) if getattr(self.bridge, 'calls', None) else {}
        vc_title = str(call.get('vc_title') or '')
        init_spec = gemini_live.resolve_persona_spec(st.voice_name or 'pappy')
        st.active_persona = init_spec['id']
        q: asyncio.Queue = asyncio.Queue(maxsize=900)
        st.live_audio_queue = q

        def _emit_live_state(action: str):
            try:
                if self.bridge.events.full():
                    self.bridge.events.get_nowait()
                self.bridge.events.put_nowait({
                    'type': 'vc_live_state_change',
                    'chat_id': int(cid),
                    'action': action,
                    'paused_track_id': st.paused_track_id or None,
                })
            except Exception:
                pass

        def _engage_live_pause():
            cur_call = self.bridge.calls.get(cid) or {}
            sync_id = cur_call.get('av_sync_id')
            if cur_call.get('browser_live') or cur_call.get('status') != 'playing' or not sync_id or cur_call.get('stream_mode') == 'rtmp':
                return
            try:
                import main as _m
                if cur_call.get('is_music') or cur_call.get('music_freerun'):
                    # Keep music playing smoothly at ducked volume instead of hard-pausing FFmpeg.
                    _m._set_sync_duck(sync_id, True)
                    _m._set_sync_tts_hold(sync_id, True)
                    st.ducked_by_live = True
                    return
                cur_call['_live_paused'] = True
                _m._set_sync_tts_hold(sync_id, True)
                _m._set_sync_paused(sync_id, True)
                cur_call['status'] = 'paused'
                st.paused_by_live = True
                st.live_ntg_resumed = True
                st.paused_track_id = str(cur_call.get('playback_id') or '')
                _emit_live_state('paused_by_lancy')
                log.info('Gemini 3.8 Live auto-paused media for conversation chat=%s', cid)
            except Exception:
                pass

        async def _on_pcm_48k(stereo_48k: bytes):
            cur_call = self.bridge.calls.get(cid) or {}
            sync_id = cur_call.get('av_sync_id')
            if not sync_id or not stereo_48k:
                return
            st.last_live_turn_mono = time.monotonic()
            if cur_call.get('status') == 'playing':
                _engage_live_pause()
            elif cur_call.get('status') == 'paused' and not st.live_ntg_resumed:
                st.live_ntg_resumed = True
                try:
                    import main as _m
                    _m._set_sync_tts_hold(sync_id, True)
                    acct = self.bridge.accounts.get(cur_call.get('alias'))
                    eng = acct.get('engine') if acct else None
                    if eng is not None and not self.bridge.factory:
                        binding = getattr(eng, '_binding', None)
                        need_resume = True
                        if binding is not None and hasattr(binding, 'get_state'):
                            try:
                                b_state = await asyncio.wait_for(binding.get_state(cid), 1.5)
                                need_resume = bool(getattr(b_state, 'paused', False))
                            except Exception:
                                need_resume = False
                        if need_resume:
                            await asyncio.wait_for(eng.resume(cid), 2.5)
                except Exception:
                    pass
            q_dir = av_sync.tts_queue_dir_for(sync_id)
            q_dir.mkdir(parents=True, exist_ok=True)
            st.live_out_buf.extend(stereo_48k)
            if len(st.live_out_buf) < 7680:
                return
            emit_pcm = bytes(st.live_out_buf)
            st.live_out_buf.clear()
            st.live_pcm_seq += 1
            if st.live_pcm_seq == 1:
                log.info('Gemini 3.8 Live first 48kHz audio packet queued chat=%s sync_id=%s bytes=%s', cid, sync_id, len(emit_pcm))
            fname = f'{time.monotonic_ns():020d}_{st.live_pcm_seq:04d}_{secrets.token_hex(2)}.pcm'
            tmp_f = q_dir / f'.{fname}.tmp'
            final_f = q_dir / fname
            tmp_f.write_bytes(emit_pcm)
            os.replace(tmp_f, final_f)
            chunk_dur = len(emit_pcm) / float(av_sync.PCM_BYTES_PER_SEC)
            self.set_echo_guard(cid, chunk_dur, extend=True)

        async def _flush_out_tail():
            if not st.live_out_buf:
                return
            cur_call = self.bridge.calls.get(cid) or {}
            sync_id = cur_call.get('av_sync_id')
            if not sync_id:
                st.live_out_buf.clear()
                return
            q_dir = av_sync.tts_queue_dir_for(sync_id)
            q_dir.mkdir(parents=True, exist_ok=True)
            emit_pcm = bytes(st.live_out_buf)
            st.live_out_buf.clear()
            st.live_pcm_seq += 1
            fname = f'{time.monotonic_ns():020d}_{st.live_pcm_seq:04d}_{secrets.token_hex(2)}.pcm'
            tmp_f = q_dir / f'.{fname}.tmp'
            final_f = q_dir / fname
            tmp_f.write_bytes(emit_pcm)
            os.replace(tmp_f, final_f)

        async def _on_interrupted():
            st.live_out_buf.clear()
            st.last_user_speech_mono = time.monotonic()
            self.trigger_barge_in(cid)

        def _mark_live_engaged():
            now_m = time.monotonic()
            st.last_live_turn_mono = now_m
            st.live_engaged_until_mono = max(st.live_engaged_until_mono, now_m + 45.0, st.echo_guard_until_mono + 35.0)
            _engage_live_pause()

        async def _on_persona_redirect(spec: dict, in_txt: str, from_sess):
            st.live_out_buf.clear()
            _mark_live_engaged()
            await _activate_persona(
                spec,
                bind_uid=getattr(from_sess, 'active_speaker_id', None),
                handoff_text=in_txt,
                speaker_label=getattr(from_sess, 'active_speaker_name', '') or '',
            )

        async def _activate_persona(spec: dict, *, bind_uid: int | None = None, handoff_text: str = '', speaker_label: str = ''):
            pid = spec['id']
            target_sess = st.persona_sessions.get(pid)
            if target_sess is None or target_sess.closed:
                # Cap warm WebSockets at 3 per chat (LRU-evicting oldest non-default if needed)
                if len(st.persona_sessions) >= 3:
                    evict_key = next((k for k in st.persona_sessions if k not in {pid, 'pappy'}), next(iter(st.persona_sessions)))
                    old = st.persona_sessions.pop(evict_key, None)
                    if old is not None:
                        asyncio.create_task(old.close())
                p_inst = gemini_live.build_live_system_instruction(persona=spec, vc_title=vc_title)

                async def _on_persona_close(_cc, p_key=pid):
                    cur_s = st.persona_sessions.get(p_key)
                    if not st.enabled or cur_s is None or cur_s.closed:
                        return
                    await asyncio.sleep(0.35)
                    if not st.enabled or st.persona_sessions.get(p_key) is not cur_s or cur_s.closed or cur_s.connected:
                        return
                    try:
                        if q.full():
                            q.get_nowait()
                        q.put_nowait((b'', 16000, 1, None, ''))
                    except Exception:
                        pass

                async def _on_persona_go_away(_time_left, sess_ref=None, p_key=pid):
                    cur_s = st.persona_sessions.get(p_key)
                    if not st.enabled or cur_s is None or cur_s.closed or not getattr(cur_s, 'session_handle', None):
                        return
                    await asyncio.sleep(0.25)
                    if st.enabled and st.persona_sessions.get(p_key) is cur_s and not cur_s.closed:
                        await cur_s.connect(timeout_sec=6.0, start_reader=True)

                target_sess = gemini_live.GeminiLiveSession(
                    chat_id=cid,
                    persona_id=pid,
                    system_instruction=p_inst,
                    voice_name=spec['voice'],
                    on_pcm_48k_stereo=_on_pcm_48k,
                    on_tool_call=_on_tool_call,
                    on_interrupted=_on_interrupted,
                    on_transcription=_on_transcription,
                    on_turn_complete=_flush_out_tail,
                    on_close=_on_persona_close,
                    on_go_away=_on_persona_go_away,
                    is_conversation_engaged=lambda: (time.monotonic() <= max(st.live_engaged_until_mono, st.active_until_mono)),
                    on_wake_engaged=_mark_live_engaged,
                    on_persona_redirect=_on_persona_redirect,
                )
                ok = await target_sess.connect(timeout_sec=8.0, start_reader=True)
                if not ok:
                    await target_sess.close()
                    return None
                st.persona_sessions[pid] = target_sess
                log.info('Gemini 3.8 Live persona active chat=%s persona=%s (%s)', cid, spec['name'], spec['voice'])
                if st.recent_room_log:
                    await target_sess.send_context_update('Recent room conversation: ' + ' | '.join(list(st.recent_room_log)[-6:]))
            elif not target_sess.connected and not target_sess.closed:
                await target_sess.connect(timeout_sec=6.0, start_reader=True)

            st.active_persona = pid
            st.live_session = target_sess
            if bind_uid is not None:
                st.speaker_persona[int(bind_uid)] = pid
                target_sess.active_speaker_id = int(bind_uid)
            if speaker_label:
                target_sess.active_speaker_name = speaker_label
            if handoff_text and target_sess.connected:
                who = speaker_label or 'Speaker'
                await target_sess.send_text_turn(f'[{who} just called you ({spec["name"]})]: {handoff_text}')
            return target_sess

        async def _on_tool_call(function_calls, sess_obj):
            st.last_live_turn_mono = time.monotonic()
            for fc in (function_calls or []):
                call_id = str(fc.get('id') or '')
                fn_name = str(fc.get('name') or '')
                args = fc.get('args') or {}
                if not fn_name:
                    continue
                if call_id:
                    st.pending_tool_sessions[call_id] = sess_obj
                    if len(st.pending_tool_sessions) > 64:
                        st.pending_tool_sessions.pop(next(iter(st.pending_tool_sessions)), None)
                if fn_name == 'switch_persona':
                    spec = gemini_live.resolve_persona_spec(args.get('name'), voice_type=args.get('voice_type'))
                    handoff = str(args.get('handoff_text') or '').strip()
                    await sess_obj.send_tool_response(call_id, fn_name, {
                        'status': 'ok',
                        'retryable': False,
                        'message': f"Switched seamlessly to {spec['name']} ({spec['age_group']}, {spec['gender']}). Stay silent so {spec['name']} speaks directly.",
                    })
                    await _activate_persona(
                        spec,
                        bind_uid=sess_obj.active_speaker_id,
                        handoff_text=handoff,
                        speaker_label=sess_obj.active_speaker_name or '',
                    )
                    continue
                if fn_name in {'control_playback', 'search_and_play_music', 'search_videos', 'search_movies_series'}:
                    act = str(args.get('action') or '')
                    if fn_name == 'control_playback' and act in {'pause', 'stop', 'leave'}:
                        st.paused_by_live = False
                elif fn_name == 'finish_conversation':
                    resume = bool(args.get('resumePlayback', True))
                    await self.release_live_pause(cid, resume=resume, clear_engaged=True)
                    await sess_obj.send_tool_response(call_id, fn_name, {
                        'status': 'ok',
                        'retryable': False,
                        'message': 'Resumed playback cleanly.' if resume else 'Conversation ended cleanly.',
                    })
                    continue
                if self.bridge.events.full():
                    try:
                        self.bridge.events.get_nowait()
                    except Exception:
                        pass
                self.bridge.events.put_nowait({
                    'type': 'vc_live_tool_call',
                    'event_id': f'ltc:{cid}:{call_id or fn_name}',
                    'chat_id': int(cid),
                    'call_id': call_id,
                    'name': fn_name,
                    'args': args,
                    'sender_id': sess_obj.active_speaker_id,
                    'sender_name': sess_obj.active_speaker_name or None,
                })

        async def _on_transcription(info: dict):
            st.last_live_turn_mono = time.monotonic()
            in_t = str(info.get('input_text') or '').strip()
            out_t = str(info.get('output_text') or '').strip()
            spk = str(info.get('speaker_name') or 'Member').strip()
            if in_t:
                st.last_user_speech_mono = time.monotonic()
                st.recent_room_log.append(f'{spk}: "{in_t[:120]}"')
                if re.search(r'\b(?:pappy|lancy|ava|maya|leo|nana|elder|zara|marcus|chloe)\b', in_t, re.IGNORECASE):
                    _engage_live_pause()
            if out_t:
                st.recent_room_log.append(f'{st.active_persona.title()}: "{out_t[:120]}"')
            if self.bridge.events.full():
                try:
                    self.bridge.events.get_nowait()
                except Exception:
                    pass
            self.bridge.events.put_nowait({
                'type': 'vc_live_transcript',
                'chat_id': int(cid),
                'input_text': in_t,
                'output_text': out_t,
                'sender_id': info.get('speaker_id'),
                'sender_name': info.get('speaker_name') or None,
            })

        first_sess = await _activate_persona(init_spec)
        if first_sess is None:
            st.live_audio_queue = None
            return
        log.info('Gemini 3.8 Live bidirectional session active chat=%s persona=%s', cid, init_spec['name'])

        async def _sender_loop():
            try:
                while st.enabled and st.live_audio_queue is q:
                    item = await q.get()
                    if item is None:
                        break
                    raw_pcm, s_rate, n_ch, u_id, s_name = item
                    target_pid = (st.speaker_persona.get(int(u_id)) if u_id is not None else None) or st.active_persona
                    target_sess = st.persona_sessions.get(target_pid) or st.live_session
                    if target_sess is None or target_sess.closed:
                        continue
                    if not target_sess.connected:
                        re_ok = await target_sess.connect(timeout_sec=6.0, start_reader=True)
                        if re_ok:
                            log.info('Gemini 3.8 Live session reconnected chat=%s persona=%s', cid, target_sess.persona_id)
                        else:
                            await asyncio.sleep(0.5)
                            continue
                    if raw_pcm == b'__FLUSH__':
                        await target_sess.flush_tail()
                    elif raw_pcm and target_sess.connected:
                        await target_sess.push_pcm_chunk(raw_pcm, s_rate, n_ch, speaker_id=u_id, speaker_name=s_name)
            except asyncio.CancelledError:
                pass
            except Exception as err:
                log.debug('GeminiLive sender loop ended chat=%s: %s', cid, str(err)[:140])

        st.live_sender_task = asyncio.create_task(_sender_loop())

    async def submit_live_tool_result(self, chat_id: int, call_id: str, name: str, response: dict | None) -> bool:
        st = self.states.get(int(chat_id))
        if not st:
            return False
        now_m = time.monotonic()
        st.last_live_turn_mono = now_m
        st.live_engaged_until_mono = max(st.live_engaged_until_mono, now_m + 90.0)
        sess_obj = st.pending_tool_sessions.pop(str(call_id), None) or st.live_session
        if not sess_obj or not sess_obj.connected:
            return False
        return await sess_obj.send_tool_response(call_id, name, response)

    async def push_context_update(self, chat_id: int, summary: str, *, trigger_turn: bool = False) -> bool:
        st = self.states.get(int(chat_id))
        if not st:
            return False
        now_m = time.monotonic()
        if trigger_turn:
            st.last_live_turn_mono = now_m
            st.live_engaged_until_mono = max(st.live_engaged_until_mono, now_m + 90.0)
        if 'status=paused' in str(summary) and not st.paused_by_live:
            st.paused_by_live = False
            st.live_ntg_resumed = False
        elif 'status=playing' in str(summary):
            st.live_ntg_resumed = False
        if trigger_turn and st.live_session is not None and getattr(st.live_session, 'connected', False):
            return await st.live_session.send_text_turn(summary)
        sent_any = False
        for sess_obj in [st.live_session, *list(st.persona_sessions.values())]:
            if sess_obj is not None and getattr(sess_obj, 'connected', False):
                if await sess_obj.send_context_update(summary):
                    sent_any = True
        return sent_any

    async def release_live_pause(self, chat_id: int, *, resume: bool = True, clear_engaged: bool = False) -> bool:
        cid = int(chat_id)
        st = self.states.get(cid)
        if not st:
            return False
        was_paused = bool(st.paused_by_live)
        was_ducked = bool(st.ducked_by_live)
        expected_pid = st.paused_track_id
        st.paused_by_live = False
        st.ducked_by_live = False
        st.live_ntg_resumed = False
        if clear_engaged:
            st.live_engaged_until_mono = 0.0
        st.paused_track_id = ''
        cur_call = self.bridge.calls.get(cid) or {}
        sync_id = cur_call.get('av_sync_id')
        if was_ducked and sync_id:
            try:
                import main as _m
                _m._set_sync_duck(sync_id, False)
                if not was_paused:
                    _m._set_sync_tts_hold(sync_id, False)
            except Exception:
                pass
        if not resume or not was_paused:
            return was_ducked
        if expected_pid and str(cur_call.get('playback_id') or '') != expected_pid:
            return False
        if sync_id and cur_call.get('status') == 'paused':
            try:
                import main as _m
                cur_call['_live_paused'] = False
                _m._set_sync_paused(sync_id, False)
                _m._set_sync_tts_hold(sync_id, False)
                _m._set_sync_duck(sync_id, False)
                _m._write_vchud_state(sync_id, active=False)
                cur_call['status'] = 'playing'
                cur_call['last_progress'] = time.monotonic()
                if hasattr(self.bridge, 'ensure_engine_resumed'):
                    await self.bridge.ensure_engine_resumed(cid)
                if self.bridge.events.full():
                    self.bridge.events.get_nowait()
                self.bridge.events.put_nowait({
                    'type': 'vc_live_state_change',
                    'chat_id': cid,
                    'action': 'resumed_by_lancy',
                })
                log.info('Gemini 3.8 Live resumed paused media after idle conversation chat=%s', cid)
                return True
            except Exception:
                pass
        return False

    async def start_chat(
        self,
        chat_id: int,
        alias: str,
        *,
        enabled: bool = True,
        authorized_user_ids: list[int] | None = None,
        enforce_auth: bool = False,
        use_live: bool | None = None,
        force_record: bool = False,
    ) -> ChatListenState:
        cid = int(chat_id)
        st = self.states.get(cid)
        if st is None or st.alias != alias:
            st = ChatListenState(chat_id=cid, alias=alias)
            self.states[cid] = st
        st.enabled = bool(enabled)
        if authorized_user_ids is not None:
            st.authorized_user_ids = {int(x) for x in authorized_user_ids if int(x or 0) > 0}
        st.enforce_auth = bool(enforce_auth)
        self.ensure_flush_loop()
        if st.enabled and (force_record or not st.recording_started):
            await self._attach_record(cid, alias, st)
        should_live = bool(use_live) if use_live is not None else bool(getattr(self.bridge, 'enable_gemini_live', False))
        if st.enabled and should_live and st.live_session is None:
            task = asyncio.create_task(self._start_live_session(cid, st))
            self._track_task(task)
        return st

    async def stop_chat(self, chat_id: int):
        cid = int(chat_id)
        st = self.states.pop(cid, None)
        if st:
            await self._stop_live_session(st)
        if st and st.recording_started:
            acct = self.bridge.accounts.get(st.alias)
            engine = acct.get('engine') if acct else None
            if engine is not None and hasattr(engine, 'record'):
                try:
                    await asyncio.wait_for(engine.record(cid, None), 3.0)
                except Exception:
                    pass

    def set_echo_guard(self, chat_id: int, duration_sec: float, *, extend: bool = False):
        st = self.states.get(int(chat_id))
        if st:
            now = time.monotonic()
            dur = max(0.02, float(duration_sec))
            real_end = 0.0
            cur_call = (self.bridge.calls.get(int(chat_id)) or {}) if getattr(self.bridge, 'calls', None) else {}
            sync_id = cur_call.get('av_sync_id')
            if sync_id:
                try:
                    import main as _m
                    real_end = _m._get_sync_tts_play_end(sync_id)
                except Exception:
                    real_end = 0.0
            if real_end > now:
                st.echo_guard_until_mono = real_end + 0.08
            elif extend and st.echo_guard_until_mono > now:
                # Cap extension tightly to actual remaining stream budget instead of compounding +0.25s per chunk.
                st.echo_guard_until_mono = max(st.echo_guard_until_mono + dur, now + dur + 0.08)
            else:
                st.echo_guard_until_mono = max(st.echo_guard_until_mono, now + max(0.15, dur) + 0.14)
            # Drop partial captures recorded during TTS tail to avoid self-trigger unless extending queued sentence
            if not extend:
                for sb in st.buffers.values():
                    sb.chunks.clear()
                    sb.total_bytes = 0
                    sb.in_speech = False
                    sb.barge_frames = 0
                    sb.live_preroll.clear()

    def trigger_barge_in(self, chat_id: int, *, user_id: int | None = None, ssrc: int | None = None) -> bool:
        """Cancel queued/streaming TTS audio mid-speech when a speaker interrupts Lancy."""
        cid = int(chat_id)
        st = self.states.get(cid)
        if not st:
            return False
        st.echo_guard_until_mono = 0.0
        st.barge_in_seq = int(getattr(st, 'barge_in_seq', 0)) + 1
        call = self.bridge.calls.get(cid) or {}
        sync_id = call.get('av_sync_id')
        cleared = False
        if sync_id:
            try:
                import av_sync
                av_sync.clear_tts_queue(sync_id)
                cleared = True
            except Exception:
                pass
        uid = user_id if user_id is not None else (st.ssrc_to_uid.get(int(ssrc)) if ssrc else None)
        sender_name = st.uid_to_name.get(int(uid)) if uid else ''
        try:
            if self.bridge.events.full():
                self.bridge.events.get_nowait()
            self.bridge.events.put_nowait({
                'type': 'vc_voice_barge_in',
                'chat_id': cid,
                'sender_id': int(uid) if uid else None,
                'sender_name': sender_name or None,
                'barge_in_seq': int(st.barge_in_seq),
                'event_id': f'barge:{cid}:{st.barge_in_seq}',
            })
        except Exception:
            pass
        return cleared or True

    def set_listening_window(
        self,
        chat_id: int,
        *,
        active: bool,
        duration_sec: float = 28.0,
        active_user_id: int | None = None,
    ):
        st = self.states.get(int(chat_id))
        if not st:
            return
        if active:
            st.active_until_mono = time.monotonic() + max(5.0, float(duration_sec or 28.0))
            if active_user_id is not None:
                st.active_user_id = int(active_user_id)
        else:
            st.active_until_mono = 0.0
            st.active_user_id = None

    async def _attach_record(self, chat_id: int, alias: str, st: ChatListenState):
        if self.bridge.factory:
            st.recording_started = True
            return
        acct = self.bridge.accounts.get(alias)
        engine = acct.get('engine') if acct else None
        if engine is None or not hasattr(engine, 'record'):
            return
        try:
            from pytgcalls.types import RecordStream, AudioQuality
            rec = RecordStream(audio=True, audio_parameters=AudioQuality.MEDIUM)
            await asyncio.wait_for(engine.record(chat_id, rec), 8.0)
            st.recording_started = True
            await self.refresh_participants(chat_id, force=True)
            log.info('Attached incoming audio listener chat=%s alias=%s', chat_id, alias)
        except Exception as err:
            log.warning('Could not attach RecordStream chat=%s kind=%s: %s', chat_id, type(err).__name__, str(err)[:160])

    async def refresh_participants(self, chat_id: int, *, force: bool = False) -> dict[int, int]:
        cid = int(chat_id)
        st = self.states.get(cid)
        if not st:
            return {}
        now = time.monotonic()
        if not force and (now - st.last_part_refresh_mono) < 3.0:
            return st.ssrc_to_uid
        st.last_part_refresh_mono = now
        acct = self.bridge.accounts.get(st.alias)
        engine = acct.get('engine') if acct else None
        if engine is None or not hasattr(engine, 'get_participants'):
            return st.ssrc_to_uid
        try:
            parts = await asyncio.wait_for(engine.get_participants(cid), 4.0)
            missing_name_uids = []
            for p in (parts or []):
                uid = int(getattr(p, 'user_id', 0) or 0)
                src = int(getattr(p, 'source', 0) or 0)
                if uid and src:
                    st.ssrc_to_uid[src] = uid
                if uid:
                    cands = (
                        getattr(p, 'first_name', None),
                        getattr(p, 'last_name', None),
                    )
                    full_fn = ' '.join(x.strip() for x in cands if isinstance(x, str) and x.strip())
                    raw_name = (
                        full_fn
                        or next((v for v in (getattr(p, 'name', None), getattr(p, 'title', None), getattr(p, 'username', None)) if isinstance(v, str) and v.strip()), None)
                    )
                    if raw_name:
                        st.uid_to_name[uid] = raw_name.strip()[:64]
                    elif uid not in st.uid_to_name:
                        missing_name_uids.append(uid)
            client = acct.get('client') if acct else None
            if missing_name_uids and client is not None and not self.bridge.factory and hasattr(client, 'get_users'):
                try:
                    users = await asyncio.wait_for(client.get_users(missing_name_uids[:20]), 4.0)
                    if not isinstance(users, list):
                        users = [users]
                    for u in users:
                        u_id = int(getattr(u, 'id', 0) or 0)
                        disp = ' '.join(x for x in (getattr(u, 'first_name', None), getattr(u, 'last_name', None)) if x).strip() or getattr(u, 'username', None)
                        if u_id and disp:
                            st.uid_to_name[u_id] = str(disp)[:64]
                except Exception:
                    pass
        except Exception as err:
            log.debug('refresh_participants error chat=%s: %s', cid, str(err)[:140])
        return st.ssrc_to_uid

    def handle_incoming_frames(self, alias: str, chat_id: int, frames: list):
        cid = int(chat_id)
        st = self.states.get(cid)
        if not st or not st.enabled or st.alias != alias:
            return
        now = time.monotonic()
        echo_guarded = now < st.echo_guard_until_mono
        active_window = now <= st.active_until_mono

        acct = self.bridge.accounts.get(alias) or {}
        self_uid = int(acct.get('uid') or 0)
        needs_refresh = False

        for frame in (frames or []):
            ssrc = int(getattr(frame, 'ssrc', 0) or 0)
            raw = bytes(getattr(frame, 'frame', b'') or b'')
            if not ssrc or not raw:
                continue
            uid = st.ssrc_to_uid.get(ssrc)
            if uid is None:
                needs_refresh = True
            elif uid == self_uid:
                continue
            elif st.enforce_auth and st.authorized_user_ids and uid not in st.authorized_user_ids:
                continue

            info = getattr(frame, 'info', None)
            sr = int(getattr(info, 'sample_rate', 0) or st.record_sample_rate or 36000)
            ch = int(getattr(info, 'channels', 0) or st.record_channels or 1)
            sb = st.buffers.get(ssrc)
            if sb is None:
                sb = SpeakerBuffer(ssrc=ssrc, sample_rate=sr, channels=ch)
                st.buffers[ssrc] = sb
            sb.sample_rate = sr
            sb.channels = ch

            samples = np.frombuffer(raw, dtype='<i2').astype(np.float32) / 32768.0
            rms = float(np.sqrt(np.mean(samples * samples))) if len(samples) else 0.0

            live_ready = bool(st.live_session is not None and not getattr(st.live_session, 'closed', False) and st.live_audio_queue is not None)
            if ssrc not in st.logged_ssrcs:
                st.logged_ssrcs.add(ssrc)
                log.info('Receiving PyTgCalls audio stream frames chat=%s ssrc=%s uid=%s sr=%s ch=%s bytes=%s rms=%.4f live=%s', cid, ssrc, uid, sr, ch, len(raw), rms, live_ready)

            s_name = st.uid_to_name.get(int(uid)) if uid is not None else ''
            if rms < 0.015:
                sb.noise_floor = (sb.noise_floor * 0.92) + (rms * 0.08)

            if echo_guarded:
                can_barge = (
                    (live_ready and (not st.enforce_auth or not st.authorized_user_ids or uid in st.authorized_user_ids))
                    or (active_window and (st.active_user_id is None or uid == st.active_user_id or (uid in st.authorized_user_ids)))
                )
                if live_ready:
                    # Calibrated adaptive barge-in (prevents speakerphone cutoff while preserving Turn-2 opening words).
                    sb.live_preroll.append((raw, sr, ch, uid, s_name))
                    barge_thresh = max(0.015, min(0.024, sb.noise_floor * 3.0))
                    if can_barge and rms >= barge_thresh:
                        sb.barge_frames += 1
                        if sb.barge_frames >= 2:
                            self.trigger_barge_in(cid, user_id=uid, ssrc=ssrc)
                            echo_guarded = False
                            sb.barge_frames = 0
                            st.live_stream_active = True
                            st.last_user_speech_mono = now
                            sb.last_voice_mono = now
                            st.live_tail_flushed = False
                            for pre_item in list(sb.live_preroll)[:-1]:
                                try:
                                    if st.live_audio_queue.full():
                                        st.live_audio_queue.get_nowait()
                                    st.live_audio_queue.put_nowait(pre_item)
                                except Exception:
                                    pass
                            sb.live_preroll.clear()
                        else:
                            continue
                    else:
                        sb.barge_frames = 0
                        if st.live_stream_active and not st.live_tail_flushed and st.last_user_speech_mono > 0.0 and (now - st.last_user_speech_mono) > 1.10:
                            st.live_tail_flushed = True
                            st.live_stream_active = False
                            try:
                                if st.live_audio_queue.full():
                                    st.live_audio_queue.get_nowait()
                                st.live_audio_queue.put_nowait((b'__FLUSH__', sr, ch, uid, ''))
                            except Exception:
                                pass
                        continue
                else:
                    if can_barge and rms >= (VAD_RMS_THRESHOLD * 1.45):
                        sb.barge_frames += 1
                        if sb.barge_frames >= 2:
                            self.trigger_barge_in(cid, user_id=uid, ssrc=ssrc)
                            echo_guarded = False
                            sb.barge_frames = 0
                        else:
                            continue
                    else:
                        sb.barge_frames = 0
                        continue
            else:
                sb.barge_frames = 0

            # Continuous streaming into Gemini 3.8 Live with clean audioStreamEnd commit on turn end
            if live_ready:
                gate_rms = max(0.0014, sb.noise_floor * 1.4)
                if rms >= gate_rms:
                    sb.last_voice_mono = now
                    st.last_user_speech_mono = now
                    st.live_tail_flushed = False
                    st.live_stream_active = True
                else:
                    sb.live_preroll.append((raw, sr, ch, uid, s_name))
                if rms >= gate_rms or (now - sb.last_voice_mono) <= 1.10:
                    try:
                        if st.live_audio_queue.full():
                            st.live_audio_queue.get_nowait()
                        st.live_audio_queue.put_nowait((raw, sr, ch, uid, s_name))
                    except Exception:
                        pass
                elif not st.live_tail_flushed and st.last_user_speech_mono > 0.0 and (now - st.last_user_speech_mono) > 1.10:
                    st.live_tail_flushed = True
                    st.live_stream_active = False
                    try:
                        if st.live_audio_queue.full():
                            st.live_audio_queue.get_nowait()
                        st.live_audio_queue.put_nowait((b'__FLUSH__', sr, ch, uid, ''))
                    except Exception:
                        pass
                continue

            is_speech = rms >= VAD_RMS_THRESHOLD

            if is_speech:
                if not sb.in_speech:
                    sb.in_speech = True
                    sb.speech_started_mono = now
                    for pre in sb.pre_roll:
                        sb.chunks.append(pre)
                        sb.total_bytes += len(pre)
                    sb.pre_roll.clear()
                sb.chunks.append(raw)
                sb.total_bytes += len(raw)
                sb.last_voice_mono = now
                if (now - sb.speech_started_mono) >= VAD_MAX_UTTERANCE_SEC:
                    self._dispatch_utterance(st, sb)
            else:
                if sb.in_speech:
                    sb.chunks.append(raw)
                    sb.total_bytes += len(raw)
                    silence_limit = VAD_FRAME_SILENCE_SEC if active_window else VAD_IDLE_SILENCE_SEC
                    if (now - sb.last_voice_mono) >= silence_limit:
                        self._dispatch_utterance(st, sb)
                else:
                    sb.pre_roll.append(raw)

        if needs_refresh and (now - st.last_part_refresh_mono) >= 3.0:
            task = asyncio.create_task(self.refresh_participants(cid))
            self._track_task(task)

    async def _periodic_flush_loop(self):
        try:
            while True:
                await asyncio.sleep(0.25)
                now = time.monotonic()
                for st in list(self.states.values()):
                    if not st.enabled:
                        continue
                    active_window = now <= st.active_until_mono
                    silence_limit = VAD_FRAME_SILENCE_SEC if active_window else VAD_IDLE_SILENCE_SEC
                    for sb in list(st.buffers.values()):
                        if sb.in_speech and (now - sb.last_voice_mono) >= silence_limit:
                            self._dispatch_utterance(st, sb)
                    for ssrc_key, pt in list(st.pending_turns.items()):
                        sb = st.buffers.get(ssrc_key)
                        currently_speaking = bool(sb and sb.in_speech)
                        elapsed_idle = now - pt.updated_mono
                        elapsed_total = now - pt.started_mono
                        if currently_speaking and elapsed_total < VAD_MAX_MERGED_TURN_SEC:
                            continue
                        if elapsed_idle >= VAD_INCOMPLETE_HOLD_SEC or elapsed_total >= VAD_MAX_MERGED_TURN_SEC:
                            st.pending_turns.pop(ssrc_key, None)
                            self._emit_turn_event(st, pt)
                    cur_call = self.bridge.calls.get(st.chat_id) or {}
                    any_speaking = any(sb.in_speech for sb in st.buffers.values())
                    if (
                        (st.paused_by_live or st.ducked_by_live)
                        and not cur_call.get('browser_live')
                        and not any_speaking
                        and now >= st.echo_guard_until_mono
                        and (now - max(st.last_live_turn_mono, st.last_user_speech_mono, st.echo_guard_until_mono)) >= 20.0
                    ):
                        await self.release_live_pause(st.chat_id, resume=True, clear_engaged=False)
        except asyncio.CancelledError:
            pass

    def _track_task(self, task: asyncio.Task):
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    def _emit_turn_event(self, st: ChatListenState, pt: PendingTurnBuffer):
        if self.bridge.events.full():
            try:
                self.bridge.events.get_nowait()
            except Exception:
                pass
        sender_name = pt.sender_name or (st.uid_to_name.get(int(pt.uid)) if pt.uid is not None else '') or ''
        ts_ms = int(time.time() * 1000)
        self.bridge.events.put_nowait({
            'type': 'vc_voice_transcript',
            'event_id': f'vct:{int(st.chat_id)}:{int(pt.ssrc)}:{ts_ms}',
            'chat_id': int(st.chat_id),
            'ssrc': int(pt.ssrc),
            'sender_id': int(pt.uid) if pt.uid is not None else None,
            'sender_name': sender_name or None,
            'simultaneous_speakers': list(pt.simultaneous_speakers or []),
            'detected_at_ms': ts_ms,
            'text': pt.last_text,
            'raw_text': pt.last_text,
            'confidence': pt.confidence,
            'avg_logprob': pt.avg_logprob,
            'no_speech_prob': pt.no_speech_prob,
            'is_wake': pt.is_wake,
            'is_listen_command': pt.is_listen_command,
            'low_confidence': pt.low_confidence,
            'duration_sec': round(pt.duration_sec, 2),
            'merged_segments': int(pt.segments or 1),
            'turn_duration_sec': round(max(pt.duration_sec, time.monotonic() - pt.started_mono), 2),
        })

    def _dispatch_utterance(self, st: ChatListenState, sb: SpeakerBuffer):
        pcm = b''.join(sb.chunks)
        sr = sb.sample_rate
        ch = sb.channels
        ssrc = sb.ssrc
        sb.chunks.clear()
        sb.total_bytes = 0
        sb.in_speech = False
        sb.speech_started_mono = 0.0

        bps = max(1, sr * ch * 2)
        dur = len(pcm) / float(bps)
        if dur < VAD_MIN_SPEECH_SEC:
            return
        task = asyncio.create_task(self._process_utterance(st, ssrc, pcm, sr, ch))
        self._track_task(task)

    async def _process_utterance(self, st: ChatListenState, ssrc: int, pcm: bytes, sr: int, ch: int):
        try:
            uid = st.ssrc_to_uid.get(ssrc)
            if uid is None:
                await self.refresh_participants(st.chat_id)
                uid = st.ssrc_to_uid.get(ssrc)

            acct = self.bridge.accounts.get(st.alias) or {}
            if uid is not None and uid == acct.get('uid'):
                return

            call = self.bridge.calls.get(st.chat_id) or {}
            active_session = time.monotonic() <= st.active_until_mono
            if st.active_user_id is not None and uid is not None and uid != st.active_user_id and not active_session:
                active_session = False

            hint = str(call.get('vc_title') or '')
            pending = st.pending_turns.get(ssrc) if active_session else None
            if pending and (time.monotonic() - pending.started_mono) <= VAD_MAX_MERGED_TURN_SEC:
                combined_pcm = b''.join(pending.pcm_chunks) + pcm
            else:
                if pending:
                    st.pending_turns.pop(ssrc, None)
                    self._emit_turn_event(st, pending)
                    pending = None
                combined_pcm = pcm

            res = await self.stt.transcribe(
                combined_pcm,
                sample_rate=sr,
                channels=ch,
                context_hint=hint,
                active_session=active_session,
            )
            if res is None:
                if pending:
                    st.pending_turns.pop(ssrc, None)
                    self._emit_turn_event(st, pending)
                return

            # Outside an active "Lancy listen" conversation session, ONLY emit explicit "Lancy listen" wakes; ignore all other idle speech.
            if not active_session and not res.is_listen_command:
                return

            now = time.monotonic()
            other_active = []
            for o_ssrc, o_sb in list(st.buffers.items()):
                if o_ssrc == ssrc:
                    continue
                if o_sb.in_speech or (now - o_sb.last_voice_mono) <= 0.75:
                    o_uid = st.ssrc_to_uid.get(o_ssrc)
                    label = st.uid_to_name.get(o_uid) if o_uid else None
                    other_active.append(label or (f'User {o_uid}' if o_uid else f'SSRC {o_ssrc}'))
            sender_name = st.uid_to_name.get(int(uid)) if uid is not None else ''

            if active_session and not res.is_listen_command:
                sb = st.buffers.get(ssrc)
                speaker_resumed = bool(sb and sb.in_speech)
                needs_hold = speaker_resumed or is_incomplete_turn(res.text)
                total_elapsed = (now - pending.started_mono) if pending else res.duration_sec
                if needs_hold and total_elapsed < VAD_MAX_MERGED_TURN_SEC:
                    if pending is None:
                        pending = PendingTurnBuffer(
                            ssrc=ssrc,
                            uid=uid,
                            pcm_chunks=[pcm],
                            sample_rate=sr,
                            channels=ch,
                            started_mono=now - min(res.duration_sec, 6.0),
                        )
                        st.pending_turns[ssrc] = pending
                    else:
                        pending.pcm_chunks.append(pcm)
                    pending.uid = uid
                    pending.updated_mono = now
                    pending.last_text = res.text
                    pending.segments += 1
                    pending.low_confidence = res.low_confidence
                    pending.confidence = res.confidence
                    pending.avg_logprob = res.avg_logprob
                    pending.no_speech_prob = res.no_speech_prob
                    pending.is_wake = res.is_wake
                    pending.is_listen_command = res.is_listen_command
                    pending.duration_sec = res.duration_sec
                    pending.sender_name = sender_name or pending.sender_name
                    if other_active:
                        pending.simultaneous_speakers = other_active
                    # Keep active listening window alive while speaker is mid-thought
                    st.active_until_mono = max(st.active_until_mono, now + 20.0)
                    return

            if pending:
                st.pending_turns.pop(ssrc, None)
            pt_final = PendingTurnBuffer(
                ssrc=ssrc,
                uid=uid,
                started_mono=pending.started_mono if pending else (now - res.duration_sec),
                updated_mono=now,
                last_text=res.text,
                segments=(pending.segments + 1) if pending else 1,
                low_confidence=res.low_confidence,
                confidence=res.confidence,
                avg_logprob=res.avg_logprob,
                no_speech_prob=res.no_speech_prob,
                is_wake=res.is_wake,
                is_listen_command=res.is_listen_command,
                duration_sec=res.duration_sec,
                sender_name=sender_name or (pending.sender_name if pending else ''),
                simultaneous_speakers=other_active or (pending.simultaneous_speakers if pending else []),
            )
            self._emit_turn_event(st, pt_final)
        except Exception as err:
            log.debug('Voice utterance processing error chat=%s: %s', st.chat_id, str(err)[:160])
