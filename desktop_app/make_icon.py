#!/usr/bin/env python3
"""Generate the local macOS launcher icon from simple vector primitives."""

from __future__ import annotations

from pathlib import Path
import sys

from PIL import Image, ImageDraw, ImageFilter


SIZE = 1024


def rounded_gradient() -> Image.Image:
    image = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    shadow = Image.new("RGBA", image.size, (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.rounded_rectangle(
        (74, 82, 950, 958),
        radius=210,
        fill=(5, 27, 23, 105),
    )
    image.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(28)))

    gradient = Image.new("RGBA", image.size)
    pixels = gradient.load()
    top = (31, 110, 98)
    bottom = (18, 57, 49)
    for y in range(SIZE):
        fraction = y / (SIZE - 1)
        color = tuple(round(top[index] * (1 - fraction) + bottom[index] * fraction) for index in range(3))
        for x in range(SIZE):
            pixels[x, y] = (*color, 255)
    mask = Image.new("L", image.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((64, 64, 960, 960), radius=210, fill=255)
    image.alpha_composite(Image.composite(gradient, Image.new("RGBA", image.size), mask))
    return image


def draw_transcripts(image: Image.Image) -> None:
    drawing = ImageDraw.Draw(image)
    cream = (244, 247, 238, 255)
    pale = (207, 229, 218, 255)
    coral = (223, 133, 105, 255)
    line = (176, 213, 198, 255)
    rows = [330, 510, 690]
    exon_sets = [
        [(180, 245), (330, 430), (610, 670), (780, 860)],
        [(180, 285), (385, 470), (540, 705), (800, 860)],
        [(180, 225), (300, 390), (485, 555), (650, 755), (810, 860)],
    ]

    for row_index, (y, exons) in enumerate(zip(rows, exon_sets)):
        drawing.rounded_rectangle((164, y - 5, 874, y + 5), radius=5, fill=line)
        for exon_index, (start, end) in enumerate(exons):
            fill = cream if (row_index + exon_index) % 2 == 0 else pale
            drawing.rounded_rectangle((start, y - 40, end, y + 40), radius=14, fill=fill)
        selected_start, selected_end = exons[1]
        drawing.rounded_rectangle(
            (selected_start + 12, y - 24, selected_end - 12, y + 24),
            radius=10,
            fill=coral,
        )
        drawing.line((854, y - 20, 878, y, 854, y + 20), fill=cream, width=10, joint="curve")

    drawing.rounded_rectangle((160, 215, 876, 805), radius=70, outline=(255, 255, 255, 42), width=4)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: make_icon.py OUTPUT.icns")
    destination = Path(sys.argv[1])
    destination.parent.mkdir(parents=True, exist_ok=True)
    image = rounded_gradient()
    draw_transcripts(image)
    image.save(destination, format="ICNS")


if __name__ == "__main__":
    main()
