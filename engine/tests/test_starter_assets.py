"""The starter asset library seeded into the user's library folder."""
from __future__ import annotations

import importlib.util
import json
import os

import numpy as np
import pytest
from scipy.io import wavfile

from conftest import STARTER

FOLDERS = sorted(d for d in os.listdir(STARTER) if os.path.isdir(os.path.join(STARTER, d)) and not d.startswith(('.', '_')))
REQUIRED = {'formatVersion', 'id', 'name', 'type', 'description', 'whenToUse', 'tags', 'scope', 'file', 'preview', 'inputs',
            'preferred', 'uses', 'createdAt', 'updatedAt'}


def load(path):
    spec = importlib.util.spec_from_file_location(os.path.basename(path)[:-3], path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_library_has_the_starter_set():
    types = {}
    for d in FOLDERS:
        with open(os.path.join(STARTER, d, 'asset.json'), encoding='utf-8') as f:
            types[d] = json.load(f)['type']
    graphics = {d for d, t in types.items() if t == 'graphic'}
    assert {'like_and_subscribe', 'lower_third', 'title_card', 'big_number', 'arrow_callout', 'progress_countdown',
            'emoji_pop'} <= graphics
    assert {f'sfx_{k}' for k in ('whoosh', 'pop', 'ding', 'riser', 'impact', 'typing', 'record_scratch')} <= set(types)
    assert types['music_engine'] == 'music' and types['sfx_synth'] == 'sound' and types['glitch'] == 'effect'


@pytest.mark.parametrize('folder', FOLDERS)
def test_asset_description(folder):
    with open(os.path.join(STARTER, folder, 'asset.json'), encoding='utf-8') as f:
        a = json.load(f)
    assert REQUIRED <= set(a)
    assert a['formatVersion'] == 1 and a['scope'] == 'shared' and a['preferred'] is False and a['uses'] == 0
    assert a['type'] in ('graphic', 'sound', 'music', 'effect')
    assert len({json.load(open(os.path.join(STARTER, d, 'asset.json')))['id'] for d in FOLDERS}) == len(FOLDERS)
    assert os.path.isfile(os.path.join(STARTER, folder, a['file']))
    assert a['description'] and a['whenToUse'] and a['tags']
    from PIL import Image

    with Image.open(os.path.join(STARTER, folder, a['preview'])) as im:
        assert im.size[0] >= 320


@pytest.mark.parametrize('kind', ['whoosh', 'pop', 'ding', 'riser', 'impact', 'typing', 'record_scratch'])
def test_sound_effects(kind):
    sr, x = wavfile.read(os.path.join(STARTER, f'sfx_{kind}', f'{kind}.wav'))
    assert sr == 48000 and x.ndim == 2 and x.shape[1] == 2 and len(x) > sr * 0.1
    synth = load(os.path.join(STARTER, 'sfx_synth', 'sfx_synth.py'))
    y = synth.render(kind, seconds=0.5, pitch=1.3, seed=4)
    assert y.shape == (24000, 2) and 0.8 < np.abs(y).max() <= 1.0
    assert np.array_equal(y, synth.render(kind, seconds=0.5, pitch=1.3, seed=4))


def test_music_engine_one_melody_many_moods(tmp_path):
    music = load(os.path.join(STARTER, 'music_engine', 'music_engine.py'))
    assert music.melody(5) == music.melody(5) and music.melody(5) != music.melody(6)
    for mood in music.MOODS:
        x = music.compose(mood, seconds=6, seed=5)
        assert x.shape == (6 * 48000, 2) and x.dtype == np.float32
        assert 0.5 < np.abs(x).max() <= 1.0 and np.sqrt(np.mean(x ** 2)) > 0.03
    out = tmp_path / 'm.wav'
    music.main(['--mood', 'chill', '--seconds', '3', '--bpm', '90', '--out', str(out)])
    assert wavfile.read(str(out))[1].shape == (3 * 48000, 2)
