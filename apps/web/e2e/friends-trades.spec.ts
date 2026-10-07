import { expect, test, type Page } from "@playwright/test";
import { navigate, openNavigation } from "./navigation";

const printing = (id: string, name: string, number: string, finishes = ["nonfoil", "foil"]) => ({ id, name, set_code: "frd", set_name: "Friend Fixtures", collector_number: number, language: "en", rarity: "rare", finishes, image_url: null, type_line: "Creature", cmc: 2 });
const dragon = printing("friend-card-1", "Shivan Dragon", "1");
const bolt = printing("friend-card-2", "Lightning Bolt", "2");
const ring = printing("friend-card-3", "Sol Ring", "3", ["nonfoil"]);

function offer(state: "pending" | "accepted", attention: string | null) {
  return { id: "offer-1", direction: "incoming", friend: { id: "friend-riley", name: "Riley" }, state, message: "Bolts for your dragon?", created_at: "2026-10-07T10:00:00Z", responded_at: state === "pending" ? null : "2026-10-07T11:00:00Z",
    applied: attention === null && state === "accepted", attention, provider: "tcgplayer",
    give: [{ printing: dragon, finish: "foil", quantity: 1, unit_amount: "30.00" }], get: [{ printing: bolt, finish: "nonfoil", quantity: 2, unit_amount: "2.50" }],
    give_amount: "30.00", get_amount: "5.00", give_unpriced: 0, get_unpriced: 0 };
}

async function fixture(page: Page) {
  const state = {
    offer: offer("pending", "respond") as ReturnType<typeof offer> | null, calls: [] as string[], importBody: "", removal: null as any, codeAttempts: [] as string[],
    wishlist: [{ id: "wish-1", printing: ring, finish: "any", quantity: 2, notes: "", price_finish: "nonfoil", unit_amount: "5.00", owned: 0, created_at: "2026-10-01T00:00:00Z" }], wishlistAdds: [] as any[],
  };
  await page.route("**/api/**", async (route) => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname, method = req.method();
    const body = req.postData() && req.headers()["content-type"]?.includes("json") ? req.postDataJSON() : null;
    if (method !== "GET") state.calls.push(`${method} ${path}`);
    let json: any = {}, status = 200;
    if (path === "/api/auth/session") json = { owner_id: "friend-fixture", display_name: "Alex", role: "member", csrf_token: "friend-csrf", tour_dismissed: true, preferred_price_source: "tcgplayer", scan_cards_used: 0, scan_card_limit: null, scan_cards_remaining: null };
    else if (path === "/api/auth/status") json = { setup_required: false, guest_signup_enabled: true };
    else if (path === "/api/v1/capabilities") json = { max_upload_bytes: 104857600 };
    else if (path === "/api/v1/scans") json = { items: [], next_offset: null };
    else if (path === "/api/v1/trade-offers") json = { items: state.offer ? [state.offer] : [], attention: state.offer?.attention ? 1 : 0 };
    else if (path === "/api/v1/trade-offers/offer-1/accept") { state.offer = offer("accepted", "apply"); json = state.offer; }
    else if (path === "/api/v1/trade-offers/offer-1/applied") { state.offer = offer("accepted", null); json = state.offer; }
    else if (path === "/api/v1/collection" && url.searchParams.get("printing_id") === dragon.id) json = { copies: 2, next_offset: null, items: [{ id: "lot-9", printing: dragon, quantity: 2, finish: "foil", condition: "NM", binder: "Binder", binder_id: "b1", binder_kind: "binder", notes: "", version: 3 }] };
    else if (path === "/api/v1/collection/lot-9/quantity") { state.removal = body; json = { id: "lot-9", quantity: body.quantity, version: 4 }; }
    else if (path === "/api/v1/imports" && method === "POST") { state.importBody = req.postData() || ""; json = { id: "trade-import", state: "REVIEW", revision: 2, summary: { ready_copies: 2, committed_copies: 0, unresolved_rows: 0 } }; }
    else if (path === "/api/v1/imports/trade-import/confirm") json = { id: "trade-import", state: "COMPLETED", revision: 3, summary: { ready_copies: 0, committed_copies: 2, unresolved_rows: 0 } };
    else if (path === "/api/v1/friends") json = { code: "ABCDE-23456", share_collection: true, share_wishlist: true, friends: [{ id: "f-1", user_id: "friend-riley", name: "Riley", since: "2026-10-01T00:00:00Z", shares_collection: true, shares_wishlist: true }], incoming: [], outgoing: [] };
    else if (path === "/api/v1/friends/requests") {
      state.codeAttempts.push(body.code);
      if (body.code === "ZZZZZ-ZZZZZ") { status = 404; json = { detail: "No one can be added with that code. Check it with the person who gave it to you." }; }
      else json = { state: "pending" };
    } else if (path === "/api/v1/wishlist" && method === "GET") json = { provider: "tcgplayer", items: state.wishlist, copies: 2, priced_copies: 2, amount: "10.00" };
    else if (path === "/api/v1/wishlist" && method === "POST") { state.wishlistAdds.push(...body.items); json = { added: body.items.length }; }
    else if (path === "/api/v1/collection/sets") json = { items: [{ code: "frd", name: "Friend Fixtures", released_at: "2026-09-01", set_type: "expansion", owned: 1, total: 3, copies: 2 }] };
    else if (path === "/api/v1/collection/sets/frd") json = { code: "frd", name: "Friend Fixtures", released_at: "2026-09-01", provider: "tcgplayer", owned: 1, total: 3, cost_to_finish: "7.50", missing_unpriced: 0,
      cards: [{ printing: dragon, owned: 2, price_finish: "nonfoil", unit_amount: "10.00" }, { printing: bolt, owned: 0, price_finish: "nonfoil", unit_amount: "2.50" }, { printing: ring, owned: 0, price_finish: "nonfoil", unit_amount: "5.00" }] };
    else { status = 500; json = { detail: "Unexpected fixture request: " + path }; }
    await route.fulfill({ status, json });
  });
  await page.goto("/");
  return state;
}

test("an incoming trade offer shows on Home and accepting it updates only this collection", async ({ page }) => {
  const state = await fixture(page);
  const notice = page.getByRole("complementary", { name: "Trade offers" });
  await expect(notice).toContainText("Riley sent you a trade offer");
  await expect(notice).toContainText("You give 1 card ($30.00) · You get 2 cards ($5.00)");

  const menu = await openNavigation(page);
  await expect(menu.getByRole("button", { name: /^Trade offers/ })).toContainText("1");
  await page.keyboard.press("Escape");

  await notice.getByRole("button", { name: "View offer", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Trade offers", exact: true })).toBeVisible();
  await expect(page.getByText("“Bolts for your dragon?”")).toBeVisible();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Accept trade", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Trade accepted." })).toHaveText("Trade accepted. Added 2 copies to “Trades” and removed 1 copy from your collection.");

  expect(state.calls).toEqual([
    "POST /api/v1/trade-offers/offer-1/accept", "POST /api/v1/imports", "POST /api/v1/imports/trade-import/confirm",
    "POST /api/v1/collection/lot-9/quantity", "POST /api/v1/trade-offers/offer-1/applied",
  ]);
  expect(state.importBody).toContain(`"${bolt.id}","Lightning Bolt","frd","2","en","2","nonfoil","Trades"`);
  expect(state.removal).toEqual({ expected_version: 3, quantity: 1 });
  await expect(page.getByRole("heading", { name: "Finished", exact: true })).toBeVisible();
  await navigate(page, "Upload photo");
  await expect(page.getByRole("complementary", { name: "Trade offers" })).toHaveCount(0);
});

test("friends are added only by code and a wrong code says nothing about accounts", async ({ page }) => {
  const state = await fixture(page);
  await navigate(page, "Friends");
  await expect(page.getByLabel("Your friend code")).toHaveText("ABCDE-23456");
  await expect(page.getByRole("button", { name: /^Riley/ })).toBeVisible();
  const code = page.getByLabel("Their friend code");
  await code.fill("ZZZZZ-ZZZZZ");
  await page.getByRole("button", { name: "Send request", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("No one can be added with that code.");
  await code.fill("QRSTU-VWXYZ");
  await page.getByRole("button", { name: "Send request", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Request sent" })).toBeVisible();
  expect(state.codeAttempts).toEqual(["ZZZZZ-ZZZZZ", "QRSTU-VWXYZ"]);
});

test("wishlist totals and set completion add missing cards to the wishlist", async ({ page }) => {
  const state = await fixture(page);
  await navigate(page, "Wishlist");
  await expect(page.getByRole("heading", { name: "Wishlist", exact: true })).toBeVisible();
  await expect(page.locator(".social-total")).toContainText("2 cards wanted");
  await expect(page.locator(".social-total")).toContainText("$10.00");
  await expect(page.getByText("Sol Ring", { exact: true })).toBeVisible();

  await navigate(page, "Set completion");
  await page.getByRole("button", { name: /Friend Fixtures/ }).click();
  await expect(page.getByRole("heading", { name: "Friend Fixtures", exact: true })).toBeVisible();
  await expect(page.locator(".social-total")).toContainText("1 of 3 owned");
  await expect(page.locator(".social-total")).toContainText("$7.50");
  const missing = page.getByRole("list", { name: "Missing cards" });
  await expect(missing.getByRole("listitem")).toHaveCount(2);
  await page.getByRole("button", { name: "Add missing cards to wishlist", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Added 2 cards to your wishlist." })).toBeVisible();
  expect(state.wishlistAdds.map((item) => item.printing_id)).toEqual([bolt.id, ring.id]);
});
