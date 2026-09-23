"""Daily public bulk feeds. One server worker; no per-card price API requests."""

import logging
import re
import tempfile
import time
import uuid
from datetime import timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path
from urllib.parse import urlparse

import httpx
import ijson
from sqlalchemy import delete, insert, select, text

from scanner.catalog import import_file
from scanner.db import session_factory
from scanner.models import CardPrice, CatalogSnapshot, DataFeed, Printing, now
from scanner.progress import Progress

log = logging.getLogger(__name__)
HEADERS = {
    "User-Agent": "PakTrak/0.1 (daily collection catalog and price cache)",
    "Accept": "application/json",
}
FEEDS = ("scryfall", "cardkingdom", "manapool")
PROVIDERS = {
    "tcgplayer": {
        "name": "TCGplayer",
        "feed": "scryfall",
        "kind": "Market · via Scryfall",
        "url": "https://www.tcgplayer.com",
    },
    "cardkingdom": {
        "name": "Card Kingdom",
        "feed": "cardkingdom",
        "kind": "NM retail",
        "url": "https://www.cardkingdom.com",
    },
    "manapool": {
        "name": "ManaPool",
        "feed": "manapool",
        "kind": "NM lowest listing",
        "url": "https://manapool.com",
    },
}
URLS = {
    "cardkingdom": "https://api.cardkingdom.com/api/v2/pricelist",
    "manapool": "https://manapool.com/api/v1/prices/singles",
}


class FeedError(Exception):
    def __init__(self, message, retry_seconds=3600):
        super().__init__(message)
        self.retry_seconds = retry_seconds


def check_response(response):
    if response.status_code in {429, 503}:
        retry = response.headers.get("Retry-After", "3600")
        try:
            seconds = int(retry)
        except ValueError:
            from email.utils import parsedate_to_datetime

            try:
                seconds = int((parsedate_to_datetime(retry) - now()).total_seconds())
            except (TypeError, ValueError, OverflowError):
                seconds = 3600
        raise FeedError(
            "Provider asked us to wait. The saved prices remain available.", max(60, seconds)
        )
    response.raise_for_status()


def trusted_url(value, host):
    if not isinstance(value, str) or len(value) > 1024:
        return None
    parsed = urlparse(value)
    return (
        value
        if parsed.scheme == "https"
        and parsed.hostname == host
        and not parsed.username
        and parsed.port in {None, 443}
        else None
    )


def amount(value, cents=False):
    if value is None or isinstance(value, bool):
        return None
    try:
        price = Decimal(str(value)) / (100 if cents else 1)
        return (
            price.quantize(Decimal("0.0001"))
            if price.is_finite() and 0 < price < 1_000_000_000
            else None
        )
    except InvalidOperation:
        return None


def normalize_prices(provider, rows, known):
    """Match UUID and finish only. Omit ambiguous catalog mappings, never guess."""
    result, ambiguous = {}, set()
    seen = 0
    for raw in rows:
        seen += 1
        if not isinstance(raw, dict) or "scryfall_id" not in raw:
            raise FeedError("The provider changed its feed format. Previous prices are preserved.")
        try:
            printing_id = uuid.UUID(raw["scryfall_id"] or "")
        except (ValueError, TypeError, AttributeError):
            continue
        finishes = known.get(printing_id)
        if not finishes:
            continue
        values = []
        if provider == "cardkingdom":
            if "price_retail" not in raw or raw.get("is_foil") not in {"true", "false"}:
                raise FeedError(
                    "Card Kingdom's price format changed. Previous prices are preserved."
                )
            finish = "foil" if raw["is_foil"] == "true" else "nonfoil"
            if re.search(r"\betched\b", raw.get("variation", ""), re.I):
                finish = "etched"
            # An etched-only printing can be flagged simply as foil by the store.
            if finish == "foil" and set(finishes) == {"etched"}:
                finish = "etched"
            path = raw.get("url", "")
            url = (
                trusted_url("https://www.cardkingdom.com/" + path, "www.cardkingdom.com")
                if path.startswith("mtg/")
                else None
            )
            price = amount(raw["price_retail"])
            # Retail is a NM reference even when only lower grades are in stock.
            available = (raw.get("condition_values") or {}).get("nm_qty", 0) > 0
            values.append((finish, price, url, available))
        else:
            for finish, suffix in (("nonfoil", ""), ("foil", "_foil"), ("etched", "_etched")):
                field = "price_cents_nm" + suffix
                if field not in raw:
                    raise FeedError(
                        "ManaPool's price format changed. Previous prices are preserved."
                    )
                price = amount(raw[field], cents=True)
                values.append(
                    (finish, price, trusted_url(raw.get("url"), "manapool.com"), price is not None)
                )
        for finish, price, url, available in values:
            if finish not in finishes or price is None:
                continue
            key = (printing_id, finish)
            if key in result:
                ambiguous.add(key)
            result[key] = {
                "printing_id": printing_id,
                "provider": provider,
                "finish": finish,
                "amount": price,
                "url": url,
                "available": available,
            }
    if not seen or not result:
        raise FeedError("No matching prices arrived. Previous prices are preserved.")
    return [value for key, value in result.items() if key not in ambiguous]


def replace_prices(provider, values):
    if not values:
        raise FeedError("No valid prices arrived. Previous prices are preserved.")
    with session_factory()() as db, db.begin():
        db.execute(delete(CardPrice).where(CardPrice.provider == provider))
        for start in range(0, len(values), 1000):
            db.execute(insert(CardPrice), values[start : start + 1000])


def save_progress(name, value):
    with session_factory()() as db, db.begin():
        feed = db.get(DataFeed, name)
        feed.progress = value


def download(client, url, path, progress, limit):
    with client.stream("GET", url) as response:
        check_response(response)
        size = response.headers.get("Content-Length", "")
        # Content-Length measures compressed transfer bytes, not decoded iter_bytes.
        total = (
            int(size) if size.isdigit() and not response.headers.get("Content-Encoding") else None
        )
        if total and total > limit:
            raise FeedError("The data file exceeds this server's download limit.")
        count = 0
        progress("Downloading data", 0, total, "bytes", force=True)
        with path.open("wb") as handle:
            for chunk in response.iter_bytes(128 * 1024):
                count += len(chunk)
                if count > limit:
                    raise FeedError("The data file exceeds this server's download limit.")
                handle.write(chunk)
                progress("Downloading data", count, total, "bytes")
        progress("Download complete", count, count, "bytes", force=True)


def scryfall_sync(client, directory, progress):
    with session_factory()() as db:
        snapshot = db.scalar(
            select(CatalogSnapshot).order_by(CatalogSnapshot.created_at.desc()).limit(1)
        )
    source_time = snapshot.created_at.isoformat() if snapshot else None
    # Reuse a recent operator import on first boot. This also avoids a redundant
    # 80+ MB download when adding the price worker to an existing installation.
    fresh = snapshot and snapshot.created_at > now() - timedelta(hours=24)
    if not fresh:
        progress("Checking daily catalog", force=True)
        response = client.get("https://api.scryfall.com/bulk-data")
        check_response(response)
        manifest = next(item for item in response.json()["data"] if item["type"] == "default_cards")
        url = trusted_url(
            manifest.get("jsonl_download_uri") or manifest.get("download_uri"), "data.scryfall.io"
        )
        if not url:
            raise FeedError("Scryfall returned an unsupported download address.")
        path = directory / "catalog.data"
        download(client, url, path, progress, 4 * 1024**3)
        import_file(path, url, progress=progress)
        source_time = str(manifest["updated_at"])[:100]
    progress("Indexing TCGplayer prices", force=True)
    values = []
    with session_factory()() as db:
        latest = db.scalar(
            select(CatalogSnapshot).order_by(CatalogSnapshot.created_at.desc()).limit(1)
        )
        total = latest.printings if latest else 0
        query = (
            select(Printing)
            .where(Printing.snapshot_id == latest.id)
            .execution_options(yield_per=500)
        )
        for count, card in enumerate(db.scalars(query), 1):
            prices = card.source_json.get("prices") or {}
            url = trusted_url(
                (card.source_json.get("purchase_uris") or {}).get("tcgplayer"), "www.tcgplayer.com"
            )
            if not url and isinstance(card.source_json.get("tcgplayer_id"), int):
                url = "https://www.tcgplayer.com/product/" + str(card.source_json["tcgplayer_id"])
            for finish, field in (
                ("nonfoil", "usd"),
                ("foil", "usd_foil"),
                ("etched", "usd_etched"),
            ):
                price = amount(prices.get(field))
                if price is not None and finish in card.finishes:
                    values.append(
                        {
                            "printing_id": card.id,
                            "provider": "tcgplayer",
                            "finish": finish,
                            "amount": price,
                            "url": url,
                            "available": None,
                        }
                    )
            if count % 500 == 0:
                progress("Indexing TCGplayer prices", count, total)
    replace_prices("tcgplayer", values)
    return len(values), source_time


def store_sync(client, name, directory, progress):
    path = directory / "prices.json"
    download(client, URLS[name], path, progress, 256 * 1024**2)
    with session_factory()() as db:
        known = dict(db.execute(select(Printing.id, Printing.finishes)).all())
    progress("Matching printings and finishes", force=True)
    with path.open("rb") as handle:
        values = normalize_prices(name, ijson.items(handle, "data.item"), known)
    with path.open("rb") as handle:
        meta = next(ijson.items(handle, "meta"), {})
    source_time = meta.get("created_at") if name == "cardkingdom" else meta.get("as_of")
    progress("Saving prices", force=True)
    replace_prices(name, values)
    return len(values), str(source_time)[:100] if source_time else None


def refresh_due():
    engine = session_factory().kw["bind"]
    with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as lock:
        if not lock.scalar(text("SELECT pg_try_advisory_lock(614803)")):
            return
        try:
            with session_factory()() as db, db.begin():
                for name in FEEDS:
                    if not db.get(DataFeed, name):
                        db.add(DataFeed(name=name))
            for name in FEEDS:
                with session_factory()() as db, db.begin():
                    feed = db.get(DataFeed, name)
                    if feed.state == "RUNNING":
                        # No other worker holds the lock: the previous process ended.
                        feed.state = "WAITING"
                        feed.error = "Resuming an interrupted update after the provider cooldown."
                    if feed.next_at > now():
                        continue
                    feed.state, feed.started_at, feed.error = "RUNNING", now(), None
                    feed.progress = {}
                    # Set before networking so repeated container restarts do not
                    # bypass provider cooldowns after an interrupted download.
                    feed.next_at = now() + timedelta(hours=1)
                try:
                    progress = Progress(lambda value, name=name: save_progress(name, value))
                    with (
                        httpx.Client(
                            headers=HEADERS,
                            timeout=httpx.Timeout(180, connect=15),
                            follow_redirects=False,
                        ) as client,
                        tempfile.TemporaryDirectory(prefix="scanner-feed-") as directory,
                    ):
                        count, source_time = (
                            scryfall_sync(client, Path(directory), progress)
                            if name == "scryfall"
                            else store_sync(client, name, Path(directory), progress)
                        )
                    with session_factory()() as db, db.begin():
                        feed = db.get(DataFeed, name)
                        feed.state, feed.records, feed.source_time = "READY", count, source_time
                        feed.checked_at = feed.updated_at = now()
                        feed.next_at = now() + timedelta(hours=24)
                        feed.failures, feed.progress, feed.error = 0, {}, None
                    log.info("Updated %s: %s prices", name, count)
                except Exception as exc:
                    log.warning("Data update failed: %s (%s)", name, type(exc).__name__)
                    with session_factory()() as db, db.begin():
                        feed = db.get(DataFeed, name)
                        feed.state, feed.checked_at = "FAILED", now()
                        feed.failures += 1
                        delay = max(
                            min(24 * 3600, 3600 * 2 ** min(feed.failures - 1, 5)),
                            exc.retry_seconds if isinstance(exc, FeedError) else 0,
                        )
                        feed.next_at = now() + timedelta(seconds=delay)
                        feed.error = (
                            str(exc)[:255]
                            if isinstance(exc, FeedError)
                            else "The provider update could not finish. Saved data is still available; the server will retry."
                        )
        finally:
            lock.execute(text("SELECT pg_advisory_unlock(614803)"))


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    while True:
        try:
            refresh_due()
        except Exception:
            log.exception("Data worker could not check scheduled updates")
        time.sleep(30)
