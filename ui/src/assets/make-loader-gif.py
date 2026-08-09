"""Generates pr-review-loading.gif: a smooth rotating accent arc on a
transparent background, tuned to read well on both light and dark themes.

Run: python make-loader-gif.py
"""
import math
from PIL import Image, ImageDraw

SIZE = 96          # supersampled canvas (downscaled 2x for smooth edges)
OUT = 48
FRAMES = 24
STROKE = 10
ACCENT = (110, 168, 254)  # #6ea8fe

frames = []
for i in range(FRAMES):
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = STROKE // 2 + 4
    box = [pad, pad, SIZE - pad, SIZE - pad]
    # Faint full track.
    d.arc(box, 0, 360, fill=ACCENT + (48,), width=STROKE)
    # Bright sweeping head.
    start = (i / FRAMES) * 360
    d.arc(box, start, start + 90, fill=ACCENT + (255,), width=STROKE)
    frames.append(img.resize((OUT, OUT), Image.LANCZOS))

frames[0].save(
    "pr-review-loading.gif",
    save_all=True,
    append_images=frames[1:],
    duration=40,
    loop=0,
    disposal=2,
    transparency=0,
)
print("wrote pr-review-loading.gif")
