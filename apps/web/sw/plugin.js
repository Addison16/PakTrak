import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// Builds sw.js with the list of files PakTrak needs to open offline. Its
// contents change with every build, so browsers pick up new versions.
/** @param {{ imageLimit: number }} options @returns {import("vite").Plugin} */
export default function serviceWorker({ imageLimit }) {
  let publicDir = "";
  return {
    name: "paktrak-service-worker",
    apply: "build",
    configResolved(config) { publicDir = config.publicDir; },
    generateBundle(_, bundle) {
      /** @param {string} dir @returns {string[]} */
      const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
      const publicFiles = files(publicDir).map((file) => "/" + relative(publicDir, file).split("\\").join("/"))
        .filter((file) => !/\.(md|txt)$/.test(file) && !/appearance-v1\./.test(file));
      const built = Object.keys(bundle).filter((file) => !file.endsWith(".map") && file !== "index.html").map((file) => "/" + file);
      const precache = ["/", ...built, ...publicFiles].sort();
      const hash = createHash("sha256");
      for (const file of Object.values(bundle)) hash.update(file.type === "chunk" ? file.code : file.source);
      for (const file of publicFiles) hash.update(readFileSync(join(publicDir, file)));
      const template = readFileSync(new URL("./service-worker.js", import.meta.url), "utf8");
      this.emitFile({ type: "asset", fileName: "sw.js", source: template
        .replace('"__VERSION__"', JSON.stringify(hash.digest("hex").slice(0, 16)))
        .replace("__PRECACHE__", JSON.stringify(precache))
        .replace("__IMAGE_LIMIT__", String(imageLimit)) });
    },
  };
}
