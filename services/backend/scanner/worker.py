import hashlib
import logging
import uuid
from datetime import timedelta

from billiard.exceptions import SoftTimeLimitExceeded
from celery import Celery
from sqlalchemy import select

from scanner import detection, storage
from scanner.db import session_factory
from scanner.models import ExportBatch, ImportBatch, Job, Outbox, Scan, User, now
from scanner.photo_decode import ImageRejected, prepare_photo
from scanner.settings import get_settings

settings = get_settings()
logger = logging.getLogger(__name__)
celery = Celery("scanner", broker=settings.broker_url.get_secret_value())
celery.conf.update(
    task_serializer="json",
    accept_content=["json"],
    task_ignore_result=True,
    worker_prefetch_multiplier=1,
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    task_soft_time_limit=45,
    task_time_limit=60,
    broker_connection_retry_on_startup=True,
    broker_transport_options={
        "visibility_timeout": settings.lease_seconds + 30,
        "socket_connect_timeout": 3,
        "socket_timeout": 3,
    },
    task_publish_retry=False,
    worker_enable_remote_control=False,
)


def claim(job_id):
    with session_factory()() as db, db.begin():
        owner = db.scalar(select(Scan.owner_id).join(Job).where(Job.id == job_id))
        if owner:
            db.scalar(select(User).where(User.id == owner).with_for_update())
        job = db.scalar(select(Job).where(Job.id == job_id).with_for_update())
        if job is None or job.state in {"SUCCEEDED", "FAILED"}:
            return None
        if job.state == "RUNNING" and job.lease_until and job.lease_until > now():
            return None
        scan = db.get(Scan, job.scan_id) if job.scan_id else None
        if scan and scan.deleted_at:
            return None
        if job.deadline_at <= now() or job.attempts >= settings.max_attempts:
            fail_job(
                job,
                scan,
                "RETRY_LIMIT",
                "Processing could not finish. Check the saved job details.",
                db=db,
            )
            return None
        token = uuid.uuid4()
        job.state, job.stage = "RUNNING", "Processing on the server"
        job.attempts += 1
        job.lease_token, job.lease_until = token, now() + timedelta(seconds=settings.lease_seconds)
        job.error_code = job.error_message = None
        if scan:
            scan.state = "PROCESSING"
        return {
            "id": job.id,
            "scan_id": scan.id if scan else None,
            "key": scan.source_key if scan else None,
            "sha256": scan.sha256 if scan else None,
            "kind": job.kind,
            "prepared_key": scan.prepared_key if scan else None,
            "redetect": bool((job.result or {}).get("redetect")),
            "import_id": job.import_id,
            "export_id": job.export_id,
            "token": token,
        }


def fail_job(job, scan, code, message, db=None):
    job.state, job.stage = "FAILED", "Server processing needs attention"
    job.error_code, job.error_message = code, message
    job.lease_token = job.lease_until = None
    job.completed_at = now()
    if scan:
        scan.state = "FAILED"
    elif db and job.import_id:
        batch = db.get(ImportBatch, job.import_id)
        if batch.state not in {"UNDOING", "UNDONE"} or job.kind == "IMPORT_UNDO":
            batch.state, batch.error = "FAILED", message
        batch.expires_at = now() + timedelta(days=7)
    elif db and job.export_id:
        db.get(ExportBatch, job.export_id).state = "FAILED"


def prepare_image(data: bytes):
    """Real image validation/normalization. This function never identifies a card."""
    return prepare_photo(data, settings.max_decoded_pixels)


def finish(claimed, result):
    from scanner.scan_work import save_prepared

    return save_prepared(claimed, result)


def record_failure(claimed, *, permanent, message):
    with session_factory()() as db, db.begin():
        job = db.scalar(select(Job).where(Job.id == claimed["id"]).with_for_update())
        if job is None or job.lease_token != claimed["token"] or job.state != "RUNNING":
            return
        scan = db.get(Scan, job.scan_id) if job.scan_id else None
        if permanent or job.attempts >= settings.max_attempts or job.deadline_at <= now():
            fail_job(
                job,
                scan,
                ("INVALID_IMAGE" if scan else "INVALID_INPUT")
                if permanent
                else "PROCESSING_UNAVAILABLE",
                message,
                db=db,
            )
        else:
            job.state = "QUEUED"
            if scan:
                scan.state = "QUEUED"
            job.stage = "Waiting to retry on the server"
            job.lease_token = job.lease_until = None
            job.error_code, job.error_message = "TEMPORARY_FAILURE", message
            outbox = db.get(Outbox, job.id)
            outbox.available_at = now() + timedelta(seconds=2**job.attempts)
            outbox.last_sent_at = None


@celery.task(name="scanner.prepare")
def process_job(job_id: str):
    claimed = claim(uuid.UUID(job_id))
    if claimed is None:
        return
    from scanner.transfers import TransferRejected, execute

    try:
        if claimed["kind"] != "PREPARE_IMAGE":
            execute(claimed)
            return
        if claimed["prepared_key"] and not claimed["redetect"]:
            from scanner.scan_work import recognize_one

            recognize_one(claimed)
            return
        obj = storage.get(claimed["key"])
        try:
            data = obj["Body"].read(settings.max_upload_bytes + 1)
        finally:
            obj["Body"].close()
        if (
            len(data) > settings.max_upload_bytes
            or hashlib.sha256(data).hexdigest() != claimed["sha256"]
        ):
            raise ImageRejected("Stored photo verification failed. Upload the photo again.")
        prepared, thumbnail, width, height = prepare_image(data)
        prefix = f"derived/{claimed['scan_id']}/{claimed['token']}"
        prepared_key, thumbnail_key = prefix + "/photo.jpg", prefix + "/thumbnail.jpg"
        storage.put(prepared_key, prepared, "image/jpeg")
        storage.put(thumbnail_key, thumbnail, "image/jpeg")
        regions = detection.detect_regions(prepared)
        for index, region in enumerate(regions):
            region["crop_key"] = f"{prefix}/region-{index}.jpg"
            storage.put(region["crop_key"], region.pop("crop"), "image/jpeg")
        finish(
            claimed,
            {
                "prepared_key": prepared_key,
                "thumbnail_key": thumbnail_key,
                "width": width,
                "height": height,
                "regions": regions,
            },
        )
    except (ImageRejected, TransferRejected) as exc:
        record_failure(claimed, permanent=True, message=str(exc))
    except (SoftTimeLimitExceeded, Exception):
        # Log identifiers only: provider errors can contain keys, URLs or credentials.
        logger.warning("Processing attempt failed job=%s", claimed["id"])
        record_failure(
            claimed, permanent=False, message="The server will retry this processing step."
        )
