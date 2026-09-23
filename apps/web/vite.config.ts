import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { target: ["es2020", "chrome100", "safari15.4"] },
  server: {
    proxy: {
      "/api": "http://localhost:8095",
      "/identity": "http://localhost:8095",
    },
  },
});
