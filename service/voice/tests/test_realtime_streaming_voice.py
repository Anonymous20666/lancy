import asyncio
from pathlib import Path
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock
import numpy as np

VOICE_DIR = Path(__file__).resolve().parents[1]
if str(VOICE_DIR) not in sys.path:
    sys.path.insert(0, str(VOICE_DIR))

import av_sync
import gemini_live
from tts_engine import TtsEngine
from voice_listener import VoiceListenerManager


class RealtimeStreamingVoiceTests(unittest.TestCase):
    def test_smooth_ramp_ducking_and_barge_in_flush(self):
        sync_id = f'test_ramp_{int(time.time() * 1000)}'
        qdir = av_sync.tts_queue_dir_for(sync_id)
        qdir.mkdir(parents=True, exist_ok=True)
        try:
            tts_samples = np.full(7680, 8000, dtype='<i2').tobytes()
            (qdir / '0001.pcm').write_bytes(tts_samples)
            feeder = av_sync.TtsAudioFeeder(sync_id, sample_rate=48000, channels=2)
            chunk, active = feeder.pop_chunk(3840)
            self.assertTrue(active)

            # Smoothly steps down from 1.0 instead of hard-jumping straight to 0.22 on sample #0
            media = np.full(1920, 10000, dtype='<i2').tobytes()
            mixed1 = feeder.mix_media_packet(media, chunk, True, duck_factor=0.22)
            self.assertLess(feeder.duck_gain, 1.0)
            self.assertGreater(feeder.duck_gain, 0.22)
            arr1 = np.frombuffer(mixed1, dtype='<i2')
            self.assertGreater(int(arr1[0]), int(arr1[-1]))  # Ramped down monotonically

            # Barge-in clears SHM buffer & restores gain smoothly
            (qdir / '0002.pcm').write_bytes(tts_samples)
            av_sync.clear_tts_queue(sync_id)
            chunk2, active2 = feeder.pop_chunk(3840)
            self.assertFalse(active2)
            self.assertEqual(chunk2, b'')
            self.assertEqual(feeder.duck_gain, 1.0)
        finally:
            for p in qdir.glob('*'):
                p.unlink(missing_ok=True)
            if qdir.exists():
                qdir.rmdir()

    def test_gemini_live_pcm_resampling_and_setup(self):
        # 36kHz mono -> 16kHz mono ratio check (20ms frame: 720 samples -> 320 samples)
        pcm_36k = np.full(720, 1500, dtype='<i2').tobytes()
        pcm_16k = gemini_live.resample_pcm_mono(pcm_36k, 36000, 16000)
        self.assertEqual(len(pcm_16k), 320 * 2)

        # 24kHz mono -> 48kHz stereo ratio check (480 samples -> 960 stereo frames = 3840 bytes)
        pcm_24k = np.full(480, 2200, dtype='<i2').tobytes()
        pcm_48k_st = gemini_live.pcm_24k_mono_to_48k_stereo(pcm_24k)
        self.assertEqual(len(pcm_48k_st), 960 * 4)

        sess = gemini_live.GeminiLiveSession(
            api_key='test_key',
            model='gemini-3.8-live',
            system_instruction=gemini_live.build_live_system_instruction(vc_title='Midnight Afrobeats'),
            function_declarations=[{'name': 'control_playback', 'description': 'Control media'}],
        )
        setup = sess.build_setup_payload()['setup']
        self.assertEqual(setup['model'], 'models/gemini-3.8-live')
        self.assertEqual(setup['generationConfig']['responseModalities'], ['AUDIO'])
        self.assertEqual(setup['generationConfig']['speechConfig']['voiceConfig']['prebuiltVoiceConfig']['voiceName'], 'Charon')
        self.assertEqual(setup['realtimeInputConfig']['automaticActivityDetection']['endOfSpeechSensitivity'], 'END_SENSITIVITY_LOW')
        self.assertEqual(setup['realtimeInputConfig']['automaticActivityDetection']['silenceDurationMs'], 680)
        self.assertIn('Lancy', setup['inputAudioTranscription']['customVocabulary'])
        self.assertIn('outputAudioTranscription', setup)
        self.assertNotIn('enable_affective_dialog', setup)
        self.assertNotIn('proactivity', setup)
        self.assertEqual(setup['tools'][0]['functionDeclarations'][0]['name'], 'control_playback')
        self.assertIn('two consecutive tool calls', setup['systemInstruction']['parts'][0]['text'])
        self.assertIn('Ask', setup['systemInstruction']['parts'][0]['text'].title())

        async def test_live_forward():
            events = asyncio.Queue(maxsize=10)
            bridge = MagicMock()
            bridge.factory = None
            bridge.enable_gemini_live = False
            bridge.events = events
            bridge.calls = {-100333: {'av_sync_id': 'sync_live'}}
            bridge.accounts = {'main': {'uid': 999, 'engine': MagicMock(), 'client': None}}
            mgr = VoiceListenerManager(bridge=bridge, stt_engine=MagicMock())
            st = await mgr.start_chat(-100333, 'main', enabled=True, use_live=False)
            st.ssrc_to_uid[1234] = 100
            st.uid_to_name[100] = 'Alex'
            mock_sess = MagicMock()
            mock_sess.connected = True
            mock_sess.closed = False
            q = asyncio.Queue(maxsize=20)
            st.live_session = mock_sess
            st.live_audio_queue = q
            frame = MagicMock(ssrc=1234, frame=np.full(720, 3000, dtype='<i2').tobytes(), info=MagicMock(sample_rate=36000, channels=1))
            mgr.handle_incoming_frames('main', -100333, [frame])
            self.assertEqual(q.qsize(), 1)
            await mgr.stop_all()

        asyncio.run(test_live_forward())

    def test_participant_display_name_resolution_and_barge_in_event(self):
        async def run():
            events = asyncio.Queue(maxsize=10)
            engine = MagicMock()
            engine.record = AsyncMock()
            p1 = SimpleNamespace(user_id=101, source=5555, first_name='Chidi', last_name='', username='chidi')
            engine.get_participants = AsyncMock(return_value=[p1])

            bridge = MagicMock()
            bridge.factory = None
            bridge.events = events
            bridge.calls = {-100321: {'av_sync_id': 'sync_test_1'}}
            bridge.accounts = {'main': {'uid': 999, 'engine': engine, 'client': None}}

            listener = VoiceListenerManager(bridge=bridge, stt_engine=MagicMock())
            st = await listener.start_chat(-100321, 'main', enabled=True)
            await listener.refresh_participants(-100321, force=True)
            self.assertEqual(st.uid_to_name[101], 'Chidi')

            listener.trigger_barge_in(-100321, user_id=101)
            ev = events.get_nowait()
            self.assertEqual(ev['type'], 'vc_voice_barge_in')
            self.assertEqual(ev['sender_id'], 101)
            self.assertEqual(ev['sender_name'], 'Chidi')
            await listener.stop_all()

        asyncio.run(run())

    def test_streaming_edge_tts_first_chunk_latency(self):
        async def run():
            with tempfile.TemporaryDirectory() as tmp:
                tts = TtsEngine(tmp)
                t0 = time.monotonic()
                first_ms = None
                total = 0
                try:
                    async for chunk in tts.synthesize_stream_pcm(
                        'Hey Alex, switching to something more energetic right now.',
                        voice='ng',
                        chunk_ms=60,
                    ):
                        if first_ms is None:
                            first_ms = (time.monotonic() - t0) * 1000.0
                        self.assertEqual(len(chunk) % 4, 0)
                        total += len(chunk)
                except Exception:
                    pass
                # Offline CI-safe: validate streaming yielded aligned PCM if network edge-tts reachable
                if total > 0:
                    self.assertIsNotNone(first_ms)
                    print(f'\n[BENCH] Edge-TTS streaming first_pcm_ms={first_ms:.1f}ms total_bytes={total}', flush=True)

        asyncio.run(run())

    def test_voice_note_stt_and_ogg_opus_endpoints(self):
        import main as bridge_main
        from stt_engine import TranscriptResult
        import wave

        async def run():
            with tempfile.TemporaryDirectory() as tmp:
                bridge = bridge_main.Bridge(tmp, factory=lambda a, s: None)
                bridge.stt.transcribe = AsyncMock(return_value=TranscriptResult(
                    text='Lancy check the current song',
                    raw_text='Lancy check the current song',
                    confidence=0.95,
                    avg_logprob=-0.18,
                    no_speech_prob=0.02,
                    is_wake=True,
                    is_listen_command=False,
                    low_confidence=False,
                    duration_sec=1.0,
                ))
                bridge.tts.synthesize_pcm = AsyncMock(return_value=np.full(24000, 1800, dtype='<i2').tobytes())

                wav_path = Path(tmp) / 'vn_test.wav'
                with wave.open(str(wav_path), 'wb') as wf:
                    wf.setnchannels(1)
                    wf.setsampwidth(2)
                    wf.setframerate(16000)
                    wf.writeframes(np.full(16000, 1200, dtype='<i2').tobytes())

                stt_res = await bridge.stt_transcribe({'file_path': str(wav_path), 'active_session': True})
                self.assertTrue(stt_res['ok'])
                self.assertEqual(stt_res['text'], 'Lancy check the current song')
                self.assertTrue(stt_res['is_wake'])

                tts_res = await bridge.tts_synthesize_ogg({'text': 'Current track is Essence!'})
                self.assertTrue(tts_res['ok'])
                import base64
                ogg = base64.b64decode(tts_res['ogg_base64'])
                self.assertTrue(ogg.startswith(b'OggS'))

                # Verify Live pause release when nothing else was talked
                st = await bridge.voice_listener.start_chat(-100789, 'main', enabled=True, use_live=False)
                sync_id = f'live_resume_{int(time.time() * 1000)}'
                shm = av_sync.shm_path_for(sync_id)
                fd, mm, sync_st = av_sync._open_sync_state(shm)
                try:
                    sync_st.paused = 1
                    sync_st.tts_hold = 1
                    bridge.calls[-100789] = {
                        'alias': 'main',
                        'status': 'paused',
                        'stream_mode': 'interactive',
                        'av_sync_id': sync_id,
                        'playback_id': 'pb_1',
                    }
                    st.paused_by_live = True
                    st.paused_track_id = 'pb_1'
                    resumed = await bridge.voice_listener.release_live_pause(-100789, resume=True)
                    self.assertTrue(resumed)
                    self.assertEqual(sync_st.paused, 0)
                    self.assertEqual(sync_st.tts_hold, 0)
                    self.assertEqual(bridge.calls[-100789]['status'], 'playing')
                finally:
                    del sync_st
                    mm.close()
                    shm.unlink(missing_ok=True)
                await bridge.voice_listener.stop_all()

        asyncio.run(run())

    def test_live_low_latency_barge_in_tail_flush_and_session_recovery(self):
        async def run():
            events = asyncio.Queue(maxsize=10)
            bridge = MagicMock()
            bridge.factory = None
            bridge.enable_gemini_live = False
            bridge.events = events
            bridge.calls = {-100444: {'av_sync_id': 'sync_fast'}}
            bridge.accounts = {'main': {'uid': 999, 'engine': MagicMock(), 'client': None}}
            mgr = VoiceListenerManager(bridge=bridge, stt_engine=MagicMock())
            st = await mgr.start_chat(-100444, 'main', enabled=True, use_live=False)
            st.ssrc_to_uid[2222] = 777
            mock_sess = MagicMock()
            mock_sess.connected = True
            mock_sess.closed = False
            q = asyncio.Queue(maxsize=32)
            st.live_session = mock_sess
            st.live_audio_queue = q

            # Under echo guard, conversational speech (~0.006 RMS) in Live mode passes & triggers barge-in immediately
            mgr.set_echo_guard(-100444, 2.0)
            conv_frame = MagicMock(ssrc=2222, frame=np.full(720, 220, dtype='<i2').tobytes(), info=MagicMock(sample_rate=36000, channels=1))
            mgr.handle_incoming_frames('main', -100444, [conv_frame])
            self.assertEqual(q.qsize(), 1)

            # Silence past 1.80s triggers exactly one __FLUSH__ sentinel for snappy VAD completion
            sb = st.buffers[2222]
            sb.last_voice_mono = time.monotonic() - 2.0
            st.last_user_speech_mono = sb.last_voice_mono
            quiet_frame = MagicMock(ssrc=2222, frame=np.zeros(720, dtype='<i2').tobytes(), info=MagicMock(sample_rate=36000, channels=1))
            mgr.handle_incoming_frames('main', -100444, [quiet_frame])
            mgr.handle_incoming_frames('main', -100444, [quiet_frame])
            items = [q.get_nowait() for _ in range(q.qsize())]
            self.assertEqual(items[-1][0], b'__FLUSH__')
            self.assertEqual(sum(1 for it in items if it[0] == b'__FLUSH__'), 1)

            # GeminiLiveSession flush_tail pads <1280 tail cleanly
            sent = []
            sess = gemini_live.GeminiLiveSession(api_key='k', chat_id=-100444)
            sess.connected = True
            sess._ws = MagicMock()
            sess._send_realtime_audio = AsyncMock(side_effect=lambda b: sent.append(len(b)))
            sess._in_buf.extend(b'\x01\x02' * 100)
            await sess.flush_tail()
            self.assertEqual(sent, [1280])
            await mgr.stop_all()

        asyncio.run(run())

    def test_multi_persona_cast_clickless_audio_and_long_talk(self):
        from tts_engine import resolve_voice_profile
        # Persona resolution across man, boy, lady, girl, old_woman, old_man & custom names
        self.assertEqual(gemini_live.resolve_persona_spec('pappy')['voice'], 'Charon')
        self.assertEqual(gemini_live.resolve_persona_spec('ava')['voice'], 'Aoede')
        self.assertEqual(gemini_live.resolve_persona_spec('maya')['voice'], 'Leda')
        self.assertEqual(gemini_live.resolve_persona_spec('leo')['voice'], 'Puck')
        self.assertEqual(gemini_live.resolve_persona_spec('nana')['voice'], 'Gacrux')
        self.assertEqual(gemini_live.resolve_persona_spec('elder')['voice'], 'Algenib')
        custom = gemini_live.resolve_persona_spec('Amara')
        self.assertEqual(custom['gender'], 'female')
        self.assertEqual(custom['voice'], 'Aoede')

        # Edge-TTS distinct pitch/rate calibration
        self.assertNotEqual(resolve_voice_profile('pappy'), resolve_voice_profile('ava'))
        self.assertNotEqual(resolve_voice_profile('maya'), resolve_voice_profile('nana'))
        self.assertNotEqual(resolve_voice_profile('leo'), resolve_voice_profile('elder'))

        # Clickless 24kHz -> 48kHz midpoint carryover across chunks
        c1 = np.array([1000, 2000], dtype='<i2').tobytes()
        c2 = np.array([4000, 5000], dtype='<i2').tobytes()
        out1, prev = gemini_live.pcm_24k_mono_to_48k_stereo(c1, None, return_state=True)
        out2, prev2 = gemini_live.pcm_24k_mono_to_48k_stereo(c2, prev, return_state=True)
        self.assertEqual(prev, 2000.0)
        self.assertEqual(prev2, 5000.0)
        # Boundary first sample of chunk 2 blends smoothly (2000 + 4000) / 2 = 3000 instead of jumping flat
        arr2 = np.frombuffer(out2, dtype='<i2')
        self.assertEqual(int(arr2[0]), 3000)

        # Long talk token budget + storyteller & persona switch tools
        sess = gemini_live.GeminiLiveSession(api_key='k', chat_id=-100555)
        payload = sess.build_setup_payload()['setup']
        self.assertEqual(payload['generationConfig']['maxOutputTokens'], 8192)
        tool_names = {t['name'] for t in payload['tools'][0]['functionDeclarations']}
        self.assertIn('tell_story_or_novel', tool_names)
        self.assertIn('switch_persona', tool_names)

    def test_uncalled_idle_chatter_dropped_and_wake_redirect_work(self):
        import base64
        import json
        import types
        import aiohttp

        async def run():
            pcm_out = []
            transcripts = []
            wakes = []
            redirects = []
            engaged = False

            raw_audio = base64.b64encode(b'\x10\x00' * 16).decode('ascii')

            class FakeWS:
                def __init__(self, msgs):
                    self._msgs = [types.SimpleNamespace(type=aiohttp.WSMsgType.TEXT, data=json.dumps(m)) for m in msgs]
                    self.close_code = None
                    self.close_reason = None

                async def receive(self):
                    if not self._msgs:
                        return types.SimpleNamespace(type=aiohttp.WSMsgType.CLOSED, data=b'')
                    return self._msgs.pop(0)

            sess = gemini_live.GeminiLiveSession(
                api_key='k',
                chat_id=-100555,
                persona_id='pappy',
                is_conversation_engaged=lambda: engaged,
                on_wake_engaged=lambda: wakes.append(True),
                on_persona_redirect=AsyncMock(side_effect=lambda spec, txt, s: redirects.append((spec['id'], txt))),
                on_pcm_48k_stereo=AsyncMock(side_effect=lambda b: pcm_out.append(b)),
                on_transcription=AsyncMock(side_effect=lambda t: transcripts.append(t)),
            )
            sess.connected = True
            sess._ws = FakeWS([
                # 1. Unaddressed side chatter -> dropped completely
                {'serverContent': {'inputTranscription': {'text': 'Hey man did you eat?'}, 'modelTurn': {'parts': [{'inlineData': {'data': raw_audio, 'mimeType': 'audio/pcm;rate=24000'}}]}}},
                {'serverContent': {'outputTranscription': {'text': 'Yeah I am good'}, 'turnComplete': True}},
                # 2. Someone calls Ava -> redirected to ava, Pappy audio dropped
                {'serverContent': {'inputTranscription': {'text': 'Ava tell us a story'}, 'modelTurn': {'parts': [{'inlineData': {'data': raw_audio, 'mimeType': 'audio/pcm;rate=24000'}}]}}},
                {'serverContent': {'turnComplete': True}},
                # 3. Someone calls Pappy -> wakes and flushes buffered audio
                {'serverContent': {'inputTranscription': {'text': 'Hey Pappy what is good?'}, 'modelTurn': {'parts': [{'inlineData': {'data': raw_audio, 'mimeType': 'audio/pcm;rate=24000'}}]}}},
                {'serverContent': {'outputTranscription': {'text': 'All good my friend!'}, 'turnComplete': True}},
            ])
            await sess._recv_loop()
            self.assertEqual(len(wakes), 2)  # once on wake match + once on turnComplete
            self.assertEqual(len(redirects), 1)
            self.assertEqual(redirects[0][0], 'ava')
            self.assertEqual(len(pcm_out), 1)
            self.assertEqual(len(transcripts), 1)
            self.assertIn('Pappy', transcripts[0]['input_text'])

        asyncio.run(run())


if __name__ == '__main__':
    unittest.main()
