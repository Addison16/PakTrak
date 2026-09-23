import io
import secrets
from datetime import timedelta

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import delete, select

from scanner import storage
from scanner.api import app
from scanner.auth import COOKIE, token_hash
from scanner.db import session_factory
from scanner.models import LoginSession, Scan, User, now
from scanner.settings import get_settings


@pytest.fixture(scope="session", autouse=True)
def isolated_database():
    settings = get_settings()
    assert settings.database_url.get_secret_value().endswith("/scanner_test"), (
        "Tests require a separate test database"
    )
    assert settings.storage_bucket == "scanner-test", "Tests require a separate bucket"
    command.upgrade(Config("alembic.ini"), "head")
    storage.ensure_bucket()


@pytest.fixture
def clients():
    created = []

    def make(role="guest", scan_cards_used=0):
        raw = secrets.token_urlsafe(32)
        csrf = secrets.token_hex(32)
        with session_factory()() as db, db.begin():
            user = User(
                issuer="test",
                subject=secrets.token_hex(16),
                display_name="Test collector",
                role=role,
                scan_cards_used=scan_cards_used,
            )
            db.add(user)
            db.flush()
            db.add(
                LoginSession(
                    owner_id=user.id,
                    token_hash=token_hash(raw),
                    csrf_token=csrf,
                    expires_at=now() + timedelta(hours=1),
                )
            )
            owner_id = user.id
        client = TestClient(app, base_url=get_settings().app_url)
        client.cookies.set(COOKIE, raw)
        client.headers.update({"Origin": get_settings().app_url, "X-CSRF-Token": csrf})
        created.append((client, owner_id))
        return client, owner_id

    yield make
    for client, owner_id in created:
        client.close()
        with session_factory()() as db, db.begin():
            for prefix in (f"imports/{owner_id}/", f"exports/{owner_id}/"):
                for page in (
                    storage.client()
                    .get_paginator("list_objects_v2")
                    .paginate(Bucket=get_settings().storage_bucket, Prefix=prefix)
                ):
                    for obj in page.get("Contents", []):
                        storage.delete(obj["Key"])
            scans = db.scalars(select(Scan).where(Scan.owner_id == owner_id)).all()
            for scan in scans:
                for prefix in (f"originals/{owner_id}/{scan.id}/", f"derived/{scan.id}/"):
                    for page in (
                        storage.client()
                        .get_paginator("list_objects_v2")
                        .paginate(Bucket=get_settings().storage_bucket, Prefix=prefix)
                    ):
                        for obj in page.get("Contents", []):
                            storage.delete(obj["Key"])
            db.execute(delete(User).where(User.id == owner_id))


@pytest.fixture
def photo():
    output = io.BytesIO()
    image = Image.new("RGB", (40, 20), color=(15, 120, 70))
    exif = image.getexif()
    exif[274] = 6
    exif[315] = "Private source metadata"
    image.save(output, "JPEG", exif=exif)
    return output.getvalue()


def create(client, photo, key=None, **overrides):
    body = {"filename": "pack.jpg", "content_type": "image/jpeg", "size": len(photo)}
    body.update(overrides)
    return client.post(
        "/api/v1/scans", json=body, headers={"Idempotency-Key": key or secrets.token_hex(16)}
    )


def upload(client, photo, **kwargs):
    response = create(client, photo, **kwargs)
    assert response.status_code == 201, response.text
    scan_id = response.json()["id"]
    response = client.put(
        f"/api/v1/scans/{scan_id}/upload",
        content=photo,
        headers={"Content-Type": kwargs.get("content_type", "image/jpeg")},
    )
    assert response.status_code == 200, response.text
    return scan_id


def accept(client, scan_id):
    response = client.post(
        f"/api/v1/scans/{scan_id}/finalize", headers={"Idempotency-Key": secrets.token_hex(16)}
    )
    assert response.status_code == 202, response.text
    return response.json()
