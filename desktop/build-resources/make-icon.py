"""Generates the AI Project Studio app icon (icon.png / icon.ico / icon.icns).

Design goals: a clean, enterprise-grade mark that stays legible at 16px in the
Windows Task Manager and taskbar, and reads on any OS theme. A gradient
"squircle" tile with a soft brand-coloured glow, a glossy top sheen and a thin
bevel carries a bold terminal `>_` prompt — the universal "run a command" cue
for a developer tool — finished with a single AI spark. The glyph is extruded
with a soft drop shadow and a top bevel highlight for a tactile 3D feel without
busy clutter. Mirrors the in-app SVG brand mark (ui/src/components/brand-mark).
"""

from __future__ import annotations

import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
S = 1024          # final icon size
SS = 4            # supersample factor for crisp anti-aliasing
W = S * SS        # working canvas size

# Brand gradient (top-left violet -> indigo -> bottom-right blue).
C1 = (139, 92, 246)   # #8B5CF6
C2 = (47, 128, 248)   # #2F80F8
GLOW = (108, 132, 255)  # accent glow colour
RADIUS = int(0.235 * W)  # macOS-style squircle corner radius


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def diagonal_gradient(size, c1, c2):
    """A smooth diagonal linear gradient, built small then upscaled."""
    n = 96
    small = Image.new("RGB", (n, n))
    px = small.load()
    for y in range(n):
        for x in range(n):
            t = (x + y) / (2 * (n - 1))
            px[x, y] = lerp(c1, c2, t)
    return small.resize((size, size), Image.BICUBIC)


def spark(draw, cx, cy, r, color, thin=0.30):
    """A 4-point sparkle (concave star)."""
    pts = [
        (cx, cy - r),
        (cx + r * thin, cy - r * thin),
        (cx + r, cy),
        (cx + r * thin, cy + r * thin),
        (cx, cy + r),
        (cx - r * thin, cy + r * thin),
        (cx - r, cy),
        (cx - r * thin, cy - r * thin),
    ]
    draw.polygon(pts, fill=color)


def stroke_path(draw, pts, width, color):
    """A rounded poly-line: curved joints plus circular end caps."""
    draw.line(pts, fill=color, width=width, joint="curve")
    r = width / 2
    for (x, y) in pts:
        draw.ellipse([x - r, y - r, x + r, y + r], fill=color)


def prompt_glyph(size, pts_sets, width, color):
    """Renders the `>_` stroke set onto a transparent layer of `size`."""
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for pts in pts_sets:
        stroke_path(d, pts, width, color)
    return layer


def build():
    canvas = Image.new("RGBA", (W, W), (0, 0, 0, 0))

    # Inset the tile a little so the glow has room to breathe.
    inset = int(0.085 * W)
    tile_box = (inset, inset, W - inset, W - inset)
    tile_size = tile_box[2] - tile_box[0]

    # --- soft outer glow ---
    glow_mask = Image.new("L", (W, W), 0)
    gd = ImageDraw.Draw(glow_mask)
    gd.rounded_rectangle(tile_box, radius=RADIUS, fill=255)
    glow_layer = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    glow_solid = Image.new("RGBA", (W, W), GLOW + (255,))
    glow_layer.paste(glow_solid, (0, 0), glow_mask)
    glow_layer = glow_layer.filter(ImageFilter.GaussianBlur(int(0.055 * W)))
    # Tone the glow down so it reads as a halo, not a fill.
    alpha = glow_layer.split()[3].point(lambda a: int(a * 0.55))
    glow_layer.putalpha(alpha)
    canvas = Image.alpha_composite(canvas, glow_layer)

    # --- gradient tile ---
    grad = diagonal_gradient(W, C1, C2).convert("RGBA")
    tile_mask = Image.new("L", (W, W), 0)
    td = ImageDraw.Draw(tile_mask)
    td.rounded_rectangle(tile_box, radius=RADIUS, fill=255)
    tile = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    tile.paste(grad, (0, 0), tile_mask)
    canvas = Image.alpha_composite(canvas, tile)

    # --- glossy top sheen ---
    sheen = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sheen)
    sd.ellipse(
        [inset - tile_size * 0.15, inset - tile_size * 0.55,
         W - inset + tile_size * 0.15, inset + tile_size * 0.42],
        fill=(255, 255, 255, 46),
    )
    sheen = sheen.filter(ImageFilter.GaussianBlur(int(0.02 * W)))
    sheen.putalpha(Image.composite(sheen.split()[3],
                                   Image.new("L", (W, W), 0), tile_mask))
    canvas = Image.alpha_composite(canvas, sheen)

    # --- thin premium bevel (light top edge) ---
    bevel = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    bd = ImageDraw.Draw(bevel)
    bd.rounded_rectangle(tile_box, radius=RADIUS, outline=(255, 255, 255, 70),
                         width=max(2, int(0.004 * W)))
    canvas = Image.alpha_composite(canvas, bevel)

    # --- terminal prompt `>_` (the "run a command" cue) ---
    # Chevron + underscore, centred as a balanced unit.
    def P(nx, ny):
        return (nx * W, ny * W)

    chevron = [P(0.345, 0.335), P(0.515, 0.505), P(0.345, 0.675)]
    underscore = [P(0.560, 0.672), P(0.730, 0.672)]
    stroke_w = int(0.078 * W)

    # soft drop shadow for depth
    shadow = prompt_glyph(W, [chevron, underscore], stroke_w, (18, 22, 55, 140))
    shadow = shadow.transform(
        (W, W), Image.AFFINE, (1, 0, 0, 0, 1, int(0.016 * W)))
    shadow = shadow.filter(ImageFilter.GaussianBlur(int(0.012 * W)))
    canvas = Image.alpha_composite(canvas, shadow)

    # base glyph (white)
    glyph = prompt_glyph(W, [chevron, underscore], stroke_w, (255, 255, 255, 255))
    canvas = Image.alpha_composite(canvas, glyph)

    # top bevel highlight, nudged up, for a tactile 3D edge
    hi = prompt_glyph(W, [chevron, underscore],
                      int(stroke_w * 0.46), (226, 236, 255, 150))
    hi = hi.transform((W, W), Image.AFFINE, (1, 0, 0, 0, 1, -int(0.010 * W)))
    hi = hi.filter(ImageFilter.GaussianBlur(int(0.004 * W)))
    hi.putalpha(Image.composite(hi.split()[3],
                                Image.new("L", (W, W), 0), glyph.split()[3]))
    canvas = Image.alpha_composite(canvas, hi)

    # --- spark accent (top-right) with a soft glow ---
    spark_layer = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    sdraw = ImageDraw.Draw(spark_layer)
    sx, sy = int(0.705 * W), int(0.300 * W)
    spark(sdraw, sx, sy, int(0.058 * W), (255, 255, 255, 255))
    glow_spark = spark_layer.filter(ImageFilter.GaussianBlur(int(0.013 * W)))
    canvas = Image.alpha_composite(canvas, glow_spark)
    canvas = Image.alpha_composite(canvas, spark_layer)

    # downscale to final size
    icon = canvas.resize((S, S), Image.LANCZOS)

    png_path = os.path.join(HERE, "icon.png")
    icon.save(png_path)

    ico_path = os.path.join(HERE, "icon.ico")
    icon.save(ico_path, sizes=[(16, 16), (24, 24), (32, 32), (48, 48),
                               (64, 64), (128, 128), (256, 256)])

    icns_path = os.path.join(HERE, "icon.icns")
    try:
        icon.save(icns_path)
    except Exception as exc:  # pragma: no cover - platform dependent
        print("icns skipped:", exc)

    print("wrote", png_path, ico_path, icns_path)


if __name__ == "__main__":
    build()

