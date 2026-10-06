# Changelog

## Single-container image — October 6, 2026

- Publish `ghcr.io/addison16/paktrak`, one container with the database, sign-in service, photo storage, app and web server, started in order and stopped cleanly. It keeps everything in one `/data` folder and creates its private passwords on first start.
- Add an Unraid template so PakTrak can be added and updated from Unraid's Docker page, and rewrite the [Unraid guide](docs/UNRAID.md) around it.
- Add `scripts/move-to-single-container.sh`, which copies a Compose installation's database, photos and passwords into the single container's data folder and leaves the old volumes untouched.

## Unraid installs — October 6, 2026

- Add an [Unraid guide](docs/UNRAID.md): install from a downloaded archive, set up and start from the Unraid terminal.
- `sh scripts/update.sh` now works without Git. An installation unpacked from a source archive downloads each release's archive instead of checking out its tag, keeping `.env` and data volumes.
- `sh scripts/setup.sh --allow-http` accepts a plain HTTP home-network address such as `http://192.168.1.50:8095`. Without it, plain HTTP is still limited to `localhost`.

## Simpler interface styling — October 6, 2026

- Remove decorative dots and marks: the dot beside the current menu item, the hook before section labels, the dot in the home banner and the onboarding progress dots (the "1 of 5" step count stays).
- Replace most nested boxes with plain sections divided by rules. Status badges are now plain labels, panels lose their drop shadows, and corners are smaller throughout, including the menu button, filters, dialogs and the menu drawer.
- Notices that need attention (recoveries, password resets, foil cards to mark) keep their tinted background with a side rule.

## Smoother self-hosted updates — October 6, 2026

- Run PakTrak from just `compose.yaml` and `.env`, with no Git checkout or host files mounted. A one-shot `database-setup` service creates missing database roles and databases, the login theme ships in the web image and is copied by a one-shot `identity-theme` service, SeaweedFS reads its S3 keys from `.env`, and bootstrap creates the sign-in realm on fresh installations.
- Keep the site up when Compose recreates the API or identity service on a new IP address: nginx re-resolves them instead of returning 502 errors, and Compose restarts the web service when they are replaced.
- Upgrade existing installations in place with `sh scripts/update.sh` or `sh scripts/start.sh`. Collections, photos, S3 credentials and sign-in accounts are kept; the older `infra/generated/` files are simply no longer needed.
- Back up installations without `infra/generated/`, skip the rebuilt theme volume, and leave completed one-shot containers stopped when resuming after a backup.
## AGPL-3.0 relicense — October 5, 2026

- Relicense original PakTrak code from PolyForm Noncommercial 1.0.0 to the GNU Affero General Public License v3.0 (AGPL-3.0-only). PakTrak is now free and open-source software, and commercial use is permitted under the AGPL's terms.
- Update the notice, README, contribution guide, third-party notices, dependency register and published image license label.

## Container dependency notices — October 4, 2026

- Include the complete React, React DOM and Scheduler MIT licenses and the npm lockfile in the production web image, alongside project notices and bundled font licenses.

## Pull-based Docker releases — October 4, 2026

- Publish tested Linux amd64 backend and web images to GHCR when a GitHub release is published. Version and commit tags include provenance and SBOM attestations; `latest` advances after both stable-release images publish.
- Pull application images in the default Compose setup, with opt-in source builds through `compose.build.yaml` and `sh scripts/start.sh --build`.
- Add `sh scripts/update.sh` to install a matching published source tag and image version while retaining existing credentials, project identifiers and named data volumes.
- Download images before pausing services, stop application processes before migrations, refresh the identity theme, and start the app only after successful bootstrap and API readiness.
- Document installation, updates, release publication and initial public package visibility; include project notices in application images.

## Easier batch review and sleeved-card OCR — October 3, 2026

- Open every batch ready for review. The separate **Edit batch** / **Done editing** mode is gone; older `/edit` batch links open the same batch.
- Put **Approve & import** in the sticky bottom bar between Previous and Next, so approving and moving to the next card is one thumb tap.
- Give crop corners finger-sized handles, keep the grab offset while dragging, and show a magnifier with a crosshair and outline edges on the side away from your finger. Keep the draft notice below the photo so it cannot shift corners mid-drag.
- Read sleeved cards: try lower title strips when the usual position has no confident name, in both orientations, and only flip a card for a plausible upside-down name.
- Count set codes with digits (M15, C18, MH3), tolerate common footer misreads, and suggest printings from a readable set code and collector number when the title is unreadable.
- On 133 previously manual-review crops, correct top printings rose from 66 to 99 (standard) and 73 to 103 (enhanced); 40 now qualify for automatic import with enhanced scanning.

## Deck case edge refinement — October 3, 2026

- Keep the compact proportions and prominent commander artwork while refining the lid, base, and corners.
- Give the front and side walls one continuous beveled base, replace the dark bottom strip with softer material shading, and tighten the contact shadow.
- Soften the lid's upper and lower edges and finger notch while preserving its slim profile and fixed rear hinge.
- Align grain and pointer lighting with the physical front silhouette, keep cap joins opaque, and give artwork a dark backing to prevent pale edge flecks in WebKit.

## Compact deck case redesign — October 3, 2026

- Rebuild deck boxes with compact proportions, beveled corners, solid walls, and a slim fitted lid that opens around a rear hinge.
- Enlarge the commander artwork window while preserving both partner commanders, featured cards, saved finishes, emblems, and mana colors.
- Replace the oversized lid branding, clasp, and stitched trim with a matte surface, narrow seam, recessed artwork frame, and discreet branding.
- Keep card flights behind the enclosure and seal grazing lid edges in WebKit. Preserve the missing-art placeholder when an image fails before the first effects run.
- Add browser regressions for thin lids, prominent commander displays, compact proportions, and initial artwork failures; retain rendered-pixel seam and enclosure checks.

## Realistic deck case construction — October 3, 2026

- Replace the sliding flat lid with a cap that rotates around a fixed rear hinge, including all four exterior walls, recessed lining, and thick edge rims.
- Build the body, lined cavity, and lid from shared projected vertices to seal panel joins and prevent edge gaps. Keep hover motion on one stable painted surface.
- Conceal cards behind the front and side walls until they emerge above the mouth, and give the lid time to clear before launching cards.
- Verify intermediate cap seams, body joins, visible lining, and card enclosure with rendered-pixel regressions in Chromium and WebKit.

## Premium deck cases — October 3, 2026

- Give deck boxes deeper proportions that scale with their size, with extra capacity for commander decks.
- Add framed artwork, padded lids, stitched edges, embossed spines, and brushed metal clasps while retaining saved finishes and emblems.
- Keep the side and top panels painted in WebKit, align the case seams, and soften pointer tilting and lid opening.
- Add a rendered-pixel regression for disappearing side panels and verify deck layouts, customization, opening, landing, cancellation, and reduced motion in Chromium and WebKit.

## Card viewer animation polish — October 2, 2026

- Keep the cached collection artwork visible while its larger image loads and decodes, including when the detail image fails. Reveal the painted viewer before blending away a single front surface and its shadow to prevent the final handoff flash and a mirrored back appearing in WebKit.
- Replace pale card edges with near-black charcoal shading so viewer spins and deck openings avoid bright edge flashes.
- Finish deck openings after their animations complete, with distinct visible landing targets and smooth exits for the remaining cards.
- Give deck cases greater depth, with larger commander cases, and keep artwork corners proportional as cards scale.
- Soften the lift and tilt when opening a card from a deck or collection while retaining the full spin and visible card edges.
- Hide the flight before cancelling its animations so completion, resizing, and navigation cannot flash an unpositioned card across the screen.
- Give late card-detail layout changes time to settle smoothly before revealing the destination artwork.
- Verify card arrivals with 64 Chromium/WebKit checks covering phone and desktop layouts, rendered front artwork during the handoff, delayed and failed images, exact landing, late responses, cleanup, focus, card faces, and reduced motion.

## Source publication checks — October 2, 2026

- Keep unfinished photos recoverable in WebKit private contexts by storing bytes and MIME type, while continuing to read previously saved Blob/File photos.
- Preserve failed banner-artwork fallback even when an image error arrives before the component's effects run.
- Give selected back-facing cards a longer visible pass during deck opening.
- Reject composed and forward archive links that escape a backup restoration destination, while preserving valid links, numeric ownership and permissions.
- Update browser regressions for persistent collection URLs, individual-card lookups and asynchronous recovery saves; verify restored upload bytes, MIME type and size.

## Deck presentation and card motion — October 1, 2026

- Add sculpted deck cases, responsive lighting, commander-led banners, artwork layouts, and named case finishes and emblems.
- Open decks with a card scatter that shows several real Magic card backs clearly before the cards land on their matching gallery positions. Separate surface fades from the 3D rotation to prevent mirrored fronts, while retaining thin card edges.
- Lift cards from their actual deck or collection position into the detail viewer with a 3D spin, accurate landing, and focus restoration. Respect reduced motion and clean up interrupted transitions.
- Show foil and etched treatments for owned finishes without changing card artwork.
- Fix duplicated deck-value panels accumulating during refreshes and stale deck/import responses during navigation.

## Quality of life upgrades — September 30, 2026

- Recover unfinished photos, scan reviews, foil selections, crop corners, decks and deck imports on the same device.
- Keep unrelated scan edits when saving foils; inspect enlarged images and zoomed crops with keyboard precision.
- Filter scan issues without changing physical card numbers; retain printing filters and show artwork in search results.
- Remember and bookmark collection views; organize selected printings together or move part of a copy group while preserving import provenance and undo.
- Open collection card links independently of the current gallery page; edit condition and notes alongside finish.
- Repair deck import quantities and sections inline, preserve reviewed choices when rebuilding previews, and navigate collection import issues directly.
- Compare edited decks with live ownership, recover conflicting edits, undo recent changes, duplicate decks and copy their complete lists.
- Add verified cold backups and restore into fresh projects, with a repeatable database/photo/configuration restore drill.

See [the feature guide](docs/QOL.md) and [backup operations](docs/OPERATIONS.md#upgrades-and-backups).

## Unreleased — September 23, 2026

This update collects the current PakTrak features and fixes. It is a source update, not a claim that physical-device qualification or every release gate is complete. See [validation status](docs/STATUS.md).

### Scanning and review

- Fixed cards with alternate titles, such as Search for the Frozen Esper (Nature's Claim), being absent from manual search and scan suggestions. Shared name matching covers alternate/localized titles and every card face in catalog, collection and import searches; printing choices and scan review show both printed and canonical titles.
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
- Added Ocean, Amethyst, Ember and Slate color themes alongside the original Forest palette. Theme previews follow light/dark/device mode; choices apply before rendering, persist in this browser, and sync across app tabs and sign-in pages.
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
