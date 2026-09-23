"""Orientation relative to the immutable, perspective-corrected card crop."""

import io

from PIL import Image


def manual_rotation(result):
    value = result.get("_orientation")
    return value if type(value) is int and value in {0, 180} else None


def display_rotation(result):
    manual = manual_rotation(result)
    return manual if manual is not None else (180 if result.get("rotation") == 180 else 0)


def oriented_crop(data, rotation):
    if rotation != 180:
        return data
    # Always read the original crop: repeated flips never accumulate JPEG loss.
    with Image.open(io.BytesIO(data)) as image:
        image = image.transpose(Image.Transpose.ROTATE_180)
        output = io.BytesIO()
        image.save(output, "JPEG", quality=95)
        return output.getvalue()
