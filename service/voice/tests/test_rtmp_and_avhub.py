"""End-to-end offline tests for single-demuxer av_hub, RTMP builder, and Bridge RTMP lifecycle."""
import asyncio
import importlib.util
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

VOICE_DIR = Path(__file__).resolve().parents[1]
if str(VOICE_DIR) not in sys.path:
    sys.path.insert(0, str(VOICE_DIR))

SPEC = importlib.util.spec_from_file_location('lancy_voice', VOICE_DIR / 'main.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

import av_hub
import av_sync
import rtmp_streamer

TESTS_DIR = Path(__file__).resolve().parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))
from test_av_sub_sync_regressions import (
    _measure_pcm_beeps,
    _measure_yuv_flashes_and_subs,
    _run_ffmpeg,
    _write_srt,
)


def _ffprobe_streams(media_path):
    res = subprocess.run(
        [
            'ffprobe', '-v', 'error',
            '-show_entries', 'stream=codec_type,codec_name,sample_rate,channels,width,height',
            '-of', 'json', str(media_path),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(res.stdout).get('streams') or []


def _strip_rtmp_realtime(args):
    out = []
    i = 0
    while i < len(args):
        if args[i] == '-re':
            i += 1
            continue
        if args[i] == '-readrate_initial_burst':
            i += 2
            continue
        out.append(args[i])
        i += 1
    return out


class FakeInteractiveEngine:
    def __init__(self):
        self.plays = []
        self.left = []

    async def play(self, chat, stream, **kw):
        self.plays.append((chat, stream, kw))

    async def time(self, chat):
        return 0

    async def pause(self, chat):
        return True

    async def resume(self, chat):
        return True

    async def change_volume_call(self, chat, volume):
        return None

    async def leave_call(self, chat):
        self.left.append(chat)


class AvHubIntegrationTests(unittest.TestCase):
    def test_single_demuxer_av_hub_with_av_sync_keeps_av_and_subs_locked(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            mp4 = root / 'sync_test.mp4'
            srt = root / 'subs.srt'
            w, h, fps, dur = 640, 360, 30, 4.0

            events = [0.5, 1.5, 2.5]
            expr = '+'.join(f'between(t,{t:.3f},{t + 0.12:.3f})' for t in events)
            _run_ffmpeg([
                '-f', 'lavfi', '-i', f'color=c=black:s={w}x{h}:r={fps}:d={dur}',
                '-f', 'lavfi', '-i', f"aevalsrc='if({expr},0.8*sin(2*PI*1000*t),0)':s=48000:d={dur}",
                '-ac', '2',
                '-vf', f"drawbox=x={w * 3 // 8}:y={h // 4}:w={w // 4}:h={h // 2}:color=white:t=fill:enable='{expr}'",
                '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
                '-c:a', 'aac', '-b:a', '128k',
                str(mp4),
            ])
            _write_srt(srt, [0.8, 1.8], prefix='HUB_SUB')

            base_a = f"ffmpeg -hide_banner -loglevel error -i {shlex.quote(str(mp4))} -f s16le -ac 2 -ar 48000 -map a pipe:1"
            base_v = f"ffmpeg -hide_banner -loglevel error -i {shlex.quote(str(mp4))} -f rawvideo -r {fps} -pix_fmt yuv420p -map v pipe:1"
            norm_a = MODULE.rewrite_audio_ffmpeg_command(base_a, normalize_pts=True)
            norm_v = MODULE.rewrite_video_ffmpeg_command(base_v, w, h, fps=fps, normalize_pts=True)

            unified = MODULE.build_unified_av_ffmpeg_command(norm_a, norm_v)
            self.assertIsNotNone(unified)
            self.assertIn(av_hub.AUDIO_PIPE_PLACEHOLDER, unified)
            self.assertEqual(unified.count(' -i '), 1)

            sid = f'testhub_{os.getpid()}'
            cfg_path = MODULE._write_sub_config(
                sid,
                enabled=True,
                subtitle_path=str(srt),
                base_sec=0.0,
                subtitle_offset=0.0,
            )
            av_hub.cleanup_hub_files(sid)
            try:
                read_a = f"{shlex.quote(sys.executable)} {shlex.quote(MODULE.AV_HUB_SCRIPT)} --role read-audio --sync-id {shlex.quote(sid)}"
                read_v = f"{shlex.quote(sys.executable)} {shlex.quote(MODULE.AV_HUB_SCRIPT)} --role read-video --sync-id {shlex.quote(sid)}"
                wrapped_a, wrapped_v = MODULE.wrap_av_sync_pair(
                    read_a, read_v, frame_bytes=w * h * 3 // 2, fps=fps, sync_id=sid
                )

                hub_proc = subprocess.Popen(
                    [sys.executable, MODULE.AV_HUB_SCRIPT, '--role', 'hub', '--sync-id', sid, '--', *shlex.split(unified)],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                )
                pa = subprocess.Popen(shlex.split(wrapped_a), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                pv = subprocess.Popen(shlex.split(wrapped_v), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                import threading
                pcm_buf = bytearray()
                yuv_buf = bytearray()
                pa_err = bytearray()
                pv_err = bytearray()

                def _drain(stream, out_buf):
                    try:
                        while True:
                            chunk = stream.read(65536)
                            if not chunk:
                                break
                            out_buf.extend(chunk)
                    finally:
                        try:
                            stream.close()
                        except OSError:
                            pass

                threads = [
                    threading.Thread(target=_drain, args=(pa.stdout, pcm_buf), daemon=True),
                    threading.Thread(target=_drain, args=(pv.stdout, yuv_buf), daemon=True),
                    threading.Thread(target=_drain, args=(pa.stderr, pa_err), daemon=True),
                    threading.Thread(target=_drain, args=(pv.stderr, pv_err), daemon=True),
                ]
                for t in threads:
                    t.start()
                try:
                    pa.wait(timeout=20)
                    pv.wait(timeout=20)
                    for t in threads:
                        t.join(timeout=5)
                    hub_err = hub_proc.communicate(timeout=15)[1].decode('utf-8', 'replace')
                finally:
                    for p in (pa, pv, hub_proc):
                        if p.poll() is None:
                            p.kill()
                            p.wait(timeout=3)
                    for s in (pa.stdout, pa.stderr, pv.stdout, pv.stderr, hub_proc.stderr):
                        if s is not None:
                            try:
                                s.close()
                            except OSError:
                                pass

                pcm_bytes = bytes(pcm_buf)
                yuv_bytes = bytes(yuv_buf)
                self.assertEqual(hub_proc.returncode, 0, msg=f'hub failed: {hub_err}')
                self.assertEqual(pa.returncode, 0, msg=pa_err.decode('utf-8', 'replace'))
                self.assertEqual(pv.returncode, 0, msg=pv_err.decode('utf-8', 'replace'))

                beeps = _measure_pcm_beeps(pcm_bytes, sample_rate=48000, channels=2, win_ms=20)
                flashes, sub_active = _measure_yuv_flashes_and_subs(yuv_bytes, w, h, fps=fps)
                self.assertGreaterEqual(len(beeps), 3)
                self.assertGreaterEqual(len(flashes), 3)
                for b_t, f_t in zip(beeps[:3], flashes[:3]):
                    self.assertLessEqual(abs(b_t - f_t), 0.055, msg=f'av_hub drift beep={b_t} flash={f_t}')

                if getattr(MODULE.av_sync, '_NATIVE_LIB', None) is not None:
                    self.assertTrue(
                        any(abs(s0 - 0.8) <= 0.15 and abs(s1 - 1.4) <= 0.25 for s0, s1 in sub_active),
                        msg=f'Missing subtitle span near 0.8..1.4 in {sub_active}',
                    )
                    self.assertTrue(
                        any(abs(s0 - 1.8) <= 0.15 and abs(s1 - 2.4) <= 0.25 for s0, s1 in sub_active),
                        msg=f'Missing subtitle span near 1.8..2.4 in {sub_active}',
                    )
            finally:
                av_hub.cleanup_hub_files(sid)
                Path(cfg_path).unlink(missing_ok=True)
                Path(MODULE.av_sync.shm_path_for(sid)).unlink(missing_ok=True)

    def test_av_hub_clean_exit_on_reader_abort(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            mp4 = root / 'long.mp4'
            _run_ffmpeg([
                '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=15:d=8',
                '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000:d=8',
                '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
                str(mp4),
            ])
            unified_cmd = [
                'ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', str(mp4),
                '-map', '0:v:0', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1',
                '-map', '0:a:0', '-f', 's16le', '-ac', '2', '-ar', '48000', av_hub.AUDIO_PIPE_PLACEHOLDER,
            ]
            sid = f'testabort_{os.getpid()}'
            av_hub.cleanup_hub_files(sid)
            try:
                hub = subprocess.Popen(
                    [sys.executable, MODULE.AV_HUB_SCRIPT, '--role', 'hub', '--sync-id', sid, '--', *unified_cmd],
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                )
                pa = subprocess.Popen(
                    [sys.executable, MODULE.AV_HUB_SCRIPT, '--role', 'read-audio', '--sync-id', sid],
                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                )
                pv = subprocess.Popen(
                    [sys.executable, MODULE.AV_HUB_SCRIPT, '--role', 'read-video', '--sync-id', sid],
                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                )
                # Read a small slice then simulate seek/abort by closing readers
                pa.stdout.read(4096)
                pv.stdout.read(4096)
                pa.stdout.close()
                pv.stdout.close()
                pa.terminate()
                pv.terminate()
                pa.wait(timeout=5)
                pv.wait(timeout=5)
                rc = hub.wait(timeout=10)
                self.assertIsNotNone(rc)
                self.assertFalse(av_hub.video_sock_path(sid).exists())
                self.assertFalse(av_hub.audio_sock_path(sid).exists())
            finally:
                av_hub.cleanup_hub_files(sid)


class RtmpBuilderTests(unittest.TestCase):
    def test_rtmp_ffmpeg_args_real_flv_outputs_and_fallbacks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            mp4 = root / 'movie.mp4'
            mp3 = root / 'song.mp3'
            silent_mp4 = root / 'silent.mp4'
            srt = root / 'movie.srt'
            _write_srt(srt, [0.1], prefix='RTMP_SUB')

            _run_ffmpeg([
                '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=24:duration=2.0',
                '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2.0',
                '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
                '-c:a', 'aac', str(mp4),
            ])
            _run_ffmpeg([
                '-f', 'lavfi', '-i', 'sine=frequency=520:sample_rate=48000:duration=1.5',
                '-c:a', 'libmp3lame', str(mp3),
            ])
            _run_ffmpeg([
                '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24:duration=1.5',
                '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
                '-an', str(silent_mp4),
            ])

            # 1) Full video + subtitle burn + EQ + volume -> FLV
            out_video = root / 'video.flv'
            args_v = _strip_rtmp_realtime(rtmp_streamer.build_rtmp_ffmpeg_args(
                str(mp4), str(out_video),
                video=True, has_video_stream=True, has_audio_stream=True,
                width=640, height=360, fps=24, video_quality='SD_480p',
                subtitle_path=str(srt), eq='bass', volume=80,
            ))
            subprocess.run(args_v, check=True)
            streams_v = _ffprobe_streams(out_video)
            codecs_v = {s['codec_type']: s for s in streams_v}
            self.assertEqual(codecs_v['video']['codec_name'], 'h264')
            self.assertEqual(codecs_v['audio']['codec_name'], 'aac')
            self.assertEqual(int(codecs_v['audio']['sample_rate']), 48000)

            # 2) Audio-only synthetic canvas -> FLV
            out_audio = root / 'audio.flv'
            args_a = _strip_rtmp_realtime(rtmp_streamer.build_rtmp_ffmpeg_args(
                str(mp3), str(out_audio),
                video=False, has_video_stream=False, has_audio_stream=True,
                width=1280, height=720, eq='vocal', volume=110,
            ))
            subprocess.run(args_a, check=True)
            streams_a = _ffprobe_streams(out_audio)
            codecs_a = {s['codec_type']: s for s in streams_a}
            self.assertEqual(codecs_a['video']['codec_name'], 'h264')
            self.assertEqual(codecs_a['audio']['codec_name'], 'aac')

            # 3) Silent video -> anullsrc audio fallback -> FLV
            out_silent = root / 'silent.flv'
            args_s = _strip_rtmp_realtime(rtmp_streamer.build_rtmp_ffmpeg_args(
                str(silent_mp4), str(out_silent),
                video=True, has_video_stream=True, has_audio_stream=False,
                width=320, height=240, fps=24,
            ))
            subprocess.run(args_s, check=True)
            streams_s = _ffprobe_streams(out_silent)
            self.assertEqual({s['codec_type'] for s in streams_s}, {'video', 'audio'})

            # 4) Standby stream -> FLV
            out_standby = root / 'standby.flv'
            args_st = _strip_rtmp_realtime(rtmp_streamer.build_rtmp_standby_args(str(out_standby), width=640, height=360))
            out_idx = args_st.index('-f', args_st.index('-flvflags'))
            args_st[out_idx:out_idx] = ['-t', '0.5', '-shortest']
            subprocess.run(args_st, check=True)
            streams_st = _ffprobe_streams(out_standby)
            self.assertEqual({s['codec_type'] for s in streams_st}, {'video', 'audio'})

    def test_scrub_rtmp_secret_strips_urls_and_keys(self):
        target = 'rtmps://dc4-1.rtmp.t.me/s/1948273645:super-secret-token-xyz'
        msg = f'Failed pushing FLV to {target} after timeout on rtmp://edge.t.me/live/anotherKey_123'
        scrubbed = rtmp_streamer.scrub_rtmp_secret(msg, target)
        self.assertNotIn('super-secret-token-xyz', scrubbed)
        self.assertNotIn('anotherKey_123', scrubbed)
        self.assertIn('<rtmp-redacted>', scrubbed)
        self.assertIn('<redacted>', scrubbed)


class BridgeRtmpLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.engine = FakeInteractiveEngine()
        self.rtmp_active = False
        self.call_seq = 100
        self.invoked = []
        self.spawned = []
        self.secret_key = '112233:SECRET_STREAM_KEY_XYZ'
        self.rtmp_base = 'rtmps://dc4-1.rtmp.t.me/s/'

        async def invoke(req, **kw):
            name = type(req).__name__
            self.invoked.append((name, req))
            if name == 'CreateGroupCall':
                self.call_seq += 1
                self.rtmp_active = bool(getattr(req, 'rtmp_stream', False))
                return types.SimpleNamespace(id=self.call_seq)
            if name == 'GetGroupCall':
                return types.SimpleNamespace(
                    call=types.SimpleNamespace(
                        id=self.call_seq,
                        rtmp_stream=self.rtmp_active,
                    )
                )
            if name == 'GetGroupCallStreamRtmpUrl':
                return types.SimpleNamespace(url=self.rtmp_base, key=self.secret_key)
            if name == 'DiscardGroupCall':
                self.rtmp_active = False
                self.call_seq = 0
                return True
            return True

        self.client = types.SimpleNamespace(
            get_me=AsyncMock(return_value=types.SimpleNamespace(id=77, is_bot=False)),
            stop=AsyncMock(),
            resolve_peer=AsyncMock(return_value=types.SimpleNamespace(channel_id=1001, access_hash=999)),
            invoke=AsyncMock(side_effect=invoke),
        )

        async def factory(alias, session):
            return self.client, self.engine, 77

        self.bridge = MODULE.Bridge(self.root, factory=factory)
        self.bridge.auto_create_call_in_tests = True
        self.bridge.test_rtmp_ingest = True
        self.bridge.resolve_destination = AsyncMock()
        self.bridge.resolve_call_invite_link = AsyncMock(return_value=None)

        async def native_call(client, chat):
            peer = types.SimpleNamespace(channel_id=abs(chat), access_hash=555)
            if self.call_seq:
                return peer, types.SimpleNamespace(id=self.call_seq, access_hash=777)
            return peer, None

        self.bridge.native_call = native_call
        self.call_seq = 0

        def mock_spawn(chat, cmd_args, is_standby=False):
            self.spawned.append((chat, list(cmd_args), bool(is_standby)))

        self.bridge.rtmp_mock_spawn = mock_spawn

        self.mp4 = self.root / 'demo.mp4'
        self.srt = self.root / 'demo.srt'
        self.srt2 = self.root / 'demo2.srt'
        _write_srt(self.srt, [0.2, 30.0], prefix='FIRST')
        _write_srt(self.srt2, [0.2, 30.0, 45.0], prefix='SECOND')
        _run_ffmpeg([
            '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=24:duration=60',
            '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=60',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', str(self.mp4),
        ])
        await self.bridge.register({'alias': 'main', 'session': 's1', 'allowed': ['-100123']})

    async def asyncTearDown(self):
        await self.bridge.shutdown()
        self.temp.cleanup()

    async def test_rtmp_lifecycle_controls_and_secret_redaction(self):
        chat = -100123

        # 1. Setup creates native group call with rtmp_stream=True and never leaks RTMP key
        setup_res = await self.bridge.setup({
            'chat_id': chat,
            'stage': 'start',
            'create': True,
            'stream_mode': 'rtmp',
            'title': 'Cinema Night',
        })
        self.assertEqual(setup_res['stream_mode'], 'rtmp')
        self.assertTrue(setup_res['created'])
        self.assertNotIn(self.secret_key, json.dumps(setup_res))
        create_reqs = [req for name, req in self.invoked if name == 'CreateGroupCall']
        self.assertEqual(len(create_reqs), 1)
        self.assertTrue(create_reqs[0].rtmp_stream)

        # 2. Play pushes via rtmp_mock_spawn and completely bypasses interactive ntgcalls play
        play_res = await self.bridge.play({
            'chat_id': chat,
            'stream_url': str(self.mp4),
            'playback_id': 'pb-rtmp-1',
            'duration_seconds': 60,
            'video': True,
            'stream_mode': 'rtmp',
            'subtitle_path': str(self.srt),
            'eq': 'bass',
            'volume': 85,
        })
        self.assertEqual(play_res['stream_mode'], 'rtmp')
        self.assertEqual(len(self.engine.plays), 0)
        self.assertEqual(len(self.spawned), 1)
        _, cmd0, standby0 = self.spawned[-1]
        self.assertFalse(standby0)
        cmd0_joined = ' '.join(cmd0)
        self.assertIn('rtmp_hub.py', cmd0_joined)
        self.assertNotIn(self.secret_key, cmd0_joined)
        self.assertIn('--rtmp-env', cmd0)
        self.assertIn('volume=0.850', cmd0_joined)
        self.assertIn('equalizer=f=48', cmd0_joined)
        self.assertIn('alimiter=limit=0.84:attack=7:release=80:level=0', cmd0_joined)
        call0 = self.bridge.calls[chat]
        self.assertTrue(call0.get('av_sync_id'))
        self.assertTrue(call0.get('sub_config_path') and Path(call0['sub_config_path']).is_file())

        # 3. Status exposes stream_mode='rtmp' and contains zero secret leakage
        st = await self.bridge.status(chat)
        self.assertEqual(st['info']['stream_mode'], 'rtmp')
        self.assertNotIn(self.secret_key, json.dumps(st))

        # 4. Live Pause pauses inside rtmp_hub SHM without tearing down stream; Resume unpauses cleanly
        spawns_before_pause = len(self.spawned)
        pause_res = await self.bridge.control('pause', {'chat_id': chat})
        self.assertEqual(pause_res['status'], 'paused')
        self.assertTrue(pause_res.get('hot_paused'))
        self.assertEqual(len(self.spawned), spawns_before_pause)
        shm_after_pause = MODULE._read_sync_metrics(self.bridge.calls[chat]['av_sync_id'])
        self.assertIsNotNone(shm_after_pause)
        self.assertTrue(shm_after_pause.get('paused'))

        resume_res = await self.bridge.control('resume', {'chat_id': chat})
        self.assertEqual(resume_res['status'], 'playing')
        self.assertTrue(resume_res.get('hot_resumed'))
        self.assertEqual(len(self.spawned), spawns_before_pause)
        shm_after_resume = MODULE._read_sync_metrics(self.bridge.calls[chat]['av_sync_id'])
        self.assertFalse(shm_after_resume.get('paused'))

        # 5. Seek restarts at target seconds
        seek_res = await self.bridge.control('seek', {'chat_id': chat, 'seconds': 25})
        self.assertEqual(seek_res['position_seconds'], 25.0)
        _, cmd_seek, _ = self.spawned[-1]
        self.assertIn('-ss', cmd_seek)
        self.assertEqual(cmd_seek[cmd_seek.index('-ss') + 1], '25.000')

        # 6. Volume restarts with updated gain filter
        await self.bridge.control('volume', {'chat_id': chat, 'volume': 60})
        self.assertIn('volume=0.600', ' '.join(self.spawned[-1][1]))

        # 7. Subtitle toggle/track/offset hot-reloads with ZERO stream restart via rtmp_hub SubOverlay
        spawns_before_sub = len(self.spawned)
        sub_res = await self.bridge.control('subtitle', {'chat_id': chat, 'subtitle_path': str(self.srt2), 'subtitle_offset': 1.5})
        self.assertTrue(sub_res.get('hot_reloaded'))
        self.assertEqual(len(self.spawned), spawns_before_sub)
        cfg_data = json.loads(Path(self.bridge.calls[chat]['sub_config_path']).read_text(encoding='utf-8'))
        self.assertEqual(cfg_data['subtitle_path'], str(self.srt2))
        self.assertEqual(float(cfg_data['subtitle_offset']), 1.5)
        self.assertTrue(cfg_data['enabled'])

        # 8. Force switch back to interactive VC discards RTMP call & creates non-RTMP call
        switch_res = await self.bridge.setup({
            'chat_id': chat,
            'stage': 'start',
            'create': True,
            'stream_mode': 'interactive',
            'force_switch': True,
        })
        self.assertEqual(switch_res['stream_mode'], 'interactive')
        self.assertGreaterEqual(sum(1 for name, _ in self.invoked if name == 'DiscardGroupCall'), 1)
        last_create = [req for name, req in self.invoked if name == 'CreateGroupCall'][-1]
        self.assertFalse(bool(getattr(last_create, 'rtmp_stream', False)))

        # 9. RTMP stop discards group call
        # Re-establish RTMP call quickly to test stop path
        await self.bridge.setup({
            'chat_id': chat,
            'stage': 'start',
            'create': True,
            'stream_mode': 'rtmp',
            'force_switch': True,
        })
        await self.bridge.play({
            'chat_id': chat,
            'stream_url': str(self.mp4),
            'playback_id': 'pb-rtmp-2',
            'duration_seconds': 60,
            'video': True,
            'stream_mode': 'rtmp',
        })
        discard_before = sum(1 for name, _ in self.invoked if name == 'DiscardGroupCall')
        stop_res = await self.bridge.control('stop', {'chat_id': chat})
        self.assertEqual(stop_res['status'], 'stopped')
        discard_after = sum(1 for name, _ in self.invoked if name == 'DiscardGroupCall')
        self.assertEqual(discard_after, discard_before + 1)
        self.assertEqual(self.bridge.accounts['main']['leases'], set())

    async def test_paused_rtmp_seek_option_a_restarts_decoder_at_target_and_keeps_paused(self):
        chat = -100123
        await self.bridge.setup({
            'chat_id': chat,
            'stage': 'start',
            'create': True,
            'stream_mode': 'rtmp',
            'title': 'Paused Seek Check',
        })
        await self.bridge.play({
            'chat_id': chat,
            'stream_url': str(self.mp4),
            'playback_id': 'pb-rtmp-paused-seek',
            'duration_seconds': 60,
            'video': True,
            'stream_mode': 'rtmp',
            'subtitle_path': str(self.srt),
        })
        pause_res = await self.bridge.control('pause', {'chat_id': chat})
        self.assertEqual(pause_res['status'], 'paused')

        spawns_before = len(self.spawned)
        seek_res = await self.bridge.control('seek', {'chat_id': chat, 'seconds': 35})
        self.assertTrue(seek_res['ok'])
        self.assertEqual(seek_res['status'], 'paused')
        self.assertAlmostEqual(float(seek_res['position_seconds']), 35.0, places=2)
        self.assertGreater(len(self.spawned), spawns_before)
        last_cmd = ' '.join(self.spawned[-1][1])
        self.assertIn('35.000', last_cmd)
        call = self.bridge.calls[chat]
        self.assertAlmostEqual(float(call['offset']), 35.0, places=2)
        metrics = MODULE._read_sync_metrics(call['av_sync_id'])
        self.assertIsNotNone(metrics)
        self.assertTrue(metrics['paused'])


class RtmpHubRealFlvE2ETests(unittest.TestCase):
    def test_rtmp_hub_real_flv_hd_no_clipping_and_live_sub_hot_reload(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            src_mp4 = root / 'hot_1080p.mp4'
            out_flv = root / 'stream_out.flv'
            srt1 = root / 'sub1.srt'
            srt2 = root / 'sub2.srt'
            srt1.write_text('1\n00:00:00,050 --> 00:00:02,200\nSUBTITLE ONE TEXT\n', encoding='utf-8')
            srt2.write_text('1\n00:00:03,800 --> 00:00:06,000\nSUBTITLE TWO HOT SWAP\n', encoding='utf-8')

            _run_ffmpeg([
                '-f', 'lavfi', '-i', 'color=c=0x101418:s=1920x1080:r=24:d=6.0',
                '-f', 'lavfi', '-i', "aevalsrc=0.70*sin(2*PI*45*t)+0.30*sin(2*PI*440*t):s=48000:c=stereo:d=6.0",
                '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
                '-c:a', 'aac', '-b:a', '192k', str(src_mp4),
            ])

            sid = 'testrtmphub1'
            cfg_path = av_sync.sub_config_path_for(sid)
            shm_path = av_sync.shm_path_for(sid)
            try:
                cfg_path.write_text(json.dumps({
                    'enabled': True,
                    'subtitle_path': str(srt1),
                    'base_sec': 0.0,
                    'subtitle_offset': 0.0,
                }), encoding='utf-8')
                dec_args = rtmp_streamer.build_rtmp_decoder_args(
                    str(src_mp4),
                    has_audio_stream=True,
                    width=1920,
                    height=1080,
                    fps=24,
                    eq='bass',
                    volume=200,
                    realtime=True,
                )
                hub_script = str(VOICE_DIR / 'rtmp_hub.py')
                env = dict(os.environ)
                env['LANCY_RTMP_TARGET'] = str(out_flv)
                proc = subprocess.Popen(
                    [
                        sys.executable, hub_script,
                        '--sync-id', sid,
                        '--width', '1920',
                        '--height', '1080',
                        '--fps', '24',
                        '--video-quality', 'FHD_1080p',
                        '--sub-config', str(cfg_path),
                        '--rtmp-env', 'LANCY_RTMP_TARGET',
                        '--',
                        *dec_args,
                    ],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                    env=env,
                )
                # 2.0s initial burst decodes ~0..2.0s immediately, then paces at 1x -> at t_wall=1.0s stream is ~3.0s (ahead of 3.8s sub2 cue).
                time.sleep(1.0)
                cfg_path.write_text(json.dumps({
                    'enabled': True,
                    'subtitle_path': str(srt2),
                    'base_sec': 0.0,
                    'subtitle_offset': 0.0,
                }), encoding='utf-8')
                MODULE._bump_sub_gen(sid)
                _, stderr_bytes = proc.communicate(timeout=20)
                self.assertEqual(proc.returncode, 0, msg=stderr_bytes.decode('utf-8', 'replace'))

                # 1. Verify true 1080p H.264 + 48kHz stereo AAC in output FLV
                streams = _ffprobe_streams(out_flv)
                by_type = {s['codec_type']: s for s in streams}
                self.assertEqual(by_type['video']['codec_name'], 'h264')
                self.assertEqual(int(by_type['video']['width']), 1920)
                self.assertEqual(int(by_type['video']['height']), 1080)
                self.assertEqual(by_type['audio']['codec_name'], 'aac')
                self.assertEqual(int(by_type['audio']['sample_rate']), 48000)

                # 2. Verify zero audio clipping even at bass + volume=200 on 0dBFS source
                vol_probe = subprocess.run(
                    ['ffmpeg', '-hide_banner', '-i', str(out_flv), '-af', 'volumedetect', '-f', 'null', '-'],
                    capture_output=True, text=True, check=True,
                )
                m_peak = re.search(r'max_volume:\s*([+-]?\d+(?:\.\d+)?)\s*dB', vol_probe.stderr)
                self.assertIsNotNone(m_peak, msg=vol_probe.stderr)
                self.assertLessEqual(float(m_peak.group(1)), -0.5)

                # 3. Verify both SUBTITLE ONE (before swap) and SUBTITLE TWO (after zero-restart swap) rendered white pixels
                for ts in (0.6, 4.8):
                    frame_yuv = root / f'frame_{ts:.1f}.yuv'
                    subprocess.run([
                        'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
                        '-ss', f'{ts:.1f}', '-i', str(out_flv), '-frames:v', '1', '-pix_fmt', 'yuv420p', str(frame_yuv),
                    ], check=True)
                    raw_y = frame_yuv.read_bytes()[:1920 * 1080]
                    # Bottom 24% rows where cinema subtitles sit
                    bottom_y = raw_y[1920 * int(1080 * 0.76):]
                    bright = sum(1 for px in bottom_y if px >= 200)
                    self.assertGreater(bright, 250, msg=f'Expected bright subtitle pixels at t={ts}s, got {bright}')
            finally:
                cfg_path.unlink(missing_ok=True)
                shm_path.unlink(missing_ok=True)

    def test_original_audio_preferred_over_dub_default_and_ntsc_rational_fps(self):
        streams = [
            {
                'index': 1,
                'codec_type': 'audio',
                'channels': 2,
                'tags': {'language': 'eng', 'title': 'English Dub'},
                'disposition': {'default': 1, 'original': 0, 'dub': 1},
            },
            {
                'index': 2,
                'codec_type': 'audio',
                'channels': 2,
                'tags': {'language': 'jpn', 'title': 'Japanese Original'},
                'disposition': {'default': 0, 'original': 1, 'dub': 0},
            },
        ]
        chosen = MODULE._pick_primary_audio_stream(streams, preferred_lang='ja')
        self.assertIsNotNone(chosen)
        self.assertEqual(int(chosen['index']), 2)
        self.assertEqual(rtmp_streamer._format_fps(23.976)[2], '24000/1001')
        self.assertEqual(rtmp_streamer._format_fps(29.97)[2], '30000/1001')
        self.assertEqual(rtmp_streamer._format_fps(59.94)[2], '60000/1001')

    def test_rtmp_hub_live_pause_hud_dim_and_resume_real_flv(self):
        if shutil.which('ffmpeg') is None:
            self.skipTest('ffmpeg not installed')
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            src_mp4 = root / 'bright.mp4'
            out_flv = root / 'paused_out.flv'
            cfg_path = root / 'sub_cfg.json'
            sid = f'rtmp_pause_hud_{os.getpid()}'
            shm_path = Path(av_sync.shm_path_for(sid))
            cfg_path.write_text(json.dumps({
                'enabled': True,
                'subtitle_path': None,
                'base_sec': 0.0,
                'subtitle_offset': 0.0,
            }), encoding='utf-8')
            try:
                subprocess.run([
                    'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
                    '-f', 'lavfi', '-i', 'color=c=#C0C0C0:s=1280x720:r=24:d=4.0',
                    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:d=4.0',
                    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
                    '-c:a', 'aac', '-ac', '2', '-ar', '48000',
                    str(src_mp4),
                ], check=True)
                dec_args = rtmp_streamer.build_rtmp_decoder_args(
                    str(src_mp4), width=1280, height=720, fps=24
                )
                hub_script = str(VOICE_DIR / 'rtmp_hub.py')
                env = dict(os.environ)
                env['LANCY_RTMP_TARGET'] = str(out_flv)
                proc = subprocess.Popen(
                    [
                        sys.executable, hub_script,
                        '--sync-id', sid,
                        '--width', '1280',
                        '--height', '720',
                        '--fps', '24',
                        '--video-quality', 'HD_720p',
                        '--sub-config', str(cfg_path),
                        '--rtmp-env', 'LANCY_RTMP_TARGET',
                        '--',
                        *dec_args,
                    ],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                    env=env,
                )
                time.sleep(1.0)
                st_live = MODULE._read_sync_metrics(sid)
                self.assertIsNotNone(st_live)
                self.assertGreater(float(st_live.get('media_pts_sec', 0.0)), 0.0)
                MODULE._set_sync_paused(sid, True)
                time.sleep(1.0)
                st_paused = MODULE._read_sync_metrics(sid)
                self.assertTrue(st_paused.get('paused'))
                MODULE._set_sync_paused(sid, False)
                _, stderr_bytes = proc.communicate(timeout=20)
                self.assertEqual(proc.returncode, 0, msg=stderr_bytes.decode('utf-8', 'replace'))
                self.assertTrue(out_flv.is_file() and out_flv.stat().st_size > 10_000)

                dur_probe = subprocess.run(
                    ['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', str(out_flv)],
                    capture_output=True, text=True, check=True,
                )
                total_dur = float(json.loads(dur_probe.stdout)['format']['duration'])
                self.assertGreaterEqual(total_dur, 4.5)

                def _mean_center_y(ts_sec):
                    yuv_p = root / f'pframe_{ts_sec:.2f}.yuv'
                    subprocess.run([
                        'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
                        '-ss', f'{ts_sec:.2f}', '-i', str(out_flv), '-frames:v', '1', '-pix_fmt', 'yuv420p', str(yuv_p),
                    ], check=True)
                    y_plane = yuv_p.read_bytes()[:1280 * 720]
                    vals = []
                    for r in range(300, 420):
                        off = r * 1280
                        vals.extend(y_plane[off + 540:off + 740])
                    return sum(vals) / max(1, len(vals))

                unpaused_y = _mean_center_y(0.4)
                paused_samples = [_mean_center_y(t) for t in (0.9, 1.15, 1.4, 1.65, 1.9, 2.15, 2.4, 2.7, 3.0, 3.3) if t < total_dur - 0.2]
                resumed_y = _mean_center_y(max(0.5, total_dur - 0.5))
                min_paused_y = min(paused_samples)
                self.assertGreater(unpaused_y, 150.0)
                self.assertLess(min_paused_y, unpaused_y - 30.0, msg=f'Expected Pause HUD dim vs live: unpaused={unpaused_y:.1f} samples={paused_samples}')
                self.assertGreater(resumed_y, 150.0, msg=f'Expected resume back to live brightness: resumed={resumed_y:.1f}')
            finally:
                cfg_path.unlink(missing_ok=True)
                shm_path.unlink(missing_ok=True)

    def test_main_parent_exit_guard_exits_when_parent_pid_is_dead(self):
        orig_expected = MODULE._EXPECTED_PPID
        orig_env = MODULE._ENV_PARENT_PID
        try:
            MODULE._EXPECTED_PPID = 99999999
            MODULE._ENV_PARENT_PID = '99999999'
            self.assertTrue(MODULE._parent_exited())
            MODULE._EXPECTED_PPID = os.getpid()
            self.assertEqual(MODULE._parent_exited(), os.getppid() != os.getpid())
        finally:
            MODULE._EXPECTED_PPID = orig_expected
            MODULE._ENV_PARENT_PID = orig_env

    def test_video_optimization_flags_and_interactive_resume_recovery(self):
        # 1. rewrite_video_ffmpeg_command updates output -r after -i to matched cinema fps & skips scale when dimensions match
        rewritten = MODULE.rewrite_video_ffmpeg_command(
            'ffmpeg -r 25 -i /tmp/movie.mp4 -f rawvideo -r 30 -pix_fmt yuv420p pipe:1',
            width=1280,
            height=720,
            fps=24,
            skip_scale=True,
        )
        tokens = shlex.split(rewritten)
        i_idx = tokens.index('-i')
        in_r_idx = tokens.index('-r')
        self.assertLess(in_r_idx, i_idx)
        self.assertEqual(tokens[in_r_idx + 1], '25')
        out_r_idx = tokens.index('-r', i_idx + 2)
        self.assertEqual(tokens[out_r_idx + 1], '24')
        self.assertIn('setsar=1', rewritten)
        self.assertNotIn('scale=1280:720', rewritten)

        # 2. rtmp_streamer skips redundant scale when scale_needed=False & uses superfast for 1080p
        dec_args = rtmp_streamer.build_rtmp_decoder_args('/tmp/movie.mp4', width=1920, height=1080, fps=24, scale_needed=False)
        vf_val = dec_args[dec_args.index('-vf') + 1]
        self.assertNotIn('scale=', vf_val)
        self.assertIn('setsar=1', vf_val)
        enc_1080 = rtmp_streamer.build_rtmp_encoder_args('LANCY_RTMP_TARGET', width=1920, height=1080, fps=24, video_quality='FHD_1080p')
        self.assertEqual(enc_1080[enc_1080.index('-preset') + 1], 'superfast')

        # 3. Interactive VC resume transparently rebuilds stream when _hub_proc exited or engine.resume fails
        async def _run():
            with tempfile.TemporaryDirectory() as td:
                bridge = MODULE.Bridge(td, factory=lambda alias, sess: None)
                bridge.ensure_publisher = AsyncMock(return_value=True)
                rebuilt = []

                async def _fake_stream(a, chat, call):
                    rebuilt.append((chat, call.get('offset'), call.get('status')))
                    call['_hub_proc'] = types.SimpleNamespace(returncode=None)

                bridge.stream = _fake_stream
                engine = types.SimpleNamespace(resume=AsyncMock(side_effect=RuntimeError('MEDIA_INVALID')))
                acct = {'alias': 'main', 'engine': engine, 'client': None}
                bridge.accounts['main'] = acct
                call_dead_hub = {
                    'alias': 'main',
                    'status': 'paused',
                    'path': '/tmp/movie.mp4',
                    'offset': 10.0,
                    'last_known_position': 425.0,
                    'last_progress': time.monotonic(),
                    'stream_mode': 'interactive',
                    '_hub_proc': types.SimpleNamespace(returncode=1),
                }
                bridge.calls[-10077] = call_dead_hub
                res1 = await bridge.control('resume', {'chat_id': -10077})
                self.assertTrue(res1['ok'])
                self.assertEqual(rebuilt[-1], (-10077, 425.0, 'playing'))

                call_dead_hub['_hub_proc'] = None
                call_dead_hub['status'] = 'paused'
                call_dead_hub['last_known_position'] = 512.0
                res2 = await bridge.control('resume', {'chat_id': -10077})
                self.assertTrue(res2['ok'])
                self.assertEqual(rebuilt[-1], (-10077, 512.0, 'playing'))

        asyncio.run(_run())


if __name__ == '__main__':
    unittest.main()
