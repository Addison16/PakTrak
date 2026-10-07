"""Automatic database backups for the single-container installation.

A backup is a plain tar file in SCANNER_BACKUP_DIR (``/data/backups``) holding
a manifest, the private settings the sign-in database depends on, and a
``pg_dump`` of the app and sign-in databases. Photos are left out: scan photos
are temporary and expire on their own after a few days.

A root-run service (``python -m scanner.backups serve``) makes the backups and
deletes the oldest beyond the keep-count. The API only lists them, saves the
settings and leaves request files for that service, so the web app never gets
database superuser access.

Restoring happens while the container starts, before the app runs:
``prepare-restore`` (before the private settings are read) picks the backup
asked for in the app, or the one backup file placed in the data folder's
``restore`` folder, and puts its private settings in place. ``restore`` (once
the database is up, before migrations) saves the current data as a
"before restore" backup, then replaces both databases. Migrations then bring
an older backup up to date.
"""

import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

FORMAT = "paktrak-database-backup"
VERSION = 1
NAME = re.compile(r"paktrak-backup-(\d{8}-\d{6})Z(?:-(manual|before-restore|imported))?\.tar\Z")
KINDS = {
    None: "automatic",
    "manual": "manual",
    "before-restore": "before-restore",
    "imported": "imported",
}
DATABASES = (
    ("scanner", "scanner", "scanner.dump"),
    ("identity_service", "identity_service", "identity.dump"),
)
ROLES = (
    ("postgres", "POSTGRES_PASSWORD"),
    ("scanner", "SCANNER_DB_PASSWORD"),
    ("identity_service", "KEYCLOAK_DB_PASSWORD"),
)
# The same private settings as infra/allinone/aio.py. They travel with the
# sign-in database: it stores the administrator password and client secrets.
SECRETS = (
    "POSTGRES_PASSWORD",
    "SCANNER_DB_PASSWORD",
    "KEYCLOAK_DB_PASSWORD",
    "SESSION_SECRET",
    "OIDC_CLIENT_SECRET",
    "PASSWORD_RESET_CLIENT_SECRET",
    "STORAGE_ACCESS_KEY",
    "STORAGE_SECRET_KEY",
    "KEYCLOAK_ADMIN_PASSWORD",
)
SECRET_VALUE = re.compile(r"[A-Za-z0-9_.~+/=-]{32,}\Z")
DEFAULT_KEEP = 7
MAX_KEEP = 60
INTERVAL = timedelta(hours=24)
RETRY = timedelta(hours=1)
SOCKET = "/var/run/postgresql"
RESTORING = "restoring_"

SETTINGS_FILE = "settings.json"
STATUS_FILE = "status.json"
BACKUP_REQUEST = "backup-requested"
RESTORE_REQUEST = "restore-requested.json"
RESTORE_PENDING = ".restore-pending.json"
LAST_RESTORE = "last-restore.json"


class BackupError(Exception):
    pass


def log(message):
    print(f"paktrak backups: {message}", flush=True)


def backup_dir():
    value = os.environ.get("SCANNER_BACKUP_DIR", "").strip()
    return Path(value) if value else None


def secrets_file(folder):
    return Path(os.environ.get("SCANNER_BACKUP_SETTINGS_FILE") or folder.parent / "paktrak.env")


def restore_folder(folder):
    return folder.parent / "restore"


def stamp(moment):
    return moment.astimezone(UTC).strftime("%Y%m%d-%H%M%S")


def parse_name(name):
    match = NAME.fullmatch(name or "")
    if not match:
        return None
    created = datetime.strptime(match.group(1), "%Y%m%d-%H%M%S").replace(tzinfo=UTC)
    return created, KINDS[match.group(2)]


def read_json(path, default=None):
    try:
        if path.stat().st_size > 64 * 1024:
            return default
        value = json.loads(path.read_text())
    except (OSError, ValueError):
        return default
    return value if isinstance(value, dict) else default


def write_private(path, data, owner=None):
    """Write a file atomically, readable only by the backup folder's owner."""
    temp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    old_umask = os.umask(0o077)
    try:
        with temp.open("wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        os.umask(old_umask)
    match_owner(temp, owner or path.parent)
    temp.replace(path)


def write_json(path, value):
    write_private(path, (json.dumps(value, indent=2) + "\n").encode())


def match_owner(path, folder):
    """Files the root service writes must stay readable by the app's user."""
    os.chmod(path, 0o600)
    if os.geteuid() == 0:
        info = Path(folder).stat()
        os.chown(path, info.st_uid, info.st_gid)


def load_settings(folder):
    raw = read_json(folder / SETTINGS_FILE, {})
    keep = raw.get("keep")
    if not isinstance(keep, int) or isinstance(keep, bool) or not 1 <= keep <= MAX_KEEP:
        keep = DEFAULT_KEEP
    enabled = raw.get("enabled")
    return {"enabled": enabled if isinstance(enabled, bool) else True, "keep": keep}


def save_settings(folder, enabled, keep):
    if not 1 <= keep <= MAX_KEEP:
        raise ValueError(f"Keep between 1 and {MAX_KEEP} backups.")
    write_json(folder / SETTINGS_FILE, {"enabled": enabled, "keep": keep})
    return load_settings(folder)


def read_manifest(path):
    """Return the manifest of a backup file, or raise BackupError."""
    try:
        with tarfile.open(path, "r:") as archive:
            member = archive.next()
            if member is None or member.name != "manifest.json" or not member.isfile():
                raise BackupError("This file is not a PakTrak database backup.")
            if member.size > 64 * 1024:
                raise BackupError("The backup's manifest is too large.")
            manifest = json.loads(archive.extractfile(member).read())
    except (OSError, tarfile.TarError, ValueError) as error:
        if isinstance(error, BackupError):
            raise
        raise BackupError("This file is not a readable PakTrak database backup.") from None
    if not isinstance(manifest, dict) or manifest.get("format") != FORMAT:
        raise BackupError("This file is not a PakTrak database backup.")
    if manifest.get("version") != VERSION:
        raise BackupError("This backup was made by a newer PakTrak. Update PakTrak first.")
    return manifest


def backup_info(path):
    created, kind = parse_name(path.name)
    info = {"name": path.name, "created_at": created.isoformat(), "kind": kind, "bytes": 0}
    try:
        info["bytes"] = path.stat().st_size
        manifest = read_manifest(path)
        info["created_at"] = manifest.get("created_at") or info["created_at"]
        info["schema"] = manifest.get("schema")
    except (OSError, BackupError) as error:
        info["problem"] = str(error) if isinstance(error, BackupError) else "Unreadable"
    return info


def backup_files(folder):
    """Backups, newest first."""
    files = [path for path in folder.iterdir() if parse_name(path.name) and path.is_file()]
    return sorted(files, key=lambda path: (parse_name(path.name)[0], path.name), reverse=True)


def find_backup(folder, name):
    if not parse_name(name):
        raise BackupError("Backup not found.")
    path = folder / name
    if not path.is_file():
        raise BackupError("Backup not found.")
    return path


def protected(folder):
    names = set()
    for marker in (RESTORE_REQUEST, RESTORE_PENDING):
        name = read_json(folder / marker, {}).get("name")
        if isinstance(name, str):
            names.add(name)
    return names


def prune(folder, keep):
    """Delete the oldest backups beyond the keep-count. Returns the names removed."""
    keeping, removed = protected(folder), []
    for path in backup_files(folder)[keep:]:
        if path.name not in keeping:
            path.unlink(missing_ok=True)
            removed.append(path.name)
    return removed


def status(folder):
    data = read_json(folder / STATUS_FILE, {})
    files = backup_files(folder)
    settings = load_settings(folder)
    newest = parse_name(files[0].name)[0] if files else None
    request = read_json(folder / RESTORE_REQUEST, None)
    return {
        "available": True,
        "settings": settings,
        "running": bool(data.get("running")) and not stale_run(data),
        "requested": (folder / BACKUP_REQUEST).exists(),
        "last_success_at": data.get("last_success_at"),
        "last_error": data.get("last_error"),
        "last_error_at": data.get("last_error_at"),
        "next_at": (
            (newest + INTERVAL if newest else datetime.now(UTC)).isoformat()
            if settings["enabled"]
            else None
        ),
        "restore_requested": request.get("name") if request else None,
        "last_restore": read_json(folder / LAST_RESTORE, None),
        "backups": [backup_info(path) for path in files],
    }


def stale_run(data):
    started = data.get("started_at")
    try:
        return datetime.now(UTC) - datetime.fromisoformat(started) > timedelta(hours=6)
    except (TypeError, ValueError):
        return True


# Root-only work below: the backup service and the restore steps at startup.


def postgres(program, *args, **kwargs):
    """Run a PostgreSQL client as the database superuser over the local socket."""
    return subprocess.run(
        [program, "-h", SOCKET, "-U", "postgres", "-w", *args],
        check=True,
        env={**os.environ, "PGCONNECT_TIMEOUT": "10"},
        **kwargs,
    )


def sql(statement, database="postgres"):
    result = postgres(
        "psql",
        "-X",
        "-q",
        "-A",
        "-t",
        "-v",
        "ON_ERROR_STOP=1",
        "-d",
        database,
        "-c",
        statement,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def identifier(value):
    if not re.fullmatch(r"[a-z_][a-z0-9_]*", value):
        raise BackupError("Unexpected database name.")
    return '"' + value + '"'


def database_exists(name):
    return sql(f"SELECT 1 FROM pg_database WHERE datname = {literal(name)}") == "1"


def schema_revision():
    if not database_exists("scanner"):
        return None
    try:
        return sql("SELECT version_num FROM alembic_version", "scanner") or None
    except subprocess.CalledProcessError:
        return None


def read_secrets(path):
    values = {}
    for line in path.read_text().splitlines():
        key, sep, value = line.partition("=")
        if sep and key in SECRETS:
            values[key] = value
    missing = [key for key in SECRETS if not SECRET_VALUE.fullmatch(values.get(key, ""))]
    if missing:
        raise BackupError(f"The private settings file is missing {', '.join(missing)}.")
    return values


def add_bytes(archive, name, data):
    member = tarfile.TarInfo(name)
    member.size, member.mode, member.mtime = len(data), 0o600, int(time.time())
    archive.addfile(member, io.BytesIO(data))


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            result.update(chunk)
    return result.hexdigest()


def create_backup(folder, kind, secrets_path=None):
    """Dump both databases into a new backup file and return its path."""
    suffix = {"automatic": "", "manual": "-manual", "before-restore": "-before-restore"}[kind]
    while True:
        moment = datetime.now(UTC).replace(microsecond=0)
        target = folder / f"paktrak-backup-{stamp(moment)}Z{suffix}.tar"
        if not target.exists():
            break
        time.sleep(1)
    secrets = read_secrets(secrets_path or secrets_file(folder))
    work = folder / f".work-{stamp(moment)}-{os.getpid()}"
    old_umask = os.umask(0o077)
    try:
        work.mkdir()
        databases = {}
        for database, _owner, filename in DATABASES:
            dump = work / filename
            with dump.open("wb") as stream:
                postgres("pg_dump", "-Fc", "-Z", "6", "-d", database, stdout=stream)
            databases[database] = {
                "file": filename,
                "bytes": dump.stat().st_size,
                "sha256": digest(dump),
            }
        manifest = {
            "format": FORMAT,
            "version": VERSION,
            "created_at": moment.isoformat(),
            "kind": kind,
            "schema": schema_revision(),
            "databases": databases,
        }
        partial = work / "backup.tar"
        with tarfile.open(partial, "w", format=tarfile.PAX_FORMAT) as archive:
            add_bytes(archive, "manifest.json", (json.dumps(manifest, indent=2) + "\n").encode())
            add_bytes(
                archive,
                "settings.env",
                "".join(f"{key}={secrets[key]}\n" for key in SECRETS).encode(),
            )
            for _database, _owner, filename in DATABASES:
                archive.add(work / filename, arcname=filename)
        with partial.open("rb") as stream:
            os.fsync(stream.fileno())
        match_owner(partial, folder)
        partial.replace(target)
    finally:
        os.umask(old_umask)
        shutil.rmtree(work, ignore_errors=True)
    return target


def check_backup(path):
    """Read a whole backup and return its manifest and private settings."""
    manifest = read_manifest(path)
    databases = manifest.get("databases")
    expected = {database: filename for database, _owner, filename in DATABASES}
    if (
        not isinstance(databases, dict)
        or {key: (value or {}).get("file") for key, value in databases.items()} != expected
    ):
        raise BackupError("The backup does not contain both PakTrak databases.")
    secrets = None
    seen = set()
    with tarfile.open(path, "r:") as archive:
        for member in archive:
            if not member.isfile() or member.name in seen:
                raise BackupError("The backup contains unexpected entries.")
            seen.add(member.name)
            stream = archive.extractfile(member)
            if member.name == "settings.env":
                secrets = {}
                for line in stream.read(64 * 1024).decode().splitlines():
                    key, sep, value = line.partition("=")
                    if sep and key in SECRETS and SECRET_VALUE.fullmatch(value):
                        secrets[key] = value
            elif member.name in expected.values():
                result = hashlib.sha256()
                while chunk := stream.read(1024 * 1024):
                    result.update(chunk)
                database = next(key for key, value in expected.items() if value == member.name)
                if result.hexdigest() != databases[database].get("sha256"):
                    raise BackupError("The backup is damaged: a database copy does not match.")
            elif member.name != "manifest.json":
                raise BackupError("The backup contains unexpected entries.")
    if seen != {"manifest.json", "settings.env", *expected.values()}:
        raise BackupError("The backup is incomplete.")
    if secrets is None or set(secrets) != set(SECRETS):
        raise BackupError("The backup's private settings are incomplete.")
    check_schema(manifest.get("schema"))
    return manifest, secrets


def check_schema(revision):
    """Refuse a backup from a newer PakTrak whose database this version cannot read."""
    if revision is None:
        return
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    root = Path(os.environ.get("SCANNER_APP_ROOT", "/app"))
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "migrations"))
    try:
        ScriptDirectory.from_config(config).get_revision(revision)
    except Exception:
        raise BackupError(
            "This backup was made by a newer PakTrak. Update PakTrak, then restore it."
        ) from None


def record_status(folder, **changes):
    data = read_json(folder / STATUS_FILE, {})
    data.update(changes)
    write_json(folder / STATUS_FILE, data)


def run_backup(folder, kind):
    started = datetime.now(UTC).isoformat()
    record_status(folder, running=True, started_at=started, last_attempt_at=started)
    try:
        path = create_backup(folder, kind)
        removed = prune(folder, load_settings(folder)["keep"])
    except (OSError, BackupError, subprocess.CalledProcessError) as error:
        message = str(error) if isinstance(error, BackupError) else "The database copy failed."
        log(f"backup failed: {error}")
        record_status(
            folder,
            running=False,
            last_error=message,
            last_error_at=datetime.now(UTC).isoformat(),
        )
        return None
    log(f"saved {path.name}" + (f"; removed {len(removed)} older" if removed else ""))
    record_status(
        folder,
        running=False,
        last_success_at=datetime.now(UTC).isoformat(),
        last_error=None,
        last_error_at=None,
    )
    return path


def due(folder, now=None):
    now = now or datetime.now(UTC)
    if not load_settings(folder)["enabled"]:
        return False
    files = backup_files(folder)
    if files and now - parse_name(files[0].name)[0] < INTERVAL:
        return False
    attempt = read_json(folder / STATUS_FILE, {}).get("last_attempt_at")
    try:
        return now - datetime.fromisoformat(attempt) >= RETRY
    except (TypeError, ValueError):
        return True


def serve(folder):
    for leftover in folder.glob(".work-*"):
        shutil.rmtree(leftover, ignore_errors=True)
    record_status(folder, running=False)
    log("automatic backups are running")
    while True:
        request = folder / BACKUP_REQUEST
        if request.exists():
            request.unlink(missing_ok=True)
            run_backup(folder, "manual")
        elif due(folder):
            run_backup(folder, "automatic")
        time.sleep(5)


def replace_secrets(path, secrets):
    """Put a backup's private settings in place, keeping every other line."""
    lines = (
        [line for line in path.read_text().splitlines() if line.partition("=")[0] not in SECRETS]
        if path.exists()
        else []
    )
    lines += [f"{key}={secrets[key]}" for key in SECRETS]
    write_private(
        path, ("\n".join(lines) + "\n").encode(), owner=path if path.exists() else path.parent
    )


def prepare_restore(folder):
    """Choose the backup to restore and put its private settings in place.

    Runs before the private settings are read at startup. A backup file placed
    in the restore folder wins over one chosen in the app.
    """
    folder.mkdir(mode=0o700, exist_ok=True)
    drop = restore_folder(folder)
    dropped = sorted(path for path in drop.glob("*.tar") if path.is_file()) if drop.is_dir() else []
    request = folder / RESTORE_REQUEST
    if len(dropped) > 1:
        raise BackupError(
            f"Leave only one backup file in {drop}, or remove them all to start without restoring."
        )
    if dropped:
        source = dropped[0]
        try:
            manifest, secrets = check_backup(source)
        except BackupError as error:
            raise BackupError(
                f"{source.name} cannot be restored: {error} Remove it from {drop} to start without restoring."
            ) from None
        if parse_name(source.name) and not (folder / source.name).exists():
            target = folder / source.name
        else:
            created = datetime.fromisoformat(manifest["created_at"])
            target = folder / f"paktrak-backup-{stamp(created)}Z-imported.tar"
            if target.exists():
                target.unlink()
        shutil.move(source, target)
        match_owner(target, folder)
        request.unlink(missing_ok=True)
        log(f"restoring {target.name} from the restore folder")
    elif request.exists():
        name = read_json(request, {}).get("name")
        request.unlink(missing_ok=True)
        try:
            target = find_backup(folder, name)
            manifest, secrets = check_backup(target)
        except BackupError as error:
            log(f"the restore asked for in the app was skipped: {error}")
            write_json(
                folder / LAST_RESTORE,
                {"name": name, "error": str(error), "at": datetime.now(UTC).isoformat()},
            )
            return
        log(f"restoring {target.name}, chosen in the app")
    else:
        return
    settings = secrets_file(folder)
    previous = settings.with_name(settings.name + ".before-restore")
    pending = read_json(folder / RESTORE_PENDING, None)
    # A restore that stopped part way already moved the original settings aside.
    if settings.exists() and not (pending and previous.exists()):
        shutil.copy2(settings, previous)
    write_json(folder / RESTORE_PENDING, {"name": target.name})
    replace_secrets(settings, secrets)


def set_role_passwords(secrets):
    for role, variable in ROLES:
        password = literal(secrets[variable])
        if sql(f"SELECT 1 FROM pg_roles WHERE rolname = {literal(role)}") == "1":
            sql(f"ALTER ROLE {identifier(role)} WITH LOGIN PASSWORD {password}")
        else:
            sql(f"CREATE ROLE {identifier(role)} LOGIN PASSWORD {password}")


def restore_database(path, database, owner, filename):
    """Restore one database into a new database named ``database``."""
    sql(f"DROP DATABASE IF EXISTS {identifier(database)} WITH (FORCE)")
    sql(f"CREATE DATABASE {identifier(database)} OWNER {identifier(owner)}")
    with tarfile.open(path, "r:") as archive:
        stream = archive.extractfile(archive.getmember(filename))
        process = subprocess.Popen(
            [
                "pg_restore",
                "-h",
                SOCKET,
                "-U",
                "postgres",
                "-w",
                "--exit-on-error",
                "--single-transaction",
                "-d",
                database,
            ],
            stdin=subprocess.PIPE,
        )
        try:
            shutil.copyfileobj(stream, process.stdin, 1024 * 1024)
            process.stdin.close()
        except BrokenPipeError:
            pass
        if process.wait() != 0:
            raise BackupError(f"Restoring the {database} database failed; see the messages above.")


def restore(folder):
    """Replace both databases with the pending backup. Needs the database running."""
    pending_path = folder / RESTORE_PENDING
    pending = read_json(pending_path, None)
    if not pending:
        return
    path = find_backup(folder, pending.get("name"))
    _manifest, secrets = check_backup(path)
    settings = secrets_file(folder)
    previous = settings.with_name(settings.name + ".before-restore")
    if not pending.get("saved") and schema_revision():
        saved = create_backup(folder, "before-restore", previous if previous.exists() else settings)
        log(f"saved the current data as {saved.name} before restoring")
        pending["saved"] = saved.name
        write_json(pending_path, pending)
    # Restore into new databases first and swap them in only once both
    # succeed, so a failed restore leaves the current data untouched.
    set_role_passwords(secrets)
    try:
        for database, owner, filename in DATABASES:
            log(f"restoring the {database} database")
            restore_database(path, RESTORING + database, owner, filename)
    except (OSError, BackupError, subprocess.CalledProcessError) as error:
        undo_restore(folder, settings, previous, path, error)
        raise BackupError(
            "The backup could not be restored, so the current data was kept. "
            "Start the container again to use it."
        ) from None
    for database, _owner, _filename in DATABASES:
        sql(f"DROP DATABASE IF EXISTS {identifier(database)} WITH (FORCE)")
        sql(f"ALTER DATABASE {identifier(RESTORING + database)} RENAME TO {identifier(database)}")
    previous.unlink(missing_ok=True)
    write_json(
        folder / LAST_RESTORE,
        {
            "name": path.name,
            "saved": pending.get("saved"),
            "at": datetime.now(UTC).isoformat(),
        },
    )
    pending_path.unlink(missing_ok=True)
    log(f"restored {path.name}")


def undo_restore(folder, settings, previous, path, error):
    """Put the previous private settings back after a failed restore."""
    log(f"restoring {path.name} failed: {error}")
    for database, _owner, _filename in DATABASES:
        sql(f"DROP DATABASE IF EXISTS {identifier(RESTORING + database)} WITH (FORCE)")
    if previous.exists():
        set_role_passwords(read_secrets(previous))
        previous.replace(settings)
    write_json(
        folder / LAST_RESTORE,
        {
            "name": path.name,
            "error": "PostgreSQL could not load this backup. The current data was kept.",
            "at": datetime.now(UTC).isoformat(),
        },
    )
    (folder / RESTORE_PENDING).unlink(missing_ok=True)


def main(argv):
    folder = backup_dir()
    if folder is None or len(argv) != 1 or argv[0] not in {"serve", "prepare-restore", "restore"}:
        sys.exit(
            "Usage: SCANNER_BACKUP_DIR=... python -m scanner.backups serve|prepare-restore|restore"
        )
    try:
        if argv[0] == "serve":
            serve(folder)
        elif argv[0] == "prepare-restore":
            prepare_restore(folder)
        else:
            restore(folder)
    except (BackupError, subprocess.CalledProcessError) as error:
        log(f"restore stopped: {error}")
        sys.exit(1)


if __name__ == "__main__":
    main(sys.argv[1:])
