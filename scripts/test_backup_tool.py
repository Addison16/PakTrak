"""Isolated archive extraction regressions; run in the pinned Python helper image."""

import io
import json
import os
import stat
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import backup_tool
from backup_tool import extract, validate_archive


def member(name, kind=tarfile.REGTYPE, link="", mode=0o640):
    value = tarfile.TarInfo(name)
    value.type = kind
    value.linkname = link
    value.uid, value.gid = 1234, 1235
    value.mode = mode
    value.mtime = 1234567
    return value


def archive(path, members):
    with tarfile.open(path, "w:gz") as output:
        for item, content in members:
            if content is not None:
                item.size = len(content)
            output.addfile(item, io.BytesIO(content) if content is not None else None)


class BackupExtractionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="paktrak-extraction-check-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.destination = self.root / "restored"
        self.destination.mkdir()
        self.archive = self.root / "backup.tar.gz"

    def test_composed_symlink_escape_is_refused_before_any_outside_write(self):
        archive(
            self.archive,
            [
                (member("deep", tarfile.DIRTYPE), None),
                (member("b", tarfile.SYMTYPE, "."), None),
                (member("link", tarfile.SYMTYPE, "b/deep/../.."), None),
                (member("link/witness.txt"), b"must remain inside the restore"),
            ],
        )
        # Every path and link is lexically contained. Only resolving the links
        # already extracted exposes that b/deep/../.. points to the parent.
        validate_archive(self.archive)
        with self.assertRaises(tarfile.LinkOutsideDestinationError):
            extract(self.archive, self.destination)
        self.assertFalse((self.root / "witness.txt").exists())
        self.assertFalse((self.destination / "link").is_symlink())

    def test_file_ownership_permissions_and_internal_links_are_preserved(self):
        archive(
            self.archive,
            [
                (member("filer", tarfile.DIRTYPE, mode=0o750), None),
                (member("filer/deep", tarfile.DIRTYPE, mode=0o750), None),
                (member("filer/photo", mode=0o660), b"photo witness"),
                (member("photo-link", tarfile.SYMTYPE, "filer/photo"), None),
                (member("photo-hardlink", tarfile.LNKTYPE, "filer/photo", mode=0o660), None),
                (member("shortcut", tarfile.SYMTYPE, "filer/deep"), None),
                (member("nested", tarfile.SYMTYPE, "shortcut/.."), None),
            ],
        )
        validate_archive(self.archive)
        extract(self.archive, self.destination)
        photo = self.destination / "filer/photo"
        self.assertEqual(photo.read_bytes(), b"photo witness")
        self.assertEqual((self.destination / "photo-link").read_bytes(), b"photo witness")
        self.assertEqual((self.destination / "nested/photo").read_bytes(), b"photo witness")
        self.assertEqual(os.readlink(self.destination / "nested"), "shortcut/..")
        self.assertEqual(photo.stat().st_ino, (self.destination / "photo-hardlink").stat().st_ino)
        self.assertEqual(stat.S_IMODE(photo.stat().st_mode), 0o660)
        self.assertEqual(stat.S_IMODE((self.destination / "filer").stat().st_mode), 0o750)
        self.assertEqual(photo.stat().st_mtime, 1234567)
        if os.geteuid() == 0:
            self.assertEqual((photo.stat().st_uid, photo.stat().st_gid), (1234, 1235))
            directory = (self.destination / "filer").stat()
            self.assertEqual((directory.st_uid, directory.st_gid), (1234, 1235))

    def test_forward_symlink_escape_is_refused_even_without_a_file_using_it(self):
        archive(
            self.archive,
            [
                (member("deep", tarfile.DIRTYPE), None),
                (member("link", tarfile.SYMTYPE, "b/deep/../.."), None),
                (member("b", tarfile.SYMTYPE, "."), None),
            ],
        )
        validate_archive(self.archive)
        with self.assertRaises(tarfile.FilterError):
            extract(self.archive, self.destination)

    def test_forward_symlink_cannot_redirect_a_subsequent_file_outside(self):
        archive(
            self.archive,
            [
                (member("deep", tarfile.DIRTYPE), None),
                (member("link", tarfile.SYMTYPE, "b/deep/../.."), None),
                (member("b", tarfile.SYMTYPE, "."), None),
                (member("link/witness.txt"), b"must remain inside the restore"),
            ],
        )
        validate_archive(self.archive)
        with self.assertRaises(tarfile.FilterError):
            extract(self.archive, self.destination)
        self.assertFalse((self.root / "witness.txt").exists())

    def test_existing_destination_is_never_overwritten(self):
        archive(self.archive, [(member("existing"), b"replacement")])
        existing = self.destination / "existing"
        existing.write_bytes(b"original")
        with self.assertRaisesRegex(ValueError, "not empty"):
            extract(self.archive, self.destination)
        self.assertEqual(existing.read_bytes(), b"original")

    def test_absolute_paths_and_parent_traversal_are_refused(self):
        for name in ("/outside", "../outside", "filer/../../outside"):
            with self.subTest(name=name):
                archive(self.archive, [(member(name), b"outside")])
                with self.assertRaisesRegex(ValueError, "outside its destination"):
                    validate_archive(self.archive)
                with self.assertRaisesRegex(ValueError, "outside its destination"):
                    extract(self.archive, self.destination)
                self.assertEqual(list(self.destination.iterdir()), [])


class BackupPlanTests(unittest.TestCase):
    def plan(self, volumes):
        written = {}
        raw = {"name": "mtg-scanner", "volumes": volumes, "services": {"api": {"image": "x"}}}
        with (
            patch.object(backup_tool.sys, "stdin", io.StringIO(json.dumps(raw))),
            patch.object(backup_tool, "write_json", lambda path, value: written.update(value)),
        ):
            backup_tool.config()
        return written

    def test_rebuilt_theme_volume_is_not_archived(self):
        volumes = {key: {} for key in ("database", "broker", "photos", "identity-theme")}
        plan = self.plan(volumes)
        self.assertEqual(
            sorted(item["key"] for item in plan["volumes"]), ["broker", "database", "photos"]
        )

    def test_unexpected_data_volume_is_still_refused(self):
        volumes = {key: {} for key in ("database", "broker", "photos", "uploads")}
        with self.assertRaisesRegex(ValueError, "Expected exactly"):
            self.plan(volumes)


if __name__ == "__main__":
    unittest.main()
