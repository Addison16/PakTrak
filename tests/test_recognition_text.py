import difflib
import io

import cv2
import numpy as np
from PIL import Image

from scanner import recognition


def jpeg(image):
    output = io.BytesIO()
    image.save(output, "JPEG", quality=95)
    return output.getvalue()


def test_footer_numbers_cover_both_frame_styles_and_common_ocr_slips():
    assert recognition.footer_numbers("171/269 C\nAKH • EN") == {"171", "269"}
    assert recognition.footer_numbers("R 0282\nINR + EN") == {"282"}
    # Rarity letters run into the number, and 0 is read as O or Q.
    assert recognition.footer_numbers("RO380 FFVII") == {"380"}
    assert recognition.footer_numbers("Q193\nNO .EN") == {"193"}
    assert recognition.footer_numbers("™ & © 2025 Wizards of the Coast") == set()
    assert recognition.footer_numbers("SOI + EN") == set()


def test_set_codes_with_digits_and_lookalike_letters_agree():
    assert recognition.code_agrees("c18", recognition.footer_codes("131/307 R\nC18+ EN"))
    assert recognition.code_agrees("m15", recognition.footer_codes("172/269 R\nM1S+EN"))
    assert recognition.code_agrees("soi", recognition.footer_codes("276/297 R\nSOl+ EN"))
    assert recognition.code_agrees("ima", recognition.footer_codes("IMAce EN"))
    assert not recognition.code_agrees("dom", recognition.footer_codes("M19 + EN"))
    # Artist names are separate words, not set codes with trailing smudges.
    assert not recognition.code_agrees("mar", recognition.footer_codes("MARK POOLE"))


def test_footer_finds_printing_from_set_and_number_or_number_with_similar_title(monkeypatch):
    rockfall = {"id": "a", "name": "Rockfall Vale", "set_code": "inr", "collector_number": "282"}
    haze = {"id": "b", "name": "Haze of Pollen", "set_code": "akh", "collector_number": "171"}
    other = {"id": "c", "name": "Lightning Bolt", "set_code": "m10", "collector_number": "171"}
    code = "INR".translate(recognition.LOOKALIKES)
    by_identifier = {(code, "282"): [rockfall]}
    by_number = {"282": [rockfall], "171": [haze, other]}
    monkeypatch.setattr(recognition, "identifier_index", lambda: (by_identifier, by_number))
    found = recognition.footer_printings({"INR", "EN"}, {"282"}, ["GEA MS SL"])
    assert [row["id"] for row, _ in found] == ["a"]
    found = recognition.footer_printings({"CC", "IM"}, {"171", "269"}, ["be of rolien Ww"])
    assert [row["id"] for row, _ in found] == ["b"]
    assert recognition.footer_printings(set(), {"171"}, [""]) == []


def test_names_ending_in_a_short_word_still_match_exactly():
    index = {"bulkup": [], "bulk": []}
    assert recognition.name_matches(["Bulk Up og"], index)[0] == ("bulkup", 1)


def marked_card():
    # A red corner block shows whether a text strip came from the flipped card.
    image = Image.new("RGB", (600, 840), "black")
    image.paste((255, 0, 0), (0, 0, 40, 40))
    return image


def test_sleeved_title_is_read_lower_only_after_the_usual_strip_fails(monkeypatch):
    monkeypatch.setattr(recognition, "catalog_index", lambda: {"bulkup": []})
    monkeypatch.setattr(recognition, "identifier_index", lambda: ({}, {}))
    calls, lowered = [], recognition.LOWER_TITLE_BOXES[0]

    def read(image, box, *args, **kwargs):
        calls.append(box)
        return "Bulk Up" if box == lowered else "unreadable"

    monkeypatch.setattr(recognition, "read_text", read)
    found = recognition.recognize(jpeg(marked_card()), orientation=0)
    assert found["title_text"][-1] == "Bulk Up"
    # The footer is read alongside the usual title strips, which come first.
    # This black card also has its dark title strips read inverted.
    footers = (recognition.FOOTER_BOX, recognition.WIDE_FOOTER_BOX)
    titles = [box for box in calls if box not in footers]
    assert sorted(titles[:4]) == sorted(recognition.TITLE_BOXES * 2)
    assert set(footers) <= set(calls)
    assert recognition.LOWER_TITLE_BOXES[1] not in calls
    calls.clear()
    lowered = recognition.TITLE_BOXES[0]
    recognition.recognize(jpeg(marked_card()), orientation=0)
    assert not set(recognition.LOWER_TITLE_BOXES) & set(calls)


def test_a_weak_upside_down_guess_does_not_turn_the_card(monkeypatch):
    monkeypatch.setattr(recognition, "catalog_index", lambda: {"syntheticfixture": []})
    monkeypatch.setattr(recognition, "identifier_index", lambda: ({}, {}))
    upright = lambda image: image.getpixel((5, 5))[0] > 200  # noqa: E731
    monkeypatch.setattr(
        recognition, "read_text", lambda image, *a, **k: "upright" if upright(image) else "flipped"
    )

    def matches(score):
        return lambda titles, index: [("syntheticfixture", score)] if "flipped" in titles else []

    monkeypatch.setattr(recognition, "name_matches", matches(recognition.FLIP_NAME - 0.05))
    assert recognition.recognize(jpeg(marked_card()))["rotation"] == 0
    monkeypatch.setattr(recognition, "name_matches", matches(recognition.FLIP_NAME + 0.05))
    assert recognition.recognize(jpeg(marked_card()))["rotation"] == 180


def test_light_title_text_on_a_dark_strip_is_read():
    # Old black frames, showcase and borderless titles print light text.
    pixels = np.full((840, 600, 3), 30, dtype=np.uint8)
    cv2.putText(
        pixels, "BRIGHT FALCON", (40, 75), cv2.FONT_HERSHEY_SIMPLEX, 1.3, (235, 235, 235), 3
    )
    image = Image.fromarray(pixels)
    box = (27, 32, 540, 92)
    assert recognition.normalized(recognition.read_text(image, box, invert=None)) == (
        "brightfalcon"
    )
    assert recognition.dark_strip(image, box)
    assert not recognition.dark_strip(Image.fromarray(255 - pixels), box)


def test_dark_title_strips_are_also_read_inverted(monkeypatch):
    # A loose crop can darken an ordinary title strip, so the usual
    # reading is kept alongside the inverted one.
    monkeypatch.setattr(recognition, "catalog_index", lambda: {"bulkup": []})
    monkeypatch.setattr(recognition, "identifier_index", lambda: ({}, {}))
    reads = []

    def read(image, box, psm=7, invert=False, **kwargs):
        reads.append((box, invert))
        return "Bulk Up" if box == recognition.TITLE_BOXES[0] and not invert else ""

    monkeypatch.setattr(recognition, "read_text", read)
    dark = recognition.recognize(jpeg(marked_card()), orientation=0)
    assert dark["candidates"] == [] and dark["title_text"][0] == "Bulk Up"
    assert {(box, True) for box in recognition.TITLE_BOXES} <= set(reads)
    reads.clear()
    recognition.recognize(jpeg(Image.new("RGB", (600, 840), "white")), orientation=0)
    footers = (recognition.FOOTER_BOX, recognition.WIDE_FOOTER_BOX)
    assert all(not invert for box, invert in reads if box not in footers)


def test_shortlisted_fuzzy_names_agree_with_a_full_search(monkeypatch):
    words = [
        "storm",
        "crow",
        "shivan",
        "dragon",
        "llanowar",
        "elves",
        "serra",
        "angel",
        "ancestral",
    ]
    index = {a + b + c: [] for a in words for b in words for c in words}
    monkeypatch.setattr(recognition, "FUZZY_SHORTLIST", 150)
    for query in ("shivandragn", "llanowarefves", "serraangelcrow", "stormcrowx", "ancestrlrecall"):
        expected = difflib.get_close_matches(query, list(index), n=4, cutoff=0.6)
        strong = [n for n in expected if difflib.SequenceMatcher(None, query, n).ratio() >= 0.78]
        found = recognition.close_names(query, index)
        assert found[: len(strong)] == strong


def test_repeated_titles_reuse_their_fuzzy_search(monkeypatch):
    index = {"stormcrow": [], "shivandragon": []}
    calls = []
    close = recognition.close_names
    monkeypatch.setattr(
        recognition, "close_names", lambda query, idx: calls.append(query) or close(query, idx)
    )
    for titles in (["Storm Crowe"], ["Storm Crowe", "Stonn Crow"], ["Storm Crowe", "Stonn Crow"]):
        assert recognition.name_matches(titles, index)[0][0] == "stormcrow"
    assert calls == ["stormcrowe", "stonncrow"]
    # A different catalog never sees another catalog's results.
    assert recognition.name_matches(["Storm Crowe"], {"shivandragon": []}) == []


def test_unread_footer_compares_each_artwork_of_a_reprinted_name(monkeypatch):
    # Twelve printings share a name; IDs sort the matching art last.
    rows = [
        {
            "id": f"{i:08x}-0000-0000-0000-000000000000",
            "name": "Storm Crow",
            "set_code": f"s{i}",
            "collector_number": "1",
            "language": "en",
            "artwork": "matching" if i == 11 else f"art-{i % 6}",
        }
        for i in range(12)
    ]
    monkeypatch.setattr(recognition, "catalog_index", lambda: {"stormcrow": rows})
    monkeypatch.setattr(recognition, "identifier_index", lambda: ({}, {}))
    monkeypatch.setattr(
        recognition,
        "read_text",
        lambda image, box, *a, **k: "Storm Crow" if box[1] != 758 else "",
    )
    monkeypatch.setattr(
        recognition,
        "catalog_cards",
        lambda ids: {i: next(r for r in rows if r["id"] == i) for i in ids},
    )
    compared = []

    def agreement(query, card, timeout):
        compared.append(card["artwork"])
        return 30 if card["artwork"] == "matching" else 0

    monkeypatch.setattr(recognition, "artwork_agreement", agreement)
    found = recognition.recognize(jpeg(marked_card()), orientation=0)
    assert found["candidates"][0]["printing_id"] == rows[11]["id"]
    assert found["candidates"][0]["visual_inliers"] == 30
    # One printing per artwork, up to the limit, and no artwork twice.
    assert sorted(compared) == sorted([f"art-{i}" for i in range(6)] + ["matching"])
    compared.clear()
    monkeypatch.setattr(recognition, "DISTINCT_ARTWORKS", 5)
    found = recognition.recognize(jpeg(marked_card()), orientation=0)
    assert "matching" not in compared
    assert found["candidates"][0]["visual_inliers"] == 0


def test_reference_artwork_features_are_computed_once(monkeypatch):
    loads = []
    monkeypatch.setattr(recognition, "_references", recognition.OrderedDict())
    monkeypatch.setattr(recognition, "source_image", lambda card, face, size: card)
    monkeypatch.setattr(
        recognition, "load_image", lambda card, timeout: loads.append(card) or (b"art", None, None)
    )
    monkeypatch.setattr(recognition, "visual_features", lambda data: ("points", data))
    monkeypatch.setattr(recognition, "REFERENCE_CACHE", 2)
    for card in ("a", "b", "a", "c", "a", "b"):
        assert recognition.reference_features(card, 3) == ("points", b"art")
    # "b" was the least recently used when "c" arrived.
    assert loads == ["a", "b", "c", "b"]


def test_titles_at_the_top_of_a_tight_crop_or_on_gold_bars_are_read(monkeypatch):
    # On a dark table the outline can follow the coloured frame, leaving the
    # title at the very top of the crop. Gold bars read better inverted.
    monkeypatch.setattr(recognition, "catalog_index", lambda: {"bulkup": []})
    monkeypatch.setattr(recognition, "identifier_index", lambda: ({}, {}))
    white = jpeg(Image.new("RGB", (600, 840), "white"))
    for wanted in ((recognition.UPPER_TITLE_BOXES[1], False), (recognition.TITLE_BOXES[0], True)):
        reads = []

        def read(image, box, psm=7, invert=False, reads=reads, wanted=wanted, **kwargs):
            reads.append((box, invert))
            return "Bulk Up" if (box, invert) == wanted else ""

        monkeypatch.setattr(recognition, "read_text", read)
        found = recognition.recognize(white, orientation=0)
        assert "Bulk Up" in found["title_text"]
    # The inverted strips are the last resort, after the lower ones.
    assert reads.index((recognition.LOWER_TITLE_BOXES[1], False)) < reads.index(wanted)
    reads.clear()
    monkeypatch.setattr(
        recognition, "read_text", lambda image, box, *a, **k: reads.append(box) or "Bulk Up"
    )
    recognition.recognize(white, orientation=0)
    assert not set(recognition.UPPER_TITLE_BOXES) & set(reads)
