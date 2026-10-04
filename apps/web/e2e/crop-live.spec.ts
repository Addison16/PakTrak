import { expect, test, type Page } from "@playwright/test";
import { createCollector } from "./account";
import { navigate, skipWelcomeTour } from "./navigation";

async function cropColors(page: Page) {
  return page.getByAltText("Your scanned card", { exact: true }).evaluate((image: HTMLImageElement) => {
    if (!image.complete || !image.naturalWidth) return [];
    const canvas = document.createElement("canvas"); canvas.width = 600; canvas.height = 840;
    const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0, 600, 840);
    return [[150, 210], [450, 210], [150, 630], [450, 630]].map(([x, y]) =>
      [...context.getImageData(x, y, 1, 1).data].slice(0, 3).map((value) => value > 127 ? 255 : 0));
  });
}

test("manual outline and saved flips keep their orientation through Docker processing and reopening", async ({ browser, request }) => {
  const account = await createCollector(request);
  let context = await browser.newContext({ baseURL: account.baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    let page = await context.newPage();
    await page.goto("/"); await page.getByRole("link", { name: "Sign in", exact: true }).click();
    await page.locator("#username").fill(account.username); await page.locator("#password").fill(account.password); await page.locator("#kc-login").click();
    await skipWelcomeTour(page); await navigate(page, "Upload photo");
    // Original four-color pixels identify both rotation and mirroring. No card
    // names/art or fake catalog matches: this board has no automatic regions.
    const board = await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 600; canvas.height = 840;
      const context = canvas.getContext("2d")!;
      for (const [color, x, y] of [["red", 0, 0], ["lime", 300, 0], ["blue", 0, 420], ["yellow", 300, 420]] as const) {
        context.fillStyle = color; context.fillRect(x, y, 300, 420);
      }
      return canvas.toDataURL("image/png").split(",")[1];
    });
    const acceptance = page.waitForResponse((response) => response.url().endsWith("/finalize") && response.status() === 202);
    void acceptance.catch(() => {});
    await page.getByTestId("photo-input").setInputFiles({ name: "synthetic-orientation.png", mimeType: "image/png", buffer: Buffer.from(board, "base64") });
    const accepted = await (await acceptance).json();
    const base = "/api/v1/scans/" + accepted.scan_id;
    const ready = () => expect.poll(async () => (await (await context.request.get(base)).json()).state, { timeout: 60000 }).toBe("PHOTO_READY");
    await ready();
    expect((await (await context.request.get(base + "/observations")).json()).items).toHaveLength(0);
    await page.getByRole("button", { name: "Add a missed card", exact: true }).click();
    await expect(page.locator(".crop-canvas img")).toHaveJSProperty("naturalWidth", 600);
    const canvas = page.locator(".crop-canvas"), box = (await canvas.boundingBox())!;
    for (const [x, y] of [[.9,.9],[.9,.1],[.1,.1],[.1,.9]]) await canvas.click({ position: { x: x * box.width, y: y * box.height } });
    const addedResponse = page.waitForResponse((response) => response.url().endsWith("/observations") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Save outline & identify", exact: true }).click();
    expect((await addedResponse).status()).toBe(201);
    const state = await context.storageState(); await context.close();
    context = await browser.newContext({ baseURL: account.baseURL, storageState: state, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await ready();
    page = await context.newPage(); await page.goto("/"); await navigate(page, "Batches");
    await page.getByRole("button", { name: /synthetic-orientation.png/ }).click();
    const upright = [[255,0,0],[0,255,0],[0,0,255],[255,255,0]];
    await expect.poll(() => cropColors(page)).toEqual(upright);
    const savedResponse = page.waitForResponse((response) => response.url().endsWith("/orientation"));
    await page.getByRole("button", { name: "Flip photo 180°", exact: true }).click();
    expect((await savedResponse).status()).toBe(200);
    await ready(); await page.reload(); await navigate(page, "Batches");
    await page.getByRole("button", { name: /synthetic-orientation.png/ }).click();
    await expect.poll(() => cropColors(page)).toEqual([...upright].reverse());
    const batch = await (await context.request.get(base + "/observations")).json();
    expect(batch.items).toHaveLength(1); expect(batch.items[0].rotation).toBe(180);
    const flippedBack = page.waitForResponse((response) => response.url().endsWith("/orientation"));
    await page.getByRole("button", { name: "Flip photo 180°", exact: true }).click();
    expect((await flippedBack).status()).toBe(200);
    await ready();
    await expect.poll(() => cropColors(page)).toEqual(upright);
    expect((await (await context.request.get("/api/auth/session")).json()).scan_cards_used).toBe(1);
    expect((await (await context.request.get("/api/v1/collection")).json()).copies).toBe(0);
    await page.screenshot({ path: `../../artifacts/crop-orientation/live-${test.info().project.name}.png`, fullPage: true });
  } finally { await context.close().catch(() => {}); await account.remove(); }
});
