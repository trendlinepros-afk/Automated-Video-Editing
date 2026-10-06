# Title card drawn by Claude in a 0.x test build.
from PIL import ImageDraw


def render(frame, t, ctx):
    draw = ImageDraw.Draw(frame)
    text = ctx.params.get("text", "")
    draw.text((frame.width * 0.1, frame.height * 0.4), text, fill=(255, 255, 255))
    return frame
