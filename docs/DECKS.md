# Deck plans and missing-card lists

**Decks** shows a paginated shelf of deck boxes, two across on narrow phones and three across on larger screens. Each box uses the combined color identity of its mainboard and commander cards, with blended colors for multicolor decks and a neutral box when the deck is colorless, empty or has no known colors. Sideboard extras do not change the box color. Commander boxes feature their selected commander, or both partners; an unselected commander has a crown placeholder. Other formats feature a mainboard card, preferring nonland cards with the most copies. Names, formats and card counts appear below the boxes, and accessible button labels also identify the colors and featured cards.

The cases have compact matte bodies, continuous beveled corners and bases, softly finished slim lids, discreet PakTrak branding, and large recessed commander artwork windows. A narrow lid seam and close contact shadow give the surfaces a consistent fit. Small color symbols complement the case colors; names and metadata align across each row. Saved finishes, emblems, and featured artwork still apply. Opening a case rotates its slim lid around a rear hinge, revealing the lined interior as cards rise above the front wall. The shelf follows the light/dark theme, and hover, press, and opening effects respect reduced-motion preferences. Decorative construction uses CSS and inline SVG without additional image downloads.

Open a box for a separate overview with a card-image gallery by Commander, Mainboard and Sideboard. **Gallery / List** switches between full card previews and compact rows; search and the missing-only filter work in either view. Tap a card for a larger image, its edition, quantities and binder/box locations, with **Previous / Next** at the bottom. Missing artwork has a named placeholder. **Back to decks** at the top and **Close deck** at the bottom return to the shelf and restore focus to the opened box. **New deck** opens the name form; creating an empty deck opens its editor, where an existing-deck import is already available.

Deck searches accept `Name #number` (for example, `Plains #287`) or `#287` alone to match an exact collector number. This works when filtering a saved deck, finding cards you own and adding any catalog card. Catalog pickers also offer set, rarity and language filters to distinguish matching editions.

**Edit deck** reveals name, format, matching settings, notes, quantities and section controls. **Save deck** saves and keeps the editor open. **Save & done** saves and returns to the overview; when there are no edits, the button reads **Done editing**. Closing or using the menu with unfinished changes asks before discarding them. Cancelling keeps the inputs. Navigation waits for an active save or import preview. Accepted imports save immediately and return to the overview. Unsaved inputs remain in memory while open; the app requests a browser unload warning, which mobile browsers may not always display.

**Copies in deck** can be cleared before typing a replacement such as `30`. Blank or invalid quantities stay visible with a field message and block saving until completed; whole numbers from 0 to 100,000 are accepted, and leading zeros are normalized when leaving a valid field. A quantity of `0` keeps the row available for editing and marks it for removal when saving. The save and legality check omit those zero-copy entries; physical collection quantities are unaffected.

Open **Decks → Import deck list**, paste a list or choose a CSV/text file, then preview it. **Match by name · use my editions** is the default for new and existing decks. Listed editions are replaced with an edition you own: keep the requested printing if owned, otherwise choose the printing with the most owned copies, with deterministic tie-breaking. The preview labels collection matches. A card without matching holdings keeps its catalog printing. Review matches, choose a card for unresolved rows, or explicitly exclude a row. Importing saves a deck plan and opens its image gallery; it never adds cards to your collection or consumes a guest's photo allowance.

**Keep listed editions only** is an explicit opt-in for exact-printing deck plans. Changing this choice clears the previous preview so it must be checked again. Collection matching is also applied on the server when saving an import, using current holdings and combining resulting duplicate printing/section rows. A repeated accepted request returns its saved deck without selecting editions again, even if holdings subsequently change.

Plain text accepts names with optional quantities (`4 Card name` or `4x Card name`), optional `(SET)` / `[SET]` codes and collector numbers, and Mainboard, Sideboard or Commander headings. `SB:` marks an individual sideboard line. CSV accepts common name/quantity columns plus optional Set Code, Collector Number, Language, Scryfall ID and Section. Matching uses the local catalog in batches, including split-card faces and available translated names, with no external per-card requests. Art inserts do not make an otherwise matching playable card ambiguous; explicit printing identifiers can still select them.

Preview is limited to 300 card lines and 256 KiB of UTF-8 content. The file picker also decodes UTF-16 files with a byte-order mark. Missing identities and invalid quantities/sections stay visible until corrected or excluded. An exact-printing deck can change any representative printing in the preview. Foil suffixes in text are accepted, but deck plans do not currently track finish preferences.

### Commander import layout

Choose **Commander** as the deck format. For a list without section labels, the default layout assigns the first card to Commander, the next 99 copies to Mainboard, and everything after card 100 to Sideboard. Quantities count as copies: a line of basic lands can be split between mainboard and extras without losing any copies. The preview shows the assigned counts before saving.

**First two cards are commanders** uses two commanders and 98 mainboard cards for partner decks. **Use listed sections only** leaves unmarked cards in Mainboard. Any explicit text section heading, `SB:` line or nonempty CSV Section/Board/Zone value preserves the whole list's supplied sections instead of applying positional layout. A CSV with an entirely blank Section column still receives the automatic layout. Invalid quantities must be corrected before automatic layout can run. Changing format, layout or replace/add mode clears the preview so the new interpretation can be reviewed.

Commander has no playable sideboard. PakTrak saves those extra cards for planning, displays them as extras in the legality panel, and excludes them from the 100-card deck and Commander legality checks. They remain in collection comparisons and exports.

## Scanning a physical deck

Choose **Decks → Scan a deck**, enter a name and format, then **Take deck photos**. An existing deck has a **Scan cards** button. Photograph about 15 separated cards at a time, using the camera or photo picker; repeat for the rest of the deck. Upload acceptance stores the destination and processing choice on the server, so the phone can disconnect while identification continues. Each photo appears in Batches and the deck’s linked-photo list.

Deck scans default to leaving collection quantities unchanged. **Also add scanned copies to my collection** opts that photo into the normal collection workflow; use it only for copies not already recorded. Both choices consume the same lifetime card-scan allowance and follow account pauses/caps. Normal collection uploads retain their existing behavior.

Deck-only matches above the configured automatic-match threshold are marked **Auto-matched**; other suggestions need **Approve match** in batch review. Corrections, manual outlines and foil selection use the usual review tools without creating inventory. The deck plan itself tracks printing, quantity and section, not finish preferences.

From a batch, choose **Continue building deck**, or return to **Decks → your deck → Scan cards**. Select photo batches and choose **Preview scanned cards**. Reviewed cards appear with images and section selectors. Set the commander (or both partners), keep other cards in Mainboard, choose Sideboard for extras, or **Leave out for now**. Unlike an ordered text list, photo positions do not imply commander order. Preview refreshes preserve existing section choices; newly reviewed cards start in Mainboard.

**Add N scanned cards to deck** adds one deck copy per pictured card and combines identical printings in the same section. Pending/unmatched cards stay excluded and can be added later. Processing batches must finish before saving. Up to 32 batches/1,024 photographed cards can be selected per preview, within the existing 300-entry deck limit. Previously added source cards are shown as already added; retries and concurrent saves cannot add the same photo card to the same deck twice. A new photo of the same physical card counts as another source card, so avoid photographing a pile twice.

Saving opens the normal deck gallery, including collection comparison, legality, tokens and exports. Saved deck cards are a snapshot: later batch corrections or deletion do not silently rewrite the deck. Edit its saved list to change/remove those entries. Deleting a collection-enabled batch still removes its remaining collection copies and updates deck availability. Lifetime scan usage is never refunded by deleting a batch or deck.

**Include my other saved batches** can reuse reviewed cards from earlier collection scans without adding collection copies again. An unlinked batch also offers **Build a deck from this batch** to name a new deck and carry that photo into the preview. All source batches and destination decks must belong to the signed-in account.

## Updating an existing deck from a list

Open the saved deck and choose **Import deck list**. Save or discard manual deck edits first. Existing-deck imports preserve its ID, name, format and notes. Import matching starts with **Match by name · use my editions**, including for a deck previously configured for exact editions; the selected import mode becomes the saved deck's matching mode.

- **Replace card list** uses the incoming list as the whole deck. Every section is replaced, including commander and sideboard; cards absent from the new list are removed from the deck plan.
- **Add to current list** keeps the current cards and adds incoming quantities. Collection matching applies to the resulting list; identical printing IDs in the same section are combined. Different sections remain separate entries.

Replacing a Commander list offers the same automatic commander layout as a new import. Adding to an existing deck keeps the current commander(s); unmarked incoming cards go to Mainboard, and explicit section labels are respected.

The preview shows the before/after deck size and counts added/removed copies. Review or exclude unresolved lines before **Replace deck list** or **Add cards to deck**. Combined decks are limited to 300 printing/section entries and 100,000 copies per entry. Neither operation changes collection quantities or scan allowance.

The final list uses the existing atomic, version-checked deck save. Retries reuse the same request receipt, including after an interrupted response. A concurrent edit is rejected; **Reload saved deck** keeps the incoming list and recalculates its impact using the latest saved deck, which must be reviewed before applying. Temporary/network failures retain the original request for retry instead of silently merging the same addition again.

List summaries load up to six distinct printings per deck, prioritizing commander cards, through batched queries. Color identities are read in one narrow batched query covering all mainboard and commander cards, including cards outside the previews. Each visible box lazily loads one cover image, or two for partners. Full deck contents are fetched on opening. Cover artwork uses the catalog's art crop when available, falls back to its normal card image, and shares the existing private image cache and CDN restrictions. Browsing boxes does not request Scryfall metadata per deck. A planned card's artwork can be viewed while it belongs to that owner's active deck, even when no copy is owned.

## Comparing your collection

New decks default to **Any printing of the card**, matching the same full card name or catalog oracle identity across editions. Full-name fallback also handles missing or inconsistent oracle IDs. Art inserts and token/emblem layouts remain separate from playable cards; matching is not fuzzy. **Exact printings only** matches the saved printing ID. Existing saved decks keep their current setting until edited or updated through an import.

The deck shows needed, owned and missing copies, per-card availability, a missing-only filter and binder/box locations. Each owned copy counts once across that deck's commander, mainboard and sideboard, in that order. For example, owning two copies of a card needed once as commander and three times in the mainboard leaves two copies missing. All finishes count. Separate decks do not reserve inventory from one another.

Collection changes appear when reopening a deck or choosing **Refresh collection comparison**. Unsaved deck edits hide the comparison and shopping actions until saved. Locations show all matching copies of that card in each binder/box; the allocated **Have** count is specific to the deck row. Decks can include any catalog card, regardless of current ownership, and never move or consume physical copies.

## Deck value

Every saved deck has a **Deck value** section near the top. It totals the saved editions and quantities across Commander, Mainboard and Sideboard, including cards not yet in the collection. Duplicate copies multiply the selected edition’s unit price. Section subtotals and **Card values and sections** explain the calculation; tap a card name to open its usual preview. **Only unpriced cards** narrows the breakdown to missing quotes.

**Deck price source** selects TCGplayer, Card Kingdom or ManaPool and shares the account’s saved collection price preference. It persists across devices using the existing preference flow, with explicit retry if saving fails. **Refresh value** rereads the server’s cached prices; it does not fetch external store data. Reports show the last successful source update, its price meaning, stale-data notices and a failed-update notice when applicable. All values are USD reference estimates and exclude shipping and tax.

Deck lists save editions and quantities rather than each physical copy’s finish. **Finish for estimate** defaults to **Nonfoil where available**, with foil and etched alternatives. When the selected finish does not exist for that edition, the estimate selects an available finish in nonfoil/foil/etched order and reports the fallback copy count. It never substitutes a different finish, edition or provider just to fill a missing quote. The breakdown names each priced finish. This is a finish-based deck estimate, not an exact valuation of a mixed-finish physical deck or a condition-adjusted resale offer.

Missing quotes are excluded and counted, not treated as zero. A partly priced deck shows **Partial estimate**; an entirely unpriced deck shows a dash and **No prices available**. An empty deck has a zero value. Prices come from the same daily cache as Collection: TCGplayer market via Scryfall, Card Kingdom near-mint retail and ManaPool lowest near-mint listing. Out-of-stock retail references can remain priced. No per-card external pricing calls are made while opening, editing or refreshing a deck.

Valid unsaved quantity and section edits recalculate after a short debounce. Blank/invalid quantities pause the estimate; zero-copy rows are omitted. Late replies from previous source/finish choices are ignored, and a failed value request offers its own retry while preserving the deck edits. Saving a deck includes a fresh default-finish report, and subsequent selected-finish refreshes use the current cards. Price calculations do not alter holdings, deck lists or lifetime scan usage.

## Tokens for the deck

**Tokens for this deck** appears below the card list in both the saved overview and the editor. It lists the token types and emblems linked to cards in the commander, mainboard and sideboard sections. Each row includes artwork when available, power/toughness and colors, rules text, and **Used by** links back to the relevant deck cards. Tap a token image to enlarge it; tokens with two faces offer **View other face**. Sideboard-only entries are marked **Sideboard only**, or **Extras only** for Commander. Searching the deck or showing only missing cards does not hide its token checklist.

Repeated copies and token illustrations with the same catalog oracle identity share a checklist entry. Distinct stats, colors and abilities stay separate through their distinct identities. When an oracle ID is missing, complete matching token characteristics can group printings; incomplete metadata keeps them separate. A linked token missing from the local catalog still appears by name with an explicit details-unavailable message. Tokens and emblems are reference entries: they do not add copies to the collection, count toward deck size, or enter the missing-card buy list or exported deck list.

The checklist updates while editing, including removing cards with quantity zero, and refreshes after a saved/imported replacement list. Invalid or blank quantities pause the draft lookup. Requests are debounced, outdated replies are ignored, and failed lookups offer a retry without losing deck edits. Saving and reopening a deck derives the checklist again from its saved cards and current local catalog.

Relationships come from the cached Scryfall `all_parts` records, resolved in one batched token query rather than per-card metadata requests. Normal combo pieces and meld results are excluded; emblems are included even when their component is `combo_piece`. Authenticated artwork requests must name a token actually linked to their source printing and use the existing allowlisted catalog-image cache. Draft decks can therefore preview tokens without owning them or saving artificial token entries. Existing collection/card-image permissions remain unchanged.

This is a checklist of types, not a fixed token quantity calculation: repeated effects, replacement effects and copies depend on the game. Tokens without catalog links and arbitrary copy effects may need additional markers. The interface explains this limit rather than claiming that an empty list guarantees a deck can never create tokens.

## Checking format legality

The legality panel checks import previews, saved decks and unsaved edits against the selected format. It reports specific issues, links affected cards to their previews, and shows the catalog date and the checks performed. Checks run on the server against its cached Scryfall metadata, with no external per-card requests. Changing cards, quantities, sections or format replaces the previous result; failed requests offer a retry. These are advisory checks, so unfinished or intentionally unusual decks can still be saved.

| Format | Checks |
| --- | --- |
| Standard, Modern, Pioneer, Pauper, Legacy, Vintage | At least 60 mainboard cards, at most 15 sideboard cards, no commander section, format card legality, banned/restricted cards and combined copy limits across sections and printings. Pauper uses card legality rather than the chosen printing's rarity. |
| Commander | Exactly 100 cards including one commander or two compatible commanders; commander eligibility, partner/Background/Doctor pairings, combined color identity including basic land types, format legality and singleton limits. Sideboard extras are excluded. |
| Limited | At least 40 mainboard cards, no commander section and playable paper cards. Duplicate and sideboard counts are unrestricted. The result stays partial because PakTrak cannot verify the event's draft/sealed pool. |
| Casual, Other | No fixed format rules; the panel asks the owner to select a supported format. |

Basic lands and card-specific copy exceptions are respected, including unlimited-copy cards, Seven Dwarves and Nazgûl. Commander eligibility uses the front face, applicable oracle-text exceptions, legendary Vehicles and legendary Spacecraft with power/toughness. Compatible partner variants and commanders that choose a color before the game are supported. Tokens, art inserts, oversized cards and other nonplayable paper printings are flagged.

Missing rules metadata or legality data, or catalog data more than 72 hours old, prevents a clean pass. Card legality follows the existing daily catalog refresh, so newly announced changes may not appear until that refresh. Companion declarations, Commander brackets and event-specific house rules are not checked. A passing result covers the listed checks rather than guaranteeing eligibility at every event.

Construction rules were reviewed on September 20, 2026 against the [official Comprehensive Rules, effective February 27, 2026](https://media.wizards.com/2026/downloads/MagicCompRules%2020260227.pdf) (100, 702.124 and 903), [Tournament Rules, effective February 27, 2026](https://media.wizards.com/ContentResources/WPN/MTG_MTR_2026_Feb27_EN.pdf) (6.1, 6.2 and 7.1), and the [August update bulletin](https://magic.wizards.com/en/news/announcements/the-hobbit-update-bulletin). The rules hub's September 25 document was not yet effective at review time. Current reference links remain available in the app: [official rules](https://magic.wizards.com/en/rules), [Commander](https://magic.wizards.com/en/formats/commander), and [banned and restricted cards](https://magic.wizards.com/en/banned-restricted-list).

## Exporting the missing cards

Expand **Buy list · N missing copies** in the deck overview to copy or download the missing quantities. The panel is collapsed initially so the deck's card list remains easy to reach. Downloads recalculate against current holdings, so newly acquired cards no longer appear. If every requested copy is owned, the **Collection comparison** panel offers a refresh instead.

| Format | Contents |
| --- | --- |
| Card Kingdom text | Combined `quantity Card name` lines, ready to paste into the deck builder. Choose editions, finishes and conditions there. |
| TCGplayer text | Combined quantity/name lines for any-printing decks; `[SET] collector-number` identifiers for exact-printing decks, ready for Mass Entry. |
| ManaPool text | Combined quantity/name lines for any-printing decks; `(SET) collector-number` identifiers for exact-printing decks. |
| Plain text | Combined quantity/name lines without deck section headings. |
| Detailed CSV | Missing quantities/names and match mode; printing IDs, sets, collector numbers and languages are included only for exact-printing decks. |

**Open in TCGplayer**, **Open in ManaPool** and **Open in Card Kingdom** open the selected store in a new tab. TCGplayer's Mass Entry and ManaPool's mass entry open with the missing cards filled in, using the same list as the text above; the list is also copied in case the page opens empty. Card Kingdom's deck builder opens empty, with the list copied to paste. Lists longer than a store page reads from a link (about 7,500 characters) open the empty page and are copied instead. If the server's administrator has added [store referral links](OPERATIONS.md#store-referral-links), these buttons use them and say so.

The links open the [Card Kingdom deck builder](https://www.cardkingdom.com/builder), [TCGplayer Mass Entry](https://www.tcgplayer.com/massentry) or [ManaPool mass entry](https://manapool.com/add-deck); they do not submit a deck or place an order. The output follows the retailers' published text-entry workflows ([Card Kingdom explanation](https://blog.cardkingdom.com/card-kingdom-deck-builder-update/), [TCGplayer instructions](https://help.tcgplayer.com/hc/en-us/articles/360055768913-Getting-Started-With-Mass-Entry), [ManaPool instructions](https://manapool.com/mass-entry-info)). Select Magic: The Gathering on TCGplayer. Store availability, set-code matching, language, finish and condition still need review at the destination. No store credentials or cart integration are required.

Expand **Export deck list** for **Export saved deck as text/CSV**. This includes the full requested list and sections, including owned cards. **Buy the whole deck** opens any of the three stores with every card in the deck, including copies you own, in the same way as the buy list buttons. Detailed CSV escapes spreadsheet formula prefixes. Synthetic round trips and live application tests verify the generated files; retailer checkout and universal third-party importer compatibility are not certified.
