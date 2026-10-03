import { expect, test, type Page } from "@playwright/test";
import { fixture } from "./deck-fixture";

async function openHeld(page: Page) {
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
  await fixture(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/v1/decks/saved-deck", async route => { await gate; await route.fallback().catch(() => {}); });
  await page.locator('.deck-box-button[data-deck-id="saved-deck"]').click();
  const opening = page.locator(".deck-opening");
  await expect(opening).toBeVisible();
  await opening.evaluate(root => {
    for (const animation of root.getAnimations({ subtree: true })) {
      animation.pause();
      if (animation.id !== "deck-lid-hinge") animation.currentTime = Number(animation.effect!.getTiming().delay) + Number(animation.effect!.getTiming().duration);
    }
  });
  return { opening, release };
}

async function pixels(page: Page, points: { x: number; y: number }[]) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const raster = await page.screenshot();
  return page.evaluate(async ({ raster, points }) => {
    const image = new Image(); image.src = raster; await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
    return points.map(point => [...context.getImageData(Math.floor(point.x), Math.floor(point.y), 1, 1).data]);
  }, { raster: `data:image/png;base64,${raster.toString("base64")}`, points });
}

for (const width of [390, 1280]) {
  test(`cards emerge above the rim and cannot paint through the front wall at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const { opening, release } = await openHeld(page);
    try {
      const flight = opening.locator(".deck-opening-card").first();
      await opening.locator(".deck-opening-card").evaluateAll(elements => elements.forEach(element => { (element as HTMLElement).style.visibility = "hidden"; }));
      await flight.evaluate(element => {
        const motion = element.getAnimations().find(animation => animation.effect instanceof KeyframeEffect && animation.effect.getKeyframes().some(frame => frame.transform !== undefined))!;
        motion.currentTime = Number(motion.effect!.getTiming().delay);
        for (const image of element.querySelectorAll<HTMLElement>("img")) image.remove();
        // Paint both sides to check enclosure regardless of the current face.
        for (const surface of element.querySelectorAll<HTMLElement>(".deck-opening-card-front, .deck-opening-card-back")) surface.style.background = "#ff00ff";
      });
      const rect = await flight.boundingBox();
      if (!rect) throw new Error("Card did not render");
      const samples = [{ x: rect.x + rect.width * .5, y: rect.y + rect.height * .5 }, { x: rect.x + rect.width * .3, y: rect.y + rect.height * .3 }];
      const before = await pixels(page, samples);
      await flight.evaluate(element => { (element as HTMLElement).style.visibility = "visible"; });
      const after = await pixels(page, samples);
      for (let index = 0; index < before.length; index++) {
        expect(Math.max(...after[index].map((value, channel) => Math.abs(value - before[index][channel]))), `card concealed by shell at ${width}px`).toBeLessThanOrEqual(1);
      }
      await flight.evaluate(element => {
        const motion = element.getAnimations().find(animation => animation.effect instanceof KeyframeEffect && animation.effect.getKeyframes().some(frame => frame.transform !== undefined))!;
        const timing = motion.effect!.getTiming();
        motion.currentTime = Number(timing.delay) + Number(timing.duration) * .16;
      });
      const lifted = await flight.boundingBox();
      if (!lifted) throw new Error("Lifted card did not render");
      const [visible] = await pixels(page, [{ x: lifted.x + lifted.width / 2, y: lifted.y + lifted.height / 2 }]);
      expect(visible[0]).toBeGreaterThan(220);
      expect(visible[1]).toBeLessThan(30);
      expect(visible[2]).toBeGreaterThan(220);
    } finally { release(); }
  });

  test(`cap seams stay opaque through a hinged opening with a solid underside at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const { opening, release } = await openHeld(page);
    try {
      await opening.locator(".deck-opening-card").evaluateAll(elements => elements.forEach(element => { (element as HTMLElement).style.visibility = "hidden"; }));
      await opening.locator(".deck-box-stamp, .deck-box-clasp").evaluateAll(elements => elements.forEach(element => { (element as HTMLElement).style.visibility = "hidden"; }));
      const lid = opening.locator(".deck-box-lid");
      for (const phase of [0, .25, .55, 1]) {
        const expected = await lid.evaluate((svg, phase) => {
          const animation = svg.getAnimations().find(animation => animation.id === "deck-lid-hinge")!;
          const timing = animation.effect!.getTiming();
          animation.currentTime = Number(timing.delay) + Number(timing.duration) * phase;
          return (animation.effect!.getComputedTiming().progress || 0) * 112;
        }, phase);
        await expect.poll(() => lid.getAttribute("data-hinge-angle").then(value => Number(value))).toBeCloseTo(expected, 1);
        const samples = await lid.evaluate(svg => {
          const edges = new Map<string, { count: number; point: { x: number; y: number } }>();
          for (const face of svg.querySelectorAll(".deck-box-cap-face")) {
            const vertices = [...face.getAttribute("d")!.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map(match => ({ x: Number(match[1]), y: Number(match[2]) }));
            vertices.forEach((a, index) => {
              const b = vertices[(index + 1) % vertices.length];
              const key = [a, b].map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).sort().join("|");
              const edge = edges.get(key) || { count: 0, point: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
              edge.count++; edges.set(key, edge);
            });
          }
          return [...edges.values()].filter(edge => edge.count > 1).map(edge => {
            const position = new DOMPoint(edge.point.x, edge.point.y).matrixTransform((svg as SVGSVGElement).getScreenCTM()!);
            return { x: position.x / position.w, y: position.y / position.w };
          });
        });
        expect(samples.length).toBeGreaterThan(0);
        samples.push(...await opening.locator(".deck-box-body").first().evaluate(svg => [40, 85, 140].map(y => {
          const point = new DOMPoint(100, y).matrixTransform((svg as SVGSVGElement).getScreenCTM()!);
          return { x: point.x / point.w, y: point.y / point.w };
        })));
        for (const color of await pixels(page, samples)) {
          expect(Math.max(...color.slice(0, 3)), `sealed cap seam at ${phase}: ${color}`).toBeLessThan(200);
          expect(color[3]).toBe(255);
        }
      }
      const lining = await lid.locator(".deck-box-cap-lining").boundingBox();
      const front = await opening.locator(".deck-box-front").first().boundingBox();
      expect(lining).not.toBeNull();
      expect(lining!.height).toBeGreaterThan(front!.height * .3);
      expect(lining!.y).toBeLessThan(front!.y - front!.height * .25);
      await expect(opening.locator(".deck-box-seam")).toBeHidden();
    } finally { release(); }
  });
}
