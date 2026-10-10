"""Bounded CSV and plain-text collection formats."""

import csv
import io
import json
import re
import uuid
from decimal import Decimal, InvalidOperation

from sqlalchemy import select

from scanner.card_search import card_name_matches, card_names
from scanner.models import Printing

MAX_BYTES = 5 * 1024 * 1024
MAX_ROWS = 10_000
CANONICAL = [
    "schema_version",
    "cell_encoding",
    "quantity",
    "scryfall_id",
    "name",
    "set_code",
    "collector_number",
    "language",
    "finish",
    "condition",
    "binder",
    "notes",
    "purchase_price",
    "purchase_currency",
    "misprint",
    "altered",
    "source_metadata_json",
]
ALIASES = {
    "scryfall_id": ["scryfall id"],
    "name": ["name", "card name"],
    "set_code": ["set code", "edition", "edition code"],
    "collector_number": ["collector number", "card number"],
    "quantity": ["quantity", "count"],
    "language": ["language", "lang"],
    "finish": ["finish", "foil", "printing"],
    "condition": ["condition"],
    "binder": ["binder name", "binder", "location", "location name", "folder"],
    "binder_type": ["binder type"],
    "notes": ["notes"],
    "purchase_price": ["purchase price", "my price"],
    "purchase_currency": ["purchase price currency", "purchase currency"],
    "misprint": ["misprint"],
    "altered": ["altered", "alter"],
    "source_metadata_json": ["source_metadata_json"],
}
LANGUAGES = {
    "english": "en",
    "german": "de",
    "french": "fr",
    "italian": "it",
    "spanish": "es",
    "portuguese": "pt",
    "japanese": "ja",
    "korean": "ko",
    "russian": "ru",
    "chinese simplified": "zhs",
    "chinese traditional": "zht",
}
FINISHES = {
    "": "unknown",
    "unknown": "unknown",
    "normal": "nonfoil",
    "nonfoil": "nonfoil",
    "non-foil": "nonfoil",
    "false": "nonfoil",
    "no": "nonfoil",
    "0": "nonfoil",
    "foil": "foil",
    "true": "foil",
    "yes": "foil",
    "1": "foil",
    "etched": "etched",
}
CONDITIONS = {
    "": "ungraded",
    "ungraded": "ungraded",
    "near mint": "NM",
    "lightly played": "LP",
    "moderately played": "MP",
    "heavily played": "HP",
    "damaged": "damaged",
    "nm": "NM",
    "lp": "LP",
    "mp": "MP",
    "hp": "HP",
}


def safe_cell(value):
    value = "" if value is None else str(value)
    # Canonical v1 decodes exactly one prefix; existing apostrophes are doubled.
    risky = (
        value.startswith("'")
        or value.lstrip().startswith(("=", "+", "-", "@"))
        or value.startswith(("\t", "\r", "\n"))
    )
    return "'" + value if risky else value


def read_csv(data, options, max_bytes=MAX_BYTES, max_rows=MAX_ROWS):
    if len(data) > max_bytes:
        raise ValueError(f"CSV exceeds the {max_bytes // (1024 * 1024)} MiB limit.")
    encoding = options.get("encoding", "utf-8-sig")
    try:
        decoded = data.decode(encoding)
    except UnicodeError as exc:
        raise ValueError(
            "Cannot read the selected encoding. Choose UTF-8 or UTF-16 and preview again."
        ) from exc
    if "\x00" in decoded:
        raise ValueError("CSV contains NUL characters; check its encoding.")
    delimiter = options.get("delimiter", "auto")
    if delimiter == "auto":
        try:
            delimiter = csv.Sniffer().sniff(decoded[:16384], delimiters=",;\t").delimiter
        except csv.Error:
            delimiter = ","
    csv.field_size_limit(16_384)
    reader = csv.reader(io.StringIO(decoded, newline=""), delimiter=delimiter, strict=True)
    try:
        headers = next(reader)
        if not 1 <= len(headers) <= 64 or any(
            not name.strip() or len(name) > 255 for name in headers
        ):
            raise ValueError("CSV needs 1–64 nonempty column names (at most 255 characters each).")
        if len({name.strip().casefold() for name in headers}) != len(headers):
            raise ValueError("CSV contains duplicate column names. Rename them before importing.")
        rows = []
        for values in reader:
            if not values or all(not value for value in values):
                continue
            if len(rows) >= max_rows:
                raise ValueError(
                    f"CSV exceeds {max_rows:,} rows. Split the collection into smaller files."
                )
            if len(values) != len(headers):
                raise ValueError(
                    f"CSV record {len(rows) + 2} has a different number of columns from its header."
                )
            rows.append(dict(zip(headers, values, strict=True)))
        if not rows:
            raise ValueError("CSV contains no collection rows.")
        return headers, rows, delimiter
    except (csv.Error, StopIteration) as exc:
        raise ValueError(
            "Malformed or empty CSV. Check quoting, delimiter, and field lengths."
        ) from exc


def infer_mapping(headers, requested_format):
    lower = {name.strip().casefold(): name for name in headers}
    if "schema_version" in lower:
        detected = "canonical"
    else:
        detected = "generic"
    fmt = detected if requested_format == "auto" else requested_format
    mapping = {}
    for field, aliases in ALIASES.items():
        found = [lower[name] for name in dict.fromkeys([field, *aliases]) if name in lower]
        if len(found) == 1:
            mapping[field] = found[0]
    return fmt, mapping


def read_text(data, options):
    if len(data) > MAX_BYTES:
        raise ValueError("Text file exceeds the 5 MiB limit.")
    try:
        decoded = data.decode(options.get("encoding", "utf-8-sig"))
    except UnicodeError as exc:
        raise ValueError("Choose UTF-8 or UTF-16 and preview the file again.") from exc
    if "\x00" in decoded:
        raise ValueError("Text contains NUL characters; check its encoding.")
    headers = [
        "quantity",
        "name",
        "set_code",
        "collector_number",
        "finish",
        "section",
        "source_line",
    ]
    rows, section = [], "main"
    sections = {
        "main": "main",
        "mainboard": "main",
        "deck": "main",
        "sideboard": "sideboard",
        "commander": "commander",
        "commanders": "commander",
        "schemes": "schemes",
        "scheme deck": "schemes",
    }
    for number, original in enumerate(decoded.splitlines(), 1):
        line = original.strip()
        if not line or line.startswith(("#", "//")):
            continue
        if len(line) > 16_384:
            raise ValueError(f"Text line {number} is too long.")
        heading = line.strip("[]:").casefold()
        if heading in sections:
            section = sections[heading]
            continue
        row_section = section
        if line.upper().startswith("SB:"):
            row_section, line = "sideboard", line[3:].strip()
        finish = ""
        marker = re.search(r"\s+\*([FE])\*$", line, re.IGNORECASE)
        if marker:
            finish = "foil" if marker[1].upper() == "F" else "etched"
            line = line[: marker.start()].strip()
        quantity = re.match(r"^(\d+)[xX]?\s+(.+)$", line)
        count, name = (quantity[1], quantity[2]) if quantity else ("1", line)
        match = re.match(r"^(.+?)\s+\(([A-Za-z0-9_]+)\)(?:\s+([^\s]+))?$", name)
        name, set_code, collector = (
            (match[1], match[2], match[3] or "") if match else (name, "", "")
        )
        rows.append(
            dict(
                zip(
                    headers,
                    [count, name, set_code, collector, finish, row_section, str(number)],
                    strict=True,
                )
            )
        )
        if len(rows) > MAX_ROWS:
            raise ValueError("Text file exceeds 10,000 card lines.")
    if not rows:
        raise ValueError("Text file contains no cards.")
    return headers, rows, "auto"


def text_line(values):
    name = values["name"]
    if any(char in name for char in "\r\n\x00"):
        raise ValueError("A card name cannot be represented on one text line.")
    line = f"{values['quantity']} {name}"
    if values.get("set_code"):
        line += f" ({values['set_code'].upper()})"
        if values.get("collector_number"):
            line += " " + values["collector_number"]
    if values.get("finish") in {"foil", "etched"}:
        line += " *F*" if values["finish"] == "foil" else " *E*"
    return line


def bounded_json(value):
    if len(value) > 16_000:
        raise ValueError(
            "Source metadata exceeds 16,000 characters; split or simplify this row's extra fields."
        )
    try:
        metadata = json.loads(value or "{}")
    except (ValueError, RecursionError) as exc:
        raise ValueError("Source metadata must be a JSON object.") from exc
    if not isinstance(metadata, dict):
        raise ValueError("Source metadata must be a JSON object.")

    def depth(node, level=0):
        if level > 8:
            raise ValueError("Source metadata nesting exceeds 8 levels.")
        if isinstance(node, str) and "\x00" in node:
            raise ValueError("Source metadata contains a NUL character.")
        for child in (
            node.values() if isinstance(node, dict) else node if isinstance(node, list) else []
        ):
            depth(child, level + 1)

    depth(metadata)
    return metadata


def boolean(value):
    if not value.strip():
        return None
    choices = {"true": True, "yes": True, "1": True, "false": False, "no": False, "0": False}
    if value.casefold() not in choices:
        raise ValueError("Misprint and altered flags must be true, false, or blank.")
    return choices[value.casefold()]


def normalize(raw, mapping, options, fmt):
    decoded = dict(raw)
    if fmt == "canonical":
        if raw.get("schema_version") != "1" or raw.get("cell_encoding") != "apostrophe-v1":
            raise ValueError("Unsupported canonical CSV version or cell encoding.")
        decoded = {key: value[1:] if value.startswith("'") else value for key, value in raw.items()}
    values = {field: decoded.get(column, "") for field, column in mapping.items()}
    quantity = values.get("quantity", "").strip() or str(options.get("default_quantity", ""))
    if not re.fullmatch(r"[0-9]{1,6}", quantity) or not 1 <= int(quantity) <= 100_000:
        raise ValueError(
            "Quantity must be a positive whole number up to 100,000; approve a default if the column is absent."
        )
    finish = values.get("finish", "").strip().casefold()
    if fmt == "text" and not finish:
        finish = options.get("text_default_finish", "nonfoil")
    condition = values.get("condition", "").strip().casefold().replace("_", " ")
    if finish not in FINISHES or condition not in CONDITIONS:
        raise ValueError("Unsupported finish or condition. Correct this row before adding it.")
    price = values.get("purchase_price", "").strip()
    if price:
        try:
            decimal = Decimal(price)
            if (
                not decimal.is_finite()
                or decimal < 0
                or decimal >= Decimal("1000000000000")
                or decimal.as_tuple().exponent < -4
            ):
                raise InvalidOperation
        except InvalidOperation as exc:
            raise ValueError(
                "Purchase price must be a nonnegative decimal with at most four decimal places."
            ) from exc
        price = str(decimal)
    currency = values.get("purchase_currency", "").strip().upper()
    if currency and not re.fullmatch(r"[A-Z]{3}", currency):
        raise ValueError("Currency must be a three-letter code or blank.")
    if price and not currency:
        raise ValueError("A purchase price requires its currency; it cannot be guessed.")
    language = values.get("language", "").strip().lower() or options.get("default_language", "")
    language = LANGUAGES.get(language, language)
    binder = values.get("binder", "").strip() or options.get(
        "default_binder", "Imported collection"
    )
    notes = values.get("notes", "")
    if len(binder) > 255 or len(notes) > 4096:
        raise ValueError("Binder names are limited to 255 characters; notes to 4,096.")
    metadata = bounded_json(values.get("source_metadata_json", ""))
    extra = {
        key: value
        for key, value in decoded.items()
        if key not in mapping.values() and key not in {"schema_version", "cell_encoding"}
    }
    if extra:
        # Avoid replacing an extension supplied by an earlier canonical export.
        metadata = (
            {"retained_metadata": metadata, "unmapped_columns": extra}
            if metadata
            else {"unmapped_columns": extra}
        )
    bounded_json(json.dumps(metadata))
    return {
        "text_input": fmt == "text",
        "quantity": int(quantity),
        "scryfall_id": values.get("scryfall_id", "").strip(),
        "name": values.get("name", "").strip(),
        "set_code": values.get("set_code", "").strip().lower(),
        "collector_number": values.get("collector_number", "").strip(),
        "language": language,
        "finish": FINISHES[finish],
        "condition": CONDITIONS[condition],
        "binder": binder,
        "notes": notes,
        "purchase_price": price or None,
        "purchase_currency": currency or None,
        "misprint": boolean(values.get("misprint", "").strip()),
        "altered": boolean(values.get("altered", "").strip()),
        "source_metadata": metadata,
        "binder_type": values.get("binder_type", "").strip().casefold(),
    }


def resolve(db, values):
    if values["scryfall_id"]:
        try:
            printing = db.get(Printing, uuid.UUID(values["scryfall_id"]))
        except ValueError:
            return None, "Scryfall ID is not a valid printing UUID."
        if printing is None:
            return (
                None,
                "Printing is absent from the local catalog; load the catalog or choose a printing.",
            )
    else:
        if not values.get("text_input") and (
            not values["language"]
            or not values["set_code"]
            or not (values["collector_number"] or values["name"])
        ):
            return (
                None,
                "Supply a printing ID, or set and language with a name or collector number.",
            )
        if not (values["name"] or (values["set_code"] and values["collector_number"])):
            return None, "Supply a card name or set and collector number."
        query = select(Printing)
        if values["set_code"]:
            query = query.where(Printing.set_code == values["set_code"])
        if values["language"]:
            query = query.where(Printing.language == values["language"])
        if values["collector_number"]:
            query = query.where(Printing.collector_number == values["collector_number"])
        if values["name"]:
            query = query.where(card_name_matches(values["name"], exact=True))
        matches = db.scalars(query.limit(2)).all()
        if len(matches) != 1:
            return (
                None,
                "Printing is ambiguous or absent from the local catalog. Choose the exact printing.",
            )
        printing = matches[0]
    for field in ("set_code", "collector_number", "language"):
        if values[field] and values[field] != getattr(printing, field):
            return (
                None,
                f"{field.replace('_', ' ').capitalize()} conflicts with the supplied printing ID.",
            )
    names = {name.casefold() for name in card_names(printing.name, printing.source_json)}
    if values["name"] and values["name"].casefold() not in names:
        return None, "Card name conflicts with the supplied printing ID."
    if values["finish"] != "unknown" and values["finish"] not in printing.finishes:
        return None, "This finish is not listed for the selected printing."
    values.update(
        scryfall_id=str(printing.id),
        name=printing.name,
        set_code=printing.set_code,
        collector_number=printing.collector_number,
        language=printing.language,
    )
    return printing, None


def canonical_row(lot, printing, binder):
    return {
        "schema_version": "1",
        "cell_encoding": "apostrophe-v1",
        "quantity": lot.quantity_remaining,
        "scryfall_id": str(printing.id),
        "name": printing.name,
        "set_code": printing.set_code,
        "collector_number": printing.collector_number,
        "language": printing.language,
        "finish": lot.finish,
        "condition": lot.condition,
        "binder": binder.name,
        "notes": lot.notes,
        "purchase_price": str(lot.purchase_price) if lot.purchase_price is not None else "",
        "purchase_currency": lot.purchase_currency or "",
        "misprint": "" if lot.misprint is None else str(lot.misprint).lower(),
        "altered": "" if lot.altered is None else str(lot.altered).lower(),
        "source_metadata_json": json.dumps(
            lot.source_metadata, ensure_ascii=False, separators=(",", ":")
        ),
    }


PORTABLE_CSV = {
    "Name": "name",
    "Set Code": "set_code",
    "Collector Number": "collector_number",
    "Scryfall ID": "scryfall_id",
    "Quantity": "quantity",
    "Foil": "finish",
    "Condition": "condition",
    "Language": "language",
    "Purchase Price": "purchase_price",
    "Purchase Price Currency": "purchase_currency",
    "Misprint": "misprint",
    "Altered": "altered",
    "Binder Name": "binder",
    "Notes": "notes",
}
