"""Short, resumable scan steps. Every inventory write is fenced by the job lease."""

import io
import time
import uuid
from collections import Counter
from datetime import timedelta

import numpy as np
from PIL import Image
from sqlalchemy import func, select

from scanner import detection, recognition, storage
from scanner.account_access import scan_card_limit
from scanner.crop_orientation import manual_rotation
from scanner.db import session_factory
from scanner.models import (
    AccountPolicy,
    InventoryEvent,
    InventoryLot,
    Job,
    Observation,
    Outbox,
    Printing,
    Scan,
    User,
    now,
)
from scanner.recognition_policy import AUTO_IMPORT_POLICY, AUTO_IMPORT_THRESHOLD, may_auto_import
from scanner.settings import get_settings
from scanner.transfers import add_lot


def reset_recognition(previous):
    return {
        key: previous[key]
        for key in ("_crop_request", "_orientation", "_orientation_request")
        if key in previous
    }


def new_observation_finish(db, scan):
    if scan.foil_count is None:
        return "unknown"  # Preserve batches created before foil plans existed.
    if scan.foil_count == 0:
        return "nonfoil"
    # A recheck or manual outline may find more cards after the user has
    # already selected every foil. Those additional cards are nonfoil.
    selected = db.scalar(
        select(func.count())
        .select_from(Observation)
        .outerjoin(InventoryLot, InventoryLot.source_observation_id == Observation.id)
        .where(
            Observation.scan_id == scan.id,
            Observation.state != "IGNORED",
            func.coalesce(InventoryLot.finish, Observation.finish).in_(["foil", "etched"]),
        )
    )
    return "nonfoil" if selected == scan.foil_count else "unknown"


def lock_scan_job(db, claimed):
    owner = db.scalar(select(Scan.owner_id).where(Scan.id == claimed["scan_id"]))
    if owner is None:
        return None
    user = db.scalar(select(User).where(User.id == owner).with_for_update())
    job = db.scalar(select(Job).where(Job.id == claimed["id"]).with_for_update())
    scan = db.scalar(select(Scan).where(Scan.id == claimed["scan_id"]).with_for_update())
    if (
        not job
        or not scan
        or scan.deleted_at
        or job.state != "RUNNING"
        or job.lease_token != claimed["token"]
    ):
        return None
    return user, job, scan


def advance(db, job, scan):
    rows = db.scalars(select(Observation).where(Observation.scan_id == scan.id)).all()
    pending = sum(row.state == "NEEDS_REVIEW" and not row.recognition.get("status") for row in rows)
    total = len(rows)
    done = total - pending
    matched = sum(bool(row.recognition.get("candidates")) for row in rows)
    added = sum(row.state == "COMMITTED" for row in rows)
    result = dict(job.result or {})
    measured = result.get("measured_cards", 0)
    eta = round(result.get("recognition_seconds", 0) / measured * pending) if measured else None
    result.update(
        {
            "recognition_available": True,
            "cards_added": added if scan.add_to_collection else 0,
            "cards_confirmed": added,
            "proposed_regions": total,
            "matched_regions": matched,
            "detector_version": detection.VERSION,
            "redetect": False,
            "progress": {
                "phase": "Identifying cards",
                "done": done,
                "total": total,
                "unit": "cards",
                "eta_seconds": eta if pending else 0,
                "measured_at": now().isoformat(),
            },
        }
    )
    job.result = result
    job.lease_token = job.lease_until = None
    if pending:
        job.state, scan.state = "QUEUED", "PROCESSING"
        job.stage = f"Identifying cards · {done} of {total} checked"
        # A successful checkpoint is not a failed retry. The overall deadline
        # remains unchanged; retry limits apply to a failing individual step.
        job.attempts = 0
        outbox = db.get(Outbox, job.id)
        outbox.available_at, outbox.last_sent_at = now(), None
    else:
        job.state, scan.state = "SUCCEEDED", "PHOTO_READY"
        job.stage = f"{total} regions checked · {matched} suggested matches"
        job.completed_at = now()


def save_prepared(claimed, result):
    with session_factory()() as db, db.begin():
        locked = lock_scan_job(db, claimed)
        if not locked:
            return False
        user, job, scan = locked
        rows = db.scalars(select(Observation).where(Observation.scan_id == scan.id)).all()
        additions = []
        for region in result.get("regions", []):
            # Redetection may reorder crops. Match physical geometry, never the
            # new position in an array, to preserve decisions and copy identity.
            matching = [
                row for row in rows if detection.overlap(region["polygon"], row.polygon) > 0.55
            ]
            if matching:
                if len(matching) == 1 and (job.result or {}).get("redetect"):
                    row = matching[0]
                    if (
                        row.state == "NEEDS_REVIEW"
                        and row.detector_version != "manual-v1"
                        and manual_rotation(row.recognition) is None
                    ):
                        row.polygon, row.crop_key = region["polygon"], region["crop_key"]
                        row.recognition, row.detector_version = {}, detection.VERSION
                        row.version += 1
                continue
            additions.append(region)
        additions = additions[: max(0, 32 - len(rows))]
        limit = scan_card_limit(user)
        if additions and limit is not None and user.scan_cards_used + len(additions) > limit:
            from scanner.worker import fail_job

            remaining = max(0, limit - user.scan_cards_used)
            guest_default = user.role == "guest" and user.scan_card_limit_override is None
            fail_job(
                job,
                scan,
                "GUEST_SCAN_LIMIT" if guest_default else "SCAN_CARD_LIMIT",
                f"This photo has {len(additions)} new card regions, but {remaining} {'guest' if guest_default else 'card'} scans remain. No scans were charged for this attempt.",
            )
            return False
        user.scan_cards_used += len(additions)
        scan.prepared_key, scan.thumbnail_key = result["prepared_key"], result["thumbnail_key"]
        scan.width, scan.height = result["width"], result["height"]
        next_index = max((row.region_index for row in rows), default=-1) + 1
        finish = new_observation_finish(db, scan) if additions else "unknown"
        for offset, region in enumerate(additions):
            index = next_index + offset
            db.add(
                Observation(
                    id=uuid.uuid5(scan.id, f"region:{index}"),
                    scan_id=scan.id,
                    region_index=index,
                    polygon=region["polygon"],
                    crop_key=region["crop_key"],
                    detector_version=detection.VERSION,
                    finish=finish,
                )
            )
        db.flush()
        advance(db, job, scan)
        return True


def detailed_crop(prepared_key, polygon):
    # Temporary higher-resolution working crop, never another stored copy.
    obj = storage.get(prepared_key, timeout=2)
    try:
        limit = get_settings().max_upload_bytes
        data = obj["Body"].read(limit + 1)
    finally:
        obj["Body"].close()
    if len(data) > limit:
        raise ValueError("Prepared photo exceeds enhancement limits")
    with Image.open(io.BytesIO(data)) as source:
        image = np.asarray(source.convert("RGB"))
    return detection.crop_region(image, polygon, scale=2)


def recognize_one(claimed):
    with session_factory()() as db, db.begin():
        locked = lock_scan_job(db, claimed)
        if not locked:
            return
        _, job, scan = locked
        rows = db.scalars(
            select(Observation)
            .where(Observation.scan_id == scan.id)
            .order_by(Observation.region_index)
        ).all()
        row = next(
            (r for r in rows if r.state == "NEEDS_REVIEW" and not r.recognition.get("status")), None
        )
        if row is None:
            advance(db, job, scan)
            return
        observation_id, version, crop_key = row.id, row.version, row.crop_key
        orientation = manual_rotation(row.recognition)
        enhanced = db.get(AccountPolicy, 1).enhanced_scanning_enabled
        prepared_key, polygon = scan.prepared_key, row.polygon
        sets = Counter(
            c["set_read"]
            for r in rows
            for c in r.recognition.get("candidates", [])[:1]
            if c.get("set_read")
        )
        set_hint = sets.most_common(1)[0][0] if sets and sets.most_common(1)[0][1] >= 2 else None
        job.stage = f"Reading card {rows.index(row) + 1} of {len(rows)}" + (
            " · Enhanced scanning" if enhanced else ""
        )
    started = time.monotonic()
    obj = storage.get(crop_key)
    try:
        data = obj["Body"].read(4 * 1024 * 1024)
    finally:
        obj["Body"].close()
    result = recognition.recognize(
        data,
        set_hint=set_hint,
        orientation=orientation,
        enhanced=enhanced,
        enhanced_image=(lambda: detailed_crop(prepared_key, polygon)) if enhanced else None,
    )
    with session_factory()() as db, db.begin():
        locked = lock_scan_job(db, claimed)
        if not locked:
            return
        _, job, scan = locked
        row = db.scalar(
            select(Observation).where(Observation.id == observation_id).with_for_update()
        )
        if (
            row
            and row.version == version
            and row.crop_key == crop_key
            and row.state == "NEEDS_REVIEW"
        ):
            row.recognition = {**reset_recognition(row.recognition), **result}
            row.version += 1
            if may_auto_import(result):
                candidate = result["candidates"][0]
                card = db.get(Printing, uuid.UUID(candidate["printing_id"]))
                if not card or row.finish != "unknown" and row.finish not in card.finishes:
                    row.recognition = {
                        **row.recognition,
                        "reason": "Check the suggested printing: it does not support the selected finish.",
                    }
                    db.flush()
                    advance(db, job, scan)
                    return
                if not scan.add_to_collection:
                    row.confirmed_printing_id = card.id
                    row.state = "COMMITTED"
                    row.recognition = {**row.recognition, "auto_confirmed": True}
                    db.flush()
                    job.result = {
                        **(job.result or {}),
                        "recognition_seconds": (job.result or {}).get("recognition_seconds", 0)
                        + time.monotonic()
                        - started,
                        "measured_cards": (job.result or {}).get("measured_cards", 0) + 1,
                    }
                    advance(db, job, scan)
                    return
                add_lot(
                    db,
                    scan.owner_id,
                    uuid.UUID(candidate["printing_id"]),
                    {
                        "quantity": 1,
                        "binder": "Scanned cards",
                        "finish": row.finish,
                        "condition": "ungraded",
                    },
                    observation_id=row.id,
                )
                db.flush()
                event = db.scalar(
                    select(InventoryEvent).where(InventoryEvent.operation_key == f"add:{row.id}")
                )
                event.kind = "ADD_SCAN_AUTO"
                event.detail = {
                    **event.detail,
                    "decision": "automatic",
                    "match_score": candidate["match_score"],
                    "threshold": AUTO_IMPORT_THRESHOLD,
                    "policy": AUTO_IMPORT_POLICY,
                    "model": result.get("version"),
                }
                row.recognition = {**row.recognition, "auto_imported": True}
                row.state = "COMMITTED"
        job.result = {
            **(job.result or {}),
            "recognition_seconds": (job.result or {}).get("recognition_seconds", 0)
            + time.monotonic()
            - started,
            "measured_cards": (job.result or {}).get("measured_cards", 0) + 1,
        }
        db.flush()
        advance(db, job, scan)


def queue_again(db, scan, redetect=False):
    job = db.scalar(select(Job).where(Job.scan_id == scan.id).with_for_update())
    if job and job.state in {"QUEUED", "RUNNING"}:
        return job
    if not job:
        return None
    job.state, job.stage, scan.state = "QUEUED", "Queued for card identification", "PROCESSING"
    job.attempts = 0
    job.lease_token = job.lease_until = job.completed_at = None
    job.error_code = job.error_message = None
    job.deadline_at = now() + timedelta(hours=24)
    job.result = {"redetect": redetect}
    outbox = db.get(Outbox, job.id)
    outbox.available_at, outbox.last_sent_at = now(), None
    return job
