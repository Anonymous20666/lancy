"""Real-time BrowserOS Neo screencast bridge for Telegram Voice Chats.

Reads live `multipart/x-mixed-replace` MJPEG streams from BrowserOS neo
(`/v1/sessions/{sessionId}/screencast`), decodes frames in RAM via PyAV,
renders an unobtrusive minimal status overlay via `_suboverlay.so` (libass),
and emits continuous real-time YUV420p / 48kHz stereo PCM (for `av_sync.py`)
or interleaved NUT (for `rtmp_hub.py`).
"""

import argparse
import ctypes
import http.client
import json
import os
import re
import signal
import socket
import sys
import threading
import time
from fractions import Fraction
from pathlib import Path
from urllib.parse import urlparse

import av
import numpy as np

try:
    import av_sync
except ImportError:  # pragma: no cover
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import av_sync

SAMPLE_RATE = 48000
CHANNELS = 2
SAMPLE_WIDTH = 2
AUDIO_BYTES_PER_20MS = 3840  # 960 samples * 2ch * 2 bytes


def _safe_sync_id(sync_id):
    return re.sub(r'[^a-zA-Z0-9_-]', '_', str(sync_id or 'default'))[:64] or 'default'


def browser_meta_path_for(sync_id):
    safe = _safe_sync_id(sync_id)
    return Path(f'/dev/shm/lancy-browser-meta-{safe}.json')


def browser_stats_path_for(sync_id):
    safe = _safe_sync_id(sync_id)
    return Path(f'/dev/shm/lancy-browser-stats-{safe}.json')


def write_browser_meta(sync_id, payload):
    p = browser_meta_path_for(sync_id)
    tmp = p.with_suffix('.tmp')
    data = {
        'state': str(payload.get('state') or 'LIVE').upper()[:24],
        'domain': str(payload.get('domain') or 'browser')[:64],
        'url': str(payload.get('url') or '')[:200],
        'task': str(payload.get('task') or 'Autonomous Browser')[:90],
        'action': str(payload.get('action') or 'Viewing page')[:90],
        'step': str(payload.get('step') or '')[:24],
        'updated_at': time.time(),
    }
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
    os.replace(tmp, p)
    return p


def _escape_ass(text):
    return av_sync._escape_ass_text(text) if hasattr(av_sync, '_escape_ass_text') else str(text or '').replace('\\', '').replace('{', '(').replace('}', ')')


def build_browser_hud_ass(width, height, meta):
    """Build crisp, minimal non-intrusive ASS HUD badges for live BrowserOS screen share."""
    w = max(320, int(width))
    h = max(180, int(height))
    top_sz = max(14, min(22, int(round(h * 0.026))))
    bot_sz = max(14, min(21, int(round(h * 0.025))))
    pad_top = max(8, int(round(top_sz * 0.34)))
    pad_bot = max(7, int(round(bot_sz * 0.32)))

    state = str((meta or {}).get('state') or 'LIVE').upper()
    domain = _escape_ass((meta or {}).get('domain') or 'browseros')[:42]
    task = _escape_ass((meta or {}).get('task') or 'Lancy Browser')[:64]
    action = _escape_ass((meta or {}).get('action') or 'Operating browser')[:64]
    step = _escape_ass((meta or {}).get('step') or '')[:20]

    if state in {'PAUSED', 'IDLE'}:
        dot_color = '&H0044D4FF&'
        chip = '● PAUSED'
    elif state in {'AWAITING_HUMAN', 'HUMAN_HELP', 'AWAITING_APPROVAL'}:
        dot_color = '&H005599FF&'
        chip = '● HUMAN HELP'
    elif state in {'CONNECTING'}:
        dot_color = '&H00FFD466&'
        chip = '● CONNECTING'
    else:
        dot_color = '&H0066EE66&'
        chip = '● LIVE'

    top_line = f'{{\\c{dot_color}\\b1}}{chip}{{\\b0\\c&H00E8ECF4&}}  LANCY BROWSER  ·  {{\\b1}}{domain}{{\\b0}}'
    bot_parts = [f'{{\\b1\\c&H00F2F5FA&}}{task}{{\\b0}}', f'{{\\c&H00BFD0EA&}}{action}']
    if step:
        bot_parts.append(f'{{\\c&H0094A8C8&}}{step}')
    bot_line = '  •  '.join(bot_parts)

    ass = (
        '[Script Info]\n'
        'ScriptType: v4.00+\n'
        f'PlayResX: {w}\n'
        f'PlayResY: {h}\n'
        'WrapStyle: 2\n'
        'ScaledBorderAndShadow: yes\n\n'
        '[V4+ Styles]\n'
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, '
        'Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, '
        'Alignment, MarginL, MarginR, MarginV, Encoding\n'
        f'Style: TopBadge,DejaVu Sans,{top_sz},&H00FFFFFF,&H00FFFFFF,&H00121822,&HC80B0F17,0,0,0,0,100,100,0.2,0,3,{pad_top},0,7,14,14,10,1\n'
        f'Style: BotBar,DejaVu Sans,{bot_sz},&H00E8ECF4,&H00E8ECF4,&H00121822,&HD20B0F17,0,0,0,0,100,100,0.2,0,3,{pad_bot},0,1,14,14,10,1\n\n'
        '[Events]\n'
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'
        f'Dialogue: 10,0:00:00.00,9:59:59.00,TopBadge,,0,0,0,,{top_line}\n'
        f'Dialogue: 10,0:00:00.00,9:59:59.00,BotBar,,0,0,0,,{bot_line}\n'
    )
    return ass.encode('utf-8')


class BrowserOverlayRenderer:
    """Minimal native-C libass compositor over YUV420p frames with frame-level caching."""

    def __init__(self, width, height):
        self.width = int(width)
        self.height = int(height)
        self.frame_bytes = (self.width * self.height * 3) // 2
        self._lib, _ = av_sync._load_suboverlay_lib()
        self._ctx = self._lib.sub_create(self.width, self.height, None) if self._lib else None
        self._c_buf = (ctypes.c_uint8 * self.frame_bytes)() if self._ctx else None
        self._hud_sig = None

    def make_canvas(self):
        """Return a clean dark slate (#0b0f17) YUV420p frame buffer."""
        y_len = self.width * self.height
        uv_len = y_len // 4
        y = np.full(y_len, 22, dtype=np.uint8)
        # subtle Slate gradient band
        y_2d = y.reshape(self.height, self.width)
        y_2d[: max(2, self.height // 16), :] = 18
        y_2d[-max(2, self.height // 16):, :] = 18
        u = np.full(uv_len, 134, dtype=np.uint8)
        v = np.full(uv_len, 126, dtype=np.uint8)
        return y.tobytes() + u.tobytes() + v.tobytes()

    def render(self, yuv_bytes, meta):
        if not self._ctx or self._c_buf is None or len(yuv_bytes) != self.frame_bytes:
            return yuv_bytes
        hud_load = getattr(self._lib, 'sub_load_hud_ass_mem', None)
        hud_render = getattr(self._lib, 'sub_render_hud_yuv420', None)
        if hud_load is None or hud_render is None:
            return yuv_bytes
        sig = (
            meta.get('state'),
            meta.get('domain'),
            meta.get('task'),
            meta.get('action'),
            meta.get('step'),
        )
        if sig != self._hud_sig:
            ass_bytes = build_browser_hud_ass(self.width, self.height, meta)
            if hud_load(self._ctx, ass_bytes, len(ass_bytes)) == 0:
                self._hud_sig = sig
        ctypes.memmove(self._c_buf, yuv_bytes, self.frame_bytes)
        c_ptr = ctypes.cast(self._c_buf, ctypes.c_void_p)
        hud_render(self._ctx, c_ptr, self.width, self.height, 1000)
        return bytes(self._c_buf)

    def close(self):
        if self._lib and self._ctx:
            try:
                self._lib.sub_destroy(self._ctx)
            except Exception:
                pass
            self._ctx = None


def decode_jpeg_to_yuv420(jpeg_bytes, width, height, *, decoder=None):
    """Decode JPEG bytes via PyAV and fit/scale cleanly to target even YUV420p dimensions."""
    if decoder is None:
        decoder = av.CodecContext.create('mjpeg', 'r')
        decoder.open()
    frames = decoder.decode(av.Packet(jpeg_bytes))
    if not frames:
        return None
    f = frames[0]
    src_w, src_h = int(f.width or width), int(f.height or height)
    lanczos = av.video.reformatter.Interpolation.LANCZOS
    if src_w == width and src_h == height:
        out = f.reformat(width=width, height=height, format='yuv420p', interpolation=lanczos)
        return b''.join(bytes(p) for p in out.planes)

    y_canvas = np.full((height, width), 16, dtype=np.uint8)
    u_canvas = np.full((height // 2, width // 2), 128, dtype=np.uint8)
    v_canvas = np.full((height // 2, width // 2), 128, dtype=np.uint8)

    if src_w <= width and src_h <= height:
        # Avoid fractional resampling blur when source fits: convert YUV420p at 1:1 pixels and center.
        fit_w = max(2, src_w & ~1)
        fit_h = max(2, src_h & ~1)
        scaled = f.reformat(format='yuv420p', interpolation=lanczos)
    else:
        scale = min(width / max(1, src_w), height / max(1, src_h))
        fit_w = max(2, int(round(src_w * scale)) & ~1)
        fit_h = max(2, int(round(src_h * scale)) & ~1)
        scaled = f.reformat(width=fit_w, height=fit_h, format='yuv420p', interpolation=lanczos)

    dx = ((width - fit_w) // 2) & ~1
    dy = ((height - fit_h) // 2) & ~1

    y_buf = np.frombuffer(scaled.planes[0], dtype=np.uint8)
    u_buf = np.frombuffer(scaled.planes[1], dtype=np.uint8)
    v_buf = np.frombuffer(scaled.planes[2], dtype=np.uint8)
    y_stride = scaled.planes[0].line_size
    u_stride = scaled.planes[1].line_size
    v_stride = scaled.planes[2].line_size

    sy = y_buf.reshape(len(y_buf) // y_stride, y_stride)[:fit_h, :fit_w]
    su = u_buf.reshape(len(u_buf) // u_stride, u_stride)[:fit_h // 2, :fit_w // 2]
    sv = v_buf.reshape(len(v_buf) // v_stride, v_stride)[:fit_h // 2, :fit_w // 2]

    y_canvas[dy:dy + fit_h, dx:dx + fit_w] = sy
    u_canvas[dy // 2:(dy + fit_h) // 2, dx // 2:(dx + fit_w) // 2] = su
    v_canvas[dy // 2:(dy + fit_h) // 2, dx // 2:(dx + fit_w) // 2] = sv
    return y_canvas.tobytes() + u_canvas.tobytes() + v_canvas.tobytes()


class MjpegScreencastReader:
    """Background HTTP/HTTPS `multipart/x-mixed-replace` reader with automatic reconnect."""

    def __init__(self, url, *, token='', target_width=1280, target_height=720):
        self.url = str(url or '').strip()
        self.token = str(token or '').strip()
        self.width = int(target_width)
        self.height = int(target_height)

        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None
        self._conn = None

        self.latest_yuv = None
        self.latest_seq = 0
        self.frames_in = 0
        self.reconnects = 0
        self.connected = False
        self.last_frame_mono = 0.0
        self.last_url = ''
        self.last_tab_id = ''
        self.last_error = ''

    def start(self):
        if not self.url:
            return
        self._thread = threading.Thread(target=self._run, name='browseros-mjpeg', daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        conn = self._conn
        if conn is not None:
            try:
                sock = getattr(conn, 'sock', None)
                if sock is not None:
                    sock.shutdown(socket.SHUT_RDWR)
            except Exception:
                pass
            try:
                conn.close()
            except Exception:
                pass
        if self._thread is not None and self._thread.is_alive():
            self._thread.join(timeout=1.0)

    def snapshot(self):
        with self._lock:
            return (
                self.latest_yuv,
                self.latest_seq,
                self.frames_in,
                self.connected,
                self.last_frame_mono,
                self.last_url,
                self.last_tab_id,
                self.reconnects,
                self.last_error,
            )

    def _run(self):
        dec = av.CodecContext.create('mjpeg', 'r')
        dec.open()
        backoff = 0.25
        attempts = 0
        while not self._stop.is_set():
            if attempts > 0:
                self.reconnects += 1
            attempts += 1
            try:
                parsed = urlparse(self.url)
                host = parsed.hostname or '127.0.0.1'
                port = parsed.port or (443 if parsed.scheme == 'https' else 80)
                path = parsed.path + (f'?{parsed.query}' if parsed.query else '')
                cls = http.client.HTTPSConnection if parsed.scheme == 'https' else http.client.HTTPConnection
                conn = cls(host, port, timeout=6.0)
                self._conn = conn
                headers = {'Accept': 'multipart/x-mixed-replace, image/jpeg'}
                if self.token:
                    headers['Authorization'] = f'Bearer {self.token}'
                conn.request('GET', path, headers=headers)
                resp = conn.getresponse()
                if resp.status != 200:
                    raise RuntimeError(f'HTTP {resp.status} {resp.reason}')

                ct = str(resp.getheader('Content-Type') or '')
                bm = re.search(r'boundary=([^;\s"]+)', ct, re.IGNORECASE)
                boundary = (bm.group(1) if bm else 'frame').encode('ascii', 'ignore')
                sep = b'--' + boundary

                self.connected = True
                self.last_error = ''
                backoff = 0.25

                buf = bytearray()
                while not self._stop.is_set():
                    chunk = resp.read1(4096) if hasattr(resp, 'read1') else resp.read(4096)
                    if not chunk:
                        break
                    buf.extend(chunk)
                    while True:
                        idx = buf.find(sep)
                        if idx < 0:
                            # Keep trailing boundary prefix in buffer
                            if len(buf) > 2_000_000:
                                del buf[:-65536]
                            break
                        # Trim anything before the boundary marker
                        if idx > 0:
                            del buf[:idx]
                        hdr_end = buf.find(b'\r\n\r\n')
                        if hdr_end < 0:
                            break
                        hdr_raw = bytes(buf[:hdr_end]).decode('utf-8', 'replace')
                        cl = None
                        x_url = ''
                        x_tab = ''
                        for line in hdr_raw.split('\r\n'):
                            low = line.lower()
                            if low.startswith('content-length:'):
                                try:
                                    cl = int(line.split(':', 1)[1].strip())
                                except ValueError:
                                    cl = None
                            elif low.startswith('x-url:'):
                                x_url = line.split(':', 1)[1].strip()
                            elif low.startswith('x-tab-id:'):
                                x_tab = line.split(':', 1)[1].strip()
                        body_start = hdr_end + 4
                        if cl is not None and cl > 0:
                            if len(buf) < body_start + cl:
                                break
                            jpeg = bytes(buf[body_start:body_start + cl])
                            del buf[:body_start + cl]
                        else:
                            next_b = buf.find(b'\r\n' + sep, body_start)
                            if next_b < 0:
                                break
                            jpeg = bytes(buf[body_start:next_b])
                            del buf[:next_b + 2]

                        if jpeg:
                            try:
                                yuv = decode_jpeg_to_yuv420(jpeg, self.width, self.height, decoder=dec)
                                if yuv:
                                    with self._lock:
                                        self.latest_yuv = yuv
                                        self.latest_seq += 1
                                        self.frames_in += 1
                                        self.last_frame_mono = time.monotonic()
                                        if x_url:
                                            self.last_url = x_url
                                        if x_tab:
                                            self.last_tab_id = x_tab
                            except Exception:
                                pass
            except Exception as err:
                self.connected = False
                self.last_error = str(err)[:160]
            finally:
                try:
                    if self._conn is not None:
                        self._conn.close()
                except Exception:
                    pass
                self._conn = None
                self.connected = False
            if not self._stop.is_set():
                self._stop.wait(backoff)
                backoff = min(2.5, backoff * 1.6)


def _read_meta_cached(meta_path, fallback):
    if not meta_path:
        return fallback
    try:
        return json.loads(Path(meta_path).read_text(encoding='utf-8'))
    except Exception:
        return fallback


def _run_video(args):
    w = max(2, int(args.width) & ~1)
    h = max(2, int(args.height) & ~1)
    fps = max(5.0, min(30.0, float(args.fps or 15.0)))
    frame_interval = 1.0 / fps

    overlay = BrowserOverlayRenderer(w, h)
    blank_canvas = overlay.make_canvas()
    reader = MjpegScreencastReader(
        args.screencast_url,
        token=args.token or os.environ.get('BROWSEROS_API_TOKEN', ''),
        target_width=w,
        target_height=h,
    )
    reader.start()

    out = sys.stdout.buffer
    stop_flag = False

    def _on_sig(_s, _f):
        nonlocal stop_flag
        stop_flag = True

    signal.signal(signal.SIGTERM, _on_sig)
    signal.signal(signal.SIGINT, _on_sig)

    cached_key = None
    cached_frame = None
    frames_out = 0
    bytes_out = 0
    t_start = time.monotonic()
    last_stats_write = 0.0
    fallback_meta = {
        'state': 'CONNECTING',
        'domain': urlparse(args.screencast_url).netloc if args.screencast_url else 'browser',
        'task': 'Lancy Browser Neo',
        'action': 'Connecting live screencast',
        'step': '',
    }

    try:
        while not stop_flag:
            meta = _read_meta_cached(args.meta_file, fallback_meta)
            yuv_raw, seq, frames_in, connected, last_frame_mono, live_url, tab_id, reconnects, last_err = reader.snapshot()

            if yuv_raw is None:
                base_yuv = blank_canvas
                eff_meta = dict(meta)
                if eff_meta.get('state') == 'LIVE':
                    eff_meta['state'] = 'CONNECTING'
            else:
                base_yuv = yuv_raw
                eff_meta = dict(meta)
                if live_url and not meta.get('domain'):
                    eff_meta['domain'] = urlparse(live_url).hostname or 'browser'

            render_key = (
                seq,
                eff_meta.get('state'),
                eff_meta.get('domain'),
                eff_meta.get('task'),
                eff_meta.get('action'),
                eff_meta.get('step'),
            )
            if render_key != cached_key or cached_frame is None:
                cached_frame = overlay.render(base_yuv, eff_meta)
                cached_key = render_key

            try:
                out.write(cached_frame)
                out.flush()
            except BrokenPipeError:
                break

            frames_out += 1
            bytes_out += len(cached_frame)
            now = time.monotonic()

            if args.stats_file and (now - last_stats_write) >= 0.75:
                last_stats_write = now
                elapsed = max(0.05, now - t_start)
                stats = {
                    'fps_out': round(frames_out / elapsed, 2),
                    'frames_out': frames_out,
                    'mjpeg_frames_in': frames_in,
                    'bytes_out': bytes_out,
                    'connected': bool(connected),
                    'last_frame_age_ms': round((now - last_frame_mono) * 1000.0, 1) if last_frame_mono > 0 else None,
                    'current_url': live_url,
                    'current_tab_id': tab_id,
                    'reconnects': reconnects,
                    'last_error': last_err,
                    'updated_at': time.time(),
                }
                try:
                    sp = Path(args.stats_file)
                    tmp = sp.with_suffix('.tmp')
                    tmp.write_text(json.dumps(stats), encoding='utf-8')
                    os.replace(tmp, sp)
                except Exception:
                    pass

            next_tick = t_start + frames_out * frame_interval
            sleep_s = next_tick - time.monotonic()
            if sleep_s > 0.001:
                time.sleep(sleep_s)
    finally:
        reader.stop()
        overlay.close()
    return 0


def _run_audio():
    """Emit continuous real-time 48kHz stereo s16le silence for TtsAudioFeeder overlay."""
    out = sys.stdout.buffer
    silence = b'\x00' * AUDIO_BYTES_PER_20MS
    stop_flag = False

    def _on_sig(_s, _f):
        nonlocal stop_flag
        stop_flag = True

    signal.signal(signal.SIGTERM, _on_sig)
    signal.signal(signal.SIGINT, _on_sig)

    t0 = time.monotonic()
    chunks = 0
    while not stop_flag:
        try:
            out.write(silence)
            out.flush()
        except BrokenPipeError:
            break
        chunks += 1
        sleep_s = (t0 + chunks * 0.020) - time.monotonic()
        if sleep_s > 0.001:
            time.sleep(sleep_s)
    return 0


def _run_nut(args):
    """Emit real-time interleaved NUT stream (`yuv420p` + `pcm_s16le`) for RTMP hub mode."""
    w = max(2, int(args.width) & ~1)
    h = max(2, int(args.height) & ~1)
    fps = max(5.0, min(30.0, float(args.fps or 15.0)))
    fps_int = int(round(fps))
    frame_interval = 1.0 / fps_int

    overlay = BrowserOverlayRenderer(w, h)
    blank_canvas = overlay.make_canvas()
    reader = MjpegScreencastReader(
        args.screencast_url,
        token=args.token or os.environ.get('BROWSEROS_API_TOKEN', ''),
        target_width=w,
        target_height=h,
    )
    reader.start()

    stop_flag = False

    def _on_sig(_s, _f):
        nonlocal stop_flag
        stop_flag = True

    signal.signal(signal.SIGTERM, _on_sig)
    signal.signal(signal.SIGINT, _on_sig)

    container = av.open(sys.stdout.buffer, mode='w', format='nut')
    v_stream = container.add_stream('rawvideo', rate=fps_int)
    v_stream.width = w
    v_stream.height = h
    v_stream.pix_fmt = 'yuv420p'

    a_stream = container.add_stream('pcm_s16le', rate=SAMPLE_RATE, layout='stereo')
    samples_per_frame = max(480, SAMPLE_RATE // fps_int)
    a_zeros = np.zeros((1, samples_per_frame * CHANNELS), dtype=np.int16)

    cached_key = None
    cached_frame = None
    frame_idx = 0
    audio_pts = 0
    t0 = time.monotonic()

    try:
        while not stop_flag:
            meta = _read_meta_cached(args.meta_file, {'state': 'LIVE', 'domain': 'browser', 'task': 'Lancy Browser', 'action': 'Streaming', 'step': ''})
            yuv_raw, seq, *_ = reader.snapshot()
            base_yuv = yuv_raw if yuv_raw is not None else blank_canvas
            render_key = (seq, meta.get('state'), meta.get('domain'), meta.get('task'), meta.get('action'), meta.get('step'))
            if render_key != cached_key or cached_frame is None:
                cached_frame = overlay.render(base_yuv, meta)
                cached_key = render_key

            vf = av.VideoFrame(w, h, 'yuv420p')
            y_end = w * h
            u_end = y_end + (y_end // 4)
            vf.planes[0].update(cached_frame[:y_end])
            vf.planes[1].update(cached_frame[y_end:u_end])
            vf.planes[2].update(cached_frame[u_end:])
            vf.pts = frame_idx
            vf.time_base = Fraction(1, fps_int)
            for pkt in v_stream.encode(vf):
                container.mux(pkt)

            af = av.AudioFrame.from_ndarray(a_zeros, format='s16', layout='stereo')
            af.rate = SAMPLE_RATE
            af.pts = audio_pts
            af.time_base = Fraction(1, SAMPLE_RATE)
            audio_pts += samples_per_frame
            for pkt in a_stream.encode(af):
                container.mux(pkt)

            frame_idx += 1
            sleep_s = (t0 + frame_idx * frame_interval) - time.monotonic()
            if sleep_s > 0.001:
                time.sleep(sleep_s)
    except BrokenPipeError:
        pass
    finally:
        reader.stop()
        overlay.close()
        try:
            container.close()
        except Exception:
            pass
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description='BrowserOS Neo Live VC Stream Bridge')
    ap.add_argument('--role', choices=['video', 'audio', 'nut'], required=True)
    ap.add_argument('--screencast-url', default='')
    ap.add_argument('--token', default='')
    ap.add_argument('--meta-file', default='')
    ap.add_argument('--stats-file', default='')
    ap.add_argument('--width', type=int, default=1280)
    ap.add_argument('--height', type=int, default=720)
    ap.add_argument('--fps', type=float, default=15.0)
    args = ap.parse_args(argv)

    av_sync._set_pdeathsig(signal.SIGTERM)
    if args.role == 'audio':
        return _run_audio()
    if args.role == 'nut':
        return _run_nut(args)
    return _run_video(args)


if __name__ == '__main__':
    raise SystemExit(main())
