"""The check before export (engine/analysis/qc.py): black, frozen picture, silence, loudness and peaks."""
from __future__ import annotations

import json
import os
import subprocess
import sys

from conftest import ENGINE_DIR, FFMPEG, ff

SCRIPT = os.path.join(ENGINE_DIR, 'analysis', 'qc.py')


def qc(video: str, *extra: str) -> dict:
    p = subprocess.run([sys.executable, SCRIPT, '--ffmpeg', FFMPEG, '--video', video, *extra], capture_output=True, text=True, check=True)
    last = json.loads(p.stdout.strip().splitlines()[-1])
    assert last['event'] == 'result', p.stdout
    return last['data']


def test_finds_black_frozen_and_silence(tmp_path):
    video = str(tmp_path / 'qc.mp4')
    # 0-4 moving, 4-5.5 black, 5.5-8.5 moving, 8.5-11.5 one still grey frame, 11.5-14.5 moving.
    # Sound: 0-5 tone, 5-9 silence, 9-14.5 tone.
    ff('-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=4', '-f', 'lavfi', '-i', 'color=black:s=640x360:r=30:d=1.5',
       '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=3', '-f', 'lavfi', '-i', 'color=gray:s=640x360:r=30:d=3',
       '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=3',
       '-f', 'lavfi', '-i', 'sine=f=440:d=5', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=4', '-f', 'lavfi', '-i', 'sine=f=440:d=5.5',
       '-filter_complex', '[0:v][1:v][2:v][3:v][4:v]concat=n=5:v=1:a=0,format=yuv420p[v];[5:a][6:a][7:a]concat=n=3:v=0:a=1[a]',
       '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-crf', '20', '-c:a', 'aac', video)
    d = qc(video)
    assert d['black'] == [{'start': 4.0, 'end': 5.5}]
    assert d['frozen'] == [{'start': 8.5, 'end': 11.5}]
    assert len(d['silence']) == 1 and abs(d['silence'][0]['start'] - 5) < 0.1 and abs(d['silence'][0]['end'] - 9) < 0.1
    assert d['hasAudio'] and d['lufs'] < -10 and d['truePeakDb'] < 0
    # A section only looks at its own range.
    sec = qc(video, '--start', '9', '--end', '14')
    assert sec['black'] == [] and sec['silence'] == []


def test_no_sound(tmp_path):
    video = str(tmp_path / 'mute.mp4')
    ff('-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=3', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', video)
    assert qc(video)['hasAudio'] is False
