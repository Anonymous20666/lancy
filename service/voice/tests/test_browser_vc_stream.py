import asyncio
import http.server
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import av
import numpy as np
from aiohttp.test_utils import AioHTTPTestCase

TESTS_DIR = Path(__file__).resolve().parent
VOICE_DIR = TESTS_DIR.parent
for _p in (TESTS_DIR, VOICE_DIR):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

import browser_stream
import main
import nut_stream
from test_bridge import FakeClient, FakeEngine


def _make_sample_jpeg(width=640, height=360, fill_y=120):
    f = av.VideoFrame(width, height, 'yuvj420p')
    arr = f.to_ndarray(format='yuv420p')
    arr[:] = fill_y
    f2 = av.VideoFrame.from_ndarray(arr, format='yuv420p').reformat(format='yuvj420p')
    enc = av.CodecContext.create('mjpeg', 'w')
    enc.width, enc.height, enc.pix_fmt = width, height, 'yuvj420p'
    enc.time_base = av.Fraction(1, 15) if hasattr(av, 'Fraction') else __import__('fractions').Fraction(1, 15)
    enc.open()
    return bytes(enc.encode(f2)[0])


def _is_browseros_up(url='http://127.0.0.1:9010/system/ready'):
    try:
        with urllib.request.urlopen(url, timeout=1.5) as r:
            return r.status == 200
    except Exception:
        return False


class BrowserVcStreamUnitTests(unittest.TestCase):
    def test_mjpeg_reader_reconnects_and_overlay_caches_clean_yuv420p(self):
        jpeg1 = _make_sample_jpeg(640, 360, 100)
        jpeg2 = _make_sample_jpeg(640, 360, 180)
        hits = {'count': 0}

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                hits['count'] += 1
                self.send_response(200)
                self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=frame')
                self.end_headers()
                payload = jpeg1 if hits['count'] == 1 else jpeg2
                part = (
                    b'--frame\r\nContent-Type: image/jpeg\r\n'
                    + f'Content-Length: {len(payload)}\r\nX-Tab-Id: 7\r\nX-Url: https://example.org/\r\n\r\n'.encode()
                    + payload
                    + b'\r\n'
                )
                self.wfile.write(part)
                self.wfile.flush()
                if hits['count'] == 1:
                    # Simulate transient drop after first frame so reader must reconnect
                    return
                time.sleep(0.5)

        srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        t = threading.Thread(target=srv.serve_forever, daemon=True)
        t.start()
        try:
            reader = browser_stream.MjpegScreencastReader(
                f'http://127.0.0.1:{srv.server_address[1]}/screencast',
                target_width=1280,
                target_height=720,
            )
            reader.start()
            got2 = False
            for _ in range(40):
                snap = reader.snapshot()
                if snap[2] >= 2:
                    got2 = True
                    break
                time.sleep(0.1)
            snap = reader.snapshot()
            reader.stop()
            self.assertTrue(got2, msg=f'Expected reconnect >=2 frames, got {snap[2:]}')
            self.assertGreaterEqual(snap[7], 1)  # reconnects >= 1
            self.assertEqual(len(snap[0]), 1280 * 720 * 3 // 2)
            self.assertEqual(snap[5], 'https://example.org/')
            self.assertEqual(snap[6], '7')

            ov = browser_stream.BrowserOverlayRenderer(1280, 720)
            rendered = ov.render(snap[0], {'state': 'LIVE', 'domain': 'example.org', 'task': 'Test Browser', 'action': 'Viewing'})
            ov.close()
            self.assertEqual(len(rendered), 1280 * 720 * 3 // 2)
        finally:
            srv.shutdown()
            srv.server_close()

    def test_decode_jpeg_1to1_preserves_crisp_horizontal_lines_on_odd_height(self):
        # 1280x633 matches BrowserOS default viewport aspect (odd height); 1:1 copy must not blur 1px horizontal stripes.
        w, h = 1280, 633
        rgb = np.zeros((h, w, 3), dtype=np.uint8)
        for row in range(0, h - 1, 4):
            rgb[row:row + 2, :, :] = 235
            rgb[row + 2:row + 4, :, :] = 20
        f = av.VideoFrame.from_ndarray(rgb, format='rgb24').reformat(format='yuvj420p')
        enc = av.CodecContext.create('mjpeg', 'w')
        enc.width, enc.height, enc.pix_fmt = w, h, 'yuvj420p'
        enc.time_base = __import__('fractions').Fraction(1, 15)
        enc.open()
        pkts = list(enc.encode(f)) + list(enc.encode(None))
        jpeg = bytes(pkts[0])

        yuv = browser_stream.decode_jpeg_to_yuv420(jpeg, 1280, 720)
        self.assertIsNotNone(yuv)
        self.assertEqual(len(yuv), 1280 * 720 * 3 // 2)
        y_plane = np.frombuffer(yuv[:1280 * 720], dtype=np.uint8).reshape(720, 1280)
        dy = ((720 - (633 & ~1)) // 2) & ~1
        # Crisp bright/dark stripes preserved across centered region (mean diff > 140)
        bright = float(y_plane[dy + 1, 100:200].mean())
        dark = float(y_plane[dy + 3, 100:200].mean())
        self.assertGreater(bright - dark, 140.0)

    def test_nut_role_outputs_valid_interleaved_nut_for_rtmp_hub(self):
        jpeg = _make_sample_jpeg(320, 180, 140)

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                self.send_response(200)
                self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=frame')
                self.end_headers()
                try:
                    for _ in range(5):
                        self.wfile.write(b'--frame\r\nContent-Type: image/jpeg\r\n' + f'Content-Length: {len(jpeg)}\r\n\r\n'.encode() + jpeg + b'\r\n')
                        self.wfile.flush()
                        time.sleep(0.1)
                except Exception:
                    pass

        srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            proc = subprocess.Popen(
                [
                    sys.executable, str(VOICE_DIR / 'browser_stream.py'),
                    '--role', 'nut',
                    '--screencast-url', f'http://127.0.0.1:{srv.server_address[1]}/sc',
                    '--width', '320', '--height', '180', '--fps', '10',
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            reader = nut_stream.NutStreamReader(proc.stdout)
            video_pkts = 0
            audio_pkts = 0
            for kind, *rest in reader.iter_packets():
                if kind == 'frame':
                    sid = rest[0]['stream_id']
                    if sid == 0:
                        video_pkts += 1
                    elif sid == 1:
                        audio_pkts += 1
                    if video_pkts >= 2 and audio_pkts >= 2:
                        break
            proc.terminate()
            proc.communicate(timeout=3)
            self.assertGreaterEqual(video_pkts, 2)
            self.assertGreaterEqual(audio_pkts, 2)
        finally:
            srv.shutdown()
            srv.server_close()

    def test_decode_jpeg_1to1_preserves_crisp_horizontal_lines_on_odd_height(self):
        # 1280x633 matches BrowserOS default viewport aspect (odd height); 1:1 copy must not blur 1px horizontal stripes.
        w, h = 1280, 633
        rgb = np.zeros((h, w, 3), dtype=np.uint8)
        for row in range(0, h - 1, 4):
            rgb[row:row + 2, :, :] = 235
            rgb[row + 2:row + 4, :, :] = 20
        f = av.VideoFrame.from_ndarray(rgb, format='rgb24').reformat(format='yuvj420p')
        enc = av.CodecContext.create('mjpeg', 'w')
        enc.width, enc.height, enc.pix_fmt = w, h, 'yuvj420p'
        enc.time_base = __import__('fractions').Fraction(1, 15)
        enc.open()
        pkts = list(enc.encode(f)) + list(enc.encode(None))
        jpeg = bytes(pkts[0])

        yuv = browser_stream.decode_jpeg_to_yuv420(jpeg, 1280, 720)
        self.assertIsNotNone(yuv)
        self.assertEqual(len(yuv), 1280 * 720 * 3 // 2)
        y_plane = np.frombuffer(yuv[:1280 * 720], dtype=np.uint8).reshape(720, 1280)
        dy = ((720 - (633 & ~1)) // 2) & ~1
        # Crisp bright/dark stripes preserved across centered region (mean diff > 140)
        bright = float(y_plane[dy + 1, 100:200].mean())
        dark = float(y_plane[dy + 3, 100:200].mean())
        self.assertGreater(bright - dark, 140.0)

    @unittest.skipUnless(_is_browseros_up(), 'Live BrowserOS neo container not running on 127.0.0.1:9010')
    def test_live_browseros_neo_screencast_to_yuv420p_end_to_end(self):
        mcp_url = 'http://127.0.0.1:9010/mcp'
        sid = None
        nid = 0

        def rpc(method, params=None):
            nonlocal sid, nid
            nid += 1
            h = {'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'}
            if sid:
                h['mcp-session-id'] = sid
                h['mcp-protocol-version'] = '2025-06-18'
            req = urllib.request.Request(mcp_url, json.dumps({'jsonrpc': '2.0', 'id': nid, 'method': method, 'params': params or {}}).encode(), h)
            resp = urllib.request.urlopen(req, timeout=20)
            sid = resp.headers.get('mcp-session-id') or sid
            ct = resp.headers.get('content-type', '')
            if 'event-stream' not in ct:
                return json.loads(resp.read())['result']
            buf = []
            for raw in resp:
                line = raw.decode().rstrip('\r\n')
                if line.startswith('data:'):
                    buf.append(line[5:].strip())
                elif not line and buf:
                    txt, buf = '\n'.join(buf).strip(), []
                    if txt and (o := json.loads(txt)).get('id') == nid:
                        return o['result']

        rpc('initialize', {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'lancy-e2e-test', 'version': '1.0'}})
        urllib.request.urlopen(urllib.request.Request(mcp_url, json.dumps({'jsonrpc': '2.0', 'method': 'notifications/initialized', 'params': {}}).encode(), {'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'mcp-session-id': sid, 'mcp-protocol-version': '2025-06-18'})).read()
        rpc('tools/call', {'name': 'tabs', 'arguments': {'action': 'new', 'url': 'https://example.com'}})

        sc_url = f'http://127.0.0.1:9010/v1/sessions/{sid}/screencast?quality=high'
        t0 = time.monotonic()
        reader = browser_stream.MjpegScreencastReader(sc_url, target_width=1280, target_height=720)
        reader.start()
        snap = None
        for _ in range(50):
            cur = reader.snapshot()
            if cur[0] is not None:
                snap = cur
                break
            time.sleep(0.1)
        first_ms = (time.monotonic() - t0) * 1000.0
        reader.stop()
        urllib.request.urlopen(urllib.request.Request(mcp_url, method='DELETE', headers={'mcp-session-id': sid}))

        self.assertIsNotNone(snap)
        self.assertEqual(len(snap[0]), 1280 * 720 * 3 // 2)
        self.assertIn('example.com', snap[5])
        print(f'\n[BENCH] BrowserOS live MJPEG -> 720p YUV420p first_frame={first_ms:.1f}ms url={snap[5]}')


class BrowserBridgeHttpRouteTests(AioHTTPTestCase):
    async def get_application(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.engine = FakeEngine()

        async def _factory(alias, session):
            return FakeClient(), self.engine, 999

        self.bridge = main.Bridge(self.tmp.name, factory=_factory)
        self.bridge.voice_listener = None
        self.token = 'b' * 40
        await self.bridge.register({'alias': 'main', 'session': 's', 'allowed': ['-100777']})
        return main.make_app(self.bridge, self.token)

    async def tearDownAsync(self):
        await self.bridge.shutdown()
        self.tmp.cleanup()

    async def test_browser_live_start_meta_and_stop_routes(self):
        hdr = {'Authorization': f'Bearer {self.token}'}
        r1 = await self.client.post('/call/browser-live/start', json={
            'chat_id': -100777,
            'screencast_url': 'http://127.0.0.1:9010/v1/sessions/demo/screencast?quality=high',
            'mcp_session_id': 'demo',
            'domain': 'example.com',
            'task': 'Open docs',
            'action': 'Loading',
            'width': 1280,
            'height': 720,
            'fps': 12,
        }, headers=hdr)
        d1 = await r1.json()
        self.assertEqual(r1.status, 200)
        self.assertTrue(d1['ok'])
        sid = d1['sync_id']
        self.assertTrue(browser_stream.browser_meta_path_for(sid).is_file())

        r2 = await self.client.post('/call/browser-live/meta', json={
            'chat_id': -100777,
            'domain': 'github.com',
            'action': 'Scrolled down',
            'step': '2/5',
        }, headers=hdr)
        d2 = await r2.json()
        self.assertTrue(d2['ok'])
        self.assertEqual(d2['meta']['domain'], 'github.com')

        r3 = await self.client.post('/call/browser-live/stop', json={'chat_id': -100777, 'keep_call': False}, headers=hdr)
        d3 = await r3.json()
        self.assertTrue(d3['ok'])
        self.assertTrue(d3['stopped'])
        self.assertFalse(browser_stream.browser_meta_path_for(sid).is_file())

    async def test_browser_live_uses_screen_share_and_live_context_trigger_turn(self):
        import inspect
        hdr = {'Authorization': f'Bearer {self.token}'}
        self.engine.streams.clear()
        vl = MagicMock()
        vl.start_chat = AsyncMock()
        vl.set_authorized_ids = MagicMock()
        vl.push_context_update = AsyncMock(return_value=True)
        vl.stop_all = AsyncMock()
        self.bridge.voice_listener = vl

        src_browser_live = inspect.getsource(main.Bridge.start_browser_live)
        self.assertIn('screen=VideoStream(', src_browser_live)
        self.assertIn('adjust_by_height=False', src_browser_live)
        self.assertIn('force_record=True', src_browser_live)

        r1 = await self.client.post('/call/browser-live/start', json={
            'chat_id': -100777,
            'screencast_url': 'http://127.0.0.1:9010/v1/sessions/demo/screencast?quality=high',
            'mcp_session_id': 'demo',
            'width': 1280,
            'height': 720,
        }, headers=hdr)
        d1 = await r1.json()
        self.assertTrue(d1['ok'])
        self.assertEqual(d1['fps'], 15)
        vl.start_chat.assert_awaited()
        self.assertTrue(vl.start_chat.await_args.kwargs.get('force_record'))

        r_ctx = await self.client.post('/call/live-context', json={
            'chat_id': -100777,
            'summary': '[Browser] completed search result',
            'trigger_turn': True,
        }, headers=hdr)
        d_ctx = await r_ctx.json()
        self.assertTrue(d_ctx['ok'])
        self.assertTrue(d_ctx['sent'])
        vl.push_context_update.assert_awaited_with(-100777, '[Browser] completed search result', trigger_turn=True)

        await self.client.post('/call/browser-live/stop', json={'chat_id': -100777, 'keep_call': False}, headers=hdr)


if __name__ == '__main__':
    unittest.main()
