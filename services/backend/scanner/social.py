"""Friends by private code, read-only shared collections, and trade offers between friends.

Accounts are never listed to each other. Someone becomes reachable only by sharing
their friend code, and becomes visible only after accepting a request.
"""

import secrets
import uuid
from collections import defaultdict
from datetime import timedelta
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import Field
from sqlalchemy import case, func, or_, select, update

from scanner import federation
from scanner.account_access import account_name
from scanner.auth import DB, Identity
from scanner.card_values import (
    finish_prices,
    money,
    owned_by_name,
    owned_copies,
    preferred_provider,
    unit_price,
)
from scanner.catalog import printing_json
from scanner.collection_api import Key, StrictModel
from scanner.gallery import collection_cards
from scanner.models import (
    AccountEvent,
    Friendship,
    InventoryLot,
    Printing,
    TradeOffer,
    TradeOfferCard,
    User,
    WishlistItem,
    now,
)
from scanner.wishlist import wishlist_json

router = APIRouter(prefix="/api/v1/friends", tags=["friends"])
trades = APIRouter(prefix="/api/v1/trade-offers", tags=["trade offers"])

# No look-alike characters (0/O, 1/I/L), so a code read aloud or typed on a phone works.
ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
CODE_LENGTH = 10
MISSES_PER_HOUR = 10
MAX_PENDING_OFFERS = 20
NOT_FOUND = "That code doesn’t match anyone sharing a friend code. Check it and try again."


def new_code():
    return "".join(secrets.choice(ALPHABET) for _ in range(CODE_LENGTH))


def shown_code(code):
    return f"{code[:5]}-{code[5:]}" if code else None


def clean_code(value):
    return "".join(ch for ch in value.upper() if ch.isalnum())


def pair(first, second):
    return (first, second) if str(first) < str(second) else (second, first)


def other(friendship, owner_id):
    return friendship.user_b if friendship.user_a == owner_id else friendship.user_a


def friendship_with(db, owner_id, friend_id, lock=False):
    user_a, user_b = pair(owner_id, friend_id)
    query = select(Friendship).where(Friendship.user_a == user_a, Friendship.user_b == user_b)
    return db.scalar(query.with_for_update() if lock else query)


def friend(db, owner_id, friend_id):
    """The other account, only while both have accepted and neither is suspended."""
    link = friendship_with(db, owner_id, friend_id)
    person = db.get(User, friend_id) if link and link.state == "accepted" else None
    if person is None or person.suspended:
        raise HTTPException(404, "This friend is no longer connected.")
    return person


class CodeChange(StrictModel):
    action: Literal["new", "off"]


class SharingSettings(StrictModel):
    share_collection: bool
    share_wishlist: bool


class FriendRequest(StrictModel):
    # A code, or code@server for someone on a connected PakTrak server.
    code: str = Field(min_length=4, max_length=300)


@router.get("")
def friends(identity: Identity, db: DB):
    me = db.get(User, identity.owner_id)
    links = db.scalars(
        select(Friendship).where(or_(Friendship.user_a == me.id, Friendship.user_b == me.id))
    ).all()
    people = {
        user.id: user
        for user in db.scalars(
            select(User).where(User.id.in_({other(link, me.id) for link in links}))
        )
    }
    result = {
        "code": shown_code(me.friend_code),
        # Set when this server connects to others, so a code can be given as code@address.
        "address": federation.host_of(federation.own_url()) if federation.enabled(db) else None,
        "share_collection": me.share_collection,
        "share_wishlist": me.share_wishlist,
        "friends": [],
        "incoming": [],
        "outgoing": [],
    }
    for link in sorted(links, key=lambda item: item.created_at):
        person = people.get(other(link, me.id))
        if person is None or person.suspended:
            continue
        if link.state == "accepted":
            result["friends"].append(
                {
                    "id": str(link.id),
                    "user_id": str(person.id),
                    "name": account_name(person),
                    "since": link.accepted_at,
                    "shares_collection": person.share_collection,
                    "shares_wishlist": person.share_wishlist,
                    "server": None,
                }
            )
        elif link.requested_by == me.id:
            # Who a code belongs to stays private until they accept.
            result["outgoing"].append(
                {"id": str(link.id), "created_at": link.created_at, "server": None}
            )
        else:
            result["incoming"].append(
                {
                    "id": str(link.id),
                    "name": account_name(person),
                    "created_at": link.created_at,
                    "server": None,
                }
            )
    for link, peer in federation.remote_links(db, me.id):
        server = federation.host_of(peer.url)
        if link.state == "accepted":
            # The ID is this server's own for the link, so pages and actions find it.
            result["friends"].append(
                {
                    "id": str(link.id),
                    "user_id": str(link.id),
                    "name": link.remote_name or "Friend",
                    "since": link.accepted_at,
                    "shares_collection": link.shares_collection,
                    "shares_wishlist": link.shares_wishlist,
                    "server": server,
                }
            )
        elif link.sent_by_owner:
            result["outgoing"].append(
                {"id": str(link.id), "created_at": link.created_at, "server": server}
            )
        else:
            result["incoming"].append(
                {
                    "id": str(link.id),
                    "name": link.remote_name or "Someone",
                    "created_at": link.created_at,
                    "server": server,
                }
            )
    result["friends"].sort(key=lambda item: item["name"].casefold())
    return result


@router.post("/code")
def change_code(data: CodeChange, identity: Identity, db: DB):
    me = db.scalar(select(User).where(User.id == identity.owner_id).with_for_update())
    if data.action == "off":
        me.friend_code = None
    else:
        while True:
            code = new_code()
            if not db.scalar(select(User.id).where(User.friend_code == code)):
                break
        me.friend_code = code
    db.commit()
    return {"code": shown_code(me.friend_code)}


@router.post("/settings")
def change_sharing(data: SharingSettings, identity: Identity, db: DB):
    me = db.scalar(select(User).where(User.id == identity.owner_id).with_for_update())
    me.share_collection, me.share_wishlist = data.share_collection, data.share_wishlist
    db.commit()
    federation.share_changed(db, me)
    return data.model_dump()


@router.post("/requests")
def send_request(data: FriendRequest, identity: Identity, db: DB):
    me = db.scalar(select(User).where(User.id == identity.owner_id).with_for_update())
    raw_code, server = federation.split_code(data.code)
    misses = db.scalar(
        select(func.count())
        .select_from(AccountEvent)
        .where(
            AccountEvent.owner_id == me.id,
            AccountEvent.kind == "friend_code_miss",
            AccountEvent.created_at > now() - timedelta(hours=1),
        )
    )
    if misses >= MISSES_PER_HOUR:
        raise HTTPException(429, "Too many codes didn’t match. Wait an hour, then try again.")
    code = clean_code(raw_code)
    if server and federation.host_of(federation.clean_url(server)) != federation.host_of(
        federation.own_url()
    ):
        if not 4 <= len(code) <= 16:
            raise HTTPException(422, "Enter the friend code before the @.")
        answer = federation.request_remote_friend(db, me, code, server)
        if answer is None:
            db.add(AccountEvent(owner_id=me.id, actor_id=me.id, kind="friend_code_miss", detail={}))
            db.commit()
            raise HTTPException(404, NOT_FOUND)
        return answer
    person = db.scalar(select(User).where(User.friend_code == code)) if code else None
    if person is None or person.suspended:
        db.add(AccountEvent(owner_id=me.id, actor_id=me.id, kind="friend_code_miss", detail={}))
        db.commit()
        raise HTTPException(404, NOT_FOUND)
    if person.id == me.id:
        raise HTTPException(422, "That’s your own friend code. Share it with someone else.")
    link = friendship_with(db, me.id, person.id, lock=True)
    if link is None:
        user_a, user_b = pair(me.id, person.id)
        link = Friendship(user_a=user_a, user_b=user_b, requested_by=me.id, state="pending")
        db.add(link)
    elif link.state == "pending" and link.requested_by != me.id:
        # They already asked; entering their code answers yes.
        link.state, link.accepted_at = "accepted", now()
    db.commit()
    return {
        "state": link.state,
        "name": account_name(person) if link.state == "accepted" else None,
    }


def incoming_request(db, request_id, owner_id):
    link = db.scalar(select(Friendship).where(Friendship.id == request_id).with_for_update())
    if (
        link is None
        or link.state != "pending"
        or owner_id not in (link.user_a, link.user_b)
        or link.requested_by == owner_id
    ):
        raise HTTPException(404, "This friend request is no longer waiting.")
    return link


@router.post("/requests/{request_id}/accept")
def accept_request(request_id: uuid.UUID, identity: Identity, db: DB):
    if remote := federation.remote_link(db, identity.owner_id, request_id, "pending", lock=True):
        if remote[0].sent_by_owner:
            raise HTTPException(404, "This friend request is no longer waiting.")
        federation.accept_remote(db, db.get(User, identity.owner_id), *remote)
        return {"state": "accepted"}
    link = incoming_request(db, request_id, identity.owner_id)
    link.state, link.accepted_at = "accepted", now()
    db.commit()
    return {"state": "accepted"}


@router.post("/requests/{request_id}/decline")
def decline_request(request_id: uuid.UUID, identity: Identity, db: DB):
    if remote := federation.remote_link(db, identity.owner_id, request_id, "pending", lock=True):
        if remote[0].sent_by_owner:
            raise HTTPException(404, "This friend request is no longer waiting.")
        federation.drop_remote(db, *remote)
        return {"state": "declined"}
    db.delete(incoming_request(db, request_id, identity.owner_id))
    db.commit()
    return {"state": "declined"}


@router.delete("/{friendship_id}")
def remove_friend(friendship_id: uuid.UUID, identity: Identity, db: DB):
    """Removing a friend or withdrawing a request also cancels offers still waiting."""
    if remote := federation.remote_link(db, identity.owner_id, friendship_id, lock=True):
        federation.drop_remote(db, *remote)
        return {"removed": True}
    link = db.scalar(select(Friendship).where(Friendship.id == friendship_id).with_for_update())
    if link is None or identity.owner_id not in (link.user_a, link.user_b):
        raise HTTPException(404, "This friend is no longer connected.")
    db.execute(
        update(TradeOffer)
        .where(
            TradeOffer.state == "pending",
            or_(
                (TradeOffer.sender_id == link.user_a) & (TradeOffer.recipient_id == link.user_b),
                (TradeOffer.sender_id == link.user_b) & (TradeOffer.recipient_id == link.user_a),
            ),
        )
        .values(
            state="cancelled",
            responded_at=now(),
            # The person removing the friend already knows; only the other sender is told.
            sender_closed_at=case(
                (TradeOffer.sender_id == identity.owner_id, now()),
                else_=TradeOffer.sender_closed_at,
            ),
        )
    )
    db.delete(link)
    db.commit()
    return {"removed": True}


@router.get("/{user_id}/collection")
def friend_collection(
    user_id: uuid.UUID,
    identity: Identity,
    db: DB,
    offset: int = Query(0, ge=0),
    q: str = Query("", max_length=255),
    sort: Literal["name", "price_desc", "price_asc", "newest"] = "name",
):
    if remote := federation.remote_link(db, identity.owner_id, user_id, "accepted"):
        return remote_collection(db, identity.owner_id, remote, offset, q, sort)
    person = friend(db, identity.owner_id, user_id)
    if not person.share_collection:
        raise HTTPException(403, f"{account_name(person)} isn’t sharing their collection.")
    provider = preferred_provider(db, identity.owner_id)
    result = collection_cards(
        db,
        person.id,
        offset=offset,
        binder_id=None,
        q=q,
        provider=provider,
        color="",
        rarity="",
        card_type="",
        set_code="",
        finish="",
        sort=sort,
        seed="",
    )
    # Storage locations and notes stay private to the owner.
    for item in result["items"]:
        item["locations"], item["location_count"] = [], 0
    return {"name": account_name(person), **result}


@router.get("/{user_id}/wishlist")
def friend_wishlist(user_id: uuid.UUID, identity: Identity, db: DB):
    if remote := federation.remote_link(db, identity.owner_id, user_id, "accepted"):
        return remote_wishlist(db, identity.owner_id, remote)
    person = friend(db, identity.owner_id, user_id)
    if not person.share_wishlist:
        raise HTTPException(403, f"{account_name(person)} isn’t sharing their wishlist.")
    result = wishlist_json(
        db, person.id, preferred_provider(db, identity.owner_id), viewer_id=identity.owner_id
    )
    for item in result["items"]:
        item.pop("notes", None)
    return {"name": account_name(person), **result}


def wanted_names(db, wanter_id):
    """Copies wanted of each card name (lowercase) on someone's wishlist."""
    return dict(
        db.execute(
            select(func.lower(Printing.name), func.sum(WishlistItem.quantity))
            .join(Printing)
            .where(WishlistItem.owner_id == wanter_id)
            .group_by(func.lower(Printing.name))
        ).all()
    )


def holdings_named(db, holder_id, names):
    """(printing, finish, copies) the holder owns of the given lowercase card names."""
    if not names:
        return []
    return [
        (printing, finish, int(quantity))
        for printing, finish, quantity in db.execute(
            select(Printing, InventoryLot.finish, func.sum(InventoryLot.quantity_remaining))
            .join(InventoryLot, InventoryLot.printing_id == Printing.id)
            .where(
                InventoryLot.owner_id == holder_id,
                InventoryLot.quantity_remaining > 0,
                func.lower(Printing.name).in_(names),
            )
            .group_by(Printing.id, InventoryLot.finish)
            .order_by(Printing.name, Printing.set_code, Printing.collector_number)
        ).all()
    ]


def wanted_matches(db, holder_id, wanter_id, provider):
    """Copies the holder owns of card names on the wanter's wishlist."""
    wanted = wanted_names(db, wanter_id)
    return match_items(db, holdings_named(db, holder_id, set(wanted)), wanted, provider)


def match_items(db, rows, wanted, provider):
    prices = finish_prices(db, provider, {printing.id for printing, _, _ in rows})
    items = []
    for printing, finish, quantity in rows:
        priced = finish if finish != "unknown" else next(iter(printing.finishes), "nonfoil")
        items.append(
            {
                "printing": printing_json(printing),
                "finish": priced,
                "finish_recorded": finish != "unknown",
                "quantity": int(quantity),
                "wanted": int(wanted.get(printing.name.lower(), 0)),
                "unit_amount": money(prices.get((printing.id, priced))),
            }
        )
    return items


@router.get("/{user_id}/matches")
def friend_matches(user_id: uuid.UUID, identity: Identity, db: DB):
    """What could trade hands: their cards you want, and your cards they want."""
    if remote := federation.remote_link(db, identity.owner_id, user_id, "accepted"):
        return remote_matches(db, identity.owner_id, remote)
    person = friend(db, identity.owner_id, user_id)
    provider = preferred_provider(db, identity.owner_id)
    return {
        "name": account_name(person),
        "provider": provider,
        "they_have": wanted_matches(db, person.id, identity.owner_id, provider)
        if person.share_collection
        else [],
        "you_have": wanted_matches(db, identity.owner_id, person.id, provider)
        if person.share_wishlist
        else [],
        "shares_collection": person.share_collection,
        "shares_wishlist": person.share_wishlist,
    }


# Friends on other servers. Their server sends card IDs and counts; this server shows them
# with its own catalog and the viewer's own prices, so pictures and prices work as usual.

FINISH_VALUES = {"nonfoil", "foil", "etched", "unknown"}


def count(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


def amount_text(value):
    if not isinstance(value, str) or len(value) > 32:
        return None
    try:
        amount = Decimal(value)
    except ArithmeticError:
        return None
    return str(amount) if amount.is_finite() and amount >= 0 else None


def local_printings(db, values):
    ids = set()
    for value in values:
        try:
            ids.add(uuid.UUID(str(value)))
        except ValueError:
            continue
    if not ids:
        return {}
    return {
        printing.id: printing
        for printing in db.scalars(select(Printing).where(Printing.id.in_(ids)))
    }


def printing_of(printings, value):
    try:
        return printings.get(uuid.UUID(str(value)))
    except ValueError:
        return None


def remote_items(answer):
    items = answer.get("items")
    return [item for item in items if isinstance(item, dict)] if isinstance(items, list) else []


def remote_collection(db, owner_id, remote, offset, q, sort):
    provider = preferred_provider(db, owner_id)
    answer = federation.ask(
        db,
        *remote,
        "/friends/collection",
        {"offset": offset, "q": q, "sort": sort, "provider": provider},
    )
    rows = remote_items(answer)[:40]
    printings = local_printings(
        db,
        [
            (item.get("printing") or {}).get("id")
            for item in rows
            if isinstance(item.get("printing"), dict)
        ],
    )
    items = []
    for item in rows:
        printing = printing_of(printings, (item.get("printing") or {}).get("id"))
        if printing is None:
            continue  # Not in this server's catalog yet.
        finishes = item.get("finish_counts") if isinstance(item.get("finish_counts"), dict) else {}
        issues = item.get("pricing_issues") if isinstance(item.get("pricing_issues"), dict) else {}
        items.append(
            {
                "printing": printing_json(printing),
                "quantity": count(item.get("quantity")),
                "location_count": 0,
                "locations": [],
                "value": amount_text(item.get("value")),
                "priced_copies": count(item.get("priced_copies")),
                "price_min": amount_text(item.get("price_min")),
                "price_max": amount_text(item.get("price_max")),
                "finish_counts": {finish: count(finishes.get(finish)) for finish in FINISH_VALUES},
                "pricing_issues": {
                    name: count(issues.get(name))
                    for name in ("unknown_finish", "custom_value", "missing_price")
                },
            }
        )
    next_offset = answer.get("next_offset")
    valuation = answer.get("valuation") if isinstance(answer.get("valuation"), dict) else {}
    return {
        "name": remote[0].remote_name or "Friend",
        "copies": count(answer.get("copies")),
        "cards": count(answer.get("cards")),
        "items": items,
        "next_offset": next_offset if count(next_offset) and next_offset > offset else None,
        "valuation": {
            "provider": provider,
            "amount": amount_text(valuation.get("amount")),
            "priced_copies": count(valuation.get("priced_copies")),
            "unpriced_copies": count(valuation.get("unpriced_copies")),
            "feed": None,
        },
    }


def remote_wanted(db, answer):
    """Their wishlist rows as (item, printing), for cards in this server's catalog."""
    rows = remote_items(answer)
    printings = local_printings(db, [item.get("printing_id") for item in rows])
    found = []
    for item in rows:
        printing = printing_of(printings, item.get("printing_id"))
        finish = item.get("finish")
        if printing is None or finish not in {"any", "nonfoil", "foil", "etched"}:
            continue
        found.append((item, printing))
    return found


def remote_wishlist(db, owner_id, remote):
    provider = preferred_provider(db, owner_id)
    answer = federation.ask(db, *remote, "/friends/wishlist", {})
    rows = remote_wanted(db, answer)
    prices = finish_prices(db, provider, {printing.id for _, printing in rows})
    have = owned_by_name(db, owner_id, {printing.name for _, printing in rows})
    items, total, priced, copies = [], Decimal(0), 0, 0
    for item, printing in sorted(
        rows, key=lambda row: (row[1].name.casefold(), row[1].set_code, row[0]["finish"])
    ):
        finish, amount = unit_price(prices, printing, item["finish"])
        quantity = max(1, min(count(item.get("quantity")), 9999))
        copies += quantity
        if amount is not None:
            total += amount * quantity
            priced += quantity
        items.append(
            {
                "id": str(item.get("id"))[:64],
                "printing": printing_json(printing),
                "finish": item["finish"],
                "quantity": quantity,
                "notes": "",
                "price_finish": finish,
                "unit_amount": money(amount),
                "owned": have[printing.name.lower()],
                "created_at": item.get("created_at")
                if isinstance(item.get("created_at"), str)
                else None,
            }
        )
    return {
        "name": remote[0].remote_name or "Friend",
        "provider": provider,
        "items": items,
        "copies": copies,
        "priced_copies": priced,
        "amount": money(total) if priced or not copies else None,
    }


def remote_matches(db, owner_id, remote):
    provider = preferred_provider(db, owner_id)
    link = remote[0]
    wanted = wanted_names(db, owner_id)
    # Your wishlist's card names go to their server only while they share their collection.
    answer = federation.ask(
        db, *remote, "/friends/matches", {"names": sorted(wanted) if link.shares_collection else []}
    )
    rows = remote_items(answer)
    printings = local_printings(db, [item.get("printing_id") for item in rows])
    they_have = []
    for item in rows:
        printing = printing_of(printings, item.get("printing_id"))
        if (
            printing is not None
            and item.get("finish") in FINISH_VALUES
            and count(item.get("quantity"))
        ):
            they_have.append((printing, item["finish"], count(item["quantity"])))
    shares_collection = answer.get("share_collection") is True
    shares_wishlist = answer.get("share_wishlist") is True
    you_have = []
    if shares_wishlist:
        theirs = defaultdict(int)
        for item, printing in remote_wanted(
            db, federation.ask(db, *remote, "/friends/wishlist", {})
        ):
            theirs[printing.name.lower()] += max(1, min(count(item.get("quantity")), 9999))
        you_have = match_items(db, holdings_named(db, owner_id, set(theirs)), theirs, provider)
    return {
        "name": link.remote_name or "Friend",
        "provider": provider,
        "they_have": match_items(db, they_have, wanted, provider) if shares_collection else [],
        "you_have": you_have,
        "shares_collection": shares_collection,
        "shares_wishlist": shares_wishlist,
    }


class OfferCard(StrictModel):
    printing_id: uuid.UUID
    finish: Literal["nonfoil", "foil", "etched"]
    quantity: int = Field(ge=1, le=999, strict=True)


class OfferCreate(StrictModel):
    friend_id: uuid.UUID
    give: list[OfferCard] = Field(default_factory=list, max_length=100)
    get: list[OfferCard] = Field(default_factory=list, max_length=100)
    message: str = Field(default="", max_length=500)


def check_side(db, owner_id, cards, whose):
    if len({(card.printing_id, card.finish) for card in cards}) != len(cards):
        raise HTTPException(422, "Combine repeated cards on each side of the offer.")
    printings = {
        printing.id: printing
        for printing in db.scalars(
            select(Printing).where(Printing.id.in_({card.printing_id for card in cards}))
        )
    }
    if len(printings) != len({card.printing_id for card in cards}):
        raise HTTPException(422, "Every card in an offer must be in this server's catalog.")
    have = owned_copies(db, owner_id, {(card.printing_id, card.finish) for card in cards})
    for card in cards:
        if have[(card.printing_id, card.finish)] < card.quantity:
            name = printings[card.printing_id].name
            raise HTTPException(
                409,
                f"{whose} {have[(card.printing_id, card.finish)]} {card.finish} "
                f"{'copy' if have[(card.printing_id, card.finish)] == 1 else 'copies'} of {name}, "
                f"but the offer lists {card.quantity}.",
            )


def offer_json(db, offer, owner_id, provider, people):
    outgoing = offer.sender_id == owner_id
    rows = db.execute(
        select(TradeOfferCard, Printing)
        .join(Printing)
        .where(TradeOfferCard.offer_id == offer.id)
        .order_by(Printing.name, Printing.id)
    ).all()
    prices = finish_prices(db, provider, {printing.id for _, printing in rows})
    sides = defaultdict(list)
    totals = defaultdict(Decimal)
    unpriced = defaultdict(int)
    for card, printing in rows:
        # Seen from this account: the sender's cards are given when outgoing, received otherwise.
        side = "give" if (card.side == "sender") == outgoing else "get"
        amount = prices.get((printing.id, card.finish))
        if amount is None:
            unpriced[side] += card.quantity
        else:
            totals[side] += amount * card.quantity
        sides[side].append(
            {
                "printing": printing_json(printing),
                "finish": card.finish,
                "quantity": card.quantity,
                "unit_amount": money(amount),
            }
        )
    applied = offer.sender_applied_at if outgoing else offer.recipient_applied_at
    closed = offer.sender_closed_at if outgoing else offer.recipient_closed_at
    if offer.state == "pending":
        attention = None if outgoing else "respond"
    elif offer.state == "accepted":
        attention = None if applied else "apply"
    else:
        attention = None if closed or not outgoing else offer.state
    person = people.get(offer.recipient_id if outgoing else offer.sender_id)
    return {
        "id": str(offer.id),
        "direction": "outgoing" if outgoing else "incoming",
        "friend": {
            "id": str(person.id) if person else None,
            "name": account_name(person) if person else "Former friend",
        },
        "state": offer.state,
        "message": offer.message,
        "created_at": offer.created_at,
        "responded_at": offer.responded_at,
        "applied": applied is not None,
        "attention": None if closed and attention != "apply" else attention,
        "give": sides["give"],
        "get": sides["get"],
        "give_amount": money(totals["give"]),
        "get_amount": money(totals["get"]),
        "give_unpriced": unpriced["give"],
        "get_unpriced": unpriced["get"],
        "provider": provider,
    }


def offers_for(db, owner_id, ids=None):
    query = select(TradeOffer).where(
        or_(TradeOffer.sender_id == owner_id, TradeOffer.recipient_id == owner_id)
    )
    if ids is not None:
        query = query.where(TradeOffer.id.in_(ids))
    offers = db.scalars(query.order_by(TradeOffer.created_at.desc()).limit(60)).all()
    people = {
        user.id: user
        for user in db.scalars(
            select(User).where(
                User.id.in_({o.sender_id for o in offers} | {o.recipient_id for o in offers})
            )
        )
    }
    provider = preferred_provider(db, owner_id)
    return [offer_json(db, offer, owner_id, provider, people) for offer in offers]


def waiting_count(db, owner_id):
    """Offers that need this person, counted the same way as offer_json's attention."""
    incoming = TradeOffer.recipient_id == owner_id
    outgoing = TradeOffer.sender_id == owner_id
    return db.scalar(
        select(func.count()).where(
            or_(
                incoming
                & (TradeOffer.state == "pending")
                & TradeOffer.recipient_closed_at.is_(None),
                incoming
                & (TradeOffer.state == "accepted")
                & TradeOffer.recipient_applied_at.is_(None),
                outgoing
                & (TradeOffer.state == "accepted")
                & TradeOffer.sender_applied_at.is_(None),
                outgoing
                & TradeOffer.state.in_(("declined", "cancelled"))
                & TradeOffer.sender_closed_at.is_(None),
            )
        )
    )


@trades.get("")
def list_offers(identity: Identity, db: DB):
    items = offers_for(db, identity.owner_id)
    return {"items": items, "attention": sum(1 for item in items if item["attention"])}


@trades.post("", status_code=201)
def create_offer(data: OfferCreate, key: Key, identity: Identity, db: DB):
    me = db.scalar(select(User).where(User.id == identity.owner_id).with_for_update())
    replay = db.scalar(
        select(TradeOffer).where(TradeOffer.sender_id == me.id, TradeOffer.request_key == key)
    )
    if replay:
        if replay.message != data.message or replay.recipient_id != data.friend_id:
            raise HTTPException(409, "This request key was already used for a different offer.")
        return offers_for(db, me.id, [replay.id])[0]
    person = friend(db, me.id, data.friend_id)
    if not data.give and not data.get:
        raise HTTPException(422, "Add at least one card to the offer.")
    if data.get and not person.share_collection:
        raise HTTPException(403, f"{account_name(person)} isn’t sharing their collection.")
    pending = db.scalar(
        select(func.count())
        .select_from(TradeOffer)
        .where(TradeOffer.sender_id == me.id, TradeOffer.state == "pending")
    )
    if pending >= MAX_PENDING_OFFERS:
        raise HTTPException(
            422, f"You have {MAX_PENDING_OFFERS} offers waiting. Cancel one to send another."
        )
    check_side(db, me.id, data.give, "You have")
    check_side(db, person.id, data.get, f"{account_name(person)} has")
    offer = TradeOffer(
        sender_id=me.id,
        recipient_id=person.id,
        request_key=key,
        message=data.message.strip(),
        state="pending",
        created_at=now(),
    )
    db.add(offer)
    db.flush()
    for side, cards in (("sender", data.give), ("recipient", data.get)):
        for card in cards:
            db.add(
                TradeOfferCard(
                    offer_id=offer.id,
                    side=side,
                    printing_id=card.printing_id,
                    finish=card.finish,
                    quantity=card.quantity,
                )
            )
    db.commit()
    return offers_for(db, me.id, [offer.id])[0]


def offer_for(db, offer_id, owner_id, role):
    offer = db.scalar(select(TradeOffer).where(TradeOffer.id == offer_id).with_for_update())
    allowed = {
        "sender": offer and offer.sender_id == owner_id,
        "recipient": offer and offer.recipient_id == owner_id,
        "either": offer and owner_id in (offer.sender_id, offer.recipient_id),
    }[role]
    if not allowed:
        raise HTTPException(404, "This trade offer isn’t available.")
    return offer


def respond(db, offer, state):
    if offer.state != "pending":
        raise HTTPException(409, f"This offer was already {offer.state}.")
    offer.state, offer.responded_at = state, now()


@trades.post("/{offer_id}/accept")
def accept_offer(offer_id: uuid.UUID, identity: Identity, db: DB):
    offer = offer_for(db, offer_id, identity.owner_id, "recipient")
    friend(db, offer.recipient_id, offer.sender_id)
    cards = db.scalars(select(TradeOfferCard).where(TradeOfferCard.offer_id == offer.id)).all()
    sender = db.get(User, offer.sender_id)

    def side(name):
        return [
            OfferCard(printing_id=c.printing_id, finish=c.finish, quantity=c.quantity)
            for c in cards
            if c.side == name
        ]

    # Both people must still have what they give, or only one collection could be updated.
    check_side(db, identity.owner_id, side("recipient"), "You have")
    check_side(db, offer.sender_id, side("sender"), f"{account_name(sender)} now has")
    respond(db, offer, "accepted")
    db.commit()
    return offers_for(db, identity.owner_id, [offer.id])[0]


@trades.post("/{offer_id}/decline")
def decline_offer(offer_id: uuid.UUID, identity: Identity, db: DB):
    offer = offer_for(db, offer_id, identity.owner_id, "recipient")
    respond(db, offer, "declined")
    offer.recipient_closed_at = now()
    db.commit()
    return offers_for(db, identity.owner_id, [offer.id])[0]


@trades.post("/{offer_id}/cancel")
def cancel_offer(offer_id: uuid.UUID, identity: Identity, db: DB):
    offer = offer_for(db, offer_id, identity.owner_id, "sender")
    respond(db, offer, "cancelled")
    offer.sender_closed_at = now()
    db.commit()
    return offers_for(db, identity.owner_id, [offer.id])[0]


@trades.post("/{offer_id}/applied")
def mark_applied(offer_id: uuid.UUID, identity: Identity, db: DB):
    """Each person's app updates their own collection, then records it here."""
    offer = offer_for(db, offer_id, identity.owner_id, "either")
    if offer.state != "accepted":
        raise HTTPException(409, "Only an accepted trade can update your collection.")
    if offer.sender_id == identity.owner_id:
        offer.sender_applied_at = offer.sender_applied_at or now()
    else:
        offer.recipient_applied_at = offer.recipient_applied_at or now()
    db.commit()
    return offers_for(db, identity.owner_id, [offer.id])[0]


@trades.post("/{offer_id}/close")
def close_notice(offer_id: uuid.UUID, identity: Identity, db: DB):
    offer = offer_for(db, offer_id, identity.owner_id, "either")
    if offer.sender_id == identity.owner_id:
        offer.sender_closed_at = now()
    else:
        offer.recipient_closed_at = now()
    db.commit()
    return offers_for(db, identity.owner_id, [offer.id])[0]
