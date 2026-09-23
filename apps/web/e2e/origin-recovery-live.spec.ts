import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { createCollector } from "./account";
import { skipWelcomeTour } from "./navigation";

test("the configured address signs in repeatedly to the same account", async ({ browser, request }, info) => {
  mkdirSync("../../artifacts/origin-recovery", { recursive: true, mode: 0o700 });
  const account = await createCollector(request);
  writeFileSync(`../../artifacts/origin-recovery/account-${account.subject}.json`, JSON.stringify({ subject: account.subject, username: account.username }));
  const context = await browser.newContext({ baseURL: account.baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const steps: unknown[] = [];
  try {
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    let owner = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      // Start a new browser sign-in rather than the provider's existing-user
      // password-only reauthentication form.
      if (attempt) await context.clearCookies();
      await page.goto("/api/auth/login?fresh=true");
      steps.push({ attempt, path: new URL(page.url()).pathname, title: await page.title(), text: await page.locator("body").innerText() });
      await page.locator("#username").fill(account.username);
      await page.locator("#password").fill(account.password);
      await page.locator("#kc-login").click();
      if (!attempt) await skipWelcomeTour(page);
      await expect(page.getByRole("button", { name: "Menu", exact: true })).toBeVisible();
      expect(new URL(page.url()).origin).toBe(account.baseURL);
      const response = await context.request.get("/api/auth/session"); expect(response.status()).toBe(200);
      const session = await response.json();
      expect(session.role).toBe("guest"); expect(session.scan_cards_remaining).toBe(100);
      if (owner) expect(session.owner_id).toBe(owner); else owner = session.owner_id;
      expect((await (await context.request.get("/api/v1/collection")).json()).copies).toBe(0);
      expect((await (await context.request.get("/api/v1/decks")).json()).items).toHaveLength(0);
    }
    await page.reload(); await expect(page.getByRole("button", { name: "Menu", exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(errors).toEqual([]);
    await page.screenshot({ path: `../../artifacts/origin-recovery/live-${info.project.name}.png` });
  } catch (error) {
    writeFileSync(`../../artifacts/origin-recovery/login-debug-${info.project.name}.json`, JSON.stringify({ steps, path: new URL(page.url()).pathname, text: await page.locator("body").innerText() }));
    throw error;
  } finally { await context.close().catch(() => {}); await account.remove(); }
});
