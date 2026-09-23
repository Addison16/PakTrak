import secrets
import uuid
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, event
from test_collections import key

from scanner import card_images
from scanner.api import app
from scanner.db import session_factory
from scanner.deck_tokens import token_report
from scanner.models import CatalogSnapshot, Printing
from scanner.settings import get_settings


@pytest.fixture(scope="module")
def token_catalog(isolated_database):
    identifiers = {
        name: uuid.uuid4()
        for name in (
            "grove",
            "captain",
            "walker",
            "side",
            "empty",
            "beast",
            "beast_alt",
            "soldier",
            "red_soldier",
            "vigilant_soldier",
            "emblem",
            "double",
            "missing",
            "no_oracle",
            "no_oracle_alt",
            "incomplete",
            "incomplete_alt",
        )
    }
    beast_oracle = uuid.uuid4()

    def link(name, component="token", type_line="Token Creature"):
        return {
            "id": str(identifiers[name]),
            "name": name.title(),
            "component": component,
            "type_line": type_line,
            "uri": "https://invalid.example/do-not-fetch",
        }

    def token(name="Beast", **changes):
        return {
            "name": name,
            "layout": "token",
            "type_line": "Token Creature — " + name,
            "colors": ["G"],
            "power": "3",
            "toughness": "3",
            "oracle_text": "",
            **changes,
        }

    records = {
        "grove": {
            "name": "Token Fixture Grove",
            "all_parts": [
                link("beast"),
                link("soldier"),
                link("captain", "combo_piece"),
                {"id": "bad-id", "component": "token"},
            ],
        },
        "captain": {
            "name": "Token Fixture Captain",
            "all_parts": [link("beast_alt"), link("red_soldier"), link("vigilant_soldier")],
        },
        "walker": {
            "name": "Token Fixture Walker",
            "all_parts": [
                link("emblem", "combo_piece", "Emblem — Walker"),
                link("empty", "meld_result"),
            ],
        },
        "side": {
            "name": "Token Fixture Side",
            "card_faces": [{"name": "Front"}, {"name": "Token-maker back"}],
            "all_parts": [link("double"), link("missing")],
        },
        "empty": {"name": "Token Fixture Plains"},
        "beast": token(),
        "beast_alt": token(),
        "soldier": token("Soldier", colors=["W"], power="1", toughness="1"),
        "red_soldier": token("Soldier", colors=["R"], power="2", toughness="2"),
        "vigilant_soldier": token(
            "Soldier", colors=["W"], power="1", toughness="1", oracle_text="Vigilance"
        ),
        "emblem": {
            "name": "Fixture Walker Emblem",
            "layout": "emblem",
            "type_line": "Emblem — Walker",
            "oracle_text": "Creatures you control have vigilance.",
        },
        "double": {
            "name": "Clue // Treasure",
            "layout": "double_faced_token",
            "card_faces": [
                token(
                    "Clue", type_line="Token Artifact — Clue", colors=[], power=None, toughness=None
                ),
                token(
                    "Treasure",
                    type_line="Token Artifact — Treasure",
                    colors=[],
                    power=None,
                    toughness=None,
                ),
            ],
        },
        "no_oracle": token("Spirit"),
        "no_oracle_alt": token("Spirit"),
        "incomplete": token("Unknown", power=None, toughness=None),
        "incomplete_alt": token("Unknown", power=None, toughness=None),
    }
    with session_factory()() as db, db.begin():
        snapshot = CatalogSnapshot(
            source="synthetic token checklist",
            checksum=secrets.token_hex(32),
            printings=len(records),
        )
        db.add(snapshot)
        db.flush()
        for number, (name, raw) in enumerate(records.items()):
            identifier = identifiers[name]
            image = {"normal": f"https://cards.scryfall.io/normal/front/a/b/{identifier}.jpg"}
            if raw.get("card_faces") and name == "double":
                for index, face in enumerate(raw["card_faces"]):
                    face["image_uris"] = {
                        "normal": f"https://cards.scryfall.io/normal/{'front' if index == 0 else 'back'}/a/b/{identifier}.jpg"
                    }
            else:
                raw["image_uris"] = image
            db.add(
                Printing(
                    id=identifier,
                    oracle_id=beast_oracle
                    if name in {"beast", "beast_alt"}
                    else None
                    if name.startswith(("no_oracle", "incomplete"))
                    else uuid.uuid4(),
                    name=raw["name"],
                    set_code="tst",
                    collector_number=str(number + 1),
                    language="en",
                    finishes=["nonfoil"],
                    snapshot_id=snapshot.id,
                    source_json=raw,
                )
            )
        snapshot_id = snapshot.id
    yield {name: str(value) for name, value in identifiers.items()}
    with session_factory()() as db, db.begin():
        db.execute(delete(Printing).where(Printing.id.in_(identifiers.values())))
        db.execute(delete(CatalogSnapshot).where(CatalogSnapshot.id == snapshot_id))


def choices(catalog):
    return [
        {"printing_id": catalog[name], "quantity": quantity, "section": section}
        for name, quantity, section in [
            ("grove", 1, "commander"),
            ("grove", 4, "main"),
            ("captain", 100, "main"),
            ("walker", 1, "main"),
            ("side", 1, "sideboard"),
        ]
    ]


def test_saved_and_draft_decks_group_tokens_preserve_variants_and_exclude_combo_cards(
    clients, token_catalog
):
    client, _ = clients()
    data = {"name": "Tokens to bring", "cards": choices(token_catalog)}
    response = client.post("/api/v1/decks", headers=key(), json=data)
    assert response.status_code == 201, response.text
    deck = response.json()
    report = deck["tokens"]
    assert len(report["items"]) == 7 and report["missing_details"] == 1
    beast = next(item for item in report["items"] if item["name"] == "Beast")
    assert len(beast["sources"]) == 2
    grove = next(
        source for source in beast["sources"] if source["printing_id"] == token_catalog["grove"]
    )
    assert grove["sections"] == ["commander", "main"]
    soldiers = [item for item in report["items"] if item["name"] == "Soldier"]
    assert len(soldiers) == 3
    assert {
        (
            item["faces"][0]["power"],
            tuple(item["faces"][0]["colors"]),
            item["faces"][0]["oracle_text"],
        )
        for item in soldiers
    } == {("1", ("W",), ""), ("2", ("R",), ""), ("1", ("W",), "Vigilance")}
    assert sum(item["kind"] == "emblem" for item in report["items"]) == 1
    assert sum(item["sideboard_only"] for item in report["items"]) == 2
    missing = next(item for item in report["items"] if not item["details_available"])
    assert missing["name"] == "Missing" and missing["faces"][0]["image_url"] is None
    double = next(item for item in report["items"] if item["name"] == "Clue // Treasure")
    assert len(double["faces"]) == 2 and "/1/grid" in double["faces"][1]["image_url"]
    assert "invalid.example" not in str(report)
    assert client.get(f"/api/v1/decks/{deck['id']}").json()["tokens"] == report
    assert client.post("/api/v1/decks/tokens", json={"cards": data["cards"]}).json() == report
    assert deck["copies"] == 107 and len(deck["cards"]) == 5
    assert client.get("/api/v1/collection").json()["copies"] == 0
    assert client.get("/api/auth/session").json()["scan_cards_used"] == 0


def test_import_updates_token_list_without_adding_tokens_to_deck_or_inventory(
    clients, token_catalog
):
    client, _ = clients()
    preview = client.post(
        "/api/v1/decks/import-preview",
        json={"content": "2 Token Fixture Grove\n1 Token Fixture Walker"},
    ).json()
    assert preview["unresolved"] == 0
    cards = [
        {
            "printing_id": row["printing"]["id"],
            "section": row["section"],
            "quantity": row["quantity"],
        }
        for row in preview["items"]
    ]
    deck = client.post(
        "/api/v1/decks", headers=key(), json={"name": "Imported", "cards": cards}
    ).json()
    assert len(deck["tokens"]["items"]) == 3
    body = {
        "name": "Imported",
        "cards": [{"printing_id": token_catalog["empty"], "quantity": 30}],
        "expected_version": deck["version"],
    }
    saved = client.post(f"/api/v1/decks/{deck['id']}", headers=key(), json=body).json()
    assert saved["copies"] == 30 and saved["tokens"] == {"items": [], "missing_details": 0}
    assert client.post("/api/v1/decks/tokens", json={"cards": []}).json() == saved["tokens"]
    assert client.get("/api/v1/collection").json()["copies"] == 0
    other, _ = clients()
    assert other.get(f"/api/v1/decks/{deck['id']}").status_code == 404


def test_token_identity_without_oracle_uses_complete_characteristics_and_one_batched_query(
    token_catalog,
):
    with session_factory()() as db:
        source = db.get(Printing, uuid.UUID(token_catalog["grove"]))
        parts = [
            {"id": token_catalog[name], "name": name, "component": "token"}
            for name in ("no_oracle", "no_oracle_alt", "incomplete", "incomplete_alt")
        ]
        synthetic = SimpleNamespace(
            id=source.id, name=source.name, source_json={"all_parts": parts}
        )
        rows = [(SimpleNamespace(quantity=1, section="main"), synthetic)] * 300
        queries = []
        engine = db.get_bind()

        def count(connection, cursor, statement, parameters, context, executemany):
            queries.append(statement)

        event.listen(engine, "before_cursor_execute", count)
        try:
            report = token_report(db, rows)
        finally:
            event.remove(engine, "before_cursor_execute", count)
        assert len(queries) == 1
        assert sorted(item["name"] for item in report["items"]) == ["Spirit", "Unknown", "Unknown"]
        assert all(len(item["sources"]) == 1 for item in report["items"])


def test_token_previews_require_signin_and_a_real_catalog_relationship(
    clients, token_catalog, monkeypatch
):
    client, _ = clients()
    calls = []

    def load(card, face, size):
        calls.append((str(card.id), face, size))
        return b"fixture", "image/jpeg", "digest"

    monkeypatch.setattr(card_images, "load_image", load)
    base = f"/api/v1/card-images/related/{token_catalog['grove']}"
    allowed = f"{base}/{token_catalog['beast']}/0/grid"
    response = client.get(allowed)
    assert response.status_code == 200 and response.content == b"fixture"
    assert response.headers["cache-control"].startswith("private")
    for target, face in (("emblem", 0), ("captain", 0), ("missing", 0), ("beast", 2)):
        assert client.get(f"{base}/{token_catalog[target]}/{face}/grid").status_code == 404
    # Ordinary image authorization is not broadened to unrelated/unowned cards.
    assert client.get(f"/api/v1/card-images/{token_catalog['beast']}/0/grid").status_code == 404
    with TestClient(app, base_url=get_settings().app_url) as anonymous:
        assert anonymous.get(allowed).status_code == 401
        assert anonymous.post("/api/v1/decks/tokens", json={"cards": []}).status_code in {401, 403}
    assert len(calls) == 1


def test_token_draft_validation_rejects_unknown_cards_invalid_counts_and_duplicate_rows(
    clients, token_catalog
):
    client, _ = clients()
    card = {"printing_id": token_catalog["grove"], "quantity": 1}
    for rows in (
        [{**card, "quantity": 0}],
        [{**card, "printing_id": str(uuid.uuid4())}],
        [card, card],
        [card] * 301,
    ):
        assert client.post("/api/v1/decks/tokens", json={"cards": rows}).status_code == 422
    bad_csrf = client.post(
        "/api/v1/decks/tokens", headers={"X-CSRF-Token": "bad"}, json={"cards": [card]}
    )
    assert bad_csrf.status_code == 403
