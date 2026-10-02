import { expect, test } from "@playwright/test";
import { fixture } from "./deck-fixture";

for (const width of [320, 1280]) for (const copies of [6, 12]) test(`${copies}-card deck scatter shows readable MTG backs naturally at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const mock = await fixture(page, copies === 12);
  const deckId = copies === 12 ? "partners" : "saved-deck";

  // Load the shipped image before measuring flight geometry, independently of
  // the asynchronous front artwork and deck-detail response.
  const backImage = await page.evaluate(() => new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error("The real MTG card-back asset did not load."));
    image.src = "/cards/mtg-card-back.png";
  }));
  expect(backImage.width).toBeGreaterThan(200);
  expect(backImage.height).toBeGreaterThan(backImage.width);

  let release!: () => void;
  let gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/v1/decks/${deckId}`, async route => {
    await gate;
    await route.fallback().catch(() => {});
  });

  try {
    await page.locator(`.deck-box-button[data-deck-id="${deckId}"]`).click();
    const opening = page.locator(".deck-opening");
    await expect(opening.locator(".deck-opening-card")).toHaveCount(copies);

    // Sample the animation as it runs. Seeking a keyframe or manually exposing
    // a back plane could pass while all back-facing frames are off screen.
    const journey = await opening.evaluate(root => new Promise<{ longestReadable: number[]; loadedPlanes: boolean; revealing: boolean }>(resolve => {
      const flights = [...root.querySelectorAll<HTMLElement>(".deck-opening-card")];
      const spans = flights.map(() => ({ since: 0, last: 0, longest: 0 }));
      let loadedPlanes = true;
      const started = performance.now();
      const sample = () => {
        const now = performance.now();
        flights.forEach((flight, index) => {
          const style = getComputedStyle(flight);
          const matrix = new DOMMatrixReadOnly(style.transform);
          const back = flight.querySelector<HTMLElement>(".deck-opening-card-back")!;
          const backStyle = getComputedStyle(back);
          const rect = back.getBoundingClientRect();
          const visibleWidth = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
          const visibleHeight = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
          const facing = matrix.m33 / Math.hypot(matrix.m13, matrix.m23, matrix.m33);
          const projectedArea = flight.offsetWidth * flight.offsetHeight * Math.abs(matrix.m11 * matrix.m22 - matrix.m12 * matrix.m21);
          const realBack = backStyle.backgroundImage.includes("/cards/mtg-card-back.png") && backStyle.backgroundSize === "cover" && backStyle.backfaceVisibility === "hidden";
          loadedPlanes &&= realBack;
          const readable = realBack && facing < -.65 && Number(style.opacity) >= .9 && Number(backStyle.opacity) >= .9 && backStyle.visibility === "visible"
            && visibleWidth >= 40 && visibleHeight >= 65 && projectedArea >= 2200
            && visibleWidth * visibleHeight >= rect.width * rect.height * .7;
          const span = spans[index];
          if (readable) {
            if (!span.since || now - span.last > 75) span.since = now;
            span.last = now;
            span.longest = Math.max(span.longest, now - span.since);
          } else span.since = 0;
        });
        if (now - started < 1800) requestAnimationFrame(sample);
        else resolve({ longestReadable: spans.map(span => Math.round(span.longest)), loadedPlanes, revealing: root.classList.contains("deck-opening--revealing") });
      };
      sample();
    }));
    expect(journey.loadedPlanes).toBe(true);
    expect(journey.revealing).toBe(false);
    expect(journey.longestReadable.filter(duration => duration >= 160).length, JSON.stringify(journey)).toBeGreaterThanOrEqual(copies / 3);

    release();
    await expect(opening).toHaveCount(0);
    await expect(page.getByRole("heading", { name: copies === 12 ? "Partners in adventure" : "Friday night", exact: true })).toBeFocused();
    await expect(page.locator("[data-deck-landing]")).toHaveCount(0);

    // Geometry alone cannot detect a compositor flattening the front onto a
    // rear-facing card. Reopen for a short raster capture, preserving the
    // uninterrupted real-time duration measurement above.
    await page.getByRole("button", { name: "Close deck", exact: true }).click();
    gate = new Promise<void>(resolve => { release = resolve; });
    await page.locator(`.deck-box-button[data-deck-id="${deckId}"]`).click();
    await page.waitForFunction(minimum => [...document.querySelectorAll<HTMLElement>(".deck-opening-card")].filter(flight => {
      const style = getComputedStyle(flight), matrix = new DOMMatrixReadOnly(style.transform), rect = flight.getBoundingClientRect();
      return Number(style.opacity) >= .9 && matrix.m33 / Math.hypot(matrix.m13, matrix.m23, matrix.m33) < -.8
        && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
    }).length >= minimum, copies / 3, { polling: "raf" });
    const capture = await opening.evaluate(root => {
      const flights = [...root.querySelectorAll<HTMLElement>(".deck-opening-card")];
      flights.forEach(flight => flight.getAnimations({ subtree: true }).forEach(animation => animation.pause()));
      const rects = flights.flatMap(flight => {
        const style = getComputedStyle(flight), matrix = new DOMMatrixReadOnly(style.transform);
        if (matrix.m33 / Math.hypot(matrix.m13, matrix.m23, matrix.m33) >= -.8) return [];
        const rect = flight.querySelector(".deck-opening-card-back")!.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
          ? [{ x: rect.x, y: rect.y, width: rect.width, height: rect.height }] : [];
      });
      return { rects, viewportWidth: innerWidth, viewportHeight: innerHeight };
    });
    const raster = await page.screenshot({ animations: "allow" });
    await opening.evaluate(root => root.querySelectorAll<HTMLElement>(".deck-opening-card").forEach(flight => {
      flight.getAnimations({ subtree: true }).forEach(animation => animation.play());
    }));
    const pixels = await page.evaluate(async ({ capture, raster }) => {
      const decode = (url: string) => new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = url;
      });
      const read = (image: HTMLImageElement) => {
        const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
        return { data: context.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width, height: canvas.height };
      };
      const [source, screenshot] = await Promise.all([decode("/cards/mtg-card-back.png"), decode(raster)]);
      const back = read(source), screen = read(screenshot), palette = new Set<number>();
      // The shipped MTG back contains a broad warm brown/red palette. Fixture
      // fronts and the canvas contain green, gray and cream instead. Learn the
      // coarse bins from the actual asset rather than a whole-screen snapshot.
      const warm = (red: number, green: number, blue: number) => red > 35 && red < 235 && red > green * 1.25 && red > blue * 1.5;
      const bin = (red: number, green: number, blue: number) => (red >> 4) << 8 | (green >> 4) << 4 | blue >> 4;
      for (let index = 0; index < back.data.length; index += 4) {
        const [red, green, blue] = back.data.subarray(index, index + 3);
        if (warm(red, green, blue)) palette.add(bin(red, green, blue));
      }
      const scaleX = screen.width / capture.viewportWidth, scaleY = screen.height / capture.viewportHeight;
      return capture.rects.map(rect => {
        const left = Math.max(0, Math.ceil(rect.x * scaleX)), right = Math.min(screen.width, Math.floor((rect.x + rect.width) * scaleX));
        const top = Math.max(0, Math.ceil(rect.y * scaleY)), bottom = Math.min(screen.height, Math.floor((rect.y + rect.height) * scaleY));
        let matching = 0;
        for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
          const index = (y * screen.width + x) * 4, [red, green, blue] = screen.data.subarray(index, index + 3);
          if (warm(red, green, blue) && palette.has(bin(red, green, blue))) matching++;
        }
        return { matching, fraction: matching / ((right - left) * (bottom - top)) };
      });
    }, { capture, raster: `data:image/png;base64,${raster.toString("base64")}` });
    expect(pixels.length).toBeGreaterThanOrEqual(copies / 3);
    expect(pixels.filter(card => card.fraction >= .06).length, JSON.stringify(pixels)).toBeGreaterThanOrEqual(copies / 3);

    release();
    await expect(opening).toHaveCount(0);
    await expect(page.getByRole("heading", { name: copies === 12 ? "Partners in adventure" : "Friday night", exact: true })).toBeFocused();
    await expect(page.locator("[data-deck-landing]")).toHaveCount(0);
    expect(mock.calls.filter(call => call.method !== "GET")).toHaveLength(0);
  } finally {
    release();
  }
});
