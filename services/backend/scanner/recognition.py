"""CPU-only OCR retrieval with local metadata and cached artwork verification.

Retrieval scores describe similarity, NOT calibrated exact-printing probability.
No reference artwork or phone photos are sent to an OCR/cloud inference service.
"""

import difflib
import io
import logging
import os
import re
import subprocess
import threading
import time
import unicodedata
from collections import OrderedDict, defaultdict
from concurrent.futures import ThreadPoolExecutor

import cv2
import numpy as np
from PIL import Image, ImageOps
from sqlalchemy import func, select

from scanner.card_images import load_image, source_image
from scanner.card_search import card_names
from scanner.db import session_factory
from scanner.image_enhancement import (
    EXTRA_SECONDS,
    dark_background,
    prefer_enhanced,
    prepare_text,
    remaining_timeout,
    strong_result,
)
from scanner.image_enhancement import VERSION as ENHANCEMENT_VERSION
from scanner.models import CatalogSnapshot, Printing, now

VERSION = "tesseract-sift-v4"
ENHANCED_VERSION = "tesseract-sift-cpu-enhanced-v4"
logger = logging.getLogger(__name__)
_catalog = None
_identifiers = None
_numbers = None
_catalog_at = 0
_catalog_fingerprint = None
# Fuzzy title lookups compare with only the catalog names sharing the most
# letter pairs, instead of every name. This many keeps every match strong
# enough to be suggested on its own, at a fraction of the cost.
FUZZY_SHORTLIST = 2000
_fuzzy = None
_title_scores = OrderedDict()
_title_scores_index = None
# Reference artwork features, by image URL. About 0.4 MB each.
REFERENCE_CACHE = 128
_references = OrderedDict()
_references_lock = threading.Lock()
# Tesseract runs as a separate process, so independent strips can be read at
# once. Artwork comparison also releases the GIL inside OpenCV.
_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="recognition")
# When a name has many printings and the footer is unreadable, compare this
# many distinct artworks rather than the first few printings by ID.
DISTINCT_ARTWORKS = 8
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


def catalog_fingerprint(db):
    # Every catalog import writes a snapshot. The printing count also notices
    # rows added outside an import.
    return (
        db.scalar(select(func.count()).select_from(Printing)),
        *db.execute(
            select(func.count(), func.max(CatalogSnapshot.created_at)).select_from(CatalogSnapshot)
        ).one(),
    )


def catalog_index():
    global _catalog, _identifiers, _numbers, _catalog_at, _catalog_fingerprint, _fuzzy
    if _catalog is not None and time.monotonic() - _catalog_at <= 300:
        return _catalog
    with session_factory()() as db:
        fingerprint = catalog_fingerprint(db)
        if _catalog is not None and fingerprint == _catalog_fingerprint:
            # Unchanged: skip rereading every printing.
            _catalog_at = time.monotonic()
            return _catalog
        by_name = defaultdict(list)
        by_identifier = defaultdict(list)
        by_number = defaultdict(list)
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
                    "illustration_id",
                    Printing.source_json["illustration_id"],
                ).label("source_names"),
            )
        ):
            record = dict(row._mapping)
            source = record.pop("source_names")
            record["artwork"] = artwork_key(row.id, source)
            for name in {normalized(name) for name in card_names(row.name, source)} - {""}:
                by_name[name].append(record)
            # Printed footers show plain numbers; letter-suffixed promos are
            # left to the name search.
            number = row.collector_number.lstrip("0")
            if number.isdigit():
                by_identifier[row.set_code.upper().translate(LOOKALIKES), number].append(record)
                by_number[number].append(record)
    _catalog, _identifiers, _numbers = dict(by_name), dict(by_identifier), dict(by_number)
    _catalog_fingerprint, _fuzzy = fingerprint, None
    _title_scores.clear()
    _catalog_at = time.monotonic()
    return _catalog


def artwork_key(printing_id, source):
    """Printings that share an illustration look alike to the artwork check."""
    faces = source.get("card_faces") or [{}]
    value = source.get("illustration_id") or (faces[0] or {}).get("illustration_id")
    return value if isinstance(value, str) and value else str(printing_id)


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


def read_text(image, box, psm=7, invert=None, *, enhance=False, deadline=None):
    """invert=None reads light text on a dark strip as dark text on light."""
    remaining_timeout(deadline, 3)
    if enhance:
        part = prepare_text(image, box, invert)
    else:
        part = ImageOps.autocontrast(image.convert("L").crop(box))
        part = part.resize((part.width * 2, part.height * 2), Image.Resampling.LANCZOS)
        if dark_background(part) if invert is None else invert:
            part = ImageOps.invert(part)
        part = ImageOps.expand(part, border=12, fill="white")
    output = io.BytesIO()
    part.save(output, "PNG")
    result = subprocess.run(
        ["tesseract", "stdin", "stdout", "-l", "eng", "--psm", str(psm)],
        input=output.getvalue(),
        capture_output=True,
        # Strips are read in parallel; one thread each avoids oversubscription.
        env={**os.environ, "OMP_THREAD_LIMIT": "1"},
        timeout=remaining_timeout(deadline, 3 if enhance else 5),
        check=True,
    )
    return result.stdout.decode("utf-8", errors="replace").strip()[:4000]


def pairs(value):
    return {value[i : i + 2] for i in range(len(value) - 1)} or {value}


def fuzzy_index(index):
    global _fuzzy
    if _fuzzy is None or _fuzzy[0] is not index:
        names = list(index)
        postings = defaultdict(list)
        sizes = np.empty(len(names), dtype=np.float32)
        for position, name in enumerate(names):
            found = pairs(name)
            sizes[position] = len(found)
            for pair in found:
                postings[pair].append(position)
        postings = {pair: np.asarray(ids, dtype=np.int32) for pair, ids in postings.items()}
        _fuzzy = (index, names, postings, sizes)
    return _fuzzy


def close_names(query, index):
    """difflib.get_close_matches over the names most like the query."""
    _, names, postings, sizes = fuzzy_index(index)
    found = pairs(query)
    lists = [postings[pair] for pair in found if pair in postings]
    if not lists:
        return []
    shared = np.bincount(np.concatenate(lists), minlength=len(names))
    similarity = 2 * shared / (sizes + len(found))
    if len(names) > FUZZY_SHORTLIST:
        shortlist = np.argpartition(-similarity, FUZZY_SHORTLIST)[:FUZZY_SHORTLIST]
    else:
        shortlist = np.arange(len(names))
    shortlist = [names[i] for i in shortlist if shared[i]]
    return difflib.get_close_matches(query, shortlist, n=4, cutoff=0.60)


def title_scores(title, index):
    # Hard cards read several strips, and each new strip used to repeat the
    # fuzzy search for every earlier one. Remember results per title.
    global _title_scores_index
    if _title_scores_index is not index:
        _title_scores.clear()
        _title_scores_index = index
    key = title
    if key in _title_scores:
        _title_scores.move_to_end(key)
        return _title_scores[key]
    scores = {}
    # Try word boundaries to discard mana symbols and border OCR noise. Keep
    # fuzzy alternatives, including spacing errors, but never force a match.
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
        for name in close_names(query, index):
            score = difflib.SequenceMatcher(None, query, name).ratio()
            scores[name] = max(scores.get(name, 0), score)
    _title_scores[key] = scores
    while len(_title_scores) > 512:
        _title_scores.popitem(last=False)
    return scores


def name_matches(titles, index):
    scores = {}
    for title in titles:
        for name, score in title_scores(title, index).items():
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
    keypoints, descriptors = cv2.SIFT_create(nfeatures=700).detectAndCompute(image, None)
    # Points rather than OpenCV keypoints, so features can be cached.
    return np.float32([point.pt for point in keypoints]).reshape(-1, 2), descriptors


def features_agree(query, reference):
    if not query or not reference or query[1] is None or reference[1] is None:
        return 0
    pairs = cv2.BFMatcher().knnMatch(query[1], reference[1], k=2)
    good = [
        a for pair in pairs if len(pair) == 2 for a, b in [pair] if a.distance < 0.70 * b.distance
    ]
    if len(good) < 6:
        return 0
    source = query[0][[m.queryIdx for m in good]]
    target = reference[0][[m.trainIdx for m in good]]
    _, mask = cv2.findHomography(source, target, cv2.RANSAC, 3)
    if mask is None:
        return 0
    inliers = int(mask.sum())
    return inliers if inliers >= 6 and inliers / len(good) >= 0.5 else 0


def visual_agreement(query, data):
    return features_agree(query, visual_features(data))


def reference_features(card, timeout):
    """Artwork features of a catalog image, computed once per worker."""
    key = source_image(card, 0, "grid")
    with _references_lock:
        if key and key in _references:
            _references.move_to_end(key)
            return _references[key]
    reference, _, _ = load_image(card, timeout=timeout)
    features = visual_features(reference)
    if key and features is not None:
        with _references_lock:
            _references[key] = features
            while len(_references) > REFERENCE_CACHE:
                _references.popitem(last=False)
    return features


def catalog_cards(ids):
    """Detached printings by ID, in one query."""
    if not ids:
        return {}
    with session_factory()() as db:
        cards = {
            str(card.id): card for card in db.scalars(select(Printing).where(Printing.id.in_(ids)))
        }
        db.expunge_all()
    return cards


def artwork_agreement(query, card, timeout):
    try:
        return features_agree(query, reference_features(card, timeout))
    except Exception:
        # Missing/offline reference art must not throw away readable text.
        return 0


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

    def read(view, box, psm=7, invert=None):
        return read_text(view, box, psm, invert, enhance=enhance, deadline=deadline)

    def strength(found):
        return found[0][1] if found else 0

    # Read both title strips and the footer at once. Most cards are upright,
    # so the footer read is rarely wasted; a turned card reads it again.
    title_reads = [_pool.submit(read, text_image, box) for box in TITLE_BOXES]
    upright_footer = _pool.submit(read, text_image, FOOTER_BOX, 6, True)
    titles = [future.result() for future in title_reads]
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
    if rotation == (orientation or 0):
        footer = upright_footer.result()
    else:
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

    candidates, artwork = {}, {}
    for name, score in matches:
        for row in index[name]:
            value = score_printing(row, score)
            artwork[value["printing_id"]] = row.get("artwork", value["printing_id"])
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
    # Without a readable footer, a name with many printings used to compare
    # only the first few by ID, which may all share one artwork. Also compare
    # one printing of each other artwork, so the matching art can rise.
    extras = []
    if not any(c["identifiers_agree"] for c in ranked):
        seen = {artwork.get(c["printing_id"], c["printing_id"]) for c in ranked}
        for value in sorted(
            candidates.values(), key=lambda c: (-c["match_score"], c["printing_id"])
        ):
            if len(seen) >= DISTINCT_ARTWORKS:
                break
            if value["name_score"] >= 0.78 and artwork[value["printing_id"]] not in seen:
                seen.add(artwork[value["printing_id"]])
                extras.append(value)
    query_data = io.BytesIO()
    image.save(query_data, "JPEG", quality=95)
    query = visual_features(query_data.getvalue())
    cards = catalog_cards([c["printing_id"] for c in ranked + extras])
    checks = []
    for extra, candidate in [(False, c) for c in ranked] + [(True, c) for c in extras]:
        if extra and deadline is not None and deadline - time.monotonic() < 1:
            break  # Optional comparisons never use up the enhancement budget.
        timeout = remaining_timeout(deadline, 3)
        card = cards.get(candidate["printing_id"])
        future = _pool.submit(artwork_agreement, query, card, timeout) if card else None
        checks.append((extra, candidate, future))
    for _, candidate, future in checks:
        count = future.result() if future else 0
        candidate["visual_inliers"] = count
        if count:
            candidate["match_score"] = round(
                min(0.99, candidate["match_score"] + 0.12 * min(count / 20, 1)), 3
            )
            candidate["evidence"].append("Artwork features match")
    ranked += [candidate for extra, candidate, _ in checks if extra]
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
