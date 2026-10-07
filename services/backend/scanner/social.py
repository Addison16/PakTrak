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
from sqlalchemy import func, or_, select, update

from scanner.account_access import account_name
from scanner.auth import DB, Identity
from scanner.card_values import finish_prices, money, owned_copies, preferred_provider
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
    code: str = Field(min_length=4, max_length=32)


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
                }
            )
        elif link.requested_by == me.id:
            # Who a code belongs to stays private until they accept.
            result["outgoing"].append({"id": str(link.id), "created_at": link.created_at})
        else:
            result["incoming"].append(
                {"id": str(link.id), "name": account_name(person), "created_at": link.created_at}
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
    return data.model_dump()


@router.post("/requests")
def send_request(data: FriendRequest, identity: Identity, db: DB):
    me = db.scalar(select(User).where(User.id == identity.owner_id).with_for_update())
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
    code = clean_code(data.code)
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
    link = incoming_request(db, request_id, identity.owner_id)
    link.state, link.accepted_at = "accepted", now()
    db.commit()
    return {"state": "accepted"}


@router.post("/requests/{request_id}/decline")
def decline_request(request_id: uuid.UUID, identity: Identity, db: DB):
    db.delete(incoming_request(db, request_id, identity.owner_id))
    db.commit()
    return {"state": "declined"}


@router.delete("/{friendship_id}")
def remove_friend(friendship_id: uuid.UUID, identity: Identity, db: DB):
    """Removing a friend or withdrawing a request also cancels offers still waiting."""
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
        .values(state="cancelled", responded_at=now())
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
    person = friend(db, identity.owner_id, user_id)
    if not person.share_wishlist:
        raise HTTPException(403, f"{account_name(person)} isn’t sharing their wishlist.")
    result = wishlist_json(
        db, person.id, preferred_provider(db, identity.owner_id), viewer_id=identity.owner_id
    )
    for item in result["items"]:
        item.pop("notes", None)
    return {"name": account_name(person), **result}


def wanted_matches(db, holder_id, wanter_id, provider):
    """Copies the holder owns of card names on the wanter's wishlist."""
    wanted = dict(
        db.execute(
            select(func.lower(Printing.name), func.sum(WishlistItem.quantity))
            .join(Printing)
            .where(WishlistItem.owner_id == wanter_id)
            .group_by(func.lower(Printing.name))
        ).all()
    )
    if not wanted:
        return []
    rows = db.execute(
        select(Printing, InventoryLot.finish, func.sum(InventoryLot.quantity_remaining))
        .join(InventoryLot, InventoryLot.printing_id == Printing.id)
        .where(
            InventoryLot.owner_id == holder_id,
            InventoryLot.quantity_remaining > 0,
            func.lower(Printing.name).in_(wanted.keys()),
        )
        .group_by(Printing.id, InventoryLot.finish)
        .order_by(Printing.name, Printing.set_code, Printing.collector_number)
    ).all()
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
                "wanted": int(wanted[printing.name.lower()]),
                "unit_amount": money(prices.get((printing.id, priced))),
            }
        )
    return items


@router.get("/{user_id}/matches")
def friend_matches(user_id: uuid.UUID, identity: Identity, db: DB):
    """What could trade hands: their cards you want, and your cards they want."""
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
    cards = db.scalars(
        select(TradeOfferCard).where(
            TradeOfferCard.offer_id == offer.id, TradeOfferCard.side == "recipient"
        )
    ).all()
    check_side(
        db,
        identity.owner_id,
        [OfferCard(printing_id=c.printing_id, finish=c.finish, quantity=c.quantity) for c in cards],
        "You have",
    )
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
