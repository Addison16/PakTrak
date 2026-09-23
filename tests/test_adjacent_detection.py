"""Original synthetic cards and shadows; no uploaded photos or catalog art."""

import math

import cv2
import numpy as np
import pytest
from PIL import Image, ImageDraw, ImageFilter
from test_borderless_detection import assert_whole_cards, jpeg


def adjacent_photo(angle=0, gap=16, perspective=False):
    background = (125, 125, 125)
    image = Image.new("RGB", (660, 880), background)
    draw = ImageDraw.Draw(image)
    x, top, width, height = 110, 110, 420, 300
    # A narrow shadow joins neighboring outlines, as on an unevenly lit table.
    # Both actual card boundaries remain visible, including the gap between them.
    draw.rectangle((x - 2, top, x + width + 2, top + height * 2 + gap), fill=(85, 85, 85))
    draw.rectangle((x + 4, top, x + width - 4, top + height * 2 + gap), fill=background)
    polygons = []
    for y in (top, top + height + gap):
        draw.rounded_rectangle((x, y, x + width, y + height), radius=5, fill=(20, 20, 20))
        draw.rectangle((x + 14, y + 14, x + width - 14, y + height - 14), fill=(200, 195, 175))
        draw.rectangle((x + 160, y + 35, x + width - 30, y + height - 30), fill=(45, 100, 140))
        for offset in range(5):
            draw.line(
                (x + 35 + offset * 20, y + 45, x + 35 + offset * 20, y + height - 35),
                fill=(70, 65, 55),
                width=3,
            )
        polygons.append([[x, y], [x + width, y], [x + width, y + height], [x, y + height]])
    polygons = np.array(polygons, dtype=np.float32)
    center = np.array(image.size) / 2
    image = image.rotate(
        angle, resample=Image.Resampling.BICUBIC, expand=True, fillcolor=background
    )
    theta = math.radians(-angle)
    rotation = np.array([[math.cos(theta), -math.sin(theta)], [math.sin(theta), math.cos(theta)]])
    polygons = (polygons - center) @ rotation.T + np.array(image.size) / 2
    if perspective:
        w, h = image.size
        transform = cv2.getPerspectiveTransform(
            np.float32([[0, 0], [w, 0], [w, h], [0, h]]),
            np.float32([[25, 15], [w - 30, 0], [w, h - 30], [0, h - 45]]),
        )
        image = Image.fromarray(
            cv2.warpPerspective(np.asarray(image), transform, image.size, borderValue=background)
        )
        polygons = cv2.perspectiveTransform(polygons.astype(np.float32), transform)
    return jpeg(image.filter(ImageFilter.GaussianBlur(0.5))), polygons / np.array(image.size)


@pytest.mark.parametrize(
    "angle,gap,perspective", [(0, 16, False), (90, 16, False), (7, 28, True), (-12, 8, False)]
)
def test_neighboring_cards_are_separate_whole_crops(angle, gap, perspective):
    assert_whole_cards(*adjacent_photo(angle, gap, perspective))


@pytest.mark.parametrize("angle", [0, 90, 9])
def test_single_card_with_two_large_artwork_panels_stays_one_card(angle):
    image = Image.new("RGB", (720, 940), (125, 125, 125))
    draw = ImageDraw.Draw(image)
    draw.rectangle((130, 150, 550, 750), fill=(20, 20, 20))
    # Landscape panels nearly fill the card, but are inset from its outside
    # corners. A rule based only on two rectangles/area would split this card.
    draw.rectangle((142, 162, 538, 440), fill=(70, 120, 160))
    draw.rectangle((142, 460, 538, 738), fill=(205, 195, 170))
    polygon = np.float32([[[130, 150], [550, 150], [550, 750], [130, 750]]])
    theta = math.radians(-angle)
    rotation = np.array([[math.cos(theta), -math.sin(theta)], [math.sin(theta), math.cos(theta)]])
    center = np.array(image.size) / 2
    image = image.rotate(
        angle, resample=Image.Resampling.BICUBIC, expand=True, fillcolor=(125, 125, 125)
    )
    polygon = (polygon - center) @ rotation.T + np.array(image.size) / 2
    assert_whole_cards(jpeg(image), polygon / np.array(image.size))
