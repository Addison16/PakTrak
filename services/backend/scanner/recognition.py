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
from sqlalchemy import func, select

from scanner.card_images import load_image
from scanner.card_search import card_names
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

VERSION = "tesseract-sift-v3"
ENHANCED_VERSION = "tesseract-sift-cpu-enhanced-v3"
logger = logging.getLogger(__name__)
_catalog = None
_identifiers = None
_numbers = None
_catalog_at = 0
# Boxes describe a 600×840 card crop.
TITLE_BOXES = ((27, 32, 540, 92), (30, 38, 510, 77))
# Sleeves and generous outlines leave a margin above the card, so its title
# sits lower in the crop. These strips are read only when no confident name
# was found at the usual position.
LOWER_TITLE_BOXES = ((27, 56, 560, 116), (27, 80, 560, 140))
FOOTER_BOX = (9, 758, 400, 831)
CONFIDENT_NAME = 0.80
FLIP_NAME = 0.70
# A collector number without its set code needs this much of the title.
NUMBERED_TITLE = 0.50
# Common OCR confusions in the small footer font, compared in digit form.
LOOKALIKES = str.maketrans("OQDILSBZ|", "001115821")


def normalized(value):
    return "".join(c for c in unicodedata.normalize("NFKD", value).lower() if c.isalnum())


def catalog_index():
    global _catalog, _identifiers, _numbers, _catalog_at
    if _catalog is None or time.monotonic() - _catalog_at > 300:
        by_name = defaultdict(list)
        by_identifier = defaultdict(list)
        by_number = defaultdict(list)
        with session_factory()() as db:
            for row in db.execute(
                select(
                    Printing.id,
                    Printing.name,
                    Printing.set_code,
                    Printing.collector_number,
                    Printing.language,
                    func.jsonb_build_object(
                        "printed_name",
                        Printing.source_json["printed_name"],
                        "flavor_name",
                        Printing.source_json["flavor_name"],
                        "card_faces",
                        Printing.source_json["card_faces"],
                    ).label("source_names"),
                )
            ):
                record = dict(row._mapping)
                source = record.pop("source_names")
                for name in {normalized(name) for name in card_names(row.name, source)} - {""}:
                    by_name[name].append(record)
                # Printed footers show plain numbers; letter-suffixed promos are
                # left to the name search.
                number = row.collector_number.lstrip("0")
                if number.isdigit():
                    by_identifier[row.set_code.upper().translate(LOOKALIKES), number].append(record)
                    by_number[number].append(record)
        _catalog, _identifiers, _numbers = dict(by_name), dict(by_identifier), dict(by_number)
        _catalog_at = time.monotonic()
    return _catalog


def identifier_index():
    catalog_index()
    return _identifiers or {}, _numbers or {}


def footer_codes(footer):
    """Possible set codes: whole words, plus the start of the word printed
    before the language code, where a smudge can run into it ("IMAce EN")."""
    text = footer.upper()
    codes = set(re.findall(r"(?<![A-Z0-9])[A-Z0-9]{2,6}(?![A-Z0-9])", text))
    for word in re.findall(r"(?<![A-Z0-9])([A-Z0-9]{4,8})\W{0,3}EN(?![A-Z0-9])", text):
        codes.update(word[:size] for size in range(3, len(word)))
    return codes


def footer_numbers(footer):
    """Collector numbers from "171/269 C" and "R 0282" footers, allowing O/0 slips."""
    numbers = set()
    for token in re.findall(r"[A-Z0-9|]+", footer.upper()):
        for part in (token, token[1:] if token[0].isalpha() and len(token) >= 4 else ""):
            digits = part.translate(LOOKALIKES)
            if 2 <= len(part) <= 5 and digits.isdigit() and sum(c.isdigit() for c in part) >= 2:
                number = digits.lstrip("0")
                # Skip copyright years; collector numbers are zero-padded.
                if number and not (len(part) == 4 and 1990 <= int(number) <= 2039):
                    numbers.add(number)
    return numbers


def code_agrees(code, tokens):
    # Digits count (M15, C18, MH3), and lookalike letters compare as digits.
    code = code.upper().translate(LOOKALIKES)
    return any(token.translate(LOOKALIKES) == code for token in tokens)


def footer_printings(tokens, numbers, titles):
    """Printings identified by a footer, with how closely each matches the title.

    A set code and collector number together identify a printing. A number
    alone only narrows the search to cards whose title is similar.
    """
    by_identifier, by_number = identifier_index()
    codes = {token.translate(LOOKALIKES) for token in tokens}
    similarity = {}

    def similar(row):
        if row["name"] not in similarity:
            similarity[row["name"]] = round(title_similarity(titles, row["name"]), 3)
        return similarity[row["name"]]

    found = {}
    for number in numbers:
        for code in codes:
            for row in by_identifier.get((code, number), []):
                found[str(row["id"])] = (row, similar(row))
        for row in by_number.get(number, []):
            if str(row["id"]) not in found and similar(row) >= NUMBERED_TITLE:
                found[str(row["id"])] = (row, similar(row))
    return list(found.values())


def title_similarity(titles, name):
    """How much of a card name appears, in order, in the OCR title, with extra text counting against it."""
    best = 0
    for target in {normalized(part) for part in [name, *name.split(" // ")]} - {""}:
        for title in titles:
            query = normalized(title)
            if query:
                blocks = difflib.SequenceMatcher(None, query, target).get_matching_blocks()
                best = max(best, sum(block.size for block in blocks) / max(len(target), len(query)))
    return best


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
        while words and len(normalized(words[0])) <= 1:
            words.pop(0)
        # Short trailing words are usually mana symbols, but a few names end
        # with one ("Bulk Up"). Those can still match a full name exactly.
        complete = words[:]
        while words and (len(normalized(words[-1])) <= 2 or normalized(words[-1]).isdigit()):
            words.pop()
        whole = normalized(" ".join(words))
        queries = {whole}
        for sequence in (words, complete):
            for start in range(min(2, len(sequence))):
                for end in range(max(start + 1, len(sequence) - 3), len(sequence) + 1):
                    queries.add(normalized(" ".join(sequence[start:end])))
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
    # On a tie, the longer exact name used more of the text that was read.
    return sorted(scores.items(), key=lambda item: (-item[1], -len(item[0])))[:4]


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

    def strength(found):
        return found[0][1] if found else 0

    titles = [read(text_image, box) for box in TITLE_BOXES]
    matches = name_matches(titles, index)
    flipped = text_image.rotate(180) if orientation is None else None
    flipped_titles, flipped_matches = [], []
    if flipped is not None and strength(matches) < CONFIDENT_NAME:
        flipped_titles.append(read(flipped, TITLE_BOXES[0]))
        flipped_matches = name_matches(flipped_titles, index)
    for box in LOWER_TITLE_BOXES:
        if max(strength(matches), strength(flipped_matches)) >= CONFIDENT_NAME:
            break
        titles.append(read(text_image, box))
        matches = name_matches(titles, index)
    for box in LOWER_TITLE_BOXES if flipped is not None else ():
        if max(strength(matches), strength(flipped_matches)) >= CONFIDENT_NAME:
            break
        flipped_titles.append(read(flipped, box))
        flipped_matches = name_matches(flipped_titles, index)
    # Junk text can fuzzily resemble a name either way up. Only a plausible
    # name read upside down justifies turning the card.
    if strength(flipped_matches) > max(strength(matches), FLIP_NAME):
        image, text_image, titles, matches, rotation = (
            image.rotate(180),
            flipped,
            flipped_titles,
            flipped_matches,
            180,
        )
    footer = read(text_image, FOOTER_BOX, psm=6, invert=True)
    codes, numbers = footer_codes(footer), footer_numbers(footer)

    def score_printing(row, score, *, named=True):
        set_agrees = code_agrees(row["set_code"], codes)
        number_agrees = row["collector_number"].lstrip("0") in numbers
        hint = set_hint and row["set_code"] in {set_hint, "t" + set_hint}
        rank = 0.65 * score + 0.14 * set_agrees + 0.09 * number_agrees + 0.04 * bool(hint)
        evidence = []
        if named or score >= 0.78:
            evidence.append("Card name matches" if score == 1 else "Card name is similar")
        if set_agrees:
            evidence.append("Set code read from photo")
        if number_agrees:
            evidence.append("Collector number read from photo")
        if hint and not set_agrees:
            evidence.append("Set suggested by other cards in this photo")
        return {
            "printing_id": str(row["id"]),
            "match_score": round(rank, 3),
            "evidence": evidence,
            "name_score": score,
            "set_read": row["set_code"] if set_agrees else None,
            "identifiers_agree": bool(set_agrees and number_agrees),
            "visual_inliers": 0,
        }

    candidates = {}
    for name, score in matches:
        for row in index[name]:
            value = score_printing(row, score)
            if value["match_score"] > candidates.get(value["printing_id"], {}).get(
                "match_score", -1
            ):
                candidates[value["printing_id"]] = value
    ranked = sorted(candidates.values(), key=lambda c: (-c["match_score"], c["printing_id"]))[:4]
    # A readable set code and collector number identify a printing even when
    # the title is unreadable. Artwork or the title must still corroborate it.
    footer_found = [
        score_printing(row, similarity, named=False)
        for row, similarity in footer_printings(codes, numbers, titles)
        if str(row["id"]) not in candidates
    ]
    footer_found = sorted(footer_found, key=lambda c: (-c["match_score"], c["printing_id"]))[:2]
    for value in footer_found:
        value["footer_match"] = True
    ranked += footer_found
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
