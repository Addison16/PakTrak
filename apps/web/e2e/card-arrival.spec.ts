import { expect, test, type Locator, type Page } from "@playwright/test";
import { fixture as deckFixture } from "./deck-fixture";

const image = '<svg xmlns="http://www.w3.org/2000/svg" width="488" height="680"><rect width="488" height="680" rx="20" fill="#183b38"/><rect x="20" y="20" width="448" height="640" rx="12" fill="#dfd0b2"/><rect x="42" y="100" width="404" height="330" fill="#486e74"/><text x="42" y="70" font-size="28" fill="#183b38">Arrival fixture</text></svg>';
const collectionPrinting = { id: "arrival-card", name: "Island", set_code: "tst", collector_number: "1", set_name: "Arrival fixtures", language: "en", rarity: "common", type_line: "Basic Land — Island", finishes: ["nonfoil"], image_url: "/api/v1/card-images/arrival-card/0/grid" };
const collectionCard = { printing: collectionPrinting, quantity: 2, location_count: 1, locations: [{ id: "arrival-binder", name: "Blue binder", quantity: 2 }], value: "2.00", price_min: "1.00", price_max: "1.00", priced_copies: 2 };

async function collectionFixture(page: Page, direct = false) {
  const writes: string[] = [];
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== "GET") writes.push(path);
    if (path.startsWith("/api/v1/card-images/")) return route.fulfill({ contentType: "image/svg+xml", body: image });
    let json: unknown;
    if (path === "/api/auth/session") json = { owner_id: "arrival-owner", display_name: "Collector", role: "member", csrf_token: "fixture", tour_dismissed: true, preferred_price_source: "tcgplayer", scan_cards_used: 0, scan_card_limit: null, scan_cards_remaining: null };
    else if (path === "/api/auth/status") json = { setup_required: false, guest_signup_enabled: true };
    else if (path === "/api/v1/capabilities") json = { max_upload_bytes: 104857600 };
    else if (path === "/api/v1/collection/cards") json = { copies: 2, cards: 1, items: [collectionCard], next_offset: null, valuation: { provider: "tcgplayer", amount: "2.00", priced_copies: 2, unpriced_copies: 0, feed: null } };
    else if (path === "/api/v1/collection/cards/arrival-card") json = collectionCard;
    else if (path === "/api/v1/collection/printings/arrival-card") json = { printing: collectionPrinting, faces: [{ name: "Island", type_line: collectionPrinting.type_line, image_url: collectionPrinting.image_url }], legalities: {}, prices: [], released_at: null, scryfall_url: null };
    else if (path === "/api/v1/collection/filters") json = { sets: [] };
    else if (path === "/api/v1/binders") json = { items: [{ id: "arrival-binder", name: "Blue binder", kind: "binder", copies: 2, version: 1, notes: "" }] };
    else if (path === "/api/v1/collection") json = { items: [], next_offset: null };
    else if (path === "/api/v1/data/status") json = { feeds: [] };
    else if (path === "/api/v1/catalog/status") json = { printings: 1 };
    else if (["/api/v1/scans", "/api/v1/decks", "/api/v1/imports", "/api/v1/exports"].includes(path)) json = { items: [], next_offset: null };
    else return route.fulfill({ status: 500, json: { detail: "Unexpected arrival fixture endpoint " + path } });
    await route.fulfill({ json });
  });
  await page.goto(direct ? "/#/collection?card=arrival-card" : "/#/collection");
  await expect(page.locator(".gallery-grid")).toHaveAttribute("aria-busy", "false");
  return writes;
}

async function openDeck(page: Page) {
  const mock = await deckFixture(page);
  await page.goto("/#/decks/saved-deck");
  await expect(page.getByRole("heading", { name: "Friday night", exact: true })).toBeVisible();
  return mock;
}

async function launch(source: Locator) {
  await source.scrollIntoViewIfNeeded();
  await expect.poll(() => source.locator(".card-art img").evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
  await source.focus();
  // Capture and activate in one task: pointer effects and history cannot move the
  // original card between our measurement and the application's click handler.
  return source.evaluate((element: HTMLButtonElement) => {
    const rect = element.querySelector(".card-art img")!.getBoundingClientRect();
    const result = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    element.click();
    return result;
  });
}

async function measureFlight(page: Page, targetSelector: string) {
  const flight = page.locator(".card-arrival-card");
  await expect(flight).toBeVisible();
  await expect.poll(() => flight.evaluate(element => element.getAnimations().length)).toBeGreaterThan(0);
  // Fast detail responses can recenter the dialog in the animation's first
  // frame. Let its ResizeObserver deliver the path seen at the next paint.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return flight.evaluate((element, selector) => {
    const placement = element.getAnimations().find(animation => animation.effect instanceof KeyframeEffect)!;
    const solid = element.querySelector<HTMLElement>(".card-arrival-solid")!;
    const spins = solid.getAnimations();
    placement.pause(); for (const spin of spins) { spin.pause(); spin.currentTime = 0; }
    placement.currentTime = 0;
    const origin = element.getBoundingClientRect();
    const target = document.querySelector(selector)!.getBoundingClientRect();
    const duration = Number(placement.effect!.getTiming().duration);
    placement.currentTime = Number(placement.effect!.getTiming().delay) + duration;
    for (const spin of spins) spin.currentTime = Number(spin.effect!.getTiming().duration);
    const landed = element.getBoundingClientRect();
    const rect = (value: DOMRect) => ({ x: value.x, y: value.y, width: value.width, height: value.height });
    return { origin: rect(origin), target: rect(target), landed: rect(landed), cardKey: (element as HTMLElement).dataset.cardKey, duration };
  }, targetSelector);
}

for (const width of [320, 1280]) for (const area of ["deck", "collection"] as const) {
  test(`${area} card lifts from its image and lands in the viewer at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    if (area === "deck") await openDeck(page); else await collectionFixture(page);
    const source = area === "deck" ? page.getByRole("button", { name: /Preview Fixture Card 1/ }) : page.getByRole("button", { name: /Open Island/ });
    const origin = await launch(source);
    const measured = await measureFlight(page, area === "deck" ? ".deck-preview-art .card-art" : ".detail-art .card-art");
    expect(measured.cardKey).toBe(area === "deck" ? "deck-card-0_main" : "arrival-card");
    expect(measured.duration).toBeLessThanOrEqual(1000);
    for (const coordinate of ["x", "y", "width", "height"] as const) {
      expect(Math.abs(measured.origin[coordinate] - origin[coordinate]), JSON.stringify({ coordinate, origin, measured })).toBeLessThan(2);
      expect(Math.abs(measured.landed[coordinate] - measured.target[coordinate]), JSON.stringify({ coordinate, measured })).toBeLessThan(2);
    }
    await expect(page.locator(".card-arrival-stage")).toHaveCount(0);
    await expect(page.locator("[data-card-flight-hidden]")).toHaveCount(0);
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.getByRole("dialog").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}

for (const area of ["deck", "collection"] as const) test(`${area} list thumbnail spins from its smaller slot into the viewer`, async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  if (area === "deck") await openDeck(page); else await collectionFixture(page);
  await page.getByRole("button", { name: "List", exact: true }).click();
  const source = area === "deck" ? page.getByRole("button", { name: /Preview Fixture Card 1/ }) : page.getByRole("button", { name: /Open Island/ });
  const origin = await launch(source);
  expect(origin.width).toBeLessThan(100);
  const measured = await measureFlight(page, area === "deck" ? ".deck-preview-art .card-art" : ".detail-art .card-art");
  for (const coordinate of ["x", "y", "width", "height"] as const) {
    expect(Math.abs(measured.origin[coordinate] - origin[coordinate]), JSON.stringify({ coordinate, origin, measured })).toBeLessThan(2);
    expect(Math.abs(measured.landed[coordinate] - measured.target[coordinate]), JSON.stringify({ coordinate, measured })).toBeLessThan(2);
  }
  await expect(page.locator(".card-arrival-stage")).toHaveCount(0);
  await expect(page.locator("[data-card-flight-hidden]")).toHaveCount(0);
});

test("spinning card keeps a visible painted edge when viewed side on", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  await collectionFixture(page);
  await launch(page.getByRole("button", { name: /Open Island/ }));
  const flight = page.locator(".card-arrival-card");
  await expect(flight).toBeVisible();
  await expect.poll(() => flight.evaluate(element => element.getAnimations().length)).toBeGreaterThan(0);
  const solid = flight.locator(".card-arrival-solid");
  const visibility = await solid.evaluate(element => {
    for (const animation of element.parentElement!.getAnimations()) { animation.pause(); animation.currentTime = Number(animation.effect!.getTiming().duration) / 2; }
    const rotation = element.getAnimations().find(animation => animation.effect instanceof KeyframeEffect)!;
    rotation.pause(); rotation.currentTime = Number(rotation.effect!.getTiming().duration) * .48;
    const backFacesViewer = new DOMMatrixReadOnly(getComputedStyle(element).transform).m11 < -.8;
    for (const animation of element.getAnimations()) animation.cancel();
    // Check the material at the exact angle where a flat card would disappear.
    (element as HTMLElement).style.transform = "rotateY(90deg)";
    const edges = [...element.querySelectorAll<HTMLElement>(".card-arrival-edge")].map(edge => {
      const rect = edge.getBoundingClientRect(), style = getComputedStyle(edge);
      return { width: rect.width, height: rect.height, opacity: Number(style.opacity), painted: style.backgroundColor !== "rgba(0, 0, 0, 0)" || style.backgroundImage !== "none" };
    });
    return { backFacesViewer, edges };
  });
  expect(visibility.backFacesViewer).toBe(true);
  expect(visibility.edges.some(edge => edge.width >= 0.5 && edge.height > 10 && edge.opacity > 0 && edge.painted)).toBe(true);
  await page.screenshot({ path: "/tmp/paktrak-card-arrival-artifacts/side-edge.png" });
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-card-flight-hidden]")).toHaveCount(0);
});

for (const cleanup of ["Escape", "Back", "resize"] as const) test(`${cleanup} during arrival restores the collection image`, async ({ page }) => {
  await collectionFixture(page);
  const source = page.getByRole("button", { name: /Open Island/ });
  await launch(source);
  await expect(page.locator(".card-arrival-stage")).toBeVisible();
  if (cleanup === "Escape") await page.keyboard.press("Escape");
  else if (cleanup === "Back") await page.evaluate(() => history.back());
  else await page.setViewportSize({ width: 720, height: 800 });
  await expect(page.locator(".card-arrival-stage")).toHaveCount(0);
  await expect(page.locator("[data-card-flight-hidden]")).toHaveCount(0);
  await expect(source.locator(".card-art")).toBeVisible();
  if (cleanup !== "resize") {
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page).not.toHaveURL(/card=arrival-card/);
    await expect.poll(() => source.evaluate(element => ({ focused: document.activeElement === element, active: document.activeElement?.outerHTML.slice(0, 180) }))).toMatchObject({ focused: true });
  } else {
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.locator(".detail-art .card-art")).toBeVisible();
  }
});

test("deck Next and history Forward open viewers without replaying an origin flight", async ({ page }) => {
  await openDeck(page);
  await launch(page.getByRole("button", { name: /Preview Fixture Card 2/ }));
  await expect(page.locator(".card-arrival-stage")).toBeVisible();
  await page.getByRole("button", { name: "Next →", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Fixture Card 1", exact: true })).toBeVisible();
  await expect(page.locator(".card-arrival-stage")).toHaveCount(0);
  await expect(page.locator("[data-card-flight-hidden]")).toHaveCount(0);
  await page.evaluate(() => history.back());
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.evaluate(() => history.forward());
  await expect(page.getByRole("dialog", { name: "Fixture Card 1", exact: true })).toBeVisible();
  await expect(page.locator(".card-arrival-stage")).toHaveCount(0);
  await expect(page.locator("[data-card-flight-hidden]")).toHaveCount(0);
});

test("late collection rules and prices retarget the flight after the dialog recenters", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  await collectionFixture(page);
  const oracle = "Create a beautiful place for every card. ".repeat(22);
  await page.route("**/api/v1/collection/printings/arrival-card", async route => {
    await new Promise(resolve => setTimeout(resolve, 200));
    await route.fulfill({ json: { printing: collectionPrinting, faces: [{ name: "Island", type_line: collectionPrinting.type_line, image_url: collectionPrinting.image_url, oracle_text: oracle, artist: "Fixture illustrator" }], legalities: { commander: "legal" }, released_at: null, prices: [{ provider: "tcgplayer", name: "TCGplayer", kind: "Reference price", feed: null, finishes: [{ finish: "nonfoil", amount: "1.00", available: true, url: null }] }] } });
  });
  const origin = await launch(page.getByRole("button", { name: /Open Island/ }));
  await expect(page.locator(".card-arrival-stage[data-card-arrival-ready]")).toBeVisible();
  await expect(page.locator(".oracle-text")).toHaveText(oracle.trim());
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const measured = await measureFlight(page, ".detail-art .card-art");
  for (const coordinate of ["x", "y", "width", "height"] as const) {
    expect(Math.abs(measured.origin[coordinate] - origin[coordinate]), JSON.stringify({ coordinate, origin, measured })).toBeLessThan(2);
    expect(Math.abs(measured.landed[coordinate] - measured.target[coordinate]), JSON.stringify({ coordinate, measured })).toBeLessThan(2);
  }
  await expect(page.locator(".card-arrival-stage")).toHaveCount(0);
  await expect(page.locator("[data-card-flight-hidden]")).toHaveCount(0);
});

test("changing a double-faced card during arrival restores both images without replaying", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  await collectionFixture(page);
  await page.route("**/api/v1/collection/printings/arrival-card", route => route.fulfill({ json: { printing: collectionPrinting, faces: [{ name: "Island", image_url: collectionPrinting.image_url }, { name: "Island after sunset", image_url: "/api/v1/card-images/arrival-card/1/grid" }], legalities: {}, prices: [], released_at: null } }));
  await launch(page.getByRole("button", { name: /Open Island/ }));
  await expect(page.locator(".card-arrival-stage[data-card-arrival-ready]")).toBeVisible();
  await page.getByRole("button", { name: "View other face", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Island after sunset", exact: true })).toBeVisible();
  await expect(page.locator(".card-arrival-stage")).toHaveCount(0);
  await expect(page.locator("[data-card-flight-hidden]")).toHaveCount(0);
  await page.getByRole("button", { name: "View front face", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Island", exact: true })).toBeVisible();
  await expect(page.locator(".card-arrival-stage")).toHaveCount(0);
  await expect(page.locator(".detail-art .card-art")).toBeVisible();
});

test("changing to reduced motion during arrival immediately reveals the real card", async ({ page }) => {
  await collectionFixture(page);
  await launch(page.getByRole("button", { name: /Open Island/ }));
  await expect(page.locator(".card-arrival-stage[data-card-arrival-ready]")).toBeVisible();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".card-arrival-stage")).toHaveCount(0);
  await expect(page.locator("[data-card-flight-hidden]")).toHaveCount(0);
  await expect(page.locator(".detail-art .card-art")).toBeVisible();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(page.locator(".card-arrival-stage")).toHaveCount(0);
});

for (const area of ["deck", "collection"] as const) test(`${area} direct links and reduced motion present the card immediately`, async ({ page }) => {
  if (area === "deck") { await openDeck(page); await page.goto("/#/decks/saved-deck?card=deck-card-0_main"); }
  else await collectionFixture(page, true);
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator(".card-arrival-stage")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const source = area === "deck" ? page.getByRole("button", { name: /Preview Fixture Card 1/ }) : page.getByRole("button", { name: /Open Island/ });
  await source.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator(".card-arrival-stage")).toHaveCount(0);
  await expect(page.locator("[data-card-flight-hidden]")).toHaveCount(0);
  await expect(page.getByRole("dialog").locator(".card-art").first()).toBeVisible();
});
