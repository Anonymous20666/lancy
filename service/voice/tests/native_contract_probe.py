"""Optional installed-library/FFmpeg probe. Never authenticates or joins Telegram.
Run with service/voice/.venv/bin/python3 service/voice/tests/native_contract_probe.py.
This verifies MediaStream preparation and generated decoder commands, NOT transport.
"""
import asyncio
import importlib.util
import inspect
import json
import shlex
import subprocess
import tempfile
from pathlib import Path
from pytgcalls.methods.utilities.stream_params import StreamParams
from pytgcalls.types.raw.stream import Stream

SPEC = importlib.util.spec_from_file_location('lancy_voice', Path(__file__).resolve().parents[1] / 'main.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

async def main():
    with tempfile.TemporaryDirectory(prefix='lancy-native-contract-') as temp:
        path = Path(temp) / 'fixture.mp4'
        subprocess.run(['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=100:sample_rate=48000', '-t', '2', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', str(path)], check=True, timeout=20)
        results = []
        for video, bass, offset in [(False, False, 0), (False, True, 0), (True, True, 0), (True, True, 0.5)]:
            class CaptureEngine:
                async def play(self, chat, stream, config):
                    assert config.auto_start is False
                    await stream.check_stream()
                    assert stream.microphone is not None
                    assert (stream.camera is not None) is video
                    if bass:
                        assert 'bass=g=3' in stream.microphone.path
                    else:
                        assert 'bass=' not in stream.microphone.path
                    if video:
                        assert 'bass=' not in stream.camera.path
                    native = StreamParams.get_stream_params(stream)
                    if inspect.isawaitable(native): native = await native
                    assert native is not None
                    for command in [stream.microphone.path] + ([stream.camera.path] if video else []):
                        subprocess.run(shlex.split(command), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=True, timeout=20)
            bridge = MODULE.Bridge(temp)
            # This decoder-only probe must not authenticate or perform publisher RPCs.
            async def no_network_publisher(*_): pass
            bridge.ensure_publisher = no_network_publisher
            await bridge.stream({'engine': CaptureEngine()}, -1, {'offset': offset, 'bass': bass, 'video': video, 'path': str(path)})
            results.append({'video': video, 'bass': bass, 'offset': offset, 'decoders_exit_zero': True})
        empty = StreamParams.get_stream_params(Stream())
        if inspect.isawaitable(empty): empty = await empty
        assert empty is not None
        print(json.dumps({'transport_tested': False, 'media_contracts': results, 'empty_idle_stream_conversion': True}))

if __name__ == '__main__':
    asyncio.run(main())
