import logging
import time
from datetime import timedelta

from sqlalchemy import or_, select

from scanner.db import session_factory
from scanner.models import Job, Outbox, Scan, now
from scanner.settings import get_settings
from scanner.worker import celery, fail_job

logger = logging.getLogger(__name__)


def reconcile():
    settings = get_settings()
    with session_factory()() as db, db.begin():
        jobs = db.scalars(
            select(Job)
            .where(
                Job.state.in_(["QUEUED", "RUNNING"]),
                or_(
                    Job.deadline_at <= now(), (Job.state == "RUNNING") & (Job.lease_until <= now())
                ),
            )
            .limit(50)
            .with_for_update(skip_locked=True)
        ).all()
        for job in jobs:
            scan = db.get(Scan, job.scan_id) if job.scan_id else None
            if job.deadline_at <= now() or job.attempts >= settings.max_attempts:
                fail_job(
                    job,
                    scan,
                    "RETRY_LIMIT",
                    "Processing could not finish. Check the saved job details.",
                    db=db,
                )
            else:
                job.state = "QUEUED"
                if scan:
                    scan.state = "QUEUED"
                job.stage = "Recovering interrupted server work"
                job.lease_token = job.lease_until = None
                outbox = db.get(Outbox, job.id)
                outbox.available_at, outbox.last_sent_at = now(), None


def dispatch_once(publish=None):
    reconcile()
    settings = get_settings()
    if publish is None:

        def publish(job_id):
            kind = db.get(Job, job_id).kind
            return celery.send_task(
                "scanner.prepare",
                args=[str(job_id)],
                queue="scans" if kind == "PREPARE_IMAGE" else "transfers",
            )

    sent = 0
    with session_factory()() as db, db.begin():
        entries = db.scalars(
            select(Outbox)
            .join(Job)
            .where(
                Job.state == "QUEUED",
                Outbox.available_at <= now(),
                or_(
                    Outbox.last_sent_at.is_(None),
                    Outbox.last_sent_at < now() - timedelta(seconds=settings.dispatch_seconds),
                ),
            )
            .order_by(Outbox.available_at)
            .limit(20)
            .with_for_update(of=Outbox, skip_locked=True)
        ).all()
        for entry in entries:
            publish(entry.job_id)
            entry.last_sent_at = now()
            entry.send_count += 1
            sent += 1
    return sent


def main():
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    from scanner.maintenance import cleanup

    last_cleanup = 0
    while True:
        try:
            count = dispatch_once()
            if count:
                logger.info("Published %s queued jobs", count)
            if time.monotonic() - last_cleanup > 60:
                cleanup()
                last_cleanup = time.monotonic()
        except Exception:
            logger.warning("Dispatch or cleanup unavailable; retrying from durable records")
        time.sleep(2)


if __name__ == "__main__":
    main()
