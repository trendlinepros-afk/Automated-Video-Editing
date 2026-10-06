"""Command line: `python -m ave_engine [--ffmpeg PATH] [--ffprobe PATH] <command> [options]`.

Every command ends with one {"event":"result","data":...} line, or {"event":"error",...} and exit code 1.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import platform
import signal
import sys
import traceback

import numpy as np

from . import VERSION, events, media
from .events import Progress, chunk_done, emit, log, result


def _load_json(path: str):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def _times(s: str) -> list[float]:
    return [float(x) for x in s.replace(';', ',').split(',') if x.strip()]


def _log(message: str, level: str = 'info') -> None:
    log(message, level)


# ---------------------------------------------------------------------------------------------
# check / probe / proxy

def cmd_check(a) -> None:
    from .backend import torch_status
    from .encode import nvenc_available

    st = torch_status()
    ff = ''
    nvenc = False
    try:
        out = media.run([media.ffmpeg_path(), '-hide_banner', '-version'], 'ffmpeg').decode('utf-8', 'replace')
        first = out.splitlines()[0] if out else ''
        parts = first.split()
        ff = parts[2] if len(parts) > 2 and parts[0] == 'ffmpeg' else first
        nvenc = nvenc_available('h264')
    except (RuntimeError, OSError, IndexError) as e:
        log(f'ffmpeg check failed: {e}', 'warn')
    result({
        'engineVersion': VERSION,
        'python': platform.python_version(),
        'numpy': np.__version__,
        'torch': st['torch'],
        'cuda': st['cuda'],
        'gpu': st['gpu'],
        'nvenc': nvenc,
        'ffmpeg': ff,
    })


def cmd_probe(a) -> None:
    result(media.probe(a.path).public())


def cmd_proxy(a) -> None:
    from .encode import COLOR_TAGS

    info = media.probe(a.path)
    if info.kind != 'video':
        raise ValueError(f'Proxies are made for video files only ({os.path.basename(a.path)} is {info.kind})')
    h = int(a.height)
    gop = str(max(2, int(round((info.fps or 30) / 2))))
    tags = []
    flag = {'color_space': '-colorspace', 'color_primaries': '-color_primaries', 'color_transfer': '-color_trc',
            'color_range': '-color_range'}
    for k, v in info.color.items():
        tags += [flag[k], v]
    tmp = _partial(a.out)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    args = [media.ffmpeg_path(), '-y', '-hide_banner', '-nostdin', '-loglevel', 'error', '-i', a.path,
            '-map', '0:v:0', '-an', '-sn', '-dn',
            '-vf', f"scale=-2:'min({h},ih)':flags=bicubic,format=yuv420p",
            '-r', info.fps_str or '30/1', '-fps_mode', 'cfr',
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-g', gop, '-keyint_min', gop,
            '-sc_threshold', '0', *tags, '-movflags', '+faststart',
            '-progress', 'pipe:1', '-nostats', '-f', 'mp4', tmp]
    total = max(0.001, info.duration)
    prog = Progress(1000, message='Making preview copy')
    last = [0]

    def on(sec):
        done = int(1000 * sec / total)
        if done > last[0]:
            prog.step(done - last[0])
            last[0] = done

    try:
        media.run_with_progress(args, total, on)
        media.replace_file(tmp, a.out)
        prog.step(1000 - last[0], force=True)
    finally:
        _remove(tmp)
    result({'out': a.out})


def _partial(out: str) -> str:
    from .encode import temp_path

    return temp_path(out)


def _remove(path: str) -> None:
    try:
        if path and os.path.exists(path):
            os.remove(path)
    except OSError:
        pass


# ---------------------------------------------------------------------------------------------
# rendering

def _frame_count(start: float, end: float, fps: float) -> int:
    return max(1, int(round((end - start) * fps)))


def _frame_bytes(B, F, yuv: bool):
    if yuv:
        return B.to_yuv420p(F)
    return memoryview(np.ascontiguousarray(B.to_uint8(F))).cast('B')


def _use_yuv(B, w: int, h: int) -> bool:
    return B.name == 'torch' and w % 2 == 0 and h % 2 == 0


def cmd_render_chunks(a) -> None:
    from .compositor import Renderer
    from .encode import RGB_TO_YUV, FrameWriter, preview_video_args, raw_input_args

    plan = _load_json(a.plan)
    jobs = _load_json(a.jobs)
    r = Renderer(plan)
    W, H, fps = r.width, r.height, r.fps
    yuv = _use_yuv(r.B, W, H)
    jobs = sorted(jobs, key=lambda j: (float(j['start']), int(j['index'])))
    total = sum(_frame_count(float(j['start']), float(j['end']), fps) for j in jobs)
    prog = Progress(total, message='Rendering preview')
    done = []
    try:
        for j in jobs:
            start, end = float(j['start']), float(j['end'])
            n = _frame_count(start, end, fps)
            out = j['out']
            os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
            tmp = _partial(out)
            args = [media.ffmpeg_path(), '-y', '-hide_banner', '-nostdin', '-loglevel', 'error',
                    *raw_input_args(W, H, fps, yuv)]
            if not yuv:
                args += ['-vf', RGB_TO_YUV]
            args += [*preview_video_args(n), '-an', '-movflags', '+faststart', '-f', 'mp4', tmp]
            w = FrameWriter(args)
            try:
                for k in range(n):
                    F = r.frame(start + k / fps)
                    w.write(_frame_bytes(r.B, F, yuv))
                    prog.step()
                w.close()
            except BaseException:
                w.abort()
                _remove(tmp)
                raise
            media.replace_file(tmp, out)
            chunk_done(int(j['index']), out)
            done.append({'index': int(j['index']), 'out': out, 'frames': n})
    finally:
        r.close()
    prog.step(0, force=True)
    result({'chunks': done, 'fps': round(prog.fps, 2), 'backend': r.B.name})


def _save_png(B, F, path: str) -> str:
    from PIL import Image

    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    tmp = path + '.part.png'
    Image.fromarray(B.to_uint8(F), 'RGB').save(tmp, compress_level=3)
    media.replace_file(tmp, path)
    return path


def cmd_frame(a) -> None:
    from .compositor import Renderer

    plan = _load_json(a.plan)
    r = Renderer(plan, footage_only=a.footage_only)
    try:
        F = r.frame(float(a.time))
        _save_png(r.B, F, a.out)
    finally:
        r.close()
    result({'out': a.out})


def cmd_frames(a) -> None:
    from .compositor import Renderer

    plan = _load_json(a.plan)
    times = _times(a.times)
    os.makedirs(a.out_dir, exist_ok=True)
    r = Renderer(plan)
    files: list[str | None] = [None] * len(times)
    prog = Progress(len(times), message='Rendering stills')
    try:
        for i in sorted(range(len(times)), key=lambda i: times[i]):
            t = times[i]
            path = os.path.join(a.out_dir, f'frame_{i:03d}_{int(round(t * 1000)):08d}.png')
            _save_png(r.B, r.frame(t), path)
            files[i] = path
            prog.step()
    finally:
        r.close()
    result({'files': files})


def cmd_graphic_preview(a) -> None:
    from PIL import Image

    from .graphics import checkerboard, merge_brand, render_graphic, resolve_brand_paths

    params = json.loads(a.params) if a.params else {}
    if not isinstance(params, dict):
        raise ValueError('--params must be a JSON object')
    brand = _load_json(a.brand) if a.brand else None
    brand = resolve_brand_paths(merge_brand(brand), os.path.dirname(os.path.abspath(a.brand)) if a.brand else None)
    W, H = int(a.width), int(a.height)
    os.makedirs(a.out_dir, exist_ok=True)
    stem = os.path.splitext(os.path.basename(a.file))[0]
    files = []
    bg = checkerboard(W, H).convert('RGBA')
    for i, t in enumerate(_times(a.times)):
        rgba = render_graphic(a.file, t, W, H, float(a.duration), params, 30.0, brand, t)
        img = Image.alpha_composite(bg, Image.fromarray(rgba, 'RGBA')).convert('RGB')
        path = os.path.join(a.out_dir, f'{stem}_{i:02d}_{int(round(t * 1000)):06d}.png')
        img.save(path)
        files.append(path)
    result({'files': files})


# ---------------------------------------------------------------------------------------------
# audio

def cmd_mix(a) -> None:
    from .audio import full_mix, slice_audio

    plan = _load_json(a.plan)
    res = full_mix(plan, dialogue_only=a.dialogue_only, want_stems=bool(a.stems), log=_log)
    sr = res['sr']
    start = None if a.start is None else float(a.start)
    end = None if a.end is None else float(a.end)
    out = slice_audio(res['mix'], sr, start, end, a.fade)
    media.write_wav(a.out, out, sr)
    data = {'out': a.out, 'lufs': res['lufs'], 'truePeakDb': res['truePeakDb'], 'masterGainDb': res['masterGainDb']}
    if a.stems:
        os.makedirs(a.stems, exist_ok=True)
        files = {}
        for name, arr in (res['stems'] or {}).items():
            p = os.path.join(a.stems, f'{name}.wav')
            media.write_wav(p, slice_audio(arr, sr, start, end, a.fade), sr)
            files[name] = p
        p = os.path.join(a.stems, 'mix.wav')
        media.write_wav(p, out, sr)
        files['mix'] = p
        data['stems'] = files
    result(data)


def cmd_energy(a) -> None:
    sr = 48000
    start, end = float(a.start), float(a.end)
    step = float(a.step_ms)
    if step <= 0:
        raise ValueError('--step-ms must be positive')
    x = media.decode_audio(a.path, start=start, duration=max(0.0, end - start), sr=sr, channels=1)[:, 0]
    n = int(round((end - start) * 1000 / step))
    out = []
    for i in range(n):
        s0 = int(round(i * step * sr / 1000))
        s1 = int(round((i + 1) * step * sr / 1000))
        seg = x[s0:s1]
        if len(seg) == 0:
            out.append(-120.0)
            continue
        rms = math.sqrt(float(np.mean(seg.astype(np.float64) ** 2)))
        out.append(round(max(-120.0, 20 * math.log10(rms)) if rms > 0 else -120.0, 2))
    result({'stepMs': step, 'start': start, 'db': out})


def cmd_peaks(a) -> None:
    per = max(1, int(a.per_second))
    k = max(1, int(round(24000 / per)))
    sr = per * k
    peaks: list[float] = []
    rest = np.zeros(0, np.float32)
    for block in media.stream_audio(a.path, sr, 2):
        m = np.abs(block).max(axis=1)
        m = np.concatenate([rest, m]) if len(rest) else m
        n = len(m) // k
        if n:
            peaks.extend(np.round(np.minimum(1.0, m[: n * k].reshape(n, k).max(axis=1)), 4).tolist())
        rest = m[n * k:]
    if len(rest):
        peaks.append(round(float(min(1.0, rest.max())), 4))
    result({'peaks': peaks})


def cmd_snippet(a) -> None:
    start, end = float(a.start), float(a.end)
    tmp = a.out + '.part.wav'
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    try:
        media.run([media.ffmpeg_path(), '-y', '-hide_banner', '-nostdin', '-loglevel', 'error',
                   '-ss', f'{max(0.0, start):.6f}', '-t', f'{max(0.0, end - start):.6f}', '-i', a.path,
                   '-vn', '-map', '0:a:0', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', '-f', 'wav', tmp], 'Snippet')
        media.replace_file(tmp, a.out)
    finally:
        _remove(tmp)
    result({'out': a.out})


def cmd_loudness(a) -> None:
    from .loudness import LoudnessMeter

    m = LoudnessMeter(48000, 2)
    for block in media.stream_audio(a.path, 48000, 2):
        m.add(block)
    result({'lufs': m.integrated(), 'truePeakDb': m.true_peak_db()})


# ---------------------------------------------------------------------------------------------
# export

def cmd_export(a) -> None:
    from .audio import full_mix, plan_duration, slice_audio
    from .compositor import Renderer
    from .encode import RGB_TO_YUV, FrameWriter, export_video_args, nvenc_available, raw_input_args, temp_path

    plan = _load_json(a.plan)
    total_dur = plan_duration(plan)
    start = 0.0 if a.start is None else max(0.0, float(a.start))
    end = total_dur if a.end is None else float(a.end)
    if end <= start:
        raise ValueError('The export range is empty')
    codec = a.codec
    encoder = 'cpu'
    if a.encoder in ('auto', 'nvenc'):
        if nvenc_available(codec):
            encoder = 'nvenc'
        elif a.encoder == 'nvenc':
            log('The NVIDIA encoder is not available here; using the CPU encoder.', 'warn')
    out = a.out
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    tmp = temp_path(out)
    wav = os.path.splitext(tmp)[0] + '.wav'
    _remove(tmp)
    _remove(wav)

    emit({'event': 'progress', 'done': 0, 'total': 1, 'message': 'Mixing audio'})
    mix = full_mix(plan, log=_log)
    r = Renderer(plan)
    W, H, fps = r.width, r.height, r.fps
    n = _frame_count(start, end, fps)
    sr = mix['sr']
    audio = slice_audio(mix['mix'], sr, start, start + n / fps, a.fade)
    media.write_wav(wav, audio, sr)

    yuv = _use_yuv(r.B, W, H)
    args = [media.ffmpeg_path(), '-y', '-hide_banner', '-nostdin', '-loglevel', 'error',
            *raw_input_args(W, H, fps, yuv), '-i', wav, '-map', '0:v:0', '-map', '1:a:0']
    if not yuv:
        args += ['-vf', RGB_TO_YUV]
    args += [*export_video_args(codec, encoder, a.quality, fps),
             '-c:a', 'aac', '-b:a', '320k', '-ar', str(sr), '-movflags', '+faststart', '-f', 'mp4', tmp]
    vname = args[args.index('-c:v') + 1]
    log(f'Export {W}x{H} {fps:g} fps, {n} frames, video encoder {vname}, compositor on {r.B.name}')
    prog = Progress(n, message='Exporting')
    w = FrameWriter(args)
    finished = False
    try:
        for k in range(n):
            F = r.frame(start + k / fps)
            w.write(_frame_bytes(r.B, F, yuv))
            prog.step()
        w.close()
        media.replace_file(tmp, out)
        finished = True
    finally:
        if not finished:
            w.abort()
            _remove(tmp)
        _remove(wav)
        r.close()
    result({'out': out, 'duration': round(n / fps, 6), 'ffmpegCommand': media.command_string(args), 'encoder': vname,
            'lufs': mix['lufs'], 'truePeakDb': mix['truePeakDb'], 'fps': round(prog.fps, 2)})


# ---------------------------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog='ave_engine', description='AI Video Editor rendering engine')
    p.add_argument('--ffmpeg')
    p.add_argument('--ffprobe')
    sub = p.add_subparsers(dest='cmd', required=True)

    sub.add_parser('check')
    s = sub.add_parser('probe')
    s.add_argument('--path', required=True)
    s = sub.add_parser('proxy')
    s.add_argument('--path', required=True)
    s.add_argument('--out', required=True)
    s.add_argument('--height', type=int, default=540)
    s = sub.add_parser('render-chunks')
    s.add_argument('--plan', required=True)
    s.add_argument('--jobs', required=True)
    s = sub.add_parser('mix')
    s.add_argument('--plan', required=True)
    s.add_argument('--out', required=True)
    s.add_argument('--start', type=float)
    s.add_argument('--end', type=float)
    s.add_argument('--dialogue-only', action='store_true')
    s.add_argument('--stems')
    s.add_argument('--fade', type=float, default=0.05)
    s = sub.add_parser('export')
    s.add_argument('--plan', required=True)
    s.add_argument('--out', required=True)
    s.add_argument('--start', type=float)
    s.add_argument('--end', type=float)
    s.add_argument('--quality', choices=['draft', 'good', 'best'], default='best')
    s.add_argument('--codec', choices=['h264', 'hevc'], default='h264')
    s.add_argument('--encoder', choices=['auto', 'nvenc', 'cpu'], default='auto')
    s.add_argument('--fade', type=float, default=0.05)
    s = sub.add_parser('frame')
    s.add_argument('--plan', required=True)
    s.add_argument('--time', type=float, required=True)
    s.add_argument('--out', required=True)
    s.add_argument('--footage-only', action='store_true')
    s = sub.add_parser('frames')
    s.add_argument('--plan', required=True)
    s.add_argument('--times', required=True)
    s.add_argument('--out-dir', required=True)
    s = sub.add_parser('graphic-preview')
    s.add_argument('--file', required=True)
    s.add_argument('--params', default='{}')
    s.add_argument('--duration', type=float, default=5.0)
    s.add_argument('--times', required=True)
    s.add_argument('--width', type=int, default=960)
    s.add_argument('--height', type=int, default=540)
    s.add_argument('--brand')
    s.add_argument('--out-dir', required=True)
    s = sub.add_parser('energy')
    s.add_argument('--path', required=True)
    s.add_argument('--start', type=float, required=True)
    s.add_argument('--end', type=float, required=True)
    s.add_argument('--step-ms', type=float, default=5.0)
    s = sub.add_parser('peaks')
    s.add_argument('--path', required=True)
    s.add_argument('--per-second', type=int, default=100)
    s = sub.add_parser('snippet')
    s.add_argument('--path', required=True)
    s.add_argument('--start', type=float, required=True)
    s.add_argument('--end', type=float, required=True)
    s.add_argument('--out', required=True)
    s = sub.add_parser('loudness')
    s.add_argument('--path', required=True)
    return p


COMMANDS = {
    'check': cmd_check,
    'probe': cmd_probe,
    'proxy': cmd_proxy,
    'render-chunks': cmd_render_chunks,
    'mix': cmd_mix,
    'export': cmd_export,
    'frame': cmd_frame,
    'frames': cmd_frames,
    'graphic-preview': cmd_graphic_preview,
    'energy': cmd_energy,
    'peaks': cmd_peaks,
    'snippet': cmd_snippet,
    'loudness': cmd_loudness,
}


class _ParseError(Exception):
    pass


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise _ParseError(message)


def _stop(signum, frame):
    raise SystemExit(130)


def main(argv: list[str] | None = None) -> None:
    events.claim_stdout()
    for name in ('SIGTERM', 'SIGBREAK'):
        if hasattr(signal, name):
            try:
                signal.signal(getattr(signal, name), _stop)
            except (ValueError, OSError):
                pass
    parser = build_parser()
    parser.__class__ = _Parser
    for action in parser._subparsers._group_actions:  # noqa: SLF001
        for sp in action.choices.values():
            sp.__class__ = _Parser
    try:
        a = parser.parse_args(argv)
        media.configure(a.ffmpeg, a.ffprobe)
        COMMANDS[a.cmd](a)
    except _ParseError as e:
        events.error(f'Bad arguments: {e}')
        sys.exit(1)
    except SystemExit as e:
        if e.code not in (0, None):
            events.error('Stopped')
        raise
    except BaseException as e:  # noqa: BLE001
        events.error(str(e) or e.__class__.__name__, traceback.format_exc())
        sys.exit(1)
