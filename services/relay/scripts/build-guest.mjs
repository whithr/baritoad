// Builds the guest page into public/ (served by the Worker's static assets):
// the bundled script, the page, the pixel font (CC0, the app's own) and a
// toad favicon drawn from the app's toad grids. `pnpm build`; `pnpm dev` and
// `pnpm run deploy` run it first.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const pub = join(root, "public");
const fonts = resolve(root, "..", "..", "apps", "desktop", "src", "assets", "fonts");
mkdirSync(join(pub, "fonts"), { recursive: true });

await build({
  entryPoints: [join(root, "src", "guest", "main.ts")],
  bundle: true,
  minify: true,
  format: "iife",
  target: ["es2020", "safari14"],
  outfile: join(pub, "guest.js"),
  legalComments: "none",
  banner: { js: "/* baritoad party page — GPL-3.0-or-later — source: services/relay in the baritoad repo */" },
});
copyFileSync(join(root, "src", "guest", "guest.html"), join(pub, "guest.html"));
for (const f of ["pixel-operator-regular.ttf", "pixel-operator-bold.ttf", "PIXEL-OPERATOR-LICENSE-CC0.txt"]) {
  copyFileSync(join(fonts, f), join(pub, "fonts", f));
}

// The favicon: the default toad's face, from the same grids as the TV.
const favicon = await build({
  stdin: {
    contents: `import { toadSvg, DEFAULT_TOAD } from "../../apps/desktop/src/party/toads"; export default toadSvg(DEFAULT_TOAD, 1, false);`,
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  write: false,
  platform: "node",
});
const mod = await import(`data:text/javascript;base64,${Buffer.from(favicon.outputFiles[0].text).toString("base64")}`);
writeFileSync(join(pub, "favicon.svg"), mod.default);
console.log("guest page built into public/");
