# Contributing to PakTrak

PakTrak is source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE). Commercial use is not licensed. Contributions to original project files are submitted under these same terms; third-party files must retain their compatible upstream licenses and notices. Do not add a different license to existing project code without discussing it with the maintainer.

## Development

Follow the [Docker setup instructions](README.md#run-with-docker), using `sh scripts/start.sh --build` to build your development checkout. The default Compose file pulls released application images; `compose.build.yaml` adds source builds. Keep `.env`, `infra/generated/`, private volumes, photos, collection exports, backups and local artifacts out of Git. Use synthetic fixtures for automated tests. Runtime card metadata/artwork comes from the configured providers rather than committed datasets.

Use a separate development installation for tests. The backend integration suite uses its own database and storage bucket, but browser tests create disposable accounts and some recovery tests intentionally restart services. Read [the operations guide](docs/OPERATIONS.md) before running them.

```sh
sh scripts/test.sh
python3 scripts/test_deployment.py
sh scripts/test-browser.sh path-to-changed-feature.spec.ts
```

The second command takes Playwright test arguments; replace the example with a relevant file in `apps/web/e2e/`. Browser tests currently assume Linux host networking. Validate both Chromium and WebKit for changes to phone-facing behavior. Run the production TypeScript/Vite build when changing the frontend.

## Changes and pull requests

- Explain the concrete problem and resulting behavior, including a short before/after example when useful.
- Keep account ownership, scan quotas, idempotent writes and durable server processing intact. A phone must be able to disconnect after the server accepts its upload.
- Include database migrations for persistent schema changes. Do not rewrite an applied migration or require users to delete their volumes.
- Test behavior that could lose or duplicate cards, weaken account boundaries, mislabel finishes or break imports. Record commands and results without credentials or personal data.
- Update the relevant feature/operation documentation and [changelog](CHANGELOG.md). Distinguish automated evidence from physical-phone or recognition-accuracy claims.
- Preserve third-party notices and identify the source/license of any added assets. Do not submit copyrighted card artwork, private photos, access tokens or production exports as fixtures.

For security problems, follow [SECURITY.md](SECURITY.md) instead of opening a public issue with sensitive details.
