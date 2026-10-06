"""Shared fixtures: synthetic media made with ffmpeg, a test timeline, and a runner for the engine CLI.

Set AVE_MATCH_SECONDS=30 to run the preview/export match test on the full 30-second timeline
(the default is shorter so the suite stays quick on a CPU).
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys

import pytest

ENGINE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO_DIR = os.path.dirname(ENGINE_DIR)
STARTER = os.path.join(ENGINE_DIR, 'starter_assets')

if ENGINE_DIR not in sys.path:
    sys.path.insert(0, ENGINE_DIR)

FFMPEG = shutil.which('ffmpeg') or 'ffmpeg'


def ff(*args: str) -> None:
    subprocess.run([FFMPEG, '-y', '-hide_banner', '-loglevel', 'error', *args], check=True)


def run_engine(*args: str, check: bool = True) -> tuple[list[dict], dict | None]:
    """Run `python -m ave_engine ...`; returns (all events, result data). Asserts stdout is JSON lines only."""
    env = dict(os.environ)
    env['PYTHONPATH'] = ENGINE_DIR + os.pathsep + env.get('PYTHONPATH', '')
    env.setdefault('AVE_BACKEND', 'numpy')
    p = subprocess.run([sys.executable, '-m', 'ave_engine', *args], capture_output=True, text=True, env=env, cwd=ENGINE_DIR)
    events = []
    for line in p.stdout.splitlines():
        if not line.strip():
            continue
        events.append(json.loads(line))  # anything that is not JSON fails the test here
    result = next((e['data'] for e in events if e['event'] == 'result'), None)
    if check:
        errors = [e for e in events if e['event'] == 'error']
        assert p.returncode == 0 and not errors, f'engine failed: {errors}\n{p.stderr[-3000:]}'
    return events, result


@pytest.fixture(scope='session')
def media(tmp_path_factory):
    d = tmp_path_factory.mktemp('media')
    m = {}
    # A-roll: two "cameras" with a talking-like tone (bursts with pauses), 1080p 30 fps.
    speech = "aevalsrc='0.35*sin(2*PI*180*t)*(0.6+0.4*sin(2*PI*3*t))*lt(mod(t,2.5),1.7)':s=48000:d=40"
    m['a1'] = str(d / 'a1.mp4')
    ff('-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30:d=40', '-f', 'lavfi', '-i', speech,
       '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '16', '-g', '45', '-pix_fmt', 'yuv420p',
       '-c:a', 'aac', '-b:a', '192k', '-shortest', m['a1'])
    m['a2'] = str(d / 'a2.mp4')
    ff('-f', 'lavfi', '-i', 'testsrc=s=1920x1080:r=30:d=40', '-f', 'lavfi', '-i', speech.replace('180', '220'),
       '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '16', '-g', '45', '-pix_fmt', 'yuv420p',
       '-c:a', 'aac', '-b:a', '192k', '-shortest', m['a2'])
    # B-roll: a different aspect (4:3) colour pattern, no audio.
    m['b1'] = str(d / 'b1.mp4')
    ff('-f', 'lavfi', '-i', 'smptehdbars=s=1440x1080:r=30:d=20', '-vf', "hue=H=2*PI*t/5",
       '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '16', '-pix_fmt', 'yuv420p', m['b1'])
    # Music: a steady chord.
    m['music'] = str(d / 'music.wav')
    ff('-f', 'lavfi', '-i', "aevalsrc='0.2*sin(2*PI*261.6*t)+0.2*sin(2*PI*329.6*t)+0.2*sin(2*PI*392*t)|0.2*sin(2*PI*261.6*t)+0.2*sin(2*PI*329.6*t)+0.2*sin(2*PI*392*t)':s=48000:d=40",
       '-c:a', 'pcm_s16le', m['music'])
    m['sfx'] = os.path.join(STARTER, 'sfx_whoosh', 'whoosh.wav')
    # A still image.
    m['still'] = str(d / 'still.png')
    ff('-f', 'lavfi', '-i', 'testsrc2=s=800x800:d=1', '-frames:v', '1', m['still'])
    # Proxies made by the engine, as the app does.
    for k in ('a1', 'a2', 'b1'):
        out = str(d / f'{k}_proxy.mp4')
        run_engine('proxy', '--path', m[k], '--out', out, '--height', '540')
        m[k + '_proxy'] = out
    m['dir'] = str(d)
    return m


def caption_lines(t0: float, t1: float) -> list[dict]:
    words = ['this', 'is', 'a', 'test', 'of', 'the', 'caption', 'burn', 'in', 'engine', 'okay', 'great']
    lines = []
    t = t0
    i = 0
    while t + 1.2 < t1:
        ws = []
        for k in range(3):
            w = words[(i + k) % len(words)]
            ws.append({'text': w, 'start': t + k * 0.4, 'end': t + k * 0.4 + 0.35, 'emphasis': w == 'test'})
        lines.append({'start': t, 'end': t + 1.2, 'words': ws})
        t += 1.5
        i += 3
    return lines


def make_plan(media: dict, project_dir: str, width: int, height: int, fps: float = 30, duration: float = 12.0,
              proxies: bool = False, captions: bool = True, effects: bool = True, graphic: bool = True) -> dict:
    """A test timeline: A-roll cuts between two files, B-roll with a transform and with keyframes, a still,
    a library graphic, several effects and captions, plus voice, ducked music and a sound effect."""
    src = (lambda k: media[k + '_proxy']) if proxies else (lambda k: media[k])
    D = duration
    layers = []
    # A-roll: cut every D/4 seconds, alternating files, non-contiguous source times.
    cuts = [0, D * 0.25, D * 0.5, D * 0.75, D]
    for i in range(4):
        layers.append({'kind': 'video', 'id': f'seg{i}', 'trackId': 'aroll', 'role': 'aroll',
                       'path': src('a1' if i % 2 == 0 else 'a2'), 'isImage': False,
                       'start': cuts[i], 'end': cuts[i + 1], 'sourceIn': 1.0 + i * 3.1, 'speed': 1.0, 'hold': False,
                       'transform': None, 'keyframes': [], 'fadeIn': 0, 'fadeOut': 0,
                       'sourceWidth': 1920, 'sourceHeight': 1080})
    # B-roll: full frame (4:3 source fitted over a blur) with fades, then picture-in-picture with keyframes.
    layers.append({'kind': 'video', 'id': 'broll1', 'trackId': 'broll', 'role': 'broll', 'path': src('b1'),
                   'isImage': False, 'start': D * 0.1, 'end': D * 0.22, 'sourceIn': 2.0, 'speed': 1.0, 'hold': False,
                   'transform': None, 'keyframes': [], 'fadeIn': 0.3, 'fadeOut': 0.3,
                   'sourceWidth': 1440, 'sourceHeight': 1080})
    layers.append({'kind': 'video', 'id': 'broll2', 'trackId': 'broll', 'role': 'broll', 'path': src('b1'),
                   'isImage': False, 'start': D * 0.55, 'end': D * 0.7, 'sourceIn': 5.0, 'speed': 1.0, 'hold': False,
                   'transform': {'x': 0.22, 'y': -0.18, 'scale': 0.4, 'rotation': 4, 'opacity': 1},
                   'keyframes': [{'t': 0, 'x': 0.25, 'y': -0.2, 'scale': 0.35}, {'t': D * 0.15, 'x': 0.15, 'y': -0.1, 'scale': 0.45}],
                   'fadeIn': 0, 'fadeOut': 0, 'sourceWidth': 1440, 'sourceHeight': 1080})
    layers.append({'kind': 'video', 'id': 'still1', 'trackId': 'broll', 'role': 'broll', 'path': media['still'],
                   'isImage': True, 'start': D * 0.8, 'end': D * 0.88, 'sourceIn': 0, 'speed': 1.0, 'hold': False,
                   'transform': {'x': -0.25, 'y': 0.1, 'scale': 0.5, 'rotation': 0, 'opacity': 0.9}, 'keyframes': [],
                   'fadeIn': 0, 'fadeOut': 0})
    if effects:
        fx = [('grade', D * 0.05, D * 0.3, {'saturation': 1.25, 'contrast': 1.1, 'temperature': 0.3, 'gain': 1.05}),
              ('vignette', D * 0.3, D * 0.6, {'amount': 0.4}),
              ('zoom', D * 0.4, D * 0.48, {'amount': 0.25, 'x': 0.1, 'y': -0.05}),
              ('flash', D * 0.5, D * 0.53, {}),
              ('light_leak', D * 0.6, D * 0.72, {}),
              ('snow', D * 0.7, D * 0.85, {'amount': 1.0}),
              ('freeze', D * 0.86, D * 0.9, {}),
              ('replay', D * 0.9, D * 0.96, {'lookback': 2, 'speed': 0.5})]
        for i, (kind, s, e, p) in enumerate(fx):
            layers.append({'kind': 'effect', 'id': f'fx{i}_{kind}', 'trackId': 'effects', 'effect': kind,
                           'params': p, 'start': s, 'end': e, 'fadeIn': 0, 'fadeOut': 0})
    if graphic:
        layers.append({'kind': 'graphic', 'id': 'g1', 'trackId': 'graphics',
                       'file': os.path.join(STARTER, 'lower_third', 'lower_third.py'),
                       'params': {'title': 'Test Person', 'subtitle': 'Preview match'}, 'start': D * 0.15, 'end': D * 0.45,
                       'transform': None, 'keyframes': [], 'fadeIn': 0, 'fadeOut': 0})
        layers.append({'kind': 'graphic', 'id': 'g2', 'trackId': 'graphics',
                       'file': os.path.join(STARTER, 'big_number', 'big_number.py'),
                       'params': {'value': '$1,299', 'label': 'PRICE'}, 'start': D * 0.62, 'end': D * 0.8,
                       'transform': {'x': 0.1, 'y': 0, 'scale': 0.8, 'rotation': 0, 'opacity': 1},
                       'keyframes': [], 'fadeIn': 0, 'fadeOut': 0})
    clips = []
    for i in range(4):
        clips.append({'id': f'seg{i}', 'trackId': 'aroll', 'role': 'voice', 'path': media['a1' if i % 2 == 0 else 'a2'],
                      'start': cuts[i], 'end': cuts[i + 1], 'sourceIn': 1.0 + i * 3.1, 'speed': 1, 'gainDb': 0,
                      'fadeIn': 0, 'fadeOut': 0, 'duck': False, 'loop': False})
    clips.append({'id': 'music', 'trackId': 'music', 'role': 'music', 'path': media['music'], 'start': 0, 'end': D,
                  'sourceIn': 0, 'speed': 1, 'gainDb': -6, 'fadeIn': 1, 'fadeOut': 1, 'duck': True, 'loop': True})
    clips.append({'id': 'sfx1', 'trackId': 'sfx', 'role': 'sfx', 'path': media['sfx'], 'start': D * 0.1, 'end': D * 0.1 + 0.8,
                  'sourceIn': 0, 'speed': 1, 'gainDb': -3, 'fadeIn': 0, 'fadeOut': 0, 'duck': False, 'loop': False})
    return {
        'planVersion': 1, 'engineVersion': '1.0.0', 'projectDir': project_dir,
        'design': {'width': 3840, 'height': 2160, 'fps': 60},
        'output': {'width': width, 'height': height, 'fps': fps},
        'duration': D,
        'layers': layers,
        'captions': {'burn': captions, 'style': {'font': '', 'size': 0.055, 'position': 'bottom', 'color': '#FFFFFF',
                                                 'highlightColor': '#FFD400', 'outlineColor': '#000000', 'maxWords': 4},
                     'lines': caption_lines(0.5, D) if captions else []},
        'brand': {'fonts': [], 'colors': {'primary': '#FF3B30', 'secondary': '#111111', 'accent': '#FFD400'},
                  'logo': {'path': media['still'], 'enabled': True, 'position': 'top-right', 'size': 0.06, 'opacity': 0.8},
                  'intro': '', 'outro': '', 'soundSignature': '',
                  'captionStyle': {'font': '', 'size': 0.055, 'position': 'bottom', 'color': '#FFFFFF',
                                   'highlightColor': '#FFD400', 'outlineColor': '#000000', 'maxWords': 4}},
        'audio': {'sampleRate': 48000, 'clips': clips,
                  'mix': {'musicUnderSpeechDb': -15, 'targetLufs': -14, 'truePeakDb': -1, 'voiceCleanup': True, 'limiter': True},
                  'masterGainDb': None},
    }


def write_json(path, obj) -> str:
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(obj, f)
    return str(path)
