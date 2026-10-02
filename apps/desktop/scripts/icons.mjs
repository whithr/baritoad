// The app icons (src-tauri/icons), drawn from the 16-px toad in
// src/win98/icons.tsx — the one brand mark (DESIGN.md). Every size is a
// whole-pixel multiple of the 16×16 grid, nearest-neighbour, never smoothed:
// 16 · 32 · 48 · 64 · 128 · 256 · 512 · 1024. Run after changing the toad:
//
//   pnpm icons
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "src", "win98", "icons.tsx"), "utf8");
const block = src.slice(src.indexOf("const TOAD = pixels("));
const rows = [...block.slice(0, block.indexOf("]")).matchAll(/"([^"]{16})"/g)].map((m) => m[1]);
const palette = Object.fromEntries(
  [...block.slice(block.indexOf("{"), block.indexOf("}")).matchAll(/(\w):\s*"#([0-9a-fA-F]{6})"/g)].map((m) => [m[1], m[2]]),
);
if (rows.length !== 16) throw new Error(`expected 16 rows of the toad, found ${rows.length}`);

// ---------------------------------------------------------------- PNG

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

/** The toad at `scale` px per grid pixel, as RGBA PNG bytes. */
function png(scale) {
  const size = 16 * scale;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = rows[Math.floor(y / scale)];
    const o = y * (size * 4 + 1);
    raw[o] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const k = row[Math.floor(x / scale)];
      const p = o + 1 + x * 4;
      if (k === ".") continue; // transparent
      const hex = palette[k];
      if (!hex) throw new Error(`no colour for "${k}"`);
      raw[p] = parseInt(hex.slice(0, 2), 16);
      raw[p + 1] = parseInt(hex.slice(2, 4), 16);
      raw[p + 2] = parseInt(hex.slice(4, 6), 16);
      raw[p + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- ICO / ICNS

/** Windows icon: PNG-compressed entries (Vista and later). */
function ico(scales) {
  const images = scales.map(png);
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); // icon
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach((img, i) => {
    const size = 16 * scales[i];
    const e = 6 + i * 16;
    head[e] = size >= 256 ? 0 : size;
    head[e + 1] = size >= 256 ? 0 : size;
    head.writeUInt16LE(1, e + 4); // planes
    head.writeUInt16LE(32, e + 6); // bits per pixel
    head.writeUInt32LE(img.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += img.length;
  });
  return Buffer.concat([head, ...images]);
}

/** macOS icon: PNG entries by OSType. */
function icns(entries) {
  const parts = entries.map(([type, scale]) => {
    const img = png(scale);
    const h = Buffer.alloc(8);
    h.write(type, 0, "ascii");
    h.writeUInt32BE(img.length + 8, 4);
    return Buffer.concat([h, img]);
  });
  const body = Buffer.concat(parts);
  const h = Buffer.alloc(8);
  h.write("icns", 0, "ascii");
  h.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([h, body]);
}

const out = join(here, "..", "src-tauri", "icons");
const files = {
  "32x32.png": png(2),
  "64x64.png": png(4),
  "128x128.png": png(8),
  "128x128@2x.png": png(16),
  "icon.png": png(32),
  "icon.ico": ico([1, 2, 3, 4, 8, 16]),
  "icon.icns": icns([
    ["icp4", 1],
    ["icp5", 2],
    ["icp6", 4],
    ["ic07", 8],
    ["ic08", 16],
    ["ic09", 32],
    ["ic10", 64],
  ]),
};
for (const [name, bytes] of Object.entries(files)) {
  writeFileSync(join(out, name), bytes);
  console.log(`${name.padEnd(16)} ${bytes.length.toLocaleString()} bytes`);
}
