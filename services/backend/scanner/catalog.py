"""Local printing catalog. Imports are atomic and never delete referenced printings."""

import argparse
import gzip
import hashlib
import json
import tempfile
import uuid
from datetime import timedelta
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse

import httpx
import ijson
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, or_, select, text
from sqlalchemy.dialects.postgresql import insert

from scanner.auth import DB
from scanner.card_search import card_display_name, card_name_matches, split_collector_search
from scanner.db import session_factory
from scanner.models import CardRuling, CatalogSnapshot, Printing, now

router = APIRouter(prefix="/api/v1/catalog", tags=["public catalog"])


class CardRecord(BaseModel):
    id: uuid.UUID
    oracle_id: uuid.UUID | None = None
    name: str = Field(min_length=1, max_length=255)
    set: str = Field(min_length=1, max_length=16)
    collector_number: str = Field(min_length=1, max_length=32)
    lang: str = Field(min_length=1, max_length=16)
    finishes: list[str] = Field(max_length=8)
    games: list[str]


def printing_json(printing):
    from scanner.card_images import source_image

    raw = printing.source_json
    return {
        "id": str(printing.id),
        "name": printing.name,
        "display_name": card_display_name(printing.name, raw),
        "set_code": printing.set_code,
        "collector_number": printing.collector_number,
        "language": printing.language,
        "finishes": printing.finishes,
        "set_name": raw.get("set_name") or printing.set_code.upper(),
        "type_line": raw.get("type_line", ""),
        "mana_cost": raw.get("mana_cost", ""),
        "cmc": raw.get("cmc"),
        "rarity": raw.get("rarity", ""),
        "colors": raw.get("color_identity", []),
        "image_url": f"/api/v1/card-images/{printing.id}/0/grid"
        if source_image(printing, 0, "grid")
        else None,
        "catalog_snapshot_id": str(printing.snapshot_id),
        "faces": [face.get("name") for face in printing.source_json.get("card_faces") or []],
    }


@router.get("/status")
def status(db: DB):
    latest = db.scalar(select(CatalogSnapshot).order_by(CatalogSnapshot.created_at.desc()).limit(1))
    return {
        "printings": db.scalar(select(func.count()).select_from(Printing)),
        "updated_at": latest.created_at if latest else None,
    }


@router.get("/search")
def search(
    db: DB,
    q: str = Query(min_length=2, max_length=255),
    offset: int = Query(0, ge=0),
    set_code: str = Query("", max_length=16),
    rarity: Literal["", "common", "uncommon", "rare", "mythic", "special", "bonus"] = "",
    language: str = Query("", max_length=16),
    collector_number: str = Query("", max_length=32),
    exact_name: bool = False,
    facets: bool = False,
):
    q, inline_number = split_collector_search(q)
    # Treat wildcard input literally. Search exposes only public card metadata.
    name_match = card_name_matches(q, exact=exact_name)
    condition = name_match
    try:
        condition = or_(Printing.id == uuid.UUID(q), name_match)
    except ValueError:
        pass
    if inline_number:
        condition = and_(condition, func.lower(Printing.collector_number) == inline_number.lower())
    query = select(Printing).where(condition)
    if set_code:
        query = query.where(Printing.set_code == set_code.lower())
    if rarity:
        query = query.where(Printing.source_json["rarity"].astext == rarity)
    if language:
        query = query.where(Printing.language == language.lower())
    if collector_number.strip():
        query = query.where(
            func.lower(Printing.collector_number) == collector_number.strip().lower()
        )
    cards = db.scalars(
        query.order_by(Printing.name, Printing.set_code, Printing.collector_number, Printing.id)
        .offset(offset)
        .limit(21)
    ).all()
    result = {
        "items": [printing_json(card) for card in cards[:20]],
        "next_offset": offset + 20 if len(cards) > 20 else None,
    }
    if facets:
        # Options describe the name/inline-number search before edition filters, so collectors
        # can switch editions without downloading every printing or calling Scryfall.
        rows = db.execute(
            select(
                Printing.set_code,
                func.coalesce(
                    Printing.source_json["set_name"].astext, func.upper(Printing.set_code)
                ),
                Printing.source_json["rarity"].astext,
                Printing.language,
            )
            .where(condition)
            .distinct()
        ).all()
        sets = {code: name for code, name, _, _ in rows}
        result["filters"] = {
            "sets": [
                {"code": code, "name": name}
                for code, name in sorted(sets.items(), key=lambda pair: (pair[1], pair[0]))
            ],
            "rarities": sorted({rarity for _, _, rarity, _ in rows if rarity}),
            "languages": sorted({language for _, _, _, language in rows}),
        }
    return result


@router.get("/printings/{printing_id}")
def detail(printing_id: uuid.UUID, db: DB):
    printing = db.get(Printing, printing_id)
    if printing is None:
        raise HTTPException(404, "Printing not found in this server's catalog.")
    return printing_json(printing)


@router.get("/printings/{printing_id}/rulings")
def rulings(printing_id: uuid.UUID, db: DB):
    """Format legality and official rulings, shared by every printing of the card."""
    printing = db.get(Printing, printing_id)
    if printing is None:
        raise HTTPException(404, "Printing not found in this server's catalog.")
    found = (
        db.scalars(
            select(CardRuling)
            .where(CardRuling.oracle_id == printing.oracle_id)
            .order_by(CardRuling.published_at, CardRuling.id)
        ).all()
        if printing.oracle_id
        else []
    )
    legalities = printing.source_json.get("legalities")
    return {
        "legalities": {
            str(name): str(value)
            for name, value in (legalities.items() if isinstance(legalities, dict) else [])
        },
        "rulings": [
            {
                "source": ruling.source,
                "published_at": ruling.published_at.isoformat(),
                "comment": ruling.comment,
            }
            for ruling in found
        ],
        # Lets the page say rulings have not arrived yet instead of "none".
        "rulings_saved": bool(found) or db.scalar(select(CardRuling.id).limit(1)) is not None,
    }


def records(path, progress=None):
    """Stream current gzipped JSON Lines and legacy JSON array exports."""
    with path.open("rb") as probe:
        compressed = probe.read(2) == b"\x1f\x8b"
    with path.open("rb") as source:
        handle = gzip.GzipFile(fileobj=source) if compressed else source
        first = handle.read(4096).lstrip()[:1]
        handle.seek(0)
        if first == b"[":
            for item in ijson.items(handle, "item", use_float=True):
                yield item
                if progress:
                    progress("Indexing card catalog", source.tell(), path.stat().st_size, "bytes")
        elif first == b"{":
            decoded_bytes = 0
            while line := handle.readline(256_001):
                decoded_bytes += len(line)
                if len(line) > 256_000 or decoded_bytes > 4 * 1024**3:
                    raise ValueError("Catalog exceeds the record or 4 GiB decoded-size limit.")
                if line.strip():
                    yield json.loads(line)
                    if progress:
                        progress(
                            "Indexing card catalog", source.tell(), path.stat().st_size, "bytes"
                        )
        else:
            raise ValueError("Catalog must contain Scryfall JSON Lines or a JSON array.")


def import_file(path: Path, source: str, progress=None):
    with path.open("rb") as handle:
        checksum = hashlib.file_digest(handle, "sha256").hexdigest()
    with session_factory()() as db, db.begin():
        # Serialize administrative catalog changes; readers continue on the last committed data.
        db.execute(text("SELECT pg_advisory_xact_lock(614801)"))
        existing = db.scalar(select(CatalogSnapshot).where(CatalogSnapshot.checksum == checksum))
        if existing:
            return existing.printings
        snapshot = CatalogSnapshot(source=source[:512], checksum=checksum, printings=0)
        db.add(snapshot)
        db.flush()
        count, batch = 0, []

        def flush():
            if not batch:
                return
            stmt = insert(Printing).values(batch)
            db.execute(
                stmt.on_conflict_do_update(
                    index_elements=["id"],
                    set_={
                        field: getattr(stmt.excluded, field) for field in batch[0] if field != "id"
                    },
                )
            )
            batch.clear()

        if path.stat().st_size > 4 * 1024**3:
            raise ValueError("Catalog file exceeds 4 GiB.")
        for raw in records(path, progress):
            if not isinstance(raw, dict) or len(json.dumps(raw)) > 256_000:
                raise ValueError("Invalid or oversized catalog entry.")
            card = CardRecord.model_validate(raw)
            if "paper" not in card.games:
                continue
            batch.append(
                {
                    "id": card.id,
                    "oracle_id": card.oracle_id,
                    "name": card.name,
                    "set_code": card.set.lower(),
                    "collector_number": card.collector_number,
                    "language": card.lang.lower(),
                    "finishes": card.finishes,
                    "source_json": raw,
                    "snapshot_id": snapshot.id,
                }
            )
            count += 1
            if len(batch) == 250:
                flush()
        flush()
        if count == 0:
            raise ValueError("Catalog contains no paper printings. Previous catalog is unchanged.")
        snapshot.printings = count
        return count


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--file", type=Path)
    source.add_argument("--download", choices=["default_cards", "all_cards"])
    parser.add_argument("--user-agent", default="PakTrak/0.1 (catalog sync)")
    parser.add_argument("--cache-dir", type=Path, default=Path("/tmp/scanner-catalog-cache"))
    args = parser.parse_args()
    if args.file:
        print(
            f"Imported {import_file(args.file, 'operator-supplied Scryfall JSON')} paper printings."
        )
        return
    with session_factory()() as db:
        cached = db.scalar(
            select(CatalogSnapshot)
            .where(
                CatalogSnapshot.source.contains("/" + args.download.replace("_", "-") + "/"),
                CatalogSnapshot.created_at > now() - timedelta(hours=24),
            )
            .order_by(CatalogSnapshot.created_at.desc())
            .limit(1)
        )
        if cached:
            print(
                f"Using the catalog downloaded within the last 24 hours ({cached.printings} printings)."
            )
            return
    # No arbitrary URLs, redirects, user-supplied credential forwarding, or per-card crawl.
    with httpx.Client(
        headers={"User-Agent": args.user_agent, "Accept": "application/json"}, timeout=60
    ) as client:
        manifest = client.get("https://api.scryfall.com/bulk-data")
        manifest.raise_for_status()
        record = next(item for item in manifest.json()["data"] if item["type"] == args.download)
        url = record.get("jsonl_download_uri") or record.get("download_uri")
        if not url:
            raise ValueError("Bulk manifest has no supported download URL.")
        parsed = urlparse(url)
        if parsed.scheme != "https" or parsed.hostname != "data.scryfall.io":
            raise ValueError("Unexpected bulk-data host. Check the current provider documentation.")
        args.cache_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        cached_file = args.cache_dir / (hashlib.sha256(url.encode()).hexdigest() + ".data")
        with tempfile.TemporaryDirectory(dir=args.cache_dir) as directory:
            path = Path(directory) / "cards.data"
            if cached_file.exists():
                count = import_file(cached_file, url)
                print(f"Imported {count} paper printings from the cached provider file.")
                return
            with client.stream("GET", url) as response, path.open("wb") as output:
                response.raise_for_status()
                size = 0
                for chunk in response.iter_bytes():
                    size += len(chunk)
                    if size > 4 * 1024**3:
                        raise ValueError("Bulk catalog exceeded the 4 GiB staging limit.")
                    output.write(chunk)
            path.replace(cached_file)
            count = import_file(cached_file, url)
            print(
                f"Imported {count} paper printings from {args.download}; provider timestamp {record['updated_at']}."
            )


if __name__ == "__main__":
    main()
