# Renders png/, icon.ico and icon.icns from the SVGs beside this file. Needs resvg-py 0.5.0 (resvg 0.48.1) and Pillow 13.0.0,
# e.g. in a venv: `python -m pip install resvg-py==0.5.0 Pillow==13.0.0`, then from the repo root: `python assets/icon/export.py`.
"""Export the Colab Playground application icon.

Every raster is rendered straight from SVG at its final pixel size (nothing is downscaled):
icon.svg is the master for 64 px and up, icon-16/24/32/48.svg are the small-size drawings
(larger bolt, heavier stroke). Windows and Linux get the full tile; the macOS .icns gets the
same drawing scaled into Apple's 824/1024 safe area with a transparent margin.
"""

import io
import math
import re
import struct
from pathlib import Path

import resvg_py
from PIL import Image

HERE = Path(__file__).resolve().parent
SMALL_DRAWINGS = (16, 24, 32, 48)
PNG_SIZES = (16, 24, 32, 48, 64, 128, 256, 512, 1024)
ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)
MAC_SCALE = 824 / 1024
# .icns entries holding PNG data: (type, pixels). ic11..ic14 and ic10 are the @2x slots.
ICNS_PNG = (
    (b"icp4", 16), (b"ic11", 32), (b"icp5", 32), (b"ic12", 64), (b"ic07", 128), (b"ic13", 256), (b"ic08", 256), (b"ic14", 512), (b"ic09", 512),
    (b"ic10", 1024),
)
# Legacy RLE RGB + 8-bit mask pairs for 16 and 32 px, for readers that skip icp4/icp5.
ICNS_LEGACY = ((b"is32", b"s8mk", 16), (b"il32", b"l8mk", 32))


def drawing_for(tile_px: float) -> str:
    """Source of the drawing designed for the size nearest to a tile of `tile_px` pixels."""
    if tile_px > 56:
        name = "icon.svg"
    else:
        best = min(SMALL_DRAWINGS, key=lambda d: abs(math.log(tile_px / d)))
        name = f"icon-{best}.svg"
    return (HERE / name).read_text(encoding="utf-8")


def mac_svg(src: str) -> str:
    """The drawing scaled into Apple's 824/1024 rounded-square safe area."""
    n = float(re.search(r'viewBox="0 0 ([\d.]+)', src).group(1))
    body = src[src.index(">", src.index("<svg")) + 1 : src.rindex("</svg>")]
    off = n * (1 - MAC_SCALE) / 2
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{n:g}" height="{n:g}" viewBox="0 0 {n:g} {n:g}">'
        f'<g transform="translate({off:g} {off:g}) scale({MAC_SCALE:g})">{body}</g></svg>'
    )


def render(svg: str, px: int) -> bytes:
    return bytes(resvg_py.svg_to_bytes(svg_string=svg, width=px, height=px))


def decode(png: bytes) -> Image.Image:
    return Image.open(io.BytesIO(png)).convert("RGBA")


def ico_bitmap(png: bytes) -> bytes:
    """32-bit BGRA DIB with its AND mask, the classic ICO entry for sizes below 256."""
    img = decode(png)
    w, h = img.size
    r, g, b, a = img.transpose(Image.Transpose.FLIP_TOP_BOTTOM).split()
    pixels = Image.merge("RGBA", (b, g, r, a)).tobytes()
    alpha = a.tobytes()
    row_bytes = (w + 31) // 32 * 4
    mask = bytearray(row_bytes * h)
    for y in range(h):
        for x in range(w):
            if alpha[y * w + x] == 0:
                mask[y * row_bytes + (x >> 3)] |= 0x80 >> (x & 7)
    header = struct.pack("<IiiHHIIiiII", 40, w, h * 2, 1, 32, 0, len(pixels) + len(mask), 0, 0, 0, 0)
    return header + pixels + bytes(mask)


def write_ico(path: Path, pngs: dict[int, bytes]) -> None:
    blobs = [(px, pngs[px] if px >= 256 else ico_bitmap(pngs[px])) for px in ICO_SIZES]
    offset = 6 + 16 * len(blobs)
    out = bytearray(struct.pack("<HHH", 0, 1, len(blobs)))
    for px, data in blobs:
        dim = 0 if px >= 256 else px
        out += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    for _, data in blobs:
        out += data
    path.write_bytes(bytes(out))


def icns_rle(channel: bytes) -> bytes:
    """Apple's byte-run encoding used by is32/il32."""
    out, i, n = bytearray(), 0, len(channel)
    while i < n:
        run = 1
        while i + run < n and run < 130 and channel[i + run] == channel[i]:
            run += 1
        if run >= 3:
            out += bytes((0x80 + run - 3, channel[i]))
            i += run
            continue
        start = i
        while i < n and i - start < 128:
            if i + 2 < n and channel[i] == channel[i + 1] == channel[i + 2]:
                break
            i += 1
        out.append(i - start - 1)
        out += channel[start:i]
    return bytes(out)


def write_icns(path: Path, pngs: dict[int, bytes]) -> None:
    entries = []
    for rgb_type, mask_type, px in ICNS_LEGACY:
        r, g, b, a = decode(pngs[px]).split()
        entries.append((rgb_type, b"".join(icns_rle(c.tobytes()) for c in (r, g, b))))
        entries.append((mask_type, a.tobytes()))
    entries += [(kind, pngs[px]) for kind, px in ICNS_PNG]
    body = b"".join(kind + struct.pack(">I", len(data) + 8) + data for kind, data in entries)
    path.write_bytes(b"icns" + struct.pack(">I", len(body) + 8) + body)


def main() -> None:
    full = {px: render(drawing_for(px), px) for px in sorted(set(PNG_SIZES) | set(ICO_SIZES))}
    png_dir = HERE / "png"
    png_dir.mkdir(exist_ok=True)
    for px in PNG_SIZES:
        (png_dir / f"icon-{px}.png").write_bytes(full[px])
    write_ico(HERE / "icon.ico", full)

    mac_sizes = {px for _, px in ICNS_PNG}
    mac = {px: render(mac_svg(drawing_for(px * MAC_SCALE)), px) for px in sorted(mac_sizes)}
    write_icns(HERE / "icon.icns", mac)
    print(f"png/ {', '.join(map(str, PNG_SIZES))}; icon.ico {', '.join(map(str, ICO_SIZES))}; "
          f"icon.icns {', '.join(map(str, sorted(mac_sizes)))}")


if __name__ == "__main__":
    main()
