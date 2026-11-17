"""Paired A/V shell pipe synchronizer for NTgCalls MediaSource.SHELL streams.

Holds both the microphone (PCM s16le) and camera (rawvideo yuv420p) FFmpeg
subprocesses behind a shared-memory startup barrier so sample #0 and frame #0
are delivered to NTgCalls at the exact same instant, and recovers from mid-stream
video fetch bursts or decode lag without drifting out of sync.
"""

import argparse
from collections import deque
import ctypes
import fcntl
import json
import mmap
import os
from pathlib import Path
import shlex
import signal
import struct
import subprocess
import sys
import termios
import threading
import time

SHM_DIR = Path('/dev/shm') if Path('/dev/shm').is_dir() else Path('/tmp')
PCM_BYTES_PER_SEC = 48000 * 2 * 2  # 192,000 B/s (48kHz stereo s16le)
AUDIO_PREBUFFER_BYTES = 7680       # 40ms of PCM before startup release
BARRIER_TIMEOUT_SEC = 20.0
VIDEO_CATCHUP_LAG_SEC = 0.180
VIDEO_TARGET_LAG_SEC = 0.035
AUDIO_MAX_LEAD_SEC = 0.145
AUDIO_RESUME_LEAD_SEC = 0.030
VIDEO_MAX_LEAD_SEC = 0.110
VIDEO_RESUME_LEAD_SEC = 0.030
PTS_DISCONTINUITY_SEC = 0.035
SYNC_STARVATION_SEC = 0.280
STALL_HEARTBEAT_TIMEOUT_SEC = 12.0
F_SETPIPE_SZ = 1031
TARGET_AUDIO_PIPE_BYTES = 32768    # ~170ms PCM (>1x 100ms ntgcalls burst) without starving readers
TIMED_PKT_MAGIC = b'LNF1'
TIMED_PKT_STRUCT = struct.Struct('<4sqQI')
_FIONREAD_BUF = ctypes.c_int(0)


def _pipe_unread_bytes(fd):
    try:
        fcntl.ioctl(fd, termios.FIONREAD, _FIONREAD_BUF, True)
        return max(0, int(_FIONREAD_BUF.value))
    except Exception:
        return 0


class SyncState(ctypes.Structure):
    _fields_ = [
        ('audio_state', ctypes.c_int32),   # 0=init, 1=ready, 2=eof/closed
        ('video_state', ctypes.c_int32),   # 0=init, 1=ready, 2=eof/closed
        ('done_mask', ctypes.c_int32),     # bit 1=audio finished, bit 2=video finished
        ('sub_gen', ctypes.c_int32),       # monotonic generation counter for hot subtitle reloads
        ('audio_sec', ctypes.c_double),
        ('video_sec', ctypes.c_double),
        ('video_hb_mono', ctypes.c_double),
        ('audio_hb_mono', ctypes.c_double),
        ('paused', ctypes.c_int32),
        ('waiting_mask', ctypes.c_int32),  # bit 1=audio clamped, bit 2=video clamped
        ('video_target_sec', ctypes.c_double),
        ('epoch_pts_sec', ctypes.c_double),
        ('epoch_mono', ctypes.c_double),
        ('sync_flags', ctypes.c_int32),    # bit 1=audio_syncing, bit 2=video_syncing, bit 4=paused_hud_once
        ('skew_ms', ctypes.c_int32),       # signed (audio_sec - video_sec) in milliseconds
        ('pipeline_delay_sec', ctypes.c_double),
    ]


def shm_path_for(sync_id):
    safe = ''.join(ch if ch.isalnum() or ch in '-_' else '_' for ch in str(sync_id or 'default'))[:64]
    return SHM_DIR / f'lancy-av-{safe}.shm'


def sub_config_path_for(sync_id):
    safe = ''.join(ch if ch.isalnum() or ch in '-_' else '_' for ch in str(sync_id or 'default'))[:64]
    return SHM_DIR / f'lancy-sub-{safe}.json'


def substatus_path_for(sync_id):
    safe = ''.join(ch if ch.isalnum() or ch in '-_' else '_' for ch in str(sync_id or 'default'))[:64]
    return SHM_DIR / f'lancy-substatus-{safe}.json'


def cleanup_stale_shm(max_age_sec=21600):
    try:
        now = time.time()
        for pat in ('lancy-av-*.shm', 'lancy-sub-*.json', 'lancy-substatus-*.json'):
            for p in SHM_DIR.glob(pat):
                try:
                    if now - p.stat().st_mtime > max_age_sec:
                        p.unlink(missing_ok=True)
                except Exception:
                    pass
    except Exception:
        pass


def _set_pdeathsig(sig):
    try:
        libc = ctypes.CDLL(None)
        libc.prctl(1, int(sig))  # PR_SET_PDEATHSIG = 1
    except Exception:
        pass


def _open_sync_state(shm_path):
    size = ctypes.sizeof(SyncState)
    fd = os.open(str(shm_path), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        st = os.fstat(fd)
        if st.st_size < size:
            os.ftruncate(fd, size)
    except Exception:
        os.close(fd)
        raise
    mm = mmap.mmap(fd, size, mmap.MAP_SHARED, mmap.PROT_READ | mmap.PROT_WRITE)
    state = SyncState.from_buffer(mm)
    return fd, mm, state


def _read_exact(stream, size):
    buf = bytearray()
    while len(buf) < size:
        chunk = stream.read(size - len(buf))
        if not chunk:
            break
        buf.extend(chunk)
    return bytes(buf)


def _write_all(out, data):
    view = memoryview(data)
    written = 0
    while written < len(view):
        n = out.write(view[written:])
        if n is None:
            written = len(view)
        elif n <= 0:
            raise BrokenPipeError('stdout closed')
        else:
            written += n
    out.flush()


def _parse_cmd_tokens(raw_cmd):
    toks = list(raw_cmd or [])
    if toks and toks[0] == '--':
        toks = toks[1:]
    if len(toks) == 1 and ' ' in toks[0]:
        return shlex.split(toks[0])
    return toks


def _wait_for_barrier(state, role, stop_ev):
    t0 = time.monotonic()
    while not stop_ev.is_set():
        a_st = int(state.audio_state)
        v_st = int(state.video_state)
        if a_st != 0 and v_st != 0:
            return
        if (time.monotonic() - t0) >= BARRIER_TIMEOUT_SEC:
            return
        time.sleep(0.004)


class _PrefixStream:
    """Prepends already-peeked header bytes seamlessly ahead of a blocking binary stream."""

    def __init__(self, prefix, stream):
        self._buf = bytearray(prefix)
        self._stream = stream

    def read(self, n=-1):
        if self._buf:
            if n is None or n < 0 or n >= len(self._buf):
                head = bytes(self._buf)
                self._buf.clear()
                if n is not None and n > len(head):
                    tail = self._stream.read(n - len(head))
                    return head + (tail or b'')
                return head
            head = bytes(self._buf[:n])
            del self._buf[:n]
            return head
        return self._stream.read(n)


def _read_next_timed_packet(stream):
    hdr = _read_exact(stream, TIMED_PKT_STRUCT.size)
    if len(hdr) < TIMED_PKT_STRUCT.size:
        return None
    magic, pts_us, dur_us, plen = TIMED_PKT_STRUCT.unpack(hdr)
    if magic != TIMED_PKT_MAGIC:
        raise ValueError(f'Corrupt timed stream packet magic={magic!r}')
    payload = _read_exact(stream, plen) if plen > 0 else b''
    if len(payload) < plen:
        return None
    return (pts_us / 1_000_000.0, dur_us / 1_000_000.0, payload)


def _open_input_adapter(stream):
    """Auto-detect LNF1 timed packet framing vs legacy raw byte pipes."""
    head4 = _read_exact(stream, 4)
    if len(head4) < 4 or head4 != TIMED_PKT_MAGIC:
        return False, None, _PrefixStream(head4, stream)
    rest = _read_exact(stream, TIMED_PKT_STRUCT.size - 4)
    if len(rest) < (TIMED_PKT_STRUCT.size - 4):
        return False, None, _PrefixStream(head4 + rest, stream)
    magic, pts_us, dur_us, plen = TIMED_PKT_STRUCT.unpack(head4 + rest)
    if (
        magic == TIMED_PKT_MAGIC
        and 0 <= plen <= 32_000_000
        and -10_000_000 <= pts_us <= 86_400_000_000
        and dur_us <= 10_000_000
    ):
        payload = _read_exact(stream, plen) if plen > 0 else b''
        if len(payload) < plen:
            return True, None, stream
        return True, (pts_us / 1_000_000.0, dur_us / 1_000_000.0, payload), stream
    return False, None, _PrefixStream(head4 + rest, stream)


def _wait_if_paused(state, stop_ev):
    while int(state.paused) == 1 and not stop_ev.is_set():
        now_m = time.monotonic()
        state.audio_hb_mono = now_m
        state.video_hb_mono = now_m
        time.sleep(0.025)


def _run_audio_timed(proc, first_pkt, stream, state, stop_ev, sample_rate, channels, *, sub_monitor=None):
    bps = max(1, int(sample_rate) * int(channels) * 2)
    sample_align = max(2, int(channels) * 2)

    init_chunks = []
    init_bytes = 0
    first_pts = 0.0
    next_expected_pts = None

    def _consume_pkt(pkt, acc):
        nonlocal first_pts, next_expected_pts, init_bytes
        p_pts, p_dur, payload = pkt
        usable = len(payload) - (len(payload) % sample_align)
        if usable <= 0:
            return
        body = payload[:usable]
        if next_expected_pts is None:
            first_pts = p_pts
            next_expected_pts = p_pts + (usable / float(bps))
            acc.append((p_pts, body))
            init_bytes += usable
            return
        gap = p_pts - next_expected_pts
        if gap > PTS_DISCONTINUITY_SEC:
            pad_len = min(int(round(gap * bps)), bps * 2)
            pad_len -= (pad_len % sample_align)
            if pad_len > 0:
                acc.append((next_expected_pts, b'\x00' * pad_len))
                init_bytes += pad_len
        elif gap < -PTS_DISCONTINUITY_SEC:
            skip = min(usable, int(round((-gap) * bps)))
            skip -= (skip % sample_align)
            body = body[skip:]
            p_pts += skip / float(bps)
            if not body:
                return
        next_expected_pts = p_pts + (len(body) / float(bps))
        acc.append((p_pts, body))
        init_bytes += len(body)

    if first_pkt is not None:
        _consume_pkt(first_pkt, init_chunks)
    while not stop_ev.is_set() and init_bytes < AUDIO_PREBUFFER_BYTES:
        nxt = _read_next_timed_packet(stream)
        if nxt is None:
            break
        _consume_pkt(nxt, init_chunks)

    state.audio_hb_mono = time.monotonic()
    state.audio_state = 1 if init_chunks else 2
    _wait_for_barrier(state, 'audio', stop_ev)
    if not init_chunks or stop_ev.is_set():
        return
    state.epoch_mono = time.monotonic()
    # Align initial audio PTS to video epoch_pts_sec set before barrier so A/V start on identical sample #0.
    target_epoch = float(getattr(state, 'epoch_pts_sec', 0.0) or 0.0)
    if target_epoch >= 0.020:
        if first_pts < target_epoch - 0.020:
            trim_bytes = int(round((target_epoch - first_pts) * bps))
            trim_bytes -= (trim_bytes % sample_align)
            while init_chunks and trim_bytes > 0:
                sp, sb = init_chunks[0]
                if len(sb) <= trim_bytes:
                    trim_bytes -= len(sb)
                    first_pts = sp + (len(sb) / float(bps))
                    init_chunks.pop(0)
                else:
                    init_chunks[0] = (sp + (trim_bytes / float(bps)), sb[trim_bytes:])
                    first_pts = sp + (trim_bytes / float(bps))
                    trim_bytes = 0
        elif first_pts > target_epoch + 0.020:
            pad_bytes = min(int(round((first_pts - target_epoch) * bps)), bps * 10)
            pad_bytes -= (pad_bytes % sample_align)
            if pad_bytes > 0:
                init_chunks.insert(0, (target_epoch, b'\x00' * pad_bytes))
                first_pts = target_epoch

    out = sys.stdout.buffer
    out_fd = out.fileno()
    try:
        fcntl.fcntl(out_fd, F_SETPIPE_SZ, TARGET_AUDIO_PIPE_BYTES)
    except Exception:
        pass

    dq = deque()
    cond = threading.Condition()
    eof_flag = False

    def reader_loop():
        nonlocal eof_flag, next_expected_pts
        try:
            while not stop_ev.is_set():
                pkt = _read_next_timed_packet(stream)
                if pkt is None:
                    break
                p_pts, _p_dur, payload = pkt
                usable = len(payload) - (len(payload) % sample_align)
                if usable <= 0:
                    continue
                body = payload[:usable]
                out_pkts = []
                if next_expected_pts is not None:
                    gap = p_pts - next_expected_pts
                    if gap > PTS_DISCONTINUITY_SEC:
                        pad_len = min(int(round(gap * bps)), bps * 2)
                        pad_len -= (pad_len % sample_align)
                        if pad_len > 0:
                            out_pkts.append((next_expected_pts, b'\x00' * pad_len))
                    elif gap < -PTS_DISCONTINUITY_SEC:
                        skip = min(usable, int(round((-gap) * bps)))
                        skip -= (skip % sample_align)
                        body = body[skip:]
                        p_pts += skip / float(bps)
                if body:
                    next_expected_pts = p_pts + (len(body) / float(bps))
                    out_pkts.append((p_pts, body))
                with cond:
                    for op in out_pkts:
                        while len(dq) >= 12 and not stop_ev.is_set():
                            cond.wait(timeout=0.04)
                        if stop_ev.is_set():
                            break
                        dq.append(op)
                    cond.notify_all()
        except Exception:
            pass
        finally:
            with cond:
                eof_flag = True
                cond.notify_all()

    t_reader = threading.Thread(target=reader_loop, daemon=True)
    t_reader.start()

    try:
        silence_since_last_real = 0

        def _update_audio_clock(end_sec):
            unread_b = _pipe_unread_bytes(out_fd)
            real_unread_b = max(0, unread_b - silence_since_last_real)
            val = max(0.0, end_sec - (real_unread_b / float(bps)))
            if val >= float(state.audio_sec or 0.0):
                state.audio_sec = val
            return float(state.audio_sec)

        last_emitted_end = first_pts
        for seg_pts, seg_body in init_chunks:
            _write_all(out, seg_body)
            silence_since_last_real = 0
            if sub_monitor is not None:
                sub_monitor.feed_pcm(seg_pts, seg_body)
            last_emitted_end = seg_pts + (len(seg_body) / float(bps))
        _update_audio_clock(last_emitted_end)
        state.audio_hb_mono = time.monotonic()

        while not stop_ev.is_set():
            if int(state.paused) == 1:
                _wait_if_paused(state, stop_ev)
                continue
            silence_sz = max(sample_align, (bps // 50) - ((bps // 50) % sample_align))
            silence_buf = b'\x00' * silence_sz
            last_sync_silence = 0.0
            dq_wait_started = None
            try:
                while True:
                    with cond:
                        if dq or eof_flag or stop_ev.is_set():
                            break
                        if int(state.paused) == 1:
                            dq_wait_started = None
                        else:
                            now_m = time.monotonic()
                            if dq_wait_started is None:
                                dq_wait_started = now_m
                            if proc.poll() is None:
                                state.audio_hb_mono = now_m
                            cur_a_clk = _update_audio_clock(last_emitted_end)
                            state.skew_ms = int(round((cur_a_clk - float(state.video_sec)) * 1000.0))
                            need_starve_hold = (
                                int(state.video_state) == 1
                                and (now_m - dq_wait_started) >= SYNC_STARVATION_SEC
                            )
                        cond.wait(timeout=0.02 if (dq_wait_started is not None and int(state.paused) != 1) else 0.03)
                    if int(state.paused) == 1:
                        state.sync_flags = int(state.sync_flags) & ~1
                        _wait_if_paused(state, stop_ev)
                        continue
                    with cond:
                        if dq or eof_flag or stop_ev.is_set():
                            break
                    now_m = time.monotonic()
                    if int(state.video_state) == 1 and dq_wait_started is not None and (now_m - dq_wait_started) >= SYNC_STARVATION_SEC:
                        state.sync_flags = int(state.sync_flags) | 1
                        if (now_m - last_sync_silence) >= 0.020:
                            pre_unread = _pipe_unread_bytes(out_fd)
                            _write_all(out, silence_buf)
                            silence_since_last_real = min(silence_since_last_real, pre_unread) + len(silence_buf)
                            last_sync_silence = time.monotonic()
                            state.audio_hb_mono = last_sync_silence
                with cond:
                    if not dq and (eof_flag or stop_ev.is_set()):
                        break
                    if not dq:
                        continue
                    pkt_pts, pkt_body = dq.popleft()
                    if int(state.video_state) == 1:
                        v_live = float(state.video_sec)
                        pkt_end_cand = pkt_pts + (len(pkt_body) / float(bps))
                        if (v_live - pkt_end_cand) > VIDEO_CATCHUP_LAG_SEC:
                            while dq and (v_live - (pkt_pts + (len(pkt_body) / float(bps)))) > VIDEO_TARGET_LAG_SEC:
                                pkt_pts, pkt_body = dq.popleft()
                    cond.notify_all()
            finally:
                state.sync_flags = int(state.sync_flags) & ~1

            wait_started = None
            pkt_end = pkt_pts + (len(pkt_body) / float(bps))
            try:
                while not stop_ev.is_set() and int(state.video_state) == 1:
                    if int(state.paused) == 1:
                        _wait_if_paused(state, stop_ev)
                        wait_started = None
                        continue
                    consumed_a = _update_audio_clock(last_emitted_end)
                    now_m = time.monotonic()
                    if proc.poll() is None:
                        state.audio_hb_mono = now_m
                    unread_real_s = max(0, _pipe_unread_bytes(out_fd) - silence_since_last_real) / float(bps)
                    cur_a = max(consumed_a, pkt_end - unread_real_s)
                    cur_v = float(state.video_sec)
                    state.skew_ms = int(round((cur_a - cur_v) * 1000.0))
                    limit = AUDIO_MAX_LEAD_SEC if wait_started is None else AUDIO_RESUME_LEAD_SEC
                    v_waiting = (int(state.waiting_mask) & 2) != 0
                    v_syncing = (int(state.sync_flags) & 2) != 0
                    if not v_syncing and ((v_waiting and consumed_a < float(state.video_target_sec)) or (cur_a - cur_v) <= limit):
                        break
                    if wait_started is None:
                        wait_started = now_m
                        last_sync_silence = now_m - 0.020
                    if v_syncing or (now_m - wait_started) >= SYNC_STARVATION_SEC:
                        if (now_m - last_sync_silence) >= 0.020:
                            pre_unread = _pipe_unread_bytes(out_fd)
                            _write_all(out, silence_buf)
                            silence_since_last_real = min(silence_since_last_real, pre_unread) + len(silence_buf)
                            last_sync_silence += 0.020
                            if (time.monotonic() - last_sync_silence) > 0.060:
                                last_sync_silence = time.monotonic()
                            state.audio_hb_mono = time.monotonic()
                    time.sleep(0.005)
            finally:
                pass

            if int(state.paused) == 1:
                _wait_if_paused(state, stop_ev)
            if stop_ev.is_set():
                break
            _write_all(out, pkt_body)
            silence_since_last_real = 0
            if sub_monitor is not None:
                sub_monitor.feed_pcm(pkt_pts, pkt_body)
            last_emitted_end = pkt_end
            cur_a_clk = _update_audio_clock(last_emitted_end)
            state.audio_hb_mono = time.monotonic()
            state.skew_ms = int(round((cur_a_clk - float(state.video_sec)) * 1000.0))
    except BrokenPipeError:
        stop_ev.set()
        with cond:
            cond.notify_all()
    finally:
        state.audio_state = 2
        with cond:
            cond.notify_all()
        t_reader.join(timeout=0.5)


def _run_audio(proc, state, stop_ev, sample_rate, channels, *, sub_monitor=None):
    is_timed, first_pkt, stream = _open_input_adapter(proc.stdout)
    if is_timed:
        return _run_audio_timed(proc, first_pkt, stream, state, stop_ev, sample_rate, channels, sub_monitor=sub_monitor)
    bps = max(1, int(sample_rate) * int(channels) * 2)
    sample_align = max(2, int(channels) * 2)
    first_chunks = bytearray()
    while not stop_ev.is_set() and len(first_chunks) < AUDIO_PREBUFFER_BYTES:
        chunk = stream.read(AUDIO_PREBUFFER_BYTES - len(first_chunks))
        if not chunk:
            break
        first_chunks.extend(chunk)

    aligned_len = len(first_chunks) - (len(first_chunks) % sample_align)
    first_buf = bytes(first_chunks[:aligned_len])
    tail_buf = bytes(first_chunks[aligned_len:])
    state.audio_hb_mono = time.monotonic()
    state.audio_state = 1 if first_buf else 2

    _wait_for_barrier(state, 'audio', stop_ev)
    if not first_buf or stop_ev.is_set():
        return

    out = sys.stdout.buffer
    out_fd = out.fileno()
    try:
        fcntl.fcntl(out_fd, F_SETPIPE_SZ, TARGET_AUDIO_PIPE_BYTES)
    except Exception:
        pass

    chunk_sz = max(sample_align, (bps // 50) - ((bps // 50) % sample_align))  # ~20ms PCM
    dq = deque()
    cond = threading.Condition()
    eof_flag = False
    carry = bytearray(tail_buf)

    def reader_loop():
        nonlocal eof_flag
        try:
            while not stop_ev.is_set():
                raw = stream.read(chunk_sz)
                if not raw:
                    if carry:
                        rem = len(carry) - (len(carry) % sample_align)
                        if rem > 0:
                            with cond:
                                dq.append(bytes(carry[:rem]))
                                cond.notify_all()
                    break
                carry.extend(raw)
                emit_len = len(carry) - (len(carry) % sample_align)
                if emit_len <= 0:
                    continue
                pkt = bytes(carry[:emit_len])
                del carry[:emit_len]
                with cond:
                    while len(dq) >= 24 and not stop_ev.is_set():
                        cond.wait(timeout=0.04)
                    if stop_ev.is_set():
                        break
                    dq.append(pkt)
                    cond.notify_all()
        finally:
            with cond:
                eof_flag = True
                cond.notify_all()

    t_reader = threading.Thread(target=reader_loop, daemon=True)
    t_reader.start()

    bytes_sent = 0
    try:
        _write_all(out, first_buf)
        if sub_monitor is not None:
            sub_monitor.feed_pcm(0.0, first_buf)
        bytes_sent += len(first_buf)
        state.audio_sec = max(0.0, (bytes_sent - _pipe_unread_bytes(out_fd)) / float(bps))
        state.audio_hb_mono = time.monotonic()

        while not stop_ev.is_set():
            if int(state.paused) == 1:
                _wait_if_paused(state, stop_ev)
                continue
            with cond:
                while not dq and not eof_flag and not stop_ev.is_set():
                    if proc.poll() is None:
                        state.audio_hb_mono = time.monotonic()
                    state.audio_sec = max(0.0, (bytes_sent - _pipe_unread_bytes(out_fd)) / float(bps))
                    cond.wait(timeout=0.03)
                if not dq and (eof_flag or stop_ev.is_set()):
                    break
                if not dq:
                    continue
                pkt = dq.popleft()
                if int(state.video_state) == 1 and float(state.video_sec or 0.0) > 0.0:
                    cur_pkt_sec = (bytes_sent + len(pkt)) / float(bps)
                    if (float(state.video_sec) - cur_pkt_sec) > VIDEO_CATCHUP_LAG_SEC:
                        while dq and (float(state.video_sec) - ((bytes_sent + len(pkt)) / float(bps))) > VIDEO_TARGET_LAG_SEC:
                            bytes_sent += len(pkt)
                            pkt = dq.popleft()
                cond.notify_all()

            # Bidirectional lead clamp: hold audio cleanly whenever video is still alive & trailing
            wait_started = None
            silence_sz = max(sample_align, (bps // 50) - ((bps // 50) % sample_align))
            silence_buf = b'\x00' * silence_sz
            last_sync_silence = 0.0
            silence_bytes = 0
            while not stop_ev.is_set() and int(state.video_state) == 1:
                if int(state.paused) == 1:
                    _wait_if_paused(state, stop_ev)
                    wait_started = None
                    continue
                consumed_a = max(0.0, (bytes_sent - max(0, _pipe_unread_bytes(out_fd) - silence_bytes)) / float(bps))
                state.audio_sec = consumed_a
                now_m = time.monotonic()
                if proc.poll() is None:
                    state.audio_hb_mono = now_m
                cur_a = max(consumed_a, ((bytes_sent + len(pkt)) - max(0, _pipe_unread_bytes(out_fd) - silence_bytes)) / float(bps))
                cur_v = float(state.video_sec)
                state.skew_ms = int(round((cur_a - cur_v) * 1000.0))
                limit = AUDIO_MAX_LEAD_SEC if wait_started is None else AUDIO_RESUME_LEAD_SEC
                v_waiting = (int(state.waiting_mask) & 2) != 0
                if (v_waiting and consumed_a < float(state.video_target_sec)) or (cur_a - cur_v) <= limit:
                    break
                if wait_started is None:
                    wait_started = now_m
                    last_sync_silence = now_m - 0.020
                if (now_m - wait_started) >= SYNC_STARVATION_SEC and (now_m - last_sync_silence) >= 0.020:
                    pre_unread = _pipe_unread_bytes(out_fd)
                    _write_all(out, silence_buf)
                    silence_bytes = min(silence_bytes, pre_unread) + len(silence_buf)
                    last_sync_silence += 0.020
                    if (time.monotonic() - last_sync_silence) > 0.060:
                        last_sync_silence = time.monotonic()
                time.sleep(0.005)

            if int(state.paused) == 1:
                _wait_if_paused(state, stop_ev)
            if stop_ev.is_set():
                break
            _write_all(out, pkt)
            if sub_monitor is not None:
                sub_monitor.feed_pcm(bytes_sent / float(bps), pkt)
            bytes_sent += len(pkt)
            state.audio_sec = max(0.0, (bytes_sent - max(0, _pipe_unread_bytes(out_fd) - silence_bytes)) / float(bps))
            state.audio_hb_mono = time.monotonic()
            state.skew_ms = int(round((float(state.audio_sec) - float(state.video_sec)) * 1000.0))
    except BrokenPipeError:
        stop_ev.set()
        with cond:
            cond.notify_all()
    finally:
        state.audio_state = 2
        with cond:
            cond.notify_all()
        t_reader.join(timeout=0.5)


_SUBOVERLAY_LIB = None
_SUB_ALIGN = None


def _load_suboverlay_lib():
    global _SUBOVERLAY_LIB, _SUB_ALIGN
    if _SUBOVERLAY_LIB is not None:
        return _SUBOVERLAY_LIB, _SUB_ALIGN
    voice_dir = Path(__file__).resolve().parent
    so_path = voice_dir / '_suboverlay.so'
    if not so_path.is_file():
        return None, None
    try:
        if str(voice_dir) not in sys.path:
            sys.path.insert(0, str(voice_dir))
        import sub_align as _sa
        lib = ctypes.CDLL(str(so_path))
        lib.sub_create.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_char_p]
        lib.sub_create.restype = ctypes.c_void_p
        lib.sub_load_ass_mem.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_size_t]
        lib.sub_load_ass_mem.restype = ctypes.c_int
        lib.sub_render_yuv420.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_longlong]
        lib.sub_render_yuv420.restype = ctypes.c_int
        for opt_name, argtypes, restype in (
            ('sub_load_hud_ass_mem', [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_size_t], ctypes.c_int),
            ('sub_dim_yuv420', [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int], None),
            ('sub_render_hud_yuv420', [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_longlong], ctypes.c_int),
        ):
            fn = getattr(lib, opt_name, None)
            if fn is not None:
                fn.argtypes = argtypes
                fn.restype = restype
        lib.sub_destroy.argtypes = [ctypes.c_void_p]
        lib.sub_destroy.restype = None
        _SUBOVERLAY_LIB = lib
        _SUB_ALIGN = _sa
        return lib, _sa
    except Exception:
        return None, None


def _format_hud_clock(sec):
    total = max(0, int(round(float(sec or 0.0))))
    h = total // 3600
    m = (total % 3600) // 60
    s = total % 60
    return f'{h}:{m:02d}:{s:02d}' if h > 0 else f'{m:02d}:{s:02d}'


def _build_hud_ass_bytes(width, height, *, mode, pos_sec):
    w = max(320, int(width))
    h = max(180, int(height))
    is_pause = (mode == 'paused')
    font_sz = max(18, min(54, int(round(h * (0.044 if is_pause else 0.030)))))
    margin_v = max(12, int(round(h * 0.05)))
    border_w = max(8, int(round(font_sz * 0.36)))
    align = 5 if is_pause else 8
    text = f'II  PAUSED  ·  {_format_hud_clock(pos_sec)}' if is_pause else 'SYNCING A/V…'
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
        f'Style: HUD,DejaVu Sans,{font_sz},&H00FFFFFF,&H00FFFFFF,&H00121822,&HC80B0F17,-1,0,0,0,100,100,0.4,0,3,{border_w},0,{align},20,20,{margin_v},1\n\n'
        '[Events]\n'
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'
        f'Dialogue: 10,0:00:00.00,9:59:59.00,HUD,,0,0,0,,{text}\n'
    )
    return ass.encode('utf-8'), text


class SubOverlay:
    """Zero-restart libass YUV420p compositor hot-reloaded from shm state & JSON config."""

    def __init__(self, config_path, state, width, height, frame_bytes):
        self.config_path = Path(config_path)
        self.state = state
        self.width = int(width)
        self.height = int(height)
        self.frame_bytes = int(frame_bytes)
        self._lib, self._sa = _load_suboverlay_lib()
        self._ctx = self._lib.sub_create(self.width, self.height, None) if self._lib else None
        self._c_buf = (ctypes.c_uint8 * self.frame_bytes)() if self._ctx else None
        self._last_gen = -1
        self._last_stat_mono = 0.0
        self._cfg_sig = None
        self._active = False
        self._loaded_path = ''
        self._loaded_mtime = -1
        self._loaded_spans = []
        self._base_sec = 0.0
        self._sub_offset = 0.0
        self._drift_rate = 0.0
        self._drift_anchor = 0.0
        self._render_screen = True
        self._pts_anchored = False
        self._hud_key = None
        self._refresh(force=True)

    def close(self):
        if self._lib and self._ctx:
            try:
                self._lib.sub_destroy(self._ctx)
            except Exception:
                pass
        self._ctx = None
        self.state = None

    def _refresh(self, force=False):
        if not self._ctx or not self._sa:
            return
        cur_gen = int(self.state.sub_gen)
        now = time.monotonic()
        if not force and cur_gen == self._last_gen and (now - self._last_stat_mono) < 0.35:
            return
        self._last_gen = cur_gen
        self._last_stat_mono = now
        try:
            st = self.config_path.stat()
        except OSError:
            return
        sig = (cur_gen, st.st_mtime_ns, st.st_size)
        if not force and sig == self._cfg_sig:
            return
        try:
            cfg = json.loads(self.config_path.read_text(encoding='utf-8'))
        except Exception:
            return
        self._cfg_sig = sig

        self._base_sec = float(cfg.get('base_sec') or 0.0)
        self._sub_offset = float(cfg.get('subtitle_offset') or 0.0)
        self._drift_rate = self._sa.clamp_drift_rate(cfg.get('drift_sec_per_sec') or 0.0)
        self._drift_anchor = float(cfg.get('drift_anchor_sec') or 0.0)
        self._render_screen = bool(cfg.get('render_screen', True))
        self._pts_anchored = bool(cfg.get('pts_anchored', False))
        enabled = bool(cfg.get('enabled', False)) and self._render_screen
        sub_path = str(cfg.get('subtitle_path') or '').strip()
        if not enabled or not sub_path:
            self._active = False
            return

        p = Path(sub_path)
        try:
            pst = p.stat()
        except OSError:
            self._active = False
            return
        if sub_path != self._loaded_path or pst.st_mtime_ns != self._loaded_mtime:
            try:
                ass_bytes, spans = self._sa.subtitles_to_ass(p, width=self.width, height=self.height)
                rc = self._lib.sub_load_ass_mem(self._ctx, ass_bytes, len(ass_bytes))
            except Exception:
                rc = -1
                spans = []
            if rc != 0:
                self._active = False
                return
            self._loaded_path = sub_path
            self._loaded_mtime = pst.st_mtime_ns
            self._loaded_spans = spans

        self._active = bool(self._loaded_spans)

    def _rel_pts_adjusted(self, rel_pts_sec):
        epoch = max(0.0, float(getattr(self.state, 'epoch_pts_sec', 0.0) or 0.0)) if self.state is not None else 0.0
        return max(0.0, float(rel_pts_sec) - epoch)

    def render(self, frame_buf, rel_pts_sec):
        self._refresh()
        if not self._active or not self._ctx or self._c_buf is None:
            return frame_buf
        eff_rel = self._rel_pts_adjusted(rel_pts_sec)
        pts_ms = self._sa.map_media_sec_to_sub_ms(
            self._base_sec + eff_rel,
            subtitle_offset=self._sub_offset,
            drift_sec_per_sec=self._drift_rate,
            drift_anchor_sec=self._drift_anchor,
        )
        if pts_ms < 0 or not self._sa.has_active_cue_near(self._loaded_spans, pts_ms, margin_ms=40):
            return frame_buf
        if len(frame_buf) != self.frame_bytes:
            return frame_buf
        ctypes.memmove(self._c_buf, frame_buf, self.frame_bytes)
        rc = self._lib.sub_render_yuv420(
            self._ctx,
            ctypes.cast(self._c_buf, ctypes.c_void_p),
            self.width,
            self.height,
            pts_ms,
        )
        return self._c_buf if rc == 1 else frame_buf

    def render_hud(self, frame_buf, rel_pts_sec=0.0, *, mode='paused', dim_factor=None):
        """Render dimmed frame + frozen subtitle (if any) + crisp PAUSED/SYNCING pill overlay."""
        self._refresh()
        if not self._ctx or self._c_buf is None or len(frame_buf) != self.frame_bytes:
            return frame_buf
        hud_load = getattr(self._lib, 'sub_load_hud_ass_mem', None)
        hud_render = getattr(self._lib, 'sub_render_hud_yuv420', None)
        dim_fn = getattr(self._lib, 'sub_dim_yuv420', None)
        if hud_load is None or hud_render is None:
            return self.render(frame_buf, rel_pts_sec)

        eff_rel = self._rel_pts_adjusted(rel_pts_sec)
        ctypes.memmove(self._c_buf, frame_buf, self.frame_bytes)
        c_ptr = ctypes.cast(self._c_buf, ctypes.c_void_p)
        if dim_fn is not None:
            eff_dim = int(dim_factor) if dim_factor is not None else (164 if mode == 'paused' else 212)
            dim_fn(c_ptr, self.width, self.height, eff_dim)
        if self._active and self._sa is not None:
            pts_ms = self._sa.map_media_sec_to_sub_ms(
                self._base_sec + eff_rel,
                subtitle_offset=self._sub_offset,
                drift_sec_per_sec=self._drift_rate,
                drift_anchor_sec=self._drift_anchor,
            )
            if pts_ms >= 0 and self._sa.has_active_cue_near(self._loaded_spans, pts_ms, margin_ms=40):
                self._lib.sub_render_yuv420(self._ctx, c_ptr, self.width, self.height, pts_ms)

        shown_sec = max(0.0, self._base_sec + eff_rel)
        cache_key = (mode, int(shown_sec) if mode == 'paused' else 0, self.width, self.height)
        if cache_key != self._hud_key:
            ass_bytes, _ = _build_hud_ass_bytes(self.width, self.height, mode=mode, pos_sec=shown_sec)
            if hud_load(self._ctx, ass_bytes, len(ass_bytes)) == 0:
                self._hud_key = cache_key
        hud_render(self._ctx, c_ptr, self.width, self.height, 1000)
        return self._c_buf


def _run_video_timed(proc, first_pkt, stream, state, stop_ev, frame_bytes, fps, sub_overlay=None):
    eff_fps = max(1.0, float(fps or 30))
    default_dur = 1.0 / eff_fps
    first_pts, first_dur, first_frame = first_pkt if first_pkt is not None else (0.0, default_dur, b'')
    has_full = (len(first_frame) == frame_bytes)
    if has_full:
        anchored = bool(sub_overlay is not None and getattr(sub_overlay, '_pts_anchored', False))
        state.epoch_pts_sec = (
            0.0
            if (anchored and 0.0 <= float(first_pts) <= 30.0)
            else (max(0.0, float(first_pts)) if float(first_pts) >= 0.05 else 0.0)
        )
    state.video_hb_mono = time.monotonic()
    state.video_state = 1 if has_full else 2

    _wait_for_barrier(state, 'video', stop_ev)
    if not has_full or stop_ev.is_set():
        return

    out = sys.stdout.buffer
    out_fd = out.fileno()
    try:
        fcntl.fcntl(out_fd, F_SETPIPE_SZ, max(131072, min(2097152, max(524288, frame_bytes))))
    except Exception:
        pass
    state.epoch_mono = time.monotonic()
    dq_maxlen = max(10, min(32, int(round(eff_fps))))
    dq = deque()
    cond = threading.Condition()
    eof_flag = False

    def reader_loop():
        nonlocal eof_flag
        try:
            while not stop_ev.is_set():
                pkt = _read_next_timed_packet(stream)
                if pkt is None:
                    break
                p_pts, p_dur, buf = pkt
                if len(buf) != frame_bytes:
                    continue
                eff_d = p_dur if p_dur > 0.001 else default_dur
                with cond:
                    while len(dq) >= dq_maxlen and not stop_ev.is_set():
                        cond.wait(timeout=0.04)
                    if stop_ev.is_set():
                        break
                    dq.append((p_pts, eff_d, buf))
                    cond.notify_all()
        except Exception:
            pass
        finally:
            with cond:
                eof_flag = True
                cond.notify_all()

    t_reader = threading.Thread(target=reader_loop, daemon=True)
    t_reader.start()

    try:
        last_raw_frame = bytes(first_frame)
        last_raw_pts = max(0.0, first_pts)
        hud_tick_interval = max(0.025, min(0.10, default_dur))

        def _maybe_emit_paused_hud():
            if (int(state.sync_flags) & 4) == 0:
                return False
            state.sync_flags = int(state.sync_flags) & ~4
            hud_buf = (
                sub_overlay.render_hud(last_raw_frame, last_raw_pts, mode='paused')
                if sub_overlay is not None
                else last_raw_frame
            )
            _write_all(out, hud_buf)
            state.video_hb_mono = time.monotonic()
            return True

        out_first = sub_overlay.render(first_frame, last_raw_pts) if sub_overlay is not None else first_frame
        _write_all(out, out_first)
        unread_f = _pipe_unread_bytes(out_fd) / float(max(1, frame_bytes))
        eff_first_d = first_dur if first_dur > 0.001 else default_dur
        state.video_sec = max(0.0, first_pts - (unread_f * eff_first_d))
        state.video_hb_mono = time.monotonic()
        state.skew_ms = int(round((float(state.audio_sec) - float(state.video_sec)) * 1000.0))

        catchup_skips = 0
        tail_wall_anchor = None
        tail_pts_anchor = None
        last_sync_hud = 0.0
        while not stop_ev.is_set():
            _maybe_emit_paused_hud()
            if int(state.paused) == 1:
                _wait_if_paused(state, stop_ev)
                tail_wall_anchor = None
                continue

            dq_wait_started = None
            sync_flag_held = False
            while not stop_ev.is_set():
                if _maybe_emit_paused_hud() or int(state.paused) == 1:
                    if sync_flag_held:
                        state.sync_flags = int(state.sync_flags) & ~2
                        sync_flag_held = False
                    if int(state.paused) == 1:
                        _wait_if_paused(state, stop_ev)
                        tail_wall_anchor = None
                    dq_wait_started = None
                    continue
                with cond:
                    if not dq and not eof_flag and not stop_ev.is_set():
                        now_m = time.monotonic()
                        if dq_wait_started is None:
                            dq_wait_started = now_m
                        if proc.poll() is None:
                            state.video_hb_mono = now_m
                        cond.wait(timeout=0.025)
                    has_item = bool(dq)
                    is_done = (not dq) and (eof_flag or stop_ev.is_set())
                    if has_item:
                        item_pts, item_dur, item_buf = dq.popleft()
                        if int(state.audio_state) == 1:
                            a_live = float(state.audio_sec)
                            if (a_live - item_pts) > VIDEO_CATCHUP_LAG_SEC:
                                while dq and (float(state.audio_sec) - item_pts) > VIDEO_TARGET_LAG_SEC:
                                    item_pts, item_dur, item_buf = dq.popleft()
                                    catchup_skips += 1
                                if (float(state.audio_sec) - item_pts) > VIDEO_CATCHUP_LAG_SEC and not dq and not eof_flag and catchup_skips < 3:
                                    catchup_skips += 1
                                    cond.notify_all()
                                    if proc.poll() is None:
                                        state.video_hb_mono = time.monotonic()
                                    has_item = False
                        if has_item:
                            catchup_skips = 0
                        cond.notify_all()
                if is_done:
                    if sync_flag_held:
                        state.sync_flags = int(state.sync_flags) & ~2
                    item_pts = None
                    break
                if has_item:
                    if sync_flag_held:
                        state.sync_flags = int(state.sync_flags) & ~2
                    break
                now_m = time.monotonic()
                if int(state.audio_state) == 1 and dq_wait_started is not None and (now_m - dq_wait_started) >= SYNC_STARVATION_SEC:
                    state.sync_flags = int(state.sync_flags) | 2
                    sync_flag_held = True
                    state.skew_ms = int(round((float(state.audio_sec) - last_raw_pts) * 1000.0))
                    if (now_m - last_sync_hud) >= hud_tick_interval:
                        hud_buf = (
                            sub_overlay.render_hud(last_raw_frame, last_raw_pts, mode='syncing')
                            if sub_overlay is not None
                            else last_raw_frame
                        )
                        _write_all(out, hud_buf)
                        last_sync_hud = time.monotonic()
                        state.video_hb_mono = last_sync_hud
            if item_pts is None or stop_ev.is_set():
                break

            state.video_target_sec = item_pts
            wait_started = None
            try:
                while not stop_ev.is_set() and int(state.audio_state) == 1:
                    _maybe_emit_paused_hud()
                    if int(state.paused) == 1:
                        state.waiting_mask = int(state.waiting_mask) & ~2
                        _wait_if_paused(state, stop_ev)
                        wait_started = None
                        continue
                    a_live = float(state.audio_sec)
                    state.skew_ms = int(round((a_live - item_pts) * 1000.0))
                    limit = VIDEO_MAX_LEAD_SEC if wait_started is None else VIDEO_RESUME_LEAD_SEC
                    a_starved = (int(state.sync_flags) & 1) != 0
                    if (item_pts - a_live) <= limit and not a_starved:
                        break
                    state.waiting_mask = int(state.waiting_mask) | 2
                    now_m = time.monotonic()
                    if wait_started is None:
                        wait_started = now_m
                    if (a_starved or (now_m - wait_started) >= SYNC_STARVATION_SEC) and (now_m - last_sync_hud) >= hud_tick_interval:
                        hud_buf = (
                            sub_overlay.render_hud(last_raw_frame, last_raw_pts, mode='syncing')
                            if sub_overlay is not None
                            else last_raw_frame
                        )
                        _write_all(out, hud_buf)
                        last_sync_hud = time.monotonic()
                    if proc.poll() is None:
                        state.video_hb_mono = time.monotonic()
                    time.sleep(0.004)
            finally:
                state.waiting_mask = int(state.waiting_mask) & ~2

            _maybe_emit_paused_hud()
            if int(state.paused) == 1:
                _wait_if_paused(state, stop_ev)
                tail_wall_anchor = None
            if stop_ev.is_set():
                break

            # Once audio finishes (EOF), keep video paced smoothly at 1x realtime instead of bursting
            if int(state.audio_state) == 2:
                now_m = time.monotonic()
                if tail_wall_anchor is None:
                    tail_wall_anchor = now_m
                    tail_pts_anchor = item_pts
                else:
                    target_wall = tail_wall_anchor + max(0.0, item_pts - tail_pts_anchor)
                    rem = target_wall - now_m
                    if rem > 0.005:
                        time.sleep(min(rem, 0.25))

            _maybe_emit_paused_hud()
            if int(state.paused) == 1:
                _wait_if_paused(state, stop_ev)
                tail_wall_anchor = None
            if stop_ev.is_set():
                break
            last_raw_frame = bytes(item_buf)
            last_raw_pts = max(0.0, item_pts)
            out_buf = sub_overlay.render(item_buf, last_raw_pts) if sub_overlay is not None else item_buf
            _write_all(out, out_buf)
            unread_f = _pipe_unread_bytes(out_fd) / float(max(1, frame_bytes))
            state.video_sec = max(0.0, item_pts - (unread_f * item_dur))
            state.video_hb_mono = time.monotonic()
            state.skew_ms = int(round((float(state.audio_sec) - float(state.video_sec)) * 1000.0))
    except BrokenPipeError:
        stop_ev.set()
        with cond:
            cond.notify_all()
    finally:
        state.video_state = 2
        with cond:
            cond.notify_all()
        t_reader.join(timeout=0.5)


def _run_video(proc, state, stop_ev, frame_bytes, fps, sub_overlay=None):
    is_timed, first_pkt, stream = _open_input_adapter(proc.stdout)
    if is_timed:
        return _run_video_timed(proc, first_pkt, stream, state, stop_ev, frame_bytes, fps, sub_overlay=sub_overlay)
    eff_fps = max(1.0, float(fps or 30))
    first_frame = _read_exact(stream, frame_bytes)
    has_full = len(first_frame) == frame_bytes
    state.video_hb_mono = time.monotonic()
    state.video_state = 1 if has_full else 2

    _wait_for_barrier(state, 'video', stop_ev)
    if not has_full or stop_ev.is_set():
        return

    out = sys.stdout.buffer
    out_fd = out.fileno()
    try:
        fcntl.fcntl(out_fd, F_SETPIPE_SZ, max(131072, min(2097152, max(524288, frame_bytes))))
    except Exception:
        pass
    state.epoch_mono = time.monotonic()
    frames_decoded = 1
    dq_maxlen = max(12, min(48, int(round(eff_fps * 1.5))))
    dq = deque()
    cond = threading.Condition()
    eof_flag = False

    def reader_loop():
        nonlocal frames_decoded, eof_flag
        try:
            while not stop_ev.is_set():
                buf = _read_exact(stream, frame_bytes)
                if len(buf) != frame_bytes:
                    break
                frames_decoded += 1
                media_sec = frames_decoded / eff_fps
                with cond:
                    while len(dq) >= dq_maxlen and not stop_ev.is_set():
                        cond.wait(timeout=0.04)
                    if stop_ev.is_set():
                        break
                    dq.append((media_sec, buf))
                    cond.notify_all()
        finally:
            with cond:
                eof_flag = True
                cond.notify_all()

    t_reader = threading.Thread(target=reader_loop, daemon=True)
    t_reader.start()

    try:
        if sub_overlay is not None:
            first_frame = sub_overlay.render(first_frame, 0.0)
        _write_all(out, first_frame)
        unread_f = _pipe_unread_bytes(out_fd) / float(max(1, frame_bytes))
        state.video_sec = max(0.0, (1.0 - unread_f) / eff_fps)
        state.video_hb_mono = time.monotonic()

        catchup_skips = 0
        while not stop_ev.is_set():
            if int(state.paused) == 1:
                _wait_if_paused(state, stop_ev)
                continue
            with cond:
                while not dq and not eof_flag and not stop_ev.is_set():
                    if proc.poll() is None:
                        state.video_hb_mono = time.monotonic()
                    cond.wait(timeout=0.04)
                if not dq and (eof_flag or stop_ev.is_set()):
                    break
                if not dq:
                    continue
                item_sec, item_buf = dq.popleft()
                if int(state.audio_state) == 1:
                    a_live = float(state.audio_sec)
                    if (a_live - item_sec) > VIDEO_CATCHUP_LAG_SEC:
                        while dq and (float(state.audio_sec) - item_sec) > VIDEO_TARGET_LAG_SEC:
                            item_sec, item_buf = dq.popleft()
                            catchup_skips += 1
                        if (float(state.audio_sec) - item_sec) > VIDEO_CATCHUP_LAG_SEC and not dq and not eof_flag and catchup_skips < 3:
                            catchup_skips += 1
                            cond.notify_all()
                            if proc.poll() is None:
                                state.video_hb_mono = time.monotonic()
                            continue
                catchup_skips = 0
                cond.notify_all()

            # Bidirectional lead clamp: if audio stalled or lagged behind, hold video until audio catches up
            state.video_target_sec = item_sec
            wait_started = None
            try:
                while not stop_ev.is_set() and int(state.audio_state) == 1:
                    if int(state.paused) == 1:
                        state.waiting_mask = int(state.waiting_mask) & ~2
                        _wait_if_paused(state, stop_ev)
                        wait_started = None
                        continue
                    a_live = float(state.audio_sec)
                    state.skew_ms = int(round((a_live - item_sec) * 1000.0))
                    limit = VIDEO_MAX_LEAD_SEC if wait_started is None else VIDEO_RESUME_LEAD_SEC
                    if (item_sec - a_live) <= limit and (int(state.sync_flags) & 1) == 0:
                        break
                    state.waiting_mask = int(state.waiting_mask) | 2
                    now_m = time.monotonic()
                    if wait_started is None:
                        wait_started = now_m
                    if proc.poll() is None:
                        state.video_hb_mono = now_m
                    time.sleep(0.004)
            finally:
                state.waiting_mask = int(state.waiting_mask) & ~2

            if int(state.paused) == 1:
                _wait_if_paused(state, stop_ev)
            if stop_ev.is_set():
                break

            if sub_overlay is not None:
                item_buf = sub_overlay.render(item_buf, max(0.0, item_sec - (1.0 / eff_fps)))
            _write_all(out, item_buf)
            unread_f = _pipe_unread_bytes(out_fd) / float(max(1, frame_bytes))
            state.video_sec = max(0.0, item_sec - (unread_f / eff_fps))
            state.video_hb_mono = time.monotonic()
            state.skew_ms = int(round((float(state.audio_sec) - float(state.video_sec)) * 1000.0))
    except BrokenPipeError:
        stop_ev.set()
        with cond:
            cond.notify_all()
    finally:
        state.video_state = 2
        with cond:
            cond.notify_all()
        t_reader.join(timeout=0.5)


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('--role', required=True, choices=('audio', 'video'))
    parser.add_argument('--sync-id', required=True)
    parser.add_argument('--frame-bytes', type=int, default=0)
    parser.add_argument('--fps', type=float, default=30.0)
    parser.add_argument('--sample-rate', type=int, default=48000)
    parser.add_argument('--channels', type=int, default=2)
    parser.add_argument('--width', type=int, default=0)
    parser.add_argument('--height', type=int, default=0)
    parser.add_argument('--sub-config', default='')
    parser.add_argument('cmd', nargs=argparse.REMAINDER)
    args = parser.parse_args()

    cmd_tokens = _parse_cmd_tokens(args.cmd)
    if not cmd_tokens:
        sys.exit(2)

    _set_pdeathsig(signal.SIGTERM)
    signal.signal(signal.SIGPIPE, signal.SIG_IGN)

    stop_ev = threading.Event()
    role_bit = 1 if args.role == 'audio' else 2
    shm_path = shm_path_for(args.sync_id)
    sub_cfg_path = Path(args.sub_config) if args.sub_config else None
    fd, mm, state = _open_sync_state(shm_path)
    proc = None
    sub_overlay = None
    sub_monitor = None

    def handle_sig(_signum, _frame):
        stop_ev.set()
        if proc and proc.poll() is None:
            try:
                proc.kill()
            except Exception:
                pass

    signal.signal(signal.SIGTERM, handle_sig)
    signal.signal(signal.SIGINT, handle_sig)

    try:
        proc = subprocess.Popen(
            cmd_tokens,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            preexec_fn=lambda: _set_pdeathsig(signal.SIGKILL),
            close_fds=True,
        )
        if args.role == 'audio':
            if sub_cfg_path is not None:
                try:
                    voice_dir = str(Path(__file__).resolve().parent)
                    if voice_dir not in sys.path:
                        sys.path.insert(0, voice_dir)
                    import sub_align as _sa
                    sub_monitor = _sa.LiveSubSyncMonitor(
                        sync_id=args.sync_id,
                        config_path=sub_cfg_path,
                        status_path=substatus_path_for(args.sync_id),
                        state=state,
                        sample_rate=args.sample_rate,
                        channels=args.channels,
                    )
                except Exception as err:
                    print(f'[av_sync] LiveSubSyncMonitor init skipped: {err}', file=sys.stderr)
                    sub_monitor = None
            _run_audio(proc, state, stop_ev, args.sample_rate, args.channels, sub_monitor=sub_monitor)
        else:
            if args.frame_bytes <= 0:
                sys.exit(2)
            if (
                sub_cfg_path is not None
                and args.width > 0
                and args.height > 0
                and (args.width % 2) == 0
                and (args.height % 2) == 0
                and args.frame_bytes == (args.width * args.height * 3) // 2
            ):
                sub_overlay = SubOverlay(sub_cfg_path, state, args.width, args.height, args.frame_bytes)
            _run_video(proc, state, stop_ev, args.frame_bytes, args.fps, sub_overlay=sub_overlay)
    finally:
        stop_ev.set()
        if sub_monitor is not None:
            sub_monitor.close()
        if sub_overlay is not None:
            sub_overlay.close()
        if proc and proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=0.5)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            if args.role == 'audio':
                state.audio_state = 2
            else:
                state.video_state = 2
            state.done_mask = int(state.done_mask) | role_bit
            should_unlink = ((int(state.done_mask) & 3) == 3)
        except Exception:
            should_unlink = False
        finally:
            try:
                fcntl.flock(fd, fcntl.LOCK_UN)
            except Exception:
                pass
        try:
            del state
        except Exception:
            pass
        try:
            mm.close()
        except Exception:
            pass
        try:
            os.close(fd)
        except Exception:
            pass
        if should_unlink:
            for p in (shm_path, sub_cfg_path or sub_config_path_for(args.sync_id), substatus_path_for(args.sync_id)):
                try:
                    p.unlink(missing_ok=True)
                except Exception:
                    pass


if __name__ == '__main__':
    main()
