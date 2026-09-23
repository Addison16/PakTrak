"""Deck token checklist derived only from the locally cached card catalog."""

import json
import uuid

from sqlalchemy import select

from scanner.models import Printing


def linked_tokens(printing):
    parts = printing.source_json.get("all_parts") or []
    if not isinstance(parts, list):
        return {}
    result = {}
    for part in parts:
        if not isinstance(part, dict):
            continue
        emblem = str(part.get("type_line", "")).startswith("Emblem")
        if part.get("component") != "token" and not emblem:
            continue
        try:
            identifier = uuid.UUID(str(part.get("id")))
        except ValueError:
            continue
        if identifier != printing.id:
            result[identifier] = part
    return result


def token_identity(card):
    if card.oracle_id:
        return "oracle:" + str(card.oracle_id)
    raw = card.source_json
    faces = raw.get("card_faces") or [raw]
    # No name-only merging: two Soldier tokens may have different colors,
    # power/toughness or abilities. Missing metadata keeps editions separate.
    if not all(
        all(key in face for key in ("name", "type_line", "colors", "oracle_text"))
        and isinstance(face["colors"], list)
        and (
            "Creature" not in face["type_line"]
            or all(face.get(key) is not None for key in ("power", "toughness"))
        )
        for face in faces
    ):
        return "printing:" + str(card.id)
    fields = (
        "name",
        "type_line",
        "colors",
        "oracle_text",
        "power",
        "toughness",
        "loyalty",
        "defense",
    )
    values = [{key: face.get(key) for key in fields} for face in faces]
    for value in values:
        value["colors"] = sorted(value["colors"] or [])
        for key in fields:
            if isinstance(value[key], str):
                value[key] = " ".join(value[key].split()).casefold()
    return "characteristics:" + json.dumps(values, sort_keys=True)


def token_item(card, part, source_id, token_id):
    from scanner.card_images import source_image

    raw = card.source_json if card else {}
    name = card.name if card else str(part.get("name") or "Unknown token")[:255]
    faces = []
    for index, face in enumerate((raw.get("card_faces") or [raw])[:2]):
        image = f"/api/v1/card-images/related/{source_id}/{token_id}/{index}/"
        faces.append(
            {
                "name": face.get("name") or name,
                "type_line": face.get("type_line") or part.get("type_line") or "Token",
                "colors": face.get("colors"),
                "power": face.get("power"),
                "toughness": face.get("toughness"),
                "oracle_text": face.get("oracle_text", ""),
                "image_url": image + "grid" if card and source_image(card, index, "grid") else None,
                "detail_image_url": image + "detail"
                if card and source_image(card, index, "detail")
                else None,
            }
        )
    return {
        "id": str(token_id),
        "name": name,
        "kind": "emblem"
        if raw.get("layout") == "emblem" or faces[0]["type_line"].startswith("Emblem")
        else "token",
        "details_available": card is not None,
        "faces": faces,
        "sources": [],
    }


def token_report(db, rows):
    links = {}
    sources = {}
    for choice, printing in rows:
        if choice.quantity <= 0:
            continue
        sources.setdefault(
            printing.id, {"printing_id": str(printing.id), "name": printing.name, "sections": set()}
        )["sections"].add(choice.section)
        for token_id, part in linked_tokens(printing).items():
            entry = links.setdefault(token_id, {"part": part, "sources": set()})
            entry["sources"].add(printing.id)
    tokens = (
        {card.id: card for card in db.scalars(select(Printing).where(Printing.id.in_(links)))}
        if links
        else {}
    )
    grouped = {}
    # Prefer an English linked illustration, then use a stable order across reads.
    for token_id, link in sorted(
        links.items(),
        key=lambda item: (
            tokens[item[0]].language != "en" if item[0] in tokens else True,
            str(item[0]),
        ),
    ):
        card = tokens.get(token_id)
        identity = token_identity(card) if card else "printing:" + str(token_id)
        source_id = min(link["sources"], key=str)
        if identity not in grouped:
            grouped[identity] = {
                "item": token_item(card, link["part"], source_id, token_id),
                "sources": set(),
            }
        grouped[identity]["sources"].update(link["sources"])
    items = []
    for group in grouped.values():
        item = group["item"]
        item["sources"] = [
            {**sources[source_id], "sections": sorted(sources[source_id]["sections"])}
            for source_id in sorted(
                group["sources"], key=lambda value: (sources[value]["name"].casefold(), str(value))
            )
        ]
        item["sideboard_only"] = all(
            source["sections"] == ["sideboard"] for source in item["sources"]
        )
        items.append(item)
    items.sort(key=lambda item: (item["sideboard_only"], item["name"].casefold(), item["id"]))
    return {"items": items, "missing_details": sum(not item["details_available"] for item in items)}
