import { expect, test, type Page } from "@playwright/test";
import { navigate } from "./navigation";

// Fully intercepted: these checks never change a running server's settings.
async function fixture(page: Page) {
  const state = { links: { tcgplayer: null, cardkingdom: "saved-ck", manapool: null } as Record<string, string | null>, version: 1, writes: [] as Record<string, unknown>[], errors: [] as string[] };
  page.on("pageerror", (error) => state.errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const req = route.request(), path = new URL(req.url()).pathname;
    const reply = (json: unknown, status = 200) => route.fulfill({ status, json });
    const settings = () => ({ guest_signup_enabled: true, enhanced_scanning_enabled: false, store_links: state.links, version: state.version });
    if (path === "/api/auth/status") return reply({ setup_required: false, guest_signup_enabled: true });
    if (path === "/api/auth/session") return reply({ owner_id: "admin-fixture", display_name: "Test administrator", csrf_token: "referral-token", role: "admin", tour_dismissed: true, preferred_price_source: "tcgplayer", scan_cards_used: 0, scan_card_limit: null, scan_cards_remaining: null, store_links: state.links });
    if (path === "/api/v1/capabilities") return reply({ max_upload_bytes: 104857600 });
    if (path === "/api/v1/scans" || path === "/api/auth/accounts") return reply({ items: [], next_offset: null });
    if (path === "/api/v1/data/status") return reply({ feeds: [] });
    if (path === "/api/auth/settings") {
      if (req.method() === "GET") return reply(settings());
      expect(req.headers()["x-csrf-token"]).toBe("referral-token");
      const data = req.postDataJSON(); state.writes.push(data);
      if (data.tcgplayer_affiliate === "bad link") return reply({ detail: "Enter a referral code (letters, numbers, . _ -) or an https:// tracking link." }, 422);
      for (const store of ["tcgplayer", "cardkingdom", "manapool"]) if (`${store}_affiliate` in data) state.links = { ...state.links, [store]: data[`${store}_affiliate`] };
      state.version += 1;
      return reply(settings());
    }
    return reply({ detail: "Unexpected test request" }, 500);
  });
  await page.goto("/");
  await navigate(page, "Administration");
  return state;
}

test("administrators save site-wide store referral links on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  const state = await fixture(page);
  const form = page.getByRole("form", { name: "Store referral links", exact: true });
  const tcgplayer = form.getByRole("textbox", { name: "TCGplayer", exact: true });
  await expect(form.getByRole("textbox", { name: "Card Kingdom", exact: true })).toHaveValue("saved-ck");
  await expect(tcgplayer).toHaveValue("");
  await tcgplayer.fill("bad link");
  await form.getByRole("button", { name: "Save referral links", exact: true }).click();
  await expect(page.getByText(/Enter a referral code/).first()).toBeVisible();
  await expect(tcgplayer).toHaveValue("bad link");
  await tcgplayer.fill("  https://tcgplayer.pxf.io/c/1/2/3 ");
  await form.getByRole("textbox", { name: "Card Kingdom", exact: true }).fill("");
  await form.getByRole("button", { name: "Save referral links", exact: true }).click();
  await expect(page.getByText("Store referral links saved.")).toBeVisible();
  expect(state.writes.at(-1)).toEqual({ tcgplayer_affiliate: "https://tcgplayer.pxf.io/c/1/2/3", cardkingdom_affiliate: null, manapool_affiliate: null, expected_version: 1 });
  expect(state.links).toEqual({ tcgplayer: "https://tcgplayer.pxf.io/c/1/2/3", cardkingdom: null, manapool: null });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(state.errors).toEqual([]);
});
