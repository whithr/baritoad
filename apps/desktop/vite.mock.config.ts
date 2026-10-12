// Browser-only harness: the real UI over dev/mockTauri.ts. Never used by
// `pnpm build` / `tauri dev` (those use vite.config.ts).
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const mock = path.resolve(__dirname, "dev/mockTauri.ts");

// The built harness is demo.baritoad.com (wrangler.demo.toml): a stand-in for
// the app, so search engines leave it out.
const noindex: Plugin = {
  name: "demo-noindex",
  apply: "build",
  transformIndexHtml: () => [
    { tag: "meta", attrs: { name: "robots", content: "noindex" }, injectTo: "head" },
  ],
  generateBundle() {
    this.emitFile({ type: "asset", fileName: "_headers", source: "/*\n  X-Robots-Tag: noindex\n" });
  },
};

export default defineConfig({
  plugins: [react(), noindex],
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
