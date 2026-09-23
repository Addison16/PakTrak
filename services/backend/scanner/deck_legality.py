"""Advisory paper-deck construction checks using the server's cached catalog.

Rules: MTR 6.1/7.1; CR 100, 702.124, 903 (reviewed 2026-09-20).
Never blocks saving a deck plan or makes an external request.
"""

import re
from collections import Counter, defaultdict
from datetime import timedelta
from typing import Literal

from sqlalchemy import select

from scanner.deck_lists import identity_groups
from scanner.models import CatalogSnapshot, now

DeckFormat = Literal[
    "casual",
    "commander",
    "standard",
    "modern",
    "pioneer",
    "pauper",
    "legacy",
    "vintage",
    "limited",
    "other",
]
CONSTRUCTED = {"standard", "modern", "pioneer", "pauper", "legacy", "vintage"}
COLORS = {"W": "white", "U": "blue", "B": "black", "R": "red", "G": "green"}
BASIC_TYPES = dict(zip(("Plains", "Island", "Swamp", "Mountain", "Forest"), COLORS, strict=True))
NUMBERS = {
    word: number
    for number, word in enumerate(
        "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty".split()
    )
}


def front(printing):
    raw = printing.source_json
    faces = raw.get("card_faces") or []
    return faces[0] if faces else raw


def oracle(printing):
    return front(printing).get("oracle_text", "").replace("’", "'")


def has_ability(printing, ability):
    # The keyword array includes "Partner" on cards with "Partner with".
    # Only the actual ability line determines which pair is permitted.
    return bool(
        re.search(
            r"(?:^|\n)" + re.escape(ability) + r"(?:\s*\([^\n]*\))?\.?\s*(?:$|\n)",
            oracle(printing),
            re.I,
        )
    )


def commander_eligible(printing):
    face = front(printing)
    types = face.get("type_line", "")
    if re.search(r"\bcan be your commander\.", oracle(printing), re.I):
        return True
    outside_creature = "isn't on the battlefield" in oracle(
        printing
    ) and "creature in addition to its other types" in oracle(printing)
    return "Legendary" in types and (
        "Creature" in types
        or outside_creature
        or "Vehicle" in types
        or "Spacecraft" in types
        and face.get("power") is not None
        and face.get("toughness") is not None
    )


def background(printing):
    types = front(printing).get("type_line", "")
    return all(kind in types for kind in ("Legendary", "Enchantment", "Background"))


def commander_pair(first, second):
    for leader, other in ((first, second), (second, first)):
        if has_ability(leader, "Choose a Background") and background(other):
            return "background"
        types = front(other).get("type_line", "")
        if (
            has_ability(leader, "Doctor's companion")
            and "Legendary" in types
            and "Creature" in types
            and types.split("—")[-1].strip() == "Time Lord Doctor"
            and "Creature" in front(leader).get("type_line", "")
        ):
            return "doctor"
    if has_ability(first, "Partner") and has_ability(second, "Partner"):
        return "partner"
    if has_ability(first, "Friends forever") and has_ability(second, "Friends forever"):
        return "friends"
    variants = [
        set(re.findall(r"(?:^|\n)Partner\s*[—–-]\s*([^\n(.]+)", oracle(p), re.I))
        for p in (first, second)
    ]
    if {v.strip().casefold() for v in variants[0]} & {v.strip().casefold() for v in variants[1]}:
        return "partner_variant"
    named = [re.search(r"(?:^|\n)Partner with ([^\n(]+)", oracle(p), re.I) for p in (first, second)]
    if (
        all(named)
        and named[0][1].strip().rstrip(".").casefold()
        == front(second).get("name", second.name).casefold()
        and named[1][1].strip().rstrip(".").casefold()
        == front(first).get("name", first.name).casefold()
    ):
        return "named_partner"
    return None


def copy_limit(printing, default):
    if "Basic" in front(printing).get("type_line", "").split():
        return None
    text = oracle(printing)
    if re.search(r"A deck can have any number of cards named ", text, re.I):
        return None
    match = re.search(r"A deck can have up to (\w+) cards named ", text, re.I)
    if match:
        return int(match[1]) if match[1].isdigit() else NUMBERS.get(match[1].lower(), default)
    return default


def check_deck(rows, deck_format, catalog_updated_at=None, checked_at=None):
    checked_at = checked_at or now()
    counts = Counter()
    for card, _ in rows:
        counts[card.section] += card.quantity
    report = {
        "format": deck_format,
        "status": "not_checked",
        "issues": [],
        "counts": {section: counts[section] for section in ("commander", "main", "sideboard")},
        "catalog_updated_at": catalog_updated_at,
        "checked_at": checked_at,
        "rules_version": "2026-09-20",
        "checks": [],
        "limitations": [
            "Companion declarations, Commander brackets and event-specific house rules are not checked."
        ],
    }
    issues = report["issues"]

    def issue(code, message, cards=(), severity="error"):
        issues.append(
            {
                "code": code,
                "message": message,
                "severity": severity,
                "printing_ids": sorted({str(p.id) for p in cards}),
            }
        )

    if deck_format not in CONSTRUCTED | {"commander", "limited"}:
        issue(
            "choose_format",
            "Choose a supported format to check this deck against its rules.",
            severity="info",
        )
        return report
    report["checks"] = ["Deck and sideboard size", "Card eligibility"]
    active = [(c, p) for c, p in rows if deck_format != "commander" or c.section != "sideboard"]
    printings = {p.id: p for _, p in active}
    if not catalog_updated_at or catalog_updated_at < checked_at - timedelta(hours=72):
        issue(
            "catalog_stale",
            "Card legality data is missing or more than 72 hours old. Refresh the catalog before relying on this check.",
            severity="warning",
        )
    if deck_format == "commander":
        report["checks"] += [
            "Commander eligibility and pairing",
            "Color identity",
            "Singleton and card-specific copy limits",
        ]
        total = counts["main"] + counts["commander"]
        if total != 100:
            issue(
                "deck_size",
                f"Commander needs exactly 100 cards including its commander(s); this deck has {total}.",
            )
        if counts["sideboard"]:
            issue(
                "commander_extras",
                f"{counts['sideboard']} sideboard cards are saved as extras and excluded from the 100-card deck and its legality checks. Commander has no playable sideboard.",
                severity="info",
            )
        leaders = [(c, p) for c, p in active if c.section == "commander"]
        pair = (
            commander_pair(leaders[0][1], leaders[1][1])
            if len(leaders) == counts["commander"] == 2
            else None
        )
        if counts["commander"] not in (1, 2) or len(leaders) != counts["commander"]:
            issue(
                "commander_count",
                "Choose one commander, or two distinct commanders with a compatible partner ability.",
                [p for _, p in leaders],
            )
        elif len(leaders) == 2 and not pair:
            issue(
                "commander_pair",
                "These two cards do not have a compatible partner, named-partner, Background or Doctor's companion pairing.",
                [p for _, p in leaders],
                "error"
                if all(front(p).get("type_line") and "oracle_text" in front(p) for _, p in leaders)
                else "warning",
            )
        for _, p in leaders:
            if (
                front(p).get("type_line")
                and not commander_eligible(p)
                and not (pair == "background" and background(p))
            ):
                issue(
                    "commander_eligibility",
                    f"{p.name} cannot be a commander in this configuration.",
                    [p],
                )
        identities_known = bool(leaders) and all(
            isinstance(p.source_json.get("color_identity"), list) for _, p in leaders
        )
        identity = set().union(
            *(set(p.source_json.get("color_identity") or []) for _, p in leaders)
        )
        choices = sum(
            "choose a color before the game begins" in oracle(p).lower() for _, p in leaders
        )
        required = {}
        for p in printings.values():
            colors = p.source_json.get("color_identity")
            if not isinstance(colors, list):
                issue("color_unknown", f"Color identity is missing for {p.name}.", [p], "warning")
                continue
            # Intrinsic mana from basic land types also matters (for example
            # colorless lands with basic types), in addition to color identity.
            colors = set(colors)
            for face in p.source_json.get("card_faces") or [p.source_json]:
                if "Land" in face.get("type_line", ""):
                    colors.update(
                        color
                        for name, color in BASIC_TYPES.items()
                        if name in face.get("type_line", "").split()
                    )
            required[p.id] = colors
        outside = set().union(*required.values()) - identity if required else set()
        if identities_known and choices and len(outside) <= choices:
            identity |= outside
            names = (
                ", ".join(COLORS[color] for color in COLORS if color in outside)
                or "any permitted color"
            )
            issue(
                "commander_color_choice",
                f"Your commander(s) allow a color choice before the game. Choose {names} for this list.",
                severity="info",
            )
        if identities_known:
            for p in printings.values():
                outside = required.get(p.id, set()) - identity
                if outside:
                    names = ", ".join(COLORS.get(color, color) for color in sorted(outside))
                    issue(
                        "color_identity",
                        f"{p.name} includes {names} outside the commander color identity.",
                        [p],
                    )
    else:
        minimum = 40 if deck_format == "limited" else 60
        if counts["main"] < minimum:
            issue(
                "deck_size",
                f"{deck_format.title()} needs at least {minimum} mainboard cards; this deck has {counts['main']}.",
            )
        if counts["commander"]:
            issue(
                "unexpected_commander",
                f"{deck_format.title()} does not use a commander section. Move those cards to the mainboard or sideboard.",
            )
        if deck_format == "limited":
            issue(
                "limited_pool",
                "Limited allows any number of copies from your draft/sealed pool. PakTrak cannot verify the event's card pool.",
                severity="warning",
            )
        else:
            report["checks"].append("Combined copy limits and restricted cards")
            if counts["sideboard"] > 15:
                issue(
                    "sideboard_size",
                    f"The sideboard has {counts['sideboard']} cards; the maximum is 15.",
                )
    for p in printings.values():
        raw, face = p.source_json, front(p)
        types = face.get("type_line", "")
        if not types or "oracle_text" not in face:
            issue(
                "card_data_missing", f"Rules metadata is incomplete for {p.name}.", [p], "warning"
            )
        if (
            raw.get("layout")
            in {
                "token",
                "double_faced_token",
                "emblem",
                "art_series",
                "planar",
                "scheme",
                "vanguard",
            }
            or any(kind in types.split(" — ")[0].split() for kind in ("Conspiracy", "Dungeon"))
            or raw.get("oversized")
            or raw.get("border_color") in {"gold", "silver"}
            or raw.get("security_stamp") == "acorn"
            or raw.get("games") is not None
            and "paper" not in raw["games"]
        ):
            issue(
                "non_playable", f"{p.name} is not a playable paper-deck card in this printing.", [p]
            )
        if deck_format != "limited":
            legality = (raw.get("legalities") or {}).get(deck_format)
            if legality in {"banned", "not_legal"}:
                issue(
                    "card_legality",
                    f"{p.name} is {'banned' if legality == 'banned' else 'not legal'} in {deck_format.title()}.",
                    [p],
                )
            elif legality not in {"legal", "restricted"}:
                issue(
                    "legality_unknown",
                    f"{deck_format.title()} legality is missing for {p.name}.",
                    [p],
                    "warning",
                )
    if deck_format != "limited":
        groups = identity_groups(list(printings.values()))
        copies, members = Counter(), defaultdict(dict)
        for card, p in active:
            copies[groups[p.id]] += card.quantity
            members[groups[p.id]][p.id] = p
        for group, quantity in copies.items():
            cards = list(members[group].values())
            restricted = any(
                (p.source_json.get("legalities") or {}).get(deck_format) == "restricted"
                for p in cards
            )
            if not restricted and any(
                not front(p).get("type_line") or "oracle_text" not in front(p) for p in cards
            ):
                continue
            limits = [copy_limit(p, 1 if deck_format == "commander" else 4) for p in cards]
            limit = 1 if restricted else None if None in limits else max(limits)
            if limit is not None and quantity > limit:
                issue(
                    "restricted_copies" if restricted else "copy_limit",
                    f"{cards[0].name}: {quantity} copies across the checked sections; the limit is {limit}.",
                    cards,
                )
    report["status"] = (
        "issues"
        if any(i["severity"] == "error" for i in issues)
        else "incomplete"
        if any(i["severity"] == "warning" for i in issues)
        else "legal"
    )
    return report


def legality_report(db, rows, deck_format):
    active = [p for c, p in rows if deck_format != "commander" or c.section != "sideboard"]
    ids = {p.snapshot_id for p in active}
    dates = (
        dict(
            db.execute(
                select(CatalogSnapshot.id, CatalogSnapshot.created_at).where(
                    CatalogSnapshot.id.in_(ids)
                )
            ).all()
        )
        if ids
        else {}
    )
    oldest = (
        min((dates[p.snapshot_id] for p in active), default=None)
        if all(p.snapshot_id in dates for p in active)
        else None
    )
    return check_deck(rows, deck_format, oldest)
