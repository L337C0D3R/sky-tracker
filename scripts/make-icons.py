"""Renders the PNG app icons (iOS home screen ignores SVG icons).
Usage: python3 scripts/make-icons.py   (needs Pillow)"""
import math
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

OUT = Path(__file__).resolve().parent.parent / 'public'
S = 1024


def render(full_bleed: bool) -> Image.Image:
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    # Background: deep navy radial gradient
    bg = Image.new('RGBA', (S, S))
    px = bg.load()
    for y in range(S):
        for x in range(S):
            d = math.hypot(x - S * 0.5, y - S * 0.32) / S
            t = min(1, d * 1.6)
            px[x, y] = (int(26 + (4 - 26) * t), int(42 + (8 - 42) * t), int(102 + (22 - 102) * t), 255)
    if full_bleed:
        img = bg
    else:
        mask = Image.new('L', (S, S), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=255)
        img.paste(bg, (0, 0), mask)
    d = ImageDraw.Draw(img)
    # Stars
    for (x, y, r) in [(0.2, 0.22, 7), (0.78, 0.16, 5), (0.14, 0.7, 4), (0.85, 0.62, 6), (0.32, 0.86, 4), (0.62, 0.1, 3)]:
        d.ellipse([x * S - r, y * S - r, x * S + r, y * S + r], fill=(255, 255, 255, 230))
    # Planet glow
    glow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse([S * 0.3, S * 0.3, S * 0.7, S * 0.7], fill=(255, 180, 90, 120))
    img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(60)))
    # Planet body
    planet = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    pp = planet.load()
    cx, cy, R = S * 0.5, S * 0.52, S * 0.2
    for y in range(int(cy - R), int(cy + R) + 1):
        for x in range(int(cx - R), int(cx + R) + 1):
            dd = math.hypot(x - cx, y - cy)
            if dd <= R:
                lx = math.hypot(x - (cx - R * 0.35), y - (cy - R * 0.35)) / (R * 1.6)
                t = min(1, lx)
                pp[x, y] = (int(255 + (205 - 255) * t), int(226 + (128 - 226) * t), int(168 + (52 - 168) * t), 255)
    img.alpha_composite(planet)
    # Ring (ellipse outline, rotated)
    ring = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(ring).ellipse([S * 0.12, S * 0.43, S * 0.88, S * 0.61], outline=(255, 222, 170, 255), width=int(S * 0.028))
    ring = ring.rotate(20, resample=Image.BICUBIC, center=(cx, cy))
    # hide the part of the ring behind the planet (upper half)
    cut = Image.new('L', (S, S), 255)
    ImageDraw.Draw(cut).pieslice([cx - R, cy - R, cx + R, cy + R], 180 + 20, 360 + 20, fill=0)
    ring.putalpha(Image.composite(ring.getchannel('A'), Image.new('L', (S, S), 0), cut))
    img.alpha_composite(ring)
    # Satellite with trail
    tr = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    td = ImageDraw.Draw(tr)
    for i in range(40):
        a = int(10 + i * 5)
        x = S * 0.58 + i * 6.5
        y = S * 0.24 - i * 2.4
        td.ellipse([x - 5, y - 5, x + 5, y + 5], fill=(126, 240, 207, a))
    img.alpha_composite(tr)
    sx, sy = S * 0.84, S * 0.145
    d.ellipse([sx - 16, sy - 16, sx + 16, sy + 16], fill=(215, 255, 242, 255))
    return img


for name, size, full in [('apple-touch-icon.png', 180, True), ('icon-192.png', 192, False), ('icon-512.png', 512, False), ('icon-maskable-512.png', 512, True)]:
    render(full).resize((size, size), Image.LANCZOS).convert('RGB' if full else 'RGBA').save(OUT / name, optimize=True)
    print('wrote', name)
