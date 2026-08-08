"""
Generate the PWA icon set.

    docker compose exec pretix python /plugin/dev/make_icons.py

Regenerate and commit the output; this is not part of the build. Pillow comes in
with pretix, so there is no extra dependency to install.
"""
import os

from PIL import Image, ImageDraw

OUT_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "pretix_openpos", "static", "pretix_openpos", "icons",
)

ACCENT = "#2563eb"
PAPER = "#ffffff"


def draw_icon(size: int, *, maskable: bool = False) -> Image.Image:
    """A receipt on an accent-coloured tile."""
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    if maskable:
        # Maskable icons get cropped to whatever shape the platform likes, so the
        # background is full-bleed and the artwork stays inside the safe zone.
        draw.rectangle([0, 0, size, size], fill=ACCENT)
        scale = 0.62
    else:
        draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=size * 0.22, fill=ACCENT)
        scale = 0.82

    width = size * 0.44 * scale
    height = size * 0.52 * scale
    left = (size - width) / 2
    top = (size - height) / 2 - size * 0.02

    draw.rectangle([left, top, left + width, top + height], fill=PAPER)

    # Torn-off bottom edge, so it reads as a receipt rather than a sheet of paper.
    teeth = 5
    step = width / teeth
    points = [(left, top + height)]
    for i in range(teeth):
        points.append((left + step * (i + 0.5), top + height + step * 0.5))
        points.append((left + step * (i + 1), top + height))
    draw.polygon(points, fill=PAPER)

    # Lines of print.
    line_height = max(2, size * 0.028 * scale)
    for index, fraction in enumerate((0.20, 0.42, 0.64)):
        line_width = width * (0.62 if index < 2 else 0.34)
        y = top + height * fraction
        draw.rounded_rectangle(
            [left + width * 0.19, y, left + width * 0.19 + line_width, y + line_height],
            radius=line_height / 2,
            fill=ACCENT,
        )

    return image


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    targets = [
        ("icon-192.png", 192, False),
        ("icon-512.png", 512, False),
        ("icon-maskable-512.png", 512, True),
        ("apple-touch-icon.png", 180, True),  # iOS applies its own rounding
    ]
    for filename, size, maskable in targets:
        # Draw large and downsample: cheap antialiasing for the diagonal teeth.
        supersampled = draw_icon(size * 4, maskable=maskable)
        icon = supersampled.resize((size, size), Image.LANCZOS)
        path = os.path.join(OUT_DIR, filename)
        icon.save(path)
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
