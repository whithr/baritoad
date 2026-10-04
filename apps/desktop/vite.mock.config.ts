// Browser-only harness: the real UI over dev/mockTauri.ts. Never used by
// `pnpm build` / `tauri dev` (those use vite.config.ts).
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const mock = path.resolve(__dirname, "dev/mockTauri.ts");
export default defineConfig({
  plugins: [react()],
  // Its own pre-bundle cache: sharing node_modules/.vite with the real config
  // made each `tauri dev` after a mock run re-optimize its dependencies.
  cacheDir: "node_modules/.vite-mock",
  resolve: {
    alias: [
      { find: /^@tauri-apps\/api\/(core|event|webview|window)$/, replacement: mock },
      { find: "@tauri-apps/plugin-dialog", replacement: mock },
    ],
  },
  server: { port: 1421, strictPort: true },
});
