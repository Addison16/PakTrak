"""Shared name aliases and collector-number shortcuts for local card searches."""

import json
import re

from sqlalchemy import cast, func, or_
from sqlalchemy.dialects.postgresql import JSONPATH

from scanner.models import Printing

NAME_FIELDS = ("name", "printed_name", "flavor_name")


def card_names(name, source):
    """Keep canonical, localized, alternate-title and individual-face names."""
    names = {name, *name.split(" // ")}
    for part in [source, *(source.get("card_faces") or [])]:
        for field in NAME_FIELDS:
            value = part.get(field)
            if isinstance(value, str) and value.strip():
                names.add(value)
                names.update(value.split(" // "))
    return names


def card_display_name(name, source):
    """Show the title on this printing while retaining its canonical identity."""
    for field in ("flavor_name", "printed_name"):
        if source.get(field):
            return source[field]
    faces = source.get("card_faces") or []
    if faces:
        return (
            " // ".join(
                face.get("flavor_name") or face.get("printed_name") or face.get("name", "")
                for face in faces
            )
            or name
        )
    return name


def _alias_pattern_matches(pattern):
    """Read the saved JSON once, checking only names on the card and every face.

    Keep one row per printing for pagination/counts. A single JSONPath avoids
    repeatedly decompressing large catalog records or a subquery per printing.
    Patterns come only from escaped literal names; JSONPath is a bound parameter.
    """
    paths = [f"@.{field}" for field in NAME_FIELDS[1:]]
    paths += [f"@.card_faces[*].{field}" for field in NAME_FIELDS]
    predicates = [f'{path} like_regex {json.dumps(pattern)} flag "i"' for path in paths]
    return func.jsonb_path_exists(
        Printing.source_json, cast("$ ? (" + " || ".join(predicates) + ")", JSONPATH)
    )


def card_names_in(names):
    names = sorted({name.lower() for name in names})
    pattern = "^(" + "|".join(re.escape(name) for name in names) + ")$"
    return or_(func.lower(Printing.name).in_(names), _alias_pattern_matches(pattern))


def card_name_matches(query, *, exact=False):
    if exact:
        return card_names_in([query])
    return or_(
        Printing.name.icontains(query, autoescape=True),
        _alias_pattern_matches(re.escape(query)),
    )


def split_collector_search(query: str) -> tuple[str, str]:
    """Split a trailing #287 or #123a, preserving the printed number as text."""
    text = query.strip()
    match = re.fullmatch(r"(.*?)\s*#\s*([^\s#]{1,32})", text)
    return (match[1].strip(), match[2]) if match else (text, "")
