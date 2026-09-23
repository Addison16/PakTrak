"""CPU-only OCR retrieval with local metadata and cached artwork verification.

Retrieval scores describe similarity, NOT calibrated exact-printing probability.
No reference artwork or phone photos are sent to an OCR/cloud inference service.
"""

import difflib
import io
import logging
import re
import subprocess
import time
import unicodedata
from collections import defaultdict

import cv2
import numpy as np
from PIL import Image, ImageOps
from sqlalchemy import select

from scanner.card_images import load_image
from scanner.db import session_factory
from scanner.image_enhancement import (
    EXTRA_SECONDS,
    prefer_enhanced,
    prepare_text,
    remaining_timeout,
    strong_result,
)
from scanner.image_enhancement import VERSION as ENHANCEMENT_VERSION
from scanner.models import Printing, now

VERSION = "tesseract-sift-v1"
ENHANCED_VERSION = "tesseract-sift-cpu-enhanced-v1"
logger = logging.getLogger(__name__)
_catalog = None
_catalog_at = 0


def normalized(value):
    return "".join(c for c in unicodedata.normalize("NFKD", value).lower() if c.isalnum())


def catalog_index():
    global _catalog, _catalog_at
    if _catalog is None or time.monotonic() - _catalog_at > 300:
        by_name = defaultdict(list)
        with session_factory()() as db:
            for row in db.execute(
                select(
                    Printing.id,
                    Printing.name,
                    Printing.set_code,
                    Printing.collector_number,
                    Printing.language,
                )
            ):
                if row.language != "en":
                    continue
                record = dict(row._mapping)
                for name in row.name.split(" // "):
                    by_name[normalized(name)].append(record)
        _catalog, _catalog_at = dict(by_name), time.monotonic()
    return _catalog


def read_text(image, box, psm=7, invert=False, *, enhance=False, deadline=None):
    remaining_timeout(deadline, 3)
    if enhance:
        part = prepare_text(image, box, invert)
    else:
        part = ImageOps.autocontrast(image.convert("L").crop(box))
        part = part.resize((part.width * 2, part.height * 2), Image.Resampling.LANCZOS)
        if invert:
            part = ImageOps.invert(part)
        part = ImageOps.expand(part, border=12, fill="white")
    output = io.BytesIO()
    part.save(output, "PNG")
    result = subprocess.run(
        ["tesseract", "stdin", "stdout", "-l", "eng", "--psm", str(psm)],
        input=output.getvalue(),
        capture_output=True,
        timeout=remaining_timeout(deadline, 3 if enhance else 5),
        check=True,
    )
    return result.stdout.decode("utf-8", errors="replace").strip()[:4000]


def name_matches(titles, index):
    scores = {}
    # Try word boundaries to discard mana symbols and border OCR noise. Keep
    # fuzzy alternatives, including spacing errors, but never force a match.
    for title in titles:
        words = re.findall(r"[\w.'’-]+", title, re.UNICODE)[:12]
        while words and (len(normalized(words[-1])) <= 2 or normalized(words[-1]).isdigit()):
            words.pop()
        while words and len(normalized(words[0])) <= 1:
            words.pop(0)
        whole = normalized(" ".join(words))
        queries = {whole}
        for start in range(min(2, len(words))):
            for end in range(max(start + 1, len(words) - 3), len(words) + 1):
                queries.add(normalized(" ".join(words[start:end])))
        for query in queries:
            if len(query) < 4:
                continue
            if query in index:
                # A shorter word inside a longer title ("Drone" inside "Ultron
                # Drone") is not an exact full-name match.
                scores[query] = max(scores.get(query, 0), min(1, len(query) / max(1, len(whole))))
        # One fuzzy lookup per title, trimming obvious trailing mana digits.
        query = whole
        if len(query) >= 5 and query not in index:
            for name in difflib.get_close_matches(query, index.keys(), n=4, cutoff=0.60):
                score = difflib.SequenceMatcher(None, query, name).ratio()
                scores[name] = max(scores.get(name, 0), score)
    return sorted(scores.items(), key=lambda item: -item[1])[:4]


def visual_features(data):
    image = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_GRAYSCALE)
    if image is None:
        return None
    image = cv2.resize(image, (420, 588))
    # Compare artwork, excluding the shared text/frame that causes false matches.
    image = image[78:325, 28:392]
    image = cv2.createCLAHE(clipLimit=2, tileGridSize=(8, 8)).apply(image)
    return cv2.SIFT_create(nfeatures=700).detectAndCompute(image, None)


def visual_agreement(query, data):
    reference = visual_features(data)
    if not query or not reference or query[1] is None or reference[1] is None:
        return 0
    pairs = cv2.BFMatcher().knnMatch(query[1], reference[1], k=2)
    good = [
        a for pair in pairs if len(pair) == 2 for a, b in [pair] if a.distance < 0.70 * b.distance
    ]
    if len(good) < 6:
        return 0
    source = np.float32([query[0][m.queryIdx].pt for m in good])
    target = np.float32([reference[0][m.trainIdx].pt for m in good])
    _, mask = cv2.findHomography(source, target, cv2.RANSAC, 3)
    if mask is None:
        return 0
    inliers = int(mask.sum())
    return inliers if inliers >= 6 and inliers / len(good) >= 0.5 else 0


def recognize(data, set_hint=None, orientation=None, *, enhanced=False, enhanced_image=None):
    started = time.monotonic()
    standard = _recognize(data, set_hint, orientation)
    if not enhanced:
        return standard
    metadata = {"enabled": True, "version": ENHANCEMENT_VERSION, "attempted": False, "used": False}
    if strong_result(standard):
        return {**standard, "enhancement": {**metadata, "outcome": "skipped_strong_match"}}
    # Keep a comfortable margin inside the worker's 45-second soft deadline.
    if time.monotonic() - started > 30:
        return {**standard, "enhancement": {**metadata, "outcome": "skipped_time_budget"}}
    extra_started = time.monotonic()
    metadata["attempted"] = True
    try:
        # Read finer source pixels only after the unchanged baseline needs help.
        # This also keeps an ambiguous high-resolution crop from replacing a
        # stronger ordinary result merely because it was resized differently.
        detailed = enhanced_image() if enhanced_image else data
        alternative = _recognize(
            detailed, set_hint, orientation, enhance=True, deadline=extra_started + EXTRA_SECONDS
        )
        used = prefer_enhanced(standard, alternative)
        result = alternative if used else standard
        metadata.update({"used": used, "outcome": "used" if used else "kept_standard"})
    except Exception as exc:
        # Do not put OCR text, paths, images or provider exception messages in logs.
        logger.warning(
            "Extra OCR pass failed; standard result retained type=%s", type(exc).__name__
        )
        result = standard
        metadata["outcome"] = "fallback"
    metadata["extra_seconds"] = round(time.monotonic() - extra_started, 3)
    return {**result, "enhancement": metadata}


def _recognize(data, set_hint=None, orientation=None, *, enhance=False, deadline=None):
    cv2.setNumThreads(1)
    source = Image.open(io.BytesIO(data)).convert("RGB")
    image = source.resize((600, 840))
    text_image = source if enhance else image
    version = ENHANCED_VERSION if enhance else VERSION
    rotation = orientation or 0
    if rotation == 180:
        image = image.transpose(Image.Transpose.ROTATE_180)
        text_image = text_image.transpose(Image.Transpose.ROTATE_180)
    index = catalog_index()
    if not index:
        return {
            "status": "NO_MATCH",
            "version": version,
            "candidates": [],
            "reason": "The card catalog is still loading. Retry identification once it is ready.",
            "rotation": rotation,
        }

    def read(view, box, psm=7, invert=False):
        return read_text(view, box, psm, invert, enhance=enhance, deadline=deadline)

    titles = [read(text_image, (27, 32, 540, 92)), read(text_image, (30, 38, 510, 77))]
    matches = name_matches(titles, index)
    if orientation is None and (not matches or matches[0][1] < 0.80):
        flipped = text_image.rotate(180)
        title = read(flipped, (27, 32, 540, 92))
        flipped_matches = name_matches([title], index)
        if flipped_matches and (not matches or flipped_matches[0][1] > matches[0][1]):
            image, text_image, titles, matches, rotation = (
                image.rotate(180),
                flipped,
                [title],
                flipped_matches,
                180,
            )
    footer = read(text_image, (9, 758, 400, 831), psm=6, invert=True)
    footer_words = set(re.findall(r"[A-Z]{2,6}", footer.upper()))
    footer_numbers = set(re.findall(r"(?<![A-Za-z0-9])[0-9]{2,5}(?![A-Za-z0-9])", footer))
    numbers = {str(int(number)) for number in footer_numbers}
    candidates = {}
    for name, score in matches:
        for row in index[name]:
            set_agrees = row["set_code"].upper() in footer_words
            number_agrees = row["collector_number"].lstrip("0") in numbers
            hint = set_hint and row["set_code"] in {set_hint, "t" + set_hint}
            rank = 0.65 * score + 0.14 * set_agrees + 0.09 * number_agrees + 0.04 * bool(hint)
            evidence = ["Card name matches" if score == 1 else "Card name is similar"]
            if set_agrees:
                evidence.append("Set code read from photo")
            if number_agrees:
                evidence.append("Collector number read from photo")
            if hint and not set_agrees:
                evidence.append("Set suggested by other cards in this photo")
            value = {
                "printing_id": str(row["id"]),
                "match_score": round(rank, 3),
                "evidence": evidence,
                "name_score": score,
                "set_read": row["set_code"] if set_agrees else None,
                "identifiers_agree": bool(set_agrees and number_agrees),
                "visual_inliers": 0,
            }
            if rank > candidates.get(value["printing_id"], {}).get("match_score", -1):
                candidates[value["printing_id"]] = value
    ranked = sorted(candidates.values(), key=lambda c: (-c["match_score"], c["printing_id"]))[:4]
    query_data = io.BytesIO()
    image.save(query_data, "JPEG", quality=95)
    query = visual_features(query_data.getvalue())
    for candidate in ranked:
        timeout = remaining_timeout(deadline, 3)
        with session_factory()() as db:
            card = db.get(Printing, candidate["printing_id"])
            db.expunge(card)
        try:
            reference, _, _ = load_image(card, timeout=timeout)
            count = visual_agreement(query, reference)
        except Exception:
            # Missing/offline reference art must not throw away readable text.
            count = 0
        candidate["visual_inliers"] = count
        if count:
            candidate["match_score"] = round(
                min(0.99, candidate["match_score"] + 0.12 * min(count / 20, 1)), 3
            )
            candidate["evidence"].append("Artwork features match")
    ranked.sort(key=lambda c: (-c["match_score"], -c["visual_inliers"], c["printing_id"]))
    # Avoid suggesting unrelated fuzzy words without visual support.
    ranked = [c for c in ranked if c["name_score"] >= 0.78 or c["visual_inliers"] >= 8][:3]
    if ranked:
        ranked = [c for c in ranked if c["match_score"] >= ranked[0]["match_score"] - 0.15]
    reason = "Check the set, collector number and finish before approving."
    if not ranked:
        reason = "No reliable suggestion yet. Edit the crop or search for the card."
    elif len(ranked) > 1 and ranked[0]["match_score"] - ranked[1]["match_score"] < 0.04:
        reason = "The card name is similar across several printings. Check the printing."
    remaining_timeout(deadline, 3)
    return {
        "status": "MATCHED" if ranked else "NO_MATCH",
        "version": version,
        "candidates": ranked,
        "p_exact": None,
        "qualification": None,
        "reason": reason,
        "title_text": titles,
        "footer_text": footer,
        "rotation": rotation,
        "processed_at": now().isoformat(),
    }
