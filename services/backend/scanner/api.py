import hashlib
import json
import tempfile
import time
import uuid
from datetime import timedelta
from typing import Annotated, Literal

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import func, select, text
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.sessions import SessionMiddleware

from scanner import storage
from scanner.account_access import check_scan_allowance
from scanner.accounts_api import router as accounts_router
from scanner.auth import DB, Identity
from scanner.auth import router as auth_router
from scanner.card_images import router as card_images_router
from scanner.catalog import router as catalog_router
from scanner.collection_api import router as collection_router
from scanner.collection_bulk import router as collection_bulk_router
from scanner.deck_scans import router as deck_scans_router
from scanner.decks_api import router as decks_router
from scanner.diagnostics import (
    MESSAGES,
    STATUS_CODES,
    mark_problem,
    record_problem,
    validation_details,
)
from scanner.diagnostics_api import router as diagnostics_router
from scanner.gallery import router as gallery_router
from scanner.models import Deck, Job, LoginSession, Outbox, Scan, User, now
from scanner.photo_formats import (
    PHOTO_FORMAT_LABEL,
    PHOTO_MIME_TYPES,
    SIGNATURE_BYTES,
    photo_mime,
    sniff_type,
)
from scanner.recognition_policy import AUTO_IMPORT_THRESHOLD
from scanner.scan_batches import batch_data
from scanner.scan_batches import router as scan_batches_router
from scanner.settings import get_settings

settings = get_settings()
app = FastAPI(
    title="PakTrak", version="0.1.0", docs_url="/api/docs", openapi_url="/api/openapi.json"
)
app.add_middleware(
    SessionMiddleware,
    secret_key=settings.session_secret.get_secret_value(),
    session_cookie="scanner_oidc",
    max_age=600,
    https_only=settings.secure_cookies,
    same_site="lax",
)
app.include_router(auth_router)
app.include_router(accounts_router)
app.include_router(catalog_router)
app.include_router(collection_router)
app.include_router(collection_bulk_router)
app.include_router(decks_router)
app.include_router(deck_scans_router)
app.include_router(gallery_router)
app.include_router(card_images_router)
app.include_router(scan_batches_router)
app.include_router(diagnostics_router)


@app.middleware("http")
async def response_headers(request: Request, call_next):
    request.state.request_id = uuid.uuid4()
    started = time.monotonic()
    try:
        response = await call_next(request)
    except Exception as exc:
        mark_problem(request, "server_error", exc)
        response = JSONResponse(
            {
                "detail": "Something went wrong on the server. Try again, or share the error reference with your administrator.",
                "error_code": "server_error",
                "request_id": str(request.state.request_id),
            },
            status_code=500,
        )
    problem = getattr(request.state, "problem", None)
    if response.status_code >= 400 and problem is None:
        code = STATUS_CODES.get(
            response.status_code,
            "server_error" if response.status_code >= 500 else "invalid_request",
        )
        problem = {"code": code, "summary": MESSAGES[code], "context": {}}
    route = getattr(request.scope.get("route"), "path", "[unmatched]")
    if problem and not (route == "/api/auth/session" and problem["code"] == "sign_in_required"):
        await run_in_threadpool(
            record_problem,
            {
                "id": request.state.request_id,
                "created_at": now(),
                "owner_id": getattr(request.state, "owner_id", None),
                "method": request.method
                if request.method in {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"}
                else "OTHER",
                "route": route,
                "status": response.status_code,
                "duration_ms": round((time.monotonic() - started) * 1000),
                **problem,
            },
        )
    response.headers.setdefault("Cache-Control", "no-store")
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["X-Request-ID"] = str(request.state.request_id)
    return response


@app.exception_handler(StarletteHTTPException)
async def request_error(request, exc):
    if not getattr(request.state, "problem", None):
        mark_problem(
            request,
            STATUS_CODES.get(
                exc.status_code, "server_error" if exc.status_code >= 500 else "invalid_request"
            ),
            exc,
        )
    return JSONResponse(
        {
            "detail": exc.detail,
            "error_code": request.state.problem["code"],
            "request_id": str(request.state.request_id),
        },
        status_code=exc.status_code,
        headers=exc.headers,
    )


@app.exception_handler(RequestValidationError)
async def invalid_fields(request, exc):
    details = validation_details(exc.errors())
    mark_problem(request, "validation_failed", fields=details)
    return JSONResponse(
        {
            "detail": details,
            "error_code": "validation_failed",
            "request_id": str(request.state.request_id),
        },
        status_code=422,
    )


@app.exception_handler(BotoCoreError)
@app.exception_handler(ClientError)
async def storage_error(request, exc):
    mark_problem(request, "storage_unavailable", exc)
    return JSONResponse(
        {
            "detail": "Photo storage is temporarily unavailable. Retry the same action.",
            "error_code": "storage_unavailable",
            "request_id": str(request.state.request_id),
        },
        status_code=503,
    )


@app.get("/api/health/live", include_in_schema=False)
def live():
    return {"status": "ok"}


@app.get("/api/health/ready", include_in_schema=False)
def ready(db: DB):
    db.execute(text("SELECT version_num FROM alembic_version"))
    storage.client().head_bucket(Bucket=settings.storage_bucket)
    return {"status": "ready"}


@app.get("/api/v1/capabilities")
def capabilities():
    return {
        "build_stage": "scan-suggestions-and-collection-transfers",
        "recognition_available": True,
        "auto_add_enabled": True,
        "auto_add_threshold": AUTO_IMPORT_THRESHOLD,
        "collection_transfer_available": True,
        "detector_qualified": False,
        "decks_available": True,
        "collection_file_formats": ["csv", "text"],
        "max_csv_bytes": 5 * 1024 * 1024,
        "max_csv_rows": 10_000,
        "max_upload_bytes": settings.max_upload_bytes,
        "formats": list(PHOTO_MIME_TYPES),
        "max_decoded_pixels": settings.max_decoded_pixels,
        "retention_days": settings.image_retention_days,
    }


class NewScan(BaseModel):
    model_config = ConfigDict(extra="forbid")
    filename: str = Field(min_length=1, max_length=255, pattern=r"^[^\x00-\x1f\x7f]+$")
    content_type: Literal[
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/heif",
        "image/avif",
        "image/tiff",
        "image/bmp",
        "image/gif",
    ]
    size: int = Field(gt=0)
    foil_count: int | None = Field(default=None, ge=0, le=32, strict=True)
    target_deck_id: uuid.UUID | None = None
    add_to_collection: bool | None = Field(default=None, strict=True)

    @field_validator("content_type", mode="before")
    @classmethod
    def supported_photo_type(cls, value):
        normalized = photo_mime(value) if isinstance(value, str) else None
        if normalized is None:
            raise ValueError(f"Choose a {PHOTO_FORMAT_LABEL} photo.")
        return normalized


RequestKey = Annotated[str, Header(alias="Idempotency-Key", min_length=8, max_length=128)]


def owned_scan(db, scan_id, owner_id, lock=False):
    query = select(Scan).where(
        Scan.id == scan_id, Scan.owner_id == owner_id, Scan.deleted_at.is_(None)
    )
    if lock:
        query = query.with_for_update()
    scan = db.scalar(query)
    if scan is None:
        raise HTTPException(404, "Scan not found.")
    return scan


def scan_response(db, scan):
    job = db.scalar(select(Job).where(Job.scan_id == scan.id))
    batch = batch_data(db, scan)
    previews = []
    for item in batch["items"]:
        if item["state"] == "IGNORED":
            continue
        card = (
            item["lot"]["printing"]
            if item["lot"]
            else item["confirmed_printing"]
            or (item["candidates"][0]["printing"] if item["candidates"] else None)
        )
        previews.append(
            {
                "id": item["id"],
                "name": card["name"] if card else "Card awaiting identification",
                "image_url": item["crop_url"]
                or (
                    f"/api/v1/scans/{scan.id}/reference/{card['id']}/image"
                    if card and card["image_url"]
                    else None
                ),
            }
        )
        if len(previews) == 6:
            break
    duplicate = None
    if scan.sha256:
        duplicate = db.scalar(
            select(Scan.id)
            .where(
                Scan.owner_id == scan.owner_id,
                Scan.sha256 == scan.sha256,
                Scan.id != scan.id,
                Scan.created_at < scan.created_at,
                Scan.deleted_at.is_(None),
            )
            .order_by(Scan.created_at)
            .limit(1)
        )
    target = db.get(Deck, scan.target_deck_id) if scan.target_deck_id else None
    return {
        "id": str(scan.id),
        "filename": scan.filename,
        "state": scan.state,
        "uploaded": scan.source_key is not None,
        "accepted_at": scan.accepted_at,
        "created_at": scan.created_at,
        "expires_at": scan.expires_at,
        "width": scan.width,
        "height": scan.height,
        "foil_count": scan.foil_count,
        "add_to_collection": scan.add_to_collection,
        "target_deck": {"id": str(target.id), "name": target.name, "archived": target.archived}
        if target
        else None,
        "summary": batch["summary"],
        "finishes_confirmed": batch["finishes"]["confirmed"],
        "preview_cards": previews,
        "duplicate_scan_id": str(duplicate) if duplicate else None,
        "thumbnail_url": f"/api/v1/scans/{scan.id}/image?kind=thumbnail"
        if scan.thumbnail_key
        else None,
        "job": {
            "id": str(job.id),
            "state": job.state,
            "stage": job.stage,
            "attempts": job.attempts,
            "error_code": job.error_code,
            "error_message": job.error_message,
            "result": job.result,
            "progress": (job.result or {}).get("progress"),
        }
        if job
        else None,
    }


@app.post("/api/v1/scans", status_code=201)
def create_scan(data: NewScan, key: RequestKey, identity: Identity, db: DB, response: Response):
    if data.size > settings.max_upload_bytes:
        raise HTTPException(413, "This photo is larger than the configured upload limit.")
    request_hash = hashlib.sha256(
        json.dumps(data.model_dump(mode="json", exclude_none=True), sort_keys=True).encode()
    ).hexdigest()
    # A per-owner lock makes same-key concurrent requests and capacity checks deterministic.
    user = db.scalar(select(User).where(User.id == identity.owner_id).with_for_update())
    existing = db.scalar(
        select(Scan).where(Scan.owner_id == identity.owner_id, Scan.request_key == key)
    )
    if existing:
        if existing.deleted_at:
            raise HTTPException(410, "This batch was deleted. Start a new upload.")
        if existing.request_hash != request_hash:
            raise HTTPException(409, "This request key already belongs to a different photo.")
        response.status_code = 200
        return scan_response(db, existing)
    check_scan_allowance(user)
    if data.target_deck_id:
        deck = db.scalar(
            select(Deck)
            .where(
                Deck.id == data.target_deck_id,
                Deck.owner_id == identity.owner_id,
                Deck.archived.is_(False),
            )
            .with_for_update()
        )
        if not deck:
            raise HTTPException(404, "Choose an available deck from your own decks.")
    elif data.add_to_collection is False:
        raise HTTPException(422, "Choose a saved deck before starting a deck-only photo scan.")
    pending = db.scalar(
        select(func.count())
        .select_from(Scan)
        .where(
            Scan.owner_id == identity.owner_id, Scan.state == "UPLOADING", Scan.deleted_at.is_(None)
        )
    )
    if pending >= 20:
        raise HTTPException(
            429, "Too many unfinished uploads. Wait for abandoned uploads to expire."
        )
    scan = Scan(
        owner_id=identity.owner_id,
        request_key=key,
        request_hash=request_hash,
        filename=data.filename,
        mime_type=data.content_type,
        expected_bytes=data.size,
        # Keep the original request hash for resumable older uploads, but new
        # photos with no declared foils always start as nonfoil.
        foil_count=data.foil_count or 0,
        target_deck_id=data.target_deck_id,
        add_to_collection=data.add_to_collection
        if data.add_to_collection is not None
        else not bool(data.target_deck_id),
    )
    db.add(scan)
    db.commit()
    return scan_response(db, scan)


@app.put("/api/v1/scans/{scan_id}/upload")
async def upload(scan_id: uuid.UUID, request: Request, identity: Identity, db: DB):
    owner_id, session_hash = identity.owner_id, identity.token_hash
    check_scan_allowance(db.get(User, owner_id))
    scan = owned_scan(db, scan_id, owner_id)
    if scan.state != "UPLOADING":
        raise HTTPException(409, "This photo has already been accepted or expired.")
    expected_bytes, mime_type = scan.expected_bytes, scan.mime_type
    if photo_mime(request.headers.get("content-type", "")) != mime_type:
        raise HTTPException(415, "Upload type does not match the selected photo.")
    db.rollback()  # Never hold a database transaction during a slow phone upload.
    digest, size = hashlib.sha256(), 0
    with tempfile.TemporaryFile() as spool:
        async for chunk in request.stream():
            size += len(chunk)
            if size > min(settings.max_upload_bytes, expected_bytes):
                raise HTTPException(413, "Upload exceeded its allowed byte count.")
            digest.update(chunk)
            await run_in_threadpool(spool.write, chunk)
        if size != expected_bytes:
            raise HTTPException(422, "Upload was incomplete. Select the same photo and retry.")
        spool.seek(0)
        if sniff_type(spool.read(SIGNATURE_BYTES)) != mime_type:
            raise HTTPException(415, "The file contents do not match a supported still-photo type.")
        spool.seek(0)
        checksum = digest.hexdigest()
        # This key is never writable by the browser. Each attempt gets an immutable key.
        key = f"originals/{owner_id}/{scan_id}/{uuid.uuid4()}"
        await run_in_threadpool(storage.put, key, spool, mime_type, checksum)
    try:
        user = db.scalar(
            select(User)
            .where(User.id == owner_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        check_scan_allowance(user)
        if not db.scalar(
            select(LoginSession.token_hash).where(
                LoginSession.token_hash == session_hash, LoginSession.expires_at > now()
            )
        ):
            raise HTTPException(401, "Sign in to continue.")
        scan = owned_scan(db, scan_id, owner_id, lock=True)
        if scan.source_key:
            if scan.sha256 != checksum:
                raise HTTPException(409, "Different bytes were already uploaded for this scan.")
            await run_in_threadpool(storage.delete, key)
        elif scan.state == "UPLOADING":
            scan.source_key, scan.sha256 = key, checksum
        else:
            raise HTTPException(409, "The scan changed while this photo was uploading.")
        db.commit()
    except Exception:
        db.rollback()
        # A lost COMMIT response is ambiguous: never delete a possibly referenced object.
        # Unreferenced attempt objects are removed by retention maintenance.
        raise
    return scan_response(db, scan)


@app.post("/api/v1/scans/{scan_id}/finalize", status_code=202)
def finalize(scan_id: uuid.UUID, key: RequestKey, identity: Identity, db: DB):
    user = db.scalar(select(User).where(User.id == identity.owner_id).with_for_update())
    scan = owned_scan(db, scan_id, identity.owner_id, lock=True)
    job = db.scalar(select(Job).where(Job.scan_id == scan.id))
    if job:
        return accepted_response(scan, job)
    check_scan_allowance(user)
    if scan.state != "UPLOADING" or not scan.source_key:
        raise HTTPException(409, "Upload the complete photo before requesting processing.")
    head = storage.client().head_object(Bucket=settings.storage_bucket, Key=scan.source_key)
    if (
        head["ContentLength"] != scan.expected_bytes
        or head.get("Metadata", {}).get("sha256") != scan.sha256
    ):
        raise HTTPException(422, "Stored photo verification failed. Create a new upload.")
    active = db.scalar(
        select(func.count())
        .select_from(Job)
        .join(Scan)
        .where(Scan.owner_id == identity.owner_id, Job.state.in_(["QUEUED", "RUNNING"]))
    )
    if active >= settings.max_active_jobs:
        raise HTTPException(429, "Your server jobs are still running. Retry acceptance shortly.")
    scan.state = "QUEUED"
    scan.accepted_at = now()
    scan.expires_at = now() + timedelta(days=settings.image_retention_days)
    job = Job(scan_id=scan.id, deadline_at=now() + timedelta(hours=settings.job_deadline_hours))
    db.add(job)
    db.flush()
    db.add(Outbox(job_id=job.id))
    db.commit()
    # Publication can happen later, including after broker downtime. This transaction is the boundary.
    return accepted_response(scan, job)


def accepted_response(scan, job):
    return {
        "scan_id": str(scan.id),
        "job_id": str(job.id),
        "accepted_at": scan.accepted_at,
        "status_url": f"/api/v1/scans/{scan.id}",
        "safe_to_disconnect": True,
    }


@app.get("/api/v1/scans")
def list_scans(identity: Identity, db: DB, offset: int = Query(default=0, ge=0)):
    scans = db.scalars(
        select(Scan)
        .where(Scan.owner_id == identity.owner_id, Scan.deleted_at.is_(None))
        .order_by(Scan.created_at.desc(), Scan.id.desc())
        .offset(offset)
        .limit(21)
    ).all()
    return {
        "items": [scan_response(db, scan) for scan in scans[:20]],
        "next_offset": offset + 20 if len(scans) > 20 else None,
    }


@app.get("/api/v1/scans/{scan_id}")
def detail(scan_id: uuid.UUID, identity: Identity, db: DB):
    return scan_response(db, owned_scan(db, scan_id, identity.owner_id))


@app.get("/api/v1/scans/{scan_id}/image")
def image(
    scan_id: uuid.UUID,
    identity: Identity,
    db: DB,
    kind: Literal["thumbnail", "prepared"] = "thumbnail",
):
    scan = owned_scan(db, scan_id, identity.owner_id)
    key = scan.thumbnail_key if kind == "thumbnail" else scan.prepared_key
    if not key or (scan.expires_at and scan.expires_at <= now()):
        raise HTTPException(404, "The photo is unavailable or has expired.")
    obj = storage.get(key)

    def chunks():
        try:
            yield from obj["Body"].iter_chunks(chunk_size=64 * 1024)
        finally:
            obj["Body"].close()

    return StreamingResponse(
        chunks(), media_type="image/jpeg", headers={"Content-Disposition": "inline"}
    )
