import { defineConfig } from "@playwright/test";

// Lets context.route see the service worker's own requests (offline.spec.ts).
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = "1";

export default defineConfig({
  testDir: "./e2e",
  timeout: 180000,
  workers: 1,
  retries: 0,
  reporter: "list",
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  use: {
    colorScheme: process.env.SCANNER_E2E_COLOR_SCHEME === "dark" ? "dark" : "light",
    actionTimeout: 15000,
    baseURL: process.env.SCANNER_E2E_URL || "http://localhost:8095",
    viewport: { width: 390, height: 844 },
    trace: "off",
    // page.route can't see requests a service worker answers; offline.spec.ts turns it on where needed.
    serviceWorkers: "block",
    screenshot: "off",
  },
});
