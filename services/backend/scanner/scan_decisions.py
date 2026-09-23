"""Durable reviewed matches for deck-only scans; these never create inventory."""

from fastapi import HTTPException

from scanner.models import Printing


def confirm_for_deck(db, row, printing_id, finish, expected_version, key, digest):
    receipt = row.recognition.get("_deck_approval", {})
    if receipt.get("key") == key:
        if receipt.get("hash") != digest:
            raise HTTPException(409, "This request key belongs to another card decision.")
        return
    if row.version != expected_version or row.state not in {"NEEDS_REVIEW", "COMMITTED"}:
        raise HTTPException(409, "This card changed. Refresh before saving its match.")
    card = db.get(Printing, printing_id) if printing_id else None
    if not card or finish != "unknown" and finish not in card.finishes:
        raise HTTPException(422, "Choose a catalog printing and a supported finish.")
    row.confirmed_printing_id = card.id
    row.finish = finish
    row.state = "COMMITTED"
    row.version += 1
    row.recognition = {
        **row.recognition,
        "auto_confirmed": False,
        "_deck_approval": {"key": key, "hash": digest},
    }
