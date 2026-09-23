# PakTrak
## Full product specification and implementation handoff

**Prepared for:** Addison  
**Document version:** 1.5  
**Date:** September 18, 2026  
**Project name:** PakTrak — Every card. In reach.  
**Audience:** Software developer, development agency, or coding agent.  
**Deliverable type:** Build instructions, architecture, contracts, and acceptance criteria. This document is not a completed application or a report of measured scanner performance.

> **Product goal:** Photograph the cards from an opened Magic: The Gathering pack laid out on a table. Detect and identify each physical card independently. Process the uploaded photo on a server. Automatically add valid server-computed matches with match strength strictly greater than 88%, per the owner’s updated direction below. Present everything else that might be a card for review, correction, or a closer photo. Preserve quantities, expose uncertainty, and make every addition reversible.

**Owner direction, September 17, 2026:** Build primarily for self-hosting with Docker Compose and use from a phone browser. Follow the Paperless-ngx upload-then-process experience: once the server confirms durable acceptance, the phone may disconnect, close the browser, or turn off. Target phones four years old or newer at release; approximately 2022-and-newer hardware is the initial 2026 baseline. Built-in collection import/export, including tested ManaBox CSV migration and a mapping flow for similar tools, belongs in Version 1. Prepare for a free, source-available public GitHub release after refinement, with commercial reuse prohibited. The owner explicitly chose this licensing direction; see Section 16.5.

**Additional owner direction, September 19, 2026 (supersedes the older owned-only deck scope):**

- Improve Take photo with an in-app rear-camera view, framing guides, thumb-accessible capture, review/retake and capability-detected controls. Preserve the native camera/file route for maximum photo detail and unsupported browsers. Show actual dimensions and distinguish a video-frame fallback. Keep recognition and processing in Docker after durable upload acceptance. See [camera capture](../docs/CAMERA.md).

- Import deck plans from pasted text and CSV/text files, including unowned cards. Show owned and missing quantities, support matching any edition or exact printings, and export missing-only buy lists for common retailer text entry and generic CSV/text use. Preserve sections and physical collection quantities.
- Place scan-review Previous/Next controls at the bottom of the selected card for easier thumb access.
- Present scan batches as a list with miniature card previews. Opening a batch replaces the list with its overview; provide Edit batch at the top, Back to batches, and a bottom Close batch action. Explain immediate saving of approvals/corrections, distinguish unfinished edits and confirm before discarding them. Done editing returns to the overview without importing unresolved cards.
- Give decks the same list/overview/edit separation with card previews, clear Back/Close/Save & done controls and protection for unfinished edits. Allow importing another CSV/text list into an existing deck, either replacing its full card list or adding quantities, after a preview. Preserve the deck's identity, notes and settings, keep sections distinct and leave physical collection quantities unchanged.
- When a guest is approved as a standard member, show a congratulations popup at their next login explaining unlimited card scans and available collection/deck tools. Remember dismissal across sessions and devices.
- Provide Light, Dark and Auto appearance choices. Auto follows the device setting and responds to changes while open. Remember the choice on the device, apply it consistently to navigation, forms, card details and account screens, and preserve original photo/card colors.

**Updated owner direction, September 19, 2026 (takes precedence over older automatic-import gates below):**

- Enable automatic import for server-computed **match strength strictly above 88%**. This is the owner-selected similarity rule, not a calibrated probability claim. Exactly 88% and weaker results need approval. Older references to a qualified model, `p_exact > 0.92`, or a disabled automatic-import gate no longer constrain this action. Independent accuracy evaluation remains required before making measured accuracy/support claims.
- Add Previous/Next review controls, a visible card counter, a jump to the next pending card and automatic advancement after approval. Preserve unfinished edits while browsing cards.
- Ask for the foil count before uploading. After identification, let the owner select that many foil cards; save those as foil and the other active cards as nonfoil, including already-imported source copies. Include etched foils in the count. Zero foils means nonfoil immediately; mixed or unspecified batches keep finishes unknown until selection. All processing and confirmed labels remain durable on the server.

**Updated owner direction, September 18, 2026 (takes precedence over older scope below):**

- The application is named **PakTrak**. Apply its card-and-trail identity, deep teal, parchment and copper palette across the collection, welcome, authentication and phone home-screen assets; see [the brand guide](../docs/BRAND.md).
- First launch must guide the installer through creating an administrator account, without a generated default application login.
- New signups are guests. A guest can scan **100 cards total**, with no daily/monthly reset. Admin approval changes them to a standard member with no total-card scan limit. This is independent of the existing processing-concurrency limits, which remain unchanged.
- The administrator can enable or disable guest signup. Closing signup preserves existing accounts and saved collections.
- Use ordinary CSV and plain-text import/export, with common card-list syntax and a CSV column mapper. Remove other collection-app names and experimental/self-hosted badges from the product interface. Older app-specific adapter/release requirements below are superseded by generic file interoperability; they do not require an app-branded UI or targeted exporter.
- Include saved decks built from owned cards, and named physical storage locations such as “Red binder” or “Box 4.” Collection search and deck details must show those locations. Preserve inventory quantities and provenance when organizing cards.
- Display duplicate owned copies as one entry per exact printing with a quantity counter. Accumulate copies from separate scans/imports, show per-location counts, preserve variant details and source history, and update totals after removals or undo. Retries must not manufacture additional copies.
- Make collection browsing a card-art gallery with enjoyable discovery, owned-card search, filters and full card details. Keep quantity counters, saved decks and physical locations.
- Supply daily, source-labeled TCGplayer, Card Kingdom and ManaPool price references, with Scryfall metadata/artwork, respectful server caching and import/update time estimates. Missing prices and unknown finishes must stay explicit; never invent values.
- Keep Docker-first deployment, phone-browser support, disconnected server processing, and the non-commercial source-available release direction.

These additions are implemented in the current code; validation and limitations are recorded in [STATUS](../docs/STATUS.md). The current guest counter measures successfully persisted detected photo regions, not imports, simultaneous jobs, or remaining holdings. Deck format labels do not imply legality validation.

**Current repository status:** The Docker implementation provides durable photo processing, manual review, collections, CSV/text transfers, first-admin setup, guest/member roles, approval and signup controls, saved decks and physical storage locations. See [implementation status](../docs/STATUS.md), [Docker operation](../docs/OPERATIONS.md), and [architecture decisions](../docs/ARCHITECTURE.md) for tested behavior and remaining recognition/release work. This document remains the target specification. The supplied PDF is the original version 1.0 snapshot and has not been regenerated; this Markdown version takes precedence. Several reference assets mentioned in version 1.0 were not present in the supplied folder; see Section 25.

### Read this first

Keep scanner reliability central while supporting the requested saved decks and physical storage locations. The distinguishing feature remains an entire pack processed from one photograph, with minimal correction effort and no silent collection corruption.

The earlier discussion proposed 15 cards as the everyday target, approximately 20-24 as a possible upper range, and larger scans on better cameras. These are **engineering hypotheses, not validated capabilities**. Similarly, an OCR score, image similarity, or hand-weighted average is not a calibrated probability of a correct printing. This specification replaces those assumptions with measurable release gates.

**Authority:** Explicit requirements in this document govern implementation. Proposed defaults may be revised through a documented architecture decision. Accuracy claims, pricing claims, supported device limits, and automatic-add behavior must not be loosened silently to make a demonstration look successful.

---

## 1. Requirements and product boundaries

### 1.1 Core requirements

| ID | Requirement | Verification |
| --- | --- | --- |
| R01 | Mobile web app with optional PWA installation; primarily target phones four years old or newer at release (approximately 2022 onward for the 2026 baseline). | Published browser/device matrix, capture tests, and ordinary-browser use without installation. |
| R02 | One image containing multiple face-up cards; primary benchmark is 15 cards. | End-to-end photographed-pack evaluation. |
| R03 | Evaluate 16-24 cards as an extended mode, not a guaranteed baseline. | Separate count-bucket qualification. |
| R04 | Valid server-produced candidates with **match strength greater than 0.88** auto-add, subject to catalog/finish validation. This score is not calibrated accuracy. | Threshold, worker fencing and inventory-integrity tests. |
| R05 | Ambiguous cards receive per-card review without blocking unrelated, eligible matches. | Mixed-result integration tests. |
| R06 | Separate card identity, printing/language, finish, and condition. | Schema, UI, and recognition tests. |
| R07 | After durable upload acceptance, all recognition and inventory processing runs on the server without any phone connection, browser session, or active polling. | Close-browser, airplane-mode, phone-off, expired-session, and server-restart tests. |
| R08 | Detect quality problems and allow correction of missed, merged, or false card regions. | Detection and recovery tests. |
| R09 | Retries and races cannot create duplicate inventory additions. | Transaction and concurrency tests. |
| R10 | Two physical copies of the same printing remain two copies. | Repeated-card image tests. |
| R11 | Provide collection/binder management, batch history, corrections, and built-in import/export: tested ManaBox CSV migration, canonical CSV, and a generic column mapper. | Mobile migration, quantity/metadata preservation, round-trip, and undo tests. |
| R12 | Keep uploaded photos private and enforce retention and deletion. | Security and lifecycle tests. |
| R13 | Auto-add follows the owner-selected 88% similarity rule. Claims of calibrated accuracy or supported devices/counts still require independent qualification. | Policy/API tests; independent evaluation for future claims. |
| R14 | Explain failures and preserve partial results; never fabricate a match to fill a pack. | Failure-injection and unknown-card tests. |
| R15 | Docker Compose is the primary installation, operation, development, and release path. | Clean-host install, container recreation, upgrade, and restore checks. |
| R16 | Baseline scanning runs on a CPU server using local catalog/model assets without a required paid cloud recognition service. | Scan with provider networking unavailable after provisioning; hardware measurements. |
| R17 | Prepare a free, source-available public GitHub release after qualification, with a license prohibiting commercial reuse, dependency notices, reproducible images, and contributor/operator documentation. | Release checklist, license matching the owner's direction, and evidence for compatibility claims. |

### 1.2 Version 1 scope

Ship sign-in for private collections; public card search where allowed by provider terms; camera capture and image upload; optional pack/set hints; card-region detection; hybrid recognition; durable background jobs; partial results; manual review; inventory; binders; batch undo; timestamped price estimates; built-in ManaBox/generic CSV migration and collection export; account deletion; administration; and operational monitoring. Ship and document the complete Docker Compose deployment, including persistent storage and a self-hosted authentication path. Collection migration must be usable before automatic recognition is qualified.

English printed cards are the initial recognition qualification target. The database must support multiple languages and card faces from the beginning. Non-English, older, or unusual cards may be recognized, but unqualified categories must enter review rather than inherit an unsupported accuracy claim.

Tokens can be stored when cataloged and deliberately enabled. Ads, card backs, accessories, and art cards must not be misfiled as ordinary playable cards. Recognition support must be stated by category, not just by total catalog size.

### 1.3 Explicitly deferred

Do not make these prerequisites for Version 1: a full Commander deck builder, trade marketplace, payment subscriptions, native app-store releases, offline full-catalog recognition, automatic grading, counterfeit detection, automatic foil/treatment classification, overlapping-photo stitching, 40-card guarantees, video-based continuous scanning, or automatic identification of serialized numbers.

Keep interfaces extensible, but do not implement speculative infrastructure for all of these features before the pack scanner works.

### 1.4 Success definition

A user photographs a supported pack-sized layout, sees all detected regions, gets correct collection additions for qualified matches, resolves remaining uncertainty quickly, and can reverse or correct the batch without losing existing collection data. A system that confidently chooses the wrong printing is worse than one that asks a short, useful question.

---

## 2. Decisions, assumptions, and open approvals

| Topic | Starting decision | Status |
| --- | --- | --- |
| Application form | Responsive mobile web app; optional PWA installation; server-side recognition. | Required by owner. |
| Device target | Phones four years old or newer at release; first 2026 test matrix starts around 2022. | Required target; actual device/browser paths must be measured. |
| Primary card count | 15 cards per photograph. | Benchmark target, unproven. |
| Extended count | 16-24 cards only when that mode and photo quality qualify. | Experimental. |
| First-release image limit | 24 candidate card regions; overflow asks the user to split the layout. | Product limit, not a camera law. |
| Auto-add comparison | `p_exact > 0.92`, with additional eligibility gates. | Required behavior. |
| Exactly 92% | Review, not auto-add. | Explicit boundary decision. |
| Recognition | Artwork/full-card retrieval plus OCR and metadata checks. | Proposed architecture. |
| Finish default | Unknown, unless the user explicitly chooses a supported finish. | Safety default. |
| Condition default | Ungraded; never assume Near Mint because the pack was just opened. | Safety default. |
| Inference location | Server for detection, normalization, OCR, matching, policy, and inventory effects; optional lightweight client guidance. | Required by owner; phone has no role after acceptance. |
| Hosting | Self-hosted Docker Compose is the primary deployment; CPU baseline, persistent volumes, no mandatory hosted service account. | Required deployment direction; machine/provider selection does not change it. |
| Collection portability | ManaBox CSV import, canonical CSV import/export, tested ManaBox-compatible export, and generic CSV mapping in the web UI. | Required Version 1 scope; exact adapter behavior must be tested. |
| Branding and domain | Placeholder name only. | Owner approval. |
| Distribution | Free, source-available project intended for public GitHub release after refinement. | Required by owner; publication is a later release action. |
| License | Commercial reuse prohibited; describe the project as source-available. | Explicit owner clarification; select compatible license text before publication. |
| Monetization | No paid application tier, subscription, or scan charge in this project's release plan. | Owner's non-commercial direction; does not settle third-party license rights. |

Support is determined by the image actually received and the evaluated browser/device path. A newer phone can still deliver a small preview frame. An older phone can deliver a useful still image. Do not infer scan capability from a camera's advertised megapixel count.

### 2.1 Source-backed constraints

Browser camera access through `getUserMedia()` requires a secure context and permission. `ImageCapture.takePhoto()` can return a still-photo Blob, but requested dimensions are not a guarantee of the returned dimensions. Feature-detect and inspect the output. [S01][S02]

Browser workers are not permanent background services; a browser may terminate service-worker work. Consequently, persistent recognition belongs on the server after upload acceptance. [S03]

Paperless-ngx separates its web interface from background task processing and documents Docker Compose deployment. Adopt that interaction and operating model; the MTG scanner has its own recognition and collection contracts. [S21][S22]

A calibrated probability must be evaluated against observed outcomes. The raw output of a classifier or retrieval system does not automatically have this interpretation. [S07][S08]

Pack contents are not always restricted to the main set code. For example, Wizards' Aetherdrift collecting guide describes DFT and SPG cards within its Play Boosters. Use pack information as a hint, not an unconditional set lock. [S09]

**Source availability note:** Several Scryfall documentation pages rejected direct retrieval during preparation. Relevant primary-domain search extracts were available for API rules, card fields, and price disclaimers. The developer must verify the complete current API, bulk-data, image-use, and commercial-use documentation before implementing ingestion or public release. This is a named M0 gate, not an assertion that all current terms were reviewed.

---

## 3. User experience and screens

### 3.1 Navigation

Provide five primary destinations: **Scan**, **Collection**, **Batches**, **Review**, and **Settings**. Public search may be available without sign-in; private collection access requires authentication.

### 3.2 Start scan

The user selects a destination binder or uses their saved default. Show the automatic-add setting and threshold before the first automatic scan and whenever the user changes that setting.

Optional inputs: pack/product hint, set hint, expected physical item count, language hint, and an explicitly chosen finish default. Expected count must be optional. Never hard-code that every pack contains 15 playable cards.

Offer **Take photo** and **Choose photo**. Suggested preparation text:

> Lay cards face-up with visible space between them. Keep every edge inside the picture. Use even lighting and avoid reflections. Start with about 15 cards; use fewer when the app requests a closer photo.

Do not require a fixed inch measurement between cards. Separation must be sufficient for reliable detection in the captured image.

### 3.3 Capture and upload

Show capture guidance when supported: detected regions, likely blur or glare, clipped edges, and estimated text readability. Treat preview guidance as provisional because the final photo can differ from the preview.

Distinguish these states clearly:

- **Photo on this device:** not yet safe to leave.
- **Uploading:** bytes are still transferring.
- **Uploaded and accepted:** image is durably stored and processing is scheduled.
- **Processing:** server is working; leaving the page is safe.

Do not display “processing in background” before server acceptance.

After acceptance, show: **“Upload complete. You can close this page or disconnect your phone. Results will be saved in Batches.”** The server continues even if the phone powers off, loses its network, or its login session expires. Reopening the app, including on another authenticated device, retrieves saved progress and results. Server outages can delay work, but a browser reconnect must never be the trigger required to resume it.

Before acceptance, show upload progress and a useful retry state. If the acceptance response is lost, recover the existing scan through its ID/idempotency key before offering a new submission. A completed byte transfer alone is not acceptance. PWA installation, a wake lock, notifications, background sync, and an open websocket are not prerequisites for this workflow.

### 3.4 Processing and partial results

Show the original image with numbered, selectable regions. Display actual stage progress and processed counts, not a decorative percentage that implies measurements the system does not have.

Example interface copy, using fictional counts:

> 15 regions detected. 11 cards added. 2 matches need review. 1 region needs a closer photo. 1 insert excluded.

Each region needs both an icon/text label and an optional color. Color alone must not convey status.

### 3.5 Review one card

Present the user's crop beside the reference candidate. Show the name, set, collector number, language, relevant treatment details, and finish status. Provide up to three useful candidate choices, **Search all printings**, **Take closer photo**, and **Not a card / Ignore**.

Explain the reason: “Card name identified; printing is uncertain,” “Bottom text unreadable,” “Set and image disagree,” or “This layout is not yet qualified for automatic addition.” Do not show an unexplained percentage as the only reason for review.

Allow users to edit the crop or draw a missed region. A close-up must target the existing observation so it cannot increment quantity a second time.

### 3.6 Completion

Show: detected objects, physical card observations, added copies, pending decisions, excluded items, unknown finishes, ungraded copies, and any expected-count mismatch. Distinguish **processing complete** from **all decisions resolved**.

The batch is complete when processing has ended and every remaining observation is accepted, intentionally ignored, or retained as unresolved with the user's explicit choice. Finishing a batch must not silently add unresolved entries.

### 3.7 Collection and batch actions

Users can search and filter by card, set, binder, finish, language, and unresolved metadata. Show quantities of physical copies, not just unique names. Support move, correct, remove, and undo. A printing correction should replace the attribution of the original copy rather than create another copy.

Batch history must remain usable after photo retention expires. Show “Photo expired under retention policy” rather than a broken image. Inventory and its provenance can survive photo deletion unless the user deletes the account or collection data.

Provide visible **Import collection** and **Export collection** actions in Collection, also reachable from Settings. Import offers ManaBox CSV, the app's own format, and a generic CSV column mapper. Users choose a file on their phone, review the server-generated mapping and quantity changes, resolve or skip flagged rows, and confirm a background import. Export supports the whole collection or selected binders, names any fields a target format cannot represent, and produces a private downloadable file. Keep transfer history and import undo accessible without a desktop or command line.

### 3.8 Accessibility and usability

Support keyboard and screen-reader operation, sensible focus movement during review, sufficiently large touch targets, zoomable crop comparisons, reduced motion, and non-color status labels. Preserve in-progress review after refresh. Explain permissions in plain language and give a file-upload fallback when live camera access fails.

Use a responsive portrait layout, mobile file pickers, paginated collections, and small server-generated thumbnails. Test large text, narrow screens, touch review, and interrupted mobile networks on the oldest supported devices. Do not download recognition weights or the full card catalog to the phone. A service worker may cache the application shell; keep private API responses, photos, and collection exports out of shared/offline caches by default and clear account-scoped state on logout.

---

## 4. Camera support and realistic image budgets

### 4.1 Qualification baseline

Use an actual 12-megapixel still image as a starting benchmark, not as a minimum marketing requirement. Apple documents a 12 MP main camera for the iPhone 14, making that device one useful older-phone test case. It does not establish what every browser capture path will deliver. [S10]

For the initial 2026 release target, test at least: one 2022-era iPhone; one 2022-era Android flagship; one lower-cost Android phone of similar age; one newer iPhone; and one newer Android phone. Test Safari on iOS and Chrome on Android in both normal browser use and installed PWA mode where available. Record the exact model, OS build, browser version, capture method, image dimensions, and image format. Refresh the four-year hardware window for future releases and publish the concrete supported matrix; do not silently withdraw already documented support. Older phones may work, but are best effort until qualified.

### 4.2 Illustrative geometry, not measured recognition performance

For upright cards with an assumed width-to-height ratio of 5:7, a 4032 x 3024 landscape image, 90% usable span in each direction, and gaps equal to 5% of a card dimension:

```text
h = min(
    0.90 * image_height / (rows + 0.05 * (rows - 1)),
    0.90 * image_width /
        ((5 / 7) * (columns + 0.05 * (columns - 1)))
)
card_width = h * (5 / 7)
```

| Cards | Layout | Approximate card crop | Meaning |
| --- | --- | --- | --- |
| 6 | 3 x 2 | 948 x 1328 px | More source detail per card. |
| 12 | 4 x 3 | 627 x 878 px | Useful benchmark layout. |
| 15 | 5 x 3 | 627 x 878 px | Primary product benchmark. |
| 20 | 5 x 4 | 468 x 656 px | Less footer-text detail. |
| 24 | 6 x 4 | 468 x 656 px | Extended-mode experiment. |
| 30 | 6 x 5 | 374 x 523 px | Outside Version 1 product limit. |

These are geometric upper-budget examples before blur, lens effects, perspective, compression, and imperfect framing. They do not demonstrate that collector-number OCR will work. Layout affects which image dimension is limiting, so simply dividing image height by row count is insufficient.

### 4.3 Capture strategy

Implement feature detection rather than user-agent promises. Try a rear-facing camera stream for preview. Where supported and validated, use still capture. Also provide a native camera/file-input route, with the HTML capture attribute treated as a hint rather than a universal guarantee. [S01][S02][S11]

Inspect returned `width`, `height`, orientation, file size, and decode success. Record the capture path. Do not upscale a 1920 x 1080 preview to a large canvas and describe it as a high-resolution photograph. A canvas snapshot is a fallback, and its actual quality may require fewer cards.

Do not require browser access to full advertised 48/50 MP output. Stop camera tracks when leaving capture. Correctly handle EXIF rotation and the transformation between displayed coordinates and source-image coordinates.

### 4.4 Image-size safety

Configured limits: **100 MB upload**, **60 million decoded pixels**, **24 candidate card regions per Version 1 scan**. These are protective settings and must be load-tested. Accept JPEG, PNG, WebP, HEIC/HEIF, AVIF, TIFF, BMP and still GIF through the Docker worker. HEIC/HEIF uses the primary still image; animation, sequences, multi-page TIFF, RAW/DNG and documents require export to separate supported still photos first. The pinned HEIF decoder and its bundled native libraries belong in the dependency/redistribution register. No client-side conversion is required; processing continues after durable upload acceptance. See [photo formats](../docs/PHOTO_FORMATS.md).

Avoid decoding several full-resolution copies on the phone. An uncompressed 48 MP RGBA buffer alone contains approximately 192 million bytes before overhead. Upload the source Blob directly where practical; generate a small preview separately.

### 4.5 Dynamic quality guidance

Measure crop geometry, blur, clipping, occlusion, glare over useful regions, and estimated character scale. Retain native crop dimensions separately from any resized inference tensor. Upsampling must not increase the recorded amount of source detail.

Learn actionable quality cutoffs from the benchmark. Do not ship universal rules such as “800 pixels guarantees exact printing.” If the footer is unreadable but artwork is clear, identify the name provisionally and request printing confirmation when needed.

---

## 5. Architecture and stack

### 5.1 Recommended starting stack

| Layer | Default choice | Responsibility |
| --- | --- | --- |
| Frontend | TypeScript, React, Next.js | Mobile UI, capture, review, collection, PWA shell. |
| Backend API | Python, FastAPI, Pydantic | Authenticated contracts, jobs, catalog, inventory. |
| Database | PostgreSQL with pgvector | Durable records, catalog search, vector retrieval. |
| Background execution | Celery with Redis broker | Dispatch and execution of recognition work. |
| Image processing | OpenCV and a maintained image decoder | Regions, geometry, crop preparation, image checks. |
| OCR | Tesseract baseline behind a replaceable interface | Name and footer extraction; benchmark alternatives. |
| Image matching | Versioned embedding model via ONNX Runtime | Artwork and full-card retrieval. |
| Object storage | Private S3-compatible storage, included in the default Compose deployment | Uploaded images, crops, transfer files, model artifacts; persistent volume. |
| Authentication | Maintained OIDC provider with a documented self-hosted Compose configuration, or an existing compatible provider | Identity, login, recovery; server-verified sessions, no custom password system or mandatory SaaS account. |
| Deployment | Docker Compose on a Linux server; separate web/API/worker roles | Primary installation, persistent services, health checks, maintenance and recovery. |
| Testing | Pytest, frontend tests, Playwright, device checks | Policy, API, browser, and end-to-end validation. |

These are implementation choices, not proof that any untrained model recognizes MTG cards adequately. ONNX Runtime provides an inference runtime; pgvector provides vector-search facilities. Neither supplies the finished recognizer. [S12][S13]

Select currently supported language/runtime and package versions at kickoff. Pin exact versions and container digests in lockfiles. Write `docs/DEPENDENCIES.md` with versions, licenses, support assumptions, and the date checked. Do not use unpinned `latest` tags in production.

### 5.2 Data flow

```text
Phone browser
  -> create scan and upload intent
  -> private object upload
  -> finalize upload / durable job acceptance

API + PostgreSQL transaction
  -> scan state + job + outbox record
  -> dispatcher -> broker -> recognition worker

Worker
  -> validate and normalize image
  -> detect regions and finalize their identities
  -> crop each physical observation
  -> retrieve artwork/full-card candidates
  -> OCR and metadata checks
  -> calibrated exact-match decision
  -> review queue OR transactional inventory addition

Browser
  -> authenticated progress polling
  -> partial results, review, corrections, collection
```

### 5.3 Docker Compose deployment

Docker is the primary operating environment, not an optional packaging exercise at the end. Deliver a root `compose.yaml`, `.env.example`, versioned application images, and container-based management commands. A supported installation must not require Python, Node.js, OCR packages, or model tooling on the host. The operator supplies Docker Engine with Compose, persistent disk, and a reachable HTTPS origin for phones.

Use these service boundaries; multiple backend roles can reuse the same built image with different commands:

| Service | Role | Persistent state |
| --- | --- | --- |
| Reverse proxy | One application origin, TLS termination or integration with the operator's existing TLS proxy. | TLS configuration/certificates when managed here. |
| Web | Mobile interface and optional PWA shell. | None required for job correctness. |
| API | Authenticated upload/finalize, results, collection, migration APIs. | Authoritative state in PostgreSQL/storage. |
| Worker | Recognition plus bounded import/export jobs; independently restartable. | Checkpoints in PostgreSQL, assets in storage. |
| Dispatcher/scheduler | Drain the outbox, reclaim expired leases, reconcile unfinished jobs, run cleanup/catalog schedules. | Durable database records; singleton scheduling or database coordination. |
| PostgreSQL with pgvector | Collections, catalog, jobs, observations, import provenance, audit and vector data. | Named database volume. |
| Broker | Deliver tasks to workers. | Configured persistence; never the sole record of accepted work. |
| Private object storage | Images, staged imports, generated exports, versioned model/index artifacts. | Named data volume; private credentials. |
| Authentication provider | Self-hosted identity and recovery in the documented default setup. | Provider database/configuration included in backups. |

Publish only the configured application/authentication entrypoints; keep database, broker, and storage service ports internal by default. Bound upload size and timeouts consistently at the proxy, API, and storage layer. Run application services without privileged containers or a Docker socket mount. Use health/readiness checks and bounded reconnection; dependency startup order alone is insufficient. Run schema migrations as a controlled one-off step before compatible API/workers start.

Do not put heavy recognition solely inside a request handler, a short-lived hosting function, or FastAPI's in-process background task facility. FastAPI's own guidance distinguishes heavier multi-process background work from its lightweight background-task pattern. [S14]

The default is a CPU-only Linux server, VM, home server, or compatible NAS running the complete Compose stack. Target Linux `amd64` first; qualify `arm64` images and model/decoder dependencies before advertising ARM support. Optional remote storage, an existing identity provider, or a GPU profile must not become baseline requirements. Publish a tested resource/disk budget including the catalog, reference images, model/index files, and retention; the worker experiment in Section 17 is not the total deployment requirement.

Keep collections, accepted image objects, transfer state, and configuration across `docker compose down` followed by recreation and across host restarts, without deleting volumes. Document upgrades, backups, restoration, and schema-compatible rollback. Warn explicitly that volume-deleting commands destroy persisted data; they must not appear in the ordinary upgrade path. Document trusted HTTPS for LAN installations as well as public-domain deployments; a phone's access to a server's plain HTTP LAN address is not the phone's localhost exception. [S01]

### 5.4 Keep the first version simple

One recognition service, one authoritative database, one broker, and private object storage are sufficient starting boundaries. Do not add multiple vector databases, Kubernetes, a model-serving cluster, or an LLM orchestration platform without measured need.

The browser captures/selects a photo, uploads it, and presents server results. All required image normalization, detection, OCR, matching, confidence decisions, import parsing, and inventory commits run on the server. Optional preview guidance must never be necessary for a scan to finish. Initial catalog/model downloads and scheduled updates may require internet access; an accepted scan against already provisioned local assets must not need a phone connection or an external recognition service.

---

## 6. Card catalog, reference images, and provider use

### 6.1 Ingestion contract

Maintain a local, versioned print-level catalog. Select the appropriate Scryfall bulk export after verifying current documentation. An identity-only or artwork-only export is not sufficient for exact-printing inventory.

Store at minimum: provider ID, identity ID when present, card names and printed names, set code, collector-number string, language, layout, faces, image references, supported finishes, relevant treatment/promo fields, paper availability, and source timestamps. Preserve the source JSON for forward compatibility. The official card-object documentation is the schema authority. [S04]

**Never convert collector numbers to integers.** Preserve suffixes, unusual characters, and original formatting. Use the provider's printing identifier as the external reference key; names are not unique inventory keys.

Treat identity, printing, and face as separate concepts. A double-faced card can have multiple searchable faces but is one physical inventory copy. Do not create an additional copy because the back face was recognized in a targeted close-up.

### 6.2 Import workflow

Fetch the current bulk manifest, record timestamps and checksums, download to staging, validate schema, and stream the import. Upsert by stable provider ID. Build or update reference-image indexes in staging, then switch the active snapshot atomically.

Do not delete previously referenced printings because an import is incomplete. Mark unavailable or changed records and retain referential integrity. Keep the last known-good snapshot usable when the provider or importer fails.

Separate reference-image retrieval from JSON import. A metadata export does not mean that all image bytes are embedded in it. Cache permitted reference images and compute features once per relevant image/model version rather than repeatedly during user scans.

### 6.3 API discipline

Use a centralized server-side client with the required application-identifying and content-negotiation headers. Verify the current provider rules. Indexed Scryfall guidance asks API clients to remain below 10 requests per second; start with a shared limit of 5 requests per second, honor `429` responses and `Retry-After`, and use backoff. [S05]

Do not fan out public API lookups for every region of every frame. Recognition queries the local catalog. Background synchronization handles provider changes. Verify separate image-host rules rather than assuming an API rate limit applies to every host.

### 6.4 Price handling

Display **estimated value**, the provider, currency, selected finish, and an “as of” timestamp. Scryfall describes prices as estimates/market values rather than guaranteed final transaction prices. Do not market this integration as a live executable quote feed. [S06]

Keep unknown values null, not zero. Do not treat missing foil prices as nonfoil prices. Do not merge currencies. Do not claim a condition-adjusted valuation unless the source actually supplies it.

A copy with unknown finish is excluded from an exact finish-specific total by default. Show priced-copy coverage, for example “12 of 15 copies have a usable estimate.” A subtotal must not masquerade as the complete collection value.

### 6.5 Pack hints

Represent a selected product as a versioned hint profile: main set, known bonus-sheet sets, language assumptions, and provenance. Always include an escape route to the full catalog. A known set must not force an unreadable or out-of-set card into a wrong printing. [S09]

Without a verified profile, use the selected set only as a soft ranking feature. Never use expected rarity distribution or pack count to invent an identification.

---

## 7. Recognition pipeline

### 7.1 Stage A: ingest and normalize

Validate size, file signature, decoded dimensions, and supported format. Normalize orientation and color representation. Remove EXIF/location metadata from retained normalized assets. Keep an immutable source-image version and a content checksum for provenance.

Use bounded-memory decoding in an isolated worker. Handle corrupt files, decompression bombs, oversized dimensions, and decoder failures as normal error paths, not process-wide crashes. Upload security must follow a layered approach rather than trusting the filename or browser MIME type. [S15]

### 7.2 Stage B: detect physical card regions

Start with a classical OpenCV quadrilateral baseline for separated rectangular cards. Evaluate a licensed, maintainable detector or segmentation model when contours are insufficient. The detector must work across dark tables, busy mats, white borders, borderless layouts, sleeves, mild rotation, and varied lighting.

Return ordered quadrilateral corners or a polygon, normalized source coordinates, objectness diagnostics, occlusion/clipping flags, and a region version. Perspective transforms can rectify a detected quadrilateral; they do not recover detail that was never captured or content hidden behind another card. [S16]

Assign stable `observation_id` values before any inventory commit. Freeze the region set for that processing revision. Suppress overlapping duplicate detections of the same physical region, not visually identical cards at different locations.

If more than 24 plausible card regions are found, block automatic additions for that scan and request smaller groups. Do not silently process the first 24 and report the scan as complete.

### 7.3 Stage C: quality and layout

Evaluate native crop detail, readable text regions, blur, glare, edge clipping, perspective, occlusion, and supported layout. Run orientation checks when necessary. Store quality features and reason codes, not only a single opaque “quality percentage.”

Use layout-specific regions. Conventional frame, retro frame, borderless, split, adventure, and double-faced layouts must not share one blindly fixed crop map.

### 7.4 Stage D: candidate retrieval

Build two useful retrieval paths: artwork-focused matching and full-card/frame matching. Start with a reproducible embedding baseline and compare it against a lightweight image-hash baseline. Generic embeddings can be a prototype, not a production-accuracy claim.

Retrieve an initial candidate union, such as the top 25 from each available path, then expand all plausible printings and related faces of strong identity/artwork matches. Tune the candidate budget using held-out retrieval recall. Persist both the returned candidates and the catalog/index versions used.

Do not truncate away likely same-art reprints before exact-printing evaluation. Always keep a no-valid-match possibility. Similarity scores are internal diagnostics; they are not UI probabilities.

### 7.5 Stage E: OCR

Read the card name and, where available, collector number, set code, and language mark. Use multiple bounded preprocessing variants for difficult crops, such as grayscale, contrast adjustment, and modest deskewing. Tesseract documents several image-quality factors and preprocessing considerations relevant to recognition. [S17]

Preserve original OCR strings and normalized forms. Treat substitutions such as `O/0`, `I/1`, and punctuation changes as alternatives requiring corroboration. Never silently rewrite an uncertain footer into the identifier of the most convenient candidate.

Missing text is not contradictory text. Evidence that clearly conflicts with the artwork must trigger review. An unreadable footer should not become a perfect set/number match merely because the user selected a set.

Bound preprocessing attempts and OCR time per crop. Do not run a general-purpose multimodal model on every video frame. An optional future fallback must have separate privacy, cost, licensing, and accuracy evaluation.

### 7.6 Stage F: rank and verify

Combine measured features: image similarities and gaps, name agreement, footer agreement, layout consistency, language evidence, quality, supported-category flags, and a pack hint. Include explicit missingness indicators.

Train or fit a ranker using labeled observations and realistic negative candidates. Then calibrate the **selected exact-match outcome** on held-out observations. Do not publish a fixed weighted formula such as 45% artwork plus 20% name as a probability.

A ranker is permitted to choose a candidate for review when confidence is low. It is not permitted to fabricate a provider ID, interpolate card metadata, or infer certainty from a top-three softmax that omitted the correct answer.

### 7.7 Stage G: policy decision

Pass the immutable recognition result into the policy engine described in Section 8. The decision must include model/index/calibration versions, effective threshold, reason codes, and metadata completeness.

Only the inventory service can commit a collection addition. Recognition workers must not issue ad hoc quantity increments outside that service.

---

## 8. Confidence, eligibility, and the 92% rule

### 8.1 Meaning of confidence

Use these distinct concepts:

| Field | Meaning | Used for automatic addition? |
| --- | --- | --- |
| `p_identity` | Estimated probability that the selected card identity is correct for this observation. | Informational prerequisite. |
| `p_exact` | Estimated probability that the observation is the selected supported card printing and language. | Yes, after qualification and gates. |
| `finish_status` | Unknown, explicitly selected, or independently verified finish. | Completeness/strict-mode gate. |
| `condition_status` | Ungraded or user-assessed condition. | Never a recognition confidence. |

`p_exact` must be calibrated on the joint exact-match outcome, not calculated by multiplying separately calibrated marginal scores. It cannot exceed `p_identity`. Reject inconsistent probability outputs rather than silently adjusting them.

Keep explicit reasons for incomplete inventory metadata. “Exact printing matched” must not imply “foil and condition verified.” Some physically distinct treatments may require additional catalog fields or user information even after a base provider record is selected.

### 8.2 Automatic-add policy

The normal user threshold starts at **0.92**, and the comparison is **strictly greater than**. Evaluate the stored, unrounded probability. A UI display of 92.0% is not sufficient to decide which side of the boundary the raw value is on.

Every following gate must also pass:

1. Auto-add is enabled for the deployment and the user, and this scan recorded consent to the policy snapshot.
2. The model, calibration, catalog, and supported use-case bucket are qualified and available.
3. Detection is valid, the region is finalized, and the crop passes the qualified quality policy.
4. The chosen identity/printing/language exists in the active catalog snapshot and `p_exact > threshold`.
5. There is no contradictory evidence, unresolved same-art printing ambiguity, unsupported treatment, or unresolved physical-duplicate association.
6. The observation has not already been committed, ignored, superseded, or changed by a reviewer.
7. Any explicitly chosen finish is allowed for that printing. Strict metadata mode additionally requires a resolved finish.

Implement the policy boundary and eligibility behavior in a shared, tested module. The reference policy mentioned in the original handoff was not supplied in this repository. Before calibration exists, route results to review even when raw similarity looks impressive.

### 8.3 Unknown finish and condition

Default behavior allows an eligible printing to be auto-added with `finish = unknown` and `condition = ungraded`. Display those fields prominently and exclude unknown finish from finish-specific valuation.

An optional strict mode holds the item for review until finish is resolved. A user can deliberately select a finish default for a scan, but the system must label that source as user-selected and reject a finish that the catalog does not permit.

Do not classify “nonfoil” merely because the image has no obvious glare. Do not infer Near Mint from an unopened-product workflow.

### 8.4 Why 92% is not a promise of an error-free pack

As an illustrative calculation, 15 independent decisions each having a true correctness probability of exactly 0.92 would have `0.92^15`, approximately **28.6%**, probability of all being correct. Their expected error count would be **1.2**. Independence is only an illustration; real photo errors can be correlated. The expected error count follows by summing individual error probabilities.

Actual accepted observations should usually score much higher than the minimum. The release gate therefore measures precision at the actual deployed policy, not merely whether a percentage passes 92. If that policy fails the release gate, disable auto-add for the failing category or obtain owner approval for a stricter threshold. Never inflate probabilities to preserve automatic-add coverage.

### 8.5 Review and unknown outcomes

At or below threshold: review. Missing qualified probability: review. Conflicting evidence: review. Unsupported layout or poor-quality crop: review or close-up. Clearly identified non-card objects: exclude with an explanation. An uncertain object that could be a card must not disappear as a confident exclusion.

Show useful candidate differences rather than arbitrary decimal precision. Scores for a small candidate list need not total 100%; the correct candidate may be outside the list.

---

## 9. Physical copies, rescans, and duplicate protection

### 9.1 Three different duplicate problems

**Duplicate detection:** two bounding boxes refer to one card in one image. Resolve spatially before committing.

**Repeated physical printing:** two cards at different positions have the same printing. Preserve both observations and both inventory copies.

**Repeated request or image:** a client, queue, or user submits the same operation again. Use idempotency and explicit rescan handling; do not blindly increment quantity.

### 9.2 Stable observation model

Mint an observation for each physical region in a finalized image revision. Additional OCR passes, worker retries, candidate changes, and targeted close-ups attach to the same observation. A close-up endpoint must require its target observation ID.

A full-image retake after some copies have already been committed is not automatically safe to merge. Version 1 should offer a clear **new physical batch** versus **replace/review existing batch** choice. Replacing requires reconciliation; it must not simply rerun addition logic against newly generated region IDs.

### 9.3 Image hashes

Within an in-progress upload/scan, the same request key returns the existing operation. A repeated file hash in another scan should trigger a user-facing warning and a link to the previous batch. Do not use hashes as proof that two physical cards or two purchases are the same object.

Hash checks must be scoped to the current owner; do not expose another user's image existence. Permit intentional new-copy recording only through an explicit operation, not a retry flag controlled by an untrusted worker.

### 9.4 Multi-photo overlap is deferred

Matching card identities across overlapping photos is not enough to deduplicate physical cards. A future implementation must use geometric registration and instance association, and ask when identical copies cannot be distinguished. Do not implement “same card ID means same physical card.”

---

## 10. Durable background jobs and state machines

### 10.1 Durability contract

The server returns accepted status only after the immutable image reference, scan record, job record, and dispatch intent are durable. The browser may then leave. Unfinished uploads do not have this guarantee.

Finalization verifies the uploaded byte count and checksum, binds a server-controlled immutable object/version to its owner, and commits the scan/job/outbox transaction. Return `202 Accepted` with `scan_id`, `job_id`, `accepted_at`, and the status URL only after those steps succeed. Image decoding and recognition remain asynchronous. Failed validation never produces the safe-to-disconnect message; committed acceptance with a lost HTTP response is recovered through the existing operation, not a second scan.

Use a transactional outbox: insert the job and outbox row in one database transaction; a dispatcher publishes work; workers are idempotent. Database state is authoritative even when a broker message or notification is lost.

Persist all inputs a worker needs: immutable object reference, owner, destination binder, policy consent, catalog/model versions, and observation/review state. Workers use server credentials and durable authorization context. They must not call back to the phone for image bytes, use a browser's expiring upload URL to read accepted files, or depend on an active login session. Expired user sessions do not cancel accepted work; explicit cancellation, account deletion, or revoked authorization is handled through server state.

Queue task delivery is not the same as an exactly-once inventory effect. Celery documents the importance of idempotent tasks and acknowledgement choices. Make the database mutation safe to replay regardless of broker delivery behavior. [S18]

### 10.2 Scan processing states

```text
DRAFT -> UPLOADING -> QUEUED -> PROCESSING -> PROCESSED
                         |          |
                         |          +-> PARTIAL_FAILURE
                         +------------> FAILED
DRAFT / UPLOADING / QUEUED / PROCESSING -> CANCEL_REQUESTED -> CANCELLED
```

`PROCESSED` means recognition work ended, not that every card was added. Track a separate resolution state: `PENDING`, `RESOLVED`, or `CLOSED_WITH_UNRESOLVED`.

### 10.3 Observation states

```text
DETECTED -> RECOGNIZING -> AUTO_ADDED
                      -> NEEDS_REVIEW -> MANUALLY_ADDED
                      -> NEEDS_CLOSEUP -> RECOGNIZING
                      -> EXCLUDED
                      -> FAILED

AUTO_ADDED / MANUALLY_ADDED -> CORRECTED or REMOVED
```

Store processing attempts separately from the current decision. Retrying recognition must not reset accepted manual work.

### 10.4 Leases, retries, and progress

Use leases/heartbeats for running work, bounded retry counts, exponential backoff with jitter, and a dead-letter/recoverable-failure path. Suggested initial maximum: three automatic attempts for transient failures; adjust after testing.

Transient examples: temporary storage failure, broker disconnect, upstream sync interruption. Permanent examples: corrupt image, unsupported format, invalid catalog identifier, explicitly excluded observation.

Version 1 uses authenticated progress polling with backoff. Poll every roughly two seconds while actively processing, then slow down when appropriate. Optional server-sent events may improve immediacy but must not be required for correctness. Reopening the app must reconstruct state entirely from the server.

Stop polling when the page is hidden or offline and refresh persisted state on return. Progress requests observe jobs; they never advance them. Run a server-side reconciler at startup and periodically to republish due jobs with missing delivery and reclaim expired worker leases. Reconcile even an outbox entry marked published when its nonterminal job has no live lease beyond the configured dispatch timeout: broker loss after publication must not strand accepted work. Use backoff, row locks, and unique operation keys so reconciliation cannot duplicate inventory effects.

Container or host restart recovery must use persisted objects and database state. Retention must protect files still needed by accepted jobs through a bounded job deadline; if that deadline expires, save an actionable failure before cleanup. Orphan temporary/final objects created by a failed finalization are collected after a safe grace period. A cleanup race must not delete an image between accepted status and worker use.

### 10.5 Cancellation and partial results

Cancellation stops future work where possible; already committed copies remain until explicitly undone. Show that distinction. Check cancellation and the observation version immediately before committing. Batch undo must prevent still-running workers from adding more copies afterward.

One failed crop must not erase successful results for unrelated observations. A whole-image decode failure, however, cannot produce invented partial identifications.

---

## 11. Data model and integrity requirements

### 11.1 General conventions

Use UUID identifiers, UTC timestamps, explicit enums or constrained text, database migrations, and integer copy quantities. Store monetary estimates as decimal values with currencies, never binary floating-point money. Keep provider numbers that may contain letters as strings.

Every private row must be directly or transitively owned by a user. Derive the authenticated owner server-side; never trust a `user_id` in a request body. Apply ownership checks in every query, background operation, signed URL, export, and object lookup.

### 11.2 Required tables

| Entity | Essential fields | Integrity rule |
| --- | --- | --- |
| `users` | id, auth issuer/subject, settings, created_at | Unique issuer/subject. |
| `binders` | id, owner_id, name, archived_at | All moved lots belong to the same owner. |
| `catalog_snapshots` | id, source, source_timestamp, checksum, status | Atomic active-snapshot selection. |
| `card_identities` | id, provider_identity_id, names | Identity is not a printing. |
| `card_printings` | id, provider_id, identity_id, set_code, collector_number, language, source_json | Unique provider ID; preserve original metadata. |
| `card_faces` | id, printing_id, face_index, image_ref, layout | Unique printing/face index. |
| `reference_features` | face_id, model_version, crop_kind, vector, checksum | Versioned features; no mixed embedding spaces. |
| `pack_profiles` | id, version, allowed_hint_sets, source_notes | Hints retain their provenance. |
| `scans` | id, owner_id, binder_id, processing_state, resolution_state, policy_snapshot, expected_count, revision | One durable scan identity. |
| `scan_images` | id, scan_id, immutable_object_ref, sha256, width, height, capture_path, expires_at | Cannot be replaced after acceptance. |
| `observations` | id, scan_id, image_id, polygon, region_revision, state, version, current_attempt_id | Stable physical-observation identity. |
| `recognition_attempts` | id, observation_id, versions, quality, OCR, candidates, p_identity, p_exact, reasons | Immutable attempt record. |
| `review_decisions` | id, observation_id, reviewer_id, decision, expected_version, created_at | Auditable manual override. |
| `inventory_lots` | id, owner_id, binder_id, printing_id, finish, condition, quantity_remaining, notes, acquisition fields, source_metadata, source_observation_id, source_import_row_id, version | At most one original lot per source observation or import row; nullable source keys distinguish manual lots. |
| `inventory_events` | id, lot_id, scan_id, import_id, event_type, delta, before_json, after_json, idempotency_key | Append-only audit and replay protection. |
| `imports` | id, owner_id, immutable_file_ref, checksum, format, adapter_version, mapping, preview_revision, state, summary | Confirmed selection/mapping immutable during commit; no inventory writes during preview. |
| `import_rows` | id, import_id, row_number, raw_fields, normalized_fields, printing_id, quantity, status, decision, version | Unique import/row number; stable source identity, retained errors and unresolved rows. |
| `exports` | id, owner_id, format, schema_version, scope, snapshot_ref, state, object_ref, checksum, expires_at | Owner-scoped snapshot and private expiring output; disclose unrepresentable fields. |
| `jobs` | id, owner_id, scan_id/import_id/export_id as applicable, kind, state, attempt_count, lease_until, error_code | Database-authoritative execution status; foreign keys and checks require the correct owner/resource for each kind. |
| `outbox_events` | id, aggregate_id, payload, published_at | Replayable dispatch intent. |
| `idempotency_records` | owner_id, route, key, request_hash, response_ref | Same key plus different request body is a conflict. |
| `price_snapshots` | printing_id, finish, source, currency, amount, source_time, fetched_at | Missing price stays null. |
| `model_registry` | model/index/calibration versions, qualified_buckets, evaluation_ref, enabled | Only explicitly qualified combinations auto-add. |

Use extra tables as needed for OAuth sessions, notifications, data-deletion tasks, and export snapshots. Do not substitute opaque JSON for all relational integrity. Raw imported fields may use structured JSON for preservation, while quantities, printing references, ownership, source keys, and mutation state retain database constraints.

### 11.3 Inventory lot semantics

A scanned observation creates a lot of quantity one. A manual or CSV import can create a larger lot. Collection views aggregate lots by printing, language, finish, condition, and binder; users may expand them to inspect provenance.

Finish is an extensible normalized field. At minimum support `unknown`, `nonfoil`, `foil`, and `etched` where the provider permits them. Preserve provider-specific treatment detail separately; do not collapse every premium treatment into one generic foil SKU.

Condition values start with `ungraded`, `NM`, `LP`, `MP`, `HP`, and `damaged`, with a clear indication that user assessments are not professional grading. Store metadata origin, such as user-selected versus catalog-constrained.

### 11.4 Required constraints and transaction pattern

Implement an owner-scoped idempotency key, uniqueness constraints on non-null `source_observation_id` and `source_import_row_id`, nonnegative remaining quantity, valid state transitions, and optimistic version checks for review/correction. An original lot cannot have both source keys. Imported rows use the same inventory service and audit rules as scans.

```text
BEGIN
  lock scan and observation rows
  verify owner, scan not cancelled/undone, observation version
  verify policy result and catalog reference are still applicable
  return existing committed result when source observation already has a lot
  insert inventory lot with quantity 1
  append ADD_SCAN inventory event with unique operation key
  update observation state and version
  write notification/outbox event if needed
COMMIT
```

The lock order must be consistent across auto-add, review, cancel, and undo to reduce deadlocks. Retry serialization/deadlock errors safely with the same operation key.

### 11.5 Corrections, removal, and undo

A correction changes the classification of the existing lot, records before/after metadata, and increments its version. It does not add quantity. Manual decisions take precedence over stale worker attempts.

Batch undo marks the batch as no longer accepting additions and reverses remaining inventory effects associated with that batch. Preserve already-consumed/removed quantities and report conflicts rather than driving totals negative. Never subtract arbitrary matching copies from unrelated batches.

---

## 12. API contracts

### 12.1 Common rules

Use `/api/v1`, JSON responses, documented error codes, and generated OpenAPI. Authenticate every private endpoint. Require an `Idempotency-Key` for mutating operations that can be retried. Use `If-Match` or an explicit `expected_version` for edits with race potential.

Common errors include `401` unauthenticated, `403` unauthorized, `404` not found, `409` conflict/version mismatch, `413` file too large, `415` unsupported type, `422` invalid input, and `429` rate limited. Do not reveal another user's resource through detailed authorization errors.

### 12.2 Endpoint inventory

| Method and path | Purpose | Important behavior |
| --- | --- | --- |
| `GET /catalog/search` | Search public catalog. | Paginated; no private collection data. |
| `GET /catalog/printings/{id}` | Retrieve printing and faces. | Return snapshot/source provenance. |
| `POST /scans` | Create scan with policy and binder choice. | Return scan ID and revision. |
| `POST /scans/{id}/uploads` | Create bounded upload intent. | Owner-bound temporary key and expiry. |
| `POST /scans/{id}/finalize` | Validate upload reference and accept work. | `202` only after durable job/outbox write. |
| `GET /scans/{id}` | Retrieve current state and summary. | Safe after refresh or reconnect. |
| `GET /scans/{id}/observations` | Retrieve region results. | Paginated if needed; include versions. |
| `POST /scans/{id}/regions` | Add a missed region. | Reject duplicate spatial associations; new revision. |
| `PATCH /observations/{id}/region` | Correct a crop before or through review. | No silent re-creation of already-added copies. |
| `POST /observations/{id}/decision` | Accept candidate, choose another, or exclude. | Expected version and transactional inventory effect. |
| `POST /observations/{id}/closeups` | Add a targeted close-up. | Same observation, never a second copy. |
| `POST /scans/{id}/retry` | Retry eligible failed work. | Preserve accepted and manually resolved items. |
| `POST /scans/{id}/cancel` | Stop future processing/commits. | Existing additions remain visible. |
| `POST /scans/{id}/undo` | Reverse remaining batch inventory effects. | Atomic state change plus audited lot effects. |
| `DELETE /scans/{id}/images` | Delete photos/crops, retain chosen inventory. | Cancel image-dependent work as needed. |
| `GET /collection` | Search holdings. | Owner-scoped aggregation and pagination. |
| `POST /collection/lots` | Manually add a lot. | Explicit quantity and metadata. |
| `PATCH /collection/lots/{id}` | Correct, move, or adjust a lot. | Versioned audit event. |
| `GET/POST /binders` | List/create binders. | Owner-scoped. |
| `PATCH /binders/{id}` | Rename/archive binder. | No cross-owner movement. |
| `POST /imports/csv` | Store bounded CSV and queue a preview job. | `202` after durable file/job acceptance; no inventory writes until confirmation. |
| `GET /imports/{id}` | Retrieve mapping, counts, transfer state, and preview revision. | Owner-scoped; available after reconnect. |
| `GET /imports/{id}/rows` | Page through resolved, ambiguous, rejected, and committed rows. | Preserve source row numbers and reasons. |
| `PATCH /imports/{id}` | Set format, column/binder mapping, or explicit defaults and rebuild preview. | Expected version; invalidates earlier preview confirmation. |
| `PATCH /imports/{id}/rows/{row_id}` | Resolve or skip a row. | Owner check and expected version; cannot rewrite a committed effect. |
| `POST /imports/{id}/commit` | Queue commit of reviewed rows. | `202` after durable acceptance; exact preview revision/selection and idempotent row effects. |
| `POST /imports/{id}/undo` | Reverse remaining effects from an import. | Stops future commits; leaves prior unrelated holdings unchanged. |
| `POST /exports` | Queue owner-scoped canonical/ManaBox/error-report export. | Durable job plus fixed scope and logical snapshot; never a public file. |
| `GET /exports/{id}` | Retrieve export state and losses/warnings. | Owner-scoped, independent of active browser connection. |
| `GET /exports/{id}/download` | Fetch a completed export or short-lived download authorization. | Re-check ownership and expiry; no reusable public URL. |
| `GET /jobs/{id}` | Retrieve owned import/export task state. | No broker details exposed. |
| `GET/PATCH /settings` | Get/change scan preferences. | Threshold and privacy changes audited. |
| `DELETE /account` | Request authenticated account deletion. | Reauthentication and deletion lifecycle. |

### 12.3 Create-scan request example

This is a schema illustration, not a real product, pricing, or catalog record.

```json
{
  "binder_id": "11111111-1111-4111-8111-111111111111",
  "mode": "pack",
  "expected_count": 15,
  "set_hint": null,
  "pack_profile_id": null,
  "auto_add_requested": true,
  "threshold": "0.92",
  "finish_default": "unknown",
  "condition_default": "ungraded",
  "require_known_finish": false
}
```

The server snapshots and enforces allowed settings. A client cannot bypass a disabled model registry, lower the approved threshold, or declare its own confidence.

### 12.4 Observation response example

All identifiers and measurements below are illustrative fixtures.

```json
{
  "observation_id": "22222222-2222-4222-8222-222222222222",
  "version": 3,
  "region_index": 8,
  "state": "NEEDS_REVIEW",
  "polygon_normalized": [[0.10, 0.10], [0.20, 0.10],
                         [0.20, 0.30], [0.10, 0.30]],
  "selected_printing_id": "33333333-3333-4333-8333-333333333333",
  "p_identity": "0.995",
  "p_exact": "0.874",
  "reason_codes": ["PRINTING_AMBIGUOUS", "FOOTER_UNREADABLE"],
  "finish": "unknown",
  "condition": "ungraded",
  "inventory_lot_id": null,
  "versions": {
    "catalog": "fixture-catalog-1",
    "recognizer": "fixture-model-1",
    "calibration": "fixture-calibration-1"
  }
}
```

### 12.5 Error shape

```json
{
  "error": {
    "code": "OBSERVATION_VERSION_CONFLICT",
    "message": "This card changed since you opened it. Refresh its result.",
    "retryable": false,
    "request_id": "44444444-4444-4444-8444-444444444444"
  }
}
```

Generate a frontend API client from the backend OpenAPI contract. Keep examples, types, and tests synchronized. Avoid separate handwritten interpretations of the confidence policy in the browser and worker.

---

## 13. Collection import, export, and interoperability

### 13.1 Required formats and mobile flow

Collection migration is a first-release feature independent of recognition qualification. Ship these paths in the phone web interface:

| Format | Import | Export | Qualification |
| --- | --- | --- | --- |
| App canonical CSV v1 | Required. | Required for all holdings or selected binders. | Round-trip supported collection fields without quantity or metadata drift. |
| ManaBox collection CSV | Required adapter with detected-header confirmation. | Required target-compatible CSV, with a loss report and explicit choices for unsupported fields. | Real authorized export fixtures plus actual import into the recorded ManaBox app version. |
| Generic CSV from similar tools | Required column mapper, delimiter/encoding preview, and explicit defaults. | Canonical CSV available for users to map into the destination tool. | Representative fixtures; named compatibility only after format-specific testing. |

ManaBox documents whole-collection and individual-binder CSV exports. Its import can use a Scryfall ID or card name plus set information and supports additional collection properties. That documents the exchange route, not exact compatibility of an untested adapter. [S23]

The flow is **select file -> durable upload -> server preview -> confirm mapping and rows -> background commit -> summary/undo**. Parsing, catalog resolution, validation, and large exports run in bounded server jobs. Preview and commit progress survive closing the phone browser; final commit always requires an explicit user action in the product. Do not import a wishlist or non-owned list into owned inventory without a deliberate mapping choice. App-specific binary/cloud backups and ongoing bidirectional sync are outside Version 1.

### 13.2 Canonical collection format

Document a versioned CSV schema with at least `schema_version`, `quantity`, `scryfall_id`, `name`, `set_code`, `collector_number`, `language`, `finish`, `condition`, `binder`, and `notes`. Include supported acquisition fields (`purchase_price`, `purchase_currency`), misprint/altered flags, and a versioned `source_metadata_json` extension for retained source properties. Use explicit representations for null, unknown finish, and ungraded condition. Store collector numbers as strings; keep decimal purchase prices and currencies separate from current market estimates.

Export stable identifiers alongside readable names. Round-trip supported holdings and preserved source metadata into a fresh collection; this transfer format does not restore accounts, photo files, scan history, or all inventory events. Full deployment backup/restore is a separate operator feature. Give unresolved import rows a separate recoverable error/repair export so they cannot vanish from an apparently complete migration.

### 13.3 ManaBox adapter and generic mapping

Use the documented identity, quantity, finish, language, condition, acquisition, and flags fields as the starting mapping. Inspect current authorized ManaBox CSVs for exact headers, binder/list fields, escaping, enum values, and empty-value semantics. Record the app version, observed schema, fixture provenance, and adapter version in `docs/IMPORT_FORMATS.md`; these samples have not yet been supplied. Preserve extra columns in source metadata instead of silently discarding them. [S23]

Resolve printings in this order:

1. Valid printing-level Scryfall ID, checked against any conflicting set/language metadata in the row.
2. Exact set code plus collector-number string plus language, when uniquely resolvable in the catalog.
3. Name and available set/printing metadata to generate review candidates.

Missing or conflicting identifiers, multiple possible printings, and unsupported enums require review. Never select the first same-name printing, convert a missing foil value to nonfoil, equate etched with ordinary foil, or default missing condition to Near Mint. A missing language can be derived from an authoritative printing ID; otherwise retain unresolved metadata or ask for an explicit import default. Column mapping does not turn ambiguous data into an exact match.

Preview a sample and overall counts: source rows, physical copies, eligible/ambiguous/rejected rows, binder mappings, proposed quantity deltas, metadata losses, and ignored fields. Require a valid positive integer quantity for a committed row. When a format omits quantity, a default of one must be shown and explicitly accepted. Preserve distinct source rows and legitimate repeated copies rather than deduplicating by card name or printing ID.

### 13.4 Safe commit, retries, and undo

Store the source file, its owner-scoped hash, parsed row numbers, adapter version, mapping, and preview revision. Confirmation freezes a reviewed selection and its revision; stale confirmation returns a conflict and a refreshed preview. Default behavior adds the selected copies to existing holdings. Do not offer implicit replacement of an existing collection; wholesale replacement is outside Version 1.

Commit in bounded transactions through the inventory service, using the stable import-row ID as the unique source key. Record each lot and audit event in the same transaction that marks its row committed. A retry after a worker crash or repeated confirmation must return the existing effect. The job may report partial completion during processing; its summary must reconcile committed, skipped, unresolved, and failed rows and quantities. Users may explicitly commit valid rows while preserving remaining rows for correction.

Warn when the same owner re-uploads an already imported file and offer the existing import history. A file hash is not proof that identical rows represent the same physical cards. Recording another purchase from the same file requires an explicit new-import choice. Undo sets an import cancellation barrier before reversing its remaining lot effects; it must not remove matching cards from unrelated inventory or allow later retries to add more copies. Do not delete provenance needed for retry protection and undo while affected inventory/history exists.

### 13.5 Exports, limits, and compatibility evidence

Generate exports from a consistent database snapshot at job start, record the timestamp and scope, and stage the snapshot server-side when needed for pagination. Collection edits during generation must not produce skipped/duplicated rows. Export complete holdings by default, with deliberate options for binders/filters; show the total physical-copy count and format limitations before download. Regeneration after expiry is supported from current data and is labeled with its new snapshot time.

For ManaBox output, verify that destination import preserves the supported identifiers, quantities, finish, language, and condition. Test binder behavior separately; document required destination-side binder selection if the target does not honor a binder column. Unknown finish, ungraded condition, notes, and other unrepresentable fields must produce explicit choices or exclusions and a companion loss report, never silent fabricated defaults. Keep a complete canonical export available. “ManaBox compatible” requires actual destination tests; a file with plausible headers is insufficient.

Handle UTF-8, BOMs, quoted commas, embedded newlines, punctuation, duplicate/unknown headers, and malformed rows. Bound file bytes, row/column counts, field lengths, JSON nesting, parsing memory, and execution time; report the configured limits before upload. Never evaluate formulas. Prevent spreadsheet-formula injection in exported user-controlled cells with a documented reversible canonical escaping rule; test formula-like notes, leading apostrophes, Unicode, and round trips. Target-format escaping needs separate compatibility tests and a loss warning when necessary.

Keep transfer files private, owner-scoped, and out of logs. Starting retention is 7 days for raw import uploads after a terminal job state and 24 hours for generated export downloads. Retain necessary normalized/source row data and provenance under collection/account deletion rules; explain that raw-upload expiry does not erase retained imported records. Active jobs have bounded retention protection as in Section 10.4. Keep imports/exports on bounded queues or reserved worker capacity so a large migration cannot indefinitely starve scans.

---

## 14. Dataset, model evaluation, and calibration

### 14.1 Required real-photo dataset

Build a consented dataset of real tabletop photos, not just clean reference images pasted into a grid. A suggested initial collection target is at least **600 source photos** across devices, layouts, lighting, card counts, and difficult cases. This is a planning target, not proof of statistical sufficiency.

Include 1-6, 7-10, 11-15, 16-20, and 21-24 count buckets. Include repeated physical printings, same-art reprints, full-art lands, sleeves, glare, rotated cards, partial crops, empty tables, other games, token/ad inserts, unusual treatments, non-English cards, and unsupported examples.

Store verified annotations: polygons, physical-instance IDs, identity, printing/language, visible face, finish when independently established, occlusion/quality, and whether exact printing is actually resolvable from that image. Unresolvable examples must remain ambiguous in evaluation.

### 14.2 Split discipline

Create separate training, calibration, and final test partitions. Split by capture session and physical-card group; do not scatter near-identical crops or augmentations across partitions. Include device and set/treatment stress partitions.

Reference-catalog images are the retrieval gallery, not a replacement for test photographs. Clearly distinguish gallery access from fitting on test observations. Hold back some identities from ranker training while leaving their reference images available for retrieval, and separately test items absent from the catalog.

Do not tune the threshold repeatedly on the final test set. Record dataset hashes, annotation revisions, random seeds, code version, and exclusion rules. Reviewer corrections used for training require consent and an ingestion review; they are not automatically trusted labels.

### 14.3 Metrics

Report detection precision/recall at a documented polygon-overlap criterion; duplicate-region rate; missed-card count per photo; retrieval recall at K; identity accuracy; exact-printing/language accuracy; auto-add precision; auto-add coverage; review rate; unknown-card rejection behavior; finish completeness; processing latency; and cost per accepted scan.

Calibration reporting must include reliability bins and sample counts, Brier score or an equivalent proper scoring metric, and observed error among auto-added results. Report per device/capture path/count bucket and important difficult categories. A pooled average cannot conceal a failing baseline phone.

Use uncertainty intervals. Because observations in one photo can share blur, glare, and layout conditions, report photo/session-clustered uncertainty rather than treating every crop as fully independent. Small segments are “insufficient evidence,” not automatically passed.

### 14.4 Proposed release gates

These are owner-approval targets, not achieved results.

| Area | Initial gate | Consequence of failure |
| --- | --- | --- |
| Auto-add correctness | At least 99.5% observed exact-printing/language precision, plus a one-sided 95% lower bound of at least 99.0% under the deployed policy. | Keep category manual-only or revise policy with approval. |
| Evidence volume | At least 1,000 auto-added test observations overall, with adequate device/count/category representation and reported uncertainty. | Collect more evidence; no broad claim. |
| Qualified subgroups | No failing subgroup hidden by the pooled metric. | Disable auto-add for that subgroup. |
| Pack usability | At least 80% auto-add coverage on clean qualified 15-card photos, measured over all annotated card observations, not only detected ones. | Improve pipeline; do not relax correctness to hide review burden. |
| Detection | At least 98% recall on fully visible supported cards in the primary test subset, plus reported false positives and count errors. | Improve detection/recovery before broad release. |
| Inventory integrity | No duplicate side effects in retry/race tests; no silent loss or negative quantities. | Block release. |
| Unknowns | Unsupported/absent-catalog examples do not pass auto-add in the acceptance suite. | Block affected policy/model. |
| Privacy/security | No cross-owner data access in the test suite; retention/deletion pass. | Block release. |

Coverage and precision must be reported together. A scanner that auto-adds almost nothing can have high precision without delivering the promised workflow.

The interval criterion and sample-size target are independent requirements. Meeting a round sample count does not automatically meet a confidence bound. Use exact-binomial or Wilson calculations as a secondary check and cluster-aware analysis for the release report.

### 14.5 Threshold qualification

Test the owner's requested threshold of 0.92 as written. Most qualifying predictions may lie far above it. When the high-confidence region is not well calibrated or has inadequate samples, keep auto-add off even if a plot looks favorable.

Version the calibration alongside the ranker, detector assumptions, image preprocessing, reference index, and supported buckets. A new model, OCR engine, or preprocessing change requires regression evaluation and may require recalibration.

---

## 15. Acceptance test matrix

Implement these tests as automated tests where possible and documented physical-device tests where necessary. Fixture probabilities are for policy testing only; they do not establish recognition accuracy.

| ID | Scenario | Required result |
| --- | --- | --- |
| A01 | Qualified result with `p_exact = 0.93`, all gates true. | Exactly one auto-added copy. |
| A02 | `p_exact = 0.92` exactly. | Review. |
| A03 | `p_exact = 0.9199`. | Review. |
| A04 | High raw similarity without a qualified calibration. | Review; no percentage misrepresented as probability. |
| A05 | Identity certain, same-art printing ambiguous. | Printing review. |
| A06 | OCR set/number contradict artwork. | Review, regardless of high score. |
| A07 | Unknown finish in normal mode. | Eligible printing may add; finish remains unknown and valuation incomplete. |
| A08 | Unknown finish in strict mode. | Review. |
| A09 | User chooses a finish absent from allowed metadata. | Review/validation error, not forced conversion. |
| A10 | Two physical copies of the same printing in one image. | Quantity increases by two. |
| A11 | Two detection boxes describe one physical card. | One observation after reconciliation; one addition. |
| A12 | Worker crashes after commit but before acknowledgement. | Retry returns existing effect; quantity unchanged. |
| A13 | User taps confirmation twice. | One effect and consistent response. |
| A14 | Reviewer and worker race. | One winning version; manual decision is not overwritten by stale work. |
| A15 | Close-up resolves an already tracked observation. | Existing copy updated; no extra copy. |
| A16 | Same file is uploaded as an accidental new batch. | Warning/reconciliation; no silent repeat addition. |
| A17 | User explicitly records genuinely new copies. | Separate audited batch allowed. |
| A18 | Main-set hint with a bonus-sheet card. | Correct candidate remains reachable. |
| A19 | Expected count differs from detected count. | Persistent mismatch warning; missing cards not invented. |
| A20 | A card is missed by detection. | User can add its region and process it once. |
| A21 | Glare obscures the footer. | Name may be suggested; exact printing reviewed when needed. |
| A22 | More than 24 plausible regions. | Explain overflow and request split; no silent first-24 completion. |
| A23 | Ad, generic card back, or another game's card. | Exclude when certain; otherwise unknown/review; never forced MTG match. |
| A24 | Double-faced card shown from either face. | Correct physical printing candidate; one copy per observation. |
| A25 | Non-English/unsupported category not qualified. | Review rather than inheriting English qualification. |
| A26 | Browser closes before upload completes. | No claim of durable processing; resume/retry path on return. |
| A27 | Browser closes after accepted upload. | Server completes; results available on return. |
| A28 | Queue publication fails after database commit. | Outbox retries; job is not lost. |
| A29 | One crop fails during a pack scan. | Other valid observations remain processed and visible. |
| A30 | Cancel races with a pending addition. | Scan lock/version prevents post-cancel commits. |
| A31 | Undo races with a worker retry. | No additions after undo; prior unrelated holdings preserved. |
| A32 | Lot was already partly removed before batch undo. | Undo remaining effect only; no negative quantity. |
| A33 | A user's ID is substituted in image/result/export requests. | No cross-owner access. |
| A34 | Corrupt file, MIME mismatch, huge decoded image, expired upload. | Bounded failure with no unsafe processing. |
| A35 | User reuses an idempotency key for a different body. | Conflict, not a second operation. |
| A36 | A signed temporary upload is overwritten after finalization. | Immutable accepted object version is unaffected. |
| A37 | Provider/catalog sync fails. | Last good snapshot remains active; stale status shown. |
| A38 | Price missing or finish unknown. | Unknown value and coverage count; not zero or false live value. |
| A39 | CSV retry, unknown printing, formula-like notes. | No duplicate import; ambiguous preview; safe export. |
| A40 | Retention expires or user deletes images. | Photos/crops removed; retained batch metadata remains understandable. |
| A41 | Account deletion with queued jobs. | Jobs cannot recreate deleted data; storage cleanup verified. |
| A42 | Probabilities are null, out of range, NaN, or exact exceeds identity. | Review/fail closed with logged validation reason. |
| A43 | Phone returns only a small video-frame capture. | Actual dimensions recorded; quality gate can request fewer cards. |
| A44 | Catalog/model changes during processing. | Pinned scan versions or explicit controlled restart; no mixed-version decision. |
| A45 | Keyboard/screen-reader review and expired photo. | Usable navigation, clear state, no inaccessible color-only result. |
| A46 | After `202`, put the phone in airplane mode, close the browser, and power it off. | Server completes or records an actionable failure; returning from another authenticated device retrieves saved results without resubmission. |
| A47 | Finalization commits, but its HTTP response is lost. | Status lookup or same-key retry returns the original accepted scan/job; no extra inventory. |
| A48 | Broker data is lost after outbox publication; no browser is polling. | Server reconciler republishes unfinished jobs; all effects remain idempotent. |
| A49 | Worker/API containers are recreated or the host restarts after acceptance. | Persisted scan, objects, jobs, and committed results survive; work resumes without the phone. |
| A50 | Login session expires during an accepted job. | Processing continues with server-owned inputs; reauthentication reveals results. Explicit account deletion still stops writes. |
| A51 | Retention cleanup runs while accepted work is queued or retried. | Needed input survives until bounded completion/deadline; terminal failure is saved before eligible cleanup. |
| A52 | Large photo and large collection on the oldest target phones. | Bounded previews/pagination, responsive review and upload, no required client OCR/model/full-catalog download. Record physical-device results. |
| A53 | Import an authorized current ManaBox export with multiple binders and repeated copies. | Preview and committed totals match; identities and supported metadata survive; unknown fields and non-owned lists are accounted for. |
| A54 | Import worker crashes after a row commit; confirmation is retried or the file re-uploaded. | Stable row effects prevent duplicate copies; repeat file is flagged with existing import history. |
| A55 | Imported printing is ambiguous, finish/condition is missing, or quantity is invalid. | Row is flagged with an actionable reason; no first-match printing or invented metadata; no mutation before confirmed choices. |
| A56 | Canonical export/reimport includes unknown metadata, Unicode, quoted newlines, and formula-like notes. | Supported fields, notes, source metadata, and copy totals round-trip; export remains spreadsheet-safe. |
| A57 | Export runs while other sessions edit holdings. | Output matches its recorded logical snapshot and scope; no skipped/duplicated rows. |
| A58 | Import undo races with a retry, after some imported copies were moved/removed. | No further additions, no negative quantities, and no removal of unrelated holdings; conflicts are reported. |
| A59 | A different account requests import rows, jobs, or export download; download has expired. | No cross-owner access; expiry is enforced without disclosing private contents. |
| A60 | Export to ManaBox and import into the documented app version. | Supported identifiers, copy counts, and metadata survive; binder behavior and any losses are documented and shown before export. |
| A61 | Clean Linux host has Docker/Compose but no app runtimes or paid service credentials. | Documented setup starts the complete stack; provisioning and private phone access work over trusted HTTPS. |
| A62 | Compose upgrade and backup restore into a fresh stack. | Collections, provenance, private assets, configuration, and identity linkage restore; pending work resumes without duplicate additions. |
| A63 | Generic CSV headers differ from known adapters or contain unsupported fields. | Mobile mapping preview works; unresolved data is preserved; app-specific compatibility is not claimed without tests. |
| A64 | Import preview mapping/rows change after confirmation was prepared. | Stale revision rejected; no unreviewed quantity or binder changes are committed. |
| A65 | Required release packaging is checked. | Source-available/non-commercial license, third-party notices, reproducible images, setup, migration, recovery, and contribution guidance are present. |

---

## 16. Security, privacy, and rights

### 16.1 Authentication and access control

Use a maintained identity provider. Validate issuer, audience, signature, expiry, and session state at the trusted backend. Protect cookie-authenticated mutations against CSRF. Use secure, HttpOnly cookies where applicable; configure CORS narrowly. Never accept a browser-supplied role or owner ID as authority.

Require elevated authorization for model activation, production feature flags, retention settings, and catalog imports. Avoid routine staff access to user photographs; any support access needs an auditable policy.

### 16.2 Upload and storage controls

Use private buckets and short-lived, owner-scoped upload/download authorizations. Generate object keys server-side. Bind upload limits and expected type where supported, and revalidate on the server.

Finalize an immutable object version. A reusable temporary signed upload must not permit the bytes of an accepted scan to change later. Either pin a storage version or copy verified bytes to a final server-only key and process that reference.

Use allowlisted external catalog/image hosts. Do not let user-provided image URLs become arbitrary server-side fetches. Keep raw images and OCR payloads out of normal logs. Security principles and file validation must be reviewed against OWASP's upload guidance. [S15]

### 16.3 Starting retention policy

Delete abandoned temporary uploads after **24 hours**. Retain normalized scan photos and close-up crops for **7 days** by default. Retain detailed OCR/candidate diagnostic payloads for **30 days**, then keep only the minimal chosen-result, version, and decision provenance needed for inventory history.

Users can delete images earlier without deleting accepted collection entries. Account deletion overrides normal retention and prevents workers from recreating data. Document backup expiration and deletion propagation separately; do not promise instantaneous erasure from all backups when the infrastructure cannot provide it.

Do not use user photos or corrections for model training without separate opt-in consent. Training storage must be separated from operational retention and support consent withdrawal procedures.

### 16.4 Intellectual property and commercial use

Use original UI and branding. Do not copy ManaBox source code, proprietary models, artwork packaging, or interface assets. Do not claim affiliation with Wizards, Scryfall, or ManaBox.

Before public release, verify data-source terms, image use, reference-image storage, model/dataset licenses, attribution, and trademarks. Scryfall's indexed API terms restrict paywalling its data; Wizards' Fan Content Policy also contains access and commercialization conditions. These policies are not blanket permission for every paid application or training use. Obtain appropriate review before monetization or claims of authorization. [S19][S20]

Keep a source/license register covering code libraries, pretrained weights, reference images, and training photographs. A software library's license does not automatically settle the rights to model weights or artwork used with it.

### 16.5 Source-available, non-commercial GitHub release

The owner explicitly chose **source-available distribution with commercial reuse prohibited**. Public source visibility and a free download do not by themselves establish an open-source license. The Open Source Initiative's definition permits business use, so a license that forbids commercial reuse must be described accurately as source-available. [S24]

The September 23 source-publication update applies the unmodified **PolyForm Noncommercial License 1.0.0** in [LICENSE](../LICENSE), with [NOTICE](../NOTICE) and [third-party notices](../THIRD_PARTY_NOTICES.md). Those terms govern the intended noncommercial use, inspection, modification and redistribution; commercial use is not licensed. Do not silently substitute MIT, Apache, GPL or AGPL as though they prohibit commercial reuse.

Review dependency, model, and asset distribution compatibility with that restriction during M0, before choosing implementation components. Keep third-party notices and licenses separate and intact; the project's chosen license cannot replace the rights attached to dependencies, card data/artwork, or user photos. Publish code and only redistributable assets in GitHub and container images. Fetch other permitted catalog/model resources through documented setup steps; never bundle real private collections or photos as demo fixtures.

Before public release, provide `LICENSE`, `THIRD_PARTY_NOTICES.md`, `CONTRIBUTING.md`, `SECURITY.md`, release notes, issue templates, and contributor instructions that state the non-commercial terms. Build versioned container images from tagged source, record their provenance/dependencies, and run the Docker installation and migration checks in CI. Publish only after refinement and the release gates; preparing these files does not itself authorize creating a public repository or publishing images.

---

## 17. Performance and cost budgets

### 17.1 Initial service objectives

Use the following as implementation targets to benchmark and revise, not as published promises: after an accepted upload, first useful results within a median of approximately 5 seconds; a qualified 15-card job within a median of approximately 15 seconds and a 95th percentile of approximately 30 seconds on the documented test configuration.

Report upload time separately. Also report queue wait, decode/detection, retrieval, OCR, policy, and commit time. Test concurrency levels of 1, 5, and 10 scans and record hardware, worker count, memory, and CPU/GPU use. If targets fail, report measured results and bottlenecks rather than disguising queue time.

### 17.2 Starting resource experiment

Begin with a documented CPU-only worker experiment, for example 4 vCPU and 8 GB RAM, and measure. This is not a guaranteed production size. Load models once per worker, bound concurrent decodes/OCR tasks, and avoid multiplying model memory by uncontrolled process counts.

Add GPU inference only when measured throughput/cost requires it. Keep CPU and GPU model outputs regression-tested. The project must run without a paid general-purpose AI call per card in the baseline design.

### 17.3 Cost model

Track cost per scan, per detected card, and per correctly auto-added copy. Include compute, object storage, requests, network transfer, database, authentication, monitoring, and support. Image bytes and retention often matter as much as inference time.

```text
approximate worker cost per scan
  = billed worker time allocated to scans * worker hourly cost / 3600

approximate photo storage
  = scans per day * average retained bytes * retention days

cost per correctly auto-added copy
  = attributable operating cost / correctly auto-added copies
```

Do not hard-code current hosting prices into the application. Obtain current quotes when selecting deployment, and keep operational estimates separate from performance claims.

### 17.4 Backpressure

Limit concurrent jobs per user and per worker. Start with two active processing jobs per account and a small bounded queue, configurable by deployment. Return a clear capacity message when limits are reached. Rate-limit upload intents, search, imports, and expensive retries.

---

## 18. Observability, administration, and recovery

Use structured request/job/scan/observation IDs. Monitor accepted-upload failures, queue depth, oldest-job age, worker heartbeats, processing-stage latency, failed crops, review reasons, user corrections, auto-add rate, catalog freshness, and image-retention backlog.

Break recognition metrics down by model version, calibrated bucket, and capture path. Changes in correction rate or review reasons should trigger investigation; they do not prove the true error rate because users may not inspect every result. Periodic audited samples are necessary.

Provide an admin view for failed jobs, last catalog import, active model/calibration pairs, qualification reports, and global/per-bucket auto-add kill switches. A kill switch must stop future automatic commits without destroying queued observations or accepted inventory.

Persist coordinated backups of PostgreSQL, private object storage, required configuration/secrets, and authentication-provider state. Record catalog/model versions and which caches/indexes can be rebuilt. Test restoration into a fresh Compose deployment, including inventory/import provenance and accepted jobs whose broker messages no longer exist. A CSV collection export is useful portability, not a complete server backup. Version model artifacts and keep the previous validated deployment available. Do not change database schemas in a way that prevents rollback without a documented migration plan.

Required runbooks: stuck queue; storage failure; catalog unavailable; model regression; duplicate-add incident; image-deletion failure; credential rotation; backup restore; and disabling auto-add while preserving manual review.

---

## 19. Repository and developer deliverables

### 19.1 Target repository structure

The implementation developer must create these components. The current folder contains planning documents, not these application services or the policy assets mentioned in the original handoff.

```text
mtg-pack-scanner/
  apps/web/                  # Next.js UI and PWA
  services/api/              # FastAPI, auth, catalog, inventory, OpenAPI
  services/worker/           # Detection, retrieval, OCR, calibration
  services/transfers/        # Import/export adapters and jobs; shared backend image is sufficient
  packages/contracts/        # Generated API client and shared enums
  packages/policy/            # Single source of decision rules
  migrations/                # Versioned database changes
  infra/                     # Containers, deployment, reverse proxy
  scripts/                   # Catalog import, index build, evaluation
  tests/unit/
  tests/integration/
  tests/e2e/
  tests/fixtures/             # Clearly labeled synthetic/test-only data
    imports/                 # Authorized/redacted adapter fixtures with provenance
  evaluation/                # Dataset manifests and reproducible metrics
  docs/                      # ADRs, setup, API, privacy, runbooks
  .github/workflows/         # Checks, image builds, Compose smoke tests
  README.md
  LICENSE                    # Non-commercial source-available license selected before publication
  THIRD_PARTY_NOTICES.md
  CONTRIBUTING.md
  SECURITY.md
  .env.example
  compose.yaml
  Makefile
```

### 19.2 Required commands

Implement and document `make setup`, `make dev`, `make migrate`, `make seed-demo`, `make import-catalog`, `make build-index`, `make test`, `make test-e2e`, `make test-transfers`, `make evaluate`, `make backup`, and `make restore-test`, or equivalent clearly named commands. These invoke containerized tooling by default. Also document direct `docker compose` equivalents so normal installation/operation needs neither Make nor host Python/Node runtimes. Include startup, logs, worker restart, upgrade, and restore procedures. The current Makefile and Docker operation guide identify the commands already implemented; index/evaluation, coordinated backup/restore, and remaining release commands are still required work.

`seed-demo` must create obviously labeled synthetic fixtures and must never be the production data path. `evaluate` must produce a reproducible report from an explicit dataset manifest, model version, and policy configuration.

### 19.3 Required environment settings

Provide examples for public application URL, HTTPS/proxy configuration, database URL, broker URL, object-storage endpoint/bucket/region, authentication issuer/audience, catalog user-agent identity, catalog rate limit, image and CSV limits, retention, worker concurrency/queues, job deadlines/reconciliation interval, deployment auto-add switch, and model/calibration/index locations. Document named volumes, backup destinations, CPU defaults, and optional profiles.

No secret may be prefixed for public frontend exposure. Validate configuration at startup. A missing production auth or model setting must fail closed; do not silently activate development bypasses.

### 19.4 Completion package from the developer

Deliver source code; lockfiles; database migrations; container/deployment configuration and versioned images; environment template; operating instructions; API specification; automated tests; import-format mappings/fixtures and destination compatibility evidence; dataset/evaluation manifests; measured device report; calibration report; non-commercial source-available license and third-party register; privacy/retention behavior; runbooks; backup/restore evidence; and a requirement-by-requirement completion checklist.

State exactly what is implemented, what is mocked, what has been measured, and what remains unsupported. A styled camera screen connected to placeholder recognitions is not a finished scanner.

---

## 20. Build sequence and milestone gates

### M0. Validate foundations

Verify provider terms, source schemas, and compatibility with the chosen non-commercial source-available direction. Select containerized storage/authentication components and record current dependency versions. Establish the Compose foundation, HTTPS path, persistent volumes, and database-authoritative job recovery. Prove upload acceptance and disconnected completion with an explicitly labeled transport test before treating it as recognition evidence. Test real capture dimensions on the oldest target devices using both browser preview and native photo/upload paths. Collect authorized ManaBox CSV samples, define adapter mapping/fixtures, finalize the dataset plan, and agree on release metrics.

**Exit evidence:** architecture decisions, clean-host Compose setup/acceptance recovery checks, source/license register, device capture samples, import-format evidence plan, and an owner-approved definition of a supported scan. Missing physical-device/photo/CSV evidence is reported explicitly; infrastructure and migration implementation can continue without claiming those gates passed.

### M1. Build the recognition experiment

Run the recognition experiment in the worker container on the CPU baseline. Import a print-level reference subset. Detect separated cards in real photos. Implement crop normalization, artwork/full-card retrieval, name/footer OCR, candidate expansion, and an unknown outcome. Compare OCR-only, image-only, and hybrid baselines on the same photos.

**Exit evidence:** reproducible evaluation notebook or script, real sample results, error taxonomy, and retrieval/detection measurements. No automatic inventory writes yet.

### M2. Build the end-to-end manual-review slice

Implement auth, private storage, scan creation/upload/finalization, durable jobs, partial result retrieval, review UI, one-copy inventory lots, binder views, targeted close-ups, and idempotency. Route every recognition to review while the calibration gate is closed.

**Exit evidence:** one real photo can create correct reviewed inventory, survive phone disconnection, lost acceptance responses, broker loss and container restarts, and be undone. Results are retrievable after signing in on another device. Cross-owner access and duplicate-add tests pass.

### M2b. Deliver collection migration

Build the phone-accessible import/export flow, ManaBox adapter, generic mapper, canonical format, server preview/commit/export jobs, error repair, binder choices, audit history, and import undo. Recognition calibration is not a prerequisite for migration. Add repeat-import and partial-failure protection before anyone moves a real collection.

**Exit evidence:** authorized ManaBox export enters the app with verified quantities/metadata; canonical round-trip and tested ManaBox-target export pass; unsupported fields are reported; browser closure and worker retries preserve progress without duplicate copies. Record adapter/app versions, fixtures, and actual test outcomes.

### M3. Qualify recognition and confidence

Expand real-photo data. Fit the ranker/calibrator, document supported categories, and test the 0.92 policy. Improve the detector/retriever where the error analysis requires it. Evaluate exact printing separately from card-name success.

**Exit evidence:** locked evaluation report, uncertainty, supported-device/count buckets, and a model-registry entry. Unqualified categories remain review-only.

### M4. Enable gated automatic addition

Wire the qualified policy to transactional inventory. Complete cancel/undo races, correction history, unknown-finish behavior, price coverage, interactions with imported holdings, and the full acceptance suite. Keep the earlier migration functionality available regardless of auto-add qualification.

**Exit evidence:** acceptance results and an end-to-end pack flow with no fake confidence values. Auto-add is enabled only for qualified buckets.

### M5. Harden and release

Complete physical-device tests, accessibility, performance/load tests, clean-host Docker installation/upgrades, backups/restores, retention/account deletion, secrets handling, monitoring, runbooks, and rollback. Finish the source-available license prohibiting commercial reuse, third-party notices, contributor/security documentation, image build/release pipeline, and migration guide. Prepare the GitHub release and publish only supported claims after the owner's release decision.

**Exit evidence:** deployment from a clean Docker environment, migration compatibility report, release/license checklist, recovery rehearsal, and owner sign-off for publication.

### Phase 2. Extend after the baseline is proven

Potential additions: broader language qualification; 16-24-card auto-add qualification; better unusual-layout coverage; faster continuous single-card capture; geometric multi-photo sessions; optional push notifications; native camera integration; and deck-list export. Each extension has its own dataset and acceptance gate.

---

## 21. Risk register and practical mitigations

| Risk | What can go wrong | Required mitigation |
| --- | --- | --- |
| Tiny footer text | Correct name but wrong printing. | Per-printing uncertainty, close-up, no forced match. |
| Same artwork | Several printings are visually similar. | Candidate expansion and explicit ambiguity gate. |
| Capture limitations | Browser returns preview-sized pixels. | Inspect real dimensions; supported fallback and smaller layouts. |
| Foil/treatment ambiguity | Wrong SKU and valuation. | Unknown metadata or explicit user selection. |
| Missed card | User assumes the whole pack was counted. | Region overlay, count warning, add-region recovery. |
| Repeated physical copies | Dedup erases legitimate quantity. | Instance-based observations, not name/ID dedup. |
| Retried job | Collection quantity doubles. | Unique source observation and transactional idempotency. |
| New-set/index drift | Confidence degrades after updates. | Versioned snapshots, regression tests, per-bucket kill switch. |
| Account/image exposure | Photos or holdings leak. | Ownership checks, private objects, scoped URLs, security tests. |
| Rights restrictions | Business model conflicts with terms. | M0 review, license register, no unapproved monetization. |
| Too much review | Technically accurate but tedious. | Measure coverage and correction effort alongside precision. |
| Unrealistic scope | Team builds a general MTG platform first. | Milestone gates centered on real pack scanning. |

---

## 22. Developer/coding-agent handoff prompt

Use the following prompt with this complete document and any implementation/evaluation assets subsequently added to the repository:

```text
Build PakTrak as described in MTG_SCANNER_BUILD_INSTRUCTIONS.md.
Treat its requirements, confidence semantics, data-integrity rules, and
acceptance tests as authoritative.

First inspect the repository and current environment. Record architecture
choices and current dependency versions. Work through M0-M5 in order,
including M2b collection migration before recognition qualification.
Start with Docker foundations, real camera capture, durable acceptance,
and a measured recognition experiment. Check which assets actually exist.
Do not begin with a mock-only finished-looking frontend.

The product must process multiple separated MTG cards from one uploaded
photo. Primarily target phones four years old or newer at release, with
approximately 2022-and-newer hardware for the initial 2026 matrix. The
15-card target is subject to actual device/photo qualification. Do not claim that
this accuracy or card count has already been achieved.

Make Docker Compose the primary install, development, and release path.
Include persistent services, private storage, self-hosted authentication,
HTTPS documentation, CPU workers, and tested upgrade/backup/restore.
Do not require a paid cloud recognition service or host app runtimes.

Use hybrid image retrieval plus OCR. A raw OCR score, cosine similarity,
or weighted average is not a calibrated exact-printing probability.
Eligible results strictly above 0.92 may auto-add only after all policy
and qualification gates pass. Keep automatic addition disabled until
those gates are supported by real-photo evaluation.

Run durable recognition jobs on the server after upload acceptance.
Follow the Paperless-ngx interaction: the phone can disconnect or power
off after the server's durable acceptance confirmation. Processing,
retries, and recovery never depend on browser polling or login lifetime.
Test response loss, broker loss, container recreation, and host restart.
Preserve distinct physical copies. Retried jobs, repeated confirmation,
and targeted close-ups must not duplicate inventory. Use stable
observations, transactions, idempotency, and audited corrections/undo.

Keep finish unknown and condition ungraded unless explicitly established.
Provide review for ambiguous printings, missing regions, glare, unknown
cards, unsupported categories, and contradictions. Never fill a pack by
inventing matches. Show timestamped estimated prices, not invented live
quotes. Preserve null/unknown values.

Build phone-accessible collection import/export: tested ManaBox CSV,
canonical CSV round-trip, generic column mapping, server preview/commit,
unresolved-row repair, quantity/metadata preservation, and import undo.
Warn about target-format losses. Qualify compatibility with real fixtures
and destination tests; do not postpone migration until auto-add works.

Prepare a free source-available GitHub release with commercial reuse
prohibited. Select compatible license text and preserve third-party
licenses; do not label the restricted project as OSI open source.
Publication follows refinement and the owner's release decision.

Implement the actual API, database migrations, workers, private storage,
review UI, collection, imports/exports, privacy lifecycle, tests, and deployment
instructions. Verify data-provider and model/image licenses. Label all
fixtures and mocks. Do not use synthetic probabilities as accuracy proof.

For each milestone, report working features, commands to reproduce,
tests run and their real outcomes, remaining limitations, and evidence
for the next gate. Do not mark a feature complete because a screen exists.
When a gate fails, preserve a working manual-review path and document the
failure rather than silently weakening safety or accuracy requirements.
```

---

## 23. Definition of done and owner handoff

The owner can deploy the app through Docker Compose, sign in from a supported phone browser without installing a native app, import an existing ManaBox collection with a checked preview, photograph a supported 15-card layout, disconnect or power off the phone after upload acceptance, return to completed or actionable partial results, review uncertain items, inspect exact-printing and unknown metadata, verify quantities, export the collection, and undo an import or scan batch without harming prior holdings.

The development team can reproduce the Docker deployment, disconnected/restart recovery, test suite, transfer round trips, recognition benchmark, qualification report, catalog import, backup restore, and model rollback. The GitHub release is labeled source-available under a selected license prohibiting commercial reuse. The released claims match measured evidence. No unqualified category is silently auto-added.

**September 23 publication direction:** the owner authorized creating a GitHub repository and populating it with the current PakTrak source and features. The source publication uses PolyForm Noncommercial 1.0.0 and does not imply that the remaining release-qualification gates passed. Hosting/provider spend, a supported launch-device matrix and release metrics remain separate decisions. Changes to the requested confidence threshold, noncommercial direction, or use of customer photos for training need explicit authorization. Routine implementation can proceed under the recorded Docker, server-processing, mobile, migration, and licensing requirements without asking the owner to choose those directions again.

**Final instruction:** favor a correct, recoverable record over a confident guess. The scanner's job is to reduce work, not make the user audit hidden mistakes.

---

## 24. Source register and verification notes

Sources were checked or sought on September 17, 2026. Official documentation and primary sources are used below. Documentation can change; verify current API behavior and terms again at implementation and release. Numerical product targets, proposed architecture, schema design, sample payloads, and release gates in this document are original specifications, not performance claims from these sources.

**[S01] MDN: MediaDevices.getUserMedia().** Secure context and permissions.  
https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia

**[S02] MDN: ImageCapture.takePhoto().** Still capture returns a Blob; requested settings need actual-output verification.  
https://developer.mozilla.org/en-US/docs/Web/API/ImageCapture/takePhoto

**[S03] MDN: Offline and background operation.** Worker lifecycle and background-operation limitations.  
https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Offline_and_background_operation

**[S04] Scryfall: Card Objects.** Primary schema reference; indexed extracts checked, direct page retrieval blocked during preparation. Verify complete current schema in M0.  
https://scryfall.com/docs/api/cards

**[S05] Scryfall: API access troubleshooting.** Primary indexed guidance on identifying headers and API traffic limits; full current guidance must be verified in M0.  
https://scryfall.com/docs/faqs/i-m-having-trouble-accessing-the-scryfall-api-or-i-m-blocked-17

**[S06] Scryfall: public pricing disclaimer.** Prices described as estimates/market values; consult stores for final prices. Primary-domain indexed extracts checked.  
https://scryfall.com/

**[S07] Guo et al.: On Calibration of Modern Neural Networks.** Primary research on model confidence calibration. Abstract/record consulted, not a claim of MTG-specific performance.  
https://arxiv.org/abs/1706.04599

**[S08] scikit-learn: Probability calibration.** Calibration concepts, methods, and evaluation.  
https://scikit-learn.org/stable/modules/calibration.html

**[S09] Wizards: Collecting Aetherdrift.** Concrete example of main-set and Special Guests cards sharing a booster product.  
https://magic.wizards.com/en/news/feature/collecting-aetherdrift

**[S10] Apple: iPhone 14 technical specifications.** Older-phone camera baseline example only, not web-capture output assurance.  
https://support.apple.com/en-us/111850

**[S11] MDN: HTML capture attribute.** File-input camera capture behavior.  
https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/capture

**[S12] ONNX Runtime: Python.** Inference runtime documentation.  
https://onnxruntime.ai/docs/get-started/with-python.html

**[S13] pgvector: official repository/documentation.** PostgreSQL vector-search extension and indexing behavior.  
https://github.com/pgvector/pgvector

**[S14] FastAPI: Background Tasks.** Guidance on lightweight background tasks versus heavier distributed work.  
https://fastapi.tiangolo.com/tutorial/background-tasks/

**[S15] OWASP: File Upload Cheat Sheet.** Layered upload validation and storage security guidance.  
https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html

**[S16] OpenCV: Geometric Transformations of Images.** Perspective-transformation tooling.  
https://docs.opencv.org/4.x/dd/d52/tutorial_js_geometric_transformations.html

**[S17] Tesseract: Improving the quality of the output.** OCR preprocessing and image-quality considerations.  
https://tesseract-ocr.github.io/tessdoc/ImproveQuality.html

**[S18] Celery: Tasks.** Idempotent task behavior, acknowledgements, and retries.  
https://docs.celeryq.dev/en/stable/userguide/tasks.html

**[S19] Scryfall: REST API documentation and usage terms.** Primary indexed extract confirms data-paywall restrictions; direct page retrieval blocked. Full terms remain an explicit M0 verification item.  
https://scryfall.com/docs/api

**[S20] Wizards: Fan Content Policy.** Access, attribution, and use conditions. A release-specific rights review remains necessary.  
https://company.wizards.com/en/legal/fancontentpolicy

**[S21] Paperless-ngx: architecture.** Official documentation describes separate web and background task processing. Checked for version 1.1 through the project's documentation source; an interaction/architecture reference, not a claim that this app uses Paperless code.  
https://github.com/paperless-ngx/paperless-ngx/blob/dev/docs/usage.md

**[S22] Paperless-ngx: official project and installation guidance.** Docker Compose deployment reference checked for version 1.1. The MTG service boundaries and durability contracts in this specification are project requirements.  
https://github.com/paperless-ngx/paperless-ngx

**[S23] ManaBox: Import and export the collection.** Official CSV exchange guidance and documented import fields checked for version 1.1. Exact export schemas/enum values and destination behavior still require authorized fixtures and tests.  
https://www.manabox.app/guides/collection/import-export/

**[S24] Open Source Initiative: The Open Source Definition.** Sections 1 and 6 establish redistribution/business-use requirements; checked for the source-available terminology in version 1.1.  
https://opensource.org/osd

### Provider verification follow-up

During implementation on September 18, 2026, Scryfall's API usage rules, bulk-data documentation, endpoint-specific rate limits, and live bulk manifest were retrieved directly. The current format is gzipped JSON Lines, and a complete default-card metadata import was exercised. See [the source register](../docs/DEPENDENCIES.md). Dedicated image/index integration and its terms review remain pending before reference-image work:

https://scryfall.com/docs/api/bulk-data  
https://scryfall.com/docs/api/images

---

## 25. Contents of this handoff package

The Markdown file is the authoritative editable specification, now version 1.3. The supplied PDF remains an **archived version 1.0 reading copy** and does not include the owner's clarified Docker, accounts, decks, file exchange, and source-available licensing requirements. Do not use the PDF to override the current Markdown.

The initial folder contained only `Instructions/MTG_SCANNER_BUILD_INSTRUCTIONS.md` and `Instructions/MTG_SCANNER_BUILD_INSTRUCTIONS.pdf`. The repository now also contains the implementation, migrations, lockfiles, Docker configuration, automated tests, and operator/architecture/format/status documentation. The repository-level `README.md` is the entrypoint for running the current development build.

The original handoff mentioned `assets/policy_reference.py`, `assets/config.example.json`, `tests/test_policy_reference.py`, `docs/ACCEPTANCE_CHECKLIST.md`, and `docs/REFERENCE_TEST_RESULTS.txt`, but none was present. They must be implemented or superseded by actual project assets; their tests cannot be described as run or passed.

The current repository contains the runnable Compose stack and frontend/API, contour-based card detection, server-side Tesseract OCR and candidate artwork comparison, guided review, catalog/pricing workers, collections, decks, transfers, and synthetic integration/browser tests. It does not claim a trained or qualified recognizer, a full artwork index, authorized real third-party compatibility fixtures, or a measured physical-device benchmark. PolyForm Noncommercial 1.0.0 and publication notices are now included, and the owner has authorized GitHub source publication. The local catalog and private account/photo/collection data stay outside version-controlled source. The PDF remains the original archived specification; prebuilt application images are not published by this source update.

### Version 1.2 change record

- Linked current implementation, operating instructions, source register, and measured validation status.
- Recorded the current Scryfall bulk format and successful metadata import.
- Kept all real-photo/device, automatic-add, ManaBox compatibility, backup/restore, and release qualification gates explicit.
- Documented implementation choices without treating an early development build as completed Version 1.

### Version 1.1 change record

- Made Docker Compose, self-hosting, and a CPU baseline explicit requirements.
- Specified safe disconnection after durable server acceptance, independent job recovery, and mobile browser/PWA constraints.
- Made ManaBox migration, generic CSV mapping, and tested exports first-release work before automatic-add qualification.
- Added import/export schema, APIs, provenance, retention, retry/undo rules, and acceptance scenarios A46-A65.
- Recorded the owner's source-available license direction prohibiting commercial reuse and the later GitHub release gate.
- Corrected the supplied-file inventory and distinguished the original PDF from this updated specification.
