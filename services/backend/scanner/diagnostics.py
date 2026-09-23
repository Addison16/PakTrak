"""Request diagnostics contain codes and code locations, never request contents."""

import json
import logging
import traceback
from datetime import timedelta
from functools import lru_cache
from pathlib import Path

from sqlalchemy import create_engine, delete, select
from sqlalchemy.orm import sessionmaker

from scanner.models import RequestErrorLog, now
from scanner.settings import get_settings

log = logging.getLogger("scanner.requests")
RETENTION_DAYS = 14
MAX_LOGS = 10_000
MESSAGES = {
    "invalid_request": "The request contains invalid fields.",
    "validation_failed": "One or more request fields failed validation.",
    "session_expired": "The sign-in session expired or was no longer available.",
    "sign_in_required": "The request requires sign-in.",
    "csrf_mismatch": "The request used an out-of-date sign-in verification token.",
    "origin_mismatch": "The request did not come from the configured app address.",
    "forbidden": "The account is not allowed to perform this action.",
    "not_found": "The requested item was not available to this account.",
    "conflict": "The request conflicted with a saved version or previous request.",
    "rate_limited": "A request or account limit was reached.",
    "storage_unavailable": "Photo/file storage was temporarily unavailable.",
    "service_unavailable": "A server service was temporarily unavailable.",
    "server_error": "An unexpected server error interrupted the request.",
    "login_expired": "The sign-in confirmation expired or its browser state did not match.",
    "login_cancelled": "Sign-in was cancelled at the identity service.",
    "login_verification_failed": "The identity service response could not be verified.",
    "identity_unavailable": "The identity service could not be reached.",
    "password_reset_pending": "An administrator password reset is still in progress.",
    "account_suspended": "The account's access is suspended.",
    "login_account_changed": "The password change returned a different account.",
    "login_address_changed": "The configured sign-in address does not match the installed identity binding.",
}
STATUS_CODES = {
    401: "sign_in_required",
    403: "forbidden",
    404: "not_found",
    409: "conflict",
    422: "invalid_request",
    429: "rate_limited",
    503: "service_unavailable",
}
FIELDS = set(
    "body query path header filename content_type size foil_count foil_ids etched_ids token cards items quantity format file_format deck_format section_mode name notes expected_version finish condition printing_id observation_id polygon rotation action find_missing binder binder_id section match_mode use_collection_versions content mapping options headers defaults price_source only_if_unset guest_signup_enabled confirmed offset limit guests_only reference q sort provider minimum maximum min_price max_price language set_code collector_number id scan_id deck_id import_id export_id user_id kind version row_id idempotency_key".split()
)
FIELDS.update({"display_name", "scan_card_limit_override", "scans_paused", "suspended"})


def validation_details(errors):
    result = []
    for error in errors[:8]:
        loc = [
            part
            if isinstance(part, int)
            else part
            if str(part).lower().replace("-", "_") in FIELDS
            else "field"
            for part in error.get("loc", ())
        ]
        kind = error.get("type", "invalid")
        if kind == "missing":
            message = "This field is required."
        elif kind in {"int_type", "int_parsing", "int_from_float"}:
            message = "Enter a whole number."
        elif kind in {"greater_than", "greater_than_equal", "less_than", "less_than_equal"}:
            bound = next(
                (
                    error.get("ctx", {}).get(k)
                    for k in ("gt", "ge", "lt", "le")
                    if k in error.get("ctx", {})
                ),
                None,
            )
            relation = {
                "greater_than": "greater than",
                "greater_than_equal": "at least",
                "less_than": "less than",
                "less_than_equal": "at most",
            }[kind]
            message = (
                f"Use a value {relation} {bound}."
                if isinstance(bound, (int, float))
                else "This value is outside the allowed range."
            )
        else:
            message = {
                "literal_error": "Choose one of the available options.",
                "extra_forbidden": "This field is not supported.",
                "string_too_long": "This text is too long.",
                "string_too_short": "This text is too short.",
                "too_long": "There are too many items.",
                "too_short": "There are too few items.",
                "uuid_parsing": "Choose a valid item or reference.",
                "json_invalid": "The request was not valid JSON. Try the action again.",
            }.get(kind, "Check this field's value and format.")
        result.append({"loc": loc, "msg": message, "type": kind})
    return result


def mark_problem(request, code, exc=None, fields=None):
    context = {}
    if exc is not None:
        context["exception_type"] = type(exc).__name__
        # Do not format the exception: database/HTTP errors can embed credentials,
        # payload values or authorization codes. Code locations suffice to trace it.
        frames = traceback.extract_tb(exc.__traceback__)
        context["frames"] = [
            {"file": Path(f.filename).name, "function": f.name, "line": f.lineno}
            for f in frames
            if "/scanner/" in f.filename
        ][-6:]
    if fields:
        context["fields"] = [
            {"field": ".".join(map(str, f["loc"])), "issue": f["msg"]} for f in fields
        ]
    request.state.problem = {"code": code, "summary": MESSAGES[code], "context": context}


@lru_cache
def log_sessions():
    # A separate, short-wait pool keeps error logging from exhausting request
    # connections or turning a database outage into a long wait for the user.
    engine = create_engine(
        get_settings().database_url.get_secret_value(),
        pool_size=2,
        max_overflow=0,
        pool_timeout=0.2,
        pool_pre_ping=True,
        connect_args={
            "connect_timeout": 2,
            "options": "-c statement_timeout=1000 -c lock_timeout=250",
        },
    )
    return sessionmaker(engine)


def trim_logs(db):
    db.execute(
        delete(RequestErrorLog).where(
            RequestErrorLog.created_at < now() - timedelta(days=RETENTION_DAYS)
        )
    )
    retained = (
        select(RequestErrorLog.id)
        .order_by(RequestErrorLog.created_at.desc(), RequestErrorLog.id.desc())
        .limit(MAX_LOGS)
    )
    db.execute(delete(RequestErrorLog).where(RequestErrorLog.id.not_in(retained)))


def record_problem(record):
    log.warning(
        json.dumps({"event": "request_error", **record}, default=str, separators=(",", ":"))
    )
    try:
        with log_sessions()() as db, db.begin():
            db.add(RequestErrorLog(**record))
            db.flush()
            trim_logs(db)
    except Exception as exc:
        # Logging must not change the original response or disclose exception text.
        log.warning(
            json.dumps(
                {
                    "event": "error_log_storage_unavailable",
                    "request_id": str(record["id"]),
                    "exception_type": type(exc).__name__,
                }
            )
        )
