"""Bounded CPU preprocessing for OCR strips; never replaces uploaded photos."""

import time

import cv2
import numpy as np
from PIL import Image, ImageFilter, ImageOps

VERSION = "cpu-text-v2"
EXTRA_SECONDS = 8.0


def remaining_timeout(deadline, maximum):
    if deadline is None:
        return maximum
    remaining = deadline - time.monotonic()
    if remaining <= 0.05:
        raise TimeoutError("Enhancement time budget exhausted")
    return min(maximum, remaining)


def dark_background(part):
    # Text covers far less of a strip than its background, so the median is
    # the background. Old black frames, showcase and borderless titles print
    # light text, which Tesseract reads far better once inverted.
    return float(np.median(np.asarray(part))) < 110


def prepare_text(image, box, invert=False):
    # Coordinates describe a 600×840 card. A 1200×1680 crop retains actual
    # source pixels instead of first shrinking away its finer printed text.
    sx, sy = image.width / 600, image.height / 840
    bounds = tuple(round(value * (sx if i % 2 == 0 else sy)) for i, value in enumerate(box))
    part = image.crop(bounds).convert("L")
    width, height = (box[2] - box[0]) * 3, (box[3] - box[1]) * 3
    if not (1 <= width <= 1800 and 1 <= height <= 2520):
        raise ValueError("OCR strip exceeds enhancement limits")
    pixels = cv2.bilateralFilter(np.asarray(part), 5, 20, 3)
    pixels = cv2.createCLAHE(clipLimit=1.5, tileGridSize=(8, 2)).apply(pixels)
    part = ImageOps.autocontrast(Image.fromarray(pixels)).resize(
        (width, height), Image.Resampling.LANCZOS
    )
    part = part.filter(ImageFilter.UnsharpMask(radius=1, percent=90, threshold=3))
    if dark_background(part) if invert is None else invert:
        part = ImageOps.invert(part)
    return ImageOps.expand(part, border=12, fill="white")


def prefer_enhanced(standard, enhanced):
    """A competing printing needs stronger text AND corroborating artwork."""
    before, after = standard.get("candidates", []), enhanced.get("candidates", [])
    if not after:
        return False
    if not before:
        return True
    old, new = before[0], after[0]
    if old["printing_id"] == new["printing_id"]:
        return new["match_score"] > old["match_score"]
    return (
        new["match_score"] >= old["match_score"] + 0.04
        and new.get("visual_inliers", 0) >= max(8, old.get("visual_inliers", 0))
        and new.get("name_score", 0) >= old.get("name_score", 0)
    )


def strong_result(result):
    candidates = result.get("candidates", [])
    if not candidates:
        return False
    top = candidates[0]
    return (
        top["match_score"] >= 0.92
        and top.get("name_score", 0) == 1
        and top.get("identifiers_agree", False)
        and top.get("visual_inliers", 0) >= 8
        and (len(candidates) == 1 or top["match_score"] - candidates[1]["match_score"] >= 0.04)
    )
