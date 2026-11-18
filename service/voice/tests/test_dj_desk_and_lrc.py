import json
import math
import tempfile
import unittest
from pathlib import Path
import sys

import numpy as np

VOICE_DIR = Path(__file__).resolve().parents[1]
if str(VOICE_DIR) not in sys.path:
    sys.path.insert(0, str(VOICE_DIR))

import av_sync
import dj_desk
import main as voice_main
import sub_align


class DjDeskAndLrcTests(unittest.TestCase):
    def test_lrc_parsing_and_ass_karaoke_generation(self):
        lrc_raw = (
            "[ar:Juice WRLD]\n"
            "[offset:250]\n"
            "[00:02.00][00:20.00]I still see your shadows in my room\n"
            "[00:06.50]Can't take back the love that I gave you\n"
        )
        cues = sub_align.parse_lrc_cues(lrc_raw)
        self.assertEqual(len(cues), 3)
        self.assertEqual(cues[0][0], 2250)
        self.assertEqual(cues[1][0], 6750)
        self.assertEqual(cues[2][0], 20250)

        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / 'song.lrc'
            p.write_text(lrc_raw, encoding='utf-8')
            ass_bytes, spans = sub_align.subtitles_to_ass(p, width=1280, height=720)
            ass_txt = ass_bytes.decode('utf-8')
            self.assertIn('Dialogue:', ass_txt)
            self.assertIn('▶ I still see your shadows in my room', ass_txt)
            self.assertEqual(len(spans), 3)

    def test_analyze_pcm_into_state_and_dj_desk_animation(self):
        with tempfile.TemporaryDirectory() as td:
            shm_p = Path(td) / 'test.shm'
            cfg_p = Path(td) / 'desk.json'
            cfg_p.write_text(json.dumps({
                'enabled': True,
                'duration_sec': 180.0,
                'crossfade_sec': 6.0,
                'base_sec': 0.0,
            }), encoding='utf-8')

            fd, mm, state = av_sync._open_sync_state(shm_p)
            try:
                # Generate 48kHz stereo PCM burst with 90Hz bass + 1.2kHz harmonic
                n_samples = 2048
                t = np.arange(n_samples, dtype=np.float32) / 48000.0
                mono = 0.55 * np.sin(2.0 * math.pi * 90.0 * t) + 0.30 * np.sin(2.0 * math.pi * 1200.0 * t)
                stereo = np.empty(n_samples * 2, dtype=np.int16)
                s16 = np.clip(mono * 32767.0, -32767, 32767).astype(np.int16)
                stereo[0::2] = s16
                stereo[1::2] = s16
                dj_desk.analyze_pcm_into_state(stereo.tobytes(), state, 48000, 2)
                self.assertGreater(int(state.bass_pulse), 10)
                self.assertTrue(any(int(state.eq_bands[i]) > 10 for i in range(16)))

                w, h = 640, 360
                frame_bytes = w * h * 3 // 2
                base_frame = bytes([24] * (w * h) + [128] * (frame_bytes - (w * h)))
                ov = dj_desk.DjDeskOverlay(cfg_p, state, w, h, frame_bytes)

                out_early = ov.render(base_frame, 10.0)
                out_crossfade = ov.render(base_frame, 177.5)
                self.assertEqual(len(out_early), frame_bytes)
                self.assertEqual(len(out_crossfade), frame_bytes)
                self.assertNotEqual(out_early, base_frame)
                self.assertNotEqual(out_early, out_crossfade)
                ov.state = None
                del ov
            finally:
                state = None
                mm.close()
                import os
                os.close(fd)

    def test_wrap_av_sync_pair_and_source_validators(self):
        wrapped_a, wrapped_v = voice_main.wrap_av_sync_pair(
            'ffmpeg -i in.mp3 -f s16le pipe:1',
            'ffmpeg -loop 1 -i img.png -f rawvideo pipe:1',
            frame_bytes=1280 * 720 * 3 // 2,
            fps=20,
            sync_id='djtest1',
            width=1280,
            height=720,
            sub_config_path='/tmp/s.json',
            dj_config_path='/tmp/d.json',
        )
        self.assertIn('--dj-config /tmp/d.json', wrapped_a)
        self.assertIn('--dj-config /tmp/d.json', wrapped_v)
        self.assertIn('--sub-config /tmp/s.json', wrapped_v)

        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            sub_f = root / 'lyrics.lrc'
            img_f = root / 'desk.png'
            sub_f.write_text('[00:01.00]Hi\n', encoding='utf-8')
            img_f.write_bytes(b'PNGDATA')
            b = voice_main.Bridge(str(root))
            self.assertEqual(b.source_subtitle(str(sub_f)), str(sub_f.resolve()))
            self.assertEqual(b.source_dj_image(str(img_f)), str(img_f.resolve()))


if __name__ == '__main__':
    unittest.main()
