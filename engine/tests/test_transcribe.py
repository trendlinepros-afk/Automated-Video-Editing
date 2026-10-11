"""The guards in engine/analysis/transcribe.py against words the speech model makes up (no model needed)."""
from __future__ import annotations

import importlib.util
import os

import numpy as np

from conftest import ENGINE_DIR

spec = importlib.util.spec_from_file_location('transcribe', os.path.join(ENGINE_DIR, 'analysis', 'transcribe.py'))
transcribe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transcribe)


def seg(start, end, text, words=None, **meta):
    if words is None:
        parts = text.split()
        step = (end - start) / max(1, len(parts))
        words = [{'word': ' ' + w, 'start': start + i * step, 'end': start + (i + 1) * step - 0.02, 'probability': 0.95} for i, w in enumerate(parts)]
    return {'start': start, 'end': end, 'text': text, 'words': words, 'no_speech_prob': 0.05, 'avg_logprob': -0.2, 'compression_ratio': 1.4, **meta}


def audio():
    """10 s at 16 kHz: speech-loud noise for 0-6 s, near-silence after."""
    rng = np.random.default_rng(1)
    a = np.concatenate([rng.normal(0, 0.2, 16000 * 6), rng.normal(0, 0.001, 16000 * 4)]).astype(np.float32)
    return transcribe.level_meter(a, 16000)


def test_drops_filler_over_silence_but_keeps_real_speech():
    r = transcribe.clean([
        seg(0.0, 2.0, 'Excuse the mess.'),
        seg(2.5, 5.5, 'This thing has a gyro in it.'),
        seg(7.0, 8.0, 'Thank you.'),  # over near-silence: invented
    ], audio())
    assert [s['text'] for s in r['segments']] == ['Excuse the mess.', 'This thing has a gyro in it.']
    assert r['dropped'] == [{'start': 7.0, 'end': 8.0, 'text': 'Thank you.', 'reason': 'filler phrase over near-silence'}]


def test_keeps_a_real_thank_you_said_out_loud():
    r = transcribe.clean([seg(0.0, 2.0, 'Okay so here it is'), seg(3.0, 4.0, 'Thank you.')], audio())
    assert [s['text'] for s in r['segments']] == ['Okay so here it is', 'Thank you.']


def test_drops_non_speech_and_loops_and_cuts_repeats():
    r = transcribe.clean([
        seg(0.0, 2.0, 'Christmas cake', no_speech_prob=0.8, avg_logprob=-1.2),
        seg(2.0, 4.0, 'la la la la la la la la', compression_ratio=3.1),
        seg(4.0, 6.0, 'go go go go go now'),
    ], audio())
    assert [d['reason'] for d in r['dropped']] == ['probably not speech', 'looks like a loop', 'repeated 5 times']
    assert r['segments'][0]['text'] == 'go now'


def test_flags_unsure_and_quiet_words_for_claude():
    words = [
        {'word': ' sixty', 'start': 1.0, 'end': 1.4, 'probability': 0.97},
        {'word': ' five', 'start': 1.4, 'end': 1.8, 'probability': 0.3},
        {'word': ' dollars', 'start': 6.5, 'end': 7.0, 'probability': 0.9},
    ]
    r = transcribe.clean([seg(1.0, 7.0, 'sixty five dollars', words=words)], audio())
    assert r['flagged'] == [{'time': 1.4, 'word': 'five', 'reason': 'unsure'}, {'time': 6.5, 'word': 'dollars', 'reason': 'quiet'}]


def test_works_without_the_audio_level():
    r = transcribe.clean([seg(0.0, 1.0, 'Thank you.')], None)
    assert r['segments'][0]['text'] == 'Thank you.'
