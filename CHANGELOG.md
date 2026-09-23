# Changelog

## Unreleased — September 23, 2026

This update collects the current PakTrak features and fixes. It is a source update, not a claim that physical-device qualification or every release gate is complete. See [validation status](docs/STATUS.md).

### Scanning and review

- Docker workers process accepted uploads independently of the phone, with durable jobs, retries, progress and recoverable batches.
- JPEG, PNG, WebP, HEIC/HEIF, AVIF, TIFF, BMP and still GIF uploads use server-side decoding. Camera capture saves JPEG by default; primary-photo handling accepts still JPEG/HEIF files with auxiliary images.
- In-app camera selection, device-local camera preference, framing guides, available light/zoom controls, capture review and retakes.
- Improved detection of borderless and adjacent cards, manual missed-card outlines, and crop orientation correction.
- Matches above 88% strength are approved automatically; other suggestions show the likely card and match strength for approval or editing. Review uses bottom Previous/Next controls.
- Foil count and finish selection distinguish chosen foils from remaining nonfoil cards. Card-count and quantity fields can be cleared before entering a new value.
- Batch lists show card previews, processing progress and estimated value. Deletion explains and removes the batch's remaining collection copies.
- Optional administrator-enabled CPU image enhancement helps difficult scans without requiring a GPU.

### Collection and pricing

- Card-art gallery with search, rarity/edition corrections, price filters and sorting, card details, and quantities for duplicates.
- Named binders and boxes connect collection searches to physical storage locations.
- Cached Scryfall metadata/artwork and account-saved pricing choices for TCGplayer, Card Kingdom and ManaPool, with visible missing prices and update status.
- CSV column mapping, CSV/text previews and exports, preserved quantities/finishes, progress estimates and reversible collection imports.
- Collector-number search such as `Plains #287`, with set filters for numbers shared across editions.

### Decks

- Three-column deck-box gallery with deck colors and commander artwork, plus detailed card-image previews.
- CSV/text imports into new or existing decks, including replacement/addition previews and matching to owned editions by card name.
- Owned/missing comparisons, physical storage locations, and missing-card buy lists for TCGplayer, Card Kingdom and ManaPool.
- Commander import ordering, section editing, format legality/construction checks, and token/emblem checklists from the cached catalog.
- Multi-photo scanning into new or existing decks. Deck-only saves are the default; adding the scanned copies to the collection is an explicit option.
- Deck value by selected price source, with duplicate quantities, section subtotals, finish estimates, individual card values and an unpriced breakdown.

### Accounts and navigation

- First-boot administrator creation and an eight-character password minimum.
- Optional guest signup with a lifetime allowance of 100 scanned cards. Approval grants unlimited scanning by default and shows a membership welcome.
- Personal account settings and administrator user management: approval, suspension, sign-out, scan pauses, lifetime caps and temporary password resets.
- PakTrak branding, locally served fonts, light/dark/device appearance settings, a welcome tour, and browser Back/Forward navigation with unsaved-edit protection.
- Dismissible action errors, retry controls, and private administrator error logs with request references.

### Hostname recovery

- Startup binds the installation to its existing identity realm and updates login destinations when `APP_URL` changes.
- Existing account IDs, roles, allowances, preferences and owned data survive address changes; previous application sessions are revoked during a move.
- Unknown realms, conflicting legacy identities and outdated login callbacks cannot silently create replacement guest accounts.
- Before moving an older installation, upgrade once at its existing address. Keep credentials and volumes; follow the [hostname-change instructions](docs/OPERATIONS.md#https-and-access-from-a-phone).

### Validation and scope

- Source publication includes PolyForm Noncommercial 1.0.0, the project notice, third-party notices, contribution/security guidance and issue templates. Private deployment configuration, data and generated artifacts are excluded.
- Latest backend verification: 416 passing tests, including account-preserving origin changes and failure/retry cases.
- Latest origin-recovery browser verification: 20 error-handling cases and two repeated live-sign-in cases across Chromium and WebKit.
- Other features have their own recorded backend/browser evidence in [implementation status](docs/STATUS.md).
- Real-phone qualification, general recognition-accuracy claims, coordinated backup/restore automation and release packaging remain separate work. The project retains its source-available, noncommercial release direction.
