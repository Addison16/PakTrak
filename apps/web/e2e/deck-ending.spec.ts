import { expect, test } from "@playwright/test";
import { fixture } from "./deck-fixture";

for (const width of [320, 390, 1280]) test(`a full deck ends without jumping or piling duplicate cards into the gallery at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const mock = await fixture(page, true);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/v1/decks/partners", async route => { await gate; await route.fallback().catch(() => {}); });

  try {
    await page.locator('.deck-box-button[data-deck-id="partners"]').click();
    const opening = page.locator(".deck-opening");
    await expect(opening.locator(".deck-opening-card")).toHaveCount(12);
    await expect(opening.locator(".eyebrow")).toHaveText("OPENING DECK");
    const settled = await opening.locator(".deck-opening-card").evaluateAll(elements => elements.map(element => [...new DOMMatrixReadOnly(getComputedStyle(element).transform).toFloat64Array()]));
    release();
    await expect(page.locator(".deck-opening--revealing")).toBeVisible();
    const ending = await opening.evaluate((root, settled) => {
      const animations = root.getAnimations({ subtree: true });
      animations.forEach(animation => animation.pause());
      const flights = [...root.querySelectorAll<HTMLElement>(".deck-opening-card")];
      const motions = flights.map(flight => flight.getAnimations().find(animation => animation.effect instanceof KeyframeEffect && animation.effect.getKeyframes().some(frame => frame.transform !== undefined))!);
      motions.forEach(animation => { animation.currentTime = 0; });
      const jump = Math.max(...flights.flatMap((flight, index) => [...new DOMMatrixReadOnly(getComputedStyle(flight).transform).toFloat64Array()].map((value, channel) => Math.abs(value - settled[index][channel]))));
      const targets = [...document.querySelectorAll<HTMLElement>(".deck-gallery .deck-art-button")];
      const landings = flights.filter(flight => flight.dataset.landingPrintingId).map(flight => {
        const target = targets.find(target => target.dataset.printingId === flight.dataset.landingPrintingId && target.dataset.cardSection === flight.dataset.landingSection)!;
        const rect = target.getBoundingClientRect();
        return { key: `${target.dataset.printingId}_${target.dataset.cardSection}`, visible: rect.left < innerWidth && rect.right > 0 && rect.top < innerHeight && rect.bottom > 0 };
      });
      const hidden = document.querySelectorAll("[data-deck-landing]").length;
      motions.forEach(animation => { animation.currentTime = Number(animation.effect!.getTiming().delay) + Number(animation.effect!.getTiming().duration); });
      const exits = flights.filter(flight => !flight.dataset.landingPrintingId).map(flight => {
        const rect = flight.getBoundingClientRect();
        return rect.right <= 0 || rect.left >= innerWidth || rect.bottom <= 0 || rect.top >= innerHeight;
      });
      animations.forEach(animation => animation.play());
      return { jump, landings, hidden, exits };
    }, settled);
    expect(ending.jump).toBeLessThan(.01);
    expect(ending.landings.length).toBeGreaterThan(0);
    expect(new Set(ending.landings.map(landing => landing.key)).size).toBe(ending.landings.length);
    expect(ending.landings.every(landing => landing.visible)).toBe(true);
    expect(ending.hidden).toBe(ending.landings.length);
    expect(ending.exits.length).toBeGreaterThan(0);
    expect(ending.exits.every(offscreen => offscreen)).toBe(true);
    await expect(opening).toHaveCount(0);
    await expect(page.locator("[data-deck-landing]")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Partners in adventure", exact: true })).toBeFocused();
    expect(mock.calls.filter(call => call.method !== "GET")).toHaveLength(0);
  } finally { release(); }
});

test("a delayed final flight keeps its artwork visible and finishes before the presentation clears", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await fixture(page, true);
  await page.locator('.deck-box-button[data-deck-id="partners"]').click();
  const opening = page.locator(".deck-opening--revealing");
  await expect(opening).toBeVisible();
  const last = opening.locator(".deck-opening-card").last();
  await last.evaluate(flight => {
    const movement = flight.getAnimations().find(animation => animation.effect instanceof KeyframeEffect && animation.effect.getKeyframes().some(frame => frame.transform !== undefined))!;
    movement.pause();
    movement.currentTime = 0;
  });
  // Hold one browser animation beyond the old 890ms wall-clock cleanup.
  await page.waitForTimeout(1100);
  await expect(opening).toBeVisible();
  expect(await last.evaluate(flight => Number(getComputedStyle(flight).opacity))).toBe(1);
  await last.evaluate(flight => flight.getAnimations().find(animation => animation.effect instanceof KeyframeEffect && animation.effect.getKeyframes().some(frame => frame.transform !== undefined))!.play());
  await expect(opening).toHaveCount(0);
  await expect(page.locator("[data-deck-landing]")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Partners in adventure", exact: true })).toBeFocused();
});
