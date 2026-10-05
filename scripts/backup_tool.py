"""Private Docker-only helpers for coordinated PakTrak backups.

The shell drivers control Docker. This helper runs with networking disabled and
only the source/destination mounts needed for each operation.
"""

import argparse
import gzip
import hashlib
import json
import os
import re
import shutil
import sys
import tarfile
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath

FORMAT = "paktrak-cold-backup"
VERSION = 1
NAME = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}\Z")
IMAGE = re.compile(r"sha256:[a-f0-9]{64}\Z")
CONTAINER = re.compile(r"[a-f0-9]{64}\Z")
SKIP = {
    ".git",
    ".venv",
    ".tools",
    ".pytest_cache",
    ".ruff_cache",
    "__pycache__",
    "node_modules",
    "dist",
    "test-results",
    "playwright-report",
    "artifacts",
    "backups",
    ".hermes-backups",
    ".hermes-stage",
    ".paktrak-backup.lock",
    ".paktrak-update.lock",
}


def fail(message):
    raise ValueError(message)


def name(value):
    if not isinstance(value, str) or not NAME.fullmatch(value):
        fail("Invalid service, volume or archive name")
    return value


def private_file(path):
    os.chmod(path, 0o600)
    os.chown(path, int(os.environ["BACKUP_UID"]), int(os.environ["BACKUP_GID"]))


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")
    private_file(path)


def read_json(path):
    if path.stat().st_size > 4 * 1024 * 1024:
        fail("Metadata file is too large")
    return json.loads(path.read_text())


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            result.update(chunk)
    return result.hexdigest()


def config():
    raw = json.load(sys.stdin)
    project = name(raw["name"])
    volumes = []
    for key, value in raw.get("volumes", {}).items():
        volumes.append(
            {
                "key": name(key),
                "name": name(value.get("name", f"{project}_{key}")),
                "archive": f"{name(key)}.tar.gz",
            }
        )
    if {item["key"] for item in volumes} != {"database", "broker", "photos"}:
        fail("Expected exactly the database, broker and photos named volumes")
    if any(
        item.get("driver", "local") != "local" or item.get("driver_opts")
        for item in raw["volumes"].values()
    ):
        fail("Custom volume drivers require their own coordinated backup procedure")
    services = {
        name(key): {
            "image_ref": value.get("image"),
            "depends_on": list(value.get("depends_on", {})),
        }
        for key, value in raw["services"].items()
    }
    write_json(
        Path("/output/compose-plan.json"),
        {"project": project, "volumes": volumes, "services": services},
    )


def containers():
    raw = json.load(sys.stdin)
    values = []
    for item in raw:
        labels = item.get("Config", {}).get("Labels", {})
        service = name(labels["com.docker.compose.service"])
        if not CONTAINER.fullmatch(item["Id"]) or not IMAGE.fullmatch(item["Image"]):
            fail("Docker returned an invalid container/image identifier")
        if item["State"].get("Paused"):
            fail("Unpause project containers before taking a backup")
        if (
            labels.get("com.docker.compose.oneoff", "false").lower() == "true"
            and item["State"]["Running"]
        ):
            fail("Finish one-off project commands before taking a backup")
        values.append(
            {
                "id": item["Id"],
                "service": service,
                "image_id": item["Image"],
                "was_running": item["State"]["Running"],
                "oneoff": labels.get("com.docker.compose.oneoff", "false").lower() == "true",
            }
        )
    # Store no environment variables or container credentials.
    write_json(Path("/output/containers.json"), values)


def query(filename, field):
    value = read_json(Path("/input") / name(filename))
    if field == "project":
        print(name(value["project"]))
    elif field == "volumes":
        for item in value["volumes"]:
            print(name(item["key"]), name(item["name"]))
    elif field == "volume-keys":
        print(" ".join(name(item["key"]) for item in value["volumes"]))
    elif field == "running":
        print(" ".join(item["id"] for item in value if item["was_running"]))
    elif field == "images":
        print(" ".join(sorted({item["image_id"] for item in value})))
    elif field == "has-images":
        print("true" if "images.tar.gz" in value["files"] else "false")
    else:
        fail("Unknown metadata query")


def check_member(member):
    path = PurePosixPath(member.name)
    if path.is_absolute() or ".." in path.parts:
        fail("Archive contains a path outside its destination")
    if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
        fail("Archive contains an unsupported special file")
    if member.issym() or member.islnk():
        target = PurePosixPath(member.linkname)
        if target.is_absolute():
            fail("Archive contains an absolute link")
        combined = path.parent / target if member.issym() else target
        depth = 0
        for part in combined.parts:
            if part == "..":
                depth -= 1
                if depth < 0:
                    fail("Archive link escapes its destination")
            elif part not in ("", "."):
                depth += 1
    return member


def validate_archive(path):
    with tarfile.open(path, "r:gz") as archive:
        for member in archive:
            check_member(member)
            if member.isfile():
                stream = archive.extractfile(member)
                while stream.read(1024 * 1024):
                    pass


def archive_volume(key):
    target = Path("/output") / f"{name(key)}.tar.gz"
    with tarfile.open(target, "w:gz", compresslevel=3) as archive:
        archive.add("/volume", arcname=".", filter=check_member)
    private_file(target)


def archive_installation(source_host, stage_host, destination_host):
    root = Path("/installation")
    excluded = set()
    for host in (stage_host, destination_host):
        try:
            excluded.add(Path(host).relative_to(source_host).as_posix())
        except ValueError:
            pass

    def keep(member):
        parts = PurePosixPath(member.name).parts
        if any(part in SKIP or part.startswith(".paktrak-backup.") for part in parts):
            return None
        if any(member.name == value or member.name.startswith(value + "/") for value in excluded):
            return None
        if member.name.endswith((".pyc", ".pyo", ".tsbuildinfo")):
            return None
        return check_member(member)

    target = Path("/output/installation.tar.gz")
    with tarfile.open(target, "w:gz", compresslevel=3) as archive:
        for child in sorted(root.iterdir()):
            archive.add(child, arcname=child.name, filter=keep)
    private_file(target)


def compress_images():
    source = Path("/output/images.tar")
    with tarfile.open(source, "r:") as archive:
        manifest = json.load(archive.extractfile("manifest.json"))
        if not manifest or any(item.get("RepoTags") for item in manifest):
            fail("Image export must contain image IDs without shared repository tags")
    target = Path("/output/images.tar.gz")
    with source.open("rb") as raw, gzip.open(target, "wb", compresslevel=3) as compressed:
        shutil.copyfileobj(raw, compressed, 1024 * 1024)
    private_file(target)
    source.unlink()


def manifest():
    root = Path("/output")
    config_plan = read_json(root / "compose-plan.json")
    container_plan = read_json(root / "containers.json")
    files = ["installation.tar.gz", *(item["archive"] for item in config_plan["volumes"])]
    if (root / "images.tar.gz").exists():
        files.append("images.tar.gz")
    images = {}
    for item in container_plan:
        if not item["oneoff"]:
            previous = images.setdefault(item["service"], item["image_id"])
            if previous != item["image_id"]:
                fail("A service has multiple installed image versions; finish the rollout first")
    result = {
        "format": FORMAT,
        "version": VERSION,
        "created_at": datetime.now(UTC).isoformat(),
        "project": config_plan["project"],
        "volumes": config_plan["volumes"],
        "service_images": images,
        "containers": container_plan,
        "files": {
            filename: {"sha256": digest(root / filename), "bytes": (root / filename).stat().st_size}
            for filename in files
        },
    }
    write_json(root / "manifest.json", result)
    (root / "compose-plan.json").unlink()
    (root / "containers.json").unlink()


def verify():
    root = Path("/input")
    value = read_json(root / "manifest.json")
    if value.get("format") != FORMAT or value.get("version") != VERSION:
        fail("Unsupported backup format/version")
    name(value["project"])
    if {item["key"] for item in value["volumes"]} != {"database", "broker", "photos"}:
        fail("Backup must contain database, broker and photos volumes")
    expected = {
        "installation.tar.gz",
        *(f"{name(item['key'])}.tar.gz" for item in value["volumes"]),
    }
    if "images.tar.gz" in value["files"]:
        expected.add("images.tar.gz")
    if set(value["files"]) != expected:
        fail("Backup file manifest is incomplete or contains unsupported files")
    for item in value["volumes"]:
        if item["archive"] != f"{name(item['key'])}.tar.gz":
            fail("Invalid volume archive path")
    for service, image_id in value["service_images"].items():
        name(service)
        if not IMAGE.fullmatch(image_id):
            fail("Invalid restored image identifier")
    for filename, metadata in value["files"].items():
        path = root / name(filename)
        if path.is_symlink() or not path.is_file():
            fail(f"Missing archive: {filename}")
        if path.stat().st_size != metadata["bytes"] or digest(path) != metadata["sha256"]:
            fail(f"Checksum/size mismatch: {filename}")
        validate_archive(path)
    with tarfile.open(root / "installation.tar.gz", "r:gz") as archive:
        paths = {member.name for member in archive}
        if not {"compose.yaml", ".env", "infra/generated"}.issubset(paths):
            fail("Installation archive is missing matching configuration")
    print("Backup verified: all archives, paths and SHA-256 checksums are valid.")


def extract(path, destination):
    if any(destination.iterdir()):
        fail("Restore destination is not empty")
    with tarfile.open(path, "r:gz") as archive:
        members = archive.getmembers()
        for member in members:
            check_member(member)
        # Check resolved paths again as earlier members create links. Lexical
        # checks alone cannot contain paths composed through multiple symlinks.
        archive.extractall(
            destination,
            members=members,
            numeric_owner=True,
            filter=extraction_member,
        )
        # A later link can change where an earlier forward link resolves even
        # when no subsequent file uses it. Reject that completed link graph too.
        for member in members:
            extraction_member(member, destination)


def extraction_member(member, destination):
    check_member(member)
    if member.issym() or member.islnk():
        root = os.path.realpath(destination)
        parent = os.path.dirname(member.name.rstrip("/")) if member.issym() else ""
        target = os.path.realpath(os.path.join(root, parent, member.linkname))
        if os.path.commonpath((root, target)) != root:
            raise tarfile.LinkOutsideDestinationError(member, target)
    # Use Python's extraction-time containment checks. Check the original link
    # above too: data_filter may normalize it before resolving its destination.
    tarfile.data_filter(member, destination)
    # Keep the original link semantics, numeric ownership and exact permissions;
    # the data filter's metadata changes would break a database volume restore.
    return member


def restore_installation(project):
    root = Path("/installation")
    value = read_json(Path("/input/manifest.json"))
    extract(Path("/input/installation.tar.gz"), root)
    uid, gid = int(os.environ["BACKUP_UID"]), int(os.environ["BACKUP_GID"])
    for path in root.rglob("*"):
        os.chown(path, uid, gid, follow_symlinks=False)
    override = {
        "volumes": {
            item["key"]: {"name": f"{name(project)}_{name(item['key'])}", "external": False}
            for item in value["volumes"]
        }
    }
    if "images.tar.gz" in value["files"]:
        override["services"] = {
            service: {"image": image_id, "pull_policy": "never"}
            for service, image_id in value["service_images"].items()
        }
    # JSON is valid YAML and avoids adding a YAML dependency.
    write_json(root / "restore-compose.yaml", override)
    write_json(
        root / ".restore-incomplete.json",
        {"project": project, "backup_created_at": value["created_at"]},
    )
    os.chmod(root / ".env", 0o600)
    for path in (root / "infra/generated").rglob("*"):
        if path.is_file():
            os.chmod(path, 0o600)


def restore_volume(key):
    extract(Path("/input") / f"{name(key)}.tar.gz", Path("/volume"))


def finish_restore():
    marker = Path("/installation/.restore-incomplete.json")
    marker.rename(marker.with_name(".restore-complete.json"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command")
    parser.add_argument("arguments", nargs="*")
    args = parser.parse_args()
    commands = {
        "config": config,
        "containers": containers,
        "query": query,
        "archive-volume": archive_volume,
        "archive-installation": archive_installation,
        "compress-images": compress_images,
        "manifest": manifest,
        "verify": verify,
        "restore-installation": restore_installation,
        "restore-volume": restore_volume,
        "finish-restore": finish_restore,
    }
    if args.command not in commands:
        fail("Unknown backup helper command")
    commands[args.command](*args.arguments)


if __name__ == "__main__":
    try:
        main()
    except (
        ValueError,
        OSError,
        tarfile.TarError,
        KeyError,
        TypeError,
        json.JSONDecodeError,
    ) as error:
        print(f"Backup operation failed: {error}", file=sys.stderr)
        sys.exit(1)
