"""Shared account policy; callers lock the user when admitting or charging cards."""

from fastapi import HTTPException

from scanner.models import AccountEvent

GUEST_CARD_LIMIT = 100


def account_name(user):
    return user.profile_name or user.display_name


def scan_card_limit(user):
    if user.scan_card_limit_override is not None:
        return user.scan_card_limit_override
    return GUEST_CARD_LIMIT if user.role == "guest" else None


def account_details(user):
    limit = scan_card_limit(user)
    return {
        "role": user.role,
        "scan_cards_used": user.scan_cards_used,
        "scan_card_limit": limit,
        "scan_card_limit_override": user.scan_card_limit_override,
        "scan_cards_remaining": max(0, limit - user.scan_cards_used) if limit is not None else None,
        "scans_paused": user.scans_paused,
        "suspended": user.suspended,
        "account_version": user.account_version,
        "password_reset_pending": user.password_reset_pending,
    }


def account_json(user):
    return {
        "id": str(user.id),
        "display_name": account_name(user),
        "created_at": user.created_at,
        "approved_at": user.approved_at,
        **account_details(user),
    }


def check_scan_access(user):
    if user.suspended:
        raise HTTPException(403, "This account is suspended. Contact your administrator.")
    if user.scans_paused:
        raise HTTPException(
            403,
            "New card scans are paused for your account. Your administrator can resume scanning.",
        )


def check_scan_allowance(user):
    check_scan_access(user)
    limit = scan_card_limit(user)
    if limit is not None and user.scan_cards_used >= limit:
        message = (
            "You have used your 100 guest card scans. An administrator can approve your account for continued scanning."
            if user.role == "guest" and user.scan_card_limit_override is None
            else f"Your {limit:,}-card scan allowance is used. Ask your administrator to raise the limit or restore the default allowance."
        )
        raise HTTPException(403, message)


def record_account_event(db, user, actor, kind, **detail):
    db.add(AccountEvent(owner_id=user.id, actor_id=actor.id, kind=kind, detail=detail))
