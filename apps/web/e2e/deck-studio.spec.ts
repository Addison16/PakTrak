import { expect, test } from "@playwright/test";
import { fixture, printings } from "./deck-fixture";

for (const deckId of ["saved-deck", "partners"]) test(`${deckId} banner defaults to its commanders without shelf-only cover metadata`, async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const mock = await fixture(page, true);
  const saved = mock.decks.find(deck => deck.id === deckId)!;
  const cards = saved.cards.map((card: any) => ({ ...card, printing: printings.find(printing => printing.id === card.printing_id)!, owned: 0, needed_in_deck: card.quantity, available: 0, missing: card.quantity, locations: [] }));
  // The real detail API sends full cards, without the list API's cover/preview fields.
  const detail = { ...saved, cards, copies: cards.reduce((sum: number, card: any) => sum + card.quantity, 0), owned_copies: 0, missing_copies: 0, missing_cards: [] };
  await page.route(`**/api/v1/decks/${deckId}`, route => route.fulfill({ json: detail }));
  await page.locator(`.deck-box-button[data-deck-id="${deckId}"]`).click();
  const images = page.locator(".deck-hero-art img");
  const commanders = cards.filter((card: any) => card.section === "commander");
  await expect(images).toHaveCount(commanders.length);
  for (let index = 0; index < commanders.length; index++) await expect(images.nth(index)).toHaveAttribute("src", `/api/v1/card-images/${commanders[index].printing.id}/0/art`);
  await page.reload();
  await expect(images).toHaveCount(commanders.length);
  for (let index = 0; index < commanders.length; index++) await expect(images.nth(index)).toHaveAttribute("src", `/api/v1/card-images/${commanders[index].printing.id}/0/art`);
});

for (const mode of ["light", "dark"] as const) for (const width of [320, 390, 1280]) test(`${mode} cinematic deck and art view fit ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  await page.emulateMedia({ colorScheme: mode, reducedMotion: "reduce" });
  const mock = await fixture(page, true);
  await page.getByRole("button", { name: /Partners in adventure/ }).click();
  const hero = page.locator(".deck-hero");
  await expect(hero.locator(".deck-hero-art img")).toHaveCount(2);
  await expect(page.getByRole("heading", { name: "Partners in adventure", exact: true })).toBeVisible();
  const gallery = page.locator(".deck-gallery").first();
  expect((await gallery.boundingBox())!.y).toBeLessThan(844);
  await page.getByRole("button", { name: "Art view", exact: true }).click();
  await expect(page.locator(".deck-detail")).toHaveAttribute("data-art-view", "true");
  await expect(page.getByRole("button", { name: "Exit art view", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `../../artifacts/deck-studio/art-${mode}-${width}.png`, fullPage: true });
  await page.reload();
  await expect(page.getByRole("button", { name: "Exit art view", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Exit art view", exact: true }).click();
  await expect(page.locator(".deck-detail")).not.toHaveAttribute("data-art-view");
  expect(mock.calls.filter(call => call.method !== "GET")).toHaveLength(0);
});

test("flying artwork lands precisely on the matching card in the loaded gallery", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await fixture(page);
  await page.getByRole("button", { name: /Friday night/ }).click();
  const opening = page.locator(".deck-opening--revealing");
  await expect(opening).toBeVisible();
  const matches = await opening.evaluate(root => {
    const flights = [...root.querySelectorAll<HTMLElement>(".deck-opening-card[data-landing-printing-id]")];
    return flights.map(flight => {
      const animation = flight.getAnimations().find(candidate => candidate.effect instanceof KeyframeEffect && candidate.effect.getKeyframes().length === 3)!;
      animation.pause();
      animation.currentTime = Number(animation.effect!.getTiming().delay) + Number(animation.effect!.getTiming().duration);
      const target = [...document.querySelectorAll<HTMLElement>(".deck-gallery .deck-art-button")].find(card => card.dataset.printingId === flight.dataset.landingPrintingId && card.dataset.cardSection === flight.dataset.landingSection)!;
      const from = flight.getBoundingClientRect(), to = target.getBoundingClientRect();
      return { id: flight.dataset.printingId, target: target.dataset.printingId, visible: to.top < innerHeight && to.bottom > 0, x: Math.abs(from.x - to.x), y: Math.abs(from.y - to.y), width: Math.abs(from.width - to.width), height: Math.abs(from.height - to.height) };
    });
  });
  expect(matches.length).toBeGreaterThan(0);
  expect(matches.some(match => match.visible)).toBe(true);
  for (const match of matches) {
    expect(match.id).toBe(match.target);
    expect(Math.max(match.x, match.y, match.width, match.height)).toBeLessThan(2);
  }
  await expect(page.locator(".deck-opening")).toHaveCount(0);
  await expect(page.locator("[data-deck-landing]")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Friday night", exact: true })).toBeFocused();
});

test("Back during card landing restores every hidden gallery image", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await fixture(page);
  await page.getByRole("button", { name: /Friday night/ }).click();
  await expect(page.locator(".deck-opening--revealing")).toBeVisible();
  await page.evaluate(() => history.back());
  await expect(page.getByRole("heading", { name: "Your decks", exact: true })).toBeVisible();
  await expect(page.locator(".deck-opening")).toHaveCount(0);
  await expect(page.locator("[data-deck-landing]")).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: /Friday night/ }).click();
  await expect(page.locator(".deck-gallery .deck-art-button").first()).toBeVisible();
});

test("a failed hero image leaves the title and deck controls readable", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await fixture(page);
  await page.route("**/api/v1/card-images/**", route => route.fulfill({ status: 503, body: "Artwork temporarily unavailable" }));
  await page.getByRole("button", { name: /Friday night/ }).click();
  await expect(page.locator(".deck-hero-art img")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Friday night", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Customize case", exact: true })).toBeVisible();
});
