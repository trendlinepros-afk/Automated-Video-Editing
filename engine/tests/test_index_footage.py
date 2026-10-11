"""Footage index (engine/analysis/index_footage.py): shots split at cuts, what each looks like, a still per shot,
and loudness for every second, on generated footage with known content."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time

from conftest import ENGINE_DIR, FFMPEG, ff

SCRIPT = os.path.join(ENGINE_DIR, 'analysis', 'index_footage.py')


def index(video: str, out: str) -> dict:
    p = subprocess.run([sys.executable, SCRIPT, '--ffmpeg', FFMPEG, '--video', video, '--out-dir', out, '--hwaccel', 'none'],
                       capture_output=True, text=True)
    events = [json.loads(line) for line in p.stdout.splitlines() if line.strip()]  # stdout is JSON lines only
    assert p.returncode == 0 and events[-1]['event'] == 'result', p.stdout + p.stderr[-2000:]
    assert any(e['event'] == 'progress' for e in events)
    return events[-1]['data']


def test_three_shots_with_their_look_stills_and_sound(tmp_path):
    video = str(tmp_path / 'clip.mp4')
    # 0-4 s: the busy test pattern; 4-8 s: flat blue; 8-13 s: a white box moving across a dark background. Tone throughout,
    # silent for the last 3 s.
    ff('-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=4', '-f', 'lavfi', '-i', 'color=0x3060c0:s=1280x720:r=30:d=4',
       '-f', 'lavfi', '-i', 'color=0x202020:s=1280x720:r=30:d=5', '-f', 'lavfi', '-i', 'color=white:s=160x160:r=30:d=5',
       '-f', 'lavfi', '-i', "aevalsrc='0.3*sin(2*PI*300*t)*lt(t,10)':s=48000:d=13",
       '-filter_complex', "[2:v][3:v]overlay=x='80+t*200':y=280[m];[0:v][1:v][m]concat=n=3:v=1:a=0,format=yuv420p[v]",
       '-map', '[v]', '-map', '4:a', '-c:v', 'libx264', '-crf', '20', '-c:a', 'aac', video)
    out = tmp_path / 'idx'
    t0 = time.time()
    d = index(video, str(out))
    took = time.time() - t0
    print(f'indexed 13 s of 720p in {took:.2f} s')
    assert took < 13  # well under real time even on a slow CI machine

    shots = d['shots']
    assert [(s['start'], s['end']) for s in shots] == [(0.0, 4.0), (4.0, 8.0), (8.0, 13.0)]
    assert [s['boundary'] for s in shots] == ['start', 'cut', 'cut']
    pattern, flat, box = shots
    # The pattern is detailed, the flat colour has no detail at all.
    assert pattern['sharpness'] > 100 and flat['sharpness'] < 5
    r, g, b = (int(flat['colors'][0][i:i + 2], 16) for i in (1, 3, 5))
    assert abs(r - 0x30) < 6 and abs(g - 0x60) < 6 and abs(b - 0xc0) < 6
    assert len(flat['colors']) == 1 and len(pattern['colors']) >= 2
    assert flat['motion'] < 0.002 and box['motion'] > flat['motion']
    # The box moves but the camera does not.
    assert box['cameraMove'] < 0.01 and box['shake'] < 0.003
    assert box['brightness'] < 0.25 < flat['brightness']
    # The subject of the box shot is where the box travels: a band across the middle.
    sub = box['subject']
    assert sub['by'] == 'motion' and 0.3 < sub['y'] < 0.5 and sub['h'] < 0.4 and sub['w'] > 0.4
    # The best still keeps away from the cuts, and each shot has its picture.
    for s in shots:
        assert s['start'] <= s['best'] <= s['end']
        if s['boundary'] == 'cut':
            assert s['best'] >= s['start'] + 0.25
        assert os.path.getsize(out / s['thumb']) > 500
    assert d['facesChecked'] in (True, False) and all(s['faces'] == 0 for s in shots)
    # Loudness per second: the tone, then silence.
    db = d['audio']['db']
    assert len(db) == 13 and all(-30 < v < -5 for v in db[:9]) and all(v < -60 for v in db[11:])
    assert box['audioPeakDb'] > -30 and box['audioDb'] < pattern['audioDb']


def test_long_take_is_split_and_camera_moves_are_told_apart(tmp_path):
    bg = str(tmp_path / 'bg.png')
    ff('-f', 'lavfi', '-i', 'mandelbrot=s=1600x900', '-frames:v', '1', bg)
    pan, shake, still = (str(tmp_path / f'{n}.mp4') for n in ('pan', 'shake', 'still'))
    ff('-loop', '1', '-i', bg, '-t', '4', '-r', '30', '-vf', "crop=640:360:x='100+t*120':y=200,format=yuv420p", '-c:v', 'libx264', pan)
    ff('-loop', '1', '-i', bg, '-t', '4', '-r', '30', '-vf',
       "crop=640:360:x='400+25*sin(t*37)+18*sin(t*53)':y='250+18*sin(t*41)',format=yuv420p", '-c:v', 'libx264', shake)
    ff('-loop', '1', '-i', bg, '-t', '23', '-r', '30', '-vf', "crop=640:360:x=300:y=250,format=yuv420p", '-c:v', 'libx264', still)
    p = index(pan, str(tmp_path / 'a'))['shots'][0]
    s = index(shake, str(tmp_path / 'b'))['shots'][0]
    assert p['cameraMove'] > 0.1 and p['shake'] < 0.01  # a steady pan of about 0.19 widths a second
    assert s['shake'] > 2 * p['shake'] and s['shake'] > 0.01
    # A 23-second take with nothing happening is cut into pieces of at most 10 s.
    long = index(still, str(tmp_path / 'c'))['shots']
    assert [x['boundary'] for x in long] == ['start', 'length', 'length']
    assert long[-1]['end'] == 23.0 and all(x['end'] - x['start'] <= 10.01 for x in long)
    assert all(x['cameraMove'] < 0.005 and x['motion'] < 0.002 for x in long)


def test_shot_sheet_numbers_the_pictures(tmp_path):
    from PIL import Image

    pics = []
    for i, colour in enumerate(('red', 'blue', 'green')):
        pics.append(str(tmp_path / f'p{i}.jpg'))
        Image.new('RGB', (320, 180), colour).save(pics[-1])
    items = tmp_path / 'items.json'
    items.write_text(json.dumps([{'path': p, 'label': f'shot {i + 1}'} for i, p in enumerate(pics)] + [{'path': '', 'label': 'gone'}]))
    out = str(tmp_path / 'sheet.jpg')
    p = subprocess.run([sys.executable, os.path.join(ENGINE_DIR, 'analysis', 'shot_sheet.py'), '--items', str(items), '--out', out, '--cols', '2'],
                       capture_output=True, text=True, check=True)
    assert json.loads(p.stdout.strip().splitlines()[-1])['data']['count'] == 4
    sheet = Image.open(out).convert('RGB')
    assert sheet.size == (640, 2 * (180 + 18))
    assert sheet.getpixel((160, 120))[0] > 200  # picture 1 (red) at the top left
    assert sheet.getpixel((480, 120))[2] > 200  # picture 2 (blue) beside it
    assert sheet.getpixel((14, 14))[0] > 200 and sheet.getpixel((14, 14))[2] < 80  # the yellow number badge
