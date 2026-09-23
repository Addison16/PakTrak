"""Startup can add a credential without rotating or exposing existing secrets."""

import json
import stat
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/setup.py"


def run_setup(directory, *args):
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args], cwd=directory, capture_output=True, text=True
    )


def test_fresh_setup_includes_dedicated_reset_secret_and_authentication_time(tmp_path):
    result = run_setup(tmp_path)
    assert result.returncode == 0
    content = (tmp_path / ".env").read_text()
    values = dict(line.split("=", 1) for line in content.splitlines())
    secret = values["PASSWORD_RESET_CLIENT_SECRET"]
    assert len(secret) >= 32 and secret != values["OIDC_CLIENT_SECRET"]
    assert secret not in result.stdout + result.stderr
    assert stat.S_IMODE((tmp_path / ".env").stat().st_mode) == 0o600
    realm = json.loads((tmp_path / "infra/generated/scanner-realm.json").read_text())
    assert "basic" in realm["clients"][0]["defaultClientScopes"]
    assert realm["passwordPolicy"] == "length(8)"


def test_parallel_upgrades_append_once_and_preserve_every_existing_setting(tmp_path):
    path = tmp_path / ".env"
    old = "APP_URL=https://example.invalid\nKEYCLOAK_ADMIN_PASSWORD=fixture-only-value\n"
    path.write_text(old)
    path.chmod(0o644)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: run_setup(tmp_path, "--upgrade"), range(2)))
    assert all(result.returncode == 0 for result in results)
    updated = path.read_text()
    assert updated.startswith(old) and updated.count("PASSWORD_RESET_CLIENT_SECRET=") == 1
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    value = updated.split("PASSWORD_RESET_CLIENT_SECRET=")[1].strip()
    assert len(value) >= 32
    assert all(value not in result.stdout + result.stderr for result in results)
    assert run_setup(tmp_path, "--upgrade").returncode == 0
    assert path.read_text() == updated


def test_upgrades_do_not_silently_replace_an_explicit_empty_credential(tmp_path):
    path = tmp_path / ".env"
    old = "APP_URL=https://example.invalid\nPASSWORD_RESET_CLIENT_SECRET=\n"
    path.write_text(old)
    result = run_setup(tmp_path, "--upgrade")
    assert result.returncode != 0 and "empty" in result.stderr
    assert path.read_text() == old
