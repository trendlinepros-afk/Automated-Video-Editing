"""Price tag pop-in. Params: text, color."""
from PIL import ImageDraw


def render(frame, t, ctx):
    d = ImageDraw.Draw(frame)
    scale = min(1.0, t / 0.2)
    d.text((frame.width * 0.6, frame.height * 0.3), ctx.params.get("text", ""), fill=ctx.params.get("color", "#FFD400"))
    return frame
