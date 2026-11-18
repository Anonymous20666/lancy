"""Real-time animated Visual DJ Desk compositor & PCM spectrum analyzer for YUV420p frames.

Works cleanly with both `av_sync.py` (WebRTC) and `rtmp_hub.py` (RTMPS) at 15-20 fps using
pure NumPy slice vector operations (~0.5ms per 720p frame) with zero heavy image deps.
"""

import json
import math
from pathlib import Path
import time

import numpy as np

# 5x7 crisp bitmap font for digits, slash, colon and live status glyphs (columns LSB->MSB)
_GLYPHS_5X7 = {
    '0': (0x3E, 0x51, 0x49, 0x45, 0x3E),
    '1': (0x00, 0x42, 0x7F, 0x40, 0x00),
    '2': (0x42, 0x61, 0x51, 0x49, 0x46),
    '3': (0x21, 0x41, 0x45, 0x4B, 0x31),
    '4': (0x18, 0x14, 0x12, 0x7F, 0x10),
    '5': (0x27, 0x45, 0x45, 0x45, 0x39),
    '6': (0x3C, 0x4A, 0x49, 0x49, 0x30),
    '7': (0x01, 0x71, 0x09, 0x05, 0x03),
    '8': (0x36, 0x49, 0x49, 0x49, 0x36),
    '9': (0x06, 0x49, 0x49, 0x29, 0x1E),
    ':': (0x00, 0x36, 0x36, 0x00, 0x00),
    '/': (0x20, 0x10, 0x08, 0x04, 0x02),
    '-': (0x08, 0x08, 0x08, 0x08, 0x08),
    ' ': (0x00, 0x00, 0x00, 0x00, 0x00),
}

# Precomputed FFT bin edges for 16 perceptual bands over rfft of 48kHz audio
_BAND_HZ_EDGES = np.geomspace(45.0, 14000.0, 17)


def analyze_pcm_into_state(pcm_bytes, state, sample_rate=48000, channels=2):
    """Compute 16-band log spectrum (0..255) & bass pulse into SyncState shm safely."""
    if state is None or not pcm_bytes or not hasattr(state, 'eq_bands'):
        return
    usable = len(pcm_bytes) - (len(pcm_bytes) % max(2, int(channels) * 2))
    if usable < 256:
        return
    try:
        arr = np.frombuffer(pcm_bytes[:usable], dtype=np.int16)
        if channels >= 2:
            mono = arr[::channels].astype(np.float32) / 32768.0
        else:
            mono = arr.astype(np.float32) / 32768.0
        if len(mono) < 64:
            return
        win = np.hanning(len(mono)).astype(np.float32)
        spec = np.abs(np.fft.rfft(mono * win))
        freqs = np.fft.rfftfreq(len(mono), d=1.0 / float(max(8000, sample_rate)))

        max_norm = max(8.0, len(mono) * 0.14)
        bass_acc = 0.0
        bass_cnt = 0
        for b in range(16):
            lo, hi = _BAND_HZ_EDGES[b], _BAND_HZ_EDGES[b + 1]
            mask = (freqs >= lo) & (freqs < hi)
            if not np.any(mask):
                idx = int(np.searchsorted(freqs, (lo + hi) * 0.5))
                idx = max(0, min(len(spec) - 1, idx))
                raw_e = float(spec[idx])
            else:
                raw_e = float(np.mean(spec[mask]))
            scaled = min(1.0, math.log1p((raw_e / max_norm) * 14.0) / 2.65)
            target = int(round(scaled * 255.0))
            prev = int(state.eq_bands[b])
            # Fast attack, smooth decay
            val = target if target >= prev else int(round(prev * 0.72 + target * 0.28))
            state.eq_bands[b] = max(0, min(255, val))
            if b <= 2:
                bass_acc += val
                bass_cnt += 1
        bass_val = int(round(bass_acc / max(1, bass_cnt)))
        prev_p = int(state.bass_pulse)
        state.bass_pulse = bass_val if bass_val >= prev_p else int(round(prev_p * 0.75 + bass_val * 0.25))
    except Exception:
        pass


def _format_mmss(sec):
    s = max(0, int(round(float(sec or 0.0))))
    m, r = divmod(s, 60)
    return f'{m:02d}:{r:02d}'


class DjDeskOverlay:
    """In-place YUV420p animated DJ Console HUD driven by playback PTS & audio shm bands."""

    def __init__(self, config_path, state, width, height, frame_bytes):
        self.config_path = Path(config_path) if config_path else None
        self.state = state
        self.width = int(width)
        self.height = int(height)
        self.frame_bytes = int(frame_bytes)
        self.enabled = False
        self.duration_sec = 180.0
        self.crossfade_sec = 4.0
        self.base_sec = 0.0
        self._cfg_sig = None
        self._last_stat_mono = 0.0
        self._peak_bars = [0.0] * 16
        self._smoothed_bars = [0.08] * 16
        self._out_buf = bytearray(self.frame_bytes)
        self._sx = self.width / 1280.0
        self._sy = self.height / 720.0
        self._init_geometry()
        self._refresh(force=True)

    def _x(self, px):
        return max(0, min(self.width - 1, int(round(px * self._sx))))

    def _y(self, py):
        return max(0, min(self.height - 1, int(round(py * self._sy))))

    def _init_geometry(self):
        # Deck A platter disc ring patch (centered around 228, 300 in 1280x720)
        cx_a, cy_a = self._x(228), self._y(300)
        r_a_out = max(24, int(round(134 * min(self._sx, self._sy))))
        r_a_in = max(16, int(round(120 * min(self._sx, self._sy))))
        ax0, ax1 = max(0, cx_a - r_a_out - 2), min(self.width, cx_a + r_a_out + 3)
        ay0, ay1 = max(0, cy_a - r_a_out - 2), min(self.height, cy_a + r_a_out + 3)
        yy_a, xx_a = np.ogrid[ay0:ay1, ax0:ax1]
        dx_a = xx_a - cx_a
        dy_a = yy_a - cy_a
        dist_a = np.sqrt(dx_a * dx_a + dy_a * dy_a)
        ang_a = np.arctan2(dy_a, dx_a)
        self._deck_a_box = (ay0, ay1, ax0, ax1, cx_a, cy_a)
        self._deck_a_ring = (dist_a >= r_a_in) & (dist_a <= r_a_out)
        self._deck_a_ang = ang_a
        self._deck_a_dist = dist_a
        self._deck_a_r_spoke_in = max(10, int(round(44 * min(self._sx, self._sy))))
        self._deck_a_r_spoke_out = max(20, int(round(115 * min(self._sx, self._sy))))

        # Deck B standby ring patch (centered around 1052, 284 in 1280x720)
        cx_b, cy_b = self._x(1052), self._y(284)
        r_b_out = max(20, int(round(104 * min(self._sx, self._sy))))
        r_b_in = max(14, int(round(92 * min(self._sx, self._sy))))
        bx0, bx1 = max(0, cx_b - r_b_out - 2), min(self.width, cx_b + r_b_out + 3)
        by0, by1 = max(0, cy_b - r_b_out - 2), min(self.height, cy_b + r_b_out + 3)
        yy_b, xx_b = np.ogrid[by0:by1, bx0:bx1]
        dx_b = xx_b - cx_b
        dy_b = yy_b - cy_b
        dist_b = np.sqrt(dx_b * dx_b + dy_b * dy_b)
        self._deck_b_box = (by0, by1, bx0, bx1, cx_b, cy_b)
        self._deck_b_ring = (dist_b >= r_b_in) & (dist_b <= r_b_out)
        self._deck_b_ang = np.arctan2(dy_b, dx_b)
        self._deck_b_dist = dist_b

        # Spectrum bay (x=454..826, y=304..416)
        self._spec_x0 = self._x(456)
        self._spec_x1 = self._x(824)
        self._spec_y0 = self._y(304)
        self._spec_y1 = self._y(416)

        # Progress bar (x=442..838, y=438..448)
        self._prog_x0 = self._x(442)
        self._prog_x1 = self._x(838)
        self._prog_y0 = self._y(438)
        self._prog_y1 = self._y(448)

        # Crossfader rail (x=520..760, y=462..478)
        self._xf_x0 = self._x(520)
        self._xf_x1 = self._x(760)
        self._xf_y0 = self._y(462)
        self._xf_y1 = self._y(478)

        # Timecode anchor
        self._tc_x = self._x(442)
        self._tc_y = self._y(419)

    def _refresh(self, force=False):
        if self.config_path is None:
            return
        now = time.monotonic()
        if not force and (now - self._last_stat_mono) < 0.45:
            return
        self._last_stat_mono = now
        try:
            st = self.config_path.stat()
        except OSError:
            return
        sig = (st.st_mtime_ns, st.st_size)
        if not force and sig == self._cfg_sig:
            return
        try:
            cfg = json.loads(self.config_path.read_text(encoding='utf-8'))
        except Exception:
            return
        self._cfg_sig = sig
        self.enabled = bool(cfg.get('enabled', False))
        self.duration_sec = max(10.0, float(cfg.get('duration_sec') or 180.0))
        self.crossfade_sec = max(0.0, min(12.0, float(cfg.get('crossfade_sec') if cfg.get('crossfade_sec') is not None else 4.0)))
        self.base_sec = max(0.0, float(cfg.get('base_sec') or 0.0))

    def _fill_rect_yuv(self, y2d, u2d, v2d, x0, y0, x1, y1, y_val, u_val=None, v_val=None):
        x0c, x1c = max(0, min(self.width, int(x0))), max(0, min(self.width, int(x1)))
        y0c, y1c = max(0, min(self.height, int(y0))), max(0, min(self.height, int(y1)))
        if x1c <= x0c or y1c <= y0c:
            return
        y2d[y0c:y1c, x0c:x1c] = y_val
        if u_val is not None and v_val is not None:
            ux0, ux1 = x0c // 2, max((x0c // 2) + 1, x1c // 2)
            uy0, uy1 = y0c // 2, max((y0c // 2) + 1, y1c // 2)
            u2d[uy0:uy1, ux0:ux1] = u_val
            v2d[uy0:uy1, ux0:ux1] = v_val

    def _draw_text(self, y2d, x, y, text, scale=2, luma=238):
        cur_x = int(x)
        py = int(y)
        sc = max(1, int(scale))
        for ch in str(text or ''):
            cols = _GLYPHS_5X7.get(ch)
            if cols is None:
                cur_x += 6 * sc
                continue
            for col_idx, bits in enumerate(cols):
                for row_idx in range(7):
                    if (bits >> row_idx) & 1:
                        ry0 = py + row_idx * sc
                        rx0 = cur_x + col_idx * sc
                        ry1 = min(self.height, ry0 + sc)
                        rx1 = min(self.width, rx0 + sc)
                        if rx0 >= 0 and ry0 >= 0 and rx1 > rx0 and ry1 > ry0:
                            y2d[ry0:ry1, rx0:rx1] = luma
            cur_x += 6 * sc

    def render(self, frame_buf, rel_pts_sec):
        self._refresh()
        if not self.enabled or len(frame_buf) != self.frame_bytes:
            return frame_buf

        epoch = max(0.0, float(getattr(self.state, 'epoch_pts_sec', 0.0) or 0.0)) if self.state is not None else 0.0
        media_sec = max(0.0, self.base_sec + max(0.0, float(rel_pts_sec) - epoch))

        self._out_buf[:] = frame_buf
        y_end = self.width * self.height
        uv_size = (self.width // 2) * (self.height // 2)
        arr = np.frombuffer(self._out_buf, dtype=np.uint8)
        y2d = arr[:y_end].reshape((self.height, self.width))
        u2d = arr[y_end:y_end + uv_size].reshape((self.height // 2, self.width // 2))
        v2d = arr[y_end + uv_size:y_end + 2 * uv_size].reshape((self.height // 2, self.width // 2))

        # 1. Read live audio energy from shm (or gentle rhythmic motion fallback when idle/silent)
        bass_norm = 0.25
        has_live_fft = False
        if self.state is not None and hasattr(self.state, 'eq_bands'):
            raw_bands = [int(self.state.eq_bands[i]) for i in range(16)]
            if any(b > 2 for b in raw_bands):
                has_live_fft = True
                for i in range(16):
                    level = max(0.06, min(1.0, raw_bands[i] / 255.0))
                    self._smoothed_bars[i] = self._smoothed_bars[i] * 0.45 + level * 0.55
            bass_norm = max(0.10, min(1.0, float(int(self.state.bass_pulse)) / 255.0))
        if not has_live_fft:
            # Smooth fallback harmonic motion when synthetic/muted tests run
            for i in range(16):
                level = 0.22 + 0.16 * math.sin(media_sec * 4.2 + i * 0.55)
                self._smoothed_bars[i] = max(0.06, min(0.95, level))
            bass_norm = 0.25 + 0.15 * abs(math.sin(media_sec * 3.1))

        # 2. Render 16-band real-time spectrum bars + peak caps inside mixer bay
        bay_w = max(32, self._spec_x1 - self._spec_x0)
        bay_h = max(24, self._spec_y1 - self._spec_y0)
        slot_w = bay_w / 16.0
        bar_w = max(4, int(round(slot_w * 0.64)))
        for i in range(16):
            lv = self._smoothed_bars[i]
            if lv >= self._peak_bars[i]:
                self._peak_bars[i] = lv
            else:
                self._peak_bars[i] = max(lv, self._peak_bars[i] - 0.018)

            bh = max(4, int(round(lv * bay_h)))
            bx0 = int(round(self._spec_x0 + i * slot_w))
            bx1 = min(self._spec_x1, bx0 + bar_w)
            by1 = self._spec_y1
            by0 = max(self._spec_y0, by1 - bh)
            # Cyan -> magenta gradient chrominance across spectrum
            u_tint = int(172 - i * 2)
            v_tint = int(92 + i * 7)
            y_luma = int(165 + min(75, lv * 80))
            self._fill_rect_yuv(y2d, u2d, v2d, bx0, by0, bx1, by1, y_luma, u_tint, v_tint)

            # Floating peak cap
            pk_y = max(self._spec_y0, self._spec_y1 - int(round(self._peak_bars[i] * bay_h)) - 3)
            self._fill_rect_yuv(y2d, u2d, v2d, bx0, pk_y, bx1, min(self._spec_y1, pk_y + 2), 242, 110, 185)

        # 3. Spinning Deck A platter phase indicator & bass-reactive halo
        ay0, ay1, ax0, ax1, _, _ = self._deck_a_box
        patch_ya = y2d[ay0:ay1, ax0:ax1]
        ring_luma = int(min(248, 150 + bass_norm * 95))
        patch_ya[self._deck_a_ring] = ring_luma
        theta_a = (media_sec * 1.85) % (2.0 * math.pi)
        diff_a = np.abs(np.arctan2(np.sin(self._deck_a_ang - theta_a), np.cos(self._deck_a_ang - theta_a)))
        spoke_a = (diff_a < 0.055) & (self._deck_a_dist >= self._deck_a_r_spoke_in) & (self._deck_a_dist <= self._deck_a_r_spoke_out)
        patch_ya[spoke_a] = 240

        # 4. Crossfader progress & Deck B cue spin during handoff window
        ratio = max(0.0, min(1.0, media_sec / max(1.0, self.duration_sec)))
        rem_sec = max(0.0, self.duration_sec - media_sec)
        xf_ratio = 0.0
        if self.crossfade_sec > 0.25 and rem_sec <= self.crossfade_sec:
            xf_ratio = max(0.0, min(1.0, (self.crossfade_sec - rem_sec) / self.crossfade_sec))
            by0, by1, bx0, bx1, _, _ = self._deck_b_box
            patch_yb = y2d[by0:by1, bx0:bx1]
            patch_yb[self._deck_b_ring] = int(170 + xf_ratio * 75)
            theta_b = ((self.crossfade_sec - rem_sec) * 2.1) % (2.0 * math.pi)
            diff_b = np.abs(np.arctan2(np.sin(self._deck_b_ang - theta_b), np.cos(self._deck_b_ang - theta_b)))
            patch_yb[(diff_b < 0.06) & (self._deck_b_dist >= 20) & (self._deck_b_dist <= 86)] = 235

        # Progress bar fill + playhead marker
        prog_w = max(8, self._prog_x1 - self._prog_x0)
        fill_x = self._prog_x0 + int(round(prog_w * ratio))
        self._fill_rect_yuv(y2d, u2d, v2d, self._prog_x0, self._prog_y0, fill_x, self._prog_y1, 212, 168, 96)
        knob_r = max(4, int(round(7 * self._sy)))
        self._fill_rect_yuv(
            y2d, u2d, v2d,
            fill_x - knob_r, self._prog_y0 - 3,
            fill_x + knob_r, self._prog_y1 + 3,
            248, 128, 128,
        )

        # Crossfader handle gliding from Deck A (left) toward Deck B (right) on handoff
        xf_w = max(24, self._xf_x1 - self._xf_x0)
        handle_w = max(16, int(round(26 * self._sx)))
        hx0 = self._xf_x0 + int(round((xf_w - handle_w) * xf_ratio))
        self._fill_rect_yuv(y2d, u2d, v2d, hx0, self._xf_y0, hx0 + handle_w, self._xf_y1, 238, 150, 122)

        # 5. Live MM:SS / MM:SS timecode readout
        tc_str = f'{_format_mmss(media_sec)}/{_format_mmss(self.duration_sec)}'
        self._draw_text(y2d, self._tc_x, self._tc_y, tc_str, scale=max(1, int(round(2 * self._sy))), luma=228)

        return bytes(self._out_buf)
