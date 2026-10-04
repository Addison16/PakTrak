import io

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
    assert calls[:2] == list(recognition.TITLE_BOXES)
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
