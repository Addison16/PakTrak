import uuid
from datetime import timedelta

from fastapi import APIRouter, Query
from sqlalchemy import select

from scanner.auth import DB, Admin
from scanner.diagnostics import RETENTION_DAYS
from scanner.models import RequestErrorLog, now

router = APIRouter(prefix="/api/v1/diagnostics", tags=["diagnostics"])


@router.get("/errors")
def recent_errors(
    admin: Admin,
    db: DB,
    offset: int = Query(0, ge=0, le=10_000),
    reference: uuid.UUID | None = None,
):
    query = select(RequestErrorLog).where(
        RequestErrorLog.created_at >= now() - timedelta(days=RETENTION_DAYS)
    )
    if reference:
        query = query.where(RequestErrorLog.id == reference)
    rows = db.scalars(
        query.order_by(RequestErrorLog.created_at.desc(), RequestErrorLog.id.desc())
        .offset(offset)
        .limit(51)
    ).all()
    return {
        "items": [
            {
                "request_id": str(row.id),
                "created_at": row.created_at,
                "method": row.method,
                "route": row.route,
                "status": row.status,
                "code": row.code,
                "summary": row.summary,
                "duration_ms": row.duration_ms,
                "context": row.context,
            }
            for row in rows[:50]
        ],
        "next_offset": offset + 50 if len(rows) > 50 else None,
        "retention_days": RETENTION_DAYS,
    }
