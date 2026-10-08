# Architecture decisions — September 18, 2026

The product requirements in the specification remain in force. These decisions select implementation details; they do not relax accuracy or compatibility gates.

## Gallery and daily card data

`data-worker` is a separate Compose process, independent of browser sessions and scan/transfer queue capacity. It prepares Scryfall metadata and daily TCGplayer, Card Kingdom and ManaPool price caches. `data_feeds` persists schedules, progress, freshness and errors; a PostgreSQL advisory lock serializes updater processes. `card_prices` is keyed by exact printing, provider and finish. Each provider's price replacement is transactional, preserving previous prices on malformed/failed imports.

Gallery totals, filtering and pagination use one SQL statement over owned lots and the selected price source. Duplicate grouping precedes pagination; lots/events remain separate for undo and audited moves. The response reports priced/unpriced quantities and a bounded location preview. Card details use the local catalog. Full images from trusted Scryfall URLs are cached in private object storage. Image requests check ownership and release the authorization connection before acquiring a cache-miss lock.

`work_progress` stores fenced attempt progress separately from long preview transactions. Phones can read measured row counts and step estimates without exposing uncommitted rows or waiting on a job lock. Browser polling pauses when hidden and is optional for processing. [Card data and pricing](CARD_DATA.md) records units, freshness, caching, attribution and boundaries.

## Docker and the mobile client

Docker Compose is the primary build, development, and deployment path. The stack includes the web entrypoint, API, photo worker, transfer worker, dispatcher/maintenance process, migration bootstrap, PostgreSQL, Valkey, SeaweedFS, and Keycloak. Only the web entrypoint publishes a host port, bound to loopback by default. Application containers run without root or Linux capabilities. No Docker socket is mounted.

The client uses React, TypeScript, and Vite instead of the specification's proposed Next.js default. This application uses authenticated interactive screens and has no current server-rendering requirement. Static assets served by nginx avoid a separate Node production service. Collection and review screens load on demand. The bundle target is Chrome 100 / Safari 15.4 syntax compatibility; this is not a physical-device support certification. Four-year-old-or-newer phones remain the intended hardware baseline, with maintained browsers.

The browser uploads the original file without required image decoding or a catalog download. It shows upload progress separately from acceptance, then reads saved server status. Polling pauses when the page is hidden or offline. Optional PWA installation remains future work.

## Storage and durable work

PostgreSQL is authoritative for accepted work. Private SeaweedFS S3 storage holds immutable photo/CSV inputs and derived images/files. The browser never receives storage credentials or arbitrary storage keys. Owner-checked API endpoints stream private results.

Valkey supplies the Redis-compatible Celery broker. This replaces the specification's proposed Redis service with a BSD-licensed component; the Python Redis client is a separate dependency. Broker persistence helps recovery, but correctness does not depend on it. Each accepted job has a transactional outbox row. The dispatcher republishes due queued work, recovers expired leases, and enforces attempt/deadline limits. Workers acknowledge late, fence stale attempts with lease tokens, and persist results independently of any browser session.

Photo acceptance happens only after byte count/hash verification and a committed scan/job/outbox transaction. CSV acceptance stores the input and preview job before returning 202. CSV confirmation freezes a reviewed revision; only server jobs create inventory effects. Long phone uploads do not hold database transactions open.

Photo and transfer workers consume separate queues with one process each by default, preventing a collection import from occupying the only photo worker. Both use the same backend image. Jobs are bounded by a 45-second soft limit, 60-second hard limit, 90-second database lease, three attempts, and a 24-hour deadline. Import commits and undo use chunks of 100 lots; a retry continues from recorded effects.

## Identity and privacy

Keycloak provides an OIDC authorization-code flow with S256 PKCE. The API validates the configured issuer and provider signatures, then creates an opaque server-side login session. Mutations require the exact configured Origin and a session CSRF token. Sessions are HttpOnly and SameSite=Lax; HTTPS deployments set Secure. First-admin setup is bound to verified OIDC state and serialized with a PostgreSQL advisory lock. Subsequent accounts default to guest; provider/browser role claims cannot grant app permissions. Admin checks and the admission setting are enforced by the API, with current roles read from the database.

Guests have a lifetime 100-card photo allowance. Processing counts newly persisted detected regions in the same transaction as the successful result, under an account lock. Stale/repeated workers cannot double-charge, and competing jobs cannot overrun the allowance. A photo too large for the remaining allowance fails without a partial charge. Imports, removals, photo expiry and session expiry do not reset scan usage. Approved members and admins have no total-card limit. Queue concurrency remains a separate capacity policy.

Guest-to-member approval persists a pending congratulations notice. Only a new verified OIDC login session captures eligibility to display it, so an already-open session receives the role change without an unexpected popup. The authenticated, CSRF-protected dismissal clears the account-level notice across devices. A receipt scoped to account and approval timestamp prevents repeated display during a failed save and retries acknowledgement on a later mount. Existing members are not retroactively shown a new-approval message.

Provider endpoints inside Docker differ from the public browser-facing issuer. The nginx proxy derives forwarded scheme/host/port from the configured application origin, including behind an HTTPS reverse proxy. Plain HTTP setup is limited to local development.

Private queries derive ownership from the session. Catalog searches need a signed-in account and return printing metadata only. Photos/crops expire after seven days, unfinished photo uploads after 24 hours, raw CSV uploads seven days after terminal processing, and export downloads after 24 hours. Active jobs protect their inputs until completion/deadline. Collection records and provenance remain after file expiry.

## Request diagnostics

The API assigns its own UUID to each request and returns `X-Request-ID`; error JSON also contains that reference and a diagnostic code. Exception handlers preserve API-specific conflict payloads, sanitize Pydantic validation fields, and record safe code locations instead of exception messages or local variables. OIDC connection, state, signature, and claim-validation failures redirect to a retryable sign-in message with the same reference. Origin and CSRF failures remain distinct without weakening either check.

Failed requests are written to a bounded `request_error_logs` table using a separate pool with short connection/statement/lock limits. Normal anonymous session probes are omitted. Records are capped at 10,000 and 14 days; periodic maintenance also enforces age retention. App-admin authorization protects the paginated reference-search endpoint, which excludes account identifiers from its response. The browser separates action errors from recoverable polling errors, preserves pending edits, and updates changed CSRF tokens even when the session's other account fields have not changed. It never automatically replays a failed write. See [operation details](OPERATIONS.md#error-logs-and-sign-in-recovery) for coverage and limits.

## Catalog, detection, and collection integrity

The catalog loader supports the live provider's gzipped JSON Lines format and legacy JSON arrays. It checks schemas, streams records in bounded batches, records a checksum/source snapshot, and commits the new catalog atomically. Existing printings are retained rather than deleted. A successful download is reused for 24 hours; failed imports retain the staged download in the configured cache. The collection gallery and cached prices use this metadata. Scan recognition uses packaged English Tesseract OCR, local name/identifier retrieval and SIFT artwork comparison against the existing unmodified image cache; no whole-catalog embedding index is shipped.

The current detector uses global and adaptive thresholds, contours, quadrilateral geometry, 600×840 perspective crops and overlap suppression to propose up to 32 regions. That cap is a resource limit, not a supported card-count claim. Separate physical regions retain separate stable IDs even when they show the same printing. Under the owner’s September 19 direction, server-computed match strength strictly above 0.88 enables automatic import; scores at or below the threshold need approval. This is a similarity rule, not a calibrated accuracy claim. The worker validates catalog identity and finish availability, then writes an audited source lot inside the existing lease/deletion transaction.

Inventory uses lots and append-only events. An automatically imported or manually approved observation creates a one-copy lot; an import row can create a larger lot. Unique source-observation/source-row constraints make inventory effects replay-safe. Quantities cannot become negative. Import undo sets a persistent cancellation barrier and only removes remaining copies from that import's own lots, recording previously removed quantities separately.

The collection view groups all remaining copies by exact printing on the server, including copies from different scans and imports. `/api/v1/collection/cards` aggregates before paging through 40 printings and calculates collection totals and per-location counts in one SQL statement. Each card initially includes up to three locations; **Manage copies** reads the complete paginated breakdown from `/api/v1/collection?printing_id=…`. Location filtering applies to both totals and details. Finish, condition, notes and source provenance remain attached to the underlying lots, so grouping the display does not change import undo, exports or deck accounting. Existing collections receive grouped counts immediately without a data migration.

Collection export first materializes a PostgreSQL repeatable-read snapshot into private export rows. CSV and text formatting/retries reuse that snapshot. Full CSV escaping is explicitly versioned and reversible. Portable CSV includes locations and card details; text omits metadata that has no representation in a card list. Unknown finish/condition never excludes owned copies from new exports.

Storage locations have names, types, notes and revision checks. Moving an entire lot adds a zero-delta audit event and preserves its original source, so import undo still finds it. Saved decks reference printings, have optimistic revision checks and idempotent writes, and do not reserve inventory. Requested quantities may exceed holdings. A bounded CSV/text preview resolves names against the local catalog in batches; explicit confirmation creates the deck without inventory effects. Current collection comparison matches exact printing IDs or oracle identities across editions and allocates each owned copy only once across commander/mainboard/sideboard. Buy-list downloads recompute missing quantities. Existing decks retain exact-printing matching; new decks default to any printing. See [deck plans](DECKS.md).

## Deferred components

PostgreSQL currently has no pgvector extension because no embedding index exists yet. Add a versioned index and extension when the recognition experiment needs them. Generated frontend response contracts, calibrated recognition, targeted close-ups, complete account deletion workflows, operational dashboards, coordinated backup/restore, and signed/released images remain tracked in the specification and status report.

Scan checkpoints, crop repair, value estimates and the persistent batch-deletion barrier are described in [Scan batches](SCANNING.md). Recognition steps handle one card at a time through the same durable outbox, preserving the task limits and overall deadline.

A scan stores its pre-upload foil count independently of recognition. New scans default omitted/null counts to zero while retaining the original request hash for resumable uploads. Zero foils defaults newly detected regions to nonfoil; positive counts keep initial finishes unknown until chosen. Once current active foil/etched assignments match a positive declared count, additional detected or manually outlined cards inherit nonfoil. This bounded lookup uses imported-lot finishes when available and ignores discarded regions. Legacy batches without a plan keep their existing interpretation. The batch finish-selection endpoint checks a snapshot token under owner → job → scan → lot locks, validates every selected printing/finish, saves per-region labels and updates existing source lots with zero-delta audit events. Count, ownership, ignored regions, stale decisions and retries are checked before committing. Mixed finishes survive bulk approval, rechecks and browser disconnection. No camera-based foil classifier is implied.
