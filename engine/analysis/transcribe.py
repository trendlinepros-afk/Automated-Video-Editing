"""Transcribes one source with word timings, guarding against the speech model inventing words.

    python transcribe.py --audio FILE --out OUT.json [--model large-v3] [--language en] [--hint "H-Star, LiPo, gyro"]

The speech model (faster-whisper) is what hears the audio; Claude then proofreads the text. Speech models make things up
in quiet stretches and loop on music ("Thank you.", "Thanks for watching", a phrase repeated over and over), so:
  - only stretches the voice detector hears as speech are transcribed (VAD), and each piece is decoded on its own
    (no carrying earlier text forward, which is what makes loops);
  - pieces the model itself rates as probably-not-speech, or that compress like a loop, are dropped;
  - stock filler phrases are dropped when they sit on near-silence;
  - repeated runs of the same phrase are cut back to one;
  - every word quieter than the speech around it, or that the model was unsure of, is listed in "flagged" so Claude
    checks those first instead of rereading everything.
Writes faster-whisper style JSON ({"segments": [{"words": [{"word","start","end","probability"}]}]}) plus "flagged"
and "dropped", and prints one {"event": "result"} line with counts.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
from typing import Callable

# Phrases speech models produce out of silence or music. Dropped only when the audio under them is near-silent.
FILLER = {
    'thank you', 'thank you very much', 'thanks for watching', 'thanks for watching!', 'thank you for watching',
    'please subscribe', 'subscribe', 'like and subscribe', 'bye', 'bye bye', 'you', 'so', 'okay', 'subtitles by',
    'subtitles by the amara.org community', 'transcribed by', 'music', 'applause', 'see you next time',
}
LOW_PROBABILITY = 0.5
QUIET_DB = 9.0  # this far under the typical speech level counts as quiet


def emit(event: str, **data) -> None:
    sys.stdout.write(json.dumps({'event': event, **data}) + '\n')
    sys.stdout.flush()


def norm(text: str) -> str:
    return re.sub(r'[^a-z0-9\' ]+', '', text.lower()).strip()


def level_meter(samples, rate: int) -> Callable[[float, float], float]:
    """RMS level in dBFS of any stretch of the audio."""
    import numpy as np

    sq = np.concatenate([[0.0], np.cumsum(samples.astype(np.float64) ** 2)])

    def level(a: float, b: float) -> float:
        i, j = max(0, int(a * rate)), min(len(samples), int(b * rate))
        if j <= i:
            return -120.0
        rms = math.sqrt(max(0.0, (sq[j] - sq[i]) / (j - i)))
        return 20 * math.log10(rms) if rms > 1e-9 else -120.0

    return level


def collapse_loops(words: list[dict], dropped: list[dict]) -> list[dict]:
    """Cuts a phrase of 1-6 words repeated 3+ times in a row back to one copy."""
    out = list(words)
    for n in range(1, 7):
        i = 0
        while i + n * 3 <= len(out):
            phrase = [norm(w['word']) for w in out[i:i + n]]
            reps = 1
            while i + n * (reps + 1) <= len(out) and [norm(w['word']) for w in out[i + n * reps:i + n * (reps + 1)]] == phrase:
                reps += 1
            if reps >= 3 and any(phrase):
                cut = out[i + n:i + n * reps]
                dropped.append({'start': cut[0]['start'], 'end': cut[-1]['end'], 'text': ' '.join(w['word'] for w in cut).strip(),
                                'reason': f'repeated {reps} times'})
                del out[i + n:i + n * reps]
            i += 1
    return out


def clean(segments: list[dict], level: Callable[[float, float], float] | None) -> dict:
    """Applies the guards to decoded segments (dicts with text, words, no_speech_prob, avg_logprob, compression_ratio)."""
    dropped: list[dict] = []
    kept: list[dict] = []
    for s in segments:
        text = s.get('text', '').strip()
        if s.get('no_speech_prob', 0) > 0.6 and s.get('avg_logprob', 0) < -0.8:
            dropped.append({'start': s['start'], 'end': s['end'], 'text': text, 'reason': 'probably not speech'})
            continue
        if s.get('compression_ratio', 0) > 2.4:
            dropped.append({'start': s['start'], 'end': s['end'], 'text': text, 'reason': 'looks like a loop'})
            continue
        kept.append(s)

    # The typical speech level: the median of the kept words.
    speech_db = None
    if level:
        levels = sorted(level(w['start'], w['end']) for s in kept for w in s.get('words', []) if w['end'] > w['start'])
        speech_db = levels[len(levels) // 2] if levels else None

    def quiet(a: float, b: float) -> bool:
        return bool(level and speech_db is not None and level(a, b) < speech_db - QUIET_DB)

    out_segments: list[dict] = []
    flagged: list[dict] = []
    for s in kept:
        text = s.get('text', '').strip()
        if norm(text) in FILLER and quiet(s['start'], s['end']):
            dropped.append({'start': s['start'], 'end': s['end'], 'text': text, 'reason': 'filler phrase over near-silence'})
            continue
        words = collapse_loops(s.get('words', []), dropped)
        for w in words:
            reasons = []
            if w.get('probability', 1) < LOW_PROBABILITY:
                reasons.append('unsure')
            if quiet(w['start'], w['end']):
                reasons.append('quiet')
            if reasons:
                flagged.append({'time': round(w['start'], 2), 'word': w['word'].strip(), 'reason': ' and '.join(reasons)})
        if words:
            out_segments.append({'start': s['start'], 'end': s['end'], 'text': ''.join(w['word'] for w in words).strip(), 'words': words})
    return {'segments': out_segments, 'flagged': flagged, 'dropped': dropped}


def transcribe(path: str, model_name: str, language: str | None, hint: str | None, device: str) -> tuple[list[dict], dict]:
    from faster_whisper import WhisperModel

    def load(dev: str):
        return WhisperModel(model_name, device=dev, compute_type='float16' if dev == 'cuda' else 'int8')

    if device == 'auto':
        try:
            model, used = load('cuda'), 'cuda'
        except Exception:
            model, used = load('cpu'), 'cpu'
    else:
        model, used = load(device), device
    segs, info = model.transcribe(
        path,
        language=language,
        beam_size=5,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters={'min_silence_duration_ms': 500, 'speech_pad_ms': 200},
        condition_on_previous_text=False,
        no_speech_threshold=0.6,
        compression_ratio_threshold=2.4,
        log_prob_threshold=-1.0,
        hallucination_silence_threshold=2.0,
        initial_prompt=hint or None,
    )
    out = []
    for s in segs:
        emit('progress', seconds=round(s.end, 1), duration=round(info.duration, 1))
        out.append({
            'start': s.start, 'end': s.end, 'text': s.text,
            'no_speech_prob': s.no_speech_prob, 'avg_logprob': s.avg_logprob, 'compression_ratio': s.compression_ratio,
            'words': [{'word': w.word, 'start': w.start, 'end': w.end, 'probability': w.probability} for w in (s.words or [])],
        })
    return out, {'language': info.language, 'duration': info.duration, 'device': used, 'model': model_name}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--audio', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--model', default='large-v3')
    ap.add_argument('--language', default=None)
    ap.add_argument('--hint', default=None, help='names and words the speech model should expect (products, brands)')
    ap.add_argument('--device', default='auto', choices=['auto', 'cuda', 'cpu'])
    a = ap.parse_args()

    segments, meta = transcribe(a.audio, a.model, a.language, a.hint, a.device)
    try:
        from faster_whisper.audio import decode_audio

        rate = 16000
        level = level_meter(decode_audio(a.audio, sampling_rate=rate), rate)
    except Exception as err:  # the guards that need the audio level are skipped, the rest still apply
        emit('warning', message=f'audio level unavailable: {err}')
        level = None
    result = {**meta, **clean(segments, level)}
    with open(a.out, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False)
    emit('result', data={'out': a.out, 'words': sum(len(s['words']) for s in result['segments']),
                         'flagged': len(result['flagged']), 'dropped': len(result['dropped']), **meta})


if __name__ == '__main__':
    main()
