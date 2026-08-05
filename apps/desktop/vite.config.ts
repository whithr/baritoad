/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite serves the webview content in `tauri dev` and emits ../dist for
// bundled builds (tauri.conf.json frontendDist).
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "es2021",
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
