"""One contact sheet of shot pictures from the footage index, numbered, so Claude can compare many shots in one look.

    python shot_sheet.py --items ITEMS.json --out SHEET.jpg [--cols 4]

ITEMS.json: [{"path": picture, "label": short caption}, ...]. Each picture gets a big number (1, 2, 3...) in its corner
and its caption under it. Prints one JSON line {"event": "result", "data": {"file": ..., "count": n}}.
"""
from __future__ import annotations

import argparse
import json
import sys

from PIL import Image, ImageDraw, ImageFont

CELL_W = 320
CAPTION = 18


def emit(event: str, **data) -> None:
    sys.stdout.write(json.dumps({'event': event, **data}) + '\n')
    sys.stdout.flush()


def font(size: int):
    for name in ('arialbd.ttf', 'arial.ttf', 'DejaVuSans-Bold.ttf', 'DejaVuSans.ttf'):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    try:
        return ImageFont.load_default(size)
    except TypeError:  # older Pillow
        return ImageFont.load_default()


def make(items: list[dict], out: str, cols: int) -> int:
    pics = []
    for it in items:
        try:
            pics.append((Image.open(it['path']).convert('RGB'), str(it.get('label', ''))))
        except Exception:  # noqa: BLE001
            pics.append((None, str(it.get('label', ''))))
    # Every cell has the shape of the first picture (footage is usually all one shape); others are fitted inside.
    first = next((p for p, _ in pics if p is not None), None)
    cell_h = round(CELL_W * first.height / first.width) if first else 180
    cols = max(1, min(cols, len(pics)))
    rows = (len(pics) + cols - 1) // cols
    sheet = Image.new('RGB', (cols * CELL_W, rows * (cell_h + CAPTION)), (16, 16, 16))
    d = ImageDraw.Draw(sheet)
    big, small = font(26), font(12)
    for i, (pic, label) in enumerate(pics):
        x, y = (i % cols) * CELL_W, (i // cols) * (cell_h + CAPTION)
        if pic is not None:
            pic.thumbnail((CELL_W, cell_h))
            sheet.paste(pic, (x + (CELL_W - pic.width) // 2, y + (cell_h - pic.height) // 2))
        else:
            d.text((x + 10, y + cell_h // 2), 'no picture', fill=(160, 160, 160), font=small)
        n = str(i + 1)
        box = d.textbbox((0, 0), n, font=big)
        d.rectangle([x + 4, y + 4, x + 14 + box[2] - box[0], y + 12 + box[3] - box[1]], fill=(255, 212, 0))
        d.text((x + 9 - box[0], y + 8 - box[1]), n, fill=(0, 0, 0), font=big)
        d.text((x + 4, y + cell_h + 3), label[:52], fill=(230, 230, 230), font=small)
        d.line([x, y, x, y + cell_h + CAPTION], fill=(0, 0, 0), width=2)
    sheet.save(out, quality=85)
    return len(pics)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument('--items', required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--cols', type=int, default=4)
    a = p.parse_args()
    try:
        with open(a.items, encoding='utf-8') as f:
            items = json.load(f)
        if not items:
            raise RuntimeError('No pictures to put on the sheet.')
        emit('result', data={'file': a.out, 'count': make(items, a.out, a.cols)})
    except Exception as e:  # noqa: BLE001
        emit('error', message=str(e) or e.__class__.__name__)
        sys.exit(1)


if __name__ == '__main__':
    main()
