import hashlib
import secrets
import uuid
from datetime import timedelta
from typing import Annotated, Literal

from authlib.common.errors import AuthlibBaseError
from authlib.integrations.base_client import OAuthError
from authlib.integrations.starlette_client import OAuth
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse, RedirectResponse
from httpx import HTTPError
from joserfc.errors import JoseError
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from scanner import identity_admin
from scanner.account_access import (
    GUEST_CARD_LIMIT,
    account_details,
    account_json,
    account_name,
    record_account_event,
)
from scanner.db import get_db
from scanner.diagnostics import mark_problem
from scanner.identity_origin import IdentityConfigurationError
from scanner.models import AccountPolicy, IdentityBinding, LoginSession, User, now
from scanner.settings import get_settings
from scanner.store_links import FIELDS as AFFILIATE_FIELDS
from scanner.store_links import clean_affiliate, store_links

router = APIRouter(prefix="/api/auth", tags=["authentication"])
COOKIE = "scanner_session"


def token_hash(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def current_session(request: Request, db: Annotated[Session, Depends(get_db)]) -> LoginSession:
    token = request.cookies.get(COOKIE, "")
    session = db.get(LoginSession, token_hash(token)) if token else None
    if session is not None:
        request.state.owner_id = session.owner_id
    if session is None or session.expires_at <= now():
        mark_problem(request, "session_expired" if token else "sign_in_required")
        raise HTTPException(401, "Sign in to continue.")
    access = db.execute(
        select(User.suspended, User.password_reset_pending).where(User.id == session.owner_id)
    ).one()
    if access.password_reset_pending:
        mark_problem(request, "password_reset_pending")
        raise HTTPException(
            403,
            "A password reset is in progress. Contact your administrator if it does not finish.",
        )
    if access.suspended:
        mark_problem(request, "account_suspended")
        raise HTTPException(403, "This account is suspended. Contact your administrator.")
    if request.method not in {"GET", "HEAD", "OPTIONS"}:
        origin = request.headers.get("origin")
        csrf = request.headers.get("x-csrf-token", "")
        if origin != get_settings().app_url:
            mark_problem(request, "origin_mismatch")
            raise HTTPException(
                403,
                "Open PakTrak from its usual address and try again. The request's origin could not be verified.",
            )
        if not secrets.compare_digest(csrf, session.csrf_token):
            mark_problem(request, "csrf_mismatch")
            raise HTTPException(
                403, "Your sign-in verification changed. Refresh sign-in and try the action again."
            )
    return session


DB = Annotated[Session, Depends(get_db)]
Identity = Annotated[LoginSession, Depends(current_session)]


def oidc_client(register=False):
    settings = get_settings()
    public = settings.oidc_issuer.rstrip("/")
    internal = settings.oidc_internal_issuer.rstrip("/")
    oauth = OAuth()
    # Explicit server endpoints avoid resolving the phone-facing hostname from a container.
    return oauth.register(
        "identity",
        client_id=settings.oidc_client_id,
        client_secret=settings.oidc_client_secret.get_secret_value(),
        authorize_url=public
        + "/protocol/openid-connect/"
        + ("registrations" if register else "auth"),
        access_token_url=internal + "/protocol/openid-connect/token",
        jwks_uri=internal + "/protocol/openid-connect/certs",
        issuer=public,
        client_kwargs={"scope": "openid profile email", "code_challenge_method": "S256"},
    )


def setup_required(db):
    return db.scalar(select(User.id).where(User.role == "admin").limit(1)) is None


@router.get("/status")
def status(db: DB):
    return {
        "setup_required": setup_required(db),
        "guest_card_limit": GUEST_CARD_LIMIT,
        "guest_signup_enabled": db.get(AccountPolicy, 1).guest_signup_enabled,
    }


async def begin_login(request, flow, owner_id=None, fresh=False):
    state = secrets.token_urlsafe(32)
    request.session["account_flow:" + state] = flow
    if owner_id:
        request.session["password_owner:" + state] = str(owner_id)
    try:
        return await oidc_client(register=flow in {"setup", "register"}).authorize_redirect(
            request,
            get_settings().app_url + "/api/auth/callback",
            state=state,
            **(
                {"kc_action": "UPDATE_PASSWORD", "prompt": "login"}
                if flow == "password"
                else {"prompt": "login"}
                if fresh
                else {}
            ),
        )
    except (HTTPError, OAuthError, TimeoutError) as exc:
        return login_failure(request, "identity_unavailable", exc)


def login_failure(request, code, exc):
    mark_problem(request, code, exc)
    request.session.clear()
    return RedirectResponse(
        f"/?login_error={code}&error_ref={request.state.request_id}", status_code=303
    )


@router.get("/login")
async def login(request: Request, fresh: bool = False):
    return await begin_login(request, "login", fresh=fresh)


@router.get("/register")
async def register(request: Request, db: DB):
    if not db.get(AccountPolicy, 1).guest_signup_enabled:
        return RedirectResponse("/?registration_closed=1", status_code=303)
    return await begin_login(request, "register")


@router.get("/password")
async def change_password(request: Request, identity: Identity):
    return await begin_login(request, "password", identity.owner_id)


@router.get("/setup")
async def setup(request: Request, db: DB):
    if not setup_required(db):
        return RedirectResponse("/", status_code=303)
    return await begin_login(request, "setup")


def save_account(db, subject, display_name, *, initial_setup=False):
    # Serialize first-admin creation across callbacks and processes. The setup
    # intent is bound to verified OIDC state, never accepted from profile claims.
    db.execute(text("SELECT pg_advisory_xact_lock(733184920)"))
    binding = db.get(IdentityBinding, 1)
    if binding is not None and binding.issuer != get_settings().oidc_issuer:
        raise IdentityConfigurationError("The configured sign-in address has not been applied.")
    policy = db.scalar(select(AccountPolicy).where(AccountPolicy.id == 1).with_for_update())
    first_admin = initial_setup and setup_required(db)
    existing = db.scalar(
        select(User)
        .where(User.issuer == get_settings().oidc_issuer, User.subject == subject)
        .with_for_update()
    )
    if not existing and not first_admin and not policy.guest_signup_enabled:
        raise HTTPException(403, "New account registration is currently closed.")
    user_id = db.execute(
        insert(User)
        .values(issuer=get_settings().oidc_issuer, subject=subject, display_name=display_name)
        .on_conflict_do_update(
            index_elements=["issuer", "subject"], set_={"display_name": display_name}
        )
        .returning(User.id)
    ).scalar_one()
    user = db.get(User, user_id, populate_existing=True)
    if first_admin:
        user.role = "admin"
        user.approved_at = now()
        db.flush()
    return user


@router.get("/callback")
async def callback(request: Request, db: DB):
    settings = get_settings()
    flow = request.session.get("account_flow:" + request.query_params.get("state", ""))
    password_owner = request.session.get("password_owner:" + request.query_params.get("state", ""))
    try:
        token = await oidc_client().authorize_access_token(
            request,
            claims_options={"iss": {"essential": True, "value": settings.oidc_issuer}},
        )
        claims = token["userinfo"]
        subject = claims["sub"]
        if not subject or claims["iss"] != settings.oidc_issuer:
            raise ValueError("Invalid identity")
    except (HTTPError, TimeoutError) as exc:
        return login_failure(request, "identity_unavailable", exc)
    except (AuthlibBaseError, JoseError, ValueError, KeyError) as exc:
        code = {
            "mismatching_state": "login_expired",
            "invalid_grant": "login_expired",
            "expired_token": "login_expired",
            "access_denied": "login_cancelled",
        }.get(getattr(exc, "error", ""), "login_verification_failed")
        return login_failure(request, code, exc)
    try:
        user = save_account(
            db,
            subject,
            str(claims.get("preferred_username", "Collector"))[:255],
            initial_setup=flow == "setup",
        )
    except IdentityConfigurationError as exc:
        db.rollback()
        return login_failure(request, "login_address_changed", exc)
    except HTTPException as exc:
        if exc.status_code != 403:
            raise
        db.rollback()
        request.session.clear()
        return RedirectResponse("/?registration_closed=1", status_code=303)
    if flow == "password" and password_owner != str(user.id):
        db.rollback()
        return login_failure(request, "login_account_changed", ValueError("Account changed"))
    if user.suspended:
        db.rollback()
        request.session.clear()
        mark_problem(request, "account_suspended")
        return RedirectResponse("/?account_suspended=1", status_code=303)
    if user.password_reset_pending:
        db.rollback()
        return login_failure(
            request, "password_reset_pending", ValueError("Password reset pending")
        )
    if user.password_reset_at:
        auth_time = claims.get("auth_time")
        if isinstance(auth_time, bool) or not isinstance(auth_time, (int, float)):
            db.rollback()
            return login_failure(
                request, "login_verification_failed", ValueError("Missing authentication time")
            )
        if auth_time < int(user.password_reset_at.timestamp()):
            db.rollback()
            request.session.clear()
            return RedirectResponse("/api/auth/login?fresh=true", status_code=303)
        try:
            changed = identity_admin.password_change_complete(user.subject)
        except identity_admin.IdentityAdminError as exc:
            db.rollback()
            return login_failure(request, "identity_unavailable", exc)
        if not changed:
            db.rollback()
            request.session.clear()
            return RedirectResponse("/api/auth/login?fresh=true", status_code=303)
    session_token = secrets.token_urlsafe(48)
    db.add(
        LoginSession(
            token_hash=token_hash(session_token),
            owner_id=user.id,
            csrf_token=secrets.token_hex(32),
            approval_notice_eligible=user.role == "member" and user.approval_notice_pending,
            expires_at=now() + timedelta(hours=settings.session_hours),
        )
    )
    db.commit()
    request.session.clear()
    response = RedirectResponse("/?account=1" if flow == "password" else "/", status_code=303)
    response.set_cookie(
        COOKIE,
        session_token,
        max_age=settings.session_hours * 3600,
        httponly=True,
        secure=settings.secure_cookies,
        samesite="lax",
        path="/",
    )
    return response


@router.get("/session")
def session_info(identity: Identity, db: DB):
    user = db.get(User, identity.owner_id)
    return {
        "owner_id": str(user.id),
        "display_name": account_name(user),
        "csrf_token": identity.csrf_token,
        "preferred_price_source": user.preferred_price_source,
        "tour_dismissed": user.tour_dismissed,
        "membership_welcome": user.role == "member"
        and user.approval_notice_pending
        and identity.approval_notice_eligible,
        "approved_at": user.approved_at,
        "store_links": store_links(db.get(AccountPolicy, 1)),
        **account_details(user),
    }


@router.post("/membership-welcome/dismiss")
def dismiss_membership_welcome(identity: Identity, db: DB):
    user = db.scalar(select(User).where(User.id == identity.owner_id).with_for_update())
    if user.role != "member" or not identity.approval_notice_eligible:
        raise HTTPException(403, "This session has no membership approval message.")
    user.approval_notice_pending = False
    db.commit()
    return {"membership_welcome": False}


class PricePreference(BaseModel):
    model_config = ConfigDict(extra="forbid")
    price_source: Literal["tcgplayer", "cardkingdom", "manapool"]
    only_if_unset: bool = Field(default=False, strict=True)


@router.patch("/preferences")
def update_preferences(data: PricePreference, identity: Identity, db: DB):
    user = db.scalar(select(User).where(User.id == identity.owner_id).with_for_update())
    if user is None:
        raise HTTPException(401, "Sign in to continue.")
    # Import a device's older preference only while the account is unset. The
    # row lock keeps a stale device from replacing another session's saved choice.
    if not data.only_if_unset or user.preferred_price_source is None:
        user.preferred_price_source = data.price_source
    db.commit()
    return {"preferred_price_source": user.preferred_price_source}


@router.post("/onboarding/dismiss")
def dismiss_onboarding(identity: Identity, db: DB):
    user = db.scalar(select(User).where(User.id == identity.owner_id).with_for_update())
    if user is None:
        raise HTTPException(401, "Sign in to continue.")
    user.tour_dismissed = True
    db.commit()
    return {"tour_dismissed": True}


def require_admin(identity: Identity, db: DB):
    user = db.get(User, identity.owner_id)
    if user.role != "admin":
        raise HTTPException(403, "An administrator account is required.")
    return user


Admin = Annotated[User, Depends(require_admin)]


class SignupSetting(BaseModel):
    model_config = ConfigDict(extra="forbid")
    guest_signup_enabled: bool | None = Field(default=None, strict=True)
    enhanced_scanning_enabled: bool | None = Field(default=None, strict=True)
    tcgplayer_affiliate: str | None = Field(default=None, max_length=500)
    cardkingdom_affiliate: str | None = Field(default=None, max_length=500)
    manapool_affiliate: str | None = Field(default=None, max_length=500)
    expected_version: int = Field(ge=1)

    @field_validator(*AFFILIATE_FIELDS)
    @classmethod
    def affiliate(cls, value):
        return clean_affiliate(value)

    @model_validator(mode="after")
    def require_change(self):
        changes = self.model_dump(exclude={"expected_version"}, exclude_unset=True)
        switches = {key: value for key, value in changes.items() if key not in AFFILIATE_FIELDS}
        if not changes or any(value is None for value in switches.values()):
            raise ValueError("Choose at least one setting to update, using true or false.")
        return self


def settings_json(policy):
    return {
        "guest_signup_enabled": policy.guest_signup_enabled,
        "enhanced_scanning_enabled": policy.enhanced_scanning_enabled,
        "store_links": store_links(policy),
        "version": policy.version,
    }


@router.get("/settings")
def account_settings(admin: Admin, db: DB):
    policy = db.get(AccountPolicy, 1)
    return settings_json(policy)


@router.post("/settings")
def update_settings(data: SignupSetting, admin: Admin, db: DB):
    policy = db.scalar(select(AccountPolicy).where(AccountPolicy.id == 1).with_for_update())
    if policy.version != data.expected_version:
        raise HTTPException(409, "Settings changed. Refresh before saving.")
    for field in ("guest_signup_enabled", "enhanced_scanning_enabled", *AFFILIATE_FIELDS):
        if field in data.model_fields_set:
            setattr(policy, field, getattr(data, field))
    policy.version += 1
    db.commit()
    return settings_json(policy)


@router.get("/accounts")
def accounts(
    admin: Admin,
    db: DB,
    offset: int = Query(0, ge=0),
    guests_only: bool = True,
    q: str = Query("", max_length=128),
):
    query = select(User)
    if guests_only:
        query = query.where(User.role == "guest")
    if q.strip():
        from sqlalchemy import func, or_

        query = query.where(
            or_(
                func.lower(User.display_name).contains(q.strip().lower(), autoescape=True),
                func.lower(User.profile_name).contains(q.strip().lower(), autoescape=True),
            )
        )
    users = db.scalars(query.order_by(User.created_at, User.id).offset(offset).limit(51)).all()
    return {
        "items": [account_json(user) for user in users[:50]],
        "next_offset": offset + 50 if len(users) > 50 else None,
    }


@router.post("/accounts/{user_id}/approve")
def approve(user_id: uuid.UUID, admin: Admin, db: DB):
    user = db.scalar(select(User).where(User.id == user_id).with_for_update())
    if user is None:
        raise HTTPException(404, "Account not found.")
    if user.role == "guest":
        if user.suspended:
            raise HTTPException(409, "Restore this account's access before approving membership.")
        user.role, user.approved_at = "member", now()
        user.approval_notice_pending = True
        user.scan_card_limit_override = None
        user.account_version += 1
        record_account_event(db, user, admin, "APPROVED")
    db.commit()
    return {"id": str(user.id), **account_details(user)}


@router.post("/logout")
def logout(identity: Identity, db: DB):
    from urllib.parse import urlencode

    settings = get_settings()
    db.delete(identity)
    db.commit()
    query = urlencode(
        {"client_id": settings.oidc_client_id, "post_logout_redirect_uri": settings.app_url + "/"}
    )
    response = JSONResponse(
        {"logout_url": settings.oidc_issuer + "/protocol/openid-connect/logout?" + query}
    )
    response.delete_cookie(COOKIE, path="/", secure=settings.secure_cookies, samesite="lax")
    return response
