"""Engine tests: CLI contract, rendering, chunks, determinism, captions, graphics, audio."""
from __future__ import annotations

import json
import math
import os
import subprocess
import time

import numpy as np
import pytest
from PIL import Image

from conftest import ENGINE_DIR, FFMPEG, STARTER, ff, make_plan, run_engine, write_json


def decode_frames(path: str, w: int, h: int) -> np.ndarray:
    raw = subprocess.run([FFMPEG, '-loglevel', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', 'rgb24',
                          '-s', f'{w}x{h}', '-sws_flags', 'area', 'pipe:1'], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, h, w, 3)


def psnr(a: np.ndarray, b: np.ndarray) -> float:
    mse = float(np.mean((a.astype(np.float64) - b.astype(np.float64)) ** 2))
    return 10 * math.log10(255 ** 2 / max(mse, 1e-9))


def ffprobe_json(*args: str) -> dict:
    out = subprocess.run(['ffprobe', '-v', 'error', '-print_format', 'json', *args], capture_output=True, check=True).stdout
    return json.loads(out)


# ---------------------------------------------------------------------------------------------

def test_check_reports_environment():
    _, data = run_engine('check')
    assert data['engineVersion'] == '1.0.0'
    for k in ('python', 'numpy', 'torch', 'cuda', 'gpu', 'nvenc', 'ffmpeg'):
        assert k in data
    assert isinstance(data['cuda'], bool) and isinstance(data['nvenc'], bool)
    assert data['ffmpeg']


def test_version_matches_app():
    from ave_engine import VERSION

    with open(os.path.join(os.path.dirname(ENGINE_DIR), 'src', 'shared', 'appInfo.ts'), encoding='utf-8') as f:
        assert f"ENGINE_VERSION = '{VERSION}'" in f.read()


def test_probe(media):
    _, v = run_engine('probe', '--path', media['a1'])
    assert v['kind'] == 'video' and v['width'] == 1920 and v['height'] == 1080 and v['hasAudio'] is True
    assert abs(v['fps'] - 30) < 1e-6 and abs(v['duration'] - 34) < 0.2
    _, a = run_engine('probe', '--path', media['music'])
    assert a['kind'] == 'audio' and a['hasAudio'] and abs(a['duration'] - 34) < 0.1
    _, i = run_engine('probe', '--path', media['still'])
    assert i['kind'] == 'image' and i['width'] == 800
    events, _ = run_engine('probe', '--path', os.path.join(media['dir'], 'missing.mp4'), check=False)
    assert events[-1]['event'] == 'error'


def test_proxy_is_small_and_seekable(media):
    _, v = run_engine('probe', '--path', media['a1_proxy'])
    assert v['height'] == 540 and v['width'] == 960 and abs(v['fps'] - 30) < 1e-6
    info = ffprobe_json('-select_streams', 'v:0', '-show_entries', 'frame=key_frame', '-read_intervals', '%+3', media['a1_proxy'])
    keys = [i for i, f in enumerate(info['frames']) if f['key_frame'] == 1]
    assert len(keys) >= 5  # a keyframe every half second


def test_stdout_is_json_only(tmp_path):
    g = tmp_path / 'noisy.py'
    g.write_text("print('hello from a graphic')\n"
                 "def render(t, ctx):\n"
                 "    print('drawing', t)\n"
                 "    return ctx.canvas()\n")
    events, data = run_engine('graphic-preview', '--file', str(g), '--times', '0,1', '--duration', '2',
                              '--width', '320', '--height', '180', '--out-dir', str(tmp_path / 'out'))
    assert len(data['files']) == 2
    assert all(isinstance(e, dict) and 'event' in e for e in events)


def test_bad_arguments_report_an_error():
    events, _ = run_engine('frame', '--plan', 'nope.json', check=False)
    assert events and events[-1]['event'] == 'error'


# ---------------------------------------------------------------------------------------------
# rendering

def test_render_chunks_concat(media, tmp_path):
    plan = write_json(tmp_path / 'plan.json', make_plan(media, str(tmp_path / 'proj'), 320, 180, 30, 6.0, proxies=True))
    jobs = [{'index': i, 'start': i * 2.0, 'end': (i + 1) * 2.0, 'out': str(tmp_path / f'chunk{i}.mp4')} for i in range(3)]
    jobs_file = write_json(tmp_path / 'jobs.json', list(reversed(jobs)))
    events, data = run_engine('render-chunks', '--plan', plan, '--jobs', jobs_file)
    done = [e for e in events if e['event'] == 'chunk_done']
    assert sorted(e['index'] for e in done) == [0, 1, 2]
    assert any(e['event'] == 'progress' and 'fps' in e for e in events)
    for j in jobs:
        info = ffprobe_json('-select_streams', 'v:0', '-show_entries', 'stream=codec_name,pix_fmt,width,height,nb_frames',
                            '-show_entries', 'frame=key_frame', '-read_intervals', '%+#1', j['out'])
        s = info['streams'][0]
        assert (s['codec_name'], s['pix_fmt'], s['width'], s['height']) == ('h264', 'yuv420p', 320, 180)
        assert int(s['nb_frames']) == 60
        assert info['frames'][0]['key_frame'] == 1
        assert not ffprobe_json('-show_streams', '-select_streams', 'a', j['out']).get('streams')
    lst = tmp_path / 'list.txt'
    lst.write_text(''.join(f"file '{j['out']}'\n" for j in jobs))
    joined = str(tmp_path / 'joined.mp4')
    ff('-f', 'concat', '-safe', '0', '-i', str(lst), '-c', 'copy', joined)
    frames = decode_frames(joined, 320, 180)
    assert len(frames) == 180
    # The joined file plays the same pictures as the chunks.
    first = decode_frames(jobs[1]['out'], 320, 180)
    assert psnr(frames[60], first[0]) > 45


def effect_heavy_plan(media, project_dir, w, h):
    plan = make_plan(media, project_dir, w, h, 30, 8.0, proxies=True)
    fx = [('vhs', 0.5, 3.5, {}), ('shake', 1.0, 4.0, {'amount': 0.02}), ('snow', 0.0, 8.0, {}),
          ('light_leak', 2.0, 6.0, {}), ('grade', 0, 8, {'saturation': 0.8}), ('custom', 1.5, 5.0, {'amount': 1.5})]
    for i, (kind, s, e, p) in enumerate(fx):
        layer = {'kind': 'effect', 'id': f'det{i}', 'trackId': 'effects', 'effect': kind, 'params': p, 'start': s, 'end': e,
                 'fadeIn': 0, 'fadeOut': 0}
        if kind == 'custom':
            layer['file'] = os.path.join(STARTER, 'glitch', 'glitch.py')
        plan['layers'].append(layer)
    return plan


def test_chunks_identical_whatever_the_boundaries(media, tmp_path):
    """Frames must not depend on where a chunk starts: decoders seek to the same frame grid and every
    random effect is seeded from absolute time."""
    from ave_engine.compositor import Renderer

    plan = effect_heavy_plan(media, str(tmp_path / 'proj'), 256, 144)
    fps = 30
    a = Renderer(plan)
    seq = {k: a.frame_uint8(k / fps) for k in range(0, 150)}  # one long chunk from 0 s
    a.close()
    for start_frame in (37, 61, 100):  # chunks that start part way through
        b = Renderer(plan)
        for k in range(start_frame, min(150, start_frame + 25)):
            assert np.array_equal(b.frame_uint8(k / fps), seq[k]), f'frame {k} differs when the chunk starts at {start_frame}'
        b.close()


def test_chunk_files_match_across_boundaries(media, tmp_path):
    plan = write_json(tmp_path / 'plan.json', effect_heavy_plan(media, str(tmp_path / 'proj'), 256, 144))
    jobs_a = [{'index': 0, 'start': 0.0, 'end': 4.0, 'out': str(tmp_path / 'a0.mp4')}]
    jobs_b = [{'index': 0, 'start': 0.0, 'end': 1.5, 'out': str(tmp_path / 'b0.mp4')},
              {'index': 1, 'start': 1.5, 'end': 4.0, 'out': str(tmp_path / 'b1.mp4')}]
    run_engine('render-chunks', '--plan', plan, '--jobs', write_json(tmp_path / 'ja.json', jobs_a))
    run_engine('render-chunks', '--plan', plan, '--jobs', write_json(tmp_path / 'jb.json', jobs_b))
    a = decode_frames(jobs_a[0]['out'], 256, 144)
    b = np.concatenate([decode_frames(j['out'], 256, 144) for j in jobs_b])
    assert a.shape == b.shape
    for k in range(0, len(a), 7):
        # Only compression differs (exact equality before encoding is checked above); grain, glitch
        # blocks and snow at this tiny size are the hardest case for the encoder.
        assert psnr(a[k], b[k]) > 28, k


def test_frame_and_frames(media, tmp_path):
    plan = write_json(tmp_path / 'plan.json', make_plan(media, str(tmp_path / 'proj'), 480, 270))
    _, d = run_engine('frame', '--plan', plan, '--time', '2.0', '--out', str(tmp_path / 'f.png'))
    full = np.asarray(Image.open(d['out']))
    assert full.shape == (270, 480, 3)
    _, d2 = run_engine('frame', '--plan', plan, '--time', '2.0', '--out', str(tmp_path / 'g.png'), '--footage-only')
    foot = np.asarray(Image.open(d2['out']))
    assert np.abs(full.astype(int) - foot.astype(int)).mean() > 1  # graphics, captions, grade, logo are off
    _, d3 = run_engine('frames', '--plan', plan, '--times', '5,1,3', '--out-dir', str(tmp_path / 'many'))
    assert len(d3['files']) == 3 and all(os.path.exists(f) for f in d3['files'])
    assert '_005000' not in d3['files'][1] and '00001000' in d3['files'][1]


def test_caption_burn(media, tmp_path):
    from ave_engine.compositor import Renderer

    plan = make_plan(media, str(tmp_path / 'proj'), 640, 360, effects=False, graphic=False)
    plan['brand']['logo']['enabled'] = False
    line = plan['captions']['lines'][0]
    word = line['words'][1]
    t = (word['start'] + word['end']) / 2
    with_caps = Renderer(plan).frame_uint8(t)
    plan['captions']['burn'] = False
    without = Renderer(plan).frame_uint8(t)
    diff = np.abs(with_caps.astype(int) - without.astype(int)).sum(axis=2)
    rows = np.flatnonzero(diff.max(axis=1) > 60)
    assert len(rows) > 0
    assert rows.min() > 360 * 0.7  # bottom position
    # The spoken word is drawn in the highlight color (#FFD400).
    region = with_caps[rows.min():rows.max() + 1]
    yellow = (region[..., 0] > 230) & (region[..., 1] > 190) & (region[..., 1] < 230) & (region[..., 2] < 60)
    assert yellow.sum() > 20
    # Middle position moves it up.
    plan['captions']['burn'] = True
    plan['captions']['style']['position'] = 'middle'
    mid = Renderer(plan).frame_uint8(t)
    d2 = np.abs(mid.astype(int) - without.astype(int)).sum(axis=2)
    r2 = np.flatnonzero(d2.max(axis=1) > 60)
    assert 120 < r2.mean() < 240


def test_effects_change_the_picture(media, tmp_path):
    from ave_engine.compositor import Renderer

    base = make_plan(media, str(tmp_path / 'proj'), 320, 180, effects=False, graphic=False, captions=False)
    base['brand']['logo']['enabled'] = False
    ref = Renderer(base).frame_uint8(1.0)
    for kind, params in [('grade', {'saturation': 0, 'gain': 0.8}), ('snow', {}), ('light_leak', {}), ('vhs', {}),
                         ('shake', {}), ('flash', {}), ('zoom', {'amount': 0.3}), ('vignette', {'amount': 0.6}),
                         ('speed', {'rate': 2}), ('replay', {'lookback': 0.9}), ('freeze', {})]:
        plan = json.loads(json.dumps(base))
        start = 0.5 if kind in ('speed', 'replay', 'freeze') else 0.9
        plan['layers'].append({'kind': 'effect', 'id': 'e', 'trackId': 'effects', 'effect': kind, 'params': params,
                               'start': start, 'end': 1.6, 'fadeIn': 0, 'fadeOut': 0})
        out = Renderer(plan).frame_uint8(1.0)
        assert np.abs(out.astype(int) - ref.astype(int)).mean() > 0.5, kind


def test_time_effects_pick_the_right_moment(media, tmp_path):
    from ave_engine.compositor import Renderer

    base = make_plan(media, str(tmp_path / 'proj'), 320, 180, effects=False, graphic=False, captions=False)
    base['brand']['logo']['enabled'] = False
    r = Renderer(base)
    at = {t: r.frame_uint8(t) for t in (0.5, 0.8, 1.1)}
    plan = json.loads(json.dumps(base))
    plan['layers'].append({'kind': 'effect', 'id': 'f', 'trackId': 'effects', 'effect': 'freeze', 'params': {},
                           'start': 0.5, 'end': 2.0, 'fadeIn': 0, 'fadeOut': 0})
    assert np.array_equal(Renderer(plan).frame_uint8(1.7), at[0.5])
    plan = json.loads(json.dumps(base))
    plan['layers'].append({'kind': 'effect', 'id': 's', 'trackId': 'effects', 'effect': 'speed', 'params': {'rate': 2},
                           'start': 0.5, 'end': 2.0, 'fadeIn': 0, 'fadeOut': 0})
    assert np.array_equal(Renderer(plan).frame_uint8(0.8), at[1.1])  # 0.5 + 0.3 * 2
    plan = json.loads(json.dumps(base))
    plan['layers'].append({'kind': 'effect', 'id': 'r', 'trackId': 'effects', 'effect': 'replay',
                           'params': {'lookback': 1.0, 'speed': 0.5}, 'start': 1.5, 'end': 2.5, 'fadeIn': 0, 'fadeOut': 0})
    assert np.array_equal(Renderer(plan).frame_uint8(2.1), at[0.8])  # 1.5 - 1 + 0.6 * 0.5


def test_layout_is_resolution_independent(media, tmp_path):
    """A transformed B-roll and graphic land in the same place at any output size, including sizes
    larger than the footage (1080p footage in a 1440p render is enlarged)."""
    from ave_engine.compositor import Renderer

    plan = make_plan(media, str(tmp_path / 'proj'), 640, 360, effects=False, captions=False)
    t = 0.65 * 12.0  # picture-in-picture B-roll with keyframes + transformed price badge
    small = Renderer(plan).frame_uint8(t)
    big = Renderer(plan, 2560, 1440).frame_uint8(t)
    down = np.asarray(Image.fromarray(big).resize((640, 360), Image.BOX))
    assert psnr(small, down) > 30


# ---------------------------------------------------------------------------------------------
# graphics

GRAPHICS = ['like_and_subscribe', 'lower_third', 'title_card', 'big_number', 'arrow_callout', 'progress_countdown', 'emoji_pop']


@pytest.mark.parametrize('name', GRAPHICS)
def test_starter_graphics_render(name):
    from ave_engine.graphics import load_module, merged_params, render_graphic

    path = os.path.join(STARTER, name, f'{name}.py')
    mod = load_module(path)
    assert mod.META['description'] and isinstance(mod.META['inputs'], dict)
    assert set(mod.META['inputs']) <= set(merged_params(mod, {}))
    drawn = 0
    for t in (0.0, 0.3, 1.0, 2.0, 3.9):
        a = render_graphic(path, t, 480, 270, 4.0, {}, 30, None)
        assert a.shape == (270, 480, 4) and a.dtype == np.uint8
        drawn += int(a[..., 3].any())
    assert drawn >= 3


def test_graphic_reloads_when_the_file_changes(tmp_path):
    from ave_engine.graphics import render_graphic

    g = tmp_path / 'g.py'
    g.write_text("META = {'inputs': {'v': {'type': 'number', 'default': 50}}}\n"
                 "import numpy as np\n"
                 "def render(t, ctx):\n"
                 "    a = np.zeros((ctx.height, ctx.width, 4), np.uint8); a[..., 3] = ctx.params['v']; return a\n")
    assert render_graphic(str(g), 0, 8, 8, 1, {}, 30, None)[0, 0, 3] == 50
    assert render_graphic(str(g), 0, 8, 8, 1, {'v': 70}, 30, None)[0, 0, 3] == 70
    time.sleep(0.01)
    g.write_text(g.read_text().replace('ctx.params[\'v\']', '200'))
    os.utime(g, None)
    assert render_graphic(str(g), 0, 8, 8, 1, {}, 30, None)[0, 0, 3] == 200
    assert not (tmp_path / '__pycache__').exists()


def test_graphic_context_helpers(tmp_path):
    from ave_engine.graphics import GraphicContext, merge_brand

    brand = merge_brand({'colors': {'primary': '#00FF00'}})
    ctx = GraphicContext(640, 360, 2, {}, 30, brand)
    assert ctx.color('primary') == (0, 255, 0) and ctx.color('#112233', 128) == (17, 34, 51, 128)
    assert ctx.font(30).size == 30 and ctx.font(20, 'NoSuchFont').size == 20
    assert ctx.ease_out_cubic(1) == 1 and abs(ctx.ease_out_back(0)) < 1e-9
    assert ctx.fade(0.0, 0.2, 0.2) == 0 and ctx.fade(1.0, 0.2, 0.2) == 1


def test_graphic_preview_command(tmp_path):
    brand = write_json(tmp_path / 'brand.json', {'colors': {'primary': '#0000FF', 'secondary': '#000000', 'accent': '#FFFFFF'}})
    _, d = run_engine('graphic-preview', '--file', os.path.join(STARTER, 'big_number', 'big_number.py'),
                      '--params', json.dumps({'value': '42%', 'label': 'UP'}), '--duration', '3', '--times', '0.2,1.5',
                      '--width', '640', '--height', '360', '--brand', brand, '--out-dir', str(tmp_path / 'p'))
    assert len(d['files']) == 2
    img = np.asarray(Image.open(d['files'][1]).convert('RGB'))
    blue = (img[..., 2] > 200) & (img[..., 0] < 40) & (img[..., 1] < 40)
    assert blue.sum() > 500  # brand color used


# ---------------------------------------------------------------------------------------------
# audio

def test_loudness_of_known_signal(tmp_path):
    p = str(tmp_path / 'sine.wav')
    ff('-f', 'lavfi', '-i', "aevalsrc='0.1*sin(2*PI*997*t)|0.1*sin(2*PI*997*t)':s=48000:d=10", '-c:a', 'pcm_f32le', p)
    _, d = run_engine('loudness', '--path', p)
    assert abs(d['lufs'] - (-20.0)) < 0.15  # BS.1770: a stereo 997 Hz sine at -20 dBFS reads -20 LUFS
    assert abs(d['truePeakDb'] - (-20.0)) < 0.2


@pytest.mark.parametrize('target', [-14.0, -16.0])
def test_mix_hits_the_loudness_target(media, tmp_path, target):
    plan = make_plan(media, str(tmp_path / 'proj'), 320, 180)
    plan['audio']['mix']['targetLufs'] = target
    pf = write_json(tmp_path / 'plan.json', plan)
    out = str(tmp_path / 'mix.wav')
    _, d = run_engine('mix', '--plan', pf, '--out', out)
    assert abs(d['lufs'] - target) <= 0.5
    _, m = run_engine('loudness', '--path', out)
    assert abs(m['lufs'] - target) <= 0.5
    assert m['truePeakDb'] <= plan['audio']['mix']['truePeakDb'] + 0.1
    # Cached: a second call is quick and gives the same numbers.
    t0 = time.time()
    _, d2 = run_engine('mix', '--plan', pf, '--out', str(tmp_path / 'mix2.wav'), '--start', '2', '--end', '4')
    assert d2['masterGainDb'] == pytest.approx(d['masterGainDb'])
    assert time.time() - t0 < 10
    assert os.listdir(os.path.join(str(tmp_path / 'proj'), 'cache', 'audio'))


def test_slice_has_same_level_and_clean_ends(media, tmp_path):
    from scipy.io import wavfile

    pf = write_json(tmp_path / 'plan.json', make_plan(media, str(tmp_path / 'proj'), 320, 180))
    run_engine('mix', '--plan', pf, '--out', str(tmp_path / 'full.wav'))
    run_engine('mix', '--plan', pf, '--out', str(tmp_path / 'part.wav'), '--start', '3', '--end', '7', '--fade', '0.05')
    sr, full = wavfile.read(str(tmp_path / 'full.wav'))
    _, part = wavfile.read(str(tmp_path / 'part.wav'))
    assert sr == 48000 and part.shape == (4 * sr, 2)
    mid = slice(int(0.1 * sr), int(3.9 * sr))
    assert np.allclose(part[mid], full[3 * sr:7 * sr][mid], atol=1e-6)  # same master gain
    assert np.abs(part[:10]).max() < 1e-3 and np.abs(part[-10:]).max() < 1e-3  # faded ends


def test_ducking_lowers_music_under_speech(media, tmp_path):
    from scipy.io import wavfile

    def music_stem(duck: bool) -> np.ndarray:
        plan = make_plan(media, str(tmp_path / f'proj{duck}'), 320, 180)
        for c in plan['audio']['clips']:
            if c['role'] == 'music':
                c['duck'] = duck
        plan['audio']['masterGainDb'] = 0.0  # same master gain for both, so stems compare directly
        d = tmp_path / f'stems{duck}'
        run_engine('mix', '--plan', write_json(tmp_path / f'p{duck}.json', plan), '--out', str(d / 'mix.wav'), '--stems', str(d))
        return wavfile.read(str(d / 'music.wav'))[1], wavfile.read(str(d / 'voice.wav'))[1]

    ducked, voice = music_stem(True)
    plain, _ = music_stem(False)
    w = 4800  # 100 ms
    n = len(voice) // w

    def rms(x):
        return np.sqrt((x[: n * w].reshape(n, w, -1) ** 2).mean(axis=(1, 2)) + 1e-12)

    speech = rms(voice) > rms(voice).max() * 0.2
    speech[:20] = False  # skip the music fade-in
    drop = 20 * np.log10(rms(ducked)[speech] / rms(plain)[speech])
    assert np.median(drop) < -12  # about mix.musicUnderSpeechDb (-15) under speech
    # In silence before the first word the music is untouched.
    assert abs(20 * np.log10(rms(ducked)[12] / rms(plain)[12])) < 1.5 or not speech[12]


def test_dialogue_only_has_no_music(media, tmp_path):
    from scipy.io import wavfile

    plan = make_plan(media, str(tmp_path / 'proj'), 320, 180)
    pf = write_json(tmp_path / 'plan.json', plan)
    run_engine('mix', '--plan', pf, '--out', str(tmp_path / 'd.wav'), '--dialogue-only')
    sr, x = wavfile.read(str(tmp_path / 'd.wav'))
    # The test speech pauses for 0.8 s every 2.5 s: in a pause there must be (nearly) silence.
    # Segment 0 plays the source from 1.0 s, so its pause (1.7-2.5 s of source) is at 0.7-1.5 s.
    pause = x[int(0.85 * sr):int(1.35 * sr)]
    assert np.sqrt(np.mean(pause ** 2)) < 1e-3


def test_energy_peaks_snippet(media, tmp_path):
    _, e = run_engine('energy', '--path', media['a1'], '--start', '1.0', '--end', '2.5', '--step-ms', '5')
    assert e['stepMs'] == 5 and e['start'] == 1.0 and len(e['db']) == 300
    db = np.array(e['db'])
    # speech 0-1.7 s of each 2.5 s cycle: loud then silent
    assert db[:100].mean() > -25 and db[-100:].max() < -60
    _, p = run_engine('peaks', '--path', media['music'], '--per-second', '100')
    assert abs(len(p['peaks']) - 3400) <= 1 and 0.4 < max(p['peaks']) <= 1.0
    out = str(tmp_path / 's.wav')
    _, s = run_engine('snippet', '--path', media['a1'], '--start', '3', '--end', '4.5', '--out', out)
    _, pr = run_engine('probe', '--path', s['out'])
    assert pr['kind'] == 'audio' and abs(pr['duration'] - 1.5) < 0.01


# ---------------------------------------------------------------------------------------------
# export

def test_export_section_and_no_half_files(media, tmp_path):
    pf = write_json(tmp_path / 'plan.json', make_plan(media, str(tmp_path / 'proj'), 320, 180))
    out = str(tmp_path / 'exports' / 'section.mp4')
    events, d = run_engine('export', '--plan', pf, '--out', out, '--start', '2', '--end', '5', '--quality', 'draft', '--encoder', 'cpu')
    assert d['encoder'] == 'libx264' and abs(d['duration'] - 3.0) < 1e-6 and 'ffmpeg' in d['ffmpegCommand']
    assert any(e['event'] == 'progress' and e.get('fps') for e in events)
    info = ffprobe_json('-show_streams', out)
    kinds = {s['codec_type']: s for s in info['streams']}
    assert kinds['video']['codec_name'] == 'h264' and kinds['audio']['codec_name'] == 'aac'
    assert int(kinds['audio']['sample_rate']) == 48000 and int(kinds['audio']['bit_rate']) > 200000
    assert abs(float(kinds['video']['duration']) - 3.0) < 0.05
    assert sorted(os.listdir(tmp_path / 'exports')) == ['section.mp4']

    # A cancelled export never leaves a file at the output name.
    env = dict(os.environ, PYTHONPATH=ENGINE_DIR, AVE_BACKEND='numpy')
    out2 = str(tmp_path / 'exports' / 'cancelled.mp4')
    p = subprocess.Popen([os.sys.executable, '-m', 'ave_engine', 'export', '--plan', pf, '--out', out2, '--encoder', 'cpu'],
                         stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, cwd=ENGINE_DIR, text=True)
    for line in p.stdout:
        if json.loads(line).get('event') == 'progress' and json.loads(line).get('fps'):
            break
    p.terminate()
    p.wait(timeout=30)
    assert not os.path.exists(out2)
    assert sorted(os.listdir(tmp_path / 'exports')) == ['section.mp4']  # temp files cleaned up on stop


def test_export_hevc_cpu(media, tmp_path):
    pf = write_json(tmp_path / 'plan.json', make_plan(media, str(tmp_path / 'proj'), 320, 180, duration=4.0))
    out = str(tmp_path / 'h.mp4')
    _, d = run_engine('export', '--plan', pf, '--out', out, '--codec', 'hevc', '--encoder', 'cpu', '--quality', 'draft',
                      '--end', '1')
    assert d['encoder'] == 'libx265'
    s = ffprobe_json('-show_streams', '-select_streams', 'v', out)['streams'][0]
    assert s['codec_name'] == 'hevc' and s['codec_tag_string'] == 'hvc1'


# ---------------------------------------------------------------------------------------------
# THE preview / export match test

MATCH_SECONDS = float(os.environ.get('AVE_MATCH_SECONDS', '12'))


def test_preview_matches_export(media, tmp_path):
    """Preview chunks at 640x360 (from proxies) and a 1280x720 export (from the originals) of a
    timeline with cuts, B-roll, graphics, effects and captions must look the same once the export is
    scaled down, and play at the same audio level. Set AVE_MATCH_SECONDS=30 for the full-length run."""
    D = MATCH_SECONDS
    proj = str(tmp_path / 'proj')
    prev_plan = write_json(tmp_path / 'prev.json', make_plan(media, proj, 640, 360, 30, D, proxies=True))
    exp_plan = write_json(tmp_path / 'exp.json', make_plan(media, proj, 1280, 720, 30, D, proxies=False))
    chunk = 3.0
    n = int(math.ceil(D / chunk))
    jobs = [{'index': i, 'start': i * chunk, 'end': min(D, (i + 1) * chunk), 'out': str(tmp_path / f'c{i:02d}.mp4')} for i in range(n)]
    _, r = run_engine('render-chunks', '--plan', prev_plan, '--jobs', write_json(tmp_path / 'jobs.json', jobs))
    print(f"preview render: {r['fps']} fps at 640x360 on {r['backend']}")
    lst = tmp_path / 'list.txt'
    lst.write_text(''.join(f"file '{j['out']}'\n" for j in jobs))
    preview = str(tmp_path / 'preview.mp4')
    ff('-f', 'concat', '-safe', '0', '-i', str(lst), '-c', 'copy', preview)
    export = str(tmp_path / 'export.mp4')
    _, e = run_engine('export', '--plan', exp_plan, '--out', export, '--quality', 'good', '--encoder', 'cpu')
    print(f"export render: {e['fps']} fps at 1280x720")

    a = decode_frames(preview, 640, 360)
    b = decode_frames(export, 640, 360)  # area downscale of the 720p export
    assert len(a) == len(b) == int(round(D * 30))
    scores = []
    for k in range(0, len(a), 10):  # every third of a second: cuts, B-roll, graphics, every effect, captions
        p = psnr(a[k], b[k])
        mad = np.abs(a[k].astype(np.float32) - b[k].astype(np.float32)).mean()
        scores.append(p)
        # Both files are lossy (the preview at crf 23); the threshold allows for that.
        assert p > 29 and mad < 4.0, f'frame {k} ({k / 30:.2f}s): PSNR {p:.1f} dB, mean abs diff {mad:.2f}'
    print(f'files: worst PSNR {min(scores):.1f} dB, mean {np.mean(scores):.1f} dB')
    assert np.mean(scores) > 31

    # The rendered pictures themselves, before encoding, match more tightly.
    from ave_engine.compositor import Renderer

    rp = Renderer(json.load(open(prev_plan)))
    re_ = Renderer(json.load(open(exp_plan)))
    worst = 99.0
    for k in range(5, len(a), 45):
        small = rp.frame_uint8(k / 30)
        big = np.asarray(Image.fromarray(re_.frame_uint8(k / 30)).resize((640, 360), Image.BOX))
        worst = min(worst, psnr(small, big))
    rp.close()
    re_.close()
    print(f'rendered frames: worst PSNR {worst:.1f} dB')
    assert worst > 30

    # Audio: the preview's mix and the export's soundtrack play at the same level.
    mix = str(tmp_path / 'preview_mix.wav')
    _, m = run_engine('mix', '--plan', prev_plan, '--out', mix)
    _, la = run_engine('loudness', '--path', mix)
    _, lb = run_engine('loudness', '--path', export)
    assert abs(la['lufs'] - lb['lufs']) < 0.3
    assert abs(m['lufs'] - e['lufs']) < 1e-6


def test_torch_backend_draws_the_same_picture(media, tmp_path):
    """When torch is installed, its compositing path must match the numpy path."""
    pytest.importorskip('torch')
    from ave_engine.backend import NumpyBackend, TorchBackend, torch_status
    from ave_engine.compositor import Renderer

    device = 'cuda' if torch_status()['cuda'] else 'cpu'
    plan = effect_heavy_plan(media, str(tmp_path / 'proj'), 480, 270)
    a = Renderer(plan, backend=NumpyBackend())
    b = Renderer(plan, backend=TorchBackend(device))
    for t in (0.6, 1.2, 2.1, 3.3, 4.8, 6.5, 7.6):
        assert psnr(a.frame_uint8(t), b.frame_uint8(t)) > 40, t
