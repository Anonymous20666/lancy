"""Comprehensive offline verification for NUT/LNF1 A/V sync, subtitle normalization, split-HLS alignment, and Layer 228 VC messaging."""
import asyncio
import http.server
import importlib.util
import io
import json
import math
import os
import shlex
import socket
import socketserver
import struct
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest import mock
from pathlib import Path

VOICE_DIR = Path(__file__).resolve().parents[1]
if str(VOICE_DIR) not in sys.path:
    sys.path.insert(0, str(VOICE_DIR))

SPEC = importlib.util.spec_from_file_location('lancy_voice', VOICE_DIR / 'main.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

import av_hub
import av_sync
import nut_stream
import rtmp_streamer
import sub_align

TESTS_DIR = Path(__file__).resolve().parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))
from test_av_sub_sync_regressions import (
    _measure_pcm_beeps,
    _measure_yuv_flashes_and_subs,
    _run_ffmpeg,
    _write_srt,
)


class NutStreamAndTimedProtocolTests(unittest.TestCase):
    def test_nut_reader_parses_1080p_av_and_survives_truncation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            mp4 = root / 'clip.mp4'
            nut_file = root / 'clip.nut'
            _run_ffmpeg([
                '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=24:d=1.5',
                '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=1.5',
                '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', str(mp4),
            ])
            dec_args = rtmp_streamer.build_rtmp_decoder_args(
                str(mp4),
                has_audio_stream=True,
                width=1920,
                height=1080,
                fps=25,
                realtime=False,
                container='nut',
            )
            p = subprocess.run([*dec_args[:-1], str(nut_file)], capture_output=True, text=True)
            self.assertEqual(p.returncode, 0, msg=p.stderr)
            raw_nut = nut_file.read_bytes()

            reader = nut_stream.NutStreamReader(io.BytesIO(raw_nut))
            v_pts, a_pts = [], []
            a_bytes = 0
            for pkt_type, *rest in reader.iter_packets():
                if pkt_type != 'frame':
                    continue
                info, _hdr_raw, _el, payload = rest
                if info.get('stream_class') == 0:
                    v_pts.append(info['pts_sec'])
                    self.assertEqual(len(payload), 1920 * 1080 * 3 // 2)
                elif info.get('stream_class') == 1:
                    a_pts.append(info['pts_sec'])
                    a_bytes += len(payload)

            self.assertGreaterEqual(len(v_pts), 30)
            self.assertGreaterEqual(len(a_pts), 15)
            self.assertEqual(v_pts, sorted(v_pts))
            self.assertEqual(a_pts, sorted(a_pts))
            self.assertGreater(a_bytes, 48000 * 2 * 2)

            # Truncated NUT stream terminates iteration cleanly without raising
            trunc_reader = nut_stream.NutStreamReader(io.BytesIO(raw_nut[: max(128, len(raw_nut) // 3)]))
            trunc_pkts = list(trunc_reader.iter_packets())
            self.assertGreater(len(trunc_pkts), 0)
            self.assertLess(len(trunc_pkts), len(v_pts) + len(a_pts))

    def test_lnf1_timed_packet_socket_roundtrip(self):
        s_tx, s_rx = socket.socketpair()
        try:
            payloads = [
                (-120_000, 33_333, b'frame-neg'),
                (0, 20_000, b'\x01\x02' * 400),
                (3_600_500_000, 40_000, b'long-pts-payload'),
            ]
            for pts_us, dur_us, data in payloads:
                nut_stream.send_timed_frame(s_tx, pts_us, dur_us, data)
            s_tx.shutdown(socket.SHUT_WR)

            rx_stream = s_rx.makefile('rb', buffering=0)
            try:
                got = []
                while True:
                    pkt = av_sync._read_next_timed_packet(rx_stream)
                    if pkt is None:
                        break
                    p_sec, d_sec, body = pkt
                    got.append((round(p_sec * 1_000_000), round(d_sec * 1_000_000), body))
                self.assertEqual(got, payloads)
            finally:
                rx_stream.close()
        finally:
            s_tx.close()
            s_rx.close()


class SubtitleAlignmentAndAssNormalizationTests(unittest.TestCase):
    def test_ass_normalization_and_progressive_vtt_dedupe(self):
        ass_raw = """[Script Info]
Title: Test Anime

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,36,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,0.5,2,20,20,24,1
Style: OP,Arial,32,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0.5,8,20,20,24,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Support us at OpenSubtitles.org!
Dialogue: 0,0:00:05.00,0:00:09.00,OP,,0,0,0,,{\\k30}Open{\\k40}ing {\\k30}Song
Dialogue: 0,0:00:10.00,0:00:12.00,Default,,0,0,0,,{\\an8}Look over there!
Dialogue: 0,0:00:10.00,0:00:12.00,Default,,0,0,0,,{\\an8}Look over there!
Dialogue: 0,0:00:13.00,0:00:15.00,Default,,0,0,0,,First spoken line.
Dialogue: 0,0:00:16.00,0:00:18.00,Default,,0,0,0,,Second spoken line.
Dialogue: 0,0:00:19.00,0:00:21.00,Default,,0,0,0,,Third spoken line.
"""
        ass_bytes, speech_spans = sub_align._normalize_ass_script(ass_raw, width=1280, height=720)
        ass_text = ass_bytes.decode('utf-8')
        self.assertIn('PlayResX: 1280', ass_text)
        self.assertNotIn('OpenSubtitles.org', ass_text)
        # Duplicate Dialogue event collapsed to one copy, OP/karaoke excluded from speech_spans
        self.assertEqual(ass_text.count('{\\an8}Look over there!'), 1)
        self.assertIn('Opening Song', ass_text.replace('{\\k30}', '').replace('{\\k40}', ''))
        self.assertEqual(speech_spans, [(10000, 12000), (13000, 15000), (16000, 18000), (19000, 21000)])

        # Progressive WebVTT prefix buildup within 450ms collapses cleanly, overlaps trimmed
        raw_cues = [
            (1000, 1400, 'Wait'),
            (1200, 1800, 'Wait for'),
            (1500, 2600, 'Wait for me'),
            (2400, 4000, 'Now go inside'),
        ]
        cleaned = sub_align.dedupe_overlapping_cues(raw_cues)
        self.assertEqual(len(cleaned), 2)
        self.assertEqual(cleaned[0][2], 'Wait for me')
        self.assertLessEqual(cleaned[0][1], cleaned[1][0])
        self.assertEqual(cleaned[1][2], 'Now go inside')

    def _synth_vocal_pcm_8k(self, total_sec, pulse_intervals):
        """Synthesize 8kHz s16le mono PCM with vocal-band speech bursts (180Hz+650Hz) inside pulse_intervals."""
        sr = 8000
        n = int(total_sec * sr)
        arr = bytearray(n * 2)
        # Build quick sample grid per 10ms window
        for sec0, sec1 in pulse_intervals:
            i0 = max(0, int(sec0 * sr))
            i1 = min(n, int(sec1 * sr))
            for i in range(i0, i1):
                t = i / float(sr)
                # syllable-like AM modulation (~4Hz) + vocal formants
                env = 0.65 * (0.6 + 0.4 * math.sin(2.0 * math.pi * 4.5 * t))
                val = int(12000 * env * (0.6 * math.sin(2.0 * math.pi * 220.0 * t) + 0.4 * math.sin(2.0 * math.pi * 680.0 * t)))
                struct.pack_into('<h', arr, i * 2, max(-32767, min(32767, val)))
        return bytes(arr)

    def test_correlate_dual_half_consensus_accepts_genuine_and_rejects_single_half_bgm(self):
        # 60s window triggers >=50s (n_audio >= 500) dual-half consensus
        true_lines = [(t, t + 1.4) for t in (4, 9, 14, 19, 24, 34, 39, 44, 49, 54)]
        cues = [(int(s * 1000), int(e * 1000), f'Line {idx}') for idx, (s, e) in enumerate(true_lines)]

        # 1) Genuine shift: speech in both halves occurs 2.4s EARLIER than cue timestamps -> cue_t - 2.4s = speech_t
        shifted_audio_intervals = [(s - 2.4, e - 2.4) for s, e in true_lines]
        pcm_shifted = self._synth_vocal_pcm_8k(60.0, shifted_audio_intervals)
        res_ok = sub_align.correlate_speech_and_cues(pcm_shifted, cues, 0.0, max_shift_sec=10.0)
        self.assertTrue(res_ok['ok'])
        self.assertTrue(res_ok['half_consensus'], msg=res_ok)
        self.assertTrue(res_ok['confident'], msg=res_ok)
        self.assertLessEqual(abs(res_ok['offset'] - (-2.4)), 0.3, msg=res_ok)

        # 2) Adverse case: first half shifted/loud BGM (+3.5s), second half aligned at 0.0s -> MUST reject false shift
        adverse_intervals = [(s + 3.5, e + 3.5) for s, e in true_lines[:5]] + [(s, e) for s, e in true_lines[5:]]
        pcm_adverse = self._synth_vocal_pcm_8k(60.0, adverse_intervals)
        res_bad = sub_align.correlate_speech_and_cues(pcm_adverse, cues, 0.0, max_shift_sec=10.0)
        self.assertTrue(res_bad['ok'])
        self.assertFalse(res_bad['confident'], msg=f'Single-half shift should NOT gain dual-half consensus: {res_bad}')
        self.assertEqual(res_bad['offset'], 0.0)


class EndToEndSplitHlsAndNutSyncTests(unittest.TestCase):
    def test_split_hls_lagging_audio_keeps_locked_av_in_rtmp_and_avhub_nut(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            src_v = root / 'src_v.ts'
            src_a = root / 'src_a.ts'
            out_flv = root / 'out_rtmp.flv'
            srt = root / 'subs.srt'
            w, h, fps = 320, 180, 24

            # Simulate post-seek split HLS segments:
            # Video proxy skipped 6.000s (video frames carry real PTS 6.0..10.5s with flashes at 7.0, 8.5, 10.0)
            # Audio proxy landed 2.0s earlier at 4.000s (audio carries real PTS 4.0..10.5s with beeps at 7.0, 8.5, 10.0)
            flash_events = [1.0, 2.5, 4.0]  # relative to t_anchor = 6.0s -> source PTS [7.0, 8.5, 10.0]
            expr_v = '+'.join(f'between(t,{t:.3f},{t + 0.12:.3f})' for t in flash_events)
            _run_ffmpeg([
                '-f', 'lavfi', '-i', f'color=c=black:s={w}x{h}:r={fps}:d=4.5',
                '-vf', f"drawbox=x={w * 3 // 8}:y={h // 4}:w={w // 4}:h={h // 2}:color=white:t=fill:enable='{expr_v}'",
                '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
                '-muxdelay', '0', '-muxpreload', '0',
                '-output_ts_offset', '6.0',
                str(src_v),
            ])
            audio_events = [3.0, 4.5, 6.0]  # 2.0s extra pre-roll -> aligns with source PTS [7.0, 8.5, 10.0]
            expr_a = '+'.join(f'between(t,{t:.3f},{t + 0.12:.3f})' for t in audio_events)
            _run_ffmpeg([
                '-f', 'lavfi', '-i', f"aevalsrc='if({expr_a},0.8*sin(2*PI*1000*t),0)':s=48000:d=6.5",
                '-ac', '2',
                '-c:a', 'aac', '-b:a', '128k',
                '-muxdelay', '0', '-muxpreload', '0',
                '-output_ts_offset', '4.0',
                str(src_a),
            ])
            v_bytes = src_v.read_bytes()
            a_bytes = src_a.read_bytes()
            _write_srt(srt, [7.2, 8.8], prefix='SPLIT_SUB')

            class _SplitHlsHandler(http.server.BaseHTTPRequestHandler):
                def do_GET(self):
                    if self.path == '/v.ts':
                        self.send_response(200)
                        self.send_header('Content-Type', 'video/mp2t')
                        self.send_header('Content-Length', str(len(v_bytes)))
                        self.end_headers()
                        self.wfile.write(v_bytes)
                        return
                    if self.path == '/a.ts':
                        self.send_response(200)
                        self.send_header('Content-Type', 'video/mp2t')
                        self.send_header('Content-Length', str(len(a_bytes)))
                        self.end_headers()
                        self.wfile.write(a_bytes)
                        return
                    if self.path.startswith('/audio.m3u8'):
                        self.send_response(200)
                        self.send_header('Content-Type', 'application/vnd.apple.mpegurl')
                        self.send_header('X-Lancy-Skipped-Sec', '4.000')
                        self.end_headers()
                        self.wfile.write(b'#EXTM3U\n#EXT-X-TARGETDURATION:7\n#EXTINF:6.5,\n/a.ts\n#EXT-X-ENDLIST\n')
                        return
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/vnd.apple.mpegurl')
                    self.send_header('X-Lancy-Skipped-Sec', '6.000')
                    self.send_header('X-Lancy-Audio-Skipped-Sec', '4.000')
                    self.end_headers()
                    body = (
                        '#EXTM3U\n'
                        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="eng",DEFAULT=YES,URI="/audio.m3u8"\n'
                        '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=320x180,AUDIO="aud"\n'
                        '/video.m3u8\n'
                    )
                    if self.path.startswith('/video.m3u8'):
                        body = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:4.5,\n/v.ts\n#EXT-X-ENDLIST\n'
                    self.wfile.write(body.encode('utf-8'))

                def log_message(self, *_args):
                    pass

            with socketserver.TCPServer(('127.0.0.1', 0), _SplitHlsHandler) as srv:
                port = srv.server_address[1]
                srv_t = threading.Thread(target=srv.serve_forever, daemon=True)
                srv_t.start()
                try:
                    proxy_url = f'http://127.0.0.1:{port}/movie-proxy/split-master.m3u8'
                    v_url = f'http://127.0.0.1:{port}/video.m3u8'
                    a_url = f'http://127.0.0.1:{port}/audio.m3u8'
                    # 1) Verify probe_initial_packet_pts recovers real 6.0s video / 4.0s audio epochs
                    v_pkt, a_pkt = asyncio.run(MODULE.probe_initial_packet_pts(proxy_url))
                    self.assertIsNotNone(v_pkt)
                    self.assertIsNotNone(a_pkt)
                    self.assertGreater(v_pkt - a_pkt, 1.5)

                    # Align both streams cleanly at t_anchor = v_pkt (~6.0s) using -copyts + pts_anchor
                    t_anchor = round(max(v_pkt, a_pkt), 6)
                    sid_rtmp = f'split_rtmp_{os.getpid()}'
                    cfg_rtmp = av_sync.sub_config_path_for(sid_rtmp)
                    shm_rtmp = av_sync.shm_path_for(sid_rtmp)
                    try:
                        cfg_rtmp.write_text(json.dumps({
                            'enabled': True,
                            'subtitle_path': str(srt),
                            'base_sec': t_anchor,
                            'subtitle_offset': 0.0,
                        }), encoding='utf-8')
                        dec_args = [
                            'ffmpeg', '-hide_banner', '-loglevel', 'error',
                            '-copyts', '-i', v_url,
                            '-copyts', '-i', a_url,
                            '-map', '0:v:0', '-map', '1:a:0',
                            '-vf', f'trim=start={t_anchor:.6f},setpts=PTS-{t_anchor:.6f}/TB,scale={w}:{h},fps={fps}:start_time=0,format=yuv420p',
                            '-af', f'atrim=start={t_anchor:.6f},asetpts=PTS-{t_anchor:.6f}/TB,aresample=48000:async=1:first_pts=0,aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=stereo',
                            '-c:v', 'rawvideo', '-pix_fmt', 'yuv420p',
                            '-c:a', 'pcm_s16le',
                            '-f', 'nut', 'pipe:1',
                        ]
                        env = dict(os.environ)
                        env['LANCY_RTMP_TARGET'] = str(out_flv)
                        hub_p = subprocess.Popen(
                            [
                                sys.executable, str(VOICE_DIR / 'rtmp_hub.py'),
                                '--sync-id', sid_rtmp,
                                '--width', str(w), '--height', str(h), '--fps', str(fps),
                                '--video-quality', 'SD_480p',
                                '--sub-config', str(cfg_rtmp),
                                '--rtmp-env', 'LANCY_RTMP_TARGET',
                                '--', *dec_args,
                            ],
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, env=env,
                        )
                        _, err = hub_p.communicate(timeout=20)
                        self.assertEqual(hub_p.returncode, 0, msg=err.decode('utf-8', 'replace'))
                        # Extract decoded PCM + YUV from output FLV and measure flash-beep alignment
                        flv_pcm = subprocess.run(
                            ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', str(out_flv), '-f', 's16le', '-ac', '2', '-ar', '48000', 'pipe:1'],
                            capture_output=True, check=True,
                        ).stdout
                        flv_yuv = subprocess.run(
                            ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', str(out_flv), '-f', 'rawvideo', '-pix_fmt', 'yuv420p', f'-s', f'{w}x{h}', '-r', str(fps), 'pipe:1'],
                            capture_output=True, check=True,
                        ).stdout
                        beeps_r = _measure_pcm_beeps(flv_pcm, 48000, 2, 20)
                        flashes_r, _subs_r = _measure_yuv_flashes_and_subs(flv_yuv, w, h, fps=fps)
                        self.assertGreaterEqual(len(beeps_r), 3, msg=beeps_r)
                        self.assertGreaterEqual(len(flashes_r), 3, msg=flashes_r)
                        for b_t, f_t in zip(beeps_r[:3], flashes_r[:3]):
                            self.assertLessEqual(abs(b_t - f_t), 0.055, msg=f'Split HLS RTMP drift b={b_t} f={f_t}')
                    finally:
                        cfg_rtmp.unlink(missing_ok=True)
                        shm_rtmp.unlink(missing_ok=True)

                    # 2) Same split-HLS through av_hub (NUT) + av_sync (LNF1 timed packets)
                    sid_vc = f'split_vc_{os.getpid()}'
                    cfg_vc = av_sync.sub_config_path_for(sid_vc)
                    shm_vc = av_sync.shm_path_for(sid_vc)
                    try:
                        wa, wv = MODULE.wrap_av_sync_pair(
                            f'{sys.executable} {MODULE.AV_HUB_SCRIPT} --role read-audio --sync-id {sid_vc}',
                            f'{sys.executable} {MODULE.AV_HUB_SCRIPT} --role read-video --sync-id {sid_vc}',
                            frame_bytes=w * h * 3 // 2,
                            fps=float(fps),
                            sync_id=sid_vc,
                            width=w,
                            height=h,
                            sub_config_path=str(cfg_vc),
                        )
                        cfg_vc.write_text(json.dumps({
                            'enabled': True,
                            'subtitle_path': str(srt),
                            'base_sec': t_anchor,
                            'subtitle_offset': 0.0,
                        }), encoding='utf-8')
                        hub = subprocess.Popen(
                            [sys.executable, MODULE.AV_HUB_SCRIPT, '--role', 'hub', '--sync-id', sid_vc, '--', *dec_args],
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                        )
                        pa = subprocess.Popen(shlex.split(wa), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                        pv = subprocess.Popen(shlex.split(wv), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                        pcm_buf, yuv_buf = bytearray(), bytearray()

                        def _drain(st, out_b):
                            try:
                                while True:
                                    c = st.read(65536)
                                    if not c:
                                        break
                                    out_b.extend(c)
                            finally:
                                try:
                                    st.close()
                                except OSError:
                                    pass

                        ta = threading.Thread(target=_drain, args=(pa.stdout, pcm_buf), daemon=True)
                        tv = threading.Thread(target=_drain, args=(pv.stdout, yuv_buf), daemon=True)
                        ta.start(); tv.start()
                        pa.wait(timeout=20); pv.wait(timeout=20)
                        ta.join(timeout=5); tv.join(timeout=5)
                        hub_err = hub.communicate(timeout=10)[1].decode('utf-8', 'replace')
                        pa.communicate(timeout=3)
                        pv.communicate(timeout=3)
                        self.assertEqual(hub.returncode, 0, msg=hub_err)
                        self.assertEqual(pa.returncode, 0)
                        self.assertEqual(pv.returncode, 0)
                        beeps_v = _measure_pcm_beeps(bytes(pcm_buf), 48000, 2, 20)
                        flashes_v, _subs_v = _measure_yuv_flashes_and_subs(bytes(yuv_buf), w, h, fps=fps)
                        self.assertGreaterEqual(len(beeps_v), 3, msg=beeps_v)
                        self.assertGreaterEqual(len(flashes_v), 3, msg=flashes_v)
                        for b_t, f_t in zip(beeps_v[:3], flashes_v[:3]):
                            self.assertLessEqual(abs(b_t - f_t), 0.055, msg=f'Split HLS Interactive LNF1 drift b={b_t} f={f_t}')
                    finally:
                        av_hub.cleanup_hub_files(sid_vc)
                        cfg_vc.unlink(missing_ok=True)
                        shm_vc.unlink(missing_ok=True)
                finally:
                    srv.shutdown()

    def test_paused_shm_clock_halts_timed_packets_and_resumes_cleanly(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sid = f'pause_clk_{os.getpid()}'
            shm_p = av_sync.shm_path_for(sid)
            sock_p = root / 'feed.sock'
            srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            srv.bind(str(sock_p))
            srv.listen(1)

            fd, mm, st = av_sync._open_sync_state(shm_p)
            st.paused = 0
            st.audio_state = 2
            frame_bytes = 64 * 64 * 3 // 2
            frame_payload = b'\x10' * frame_bytes
            helper_py = (
                'import socket, sys; '
                f's = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.connect({str(sock_p)!r}); '
                'out = sys.stdout.buffer\n'
                'while True:\n'
                ' b = s.recv(65536)\n'
                ' if not b: break\n'
                ' out.write(b); out.flush()'
            )
            proc = subprocess.Popen(
                [
                    sys.executable, str(VOICE_DIR / 'av_sync.py'),
                    '--role', 'video', '--sync-id', sid,
                    '--frame-bytes', str(frame_bytes), '--fps', '20',
                    '--', sys.executable, '-c', helper_py,
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            s_tx = None
            out_frames = []
            stop_read = threading.Event()

            def _read_out():
                while not stop_read.is_set():
                    buf = proc.stdout.read(frame_bytes)
                    if not buf or len(buf) < frame_bytes:
                        break
                    out_frames.append(len(buf))

            tr = threading.Thread(target=_read_out, daemon=True)
            tr.start()
            try:
                srv.settimeout(5.0)
                s_tx, _ = srv.accept()
                for i in range(4):
                    nut_stream.send_timed_frame(s_tx, i * 50_000, 50_000, frame_payload)
                time.sleep(0.35)
                count_before_pause = len(out_frames)
                self.assertGreaterEqual(count_before_pause, 2)

                st.paused = 1
                time.sleep(0.15)
                paused_snap = len(out_frames)
                for i in range(4, 9):
                    nut_stream.send_timed_frame(s_tx, i * 50_000, 50_000, frame_payload)
                time.sleep(0.30)
                self.assertEqual(len(out_frames), paused_snap, 'Paused timed video must not emit queued frames')

                st.paused = 0
                s_tx.shutdown(socket.SHUT_WR)
                proc.wait(timeout=8)
                stop_read.set()
                tr.join(timeout=2)
                self.assertEqual(proc.returncode, 0, msg=proc.stderr.read().decode('utf-8', 'replace'))
                self.assertEqual(len(out_frames), 9)
            finally:
                stop_read.set()
                if s_tx is not None:
                    try:
                        s_tx.close()
                    except OSError:
                        pass
                srv.close()
                if proc.poll() is None:
                    proc.kill()
                for s in (proc.stdout, proc.stderr):
                    if s is not None:
                        try:
                            s.close()
                        except OSError:
                            pass
                del st
                mm.close()
                os.close(fd)
                shm_p.unlink(missing_ok=True)


class Layer228AndModeSwitchTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from pyrogram import raw

        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.invokes = []
        self.fail_first_send = False
        self.call_is_rtmp = False
        invokes = self.invokes
        parent = self

        class FakeClient:
            def on_raw_update(self):
                def _dec(fn):
                    return fn
                return _dec

            async def get_me(self):
                return types.SimpleNamespace(id=101, is_bot=False)

            async def invoke(self, req, sleep_threshold=None):
                invokes.append(req)
                cname = type(req).__name__
                if cname == 'CreateGroupCall':
                    parent.call_is_rtmp = bool(getattr(req, 'rtmp_stream', False))
                    return types.SimpleNamespace(id=777)
                if cname == 'GetGroupCallStreamRtmpUrl':
                    return types.SimpleNamespace(url='rtmps://dc4-1.rtmp.t.me/s/', key='test_rtmp_secret_123')
                if cname == 'DiscardGroupCall':
                    parent.call_is_rtmp = False
                    return True
                if cname == 'SendGroupCallMessage':
                    if parent.fail_first_send:
                        parent.fail_first_send = False
                        raise RuntimeError('GROUPCALL_FORBIDDEN')
                    msg = types.SimpleNamespace(id=555)
                    return types.SimpleNamespace(updates=[types.SimpleNamespace(message=msg)])
                if cname == 'GetGroupCall':
                    gc = types.SimpleNamespace(id=777, rtmp_stream=parent.call_is_rtmp, messages_enabled=True)
                    return types.SimpleNamespace(call=gc)
                return types.SimpleNamespace(updates=[])

            async def get_dialogs(self, limit=None):
                if False:
                    yield None

            async def get_chat(self, chat):
                return types.SimpleNamespace(id=int(chat), type=types.SimpleNamespace(name='SUPERGROUP'), title='Test VC')

            async def resolve_peer(self, chat):
                return raw.types.InputPeerChannel(channel_id=abs(int(chat)), access_hash=1)

            async def stop(self):
                pass

        class FakeEngine:
            async def play(self, *args, **kwargs):
                pass

            async def time(self, chat):
                return 0

            async def pause(self, chat):
                return True

            async def resume(self, chat):
                return True

            async def change_volume_call(self, chat, vol):
                return None

            async def leave_call(self, chat):
                pass

        self.client = FakeClient()
        self.engine = FakeEngine()

        async def factory(alias, session):
            return self.client, self.engine, 101

        self.bridge = MODULE.Bridge(self.root, factory=factory)
        self.bridge.test_call_settings = True
        self.bridge.auto_create_call_in_tests = True
        self.bridge.test_rtmp_ingest = True
        self.spawned = []
        self.bridge.rtmp_mock_spawn = lambda chat, cmd, is_standby=False: self.spawned.append((chat, list(cmd), bool(is_standby)))
        self.bridge._create_group_call = self._fake_create_call
        async def _fake_resolve(client, chat):
            return await client.get_chat(chat)
        self.bridge.resolve_destination = _fake_resolve
        async def _fake_stream(a, chat, call):
            await asyncio.sleep(0.01)
        self.bridge.stream = _fake_stream
        self.bridge.native_call = self._fake_native_call
        self.track = self.root / 'song.mp3'
        self.track.write_bytes(b'abc')
        await self.bridge.register({'alias': 'one', 'session': 's', 'allowed': ['-1001']})
        self.raw = raw

    async def _fake_native_call(self, client, chat):
        peer = self.raw.types.InputPeerChannel(channel_id=abs(int(chat)), access_hash=555)
        return peer, self.raw.types.InputGroupCall(id=777, access_hash=888)

    async def _fake_create_call(self, a, chat, peer, *, vc_title=None, rtmp_stream=False):
        self.call_is_rtmp = bool(rtmp_stream)
        return self.raw.types.InputGroupCall(id=777, access_hash=888)

    async def asyncTearDown(self):
        await self.bridge.shutdown()
        self.tmp.cleanup()

    async def test_layer228_call_settings_send_join_retry_delete_and_incoming_events(self):
        await self.bridge.setup({'chat_id': -1001, 'stage': 'start', 'create': True, 'stream_mode': 'rtmp'})
        res = await self.bridge.play({
            'chat_id': -1001,
            'stream_url': str(self.track),
            'playback_id': 'pb1',
            'duration_seconds': 60,
            'stream_mode': 'rtmp',
        })
        self.assertTrue(res['ok'])
        # Auto-enabled Layer 228 messages on call startup
        toggle_reqs = [r for r in self.invokes if type(r).__name__ == 'ToggleGroupCallSettings']
        self.assertTrue(any(r.messages_enabled is True for r in toggle_reqs), msg=toggle_reqs)

        # Send call message hits GROUPCALL_FORBIDDEN in RTMP -> auto-joins + retries
        self.fail_first_send = True
        self.bridge.calls[-1001]['stream_mode'] = 'rtmp'
        send_res = await self.bridge.send_call_message({'chat_id': -1001, 'text': 'Hello VC!'})
        self.assertEqual(send_res, {'ok': True, 'sent': True, 'message_ids': [555]})

        # Update settings & delete messages
        upd_res = await self.bridge.update_call_settings({'chat_id': -1001, 'messages_enabled': False})
        self.assertEqual(upd_res, {'ok': True, 'messages_enabled': False})
        del_res = await self.bridge.delete_call_messages({'chat_id': -1001, 'message_ids': [555]})
        self.assertEqual(del_res, {'ok': True, 'deleted': 1})

        # Incoming UpdateGroupCallMessage: ignore own echo (uid 101), accept viewer msg, dedupe duplicate id
        gc_ref = self.raw.types.InputGroupCall(id=777, access_hash=888)
        own_upd = self.raw.types.UpdateGroupCallMessage(
            call=gc_ref,
            message=self.raw.types.GroupCallMessage(
                id=10,
                from_id=self.raw.types.PeerUser(user_id=101),
                date=1700000000,
                message=self.raw.types.TextWithEntities(text='!np', entities=[]),
                from_admin=True,
            ),
        )
        viewer_upd = self.raw.types.UpdateGroupCallMessage(
            call=gc_ref,
            message=self.raw.types.GroupCallMessage(
                id=11,
                from_id=self.raw.types.PeerUser(user_id=909),
                date=1700000001,
                message=self.raw.types.TextWithEntities(text='!np', entities=[]),
                from_admin=False,
            ),
        )
        users = {909: types.SimpleNamespace(first_name='Ari', last_name='V', username='ariv', title='')}
        await self.bridge._handle_group_call_message('one', own_upd, users, {})
        await self.bridge._handle_group_call_message('one', viewer_upd, users, {})
        await self.bridge._handle_group_call_message('one', viewer_upd, users, {})

        ev_list = []
        while not self.bridge.events.empty():
            ev_list.append(self.bridge.events.get_nowait())
        vc_evs = [e for e in ev_list if e.get('type') == 'vc_message']
        self.assertEqual(len(vc_evs), 1, msg=vc_evs)
        self.assertEqual(vc_evs[0]['sender_id'], 909)
        self.assertEqual(vc_evs[0]['sender_name'], 'Ari V')
        self.assertEqual(vc_evs[0]['text'], '!np')

        # Mode switch from active RTMP call -> interactive waits on DiscardGroupCall settlement and switches cleanly
        sw_res = await self.bridge.setup({'chat_id': -1001, 'stage': 'start', 'create': True, 'force_switch': True, 'stream_mode': 'interactive'})
        self.assertEqual(sw_res['stream_mode'], 'interactive')
        self.assertFalse(self.call_is_rtmp)
        self.assertTrue(any(type(r).__name__ == 'DiscardGroupCall' for r in self.invokes))

    def test_sub_align_maps_selected_audio_stream_index(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            mkv = root / 'dual_audio.mkv'
            srt = root / 'subs.srt'
            _run_ffmpeg([
                '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=24:d=22',
                '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=22',
                '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:d=22',
                '-map', '0:v', '-map', '1:a', '-map', '2:a',
                '-c:v', 'libx264', '-preset', 'ultrafast',
                '-c:a', 'aac', '-ac', '2',
                str(mkv),
            ])
            # Audio stream 0:1 is silent dub; audio stream 0:2 has 1kHz speech-band energy matching cues when aligned +2.5s
            events = [float(t) + 2.5 for t in (2.0, 4.0, 6.0, 8.0, 10.0, 12.0, 14.0, 16.0)]
            _write_srt(srt, events, prefix='DIAL')
            # Probing stream 1 (silent) yields empty_audio_probe / low correlation
            res_dub = sub_align.probe_audio_and_align(str(mkv), str(srt), audio_stream_index=1)
            self.assertFalse(res_dub.get('confident', False))
            # Passing audio_stream_index=2 explicitly runs ffmpeg with -map 0:2 cleanly
            seen_cmds = []
            real_run = subprocess.run

            def _spy_run(cmd, *args, **kwargs):
                seen_cmds.append(list(cmd))
                return real_run(cmd, *args, **kwargs)

            with mock.patch('sub_align.subprocess.run', side_effect=_spy_run):
                sub_align.probe_audio_and_align(str(mkv), str(srt), audio_stream_index=2)
            self.assertTrue(any('-map' in c and c[c.index('-map') + 1] == '0:2' for c in seen_cmds))


if __name__ == '__main__':
    unittest.main()
