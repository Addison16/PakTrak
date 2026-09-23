import gzip
import io
import json
import uuid
from datetime import timedelta
from decimal import Decimal

import httpx
import pytest
from PIL import Image
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from test_collections import catalog as catalog
from test_collections import commit, preview

from scanner import card_images, data_sync, storage
from scanner.db import session_factory
from scanner.models import CardPrice, CatalogSnapshot, DataFeed, Printing, WorkProgress, now
from scanner.progress import Progress


def seed_metadata(ids):
    with session_factory()() as db, db.begin():
        card = db.get(Printing, uuid.UUID(ids[0]))
        card.source_json = {
            "name": card.name,
            "set_name": "Fixture edition",
            "type_line": "Creature — Wizard",
            "mana_cost": "{1}{U}",
            "cmc": 2,
            "color_identity": ["U"],
            "rarity": "rare",
            "oracle_text": "Flash. Draw a card.",
            "artist": "Fixture Artist",
            "image_uris": {"normal": f"https://cards.scryfall.io/normal/front/0/0/{card.id}.jpg"},
            "scryfall_uri": f"https://scryfall.com/card/tst/1/{card.id}",
            "legalities": {"commander": "legal", "standard": "not_legal"},
        }
        second = db.get(Printing, uuid.UUID(ids[1]))
        second.source_json = {
            "color_identity": [],
            "rarity": "common",
            "cmc": 0,
            "type_line": "Land",
            "card_faces": [
                {"name": "Front", "oracle_text": "Add mana."},
                {"name": "Back", "oracle_text": "Flying and vigilance."},
            ],
        }


def test_gallery_exact_finish_values_rules_filters_and_private_details(clients, catalog):
    client, _ = clients()
    other, _ = clients()
    seed_metadata(catalog)
    batch = commit(
        client,
        preview(
            client,
            [
                {
                    "Scryfall ID": catalog[0],
                    "Quantity": "3",
                    "Finish": "nonfoil",
                    "Altered": "false",
                },
                {"Scryfall ID": catalog[0], "Quantity": "1", "Finish": "foil", "Altered": "false"},
                {
                    "Scryfall ID": catalog[0],
                    "Quantity": "2",
                    "Finish": "unknown",
                    "Altered": "false",
                },
                {
                    "Scryfall ID": catalog[0],
                    "Quantity": "1",
                    "Finish": "nonfoil",
                    "Altered": "true",
                },
                {
                    "Scryfall ID": catalog[1],
                    "Quantity": "1",
                    "Finish": "nonfoil",
                    "Altered": "false",
                },
            ],
        ),
    )
    with session_factory()() as db, db.begin():
        for printing, finish, value in [
            (catalog[0], "nonfoil", "2.5"),
            (catalog[0], "foil", "7"),
            (catalog[1], "nonfoil", "5"),
        ]:
            db.add(
                CardPrice(
                    printing_id=uuid.UUID(printing),
                    provider="tcgplayer",
                    finish=finish,
                    amount=Decimal(value),
                )
            )
    data = client.get("/api/v1/collection/cards").json()
    assert (data["copies"], data["cards"]) == (8, 2)
    assert Decimal(data["valuation"]["amount"]) == Decimal("19.5")
    assert data["valuation"]["priced_copies"] == 5
    assert data["valuation"]["unpriced_copies"] == 3
    assert data["valuation"]["pricing_issues"] == {
        "unknown_finish": 2,
        "custom_value": 1,
        "missing_price": 0,
    }
    assert data["items"][0]["pricing_issues"] == {
        "unknown_finish": 2,
        "custom_value": 1,
        "missing_price": 0,
    }
    assert data["items"][0]["printing"]["image_url"].startswith("/api/v1/card-images/")
    assert Decimal(data["items"][0]["value"]) == Decimal("14.5")
    assert (
        client.get("/api/v1/collection/cards?provider=cardkingdom").json()["valuation"]["amount"]
        is None
    )
    assert client.get("/api/v1/collection/cards?provider=cardkingdom").json()["valuation"][
        "pricing_issues"
    ] == {"unknown_finish": 2, "custom_value": 1, "missing_price": 5}
    assert client.get("/api/v1/collection/cards?provider=untrusted").status_code == 422
    for params, expected in [
        ({"q": "draw a card"}, 7),
        ({"q": "vigilance"}, 1),
        ({"color": "U"}, 7),
        ({"color": "C"}, 1),
        ({"color": "M"}, 0),
        ({"rarity": "rare"}, 7),
        ({"card_type": "Land"}, 1),
        ({"finish": "foil"}, 1),
        ({"finish": "unknown"}, 2),
        ({"set_code": "TST"}, 8),
        ({"q": "%"}, 0),
    ]:
        result = client.get("/api/v1/collection/cards", params=params)
        assert result.status_code == 200, result.text
        assert result.json()["copies"] == expected
    assert (
        client.get("/api/v1/collection/cards?sort=price").json()["items"][0]["printing"]["id"]
        == catalog[0]
    )
    assert (
        client.get("/api/v1/collection/cards?sort=mana").json()["items"][0]["printing"]["id"]
        == catalog[1]
    )
    assert (
        client.get("/api/v1/collection/cards?sort=shuffle&seed=abc").json()
        == client.get("/api/v1/collection/cards?sort=shuffle&seed=abc").json()
    )
    assert client.get("/api/v1/collection/filters").json()["sets"][0]["code"] == "tst"
    assert other.get("/api/v1/collection/filters").json()["sets"] == []
    detail = client.get(f"/api/v1/collection/printings/{catalog[0]}")
    assert detail.status_code == 200
    assert detail.json()["faces"][0]["oracle_text"] == "Flash. Draw a card."
    assert len(detail.json()["prices"]) == 3
    assert other.get(f"/api/v1/collection/printings/{catalog[0]}").status_code == 404
    with session_factory()() as db:
        saved = list(
            db.scalars(
                select(WorkProgress).where(
                    WorkProgress.job_id.in_([uuid.UUID(job["id"]) for job in batch["jobs"]])
                )
            )
        )
        assert any(value.data.get("phase") == "Preview ready" for value in saved)


def test_provider_units_finishes_ambiguity_and_unavailable_prices():
    identifier = uuid.uuid4()
    known = {identifier: ["nonfoil", "foil", "etched"]}
    base = {
        "scryfall_id": str(identifier),
        "is_foil": "false",
        "price_retail": "12.34",
        "url": "mtg/example",
        "condition_values": {"nm_qty": 0},
        "variation": "",
    }
    ck = data_sync.normalize_prices(
        "cardkingdom",
        [base, {**base, "is_foil": "true", "variation": "Etched Foil", "price_retail": "23.45"}],
        known,
    )
    assert [(row["finish"], row["amount"], row["available"]) for row in ck] == [
        ("nonfoil", Decimal("12.3400"), False),
        ("etched", Decimal("23.4500"), False),
    ]
    # Two store SKUs sharing an ID+finish are ambiguous: don't choose a cheaper one.
    assert (
        data_sync.normalize_prices("cardkingdom", [base, {**base, "price_retail": "99"}], known)
        == []
    )
    mp = data_sync.normalize_prices(
        "manapool",
        [
            {
                "scryfall_id": str(identifier),
                "price_cents_nm": 123,
                "price_cents_nm_foil": None,
                "price_cents_nm_etched": 456,
                "url": "https://manapool.com/card/test",
            }
        ],
        known,
    )
    assert [(row["finish"], row["amount"]) for row in mp] == [
        ("nonfoil", Decimal("1.2300")),
        ("etched", Decimal("4.5600")),
    ]
    assert data_sync.amount("NaN") is None
    assert data_sync.amount("-1") is None
    assert data_sync.amount("0") is None
    assert data_sync.amount("Infinity") is None
    assert data_sync.trusted_url("https://manapool.com.evil.test/card/test", "manapool.com") is None
    with pytest.raises(data_sync.FeedError):
        data_sync.normalize_prices("manapool", [{"id": "changed schema"}], known)


def test_price_replacement_is_atomic_and_empty_failure_keeps_old_snapshot(catalog):
    old = {
        "printing_id": uuid.UUID(catalog[0]),
        "provider": "cardkingdom",
        "finish": "nonfoil",
        "amount": Decimal("1.25"),
        "url": None,
        "available": True,
    }
    data_sync.replace_prices("cardkingdom", [old])
    with pytest.raises(IntegrityError):
        data_sync.replace_prices("cardkingdom", [{**old, "printing_id": uuid.uuid4()}])
    with pytest.raises(data_sync.FeedError):
        data_sync.replace_prices("cardkingdom", [])
    with session_factory()() as db:
        assert db.get(CardPrice, (old["printing_id"], "cardkingdom", "nonfoil")).amount == Decimal(
            "1.25"
        )


def test_http_backoff_download_limit_and_measured_estimates(tmp_path, monkeypatch):
    response = httpx.Response(
        429,
        headers={"Retry-After": "7200"},
        request=httpx.Request("GET", "https://api.scryfall.com/bulk-data"),
    )
    with pytest.raises(data_sync.FeedError) as error:
        data_sync.check_response(response)
    assert error.value.retry_seconds == 7200
    called = []
    with httpx.Client(
        transport=httpx.MockTransport(
            lambda request: (called.append(request), httpx.Response(200, content=b"too large"))[1]
        )
    ) as client:
        with pytest.raises(data_sync.FeedError):
            data_sync.download(
                client,
                "https://manapool.com/api/v1/prices/singles",
                tmp_path / "prices",
                lambda *args, **kwargs: None,
                3,
            )
    assert len(called) == 1
    ticks = iter([0, 0, 10, 11])
    monkeypatch.setattr("scanner.progress.time.monotonic", lambda: next(ticks))
    updates = []
    report = Progress(updates.append)
    report("Importing", 0, 100, force=True)
    report("Importing", 25, 100)
    assert updates[-1]["eta_seconds"] == 30
    report("Saving", 0, None, force=True)
    assert updates[-1]["eta_seconds"] is None


def test_daily_worker_cooldown_and_interrupted_restart(monkeypatch):
    with session_factory()() as db, db.begin():
        db.execute(delete(DataFeed))
        for name in data_sync.FEEDS:
            db.add(DataFeed(name=name, state="READY", next_at=now() + timedelta(hours=24)))
    calls = []

    def fail(*args):
        calls.append(1)
        raise data_sync.FeedError("Rate limited", 7200)

    monkeypatch.setattr(data_sync, "scryfall_sync", fail)
    monkeypatch.setattr(data_sync, "store_sync", fail)
    try:
        data_sync.refresh_due()
        assert not calls
        with session_factory()() as db, db.begin():
            feed = db.get(DataFeed, "scryfall")
            feed.next_at = now() - timedelta(seconds=1)
        data_sync.refresh_due()
        with session_factory()() as db:
            feed = db.get(DataFeed, "scryfall")
            assert feed.state == "FAILED" and feed.next_at > now() + timedelta(minutes=119)
        data_sync.refresh_due()
        assert len(calls) == 1
        with session_factory()() as db, db.begin():
            feed = db.get(DataFeed, "scryfall")
            feed.state = "RUNNING"
        data_sync.refresh_due()
        assert len(calls) == 1  # Restart cannot defeat the persisted cooldown.
    finally:
        with session_factory()() as db, db.begin():
            db.execute(delete(DataFeed))


def test_cold_catalog_download_and_daily_reuse(tmp_path, monkeypatch):
    identifier = uuid.uuid4()
    raw = {
        "id": str(identifier),
        "name": "Cold catalog fixture",
        "set": "tst",
        "collector_number": "123",
        "lang": "en",
        "games": ["paper"],
        "finishes": ["nonfoil", "foil"],
        "prices": {"usd": "1.23", "usd_foil": "4.56"},
    }
    blob = gzip.compress((json.dumps(raw) + "\n").encode())
    requested = []

    def provider(request):
        requested.append(request)
        assert request.headers["User-Agent"].startswith("PakTrak/")
        assert request.headers["Accept"] == "application/json"
        if request.url.host == "api.scryfall.com":
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "type": "default_cards",
                            "updated_at": now().isoformat(),
                            "jsonl_download_uri": "https://data.scryfall.io/default-cards/fixture.jsonl.gz",
                        }
                    ]
                },
            )
        assert request.url.host == "data.scryfall.io"
        return httpx.Response(200, content=blob)

    real_now = data_sync.now
    monkeypatch.setattr(data_sync, "now", lambda: real_now() + timedelta(days=2))
    try:
        with httpx.Client(
            transport=httpx.MockTransport(provider), headers=data_sync.HEADERS
        ) as client:
            count, _ = data_sync.scryfall_sync(client, tmp_path, Progress(lambda value: None))
            assert count == 2 and len(requested) == 2
            monkeypatch.setattr(data_sync, "now", real_now)
            count, _ = data_sync.scryfall_sync(client, tmp_path, Progress(lambda value: None))
            assert count == 2 and len(requested) == 2  # No requests on the second pass.
        with session_factory()() as db:
            assert db.get(CardPrice, (identifier, "tcgplayer", "foil")).amount == Decimal("4.56")
    finally:
        with session_factory()() as db, db.begin():
            printing = db.get(Printing, identifier)
            if printing:
                snapshot_id = printing.snapshot_id
                db.execute(delete(Printing).where(Printing.id == identifier))
                db.execute(delete(CatalogSnapshot).where(CatalogSnapshot.id == snapshot_id))


def test_card_art_is_cached_unmodified_authorized_and_host_restricted(
    clients, catalog, monkeypatch
):
    owner, _ = clients()
    other, _ = clients()
    seed_metadata(catalog)
    commit(owner, preview(owner, [{"Scryfall ID": catalog[0], "Quantity": "1"}]))
    output = io.BytesIO()
    Image.new("RGB", (20, 28), "green").save(output, format="PNG")
    data = output.getvalue()
    calls = []
    original = httpx.Client

    def fetch(request):
        calls.append(request)
        assert request.url.host == "cards.scryfall.io"
        return httpx.Response(200, content=data, headers={"Content-Type": "image/png"})

    monkeypatch.setattr(
        card_images.httpx,
        "Client",
        lambda **kwargs: original(transport=httpx.MockTransport(fetch), **kwargs),
    )
    path = f"/api/v1/card-images/{catalog[0]}/0/grid"
    try:
        assert other.get(path).status_code == 404
        for _ in range(2):
            result = owner.get(path)
            assert result.status_code == 200
            assert result.content == data
            assert result.headers["cache-control"] == "private, max-age=86400"
        assert len(calls) == 1
        assert owner.get(f"/api/v1/card-images/{catalog[0]}/-1/grid").status_code == 404
        with session_factory()() as db:
            card = db.get(Printing, uuid.UUID(catalog[0]))
            card.source_json = {"image_uris": {"normal": f"https://localhost/{card.id}.jpg"}}
            assert card_images.source_image(card, 0, "grid") is None
    finally:
        from scanner.settings import get_settings

        for obj in (
            storage.client()
            .list_objects_v2(
                Bucket=get_settings().storage_bucket, Prefix=f"catalog-images/{catalog[0]}/"
            )
            .get("Contents", [])
        ):
            storage.delete(obj["Key"])
