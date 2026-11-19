import asyncio
from pathlib import Path
import tempfile
import time
import unittest

import numpy as np

import sys
VOICE_DIR = Path(__file__).resolve().parents[1]
if str(VOICE_DIR) not in sys.path:
    sys.path.insert(0, str(VOICE_DIR))

import voice_listener
import stt_engine
import main as voice_main


class FakeBridge:
    def __init__(self):
        self.factory = True
        self.accounts = {'player_one': {'uid': 999, 'engine': None}}
        self.calls = {-1001: {'vc_title': 'Alchemy of Souls'}}
        self.events = asyncio.Queue(maxsize=50)


class FakeStt:
    def __init__(self, script):
        self.script = list(script)
        self.calls = []

    async def transcribe(self, pcm_bytes, *, sample_rate=36000, channels=1, context_hint='', active_session=False):
        self.calls.append({'len': len(pcm_bytes), 'active': active_session})
        idx = min(len(self.calls) - 1, len(self.script) - 1)
        txt = self.script[idx]
        return stt_engine.TranscriptResult(
            text=txt,
            raw_text=txt,
            confidence=0.92,
            avg_logprob=-0.22,
            no_speech_prob=0.05,
            is_wake=('lancy' in txt.lower()),
            is_listen_command=('lancy listen' in txt.lower()),
            low_confidence=False,
            duration_sec=1.2,
        )


class TurnEndAndAudioLangTests(unittest.IsolatedAsyncioTestCase):
    def test_incomplete_turn_heuristic(self):
        self.assertTrue(voice_listener.is_incomplete_turn('lower the'))
        self.assertTrue(voice_listener.is_incomplete_turn('play Alchemy of Souls and'))
        self.assertTrue(voice_listener.is_incomplete_turn('search for'))
        self.assertTrue(voice_listener.is_incomplete_turn('um'))
        self.assertFalse(voice_listener.is_incomplete_turn('Lancy listen'))
        self.assertFalse(voice_listener.is_incomplete_turn('pause'))
        self.assertFalse(voice_listener.is_incomplete_turn('lower the volume to 40 and skip'))

    async def test_pending_turn_merges_pauses_before_emitting(self):
        bridge = FakeBridge()
        stt = FakeStt(['lower the', 'lower the volume to forty'])
        mgr = voice_listener.VoiceListenerManager(bridge=bridge, stt_engine=stt)
        st = await mgr.start_chat(-1001, 'player_one', enabled=True)
        st.ssrc_to_uid[1234] = 555
        st.active_until_mono = time.monotonic() + 25.0

        pcm = (np.ones(16000, dtype=np.int16) * 1000).tobytes()
        # First chunk ("lower the") looks incomplete -> held in PendingTurnBuffer, nothing emitted yet
        await mgr._process_utterance(st, 1234, pcm, 16000, 1)
        self.assertEqual(bridge.events.qsize(), 0)
        self.assertIn(1234, st.pending_turns)

        # Second chunk completes the thought -> merged transcript emitted cleanly with merged_segments=2
        await mgr._process_utterance(st, 1234, pcm, 16000, 1)
        self.assertEqual(bridge.events.qsize(), 1)
        ev = await bridge.events.get()
        self.assertEqual(ev['text'], 'lower the volume to forty')
        self.assertEqual(ev['merged_segments'], 2)
        self.assertNotIn(1234, st.pending_turns)

        await mgr.stop_all()

    async def test_stt_beam_size_scales_when_active(self):
        with tempfile.TemporaryDirectory() as tmp:
            eng = stt_engine.SttEngine(cache_dir=tmp)
            recorded = []

            class DummyModel:
                def transcribe(self, audio, **kwargs):
                    recorded.append(kwargs.get('beam_size'))
                    class Seg:
                        text = 'pause now'
                        avg_logprob = -0.2
                        no_speech_prob = 0.05
                        compression_ratio = 1.0
                    return [Seg()], None

            eng._model = DummyModel()
            pcm = (np.ones(16000, dtype=np.int16) * 2000).tobytes()
            eng.transcribe_sync(pcm, sample_rate=16000, channels=1, active_session=False)
            eng.transcribe_sync(pcm, sample_rate=16000, channels=1, active_session=True)
            self.assertEqual(recorded, [1, 2])

    async def test_verify_audio_language_rejects_invalid_and_uses_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            b = voice_main.Bridge(tmp)
            with self.assertRaises(voice_main.VoiceFailure):
                await b.verify_audio_language({'url': 'ftp://bad.local/x.mp4'})
            b._audio_lang_cache['https://example.test/a.m3u8'] = (
                time.monotonic(),
                {'ok': True, 'language': 'en', 'probability': 0.96, 'speech_detected': True, 'sample_text': 'hello'},
            )
            cached = await b.verify_audio_language({'url': 'https://example.test/a.m3u8'})
            self.assertEqual(cached['language'], 'en')
            self.assertTrue(cached['speech_detected'])

    async def test_extract_hls_audio_sample_follows_master_map_and_offset(self):
        with tempfile.TemporaryDirectory() as tmp:
            b = voice_main.Bridge(tmp)
            fetched = []

            async def fake_fetch(url, headers=None, timeout_sec=6.0):
                fetched.append(url)
                if url.endswith('master.m3u8'):
                    return (
                        b'#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Audio",DEFAULT=YES,URI="aud.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=500000\nv0.m3u8\n',
                        url,
                    )
                if url.endswith('aud.m3u8'):
                    segs = '\n'.join(f'#EXTINF:10.0,\nseg_{i}.m4s' for i in range(12))
                    return (b'#EXTM3U\n#EXT-X-MAP:URI="init.m4s"\n' + segs.encode(), url)
                if url.endswith('init.m4s'):
                    return b'INIT', url
                return url.rsplit('/', 1)[-1].encode(), url

            b._fetch_bytes_with_fallback = fake_fetch
            sample = await b._extract_hls_audio_sample_bytes('https://cdn.test/master.m3u8', offset_sec=75)
            self.assertIsNotNone(sample)
            self.assertTrue(sample.startswith(b'INITseg_8.m4s'))
            self.assertIn('https://cdn.test/aud.m3u8', fetched)


if __name__ == '__main__':
    unittest.main()
