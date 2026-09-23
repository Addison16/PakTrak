"""Personal account settings and versioned administrator access controls."""

import secrets
import uuid

import httpx
from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import delete, func, select

from scanner import identity_admin
from scanner.account_access import account_json, record_account_event
from scanner.auth import DB, Admin, Identity
from scanner.models import AccountEvent, Deck, InventoryLot, LoginSession, Scan, User, now
from scanner.settings import get_settings

router = APIRouter(prefix="/api/auth", tags=["accounts"])


class Versioned(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_version: int = Field(ge=1, strict=True)


class ProfileEdit(Versioned):
    display_name: str = Field(min_length=1, max_length=80, pattern=r"\S")


class AccountAccess(Versioned):
    suspended: bool = Field(strict=True)
    scans_paused: bool = Field(strict=True)
    scan_card_limit_override: int | None = Field(ge=0, le=1_000_000_000, strict=True)


def locked_account(db, user_id, expected_version, *, protect_admin=False):
    user = db.scalar(select(User).where(User.id == user_id).with_for_update())
    if user is None:
        raise HTTPException(404, "Account not found.")
    if protect_admin and user.role == "admin":
        raise HTTPException(403, "Administrator accounts are protected from these access controls.")
    if user.account_version != expected_version:
        raise HTTPException(409, "This account changed. Reload its settings before saving.")
    return user


def account_summary(db, user):
    return {
        **account_json(user),
        "collection_copies": db.scalar(
            select(func.coalesce(func.sum(InventoryLot.quantity_remaining), 0)).where(
                InventoryLot.owner_id == user.id
            )
        ),
        "saved_decks": db.scalar(
            select(func.count())
            .select_from(Deck)
            .where(Deck.owner_id == user.id, Deck.archived.is_(False))
        ),
        "saved_batches": db.scalar(
            select(func.count())
            .select_from(Scan)
            .where(Scan.owner_id == user.id, Scan.deleted_at.is_(None))
        ),
        "active_sessions": db.scalar(
            select(func.count())
            .select_from(LoginSession)
            .where(LoginSession.owner_id == user.id, LoginSession.expires_at > now())
        ),
        "activity": [
            {"kind": event.kind, "created_at": event.created_at, "detail": event.detail}
            for event in db.scalars(
                select(AccountEvent)
                .where(AccountEvent.owner_id == user.id)
                .order_by(AccountEvent.created_at.desc(), AccountEvent.id)
                .limit(10)
            )
        ],
    }


@router.get("/me")
def my_account(identity: Identity, db: DB):
    return account_summary(db, db.get(User, identity.owner_id))


@router.patch("/me")
def edit_profile(data: ProfileEdit, identity: Identity, db: DB):
    user = locked_account(db, identity.owner_id, data.expected_version)
    user.profile_name = data.display_name.strip()
    user.account_version += 1
    record_account_event(db, user, user, "PROFILE_UPDATED")
    db.commit()
    return account_summary(db, user)


@router.post("/me/signout-others")
def signout_others(data: Versioned, identity: Identity, db: DB):
    user = locked_account(db, identity.owner_id, data.expected_version)
    count = db.execute(
        delete(LoginSession).where(
            LoginSession.owner_id == user.id, LoginSession.token_hash != identity.token_hash
        )
    ).rowcount
    user.account_version += 1
    record_account_event(db, user, user, "OTHER_SESSIONS_ENDED", sessions=count)
    db.commit()
    return {"sessions_ended": count, "account": account_summary(db, user)}


@router.get("/accounts/{user_id}")
def get_account(user_id: uuid.UUID, admin: Admin, db: DB):
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(404, "Account not found.")
    return account_summary(db, user)


@router.post("/accounts/{user_id}/access")
def update_access(user_id: uuid.UUID, data: AccountAccess, admin: Admin, db: DB):
    user = locked_account(db, user_id, data.expected_version, protect_admin=True)
    before = {
        field: getattr(user, field)
        for field in ("suspended", "scans_paused", "scan_card_limit_override")
    }
    for field in before:
        setattr(user, field, getattr(data, field))
    changes = {
        field: {"before": previous, "after": getattr(user, field)}
        for field, previous in before.items()
        if previous != getattr(user, field)
    }
    if changes:
        user.account_version += 1
        record_account_event(db, user, admin, "ACCESS_UPDATED", changes=changes)
    if user.suspended:
        db.execute(delete(LoginSession).where(LoginSession.owner_id == user.id))
    db.commit()
    return account_summary(db, user)


@router.post("/accounts/{user_id}/signout")
def signout_account(user_id: uuid.UUID, data: Versioned, admin: Admin, db: DB):
    user = locked_account(db, user_id, data.expected_version, protect_admin=True)
    count = db.execute(delete(LoginSession).where(LoginSession.owner_id == user.id)).rowcount
    user.account_version += 1
    record_account_event(db, user, admin, "SESSIONS_ENDED", sessions=count)
    db.commit()
    return {"sessions_ended": count, "account": account_summary(db, user)}


@router.post("/accounts/{user_id}/reset-password")
def reset_password(user_id: uuid.UUID, data: Versioned, admin: Admin, db: DB, response: Response):
    user = locked_account(db, user_id, data.expected_version, protect_admin=True)
    if user.issuer != get_settings().oidc_issuer:
        raise HTTPException(
            409, "This account uses a different sign-in provider and cannot be reset here."
        )
    try:
        with identity_admin.identity_client() as provider:
            profile = identity_admin.identity_user(provider, user.subject)
            # Persist revocation before touching external credentials. If the
            # process stops, callbacks remain blocked until an admin retries.
            reset_at = now()
            user.password_reset_at, user.password_reset_pending = reset_at, True
            user.account_version += 1
            db.execute(delete(LoginSession).where(LoginSession.owner_id == user.id))
            record_account_event(db, user, admin, "PASSWORD_RESET_STARTED")
            db.commit()
            user = db.scalar(
                select(User)
                .where(User.id == user_id)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
            if user.password_reset_at != reset_at:
                raise HTTPException(
                    409, "Another password reset replaced this request. Reload the account."
                )
            password = "P!" + secrets.token_urlsafe(18) + "7a"
            try:
                identity_admin.set_temporary_password(provider, user.subject, password)
            except (identity_admin.IdentityAdminError, httpx.HTTPError, ValueError):
                user.password_reset_pending = False
                user.account_version += 1
                db.execute(delete(LoginSession).where(LoginSession.owner_id == user.id))
                record_account_event(db, user, admin, "PASSWORD_RESET_FAILED")
                db.commit()
                raise HTTPException(
                    503,
                    "The password reset could not be confirmed. PakTrak sessions were ended. Reload this account and reset again before sharing a temporary password.",
                ) from None
            user.password_reset_pending = False
            user.account_version += 1
            db.execute(delete(LoginSession).where(LoginSession.owner_id == user.id))
            record_account_event(db, user, admin, "PASSWORD_RESET")
            db.commit()
            response.headers["Cache-Control"] = "no-store"
            response.headers["Pragma"] = "no-cache"
            return {
                "account": account_summary(db, user),
                "temporary_password": password,
                "username": profile.get("username", user.display_name),
            }
    except identity_admin.IdentityAdminError as exc:
        raise HTTPException(503, str(exc)) from None
