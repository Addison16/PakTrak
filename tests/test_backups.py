import hashlib
import io
import json
import tarfile
from pathlib import Path

import pytest

from scanner import backups

SECRETS = {key: f"{key.lower()}-" + "x" * 40 for key in backups.SECRETS}


def make_backup(folder, name, schema=None, damage=False):
    dumps = {"scanner.dump": b"app data", "identity.dump": b"sign-in data"}
    manifest = {
        "format": backups.FORMAT,
        "version": backups.VERSION,
        "created_at": "2026-10-01T03:00:00+00:00",
        "kind": "automatic",
        "schema": schema,
        "databases": {
            database: {"file": filename, "sha256": hashlib.sha256(dumps[filename]).hexdigest()}
            for database, _owner, filename in backups.DATABASES
        },
    }
    if damage:
        dumps["scanner.dump"] = b"changed"
    path = Path(folder) / name
    with tarfile.open(path, "w") as archive:
        for member, data in (
            ("manifest.json", json.dumps(manifest).encode()),
            ("settings.env", "".join(f"{k}={v}\n" for k, v in SECRETS.items()).encode()),
            *dumps.items(),
        ):
            info = tarfile.TarInfo(member)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    return path


@pytest.fixture
def folder(tmp_path, monkeypatch):
    path = tmp_path / "backups"
    path.mkdir()
    monkeypatch.setenv("SCANNER_BACKUP_DIR", str(path))
    monkeypatch.setenv("SCANNER_APP_ROOT", str(Path.cwd()))
    return path


def test_backups_need_the_single_container_install(clients, monkeypatch):
    monkeypatch.delenv("SCANNER_BACKUP_DIR", raising=False)
    admin, _ = clients(role="admin")
    assert admin.get("/api/v1/backups").json() == {"available": False}
    assert admin.post("/api/v1/backups/run").status_code == 409


def test_only_admins_see_backups(clients, folder):
    make_backup(folder, "paktrak-backup-20261001-030000Z.tar")
    member, _ = clients(role="member")
    assert member.get("/api/v1/backups").status_code == 403
    assert (
        member.get("/api/v1/backups/paktrak-backup-20261001-030000Z.tar/download").status_code
        == 403
    )


def test_admin_settings_list_download_and_delete(clients, folder):
    admin, _ = clients(role="admin")
    status = admin.get("/api/v1/backups").json()
    assert status["settings"] == {"enabled": True, "keep": 7} and status["backups"] == []
    assert (
        admin.post("/api/v1/backups/settings", json={"enabled": True, "keep": 0}).status_code == 422
    )
    saved = admin.post("/api/v1/backups/settings", json={"enabled": False, "keep": 3}).json()
    assert saved["settings"] == {"enabled": False, "keep": 3} and saved["next_at"] is None
    assert admin.post("/api/v1/backups/run").json()["requested"] is True
    assert (folder / backups.BACKUP_REQUEST).exists()

    path = make_backup(folder, "paktrak-backup-20261001-030000Z-manual.tar")
    listed = admin.get("/api/v1/backups").json()["backups"]
    assert [(item["name"], item["kind"]) for item in listed] == [(path.name, "manual")]
    download = admin.get(f"/api/v1/backups/{path.name}/download")
    assert download.status_code == 200 and download.content == path.read_bytes()
    assert admin.get("/api/v1/backups/..%2Fpaktrak.env/download").status_code == 404
    assert admin.get("/api/v1/backups/settings.json/download").status_code == 404
    assert admin.delete(f"/api/v1/backups/{path.name}").json()["backups"] == []


def test_restore_request_and_cancel(clients, folder):
    admin, _ = clients(role="admin")
    path = make_backup(folder, "paktrak-backup-20261001-030000Z.tar")
    status = admin.post(f"/api/v1/backups/{path.name}/restore").json()
    assert status["restore_requested"] == path.name
    assert admin.delete(f"/api/v1/backups/{path.name}").status_code == 409
    assert admin.delete("/api/v1/backups/restore/request").json()["restore_requested"] is None
    newer = make_backup(folder, "paktrak-backup-20261002-030000Z.tar", schema="ffffffffffff")
    refused = admin.post(f"/api/v1/backups/{newer.name}/restore")
    assert refused.status_code == 409 and "newer PakTrak" in refused.json()["detail"]


def test_prune_keeps_the_newest_and_the_one_waiting_to_restore(folder):
    names = [f"paktrak-backup-2026100{day}-030000Z.tar" for day in range(1, 6)]
    for name in names:
        make_backup(folder, name)
    backups.write_json(folder / backups.RESTORE_REQUEST, {"name": names[0]})
    removed = backups.prune(folder, 2)
    assert sorted(removed) == names[1:3]
    assert sorted(path.name for path in backups.backup_files(folder)) == [names[0], *names[3:]]


def test_due_after_a_day_and_retries_hourly(folder):
    from datetime import datetime, timedelta

    now = datetime(2026, 10, 2, 4, tzinfo=backups.UTC)
    assert backups.due(folder, now)
    make_backup(folder, "paktrak-backup-20261002-030000Z.tar")
    assert not backups.due(folder, now)
    assert backups.due(folder, now + timedelta(hours=23))
    backups.write_json(
        folder / backups.STATUS_FILE, {"last_attempt_at": (now + timedelta(hours=23)).isoformat()}
    )
    assert not backups.due(folder, now + timedelta(hours=23, minutes=30))
    backups.save_settings(folder, False, 7)
    assert not backups.due(folder, now + timedelta(days=3))


def test_dropped_backup_brings_its_private_settings(folder):
    settings = folder.parent / "paktrak.env"
    settings.write_text("APP_NOTE=kept\nSESSION_SECRET=" + "o" * 40 + "\n")
    drop = folder.parent / "restore"
    drop.mkdir()
    make_backup(drop, "from-old-server.tar")
    backups.prepare_restore(folder)
    assert list(drop.iterdir()) == []
    moved = folder / "paktrak-backup-20261001-030000Z-imported.tar"
    assert moved.exists()
    assert json.loads((folder / backups.RESTORE_PENDING).read_text()) == {"name": moved.name}
    lines = settings.read_text().splitlines()
    assert "APP_NOTE=kept" in lines and f"SESSION_SECRET={SECRETS['SESSION_SECRET']}" in lines
    assert ("SESSION_SECRET=" + "o" * 40) in (
        folder.parent / "paktrak.env.before-restore"
    ).read_text()


def test_damaged_dropped_backup_stops_startup(folder):
    drop = folder.parent / "restore"
    drop.mkdir()
    make_backup(drop, "broken.tar", damage=True)
    with pytest.raises(backups.BackupError, match="damaged"):
        backups.prepare_restore(folder)
    assert (drop / "broken.tar").exists() and not (folder / backups.RESTORE_PENDING).exists()


def test_missing_requested_backup_is_skipped(folder):
    backups.write_json(
        folder / backups.RESTORE_REQUEST, {"name": "paktrak-backup-20261001-030000Z.tar"}
    )
    backups.prepare_restore(folder)
    assert not (folder / backups.RESTORE_REQUEST).exists()
    assert "error" in json.loads((folder / backups.LAST_RESTORE).read_text())
