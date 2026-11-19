"""Speech-to-text & Nigerian English/Pidgin normalization engine for VC voice input.

Runs ``faster-whisper`` (default ``small.en`` with ``int8`` quantization,
falling back gracefully to cached models) inside a dedicated worker thread,
evaluates segment confidence (``avg_logprob``, ``no_speech_prob``,
``compression_ratio``), and normalizes common Nigerian English & Pidgin
accented phrasings cleanly while flagging unclear speech for clarification.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
import logging
import math
import os
from pathlib import Path
import re
import threading
import numpy as np

log = logging.getLogger('voice.stt')

DEFAULT_WHISPER_MODEL = os.environ.get('LANCY_WHISPER_MODEL', 'small.en')
DEFAULT_WHISPER_THREADS = max(2, min(10, int(os.environ.get('LANCY_WHISPER_THREADS', '6'))))

BASE_INITIAL_PROMPT = (
    'Lancy, Lancy listen, hey Lancy, abeg, no wahala, how far, wetin dey happen, '
    'lower the volume, increase the volume, mute, unmute, pause, resume, skip, '
    'next queue, previous, go to the movie middle, send this video to the chat, '
    'search movie, play remix, is that all, yeah that is all.'
)

_WAKE_HOMOPHONES_RE = re.compile(
    r'\b(?:nancy|lansi|lency|lancie|lencie|lanci|lenny|land\s+see|lance\s+see|elancy)\b',
    re.IGNORECASE,
)
_EXACT_LANCY_RE = re.compile(r'\blancy\b', re.IGNORECASE)

_PHONETIC_REPLACEMENTS = (
    (re.compile(r'\bd\s+(volume|vol|movie|video|song|music|middle|queue|chat|sound|subtitles?|subs?)\b', re.I), r'the \1'),
    (re.compile(r'\bdis\s+(video|movie|song|track|film|episode|one)\b', re.I), r'this \1'),
    (re.compile(r'\bdat\s+(video|movie|song|track|film|episode|one)\b', re.I), r'that \1'),
    (re.compile(r'\bnext\s+(?:que|q|cue|kyu)\b', re.I), 'next queue'),
    (re.compile(r'\b(?:gi|gwe)\s+to\s+(?:the\s+|d\s+)?middle\b', re.I), 'go to the middle'),
    (re.compile(r'\bmove\s+to\s+(?:the\s+)?next\s+(?:que|q|cue)\b', re.I), 'move to next queue'),
    (re.compile(r'\b(pause|resume|mute|unmute|skip|stop|send|play|lower|increase)\s+am\b', re.I), r'\1 it'),
    (re.compile(r'\b(?:shey|abi)\b', re.I), 'is that right'),
)

_HALLUCINATED_PHRASES = {
    'thank you', 'thanks for watching', 'you', 'bye', 'bye bye',
    'subtitles by the amara org community', 'please subscribe', '.', '',
}


def normalize_nigerian_speech(text: str, *, active_session: bool = False) -> tuple[str, bool]:
    """Normalize Nigerian English/Pidgin phrasing & return (normalized, is_wake)."""
    raw = re.sub(r'\s+', ' ', str(text or '')).strip()
    if not raw:
        return '', False

    out = raw
    # Convert near-homophones of "Lancy" when leading an utterance or paired with wake/command cues.
    if _WAKE_HOMOPHONES_RE.search(out):
        if (
            active_session
            or re.match(r'^(?:hey\s+|hi\s+|yo\s+|ok(?:ay)?\s+|abeg\s+)?(?:nancy|lansi|lency|lancie|lencie|lanci|lenny|land\s+see|lance\s+see|elancy)\b', out, re.I)
            or re.search(r'\b(?:listen|volume|mute|pause|resume|middle|queue|movie|video|skip|chat|play|search)\b', out, re.I)
        ):
            out = _WAKE_HOMOPHONES_RE.sub('Lancy', out)

    for pattern, repl in _PHONETIC_REPLACEMENTS:
        out = pattern.sub(repl, out)

    out = re.sub(r'\s+', ' ', out).strip()
    is_wake = bool(_EXACT_LANCY_RE.search(out))
    return out, is_wake


def resample_pcm16_mono_to_float16k(pcm_bytes: bytes, src_rate: int, channels: int = 1) -> np.ndarray:
    """Convert raw s16le PCM frames into normalized 16kHz mono float32 audio."""
    if not pcm_bytes:
        return np.zeros(0, dtype=np.float32)
    samples = np.frombuffer(pcm_bytes, dtype='<i2').astype(np.float32) / 32768.0
    if int(channels) > 1:
        usable = len(samples) - (len(samples) % int(channels))
        samples = samples[:usable].reshape(-1, int(channels)).mean(axis=1)
    if int(src_rate) == 16000 or len(samples) < 2:
        return samples
    out_len = max(1, int(round(len(samples) * 16000.0 / float(src_rate))))
    x_old = np.linspace(0.0, 1.0, num=len(samples), endpoint=False)
    x_new = np.linspace(0.0, 1.0, num=out_len, endpoint=False)
    return np.interp(x_new, x_old, samples).astype(np.float32)


@dataclass
class TranscriptResult:
    text: str
    raw_text: str
    confidence: float
    avg_logprob: float
    no_speech_prob: float
    is_wake: bool
    is_listen_command: bool
    low_confidence: bool
    duration_sec: float


class SttEngine:
    def __init__(self, cache_dir: str | Path | None = None, model_name: str | None = None):
        base = Path(cache_dir) if cache_dir else Path('/tmp/lancy-cache')
        # Keep Whisper cache inside data/cache/whisper so downloaded models persist across restarts.
        whisper_root = base.parent / 'whisper' if base.name == 'music' else base / 'whisper'
        whisper_root.mkdir(parents=True, exist_ok=True)
        self.download_root = whisper_root
        self.model_name = str(model_name or DEFAULT_WHISPER_MODEL).strip() or 'small.en'
        self._model = None
        self._model_lock = threading.Lock()
        self._infer_lock = threading.Lock()
        self._lang_model = None
        self._lang_model_lock = threading.Lock()
        self._lang_infer_lock = threading.Lock()

    def _get_model(self):
        if self._model is not None:
            return self._model
        with self._model_lock:
            if self._model is not None:
                return self._model
            from faster_whisper import WhisperModel
            candidates = [self.model_name]
            if self.model_name != 'base.en':
                candidates.append('base.en')
            if self.model_name != 'tiny':
                candidates.append('tiny')
            last_err = None
            for name in candidates:
                try:
                    self._model = WhisperModel(
                        name,
                        device='cpu',
                        compute_type='int8',
                        cpu_threads=DEFAULT_WHISPER_THREADS,
                        download_root=str(self.download_root),
                    )
                    log.info('Loaded faster-whisper model=%s root=%s', name, self.download_root)
                    return self._model
                except Exception as err:
                    last_err = err
                    log.warning('Failed loading whisper model=%s: %s', name, str(err)[:160])
            raise RuntimeError(f'Unable to load any Whisper STT model: {last_err}')

    def transcribe_sync(
        self,
        pcm_bytes: bytes,
        *,
        sample_rate: int = 36000,
        channels: int = 1,
        context_hint: str = '',
        active_session: bool = False,
    ) -> TranscriptResult | None:
        audio = resample_pcm16_mono_to_float16k(pcm_bytes, sample_rate, channels)
        dur = len(audio) / 16000.0
        if dur < 0.22:
            return None

        # Reject near-silent captures quickly before invoking CTranslate2.
        rms = float(np.sqrt(np.mean(audio * audio)))
        if rms < 0.006:
            return None

        model = self._get_model()
        prompt = BASE_INITIAL_PROMPT
        if context_hint:
            prompt = f'{prompt} Current media: {str(context_hint)[:120]}.'

        beam = 2 if active_session else 1
        with self._infer_lock:
            segments_iter, _info = model.transcribe(
                audio,
                language='en',
                initial_prompt=prompt,
                beam_size=beam,
                best_of=beam,
                temperature=0.0,
                condition_on_previous_text=False,
                vad_filter=True,
                vad_parameters={'min_silence_duration_ms': 320 if active_session else 260, 'speech_pad_ms': 120},
                word_timestamps=False,
            )
            segments = list(segments_iter)

        if not segments:
            return None

        texts = []
        logprobs = []
        no_speech_probs = []
        max_comp = 0.0
        for seg in segments:
            seg_text = str(getattr(seg, 'text', '') or '').strip()
            if seg_text:
                texts.append(seg_text)
            logprobs.append(float(getattr(seg, 'avg_logprob', -1.2)))
            no_speech_probs.append(float(getattr(seg, 'no_speech_prob', 0.5)))
            max_comp = max(max_comp, float(getattr(seg, 'compression_ratio', 1.0)))

        raw_text = re.sub(r'\s+', ' ', ' '.join(texts)).strip()
        bare = re.sub(r'[^a-z0-9 ]+', '', raw_text.lower()).strip()
        if not raw_text or bare in _HALLUCINATED_PHRASES:
            return None

        avg_lp = sum(logprobs) / max(1, len(logprobs))
        avg_ns = sum(no_speech_probs) / max(1, len(no_speech_probs))

        # Ignore Whisper background-music hallucinations unless actively listening to a verified speaker.
        if avg_ns > 0.65 and not active_session:
            return None

        normalized, is_wake = normalize_nigerian_speech(raw_text, active_session=active_session)
        if not normalized:
            return None

        # Confidence calibration: avg_logprob near -0.25 -> ~0.9, -0.85 -> ~0.5, <-1.2 -> <0.3.
        lp_conf = max(0.0, min(1.0, math.exp(avg_lp * 0.72)))
        ns_penalty = max(0.0, 1.0 - max(0.0, avg_ns - 0.35) * 1.1)
        rep_penalty = 0.65 if max_comp > 2.35 else 1.0
        confidence = round(max(0.0, min(1.0, lp_conf * ns_penalty * rep_penalty)), 3)

        # Strict voice idle trigger: ONLY explicit "Lancy listen" (or "listen Lancy") triggers idle wake.
        is_listen_cmd = bool(
            re.search(r'\blancy\b[\s,]*(?:abeg\s+|please\s+)?\blisten\b|\blisten\b[\s,]*\blancy\b', normalized, re.I)
        )
        low_confidence = bool(confidence < 0.50 or max_comp > 2.35 or avg_ns > 0.68)

        return TranscriptResult(
            text=normalized,
            raw_text=raw_text,
            confidence=confidence,
            avg_logprob=round(avg_lp, 3),
            no_speech_prob=round(avg_ns, 3),
            is_wake=is_wake,
            is_listen_command=is_listen_cmd,
            low_confidence=low_confidence,
            duration_sec=round(dur, 2),
        )

    async def transcribe(
        self,
        pcm_bytes: bytes,
        *,
        sample_rate: int = 36000,
        channels: int = 1,
        context_hint: str = '',
        active_session: bool = False,
    ) -> TranscriptResult | None:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            None,
            lambda: self.transcribe_sync(
                pcm_bytes,
                sample_rate=sample_rate,
                channels=channels,
                context_hint=context_hint,
                active_session=active_session,
            ),
        )

    def _get_lang_model(self):
        if self._lang_model is not None:
            return self._lang_model
        with self._lang_model_lock:
            if self._lang_model is not None:
                return self._lang_model
            from faster_whisper import WhisperModel
            # Prefer multilingual tiny for ultra-fast (<450ms) language identification across Korean/Japanese/Spanish/English audio.
            for name in ('tiny', 'base', 'small'):
                try:
                    self._lang_model = WhisperModel(
                        name,
                        device='cpu',
                        compute_type='int8',
                        cpu_threads=2,
                        download_root=str(self.download_root),
                    )
                    log.info('Loaded spoken-language detector model=%s', name)
                    return self._lang_model
                except Exception as err:
                    log.debug('Lang model %s load failed: %s', name, str(err)[:120])
            return self._get_model()

    def detect_spoken_language_sync(
        self,
        pcm_bytes: bytes,
        *,
        sample_rate: int = 16000,
        channels: int = 1,
    ) -> dict:
        audio = resample_pcm16_mono_to_float16k(pcm_bytes, sample_rate, channels)
        dur = len(audio) / 16000.0
        if dur < 1.0:
            return {'ok': True, 'language': None, 'probability': 0.0, 'speech_detected': False, 'sample_text': ''}
        rms = float(np.sqrt(np.mean(audio * audio)))
        if rms < 0.0025:
            return {'ok': True, 'language': None, 'probability': 0.0, 'speech_detected': False, 'sample_text': ''}
        model = self._get_lang_model()
        with self._lang_infer_lock:
            segs_iter, info = model.transcribe(
                audio,
                beam_size=1,
                best_of=1,
                temperature=0.0,
                condition_on_previous_text=False,
                vad_filter=True,
                vad_parameters={'min_silence_duration_ms': 300, 'speech_pad_ms': 100},
                word_timestamps=False,
            )
            segs = list(segs_iter)
        sample_text = re.sub(r'\s+', ' ', ' '.join(str(getattr(s, 'text', '') or '').strip() for s in segs)).strip()
        lang = str(getattr(info, 'language', '') or '').strip().lower() or None
        prob = round(float(getattr(info, 'language_probability', 0.0) or 0.0), 3)
        speech_detected = bool(segs and sample_text and prob >= 0.45)
        return {
            'ok': True,
            'language': lang if speech_detected else None,
            'probability': prob,
            'speech_detected': speech_detected,
            'sample_text': sample_text[:200],
        }

    async def detect_spoken_language(
        self,
        pcm_bytes: bytes,
        *,
        sample_rate: int = 16000,
        channels: int = 1,
    ) -> dict:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            None,
            lambda: self.detect_spoken_language_sync(
                pcm_bytes,
                sample_rate=sample_rate,
                channels=channels,
            ),
        )
