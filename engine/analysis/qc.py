"""Checks a rendered video for mechanical problems before export.

    python qc.py --ffmpeg FFMPEG --video VIDEO [--start S --end E] [--target-lufs -14]

Prints one JSON line {"event": "result", "data": {...}}: black stretches, frozen picture, dead air (long silence),
loudness against the target and the true peak. Times are seconds in the video. Measurement only: deciding what is
intentional (a photo, a freeze frame, a fade) is up to the app, which knows the timeline.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys


def emit(event: str, **data) -> None:
    sys.stdout.write(json.dumps({'event': event, **data}) + '\n')
    sys.stdout.flush()


def flags() -> dict:
    return {'creationflags': 0x08000000} if os.name == 'nt' else {}


def run(args: list[str]) -> str:
    p = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **flags())
    err = p.stderr.decode('utf-8', 'replace')
    if p.returncode != 0:
        raise RuntimeError('ffmpeg failed: ' + err[-500:])
    return err


def spans(text: str, start_key: str, end_key: str, offset: float) -> list[dict]:
    out, cur = [], None
    for m in re.finditer(rf'({start_key}|{end_key})[:=]\s*(-?[\d.]+)', text):
        key, t = m.group(1), float(m.group(2)) + offset
        if key == start_key:
            cur = t
        elif cur is not None:
            out.append({'start': round(cur, 3), 'end': round(t, 3)})
            cur = None
    return out


def picture(ffmpeg: str, video: str, ss: float, dur: float | None) -> tuple[list[dict], list[dict]]:
    """Black stretches (0.4 s or more) and frozen picture (2 s or more), in one pass over a small copy of each frame."""
    args = [ffmpeg, '-hide_banner', '-nostdin', '-ss', f'{ss:.3f}', *(['-t', f'{dur:.3f}'] if dur else []), '-i', video, '-an',
            '-vf', 'scale=320:-2,blackdetect=d=0.4:pix_th=0.10,freezedetect=n=-60dB:d=2,metadata=print:file=-',
            '-f', 'null', '-']
    p = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **flags())
    if p.returncode != 0:
        raise RuntimeError('ffmpeg could not read the video: ' + p.stderr.decode('utf-8', 'replace')[-500:])
    text = p.stderr.decode('utf-8', 'replace') + p.stdout.decode('utf-8', 'replace')
    black = []
    for m in re.finditer(r'black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)', text):
        black.append({'start': round(float(m.group(1)) + ss, 3), 'end': round(float(m.group(2)) + ss, 3)})
    frozen = spans(text, 'lavfi.freezedetect.freeze_start', 'lavfi.freezedetect.freeze_end', ss)
    # ffmpeg reports each one both in its log and in the metadata printout.
    dedupe = lambda xs: [dict(t) for t in dict.fromkeys(tuple(sorted(x.items())) for x in xs)]
    return dedupe(black), dedupe(frozen)


def audio(ffmpeg: str, video: str, ss: float, dur: float | None) -> dict:
    args = [ffmpeg, '-hide_banner', '-nostdin', '-ss', f'{ss:.3f}', *(['-t', f'{dur:.3f}'] if dur else []), '-i', video, '-vn',
            '-af', 'silencedetect=noise=-45dB:d=3,ebur128=peak=true', '-f', 'null', '-']
    try:
        text = run(args)
    except RuntimeError as e:
        if 'does not contain any stream' in str(e) or 'matches no streams' in str(e):
            return {'hasAudio': False}
        raise
    if 'Audio:' not in text:
        return {'hasAudio': False}
    silence = spans(text, 'silence_start', 'silence_end', ss)
    lufs = re.findall(r'I:\s*(-?[\d.]+) LUFS', text)
    peak = re.findall(r'Peak:\s*(-?[\d.]+|-inf) dBFS', text)
    return {
        'hasAudio': True,
        'silence': silence,
        'lufs': float(lufs[-1]) if lufs else None,
        'truePeakDb': float(peak[-1]) if peak and peak[-1] != '-inf' else None,
    }


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument('--ffmpeg', default='ffmpeg')
    p.add_argument('--video', required=True)
    p.add_argument('--start', type=float, default=0.0)
    p.add_argument('--end', type=float)
    a = p.parse_args()
    try:
        dur = a.end - a.start if a.end is not None else None
        emit('progress', message='Checking the picture')
        black, frozen = picture(a.ffmpeg, a.video, a.start, dur)
        emit('progress', message='Checking the sound')
        snd = audio(a.ffmpeg, a.video, a.start, dur)
        emit('result', data={'black': black, 'frozen': frozen, **snd})
    except Exception as e:  # noqa: BLE001
        emit('error', message=str(e) or e.__class__.__name__)
        sys.exit(1)


if __name__ == '__main__':
    main()
