import { expect, test } from "@playwright/test";
import { navigate } from "./navigation";
import { noPriceAlerts } from "./price-alert-fixture";

const printing = (id: string, name: string) => ({ id, name, set_code: "tst", set_name: "Fixture set", collector_number: id.slice(-1), rarity: "rare", language: "en", finishes: ["nonfoil", "foil"], image_url: "/brand/paktrak-mark.svg" });

for (const width of [320, 390, 1280]) test(`a wanted card can carry the most you'd pay at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  const edits: unknown[] = [];
  const items = [
    { id: "want-1", printing: printing("wish-1", "Fixture Captain of the Long Watch"), finish: "any", quantity: 2, notes: "", price_finish: "nonfoil", unit_amount: "12.50", target_price: null as string | null, at_target: false, owned: 0 },
    { id: "want-2", printing: printing("wish-2", "Fixture Island"), finish: "foil", quantity: 1, notes: "", price_finish: "foil", unit_amount: "3.00", target_price: "4.00", at_target: true, owned: 1 },
  ];
  await page.route("**/api/**", async (route) => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (path === "/api/v1/price-alerts") return route.fulfill({ json: noPriceAlerts });
    let json: unknown = {};
    if (path === "/api/auth/session") json = { owner_id: "wish-owner", display_name: "Collector", role: "member", csrf_token: "wish-csrf", tour_dismissed: true, preferred_price_source: "tcgplayer", scan_cards_used: 0, scan_card_limit: null, scan_cards_remaining: null };
    else if (path === "/api/auth/status") json = { setup_required: false, guest_signup_enabled: true };
    else if (path === "/api/v1/capabilities") json = { max_upload_bytes: 104857600 };
    else if (path === "/api/v1/wishlist") json = { provider: "tcgplayer", items, copies: 3, priced_copies: 3, amount: "28.00", at_target: items.filter((item) => item.at_target).length };
    else if (path === "/api/v1/wishlist/want-1" && req.method() === "POST") {
      const body = req.postDataJSON(); edits.push(body); items[0].quantity = body.quantity;
      if ("target_price" in body) { items[0].target_price = body.target_price; items[0].at_target = body.target_price !== null && Number(body.target_price) >= 12.5; }
      json = { id: "want-1" };
    }
    else if (path === "/api/v1/data/status") json = { feeds: [] };
    else if (["/api/v1/scans", "/api/v1/decks", "/api/v1/imports", "/api/v1/exports", "/api/v1/binders", "/api/v1/trade-offers", "/api/v1/friends"].includes(path)) json = { items: [], next_offset: null };
    else { await route.fulfill({ status: 404, json: { detail: "Not in fixture: " + path } }); return; }
    await route.fulfill({ json });
  });
  await page.goto("/");
  await navigate(page, "Wishlist");
  await expect(page.getByText("1 card is at or under the price you set.")).toBeVisible();
  await expect(page.locator(".wish-reached")).toHaveText(["At your price"]);
  const box = page.getByLabel("Most you’d pay for one Fixture Captain of the Long Watch");
  await expect(page.getByLabel("Most you’d pay for one Fixture Island")).toHaveValue("4.00");
  // Something that isn't a price is not sent.
  await box.fill("cheap"); await box.blur();
  await expect(box).toHaveAttribute("aria-invalid", "true");
  expect(edits).toEqual([]);
  await box.fill("$13"); await box.press("Enter");
  await expect(page.getByText("2 cards are at or under the price you set.")).toBeVisible();
  await expect(box).toHaveValue("13.00");
  expect(edits).toEqual([{ quantity: 2, finish: "any", notes: "", target_price: "13.00" }]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (width !== 320) await page.screenshot({ path: `/mnt/project-files/qol-round-two/wishlist-target-${width}.png`, fullPage: false });
  // A quantity tap leaves the target alone; emptying the box clears it.
  await page.getByRole("button", { name: "One more Fixture Captain of the Long Watch" }).click();
  await expect.poll(() => edits.length).toBe(2);
  expect(edits[1]).toEqual({ quantity: 3, finish: "any", notes: "" });
  await box.fill(""); await box.blur();
  await expect(page.getByText("1 card is at or under the price you set.")).toBeVisible();
  expect(edits[2]).toEqual({ quantity: 3, finish: "any", notes: "", target_price: null });
});
