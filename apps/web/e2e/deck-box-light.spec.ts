import { expect, test, type Page } from "@playwright/test";
import { navigate } from "./navigation";

async function shelf(page: Page) {
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    let json: unknown = {};
    if (path === "/api/auth/session") json = { owner_id: "box-light-fixture", display_name: "Deck collector", csrf_token: "fixture-csrf", role: "member", tour_dismissed: true, preferred_price_source: "tcgplayer", scan_cards_used: 0, scan_card_limit: null, scan_cards_remaining: null };
    else if (path === "/api/auth/status") json = { setup_required: false, guest_signup_enabled: true };
    else if (path === "/api/v1/capabilities") json = { max_upload_bytes: 104857600 };
    else if (path === "/api/v1/scans") json = { items: [], next_offset: null };
    else if (path === "/api/v1/decks") json = { items: [{ id: "night-deck", name: "Midnight collection", format: "commander", match_mode: "exact", notes: "", version: 1, copies: 100, colors: ["U"], cover_cards: [] }], next_offset: null };
    return route.fulfill({ json });
  });
  await page.goto("/");
  await navigate(page, "Decks");
  return page.getByRole("button", { name: /^Open Midnight collection/ });
}

test("pointer light follows the cursor and resets on leave and cancellation", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const box = await shelf(page);
  const bounds = await box.locator(".deck-box").boundingBox();
  if (!bounds) throw new Error("Deck box did not render");
  await page.mouse.move(bounds.x + bounds.width * .2, bounds.y + bounds.height * .25);
  await expect(box).toHaveAttribute("data-box-light", "active");
  await expect.poll(() => box.evaluate((el) => parseFloat((el as HTMLElement).style.getPropertyValue("--box-light-x")))).toBeCloseTo(20, 0);
  const firstTurn = await box.evaluate((el) => (el as HTMLElement).style.getPropertyValue("--box-turn-y"));
  await page.mouse.move(bounds.x + bounds.width * .8, bounds.y + bounds.height * .6);
  await expect.poll(() => box.evaluate((el) => parseFloat((el as HTMLElement).style.getPropertyValue("--box-light-x")))).toBeCloseTo(80, 0);
  expect(await box.evaluate((el) => (el as HTMLElement).style.getPropertyValue("--box-turn-y"))).not.toBe(firstTurn);
  await expect(box.locator(".deck-box-light").first()).toHaveCSS("opacity", "1");
  await page.mouse.move(5, 5);
  await expect(box).not.toHaveAttribute("data-box-light", "active");
  expect(await box.evaluate((el) => (el as HTMLElement).style.getPropertyValue("--box-light-x"))).toBe("");
  await page.mouse.move(bounds.x + bounds.width * .5, bounds.y + bounds.height * .5);
  await expect(box).toHaveAttribute("data-box-light", "active");
  await box.dispatchEvent("pointercancel", { pointerType: "mouse" });
  await expect(box).not.toHaveAttribute("data-box-light", "active");
  expect(errors).toEqual([]);
});

test("pointer tilt stops when reduced motion is enabled and ignores touch", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  const box = await shelf(page);
  await box.hover();
  await expect(box).toHaveAttribute("data-box-light", "active");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(box).not.toHaveAttribute("data-box-light", "active");
  await box.hover({ position: { x: 20, y: 20 } });
  await expect(box).not.toHaveAttribute("data-box-light", "active");
  await page.mouse.move(5, 5);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await box.dispatchEvent("pointerenter", { pointerType: "touch", clientX: 40, clientY: 40 });
  await box.dispatchEvent("pointermove", { pointerType: "touch", clientX: 60, clientY: 80 });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect(box).not.toHaveAttribute("data-box-light", "active");
});
