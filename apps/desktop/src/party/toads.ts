// Guests' toads (docs/PARTY.md "Toads"): the site's toad family — the app's
// 16-px face with the eyes and mouth swapped for a feeling, the greens
// recoloured, and something to wear — drawn as crisp SVG squares at
// whole-pixel multiples, never smoothed. Ported from the site's
// scripts/toads.mjs; the relay's guest page imports this file too, so the
// phone and the TV draw the same toad. The lists match karaoke-core `party`
// (FACES, COLOURS, HATS), which validates what guests send.

export const FACES = ["sing", "smile", "grin", "wink", "sleepy", "surprised", "love", "cool", "belt", "nervous", "sad"] as const;
export const COLOURS = ["green", "pink", "blue", "gold", "purple"] as const;
export const HATS = ["none", "crown", "partyhat", "cap", "bow", "headphones", "bowtie"] as const;

export type Face = (typeof FACES)[number];
export type Colour = (typeof COLOURS)[number];
export type Hat = (typeof HATS)[number];
export interface Toad {
  face: Face;
  colour: Colour;
  hat: Hat;
}

export const DEFAULT_TOAD: Toad = { face: "sing", colour: "green", hat: "none" };

export const isToad = (t: unknown): t is Toad => {
  const x = t as Toad | null;
  return !!x && FACES.includes(x.face) && COLOURS.includes(x.colour) && HATS.includes(x.hat);
};

// ------------------------------------------------------------ palette
const FIXED: Record<string, string> = {
  K: "#000", W: "#fff", O: "#ffa800", P: "#000", C: "#f8e0a0", R: "#a00000", T: "#ff6868",
  H: "#ff2a5c", S: "#6f86ff", D: "#7fd8ff", Y: "#ffd000", M: "#d4389b", N: "#000080", n: "#1084d0",
  A: "#404040", a: "#a0a0a0", B: "#ff79c6", b: "#c8407a", Z: "#c00018", z: "#900010",
};
export const COLOUR_HEX: Record<Colour, [string, string]> = {
  green: ["#4c9420", "#8cd048"],
  pink: ["#c84a8a", "#f08cc0"],
  blue: ["#2a6ad0", "#7ab0f0"],
  gold: ["#c89a10", "#f0d060"],
  purple: ["#7a4ac8", "#b08cf0"],
};

// ------------------------------------------------------------ the face
// rows 0-15; G and L are the greens (recoloured), "." is clear
const HEAD: Record<number, string> = {
  0: "................",
  5: "KGGGGLGGGGLGGGGK",
  6: "KGLGGGGGGGGGGLGK",
  15: "................",
};
const EYES: Record<string, string[]> = {
  open: ["..KKKK....KKKK..", ".KWOOOK..KWOOOK.", ".KOPPOKKKKOPPOK.", ".KOOOOKGGKOOOOK."],
  happy: ["..KKKK....KKKK..", ".KGKKGK..KGKKGK.", ".KKGGKKKKKKGGKK.", ".KGGGGKGGKGGGGK."],
  squeeze: ["..KKKK....KKKK..", ".KKKGGK..KGGKKK.", ".KGGKKKKKKKKGGK.", ".KKKGGKGGKGGKKK."],
  wink: ["..KKKK....KKKK..", ".KWOOOK..KGKKGK.", ".KOPPOKKKKKGGKK.", ".KOOOOKGGKGGGGK."],
  sleepy: ["..KKKK....KKKK..", ".KGGGGK..KGGGGK.", ".KKKKKKKKKKKKKK.", ".KOPPOKGGKOPPOK."],
  hearts: [".HH.HH....HH.HH.", ".HHHHH....HHHHH.", "..HHH.KKKK.HHH..", ".KGHGGKGGKGGHGK."],
  shades: ["..KKKK....KKKK..", ".KKKKKKKKKKKKKK.", ".KSKKKKGGKSKKKK.", ".KGGGGKGGKGGGGK."],
  wide: ["..KKKK....KKKK..", ".KWWWWK..KWWWWK.", ".KWPPWKKKKWPPWK.", ".KWWWWKGGKWWWWK."],
  low: ["..KKKK....KKKK..", ".KOOOOK..KOOOOK.", ".KOOOOKKKKOOOOK.", ".KOPPOKGGKOPPOK."],
};
const MOUTHS: Record<string, string[]> = {
  // rows 7-14 (belt starts at row 6)
  sing: ["KGKKKKKKKKKKKKGK", "KKRRRRRRRRRRRRKK", "KCKRRRRRRRRRRKCK", "KCCKRRTTTTRRKCCK", "KCCCKKTTTTKKCCCK", ".KCCCCKKKKCCCCK.", "..KCCCCCCCCCCK..", "...KKKKKKKKKK..."],
  smile: ["KGGGGGGGGGGGGGGK", "KGKGGGGGGGGGGKGK", "KGGKKKKKKKKKKGGK", "KCCCCCCCCCCCCCCK", "KCCCCCCCCCCCCCCK", ".KCCCCCCCCCCCCK.", "..KCCCCCCCCCCK..", "...KKKKKKKKKK..."],
  grin: ["KGGGGGGGGGGGGGGK", "KGKKKKKKKKKKKKGK", "KCKRRRRRRRRRRKCK", "KCCKRRTTTTRRKCCK", "KCCCKKKKKKKKCCCK", ".KCCCCCCCCCCCCK.", "..KCCCCCCCCCCK..", "...KKKKKKKKKK..."],
  oh: ["KGGGGGGGGGGGGGGK", "KGGGGGKKKKGGGGGK", "KCCCCKRRRRKCCCCK", "KCCCCKRTTRKCCCCK", "KCCCCCKKKKCCCCCK", ".KCCCCCCCCCCCCK.", "..KCCCCCCCCCCK..", "...KKKKKKKKKK..."],
  frown: ["KGGGGGGGGGGGGGGK", "KGGGGGGGGGGGGGGK", "KGGKKKKKKKKKKGGK", "KCKCCCCCCCCCCKCK", "KCCCCCCCCCCCCCCK", ".KCCCCCCCCCCCCK.", "..KCCCCCCCCCCK..", "...KKKKKKKKKK..."],
  wobble: ["KGGGGGGGGGGGGGGK", "KGGGGGGGGGGGGGGK", "KGGKKGGKKGGKKGGK", "KCCCCKKCCKKCCCCK", "KCCCCCCCCCCCCCCK", ".KCCCCCCCCCCCCK.", "..KCCCCCCCCCCK..", "...KKKKKKKKKK..."],
};
const BELT = ["KGKKKKKKKKKKKKGK", "KKRRRRRRRRRRRRKK", "KKRRRRRRRRRRRRKK", "KCKRRRRRRRRRRKCK", "KCCKRRTTTTRRKCCK", "KCCCKRTTTTRKCCCK", ".KCCCKKKKKKCCCK.", "..KCCCCCCCCCCK..", "...KKKKKKKKKK..."];

const FACE_PARTS: Record<Face, { eyes: string; mouth: string; over?: Record<number, string> }> = {
  sing: { eyes: "open", mouth: "sing" },
  smile: { eyes: "open", mouth: "smile" },
  grin: { eyes: "happy", mouth: "grin" },
  wink: { eyes: "wink", mouth: "smile" },
  sleepy: { eyes: "sleepy", mouth: "smile" },
  surprised: { eyes: "wide", mouth: "oh" },
  love: { eyes: "hearts", mouth: "smile" },
  cool: { eyes: "shades", mouth: "smile" },
  belt: { eyes: "squeeze", mouth: "belt" },
  nervous: { eyes: "open", mouth: "wobble", over: { 5: ".............D..", 6: "............DD.." } },
  sad: { eyes: "low", mouth: "frown", over: { 5: "...D............", 6: "...D............", 7: "..D............." } },
};

// things to wear: grids by row (rows below 0 sit above the head)
const WEAR: Record<Exclude<Hat, "none">, Record<number, string>> = {
  crown: { [-3]: ".......YY.......", [-2]: ".....Y.YY.Y.....", [-1]: ".....Y.RR.Y.....", 0: ".....YYYYYY....." },
  partyhat: { [-4]: ".......YY.......", [-3]: ".......MM.......", [-2]: "......MYYM......", [-1]: "......MMMM......", 0: ".....YYYYYY....." },
  cap: { [-3]: ".......zz.......", [-2]: "...ZZZZZZZZZZ...", [-1]: "...ZZZZZZZZZZ...", 0: "...ZZZZZZzzzzzz." },
  bow: { [-2]: "....BB....BB....", [-1]: "....BBBbbBBB....", 0: "....BB....BB...." },
  headphones: {
    0: "..AAAAAAAAAAAA..", 1: ".A............A.", 2: "A..............A", 3: "A..............A",
    4: "AA............AA", 5: "Aa............aA", 6: "Aa............aA", 7: "Aa............aA", 8: "AA............AA",
  },
  bowtie: { 14: ".....NNnnNN.....", 15: ".....NN..NN....." },
};

/** The toad's rows, -4…15 (blank above the head when it wears nothing tall). */
export function toadRows(t: Toad): Record<number, string> {
  const f = FACE_PARTS[t.face] ?? FACE_PARTS.sing;
  const rows: Record<number, string> = { ...HEAD };
  EYES[f.eyes].forEach((r, i) => (rows[1 + i] = r));
  if (f.mouth === "belt") BELT.forEach((r, i) => (rows[6 + i] = r));
  else MOUTHS[f.mouth].forEach((r, i) => (rows[7 + i] = r));
  const layers = [f.over ?? {}, t.hat !== "none" ? WEAR[t.hat] ?? {} : {}];
  for (const layer of layers) {
    for (const [ys, row] of Object.entries(layer)) {
      const y = Number(ys);
      const base = rows[y] ?? "................";
      rows[y] = [...base].map((c, x) => (row[x] !== "." ? row[x] : c)).join("");
    }
  }
  return rows;
}

export interface ToadRect {
  x: number;
  y: number;
  w: number;
  fill: string;
}

/** Runs of one colour per row, as rects on the 16-wide grid. */
export function toadRects(t: Toad): ToadRect[] {
  const fill: Record<string, string> = { ...FIXED, G: COLOUR_HEX[t.colour]?.[0] ?? COLOUR_HEX.green[0], L: COLOUR_HEX[t.colour]?.[1] ?? COLOUR_HEX.green[1] };
  const rows = toadRows(t);
  const out: ToadRect[] = [];
  for (const y of Object.keys(rows).map(Number).sort((a, b) => a - b)) {
    const row = rows[y];
    for (let x = 0; x < 16; ) {
      const k = row[x];
      let w = 1;
      while (x + w < 16 && row[x + w] === k) w++;
      if (k !== ".") out.push({ x, y, w, fill: fill[k] });
      x += w;
    }
  }
  return out;
}

/** The toad as an SVG string: `full` is the 16×20 figure (hat room above
 *  the head, so toads stand on one line), otherwise the 16×16 face. `scale`
 *  is a whole number of screen pixels per toad pixel. */
export function toadSvg(t: Toad, scale: number, full = true): string {
  const top = full ? -4 : 0;
  const h = full ? 20 : 16;
  const rects = toadRects(t)
    .filter((r) => r.y >= top && r.y < top + h)
    .map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="1" fill="${r.fill}"/>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 ${top} 16 ${h}" width="${16 * scale}" height="${h * scale}" shape-rendering="crispEdges">${rects}</svg>`;
}

/** Words for a toad (screen readers; the name is always shown beside it). */
export const toadLabel = (t: Toad) => `${t.colour} toad, ${t.face}${t.hat !== "none" ? `, ${t.hat === "partyhat" ? "party hat" : t.hat}` : ""}`;
