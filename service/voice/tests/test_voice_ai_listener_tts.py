import asyncio
import ctypes
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import AsyncMock, MagicMock
import numpy as np

VOICE_DIR = Path(__file__).resolve().parents[1]
if str(VOICE_DIR) not in sys.path:
    sys.path.insert(0, str(VOICE_DIR))

import av_sync
import main as bridge_main
from stt_engine import normalize_nigerian_speech, TranscriptResult
from tts_engine import sanitize_spoken_text, resolve_voice_name
from voice_listener import VoiceListenerManager


class VoiceAiListenerAndTtsTests(unittest.TestCase):
    def test_nigerian_pidgin_and_phonetic_normalization(self):
        norm1, wake1 = normalize_nigerian_speech('nancy listen lower d volume', active_session=False)
        self.assertTrue(wake1)
        self.assertIn('Lancy', norm1)
        self.assertIn('the volume', norm1.lower())

        norm2, _ = normalize_nigerian_speech('send dis video to the chat and move to next que', active_session=True)
        self.assertIn('this video', norm2.lower())
        self.assertIn('next queue', norm2.lower())

        norm3, _ = normalize_nigerian_speech('abeg gi to d middle and pause am', active_session=True)
        self.assertIn('go to the middle', norm3.lower())
        self.assertIn('pause it', norm3.lower())

        # Normal conversation saying unrelated word should not falsely wake without command
        _, wake4 = normalize_nigerian_speech('i talked to nancy yesterday at work', active_session=False)
        self.assertFalse(wake4)

    def test_tts_sanitization_and_voice_aliases(self):
        cleaned = sanitize_spoken_text('🎙️ **Volume** is now `60%`! See https://t.me/test ♡✨')
        self.assertNotIn('https://', cleaned)
        self.assertNotIn('**', cleaned)
        self.assertIn('Volume is now 60%!', cleaned)
        self.assertEqual(resolve_voice_name('ng_female'), 'en-NG-EzinneNeural')
        self.assertEqual(resolve_voice_name('uk_female'), 'en-GB-SoniaNeural')

    def test_avsync_tts_feeder_and_duck_mix(self):
        with tempfile.TemporaryDirectory() as tmp:
            sync_id = f'test_tts_{int(time.time() * 1000)}'
            qdir = av_sync.tts_queue_dir_for(sync_id)
            qdir.mkdir(parents=True, exist_ok=True)
            try:
                tts_samples = np.full(1920, 12000, dtype='<i2').tobytes()  # 3840 bytes = 20ms stereo 48kHz
                (qdir / '0001.pcm').write_bytes(tts_samples)
                feeder = av_sync.TtsAudioFeeder(sync_id, sample_rate=48000, channels=2)
                chunk, active = feeder.pop_chunk(3840)
                self.assertTrue(active)
                self.assertEqual(len(chunk), 3840)

                media_pcm = np.full(1920, 10000, dtype='<i2').tobytes()
                mixed = av_sync.mix_pcm_with_tts(media_pcm, chunk, duck_factor=0.2)
                arr = np.frombuffer(mixed, dtype='<i2')
                # 10000 * 0.2 + 12000 = 14000
                self.assertEqual(int(arr[0]), 14000)
            finally:
                for p in qdir.glob('*'):
                    p.unlink(missing_ok=True)
                if qdir.exists():
                    qdir.rmdir()

    def test_voice_listener_ssrc_mapping_echo_guard_and_utterance(self):
        async def run():
            events = asyncio.Queue(maxsize=20)
            engine = MagicMock()
            engine.record = AsyncMock()
            part_admin = MagicMock(user_id=501, source=11111)
            part_viewer = MagicMock(user_id=999, source=22222)
            engine.get_participants = AsyncMock(return_value=[part_admin, part_viewer])

            bridge = MagicMock()
            bridge.factory = None
            bridge.events = events
            bridge.calls = {-100123: {'vc_title': 'Inception'}}
            bridge.accounts = {'main': {'uid': 777, 'engine': engine}}

            stt = MagicMock()
            # 1. Idle mic speech WITHOUT "Lancy listen" must be ignored completely
            stt.transcribe = AsyncMock(return_value=TranscriptResult(
                text='Lancy lower the volume to 50',
                raw_text='Lancy lower the volume to 50',
                confidence=0.92,
                avg_logprob=-0.22,
                no_speech_prob=0.05,
                is_wake=True,
                is_listen_command=False,
                low_confidence=False,
                duration_sec=1.2,
            ))

            listener = VoiceListenerManager(bridge=bridge, stt_engine=stt)
            st = await listener.start_chat(-100123, 'main', enabled=True, authorized_user_ids=[501], enforce_auth=True)
            await listener.refresh_participants(-100123, force=True)
            self.assertEqual(st.ssrc_to_uid[11111], 501)

            loud_pcm = np.full(7200, 4000, dtype='<i2').tobytes()
            quiet_pcm = np.zeros(7200, dtype='<i2').tobytes()
            f_loud = MagicMock(ssrc=11111, frame=loud_pcm, info=MagicMock(sample_rate=36000, channels=1))
            f_unauth = MagicMock(ssrc=22222, frame=loud_pcm, info=MagicMock(sample_rate=36000, channels=1))
            f_quiet = MagicMock(ssrc=11111, frame=quiet_pcm, info=MagicMock(sample_rate=36000, channels=1))

            listener.handle_incoming_frames('main', -100123, [f_loud, f_loud, f_unauth])
            self.assertNotIn(22222, st.buffers)  # unauthorized speaker ignored cleanly
            st.buffers[11111].last_voice_mono = time.monotonic() - 1.0
            listener.handle_incoming_frames('main', -100123, [f_quiet])
            await asyncio.sleep(0.08)
            self.assertTrue(events.empty())  # non-listen idle utterance ignored!

            # 2. Explicit "Lancy listen" wakes idle mic cleanly
            stt.transcribe = AsyncMock(return_value=TranscriptResult(
                text='Lancy listen',
                raw_text='Lancy listen',
                confidence=0.94,
                avg_logprob=-0.20,
                no_speech_prob=0.04,
                is_wake=True,
                is_listen_command=True,
                low_confidence=False,
                duration_sec=0.9,
            ))
            listener.handle_incoming_frames('main', -100123, [f_loud, f_loud])
            st.buffers[11111].last_voice_mono = time.monotonic() - 1.0
            listener.handle_incoming_frames('main', -100123, [f_quiet])
            await asyncio.sleep(0.08)
            self.assertFalse(events.empty())
            ev = events.get_nowait()
            self.assertEqual(ev['type'], 'vc_voice_transcript')
            self.assertEqual(ev['sender_id'], 501)
            self.assertTrue(ev['is_listen_command'])

            # 3. Echo guard blocks idle tail, whereas strong active-session speech triggers barge-in
            listener.set_listening_window(-100123, active=False)
            listener.set_echo_guard(-100123, 1.5)
            listener.handle_incoming_frames('main', -100123, [f_loud])
            self.assertFalse(st.buffers[11111].in_speech)

            listener.set_listening_window(-100123, active=True, duration_sec=20.0, active_user_id=501)
            listener.set_echo_guard(-100123, 2.0)
            listener.handle_incoming_frames('main', -100123, [f_loud, f_loud, f_loud])
            self.assertTrue(st.buffers[11111].in_speech)  # barge-in interrupted TTS echo guard cleanly
            await listener.stop_all()

        asyncio.run(run())

    def test_bridge_speak_and_listen_endpoints(self):
        async def run():
            with tempfile.TemporaryDirectory() as tmp:
                bridge = bridge_main.Bridge(tmp, factory=lambda a, s: None)
                sync_id = f'bridge_tts_{int(time.time() * 1000)}'
                shm = av_sync.shm_path_for(sync_id)
                fd, mm, st = av_sync._open_sync_state(shm)
                try:
                    st.paused = 0
                    st.tts_hold = 0
                    bridge.calls[-100555] = {
                        'alias': 'main',
                        'status': 'playing',
                        'stream_mode': 'interactive',
                        'av_sync_id': sync_id,
                        'offset': 10.0,
                        'last_known_position': 10.0,
                    }
                    bridge.accounts['main'] = {'alias': 'main', 'engine': None, 'client': None, 'uid': 99}
                    bridge._call_elapsed_seconds = AsyncMock(return_value=12.0)

                    # Mock TTS synthesis so test stays offline and fast
                    bridge.tts.synthesize_pcm = AsyncMock(return_value=np.full(9600, 3000, dtype='<i2').tobytes())

                    res_listen = await bridge.set_listen_state({
                        'chat_id': -100555,
                        'mode': 'start',
                        'active': True,
                        'pause_media': True,
                        'active_user_id': 501,
                    })
                    self.assertTrue(res_listen['ok'])
                    self.assertEqual(st.paused, 1)
                    self.assertEqual(st.tts_hold, 1)
                    self.assertEqual(bridge.calls[-100555]['status'], 'paused')

                    res_speak = await bridge.speak_in_call({
                        'chat_id': -100555,
                        'text': 'Hi Pappy, you good?',
                        'speaker_name': 'Pappy',
                        'user_text': 'hey',
                        'lancy_text': 'Hi Pappy, you good?',
                        'hud_theme': 'neon_rose',
                    })
                    self.assertTrue(res_speak['ok'])
                    self.assertEqual(res_speak['mode'], 'av_sync_mix')
                    q_files = list(av_sync.tts_queue_dir_for(sync_id).glob('*.pcm'))
                    self.assertEqual(len(q_files), 1)
                    hud_path = av_sync.vchud_config_path_for(sync_id)
                    self.assertTrue(hud_path.is_file())
                    import json as _json
                    hud_data = _json.loads(hud_path.read_text(encoding='utf-8'))
                    self.assertEqual(hud_data['speaker_name'], 'Pappy')
                    self.assertEqual(hud_data['user_text'], 'hey')
                    self.assertEqual(hud_data['lancy_text'], 'Hi Pappy, you good?')

                    # Verify ASS generator & clean dialogue-only HUD (user text + Lancy response only, no top clock/status banner)
                    ass_bytes, chat_txt = av_sync._build_hud_ass_bytes(1280, 720, mode='vchud', pos_sec=42.0, vchud=hud_data)
                    ass_str = ass_bytes.decode('utf-8')
                    self.assertIn('Pappy:', ass_str)
                    self.assertIn('Hi Pappy, you good?', ass_str)
                    self.assertNotIn('HUDTop', ass_str)
                    self.assertNotIn('LANCY SPEAKING', ass_str)
                    self.assertNotIn('LANCY LISTENING', ass_str)

                    res_done = await bridge.set_listen_state({
                        'chat_id': -100555,
                        'mode': 'stop',
                        'active': False,
                        'resume_media': True,
                    })
                    self.assertTrue(res_done['ok'])
                    self.assertEqual(st.paused, 0)
                    self.assertEqual(st.tts_hold, 0)
                    self.assertEqual(bridge.calls[-100555]['status'], 'playing')
                    self.assertFalse(hud_path.exists())
                    await bridge.voice_listener.stop_all()
                finally:
                    del st
                    mm.close()
                    os.close(fd) if 'os' in globals() else None
                    shm.unlink(missing_ok=True)
                    for p in av_sync.tts_queue_dir_for(sync_id).glob('*'):
                        p.unlink(missing_ok=True)
                    if av_sync.tts_queue_dir_for(sync_id).exists():
                        av_sync.tts_queue_dir_for(sync_id).rmdir()

        import os
        asyncio.run(run())

    def test_music_freerun_flag_and_sync_monitor_bypass(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            bridge = bridge_main.Bridge(tmpdir, factory=lambda _s, _m: None)
            wrapped_a, wrapped_v = bridge_main.wrap_av_sync_pair(
                'ffmpeg -i a.mp3 -f s16le pipe:1',
                'ffmpeg -i bg.jpg -f rawvideo pipe:1',
                frame_bytes=1280 * 720 * 3 // 2,
                fps=20,
                sync_id='music-freerun-test',
                music_freerun=True,
            )
            self.assertIn('--music-freerun', wrapped_a)
            self.assertIn('--music-freerun', wrapped_v)

            call_music = {'status': 'playing', 'dj_desk': True, 'is_music': True, 'music_freerun': True}
            m_out, reason = bridge._evaluate_call_sync(
                -100999,
                call_music,
                metrics={'sync_health': 'drifted', 'skew_ms': -520, 'hb_age_sec': 0.1, 'sync_flags': 0, 'paused': False},
            )
            self.assertIsNone(reason)
            self.assertEqual(m_out['sync_health'], 'locked')
            self.assertEqual(m_out['skew_ms'], 0)
            self.assertEqual(call_music['_sync_mon']['skew_streak'], 0)

    def test_rtmp_keeps_voice_listener_and_skips_record_on_rtmp_stream_only(self):
        async def run():
            from types import SimpleNamespace
            from unittest.mock import AsyncMock
            with tempfile.TemporaryDirectory() as tmpdir:
                root = Path(tmpdir)
                track = root / 'song.mp3'
                track.write_bytes(b'fake')
                engine = SimpleNamespace(
                    play=AsyncMock(),
                    leave_call=AsyncMock(),
                    record=AsyncMock(),
                    get_participants=AsyncMock(return_value=[]),
                    _binding=SimpleNamespace(get_state=AsyncMock(return_value=None)),
                )
                client = SimpleNamespace(
                    get_me=AsyncMock(return_value=SimpleNamespace(id=12345, is_bot=False)),
                    get_chat=AsyncMock(return_value=SimpleNamespace(id=-100888)),
                    resolve_peer=AsyncMock(return_value=SimpleNamespace(channel_id=999, access_hash=1)),
                )
                async def fake_factory(_alias, _sess):
                    return client, engine, 12345
                bridge = bridge_main.Bridge(root, factory=fake_factory)
                await bridge.register({'alias': 'a1', 'session': 'sess', 'enabled': True, 'allowed': ['-100888'], 'managed_destinations': [-100888]})
                bridge.native_call = AsyncMock(return_value=(SimpleNamespace(), SimpleNamespace(id=77, access_hash=88, rtmp_stream=True)))
                bridge._get_group_call_is_rtmp = AsyncMock(return_value=True)
                bridge._fetch_rtmp_ingest = AsyncMock(return_value=('rtmps://example/live/key', 'rtmps://example/live/', 'key'))
                bridge._stream_rtmp = AsyncMock()
                bridge.ensure_call_settings = AsyncMock()
                bridge.resolve_call_invite_link = AsyncMock(return_value=None)
                res = await bridge.play({
                    'chat_id': -100888,
                    'playback_id': 'pb-rtmp-1',
                    'stream_url': str(track),
                    'stream_mode': 'rtmp',
                    'is_music': True,
                    'voice_ai_enabled': True,
                })
                self.assertTrue(res['ok'])
                self.assertEqual(res['stream_mode'], 'rtmp')
                self.assertIn(-100888, bridge.voice_listener.states)
                # Exercise non-factory _attach_record guard against rtmp_stream=True
                bridge.factory = None
                st = bridge.voice_listener.states[-100888]
                st.recording_started = False
                await bridge.voice_listener._attach_record(-100888, 'a1', st)
                self.assertFalse(st.recording_started)
                engine.record.assert_not_awaited()
                await bridge.voice_listener.stop_all()

        asyncio.run(run())

    def test_ambient_filler_persona_switch_cooldown_and_native_call_cache(self):
        import gemini_live
        import voice_listener
        from types import SimpleNamespace
        from unittest.mock import AsyncMock, patch
        from pyrogram import raw
        from pyrogram.errors import FloodWait

        self.assertTrue(gemini_live.is_ambient_filler_utterance('Omo.'))
        self.assertTrue(gemini_live.is_ambient_filler_utterance('Oh.'))
        self.assertTrue(gemini_live.is_ambient_filler_utterance('Hmm...'))
        self.assertFalse(gemini_live.is_ambient_filler_utterance('Hey Pappy'))
        self.assertFalse(gemini_live.is_ambient_filler_utterance('Yes'))
        self.assertFalse(gemini_live.is_ambient_filler_utterance('Play Burna Boy'))
        self.assertFalse(gemini_live.is_ambient_filler_utterance('What song is this?'))

        async def run():
            with tempfile.TemporaryDirectory() as tmpdir:
                root = Path(tmpdir)
                engine = SimpleNamespace(
                    play=AsyncMock(),
                    leave_call=AsyncMock(),
                    record=AsyncMock(),
                    resume=AsyncMock(),
                    get_participants=AsyncMock(return_value=[]),
                    _binding=SimpleNamespace(get_state=AsyncMock(return_value=None)),
                )
                bridge = bridge_main.Bridge(root, factory=None)
                bridge.calls[-100777] = {'alias': 'a1', 'status': 'playing', 'av_sync_id': 'sync-x'}
                bridge.accounts['a1'] = {'alias': 'a1', 'engine': engine, 'client': None, 'leases': set()}
                mgr = bridge.voice_listener
                st = voice_listener.ChatListenState(chat_id=-100777, alias='a1', use_live_mode=True)
                mgr.states[-100777] = st

                captured = {}

                class FakePersonaSess:
                    def __init__(self, **kwargs):
                        self.persona_id = kwargs['persona_id']
                        self.connected = True
                        self.closed = False
                        self.active_speaker_id = 11
                        self.active_speaker_name = 'Yuki'
                        self.send_tool_response = AsyncMock()
                        self.send_text_turn = AsyncMock()
                        self.send_context_update = AsyncMock()
                        self.close = AsyncMock()
                        captured[self.persona_id] = kwargs

                    async def connect(self, **_kwargs):
                        self.connected = True
                        return True

                with patch('gemini_live.GeminiLiveSession', FakePersonaSess), patch('av_sync.tts_queue_dir_for', return_value=root):
                    await mgr._start_live_session(-100777, st)
                    # Simulate Pappy invoking switch_persona -> Nana, then Nana trying to bounce back within cooldown
                    pappy_sess = st.persona_sessions['pappy']
                    await captured['pappy']['on_tool_call']([{
                        'id': 'tc-1',
                        'name': 'switch_persona',
                        'args': {'name': 'Nana', 'handoff_text': 'Hey Nana'},
                    }], pappy_sess)
                    self.assertEqual(st.active_persona, 'nana')
                    nana_sess = st.persona_sessions['nana']
                    # Inactive persona (pappy) PCM chunks must be dropped immediately
                    await captured['pappy']['on_pcm_48k_stereo'](b'\x01\x00' * 4000)
                    self.assertEqual(list(root.glob('*.pcm')), [])

                    # Immediate bounce back by Nana within 4s cooldown must be ignored
                    await captured['nana']['on_tool_call']([{
                        'id': 'tc-2',
                        'name': 'switch_persona',
                        'args': {'name': 'Pappy', 'handoff_text': 'back'},
                    }], nana_sess)
                    self.assertEqual(st.active_persona, 'nana')
                    nana_sess.send_tool_response.assert_awaited()
                    self.assertEqual(nana_sess.send_tool_response.await_args.args[2]['status'], 'ignored')

                    # finish_conversation clears live_engaged_until_mono to 0.0
                    await captured['nana']['on_tool_call']([{
                        'id': 'tc-3',
                        'name': 'finish_conversation',
                        'args': {'resumePlayback': True},
                    }], nana_sess)
                    self.assertEqual(st.live_engaged_until_mono, 0.0)

                # native_call 3s cache + FloodWait fallback prevents GetFullChannel storms
                invocations = []

                class FakeClient:
                    async def resolve_peer(self, _chat):
                        return raw.types.InputPeerChannel(channel_id=12345, access_hash=67890)

                    async def invoke(self, req, sleep_threshold=0):
                        invocations.append((type(req).__name__, sleep_threshold))
                        return SimpleNamespace(full_chat=SimpleNamespace(call=SimpleNamespace(id=555, access_hash=777)))

                cli = FakeClient()
                p1, c1 = await bridge.native_call(cli, -100777)
                p2, c2 = await bridge.native_call(cli, -100777)
                self.assertEqual(c1.id, 555)
                self.assertEqual(c2.id, 555)
                self.assertEqual(len(invocations), 1, 'Second native_call within 3s must hit cache')

                # After invalidation, FloodWait returns stale cached result and sets backoff without hammering
                bridge._invalidate_native_call_cache(cli, -100777)
                # Seed stale entry cleanly then fail with FloodWait
                _, _ = await bridge.native_call(cli, -100777)
                bridge._native_call_cache[bridge._native_call_cache_key(cli, -100777)] = (
                    bridge_main.time.monotonic() - 5.0,
                    p1,
                    SimpleNamespace(id=555, access_hash=777),
                )

                async def raise_flood(_req, sleep_threshold=0):
                    invocations.append(('FloodWait', sleep_threshold))
                    raise FloodWait(10)

                cli.invoke = raise_flood
                _, c_stale = await bridge.native_call(cli, -100777)
                self.assertEqual(c_stale.id, 555)
                count_after_flood = len(invocations)
                _, c_backoff = await bridge.native_call(cli, -100777)
                self.assertEqual(c_backoff.id, 555)
                self.assertEqual(len(invocations), count_after_flood, 'Active FloodWait backoff must not hit invoke again')

                # refresh_participants uses native_call GetGroupParticipants directly (no engine.get_participants / GetFullChannel) and throttles 30s
                direct_calls = []

                class FakeDirectClient:
                    async def invoke(self, req, sleep_threshold=0):
                        direct_calls.append((type(req).__name__, sleep_threshold))
                        return SimpleNamespace(
                            participants=[SimpleNamespace(peer=SimpleNamespace(user_id=991), source=4242)],
                            users=[SimpleNamespace(id=991, first_name='PappyFan', last_name='', username='pf')],
                        )

                bridge.calls[-100777]['native_call'] = SimpleNamespace(id=555, access_hash=777)
                bridge.accounts['a1']['client'] = FakeDirectClient()
                st.last_part_refresh_mono = 0.0
                st.part_refresh_backoff_until = 0.0
                mapping = await mgr.refresh_participants(-100777)
                self.assertEqual(mapping.get(4242), 991)
                self.assertEqual(st.uid_to_name.get(991), 'PappyFan')
                self.assertEqual(len(direct_calls), 1)
                self.assertEqual(direct_calls[0], ('GetGroupParticipants', 0))
                engine.get_participants.assert_not_awaited()
                # Immediate second call within 30s must be throttled
                await mgr.refresh_participants(-100777)
                self.assertEqual(len(direct_calls), 1)

                # _close_dropped_call must still remove the dead call & stop voice_listener even if leave_call hits FloodWait
                engine.leave_call = AsyncMock(side_effect=FloodWait(10))
                bridge.calls[-100777] = {'alias': 'a1', 'status': 'playing', 'stream_mode': 'interactive', 'playback_id': 'pb-z'}
                await bridge._close_dropped_call(bridge.accounts['a1'], -100777, bridge.calls[-100777], reason='NO_ACTIVE_CALL', ignore_leave_error=False)
                self.assertNotIn(-100777, bridge.calls)
                self.assertNotIn(-100777, mgr.states)

                await mgr.stop_all()

        asyncio.run(run())


if __name__ == '__main__':
    unittest.main()
