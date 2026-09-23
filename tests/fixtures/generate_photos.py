"""Generate original codec fixtures; the HEIF encoder is only a fixture-build dependency.

Run with Pillow 12.3.0 and pillow-heif 1.7.0. Runtime uses the decoder-only pi-heif.
"""

import hashlib
import json
from array import array
from pathlib import Path

import pillow_heif
from PIL import Image, ImageCms, ImageDraw

pillow_heif.register_heif_opener()
folder = Path(__file__).parent / "photos"
folder.mkdir(exist_ok=True)
srgb = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()

with Image.open(Path(__file__).parent / "transport.png") as source:
    for extension, codec in (
        ("heic", "HEIF"),
        ("avif", "AVIF"),
        ("tiff", "TIFF"),
        ("bmp", "BMP"),
        ("gif", "GIF"),
        ("jpg", "JPEG"),
        ("webp", "WEBP"),
    ):
        options = {"compression": "tiff_lzw"} if codec == "TIFF" else {}
        source.convert("RGB").save(folder / f"transport.{extension}", codec, **options)
    # Phone JPEGs can carry MPF auxiliary images. The first JPEG is the photo;
    # a deliberately different, smaller image makes selecting the wrong one obvious.
    source.convert("RGB").save(
        folder / "transport-mpf.jpg",
        "MPO",
        save_all=True,
        append_images=[Image.new("RGB", (75, 105), "magenta")],
        quality=95,
    )

# Primary index is deliberately nonzero. Container rotation must not be applied
# again from EXIF. Each quadrant makes incorrect rotation visible in pixel tests.
primary = Image.new("RGB", (96, 64))
draw = ImageDraw.Draw(primary)
for box, color in (
    ((0, 0, 47, 31), "red"),
    ((48, 0, 95, 31), "lime"),
    ((0, 32, 47, 63), "blue"),
    ((48, 32, 95, 63), "yellow"),
):
    draw.rectangle(box, fill=color)
exif = primary.getexif()
exif[274] = 6
exif[315] = "SYNTHETIC PRIVATE METADATA"
primary.info.update(exif=exif.tobytes(), icc_profile=srgb, xmp=b"<test>PRIVATE XMP</test>")
Image.new("RGB", (32, 24), "magenta").save(
    folder / "primary-rotated.heic",
    "HEIF",
    save_all=True,
    append_images=[primary],
    primary_index=1,
    quality=-1,
    chroma=444,
)

pixels = array(
    "H",
    (
        value
        for _y in range(64)
        for x in range(96)
        for value in ([16384] * 3 if x < 32 else [32768] * 3 if x < 64 else [65535] * 3)
    ),
)
for bits in (10, 12):
    pillow_heif.options.SAVE_HDR_TO_12_BIT = bits == 12
    image = pillow_heif.from_bytes("RGB;16", (96, 64), pixels.tobytes())
    image.save(folder / f"gray-{bits}bit.heif", quality=-1, chroma=444)

manifest = {
    path.name: hashlib.sha256(path.read_bytes()).hexdigest()
    for path in sorted(folder.iterdir())
    if path.suffix in {".heic", ".heif", ".avif", ".tiff", ".bmp", ".gif", ".jpg", ".webp"}
}
(folder / "sha256.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(f"Generated {len(manifest)} synthetic photo fixtures.")
