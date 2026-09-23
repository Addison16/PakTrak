# Collection transfer formats

Adapter version: **csv-v1**. Canonical schema: **1**, cell encoding **apostrophe-v1**. Last implementation review: September 18, 2026.

## Workflow and guarantees

The phone uploads CSV or plain text to private storage. The server stores the file and preview job before acknowledging acceptance. Parsing, normalization, and catalog resolution run in the transfer worker. No collection entries are created until the collector confirms the saved revision and declares the rows represent owned cards. Valid rows may be added while preserving unresolved rows if the collector explicitly accepts a partial import.

Each source record has a stable row ID. Its lot and audit event commit in the same transaction that marks the row committed. Repeated confirmation and retries cannot duplicate its effect. A repeated file is flagged within the same account; another purchase using the same file needs the explicit additional-copies choice. Legitimate repeated rows are not deduplicated by printing ID.

Undo prevents further additions even if a reversal attempt fails, then removes only the import's own remaining quantities. It reports copies previously removed separately. Raw CSV expiry does not erase normalized rows, unresolved raw fields, or inventory provenance.

## Canonical CSV v1

Every row includes these columns:

```text
schema_version,cell_encoding,quantity,scryfall_id,name,set_code,collector_number,language,finish,condition,binder,notes,purchase_price,purchase_currency,misprint,altered,source_metadata_json
```

| Field | Representation |
| --- | --- |
| `schema_version` / `cell_encoding` | `1` / `apostrophe-v1` on every row. |
| `quantity` | Positive whole number, at most 100,000 per row. Exports contain remaining owned copies. |
| `scryfall_id` | Stable printing UUID; checked against supplied metadata. |
| `collector_number` | String, preserving letters and leading zeros. |
| `language` | Catalog language code. A printing ID may supply it authoritatively. |
| `finish` | `unknown`, `nonfoil`, `foil`, or `etched`; known values must be supported by that printing. |
| `condition` | `ungraded`, `NM`, `LP`, `MP`, `HP`, or `damaged`; a collector assessment. |
| `binder` / `notes` | Unicode strings; 255 / 4,096 characters maximum. |
| `purchase_price` / `purchase_currency` | Blank for absent data; decimal with up to four decimal places and a separate three-letter currency. No floating-point prices. |
| `misprint` / `altered` | `true`, `false`, or blank for unknown. |
| `source_metadata_json` | JSON object preserving extra source data, up to 16,000 characters and eight nesting levels. |

Exports use UTF-8 with BOM and ordinary CSV quoting, including embedded newlines. Empty finish and condition import as unknown/ungraded; empty flags remain null. Missing quantity is unresolved until the collector approves a default. Imported holdings create lots; a fresh canonical export/import preserves supported fields and source metadata, not account IDs, photos, all event history, or the deployment itself.

Spreadsheet safety is reversible only under the explicit canonical encoding. Prefix one apostrophe when a value starts with an apostrophe, starts with tab/CR/LF, or its whitespace-trimmed beginning is `=`, `+`, `-`, or `@`. Existing initial apostrophes therefore double. Canonical import removes exactly one initial apostrophe. Other CSV adapters do not remove arbitrary user apostrophes. Formula text is never evaluated.

## Portable CSV

Portable CSV uses common card-list columns and UTF-8 with BOM. Imports detect known aliases or allow manual column mapping. Exact destination behavior varies; the app offers file formats without claiming certified compatibility with a particular product.

| Suggested source column | Canonical field |
| --- | --- |
| `Scryfall ID` | `scryfall_id` |
| `Name` | `name` |
| `Set Code` | `set_code` |
| `Collector Number` | `collector_number` |
| `Quantity` | `quantity` |
| `Foil` | `finish` (`normal`, `foil`, `etched`; blank stays unknown) |
| `Condition` | `condition` (including underscore-separated names) |
| `Language` | `language` (supported language names normalize to provider codes) |
| `Binder Name` / `Binder Type` | Destination binder / non-owned-list exclusion |
| `Purchase Price` / `Purchase Price Currency` | Acquisition amount and currency |
| `Misprint` / `Altered` | Nullable flags |
| `Notes` | Card notes |
| Unmapped columns, including app-specific IDs | Retained source metadata |

`list`, `wishlist`, `wish list`, and `deck` types are excluded. Unknown list types require review. A manual printing selection also requires explicit ownership confirmation. Do not import a wishlist as owned copies merely by renaming its columns.

All remaining copies are exported, including unknown finish/ungraded condition, which use blank cells. Notes and named locations are included; source extensions are omitted and reported. Spreadsheet-safe prefixes are applied, but only full CSV has the explicit reversible encoding marker. Use full CSV when preserving literal formula-like fields or extra source metadata matters. Older stored export files keep their original contents and may still require acknowledgement of omitted details.

## Plain text lists

Choose Text, or upload a `.txt` file with automatic detection. Accepted examples:

```text
Mainboard
4 Lightning Bolt (M11) 146
2x Island
1 Card Name (SET) 123 *F*

Sideboard
1 Other Card (SET) 45 *E*
```

Each card line has an optional positive quantity (`4` or `4x`), a name, optional set code in parentheses and collector number, and optional `*F*`/`*E*` foil/etched marker. A bare card name means one copy. Unmarked text entries default to **nonfoil**; `*F*` means foil and `*E*` means etched. Before confirming an import, **Column mapping and file options → Unmarked text entries** can instead keep their finish unknown. This setting applies only to text; blank CSV finishes remain unknown. Blank lines and comment lines beginning `#` or `//` are skipped. Mainboard, Sideboard, Commander headings and `SB:` prefixes are recognized; section information is retained as source metadata. Uploading a deck list does not assert ownership: the same collection confirmation is required.

Text printings resolve only when the supplied identifiers match exactly one local catalog entry; missing or ambiguous printings need manual selection. No arbitrary printing is chosen. Text exports include quantities, names, set codes, collector numbers and foil/etched markers. They omit storage locations, language, condition, notes, acquisition details and source extensions, with an explanation in the export report. Unknown finishes also lose their distinction from unmarked nonfoil entries in portable text; use full CSV to preserve unknowns. Full CSV retains those supported card details. Saved decks also export sectioned text or CSV from their saved list, independently of owned-copy quantities.

Both CSV and text are checked with synthetic round trips. Destination interoperability still needs representative files and actual imports, including copy totals and field handling; common columns alone are not a universal compatibility claim.

## Generic mapping and recovery

The mobile mapper lets collectors choose source columns, comma/semicolon/tab delimiter, UTF-8 or UTF-16 encoding, an explicit absent-quantity default, an optional absent-language default, and a default binder. Mappings and defaults require a fresh server preview. Duplicate column names, malformed records, unsupported enums, conflicting IDs, ambiguous printings, invalid money, and nonpositive quantities are never silently accepted.

Identifiers resolve from an existing printing UUID first, then an exact set/language and collector-number/name combination only when unique. Row metadata is checked for conflicts. Search-based manual repair lets the collector choose an exact printing. Invalid quantities or metadata require correcting the mapping/file. Failed/unresolved/excluded rows remain available in a spreadsheet-safe recovery CSV containing source record numbers, statuses, errors, and complete raw-field JSON.

Current limits: 5 MiB/file; 10,000 records; 64 columns; 16,384 characters per parsed cell; at most two active imports and two active exports per account; exports up to 50,000 lots (larger collections can export by binder). Raw import files expire after seven days in a terminal state; generated export files expire after 24 hours. Private downloads enforce owner and expiry checks.

Current tests cover canonical round-trips, Unicode/quotes/newlines/formula-like text, missing defaults, duplicate files, repeated rows, explicit partial imports, stale previews, interrupted commits, undo barriers, removal before undo, ownership, expiry, and snapshot reuse. See [status](STATUS.md) for browser and release evidence.
