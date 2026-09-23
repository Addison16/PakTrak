import { expect, test } from "@playwright/test";
import { createCollector } from "./account";
import { navigate, skipWelcomeTour } from "./navigation";

test("nonfoil defaults and selected foils survive adding a missed card with the browser closed", async ({ browser, request }) => {
  const account = await createCollector(request);
  let context = await browser.newContext({ baseURL: account.baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    let page = await context.newPage();
    await page.goto("/"); await page.getByRole("link", { name: "Sign in", exact: true }).click();
    await page.waitForURL(/\/identity\/realms\/scanner\//); await page.waitForLoadState("load");
    await page.locator("#username").fill(account.username); await page.locator("#password").fill(account.password); await page.locator("#kc-login").click();
    await skipWelcomeTour(page); await navigate(page, "Upload photo");
    await expect(page.getByRole("spinbutton", { name: "How many cards are foil?", exact: true })).toHaveValue("0");
    const photo = await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 1000; canvas.height = 700;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#334533"; ctx.fillRect(0, 0, 1000, 700);
      for (const x of [120, 560]) {
        ctx.fillStyle = "#eeeecc"; ctx.fillRect(x, 120, 180, 252);
        ctx.strokeStyle = "black"; ctx.lineWidth = 5; ctx.strokeRect(x, 120, 180, 252);
        ctx.fillStyle = "#775599"; ctx.fillRect(x + 20, 170, 140, 100);
      }
      return canvas.toDataURL("image/jpeg", .95).split(",")[1];
    });
    const acceptance = page.waitForResponse((response) => response.url().endsWith("/finalize") && response.status() === 202);
    await page.getByTestId("photo-input").setInputFiles({ name: "finish-defaults-fixture.jpg", mimeType: "image/jpeg", buffer: Buffer.from(photo, "base64") });
    const accepted = await (await acceptance).json();
    expect(accepted.safe_to_disconnect).toBe(true);
    const base = `/api/v1/scans/${accepted.scan_id}`;
    await expect.poll(async () => (await (await context.request.get(base)).json()).state, { timeout: 60000 }).toBe("PHOTO_READY");
    await page.getByRole("button", { name: "Edit batch", exact: true }).click();
    let data = await (await context.request.get(base + "/observations")).json();
    expect(data.items).toHaveLength(2);
    expect(data.finishes).toMatchObject({ foil_count: 0, confirmed: true, foil_ids: [] });
    expect(data.items.every((row: any) => row.finish === "nonfoil")).toBe(true);
    const expected = page.getByRole("spinbutton", { name: "Cards in this photo", exact: true });
    await expected.click(); await expected.press("Backspace"); await expected.press("Backspace"); await expect(expected).toHaveValue("");
    await expected.pressSequentially("2"); await expected.press("Tab"); await expect(expected).toHaveValue("2");
    const panel = page.getByRole("region", { name: "Foil cards", exact: true });
    await expect(panel.getByRole("button", { name: "Select foil cards", exact: true })).toHaveCount(0);
    await panel.getByRole("button", { name: "Change foil cards", exact: true }).click();
    await panel.getByRole("spinbutton", { name: "How many cards are foil?", exact: true }).fill("1");
    await panel.getByRole("button", { name: /^Foil card 1:/ }).click();
    await panel.getByRole("button", { name: "Confirm card finishes", exact: true }).click();
    await expect(panel.getByRole("heading", { name: "1 foil · 1 nonfoil", exact: true })).toBeVisible();
    data = await (await context.request.get(base + "/observations")).json();
    const foilId = data.finishes.foil_ids[0];
    const session = await (await context.request.get("/api/auth/session")).json();
    const outlined = await context.request.post(base + "/observations", {
      headers: { "Origin": account.baseURL, "X-CSRF-Token": session.csrf_token, "Idempotency-Key": crypto.randomUUID() },
      data: { polygon: [[.77, .65], [.96, .65], [.96, .98], [.77, .98]] },
    });
    expect(outlined.status(), await outlined.text()).toBe(201);
    const newId = (await outlined.json()).id;
    const state = await context.storageState(); await context.close();
    // The accepted outline and finish plan continue in Docker with no page alive.
    context = await browser.newContext({ baseURL: account.baseURL, storageState: state, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await expect.poll(async () => (await (await context.request.get(base)).json()).state, { timeout: 60000 }).toBe("PHOTO_READY");
    page = await context.newPage(); await page.goto("/"); await navigate(page, "Batches");
    await page.getByRole("button", { name: /finish-defaults-fixture.jpg/ }).click();
    await page.getByRole("button", { name: "Edit batch", exact: true }).click();
    await expect(page.getByRole("heading", { name: "1 foil · 2 nonfoil", exact: true })).toBeVisible();
    data = await (await context.request.get(base + "/observations")).json();
    expect(data.finishes).toMatchObject({ foil_count: 1, confirmed: true, foil_ids: [foilId] });
    expect(data.items.find((row: any) => row.id === newId).finish).toBe("nonfoil");
    expect((await (await context.request.get("/api/v1/collection")).json()).copies).toBe(0);
    expect((await (await context.request.get("/api/auth/session")).json()).scan_cards_used).toBe(3);
    await page.getByRole("region", { name: "Foil cards", exact: true }).screenshot({ path: `../../artifacts/scan-defaults/live-${test.info().project.name}.png` });
  } finally { await context.close(); await account.remove(); }
});
