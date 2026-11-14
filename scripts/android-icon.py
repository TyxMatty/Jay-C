# Android launcher icons from src-tauri/app-icon.png, after `npx tauri icon`, which puts the wolf
# edge to edge in the adaptive icon's foreground: Android masks it to the middle ~66% and the
# head came out cropped and zoomed in. Here the wolf fits the safe zone, on the dark head color.
#   python scripts/android-icon.py   (needs Pillow)
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent / "frontend" / "src-tauri"
RES = ROOT / "gen" / "android" / "app" / "src" / "main" / "res"
BACKGROUND = (0x16, 0x13, 0x1B, 255)  # values/ic_launcher_background.xml
DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
# Share of the canvas the wolf's box takes: adaptive foreground (108 dp canvas, 66 dp safe circle),
# legacy square and legacy round (no mask; the shape is drawn here).
FOREGROUND, LEGACY, ROUND = 0.5, 0.74, 0.6
# The ear sits in the box's top-left corner, the farthest point from the center: the wolf moves a
# little down and right so it stays inside a round mask.
NUDGE = 0.03

wolf = Image.open(ROOT / "app-icon.png").convert("RGBA")
wolf = wolf.crop(wolf.getbbox())


def placed(size, share):
    """The wolf scaled to `share` of a transparent `size` square, centered."""
    box = round(size * share)
    w, h = wolf.size
    scale = box / max(w, h)
    art = wolf.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    nudge = round(size * NUDGE)
    canvas.alpha_composite(art, ((size - art.width) // 2 + nudge, (size - art.height) // 2 + nudge))
    return canvas


def on_shape(size, share, round_shape):
    """The legacy icons: the wolf on a dark circle or rounded square (drawn 4x, then scaled down)."""
    big = size * 4
    mask = Image.new("L", (big, big), 0)
    draw = ImageDraw.Draw(mask)
    if round_shape:
        draw.ellipse((0, 0, big - 1, big - 1), fill=255)
    else:
        draw.rounded_rectangle((0, 0, big - 1, big - 1), radius=big // 5, fill=255)
    mask = mask.resize((size, size), Image.LANCZOS)
    icon = Image.new("RGBA", (size, size), BACKGROUND)
    icon.alpha_composite(placed(size, share))
    icon.putalpha(mask)
    return icon


for name, scale in DENSITIES.items():
    folder = RES / f"mipmap-{name}"
    placed(round(108 * scale), FOREGROUND).save(folder / "ic_launcher_foreground.png")
    on_shape(round(48 * scale), LEGACY, False).save(folder / "ic_launcher.png")
    on_shape(round(48 * scale), ROUND, True).save(folder / "ic_launcher_round.png")
    print(name, "ok")
