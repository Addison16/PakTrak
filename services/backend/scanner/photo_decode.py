"""Convert uploaded still photos to metadata-free, browser-compatible scan images."""

import io
import warnings

from pi_heif import register_heif_opener
from PIL import Image, ImageCms, ImageOps, UnidentifiedImageError

from scanner.photo_formats import PHOTO_FORMAT_LABEL, SIGNATURE_BYTES, sniff_type

# Only the primary HEIF image is scanned. Depth/gain maps and embedded thumbnails
# are not separate cards. Keep libheif's own security limits enabled.
register_heif_opener(thumbnails=False, depth_images=False, aux_images=False, decode_threads=2)
PILLOW_FORMATS = {
    "image/jpeg": "JPEG",
    "image/png": "PNG",
    "image/webp": "WEBP",
    "image/heif": "HEIF",
    "image/avif": "AVIF",
    "image/tiff": "TIFF",
    "image/bmp": "BMP",
    "image/gif": "GIF",
}
SRGB = ImageCms.createProfile("sRGB")


class ImageRejected(Exception):
    pass


def _rgb(image: Image.Image) -> Image.Image:
    profile = image.info.get("icc_profile")
    if image.mode.startswith("I;16"):
        image = image.convert("I").point(lambda pixel: pixel / 257 + 0.5).convert("L")
    # Indexed/gray transparency needs an alpha channel before color conversion.
    if image.mode in {"P", "LA", "PA"} or "transparency" in image.info:
        image = image.convert("RGBA")
    if profile:
        if image.mode not in {"RGB", "RGBA", "CMYK", "LAB", "L"}:
            image = image.convert("RGB")
        try:
            image = ImageCms.profileToProfile(
                image,
                ImageCms.ImageCmsProfile(io.BytesIO(profile)),
                SRGB,
                outputMode="RGBA" if "A" in image.getbands() else "RGB",
            )
        except (ImageCms.PyCMSError, OSError, ValueError, TypeError) as exc:
            raise ImageRejected(
                "This photo's color profile could not be read. Export it as an sRGB JPEG or PNG and try again."
            ) from exc
    if "A" in image.getbands():
        background = Image.new("RGB", image.size, "white")
        background.paste(image, mask=image.getchannel("A"))
        return background
    return image.convert("RGB")


def prepare_photo(data: bytes, max_pixels: int):
    Image.MAX_IMAGE_PIXELS = max_pixels
    mime = sniff_type(data[:SIGNATURE_BYTES])
    if mime is None:
        raise ImageRejected(f"Choose a {PHOTO_FORMAT_LABEL} still photo.")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            # Both HEIF plugins can claim mif1. Compatible brands above decide
            # which codec owns the file, so AVIF never enters the HEVC decoder.
            with Image.open(io.BytesIO(data), formats=[PILLOW_FORMATS[mime]]) as opened:
                if opened.width * opened.height > max_pixels:
                    raise ImageRejected("This photo has too many pixels. Choose a smaller image.")
                if opened.format == "TIFF" and 50706 in opened.tag_v2:
                    raise ImageRejected(
                        "RAW/DNG photos need developing first. Export a JPEG, HEIC or TIFF photo and upload that."
                    )
                # Camera JPEGs can contain MPF auxiliary images (e.g. HDR gain
                # maps), which Pillow exposes as an animated MPO. Its initially
                # selected image is the primary photo. As with HEIF, scan only
                # that photo, without decoding auxiliaries or rejecting a still.
                if opened.format not in {"HEIF", "MPO"} and getattr(opened, "n_frames", 1) != 1:
                    raise ImageRejected(
                        "Upload one still photo per file. Export animated images or multi-page TIFFs as separate photos."
                    )
                # The HEIF plugin already selects the primary image and applies its
                # container rotation while resetting EXIF orientation. Do not seek(0).
                opened.load()
                if opened.width * opened.height > max_pixels:
                    raise ImageRejected("This photo has too many pixels. Choose a smaller image.")
                image = _rgb(ImageOps.exif_transpose(opened))
            width, height = image.size
            # Copy only pixels. Neither source EXIF/GPS/XMP nor its ICC metadata
            # belongs in the derived JPEGs; pixel colors have been converted to sRGB.
            clean = Image.new("RGB", image.size)
            clean.paste(image)
            output = io.BytesIO()
            clean.save(output, "JPEG", quality=93)
            clean.thumbnail((720, 720), Image.Resampling.LANCZOS)
            thumbnail = io.BytesIO()
            clean.save(thumbnail, "JPEG", quality=82)
            return output.getvalue(), thumbnail.getvalue(), width, height
    except ImageRejected:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ImageRejected("This photo has too many pixels. Choose a smaller image.") from exc
    except (
        UnidentifiedImageError,
        OSError,
        ValueError,
        SyntaxError,
        RuntimeError,
        EOFError,
    ) as exc:
        raise ImageRejected(
            "This photo could not be decoded safely. Export it as a JPEG or PNG and try again."
        ) from exc
