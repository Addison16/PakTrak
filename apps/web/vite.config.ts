import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import serviceWorker from "./sw/plugin.js";
import motionPreference from "./motionPreference";
import { imageLimit } from "./src/offlineLimits";

export default defineConfig({
  plugins: [react(), serviceWorker({ imageLimit })],
  css: { postcss: { plugins: [motionPreference()] } },
  build: { target: ["es2020", "chrome100", "safari15.4"] },
  server: {
    proxy: {
      "/api": "http://localhost:8095",
      "/identity": "http://localhost:8095",
    },
  },
});
