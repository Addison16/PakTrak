import io
import subprocess
import time
import uuid

import cv2
import numpy as np
import pytest
from conftest import accept, upload
from PIL import Image
from test_collections import geometry_photo, key

from scanner import detection, recognition, storage
from scanner.db import session_factory
from scanner.image_enhancement import prepare_text, remaining_timeout
from scanner.models import AccountPolicy, Scan, User
from scanner.worker import process_job


@pytest.fixture
def scan_settings(clients):
    admin, _ = clients(role="admin")
    with session_factory()() as db:
        policy = db.get(AccountPolicy, 1)
        original = (policy.guest_signup_enabled, policy.enhanced_scanning_enabled, policy.version)

    def set_enabled(enabled):
        current = admin.get("/api/auth/settings").json()
        response = admin.post(
            "/api/auth/settings",
            json={"expected_version": current["version"], "enhanced_scanning_enabled": enabled},
        )
        assert response.status_code == 200, response.text
        return response.json()

    yield admin, set_enabled
    with session_factory()() as db, db.begin():
        policy = db.get(AccountPolicy, 1)
        policy.guest_signup_enabled, policy.enhanced_scanning_enabled, policy.version = original


def test_enhancement_setting_is_admin_only_versioned_persistent_and_independent(
    clients, scan_settings
):
    admin, enable = scan_settings
    initial = admin.get("/api/auth/settings").json()
    assert initial["enhanced_scanning_enabled"] is False
    data = {"enhanced_scanning_enabled": True, "expected_version": initial["version"]}
    for role in ("guest", "member"):
        client, _ = clients(role=role)
        assert client.get("/api/auth/settings").status_code == 403
        assert client.post("/api/auth/settings", json=data).status_code == 403
    saved = enable(True)
    assert saved["guest_signup_enabled"] == initial["guest_signup_enabled"]
    assert saved["enhanced_scanning_enabled"] is True
    assert admin.post("/api/auth/settings", json=data).status_code == 409
    # Older clients changing guest signup must preserve the independent scan setting.
    changed = admin.post(
        "/api/auth/settings",
        json={
            "guest_signup_enabled": not initial["guest_signup_enabled"],
            "expected_version": saved["version"],
        },
    )
    assert changed.status_code == 200
    assert changed.json()["enhanced_scanning_enabled"] is True
    another_admin, _ = clients(role="admin")
    assert another_admin.get("/api/auth/settings").json() == changed.json()
    assert enable(False)["enhanced_scanning_enabled"] is False
    for update in (
        {},
        {"enhanced_scanning_enabled": None},
        {"enhanced_scanning_enabled": "true"},
        {"enhanced_scanning_enabled": 1},
    ):
        current = admin.get("/api/auth/settings").json()
        assert (
            admin.post(
                "/api/auth/settings", json={"expected_version": current["version"], **update}
            ).status_code
            == 422
        )
        assert admin.get("/api/auth/settings").json() == current


def suggestion(identifier="standard", score=0.84, visual=10, **overrides):
    return {
        "status": "MATCHED",
        "version": "fixture",
        "candidates": [
            {
                "printing_id": identifier,
                "match_score": score,
                "visual_inliers": visual,
                "name_score": 1,
                "identifiers_agree": False,
                **overrides,
            }
        ],
        "rotation": 180,
    }


@pytest.mark.parametrize(
    "scenario",
    [
        "disabled",
        "strong",
        "improved",
        "weaker",
        "conflicting",
        "verified_alternative",
        "new_match",
        "timeout",
        "processing_error",
    ],
)
def test_optional_recognition_preserves_normal_matches_and_bounded_fallback(monkeypatch, scenario):
    standard = suggestion()
    alternative = suggestion(score=0.93)
    if scenario == "strong":
        standard = suggestion(score=0.97, identifiers_agree=True)
    if scenario == "weaker":
        alternative = suggestion(score=0.75)
    if scenario == "conflicting":
        alternative = suggestion(identifier="different", score=0.99, visual=0)
    if scenario == "verified_alternative":
        alternative = suggestion(identifier="different", score=0.94, visual=16)
    if scenario == "new_match":
        standard = {"status": "NO_MATCH", "candidates": []}
    calls = []
    source_reads = []

    def detailed():
        source_reads.append(True)
        return b"detailed"

    def fake(data, hint, orientation, **options):
        calls.append(options)
        assert hint == "tst" and orientation == 180
        if not options.get("enhance"):
            assert data == b"original"
            return standard
        assert data == b"detailed"
        assert 0 < options["deadline"] - time.monotonic() <= 8
        if scenario == "timeout":
            raise subprocess.TimeoutExpired("tesseract", 3)
        if scenario == "processing_error":
            raise ValueError("Do not log private OCR text")
        return alternative

    monkeypatch.setattr(recognition, "_recognize", fake)
    found = recognition.recognize(
        b"original", "tst", 180, enhanced=scenario != "disabled", enhanced_image=detailed
    )
    assert source_reads == ([] if scenario in {"disabled", "strong"} else [True])
    if scenario == "disabled":
        assert found is standard and len(calls) == 1
    else:
        used = scenario in {"improved", "verified_alternative", "new_match"}
        assert found["candidates"] == (alternative if used else standard)["candidates"]
        assert found["enhancement"]["used"] is used
        assert len(calls) == (1 if scenario == "strong" else 2)
        if scenario in {"timeout", "processing_error"}:
            assert found["enhancement"]["outcome"] == "fallback"


def test_slow_normal_recognition_does_not_spend_worker_deadline_on_extra_work(monkeypatch):
    calls = []
    monkeypatch.setattr(
        recognition, "_recognize", lambda *args, **kwargs: calls.append(kwargs) or suggestion()
    )
    clock = iter([0, 31])
    monkeypatch.setattr(recognition.time, "monotonic", lambda: next(clock))
    result = recognition.recognize(b"data", enhanced=True)
    assert len(calls) == 1
    assert result["enhancement"]["outcome"] == "skipped_time_budget"


def test_extra_ocr_retains_source_pixels_uses_bounded_strips_and_reads_real_text():
    pixels = np.full((1680, 1200, 3), 235, dtype=np.uint8)
    cv2.putText(
        pixels,
        "BRIGHT FALCON",
        (62, 150),
        cv2.FONT_HERSHEY_SIMPLEX,
        2.1,
        (25, 25, 25),
        3,
        cv2.LINE_AA,
    )
    source = Image.fromarray(pixels)
    original = source.tobytes()
    output = prepare_text(source, (27, 32, 540, 92))
    assert output.mode == "L" and output.size == (1563, 204)
    assert output.getpixel((0, 0)) == 255
    assert source.tobytes() == original
    text = recognition.read_text(
        source, (27, 32, 540, 92), enhance=True, deadline=time.monotonic() + 3
    )
    assert recognition.normalized(text) == "brightfalcon"
    with pytest.raises(TimeoutError):
        remaining_timeout(time.monotonic() - 1, 3)
    with pytest.raises(ValueError):
        prepare_text(source, (0, 0, 601, 840))


def test_enhanced_crops_preserve_outlines_and_bound_size():
    photo = geometry_photo()
    original = detection.detect_regions(photo)
    pixels = np.asarray(Image.open(io.BytesIO(photo)).convert("RGB"))
    assert len(original) == 2
    for regular in original:
        detailed = detection.crop_region(pixels, regular["polygon"], scale=2)
        assert Image.open(io.BytesIO(regular["crop"])).size == (600, 840)
        assert Image.open(io.BytesIO(detailed)).size == (1200, 1680)
        assert len(detailed) < 4 * 1024 * 1024


@pytest.mark.parametrize("preparation_fails", [False, True])
def test_worker_reads_setting_between_steps_preserves_upload_and_charges_once(
    clients, scan_settings, monkeypatch, preparation_fails
):
    _, enable = scan_settings
    enable(True)
    client, owner = clients()
    photo = geometry_photo()
    scan_id = upload(client, photo)
    job_id = accept(client, scan_id)["job_id"]
    original_crop = detection.crop_region
    scales = []

    def crop(data, polygon, *, scale=1):
        scales.append(scale)
        if scale == 2 and preparation_fails:
            raise ValueError("Synthetic enhancement failure")
        return original_crop(data, polygon, scale=scale)

    monkeypatch.setattr(detection, "crop_region", crop)
    process_job(job_id)
    assert scales == [1, 1]
    rows = client.get(f"/api/v1/scans/{scan_id}/observations").json()["items"]
    assert len(rows) == 2
    assert Image.open(io.BytesIO(client.get(rows[0]["crop_url"]).content)).size == (600, 840)
    modes = []

    def identify(data, *args, enhance=False, **kwargs):
        modes.append(enhance)
        assert Image.open(io.BytesIO(data)).size == ((1200, 1680) if enhance else (600, 840))
        return {"status": "NO_MATCH", "candidates": []}

    monkeypatch.setattr(recognition, "_recognize", identify)
    enable(False)
    process_job(job_id)
    assert modes == [False] and scales == [1, 1]
    enable(True)
    process_job(job_id)
    assert modes == ([False, False] if preparation_fails else [False, False, True])
    assert scales == [1, 1, 2]
    updated_rows = client.get(f"/api/v1/scans/{scan_id}/observations").json()["items"]
    assert updated_rows[1]["recognition"]["enhancement"]["outcome"] == (
        "fallback" if preparation_fails else "kept_standard"
    )
    assert client.get(f"/api/v1/scans/{scan_id}").json()["job"]["state"] == "SUCCEEDED"
    with session_factory()() as db:
        scan = db.get(Scan, uuid.UUID(scan_id))
        obj = storage.get(scan.source_key)
        try:
            assert obj["Body"].read() == photo
        finally:
            obj["Body"].close()
        assert db.get(User, owner).scan_cards_used == 2
    # Manual outlines retain the unchanged baseline and get extra detail lazily.
    response = client.put(
        f"/api/v1/scans/{scan_id}/observations/{rows[0]['id']}/geometry",
        headers=key(),
        json={"polygon": rows[0]["polygon"], "expected_version": rows[0]["version"] + 1},
    )
    assert response.status_code == 200, response.text
    updated = client.get(f"/api/v1/scans/{scan_id}/observations").json()["items"][0]
    assert Image.open(io.BytesIO(client.get(updated["crop_url"]).content)).size == (600, 840)
    process_job(job_id)
    assert scales[-2:] == [1, 2]
    with session_factory()() as db:
        assert db.get(User, owner).scan_cards_used == 2
