from datetime import timedelta

from sqlalchemy import delete, or_, select

from scanner import storage
from scanner.db import session_factory
from scanner.diagnostics import trim_logs
from scanner.models import (
    ExportBatch,
    ExportRow,
    ImportBatch,
    Job,
    LoginSession,
    Observation,
    Scan,
    now,
)
from scanner.settings import get_settings


def cleanup():
    """Expire photos, retain batch history, and protect active job inputs."""
    with session_factory()() as db, db.begin():
        trim_logs(db)
        db.execute(delete(LoginSession).where(LoginSession.expires_at < now()))
        scans = db.scalars(
            select(Scan)
            .outerjoin(Job)
            .where(
                Scan.state != "EXPIRED",
                or_(
                    Scan.deleted_at.is_not(None),
                    (Scan.state == "UPLOADING") & (Scan.created_at < now() - timedelta(hours=24)),
                    (Scan.expires_at < now()) & (Job.state.in_(["SUCCEEDED", "FAILED"])),
                ),
            )
            .limit(50)
            .with_for_update(of=Scan, skip_locked=True)
        ).all()
        for scan in scans:
            for region in db.scalars(select(Observation).where(Observation.scan_id == scan.id)):
                if region.crop_key:
                    storage.delete(region.crop_key)
                    region.crop_key = None
            for key in (scan.source_key, scan.prepared_key, scan.thumbnail_key):
                if key:
                    storage.delete(key)
            scan.source_key = scan.prepared_key = scan.thumbnail_key = None
            scan.state = "EXPIRED"
        for batch in db.scalars(
            select(ImportBatch)
            .where(
                ImportBatch.source_key.is_not(None),
                ImportBatch.expires_at < now(),
                ImportBatch.state.in_(["REVIEW", "COMPLETED", "UNDONE", "FAILED"]),
            )
            .limit(50)
            .with_for_update(skip_locked=True)
        ):
            storage.delete(batch.source_key)
            batch.source_key = None
        for export in db.scalars(
            select(ExportBatch)
            .where(ExportBatch.state == "READY", ExportBatch.expires_at < now())
            .limit(50)
            .with_for_update(skip_locked=True)
        ):
            storage.delete(export.object_key)
            export.object_key, export.state = None, "EXPIRED"
            db.execute(delete(ExportRow).where(ExportRow.export_id == export.id))
    cleanup_orphans()


def cleanup_orphans():
    # Grace exceeds the longest bounded upload/worker attempt. Referenced and active
    # scan objects are checked while locked so cleanup cannot race acceptance.
    settings = get_settings()
    paginator = storage.client().get_paginator("list_objects_v2")
    cutoff = now() - timedelta(hours=24)
    for page in paginator.paginate(Bucket=settings.storage_bucket):
        for obj in page.get("Contents", []):
            if obj["LastModified"] >= cutoff:
                continue
            key = obj["Key"]
            parts = key.split("/")
            if parts[0] not in {"originals", "derived", "imports", "exports"}:
                continue
            from uuid import UUID

            try:
                scan_id = UUID(parts[1] if parts[0] == "derived" else parts[2])
            except (ValueError, IndexError):
                continue
            with session_factory()() as db, db.begin():
                if parts[0] in {"imports", "exports"}:
                    model = ImportBatch if parts[0] == "imports" else ExportBatch
                    resource = db.scalar(select(model).where(model.id == scan_id).with_for_update())
                    reference = (
                        (resource.source_key if parts[0] == "imports" else resource.object_key)
                        if resource
                        else None
                    )
                    if resource and (
                        resource.state
                        in {"PREVIEWING", "COMMITTING", "UNDOING", "QUEUED", "PROCESSING"}
                        or key == reference
                    ):
                        continue
                    storage.delete(key)
                    continue
                scan = db.scalar(select(Scan).where(Scan.id == scan_id).with_for_update())
                if scan and (
                    scan.state in {"QUEUED", "PROCESSING"}
                    or key in {scan.source_key, scan.prepared_key, scan.thumbnail_key}
                    or db.scalar(
                        select(Observation.id)
                        .where(Observation.scan_id == scan.id, Observation.crop_key == key)
                        .limit(1)
                    )
                ):
                    continue
                storage.delete(key)
