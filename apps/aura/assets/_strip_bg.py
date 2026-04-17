"""One-shot: flood-fill white background → transparent, then export icon sizes.

Flood-fill from the 4 corners with a small tolerance so only the outer white
canvas becomes transparent — any near-white highlights inside the rounded
square stay intact.
"""
from __future__ import annotations

from collections import deque
from pathlib import Path

from PIL import Image

SRC = Path(__file__).parent.parent / "Gemini_Generated_Image_w2jx7kw2jx7kw2jx.png"
OUT_1024 = Path(__file__).parent / "aura-icon-1024.png"
SIZES = [1024, 512, 256, 192, 128, 64, 32, 16]
TOL = 12  # per-channel distance from #fff


def strip_white_bg(img: Image.Image) -> Image.Image:
    img = img.convert("RGBA")
    w, h = img.size
    px = img.load()

    def is_white(p):
        r, g, b, _ = p
        return r >= 255 - TOL and g >= 255 - TOL and b >= 255 - TOL

    visited = bytearray(w * h)
    q: deque[tuple[int, int]] = deque()
    for x in range(w):
        q.append((x, 0))
        q.append((x, h - 1))
    for y in range(h):
        q.append((0, y))
        q.append((w - 1, y))

    while q:
        x, y = q.popleft()
        if x < 0 or y < 0 or x >= w or y >= h:
            continue
        idx = y * w + x
        if visited[idx]:
            continue
        visited[idx] = 1
        if not is_white(px[x, y]):
            continue
        px[x, y] = (0, 0, 0, 0)
        q.append((x + 1, y))
        q.append((x - 1, y))
        q.append((x, y + 1))
        q.append((x, y - 1))

    return img


def main() -> None:
    src = Image.open(SRC)
    stripped = strip_white_bg(src)
    stripped.save(OUT_1024, "PNG")
    print(f"wrote {OUT_1024}  ({stripped.size[0]}x{stripped.size[1]})")
    for s in SIZES:
        if s == stripped.size[0]:
            continue
        out = OUT_1024.with_name(f"aura-icon-{s}.png")
        stripped.resize((s, s), Image.LANCZOS).save(out, "PNG")
        print(f"wrote {out}")


if __name__ == "__main__":
    main()
