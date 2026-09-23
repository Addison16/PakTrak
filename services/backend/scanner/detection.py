"""Perspective crops of separated cards, including unevenly lit table layouts."""

import io

import cv2
import numpy as np
from PIL import Image

VERSION = "contours-neighbors-v4"


def ordered(points):
    points = np.asarray(points, dtype=np.float32).reshape(4, 2)
    center = points.mean(axis=0)
    order = np.argsort(np.arctan2(points[:, 1] - center[1], points[:, 0] - center[0]))
    points = points[order]
    return np.roll(points, -int(np.argmin(points.sum(axis=1))), axis=0)


def visible_edges(points, color):
    # A hull may bridge a weak/rounded edge, but must not invent a rectangle
    # from scattered noise. Require a color boundary along most of three sides;
    # the fourth may blend into the table or be washed out by glare.
    strong = 0
    positions = np.linspace(0.08, 0.92, 48)[:, None]
    for start, end in zip(points, np.roll(points, -1, axis=0), strict=True):
        tangent = (end - start) / max(1, np.linalg.norm(end - start))
        normal = np.array([-tangent[1], tangent[0]])
        samples = start + (end - start) * positions
        sides = []
        for sign in (-1, 1):
            pixels = np.rint(samples + sign * normal * 4).astype(int)
            sides.append(
                color[
                    np.clip(pixels[:, 1], 0, color.shape[0] - 1),
                    np.clip(pixels[:, 0], 0, color.shape[1] - 1),
                ].astype(np.float32)
            )
        strong += np.median(np.linalg.norm(sides[0] - sides[1], axis=1)) > 8
    return strong >= 3


def separate_neighbors(candidates):
    # Two landscape cards stacked together can have a portrait card's aspect
    # ratio. Area-first suppression must not let that enclosing outline erase
    # both complete cards. Deduplicate edge/threshold proposals first so this
    # check stays small and multiple outlines of one card cannot become a pair.
    proposals = []
    for area, points in sorted(candidates, key=lambda item: -item[0]):
        if not any(
            cv2.intersectConvexConvex(points, other)[0] / area > 0.97 and other_area / area < 1.04
            for other_area, other in proposals
        ):
            proposals.append((area, points))
    result = []
    for area, points in proposals:
        children = [
            (child_area, child)
            for child_area, child in proposals
            if 0.30 < child_area / area < 0.68
            and cv2.intersectConvexConvex(points, child)[0] / child_area > 0.90
        ]
        lengths = np.linalg.norm(points - np.roll(points, -1, axis=0), axis=1)
        corner_tolerance = min((lengths[0] + lengths[2]) / 2, (lengths[1] + lengths[3]) / 2) * 0.04
        enclosing_pair = False
        for index, (first_area, first) in enumerate(children):
            for second_area, second in children[index + 1 :]:
                if min(first_area, second_area) / max(first_area, second_area) < 0.60:
                    continue
                intersection = cv2.intersectConvexConvex(first, second)[0]
                if intersection / min(first_area, second_area) > 0.08:
                    continue
                if (first_area + second_area - intersection) / area < 0.86:
                    continue
                # Artwork/text panels are inset inside a single card. Require
                # the two proposals to reach all four of the enclosing corners,
                # in addition to filling it with two distinct supported quads.
                corners = np.concatenate((first, second))
                distances = np.linalg.norm(points[:, None] - corners[None, :], axis=2)
                if np.all(distances.min(axis=1) < corner_tolerance):
                    enclosing_pair = True
                    break
            if enclosing_pair:
                break
        if not enclosing_pair:
            result.append((area, points))
    return result


def detect_regions(prepared: bytes):
    cv2.setNumThreads(1)
    with Image.open(io.BytesIO(prepared)) as source:
        full = np.asarray(source.convert("RGB"))
    height, width = full.shape[:2]
    scale = min(1.0, 1800 / max(height, width))
    small = cv2.resize(full, (max(1, int(width * scale)), max(1, int(height * scale))))
    color = cv2.GaussianBlur(small, (5, 5), 0)
    gray = cv2.cvtColor(small, cv2.COLOR_RGB2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blurred, 40, 140)
    edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    # Full-art edges can change color without a strong grayscale boundary.
    # Multi-channel Canny retains those transitions at a lower threshold while
    # smoothing sensor noise; the same geometry/overlap checks still apply.
    color_edges = cv2.Canny(color, 20, 60)
    color_edges = cv2.morphologyEx(color_edges, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    soft_edges = cv2.Canny(color, 12, 36)
    soft_edges = cv2.morphologyEx(soft_edges, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    _, threshold = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    candidates = []
    frame_area = small.shape[0] * small.shape[1]
    # A global threshold loses entire borders under glare or a lighting gradient.
    # Independent local scales recover those edges without inventing a pack count.
    masks = [(edges, False), (color_edges, True), (soft_edges, True), (threshold, False)]
    for block in (31, 71, 151):
        masks.append(
            (
                cv2.adaptiveThreshold(
                    blurred,
                    255,
                    cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                    cv2.THRESH_BINARY_INV,
                    block,
                    6,
                ),
                False,
            )
        )
    for mask, recover_outer_edge in masks:
        contours, _ = cv2.findContours(mask, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        if recover_outer_edge:
            # Artwork can join the outline and make the contour concave. Keep
            # both proposals, but do not bridge large empty/wood-grain gaps.
            recovered = []
            for contour in contours:
                area = cv2.contourArea(contour)
                if area <= frame_area * 0.001:
                    continue
                hull = cv2.convexHull(contour)
                if area >= 0.65 * cv2.contourArea(hull):
                    recovered.append(hull)
            contours = list(contours) + recovered
        for contour in contours:
            area = cv2.contourArea(contour)
            if area < max(200, frame_area * 0.0025) or area > frame_area * 0.94:
                continue
            polygon = cv2.approxPolyDP(contour, 0.025 * cv2.arcLength(contour, True), True)
            if len(polygon) != 4 or not cv2.isContourConvex(polygon):
                continue
            points = ordered(polygon)
            lengths = np.linalg.norm(points - np.roll(points, -1, axis=0), axis=1)
            short, long = sorted([(lengths[0] + lengths[2]) / 2, (lengths[1] + lengths[3]) / 2])
            if long == 0 or not 0.55 < short / long < 0.86 or short < 24:
                continue
            if (
                points[:, 0].min() < 2
                or points[:, 1].min() < 2
                or points[:, 0].max() >= small.shape[1] - 2
                or points[:, 1].max() >= small.shape[0] - 2
            ):
                continue
            if not visible_edges(points, color):
                continue
            candidates.append((cv2.contourArea(points), points))
    chosen = []
    for area, points in separate_neighbors(candidates):
        if any(
            cv2.intersectConvexConvex(points, other)[0] / min(area, other_area) > 0.65
            for other_area, other in chosen
        ):
            continue
        chosen.append((area, points))
        if len(chosen) >= 32:
            break
    chosen.sort(
        key=lambda item: (round(float(item[1][:, 1].mean()) / 80), float(item[1][:, 0].mean()))
    )
    regions = []
    for _, points in chosen:
        normalized = points / np.array([small.shape[1], small.shape[0]], dtype=np.float32)
        regions.append(
            {
                "polygon": normalized.tolist(),
                "crop": crop_region(full, normalized),
            }
        )
    return regions


def crop_region(full, normalized, *, scale=1):
    # Manual outlines may start at any corner and go in either direction.
    # Establish the same image-space winding/start as automatically found cards.
    if scale not in (1, 2):
        raise ValueError("Card crops support only standard or enhanced resolution.")
    width, height = 600 * scale, 840 * scale
    points = ordered(
        np.asarray(normalized, dtype=np.float32)
        * np.array([full.shape[1], full.shape[0]], dtype=np.float32)
    )
    if np.linalg.norm(points[1] - points[0]) > np.linalg.norm(points[2] - points[1]):
        points = np.roll(points, -1, axis=0)
    transform = cv2.getPerspectiveTransform(
        points,
        np.array(
            [[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]], dtype=np.float32
        ),
    )
    crop = cv2.warpPerspective(full, transform, (width, height))
    output = io.BytesIO()
    Image.fromarray(crop).save(output, "JPEG", quality=95 if scale == 2 else 90)
    return output.getvalue()


def polygon_valid(polygon):
    try:
        points = np.asarray(polygon, dtype=np.float32)
    except (ValueError, TypeError):
        return False
    if points.shape != (4, 2) or not np.isfinite(points).all():
        return False
    if points.min() < 0 or points.max() > 1:
        return False
    return bool(cv2.isContourConvex(points) and 0.001 < cv2.contourArea(points) < 0.98)


def overlap(first, second):
    # OpenCV's intersection tolerances are absolute. Nearly coincident edges in
    # a unit square can report half the true intersection; work in pixel scale.
    a, b = ordered(first) * 4096, ordered(second) * 4096
    return cv2.intersectConvexConvex(a, b)[0] / max(
        0.000001, min(cv2.contourArea(a), cv2.contourArea(b))
    )
