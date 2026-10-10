# Gallery, card data and prices

Collection opens a card-art gallery. One tile represents an exact printing with a duplicate quantity counter. Tap for rules text, faces, set/artist information, format legality, prices, and editable copies/locations. Gallery/list views, name and rules-text search, color identity, type, rarity, set, owned finish and location filters operate on the signed-in collector's holdings. Shuffle stays stable until requested again. Totals cover the entire filtered collection before its 40-printing page limit.

Search accepts a trailing collector number: `Plains #287` matches that number exactly, and `#287` alone finds owned cards with that number. Letter and symbol suffixes are preserved. Combine this with the set filter when multiple editions share a number. The same shortcut works in printing correction, scan approval, collection import repair and deck pickers, using the local catalog without additional provider requests.

Search and photo identification also recognize alternate printed titles, localized names and individual card-face names saved in the catalog. For example, `Search for the Frozen Esper` finds the FCA #47 printing of `Nature's Claim`. Printing choices and scan review show both titles when they differ; saved card identity and exports retain the canonical name. Collection and deck imports accept these aliases with the usual printing checks. Existing catalogs work immediately after upgrading; use **Check photo again** for pending scans made before the fix. Localized names require the corresponding printings in the local catalog, and OCR still depends on readable text.

**Price source** is always visible next to the collection totals, with TCGplayer, Card Kingdom and ManaPool choices. The choice is saved to the signed-in account and restored on other devices until the collector changes it. A previously saved browser choice is carried over only when the account has no saved source. Saving failures are shown with a retry option.

**Sort by** is visible without opening Filters. **Price: Low to high** uses the lowest priced owned finish per printing; **Price: High to low** uses the highest. Both use the selected source, sort the complete filtered collection before pagination, and put cards without a quote last. Ties use a stable printing order. Copy quantities do not change per-copy price ordering.

**Filters → Price range** accepts an inclusive minimum, maximum, or both in USD per copy from that source. The range applies to each owned finish before grouping: a printing with differently priced foil/nonfoil copies shows only matching copies. Unknown finishes, missing quotes and custom-value cards cannot match a price range. Totals and locations follow the matching copies; the active range can be cleared without opening Filters. Changing source also changes the range's results and price order.

To correct a recorded card, open its details, then **Manage copies → Edit card details**. The printing picker filters the saved catalog by card name, set/expansion, rarity, collector number and language. Selecting a printing updates its set, rarity, artwork and price references together; rarity comes from that printing's catalog entry. Finish can also be corrected, with validation against the selected printing. Changes apply to every copy in the selected group. Quantities, physical locations, notes and original import/scan provenance are preserved, and corrections are audited with version checks and retry protection. New exports reflect the correction; import undo still removes only its own copies. Saved decks retain their explicitly selected printings and show current availability.

## Price meanings

All amounts are **USD reference prices**, updated daily rather than live quotes. The source selector controls the gallery and its collection estimate; card details compare sources for a selected finish.

| Display | Source | Meaning |
| --- | --- | --- |
| TCGplayer | Scryfall bulk `prices.usd`, `usd_foil`, `usd_etched` | TCGplayer **market** price via Scryfall. [Scryfall explains its price sources](https://scryfall.com/docs/faqs/where-do-scryfall-prices-come-from-7). |
| Card Kingdom | [Public pricelist](https://api.cardkingdom.com/api/v2/pricelist), `price_retail` | Near-mint retail reference. A reference can remain available when near-mint stock is zero, which is shown in details. It is not a buylist price. |
| ManaPool | [Public API](https://manapool.com/api/docs/v1), `/api/v1/prices/singles`, `price_cents_nm` and finish variants | Lowest near-mint listing, converted from cents. Missing listings stay missing; another finish or grade is not substituted. |

Prices match exact Scryfall printing IDs and finishes. Ambiguous duplicate store mappings, missing/zero/nonfinite prices and unsupported finishes are excluded. Estimates multiply each recorded finish's reference price by its quantity. Unknown finishes, altered cards and misprints remain **unpriced**, with an explicit count. The gallery distinguishes a missing recorded finish from a missing provider quote and a custom-value card. Its unpriced explanation gives separate copy counts and a filter for unknown finishes. Text imports default unmarked entries to nonfoil, with an option to keep them unknown; blank CSV finishes remain unknown. Condition is preserved but the app does not invent condition discounts. Prices omit shipping and tax and are not an offer to buy a collection. Historical charts and price alerts are not implemented.

TCGplayer's [developer guide](https://docs.tcgplayer.com/docs/getting-started) currently says new API keys are not being granted. The app uses market estimates supplied by Scryfall, without a developer account or storefront scraping. Card Kingdom and ManaPool's public feeds were fetched successfully without credentials on September 18, 2026. External schemas can change; failures preserve the last usable snapshot.

## Background updates and time estimates

Compose starts a separate `data-worker`. It prepares the default Scryfall catalog and three price sources automatically, then waits at least 24 hours between successful updates per feed. Recent catalog imports are reused. PostgreSQL stores schedules, errors, last successful update times and progress. An advisory lock permits one updater across replicas; restarts retain cooldowns. Failed sources retry independently with increasing delays. HTTP 429/503 `Retry-After` values are respected without immediate retries.

**Card data & prices** in Collection, Import/export and Administration shows current steps, cache/source timestamps and scheduled checks. Sources older than 48 hours are flagged. Card Kingdom's source timestamp has no timezone and is labeled accordingly. “Saved” means a successful server cache update, not a transaction time on a marketplace.

Downloads/catalog indexing report bytes and estimate remaining time in the current step from observed speed. Collection previews/additions report rows, with estimates after a measurable sample. Queue wait, unknown-size steps, startup and stalled progress remain indeterminate rather than showing fabricated countdowns. Estimates vary with load and network speed and exclude later steps. CSV additions still require review/ownership confirmation.

Accepted photo/collection jobs and data updates do not need a connected phone. Browsing schedules no per-card metadata or price API calls. A missing card image is downloaded by the server when first viewed and stored unmodified for reuse. Browsers receive same-origin URLs and cache them privately for a day. Image requests check collection ownership or ownership of the reviewing scan. Manual printing previews also require an owned, undeleted scan and a catalog printing; arbitrary URL proxying is not provided. Scan suggestions reuse this unmodified cache for local artwork comparison; no whole-catalog embedding index is stored.

## Provider usage and presentation

The updater requests one Scryfall bulk manifest per refresh and downloads its referenced file. Imports and searches use PostgreSQL. This is below Scryfall's [documented endpoint limits](https://scryfall.com/docs/api/rate-limits): currently 2 requests/second for search/named/random/collection, 10/minute for manifest, and 10/second for other API endpoints. The `cards.scryfall.io` file origin has no hard API rate limit. Requests identify the app with `User-Agent` and `Accept` headers and use fixed HTTPS provider hosts.

Full images preserve aspect ratio and artist/copyright text; quantity badges sit outside artwork. There are no watermarks, recoloring, art crops, or bundled card-art fixtures. Card details are available through free collection accounts. Provider data and Wizards' imagery retain their rights independently of PakTrak's software license. See [source rights](DEPENDENCIES.md) and [Scryfall's usage rules](https://scryfall.com/docs/api).

## Operations and boundaries

Use `docker compose logs --tail 50 data-worker` for results and the app disclosure for progress/errors. Restarting the worker retains daily schedules and cooldowns. Initial preparation can take several minutes. Outages do not stop browsing saved data, importing against the local catalog or processing photos.

Each daily catalog download also fetches Scryfall's **Rulings** bulk file and replaces the saved rulings, which card details list under the card with format legality. A failed rulings download keeps the previous rulings and never delays prices. Rulings first appear after the first daily catalog update that includes them; a catalog loaded only through the CLI brings no rulings until the next daily update.

The automatic catalog is **Default Cards**, primarily English plus cards unavailable in English. Operators can load All Cards through the catalog CLI for localized printing resolution, but daily price coverage is based on the most recent snapshot and is not a guarantee of language-specific market data. Referenced printings remain in the database after later imports.

Prices/schedules live in the `database` volume. Viewed reference images use `catalog-images/` in the private bucket in `photos`; uploads and derived scan images have separate prefixes. Bulk staging uses a temporary directory removed after each attempt. Do not commit downloaded datasets or private volumes to Git.
