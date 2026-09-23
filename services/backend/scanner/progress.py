"""Measured, phase-specific estimates, never a fabricated completion countdown."""

import math
import time

from sqlalchemy import update

from scanner.db import session_factory
from scanner.models import Job, WorkProgress, now


class Progress:
    def __init__(self, save):
        self.save = save
        self.phase = None
        self.start = self.last = time.monotonic()

    def __call__(self, phase, done=0, total=None, unit="rows", force=False):
        current = time.monotonic()
        if phase != self.phase:
            self.phase, self.start, self.last = phase, current, 0
        if not force and current - self.last < 1:
            return
        elapsed = current - self.start
        eta = (
            math.ceil(elapsed * (total - done) / done)
            if total and 0 < done < total and elapsed >= 1
            else None
        )
        self.save(
            {
                "phase": phase,
                "done": done,
                "total": total,
                "unit": unit,
                "eta_seconds": eta,
                "measured_at": now().isoformat(),
            }
        )
        self.last = current


def job_progress(claimed):
    with session_factory()() as db, db.begin():
        db.execute(
            update(WorkProgress)
            .where(
                WorkProgress.job_id == claimed["id"],
                Job.id == WorkProgress.job_id,
                Job.lease_token == claimed["token"],
                Job.state == "RUNNING",
            )
            .values(token=claimed["token"], data={})
        )

    def save(data):
        with session_factory()() as db, db.begin():
            db.execute(
                update(WorkProgress)
                .where(
                    WorkProgress.job_id == claimed["id"],
                    WorkProgress.token == claimed["token"],
                )
                .values(data=data)
            )

    return Progress(save)
