import { expect, test, type Locator, type Page } from "@playwright/test";
import { fixture as deckFixture } from "./deck-fixture";

const image = '<svg xmlns="http://www.w3.org/2000/svg" width="488" height="680"><rect width="488" height="680" rx="20" fill="#183b38"/><rect x="20" y="20" width="448" height="640" rx="12" fill="#dfd0b2"/><rect x="42" y="100" width="404" height="330" fill="#486e74"/><text x="42" y="70" font-size="28" fill="#183b38">Arrival fixture</text></svg>';
const collectionPrinting = { id: "arrival-card", name: "Island", set_code: "tst", collector_number: "1", set_name: "Arrival fixtures", language: "en", rarity: "common", type_line: "Basic Land — Island", finishes: ["nonfoil"], image_url: "/api/v1/card-images/arrival-card/0/grid" };
const collectionCard = { printing: collectionPrinting, quantity: 2, location_count: 1, locations: [{ id: "arrival-binder", name: "Blue binder", quantity: 2 }], value: "2.00", price_min: "1.00", price_max: "1.00", priced_copies: 2 };

async function collectionFixture(page: Page, direct = false, artwork?: string) {
  const writes: string[] = [];
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== "GET") writes.push(path);
    if (path.startsWith("/api/v1/card-images/")) return route.fulfill({ contentType: "image/svg+xml", body: artwork || image });
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

async function openDeck(page: Page, artwork?: string) {
  const mock = await deckFixture(page, false, artwork);
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
    // Resume after seeking so completion follows the browser's timeline.
    placement.play(); for (const spin of spins) spin.play();
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
  let release!: () => void;
  const detailsReady = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/v1/collection/printings/arrival-card", async route => {
    await detailsReady;
    await route.fulfill({ json: { printing: collectionPrinting, faces: [{ name: "Island", type_line: collectionPrinting.type_line, image_url: collectionPrinting.image_url, oracle_text: oracle, artist: "Fixture illustrator" }], legalities: { commander: "legal" }, released_at: null, prices: [{ provider: "tcgplayer", name: "TCGplayer", kind: "Reference price", feed: null, finishes: [{ finish: "nonfoil", amount: "1.00", available: true, url: null }] }] } });
  });
  const origin = await launch(page.getByRole("button", { name: /Open Island/ }));
  await expect(page.locator(".card-arrival-stage[data-card-arrival-ready]")).toBeVisible();
  const before = await page.locator(".card-arrival-card").evaluate(element => {
    const animation = element.getAnimations()[0];
    animation.pause(); animation.currentTime = Number(animation.effect!.getTiming().duration) * .45;
    const rect = document.querySelector(".detail-art .card-art")!.getBoundingClientRect();
    return { transform: [...new DOMMatrixReadOnly(getComputedStyle(element).transform).toFloat64Array()], targetY: rect.y };
  });
  release();
  await expect(page.locator(".oracle-text")).toHaveText(oracle.trim());
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const after = await page.locator(".card-arrival-card").evaluate(element => ({ transform: [...new DOMMatrixReadOnly(getComputedStyle(element).transform).toFloat64Array()], targetY: document.querySelector(".detail-art .card-art")!.getBoundingClientRect().y }));
  expect(Math.abs(after.targetY - before.targetY)).toBeGreaterThan(5);
  for (let index = 0; index < before.transform.length; index++) expect(Math.abs(after.transform[index] - before.transform[index])).toBeLessThan(.01);
  const measured = await measureFlight(page, ".detail-art .card-art");
  for (const coordinate of ["x", "y", "width", "height"] as const) {
    expect(Math.abs(measured.origin[coordinate] - origin[coordinate]), JSON.stringify({ coordinate, origin, measured })).toBeLessThan(2);
    expect(Math.abs(measured.landed[coordinate] - measured.target[coordinate]), JSON.stringify({ coordinate, measured })).toBeLessThan(2);
  }
  await expect(page.locator(".card-arrival-stage")).toHaveCount(0);
  await expect(page.locator("[data-card-flight-hidden]")).toHaveCount(0);
});

test("card translation and rotation keep their speed through intermediate poses", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  await collectionFixture(page);
  await launch(page.getByRole("button", { name: /Open Island/ }));
  await expect(page.locator(".card-arrival-stage[data-card-arrival-ready]")).toBeVisible();
  const discontinuities = await page.locator(".card-arrival-card").evaluate(flight => {
    const sample = (element: Element, offsets: number[]) => {
      const animation = element.getAnimations()[0]; animation.pause();
      const duration = Number(animation.effect!.getTiming().duration);
      const matrix = (time: number) => {
        animation.currentTime = time;
        return [...new DOMMatrixReadOnly(getComputedStyle(element).transform).toFloat64Array()];
      };
      return offsets.map(offset => {
        const at = matrix(duration * offset), before = matrix(duration * offset - 2), after = matrix(duration * offset + 2);
        const incoming = at.map((value, index) => value - before[index]), outgoing = after.map((value, index) => value - at[index]);
        const length = (values: number[]) => Math.hypot(...values);
        return length(incoming.map((value, index) => value - outgoing[index])) / Math.max(length(incoming), length(outgoing));
      });
    };
    return [...sample(flight, [.48]), ...sample(flight.querySelector(".card-arrival-solid")!, [.26, .48, .7])];
  });
  for (const discontinuity of discontinuities) expect(discontinuity).toBeLessThan(.15);
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-card-flight-hidden]")).toHaveCount(0);
});

for (const area of ["deck", "collection"] as const) for (const ending of ["complete", "resize"] as const) test(`${area} ${ending} hides the flight before its transform resets`, async ({ page }) => {
  await page.addInitScript(() => {
    const cancel = Animation.prototype.cancel;
    (window as any).arrivalResets = [];
    (window as any).viewerResets = [];
    Animation.prototype.cancel = function () {
      const element = this.effect instanceof KeyframeEffect ? this.effect.target : null;
      cancel.call(this);
      if (element instanceof HTMLElement && element.matches(".card-arrival-card") && element.isConnected) {
        const rect = element.getBoundingClientRect();
        (window as any).arrivalResets.push({ visibility: getComputedStyle(element).visibility, x: rect.x, y: rect.y });
      }
      if (element instanceof HTMLElement && element.isConnected && element.closest(".card-arrival-stage")) {
        const viewer = element.closest("dialog")?.querySelector(".detail-art .card-art, .deck-preview-art .card-art");
        if (viewer) (window as any).viewerResets.push(getComputedStyle(viewer).visibility);
      }
    };
  });
  if (area === "deck") await openDeck(page); else await collectionFixture(page);
  await launch(page.getByRole("button", { name: area === "deck" ? /Preview Fixture Card 1/ : /Open Island/ }));
  await expect(page.locator(".card-arrival-stage[data-card-arrival-ready]")).toBeVisible();
  if (ending === "resize") await page.evaluate(() => window.dispatchEvent(new Event("resize")));
  await expect(page.locator(".card-arrival-stage")).toHaveCount(0);
  const resets = await page.evaluate(() => (window as any).arrivalResets as { visibility: string; x: number; y: number }[]);
  expect(resets.length).toBeGreaterThan(0);
  for (const reset of resets) expect(reset.visibility, JSON.stringify(reset)).toBe("hidden");
  const viewerResets = await page.evaluate(() => (window as any).viewerResets as string[]);
  expect(viewerResets.length).toBeGreaterThan(0);
  for (const visibility of viewerResets) expect(visibility).toBe("visible");
  await expect(page.locator("[data-card-flight-hidden]")).toHaveCount(0);
  await expect(page.getByRole("dialog").locator(".card-art").first()).toBeVisible();
});

for (const response of ["loaded", "failed"] as const) test(`collection keeps painted artwork after landing while the detail image is ${response}`, async ({ page }) => {
  await collectionFixture(page);
  const detailUrl = "/api/v1/card-images/arrival-card/0/detail";
  let release!: () => void, requested!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const imageRequested = new Promise<void>(resolve => { requested = resolve; });
  await page.route("**/api/v1/card-images/arrival-card/0/detail", async route => {
    requested(); await pending;
    if (response === "failed") await route.abort();
    else await route.fulfill({ contentType: "image/svg+xml", body: image });
  });
  await page.route("**/api/v1/collection/printings/arrival-card", route => route.fulfill({ json: {
    printing: collectionPrinting,
    faces: [{ name: "Island", type_line: collectionPrinting.type_line, image_url: detailUrl }],
    legalities: {}, prices: [], released_at: null, scryfall_url: null,
  } }));
  try {
    await launch(page.getByRole("button", { name: /Open Island/ }));
    await imageRequested;
    await expect(page.locator(".card-arrival-stage")).toHaveCount(0);
    const viewer = page.locator(".detail-art .card-art img");
    const before = await viewer.evaluate((image: HTMLImageElement) => ({ src: image.getAttribute("src"), complete: image.complete && image.naturalWidth > 0, visibility: getComputedStyle(image).visibility }));
    expect(before).toEqual({ src: collectionPrinting.image_url, complete: true, visibility: "visible" });
    const failure = response === "failed" ? page.waitForEvent("requestfailed", { predicate: request => request.url().endsWith(detailUrl) }) : null;
    release();
    if (response === "loaded") {
      await expect(viewer).toHaveAttribute("src", detailUrl);
      await expect.poll(() => viewer.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    } else {
      await failure;
      await expect(viewer).toHaveAttribute("src", collectionPrinting.image_url);
      await expect(page.locator(".detail-art .art-placeholder")).toHaveCount(0);
    }
    await expect(viewer).toBeVisible();
    await expect(page.locator("[data-card-flight-hidden]")).toHaveCount(0);
  } finally { release(); }
});

for (const width of [320, 1280]) for (const area of ["deck", "collection"] as const) test(`${area} handoff keeps the front artwork painted at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  await page.addInitScript(() => {
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      const animation = animate.apply(this, args);
      // Freeze the final crossfade so screenshots can inspect every surface
      // without missing the brief back-face flash in WebKit.
      if (this.matches(".card-arrival-solid > *") && Array.isArray(args[0]) && args[0].some(frame => "opacity" in frame)) animation.pause();
      return animation;
    };
  });
  if (area === "deck") await openDeck(page, image); else await collectionFixture(page);
  await launch(page.getByRole("button", { name: area === "deck" ? /Preview Fixture Card 1/ : /Open Island/ }));
  const front = page.locator(".card-arrival-front");
  await expect.poll(() => front.evaluate(element => element.getAnimations().length)).toBeGreaterThan(0);
  const art = page.locator(area === "deck" ? ".deck-preview-art .card-art" : ".detail-art .card-art");
  await expect(art).toBeVisible();
  for (const progress of [0, .5, 1]) {
    await page.evaluate(progress => {
      for (const element of document.querySelectorAll(".card-arrival-solid > *")) {
        for (const animation of element.getAnimations()) animation.currentTime = Number(animation.effect!.getTiming().duration) * progress;
      }
    }, progress);
    const raster = await art.screenshot();
    const painted = await page.evaluate(async raster => {
      const image = new Image(); image.src = raster;
      await image.decode();
      const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
      return [...context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data];
    }, `data:image/png;base64,${raster.toString("base64")}`);
    // Compositing identical colors can round each channel by one value.
    const difference = Math.max(...[72, 110, 116, 255].map((expected, channel) => Math.abs(painted[channel] - expected)));
    expect(difference, `front artwork at handoff progress ${progress}: ${painted}`).toBeLessThanOrEqual(2);
  }
  await page.evaluate(() => {
    for (const element of document.querySelectorAll(".card-arrival-solid > *")) for (const animation of element.getAnimations()) animation.play();
  });
  await expect(page.locator(".card-arrival-stage")).toHaveCount(0);
  await expect(art).toBeVisible();
  await expect(page.locator("[data-card-flight-hidden]")).toHaveCount(0);
});

test("late layout changes leave enough time for a smooth landing", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  await collectionFixture(page);
  const oracle = "Create a beautiful place for every card. ".repeat(22);
  let release!: () => void;
  const detailsReady = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/v1/collection/printings/arrival-card", async route => {
    await detailsReady;
    await route.fulfill({ json: { printing: collectionPrinting, faces: [{ name: "Island", image_url: collectionPrinting.image_url, oracle_text: oracle }], legalities: {}, prices: [], released_at: null, scryfall_url: null } });
  });
  await launch(page.getByRole("button", { name: /Open Island/ }));
  await expect(page.locator(".card-arrival-stage[data-card-arrival-ready]")).toBeVisible();
  const before = await page.locator(".card-arrival-card").evaluate(element => {
    const animation = element.getAnimations()[0];
    animation.pause(); animation.currentTime = Number(animation.effect!.getTiming().duration) * .86;
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, targetY: document.querySelector(".detail-art .card-art")!.getBoundingClientRect().y };
  });
  release();
  await expect(page.locator(".oracle-text")).toHaveText(oracle.trim());
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const after = await page.locator(".card-arrival-card").evaluate(element => {
    const animation = element.getAnimations()[0], rect = element.getBoundingClientRect();
    const target = document.querySelector(".detail-art .card-art")!;
    return { x: rect.x, y: rect.y, targetY: target.getBoundingClientRect().y, remaining: Number(animation.effect!.getTiming().duration) - Number(animation.currentTime), targetVisibility: getComputedStyle(target).visibility };
  });
  expect(Math.abs(after.targetY - before.targetY)).toBeGreaterThan(5);
  expect(Math.abs(after.x - before.x)).toBeLessThan(.01);
  expect(Math.abs(after.y - before.y)).toBeLessThan(.01);
  expect(after.remaining).toBeGreaterThanOrEqual(200);
  expect(after.targetVisibility).toBe("hidden");
  const measured = await measureFlight(page, ".detail-art .card-art");
  expect(Math.abs(measured.landed.y - measured.target.y)).toBeLessThan(2);
  await expect(page.locator(".card-arrival-stage")).toHaveCount(0);
  await expect(page.locator("[data-card-flight-hidden]")).toHaveCount(0);
});

for (const width of [320, 1280]) for (const area of ["deck", "collection"] as const) test(`${area} enlarged artwork clips pale image corners at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  // JPEG card images paint the area outside their printed corners white.
  const jpegCorners = '<svg xmlns="http://www.w3.org/2000/svg" width="488" height="680"><rect width="488" height="680" fill="white"/><rect width="488" height="680" rx="22" fill="#183b38"/></svg>';
  if (area === "deck") await openDeck(page, jpegCorners); else await collectionFixture(page, false, jpegCorners);
  await page.getByRole("button", { name: area === "deck" ? /Preview Fixture Card 1/ : /Open Island/ }).click();
  const art = page.getByRole("dialog").locator(".card-art").first();
  await expect.poll(() => art.locator("img").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  expect(await art.locator("img").evaluate((image: HTMLImageElement) => {
    const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
    return [...context.getImageData(0, 0, 1, 1).data];
  })).toEqual([255, 255, 255, 255]);
  await page.addStyleTag({ content: ".detail-art, .deck-preview-art { background: #df4080; } .card-art { box-shadow: none; }" });
  const raster = await art.screenshot({ path: `/tmp/paktrak-card-polish/${area}-${width}-corners.png` });
  const whitePixels = await page.evaluate(raster => new Promise<number>((resolve, reject) => {
    const image = new Image();
    image.onerror = reject;
    image.onload = () => {
      const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let white = 0;
      // Exclude the fractional row captured just outside the artwork's bounds.
      for (let y = 1; y < canvas.height - 1; y++) for (let x = 1; x < canvas.width - 1; x++) {
        const index = (y * canvas.width + x) * 4;
        if (pixels[index] > 245 && pixels[index + 1] > 245 && pixels[index + 2] > 245) white++;
      }
      resolve(white);
    };
    image.src = raster;
  }), `data:image/png;base64,${raster.toString("base64")}`);
  expect(whitePixels).toBeLessThanOrEqual(2);
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
