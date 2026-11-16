"""Shared subtitle parser (SRT/VTT/ASS -> ASS/cue spans) and audio-speech cross-correlator."""

import argparse
from array import array
import bisect
from collections import deque
import html
import json
import math
import os
from pathlib import Path
import re
import statistics
import subprocess
import sys
import threading
import time
import urllib.request

PROMO_SUB_RE = re.compile(
    r'\b(?:opensubtitles\.(?:org|com)|osdb\.link|subscene\.com|yify-?subtitles|addic7ed\.com|'
    r'podnapisi\.net|hoofoot\.ru|subdl\.com|subf2m\.|subtitlecat\.|tvsubtitles\.|titlovi\.com|'
    r'advertise\s+your\s+product|api\.opensubtitles|ai\.opensubtitles)\b',
    re.I,
)


def parse_timestamp_ms(raw):
    cleaned = str(raw or '').strip()
    m = re.match(r'^(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})$', cleaned)
    if m:
        ms = int(m[4].ljust(3, '0')[:3])
        return (((int(m[1]) * 60) + int(m[2])) * 60 + int(m[3])) * 1000 + ms
    s = re.match(r'^(\d{1,2}):(\d{2})[,.](\d{1,3})$', cleaned)
    if s:
        ms = int(s[3].ljust(3, '0')[:3])
        return ((int(s[1]) * 60) + int(s[2])) * 1000 + ms
    return None


_ASS_TS_RE = re.compile(r'^(\d+):(\d{1,2}):(\d{1,2})[.:](\d{1,3})$')


def _parse_ass_ts_ms(raw):
    m = _ASS_TS_RE.match(str(raw or '').strip())
    if not m:
        return None
    frac = m[4]
    ms = int(frac) * (10 if len(frac) == 2 else (100 if len(frac) == 1 else 1))
    return (((int(m[1]) * 60) + int(m[2])) * 60 + int(m[3])) * 1000 + ms


def format_ass_ts(ms):
    ms = max(0, int(ms))
    cs = (ms // 10) % 100
    total_s = ms // 1000
    s = total_s % 60
    total_m = total_s // 60
    m = total_m % 60
    h = total_m // 60
    return f'{h}:{m:02d}:{s:02d}.{cs:02d}'


_ASS_SAFE_TAG_RE = re.compile(r'^\{\\(?:an?\d|[ibu][01]|pos\([^}]+\)|fs\d+(?:\.\d+)?)\}$', re.I)


def _clean_text_to_ass(raw_lines):
    joined = '\n'.join(raw_lines).strip()
    if not joined:
        return ''
    # Map simple HTML inline styling before stripping arbitrary tags and decoding HTML entities.
    text = re.sub(r'<\s*i\s*>', r'{\\i1}', joined, flags=re.I)
    text = re.sub(r'<\s*/\s*i\s*>', r'{\\i0}', text, flags=re.I)
    text = re.sub(r'<\s*b\s*>', r'{\\b1}', text, flags=re.I)
    text = re.sub(r'<\s*/\s*b\s*>', r'{\\b0}', text, flags=re.I)
    text = re.sub(r'<\s*u\s*>', r'{\\u1}', text, flags=re.I)
    text = re.sub(r'<\s*/\s*u\s*>', r'{\\u0}', text, flags=re.I)
    text = re.sub(r'<\s*br\s*/?\s*>', '\n', text, flags=re.I)
    text = re.sub(r'<[^>]+>', '', text)
    text = html.unescape(text)
    text = text.replace('\xa0', ' ').replace('\\h', ' ')
    # Preserve standard ASS override tags such as {\an8} while stripping unsupported inline tags.
    text = re.sub(r'\{[^}]+\}', lambda m: m.group(0) if _ASS_SAFE_TAG_RE.match(m.group(0)) else '', text)
    lines = [re.sub(r'[ \t]{2,}', ' ', ln).strip() for ln in text.split('\n')]
    lines = [ln for ln in lines if ln]
    if not lines:
        return ''
    if len(lines) > 3:
        lines = lines[:2] + [' '.join(lines[2:])]
    ass_text = r'\N'.join(lines).strip()
    plain = re.sub(r'\{[^}]+\}', '', ass_text).replace(r'\N', ' ').strip()
    if not plain or PROMO_SUB_RE.search(plain):
        return ''
    return ass_text


def _is_progressive_prefix(prev_key, cur_key):
    if not prev_key or not cur_key or len(cur_key) <= len(prev_key):
        return False
    return cur_key.startswith(prev_key + ' ') or cur_key.startswith(prev_key + '\n')


def dedupe_overlapping_cues(cues, *, trim_overlaps=True, max_cue_ms=20000):
    """Merge back-to-back duplicate or progressive cues and trim overlaps to avoid flicker."""
    if not cues:
        return []
    ordered = sorted(cues, key=lambda c: (c[0], c[1]))
    out = []
    for s_ms, e_ms, txt in ordered:
        s_i = max(0, int(s_ms))
        e_i = max(s_i + 1, int(e_ms))
        if trim_overlaps and (e_i - s_i) > max_cue_ms:
            e_i = s_i + 12000
        plain = re.sub(r'\{[^}]+\}', '', str(txt or '')).replace(r'\N', ' ').replace(r'\h', ' ')
        key = re.sub(r'\s+', ' ', plain).strip().lower()
        if not key or PROMO_SUB_RE.search(key):
            continue
        if out:
            ps, pe, pt, pkey = out[-1]
            # Merge exact repeat within 250ms, or progressive WebVTT extension within single cue span
            if (key == pkey and s_i <= pe + 250) or (
                trim_overlaps and _is_progressive_prefix(pkey, key) and (e_i - ps) <= 6000 and s_i <= pe + 150
            ):
                out[-1] = (ps, max(pe, e_i), txt if len(key) >= len(pkey) else pt, key)
                continue
            # Also drop/merge when a new cue shrinks back to an identical suffix or overlaps <= 1500ms
            if trim_overlaps and pe > s_i:
                overlap = pe - s_i
                if s_i - ps >= 200 and overlap <= 1500:
                    out[-1] = (ps, max(ps + 200, s_i - 10), pt, pkey)
        out.append((s_i, e_i, txt, key))
    return [(s, e, t) for s, e, t, _ in out]


def parse_subtitle_cues(raw_text, *, is_ass=False):
    """Return sorted list of (start_ms, end_ms, ass_text) tuples."""
    text = str(raw_text or '').lstrip('\ufeff').replace('\r\n', '\n').replace('\r', '\n')
    if not text.strip():
        return []

    if is_ass or ('[Events]' in text and 'Dialogue:' in text):
        cues = []
        in_events = False
        format_cols = ['Layer', 'Start', 'End', 'Style', 'Name', 'MarginL', 'MarginR', 'MarginV', 'Effect', 'Text']
        for line in text.split('\n'):
            st = line.strip()
            if st.startswith('['):
                in_events = (st.lower() == '[events]')
                continue
            if not in_events:
                continue
            if st.lower().startswith('format:'):
                format_cols = [c.strip() for c in st.split(':', 1)[1].split(',')]
                continue
            if st.lower().startswith('dialogue:'):
                body = st.split(':', 1)[1].lstrip()
                parts = body.split(',', max(0, len(format_cols) - 1))
                if len(parts) < 3:
                    continue
                idx_s = next((i for i, c in enumerate(format_cols) if c.lower() == 'start'), 1)
                idx_e = next((i for i, c in enumerate(format_cols) if c.lower() == 'end'), 2)
                idx_t = len(format_cols) - 1
                s_ms = _parse_ass_ts_ms(parts[idx_s])
                e_ms = _parse_ass_ts_ms(parts[idx_e])
                txt = parts[idx_t].strip() if idx_t < len(parts) else ''
                if s_ms is not None and e_ms is not None and e_ms > s_ms and txt and not PROMO_SUB_RE.search(txt):
                    cues.append((s_ms, e_ms, txt))
        return dedupe_overlapping_cues(cues, trim_overlaps=False)

    cues = []
    for block in re.split(r'\n{2,}', text):
        lines = [l.strip() for l in block.split('\n') if l.strip()]
        if not lines:
            continue
        if re.match(r'^(?:WEBVTT|NOTE\b|STYLE\b|REGION\b)', lines[0], re.I):
            continue
        ti = next((i for i, l in enumerate(lines) if '-->' in l), -1)
        if ti < 0:
            continue
        parts = [p.strip().split()[0] for p in lines[ti].split('-->') if p.strip()]
        if len(parts) < 2:
            continue
        st_ms = parse_timestamp_ms(parts[0])
        en_ms = parse_timestamp_ms(parts[1])
        if st_ms is None or en_ms is None or en_ms <= st_ms:
            continue
        body = _clean_text_to_ass(lines[ti + 1:])
        if body:
            cues.append((st_ms, en_ms, body))
    return dedupe_overlapping_cues(cues, trim_overlaps=True)


_ASS_NON_SPEECH_STYLE_RE = re.compile(
    r'(?:^|[^a-z])(sign|signs|title|titles|op|ed|song|songs|lyric|lyrics|kara|karaoke|credit|credits|eyecatch|typeset|note)(?:$|[^a-z])',
    re.IGNORECASE,
)


def _ass_plain_text(raw_text):
    t = str(raw_text or '')
    if re.search(r'\{\\[^}]*\\p[1-9][^}]*\}', t) or t.lstrip().startswith(r'{\p'):
        return ''
    t = re.sub(r'\{[^}]+\}', '', t)
    t = t.replace(r'\N', ' ').replace(r'\n', ' ').replace(r'\h', ' ')
    return re.sub(r'\s+', ' ', t).strip()


def _normalize_ass_script(raw, width=1280, height=720, fallback_cues=None):
    """Strip promo/empty ASS Dialogue events and separate speech spans from signage/karaoke."""
    normalized = raw.replace('\r\n', '\n').replace('\r', '\n')
    if 'PlayResX:' not in normalized:
        normalized = normalized.replace(
            '[Script Info]',
            f'[Script Info]\nPlayResX: {int(width)}\nPlayResY: {int(height)}',
            1,
        )

    lines = normalized.split('\n')
    out_lines = []
    in_events = False
    col_names = None
    all_spans = []
    speech_spans = []
    seen_events = set()

    for line in lines:
        stripped = line.strip()
        if stripped.startswith('[') and stripped.endswith(']'):
            in_events = (stripped.lower() == '[events]')
            if in_events:
                col_names = None
            out_lines.append(line)
            continue

        if in_events and stripped.lower().startswith('format:'):
            cols = [c.strip().lower() for c in stripped.split(':', 1)[1].split(',')]
            col_names = cols
            out_lines.append(line)
            continue

        if in_events and stripped.startswith('Dialogue:'):
            body = line.split(':', 1)[1].lstrip()
            cols = col_names or ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text']
            parts = body.split(',', len(cols) - 1)
            if len(parts) == len(cols):
                idx_map = {name: i for i, name in enumerate(cols)}
                s_ms = _parse_ass_ts_ms(parts[idx_map.get('start', 1)])
                e_ms = _parse_ass_ts_ms(parts[idx_map.get('end', 2)])
                style = parts[idx_map.get('style', 3)].strip() if 'style' in idx_map else ''
                effect = parts[idx_map.get('effect', 8)].strip() if 'effect' in idx_map else ''
                raw_txt = parts[idx_map.get('text', len(cols) - 1)]
                plain = _ass_plain_text(raw_txt)
                key = plain.lower()
                is_draw = bool(re.search(r'\\p[1-9]', raw_txt))
                if s_ms is None or e_ms is None or e_ms <= s_ms:
                    continue
                if not is_draw and (not key or PROMO_SUB_RE.search(key)):
                    continue
                ev_sig = (s_ms, e_ms, style, key)
                if not is_draw and ev_sig in seen_events:
                    continue
                seen_events.add(ev_sig)
                out_lines.append(line)
                if key:
                    all_spans.append((s_ms, e_ms))
                    has_karaoke = bool(re.search(r'\{\\[^}]*\\k[fo]?\d', raw_txt, re.IGNORECASE))
                    if not (
                        _ASS_NON_SPEECH_STYLE_RE.search(style)
                        or _ASS_NON_SPEECH_STYLE_RE.search(effect)
                        or has_karaoke
                    ):
                        speech_spans.append((s_ms, e_ms))
                continue

        out_lines.append(line)

    spans = speech_spans if len(speech_spans) >= 4 else (all_spans if all_spans else [(c[0], c[1]) for c in (fallback_cues or [])])
    spans = sorted(set(spans))
    return '\n'.join(out_lines).encode('utf-8'), spans


def subtitles_to_ass(sub_path, width=1280, height=720):
    """Load .srt/.vtt/.ass file and return (ass_bytes, sorted_spans[(start_ms, end_ms)])."""
    p = Path(sub_path)
    raw = p.read_text(encoding='utf-8', errors='replace').lstrip('\ufeff')
    is_ass = p.suffix.lower() in {'.ass', '.ssa'}
    cues = parse_subtitle_cues(raw, is_ass=is_ass)
    spans = [(c[0], c[1]) for c in cues]

    if is_ass and '[Events]' in raw and 'Dialogue:' in raw:
        return _normalize_ass_script(raw, width=width, height=height, fallback_cues=cues)

    h = max(240, int(height or 720))
    w = max(320, int(width or 1280))
    # Keep readable proportional typography on both 16:9 HD and ultra-wide 2.39:1 cinema frames.
    h_eff = max(h, int(round(w * 9.0 / 16.0)))
    font_sz = max(20, min(62, int(round(h * 0.056))))
    margin_v = max(18, int(round(h * 0.052)))
    margin_lr = max(28, int(round(w * 0.045)))
    outline_w = max(2.0, round(h_eff * 0.0028, 1))
    header = (
        '[Script Info]\n'
        'ScriptType: v4.00+\n'
        f'PlayResX: {w}\n'
        f'PlayResY: {h}\n'
        'WrapStyle: 0\n'
        'ScaledBorderAndShadow: yes\n\n'
        '[V4+ Styles]\n'
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, '
        'Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, '
        'Alignment, MarginL, MarginR, MarginV, Encoding\n'
        f'Style: Default,DejaVu Sans,{font_sz},&H00FFFFFF,&H000000FF,&H00000000,&HA0000000,'
        f'-1,0,0,0,100,100,0.2,0,1,{outline_w},1.6,2,{margin_lr},{margin_lr},{margin_v},1\n\n'
        '[Events]\n'
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'
    )
    events = [
        f'Dialogue: 0,{format_ass_ts(s_ms)},{format_ass_ts(e_ms)},Default,,0,0,0,,{txt}'
        for s_ms, e_ms, txt in cues
    ]
    return (header + '\n'.join(events) + '\n').encode('utf-8'), spans


_SPAN_MAX_LEN_CACHE = {}


def _get_max_span_ms(spans):
    key = (id(spans), len(spans), spans[0] if spans else None, spans[-1] if spans else None)
    hit = _SPAN_MAX_LEN_CACHE.get(key)
    if hit is not None:
        return hit
    max_len = 0
    for s_ms, e_ms in spans:
        dur = e_ms - s_ms
        if dur > max_len:
            max_len = dur
    if len(_SPAN_MAX_LEN_CACHE) > 32:
        _SPAN_MAX_LEN_CACHE.clear()
    _SPAN_MAX_LEN_CACHE[key] = max_len
    return max_len


def has_active_cue_near(spans, pts_ms, margin_ms=40):
    """O(log N) exact check whether any cue span overlaps [pts_ms - margin_ms, pts_ms + margin_ms]."""
    if not spans:
        return False
    lo_t = pts_ms - margin_ms
    hi_t = pts_ms + margin_ms
    max_span = _get_max_span_ms(spans)
    idx = bisect.bisect_right(spans, (hi_t, 1 << 60))
    for i in range(idx - 1, -1, -1):
        s_ms, e_ms = spans[i]
        if e_ms >= lo_t and s_ms <= hi_t:
            return True
        if (hi_t - s_ms) > max_span + margin_ms + 1000:
            break
    return False


_SDH_BRACKET_RE = re.compile(r'\[[^\]]*\]|\([^)]*\)|\{[^}]*\}')
_SDH_MUSIC_LINE_RE = re.compile(r'(?:^|\s)[♪♫].*?(?:[♪♫]|$)')
_SDH_SPEAKER_PREFIX_RE = re.compile(r'^[A-Z0-9][A-Z0-9 .\'_-]{0,22}:\s*')
_SPOKEN_WORD_RE = re.compile(r'[A-Za-z0-9\u00C0-\u024F\u0400-\u04FF\u0600-\u06FF\u3040-\u30FF\u4E00-\u9FFF]')


def filter_speech_cues(cues, *, min_fallback=4):
    """Filter out pure SDH sound-effect / music cues (e.g., (WIND HOWLING), [SCREAMS], ♪) while preserving spoken cues."""
    if not cues:
        return []
    has_text = any(str(t or '').strip() for _, _, t in cues)
    if not has_text:
        return list(cues)
    spoken = []
    for s_ms, e_ms, txt in cues:
        raw = str(txt or '').replace(r'\N', ' ').replace(r'\h', ' ').replace('\n', ' ')
        # Strip ASS/SDH annotations and music cues before checking whether spoken words remain.
        cleaned = _SDH_BRACKET_RE.sub(' ', raw)
        cleaned = _SDH_MUSIC_LINE_RE.sub(' ', cleaned)
        cleaned = _SDH_SPEAKER_PREFIX_RE.sub('', cleaned.strip())
        cleaned = re.sub(r'[♪♫\-–—.,!?;:\'\"*~]+', ' ', cleaned).strip()
        if not cleaned or PROMO_SUB_RE.search(cleaned):
            continue
        if _SPOKEN_WORD_RE.search(cleaned):
            spoken.append((s_ms, e_ms, txt))
    if len(spoken) >= max(1, int(min_fallback)):
        return spoken
    return list(cues)


def choose_probe_window(cues, seek_offset=0.0, window_sec=120.0):
    """Pick the best dialogue-dense probe window (skipping 0-85s anime OP/intro themes on start)."""
    if not cues:
        return max(0.0, float(seek_offset or 0.0)), window_sec
    speech_cues = filter_speech_cues(cues)
    dialogue = [(s / 1000.0, e / 1000.0) for s, e, _ in speech_cues if 0.25 <= (e - s) / 1000.0 <= 12.0]
    if not dialogue:
        dialogue = [(s / 1000.0, e / 1000.0) for s, e, _ in speech_cues]
    max_t = dialogue[-1][1]
    base_seek = max(0.0, float(seek_offset or 0.0))
    if base_seek > 5.0:
        return base_seek, min(window_sec, max(45.0, max_t - base_seek + 20.0))

    search_min = 85.0 if max_t > 240.0 else 0.0
    starts = [s for s, _ in dialogue if s >= search_min]
    if not starts:
        starts = [s for s, _ in dialogue]
    for st in starts:
        cand_end = st + window_sec
        count = sum(1 for s, e in dialogue if s >= st and e <= cand_end)
        if count >= 10:
            return max(0.0, st - 4.0), window_sec
    return max(0.0, starts[0] - 4.0) if starts else 0.0, min(window_sec, max(45.0, max_t + 10.0))


def _speech_activity_envelope(pcm_s16le_8k, bin_sec=0.1, sample_rate=8000):
    samples = array('h')
    samples.frombytes(pcm_s16le_8k[:len(pcm_s16le_8k) - (len(pcm_s16le_8k) % 2)])
    step = max(1, int(round(sample_rate * bin_sec)))
    n_bins = len(samples) // step
    if n_bins < 40:
        return [], []

    log_e = []
    for i in range(n_bins):
        off = i * step
        chunk = samples[off:off + step]
        sq = sum(x * x for x in chunk) / float(step)
        log_e.append(math.log1p(math.sqrt(sq)))

    # Chunk-local (25s) 20th-percentile baseline + syllable flux so quiet dialogue scenes
    # aren't drowned out by one later loud music/action sequence, and continuous BGM isn't misread as dialogue.
    half_win = max(60, int(round(12.5 / bin_sec)))
    act = [0.0] * n_bins
    for i in range(n_bins):
        lo = max(0, i - half_win)
        hi = min(n_bins, i + half_win + 1)
        win = sorted(log_e[lo:hi])
        floor = win[max(0, int(len(win) * 0.20))]
        ceil = win[min(len(win) - 1, int(len(win) * 0.92))]
        span = max(0.65, ceil - floor)
        flux = abs(log_e[i] - log_e[i - 1]) if i > 0 else 0.0
        level = max(0.0, log_e[i] - (floor + 0.22)) / span
        raw_v = min(1.0, 0.72 * level + 0.45 * min(1.0, flux / 0.85))
        act[i] = raw_v

    gap_bins = max(3, int(round(0.4 / bin_sec)))
    onset = [0.0] * n_bins
    for i in range(gap_bins, n_bins):
        prev_max = max(act[i - gap_bins:i])
        onset[i] = max(0.0, act[i] - prev_max)
    return act, onset


def correlate_speech_and_cues(
    pcm_s16le_8k,
    cues,
    probe_start_sec,
    *,
    max_shift_sec=16.0,
    fine_step_sec=0.1,
    same_route=False,
    min_cues=6,
    min_z=None,
):
    """Cross-correlate vocal-band modulation & onsets against subtitle dialogue intervals.

    Enforces split-window consensus across both halves of the probe audio so continuous BGM/SFX
    in a single scene cannot produce false shift adjustments.
    """
    bin_sec = 0.1
    act, onset = _speech_activity_envelope(pcm_s16le_8k, bin_sec=bin_sec, sample_rate=8000)
    n_audio = len(act)
    if n_audio < 100 or not cues:
        return {'ok': False, 'reason': 'insufficient_audio_or_cues', 'offset': 0.0, 'confident': False}

    cues = filter_speech_cues(cues)

    mean_act = sum(act) / float(n_audio)
    act_zm = [a - mean_act for a in act]
    mean_onset = sum(onset) / float(n_audio)
    onset_zm = [o - mean_onset for o in onset]

    pad_sec = max_shift_sec + 3.0
    grid_origin = float(probe_start_sec) - pad_sec
    audio_dur = n_audio * bin_sec
    grid_bins = int(math.ceil((audio_dur + 2.0 * pad_sec) / bin_sec)) + 4
    cue_grid = [0.0] * grid_bins
    onset_grid = [0.0] * grid_bins

    prev_end_s = -999.0
    used_cues = 0
    for s_ms, e_ms, _ in cues:
        s_s = s_ms / 1000.0
        e_s = e_ms / 1000.0
        if (e_s - s_s) > 14.0 or e_s < grid_origin or s_s > grid_origin + grid_bins * bin_sec:
            prev_end_s = max(prev_end_s, e_s)
            continue
        used_cues += 1
        b0 = max(0, int(round((s_s - grid_origin) / bin_sec)))
        b1 = min(grid_bins, int(round((e_s - grid_origin) / bin_sec)) + 1)
        for b in range(b0, b1):
            cue_grid[b] = 1.0
        if (s_s - prev_end_s) >= 0.55:
            ob0 = max(0, int(round((s_s - 0.1 - grid_origin) / bin_sec)))
            ob1 = min(grid_bins, int(round((s_s + 0.35 - grid_origin) / bin_sec)) + 1)
            for b in range(ob0, ob1):
                onset_grid[b] = 1.0
        prev_end_s = e_s

    if used_cues < max(3, int(min_cues or 6)):
        return {'ok': False, 'reason': 'insufficient_cues_in_window', 'offset': 0.0, 'confident': False, 'in_sync': False}

    pad_bins = int(round(pad_sec / bin_sec))

    def score_range(shift_bins, lo_idx, hi_idx):
        base = pad_bins - shift_bins
        if base < 0 or base + n_audio > grid_bins or hi_idx <= lo_idx:
            return -1e9
        ov = 0.0
        on = 0.0
        for i in range(lo_idx, hi_idx):
            if cue_grid[base + i] > 0.0:
                ov += act_zm[i]
            if onset_grid[base + i] > 0.0:
                on += onset_zm[i]
        return (ov + 0.70 * on) / float(hi_idx - lo_idx)

    max_bins = int(round(max_shift_sec / bin_sec))
    coarse_scores = {sb: score_range(sb, 0, n_audio) for sb in range(-max_bins, max_bins + 1, 2)}
    score_at_0 = coarse_scores.get(0, score_range(0, 0, n_audio))
    best_coarse_sb = max(coarse_scores, key=lambda k: coarse_scores[k])

    best_sb = best_coarse_sb
    best_score = coarse_scores[best_coarse_sb]
    fine_step_bins = max(1, int(round(fine_step_sec / bin_sec)))
    for sb in range(best_coarse_sb - 4, best_coarse_sb + 5, fine_step_bins):
        if -max_bins <= sb <= max_bins:
            sc = score_range(sb, 0, n_audio)
            if sc > best_score:
                best_score = sc
                best_sb = sb

    excl = int(round(2.5 / bin_sec))
    far_vals = [sc for sb, sc in coarse_scores.items() if abs(sb - best_sb) > excl and sc > -1e8]
    if len(far_vals) < 10:
        return {'ok': False, 'reason': 'insufficient_sweep', 'offset': 0.0, 'confident': False}

    far_mean = statistics.fmean(far_vals)
    far_std = statistics.pstdev(far_vals) if len(far_vals) > 1 else 0.0
    z_score = (best_score - far_mean) / max(far_std, 1e-6)
    best_offset = round(best_sb * bin_sec, 1)

    best_base = pad_bins - best_sb
    aligned_cue_bins = sum(1 for b in cue_grid[best_base:best_base + n_audio] if b > 0.0)
    cue_duty = aligned_cue_bins / float(n_audio)
    sane_duty = (0.08 <= cue_duty <= 0.72)

    # Split-window consensus check for windows >= 30s so single-scene BGM/SFX cannot bias shift
    # (short <30s windows have sub-windows <= max_shift_sec which can alias periodic cues)
    half_consensus = True
    if n_audio >= 300:
        half_consensus = False
        mid = n_audio // 2
        h1_peak_sb = max(range(-max_bins, max_bins + 1, 2), key=lambda sb: score_range(sb, 0, mid))
        h2_peak_sb = max(range(-max_bins, max_bins + 1, 2), key=lambda sb: score_range(sb, mid, n_audio))
        h1_at_best = score_range(best_sb, 0, mid)
        h2_at_best = score_range(best_sb, mid, n_audio)
        h1_at_0 = score_range(0, 0, mid)
        h2_at_0 = score_range(0, mid, n_audio)
        tol = int(round(1.0 / bin_sec))
        pair_tol = int(round(1.4 / bin_sec))
        both_halves_gain = (h1_at_best > h1_at_0 and h2_at_best > h2_at_0)
        close_peaks = (
            abs(h1_peak_sb - best_sb) <= tol
            and abs(h2_peak_sb - best_sb) <= tol
            and abs(h1_peak_sb - h2_peak_sb) <= pair_tol
        )
        half_consensus = bool(both_halves_gain and close_peaks)

    req_z = float(min_z) if min_z is not None else (3.6 if same_route else 2.7)
    min_delta = 0.8 if same_route else 0.5
    gain_ratio = 1.28 if same_route else 1.20
    z_at_0 = (score_at_0 - far_mean) / max(far_std, 1e-6)
    confident = bool(
        sane_duty
        and half_consensus
        and z_score >= req_z
        and best_score > 0.004
        and abs(best_offset) >= min_delta
        and best_score > max(0.0, score_at_0) * gain_ratio + (far_std * 0.6)
    )
    in_sync_confirmed = bool(
        used_cues >= max(3, int(min_cues or 6))
        and score_at_0 > 0.004
        and z_at_0 >= 2.2
        and not confident
        and (
            abs(best_offset) < min_delta
            or best_score <= max(0.0, score_at_0) * gain_ratio + (far_std * 0.6)
        )
    )
    return {
        'ok': True,
        'offset': best_offset if confident else 0.0,
        'raw_best_offset': best_offset,
        'z_score': round(z_score, 2),
        'z_at_0': round(z_at_0, 2),
        'score_at_0': round(score_at_0, 5),
        'best_score': round(best_score, 5),
        'cue_duty': round(cue_duty, 3),
        'half_consensus': half_consensus,
        'confident': confident,
        'in_sync': in_sync_confirmed,
        'used_cues': used_cues,
    }


_HLS_TRIM_DELTA_CACHE = {}


def _fetch_hls_skipped_hdrs(url):
    v_skip = None
    a_skip = None
    try:
        req = urllib.request.Request(url, method='GET')
        with urllib.request.urlopen(req, timeout=4.0) as resp:
            vh = resp.headers.get('X-Lancy-Skipped-Sec')
            ah = resp.headers.get('X-Lancy-Audio-Skipped-Sec')
            dh = resp.headers.get('X-Lancy-Audio-Trim-Delta')
            if vh is not None:
                v_skip = float(vh)
            if ah is not None:
                a_skip = float(ah)
            if dh is not None:
                if len(_HLS_TRIM_DELTA_CACHE) > 256:
                    _HLS_TRIM_DELTA_CACHE.clear()
                _HLS_TRIM_DELTA_CACHE[str(url)] = max(0.0, float(dh))
    except Exception:
        pass
    return v_skip, a_skip


def _fetch_hls_audio_trim_delta(url):
    return _HLS_TRIM_DELTA_CACHE.get(str(url))


def _fetch_hls_skipped_sec(url):
    v_skip, _ = _fetch_hls_skipped_hdrs(url)
    return v_skip


def _resolve_ffprobe_bin(ffmpeg_bin):
    fb = str(ffmpeg_bin or 'ffmpeg')
    if 'ffmpeg' in os.path.basename(fb):
        return os.path.join(os.path.dirname(fb), os.path.basename(fb).replace('ffmpeg', 'ffprobe')) if os.path.dirname(fb) else fb.replace('ffmpeg', 'ffprobe')
    return 'ffprobe'


def _probe_hls_packet_start_sec(ffmpeg_bin, base_url, probe_url, fallback_skipped=None, origin_pts_sec=None):
    """Measure true movie-timeline start time of probe_url's first audio packet via ffprobe."""
    ffprobe_bin = _resolve_ffprobe_bin(ffmpeg_bin)
    try:
        r_a = subprocess.run(
            [
                ffprobe_bin, '-v', 'error', '-select_streams', 'a:0',
                '-show_entries', 'packet=pts_time', '-read_intervals', '%+#3',
                '-of', 'default=nw=1:nk=1', probe_url,
            ],
            capture_output=True, text=True, timeout=8,
        )
        a_pts = None
        for ln in (r_a.stdout or '').splitlines():
            try:
                val = float(ln.strip())
                if val == val:
                    a_pts = val
                    break
            except ValueError:
                continue
        if a_pts is None:
            return float(fallback_skipped) if fallback_skipped is not None else None

        if origin_pts_sec is not None:
            origin = float(origin_pts_sec)
        else:
            r_base = subprocess.run(
                [
                    ffprobe_bin, '-v', 'error',
                    '-show_entries', 'packet=codec_type,pts_time', '-read_intervals', '%+#12',
                    '-of', 'csv=p=0', base_url,
                ],
                capture_output=True, text=True, timeout=8,
            )
            v0 = None
            a0 = None
            for ln in (r_base.stdout or '').splitlines():
                parts = [p.strip() for p in ln.split(',')]
                if len(parts) < 2:
                    continue
                ctype, ts_s = parts[0], parts[1]
                try:
                    val = float(ts_s)
                except ValueError:
                    continue
                if val != val:
                    continue
                if ctype == 'video' and v0 is None:
                    v0 = val
                elif ctype == 'audio' and a0 is None:
                    a0 = val

            if v0 is not None and (a0 is None or abs(a0 - v0) <= 15.0):
                origin = v0
            elif a0 is not None:
                origin = a0
            else:
                origin = 0.0

        pts_start = a_pts - origin
        if pts_start >= -0.5 and (fallback_skipped is None or abs(pts_start - float(fallback_skipped)) <= 12.0):
            return max(0.0, pts_start)
    except Exception:
        pass
    return float(fallback_skipped) if fallback_skipped is not None else None


def probe_audio_and_align(
    media_url,
    sub_path,
    *,
    seek_offset=0.0,
    is_hls_proxy=False,
    same_route=False,
    audio_stream_index=None,
    ffmpeg_bin='ffmpeg',
    max_shift_sec=25.0,
    origin_pts_sec=None,
):
    """Extract speech-band audio over an active dialogue window and correlate with subtitle cues."""
    p = Path(sub_path)
    if not p.is_file():
        return {'ok': False, 'reason': 'missing_sub_file', 'offset': 0.0, 'confident': False}
    raw = p.read_text(encoding='utf-8', errors='replace').lstrip('\ufeff')
    is_ass = p.suffix.lower() in {'.ass', '.ssa'}
    cues = parse_subtitle_cues(raw, is_ass=is_ass)
    if is_ass and '[Events]' in raw and 'Dialogue:' in raw:
        _, speech_spans = _normalize_ass_script(raw, fallback_cues=cues)
        if len(speech_spans) >= 6:
            span_set = set(speech_spans)
            ass_spoken = [c for c in cues if (c[0], c[1]) in span_set]
            cues = filter_speech_cues(ass_spoken) if len(ass_spoken) >= 6 else [(s, e, '') for s, e in speech_spans]
    else:
        cues = filter_speech_cues(cues)
    if len(cues) < 6:
        return {'ok': False, 'reason': 'few_cues', 'offset': 0.0, 'confident': False}

    win_start, win_sec = choose_probe_window(cues, seek_offset=seek_offset, window_sec=110.0)
    actual_start = win_start
    a_map = f'0:{int(audio_stream_index)}' if audio_stream_index is not None else '0:a:0'
    sel_stream = str(int(audio_stream_index)) if audio_stream_index is not None else 'a:0'

    base_url = re.sub(r'[?&]start=[0-9.]+', '', str(media_url or ''))

    def _run_probe_window(req_start, req_sec, win_max_shift=None):
        nonlocal actual_start
        eff_actual = req_start
        if is_hls_proxy and req_start > 0.05:
            sep = '&' if '?' in base_url else '?'
            probe_url = f'{base_url}{sep}start={req_start:.3f}'
            v_skipped, a_skipped = _fetch_hls_skipped_hdrs(probe_url)
            skipped = a_skipped if a_skipped is not None else v_skipped
            probed_start = _probe_hls_packet_start_sec(
                ffmpeg_bin, base_url, probe_url, fallback_skipped=skipped, origin_pts_sec=origin_pts_sec
            )
            if probed_start is not None:
                eff_actual = float(probed_start)
            elif skipped is not None:
                eff_actual = float(skipped)
            else:
                try:
                    pr = subprocess.run(
                        ['ffprobe', '-v', 'error', '-select_streams', sel_stream, '-show_entries', 'stream=start_time', '-of', 'json', probe_url],
                        capture_output=True,
                        text=True,
                        timeout=6,
                    )
                    streams = json.loads(pr.stdout or '{}').get('streams') or []
                    if streams and streams[0].get('start_time') is not None:
                        a_st = float(streams[0]['start_time'])
                        if abs(a_st - req_start) <= 25.0:
                            eff_actual = a_st
                except Exception:
                    pass
            cmd = [
                ffmpeg_bin, '-v', 'error', '-i', probe_url, '-t', f'{req_sec:.1f}',
                '-map', a_map, '-vn', '-sn', '-dn', '-af', 'highpass=f=280,lowpass=f=3400,aresample=8000',
                '-f', 's16le', '-ac', '1', 'pipe:1',
            ]
        else:
            cmd = [ffmpeg_bin, '-v', 'error']
            if req_start > 0.05:
                cmd += ['-ss', f'{req_start:.3f}']
            cmd += [
                '-i', base_url, '-t', f'{req_sec:.1f}',
                '-map', a_map, '-vn', '-sn', '-dn', '-af', 'highpass=f=280,lowpass=f=3400,aresample=8000',
                '-f', 's16le', '-ac', '1', 'pipe:1',
            ]

        try:
            proc = subprocess.run(cmd, capture_output=True, timeout=20)
        except Exception as err:
            return {'ok': False, 'reason': f'ffmpeg_failed:{type(err).__name__}', 'offset': 0.0, 'confident': False}, eff_actual
        if not proc.stdout or len(proc.stdout) < 8000 * 2 * 10:
            return {'ok': False, 'reason': 'empty_audio_probe', 'offset': 0.0, 'confident': False}, eff_actual
        cor = correlate_speech_and_cues(
            proc.stdout,
            cues,
            eff_actual,
            max_shift_sec=max_shift_sec if win_max_shift is None else float(win_max_shift),
            same_route=same_route,
        )
        cor['window_start'] = round(eff_actual, 3)
        cor['window_sec'] = round(req_sec, 1)
        return cor, eff_actual

    res, actual_start = _run_probe_window(win_start, win_sec)
    last_cue_sec = max((e / 1000.0 for _, e, _ in cues), default=0.0)
    # Multi-window FPS/linear drift check for long streams across both HTTP & seekable HLS proxies
    if (
        res.get('ok')
        and (res.get('confident') or res.get('in_sync'))
        and (last_cue_sec - actual_start) >= 600.0
    ):
        rem_span = last_cue_sec - actual_start
        late_target = max(actual_start + 450.0, min(last_cue_sec - 120.0, actual_start + (rem_span * 0.65)))
        w2_start, w2_sec = choose_probe_window(cues, seek_offset=late_target, window_sec=65.0)
        if (w2_start - actual_start) >= 360.0:
            est_dt = w2_start - actual_start
            w2_max_shift = max(float(max_shift_sec), min(180.0, (est_dt * 0.065) + abs(float(res.get('offset') or 0.0)) + 15.0))
            res2, actual_w2 = _run_probe_window(w2_start, w2_sec, win_max_shift=w2_max_shift)
            dt_win = actual_w2 - actual_start
            if res2.get('ok') and (res2.get('confident') or res2.get('in_sync')) and dt_win >= 360.0:
                drift = float(res2.get('offset') or 0.0) - float(res.get('offset') or 0.0)
                rate = drift / dt_win
                # Only treat statistically meaningful drift (> 30 ms/min and <= 8% speed delta)
                if 0.0005 <= abs(rate) <= 0.08:
                    res['drift_sec_per_sec'] = round(rate, 6)
                    res['drift_ms_per_min'] = round(rate * 60000.0, 2)
                    res['drift_anchor_sec'] = round(actual_start, 3)
                else:
                    res['drift_sec_per_sec'] = 0.0
                    res['drift_ms_per_min'] = 0.0

    # Classify result consistently for UI and normalizer callers
    if not res.get('ok'):
        res['status'] = 'insufficient_speech'
    elif res.get('confident'):
        off_v = abs(float(res.get('offset') or 0.0))
        has_drift = abs(float(res.get('drift_sec_per_sec') or 0.0)) >= 0.0005
        if off_v < 0.45 and not has_drift:
            res['status'] = 'synced'
        elif has_drift:
            res['status'] = 'drifted'
        else:
            res['status'] = 'desynced'
    elif res.get('in_sync'):
        has_drift = abs(float(res.get('drift_sec_per_sec') or 0.0)) >= 0.0005
        res['status'] = 'drifted' if has_drift else 'synced'
    elif int(res.get('used_cues') or 0) >= 4 and float(res.get('z_score') or 0.0) < 1.6:
        res['status'] = 'mismatch'
    else:
        res['status'] = 'uncertain'
    return res


def clamp_drift_rate(rate):
    try:
        v = float(rate or 0.0)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(v):
        return 0.0
    return max(-0.08, min(0.08, v))


def map_media_sec_to_sub_ms(media_sec, *, subtitle_offset=0.0, drift_sec_per_sec=0.0, drift_anchor_sec=0.0):
    """Map current playback media time -> subtitle file timestamp (ms) with offset + FPS drift normalization."""
    t = float(media_sec or 0.0)
    off = float(subtitle_offset or 0.0)
    drift = clamp_drift_rate(drift_sec_per_sec)
    anchor = float(drift_anchor_sec or 0.0)
    sub_sec = t - off - (drift * (t - anchor))
    return int(round(sub_sec * 1000.0))


def inverse_map_sub_ms_to_media_sec(sub_ms, *, subtitle_offset=0.0, drift_sec_per_sec=0.0, drift_anchor_sec=0.0):
    """Inverse transform: map raw subtitle cue timestamp (ms) -> normalized playback media seconds."""
    sub_sec = float(sub_ms) / 1000.0
    off = float(subtitle_offset or 0.0)
    drift = clamp_drift_rate(drift_sec_per_sec)
    anchor = float(drift_anchor_sec or 0.0)
    denom = max(0.5, 1.0 - drift)
    return (sub_sec + off - (drift * anchor)) / denom


def shift_cues_by_transform(cues, *, subtitle_offset=0.0, drift_sec_per_sec=0.0, drift_anchor_sec=0.0):
    """Project raw subtitle cues onto the currently displayed normalized timeline."""
    off = float(subtitle_offset or 0.0)
    drift = clamp_drift_rate(drift_sec_per_sec)
    anchor = float(drift_anchor_sec or 0.0)
    if abs(off) < 1e-4 and abs(drift) < 1e-6:
        return cues
    denom = max(0.5, 1.0 - drift)
    out = []
    for st, en, txt in cues:
        nst = int(round(((st / 1000.0 + off - drift * anchor) / denom) * 1000.0))
        nen = int(round(((en / 1000.0 + off - drift * anchor) / denom) * 1000.0))
        if nen <= 0:
            continue
        nst = max(0, nst)
        nen = max(nst + 200, nen)
        out.append((nst, nen, txt))
    return out


def pcm_to_8k_mono(pcm_bytes, *, sample_rate=48000, channels=2):
    """Fast C-array decimation of interleaved s16le PCM to 8kHz mono s16le."""
    if not pcm_bytes:
        return b''
    sr = max(8000, int(sample_rate or 48000))
    ch = max(1, int(channels or 2))
    step_frames = max(1, int(round(sr / 8000.0)))
    block_bytes = step_frames * ch * 2
    usable = len(pcm_bytes) - (len(pcm_bytes) % block_bytes)
    if usable <= 0:
        return b''
    arr = array('h')
    arr.frombytes(memoryview(pcm_bytes)[:usable])
    stride = step_frames * ch
    if ch == 1:
        return arr[::stride].tobytes()
    left = arr[0::stride]
    right = arr[1::stride]
    mono = array('h', ((a + b) >> 1 for a, b in zip(left, right)))
    return mono.tobytes()


def fit_linear_drift(samples):
    """Fit weighted/ordinary linear drift `(rate, anchor_sec, offset_at_anchor)` from `(t_sec, offset_sec)` samples."""
    if len(samples) < 4:
        return None
    ordered = sorted((float(s[0]), float(s[1])) for s in samples)
    ts = [s[0] for s in ordered]
    offs = [s[1] for s in ordered]
    span = ts[-1] - ts[0]
    if span < 140.0:
        return None
    n = float(len(ordered))
    t_mean = sum(ts) / n
    o_mean = sum(offs) / n
    denom = sum((t - t_mean) ** 2 for t in ts)
    if denom <= 1e-6:
        return None
    slope = sum((t - t_mean) * (o - o_mean) for t, o in zip(ts, offs)) / denom
    if abs(slope) < 0.0005 or abs(slope) > 0.06:
        return None
    mid_idx = len(ordered) // 2
    first_half_mean = sum(offs[:mid_idx]) / float(mid_idx)
    second_half_mean = sum(offs[mid_idx:]) / float(len(offs) - mid_idx)
    half_delta = second_half_mean - first_half_mean
    is_short_or_sparse = (len(ordered) < 6 or span < 240.0)
    min_half_delta = 0.18 if is_short_or_sparse else 0.14
    if (half_delta * slope) <= 0.0 or abs(half_delta) < min_half_delta:
        return None
    # Verify residuals and R^2 stay tightly linear across checkpoints
    residuals = [abs(o - (o_mean + slope * (t - t_mean))) for t, o in zip(ts, offs)]
    max_res_limit = 0.25 if is_short_or_sparse else 0.35
    if max(residuals) > max_res_limit:
        return None
    ss_tot = sum((o - o_mean) ** 2 for o in offs)
    ss_res = sum(r * r for r in residuals)
    r2 = 1.0 - (ss_res / max(ss_tot, 1e-9))
    min_r2 = 0.88 if is_short_or_sparse else 0.82
    if r2 < min_r2:
        return None
    return {
        'drift_sec_per_sec': round(slope, 6),
        'drift_ms_per_min': round(slope * 60000.0, 2),
        'drift_anchor_sec': round(t_mean, 3),
        'offset_at_anchor': round(o_mean, 2),
    }


def _atomic_write_json(path, payload):
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(f'{p.name}.{os.getpid()}.{threading.get_ident()}.tmp')
    tmp.write_text(json.dumps(payload), encoding='utf-8')
    os.replace(tmp, p)


class LiveSubSyncMonitor:
    """Continuous non-blocking subtitle sync checker + auto-normalizer embedded inside A/V normalizer.

    Consumes live decoded PCM + media PTS as the movie plays, checks speech energy/onsets
    against the currently displayed subtitle cues every ~18s (22–32s sliding window),
    detects desyncs or FPS drift, writes live sync telemetry to `status_path`, and
    automatically normalizes `config_path` + bumps `state.sub_gen` when enabled.
    """

    def __init__(
        self,
        *,
        sync_id,
        config_path,
        status_path=None,
        state=None,
        sample_rate=48000,
        channels=2,
        check_interval_sec=10.0,
        min_window_sec=20.0,
        max_window_sec=44.0,
    ):
        self.sync_id = str(sync_id or 'default')
        self.config_path = Path(config_path) if config_path else None
        if status_path is not None:
            self.status_path = Path(status_path)
        elif self.config_path is not None:
            self.status_path = self.config_path.with_name(f'lancy-substatus-{self.sync_id}.json')
        else:
            self.status_path = None
        self.state = state
        self.sample_rate = max(8000, int(sample_rate or 48000))
        self.channels = max(1, int(channels or 2))
        self.check_interval_sec = max(4.0, float(check_interval_sec))
        self.min_window_sec = max(12.0, float(min_window_sec))
        self.max_window_sec = max(self.min_window_sec + 4.0, float(max_window_sec))

        self._stop = threading.Event()
        self._force_ev = threading.Event()
        self._inbox_lock = threading.Lock()
        self._raw_inbox = deque(maxlen=2048)

        self._ring = bytearray()
        self._pcm_rem = bytearray()
        self._ring_start_pts = None
        self._ring_end_pts = None
        self._next_raw_pts = None
        self._last_check_mono = 0.0
        self._loaded_sub_path = ''
        self._loaded_sub_mtime = None
        self._loaded_cues = []

        self._history = deque(maxlen=12)  # (abs_media_sec, implied_total_offset_sec)
        self._consec_desync_dir = 0
        self._consec_desync_count = 0
        self._last_desync_residual = 0.0
        self._mismatch_streak = 0
        self._checks_run = 0
        self._confident_checks = 0
        self._auto_normalized = False
        self._last_gen = -1
        self._last_force_seq = 0
        self._last_status = {
            'status': 'monitoring',
            'checked_at_sec': 0.0,
            'residual_sec': 0.0,
            'applied_offset_sec': 0.0,
            'suggested_offset_sec': 0.0,
            'drift_ms_per_min': 0.0,
            'drift_sec_per_sec': 0.0,
            'drift_anchor_sec': 0.0,
            'z_score': 0.0,
            'confident': False,
            'auto_normalized': False,
            'manual_override': False,
            'checks_run': 0,
            'confident_checks': 0,
            'mismatch_streak': 0,
            'message': 'Monitoring subtitle sync...',
        }
        self._thread = None
        if self.config_path is not None:
            self._thread = threading.Thread(target=self._run_loop, name=f'submon-{self.sync_id[:12]}', daemon=True)
            self._thread.start()

    def feed_pcm(self, rel_pts_sec, pcm_bytes):
        if self._stop.is_set() or not pcm_bytes or self.config_path is None:
            return
        with self._inbox_lock:
            self._raw_inbox.append((float(rel_pts_sec), bytes(pcm_bytes)))

    def trigger_check(self):
        self._last_check_mono = 0.0
        self._force_ev.set()

    def snapshot(self):
        return dict(self._last_status)

    def _read_config(self):
        if self.config_path is None or not self.config_path.is_file():
            return None
        try:
            st = self.config_path.stat()
            cfg = json.loads(self.config_path.read_text(encoding='utf-8'))
            self._last_cfg_mtime_ns = st.st_mtime_ns
            return cfg
        except Exception:
            return None

    def _ensure_cues(self, sub_path):
        p = Path(sub_path)
        try:
            st = p.stat()
        except OSError:
            return []
        if sub_path == self._loaded_sub_path and st.st_mtime_ns == self._loaded_sub_mtime and self._loaded_cues:
            return self._loaded_cues
        try:
            raw = p.read_text(encoding='utf-8', errors='replace')
            cues = parse_subtitle_cues(raw, is_ass=p.suffix.lower() in {'.ass', '.ssa'})
            cues = dedupe_overlapping_cues(cues, trim_overlaps=True)
            cues = filter_speech_cues(cues)
        except Exception:
            cues = []
        self._loaded_sub_path = sub_path
        self._loaded_sub_mtime = st.st_mtime_ns
        self._loaded_cues = cues
        # Reset regression samples when subtitle track changes
        self._history.clear()
        self._consec_desync_dir = 0
        self._consec_desync_count = 0
        self._last_desync_residual = 0.0
        self._mismatch_streak = 0
        return cues

    def _ingest_inbox(self):
        batch = []
        with self._inbox_lock:
            while self._raw_inbox:
                batch.append(self._raw_inbox.popleft())
        if not batch:
            return
        bytes_per_8k_sec = 8000 * 2
        sr = max(8000, int(self.sample_rate or 48000))
        ch = max(1, int(self.channels or 2))
        step_frames = max(1, int(round(sr / 8000.0)))
        raw_frame_bytes = ch * 2
        block_bytes = step_frames * raw_frame_bytes
        raw_bps = float(sr * raw_frame_bytes)
        max_bytes = int(self.max_window_sec * bytes_per_8k_sec)
        for pts_sec, raw_pcm in batch:
            if not raw_pcm:
                continue
            if (
                self._ring_start_pts is None
                or self._next_raw_pts is None
                or pts_sec < (self._next_raw_pts - 1.5)
                or (pts_sec - self._next_raw_pts) > 6.0
            ):
                self._ring.clear()
                self._pcm_rem.clear()
                self._ring_start_pts = pts_sec
                self._ring_end_pts = pts_sec
                self._next_raw_pts = pts_sec
            else:
                gap = pts_sec - self._next_raw_pts
                if gap > 0.025:
                    pad_bytes = int(round(gap * raw_bps))
                    pad_bytes -= (pad_bytes % raw_frame_bytes)
                    if pad_bytes > 0:
                        self._pcm_rem.extend(b'\x00' * pad_bytes)
                        self._next_raw_pts += pad_bytes / raw_bps
                elif gap < -0.025:
                    ring_raw_end = self._next_raw_pts - (len(self._pcm_rem) / raw_bps)
                    self._pcm_rem.clear()
                    skip_bytes = int(round(max(0.0, ring_raw_end - pts_sec) * raw_bps))
                    skip_bytes -= (skip_bytes % raw_frame_bytes)
                    if skip_bytes >= len(raw_pcm):
                        continue
                    if skip_bytes > 0:
                        raw_pcm = raw_pcm[skip_bytes:]
                        pts_sec += skip_bytes / raw_bps

            if self._pcm_rem:
                self._pcm_rem.extend(raw_pcm)
                buf = bytes(self._pcm_rem)
                usable = len(buf) - (len(buf) % block_bytes)
                if usable > 0:
                    pcm8k = pcm_to_8k_mono(buf[:usable], sample_rate=sr, channels=ch)
                    self._pcm_rem = bytearray(buf[usable:])
                else:
                    pcm8k = b''
            else:
                usable = len(raw_pcm) - (len(raw_pcm) % block_bytes)
                pcm8k = pcm_to_8k_mono(raw_pcm[:usable], sample_rate=sr, channels=ch) if usable > 0 else b''
                if usable < len(raw_pcm):
                    self._pcm_rem = bytearray(raw_pcm[usable:])

            self._next_raw_pts = pts_sec + (len(raw_pcm) / raw_bps)
            if pcm8k:
                self._ring.extend(pcm8k)
                self._ring_end_pts = self._next_raw_pts - (len(self._pcm_rem) / raw_bps)
                if len(self._ring) > max_bytes:
                    trim = len(self._ring) - max_bytes
                    trim -= (trim % 2)
                    if trim > 0:
                        del self._ring[:trim]
                        self._ring_start_pts += trim / float(bytes_per_8k_sec)

    def _write_status(self, payload):
        self._last_status = payload
        if self.status_path is not None:
            try:
                _atomic_write_json(self.status_path, payload)
            except Exception:
                pass

    def _apply_normalization(self, cfg, *, new_offset, new_drift, new_anchor):
        if self.config_path is None or not self.config_path.is_file():
            return False
        try:
            cur_st = self.config_path.stat()
            disk_cfg = json.loads(self.config_path.read_text(encoding='utf-8'))
        except Exception:
            return False
        expected_mtime = getattr(self, '_last_cfg_mtime_ns', None)
        if (
            str(disk_cfg.get('subtitle_path') or '').strip() != str(cfg.get('subtitle_path') or '').strip()
            or int(disk_cfg.get('cfg_rev') or 0) != int(cfg.get('cfg_rev') or 0)
            or abs(float(disk_cfg.get('base_sec') or 0.0) - float(cfg.get('base_sec') or 0.0)) >= 0.05
            or bool(disk_cfg.get('manual_override'))
            or (expected_mtime is not None and cur_st.st_mtime_ns != expected_mtime)
        ):
            return False
        updated = dict(disk_cfg)
        updated['subtitle_offset'] = round(max(-30.0, min(30.0, float(new_offset))), 2)
        updated['drift_sec_per_sec'] = round(clamp_drift_rate(new_drift), 6)
        updated['drift_anchor_sec'] = round(float(new_anchor or 0.0), 3)
        updated['cfg_rev'] = int(disk_cfg.get('cfg_rev') or 0) + 1
        try:
            _atomic_write_json(self.config_path, updated)
            try:
                self._last_cfg_mtime_ns = self.config_path.stat().st_mtime_ns
            except Exception:
                pass
            if self.state is not None:
                self.state.sub_gen = int(self.state.sub_gen) + 1
            return True
        except Exception:
            return False

    def _run_one_check(self, cfg):
        sub_path = str(cfg.get('subtitle_path') or '').strip()
        if not cfg.get('enabled') or not sub_path:
            return
        cues = self._ensure_cues(sub_path)
        if not cues or self._ring_start_pts is None:
            return
        dur = len(self._ring) / 16000.0
        if dur < self.min_window_sec:
            return

        base_sec = float(cfg.get('base_sec') or 0.0)
        cur_offset = float(cfg.get('subtitle_offset') or 0.0)
        cur_drift = clamp_drift_rate(cfg.get('drift_sec_per_sec') or 0.0)
        cur_anchor = float(cfg.get('drift_anchor_sec') or 0.0)
        manual_override = bool(cfg.get('manual_override'))
        same_route = bool(cfg.get('same_route'))
        auto_normalize = bool(cfg.get('auto_normalize', True))

        epoch_off = max(0.0, float(getattr(self.state, 'epoch_pts_sec', 0.0) or 0.0)) if self.state is not None else 0.0
        abs_start_sec = base_sec + max(0.0, float(self._ring_start_pts) - epoch_off)
        abs_mid_sec = abs_start_sec + (dur * 0.5)
        disp_cues = shift_cues_by_transform(
            cues,
            subtitle_offset=cur_offset,
            drift_sec_per_sec=cur_drift,
            drift_anchor_sec=cur_anchor,
        )
        cor = correlate_speech_and_cues(
            bytes(self._ring),
            disp_cues,
            abs_start_sec,
            max_shift_sec=14.0,
            fine_step_sec=0.1,
            same_route=False,
            min_cues=6,
            min_z=2.7,
        )
        self._checks_run += 1
        z_val = round(float(cor.get('z_score') or 0.0), 2)
        used_cues = int(cor.get('used_cues') or 0)
        now_ts = round(time.time(), 3)

        # If auto-sync previously pushed offset away from 0.0, verify unshifted timeline hasn't become superior
        if abs(cur_offset) >= 0.45 and not manual_override and auto_normalize:
            cor_raw = correlate_speech_and_cues(
                bytes(self._ring),
                cues,
                abs_start_sec,
                max_shift_sec=14.0,
                fine_step_sec=0.1,
                same_route=False,
                min_cues=6,
                min_z=2.7,
            )
            if cor_raw.get('ok'):
                raw_z0 = float(cor_raw.get('z_at_0') or 0.0)
                raw_sc0 = float(cor_raw.get('score_at_0') or 0.0)
                cur_z0 = float(cor.get('z_at_0') or 0.0) if cor.get('ok') else -999.0
                cur_sc_best = float(cor.get('best_score') or 0.0) if cor.get('ok') else -999.0
                if raw_z0 >= 2.6 and (
                    cor_raw.get('in_sync') or (raw_z0 > cur_z0 + 0.4 and raw_sc0 > cur_sc_best)
                ):
                    if self._apply_normalization(cfg, new_offset=0.0, new_drift=0.0, new_anchor=0.0):
                        self._history.clear()
                        self._consec_desync_dir = 0
                        self._consec_desync_count = 0
                        self._last_desync_residual = 0.0
                        self._mismatch_streak = 0
                        self._write_status({
                            'status': 'auto_normalized',
                            'checked_at_sec': round(abs_mid_sec, 1),
                            'residual_sec': 0.0,
                            'applied_offset_sec': 0.0,
                            'suggested_offset_sec': 0.0,
                            'drift_ms_per_min': 0.0,
                            'drift_sec_per_sec': 0.0,
                            'drift_anchor_sec': 0.0,
                            'z_score': round(raw_z0, 2),
                            'confident': True,
                            'auto_normalized': True,
                            'manual_override': False,
                            'checks_run': self._checks_run,
                            'confident_checks': self._confident_checks,
                            'mismatch_streak': 0,
                            'message': 'Auto-normalized subtitles back to +0.0s',
                            'updated_at': now_ts,
                        })
                        return

        if not cor.get('ok'):
            self._write_status({
                **self._last_status,
                'status': 'monitoring',
                'checked_at_sec': round(abs_mid_sec, 1),
                'z_score': z_val,
                'confident': False,
                'applied_offset_sec': round(cur_offset, 2),
                'drift_ms_per_min': round(cur_drift * 60000.0, 1),
                'drift_sec_per_sec': round(cur_drift, 6),
                'drift_anchor_sec': round(cur_anchor, 2),
                'manual_override': manual_override,
                'checks_run': self._checks_run,
                'confident_checks': self._confident_checks,
                'mismatch_streak': self._mismatch_streak,
                'message': 'Waiting for active speech dialogue...',
                'updated_at': now_ts,
            })
            return

        if not cor.get('confident') and not cor.get('in_sync'):
            if used_cues >= 3 and z_val < 1.6:
                self._mismatch_streak += 1
            status_str = 'mismatch' if self._mismatch_streak >= 3 else 'uncertain'
            msg = (
                'Subtitles may not match this audio cut — try switching subtitle track'
                if status_str == 'mismatch'
                else 'Checking subtitle speech alignment...'
            )
            self._write_status({
                **self._last_status,
                'status': status_str,
                'checked_at_sec': round(abs_mid_sec, 1),
                'z_score': z_val,
                'confident': False,
                'applied_offset_sec': round(cur_offset, 2),
                'suggested_offset_sec': round(cur_offset, 2),
                'drift_ms_per_min': round(cur_drift * 60000.0, 1),
                'drift_sec_per_sec': round(cur_drift, 6),
                'drift_anchor_sec': round(cur_anchor, 2),
                'manual_override': manual_override,
                'checks_run': self._checks_run,
                'confident_checks': self._confident_checks,
                'mismatch_streak': self._mismatch_streak,
                'message': msg,
                'updated_at': now_ts,
            })
            return

        self._mismatch_streak = 0
        self._confident_checks += 1
        residual = float(cor.get('offset') or 0.0)
        # Compute implied total offset against raw subtitle timeline at abs_mid_sec
        implied_total = cur_offset + (cur_drift * (abs_mid_sec - cur_anchor)) + residual
        self._history.append((abs_mid_sec, implied_total))

        suggested_offset = round(max(-30.0, min(30.0, cur_offset + residual)), 1)
        new_drift = cur_drift
        new_anchor = cur_anchor
        drift_fitted = fit_linear_drift(list(self._history))
        if drift_fitted is not None:
            new_drift = float(drift_fitted['drift_sec_per_sec'])
            new_anchor = float(drift_fitted['drift_anchor_sec'])
            # Offset at anchor gives zero-residual alignment at current point
            implied_at_cur_anchor = float(drift_fitted['offset_at_anchor'])
        else:
            implied_at_cur_anchor = cur_offset + residual

        if abs(residual) >= 0.45:
            sign = 1 if residual > 0 else -1
            if sign == self._consec_desync_dir and abs(residual - self._last_desync_residual) <= 1.8:
                self._consec_desync_count += 1
            else:
                self._consec_desync_dir = sign
                self._consec_desync_count = 1
            self._last_desync_residual = residual
        else:
            self._consec_desync_dir = 0
            self._consec_desync_count = 0
            self._last_desync_residual = 0.0

        min_auto_thresh = 0.65 if same_route else 0.6
        strong_peak = (
            z_val >= 3.3
            and bool(cor.get('half_consensus', False))
            and abs(residual) >= 0.75
        )
        consistent_desync = (self._consec_desync_count >= 2 and abs(residual) >= min_auto_thresh)
        should_normalize = (
            auto_normalize
            and not manual_override
            and (
                (abs(residual) >= min_auto_thresh and (strong_peak or consistent_desync))
                or (drift_fitted is not None and abs(new_drift - cur_drift) >= 0.0005)
            )
        )

        applied_now = False
        final_offset = cur_offset
        if should_normalize:
            target_off = implied_at_cur_anchor if drift_fitted is not None else (cur_offset + residual)
            applied_now = self._apply_normalization(
                cfg,
                new_offset=target_off,
                new_drift=new_drift,
                new_anchor=new_anchor if drift_fitted is not None else cur_anchor,
            )
            if applied_now:
                self._auto_normalized = True
                final_offset = round(max(-30.0, min(30.0, target_off)), 2)
                suggested_offset = final_offset
                residual = 0.0
                self._consec_desync_dir = 0
                self._consec_desync_count = 0

        eff_drift = new_drift if applied_now else cur_drift
        eff_anchor = (new_anchor if (applied_now and drift_fitted is not None) else cur_anchor)
        if applied_now:
            status_str = 'auto_normalized'
            msg = f'Auto-normalized subtitles ({final_offset:+.1f}s' + (f', {eff_drift * 60000.0:+.0f}ms/min' if abs(eff_drift) >= 0.0005 else '') + ')'
        elif abs(residual) < 0.45:
            status_str = 'synced'
            msg = f'Subtitles in sync ({residual:+.1f}s, z={z_val:.1f})'
        elif abs(eff_drift) >= 0.0005 or drift_fitted is not None:
            status_str = 'drifted'
            msg = f'Subtitle drift detected ({residual:+.1f}s)'
        else:
            status_str = 'desynced'
            msg = f'Subtitles out of sync by {residual:+.1f}s'

        self._write_status({
            'status': status_str,
            'checked_at_sec': round(abs_mid_sec, 1),
            'residual_sec': round(residual, 2),
            'applied_offset_sec': round(final_offset, 2),
            'suggested_offset_sec': round(suggested_offset, 1),
            'drift_ms_per_min': round(eff_drift * 60000.0, 2),
            'drift_sec_per_sec': round(eff_drift, 6),
            'drift_anchor_sec': round(eff_anchor, 3),
            'z_score': z_val,
            'confident': True,
            'auto_normalized': bool(self._auto_normalized or applied_now),
            'manual_override': manual_override,
            'checks_run': self._checks_run,
            'confident_checks': self._confident_checks,
            'mismatch_streak': 0,
            'message': msg,
            'updated_at': now_ts,
        })

    def _run_loop(self):
        while not self._stop.is_set():
            self._force_ev.wait(timeout=0.5)
            forced = self._force_ev.is_set()
            if forced:
                self._force_ev.clear()
            if self._stop.is_set():
                break
            try:
                self._ingest_inbox()
                now_m = time.monotonic()
                gen_changed = False
                if self.state is not None:
                    cur_gen = int(self.state.sub_gen)
                    if cur_gen != self._last_gen:
                        self._last_gen = cur_gen
                        gen_changed = True
                if self._ring_start_pts is not None and (forced or gen_changed or (now_m - self._last_check_mono) >= self.check_interval_sec):
                    cfg = self._read_config()
                    if cfg and cfg.get('enabled') and cfg.get('subtitle_path'):
                        force_seq = int(cfg.get('force_check_seq') or 0)
                        if force_seq != self._last_force_seq:
                            self._last_force_seq = force_seq
                            forced = True
                            self._consec_desync_dir = 0
                            self._consec_desync_count = 0
                        dur = len(self._ring) / 16000.0
                        if dur >= self.min_window_sec and (forced or (now_m - self._last_check_mono) >= self.check_interval_sec):
                            self._last_check_mono = now_m
                            self._run_one_check(cfg)
            except Exception as err:
                print(f'[sub_align] monitor error ({self.sync_id}): {err}', file=sys.stderr)

    def close(self):
        self._stop.set()
        self._force_ev.set()
        if self._thread is not None and self._thread.is_alive():
            self._thread.join(timeout=1.5)
        if self.status_path is not None:
            try:
                self.status_path.unlink(missing_ok=True)
            except Exception:
                pass


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('--url', required=True)
    parser.add_argument('--sub', required=True)
    parser.add_argument('--seek', type=float, default=0.0)
    parser.add_argument('--audio-stream-index', type=int, default=None)
    parser.add_argument('--hls-proxy', action='store_true')
    parser.add_argument('--same-route', action='store_true')
    args = parser.parse_args()
    out = probe_audio_and_align(
        args.url,
        args.sub,
        seek_offset=args.seek,
        is_hls_proxy=args.hls_proxy,
        same_route=args.same_route,
        audio_stream_index=args.audio_stream_index,
    )
    print(json.dumps(out))


if __name__ == '__main__':
    main()
