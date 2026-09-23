import { expect, test, type Page } from "@playwright/test";
import { cancelBrowserBack, navigate, openNavigation } from "./navigation";
import type { Account } from "../src/accountTypes";

// All API traffic is intercepted; real users and their settings are untouched.
function account(id: string, role: Account["role"], display_name: string): Account {
  return { id, role, display_name, created_at: "2026-09-01T12:00:00Z", approved_at: role === "member" ? "2026-09-02T12:00:00Z" : null, scan_cards_used: 75, scan_card_limit: role === "guest" ? 100 : null, scan_card_limit_override: null, scan_cards_remaining: role === "guest" ? 25 : null, scans_paused: false, suspended: false, account_version: 1, collection_copies: 1250, saved_decks: 4, saved_batches: 5, active_sessions: 3, activity: [] };
}
async function fixture(page: Page, role: Account["role"] = "admin") {
  const self = account("self", role, "My collector account");
  const member = account("member", "member", "Red binder collector");
  const guest = account("guest", "guest", "New collector");
  const state = { self, member, guest, accounts: [self, member, guest], writes: [] as { path: string; body: Record<string, unknown> }[], errors: [] as string[], unexpected: [] as string[], conflict: false, welcome: false, resetFailure: false };
  page.on("pageerror", (error) => state.errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname;
    const reply = (json: unknown, status = 200) => route.fulfill({ json, status });
    if (path === "/api/auth/status") return reply({ setup_required: false, guest_signup_enabled: true });
    if (path === "/api/auth/session") return reply({ ...self, owner_id: self.id, csrf_token: "account-csrf", tour_dismissed: true, preferred_price_source: "tcgplayer", membership_welcome: state.welcome });
    if (path === "/api/v1/capabilities") return reply({ max_upload_bytes: 104857600 });
    if (path === "/api/v1/scans") return reply({ items: [], next_offset: null });
    if (path === "/api/v1/data/status") return reply({ feeds: [] });
    if (path === "/api/auth/settings") return reply({ guest_signup_enabled: true, enhanced_scanning_enabled: false, version: 1 });
    if (path === "/api/auth/accounts") {
      const offset = Number(url.searchParams.get("offset")), search = url.searchParams.get("q")?.toLowerCase() || "";
      const list = state.accounts.filter((a) => (url.searchParams.get("guests_only") !== "true" || a.role === "guest") && a.display_name.toLowerCase().includes(search));
      return reply({ items: list.slice(offset, offset + 50), next_offset: list.length > offset + 50 ? offset + 50 : null });
    }
    const target = path.startsWith("/api/auth/me") ? self : state.accounts.find((a) => path.startsWith(`/api/auth/accounts/${a.id}`));
    if (target && req.method() === "GET") return reply(target);
    if (req.method() !== "GET") {
      const data = req.postData() ? req.postDataJSON() : {};
      expect(req.headers()["x-csrf-token"]).toBe("account-csrf"); state.writes.push({ path, body: data });
      if (path.endsWith("/membership-welcome/dismiss")) { state.welcome = false; return reply({ membership_welcome: false }); }
      if (target) {
        if (!path.endsWith("/approve") && (state.conflict || data.expected_version !== target.account_version)) return reply({ detail: "This account changed. Reload its settings before saving." }, 409);
        target.account_version += 1;
        if (path.endsWith("/reset-password")) {
          target.account_version += 1; target.active_sessions = 0;
          if (state.resetFailure) return reply({ detail: "The password reset could not be confirmed. Reload this account and reset again." }, 503);
          return reply({ account: target, temporary_password: "Browser-fixture!2026", username: "collector-login" });
        }
        if (path.endsWith("/access")) {
          Object.assign(target, { suspended: data.suspended, scans_paused: data.scans_paused, scan_card_limit_override: data.scan_card_limit_override });
          target.scan_card_limit = target.scan_card_limit_override ?? (target.role === "guest" ? 100 : null);
          target.scan_cards_remaining = target.scan_card_limit === null ? null : Math.max(0, target.scan_card_limit - target.scan_cards_used);
          if (target.suspended) target.active_sessions = 0;
        } else if (path.endsWith("/approve")) Object.assign(target, { role: "member", scan_card_limit: null, scan_cards_remaining: null, scan_card_limit_override: null });
        else if (path.endsWith("/me")) target.display_name = data.display_name;
        else if (path.endsWith("/signout") || path.endsWith("/signout-others")) {
          const sessions = (target.active_sessions ?? 0) - (path.endsWith("/signout-others") ? 1 : 0);
          target.active_sessions = path.endsWith("/signout-others") ? 1 : 0;
          return reply({ sessions_ended: sessions, account: target });
        }
        target.activity = [{ kind: path.endsWith("/me") ? "PROFILE_UPDATED" : "ACCESS_UPDATED", created_at: new Date().toISOString(), detail: {} }];
        return reply(target);
      }
    }
    state.unexpected.push(path); return reply({ detail: "Unexpected fixture request" }, 500);
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Take photo", exact: true })).toBeVisible();
  return state;
}

for (const theme of ["light", "dark"] as const) test(`lifetime controls allow clearing to zero, raising limits and restoring unlimited in ${theme} mode`, async ({ page }, info) => {
  await page.setViewportSize({ width: theme === "dark" ? 390 : 320, height: 844 });
  await page.emulateMedia({ colorScheme: theme });
  const state = await fixture(page);
  await navigate(page, "Administration");
  await page.getByRole("button", { name: "Manage Red binder collector", exact: true }).click();
  await page.getByRole("radio", { name: "Set a lifetime card limit", exact: true }).check();
  const limit = page.getByRole("spinbutton", { name: "Lifetime card limit", exact: true });
  await limit.fill(""); await expect(limit).toHaveValue("");
  await expect(page.getByRole("button", { name: "Save account settings", exact: true })).toBeDisabled();
  await limit.fill("0"); await page.getByRole("button", { name: "Save account settings", exact: true }).click();
  await expect(page.getByText("Account settings saved.", { exact: true })).toBeVisible();
  expect(state.member.scan_card_limit).toBe(0); expect(state.member.scan_cards_used).toBe(75);
  await limit.fill("200"); await page.getByRole("checkbox", { name: "Pause new scans" }).check();
  await page.getByRole("button", { name: "Save account settings", exact: true }).click();
  await expect(page.getByRole("region", { name: "Card scan allowance" })).toContainText("125 remaining of 200");
  await expect(page.getByRole("region", { name: "Card scan allowance" })).toContainText("Paused");
  expect(state.writes.at(-1)?.body).toEqual({ expected_version: 2, suspended: false, scans_paused: true, scan_card_limit_override: 200 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("region", { name: "User management", exact: true }).screenshot({ path: `../../artifacts/account-management/admin-${theme}-${info.project.name}.png` });
  await page.getByRole("radio", { name: "Unlimited card scans", exact: true }).check();
  await page.getByRole("checkbox", { name: "Pause new scans" }).uncheck();
  await page.getByRole("button", { name: "Save account settings", exact: true }).click();
  await expect(page.getByRole("region", { name: "Card scan allowance" })).toContainText("Unlimited card scans");
  expect(state.member.scan_cards_used).toBe(75); expect(state.member.scan_card_limit).toBeNull();
  await page.getByRole("button", { name: "Back to users", exact: false }).click();
  await expect(page.getByRole("list", { name: "User accounts" })).toBeVisible();
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("suspending and kicking require confirmation; guest approval restores unlimited", async ({ page }) => {
  const state = await fixture(page);
  await navigate(page, "Administration");
  await page.getByRole("button", { name: "Manage Red binder collector", exact: true }).click();
  page.once("dialog", (d) => d.dismiss());
  await page.getByRole("button", { name: "Sign out all devices", exact: true }).click();
  expect(state.writes).toHaveLength(0);
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Sign out all devices", exact: true }).click();
  await expect(page.getByText("3 sign-in sessions ended.", { exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Account access", exact: true }).selectOption("suspended");
  page.once("dialog", (d) => d.dismiss());
  await page.getByRole("button", { name: "Save account settings", exact: true }).click();
  expect(state.member.suspended).toBe(false);
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Save account settings", exact: true }).click();
  await expect(page.getByText("Suspended", { exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Account access", exact: true }).selectOption("active");
  await page.getByRole("button", { name: "Save account settings", exact: true }).click();
  await expect(page.getByText("Suspended", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Back to users", exact: false }).click();
  await page.getByRole("button", { name: "Manage New collector", exact: true }).click();
  await page.getByRole("button", { name: "Approve as standard member", exact: true }).click();
  await expect(page.getByRole("region", { name: "Card scan allowance" })).toContainText("Unlimited card scans");
  expect(state.guest.role).toBe("member"); expect(state.guest.scan_cards_used).toBe(75);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("admin edits warn before leaving, and conflicts preserve drafts until an explicit reload", async ({ page }) => {
  const state = await fixture(page);
  await navigate(page, "Administration");
  await page.getByRole("button", { name: "Manage Red binder collector", exact: true }).click();
  await page.getByRole("checkbox", { name: "Pause new scans" }).check();
  page.once("dialog", (d) => d.dismiss());
  await navigate(page, "My account");
  await expect(page.getByRole("heading", { name: "Red binder collector", exact: true })).toBeVisible();
  state.conflict = true;
  await page.getByRole("button", { name: "Save account settings", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Reload its settings");
  await expect(page.getByRole("checkbox", { name: "Pause new scans" })).toBeChecked();
  expect(state.member.scans_paused).toBe(false);
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Reload account", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Pause new scans" })).not.toBeChecked();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

for (const role of ["member", "guest"] as const) test(`${role} can edit their profile and sign out other devices without admin access`, async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 844 });
  const state = await fixture(page, role);
  const nav = await openNavigation(page);
  await expect(nav.getByRole("button", { name: "Administration", exact: true })).toHaveCount(0);
  await nav.getByRole("button", { name: "My account", exact: true }).click();
  await expect(page.getByRole("region", { name: "Card scan allowance" })).toContainText(role === "guest" ? "25 remaining of 100" : "Unlimited card scans");
  await expect(page.getByRole("link", { name: "Change password", exact: true })).toHaveAttribute("href", "/api/auth/password");
  const name = page.getByRole("textbox", { name: "Display name", exact: true });
  await name.fill(""); await expect(page.getByRole("button", { name: "Save profile", exact: true })).toBeDisabled();
  await name.fill("My red binder");
  page.once("dialog", (d) => d.dismiss());
  await navigate(page, "Upload photo"); await expect(name).toHaveValue("My red binder");
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(page.getByText("Your display name is saved.", { exact: true })).toBeVisible();
  expect(state.writes[0].body).toEqual({ display_name: "My red binder", expected_version: 1 });
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Sign out other devices", exact: true }).click();
  await expect(page.getByText("2 other sign-in sessions ended.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out other devices", exact: true })).toBeDisabled();
  expect(state.self.active_sessions).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("region", { name: "My account", exact: true }).screenshot({ path: `../../artifacts/account-management/my-account-${role}-${info.project.name}.png` });
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("live allowance changes disable uploads while leaving the account screen available", async ({ page }) => {
  const state = await fixture(page, "member");
  state.self.scans_paused = true;
  await expect(page.getByRole("button", { name: "Take photo", exact: true })).toBeDisabled({ timeout: 6000 });
  await expect(page.getByRole("button", { name: "Choose photo", exact: true })).toBeDisabled();
  await expect(page.getByText("New scans are paused.", { exact: false })).toBeVisible();
  await navigate(page, "My account");
  await expect(page.getByRole("region", { name: "Card scan allowance" })).toContainText("Paused");
  state.self.scans_paused = false; state.self.scan_card_limit = 75; state.self.scan_cards_remaining = 0;
  await expect(page.getByRole("region", { name: "Card scan allowance" })).toContainText("Limit reached", { timeout: 6000 });
  await navigate(page, "Upload photo"); await expect(page.getByRole("button", { name: "Take photo", exact: true })).toBeDisabled();
  state.self.scan_card_limit = null; state.self.scan_cards_remaining = null;
  await expect(page.getByRole("button", { name: "Take photo", exact: true })).toBeEnabled({ timeout: 6000 });
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("all accounts are searchable, paginated and administrator access is protected", async ({ page }) => {
  const state = await fixture(page);
  state.accounts.push(...Array.from({ length: 50 }, (_, i) => account(`extra-${i}`, "member", `Collector ${i}`)));
  await navigate(page, "Administration");
  await expect(page.getByRole("list", { name: "User accounts" }).locator("li")).toHaveCount(50);
  await page.getByRole("button", { name: "More accounts", exact: true }).click();
  await expect(page.getByRole("list", { name: "User accounts" }).locator("li")).toHaveCount(3);
  await page.getByRole("searchbox", { name: "Find an account" }).fill("My collector");
  await expect(page.getByRole("list", { name: "User accounts" }).locator("li")).toHaveCount(1);
  await page.getByRole("button", { name: "Manage My collector account", exact: true }).click();
  await expect(page.getByText("Administrator accounts are protected", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out all devices" })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Account access" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reset password", exact: true })).toHaveCount(0);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("approval welcome reports a custom allowance when it was set before the next login", async ({ page }) => {
  const state = await fixture(page, "member");
  state.welcome = true; state.self.scan_card_limit = 250; state.self.scan_cards_remaining = 175;
  await page.reload();
  const welcome = page.getByRole("dialog", { name: "You’re approved!" });
  await expect(welcome).toContainText("175 remain");
  await expect(welcome).not.toContainText("Scan as many cards as you like");
  await welcome.getByRole("button", { name: "Let’s keep collecting" }).click();
  await expect(welcome).not.toBeVisible();
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});


for (const theme of ["light", "dark"] as const) test(`admin password reset confirms the user, protects the receipt and keeps secrets transient in ${theme} mode`, async ({ page }, info) => {
  await page.setViewportSize({ width: theme === "light" ? 320 : 390, height: 844 });
  await page.emulateMedia({ colorScheme: theme });
  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => {} } }));
  const state = await fixture(page);
  await navigate(page, "Administration");
  await page.getByRole("button", { name: "Manage Red binder collector", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Allow guest signup", exact: true })).toHaveCount(0);
  const reset = page.getByRole("button", { name: "Reset password", exact: true });
  const pause = page.getByRole("checkbox", { name: "Pause new scans", exact: true });
  await pause.check(); await expect(reset).toBeDisabled(); await pause.uncheck();
  page.once("dialog", (dialog) => dialog.dismiss()); await reset.click();
  expect(state.writes).toHaveLength(0);
  page.once("dialog", async (dialog) => { expect(dialog.message()).toContain("Red binder collector"); await dialog.accept(); });
  await reset.click();
  const password = page.getByLabel("Temporary password", { exact: true });
  await expect(password).toBeVisible(); await expect(password).toHaveAttribute("type", "password");
  await expect(reset).toBeDisabled();
  expect(state.writes).toEqual([{ path: "/api/auth/accounts/member/reset-password", body: { expected_version: 1 } }]);
  await page.getByRole("button", { name: "Copy password", exact: true }).click();
  await expect(page.getByText("Password copied.", { exact: true })).toBeVisible();
  const leaked = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }).includes("Browser-fixture!2026"));
  expect(leaked).toBe(false);
  await page.getByRole("button", { name: "Show password", exact: true }).click();
  await expect(password).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "Hide password", exact: true }).click();
  const receipt = page.getByRole("region", { name: "Temporary sign-in password", exact: true });
  await expect(receipt).toContainText("collector-login");
  await expect(receipt).toContainText("won’t be shown again");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await receipt.screenshot({ path: `../../artifacts/password-reset/receipt-${theme}-${info.project.name}.png` });
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Back to users", exact: false }).click();
  await expect(password).toBeVisible();
  await page.getByRole("button", { name: "I’ve saved the password", exact: true }).click();
  await expect(password).toHaveCount(0);
  await page.getByRole("button", { name: "Back to users", exact: false }).click();
  await expect(page.getByRole("checkbox", { name: "Allow guest signup", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Manage Red binder collector", exact: true }).click();
  await expect(password).toHaveCount(0); await expect(reset).toBeEnabled();
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("reset failures require a reload and unavailable clipboard offers manual copying", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("Unavailable clipboard"); } } }));
  const state = await fixture(page);
  await navigate(page, "Administration");
  await page.getByRole("button", { name: "Manage Red binder collector", exact: true }).click();
  state.resetFailure = true;
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Reset password", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("could not be confirmed");
  await expect(page.getByLabel("Temporary password", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Reload account", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  state.resetFailure = false;
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Reset password", exact: true }).click();
  await expect(page.getByLabel("Temporary password", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Copy password", exact: true }).click();
  await expect(page.getByText("Copy wasn’t available.", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Temporary password", { exact: true })).toHaveAttribute("type", "text");
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});


test("browser history keeps user edits and reset passwords out of history", async ({ page }) => {
  const state = await fixture(page);
  await navigate(page, "Administration");
  await page.getByRole("button", { name: "Manage Red binder collector", exact: true }).click();
  await page.getByRole("checkbox", { name: "Pause new scans", exact: true }).check();
  await cancelBrowserBack(page);
  await expect(page).toHaveURL(/#\/admin\/member$/);
  await expect(page.getByRole("checkbox", { name: "Pause new scans", exact: true })).toBeChecked();
  page.once("dialog", (dialog) => dialog.accept());
  await page.evaluate(() => history.back());
  await expect(page.getByRole("checkbox", { name: "Allow guest signup", exact: true })).toBeVisible();
  await page.evaluate(() => history.forward());
  await expect(page.getByRole("checkbox", { name: "Pause new scans", exact: true })).not.toBeChecked();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Reset password", exact: true }).click();
  await expect(page.getByLabel("Temporary password", { exact: true })).toBeVisible();
  const stored = await page.evaluate(() => JSON.stringify(history.state));
  expect(stored).not.toContain("Browser-fixture!2026");
  expect(stored).not.toContain("Red binder collector");
  await cancelBrowserBack(page);
  await expect(page.getByLabel("Temporary password", { exact: true })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.evaluate(() => history.back());
  await expect(page.getByRole("checkbox", { name: "Allow guest signup", exact: true })).toBeVisible();
  await page.evaluate(() => history.forward());
  await expect(page.getByRole("heading", { name: "Red binder collector", exact: true })).toBeVisible();
  await expect(page.getByLabel("Temporary password", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Red binder collector", exact: true })).toBeVisible();
  expect(state.writes.filter((item) => item.path.endsWith("/reset-password"))).toHaveLength(1);
  expect(state.errors).toEqual([]);
});

test("browser history preserves a cancelled personal profile edit", async ({ page }) => {
  await fixture(page, "member");
  await navigate(page, "My account");
  const name = page.getByRole("textbox", { name: "Display name", exact: true });
  await name.fill("Keep my name draft");
  await cancelBrowserBack(page);
  await expect(page).toHaveURL(/#\/account$/);
  await expect(name).toHaveValue("Keep my name draft");
  page.once("dialog", (dialog) => dialog.accept());
  await page.evaluate(() => history.back());
  await expect(page.getByRole("button", { name: "Take photo", exact: true })).toBeVisible();
  await page.evaluate(() => history.forward());
  await expect(name).toHaveValue("My collector account");
});


test("browser history cannot restore a temporary password after leaving the document", async ({ page }) => {
  await fixture(page);
  await navigate(page, "Administration");
  await page.getByRole("button", { name: "Manage Red binder collector", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Reset password", exact: true }).click();
  await expect(page.getByLabel("Temporary password", { exact: true })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.goto("/brand/paktrak-mark.svg");
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Red binder collector", exact: true })).toBeVisible();
  await expect(page.getByLabel("Temporary password", { exact: true })).toHaveCount(0);
});
