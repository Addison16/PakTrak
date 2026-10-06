# Publishing PakTrak Docker releases

The [Docker workflow](../.github/workflows/docker-publish.yml) verifies pushes to `main`, pull requests and manual runs. **Publishing a GitHub release** triggers verification followed by image publication. Pushing a commit or tag alone does not update `latest`.

## Publish a version

1. Commit and push the release changes to `main`, then check that **Docker verification and releases** passes under [Actions](https://github.com/Addison16/PakTrak/actions).
2. Open [New release](https://github.com/Addison16/PakTrak/releases/new). Create a tag such as `v0.1.0` at the tested commit, add the release notes and publish it. Tags must be `vX.Y.Z` or `vX.Y.Z-prerelease`, with no build metadata. Mark experimental releases as prereleases.
3. Wait for the release workflow to finish. Verification builds the frontend/backend, boots disposable backing services, runs the backend suite, checks lint and schema drift, and exercises deployment failure gates. Publication builds both runtime images with SBOM and provenance attestations.

Images are published as:

```text
ghcr.io/addison16/paktrak-backend:0.1.0
ghcr.io/addison16/paktrak-web:0.1.0
```

Both images also receive `sha-FULL_COMMIT_SHA` tags. After both versioned images publish, stable releases promote both `latest` tags. Prereleases receive version/commit tags and never change `latest`. The updater pins both application images to the same release version; infrastructure images retain their separately pinned upstream digests.

The workflow uses its repository-scoped `GITHUB_TOKEN` with `packages: write`; no separate Docker Hub account or registry token is needed. Actions are pinned to commits. The first published platform is **linux/amd64**; ARM64 is not yet qualified.

## Make the packages publicly pullable

GitHub initially creates container packages with **private** visibility, even for a public source repository. After the first successful publication, open each package's settings:

- [paktrak-backend settings](https://github.com/users/Addison16/packages/container/paktrak-backend/settings)
- [paktrak-web settings](https://github.com/users/Addison16/packages/container/paktrak-web/settings)

Choose **Change visibility → Public** for both packages. This is a one-time setting and enables pulls without a GitHub login. The workflow's source labels link the packages to this repository. Keep the repository's Actions access to both packages so future releases can push updates. See [GitHub's registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

Verify anonymously from a fresh Docker configuration:

```sh
docker_config=$(mktemp -d)
docker --config "$docker_config" pull ghcr.io/addison16/paktrak-backend:latest
docker --config "$docker_config" pull ghcr.io/addison16/paktrak-web:latest
rmdir "$docker_config"
```

## Install and update

```sh
git clone https://github.com/Addison16/PakTrak.git
cd PakTrak
sh scripts/setup.sh
sh scripts/update.sh
```

For a phone deployment, pass the final HTTPS origin to setup as described in [operations](OPERATIONS.md#https-and-access-from-a-phone). Repeat only `sh scripts/update.sh` to update. Use `sh scripts/start.sh` to restart the installed version, or `sh scripts/update.sh --version v0.1.0` to select a published release explicitly.

Keep Git in the installation: Compose uses the release's PostgreSQL initialization script and identity theme/public assets from the checkout. Only locally generated provider configuration and credentials stay outside Git. The updater selects the matching source tag and writes `PAKTRAK_VERSION` to `.env`; users do not compile application code. It refuses tracked edits and simultaneous updates.

For local development, run `sh scripts/start.sh --build`. Direct builds can use `docker compose -f compose.yaml -f compose.build.yaml build api web`. Building locally does not publish anything to GHCR.

## Notices and release evidence

Both app images include `LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES.md` and the dependency register under `/usr/share/doc/paktrak/`. Python wheels retain their upstream license files; backend/base-image system package notices remain in their installed locations. The web image includes the full React, React DOM and Scheduler MIT licenses and its npm lockfile under `/usr/share/doc/paktrak/`, and retains font license texts with its static assets. BuildKit attaches an SBOM and provenance to each versioned image, alongside source/revision/version/license labels. Dependency licenses and any applicable source/replacement obligations remain independent of PakTrak's AGPL-3.0 license; see [the dependency register](DEPENDENCIES.md).

If a release build fails, fix the cause and rerun its failed workflow jobs. The start script completes image pulls before pausing an existing installation, so missing or incomplete release images do not stop its running containers. Keep published version tags tied to their release commit, and publish a new version for source changes.
