"""Telegram Native RTMP Live Stream FFmpeg builder and secret scrubber."""
import re
from urllib.parse import urlparse

_QUALITY_PRESETS = {
    'SD_480p': (854, 480, '1800k', '2200k', '4400k'),
    'HD_720p': (1280, 720, '3500k', '4000k', '8000k'),
    'FHD_1080p': (1920, 1080, '5000k', '5800k', '11600k'),
}


def scrub_rtmp_secret(text, rtmp_target=None):
    out = str(text or '')
    if rtmp_target:
        out = out.replace(str(rtmp_target), '<rtmp-redacted>')
    out = re.sub(r'(rtmps?://[^\s/]+/[^\s/]+/)([^\s"\']+)', r'\1<redacted>', out, flags=re.IGNORECASE)
    return out


def escape_ffmpeg_filter_path(path_str):
    return (
        str(path_str)
        .replace('\\', '\\\\')
        .replace(':', '\\:')
        .replace("'", "\\'")
        .replace('[', '\\[')
        .replace(']', '\\]')
    )


AUDIO_PIPE_PLACEHOLDER = '__LANCY_AUDIO_PIPE__'


def build_eq_af_filters(eq_preset='off', *, bass=False, volume=100, video_active=False):
    preset = str(eq_preset or ('bass' if bass else 'off')).strip().lower()
    if preset == 'off' and bass:
        preset = 'bass'
    # -5 dB input headroom + subsonic highpass prevent EQ/AAC inter-sample clipping and DAC cracking.
    filters = ['highpass=f=24', 'volume=0.56234133']
    if preset == 'bass':
        filters.extend([
            'equalizer=f=48:width_type=h:w=50:g=2.5',
            'equalizer=f=110:width_type=h:w=80:g=1.6',
            'equalizer=f=240:width_type=h:w=140:g=-1.8',
            'equalizer=f=3500:width_type=h:w=1400:g=1.2',
            'acompressor=threshold=-18dB:ratio=1.6:attack=20:release=180:makeup=1',
        ])
    elif preset == 'studio':
        filters.extend([
            'highpass=f=30',
            'equalizer=f=75:width_type=h:w=80:g=1.8',
            'equalizer=f=260:width_type=h:w=140:g=-1.0',
            'equalizer=f=4200:width_type=h:w=1500:g=1.5',
            'acompressor=threshold=-18dB:ratio=1.5:attack=20:release=180:makeup=1',
        ])
    elif preset == 'vocal':
        filters.extend([
            'highpass=f=90',
            'equalizer=f=1400:width_type=h:w=900:g=2.4',
            'equalizer=f=3400:width_type=h:w=1200:g=2.0',
            'acompressor=threshold=-18dB:ratio=1.5:attack=20:release=180:makeup=1',
        ])
    elif preset == 'nightcore':
        filters.append('treble=g=2.5:f=4000' if video_active else 'atempo=1.25')
    elif preset == 'vaporwave':
        if video_active:
            filters.extend(['equalizer=f=120:width_type=q:w=1.2:g=2.0', 'lowpass=f=9000'])
        else:
            filters.extend(['aresample=48000', 'asetrate=48000*0.85', 'aresample=48000'])
    elif preset == '8d':
        filters.append('apulsator=hz=0.125')

    vol = int(volume) if volume is not None else 100
    vol = max(0, min(200, vol))
    if vol != 100:
        filters.append(f'volume={vol / 100.0:.3f}')
    # Brickwall soft limiter with level=0 (no auto-gain pump) keeps decoded AAC peaks below -1.5 dBFS.
    filters.append('alimiter=limit=0.84:attack=7:release=80:level=0')
    return filters


def _bitrate_profile(video_quality):
    key = str(video_quality or 'HD_720p')
    return _QUALITY_PRESETS.get(key, _QUALITY_PRESETS['HD_720p'])


def _is_http_url(src):
    try:
        return urlparse(str(src)).scheme in {'http', 'https'}
    except Exception:
        return False


def _format_fps(fps):
    eff_fps = max(12.0, min(60.0, float(fps or 30)))
    for num, den in ((24000, 1001), (30000, 1001), (60000, 1001)):
        rat = float(num) / float(den)
        if abs(eff_fps - rat) < 0.015:
            return rat, int(round(rat)), f'{num}/{den}'
    fps_int = int(round(eff_fps))
    fps_str = str(fps_int) if abs(eff_fps - fps_int) < 1e-3 else f'{eff_fps:.4f}'.rstrip('0').rstrip('.')
    return eff_fps, fps_int, fps_str


def _build_video_demux_parts(
    source_path,
    *,
    has_audio_stream=True,
    width=1280,
    height=720,
    fps=30,
    video_stream_index=None,
    audio_stream_index=None,
    video_count=1,
    audio_count=1,
    pre_seek=0.0,
    copyts=False,
    video_trim_start=None,
    audio_trim_start=None,
    pts_anchor=None,
    eq='off',
    bass=False,
    volume=100,
    is_hls_proxy=False,
    realtime=True,
    preserve_nut_pts=False,
):
    w = max(2, int(width) - (int(width) % 2))
    h = max(2, int(height) - (int(height) % 2))
    eff_fps, fps_int, fps_str = _format_fps(fps)
    is_http = _is_http_url(source_path)

    args = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin']
    if realtime:
        args.extend(['-re', '-readrate_initial_burst', '2.0'])
    if is_http and not is_hls_proxy:
        args.extend([
            '-reconnect', '1',
            '-reconnect_streamed', '1',
            '-reconnect_on_network_error', '1',
            '-reconnect_on_http_error', '4xx,5xx',
            '-reconnect_delay_max', '4',
            '-rw_timeout', '15000000',
        ])
    if copyts:
        args.append('-copyts')
    if pre_seek and float(pre_seek) > 0.05 and not is_hls_proxy:
        args.extend(['-ss', f'{float(pre_seek):.3f}'])
    args.extend(['-i', str(source_path)])
    if not has_audio_stream:
        args.extend(['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000'])

    vf_parts = []
    af_parts = []

    if video_trim_start is not None:
        vf_parts.append(f'trim=start={float(video_trim_start):.3f}')
    if pts_anchor is not None:
        vf_parts.append(f'setpts=PTS-{float(pts_anchor):.3f}/TB')
    elif video_trim_start is not None or copyts:
        vf_parts.append('setpts=PTS-STARTPTS')

    if has_audio_stream:
        if audio_trim_start is not None:
            af_parts.append(f'atrim=start={float(audio_trim_start):.3f}')
        if pts_anchor is not None:
            af_parts.append(f'asetpts=PTS-{float(pts_anchor):.3f}/TB')
        elif audio_trim_start is not None or copyts:
            af_parts.append('asetpts=PTS-STARTPTS')

    vf_parts.append(f'fps=fps={fps_str}' + (':start_time=0' if pts_anchor is not None else ''))
    vf_parts.extend([f'scale={w}:{h}:flags=lanczos', 'setsar=1'])

    af_parts.extend(build_eq_af_filters(eq, bass=bass, volume=volume, video_active=True))
    if preserve_nut_pts:
        af_parts.append('aresample=48000:async=1')
    else:
        af_parts.append('aresample=48000:async=1:first_pts=0')

    v_map = f'0:{int(video_stream_index)}' if (video_stream_index is not None and video_count > 1) else '0:v:0'
    if has_audio_stream:
        a_map = f'0:{int(audio_stream_index)}' if (audio_stream_index is not None and audio_count > 1) else '0:a:0'
    else:
        a_map = '1:a:0'

    return args, vf_parts, af_parts, v_map, a_map, w, h, eff_fps, fps_int, fps_str


def build_rtmp_decoder_args(
    source_path,
    *,
    has_audio_stream=True,
    width=1280,
    height=720,
    fps=30,
    video_stream_index=None,
    audio_stream_index=None,
    video_count=1,
    audio_count=1,
    pre_seek=0.0,
    copyts=False,
    video_trim_start=None,
    audio_trim_start=None,
    pts_anchor=None,
    eq='off',
    bass=False,
    volume=100,
    is_hls_proxy=False,
    realtime=True,
    audio_pipe=AUDIO_PIPE_PLACEHOLDER,
    container='nut',
    preserve_nut_pts=None,
):
    """Build single-demuxer FFmpeg decoder emitting interleaved NUT (default) or legacy dual raw pipes."""
    eff_container = str(container or 'nut').lower()
    eff_preserve_pts = (eff_container == 'nut') if preserve_nut_pts is None else bool(preserve_nut_pts)
    args, vf_parts, af_parts, v_map, a_map, *_ = _build_video_demux_parts(
        source_path,
        has_audio_stream=has_audio_stream,
        width=width,
        height=height,
        fps=fps,
        video_stream_index=video_stream_index,
        audio_stream_index=audio_stream_index,
        video_count=video_count,
        audio_count=audio_count,
        pre_seek=pre_seek,
        copyts=copyts,
        video_trim_start=video_trim_start,
        audio_trim_start=audio_trim_start,
        pts_anchor=pts_anchor,
        eq=eq,
        bass=bass,
        volume=volume,
        is_hls_proxy=is_hls_proxy,
        realtime=realtime,
        preserve_nut_pts=eff_preserve_pts,
    )
    vf_full = [*vf_parts, 'format=yuv420p']
    if str(container or 'nut').lower() == 'nut':
        return [
            *args,
            '-map', v_map,
            '-map', a_map,
            *(['-shortest'] if not has_audio_stream else []),
            '-sn', '-dn',
            '-vf', ','.join(vf_full),
            '-af', ','.join(af_parts),
            '-c:v', 'rawvideo', '-pix_fmt', 'yuv420p',
            '-c:a', 'pcm_s16le', '-ac', '2', '-ar', '48000',
            '-write_index', '0',
            '-f', 'nut', 'pipe:1',
        ]
    return [
        *args,
        '-map', v_map, '-sn', '-dn',
        '-vf', ','.join(vf_full),
        '-an', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1',
        '-map', a_map, '-sn', '-vn',
        '-af', ','.join(af_parts),
        '-f', 's16le', '-ac', '2', '-ar', '48000', str(audio_pipe),
    ]


def build_rtmp_encoder_args(
    rtmp_target,
    *,
    width=1280,
    height=720,
    fps=24,
    video_quality='HD_720p',
    vb=None,
    vmax=None,
    vbuf=None,
    audio_input='pipe:3',
    preset='veryfast',
    threads=4,
    input_format='nut',
    realtime=False,
):
    """Build H.264 High@4.1 + AAC 192k FLV encoder reading interleaved NUT (pipe:0) or legacy rawvideo/s16le."""
    _, _, def_vb, def_vmax, def_vbuf = _bitrate_profile(video_quality)
    eff_vb = str(vb or def_vb)
    eff_vmax = str(vmax or def_vmax)
    eff_vbuf = str(vbuf or def_vbuf)
    w = max(2, int(width) - (int(width) % 2))
    h = max(2, int(height) - (int(height) % 2))
    eff_fps, fps_int, fps_str = _format_fps(fps)
    eff_preset = str(preset or 'veryfast')

    if str(input_format or 'nut').lower() == 'nut':
        in_args = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin']
        if realtime:
            in_args.extend(['-re', '-readrate_initial_burst', '1.5'])
        in_args.extend([
            '-thread_queue_size', '256',
            '-f', 'nut', '-i', 'pipe:0',
            '-map', '0:v:0',
            '-map', '0:a:0',
            '-af', 'aresample=async=1',
        ])
    else:
        in_args = [
            'ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin',
            '-thread_queue_size', '64',
            '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', f'{w}x{h}', '-r', fps_str, '-i', 'pipe:0',
            '-thread_queue_size', '64',
            '-f', 's16le', '-ac', '2', '-ar', '48000', '-i', str(audio_input),
            '-map', '0:v:0',
            '-map', '1:a:0',
        ]

    return [
        *in_args,
        '-c:v', 'libx264', '-preset', eff_preset, '-bf', '0', '-threads', str(int(threads or 4)),
        '-profile:v', 'high', '-level:v', '4.1', '-pix_fmt', 'yuv420p',
        '-r', fps_str, '-g', str(max(15, fps_int * 2)), '-keyint_min', str(max(10, fps_int)), '-sc_threshold', '0',
        '-b:v', eff_vb, '-maxrate', eff_vmax, '-bufsize', eff_vbuf,
        '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000',
        '-max_interleave_delta', '0',
        '-fflags', '+flush_packets',
        '-flvflags', 'no_duration_filesize',
        '-f', 'flv', str(rtmp_target),
    ]


def build_rtmp_ffmpeg_args(
    source_path,
    rtmp_target,
    *,
    video=True,
    has_video_stream=True,
    has_audio_stream=True,
    is_image=False,
    width=1280,
    height=720,
    fps=30,
    video_quality='HD_720p',
    video_stream_index=None,
    audio_stream_index=None,
    video_count=1,
    audio_count=1,
    subtitle_path=None,
    pre_seek=0.0,
    copyts=False,
    video_trim_start=None,
    audio_trim_start=None,
    pts_anchor=None,
    eq='off',
    bass=False,
    volume=100,
    is_hls_proxy=False,
):
    """Build ONE unified FFmpeg command that pushes muxed H.264 + AAC FLV to Telegram RTMPS."""
    _, _, vb, vmax, vbuf = _bitrate_profile(video_quality)
    w = max(2, int(width) - (int(width) % 2))
    h = max(2, int(height) - (int(height) % 2))
    is_http = _is_http_url(source_path)

    base = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin']

    # Pure audio or cover-art tracks use a sleek dark 720p backdrop paired with the audio stream.
    use_synthetic_canvas = (not video) or (not has_video_stream) or is_image
    if use_synthetic_canvas:
        canvas_w = max(640, min(1280, w))
        canvas_h = max(360, min(720, h))
        canvas_w -= canvas_w % 2
        canvas_h -= canvas_h % 2
        args = [
            *base,
            '-re', '-readrate_initial_burst', '1.5',
            '-f', 'lavfi', '-i', f'color=c=0x0b0f17:s={canvas_w}x{canvas_h}:r=15',
        ]
        if is_http and not is_hls_proxy:
            args.extend(['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '4'])
        if pre_seek and float(pre_seek) > 0.05 and not is_hls_proxy:
            args.extend(['-ss', f'{float(pre_seek):.3f}'])
        args.extend(['-i', str(source_path)])

        af_parts = []
        if audio_trim_start is not None:
            af_parts.append(f'atrim=start={float(audio_trim_start):.3f}')
            af_parts.append('asetpts=PTS-STARTPTS')
        af_parts.extend(build_eq_af_filters(eq, bass=bass, volume=volume, video_active=False))
        af_parts.append('aresample=48000:async=1:first_pts=0')

        audio_map = f'1:{int(audio_stream_index)}' if (audio_stream_index is not None and audio_count > 1) else '1:a:0'
        args.extend([
            '-map', '0:v:0',
            '-map', audio_map,
            '-shortest',
            '-vf', 'format=yuv420p',
            '-af', ','.join(af_parts),
            '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-threads', '2',
            '-pix_fmt', 'yuv420p', '-r', '15', '-g', '30', '-keyint_min', '15', '-sc_threshold', '0',
            '-b:v', '450k', '-maxrate', '600k', '-bufsize', '1200k',
            '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000',
            '-flvflags', 'no_duration_filesize',
            '-f', 'flv', str(rtmp_target),
        ])
        return args

    # Full Video / Movie mode: one shared demuxer & one paced RTMP FLV encode.
    args, vf_parts, af_parts, v_map, a_map, _, _, _, fps_int, fps_str = _build_video_demux_parts(
        source_path,
        has_audio_stream=has_audio_stream,
        width=w,
        height=h,
        fps=fps,
        video_stream_index=video_stream_index,
        audio_stream_index=audio_stream_index,
        video_count=video_count,
        audio_count=audio_count,
        pre_seek=pre_seek,
        copyts=copyts,
        video_trim_start=video_trim_start,
        audio_trim_start=audio_trim_start,
        pts_anchor=pts_anchor,
        eq=eq,
        bass=bass,
        volume=volume,
        is_hls_proxy=is_hls_proxy,
        realtime=True,
    )
    if subtitle_path:
        esc_sub = escape_ffmpeg_filter_path(subtitle_path)
        vf_parts.append(
            f"subtitles='{esc_sub}':force_style='FontName=DejaVu Sans,FontSize=24,Bold=-1,PrimaryColour=&H00FFFFFF,"
            f"OutlineColour=&H00000000,BackColour=&HA0000000,BorderStyle=1,Outline=2.2,Shadow=1.4,MarginV=24'"
        )
    vf_parts.append('format=yuv420p')

    args.extend([
        '-map', v_map,
        '-map', a_map,
        *(['-shortest'] if not has_audio_stream else []),
        '-sn', '-dn',
        '-vf', ','.join(vf_parts),
        '-af', ','.join(af_parts),
        '-c:v', 'libx264', '-preset', 'veryfast', '-bf', '0', '-threads', '4',
        '-profile:v', 'high', '-level:v', '4.1', '-pix_fmt', 'yuv420p',
        '-r', fps_str, '-g', str(max(15, fps_int * 2)), '-keyint_min', str(max(10, fps_int)), '-sc_threshold', '0',
        '-b:v', vb, '-maxrate', vmax, '-bufsize', vbuf,
        '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000',
        '-flvflags', 'no_duration_filesize',
        '-f', 'flv', str(rtmp_target),
    ])
    return args


def build_rtmp_standby_args(rtmp_target, *, width=1280, height=720):
    """Lightweight dark-slate standby stream so Telegram keeps RTMP live during pause/idle."""
    w = max(640, min(1280, int(width) - (int(width) % 2)))
    h = max(360, min(720, int(height) - (int(height) % 2)))
    return [
        'ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-re',
        '-f', 'lavfi', '-i', f'color=c=0x0d1117:s={w}x{h}:r=10',
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-threads', '1',
        '-pix_fmt', 'yuv420p', '-r', '10', '-g', '20',
        '-b:v', '250k', '-maxrate', '350k', '-bufsize', '700k',
        '-c:a', 'aac', '-b:a', '64k', '-ac', '2', '-ar', '48000',
        '-flvflags', 'no_duration_filesize',
        '-f', 'flv', str(rtmp_target),
    ]
