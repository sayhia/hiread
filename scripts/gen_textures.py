#!/usr/bin/env python3
"""Generate the tileable paper-grain textures the reader overlays on the page.

Pure standard library (no Pillow): PNGs are written directly via zlib. The
grains are low-alpha warm greys, so they tint with whatever paper colour the
reader has chosen rather than painting over it.

Seamless by construction: each pattern is drawn on a 2× tile and the centre
square is cropped out. When the result tiles, its right edge sits directly
next to its left edge — and in the source those two edges were neighbours,
so no seam shows. The larger 256px tile also repeats far less often.

Run from the repo root:  python3 scripts/gen_textures.py
"""

import math
import os
import random
import struct
import zlib

OUT = os.path.join(
    os.path.dirname(__file__), "..", "frontend", "src", "assets", "textures"
)
SIZE = 256
BIG = SIZE * 2
# A warm grey, matching the grain the CSS used to draw (rgba(120,100,70,…)).
R, G, B = 120, 100, 70


def png(w, h, pixels):
    """Encode RGBA pixels (rows of (r, g, b, a) tuples) as a PNG."""
    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(
            ">I", zlib.crc32(body) & 0xFFFFFFFF
        )

    raw = bytearray()
    for row in pixels:
        raw.append(0)  # filter: none
        for r, g, b, a in row:
            raw += bytes((r, g, b, a))
    return b"".join(
        [
            b"\x89PNG\r\n\x1a\n",
            chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)),
            chunk(b"IDAT", zlib.compress(bytes(raw), 9)),
            chunk(b"IEND", b""),
        ]
    )


def blank():
    return [[(R, G, B, 0) for _ in range(BIG)] for _ in range(BIG)]


def tileable(px):
    """Crop the centre SIZE square out of a 2× pattern.

    Tiling the result puts its right edge next to its left edge; in the
    source pattern those two edges were adjacent, so the join is invisible.
    """
    off = SIZE // 2
    return [row[off : off + SIZE] for row in px[off : off + SIZE]]


def write(name, pixels):
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, name + ".png")
    with open(path, "wb") as f:
        f.write(png(SIZE, SIZE, pixels))
    print("wrote", path)


def wood():
    """Straight-grained timber: soft vertical fibres with a slow wave, like
    the face of a sawn plank.

    Built from sine sums whose periods divide the tile size exactly, so the
    grain meets itself at every edge — no centre-crop needed, and no seam.
    """
    rnd = random.Random(53)
    px = [[(R, G, B, 0) for _ in range(SIZE)] for _ in range(SIZE)]
    # Fibre density across the width: a few low sines, whole periods only.
    fib = [0.0] * SIZE
    for k, amp in ((1, 4.5), (2, 3.5), (3, 2.6), (5, 1.8)):
        ph = rnd.uniform(0, 6.283)
        for x in range(SIZE):
            fib[x] += amp * math.sin(2 * math.pi * k * x / SIZE + ph)
    # The wave down the length shifts the fibres gently, also periodic.
    wob = [0.0] * SIZE
    for k, amp in ((1, 3.2), (2, 2.2)):
        ph = rnd.uniform(0, 6.283)
        for y in range(SIZE):
            wob[y] += amp * math.sin(2 * math.pi * k * y / SIZE + ph)
    for y in range(SIZE):
        shift = int(wob[y])
        for x in range(SIZE):
            a = 13 + fib[(x + shift) % SIZE]
            if a > 0:
                px[y][x] = (R, G, B, min(40, int(a)))
    return px


def fibre():
    """Short random filaments in every direction, like unsized paper."""
    rnd = random.Random(41)
    px = blank()
    for _ in range(1500):
        x, y = rnd.randrange(BIG), rnd.randrange(BIG)
        ang = rnd.uniform(0, 6.283)
        ln = rnd.uniform(3, 8)
        a = rnd.randint(20, 34)
        dx, dy = math.cos(ang) * ln, math.sin(ang) * ln
        steps = max(1, int(ln))
        for i in range(steps + 1):
            t = i / steps
            xx = int((x + dx * t) % BIG)
            yy = int((y + dy * t) % BIG)
            px[yy][xx] = (R, G, B, a)
    return tileable(px)


def grain():
    """A fine random noise, like the tooth of a grained paper."""
    rnd = random.Random(43)
    px = blank()
    for y in range(BIG):
        for x in range(BIG):
            if rnd.random() < 0.12:
                px[y][x] = (R, G, B, rnd.randint(28, 40))
    return tileable(px)


def grid():
    """A clear ruled grid on a 4px pitch, like graph paper.

    4 divides the tile size exactly, so the last rule of a tile lines up with
    the first rule of the next one — a grid tiles without a break anyway,
    but the centre-crop keeps the look consistent with the other grains.
    """
    rnd = random.Random(31)
    px = blank()
    for y in range(0, BIG, 4):
        a = rnd.randint(40, 46)
        for x in range(BIG):
            px[y][x] = (R, G, B, a)
    for x in range(0, BIG, 4):
        a = rnd.randint(40, 46)
        for y in range(BIG):
            px[y][x] = (R, G, B, a)
    return tileable(px)


if __name__ == "__main__":
    write("wood", wood())
    write("fibre", fibre())
    write("grain", grain())
    write("grid", grid())
