"""Generates the AI Project Studio app icon (icon.png / icon.ico / icon.icns).

Design goals: a clean, enterprise-grade monogram that stays legible at 16px in
the Windows Task Manager and taskbar. A gradient "squircle" tile with a soft
brand-coloured glow, a glossy top sheen, a thin bevel, and a bold "AI" mark with
a single spark accent. No busy 3D clutter — high contrast, minimal detail.
"""

from __future__ import annotations

import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
S = 1024          # final icon size
SS = 4            # supersample factor for crisp anti-aliasing
W = S * SS        # working canvas size

# Brand gradient (top-left violet -> bottom-right blue).
C1 = (126, 82, 246)   # #7E52F6
C2 = (52, 120, 248)   # #3478F8
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


def squircle_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def load_font(size):
    for name in ("ariblk.ttf", "segoeuib.ttf", "arialbd.ttf"):
        p = os.path.join(r"C:\Windows\Fonts", name)
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


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

    # --- "AI" monogram ---
    text_layer = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    tdraw = ImageDraw.Draw(text_layer)
    font = load_font(int(0.44 * W))
    label = "AI"
    bbox = tdraw.textbbox((0, 0), label, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    tx = (W - tw) / 2 - bbox[0]
    ty = (W - th) / 2 - bbox[1] + int(0.03 * W)

    # soft drop shadow for depth
    shadow = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    shd = ImageDraw.Draw(shadow)
    shd.text((tx, ty + int(0.012 * W)), label, font=font, fill=(20, 24, 60, 130))
    shadow = shadow.filter(ImageFilter.GaussianBlur(int(0.01 * W)))
    canvas = Image.alpha_composite(canvas, shadow)

    tdraw.text((tx, ty), label, font=font, fill=(255, 255, 255, 255))
    canvas = Image.alpha_composite(canvas, text_layer)

    # --- spark accent (top-right of the monogram) ---
    spark_layer = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    sdraw = ImageDraw.Draw(spark_layer)
    sx, sy = int(0.70 * W), int(0.30 * W)
    spark(sdraw, sx, sy, int(0.055 * W), (255, 255, 255, 255))
    glow_spark = spark_layer.filter(ImageFilter.GaussianBlur(int(0.012 * W)))
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
