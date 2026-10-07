"""Video theme analysis (engine/analysis/style.py): cuts, including jump cuts in the same framing, speech pace
from YouTube captions, and contact sheets."""
from __future__ import annotations

import json
import os
import subprocess
import sys

from conftest import ENGINE_DIR, FFMPEG, ff

SCRIPT = os.path.join(ENGINE_DIR, 'analysis', 'style.py')


def analyze(video: str, out: str, subs: str | None = None) -> dict:
    args = [sys.executable, SCRIPT, '--ffmpeg', FFMPEG, '--video', video, '--out-dir', out, '--prefix', 't']
    if subs:
        args += ['--subs', subs]
    p = subprocess.run(args, capture_output=True, text=True, check=True)
    last = json.loads(p.stdout.strip().splitlines()[-1])
    assert last['event'] == 'result', p.stdout
    return last['data']


def test_finds_hard_cuts_and_jump_cuts(tmp_path):
    video = str(tmp_path / 'ref.mp4')
    # Shots: 0-2 pattern, jump cut to 2-3.5 (same pattern, later), bars, fractal, jump cut, jump cut.
    ff('-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=30', '-f', 'lavfi', '-i', 'smptebars=s=640x360:r=30:d=30',
       '-f', 'lavfi', '-i', 'mandelbrot=s=640x360:r=30', '-f', 'lavfi', '-i', 'sine=f=300:d=40',
       '-filter_complex',
       '[0:v]trim=0:2,setpts=PTS-STARTPTS[a];[0:v]trim=6:7.5,setpts=PTS-STARTPTS[b];[1:v]trim=0:2,setpts=PTS-STARTPTS[c];'
       '[2:v]trim=0:3,setpts=PTS-STARTPTS,format=yuv420p[d];[0:v]trim=12:14,setpts=PTS-STARTPTS[e];[0:v]trim=20:21,setpts=PTS-STARTPTS[f];'
       '[a][b][c][d][e][f]concat=n=6:v=1:a=0,format=yuv420p[v]',
       '-map', '[v]', '-map', '3:a', '-t', '11.5', '-c:v', 'libx264', '-crf', '20', '-c:a', 'aac', video)
    subs = tmp_path / 'ref.en.json3'
    subs.write_text(json.dumps({'events': [
        {'tStartMs': 0, 'segs': [{'utf8': 'So'}, {'utf8': ' today', 'tOffsetMs': 300}, {'utf8': ' we', 'tOffsetMs': 600}, {'utf8': ' are', 'tOffsetMs': 800}]},
        {'tStartMs': 1200, 'segs': [{'utf8': 'testing'}, {'utf8': ' this', 'tOffsetMs': 300}, {'utf8': ' thing', 'tOffsetMs': 500}, {'utf8': ' right', 'tOffsetMs': 800}]},
        {'tStartMs': 2500, 'segs': [{'utf8': 'now'}, {'utf8': ' and', 'tOffsetMs': 200}, {'utf8': ' it', 'tOffsetMs': 400}, {'utf8': ' is', 'tOffsetMs': 600}, {'utf8': ' fast', 'tOffsetMs': 900}]},
    ]}))
    d = analyze(video, str(tmp_path / 'out'), str(subs))
    assert d['cutTimes'] == [2.0, 3.5, 5.5, 8.5, 10.5]
    assert d['shotSeconds']['median'] == 2.0
    assert d['speech']['firstWords'].startswith('So today we are testing')
    assert 150 < d['speech']['wordsPerMinute'] < 320
    assert d['loudnessLufs'] < -5
    assert [s['file'] for s in d['sheets']] == ['t-hook.jpg']
    assert os.path.getsize(tmp_path / 'out' / 't-hook.jpg') > 5000


def test_no_cuts_in_one_moving_shot(tmp_path):
    video = str(tmp_path / 'pan.mp4')
    ff('-f', 'lavfi', '-i', 'mandelbrot=s=640x360:r=30', '-t', '8', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '20', video)
    d = analyze(video, str(tmp_path / 'out'))
    assert d['cutTimes'] == []
    assert 'speech' not in d
