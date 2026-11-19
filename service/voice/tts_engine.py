"""Neural text-to-speech synthesis for Lancy's live Voice Chat replies.

Synthesizes warm, intelligible speech using Microsoft Neural voices via
``edge-tts`` (default ``en-NG-EzinneNeural`` for natural Nigerian English
clarity) with disk caching for rapid conversational acknowledgements and an
optional ``kokoro-onnx`` local fallback, outputting 48kHz stereo PCM s16le
frames ready for ``av_sync`` mixing or idle ``MediaStream`` playback.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
from pathlib import Path
import re
import tempfile

log = logging.getLogger('voice.tts')

DEFAULT_TTS_VOICE = os.environ.get('LANCY_TTS_VOICE', 'en-NG-AbeoNeural')
DEFAULT_TTS_RATE = os.environ.get('LANCY_TTS_RATE', '+2%')
DEFAULT_TTS_PITCH = '+0Hz'
SUPPORTED_VOICES = {
    'pappy': 'en-NG-AbeoNeural',
    'man': 'en-NG-AbeoNeural',
    'deep_male': 'en-NG-AbeoNeural',
    'male': 'en-NG-AbeoNeural',
    'ng_male': 'en-NG-AbeoNeural',
    'ng': 'en-NG-AbeoNeural',
    'charon': 'en-US-AndrewMultilingualNeural',
    'us_male': 'en-US-AndrewMultilingualNeural',
    'fenrir': 'en-GB-RyanNeural',
    'marcus': 'en-GB-RyanNeural',
    'uk_male': 'en-GB-RyanNeural',
    'leo': 'en-ZA-LukeNeural',
    'boy': 'en-ZA-LukeNeural',
    'young_male': 'en-ZA-LukeNeural',
    'elder': 'en-US-RogerNeural',
    'old_man': 'en-US-RogerNeural',
    'grandpa': 'en-US-RogerNeural',
    'ava': 'en-NG-EzinneNeural',
    'lady': 'en-NG-EzinneNeural',
    'woman': 'en-NG-EzinneNeural',
    'female': 'en-NG-EzinneNeural',
    'aoede': 'en-NG-EzinneNeural',
    'ng_female': 'en-NG-EzinneNeural',
    'zara': 'en-US-AvaMultilingualNeural',
    'kore': 'en-US-AvaMultilingualNeural',
    'maya': 'en-GB-MaisieNeural',
    'girl': 'en-GB-MaisieNeural',
    'young_female': 'en-GB-MaisieNeural',
    'leda': 'en-GB-MaisieNeural',
    'chloe': 'en-US-AnaNeural',
    'nana': 'en-GB-SoniaNeural',
    'old_woman': 'en-GB-SoniaNeural',
    'grandma': 'en-GB-SoniaNeural',
    'elder_woman': 'en-GB-SoniaNeural',
    'gacrux': 'en-GB-SoniaNeural',
    'uk_female': 'en-GB-SoniaNeural',
    'us_female': 'en-US-JennyNeural',
    'local_fast': 'kokoro',
    'kokoro': 'kokoro',
}
VOICE_PROFILES = {
    'pappy': ('en-NG-AbeoNeural', '+2%', '-4Hz'),
    'man': ('en-NG-AbeoNeural', '+2%', '-4Hz'),
    'deep_male': ('en-NG-AbeoNeural', '+2%', '-4Hz'),
    'leo': ('en-ZA-LukeNeural', '+8%', '+14Hz'),
    'boy': ('en-ZA-LukeNeural', '+8%', '+14Hz'),
    'young_male': ('en-ZA-LukeNeural', '+8%', '+14Hz'),
    'elder': ('en-US-RogerNeural', '-8%', '-10Hz'),
    'old_man': ('en-US-RogerNeural', '-8%', '-10Hz'),
    'grandpa': ('en-US-RogerNeural', '-8%', '-10Hz'),
    'ava': ('en-NG-EzinneNeural', '+1%', '+0Hz'),
    'lady': ('en-NG-EzinneNeural', '+1%', '+0Hz'),
    'woman': ('en-NG-EzinneNeural', '+1%', '+0Hz'),
    'maya': ('en-GB-MaisieNeural', '+5%', '+8Hz'),
    'girl': ('en-GB-MaisieNeural', '+5%', '+8Hz'),
    'young_female': ('en-GB-MaisieNeural', '+5%', '+8Hz'),
    'chloe': ('en-US-AnaNeural', '+4%', '+6Hz'),
    'nana': ('en-GB-SoniaNeural', '-8%', '-10Hz'),
    'old_woman': ('en-GB-SoniaNeural', '-8%', '-10Hz'),
    'grandma': ('en-GB-SoniaNeural', '-8%', '-10Hz'),
    'elder_woman': ('en-GB-SoniaNeural', '-8%', '-10Hz'),
    'zara': ('en-US-AvaMultilingualNeural', '+2%', '+0Hz'),
    'marcus': ('en-GB-RyanNeural', '-1%', '-4Hz'),
}

_EMOJI_RE = re.compile(
    '[\U0001F300-\U0001FAFF\U00002600-\U000027BF\uFE00-\uFE0F\u200D♡✨🎙▶⏸⏹⏭⏮🔊💬🎬🎵🗳⬇📌🔴⚪✅⚠️🔒📡]+',
    flags=re.UNICODE,
)
_URL_RE = re.compile(r'https?://\S+', re.IGNORECASE)
_MD_RE = re.compile(r'[*_`~>#\[\]]+')


def sanitize_spoken_text(text: str) -> str:
    """Strip markdown, URLs, and emojis so neural TTS speaks naturally."""
    raw = str(text or '').strip()
    if not raw:
        return ''
    cleaned = _URL_RE.sub('', raw)
    cleaned = _EMOJI_RE.sub(' ', cleaned)
    cleaned = _MD_RE.sub('', cleaned)
    cleaned = re.sub(r'\s+', ' ', cleaned).strip()
    return cleaned[:2400]


def resolve_voice_profile(voice: str | None = None, rate: str | None = None, pitch: str | None = None) -> tuple[str, str, str]:
    raw = str(voice or '').strip()
    low = raw.lower()
    if low in VOICE_PROFILES:
        v_id, d_rate, d_pitch = VOICE_PROFILES[low]
        return v_id, str(rate or d_rate), str(pitch or d_pitch)
    return resolve_voice_name(voice), str(rate or DEFAULT_TTS_RATE).strip() or DEFAULT_TTS_RATE, str(pitch or DEFAULT_TTS_PITCH).strip() or DEFAULT_TTS_PITCH


def resolve_voice_name(voice: str | None = None) -> str:
    raw = str(voice or '').strip()
    if not raw:
        return DEFAULT_TTS_VOICE
    if raw.lower() in SUPPORTED_VOICES:
        return SUPPORTED_VOICES[raw.lower()]
    if '-' in raw and 'Neural' in raw:
        return raw
    return DEFAULT_TTS_VOICE


class TtsEngine:
    def __init__(self, cache_dir: str | Path | None = None):
        base = Path(cache_dir) if cache_dir else Path('/tmp/lancy-tts-cache')
        self.cache_dir = base / 'tts_cache'
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._lock = asyncio.Lock()

    def _cache_key(self, clean_text: str, voice: str, rate: str) -> Path:
        digest = hashlib.sha256(f'{voice}|{rate}|{clean_text}'.encode('utf-8')).hexdigest()[:24]
        return self.cache_dir / f'{digest}.pcm'

    async def _ffmpeg_decode_to_pcm(self, input_path: Path, target_rate: int = 48000, channels: int = 2) -> bytes:
        proc = await asyncio.create_subprocess_exec(
            'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
            '-i', str(input_path),
            '-af', 'highpass=f=95,acompressor=threshold=-20dB:ratio=2.5:attack=10:release=120:makeup=3,alimiter=limit=0.92:level=0',
            '-f', 's16le', '-acodec', 'pcm_s16le',
            '-ar', str(int(target_rate)), '-ac', str(int(channels)),
            'pipe:1',
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=15.0)
        if proc.returncode != 0 or not stdout:
            err_msg = (stderr or b'').decode('utf-8', errors='replace')[:200]
            raise RuntimeError(f'ffmpeg TTS decode failed rc={proc.returncode}: {err_msg}')
        align = max(2, int(channels) * 2)
        usable = len(stdout) - (len(stdout) % align)
        return stdout[:usable]

    async def _pcm_to_wav(self, pcm: bytes, out_wav: Path, sample_rate: int = 48000, channels: int = 2) -> Path:
        import wave
        with wave.open(str(out_wav), 'wb') as wf:
            wf.setnchannels(int(channels))
            wf.setsampwidth(2)
            wf.setframerate(int(sample_rate))
            wf.writeframes(pcm)
        return out_wav

    async def synthesize_pcm(
        self,
        text: str,
        *,
        voice: str | None = None,
        rate: str | None = None,
        sample_rate: int = 48000,
        channels: int = 2,
    ) -> bytes:
        clean = sanitize_spoken_text(text)
        if not clean:
            return b''
        eff_voice, eff_rate, eff_pitch = resolve_voice_profile(voice, rate)
        cache_path = self._cache_key(clean, eff_voice, f'{eff_rate}|{eff_pitch}') if (sample_rate == 48000 and channels == 2 and len(clean) <= 220) else None
        if cache_path and cache_path.is_file() and cache_path.stat().st_size > 0:
            try:
                return cache_path.read_bytes()
            except Exception:
                pass

        pcm = b''
        tmp_mp3 = None
        if eff_voice == 'kokoro':
            pcm = await self._try_offline_kokoro(clean, sample_rate=sample_rate, channels=channels)
            if not pcm:
                eff_voice = DEFAULT_TTS_VOICE
        if not pcm:
            try:
                import edge_tts
                fd, raw_mp3 = tempfile.mkstemp(prefix='lancy_tts_', suffix='.mp3')
                os.close(fd)
                tmp_mp3 = Path(raw_mp3)
                comm = edge_tts.Communicate(clean, eff_voice, rate=eff_rate, pitch=eff_pitch)
                await asyncio.wait_for(comm.save(str(tmp_mp3)), timeout=28.0)
                if tmp_mp3.is_file() and tmp_mp3.stat().st_size > 0:
                    pcm = await self._ffmpeg_decode_to_pcm(tmp_mp3, target_rate=sample_rate, channels=channels)
            except Exception as err:
                log.warning('edge-tts synthesis failed (%s): %s', type(err).__name__, str(err)[:160])
            finally:
                if tmp_mp3 is not None:
                    try:
                        tmp_mp3.unlink(missing_ok=True)
                    except Exception:
                        pass

        if not pcm:
            pcm = await self._try_offline_kokoro(clean, sample_rate=sample_rate, channels=channels)

        if pcm and cache_path is not None:
            try:
                tmp_cache = cache_path.with_suffix('.tmp')
                tmp_cache.write_bytes(pcm)
                os.replace(tmp_cache, cache_path)
            except Exception:
                pass
        return pcm

    async def synthesize_stream_pcm(
        self,
        text: str,
        *,
        voice: str | None = None,
        rate: str | None = None,
        sample_rate: int = 48000,
        channels: int = 2,
        chunk_ms: int = 40,
    ):
        """Stream decoded 48kHz stereo PCM chunks incrementally as edge_tts synthesizes MP3 bytes."""
        clean = sanitize_spoken_text(text)
        if not clean:
            return
        eff_voice, eff_rate, eff_pitch = resolve_voice_profile(voice, rate)
        align = max(2, int(channels) * 2)
        chunk_bytes = max(align, int((int(sample_rate) * int(channels) * 2 * max(20, int(chunk_ms))) // 1000))
        chunk_bytes -= (chunk_bytes % align)

        cache_path = self._cache_key(clean, eff_voice, f'{eff_rate}|{eff_pitch}') if (sample_rate == 48000 and channels == 2 and len(clean) <= 220) else None
        if cache_path and cache_path.is_file() and cache_path.stat().st_size > 0:
            try:
                cached = cache_path.read_bytes()
                for off in range(0, len(cached), chunk_bytes):
                    part = cached[off:off + chunk_bytes]
                    usable = len(part) - (len(part) % align)
                    if usable > 0:
                        yield part[:usable]
                return
            except Exception:
                pass

        if eff_voice == 'kokoro':
            pcm = await self._try_offline_kokoro(clean, sample_rate=sample_rate, channels=channels)
            if pcm:
                for off in range(0, len(pcm), chunk_bytes):
                    part = pcm[off:off + chunk_bytes]
                    usable = len(part) - (len(part) % align)
                    if usable > 0:
                        yield part[:usable]
                return
            eff_voice = DEFAULT_TTS_VOICE

        proc = None
        writer_task = None
        all_pcm = bytearray()
        emitted_any = False
        try:
            import edge_tts
            proc = await asyncio.create_subprocess_exec(
                'ffmpeg',
                '-nostdin',
                '-hide_banner',
                '-loglevel', 'error',
                '-f', 'mp3',
                '-i', 'pipe:0',
                '-f', 's16le',
                '-acodec', 'pcm_s16le',
                '-ar', str(int(sample_rate)),
                '-ac', str(int(channels)),
                'pipe:1',
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )

            async def _feed_mp3():
                try:
                    comm = edge_tts.Communicate(clean, eff_voice, rate=eff_rate, pitch=eff_pitch)
                    async for msg in comm.stream():
                        if msg.get('type') == 'audio' and msg.get('data') and proc.stdin is not None:
                            proc.stdin.write(msg['data'])
                            await proc.stdin.drain()
                except Exception as err:
                    log.debug('edge-tts stream feed error (%s): %s', type(err).__name__, str(err)[:120])
                finally:
                    if proc.stdin is not None:
                        try:
                            proc.stdin.close()
                        except Exception:
                            pass

            writer_task = asyncio.create_task(_feed_mp3())
            carry = bytearray()
            while proc.stdout is not None:
                data = await asyncio.wait_for(proc.stdout.read(chunk_bytes), timeout=12.0)
                if not data:
                    break
                carry.extend(data)
                usable = len(carry) - (len(carry) % align)
                if usable >= chunk_bytes:
                    out = bytes(carry[:usable])
                    del carry[:usable]
                    emitted_any = True
                    all_pcm.extend(out)
                    yield out
            if carry:
                usable = len(carry) - (len(carry) % align)
                if usable > 0:
                    out = bytes(carry[:usable])
                    emitted_any = True
                    all_pcm.extend(out)
                    yield out
            await asyncio.wait_for(proc.wait(), timeout=3.0)
            if writer_task is not None:
                await writer_task
            if all_pcm and cache_path is not None and proc.returncode == 0:
                try:
                    tmp_cache = cache_path.with_suffix('.tmp')
                    tmp_cache.write_bytes(bytes(all_pcm))
                    os.replace(tmp_cache, cache_path)
                except Exception:
                    pass
        except Exception as err:
            log.warning('synthesize_stream_pcm failed (%s): %s', type(err).__name__, str(err)[:160])
        finally:
            if writer_task is not None and not writer_task.done():
                writer_task.cancel()
                await asyncio.gather(writer_task, return_exceptions=True)
            if proc is not None and proc.returncode is None:
                try:
                    proc.kill()
                except Exception:
                    pass
                try:
                    await asyncio.wait_for(proc.wait(), timeout=1.0)
                except Exception:
                    pass
        if not emitted_any:
            pcm = await self._try_offline_kokoro(clean, sample_rate=sample_rate, channels=channels)
            for off in range(0, len(pcm), chunk_bytes):
                part = pcm[off:off + chunk_bytes]
                usable = len(part) - (len(part) % align)
                if usable > 0:
                    yield part[:usable]

    async def synthesize_wav(
        self,
        text: str,
        *,
        out_path: str | Path | None = None,
        voice: str | None = None,
        rate: str | None = None,
    ) -> Path | None:
        pcm = await self.synthesize_pcm(text, voice=voice, rate=rate, sample_rate=48000, channels=2)
        if not pcm:
            return None
        target = Path(out_path) if out_path else (self.cache_dir / f'speak_{int(asyncio.get_running_loop().time() * 1000)}.wav')
        await self._pcm_to_wav(pcm, target, sample_rate=48000, channels=2)
        return target

    async def synthesize_ogg_opus(
        self,
        text: str,
        *,
        voice: str | None = None,
        rate: str | None = None,
    ) -> bytes:
        """Synthesize compact OGG/Opus voice-note bytes suitable for Telegram sendVoice."""
        pcm = await self.synthesize_pcm(text, voice=voice, rate=rate, sample_rate=48000, channels=1)
        if not pcm:
            return b''
        proc = await asyncio.create_subprocess_exec(
            'ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error',
            '-f', 's16le', '-acodec', 'pcm_s16le', '-ar', '48000', '-ac', '1',
            '-i', 'pipe:0',
            '-c:a', 'libopus', '-b:a', '32k', '-vbr', 'on', '-application', 'voip',
            '-f', 'ogg', 'pipe:1',
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(input=pcm), timeout=15.0)
        if proc.returncode != 0 or not stdout:
            err_msg = (stderr or b'').decode('utf-8', errors='replace')[:180]
            raise RuntimeError(f'ffmpeg opus encode failed rc={proc.returncode}: {err_msg}')
        return stdout

    async def _try_offline_kokoro(self, clean: str, *, sample_rate: int = 48000, channels: int = 2) -> bytes:
        model_path = self.cache_dir.parent / 'kokoro-v1.0.onnx'
        voices_path = self.cache_dir.parent / 'voices-v1.0.bin'
        if not (model_path.is_file() and voices_path.is_file()):
            return b''
        tmp_wav = None
        try:
            from kokoro_onnx import Kokoro
            import wave
            import numpy as np

            def _run():
                kokoro = Kokoro(str(model_path), str(voices_path))
                samples, sr = kokoro.create(clean, voice='af_heart', speed=1.02, lang='en-us')
                pcm16 = np.clip(samples * 32767.0, -32768, 32767).astype('<i2')
                fd, raw_wav = tempfile.mkstemp(prefix='lancy_koko_', suffix='.wav')
                os.close(fd)
                with wave.open(raw_wav, 'wb') as wf:
                    wf.setnchannels(1)
                    wf.setsampwidth(2)
                    wf.setframerate(int(sr))
                    wf.writeframes(pcm16.tobytes())
                return Path(raw_wav)

            tmp_wav = await asyncio.get_running_loop().run_in_executor(None, _run)
            return await self._ffmpeg_decode_to_pcm(tmp_wav, target_rate=sample_rate, channels=channels)
        except Exception as err:
            log.debug('Offline kokoro TTS fallback skipped: %s', type(err).__name__)
            return b''
        finally:
            if tmp_wav is not None:
                try:
                    tmp_wav.unlink(missing_ok=True)
                except Exception:
                    pass
