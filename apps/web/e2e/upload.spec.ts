import { expect, test } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { navigate, skipWelcomeTour } from "./navigation";

const config = Object.fromEntries(
  readFileSync("../../.env", "utf8").split("\n").filter((line) => line && !line.startsWith("#"))
    .map((line) => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; }),
);

test("mobile upload survives a closed browser and is available in a new session", async ({ browser, request }) => {
  const baseURL = process.env.SCANNER_E2E_URL || config.APP_URL;
  const tokenResponse = await request.post(baseURL + "/identity/realms/master/protocol/openid-connect/token", {
    form: { grant_type: "password", client_id: "admin-cli", username: "admin", password: config.KEYCLOAK_ADMIN_PASSWORD },
  });
  expect(tokenResponse.ok()).toBeTruthy();
  const adminToken = (await tokenResponse.json()).access_token;
  const username = "scanner-e2e-" + Date.now();
  const password = randomBytes(24).toString("hex");
  const created = await request.post(baseURL + "/identity/admin/realms/scanner/users", {
    headers: { Authorization: "Bearer " + adminToken },
    data: {
      username, enabled: true, firstName: "Scanner", lastName: "Test",
      email: username + "@localhost.invalid",
      credentials: [{ type: "password", value: password, temporary: false }],
    },
  });
  expect(created.status()).toBe(201);
  const subject = created.headers().location.split("/").at(-1)!;
  mkdirSync("../../artifacts", { recursive: true });
  writeFileSync("../../artifacts/e2e-subject.json", JSON.stringify({ subject }));
  let context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } });
  try {
    let page = await context.newPage();
    const scriptErrors: string[] = [];
    page.on("pageerror", (e) => scriptErrors.push(e.message));
    await page.goto("/");
    await page.getByRole("link", { name: "Sign in", exact: true }).click();
    await page.locator("#username").fill(username);
    await page.locator("#password").fill(password);
    await page.locator("#kc-login").click();
    await skipWelcomeTour(page);
    await navigate(page, "Upload photo");
    await expect(page.getByRole("button", { name: "Choose photo", exact: true })).toBeVisible();
    const acceptedResponse = page.waitForResponse((response) =>
      response.url().endsWith("/finalize") && response.status() === 202,
    );
    void acceptedResponse.catch(() => {});
    const uploadResponse = page.waitForResponse((response) => response.url().endsWith("/upload"));
    await page.getByTestId("photo-input").setInputFiles({
      name: "synthetic-transport-test.png", mimeType: "image/png",
      buffer: readFileSync("../../tests/fixtures/transport.png"),
    });
    const uploadResult = await uploadResponse;
    expect(uploadResult.status(), await uploadResult.text()).toBe(200);
    const accepted = await (await acceptedResponse).json();
    expect(accepted.safe_to_disconnect).toBe(true);
    await expect(page.getByRole("heading", { name: "synthetic-transport-test.png", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Choose photo", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Back to batches/ })).toBeVisible();
    const state = await context.storageState();
    await context.close();
    // This marker lets the optional host fault test recreate containers while no
    // browser is alive. It contains identifiers only, never cookies or passwords.
    writeFileSync("../../artifacts/e2e-accepted.json", JSON.stringify(accepted));
    if (process.env.SCANNER_FAULT_TEST === "1") {
      await expect.poll(() => {
        try { return readFileSync("../../artifacts/e2e-server-recovered", "utf8"); }
        catch { return ""; }
      }, { timeout: 120000, intervals: [1000] }).toBe("ready");
    }
    context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, storageState: state });
    page = await context.newPage();
    await page.goto("/");
    await navigate(page, "Batches");
    await expect(page.getByRole("button", { name: /synthetic-transport-test.png/ })).toBeVisible();
    await page.getByRole("button", { name: /synthetic-transport-test.png/ }).click();
    await expect(page.getByRole("heading", { name: "synthetic-transport-test.png", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add a missed card", exact: true })).toBeEnabled({ timeout: 60000 });
    await expect.poll(async () => (await (await context.request.get("/api/v1/scans/" + accepted.scan_id)).json()).state, { timeout: 60000 }).toBe("PHOTO_READY");
    const scan = await (await context.request.get("/api/v1/scans/" + accepted.scan_id)).json();
    expect(scan.job.result).toMatchObject({ recognition_available: true, cards_added: 0 });
    expect(scan.foil_count).toBe(0);
    expect(scan.thumbnail_url).toBeTruthy();
    expect((await context.request.get(scan.thumbnail_url)).status()).toBe(200);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(scriptErrors).toEqual([]);
    await page.getByRole("button", { name: "Change foil cards", exact: true }).click();
    const foils = page.getByRole("region", { name: "Foil cards", exact: true });
    await foils.getByRole("button", { name: /^Foil card 1:/ }).click();
    await foils.getByRole("button", { name: "Confirm card finishes", exact: true }).click();
    await expect(foils.getByRole("button", { name: "Change foil cards", exact: true })).toBeVisible();
    await page.screenshot({ path: "../../artifacts/mobile-upload.png", fullPage: true });
    // Deliberately select a printing for a synthetic region; this is manual-review
    // plumbing evidence, never automatic recognition evidence.
    const card = (await (await context.request.get("/api/v1/catalog/search?q=Island")).json()).items.find((r: any) => r.finishes.includes("foil"));
    expect(card).toBeTruthy();
    await page.getByRole("button", { name: "Edit card / printing", exact: true }).click();
    await page.getByRole("searchbox", { name: "Find an exact printing" }).fill(card.id);
    await page.locator(".printing-choice").first().click();
    await page.getByRole("button", { name: "Approve & import", exact: true }).click();
    await expect(page.locator(".scan-match-state.imported")).toHaveCount(1);
    expect((await (await context.request.get("/api/v1/collection")).json()).copies).toBe(1);
    const reviewed = await (await context.request.get("/api/v1/scans/" + accepted.scan_id + "/observations")).json();
    expect(reviewed.items[0].lot.finish).toBe("foil");
    await page.getByRole("button", { name: "Close batch", exact: true }).click();
    const batchRow = page.getByRole("button", { name: /synthetic-transport-test.png/ });
    await expect(batchRow).toContainText("1 imported");
    await expect(batchRow.locator(".batch-mini img").first()).toHaveJSProperty("complete", true);
    expect(await batchRow.locator(".batch-mini img").first().evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await page.reload();
    expect((await (await context.request.get("/api/v1/collection")).json()).copies).toBe(1);
  } finally {
    await context.close().catch(() => {});
    await request.delete(baseURL + "/identity/admin/realms/scanner/users/" + subject, {
      headers: { Authorization: "Bearer " + adminToken },
    }).catch(() => {});
  }
});
