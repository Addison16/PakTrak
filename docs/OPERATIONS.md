# Docker operation guide

## First installation

Run from the project directory on a machine with Docker Engine/Desktop and Compose:

```sh
sh scripts/setup.sh
sh scripts/start.sh
```

The web app is at `http://localhost:8095`. Its first launch offers **Create administrator account**; choose your own credentials through the registration screen. There is no pre-created application account on fresh installations. Finish setup before opening registration to general visitors. The separate identity administrator is `admin`, with `KEYCLOAK_ADMIN_PASSWORD`; the identity console is under `/identity/admin/`. Keep secrets, generated configuration, private volumes, test artifacts, and real collection/photo fixtures private.

The application's **Administration** tab controls guest signup and approval. Guests receive 100 total detected card regions from successful photo processing, never a daily/monthly allowance or a concurrency allowance. Ignoring/removing a card or expiring a photo does not refund usage. If a photo would exceed the remaining allowance, it fails with no charge; smaller photos can use the remainder. Approval changes the account to a standard member with no total-card scan limit. The existing default of two active photo jobs per account remains an independent capacity limit for every role. CSV/text transfers do not consume photo scans.

Closing guest signup prevents new application accounts, including attempted admission through a direct identity-provider login. Existing guest/member sessions continue working. Identity registration and application membership are separate: the provider may retain a login identity for an attempted registration, but it cannot obtain an application session while admission is closed. Bootstrap enables the identity registration form; only the application controls administrator/member/guest roles. The identity bootstrap credential is mounted into the one-shot migration service, not the running API or workers.

The account/deck migration preserves existing collectors as members and upgrades an existing provisioned `owner` application account to admin when present. An installation without that account shows the new setup screen. Existing secrets are not overwritten; an old `OWNER_INITIAL_PASSWORD` value is no longer needed for fresh app setup.

No host Python, Node, npm, uv, or Make installation is required. `make setup`, `make dev`, and the other Make targets are conveniences for the shell/Docker commands. The setup script uses the pinned Python container and refuses to overwrite configuration. Builds use Buildx when available and support the legacy Docker builder as a fallback.

Passwords require at least **8 characters**. Bootstrap applies this minimum to both new and existing installations, retaining any other operator-configured password rules. Existing credentials keep working. It also selects the `paktrak` login theme; Compose mounts [the theme](../infra/themes/paktrak/login/), bundled fonts and shared appearance assets read-only. Keep both theme `resources/fonts/` and `resources/shared/` directories, including their `.gitkeep` files, when copying the project: Docker needs those mount points inside the read-only theme.

The display name is **PakTrak**. Existing Compose project, volume, database, Python package and OIDC identifiers retain `mtg-scanner`/`scanner` for installation continuity. The normal start script selects the theme; no account or collection migration is needed for branding. Do not rename volumes or recreate the realm to update branding.

When changing an existing login theme, use a new CSS resource filename in `theme.properties` and run `docker compose restart identity` after copying the files. Keycloak caches theme properties and compressed resources, while browsers cache theme assets for 30 days; a query string alone does not refresh the server's compressed resource. Keep the previous CSS file available for already-open sign-in pages. The current stylesheet is `css/paktrak-v6.css`, with shared `appearance-v1.css` / `appearance-v1.js` assets. It uses solid surfaces and follows the same Auto/Light/Dark choice as the application. When shared assets change after release, version their filenames in both `index.html` and `theme.properties` too.

Allow initial image downloads and time for Keycloak to start. The API readiness check covers the schema and private storage bucket. Bootstrap performs an actual private storage write/read/delete probe before startup. A temporarily unavailable identity provider can require a sign-in retry during initial startup.

The start script validates and reloads nginx after Compose starts the services. This refreshes Docker service addresses when an API update replaces its container but leaves the existing web container running.

## HTTPS and access from a phone

For a **fresh** deployment, choose the final origin before initializing Keycloak:

```sh
sh scripts/setup.sh --url https://cards.example.net --bind 127.0.0.1 --port 8095
sh scripts/start.sh
```

Replace the example hostname with one you control. Terminate HTTPS at your existing reverse proxy on the same server and forward to `127.0.0.1:8095`. For example, using [Caddy's documented reverse-proxy configuration](https://caddyserver.com/docs/quick-starts/reverse-proxy), a host-installed Caddy configuration is:

```caddy
cards.example.net {
    reverse_proxy 127.0.0.1:8095
}
```

Configure DNS and a certificate trusted by the phone. A local-only hostname is also usable with a certificate authority trusted by that phone. If the reverse proxy runs in Docker, its `127.0.0.1` is its own container: connect it to an appropriate Docker network and proxy to the app's web service instead. Do not publish the database, broker, storage, or Keycloak's internal service ports.

Open the HTTPS hostname in the phone browser. Installation as a native app is unnecessary. Accepted photos are JPEG, PNG, WebP, HEIC/HEIF, AVIF, TIFF, BMP and still GIF, up to 100 MiB and 60 million decoded pixels. The Docker worker decodes the original upload after durable acceptance; the phone can then disconnect. Browsers may still convert a camera/library selection to JPEG themselves. See [photo formats](PHOTO_FORMATS.md) for primary-image handling, color conversion and limitations. Test the real device's capture path before relying on it.

The external proxy must allow the 100 MiB upload body and enough time for a mobile connection. nginx already sets the app's body limit and ten-minute upload timeouts. Keep TLS through the browser-facing edge; the internal Docker hop uses HTTP. Forwarded origin metadata comes from `APP_URL`, and secure session cookies follow that configured origin.

**To change the public hostname**, point the new DNS/proxy/TLS address at this installation, change only `APP_URL` in `.env`, and run `sh scripts/start.sh`. Keep all credentials, databases and volumes. Startup updates the existing Keycloak client's callback, web origin and logout destination, the realm's frontend URL/SSL setting, and the application accounts' issuer together. A database binding pins the local realm's stable ID so the public address can change without creating new account owners. Roles, approval, lifetime usage, limits, preferences, collections, binders, decks and photo batches stay attached to their existing IDs. Sign in at the new address after the move; previous application sessions are revoked. Redirect an old hostname to the new one at your external proxy if you keep it available.

When first upgrading an older installation, start this version with the **existing** `APP_URL` before changing it so bootstrap can record the current realm binding. An unrecognized legacy issuer, duplicate identity or a different realm ID stops bootstrap with a recovery message instead of guessing which accounts to join. If a move made with an older version already created a guest duplicate, back up both databases and verify the original provider subjects before repairing the account mapping; do not recreate users or delete volumes. The realm import JSON remains a first-install seed; updating that file alone does not update an existing realm. DNS, reverse-proxy routing and certificates remain operator configuration.

The local stack and mobile-sized browser tests have been exercised. An actual phone over this HTTPS path remains a validation gate.

## Personal accounts and user management

Open **Menu → My account** for your profile, password change, sign-out controls and lifetime usage. Administrators can open **Menu → Administration → User management** to search users, approve guests, reset passwords, suspend/restore access, sign out devices, pause scans and set lifetime card limits. Approved members default to unlimited scanning; administrators can raise a custom cap or restore unlimited without resetting usage. See [account controls and counting rules](ACCOUNTS.md).

Password resets create a temporary password to share privately; the next sign-in requires a new password. They revoke both app and identity sessions. No SMTP configuration is needed, and PakTrak does not send the password automatically. Admin accounts change their own password through **My account**; the per-user reset action is for guests and members.

`scripts/start.sh` runs `scripts/setup.sh --upgrade` before building. On an older installation, this appends a generated `PASSWORD_RESET_CLIENT_SECRET` to `.env` under a file lock, preserves existing values and permissions them to owner-only access. Repeated starts reuse the secret. An explicitly empty key needs a generated value of at least 32 characters. Keep the updated `.env` with private installation backups.

The one-shot bootstrap provisions a dedicated confidential Keycloak service client, `paktrak-account-admin`, with only the `realm-management` **manage-users** role and a matching token scope. This role manages users within the application realm; it is not an endpoint-specific reset permission. Interactive login and password grants are disabled for this client. Its credential reaches only the API and migration service, not workers or browser assets. The identity master-admin credential remains confined to bootstrap and the identity service. The application checks administrator status, CSRF, account version and protected-admin rules before calling the provider's [credential reset and logout endpoints](https://www.keycloak.org/docs-api/26.7.4/rest-api/index.html).

Bootstrap also attaches the existing **basic** scope to the normal sign-in client. Keycloak supplies `auth_time` through this scope; PakTrak uses it to reject authentication that predates a reset, and checks completion of the required password change before issuing a new app session. See Keycloak's [basic-scope upgrade notes](https://github.com/keycloak/keycloak/blob/main/docs/documentation/upgrading/topics/changes/changes-25_0_0.adoc). Do not remove the scope or rotate the dedicated client credential in only one place. If configuring Compose manually instead of using the start script, run `sh scripts/setup.sh --upgrade` before starting the migration service.

## Optional scan enhancement

Open **Menu → Administration → Scan processing** to enable **Enhanced scanning**. It is **off by default** on both fresh and upgraded installations. The setting persists in PostgreSQL and applies to upcoming card-identification steps without container restarts. Only administrators can change it; guest registration and approval remain independent settings.

This CPU option retries difficult text with a larger temporary crop and extra cleanup, preserving the ordinary recognition result as a fallback. It needs no GPU or additional models. Allow extra CPU, memory, private-storage reads and processing time when enabled; stored photo sizes do not increase. The phone can disconnect after upload as usual. The ordinary scan worker's concurrency, lease, retry and task limits still apply. Disable it to return upcoming steps to standard processing on a smaller server. Changing the switch does not rescan saved collections or add copies; **Check photo again** can retry pending batch cards. See [scan enhancement](SCANNING.md#optional-enhanced-scanning) for evidence, limits and timing details.

## Catalog maintenance

The `data-worker` container now prepares the default card catalog and daily price feeds automatically. No separate initial catalog command is needed. Open **Card data & prices** in the app for progress and step estimates; accepted uploads continue independently. See [card data and pricing](CARD_DATA.md) for provider meanings, schedules and missing-price handling.

The default catalog contains English printings plus cards that only exist in another printed language. Localized collections generally need the all-language export:

```sh
docker compose exec -T api python -m scanner.catalog --download all_cards
```

The manifest is fetched from Scryfall and download URLs are restricted to its HTTPS data host. Set an operator-specific descriptive `--user-agent` if desired. Successful downloads are reused for 24 hours. The CLI loads metadata only. Viewed card artwork is cached separately by the gallery. Search, import resolution, and manual collection additions then use local records.

You can also load an already downloaded `.jsonl.gz`, JSON Lines, or legacy JSON array file without an external API call:

```sh
docker compose run --rm --no-deps -v /absolute/path/to/catalog:/input:ro api \
  python -m scanner.catalog --file /input/default-cards.jsonl.gz
```

The import is all-or-nothing and preserves referenced printings. The staged download cache defaults to the API container's `/tmp/scanner-catalog-cache`; it can be rebuilt and is not authoritative data. A failed schema check leaves the previous database catalog intact. Catalog errors print public provider data only; do not substitute private collection files for catalog input.

## Routine commands

```sh
docker compose ps
docker compose logs --tail 50 api worker transfer-worker dispatcher data-worker
docker compose restart worker transfer-worker
docker compose run --rm migrate
docker compose down
sh scripts/start.sh
```

`down` without volume deletion retains named volumes. Never use `down -v` against a collection you want to keep. This stack does not expose a Docker socket or manage unrelated Docker projects.

The `database` volume contains application and identity databases, `photos` contains both SeaweedFS data and filer metadata, and `broker` contains Valkey persistence. `.env` and `infra/generated/` contain the matching credentials/provider configuration. Database records are authoritative for broker recovery.

## Error logs and sign-in recovery

Open **Menu → Administration → Error logs → View error logs** to inspect failed app requests and sign-in confirmations. Error banners name the action that failed, are dismissible, and offer **Error details → Copy error details**. Paste the reference into the log viewer to find the matching server record. Validation messages identify the invalid field when available; connection and server failures no longer ask you to correct unrelated fields.

Background refresh errors clear after a successful refresh. Dismissing an ongoing refresh failure keeps it hidden until recovery or a different failure. Failed saves remain visible until dismissed or retried; a successful background refresh cannot imply that a failed save succeeded. The main session/batch refresh slows retries during outages and pauses on expired sessions. **Sign in again** starts a fresh login; **Refresh sign-in** updates the verification token without repeating the failed write. Returning to an open tab also refreshes its token when another tab has signed in again to the same account.

Server records contain a generated request reference, time, HTTP method, route template, status, diagnostic code, duration, and safe field names or code locations. They omit request bodies, query values, passwords, cookies, tokens, photo contents, and uploaded collection/deck lists. Only app administrators can read the viewer. Records live in PostgreSQL, survive container replacement, and are retained for up to **14 days / 10,000 entries**, whichever limit is reached first. The dispatcher prunes aged records even when there are no new errors. Backend Docker logs use the local logging driver with three 10 MB files per container.

For terminal diagnostics:

```sh
docker compose logs --since 30m api
```

Look for JSON entries with `event` equal to `request_error` and an `id` matching the displayed reference. Logging uses a separate bounded database pool and falls back to Docker logs if storage of the diagnostic record fails; it does not replace the original response with a logging error. Normal signed-out session probes are not saved as failures. Errors occurring entirely in the browser, the external reverse proxy, or the identity provider's password form may have no app reference or saved app log; copy the browser error's action, time, and status, and inspect the relevant service logs. Logs begin when this update is installed and cannot reconstruct older errors.

## Validation and fault testing

```sh
sh scripts/test.sh
sh scripts/test-browser.sh
sh scripts/test-recovery.sh
sh scripts/test-backup.sh
```

Run these sequentially. The backend suite uses a separate database and bucket. Browser tests require a running stack, its generated local credentials, a populated catalog, and Linux host-network access. They create and remove their own identity accounts; their synthetic application records can remain in this development instance. Screenshots contain only test account data and are git-ignored.

The recovery test deliberately interrupts this project's services, loses its task queue, and recreates containers while a browser is closed. It checks for active non-test jobs first. Run it on a development instance, never concurrently with builds, other tests, or real uploads/transfers. It preserves volumes; it does not simulate disk loss or prove a backup restore.

The backup test creates separate temporary Docker projects and volumes, restores a real PostgreSQL installation, checks synthetic application/identity records and photo/broker files, and removes its own projects afterward. It leaves private artifacts for diagnosis on failure and does not stop the real installation. Allow space for the captured PostgreSQL image and temporary database volumes.

## Upgrades and backups

Run a coordinated backup before upgrading:

```sh
sh scripts/backup.sh
```

The command saves the exact installed container images, then stops this project's containers, copies all three named volumes, and resumes only containers that were previously running. The maintenance pause lasts while the volumes and matching installation are copied; archive checksums and full verification then run with the installation available again. The backup contains application and identity PostgreSQL databases, SeaweedFS photos and filer metadata, Valkey persistence, `.env`, generated provider configuration, source, lockfiles, themes and the installed images. Build caches, dependencies, Git history, previous backups and test artifacts are excluded. A collection CSV is a separate export, not an installation backup.

Backups default to `backups/paktrak-YYYYMMDDTHHMMSSZ/`. Each new directory is private (`0700`), its archives and SHA-256 manifest are owner-readable (`0600`), and successful completion verifies checksums and complete archive contents. Backups contain credentials and private photos; use encrypted storage and an off-machine copy. SHA-256 detects damage but does not authenticate an untrusted backup. These scripts need Docker and Compose; their Python helper runs in the pinned setup container with networking disabled, without a host Python installation.

Useful options:

```sh
# Keep services stopped for the following upgrade.
sh scripts/backup.sh --leave-stopped /private/backups/paktrak-before-upgrade
# Back up a separately named installation.
sh scripts/backup.sh --project my-collection --directory /srv/paktrak /private/backups/my-collection
# Check an existing backup without stopping any services.
sh scripts/verify-backup.sh /private/backups/paktrak-before-upgrade
```

`--without-images` omits image archives to reduce storage; that backup requires the matching images already installed or a compatible rebuild before startup. The default includes images so restoration does not depend on a registry or mutable image tags. Existing backup destinations are refused. Concurrent backups of one directory are refused, and paused containers or active one-off commands must finish first. Do not run deployment commands or an external container restart watchdog during the maintenance pause. On failure, the command resumes prior containers unless `--leave-stopped` was requested and retains its private partial directory for diagnosis. A hard power loss or `SIGKILL` can leave a stale `.paktrak-backup.lock`; inspect the installation and partial backup before removing it.

### Restore into a fresh installation

Restoration requires a new project name and an empty destination. It refuses existing containers, volumes and installation files; it has no option to overwrite a collection.

```sh
sh scripts/restore.sh /private/backups/paktrak-before-upgrade \
  --target-dir /srv/paktrak-restored --project paktrak-restored
```

Restore checks all archives before extracting, preserves original database/file ownership, rejects archive paths and links that escape their destination, creates separate project volumes and loads the captured image IDs without changing existing image tags. It restores `.env` and generated credentials together. It does **not** start services. `.restore-incomplete.json` remains until extraction, volume restoration and image loading all finish; a failed restore can leave the new partial directory and volumes, which should be inspected and removed before starting a fresh attempt.

Before starting alongside an existing installation, choose a free `HTTP_PORT` and bind address in the restored `.env`, and arrange a separate hostname/proxy if testing sign-in. The [hostname change procedure](#https-and-access-from-a-phone) applies to the restored copy. Then use the captured images and separately named volumes:

```sh
cd /srv/paktrak-restored
docker compose -p paktrak-restored -f compose.yaml -f restore-compose.yaml up -d --no-build
docker compose -p paktrak-restored -f compose.yaml -f restore-compose.yaml exec -T web nginx -t
docker compose -p paktrak-restored -f compose.yaml -f restore-compose.yaml exec -T web nginx -s reload
```

The restore override pins the captured images and renames all volumes. Keep using both Compose files and the same `-p` name for this restored installation. For a later upgrade, take another coordinated backup, remove the `services` image pins from `restore-compose.yaml` while retaining its `volumes` section, build the new images, and start using those same Compose options. The normal start script assumes the original project configuration; do not use it unchanged for this alternate restore project.

A disposable restore drill exercises PostgreSQL application and identity databases, photo/filer files, broker files, numeric ownership, symlinks, exact image loading and safeguards against overwriting existing destinations. This verifies the backup mechanism; an operator should additionally exercise their own restored catalog, sign-in and photo processing on an isolated deployment. It does not qualify a particular disk, phone or external proxy.

### Scheduled backups

Schedule the same command during a quiet maintenance window, for example with the installation owner's crontab:

```cron
15 3 * * 0 cd /srv/paktrak && sh scripts/backup.sh >> /private/paktrak-backup.log 2>&1
```

Create the log with `0600` permissions first, ensure that the scheduler can access Docker, monitor command failures and available space, and copy completed backup directories to encrypted remote storage. The script keeps every backup; choose and document retention outside the app, deleting only older successfully verified copies after confirming the remote copy. Periodically repeat a restore into a fresh project rather than relying only on a checksum check.

Migrations run through the bootstrap service before the new API/workers start. The collection migration adds non-scan jobs that older workers cannot process; rolling back only the application image is unsafe. That migration deliberately refuses a destructive downgrade. Roll back using a coordinated pre-upgrade backup with its matching application version.

Published images, automatic updates, self-service email recovery, monitoring dashboards, device qualification, and a production release checklist remain future work. Administrator-issued temporary passwords are available now. Current lockfiles and image digests make the development build reproducible; they do not replace release qualification.
