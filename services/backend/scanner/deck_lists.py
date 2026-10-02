"""Local deck-list parsing and collection comparison; never changes inventory."""

import json
import re
from collections import Counter, defaultdict

from sqlalchemy import func, or_, select

from scanner.card_search import card_names, card_names_in
from scanner.catalog import printing_json
from scanner.csv_formats import infer_mapping, read_csv, read_text, resolve
from scanner.models import Binder, InventoryLot, Printing

MAX_DECK_BYTES = 256 * 1024
MAX_DECK_ROWS = 300
SECTIONS = {
    "main": "main",
    "mainboard": "main",
    "main deck": "main",
    "deck": "main",
    "sideboard": "sideboard",
    "side": "sideboard",
    "sb": "sideboard",
    "companion": "sideboard",
    "commander": "commander",
    "commanders": "commander",
}
SECTION_ORDER = {"commander": 0, "main": 1, "sideboard": 2}


def identity_groups(printings):
    """Same full name or oracle identity; never combine art inserts with game cards."""
    parents, seen = {}, {}

    def root(value):
        while parents[value] != value:
            parents[value] = parents[parents[value]]
            value = parents[value]
        return value

    for printing in printings:
        parents.setdefault(printing.id, printing.id)
        layout = printing.source_json.get("layout")
        family = (
            "art"
            if layout == "art_series"
            else "token"
            if layout in {"token", "double_faced_token", "emblem"}
            else "card"
        )
        aliases = [(family, "name", printing.name.casefold())]
        if printing.oracle_id:
            aliases.append((family, "oracle", printing.oracle_id))
        for alias in aliases:
            if alias in seen:
                parents[root(printing.id)] = root(seen[alias])
            else:
                seen[alias] = printing.id
    return {printing_id: root(printing_id) for printing_id in parents}


def collection_matches(db, owner_id, printings, mode="any"):
    if not printings:
        return {}, []
    match = (
        Printing.id.in_({p.id for p in printings})
        if mode == "exact"
        else or_(
            Printing.oracle_id.in_({p.oracle_id for p in printings if p.oracle_id}),
            func.lower(Printing.name).in_({p.name.lower() for p in printings}),
        )
    )
    holdings = db.execute(
        select(
            Printing, Binder.id, Binder.name, Binder.kind, func.sum(InventoryLot.quantity_remaining)
        )
        .join(InventoryLot, InventoryLot.printing_id == Printing.id)
        .join(Binder, InventoryLot.binder_id == Binder.id)
        .where(InventoryLot.owner_id == owner_id, InventoryLot.quantity_remaining > 0, match)
        .group_by(Printing.id, Binder.id)
        .order_by(Binder.name, Printing.id)
    ).all()
    all_printings = [*printings, *(row[0] for row in holdings)]
    groups = (
        {p.id: p.id for p in all_printings} if mode == "exact" else identity_groups(all_printings)
    )
    return groups, holdings


def collection_versions(db, owner_id, printings):
    """Prefer a requested edition already owned, otherwise the most-owned edition."""
    groups, holdings = collection_matches(db, owner_id, printings)
    quantities, choices = Counter(), defaultdict(dict)
    for printing, _, _, _, quantity in holdings:
        quantities[printing.id] += quantity
        choices[groups[printing.id]][printing.id] = printing
    selected, owned = {}, {}
    for printing in printings:
        available = list(choices[groups[printing.id]].values())
        owned[printing.id] = sum(quantities[p.id] for p in available)
        selected[printing.id] = (
            min(
                available,
                key=lambda p: (
                    p.id != printing.id,
                    -quantities[p.id],
                    p.language != "en",
                    p.set_code,
                    p.collector_number,
                    p.id,
                ),
            )
            if available
            else printing
        )
    return selected, owned


def compare_cards(db, owner_id, rows, mode):
    """Allocate each owned copy once across all sections and requested printings."""
    rows = sorted(
        rows, key=lambda row: (SECTION_ORDER[row[0].section], row[1].name, str(row[1].id))
    )
    needed = Counter()
    printings = {printing.id: printing for _, printing in rows}
    groups, holdings = collection_matches(db, owner_id, list(printings.values()), mode)
    for card, printing in rows:
        needed[groups[printing.id]] += card.quantity
    locations = defaultdict(dict)
    for printing, binder_id, name, kind, quantity in holdings:
        key = groups[printing.id]
        if key not in needed:
            continue
        location = locations[key].setdefault(
            binder_id, {"id": str(binder_id), "name": name, "kind": kind, "quantity": 0}
        )
        location["quantity"] += quantity
    owned = {
        key: sum(location["quantity"] for location in values.values())
        for key, values in locations.items()
    }
    remaining = dict(owned)
    cards, missing = [], {}
    for card, printing in rows:
        key = groups[printing.id]
        available = min(card.quantity, remaining.get(key, 0))
        remaining[key] = remaining.get(key, 0) - available
        shortage = card.quantity - available
        cards.append(
            {
                "printing": printing_json(printing),
                "section": card.section,
                "quantity": card.quantity,
                "owned": owned.get(key, 0),
                "needed_in_deck": needed[key],
                "available": available,
                "missing": shortage,
                "locations": list(locations[key].values()),
            }
        )
        if shortage:
            item = missing.setdefault(key, {"printing": printing_json(printing), "quantity": 0})
            item["quantity"] += shortage
    copies = sum(needed.values())
    missing_cards = sorted(
        missing.values(), key=lambda item: (item["printing"]["name"], item["printing"]["id"])
    )
    missing_copies = sum(item["quantity"] for item in missing_cards)
    return {
        "copies": copies,
        "owned_copies": copies - missing_copies,
        "missing_copies": missing_copies,
        "cards": cards,
        "missing_cards": missing_cards,
    }


def deck_name_index(db, names):
    """Resolve a whole list in batches, without a JSON catalog scan per card."""
    names = {name.lower() for name in names if name and len(name) <= 255}
    indexed = defaultdict(dict)
    if not names:
        return indexed

    def include(printing, aliases):
        for alias in aliases:
            if isinstance(alias, str) and alias.lower() in names:
                indexed[alias.lower()][printing.id] = printing

    # Full and split-card names live in the small relational column. Only matching
    # printings load their large catalog JSON; normal deck lists stop here.
    for printing in db.scalars(
        select(Printing).where(
            or_(
                func.lower(Printing.name).in_(names),
                func.lower(func.split_part(Printing.name, " // ", 1)).in_(names),
                func.lower(func.split_part(Printing.name, " // ", 2)).in_(names),
            )
        )
    ):
        include(printing, [printing.name, *printing.name.split(" // ")])
    unresolved = names - indexed.keys()
    if unresolved:
        for printing in db.scalars(select(Printing).where(card_names_in(unresolved))):
            include(printing, card_names(printing.name, printing.source_json))
    return indexed


def resolve_deck_card(db, values, name_index):
    if values["scryfall_id"]:
        return resolve(db, {**values, "finish": "unknown", "text_input": True})
    if not (values["name"] or values["set_code"] and values["collector_number"]):
        return None, "Enter a card name or a set and collector number."
    if values["name"]:
        matches = list(name_index.get(values["name"].lower(), {}).values())
        for field in ("set_code", "collector_number", "language"):
            if values[field]:
                matches = [card for card in matches if getattr(card, field) == values[field]]
    else:
        query = select(Printing)
        for field in ("set_code", "collector_number", "language"):
            if values[field]:
                query = query.where(getattr(Printing, field) == values[field])
        matches = db.scalars(query).all()
    if not matches:
        return None, "Card not found in the local catalog. Check the name or choose its printing."
    if values["name"]:
        # A full name outranks a face alias, such as Island versus Island // Island.
        matches = [
            card for card in matches if card.name.lower() == values["name"].lower()
        ] or matches
    # Art inserts can share the front name of a playable card but have another
    # oracle identity. Prefer playable printings unless supplied identifiers only
    # match an art insert; explicit printing IDs are already handled above.
    matches = [
        card for card in matches if card.source_json.get("layout") != "art_series"
    ] or matches
    if len(set(identity_groups(matches).values())) != 1:
        return None, "More than one card identity matches. Choose the card you meant."
    return min(
        matches,
        key=lambda card: (
            card.language != "en",
            card.set_code,
            card.collector_number,
            card.id,
        ),
    ), None


def commander_layout(rows, commanders):
    """Assign physical copies in input order without expanding large quantities."""
    result, position = [], 0
    for row in rows:
        left = row["quantity"]
        while left:
            section, end = (
                ("commander", commanders)
                if position < commanders
                else ("main", 100)
                if position < 100
                else ("sideboard", position + left)
            )
            count = min(left, end - position)
            result.append({**row, "section": section, "quantity": count})
            position += count
            left -= count
    return result


def preview_list(
    db,
    content,
    file_format,
    owner_id=None,
    match_mode="any",
    deck_format="casual",
    section_mode="auto",
):
    raw_bytes = content.encode("utf-8")
    if len(raw_bytes) > MAX_DECK_BYTES:
        raise ValueError("Deck lists can be up to 256 KiB.")
    explicit_sections = False
    if file_format == "csv":
        headers, source, _ = read_csv(raw_bytes, {})
        _, mapping = infer_mapping(headers, "auto")
        lower = {header.strip().casefold(): header for header in headers}
        for field, aliases in {
            "name": ["card"],
            "quantity": ["qty"],
            "set_code": ["set"],
            "section": ["section", "board", "zone"],
        }.items():
            if field not in mapping:
                mapping[field] = next((lower[alias] for alias in aliases if alias in lower), "")
        if not mapping.get("name") and not mapping.get("scryfall_id"):
            raise ValueError(
                "CSV needs a Name / Card Name or Scryfall ID column. Quantity and Section are optional."
            )
        explicit_sections = any(raw.get(mapping.get("section", ""), "").strip() for raw in source)
    else:
        # Recognized commented headings and bracketed set codes are common deck exports.
        lines = []
        for line in content.lstrip("\ufeff").splitlines():
            heading = line.strip().removeprefix("//").strip().strip("[]:").casefold()
            if heading in SECTIONS:
                explicit_sections = True
                line = SECTIONS[heading]
            if line.strip().upper().startswith("SB:"):
                explicit_sections = True
            line = re.sub(r"\s+\[([A-Za-z0-9_]+)\](?=\s|$)", r" (\1)", line)
            lines.append(line)
        headers, source, _ = read_text("\n".join(lines).encode(), {})
        mapping = {header: header for header in headers}
    if len(source) > MAX_DECK_ROWS:
        raise ValueError(
            "Deck lists can contain up to 300 card lines. Split larger lists into separate decks."
        )
    name_index = deck_name_index(
        db,
        (
            raw.get(mapping.get("name", ""), "").strip()
            for raw in source
            if not raw.get(mapping.get("scryfall_id", ""), "").strip()
        ),
    )
    rows, cached, resolved = [], {}, {}
    occurrences = Counter()
    for index, raw in enumerate(source):

        def value(field, raw=raw):
            return raw.get(mapping.get(field, ""), "").strip()

        quantity = value("quantity") or "1"
        section = SECTIONS.get((value("section") or "main").casefold())
        values = {
            field: value(field)
            for field in ("name", "scryfall_id", "set_code", "collector_number", "language")
        }
        values["set_code"], values["language"] = (
            values["set_code"].lower(),
            values["language"].lower(),
        )
        identity_error, printing = None, None
        count = (
            int(quantity) if quantity.isascii() and quantity.isdigit() and len(quantity) <= 6 else 0
        )
        quantity_error = (
            "Quantity must be a whole number from 1 to 100,000. Correct the quantity below."
            if not 1 <= count <= 100_000
            else None
        )
        section_error = (
            "Section must be Mainboard, Sideboard or Commander. Choose a section below."
            if section is None
            else None
        )
        if any(len(item) > 255 for item in values.values()):
            identity_error = (
                "Card identifiers are too long. Edit the source list and preview again."
            )
        else:
            cache_key = tuple(values.items())
            if cache_key not in cached:
                cached[cache_key] = resolve_deck_card(db, values, name_index)
            printing, identity_error = cached[cache_key]
        if printing:
            resolved[printing.id] = printing
        source_key = json.dumps(
            {**values, "quantity": quantity, "section": value("section") or "main"},
            sort_keys=True,
        )
        occurrences[source_key] += 1
        rows.append(
            {
                "line": int(raw.get("source_line", index + 2)),
                "name": values["name"] or values["scryfall_id"],
                "quantity": count,
                "section": section,
                "printing": printing_json(printing) if printing else None,
                "error": quantity_error or section_error or identity_error,
                "quantity_error": quantity_error,
                "section_error": section_error,
                "identity_error": identity_error,
                # Source identity deliberately excludes line numbers so inserting
                # a different source row does not lose reviewed choices.
                "source_key": f"{source_key}:{occurrences[source_key]}",
                "can_choose": bool(1 <= count <= 100_000 and section),
            }
        )
    if owner_id is not None and match_mode == "any":
        selected, owned = collection_versions(db, owner_id, list(resolved.values()))
        by_id = {str(p.id): p for p in resolved.values()}
        for row in rows:
            if row["printing"]:
                original = by_id[row["printing"]["id"]]
                row["collection_match"] = owned[original.id] > 0
                row["owned"] = owned[original.id]
                row["printing"] = printing_json(selected[original.id])
    automatic = deck_format == "commander" and section_mode != "listed" and not explicit_sections
    arranged = automatic and all(1 <= row["quantity"] <= 100_000 for row in rows)
    if arranged:
        rows = commander_layout(rows, 2 if section_mode == "two_commanders" else 1)
        # One source line may be split between mainboard and extras. Keep each
        # split independently reviewable when the same source is previewed again.
        for row in rows:
            row["source_key"] += f":{row['section']}:{row['quantity']}"
    return {
        "items": rows,
        "unresolved": sum(bool(row["error"]) for row in rows),
        "copies": sum(row["quantity"] for row in rows),
        "layout": {
            "applied": arranged,
            "reason": "commander_order"
            if arranged
            else "invalid_quantities"
            if automatic
            else "listed_sections"
            if explicit_sections
            else "mainboard",
            "counts": {
                section: sum(row["quantity"] for row in rows if row["section"] == section)
                for section in SECTION_ORDER
            },
        },
    }
