"""Upload type checks without decoding photos in the API process."""

PHOTO_MIME_TYPES = (
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heif",
    "image/avif",
    "image/tiff",
    "image/bmp",
    "image/gif",
)
PHOTO_FORMAT_LABEL = "JPEG, PNG, WebP, HEIC/HEIF, AVIF, TIFF, BMP or still GIF"
SIGNATURE_BYTES = 4096
MIME_ALIASES = {
    "image/jpg": "image/jpeg",
    "image/pjpeg": "image/jpeg",
    "image/x-png": "image/png",
    "image/heic": "image/heif",
    "image/x-heic": "image/heif",
    "image/x-heif": "image/heif",
    "image/x-tiff": "image/tiff",
    "image/x-bmp": "image/bmp",
    "image/x-ms-bmp": "image/bmp",
}


def photo_mime(value: str) -> str | None:
    value = value.split(";", 1)[0].strip().lower()
    value = MIME_ALIASES.get(value, value)
    return value if value in PHOTO_MIME_TYPES else None


def sniff_type(prefix: bytes) -> str | None:
    if prefix.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if prefix.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if prefix.startswith(b"RIFF") and prefix[8:12] == b"WEBP":
        return "image/webp"
    if prefix.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if prefix.startswith(b"BM"):
        return "image/bmp"
    if prefix.startswith((b"II*\x00", b"MM\x00*", b"II+\x00", b"MM\x00+")):
        return "image/tiff"
    # HEIF/AVIF use ISO BMFF. Inspect the bounded ftyp box, including compatible
    # brands: mif1 alone cannot distinguish HEVC from AV1. Never accept MP4/QuickTime
    # or sequence brands just because they also use an ftyp box.
    if len(prefix) >= 16 and prefix[4:8] == b"ftyp":
        size = int.from_bytes(prefix[:4], "big")
        if size < 16 or size > min(len(prefix), SIGNATURE_BYTES) or size % 4:
            return None
        major = prefix[8:12]
        brands = {major, *(prefix[i : i + 4] for i in range(16, size, 4))}
        if brands & {b"avis", b"msf1", b"hevc", b"hevx", b"hevm", b"hevs"}:
            return None
        if major in {b"avif", b"mif1"} and b"avif" in brands:
            return "image/avif"
        if major in {b"heic", b"heix", b"heim", b"heis", b"mif1"}:
            return "image/heif"
    return None
