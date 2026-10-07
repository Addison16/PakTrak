"""Administrator pages for automatic database backups (single-container installs)."""

from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field

from scanner import backups
from scanner.auth import Admin

router = APIRouter(prefix="/api/v1/backups", tags=["backups"])


class BackupSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool = Field(strict=True)
    keep: int = Field(ge=1, le=backups.MAX_KEEP, strict=True)


def folder():
    path = backups.backup_dir()
    if path is None or not path.is_dir():
        raise HTTPException(
            409,
            "Automatic backups are part of the single-container install. "
            "Compose installs use scripts/backup.sh.",
        )
    return path


def backup(name):
    try:
        return backups.find_backup(folder(), name)
    except backups.BackupError:
        raise HTTPException(404, "Backup not found. Refresh the list and try again.") from None


@router.get("")
def overview(admin: Admin):
    path = backups.backup_dir()
    if path is None or not path.is_dir():
        return {"available": False}
    return backups.status(path)


@router.post("/settings")
def save_settings(data: BackupSettings, admin: Admin):
    path = folder()
    backups.save_settings(path, data.enabled, data.keep)
    return backups.status(path)


@router.post("/run")
def back_up_now(admin: Admin):
    path = folder()
    (path / backups.BACKUP_REQUEST).touch()
    return backups.status(path)


@router.get("/{name}/download")
def download(name: str, admin: Admin):
    return FileResponse(
        backup(name),
        media_type="application/x-tar",
        filename=name,
        headers={"Cache-Control": "no-store"},
    )


@router.delete("/{name}")
def delete(name: str, admin: Admin):
    path = backup(name)
    if name in backups.protected(path.parent):
        raise HTTPException(409, "This backup is waiting to be restored. Cancel the restore first.")
    path.unlink(missing_ok=True)
    return backups.status(path.parent)


@router.post("/{name}/restore")
def request_restore(name: str, admin: Admin):
    path = backup(name)
    try:
        backups.check_schema(backups.read_manifest(path).get("schema"))
    except backups.BackupError as error:
        raise HTTPException(409, str(error)) from None
    backups.write_json(
        path.parent / backups.RESTORE_REQUEST,
        {"name": name, "requested_by": str(admin.id), "at": datetime.now(UTC).isoformat()},
    )
    return backups.status(path.parent)


@router.delete("/restore/request")
def cancel_restore(admin: Admin):
    path = folder()
    (path / backups.RESTORE_REQUEST).unlink(missing_ok=True)
    return backups.status(path)
