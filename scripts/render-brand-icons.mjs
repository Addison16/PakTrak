// Run from the repository in the pinned Playwright container used by test-browser.sh.
import { readFile, writeFile } from "node:fs/promises";
import { chromium } from "../apps/web/node_modules/playwright/index.mjs";

const root = new URL("../apps/web/public/", import.meta.url);
const loginImages = new URL("../infra/themes/paktrak/login/resources/img/", import.meta.url);
const svg = await readFile(new URL("brand/paktrak-mark.svg", root), "utf8");
const browser = await chromium.launch();
try {
  for (const size of [64, 180, 192, 512]) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<html><body style="margin:0">${svg}</body></html>`);
    const png = await page.locator("svg").screenshot({ omitBackground: true });
    if (size === 64) {
      // Keycloak's inherited template requests img/favicon.ico. Use a PNG-backed ICO.
      const header = Buffer.alloc(22);
      header.writeUInt16LE(1, 2); // Icon type.
      header.writeUInt16LE(1, 4); // One image.
      header[6] = size;
      header[7] = size;
      header.writeUInt16LE(1, 10); // Color planes.
      header.writeUInt16LE(32, 12); // Bits per pixel.
      header.writeUInt32LE(png.length, 14);
      header.writeUInt32LE(header.length, 18);
      await writeFile(new URL("favicon.ico", loginImages), Buffer.concat([header, png]));
    } else {
      await writeFile(new URL(`brand/paktrak-${size}.png`, root), png);
    }
    await page.close();
  }
  await writeFile(new URL("paktrak-mark.svg", loginImages), svg);
  // Existing bookmarks using the old icon URL also receive the current mark.
  await writeFile(new URL("icon.svg", root), svg);
} finally {
  await browser.close();
}
