# Third-party notices

PakTrak's [PolyForm Noncommercial license](LICENSE) applies to its original project files. The following components retain their own terms; the project license does not replace them.

## Fonts distributed with the source

| Component | Copyright | License and source record |
| --- | --- | --- |
| DM Sans Latin WOFF2 | Copyright 2014 The DM Sans Project Authors | [SIL Open Font License 1.1](apps/web/public/fonts/dmsans-OFL.txt); [source URL and checksum](apps/web/public/fonts/README.md#dm-sans) |
| Fraunces Latin WOFF2 | Copyright 2018 The Fraunces Project Authors | [SIL Open Font License 1.1](apps/web/public/fonts/fraunces-OFL.txt); [source URL and checksum](apps/web/public/fonts/README.md#fraunces) |

The font files are unmodified subsets and include their full upstream license texts. These font licenses permit uses independently of PakTrak's project license. Original PakTrak SVG/CSS artwork and the PNG icons rendered from it contain no third-party card artwork.

## Software installed when building or running

Python and JavaScript packages are downloaded during the Docker build, rather than vendored into this source repository. Exact versions and hashes are in [uv.lock](uv.lock) and [package-lock.json](apps/web/package-lock.json). The [dependency and source-rights register](docs/DEPENDENCIES.md) identifies direct dependencies, declared licenses, native libraries and container components.

React/React DOM, FastAPI and several other libraries use MIT terms; Vite and its plugin use their upstream permissive terms; TypeScript and Playwright use Apache-2.0. Python libraries, native codecs, system packages and service images carry additional licenses. In particular, Psycopg and the HEIF/native decoding stack include LGPL-covered components. Preserve the notices and applicable source/replacement rights when redistributing built artifacts.

Docker installs Debian's Tesseract OCR and English language data, with their copyright manifests under `/usr/share/doc/tesseract-ocr/` and `/usr/share/doc/tesseract-ocr-eng/`. Container base images include further operating-system components and notices. This source publication does not publish prebuilt application images or claim that a complete image SBOM/source-offer review is finished.

The login theme extends Keycloak's bundled theme without vendoring its authentication templates. Keycloak and SeaweedFS are Apache-2.0 components; PostgreSQL and Valkey retain their respective PostgreSQL and BSD licenses.

## Card data, artwork and pricing

Magic: The Gathering and its trademarks and artwork belong to their respective rights holders, including Wizards of the Coast and card artists. PakTrak is unofficial and is not endorsed by Wizards of the Coast, Scryfall or the pricing providers.

Scryfall metadata/card-face artwork, TCGplayer estimates supplied through Scryfall, Card Kingdom retail references and ManaPool listing prices are retrieved at runtime and keep their provider terms. No downloaded card catalog, card-face artwork, real collection export or private scan photo is bundled in the repository. See [card data and pricing](docs/CARD_DATA.md) for provider references, caching and price meanings.

Decorative card transitions use an unmodified classic Magic: The Gathering card-back image from Scryfall. The image and Magic marks are © Wizards of the Coast and retain separate rights from PakTrak's software license. Its source URL, retrieval date, dimensions and checksum are recorded in [the card asset directory](apps/web/public/cards/README.md).

The test image files are original synthetic transport/geometry/codec fixtures described in [tests/fixtures/README.md](tests/fixtures/README.md). They contain no real card artwork or personal collection data.

## License text

The project license is the unmodified [official PolyForm Noncommercial License 1.0.0](https://github.com/polyformproject/polyform-licenses/blob/1.0.0/PolyForm-Noncommercial-1.0.0.md). The PolyForm Project grants permission to use its license texts in its [license-text notice](https://github.com/polyformproject/polyform-licenses/blob/1.0.0/README.md#license).
