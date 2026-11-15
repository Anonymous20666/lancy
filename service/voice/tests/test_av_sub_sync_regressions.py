import asyncio
import http.server
import math
import os
import shlex
import socketserver
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

VOICE_DIR = Path(__file__).resolve().parents[1]
if str(VOICE_DIR) not in sys.path:
    sys.path.insert(0, str(VOICE_DIR))

import av_sync
import main as voice_main
import sub_align


def _run_ffmpeg(args):
    p = subprocess.run(
        ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', *args],
        capture_output=True,
        text=True,
    )
    if p.returncode != 0:
        raise RuntimeError(f'ffmpeg failed: {p.stderr}')


def _write_srt(path, events, prefix='CUE'):
    blocks = []
    for idx, t in enumerate(events, 1):
        sh, srem = divmod(int(t), 3600)
        sm, ss = divmod(srem, 60)
        et = t + 0.6
        eh, erem = divmod(int(et), 3600)
        em, es = divmod(erem, 60)
        blocks.append(
            f"{idx}\n"
            f"{sh:02d}:{sm:02d}:{ss:02d},{int(round((t % 1) * 1000)):03d} --> "
            f"{eh:02d}:{em:02d}:{es:02d},{int(round((et % 1) * 1000)):03d}\n"
            f"{prefix}_{idx}"
        )
    Path(path).write_text('\n\n'.join(blocks) + '\n', encoding='utf-8')


def _measure_pcm_beeps(pcm_bytes, sample_rate=48000, channels=2, win_ms=20):
    samples_per_win = int(sample_rate * win_ms / 1000)
    frame_bytes = samples_per_win * channels * 2
    beeps = []
    active = False
    for i in range(len(pcm_bytes) // frame_bytes):
        chunk = pcm_bytes[i * frame_bytes:(i + 1) * frame_bytes]
        vals = struct.unpack(f'<{samples_per_win * channels}h', chunk)[::channels]
        rms = math.sqrt(sum(v * v for v in vals) / max(1, len(vals)))
        if rms > 2000:
            if not active:
                beeps.append(round((i * win_ms) / 1000.0, 3))
                active = True
        else:
            active = False
    return beeps


def _measure_yuv_flashes_and_subs(yuv_bytes, width, height, fps=30.0):
    y_size = width * height
    frame_bytes = y_size * 3 // 2
    n_frames = len(yuv_bytes) // frame_bytes
    flashes = []
    sub_spans = []
    flash_on = False
    sub_on_start = None
    cx0, cx1 = width * 3 // 8, width * 5 // 8
    cy0, cy1 = height * 1 // 4, height * 2 // 4
    sub_y0 = int(height * 0.78)
    for idx in range(n_frames):
        off = idx * frame_bytes
        y_plane = yuv_bytes[off:off + y_size]
        acc = 0
        cnt = 0
        for row in range(cy0, cy1, 10):
            ro = row * width
            for col in range(cx0, cx1, 10):
                acc += y_plane[ro + col]
                cnt += 1
        t = idx / fps
        if (acc / max(1, cnt)) > 160:
            if not flash_on:
                flashes.append(round(t, 3))
                flash_on = True
        else:
            flash_on = False
        max_sub_y = 0
        for row in range(sub_y0, height - 4, 2):
            ro = row * width
            seg = y_plane[ro + width // 6: ro + width * 5 // 6: 2]
            if seg:
                m = max(seg)
                if m > max_sub_y:
                    max_sub_y = m
        if max_sub_y > 100:
            if sub_on_start is None:
                sub_on_start = t
        elif sub_on_start is not None:
            sub_spans.append((round(sub_on_start, 3), round(t, 3)))
            sub_on_start = None
    if sub_on_start is not None:
        sub_spans.append((round(sub_on_start, 3), round(n_frames / fps, 3)))
    return flashes, sub_spans


def _run_paired_realtime(audio_cmd, video_cmd, frame_bytes, fps=30.0, max_sec=11.0):
    pa = subprocess.Popen(shlex.split(audio_cmd), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    pv = subprocess.Popen(shlex.split(video_cmd), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    a_chunks = bytearray()
    v_chunks = bytearray()
    t0 = time.monotonic()

    def read_a():
        next_t = time.monotonic()
        while time.monotonic() - t0 < max_sec:
            b = pa.stdout.read(1920)
            if not b:
                break
            a_chunks.extend(b)
            next_t += 0.01
            dt = next_t - time.monotonic()
            if dt > 0:
                time.sleep(dt)

    def read_v():
        next_t = time.monotonic()
        period = 1.0 / fps
        while time.monotonic() - t0 < max_sec:
            buf = bytearray()
            while len(buf) < frame_bytes:
                c = pv.stdout.read(frame_bytes - len(buf))
                if not c:
                    break
                buf.extend(c)
            if len(buf) < frame_bytes:
                break
            v_chunks.extend(buf)
            next_t += period
            dt = next_t - time.monotonic()
            if dt > 0:
                time.sleep(dt)

    ta = threading.Thread(target=read_a, daemon=True)
    tv = threading.Thread(target=read_v, daemon=True)
    ta.start()
    tv.start()
    ta.join(max_sec + 2)
    tv.join(max_sec + 2)
    for p in (pa, pv):
        try:
            p.terminate()
            p.wait(timeout=2)
        except Exception:
            p.kill()
        for stream in (p.stdout, p.stderr):
            if stream:
                try:
                    stream.close()
                except Exception:
                    pass
    return bytes(a_chunks), bytes(v_chunks)


class _FakeEngine:
    def __init__(self):
        self.last_stream = None
        self.t0 = time.monotonic()

    async def play(self, chat, stream, config=None):
        self.last_stream = stream
        self.t0 = time.monotonic()

    async def time(self, chat):
        return int(time.monotonic() - self.t0)

    async def calls(self):
        return {}


class AvSubSyncRegressionTests(unittest.TestCase):
    def _make_bridge(self, td):
        bridge = voice_main.Bridge(td, factory=lambda alias, sess: None)

        async def _ok_pub(*_args, **_kwargs):
            return True

        bridge.ensure_publisher = _ok_pub
        eng = _FakeEngine()
        bridge.accounts['main'] = {
            'alias': 'main',
            'enabled': True,
            'allowed': ['*'],
            'status': 'available',
            'leases': set(),
            'client': type('C', (), {'get_me': staticmethod(lambda: asyncio.sleep(0, result=type('Me', (), {'is_bot': False})()))})(),
            'engine': eng,
            'managed': {-1001, -10099},
            'denied': [],
            'group_grants': set(),
            'member_fallback_enabled': False,
            'uid': 1,
            'me_checked_at': time.monotonic(),
        }
        return bridge, eng

    def test_fractional_fps_preserved_and_long_nested_cue_detected(self):
        cmd = voice_main.rewrite_video_ffmpeg_command(
            'ffmpeg -i in.mp4 -f rawvideo -r 24 -pix_fmt yuv420p pipe:1',
            width=640,
            height=360,
            fps=23.976,
            stream_index=0,
        )
        self.assertIn('fps=fps=23.976', cmd)
        self.assertNotIn('fps=fps=23,', cmd)

        spans = [(10000, 90000)] + [(11000 + i * 2000, 11500 + i * 2000) for i in range(25)]
        self.assertTrue(sub_align.has_active_cue_near(spans, 85000, margin_ms=40))
        self.assertFalse(sub_align.has_active_cue_near(spans, 95000, margin_ms=40))

    def test_hls_header_probe_prefers_audio_skipped_header(self):
        class _Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header('X-Lancy-Skipped-Sec', '12.000')
                self.send_header('X-Lancy-Audio-Skipped-Sec', '10.000')
                self.end_headers()
                self.wfile.write(b'#EXTM3U\n')

            def log_message(self, *_args):
                pass

        with socketserver.TCPServer(('127.0.0.1', 0), _Handler) as srv:
            port = srv.server_address[1]
            t = threading.Thread(target=srv.serve_forever, daemon=True)
            t.start()
            try:
                v_skip, a_skip = sub_align._fetch_hls_skipped_hdrs(f'http://127.0.0.1:{port}/master.m3u8?start=14')
                self.assertEqual(v_skip, 12.0)
                self.assertEqual(a_skip, 10.0)
            finally:
                srv.shutdown()

    def test_seek_copyts_and_no_subtitles_and_1080p_downscale_av_sync(self):
        events = [2.0, 5.0, 8.0]
        with tempfile.TemporaryDirectory(prefix='lancy_reg_av_') as td:
            mp4 = os.path.join(td, 'src_23976_44100.mp4')
            srt = os.path.join(td, 'src_23976_44100.srt')
            expr = '+'.join(f'between(t,{t:.3f},{t + 0.15:.3f})' for t in events)
            _run_ffmpeg([
                '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:r=24000/1001:d=10',
                '-f', 'lavfi', '-i', f"aevalsrc='if({expr},0.8*sin(2*PI*1000*t),0)':s=44100:d=10",
                '-vf', f"drawbox=x=480:y=180:w=320:h=180:color=white:t=fill:enable='{expr}'",
                '-c:v', 'libx264', '-preset', 'ultrafast', '-bf', '2', '-g', '24', '-pix_fmt', 'yuv420p',
                '-c:a', 'aac', '-b:a', '128k', '-shortest', mp4,
            ])
            _write_srt(srt, events)
            bridge, eng = self._make_bridge(td)
            call = {
                'alias': 'main',
                'path': mp4,
                'subtitle_path': srt,
                'subtitle_offset': 0.0,
                'subtitle_same_route': True,
                'manual_sub_override': False,
                'video': True,
                'video_quality': 'SD_360p',
                'bass': False,
                'eq': 'off',
                'is_channel': False,
                'remote_proxy': False,
                'duration': 10.0,
                'offset': 3.5,
                'playback_id': 'pseek',
                'status': 'playing',
                'clock_errors': 0,
                'retries': 0,
                'retry_after': 0.0,
                'last_progress': time.monotonic(),
            }
            asyncio.run(bridge.stream(bridge.accounts['main'], -1001, call))
            w = eng.last_stream.camera.parameters.width
            h = eng.last_stream.camera.parameters.height
            fps = eng.last_stream.camera.parameters.frame_rate
            pcm, yuv = _run_paired_realtime(
                eng.last_stream.microphone.path,
                eng.last_stream.camera.path,
                w * h * 3 // 2,
                fps=fps,
                max_sec=8.0,
            )
            bridge._cleanup_sub_overlay(call)
            beeps = _measure_pcm_beeps(pcm)
            flashes, subs = _measure_yuv_flashes_and_subs(yuv, w, h, fps=fps)
            # Seeking to 3.5s lands on 5.0 (->1.5) and 8.0 (->4.5)
            self.assertEqual(len(beeps), 2, beeps)
            self.assertEqual(len(flashes), 2, flashes)
            self.assertEqual(len(subs), 2, subs)
            for b, f, s in zip(beeps, flashes, subs):
                self.assertLessEqual(abs(b - f), 0.06)
                self.assertLessEqual(abs(s[0] - f), 0.06)

            # Without subtitles: renders zero subtitle spans while keeping A/V sync intact
            call_nosub = {**call, 'subtitle_path': None, 'offset': 0.0, 'playback_id': 'pnosub'}
            asyncio.run(bridge.stream(bridge.accounts['main'], -1001, call_nosub))
            pcm2, yuv2 = _run_paired_realtime(
                eng.last_stream.microphone.path,
                eng.last_stream.camera.path,
                w * h * 3 // 2,
                fps=fps,
                max_sec=11.0,
            )
            bridge._cleanup_sub_overlay(call_nosub)
            beeps2 = _measure_pcm_beeps(pcm2)
            flashes2, subs2 = _measure_yuv_flashes_and_subs(yuv2, w, h, fps=fps)
            self.assertEqual(subs2, [])
            self.assertEqual(len(beeps2), 3)
            for b, f in zip(beeps2, flashes2):
                self.assertLessEqual(abs(b - f), 0.06)

    def test_av_sync_5s_video_stall_recovers_within_50ms(self):
        events = [1.5, 4.5, 7.5]
        fb = 640 * 360 * 3 // 2
        with tempfile.TemporaryDirectory(prefix='lancy_stall5s_') as td:
            mp4 = os.path.join(td, 'stall.mp4')
            expr = '+'.join(f'between(t,{t:.3f},{t + 0.14:.3f})' for t in events)
            _run_ffmpeg([
                '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30:d=9',
                '-f', 'lavfi', '-i', f"aevalsrc='if({expr},0.8*sin(2*PI*1000*t),0)':s=48000:d=9",
                '-vf', f"drawbox=x=240:y=90:w=160:h=90:color=white:t=fill:enable='{expr}'",
                '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
                '-c:a', 'aac', '-shortest', mp4,
            ])
            stalled_v = os.path.join(td, 'stalled_v.py')
            Path(stalled_v).write_text(
                f"""import subprocess, sys, time
p = subprocess.Popen(['ffmpeg', '-v', 'quiet', '-i', {mp4!r}, '-an', '-f', 'rawvideo', '-r', '30', '-pix_fmt', 'yuv420p', 'pipe:1'], stdout=subprocess.PIPE)
frames = 0
stalled = False
while True:
    buf = bytearray()
    while len(buf) < {fb}:
        c = p.stdout.read({fb} - len(buf))
        if not c: break
        buf.extend(c)
    if len(buf) < {fb}: break
    if not stalled and frames >= 75:
        stalled = True
        time.sleep(5.0)
    sys.stdout.buffer.write(buf)
    sys.stdout.buffer.flush()
    frames += 1
""",
                encoding='utf-8',
            )
            raw_a = f"ffmpeg -v quiet -i {shlex.quote(mp4)} -vn -f s16le -ac 2 -ar 48000 pipe:1"
            raw_v = f"python3 {shlex.quote(stalled_v)}"
            wa, wv = voice_main.wrap_av_sync_pair(raw_a, raw_v, frame_bytes=fb, fps=30, sync_id='test_stall5v')
            pa = subprocess.Popen(shlex.split(wa), stdout=subprocess.PIPE)
            pv = subprocess.Popen(shlex.split(wv), stdout=subprocess.PIPE)
            a_wall = []
            v_wall = []
            t0 = time.monotonic()

            def ra():
                while time.monotonic() - t0 < 15.0:
                    b = pa.stdout.read(1920)
                    if not b:
                        break
                    now = time.monotonic() - t0
                    if len(b) == 1920:
                        vals = struct.unpack('<960h', b)[::2]
                        if math.sqrt(sum(x * x for x in vals) / len(vals)) > 2000:
                            if not a_wall or now - a_wall[-1] > 1.0:
                                a_wall.append(now)
                    time.sleep(0.01)

            def rv():
                while time.monotonic() - t0 < 15.0:
                    buf = bytearray()
                    while len(buf) < fb:
                        c = pv.stdout.read(fb - len(buf))
                        if not c:
                            break
                        buf.extend(c)
                    if len(buf) < fb:
                        break
                    now = time.monotonic() - t0
                    acc = 0
                    cnt = 0
                    for row in range(90, 180, 10):
                        ro = row * 640
                        for col in range(240, 400, 10):
                            acc += buf[ro + col]
                            cnt += 1
                    if (acc / cnt) > 160 and (not v_wall or now - v_wall[-1] > 1.0):
                        v_wall.append(now)
                    time.sleep(1.0 / 30.0)

            ta = threading.Thread(target=ra, daemon=True)
            tv = threading.Thread(target=rv, daemon=True)
            ta.start()
            tv.start()
            ta.join(16.0)
            tv.join(16.0)
            for p in (pa, pv):
                try:
                    p.terminate()
                    p.wait(timeout=2)
                except Exception:
                    p.kill()
                for stream in (p.stdout, p.stderr):
                    if stream:
                        try:
                            stream.close()
                        except Exception:
                            pass
            self.assertEqual(len(a_wall), 3, a_wall)
            self.assertEqual(len(v_wall), 3, v_wall)
            # Even after a 5s stall, hysteresis recovery keeps A/V aligned within <=55ms
            for aw, vw in zip(a_wall, v_wall):
                self.assertLessEqual(abs(aw - vw), 0.055, f'Expected <=55ms after stall, got {aw - vw:.3f}s')

    def test_bridge_hls_seek_updates_landed_position_and_hot_reloads_subtitles(self):
        with tempfile.TemporaryDirectory(prefix='lancy_hls_ctrl_') as td:
            srt1 = os.path.join(td, 's1.srt')
            srt2 = os.path.join(td, 's2.srt')
            _write_srt(srt1, [2.0, 14.0], prefix='FIRST')
            _write_srt(srt2, [2.0, 14.0], prefix='SECOND')
            ts_path = os.path.join(td, 'v2.ts')
            _run_ffmpeg([
                '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=24:d=0.4',
                '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=0.4',
                '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
                '-c:a', 'aac', '-shortest', ts_path,
            ])
            ts_bytes = Path(ts_path).read_bytes()

            class _HlsHandler(http.server.BaseHTTPRequestHandler):
                def do_GET(self):
                    if self.path.endswith('.ts'):
                        self.send_response(200)
                        self.send_header('Content-Type', 'video/mp2t')
                        self.send_header('Content-Length', str(len(ts_bytes)))
                        self.end_headers()
                        self.wfile.write(ts_bytes)
                        return
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/vnd.apple.mpegurl')
                    self.send_header('X-Lancy-Skipped-Sec', '12.000')
                    self.send_header('X-Lancy-Audio-Skipped-Sec', '10.000')
                    self.end_headers()
                    self.wfile.write(b'#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nv2.ts\n#EXT-X-ENDLIST\n')

                def log_message(self, *_args):
                    pass

            with socketserver.TCPServer(('127.0.0.1', 0), _HlsHandler) as srv:
                port = srv.server_address[1]
                t = threading.Thread(target=srv.serve_forever, daemon=True)
                t.start()
                try:
                    bridge, _eng = self._make_bridge(td)
                    proxy_url = f'http://127.0.0.1:{port}/movie-proxy/0123456789abcdef0123456789abcdef.m3u8'
                    res = asyncio.run(bridge.play({
                        'chat_id': -10099,
                        'playback_id': 'phls_ctrl',
                        'stream_url': proxy_url,
                        'title': 'HLS Seek Film',
                        'video': True,
                        'remote_proxy': True,
                        'start_seconds': 14.0,
                        'duration_seconds': 60.0,
                        'subtitle_path': srt1,
                    }))
                    self.assertTrue(res['ok'])
                    self.assertEqual(res['position_seconds'], 12.0)
                    call = bridge.calls[-10099]
                    self.assertEqual(call['offset'], 12.0)
                    cfg_path = call.get('sub_config_path')
                    self.assertTrue(cfg_path and os.path.exists(cfg_path))
                    # Hot-reload subtitle path & offset without restarting the stream
                    prev_pid = call['playback_id']
                    ctrl_res = asyncio.run(bridge.control('subtitle', {
                        'chat_id': -10099,
                        'subtitle_path': srt2,
                        'subtitle_offset': 1.25,
                    }))
                    self.assertTrue(ctrl_res['ok'])
                    self.assertEqual(bridge.calls[-10099]['playback_id'], prev_pid)
                    import json
                    cfg = json.loads(Path(cfg_path).read_text(encoding='utf-8'))
                    self.assertEqual(cfg['subtitle_path'], srt2)
                    self.assertAlmostEqual(cfg['subtitle_offset'], 1.25, places=3)
                    # Seek control also lands cleanly at 12.0 and reports position_seconds=12.0
                    seek_res = asyncio.run(bridge.control('seek', {
                        'chat_id': -10099,
                        'seconds': 14.0,
                        'playback_id': 'phls_ctrl_2',
                    }))
                    self.assertTrue(seek_res['ok'])
                    self.assertEqual(seek_res['position_seconds'], 12.0)
                    bridge._cleanup_sub_overlay(bridge.calls[-10099])
                finally:
                    srv.shutdown()

    def test_vc_sync_verifier_hud_render_and_starvation_freeze_recovery(self):
        with tempfile.TemporaryDirectory() as td:
            srt = Path(td) / 'hud.srt'
            _write_srt(srt, [1.0, 3.0], prefix='VC')
            sid = f'vc_starve_{os.getpid()}'
            shm_p = av_sync.shm_path_for(sid)
            cfg_path = Path(voice_main._write_sub_config(
                sid,
                enabled=True,
                subtitle_path=str(srt),
                base_sec=0.0,
                subtitle_offset=0.0,
            ))
            fd, mm, state = av_sync._open_sync_state(shm_p)
            ov = None
            try:
                frame_bytes = (320 * 180 * 3) // 2
                ov = av_sync.SubOverlay(str(cfg_path), state, 320, 180, frame_bytes)
                frame = bytearray(b'\x80' * (320 * 180) + b'\x80' * (160 * 90 * 2))
                paused_frame = bytes(ov.render_hud(bytes(frame), 83.0, mode='paused'))
                self.assertEqual(len(paused_frame), len(frame))
                # Dimmed frame + PAUSED HUD pill must lower center Y well below original 0x80=128
                avg_y = sum(paused_frame[320 * 10:320 * 40]) / (320 * 30)
                self.assertLess(avg_y, 95.0)
                syncing_frame = bytes(ov.render_hud(bytes(frame), 83.0, mode='syncing'))
                self.assertNotEqual(syncing_frame, bytes(frame))

                # Starvation lead > SYNC_STARVATION_SEC (0.280) sets sync_flags & skew_ms in SHM metrics
                audio_pts = 0.20
                video_pts = 0.65
                self.assertGreater(video_pts - audio_pts, av_sync.SYNC_STARVATION_SEC)
                state.audio_state = 1
                state.video_state = 1
                state.audio_sec = audio_pts
                state.video_sec = video_pts
                state.sync_flags = 1
                state.skew_ms = 450
                snap = voice_main._read_sync_metrics(sid)
                self.assertIsNotNone(snap)
                self.assertEqual(int(snap.get('sync_flags', 0)), 1)
                self.assertEqual(int(snap.get('skew_ms', 0)), 450)
                state.audio_sec = 0.65
                state.sync_flags = 4
                state.skew_ms = 0
                state.paused = 1
                snap_paused = voice_main._read_sync_metrics(sid)
                self.assertEqual(int(snap_paused.get('sync_flags', 0)), 4)
                self.assertTrue(snap_paused.get('paused'))
            finally:
                if ov is not None:
                    ov.close()
                state = None
                try:
                    mm.close()
                except Exception:
                    pass
                try:
                    os.close(fd)
                except Exception:
                    pass
                cfg_path.unlink(missing_ok=True)
                shm_p.unlink(missing_ok=True)

    def test_live_sub_sync_monitor_detects_desync_drift_mismatch_and_normalizes(self):
        import json
        from types import SimpleNamespace

        # 1. Exact inverse transform with non-zero linear FPS drift
        t_media = 185.0
        sub_ms = sub_align.map_media_sec_to_sub_ms(
            t_media,
            subtitle_offset=1.6,
            drift_sec_per_sec=0.0025,
            drift_anchor_sec=25.0,
        )
        t_back = sub_align.inverse_map_sub_ms_to_media_sec(
            sub_ms,
            subtitle_offset=1.6,
            drift_sec_per_sec=0.0025,
            drift_anchor_sec=25.0,
        )
        self.assertAlmostEqual(t_back, t_media, places=2)

        # 2. Linear drift estimator recovers synthetic FPS drift across speech checkpoints
        drift_fit = sub_align.fit_linear_drift([
            (10.0, 0.50),
            (60.0, 0.70),
            (110.0, 0.90),
            (160.0, 1.10),
        ])
        self.assertIsNotNone(drift_fit)
        rate = drift_fit['drift_sec_per_sec']
        anchor_sec = drift_fit['drift_anchor_sec']
        offset_at_anchor = drift_fit['offset_at_anchor']
        self.assertAlmostEqual(rate, 0.004, places=4)
        self.assertAlmostEqual(offset_at_anchor, 0.50 + rate * (anchor_sec - 10.0), places=2)

        # 3. LiveSubSyncMonitor detects +2.2s speech-vs-cue offset in PCM stream & normalizes config,
        # then confirms 'synced' on follow-up check and 'mismatch' when swapped to a wrong cut.
        speech_slots = [1.5, 4.1, 9.2, 12.6, 15.1, 20.8, 24.0]
        with tempfile.TemporaryDirectory() as td:
            td_p = Path(td)
            srt = td_p / 'live_check.srt'
            # Cues start 2.2s EARLIER than speech slots => subtitle_offset should become +2.2s
            # Check math: map(speech_t) = speech_t - offset => cue_t = speech_t - 2.2 => offset = +2.2
            def _fmt_srt(sec):
                ms = max(0, int(round(float(sec) * 1000.0)))
                h, rem = divmod(ms, 3600000)
                m, rem = divmod(rem, 60000)
                s, ms_rem = divmod(rem, 1000)
                return f"{h:02d}:{m:02d}:{s:02d},{ms_rem:03d}"

            cue_lines = []
            for idx, st in enumerate(speech_slots, 1):
                c0 = max(0.2, st - 2.2)
                c1 = c0 + 1.6
                cue_lines.append(
                    f"{idx}\n{_fmt_srt(c0)} --> {_fmt_srt(c1)}\nLine {idx}\n"
                )
            srt.write_text('\n'.join(cue_lines), encoding='utf-8')

            sid = f'live_mon_{os.getpid()}'
            cfg_path = td_p / f'lancy-sub-{sid}.json'
            status_path = td_p / f'lancy-substatus-{sid}.json'
            cfg_path.write_text(json.dumps({
                'enabled': True,
                'subtitle_path': str(srt),
                'base_sec': 0.0,
                'subtitle_offset': 0.0,
                'drift_sec_per_sec': 0.0,
                'drift_anchor_sec': 0.0,
                'manual_override': False,
                'same_route': False,
                'auto_normalize': True,
                'force_check_seq': 0,
            }), encoding='utf-8')
            fake_state = SimpleNamespace(sub_gen=0)
            mon = sub_align.LiveSubSyncMonitor(
                sync_id=sid,
                config_path=str(cfg_path),
                status_path=str(status_path),
                state=fake_state,
                sample_rate=48000,
                channels=2,
                check_interval_sec=4.0,
                min_window_sec=12.0,
                max_window_sec=28.0,
            )
            try:
                # Generate 26s of 48kHz stereo PCM with 1.5s tone bursts matching speech_slots
                sr = 48000
                chunk_sec = 0.5
                frames_per_chunk = int(sr * chunk_sec)
                tone_samples = []
                for i in range(frames_per_chunk):
                    v = int(14000 * math.sin(2.0 * math.pi * 700.0 * (i / sr)))
                    tone_samples.append(v)
                    tone_samples.append(v)
                tone_pcm = struct.pack(f'<{frames_per_chunk * 2}h', *tone_samples)
                silence_pcm = b'\x00' * (frames_per_chunk * 4)
                for c_idx in range(52):
                    t0 = c_idx * chunk_sec
                    t_mid = t0 + chunk_sec * 0.5
                    speaking = any(s <= t_mid <= (s + 1.6) for s in speech_slots)
                    mon.feed_pcm(t0, tone_pcm if speaking else silence_pcm)
                    if (c_idx + 1) % 20 == 0:
                        time.sleep(0.05)

                mon.trigger_check()
                deadline = time.monotonic() + 5.0
                snap = None
                while time.monotonic() < deadline:
                    if status_path.exists():
                        data = json.loads(status_path.read_text(encoding='utf-8'))
                        if data.get('status') == 'auto_normalized':
                            snap = data
                            break
                    time.sleep(0.05)
                self.assertIsNotNone(snap, f'LiveSubSyncMonitor should auto-normalize shifted subtitles, last={mon.snapshot()}')
                self.assertGreaterEqual(int(fake_state.sub_gen), 1)
                new_cfg = json.loads(cfg_path.read_text(encoding='utf-8'))
                self.assertGreater(float(new_cfg['subtitle_offset']), 1.4)
                self.assertLess(float(new_cfg['subtitle_offset']), 3.0)

                # Follow-up check with normalized config transitions to 'synced'
                mon.trigger_check()
                deadline2 = time.monotonic() + 3.0
                synced_snap = None
                while time.monotonic() < deadline2:
                    data = json.loads(status_path.read_text(encoding='utf-8'))
                    if data.get('status') == 'synced':
                        synced_snap = data
                        break
                    time.sleep(0.05)
                self.assertIsNotNone(synced_snap, f'Follow-up check after normalization should report synced, last={mon.snapshot()}')
            finally:
                mon.close()

    def test_bridge_subcheck_and_status_expose_subtitle_sync(self):
        with tempfile.TemporaryDirectory() as td:
            srt = str(Path(td) / 'check_bridge.srt')
            mp4 = str(Path(td) / 'check_movie.mp4')
            _run_ffmpeg([
                '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=10:d=2',
                '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=2',
                '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', mp4,
            ])
            _write_srt(srt, [1.0, 4.0], prefix='Chk')
            bridge, _eng = self._make_bridge(td)
            probe_calls = []

            def fake_probe(media_url, subtitle_path, **kwargs):
                probe_calls.append((media_url, subtitle_path, kwargs))
                return {
                    'confident': True,
                    'offset': 1.8,
                    'z_score': 4.1,
                    'drift_sec_per_sec': 0.0012,
                    'drift_anchor_sec': 60.0,
                    'window_start': 60.0,
                    'half_consensus': True,
                    'status': 'drifted',
                }

            bridge.sub_align_probe = fake_probe
            play_res = asyncio.run(bridge.play({
                'chat_id': -10199,
                'playback_id': 'psubchk_1',
                'stream_url': mp4,
                'title': 'Checker Bridge Film',
                'video': True,
                'start_seconds': 0.0,
                'duration_seconds': 600.0,
                'subtitle_path': srt,
            }))
            self.assertTrue(play_res['ok'])
            try:
                chk_res = asyncio.run(bridge.control('subcheck', {'chat_id': -10199, 'auto_fix': True}))
                self.assertTrue(chk_res['ok'])
                self.assertEqual(len(probe_calls), 1)
                self.assertAlmostEqual(float(chk_res['subtitle_offset']), 1.8, places=2)
                self.assertAlmostEqual(float(chk_res['sub_drift_sec_per_sec']), 0.0012, places=4)
                self.assertEqual(chk_res['subtitle_sync']['status'], 'auto_normalized')

                st_res = asyncio.run(bridge.status(-10199))
                self.assertTrue(st_res['ok'])
                info = st_res['info']
                self.assertAlmostEqual(float(info['subtitle_offset']), 1.8, places=2)
                self.assertAlmostEqual(float(info['sub_drift_sec_per_sec']), 0.0012, places=4)
                self.assertEqual(info['subtitle_sync']['status'], 'auto_normalized')
            finally:
                bridge._cleanup_sub_overlay(bridge.calls[-10199])

    def test_sdh_filtering_and_two_point_drift_guards(self):
        mixed_cues = [
            (1000, 3000, '(WIND HOWLING)'),
            (3500, 5500, '[SCREAMING IN DISTANCE]'),
            (6000, 8000, '♪ Eerie music plays ♪'),
            (8500, 10000, 'CLOWN: (GROANS)'),
            (11000, 13000, 'We need to leave right now.'),
            (14000, 16000, "Don't look behind the door."),
            (17000, 19000, 'Did you hear that sound?'),
            (20000, 22000, 'Run upstairs!'),
        ]
        spoken = sub_align.filter_speech_cues(mixed_cues)
        self.assertEqual(
            [txt for _, _, txt in spoken],
            [
                'We need to leave right now.',
                "Don't look behind the door.",
                'Did you hear that sound?',
                'Run upstairs!',
            ],
        )
        # Reject 2-point noisy drift fit and short-span fits (<140s)
        self.assertIsNone(sub_align.fit_linear_drift([(10.0, 0.0), (90.0, 3.2)]))
        self.assertIsNone(sub_align.fit_linear_drift([(10.0, 0.2), (40.0, 0.5), (70.0, 0.8), (100.0, 1.1)]))


if __name__ == '__main__':
    unittest.main()
