import { expect, test, type Page } from "@playwright/test";

async function member(page: Page, state = { pending: true, failures: 0 }) {
  const writes: string[] = [];
  await page.route("**/api/**", async (route) => {
    const req = route.request(), path = new URL(req.url()).pathname;
    let json: any = {}, status = 200;
    if (path === "/api/auth/session") json = { owner_id: "approved-member", display_name: "Fixture collector", csrf_token: "member-csrf", role: "member", membership_welcome: state.pending, approved_at: "2026-09-20T01:00:00Z", tour_dismissed: true, scan_cards_used: 100, scan_card_limit: null, scan_cards_remaining: null, preferred_price_source: "tcgplayer" };
    else if (path === "/api/auth/status") json = { setup_required: false, guest_signup_enabled: true };
    else if (path === "/api/v1/capabilities") json = { max_upload_bytes: 104857600 };
    else if (path === "/api/v1/scans") json = { items: [], next_offset: null };
    else if (path === "/api/auth/membership-welcome/dismiss" && req.method() === "POST") {
      expect(req.headers()["x-csrf-token"]).toBe("member-csrf"); writes.push(path);
      if (state.failures > 0) { state.failures--; status = 503; json = { detail: "Temporary save failure" }; }
      else { state.pending = false; json = { membership_welcome: false }; }
    } else { status = 500; json = { detail: "Unexpected fixture endpoint " + path }; }
    await route.fulfill({ status, json });
  });
  return { state, writes };
}

for (const width of [320, 390, 1280]) {
  test(`approved member welcome explains unlimited scanning and dismisses once at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    const mock = await member(page);
    await page.goto("/");
    const dialog = page.getByRole("dialog", { name: "You’re approved!", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Unlimited card scans", { exact: true })).toBeVisible();
    await expect(dialog.getByText(/100-card guest limit is removed/)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Let’s keep collecting", exact: true })).toBeFocused();
    await dialog.screenshot({ path: `../../artifacts/deck-buy-lists/member-${width}-${test.info().project.name}.png` });
    await dialog.getByRole("button", { name: "Let’s keep collecting", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => mock.state.pending).toBe(false);
    await page.reload();
    await expect(page.getByRole("button", { name: "Take photo", exact: true })).toBeVisible();
    await expect(dialog).toHaveCount(0);
    expect(mock.writes).toHaveLength(1);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("member welcome waits for eligibility and remembers dismissal during a save failure", async ({ page }) => {
  const mock = await member(page, { pending: false, failures: 1 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Take photo", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  mock.state.pending = true;
  await page.reload();
  await expect(page.getByRole("dialog", { name: "You’re approved!", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "Take photo", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => mock.state.pending).toBe(false);
});
