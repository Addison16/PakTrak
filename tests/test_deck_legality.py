"""Deck construction checks against synthetic, explicitly dated catalog data."""

import uuid
from datetime import timedelta
from types import SimpleNamespace

import pytest
from test_collections import key
from test_deck_lists import deck_catalog as deck_catalog

from scanner.deck_legality import CONSTRUCTED, check_deck
from scanner.models import now


def printing(name="Fixture spell", types="Instant", text="", colors=(), **extra):
    return SimpleNamespace(
        id=uuid.uuid4(),
        oracle_id=uuid.uuid4(),
        name=name,
        source_json={
            "name": name,
            "type_line": types,
            "oracle_text": text,
            "color_identity": list(colors),
            "games": ["paper"],
            "layout": "normal",
            "legalities": {format: "legal" for format in CONSTRUCTED | {"commander"}},
            **extra,
        },
    )


def entry(card, quantity=1, section="main"):
    return SimpleNamespace(quantity=quantity, section=section), card


def basic(name="Forest"):
    return printing(name, f"Basic Land — {name}")


def commander(**kwargs):
    return printing("Fixture leader", "Legendary Creature — Human", colors=["G"], **kwargs)


def report(rows, format="commander", date=None):
    return check_deck(rows, format, date or now())


def errors(result):
    return {item["code"] for item in result["issues"] if item["severity"] == "error"}


@pytest.mark.parametrize("format", sorted(CONSTRUCTED))
def test_constructed_formats_accept_60_cards_and_basic_land_copy_exception(format):
    result = report([entry(basic(), 60), entry(basic("Island"), 15, "sideboard")], format)
    assert result["status"] == "legal"
    assert result["counts"] == {"main": 60, "sideboard": 15, "commander": 0, "schemes": 0}


def test_combined_copy_limits_include_sideboard_and_different_editions():
    a, b = printing(), printing()
    b.oracle_id = a.oracle_id
    result = report([entry(basic(), 56), entry(a, 4), entry(b, 1, "sideboard")], "modern")
    assert errors(result) == {"copy_limit"}
    issue = next(i for i in result["issues"] if i["code"] == "copy_limit")
    assert set(issue["printing_ids"]) == {str(a.id), str(b.id)}
    assert "5 copies" in issue["message"]


def test_format_pool_bans_restrictions_and_structure():
    banned, rotated, restricted = printing("Banned"), printing("Rotated"), printing("Restricted")
    banned.source_json["legalities"]["standard"] = "banned"
    rotated.source_json["legalities"]["standard"] = "not_legal"
    result = report(
        [
            entry(basic(), 55),
            entry(banned),
            entry(rotated),
            entry(basic(), 16, "sideboard"),
            entry(commander(), section="commander"),
        ],
        "standard",
    )
    assert errors(result) == {
        "card_legality",
        "deck_size",
        "sideboard_size",
        "unexpected_commander",
    }
    restricted.source_json["legalities"]["vintage"] = "restricted"
    assert (
        report([entry(basic(), 60), entry(restricted, section="sideboard")], "vintage")["status"]
        == "legal"
    )
    assert errors(
        report(
            [entry(basic(), 59), entry(restricted), entry(restricted, section="sideboard")],
            "vintage",
        )
    ) == {"restricted_copies"}


def test_pauper_uses_format_legality_instead_of_printed_rarity():
    rare_reprint = printing(rarity="rare")
    assert report([entry(basic(), 59), entry(rare_reprint)], "pauper")["status"] == "legal"
    rare_reprint.source_json["legalities"]["pauper"] = "not_legal"
    assert "card_legality" in errors(report([entry(basic(), 59), entry(rare_reprint)], "pauper"))


@pytest.mark.parametrize(
    "text,quantity,allowed",
    [
        ("A deck can have any number of cards named Fixture spell.", 99, True),
        ("A deck can have up to seven cards named Fixture spell.", 7, True),
        ("A deck can have up to nine cards named Fixture spell.", 10, False),
    ],
)
def test_oracle_copy_exceptions_override_singleton(text, quantity, allowed):
    rows = [entry(commander(), section="commander"), entry(printing(text=text), quantity)]
    if quantity < 99:
        rows.append(entry(basic(), 99 - quantity))
    result = report(rows)
    assert ("copy_limit" not in errors(result)) == allowed


def test_commander_extras_are_saved_outside_checked_deck():
    off_color_banned = printing("Extra", colors=["U"], legalities={"commander": "banned"})
    result = report(
        [
            entry(commander(), section="commander"),
            entry(basic(), 99),
            entry(off_color_banned, 8, "sideboard"),
        ]
    )
    assert result["status"] == "legal"
    assert any(i["code"] == "commander_extras" for i in result["issues"])
    assert result["counts"]["sideboard"] == 8


def test_commander_identity_includes_back_face_and_basic_land_types():
    back_color = printing(
        "Two faced",
        color_identity=["G", "U"],
        card_faces=[
            {"type_line": "Creature", "oracle_text": ""},
            {"type_line": "Land", "oracle_text": ""},
        ],
    )
    island = basic("Island")  # Intentionally colorless metadata still has an intrinsic U ability.
    result = report(
        [
            entry(commander(), section="commander"),
            entry(basic(), 97),
            entry(back_color),
            entry(island),
        ]
    )
    assert errors(result) == {"color_identity"}
    assert len([i for i in result["issues"] if i["code"] == "color_identity"]) == 2


@pytest.mark.parametrize(
    "types,extra,eligible",
    [
        ("Legendary Artifact — Vehicle", {}, True),
        ("Legendary Artifact — Spacecraft", {"power": "5", "toughness": "5"}, True),
        ("Legendary Artifact — Spacecraft", {}, False),
        (
            "Legendary Planeswalker — Fixture",
            {"oracle_text": "Fixture leader can be your commander."},
            True,
        ),
        ("Legendary Planeswalker — Fixture", {}, False),
        (
            "Legendary Planeswalker — Fixture",
            {
                "oracle_text": "As long as Fixture leader isn't on the battlefield, it's a 1/1 Insect creature in addition to its other types."
            },
            True,
        ),
        ("Legendary Artifact", {}, False),
        (
            "Enchantment // Legendary Creature",
            {
                "card_faces": [
                    {"type_line": "Enchantment", "oracle_text": ""},
                    {"type_line": "Legendary Creature", "oracle_text": ""},
                ]
            },
            False,
        ),
    ],
)
def test_front_face_commander_eligibility_includes_current_vehicle_and_spacecraft_rules(
    types, extra, eligible
):
    leader = printing("Fixture leader", types, colors=["G"], **extra)
    result = report([entry(leader, section="commander"), entry(basic(), 99)])
    assert ("commander_eligibility" not in errors(result)) == eligible


@pytest.mark.parametrize(
    "first,second,valid",
    [
        ("Partner", "Partner", True),
        ("Partner—Friends forever", "Partner—Friends forever", True),
        ("Partner—Character select", "Partner—Survivors", False),
        ("Partner", "Partner with First", False),
        ("Partner with Second", "Partner with First", True),
        ("Partner with Stranger", "Partner with First", False),
    ],
)
def test_partner_abilities_must_actually_match(first, second, valid):
    a = printing("First", "Legendary Creature — Human", first, ["G"], keywords=["Partner"])
    b = printing(
        "Second", "Legendary Creature — Human", second, ["G"], keywords=["Partner", "Partner with"]
    )
    result = report(
        [entry(a, section="commander"), entry(b, section="commander"), entry(basic(), 98)]
    )
    assert ("commander_pair" not in errors(result)) == valid


def test_background_doctor_and_color_choice():
    a = printing("Leader", "Legendary Creature — Human", "Choose a Background", ["G"])
    b = printing("History", "Legendary Enchantment — Background")
    assert (
        report([entry(a, section="commander"), entry(b, section="commander"), entry(basic(), 98)])[
            "status"
        ]
        == "legal"
    )
    assert "commander_eligibility" in errors(
        report([entry(b, section="commander"), entry(basic(), 99)])
    )
    doctor = printing("Doctor", "Legendary Creature — Time Lord Doctor", colors=["G"])
    clara = printing(
        "Companion",
        "Legendary Creature — Human",
        "If Companion is your commander, choose a color before the game begins.\nDoctor's companion",
    )
    rows = [
        entry(doctor, section="commander"),
        entry(clara, section="commander"),
        entry(basic("Island"), 98),
    ]
    assert report(rows)["status"] == "legal"
    doctor.source_json["type_line"] += " Human"
    assert "commander_pair" in errors(report(rows))
    piper = printing(
        "Piper",
        "Legendary Creature — Shapeshifter",
        "If Piper is your commander, choose a color before the game begins.\nPartner",
    )
    assert (
        report([entry(piper, section="commander"), entry(basic("Island"), 99)])["status"] == "legal"
    )
    assert "color_identity" in errors(
        report([entry(piper, section="commander"), entry(basic("Island"), 98), entry(basic())])
    )


def test_unknown_and_stale_data_never_report_a_clean_pass():
    rows = [entry(commander(), section="commander"), entry(basic(), 99)]
    assert report(rows, date=now() - timedelta(days=4))["status"] == "incomplete"
    rows[0][1].source_json.pop("color_identity")
    assert report(rows)["status"] == "incomplete"
    rows[1][1].source_json.pop("legalities")
    assert report(rows)["status"] == "incomplete"
    assert check_deck(rows, "commander", None)["status"] == "incomplete"


def test_limited_and_unconfigured_formats_do_not_invent_restrictions():
    rows = [entry(printing(), 40), entry(printing("Reserve"), 32, "sideboard")]
    limited = report(rows, "limited")
    assert not errors(limited) and limited["status"] == "incomplete"
    assert {i["code"] for i in limited["issues"]} == {"limited_pool"}
    for format in ("casual", "other"):
        assert report(rows, format)["status"] == "not_checked"


@pytest.mark.parametrize(
    "extra",
    [
        {"layout": "art_series"},
        {"layout": "token"},
        {"oversized": True},
        {"security_stamp": "acorn"},
        {"border_color": "gold"},
        {"games": ["arena"]},
    ],
)
def test_collectibles_and_non_playable_printings_are_not_deck_cards(extra):
    assert "non_playable" in errors(
        report([entry(basic(), 59), entry(printing(**extra))], "standard")
    )


def test_legality_endpoint_is_advisory_reads_current_catalog_and_never_changes_holdings(
    clients, deck_catalog
):
    client, _ = clients()
    data = {
        "format": "standard",
        "cards": [{"printing_id": deck_catalog[0], "section": "main", "quantity": 1}],
    }
    response = client.post("/api/v1/decks/legality", headers=key(), json=data)
    assert response.status_code == 200
    assert "deck_size" in errors(response.json())
    saved = client.post("/api/v1/decks", headers=key(), json={"name": "Work in progress", **data})
    assert saved.status_code == 201
    assert saved.json()["legality"]["status"] == "issues"
    assert (
        client.get(f"/api/v1/decks/{saved.json()['id']}").json()["legality"]["format"] == "standard"
    )
    assert client.get("/api/v1/collection").json()["copies"] == 0
    assert client.get("/api/auth/session").json()["scan_cards_used"] == 0
    data["cards"][0]["printing_id"] = str(uuid.uuid4())
    assert client.post("/api/v1/decks/legality", headers=key(), json=data).status_code == 422


def scheme(name="Fixture scheme", ongoing=False):
    return printing(name, "Ongoing Scheme" if ongoing else "Scheme", layout="scheme", legalities={})


def schemes(count, copies=1, prefix="Scheme"):
    return [entry(scheme(f"{prefix} {n}"), copies, "schemes") for n in range(count)]


def test_archenemy_scheme_deck_needs_twenty_with_up_to_two_of_each():
    deck = [entry(basic(), 60)]
    result = report(deck + schemes(10, 2), "standard")
    assert result["status"] == "legal"
    assert result["archenemy"] and "Scheme deck" in result["checks"]
    assert result["counts"]["schemes"] == 20
    assert any("40 life" in i["message"] for i in result["issues"])
    result = report(deck + schemes(9, 2) + [entry(scheme("Extra"), 1, "schemes")], "standard")
    assert "scheme_deck_size" in errors(result)
    result = report(deck + schemes(17) + [entry(scheme("Triple"), 3, "schemes")], "standard")
    assert errors(result) == {"scheme_copies"}


def test_commander_archenemy_needs_ten_differently_named_schemes():
    deck = [entry(commander(), section="commander"), entry(basic(), 99)]
    result = report(deck + schemes(10))
    assert result["status"] == "legal"
    assert result["counts"]["commander"] == 1
    assert any("60 life" in i["message"] for i in result["issues"])
    # Schemes never count toward the 100 cards or get checked as Commander cards.
    assert "deck_size" not in errors(result) and "non_playable" not in errors(result)
    assert "scheme_copies" in errors(report(deck + schemes(9) + schemes(1, 2, "Twice")))
    assert "scheme_deck_size" in errors(report(deck + schemes(9)))
    flagged = report(deck + schemes(9) + [entry(scheme("Mortal Flesh Is Weak"), 1, "schemes")])
    assert flagged["status"] == "legal"
    assert any(i["code"] == "scheme_shared_life" for i in flagged["issues"])


def test_scheme_deck_only_holds_schemes_and_schemes_stay_out_of_the_deck():
    deck = [entry(basic(), 60)]
    result = report(deck + schemes(19) + [entry(printing("Bolt"), 1, "schemes")], "modern")
    assert errors(result) == {"not_a_scheme"}
    result = report([entry(basic(), 59), entry(scheme())], "modern")
    assert "non_playable" in errors(result)
    assert not result["archenemy"]


def test_casual_decks_still_check_their_scheme_deck():
    result = report([entry(basic(), 40)] + schemes(5), "casual")
    assert result["status"] == "issues" and errors(result) == {"scheme_deck_size"}
    assert result["checks"] == ["Scheme deck"]
    assert report([entry(basic(), 40)] + schemes(20), "casual")["status"] == "legal"
    assert report([entry(basic(), 40)], "casual")["status"] == "not_checked"
