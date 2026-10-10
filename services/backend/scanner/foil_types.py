"""Named foil treatments, read from each printing's Scryfall promo types.

Scryfall keeps the finish a copy can have (nonfoil, foil, etched) separate from the
special treatment a foil printing gets. A galaxy foil or surge foil is its own printing
whose finish is "foil" and whose promo_types names the treatment, so the type of an
owned foil follows from its printing and finish without storing anything new.
"""

from sqlalchemy import case, select, tuple_
from sqlalchemy.dialects.postgresql import array

from scanner.models import InventoryLot, Printing

# Most specific first: a printing listing several takes the earlier name.
SPECIAL_FOILS = (
    ("surge", ("surgefoil",)),
    ("galaxy", ("galaxyfoil",)),
    ("fracture", ("fracturefoil",)),
    ("singularity", ("singularityfoil",)),
    ("cosmic", ("cosmicfoil",)),
    ("textured", ("textured",)),
    ("gilded", ("gilded",)),
    ("confetti", ("confettifoil",)),
    ("halo", ("halofoil",)),
    (
        "neon_ink",
        (
            "neonink",
            "neoninkblue",
            "neoninkgreen",
            "neoninkmulticolor",
            "neoninkpink",
            "neoninkpurple",
            "neoninkrainbow",
            "neoninkred",
            "neoninkthreecolor",
            "neoninkyellow",
        ),
    ),
    ("oil_slick", ("oilslick",)),
    ("step_and_compleat", ("stepandcompleat",)),
    ("double_rainbow", ("doublerainbow",)),
    ("raised", ("raisedfoil",)),
    ("ripple", ("ripplefoil",)),
    ("silver", ("silverfoil",)),
    ("invisible_ink", ("invisibleink",)),
    ("dragonscale", ("dragonscalefoil",)),
    ("chocobo_track", ("chocobotrackfoil",)),
    ("mana", ("manafoil",)),
    ("rainbow", ("rainbowfoil",)),
    ("first_place", ("firstplacefoil",)),
    ("dazzle", ("dazzlefoil",)),
    ("facet", ("facetfoil",)),
    ("embossed", ("embossed",)),
    ("silver_scroll", ("silverscroll",)),
    ("gleaming_gold", ("gleaminggold",)),
)
FOIL_TYPES = ("regular", "etched", *(key for key, _ in SPECIAL_FOILS))


def special_foil(raw):
    """The named treatment a printing's foil copies have, or None for a regular foil."""
    promos = set(raw.get("promo_types") or ())
    return next((key for key, values in SPECIAL_FOILS if promos.intersection(values)), None)


def owned_foil_type():
    """SQL for the foil type of an owned copy; NULL for nonfoil and unknown finishes."""
    promos = Printing.source_json["promo_types"]
    return case(
        (InventoryLot.finish == "etched", "etched"),
        (InventoryLot.finish != "foil", None),
        *((promos.has_any(array(values)), key) for key, values in SPECIAL_FOILS),
        else_="regular",
    )


def foil_versions(db, cards):
    """Each printing's special foil siblings: same name, set and language, foil available.

    A scan usually matches the regular printing, while a galaxy or surge foil is a
    separate printing with its own collector number and its own price.
    """
    keys = {(card.set_code, card.name, card.language) for card in cards}
    if not keys:
        return {}
    siblings = {}
    for printing in db.scalars(
        select(Printing)
        .where(tuple_(Printing.set_code, Printing.name, Printing.language).in_(keys))
        .order_by(Printing.collector_number)
    ):
        kind = special_foil(printing.source_json)
        if kind and "foil" in printing.finishes:
            siblings.setdefault((printing.set_code, printing.name, printing.language), []).append(
                (printing, kind)
            )
    return {
        card.id: [
            (printing, kind)
            for printing, kind in siblings.get((card.set_code, card.name, card.language), [])
            if printing.id != card.id
        ]
        for card in cards
    }
