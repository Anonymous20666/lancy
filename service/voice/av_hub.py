"""Single-demuxer FFmpeg hub + Unix-socket readers for locked interactive WebRTC A/V.

Runs ONE FFmpeg subprocess that demuxes the source container/HTTP stream once and
emits rawvideo (`yuv420p`) on stdout (fd 1) and s16le PCM on an extra pipe fd,
forwarding them over two `/dev/shm` Unix domain sockets to `av_sync.py` wrappers.
"""
from collections import deque
import argparse
import errno
import fcntl
import os
import shlex
import signal
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

VOICE_DIR = Path(__file__).resolve().parent
if str(VOICE_DIR) not in sys.path:
    sys.path.insert(0, str(VOICE_DIR))

import nut_stream

AUDIO_PIPE_PLACEHOLDER = '__LANCY_AUDIO_PIPE__'
F_SETPIPE_SZ = 1031
PIPE_BYTES = 1048576
AUDIO_SOCK_SNDBUF = 24576
CHUNK_BYTES = 65536


def _sock_dir():
    shm = Path('/dev/shm')
    return shm if shm.is_dir() else Path('/tmp')


def video_sock_path(sync_id):
    return _sock_dir() / f'lancy-hub-v-{sync_id}.sock'


def audio_sock_path(sync_id):
    return _sock_dir() / f'lancy-hub-a-{sync_id}.sock'


def _prune_stale_sockets(max_age_sec=1800):
    cutoff = time.time() - max_age_sec
    for pat in ('lancy-hub-v-*.sock', 'lancy-hub-a-*.sock'):
        for p in _sock_dir().glob(pat):
            try:
                if p.stat().st_mtime < cutoff:
                    p.unlink(missing_ok=True)
            except OSError:
                pass


def _enlarge_pipe(fd):
    try:
        fcntl.fcntl(fd, F_SETPIPE_SZ, PIPE_BYTES)
    except OSError:
        pass


def _safe_unlink(path):
    try:
        Path(path).unlink(missing_ok=True)
    except OSError:
        pass


def cleanup_hub_files(sync_id):
    if not sync_id:
        return
    _safe_unlink(video_sock_path(sync_id))
    _safe_unlink(audio_sock_path(sync_id))


def _bind_unix_server(sock_path):
    _safe_unlink(sock_path)
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(str(sock_path))
    try:
        os.chmod(str(sock_path), 0o600)
    except OSError:
        pass
    srv.listen(2)
    srv.settimeout(0.25)
    return srv


def _run_hub(sync_id, cmd_args, startup_timeout=25.0):
    if not cmd_args:
        return 2
    _prune_stale_sockets()

    v_path = video_sock_path(sync_id)
    a_path = audio_sock_path(sync_id)
    v_srv = _bind_unix_server(v_path)
    a_srv = _bind_unix_server(a_path)

    stop_event = threading.Event()
    broken_event = threading.Event()
    proc = None
    v_conn = None
    a_conn = None
    audio_r, audio_w = os.pipe()
    _enlarge_pipe(audio_w)

    def _on_signal(_signum, _frame):
        stop_event.set()
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
            except OSError:
                pass

    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)

    try:
        deadline = time.monotonic() + max(2.0, float(startup_timeout))
        while (v_conn is None or a_conn is None) and not stop_event.is_set():
            if time.monotonic() > deadline:
                return 3
            if v_conn is None:
                try:
                    v_conn, _ = v_srv.accept()
                except socket.timeout:
                    pass
            if a_conn is None:
                try:
                    a_conn, _ = a_srv.accept()
                except socket.timeout:
                    pass

        for srv in (v_srv, a_srv):
            try:
                srv.close()
            except OSError:
                pass
        v_srv = None
        a_srv = None

        if stop_event.is_set() or v_conn is None or a_conn is None:
            return 0

        try:
            a_conn.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, AUDIO_SOCK_SNDBUF)
        except OSError:
            pass

        is_nut = (AUDIO_PIPE_PLACEHOLDER not in cmd_args)
        if is_nut:
            try:
                os.close(audio_w)
            except OSError:
                pass
            try:
                os.close(audio_r)
            except OSError:
                pass
            audio_w = -1
            audio_r = -1

            proc = subprocess.Popen(
                list(cmd_args),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                bufsize=0,
            )
            _enlarge_pipe(proc.stdout.fileno())

            v_q = deque()
            a_q = deque()
            q_cond = threading.Condition()
            reader_done = False

            def _send_loop(q, max_q_wakeup, dst_sock):
                try:
                    while True:
                        with q_cond:
                            while not q and not reader_done and not stop_event.is_set():
                                q_cond.wait(timeout=0.05)
                            if stop_event.is_set():
                                break
                            if not q and reader_done:
                                break
                            item = q.popleft()
                            if len(q) <= max_q_wakeup:
                                q_cond.notify_all()
                        pts_us, dur_us, payload = item
                        nut_stream.send_timed_frame(dst_sock, pts_us, dur_us, payload)
                except (BrokenPipeError, ConnectionResetError, OSError):
                    broken_event.set()
                finally:
                    with q_cond:
                        q_cond.notify_all()
                    try:
                        dst_sock.shutdown(socket.SHUT_WR)
                    except OSError:
                        pass
                    try:
                        dst_sock.close()
                    except OSError:
                        pass

            def _nut_reader():
                nonlocal reader_done
                prev_v_pts_us = None
                try:
                    reader = nut_stream.NutStreamReader(proc.stdout)
                    for pkt in reader.iter_packets():
                        if stop_event.is_set() or broken_event.is_set():
                            break
                        if pkt[0] != 'frame':
                            continue
                        _, info, _hdr, _el, payload = pkt
                        if not payload:
                            continue
                        pts_us = int(info['pts_us'])
                        sclass = int(info['stream_class'])
                        if sclass == 0:
                            if prev_v_pts_us is not None:
                                dv = pts_us - prev_v_pts_us
                                dur_us = dv if 1000 <= dv <= 250000 else 33333
                            else:
                                dur_us = 33333
                            prev_v_pts_us = pts_us
                            with q_cond:
                                while len(v_q) >= 12 and not stop_event.is_set() and not broken_event.is_set():
                                    q_cond.wait(timeout=0.04)
                                if stop_event.is_set() or broken_event.is_set():
                                    break
                                v_q.append((pts_us, dur_us, payload))
                                q_cond.notify_all()
                        elif sclass == 1:
                            dur_us = max(1000, int(round((len(payload) / 4.0) * (1_000_000.0 / 48000.0))))
                            with q_cond:
                                while len(a_q) >= 48 and not stop_event.is_set() and not broken_event.is_set():
                                    q_cond.wait(timeout=0.04)
                                if stop_event.is_set() or broken_event.is_set():
                                    break
                                a_q.append((pts_us, dur_us, payload))
                                q_cond.notify_all()
                except (BrokenPipeError, ConnectionResetError, OSError, ValueError):
                    pass
                finally:
                    with q_cond:
                        reader_done = True
                        q_cond.notify_all()
                    try:
                        proc.stdout.close()
                    except OSError:
                        pass

            tr = threading.Thread(target=_nut_reader, daemon=True)
            tv = threading.Thread(target=_send_loop, args=(v_q, 6, v_conn), daemon=True)
            ta = threading.Thread(target=_send_loop, args=(a_q, 24, a_conn), daemon=True)
            tr.start()
            tv.start()
            ta.start()

            while tv.is_alive() or ta.is_alive():
                if stop_event.is_set():
                    break
                if broken_event.is_set():
                    time.sleep(0.3)
                    break
                tv.join(timeout=0.1)
                ta.join(timeout=0.1)

            if (stop_event.is_set() or broken_event.is_set()) and proc.poll() is None:
                try:
                    proc.terminate()
                    proc.wait(timeout=1.5)
                except Exception:
                    try:
                        proc.kill()
                    except OSError:
                        pass
            tr.join(timeout=1.5)
            tv.join(timeout=1.5)
            ta.join(timeout=1.5)
            rc = proc.poll()
            if rc is None:
                try:
                    rc = proc.wait(timeout=2.0)
                except Exception:
                    try:
                        proc.kill()
                    except OSError:
                        pass
                    rc = 1
            return int(rc or 0)

        resolved_cmd = [
            (f'pipe:{audio_w}' if tok == AUDIO_PIPE_PLACEHOLDER else tok)
            for tok in cmd_args
        ]
        if f'pipe:{audio_w}' not in resolved_cmd:
            return 2

        proc = subprocess.Popen(
            resolved_cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            pass_fds=(audio_w,),
            bufsize=0,
        )
        _enlarge_pipe(proc.stdout.fileno())
        try:
            os.close(audio_w)
            audio_w = -1
        except OSError:
            audio_w = -1

        audio_stream = os.fdopen(audio_r, 'rb', buffering=0)
        audio_r = -1

        def _pump(src_stream, dst_sock):
            try:
                while not stop_event.is_set():
                    chunk = src_stream.read(CHUNK_BYTES)
                    if not chunk:
                        break
                    dst_sock.sendall(chunk)
            except (BrokenPipeError, ConnectionResetError, OSError):
                broken_event.set()
            finally:
                try:
                    dst_sock.shutdown(socket.SHUT_WR)
                except OSError:
                    pass
                try:
                    dst_sock.close()
                except OSError:
                    pass
                try:
                    src_stream.close()
                except OSError:
                    pass

        tv = threading.Thread(target=_pump, args=(proc.stdout, v_conn), daemon=True)
        ta = threading.Thread(target=_pump, args=(audio_stream, a_conn), daemon=True)
        tv.start()
        ta.start()

        while tv.is_alive() or ta.is_alive():
            if stop_event.is_set():
                break
            if broken_event.is_set():
                # Give sibling reader 0.4s before terminating FFmpeg on abort/seek
                time.sleep(0.4)
                break
            tv.join(timeout=0.1)
            ta.join(timeout=0.1)

        if (stop_event.is_set() or broken_event.is_set()) and proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=1.5)
            except Exception:
                try:
                    proc.kill()
                except OSError:
                    pass

        tv.join(timeout=1.5)
        ta.join(timeout=1.5)
        rc = proc.poll()
        if rc is None:
            try:
                rc = proc.wait(timeout=2.0)
            except Exception:
                try:
                    proc.kill()
                except OSError:
                    pass
                rc = 1
        return int(rc or 0)
    finally:
        for fd in (audio_w, audio_r):
            if fd >= 0:
                try:
                    os.close(fd)
                except OSError:
                    pass
        for sock in (v_conn, a_conn, v_srv, a_srv):
            if sock is not None:
                try:
                    sock.close()
                except OSError:
                    pass
        cleanup_hub_files(sync_id)


def _run_reader(role, sync_id, connect_timeout=15.0):
    sock_path = video_sock_path(sync_id) if role == 'read-video' else audio_sock_path(sync_id)
    sock = None
    deadline = time.monotonic() + max(2.0, float(connect_timeout))
    while time.monotonic() < deadline:
        try:
            cand = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            cand.connect(str(sock_path))
            sock = cand
            break
        except OSError as err:
            try:
                cand.close()
            except OSError:
                pass
            if err.errno not in (errno.ENOENT, errno.ECONNREFUSED, errno.EAGAIN):
                time.sleep(0.05)
            else:
                time.sleep(0.02)
    if sock is None:
        return 1

    out_fd = sys.stdout.fileno()
    try:
        while True:
            chunk = sock.recv(CHUNK_BYTES)
            if not chunk:
                break
            nut_stream.write_fd_all(out_fd, chunk)
        return 0
    except (BrokenPipeError, ConnectionResetError, OSError):
        return 0
    finally:
        try:
            sock.close()
        except OSError:
            pass


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('--role', required=True, choices=('hub', 'read-video', 'read-audio'))
    parser.add_argument('--sync-id', required=True)
    parser.add_argument('--startup-timeout', type=float, default=25.0)
    parser.add_argument('rest', nargs=argparse.REMAINDER)
    args = parser.parse_args()

    if args.role == 'hub':
        cmd = list(args.rest)
        if cmd and cmd[0] == '--':
            cmd = cmd[1:]
        raise SystemExit(_run_hub(args.sync_id, cmd, startup_timeout=args.startup_timeout))

    raise SystemExit(_run_reader(args.role, args.sync_id, connect_timeout=args.startup_timeout))


if __name__ == '__main__':
    main()
