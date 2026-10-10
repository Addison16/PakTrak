"""Format legality and official rulings shown under a card."""

import json
import secrets
import uuid

import httpx
import pytest
from sqlalchemy import delete, select

from scanner import data_sync
from scanner.db import session_factory
from scanner.models import CardRuling, CatalogSnapshot, Printing

ORACLE = uuid.uuid4()


@pytest.fixture
def ruled_card():
    with session_factory()() as db, db.begin():
        saved = [
            {
                "oracle_id": row.oracle_id,
                "source": row.source,
                "published_at": row.published_at,
                "comment": row.comment,
            }
            for row in db.scalars(select(CardRuling))
        ]
        db.execute(delete(CardRuling))
        snapshot = CatalogSnapshot(
            source="rulings tests", checksum=secrets.token_hex(32), printings=1
        )
        db.add(snapshot)
        db.flush()
        snapshot_id = snapshot.id
        card = Printing(
            id=uuid.uuid4(),
            oracle_id=ORACLE,
            name="Ruling Fixture",
            set_code="tst",
            collector_number="40",
            language="en",
            finishes=["nonfoil"],
            snapshot_id=snapshot_id,
            source_json={
                "legalities": {"standard": "not_legal", "modern": "legal", "vintage": "restricted"}
            },
        )
        db.add(card)
        card_id = card.id
    yield card_id
    with session_factory()() as db, db.begin():
        db.execute(delete(CardRuling))
        if saved:
            db.execute(CardRuling.__table__.insert(), saved)
        db.execute(delete(Printing).where(Printing.id == card_id))
        db.execute(delete(CatalogSnapshot).where(CatalogSnapshot.id == snapshot_id))


def test_rulings_skip_malformed_entries():
    other = str(uuid.uuid4())
    rows = data_sync.normalize_rulings(
        [
            {
                "oracle_id": other,
                "source": "wotc",
                "published_at": "2020-01-02",
                "comment": " Ok. ",
            },
            {"oracle_id": other, "source": "odd", "published_at": "2020-01-02", "comment": "Kept"},
            {"oracle_id": "not-a-uuid", "published_at": "2020-01-02", "comment": "No"},
            {"oracle_id": other, "published_at": "someday", "comment": "No"},
            {"oracle_id": other, "published_at": "2020-01-02", "comment": "   "},
            {"oracle_id": other, "published_at": "2020-01-02", "comment": 5},
            "not a ruling",
        ]
    )
    assert [(row["source"], row["comment"]) for row in rows] == [("wotc", "Ok."), ("other", "Kept")]


def test_rulings_arrive_with_the_daily_update(ruled_card, tmp_path, clients):
    client, _ = clients()
    before = client.get(f"/api/v1/catalog/printings/{ruled_card}/rulings").json()
    assert before["rulings"] == [] and before["rulings_saved"] is False
    assert before["legalities"]["modern"] == "legal"

    file = [
        {
            "object": "ruling",
            "oracle_id": str(ORACLE),
            "source": "wotc",
            "published_at": "2021-06-18",
            "comment": "Second ruling.",
        },
        {
            "object": "ruling",
            "oracle_id": str(ORACLE),
            "source": "scryfall",
            "published_at": "2004-10-04",
            "comment": "First ruling.",
        },
        {
            "object": "ruling",
            "oracle_id": str(uuid.uuid4()),
            "source": "wotc",
            "published_at": "2010-01-01",
            "comment": "Another card.",
        },
    ]

    def handler(request):
        assert request.url.host == "data.scryfall.io"
        return httpx.Response(200, content=json.dumps(file).encode())

    manifest = [
        {"type": "default_cards", "download_uri": "https://data.scryfall.io/default.json"},
        {"type": "rulings", "download_uri": "https://data.scryfall.io/rulings/rulings.json"},
    ]
    with httpx.Client(transport=httpx.MockTransport(handler)) as fake:
        count = data_sync.rulings_sync(fake, manifest, tmp_path, lambda *a, **k: None)
    assert count == 3

    after = client.get(f"/api/v1/catalog/printings/{ruled_card}/rulings").json()
    assert after["rulings_saved"] is True
    assert after["rulings"] == [
        {"source": "scryfall", "published_at": "2004-10-04", "comment": "First ruling."},
        {"source": "wotc", "published_at": "2021-06-18", "comment": "Second ruling."},
    ]


def test_rulings_refuse_other_hosts_and_keep_saved_ones(ruled_card, tmp_path):
    with session_factory()() as db, db.begin():
        db.add(
            CardRuling(oracle_id=ORACLE, source="wotc", published_at="2001-01-01", comment="Kept.")
        )
    manifest = [{"type": "rulings", "download_uri": "https://example.com/rulings.json"}]
    with httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(500))) as fake:
        with pytest.raises(data_sync.FeedError):
            data_sync.rulings_sync(fake, manifest, tmp_path, lambda *a, **k: None)
    empty = [{"type": "rulings", "download_uri": "https://data.scryfall.io/r.json"}]
    with httpx.Client(
        transport=httpx.MockTransport(lambda r: httpx.Response(200, content=b"[]"))
    ) as fake:
        with pytest.raises(data_sync.FeedError):
            data_sync.rulings_sync(fake, empty, tmp_path, lambda *a, **k: None)
    with session_factory()() as db:
        assert db.scalars(select(CardRuling.comment)).all() == ["Kept."]


def test_unknown_printing_has_no_rulings(clients):
    client, _ = clients()
    assert client.get(f"/api/v1/catalog/printings/{uuid.uuid4()}/rulings").status_code == 404
