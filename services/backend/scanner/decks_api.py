"""Saved deck lists reference printings without moving or manufacturing holdings."""

import csv
import io
import uuid
from collections import Counter, defaultdict
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response
from pydantic import Field
from sqlalchemy import case, delete, func, select

from scanner.auth import DB, Identity
from scanner.card_images import source_image
from scanner.catalog import printing_json
from scanner.collection_api import Key, StrictModel, fingerprint, owned
from scanner.csv_formats import safe_cell, text_line
from scanner.deck_legality import DeckFormat, legality_report
from scanner.deck_lists import MAX_DECK_BYTES, collection_versions, compare_cards, preview_list
from scanner.deck_tokens import token_report
from scanner.deck_values import FinishPreference, value_report
from scanner.gallery import Provider
from scanner.models import Deck, DeckCard, Printing, User, now

router = APIRouter(prefix="/api/v1/decks", tags=["decks"])


class DeckInfo(StrictModel):
    name: str = Field(min_length=1, max_length=255, pattern=r"\S")
    format: DeckFormat = "casual"
    notes: str = Field(default="", max_length=4096)
    match_mode: Literal["any", "exact"] = "any"


class CardChoice(StrictModel):
    printing_id: uuid.UUID
    section: Literal["main", "sideboard", "commander"] = "main"
    quantity: int = Field(ge=1, le=100_000, strict=True)


class DeckCreate(DeckInfo):
    cards: list[CardChoice] = Field(default_factory=list, max_length=300)
    use_collection_versions: bool = False


class DeckEdit(DeckInfo):
    expected_version: int = Field(ge=1)
    cards: list[CardChoice] = Field(max_length=300)
    use_collection_versions: bool = False


class ArchiveDeck(StrictModel):
    expected_version: int = Field(ge=1)


class DeckPreview(StrictModel):
    content: str = Field(min_length=1, max_length=MAX_DECK_BYTES)
    file_format: Literal["text", "csv"] = "text"
    match_mode: Literal["any", "exact"] = "any"
    deck_format: DeckFormat = "casual"
    section_mode: Literal["auto", "two_commanders", "listed"] = "auto"


class DeckCheck(StrictModel):
    format: DeckFormat
    cards: list[CardChoice] = Field(max_length=300)


class DeckTokenCheck(StrictModel):
    cards: list[CardChoice] = Field(max_length=300)


class DeckValueCheck(StrictModel):
    cards: list[CardChoice] = Field(max_length=300)
    provider: Provider = "tcgplayer"
    finish_preference: FinishPreference = "nonfoil"


@router.post("/value")
def check_value(data: DeckValueCheck, identity: Identity, db: DB):
    validate_cards(db, data.cards)
    printings = {
        card.id: card
        for card in db.scalars(
            select(Printing).where(Printing.id.in_({choice.printing_id for choice in data.cards}))
        )
    }
    return value_report(
        db,
        [(choice, printings[choice.printing_id]) for choice in data.cards],
        data.provider,
        data.finish_preference,
    )


@router.post("/tokens")
def check_tokens(data: DeckTokenCheck, identity: Identity, db: DB):
    validate_cards(db, data.cards)
    printings = {
        card.id: card
        for card in db.scalars(
            select(Printing).where(Printing.id.in_({choice.printing_id for choice in data.cards}))
        )
    }
    return token_report(db, [(choice, printings[choice.printing_id]) for choice in data.cards])


@router.post("/legality")
def check_list(data: DeckCheck, identity: Identity, db: DB):
    validate_cards(db, data.cards)
    printings = {
        p.id: p
        for p in db.scalars(
            select(Printing).where(Printing.id.in_({c.printing_id for c in data.cards}))
        )
    }
    return legality_report(
        db, [(card, printings[card.printing_id]) for card in data.cards], data.format
    )


@router.post("/import-preview")
def import_preview(data: DeckPreview, identity: Identity, db: DB):
    try:
        return preview_list(
            db,
            data.content,
            data.file_format,
            identity.owner_id,
            data.match_mode,
            data.deck_format,
            data.section_mode,
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


def deck_json(deck):
    return {
        "id": str(deck.id),
        "name": deck.name,
        "format": deck.format,
        "match_mode": deck.match_mode,
        "notes": deck.notes,
        "version": deck.version,
        "archived": deck.archived,
        "updated_at": deck.updated_at,
    }


def deck_detail(db, deck):
    rows = db.execute(
        select(DeckCard, Printing)
        .join(Printing)
        .where(DeckCard.deck_id == deck.id)
        .order_by(DeckCard.section, Printing.name, Printing.id)
    ).all()
    return {
        **deck_json(deck),
        **compare_cards(db, deck.owner_id, rows, deck.match_mode),
        "legality": legality_report(db, rows, deck.format),
        "tokens": token_report(db, rows),
        "valuation": value_report(
            db, rows, db.get(User, deck.owner_id).preferred_price_source or "tcgplayer"
        ),
    }


def validate_cards(db, cards):
    if len({(card.printing_id, card.section) for card in cards}) != len(cards):
        raise HTTPException(422, "Combine duplicate printings within each deck section.")
    ids = {card.printing_id for card in cards}
    if ids and set(db.scalars(select(Printing.id).where(Printing.id.in_(ids)))) != ids:
        raise HTTPException(422, "Every deck card must have a printing in this server's catalog.")


def selected_cards(db, owner_id, data):
    validate_cards(db, data.cards)
    if not data.use_collection_versions:
        return data.cards
    if data.match_mode != "any":
        raise HTTPException(422, "Use name matching when selecting editions from your collection.")
    printings = list(
        db.scalars(select(Printing).where(Printing.id.in_({c.printing_id for c in data.cards})))
    )
    selected, _ = collection_versions(db, owner_id, printings)
    combined = Counter()
    for card in data.cards:
        combined[(selected[card.printing_id].id, card.section)] += card.quantity
    if any(quantity > 100_000 for quantity in combined.values()):
        raise HTTPException(
            422, "Combined quantities cannot exceed 100,000 per printing and section."
        )
    return [
        CardChoice(printing_id=printing_id, section=section, quantity=quantity)
        for (printing_id, section), quantity in combined.items()
    ]


@router.get("")
def list_decks(identity: Identity, db: DB, offset: int = Query(0, ge=0)):
    decks = db.scalars(
        select(Deck)
        .where(Deck.owner_id == identity.owner_id, Deck.archived.is_(False))
        .order_by(Deck.updated_at.desc(), Deck.id)
        .offset(offset)
        .limit(21)
    ).all()
    visible = decks[:20]
    ids = [deck.id for deck in visible]
    totals, previews = {}, defaultdict(list)
    deck_colors, unknown_colors = defaultdict(set), set()
    if ids:
        totals = {
            deck_id: {"copies": copies, "unique_printings": unique}
            for deck_id, copies, unique in db.execute(
                select(
                    DeckCard.deck_id,
                    func.sum(DeckCard.quantity),
                    func.count(func.distinct(DeckCard.printing_id)),
                )
                .where(DeckCard.deck_id.in_(ids))
                .group_by(DeckCard.deck_id)
            )
        }
        # Read only the identity arrays for all active deck cards, including
        # cards outside the six previews. Sideboard extras do not tint the box.
        for deck_id, colors in db.execute(
            select(DeckCard.deck_id, Printing.source_json["color_identity"])
            .join(Printing, Printing.id == DeckCard.printing_id)
            .where(DeckCard.deck_id.in_(ids), DeckCard.section.in_(["main", "commander"]))
        ):
            if isinstance(colors, list):
                deck_colors[deck_id].update(
                    color
                    for color in colors
                    if isinstance(color, str) and color in ("W", "U", "B", "R", "G")
                )
            else:
                unknown_colors.add(deck_id)
        # Rank distinct printings before loading catalog JSON. List pages never
        # load every card in every deck or run a comparison query per deck.
        grouped = (
            select(
                DeckCard.deck_id,
                DeckCard.printing_id,
                func.min(
                    case(
                        (DeckCard.section == "commander", 0),
                        (DeckCard.section == "main", 1),
                        else_=2,
                    )
                ).label("section_order"),
                func.max(case((DeckCard.section == "main", DeckCard.quantity), else_=0)).label(
                    "quantity"
                ),
            )
            .where(DeckCard.deck_id.in_(ids))
            .group_by(DeckCard.deck_id, DeckCard.printing_id)
            .subquery()
        )
        ranked = (
            select(
                grouped.c.deck_id,
                grouped.c.printing_id,
                grouped.c.section_order,
                func.row_number()
                .over(
                    partition_by=grouped.c.deck_id,
                    order_by=(
                        grouped.c.section_order,
                        case(
                            (
                                func.coalesce(
                                    Printing.source_json["type_line"].astext, ""
                                ).contains("Land"),
                                1,
                            ),
                            else_=0,
                        ),
                        grouped.c.quantity.desc(),
                        Printing.name,
                        Printing.id,
                    ),
                )
                .label("position"),
            )
            .join(Printing, Printing.id == grouped.c.printing_id)
            .subquery()
        )
        for deck_id, section_order, card in db.execute(
            select(ranked.c.deck_id, ranked.c.section_order, Printing)
            .join(Printing, Printing.id == ranked.c.printing_id)
            .where(ranked.c.position <= 6)
            .order_by(ranked.c.deck_id, ranked.c.position)
        ):
            printing = printing_json(card)
            previews[deck_id].append(
                {
                    "id": printing["id"],
                    "name": printing["name"],
                    "image_url": printing["image_url"],
                    "art_url": f"/api/v1/card-images/{card.id}/0/art"
                    if source_image(card, 0, "art")
                    else None,
                    "section": ("commander", "main", "sideboard")[section_order],
                }
            )
    return {
        "items": [
            {
                **deck_json(deck),
                **totals.get(deck.id, {"copies": 0, "unique_printings": 0}),
                "preview_cards": previews[deck.id],
                "colors": [color for color in "WUBRG" if color in deck_colors[deck.id]],
                "colors_known": deck.id not in unknown_colors,
                "cover_cards": (
                    [card for card in previews[deck.id] if card["section"] == "commander"][:2]
                    if deck.format == "commander"
                    else (
                        [card for card in previews[deck.id] if card["section"] == "main"]
                        or previews[deck.id]
                    )[:1]
                ),
            }
            for deck in visible
        ],
        "next_offset": offset + 20 if len(decks) > 20 else None,
    }


@router.post("", status_code=201)
def create_deck(data: DeckCreate, key: Key, identity: Identity, db: DB):
    db.scalar(select(User).where(User.id == identity.owner_id).with_for_update())
    digest = fingerprint(
        data.model_dump(
            exclude={"use_collection_versions"} if not data.use_collection_versions else set()
        )
    )
    deck = db.scalar(
        select(Deck).where(Deck.owner_id == identity.owner_id, Deck.request_key == key)
    )
    if deck:
        if deck.request_hash != digest:
            raise HTTPException(409, "Request key belongs to a different deck.")
        return deck_detail(db, deck)
    if (
        db.scalar(
            select(func.count())
            .select_from(Deck)
            .where(Deck.owner_id == identity.owner_id, Deck.archived.is_(False))
        )
        >= 1000
    ):
        raise HTTPException(422, "Archive a deck before creating more than 1,000 saved decks.")
    cards = selected_cards(db, identity.owner_id, data)
    deck = Deck(
        owner_id=identity.owner_id,
        request_key=key,
        request_hash=digest,
        **data.model_dump(exclude={"cards", "use_collection_versions"}),
    )
    db.add(deck)
    db.flush()
    for card in cards:
        db.add(DeckCard(deck_id=deck.id, **card.model_dump()))
    db.commit()
    return deck_detail(db, deck)


@router.get("/{deck_id}")
def get_deck(deck_id: uuid.UUID, identity: Identity, db: DB):
    return deck_detail(db, owned(db, Deck, deck_id, identity.owner_id))


@router.post("/{deck_id}")
def save_deck(deck_id: uuid.UUID, data: DeckEdit, key: Key, identity: Identity, db: DB):
    deck = owned(db, Deck, deck_id, identity.owner_id, True)
    digest = fingerprint(
        data.model_dump(
            exclude={"use_collection_versions"} if not data.use_collection_versions else set()
        )
    )
    if deck.last_edit_key == key:
        if deck.last_edit_hash != digest:
            raise HTTPException(409, "Request key belongs to a different deck edit.")
        return deck_detail(db, deck)
    if deck.archived or deck.version != data.expected_version:
        raise HTTPException(409, "This deck changed. Reload it before saving.")
    cards = selected_cards(db, identity.owner_id, data)
    db.execute(delete(DeckCard).where(DeckCard.deck_id == deck.id))
    for card in cards:
        db.add(DeckCard(deck_id=deck.id, **card.model_dump()))
    deck.name, deck.format, deck.notes = data.name.strip(), data.format, data.notes
    deck.match_mode = data.match_mode
    deck.version += 1
    deck.updated_at = now()
    deck.last_edit_key, deck.last_edit_hash = key, digest
    db.commit()
    return deck_detail(db, deck)


@router.post("/{deck_id}/archive")
def archive_deck(deck_id: uuid.UUID, data: ArchiveDeck, key: Key, identity: Identity, db: DB):
    deck = owned(db, Deck, deck_id, identity.owner_id, True)
    if deck.archived:
        return deck_json(deck)
    if deck.version != data.expected_version:
        raise HTTPException(409, "This deck changed. Reload it before archiving.")
    deck.archived = True
    deck.version += 1
    deck.updated_at = now()
    db.commit()
    return deck_json(deck)


@router.get("/{deck_id}/download")
def download_deck(
    deck_id: uuid.UUID, identity: Identity, db: DB, format: Literal["csv", "text"] = "text"
):
    deck = owned(db, Deck, deck_id, identity.owner_id, True)
    rows = db.execute(
        select(DeckCard, Printing)
        .join(Printing)
        .where(DeckCard.deck_id == deck.id)
        .order_by(DeckCard.section, Printing.name)
    ).all()
    output = io.StringIO(newline="")
    if format == "csv":
        writer = csv.writer(output)
        writer.writerow(
            [
                "Quantity",
                "Name",
                "Set Code",
                "Collector Number",
                "Language",
                "Scryfall ID",
                "Section",
            ]
        )
        for card, printing in rows:
            writer.writerow(
                [
                    safe_cell(value)
                    for value in [
                        card.quantity,
                        printing.name,
                        printing.set_code,
                        printing.collector_number,
                        printing.language,
                        str(printing.id),
                        card.section,
                    ]
                ]
            )
    else:
        for section, label in [
            ("commander", "Commander"),
            ("main", "Mainboard"),
            ("sideboard", "Sideboard"),
        ]:
            cards = [(card, printing) for card, printing in rows if card.section == section]
            if cards:
                output.write(label + "\n")
                for card, printing in cards:
                    output.write(
                        text_line(
                            {
                                "quantity": card.quantity,
                                "name": printing.name,
                                "set_code": printing.set_code,
                                "collector_number": printing.collector_number,
                            }
                        )
                        + "\n"
                    )
                output.write("\n")
    return Response(
        output.getvalue().encode("utf-8-sig" if format == "csv" else "utf-8"),
        media_type="text/csv" if format == "csv" else "text/plain",
        headers={
            "Content-Disposition": f'attachment; filename="deck-{deck.id}.{"csv" if format == "csv" else "txt"}"'
        },
    )


@router.get("/{deck_id}/buy-list")
def download_buy_list(
    deck_id: uuid.UUID,
    identity: Identity,
    db: DB,
    format: Literal["text", "csv", "cardkingdom", "tcgplayer", "manapool"] = "text",
):
    deck = owned(db, Deck, deck_id, identity.owner_id, True)
    data = deck_detail(db, deck)
    if not data["missing_copies"]:
        raise HTTPException(409, "You already own every card needed for this deck.")
    output = io.StringIO(newline="")
    if format == "csv":
        writer = csv.writer(output)
        writer.writerow(
            [
                "Quantity",
                "Name",
                "Set Code",
                "Collector Number",
                "Language",
                "Scryfall ID",
                "Match Mode",
            ]
        )
        for item in data["missing_cards"]:
            card = item["printing"]
            specific = deck.match_mode == "exact"
            writer.writerow(
                [
                    safe_cell(value)
                    for value in [
                        item["quantity"],
                        card["name"],
                        card["set_code"] if specific else "",
                        card["collector_number"] if specific else "",
                        card["language"] if specific else "",
                        card["id"] if specific else "",
                        deck.match_mode,
                    ]
                ]
            )
    elif format == "manapool" and deck.match_mode == "exact":
        for item in data["missing_cards"]:
            output.write(text_line({**item["printing"], "quantity": item["quantity"]}) + "\n")
    elif format == "tcgplayer" and deck.match_mode == "exact":
        for item in data["missing_cards"]:
            card = item["printing"]
            line = text_line({"name": card["name"], "quantity": item["quantity"]})
            output.write(f"{line} [{card['set_code'].upper()}] {card['collector_number']}\n")
    else:
        quantities = Counter()
        for item in data["missing_cards"]:
            quantities[item["printing"]["name"]] += item["quantity"]
        for name, quantity in sorted(quantities.items()):
            output.write(text_line({"name": name, "quantity": quantity}) + "\n")
    return Response(
        output.getvalue().encode("utf-8-sig" if format == "csv" else "utf-8"),
        media_type="text/csv" if format == "csv" else "text/plain",
        headers={
            "Content-Disposition": f'attachment; filename="buy-list-{deck.id}-{format}.{"csv" if format == "csv" else "txt"}"',
            "Cache-Control": "private, no-store",
        },
    )
