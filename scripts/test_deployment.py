"""Docker-free regression checks for release selection and deployment failure gates."""

import importlib.util
import io
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("paktrak_release", ROOT / "scripts/release.py")
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "scripts").mkdir()
        for name in ("start.sh", "update.sh", "setup.sh", "setup.py", "release.py"):
            shutil.copy(ROOT / "scripts" / name, self.root / "scripts" / name)
        self.config = self.root / ".env"
        self.original = "APP_URL=https://example.invalid\nSESSION_SECRET=fixture-secret\nPASSWORD_RESET_CLIENT_SECRET=fixture-reset-secret\n"
        self.config.write_text(self.original)
        self.log = self.root / "commands.log"
        binary = self.root / "bin"
        binary.mkdir()
        stub = """#!/bin/sh
set -eu
printf '%s %s\\n' "$(basename "$0")" "$*" >> "$DEPLOY_TEST_LOG"
if [ -n "${DEPLOY_TEST_FAIL:-}" ]; then
  case "$*" in *"$DEPLOY_TEST_FAIL"*) exit 1;; esac
fi
case "$*" in
  *'/release.py resolve'*) printf '%s\\n' 'v0.1.0';;
  *'config --images api'*) printf '%s\\n' 'postgres:fixture' 'ghcr.io/addison16/paktrak-backend:latest';;
  *'config --images web'*) printf '%s\\n' 'postgres:fixture' 'ghcr.io/addison16/paktrak-backend:latest' 'ghcr.io/addison16/paktrak-web:latest';;
esac
"""
        for name in ("docker", "git"):
            path = binary / name
            path.write_text(stub)
            path.chmod(0o755)
        self.environment = {
            **os.environ,
            "PATH": str(binary) + os.pathsep + os.environ["PATH"],
            "DEPLOY_TEST_LOG": str(self.log),
        }

    def run_script(self, name, *args, fail=""):
        return subprocess.run(
            ["sh", str(self.root / "scripts" / name), *args],
            env={**self.environment, "DEPLOY_TEST_FAIL": fail},
            capture_output=True,
            text=True,
        )

    def commands(self):
        return self.log.read_text().splitlines() if self.log.exists() else []

    def test_failed_pull_does_not_interrupt_running_services(self):
        result = self.run_script("start.sh", fail="compose -f compose.yaml pull")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(" stop " in line or " up " in line for line in self.commands()))

    def test_failed_migration_blocks_application_start_and_nginx_reload(self):
        result = self.run_script("start.sh", fail="--exit-code-from migrate")
        self.assertNotEqual(result.returncode, 0)
        commands = "\n".join(self.commands())
        self.assertIn("stop --timeout 90 web api worker", commands)
        self.assertNotIn("--wait-timeout 180 api", commands)
        self.assertNotIn("nginx -s reload", commands)

    def test_start_orders_pull_stop_migration_health_checks_and_nginx_reload(self):
        result = self.run_script("start.sh")
        self.assertEqual(result.returncode, 0, result.stderr)
        commands = self.commands()
        fragments = ["compose.yaml pull", "stop --timeout", "restart identity", "--exit-code-from migrate", "--wait-timeout 180 api", "--wait-timeout 60 web", "nginx -t", "nginx -s reload"]
        positions = [next(i for i, line in enumerate(commands) if part in line) for part in fragments]
        self.assertEqual(positions, sorted(positions))
        self.assertNotIn(" build ", "\n".join(commands))
        self.assertNotIn("--volumes", "\n".join(commands))
        self.assertEqual(self.config.read_text(), self.original)

    def test_local_build_fallback_uses_resolved_image_names_and_never_pulls_app(self):
        result = self.run_script("start.sh", "--build", fail="buildx version")
        self.assertEqual(result.returncode, 0, result.stderr)
        commands = "\n".join(self.commands())
        self.assertIn("build --target runtime -t ghcr.io/addison16/paktrak-backend:latest", commands)
        self.assertIn("build -t ghcr.io/addison16/paktrak-web:latest", commands)
        self.assertIn("pull database broker storage identity", commands)
        self.assertNotIn("compose.build.yaml pull\n", commands)

    def test_dirty_source_prevents_release_lookup_and_checkout(self):
        result = self.run_script("update.sh", fail="diff --quiet HEAD --")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("source edits", result.stderr)
        self.assertFalse(any(line.startswith("docker ") or "checkout" in line for line in self.commands()))

    def test_failed_release_fetch_does_not_checkout_or_start(self):
        result = self.run_script("update.sh", fail="fetch --no-tags")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any("checkout" in line or "--upgrade" in line for line in self.commands()))

    def test_update_checks_out_release_and_pins_matching_images(self):
        result = self.run_script("update.sh", "--version", "v0.1.0")
        self.assertEqual(result.returncode, 0, result.stderr)
        commands = self.commands()
        fragments = ["/release.py resolve v0.1.0", "fetch --no-tags origin refs/tags/v0.1.0", "checkout --detach FETCH_HEAD", "--upgrade --image-version 0.1.0", "compose.yaml pull"]
        positions = [next(i for i, line in enumerate(commands) if part in line) for part in fragments]
        self.assertEqual(positions, sorted(positions))
        self.assertFalse((self.root / ".paktrak-update.lock").exists())

    def test_concurrent_update_refused_without_docker_or_checkout(self):
        (self.root / ".paktrak-update.lock").mkdir()
        result = self.run_script("update.sh")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(line.startswith("docker ") or "checkout" in line for line in self.commands()))

    def test_pinning_image_version_preserves_secrets_and_file_permissions(self):
        args = [sys.executable, str(ROOT / "scripts/setup.py"), "--upgrade", "--image-version", "0.1.0"]
        result = subprocess.run(args, cwd=self.root, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.config.read_text(), self.original + "PAKTRAK_VERSION=0.1.0\n")
        self.assertEqual(stat.S_IMODE(self.config.stat().st_mode), 0o600)
        args[-1] = "0.2.0"
        result = subprocess.run(args, cwd=self.root, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.config.read_text(), self.original + "PAKTRAK_VERSION=0.2.0\n")
        self.assertNotIn("fixture-secret", result.stdout + result.stderr)

    def test_invalid_version_does_not_change_configuration(self):
        result = subprocess.run([sys.executable, str(ROOT / "scripts/setup.py"), "--upgrade", "--image-version", "bad\nSESSION_SECRET=changed"], cwd=self.root, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.config.read_text(), self.original)


class ReleaseTests(unittest.TestCase):
    def test_valid_registry_tags_and_prereleases(self):
        for tag in ("v0.1.0", "v12.3.45", "v1.0.0-rc.1"):
            self.assertEqual(release.image_version(tag), tag[1:])

    def test_invalid_or_unsafe_release_tags(self):
        for tag in ("latest", "1.0.0", "v01.0.0", "v1.0.0/path", "v1.0.0\n", "v1.0.0+build", "v1.0.0-" + "x" * 130):
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                release.image_version(tag)

    def lookup(self, data, version=""):
        with patch.object(release, "urlopen", return_value=io.BytesIO(json.dumps(data).encode())):
            return release.resolve_release(version)

    def test_latest_requires_a_published_stable_release(self):
        data = {"tag_name": "v0.1.0", "draft": False, "prerelease": False, "published_at": "2026-10-04T00:00:00Z"}
        self.assertEqual(self.lookup(data), "v0.1.0")
        for changes in ({"draft": True}, {"published_at": None}, {"prerelease": True}, {"tag_name": "v1.0.0-rc.1"}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.lookup({**data, **changes})

    def test_explicit_prerelease_allowed_but_mismatched_response_refused(self):
        data = {"tag_name": "v1.0.0-rc.1", "draft": False, "prerelease": True, "published_at": "2026-10-04T00:00:00Z"}
        self.assertEqual(self.lookup(data, "1.0.0-rc.1"), "v1.0.0-rc.1")
        with self.assertRaises(ValueError):
            self.lookup(data, "0.1.0")


if __name__ == "__main__":
    unittest.main(verbosity=2)
