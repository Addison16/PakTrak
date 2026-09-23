# PakTrak

**Every card. In reach.**

Use **PakTrak**, with a capital P and T, for the application name. The identity connects collecting with finding a card's physical home: paired cards, a P-shaped route, and a small endpoint marker. Keep interface copy direct, welcoming and focused on the collector's cards, binders, boxes and decks.

## Palette and typography

| Role | Color |
| --- | --- |
| Deep teal: brand, primary buttons, selected navigation | `#163e38` |
| Parchment: page background | `#f5f1e9` |
| Paper: panels and forms | `#fffdf8` |
| Muted surface: secondary controls and filter panels | `#f2f1e9` |
| Control borders | `#cbd1c7` |
| Copper: accents, links, keyboard focus | `#a1532e` |
| Gold: highlights on dark surfaces | `#e7bf78` |
| Ink: body text | `#203d37` |
| Muted text | `#636d66` |

DM Sans supplies interface text and the wordmark; Fraunces supplies display headings and collection totals. Fonts are bundled locally with their original [licenses and notices](../apps/web/public/fonts/README.md). Use gold for decoration on light surfaces, not small text. Preserve visible keyboard focus and touch-friendly controls.

Page and banner backgrounds are solid. In Light mode, primary actions, selected filter pills, selected gallery/list controls and the current navigation item share deep teal with paper-colored text. Dark mode uses a deep green page (`#0f1b19`), raised panels (`#182724`), pale text (`#edf2ea`), mint actions (`#9bd3bd`) with dark labels, and a brighter copper accent (`#e5aa7f`). Unselected controls use paper or muted surfaces from the active palette. Dropdowns keep their native selection behavior with an explicit arrow and appearance reset so Safari and Chrome render the same control colors. Modal backdrops use neutral charcoal. Card art and uploaded photos keep their original colors.

**Menu → Appearance** offers Auto, Light and Dark, with the same selector on the welcome, sign-in and registration screens. Auto defaults to the [device/browser preference](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-color-scheme) and uses its [change event](https://developer.mozilla.org/en-US/docs/Web/API/MediaQueryList/change_event) to respond without reloading. The browser stores manual choices locally; appearance is a device preference, independent of account pricing preferences. Storage events synchronize open tabs. An external script applies the choice before the main bundle, and shared CSS supplies a system-based fallback. Native controls use the selected [color scheme](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/color-scheme); forced-colors accessibility overrides remain available.

## Assets

- [Card-and-route mark](../apps/web/public/brand/paktrak-mark.svg): original SVG for the header, favicon, footer and home-screen icons.
- [Card-and-trail illustration](../apps/web/public/brand/paktrak-trail.svg): original SVG for the welcome and scan screens.
- [Web manifest](../apps/web/public/manifest.webmanifest): PakTrak name, colors and home-screen icon metadata. It does not provide offline processing.
- [Login theme](../infra/themes/paktrak/login/): matching colors, locally bundled fonts and a copy of the mark; authentication templates remain inherited from Keycloak.
- [Appearance palette](../apps/web/public/appearance-v1.css) and [early theme selection](../apps/web/public/appearance-v1.js): shared with the login theme through a read-only Compose mount.

The 180, 192 and 512-pixel PNG icons, login favicon and legacy `public/icon.svg` are generated from the mark. After installing the web dependencies using the project's pinned Node container, render them from the repository root:

```sh
docker run --rm --user "$(id -u):$(id -g)" --ipc host \
  -v "$PWD:/workspace" -w /workspace \
  mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27 \
  node scripts/render-brand-icons.mjs
```

The script also updates the login theme's `resources/img/paktrak-mark.svg` from the same source. Decorative branding should not compete with the actual card artwork in the collection gallery.

Existing internal installation identifiers retain their earlier names to preserve volumes and account sessions; see [operations](OPERATIONS.md). PakTrak is the public display name.
