import io
import struct
import uuid
from pathlib import Path

import pytest
from conftest import accept, create, upload
from pi_heif import open_heif
from PIL import Image, ImageCms

from scanner import detection, storage
from scanner.db import session_factory
from scanner.models import Job, Scan, User
from scanner.photo_decode import ImageRejected, prepare_photo
from scanner.photo_formats import PHOTO_MIME_TYPES, SIGNATURE_BYTES, sniff_type
from scanner.worker import process_job

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.mark.parametrize(
    "filename,mime",
    [
        ("transport.png", "image/png"),
        ("photos/transport.jpg", "image/pjpeg"),
        ("photos/transport-mpf.jpg", "image/jpeg"),
        ("photos/transport.webp", "image/webp"),
        ("photos/transport.heic", "image/heic"),
        ("photos/transport.heic", "image/heif"),
        ("photos/transport.avif", "image/avif"),
        ("photos/transport.tiff", "image/x-tiff"),
        ("photos/transport.bmp", "image/x-ms-bmp"),
        ("photos/transport.gif", "image/gif"),
    ],
)
def test_photo_formats_survive_client_closure(clients, monkeypatch, filename, mime):
    # Actual codecs, storage, queue receipt and worker; recognition is covered
    # separately, so this fixture cannot manufacture inventory while testing a codec.
    monkeypatch.setattr(detection, "detect_regions", lambda _: [])
    client, owner = clients()
    data = (FIXTURES / filename).read_bytes()
    scan_id = upload(client, data, filename=Path(filename).name, content_type=mime)
    accepted = accept(client, scan_id)
    assert accepted["safe_to_disconnect"]
    client.close()
    process_job(accepted["job_id"])
    process_job(accepted["job_id"])
    with session_factory()() as db:
        scan = db.get(Scan, uuid.UUID(scan_id))
        job = db.get(Job, uuid.UUID(accepted["job_id"]))
        assert job.state == "SUCCEEDED" and job.attempts == 1
        assert (scan.width, scan.height) == (300, 420)
        assert scan.mime_type in PHOTO_MIME_TYPES
        assert db.get(User, owner).scan_cards_used == 0
        for key in (scan.prepared_key, scan.thumbnail_key):
            obj = storage.get(key)
            try:
                image = Image.open(io.BytesIO(obj["Body"].read()))
                assert image.format == "JPEG" and image.mode == "RGB"
                assert image.size == (300, 420)
                assert not image.getexif() and "icc_profile" not in image.info
            finally:
                obj["Body"].close()
        obj = storage.get(scan.source_key)
        try:
            assert obj["Body"].read() == data
        finally:
            obj["Body"].close()


def test_heif_selects_primary_and_applies_rotation_once_without_metadata():
    prepared, thumbnail, width, height = prepare_photo(
        (FIXTURES / "photos/primary-rotated.heic").read_bytes(),
        60_000_000,
    )
    assert (width, height) == (64, 96)
    for data in (prepared, thumbnail):
        image = Image.open(io.BytesIO(data))
        assert not image.getexif() and "icc_profile" not in image.info and "xmp" not in image.info
        for point, expected in (
            ((16, 24), (0, 0, 255)),
            ((48, 24), (255, 0, 0)),
            ((16, 72), (255, 255, 0)),
            ((48, 72), (0, 255, 0)),
        ):
            assert (
                max(abs(a - b) for a, b in zip(image.getpixel(point), expected, strict=True)) < 12
            )


@pytest.mark.parametrize("bits", [10, 12])
def test_high_bit_depth_heif_keeps_midtones(bits):
    assert open_heif(FIXTURES / f"photos/gray-{bits}bit.heif").info["bit_depth"] == bits
    prepared, _, _, _ = prepare_photo(
        (FIXTURES / f"photos/gray-{bits}bit.heif").read_bytes(), 60_000_000
    )
    image = Image.open(io.BytesIO(prepared))
    for x, value in ((16, 64), (48, 128), (80, 255)):
        assert all(abs(channel - value) < 5 for channel in image.getpixel((x, 32)))


def encoded(image, codec, **kwargs):
    output = io.BytesIO()
    image.save(output, codec, **kwargs)
    return output.getvalue()


def test_camera_jpeg_with_auxiliary_image_uses_primary_and_preserves_orientation():
    primary = Image.new("RGB", (96, 64), "red")
    primary.paste("blue", (48, 0, 96, 64))
    exif = Image.Exif()
    exif[274] = 6
    exif[315] = "SYNTHETIC PRIVATE METADATA"
    data = encoded(
        primary,
        "MPO",
        save_all=True,
        append_images=[Image.new("RGB", (24, 16), "magenta")],
        exif=exif,
        icc_profile=ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes(),
        quality=95,
    )
    assert sniff_type(data[:SIGNATURE_BYTES]) == "image/jpeg"
    with Image.open(io.BytesIO(data)) as source:
        assert source.format == "MPO" and source.n_frames == 2
    prepared, thumbnail, width, height = prepare_photo(data, 60_000_000)
    assert (width, height) == (64, 96)
    for result in (prepared, thumbnail):
        with Image.open(io.BytesIO(result)) as image:
            assert image.format == "JPEG" and getattr(image, "n_frames", 1) == 1
            assert image.size == (64, 96)
            assert not image.getexif()
            assert not {"icc_profile", "xmp", "mp"}.intersection(image.info)
            for point, color in (((32, 24), (255, 0, 0)), ((32, 72), (0, 0, 255))):
                assert (
                    max(abs(a - b) for a, b in zip(image.getpixel(point), color, strict=True)) < 8
                )


def test_16_bit_tiff_is_scaled_and_transparent_images_have_white_backgrounds():
    gray = Image.frombytes("I;16", (32, 32), struct.pack("<H", 32768) * 1024)
    prepared, _, _, _ = prepare_photo(encoded(gray, "TIFF"), 60_000_000)
    assert Image.open(io.BytesIO(prepared)).getpixel((16, 16)) == (128, 128, 128)
    for codec in ("PNG", "WEBP", "TIFF"):
        transparent = Image.new("RGBA", (32, 32), (0, 0, 0, 0))
        prepared, _, _, _ = prepare_photo(encoded(transparent, codec), 60_000_000)
        assert Image.open(io.BytesIO(prepared)).getpixel((16, 16)) == (255, 255, 255)


def test_embedded_color_profile_is_applied_before_metadata_removal():
    # An actual non-RGB profile: interpreting these LAB bytes directly as RGB
    # would produce a very different color. Compare to LittleCMS' managed output.
    lab = Image.new("LAB", (32, 32), (160, 155, 90))
    profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("LAB"))
    srgb = ImageCms.createProfile("sRGB")
    reference = ImageCms.profileToProfile(lab, profile, srgb, outputMode="RGB").getpixel((16, 16))
    prepared, _, _, _ = prepare_photo(
        encoded(lab, "TIFF", icc_profile=profile.tobytes()), 60_000_000
    )
    image = Image.open(io.BytesIO(prepared))
    assert max(abs(a - b) for a, b in zip(image.getpixel((16, 16)), reference, strict=True)) < 5
    assert "icc_profile" not in image.info
    with pytest.raises(ImageRejected, match="color profile"):
        prepare_photo(
            encoded(Image.new("RGB", (32, 32)), "PNG", icc_profile=b"broken profile"), 60_000_000
        )


@pytest.mark.parametrize("codec", ["GIF", "PNG", "WEBP", "TIFF", "AVIF"])
def test_animation_and_multiple_tiff_pages_are_not_silently_dropped(codec):
    first, second = Image.new("RGB", (32, 32), "red"), Image.new("RGB", (32, 32), "blue")
    data = encoded(first, codec, save_all=True, append_images=[second])
    with pytest.raises(ImageRejected):
        prepare_photo(data, 60_000_000)


def test_dng_disguised_as_tiff_requires_developing_first():
    data = encoded(Image.new("RGB", (32, 32)), "TIFF", tiffinfo={50706: b"\x01\x04\x00\x00"})
    with pytest.raises(ImageRejected, match="RAW/DNG"):
        prepare_photo(data, 60_000_000)


@pytest.mark.parametrize(
    "filename",
    [
        "transport.heic",
        "transport.avif",
        "transport.tiff",
        "transport.bmp",
        "transport.gif",
        "transport-mpf.jpg",
    ],
)
def test_pixel_limit_applies_to_new_formats(filename):
    with pytest.raises(ImageRejected, match="too many pixels"):
        prepare_photo((FIXTURES / "photos" / filename).read_bytes(), 10_000)
    Image.MAX_IMAGE_PIXELS = 60_000_000


def ftyp(major, *compatible, minor=b"\0\0\0\0"):
    return (
        struct.pack(">I", 16 + 4 * len(compatible)) + b"ftyp" + major + minor + b"".join(compatible)
    )


def test_container_brands_are_bounded_and_do_not_accept_video_or_sequences():
    assert sniff_type(ftyp(b"mif1", b"avif", b"miaf")) == "image/avif"
    assert sniff_type(ftyp(b"mif1", b"heic", minor=b"avif")) == "image/heif"
    assert sniff_type(ftyp(b"heix", b"mif1")) == "image/heif"
    for header in (
        ftyp(b"isom", b"heic"),
        ftyp(b"qt  ", b"mif1"),
        ftyp(b"avif", b"avis"),
        ftyp(b"heic", b"msf1"),
        ftyp(b"hevc", b"mif1"),
        ftyp(b"mif1", b"heic")[:-1],
        struct.pack(">I", SIGNATURE_BYTES + 4) + b"ftypheic",
        b"\0\0\0\x01ftypheic",
        b"\0\0\0\0ftypheic",
    ):
        assert sniff_type(header) is None


@pytest.mark.parametrize("extension,mime", [("heic", "image/heif"), ("avif", "image/avif")])
def test_generic_mif1_containers_route_to_their_actual_codec(extension, mime):
    data = (FIXTURES / f"photos/transport.{extension}").read_bytes()
    data = data[:8] + b"mif1" + data[12:]
    assert sniff_type(data[:SIGNATURE_BYTES]) == mime
    prepared, _, width, height = prepare_photo(data, 60_000_000)
    assert (width, height) == (300, 420)
    assert Image.open(io.BytesIO(prepared)).format == "JPEG"


def test_mislabeled_heic_rejects_avif_and_unsupported_inputs(clients):
    client, _ = clients()
    data = (FIXTURES / "photos/transport.avif").read_bytes()
    scan = create(client, data, filename="photo.heic", content_type="image/heic").json()
    response = client.put(
        f"/api/v1/scans/{scan['id']}/upload", content=data, headers={"Content-Type": "image/heif"}
    )
    assert response.status_code == 415
    for mime in (
        "image/svg+xml",
        "application/pdf",
        "video/quicktime",
        "image/heic-sequence",
        "image/x-adobe-dng",
        "application/octet-stream",
    ):
        assert create(client, data, content_type=mime).status_code == 422


def test_damaged_heic_fails_durably_after_acceptance(clients):
    client, owner = clients()
    data = ftyp(b"heic", b"mif1") + b"damaged synthetic photo"
    scan_id = upload(client, data, filename="damaged.heic", content_type="image/heic")
    result = accept(client, scan_id)
    client.close()
    process_job(result["job_id"])
    with session_factory()() as db:
        job = db.get(Job, uuid.UUID(result["job_id"]))
        scan = db.get(Scan, uuid.UUID(scan_id))
        assert job.state == "FAILED" and job.error_code == "INVALID_IMAGE"
        assert job.error_message and scan.prepared_key is None
        assert db.get(User, owner).scan_cards_used == 0


def test_capabilities_include_the_formats_the_worker_can_decode(clients):
    client, _ = clients()
    data = client.get("/api/v1/capabilities").json()
    assert set(data["formats"]) == {
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/heif",
        "image/avif",
        "image/tiff",
        "image/bmp",
        "image/gif",
    }
    assert data["max_decoded_pixels"] == 60_000_000
