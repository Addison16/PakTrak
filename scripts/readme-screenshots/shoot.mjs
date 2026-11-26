// Takes the README screenshots in docs/images from the web app's dev server.
// Every /api request is answered from invented cards (data.mjs, mock.mjs, scan.mjs),
// so no server, account or real card art is needed.
// Usage: (cd apps/web && npm ci && npx vite --port 5173) then, from the repository root,
//   node scripts/readme-screenshots/shoot.mjs [only-these-names...]
// The screens and how each one is framed are listed in shots.mjs.
import { createRequire } from "node:module";
import { route } from "./mock.mjs";
const require = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { chromium } = require("@playwright/test");
const base = process.env.PAKTRAK_URL || "http://localhost:5173";
const out = new URL("../../docs/images/", import.meta.url).pathname;

const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const desktop = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };
const shots = (await import("./shots.mjs")).default;
const only = process.argv.slice(2);
const browser = await chromium.launch();
for (const shot of shots) {
  if (only.length && !only.includes(shot.name)) continue;
  const context = await browser.newContext({ ...(shot.desktop ? desktop : phone), colorScheme: shot.dark ? "dark" : "light", reducedMotion: "no-preference" });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(shot.name, "pageerror", e.message));
  await page.route("**/api/**", route(shot.handlers?.() || {}));
  await page.addInitScript(() => { try { localStorage.setItem("paktrak.review.demo-owner.expected", "9"); } catch {} });
  await page.addInitScript(() => { document.addEventListener("DOMContentLoaded", () => { document.documentElement.style.scrollbarGutter = "auto"; }); });
  try {
    await shot.run(page, base);
    await page.evaluate(() => (document.activeElement)?.blur?.());
    await page.waitForTimeout(shot.settle ?? 900);
    await page.screenshot({ path: out + shot.name + ".png", fullPage: !!process.env.FULL });
    console.log("saved", shot.name);
  } catch (error) { console.log(shot.name, "FAILED", error.message.split("\n")[0]); await page.screenshot({ path: "/tmp/fail-" + shot.name + ".png" }); }
  await context.close();
}
await browser.close();
