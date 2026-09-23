# Dependency and source-rights register

Reviewed September 18, 2026. This is an implementation inventory and release gate, not a claim that all redistribution obligations have been discharged.

## Project license direction

The owner explicitly chose **source-available, commercial reuse prohibited**. Original PakTrak files use [PolyForm Noncommercial 1.0.0](../LICENSE), with [NOTICE](../NOTICE) and [third-party notices](../THIRD_PARTY_NOTICES.md). Do not describe the project as OSI open-source. A project-level restriction does not replace dependency licenses, provider terms, card-art rights, or users' rights in their photos/collections.

The source repository includes the project license and full notices for its bundled fonts. Before distributing built images, assemble the required dependency, bundled-library, and container-base notices/source offers for those images. The current stack avoids a mandatory paid recognition API and bundles the packaged English Tesseract OCR data when building the server image. Provider card images are cached at runtime and are not bundled for distribution.

## Python application dependencies

Versions and hashes are locked in [uv.lock](../uv.lock); direct dependencies are declared in [pyproject.toml](../pyproject.toml). License identifiers below were checked against installed distribution metadata. They do not cover every library bundled inside wheels.

| Package | Version | Declared license |
| --- | --- | --- |
| [FastAPI](https://pypi.org/project/fastapi/) | 0.141.1 | MIT |
| [Uvicorn](https://pypi.org/project/uvicorn/) | 0.53.0 | BSD-3-Clause |
| [pydantic-settings](https://pypi.org/project/pydantic-settings/) | 2.15.0 | MIT |
| [SQLAlchemy](https://pypi.org/project/SQLAlchemy/) | 2.0.54 | MIT |
| [Psycopg / binary distribution](https://www.psycopg.org/psycopg3/docs/basic/install.html) | 3.3.5 | LGPL-3.0-only; preserve its license and applicable replacement/source rights when distributing images |
| [Alembic](https://pypi.org/project/alembic/) | 1.20.0 | MIT |
| [Celery](https://pypi.org/project/celery/) | 5.6.3 | BSD-3-Clause |
| [redis Python client](https://pypi.org/project/redis/) | 8.1.0 | MIT; distinct from the server product |
| [boto3](https://pypi.org/project/boto3/) | 1.43.97 | Apache-2.0 |
| [Pillow](https://pypi.org/project/Pillow/) | 12.3.0 | MIT-CMU |
| [pi-heif](https://pypi.org/project/pi-heif/) | 1.4.0 | BSD-3-Clause; decoding-only HEIF package, with bundled libheif/libde265 notices retained in its wheel |
| [Authlib](https://pypi.org/project/Authlib/) | 1.8.0 | BSD-3-Clause |
| [HTTPX](https://pypi.org/project/httpx/) | 0.28.1 | BSD-3-Clause |
| [ItsDangerous](https://itsdangerous.palletsprojects.com/) | 2.2.0 | BSD |
| [opencv-python-headless](https://pypi.org/project/opencv-python-headless/) | 5.0.0.93 | Apache-2.0 package; inspect bundled native-library notices before distribution |
| [ijson](https://pypi.org/project/ijson/) | 3.5.0 | BSD-3-Clause AND ISC |
| [NumPy](https://pypi.org/project/numpy/) (transitive) | 2.5.3 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 |

Development dependencies include pytest 9.1.1 (MIT) and Ruff 0.16.8 (MIT). Authlib/Starlette currently emit three upstream deprecation warnings around HTTPX/AnyIO integration; tests pass with the pinned versions. Changes to those dependencies require an OIDC/browser regression run.

The September 19 photo-format update adds the pinned `pi-heif` decoder. The inspected Linux x86_64 wheel contains libheif 1.23.0 and libde265 1.1.0, dynamically loaded from `pi_heif.libs`; its distribution includes native-library license texts. Preserve those LGPL notices and applicable source/replacement obligations in release artifacts. Native code is shipped in the server image only. Published Python 3.13 wheels cover x86_64 and ARM64, but this update was executed on x86_64; ARM64 installation remains a separate qualification. Pillow supplies the AVIF, TIFF, WebP and LittleCMS paths. The Docker build checks decoder availability. `pillow-heif==1.7.0` is used only in an ephemeral fixture-generation environment; it is not an application dependency. Its encoder produces original synthetic test images, without redistributing external photos. Technical references: [Pillow-Heif plugin behavior](https://pillow-heif.readthedocs.io/en/stable/pillow-plugin.html), [orientation handling](https://pillow-heif.readthedocs.io/en/stable/workaround-orientation.html), and [Pillow's supported formats](https://pillow.readthedocs.io/en/stable/handbook/image-file-formats.html).

## Browser and build tooling

The checked-in [npm lockfile](../apps/web/package-lock.json) records exact versions/integrity and package license metadata: React/React DOM 19.3.0 (MIT), Vite 8.3.0 (MIT), TypeScript 7.0.2 (Apache-2.0), Vite React plugin 6.1.1 (MIT), and Playwright 1.63.0 (Apache-2.0). The production client does not ship the catalog, OpenCV, or a recognition model. npm's audit reported no known vulnerabilities for the installed browser package set during this build; that is a point-in-time result, not a security certification.

Container images and build tools are pinned by digest in [Compose](../compose.yaml), [backend Dockerfile](../services/backend/Dockerfile), [web Dockerfile](../apps/web/Dockerfile), and [test scripts](../scripts/test-browser.sh): Python 3.13 slim Bookworm, Node 24 Bookworm slim, nginx unprivileged stable Alpine, PostgreSQL 17 Bookworm, Valkey 9.1.2, SeaweedFS 4.47, Keycloak 26.7.4, uv 0.12.16, and Playwright 1.63.0 Noble. These images contain operating-system packages with additional notices. PostgreSQL uses the PostgreSQL license, Valkey BSD-3-Clause, and SeaweedFS/Keycloak Apache-2.0. Record image SBOMs and distribution obligations before publishing built images.

## Bundled typography and interface assets

DM Sans and Fraunces are bundled as unmodified Latin WOFF2 subsets, each under the SIL Open Font License 1.1. Their copyright notices, full license texts, download URLs, and checksums are included in [the font directory](../apps/web/public/fonts/README.md). These assets retain their own licenses independently of the application's source-available license. The browser and login theme load fonts from this installation, with system fallback for other scripts; there are no runtime requests to a font service. The PakTrak mark, card-and-trail illustration, and interface icons are original SVG/CSS in the repository. Home-screen PNGs are rendered from the mark; [the brand guide](BRAND.md) records their source and regeneration command. These decorative assets contain no third-party card artwork.

The login theme extends Keycloak's bundled theme without copying its authentication templates. Its configuration follows the [Keycloak theme guide](https://www.keycloak.org/ui-customization/themes); repeat login, registration, and password validation checks when updating the pinned provider.

## Provider data and recognition assets

| Source | Use and constraints | Evidence / remaining gate |
| --- | --- | --- |
| [Scryfall API rules](https://scryfall.com/docs/api) | Free card metadata for an added-value collection tool. Public catalog endpoints expose no holdings. Do not imply endorsement, paywall the data, or redistribute a simple proxy/repackaging as the product. | Primary documentation retrieved September 18, 2026. Metadata is prepared by the daily server worker or operator CLI, not committed to Git. |
| [Scryfall bulk data](https://scryfall.com/docs/api/bulk-data) | Current bulk exports are gzipped JSON Lines. Use print-level Default Cards or All Cards; Oracle/Unique Artwork alone cannot represent all printings. | The actual default-card manifest dated 2026-09-18 was loaded: 108,883 paper printings. Source URL and checksum are stored in PostgreSQL. |
| [Scryfall rate limits](https://scryfall.com/docs/api/rate-limits) | Use bulk data/local lookup for large catalogs and cache downloads. Search/named/random/collection currently have stricter endpoint-specific limits than the general API limit. | Loader performs one manifest request and one data download; successful catalog downloads are reused for 24 hours. Recognition/import lookup makes no per-card API calls. |
| [Scryfall image rules](https://scryfall.com/docs/api) | Preserve copyright/artist attribution and permitted presentation when adding reference images. | Full gallery images are cached unmodified in private storage, with copyright/artist credits and badges outside the artwork. No embeddings or recognition index exist. User-photo crops are separate. |
| [Wizards Fan Content Policy](https://company.wizards.com/en/legal/fancontentpolicy) | Magic-related fan content and third-party artwork retain separate rights; the project's license does not grant card-art ownership. | Unofficial attribution in README; no provider art or real personal photos distributed as fixtures. Recheck release presentation before publication. |
| [ManaBox transfer guide](https://www.manabox.app/guides/collection/import-export/) | Establishes CSV import/export as the transfer route. It is not a grant to ship other people's collection files or a compatibility certificate. | Actual authorized CSV exports and destination-app tests still missing. The interface uses generic CSV/text labels; no universal destination compatibility claim is made. |
| [OpenCV contour features](https://docs.opencv.org/4.x/dd/d49/tutorial_py_contour_features.html) | Local geometry-based region proposals. No learned weights used. | Synthetic geometry, transport and a private 15-card development photo checked; no held-out real-photo recognition qualification. |

This inventory is intentionally separate from the project license. Before M5, include all transitive runtime/build dependencies, native libraries, fonts/icons, datasets, models, and container packages in a reproducible notice/SBOM process and resolve any outstanding distribution obligations.

Daily price feeds use TCGplayer market estimates supplied by Scryfall, Card Kingdom’s public retail pricelist and ManaPool’s public near-mint listing feed. Source names, finish, price meaning and cached timestamps are shown. Their data keeps its separate rights and is not bundled in Git or application images. [Card data and pricing](CARD_DATA.md) links the primary provider references and documents daily caching, units, image presentation and failures.

## Server OCR packages

The backend Dockerfile installs Debian Bookworm `tesseract-ocr=5.3.0-2` and `tesseract-ocr-eng=1:4.1.0-2`, with `OMP_THREAD_LIMIT=1`. The English `tessdata_fast` model runs entirely on the server. Both installed package copyright manifests identify Apache-2.0: `/usr/share/doc/tesseract-ocr/copyright` and `/usr/share/doc/tesseract-ocr-eng/copyright`; the complete license is retained at `/usr/share/common-licenses/Apache-2.0`. These packages also bring native runtime dependencies that must be included in the release SBOM/notices review. Package versions were checked against the configured Debian archive and installed manifests.
