"""Single-demuxer RTMP hub with live C/libass subtitle compositing and zero-restart hot reload.

Spawns:
1) Decoder FFmpeg reading media once and emitting rawvideo yuv420p (stdout) + s16le 48kHz stereo PCM (extra pipe).
2) Relay threads applying in-place libass YUV420p subtitles via `av_sync.SubOverlay` (hot-reloaded on sub_gen).
3) Encoder FFmpeg muxing H.264 High@4.1 + AAC 192k FLV to Telegram RTMPS (or file in offline tests).
"""
import argparse
from collections import deque
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

VOICE_DIR = Path(__file__).resolve().parent
if str(VOICE_DIR) not in sys.path:
    sys.path.insert(0, str(VOICE_DIR))

import av_hub
import av_sync
import nut_stream
import rtmp_streamer
import sub_align

CHUNK_BYTES = 65536


def _extract_realtime_from_cmd(tokens):
    out = []
    had_re = False
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if tok == '-re':
            had_re = True
            i += 1
            continue
        if tok == '-readrate_initial_burst' and (i + 1) < len(tokens):
            had_re = True
            i += 2
            continue
        out.append(tok)
        i += 1
    return out, had_re


def _drain_stderr(stream, sink_deque, rtmp_target):
    try:
        while True:
            raw = stream.readline()
            if not raw:
                break
            line = raw.decode('utf-8', errors='replace').rstrip()
            if line:
                sink_deque.append(rtmp_streamer.scrub_rtmp_secret(line, rtmp_target))
    except Exception:
        pass
    finally:
        try:
            stream.close()
        except OSError:
            pass


def run_rtmp_hub(
    *,
    sync_id,
    rtmp_target,
    width,
    height,
    fps,
    video_quality='HD_720p',
    vb=None,
    vmax=None,
    vbuf=None,
    preset='veryfast',
    threads=4,
    sub_config_path=None,
    dec_cmd=None,
    no_audio_eof=False,
    realtime=False,
):
    w = max(2, int(width) - (int(width) % 2))
    h = max(2, int(height) - (int(height) % 2))
    eff_fps, _, _ = rtmp_streamer._format_fps(fps)
    frame_bytes = (w * h * 3) // 2

    cmd_tokens = av_sync._parse_cmd_tokens(dec_cmd or [])
    if not cmd_tokens:
        print('[rtmp_hub] missing decoder command', file=sys.stderr)
        return 2
    if not rtmp_target:
        print('[rtmp_hub] missing RTMP target', file=sys.stderr)
        return 2

    av_sync._set_pdeathsig(signal.SIGTERM)

    shm_fd = None
    shm_mm = None
    state = None
    sub_overlay = None
    sub_monitor = None
    dec_proc = None
    enc_proc = None
    dec_aud_r = dec_aud_w = -1
    enc_aud_r = enc_aud_w = -1
    stop_event = threading.Event()
    signal_stop = threading.Event()
    broken_event = threading.Event()
    v_done = threading.Event()
    a_done = threading.Event()
    dec_logs = deque(maxlen=40)
    enc_logs = deque(maxlen=40)

    def _on_signal(_signum, _frame):
        signal_stop.set()
        stop_event.set()
        for p in (dec_proc, enc_proc):
            if p is not None and p.poll() is None:
                try:
                    p.terminate()
                except OSError:
                    pass

    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)

    try:
        shm_fd, shm_mm, state = av_sync._open_sync_state(av_sync.shm_path_for(sync_id))
        cfg_path = Path(sub_config_path) if sub_config_path else av_sync.sub_config_path_for(sync_id)
        try:
            sub_overlay = av_sync.SubOverlay(cfg_path, state, w, h, frame_bytes)
        except Exception as err:
            print(f'[rtmp_hub] SubOverlay init skipped: {err}', file=sys.stderr)
            sub_overlay = None
        if cfg_path is not None and rtmp_streamer.AUDIO_PIPE_PLACEHOLDER not in cmd_tokens:
            try:
                sub_monitor = sub_align.LiveSubSyncMonitor(
                    sync_id=sync_id,
                    config_path=cfg_path,
                    status_path=av_sync.substatus_path_for(sync_id),
                    state=state,
                    sample_rate=48000,
                    channels=2,
                )
            except Exception as err:
                print(f'[rtmp_hub] LiveSubSyncMonitor init skipped: {err}', file=sys.stderr)
                sub_monitor = None

        is_nut = (rtmp_streamer.AUDIO_PIPE_PLACEHOLDER not in cmd_tokens)
        pumps = []

        if is_nut:
            resolved_dec, had_re = _extract_realtime_from_cmd(cmd_tokens)
            enc_realtime = bool(realtime or had_re)
            enc_aud_r, enc_aud_w = os.pipe()
            av_hub._enlarge_pipe(enc_aud_w)
            enc_cmd = rtmp_streamer.build_rtmp_encoder_args(
                rtmp_target,
                width=w,
                height=h,
                fps=eff_fps,
                video_quality=video_quality,
                vb=vb,
                vmax=vmax,
                vbuf=vbuf,
                audio_input=f'pipe:{enc_aud_r}',
                preset=preset,
                threads=threads,
                input_format='raw',
                realtime=False,
            )
            enc_proc = subprocess.Popen(
                enc_cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                pass_fds=(enc_aud_r,),
                bufsize=0,
            )
            os.close(enc_aud_r)
            enc_aud_r = -1
            av_hub._enlarge_pipe(enc_proc.stdin.fileno())
            a_out = os.fdopen(enc_aud_w, 'wb', buffering=0)
            enc_aud_w = -1
            v_out = enc_proc.stdin

            dec_proc = subprocess.Popen(
                resolved_dec,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                bufsize=0,
            )
            av_hub._enlarge_pipe(dec_proc.stdout.fileno())

            t_dec_err = threading.Thread(target=_drain_stderr, args=(dec_proc.stderr, dec_logs, rtmp_target), daemon=True)
            t_enc_err = threading.Thread(target=_drain_stderr, args=(enc_proc.stderr, enc_logs, rtmp_target), daemon=True)
            t_dec_err.start()
            t_enc_err.start()

            AUDIO_BPS = 192000  # 48kHz * 2ch * s16le
            SAMPLE_ALIGN = 4
            STARVE_SEC = 0.250
            DRIFT_SILENT_SEC = 0.045
            TARGET_LOCK_SEC = 0.030
            frame_dur = 1.0 / eff_fps
            max_vq = max(48, min(180, int(round(eff_fps * 3.0))))
            max_apcm = AUDIO_BPS * 6

            cond = threading.Condition()
            video_q = deque()
            audio_pcm = bytearray()
            audio_head_pts = None
            audio_tail_pts = None
            v_seen = False
            a_seen = False
            dec_eof = False

            def _demux_nut_reader():
                nonlocal audio_head_pts, audio_tail_pts, v_seen, a_seen, dec_eof
                reader = nut_stream.NutStreamReader(dec_proc.stdout)
                try:
                    for pkt in reader.iter_packets():
                        if stop_event.is_set():
                            break
                        if pkt[0] != 'frame':
                            continue
                        _, info, _hdr_raw, _el, payload = pkt
                        sc = int(info['stream_class'])
                        pts = float(info['pts_sec'])
                        if sc == 0:
                            if len(payload) != frame_bytes:
                                continue
                            with cond:
                                while (len(video_q) >= max_vq and (len(audio_pcm) >= max_apcm or no_audio_eof)) and not stop_event.is_set():
                                    cond.wait(timeout=0.04)
                                if stop_event.is_set():
                                    break
                                video_q.append((pts, bytes(payload)))
                                v_seen = True
                                cond.notify_all()
                        elif sc == 1:
                            usable = len(payload) - (len(payload) % SAMPLE_ALIGN)
                            if usable <= 0:
                                continue
                            body = memoryview(payload)[:usable]
                            with cond:
                                while (len(audio_pcm) >= max_apcm and len(video_q) >= max_vq) and not stop_event.is_set():
                                    cond.wait(timeout=0.04)
                                if stop_event.is_set():
                                    break
                                if audio_head_pts is None:
                                    audio_head_pts = pts
                                    audio_tail_pts = pts
                                else:
                                    gap = pts - audio_tail_pts
                                    if gap > 0.025:
                                        pad_b = min(int(round(gap * AUDIO_BPS)), AUDIO_BPS * 5)
                                        pad_b -= (pad_b % SAMPLE_ALIGN)
                                        if pad_b > 0:
                                            audio_pcm.extend(b'\x00' * pad_b)
                                            audio_tail_pts += pad_b / float(AUDIO_BPS)
                                    elif gap < -0.025:
                                        skip_b = min(usable, int(round((-gap) * AUDIO_BPS)))
                                        skip_b -= (skip_b % SAMPLE_ALIGN)
                                        if skip_b >= usable:
                                            continue
                                        body = body[skip_b:]
                                if len(body) > 0:
                                    audio_pcm.extend(body)
                                    audio_tail_pts += len(body) / float(AUDIO_BPS)
                                a_seen = True
                                cond.notify_all()
                except Exception as err:
                    if not stop_event.is_set():
                        print(f'[rtmp_hub] nut demux error: {err}', file=sys.stderr)
                        broken_event.set()
                        stop_event.set()
                finally:
                    with cond:
                        dec_eof = True
                        cond.notify_all()

            def _pop_audio_bytes(nbytes):
                nonlocal audio_head_pts
                n = min(nbytes, len(audio_pcm))
                n -= (n % SAMPLE_ALIGN)
                if n <= 0:
                    return b''
                out_b = bytes(audio_pcm[:n])
                del audio_pcm[:n]
                if audio_head_pts is not None:
                    audio_head_pts += n / float(AUDIO_BPS)
                return out_b

            def _pump_verifier():
                nonlocal audio_head_pts, audio_tail_pts
                tick_idx = 0
                total_pcm_written = 0
                last_raw_frame = bytes(frame_bytes)
                last_frame_pts = 0.0
                wall_origin = None
                starve_since = None
                if state is not None:
                    state.audio_state = 1
                    state.video_state = 1

                out_cond = threading.Condition()
                v_out_q = deque()
                a_out_q = deque()
                verify_eof = False

                def _pipe_writer_loop(q, sink_stream):
                    try:
                        while True:
                            with out_cond:
                                while not q and not verify_eof and not stop_event.is_set():
                                    out_cond.wait(timeout=0.05)
                                if not q and (verify_eof or stop_event.is_set()):
                                    break
                                if not q:
                                    continue
                                chunk = q.popleft()
                                out_cond.notify_all()
                            av_sync._write_all(sink_stream, chunk)
                    except (BrokenPipeError, ConnectionResetError, OSError):
                        broken_event.set()
                        stop_event.set()
                        with out_cond:
                            out_cond.notify_all()
                    finally:
                        try:
                            sink_stream.close()
                        except OSError:
                            pass

                t_vw = threading.Thread(target=_pipe_writer_loop, args=(v_out_q, v_out), daemon=True)
                t_aw = threading.Thread(target=_pipe_writer_loop, args=(a_out_q, a_out), daemon=True)
                t_vw.start()
                t_aw.start()

                def _emit_tick(frame_buf, pcm_buf, media_pts, skew_s=0.0, sync_bits=0):
                    nonlocal tick_idx, total_pcm_written, wall_origin
                    safe_frame = bytes(frame_buf) if type(frame_buf) is not bytes else frame_buf
                    safe_pcm = bytes(pcm_buf) if type(pcm_buf) is not bytes else pcm_buf
                    with out_cond:
                        while (len(v_out_q) >= 36 or len(a_out_q) >= 36) and not stop_event.is_set():
                            out_cond.wait(timeout=0.04)
                        if stop_event.is_set():
                            return
                        if enc_realtime:
                            out_cond.release()
                            try:
                                now_m = time.monotonic()
                                if wall_origin is None:
                                    wall_origin = now_m - 0.35
                                target_m = wall_origin + ((tick_idx + 1) * frame_dur)
                                rem = target_m - now_m
                                if rem > 0.002:
                                    time.sleep(min(rem, 0.25))
                            finally:
                                out_cond.acquire()
                        if stop_event.is_set():
                            return
                        v_out_q.append(safe_frame)
                        a_out_q.append(safe_pcm)
                        out_cond.notify_all()
                    total_pcm_written += len(safe_pcm)
                    tick_idx += 1
                    if state is not None:
                        now_hb = time.monotonic()
                        state.audio_sec = float(media_pts)
                        state.video_sec = float(media_pts)
                        state.audio_hb_mono = now_hb
                        state.video_hb_mono = now_hb
                        state.skew_ms = int(round(skew_s * 1000.0))
                        state.sync_flags = int(sync_bits)

                try:
                    # Wait for aligned startup epoch across video + audio (unless EOF/audio-less)
                    with cond:
                        wait_start = time.monotonic()
                        while not stop_event.is_set() and not dec_eof:
                            have_v = len(video_q) > 0
                            have_a = (len(audio_pcm) >= SAMPLE_ALIGN) or no_audio_eof
                            if have_v and have_a:
                                break
                            if (time.monotonic() - wait_start) >= 3.0 and (have_v or a_seen):
                                break
                            cond.wait(timeout=0.025)
                        if not video_q and dec_eof:
                            return
                        if video_q:
                            v0_pts, v0_buf = video_q[0]
                            last_raw_frame = v0_buf
                            last_frame_pts = max(0.0, v0_pts)
                            if audio_head_pts is not None:
                                if audio_head_pts > v0_pts + 0.015:
                                    pad_b = min(int(round((audio_head_pts - v0_pts) * AUDIO_BPS)), AUDIO_BPS * 5)
                                    pad_b -= (pad_b % SAMPLE_ALIGN)
                                    if pad_b > 0:
                                        audio_pcm[:0] = b'\x00' * pad_b
                                        audio_head_pts -= pad_b / float(AUDIO_BPS)
                                elif v0_pts > audio_head_pts + 0.015:
                                    drop_b = min(len(audio_pcm), int(round((v0_pts - audio_head_pts) * AUDIO_BPS)))
                                    drop_b -= (drop_b % SAMPLE_ALIGN)
                                    if drop_b > 0:
                                        del audio_pcm[:drop_b]
                                        audio_head_pts += drop_b / float(AUDIO_BPS)

                    while not stop_event.is_set():
                        target_pcm_end = int(round(((tick_idx + 1) * float(AUDIO_BPS)) / eff_fps))
                        target_pcm_end -= (target_pcm_end % SAMPLE_ALIGN)
                        need_pcm = max(SAMPLE_ALIGN, target_pcm_end - total_pcm_written)
                        need_pcm -= (need_pcm % SAMPLE_ALIGN)

                        paused_now = (state is not None and int(state.paused) == 1)
                        if paused_now:
                            starve_since = None
                            hud_frame = (
                                sub_overlay.render_hud(last_raw_frame, last_frame_pts, mode='paused')
                                if sub_overlay is not None
                                else last_raw_frame
                            )
                            _emit_tick(hud_frame, b'\x00' * need_pcm, last_frame_pts, skew_s=0.0, sync_bits=0)
                            continue

                        emit_frame = None
                        emit_pcm = None
                        emit_pts = last_frame_pts
                        emit_skew = 0.0
                        sync_bits = 0
                        should_break = False
                        need_wait = False

                        with cond:
                            v_len = len(video_q)
                            a_len = len(audio_pcm)
                            expect_audio = a_seen and not no_audio_eof

                            if v_len == 0 and dec_eof:
                                if expect_audio and a_len >= need_pcm and (last_frame_pts == 0.0 or a_len <= AUDIO_BPS * 2):
                                    # Drain brief audio tail cleanly after final video frame
                                    emit_pcm = _pop_audio_bytes(need_pcm)
                                    emit_frame = (
                                        sub_overlay.render(last_raw_frame, last_frame_pts)
                                        if sub_overlay is not None
                                        else last_raw_frame
                                    )
                                else:
                                    should_break = True
                            elif v_len > 0 and (dec_eof or no_audio_eof or not expect_audio or a_len >= need_pcm):
                                v_pts, v_buf = video_q[0]
                                if expect_audio and audio_head_pts is not None:
                                    skew = audio_head_pts - v_pts
                                    emit_skew = skew
                                    # Video lagging behind audio -> drop stale video frames up to lock
                                    if skew > DRIFT_SILENT_SEC and len(video_q) > 1:
                                        while len(video_q) > 1 and (audio_head_pts - video_q[0][0]) > TARGET_LOCK_SEC:
                                            video_q.popleft()
                                        v_pts, v_buf = video_q[0]
                                        skew = audio_head_pts - v_pts
                                        emit_skew = skew
                                    # Audio lagging behind video -> discard stale audio samples up to lock
                                    elif skew < -DRIFT_SILENT_SEC and a_len > need_pcm:
                                        drop_b = min(
                                            max(0, a_len - need_pcm),
                                            int(round((v_pts - audio_head_pts) * AUDIO_BPS)),
                                        )
                                        drop_b -= (drop_b % SAMPLE_ALIGN)
                                        if drop_b > 0:
                                            del audio_pcm[:drop_b]
                                            audio_head_pts += drop_b / float(AUDIO_BPS)
                                            a_len = len(audio_pcm)
                                            skew = audio_head_pts - v_pts
                                            emit_skew = skew

                                    # Still severely skewed (>250ms) and not EOF -> hold & sync
                                    if not dec_eof and skew > STARVE_SEC:
                                        now_m = time.monotonic()
                                        if starve_since is None:
                                            starve_since = now_m
                                        sync_bits = 2
                                        emit_frame = (
                                            sub_overlay.render_hud(last_raw_frame, last_frame_pts, mode='syncing')
                                            if (now_m - starve_since) >= STARVE_SEC and sub_overlay is not None
                                            else (sub_overlay.render(last_raw_frame, last_frame_pts) if sub_overlay is not None else last_raw_frame)
                                        )
                                        emit_pcm = b'\x00' * need_pcm
                                    elif not dec_eof and skew < -STARVE_SEC:
                                        now_m = time.monotonic()
                                        if starve_since is None:
                                            starve_since = now_m
                                        sync_bits = 1
                                        emit_frame = (
                                            sub_overlay.render_hud(last_raw_frame, last_frame_pts, mode='syncing')
                                            if (now_m - starve_since) >= STARVE_SEC and sub_overlay is not None
                                            else (sub_overlay.render(last_raw_frame, last_frame_pts) if sub_overlay is not None else last_raw_frame)
                                        )
                                        emit_pcm = b'\x00' * need_pcm
                                    # Moderate video ahead (45..250ms, e.g. dropped video frame) -> repeat cached frame silently while audio runs
                                    elif skew < -DRIFT_SILENT_SEC:
                                        starve_since = None
                                        cur_a_pts = audio_head_pts
                                        emit_pcm = _pop_audio_bytes(need_pcm)
                                        emit_pts = max(0.0, cur_a_pts)
                                        emit_frame = (
                                            sub_overlay.render(last_raw_frame, emit_pts)
                                            if sub_overlay is not None
                                            else last_raw_frame
                                        )
                                    else:
                                        starve_since = None
                                        video_q.popleft()
                                        last_raw_frame = v_buf
                                        last_frame_pts = max(0.0, v_pts)
                                        emit_pts = last_frame_pts
                                        emit_pcm = _pop_audio_bytes(need_pcm)
                                        if len(emit_pcm) < need_pcm:
                                            emit_pcm = emit_pcm + (b'\x00' * (need_pcm - len(emit_pcm)))
                                        emit_frame = (
                                            sub_overlay.render(v_buf, last_frame_pts)
                                            if sub_overlay is not None
                                            else v_buf
                                        )
                                else:
                                    starve_since = None
                                    video_q.popleft()
                                    last_raw_frame = v_buf
                                    last_frame_pts = max(0.0, v_pts)
                                    emit_pts = last_frame_pts
                                    emit_pcm = _pop_audio_bytes(need_pcm)
                                    if len(emit_pcm) < need_pcm:
                                        emit_pcm = emit_pcm + (b'\x00' * (need_pcm - len(emit_pcm)))
                                    emit_frame = (
                                        sub_overlay.render(v_buf, last_frame_pts)
                                        if sub_overlay is not None
                                        else v_buf
                                    )
                            else:
                                # One or both queues empty while decoder still live -> wait briefly or emit syncing hold
                                now_m = time.monotonic()
                                if starve_since is None:
                                    starve_since = now_m
                                if (now_m - starve_since) < STARVE_SEC:
                                    need_wait = True
                                else:
                                    sync_bits = (2 if v_len == 0 else 0) | (1 if (expect_audio and a_len < need_pcm) else 0)
                                    emit_frame = (
                                        sub_overlay.render_hud(last_raw_frame, last_frame_pts, mode='syncing')
                                        if sub_overlay is not None
                                        else last_raw_frame
                                    )
                                    emit_pcm = b'\x00' * need_pcm
                            cond.notify_all()
                            if need_wait:
                                cond.wait(timeout=0.02)
                                continue

                        if should_break:
                            break
                        if emit_frame is not None and emit_pcm is not None:
                            _emit_tick(emit_frame, emit_pcm, emit_pts, skew_s=emit_skew, sync_bits=sync_bits)
                            if sub_monitor is not None and sync_bits == 0 and len(emit_pcm) > 0:
                                sub_monitor.feed_pcm(emit_pts, emit_pcm)
                except (BrokenPipeError, ConnectionResetError, OSError):
                    broken_event.set()
                    stop_event.set()
                except Exception as err:
                    print(f'[rtmp_hub] verifier relay error: {err}', file=sys.stderr)
                    broken_event.set()
                    stop_event.set()
                finally:
                    verify_eof = True
                    with out_cond:
                        out_cond.notify_all()
                    t_vw.join(timeout=3.0)
                    t_aw.join(timeout=3.0)
                    if state is not None:
                        state.audio_state = 2
                        state.video_state = 2
                        state.sync_flags = 0
                    v_done.set()
                    a_done.set()
                    with cond:
                        cond.notify_all()
                    try:
                        v_out.close()
                    except OSError:
                        pass
                    try:
                        a_out.close()
                    except OSError:
                        pass
                    try:
                        dec_proc.stdout.close()
                    except OSError:
                        pass

            t_demux = threading.Thread(target=_demux_nut_reader, daemon=True)
            t_verify = threading.Thread(target=_pump_verifier, daemon=True)
            t_demux.start()
            t_verify.start()
            pumps = [t_demux, t_verify]
        else:
            dec_aud_r, dec_aud_w = os.pipe()
            enc_aud_r, enc_aud_w = os.pipe()
            av_hub._enlarge_pipe(dec_aud_w)
            av_hub._enlarge_pipe(enc_aud_w)

            resolved_dec = [
                (f'pipe:{dec_aud_w}' if tok == rtmp_streamer.AUDIO_PIPE_PLACEHOLDER else tok)
                for tok in cmd_tokens
            ]
            if f'pipe:{dec_aud_w}' not in resolved_dec:
                print('[rtmp_hub] decoder command missing audio pipe placeholder', file=sys.stderr)
                return 2

            enc_cmd = rtmp_streamer.build_rtmp_encoder_args(
                rtmp_target,
                width=w,
                height=h,
                fps=eff_fps,
                video_quality=video_quality,
                vb=vb,
                vmax=vmax,
                vbuf=vbuf,
                audio_input=f'pipe:{enc_aud_r}',
                preset=preset,
                threads=threads,
                input_format='raw',
            )

            enc_proc = subprocess.Popen(
                enc_cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                pass_fds=(enc_aud_r,),
                bufsize=0,
            )
            os.close(enc_aud_r)
            enc_aud_r = -1
            av_hub._enlarge_pipe(enc_proc.stdin.fileno())

            dec_proc = subprocess.Popen(
                resolved_dec,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                pass_fds=(dec_aud_w,),
                bufsize=0,
            )
            os.close(dec_aud_w)
            dec_aud_w = -1
            av_hub._enlarge_pipe(dec_proc.stdout.fileno())

            v_in = dec_proc.stdout
            a_in = os.fdopen(dec_aud_r, 'rb', buffering=0)
            dec_aud_r = -1
            v_out = enc_proc.stdin
            a_out = os.fdopen(enc_aud_w, 'wb', buffering=0)
            enc_aud_w = -1

            t_dec_err = threading.Thread(target=_drain_stderr, args=(dec_proc.stderr, dec_logs, rtmp_target), daemon=True)
            t_enc_err = threading.Thread(target=_drain_stderr, args=(enc_proc.stderr, enc_logs, rtmp_target), daemon=True)
            t_dec_err.start()
            t_enc_err.start()

            def _pump_video():
                frame_idx = 0
                try:
                    while not stop_event.is_set():
                        frame = av_sync._read_exact(v_in, frame_bytes)
                        if len(frame) < frame_bytes:
                            break
                        if sub_overlay is not None:
                            frame = sub_overlay.render(frame, frame_idx / eff_fps)
                        av_sync._write_all(v_out, frame)
                        frame_idx += 1
                except (BrokenPipeError, ConnectionResetError, OSError):
                    broken_event.set()
                    stop_event.set()
                finally:
                    v_done.set()
                    try:
                        v_out.close()
                    except OSError:
                        pass
                    try:
                        v_in.close()
                    except OSError:
                        pass

            def _pump_audio():
                try:
                    while not stop_event.is_set():
                        chunk = a_in.read(CHUNK_BYTES)
                        if not chunk:
                            break
                        av_sync._write_all(a_out, chunk)
                except (BrokenPipeError, ConnectionResetError, OSError):
                    broken_event.set()
                    stop_event.set()
                finally:
                    a_done.set()
                    try:
                        a_out.close()
                    except OSError:
                        pass
                    try:
                        a_in.close()
                    except OSError:
                        pass

            tv = threading.Thread(target=_pump_video, daemon=True)
            ta = threading.Thread(target=_pump_audio, daemon=True)
            tv.start()
            ta.start()
            pumps = [tv, ta]

        silent_stopped = False
        while not (v_done.is_set() and a_done.is_set()):
            if stop_event.is_set():
                break
            if enc_proc.poll() is not None:
                broken_event.set()
                stop_event.set()
                break
            if no_audio_eof and v_done.is_set() and not silent_stopped:
                silent_stopped = True
                if dec_proc.poll() is None:
                    try:
                        dec_proc.terminate()
                    except OSError:
                        pass
            time.sleep(0.05)

        if stop_event.is_set():
            if dec_proc is not None and dec_proc.poll() is None:
                try:
                    dec_proc.terminate()
                except OSError:
                    pass
        for t in pumps:
            t.join(timeout=2.0)

        if not stop_event.is_set():
            try:
                dec_proc.wait(timeout=3.0)
            except subprocess.TimeoutExpired:
                pass
            try:
                enc_proc.wait(timeout=10.0)
            except subprocess.TimeoutExpired:
                pass

        for proc in (dec_proc, enc_proc):
            if proc is not None and proc.poll() is None:
                try:
                    proc.terminate()
                    proc.wait(timeout=1.5)
                except subprocess.TimeoutExpired:
                    try:
                        proc.kill()
                        proc.wait(timeout=1.0)
                    except OSError:
                        pass
                except OSError:
                    pass

        t_dec_err.join(timeout=0.5)
        t_enc_err.join(timeout=0.5)

        if signal_stop.is_set():
            return 0
        enc_rc = enc_proc.returncode if enc_proc is not None else 1
        dec_rc = dec_proc.returncode if dec_proc is not None else 0
        if enc_rc != 0:
            for ln in enc_logs:
                print(f'[rtmp_hub:enc] {ln}', file=sys.stderr)
            for ln in dec_logs:
                print(f'[rtmp_hub:dec] {ln}', file=sys.stderr)
            return enc_rc or 1
        if dec_rc not in (0, None) and not no_audio_eof:
            for ln in dec_logs:
                print(f'[rtmp_hub:dec] {ln}', file=sys.stderr)
            return dec_rc
        return 0
    finally:
        for fd in (dec_aud_r, dec_aud_w, enc_aud_r, enc_aud_w):
            if fd >= 0:
                try:
                    os.close(fd)
                except OSError:
                    pass
        if sub_monitor is not None:
            sub_monitor.close()
        if sub_overlay is not None:
            sub_overlay.close()
        if shm_mm is not None:
            try:
                shm_mm.close()
            except Exception:
                pass
        if shm_fd is not None:
            try:
                os.close(shm_fd)
            except OSError:
                pass


def main():
    p = argparse.ArgumentParser(description='Single-demuxer RTMP hub with live subtitle compositing')
    p.add_argument('--sync-id', required=True)
    p.add_argument('--width', type=int, required=True)
    p.add_argument('--height', type=int, required=True)
    p.add_argument('--fps', type=float, default=24.0)
    p.add_argument('--video-quality', default='HD_720p')
    p.add_argument('--vb', default=None)
    p.add_argument('--vmax', default=None)
    p.add_argument('--vbuf', default=None)
    p.add_argument('--preset', default='veryfast')
    p.add_argument('--threads', type=int, default=4)
    p.add_argument('--sub-config', default='')
    p.add_argument('--rtmp-env', default='LANCY_RTMP_TARGET')
    p.add_argument('--rtmp-target', default='')
    p.add_argument('--no-audio-eof', action='store_true')
    p.add_argument('--realtime', action='store_true')
    p.add_argument('dec_cmd', nargs=argparse.REMAINDER)
    args = p.parse_args()

    target = str(args.rtmp_target or os.environ.get(args.rtmp_env) or '').strip()
    sys.exit(run_rtmp_hub(
        sync_id=args.sync_id,
        rtmp_target=target,
        width=args.width,
        height=args.height,
        fps=args.fps,
        video_quality=args.video_quality,
        vb=args.vb,
        vmax=args.vmax,
        vbuf=args.vbuf,
        preset=args.preset,
        threads=args.threads,
        sub_config_path=args.sub_config or None,
        dec_cmd=args.dec_cmd,
        no_audio_eof=args.no_audio_eof,
        realtime=args.realtime,
    ))


if __name__ == '__main__':
    main()
