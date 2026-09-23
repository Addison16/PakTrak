"""Original synthetic artwork; no private uploads or catalog images in fixtures."""

import io
import math

import cv2
import numpy as np
import pytest
from PIL import Image, ImageDraw, ImageFilter

from scanner.detection import detect_regions, ordered


def jpeg(image):
    output = io.BytesIO()
    image.save(output, "JPEG", quality=88)
    return output.getvalue()


def borderless_photo(angle=0, seed=0, rows=3, mixed=False, perspective=False):
    background = (118, 118, 118)
    image = Image.new("RGB", (1200, 105 + rows * 465), background)
    draw = ImageDraw.Draw(image)
    polygons = []
    # Full-bleed colors close to the table's grayscale luminance: the boundary
    # is visible in RGB even when the old grayscale detector cannot follow it.
    colors = [(168, 89, 129), (75, 127, 183), (157, 98, 118), (57, 159, 68)]
    for row in range(rows):
        for col in range(3):
            x, y = 70 + col * 380, 70 + row * 465
            bordered = mixed and (row + col) % 2 == 1
            draw.rounded_rectangle(
                (x, y, x + 260, y + 364),
                radius=8,
                fill=(20, 20, 20) if bordered else colors[(row + col + seed) % 4],
            )
            for stripe in range(7):
                draw.rectangle(
                    (x + 8, y + 8 + stripe * 48, x + 252, y + 54 + stripe * 48),
                    fill=colors[(stripe + seed) % 4],
                )
            draw.rectangle((x + 18, y + 20, x + 238, y + 45), fill=(180, 150, 90))
            for line in range(4):
                draw.line(
                    (x + 22, y + 260 + line * 16, x + 210, y + 260 + line * 16),
                    fill=(85, 85, 85),
                    width=2,
                )
            polygons.append([[x, y], [x + 260, y], [x + 260, y + 364], [x, y + 364]])
    polygons = np.array(polygons, dtype=np.float32)
    before_center = np.array(image.size) / 2
    image = image.rotate(
        angle, resample=Image.Resampling.BICUBIC, expand=True, fillcolor=background
    )
    theta = math.radians(-angle)
    rotation = np.array([[math.cos(theta), -math.sin(theta)], [math.sin(theta), math.cos(theta)]])
    polygons = (polygons - before_center) @ rotation.T + np.array(image.size) / 2
    if perspective:
        width, height = image.size
        transform = cv2.getPerspectiveTransform(
            np.float32([[0, 0], [width, 0], [width, height], [0, height]]),
            np.float32([[35, 20], [width - 70, 0], [width, height - 35], [0, height - 90]]),
        )
        image = Image.fromarray(
            cv2.warpPerspective(np.asarray(image), transform, image.size, borderValue=background)
        )
        polygons = cv2.perspectiveTransform(polygons.astype(np.float32), transform)
    image = image.filter(ImageFilter.GaussianBlur(0.5))
    return jpeg(image), polygons / np.array(image.size)


def assert_whole_cards(photo, expected):
    regions = detect_regions(photo)
    assert len(regions) == len(expected)
    remaining = {index for index in range(len(regions))}
    for polygon in expected:
        # IoU protects against art panels, partial crops, and merged neighbors;
        # count or intersection/min-area alone would accept nested rectangles.
        wanted = ordered(polygon) * 4096
        matches = []
        for index in remaining:
            actual = ordered(regions[index]["polygon"]) * 4096
            intersection = cv2.intersectConvexConvex(wanted, actual)[0]
            union = cv2.contourArea(wanted) + cv2.contourArea(actual) - intersection
            if intersection / union > 0.90:
                matches.append(index)
        assert len(matches) == 1, f"No distinct whole-card outline for {polygon.tolist()}"
        remaining.remove(matches[0])
        with Image.open(io.BytesIO(regions[matches[0]]["crop"])) as crop:
            assert crop.size == (600, 840)
    assert not remaining


@pytest.mark.parametrize("angle,seed", [(0, 0), (7, 1), (-12, 2), (90, 3)])
def test_borderless_cards_with_nested_artwork_and_rotated_layouts(angle, seed):
    assert_whole_cards(*borderless_photo(angle, seed))


@pytest.mark.parametrize("perspective", [False, True])
def test_fifteen_mixed_cards_survive_downscaling_and_perspective(perspective):
    assert_whole_cards(*borderless_photo(rows=5, mixed=True, perspective=perspective))


@pytest.mark.parametrize("scene", ["blank", "noise", "shapes", "open_shapes"])
def test_color_edges_do_not_invent_cards_from_empty_tables_or_non_card_shapes(scene):
    image = Image.new("RGB", (1600, 1200), (118, 118, 118))
    if scene == "noise":
        pixels = 118 + np.random.default_rng(41).normal(0, 7, (1200, 1600, 3))
        image = Image.fromarray(np.clip(pixels, 0, 255).astype(np.uint8))
    elif scene == "shapes":
        draw = ImageDraw.Draw(image)
        for x in (60, 500, 950):
            draw.ellipse((x, 150, x + 320, 470), fill=(180, 80, 150))
            draw.polygon([(x, 550), (x + 320, 550), (x + 150, 950)], fill=(75, 127, 183))
    elif scene == "open_shapes":
        draw = ImageDraw.Draw(image)
        # Three high-contrast edges do not justify filling a large concavity.
        for x in (100, 600, 1100):
            draw.rectangle((x, 300, x + 250, 650), fill=(30, 50, 70))
            draw.rectangle((x + 25, 325, x + 250, 625), fill=(118, 118, 118))
    assert detect_regions(jpeg(image)) == []
