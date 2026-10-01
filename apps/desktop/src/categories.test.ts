import { describe, expect, it } from "vitest";
import type { Song } from "./api";
import {
  categoryContext,
  categoryFilter,
  decadeOf,
  facets,
  groupRows,
  paceBands,
  paceOf,
  searchSongs,
  type CategoryContext,
} from "./categories";

const NOW = 1_800_000_000;
let nextId = 1;
const song = (over: Partial<Song>): Song => ({
  id: nextId++,
  title: "Untitled",
  artist: null,
  audio_path: "a.mp3",
  audio_hash: `h${nextId}`,
  job_dir: "j",
  timing_map_path: "m.json",
  language_tag: "en",
  date_added: NOW - 100 * 86400,
  play_count: 0,
  ...over,
});

const waterloo = song({ title: "Waterloo", artist: "ABBA", year: 1974, genre: "Pop", pace_wpm: 150, play_count: 4, duration_s: 170 });
const africa = song({ title: "Africa", artist: "Toto", year: 1982, genre: "Rock", pace_wpm: 110 });
const lithium = song({ title: "Lithium", artist: "Nirvana", year: 1992, genre: "Grunge / Rock", pace_wpm: 90, date_added: NOW - 2 * 86400 });
const rap = song({ title: "Lose Yourself", artist: "Eminem", year: 2002, genre: "Hip Hop", pace_wpm: 260, play_count: 1 });
const lied = song({ title: "99 Luftballons", artist: "Nena", year: 1983, genre: "rock", pace_wpm: 120, language_tag: "de" });
const noTimings = song({ title: "Still processing", timing_map_path: null });
const all = [waterloo, africa, lithium, rap, lied, noTimings];
const ctx: CategoryContext = categoryContext(all, NOW);

describe("pace", () => {
  it("splits the library into thirds by words per minute", () => {
    expect(paceBands(all)).toEqual({ slowMax: 110, fastMin: 150 });
    expect(paceOf(lithium, ctx.bands)).toBe("slow");
    expect(paceOf(lied, ctx.bands)).toBe("medium");
    expect(paceOf(rap, ctx.bands)).toBe("fast");
    expect(paceOf(noTimings, ctx.bands)).toBeNull();
  });
  it("needs three measured songs", () => {
    expect(paceBands([waterloo, africa])).toBeNull();
  });
});

describe("tree categories", () => {
  const ids = (id: string) => all.filter(categoryFilter(id, ctx)!).map((s) => s.title);
  it("shelves come from play history and date added", () => {
    expect(ids("shelf:most")).toEqual(["Waterloo", "Lose Yourself"]);
    expect(ids("shelf:never")).toEqual(["Africa", "Lithium", "99 Luftballons"]); // not the unfinished one
    expect(ids("shelf:recent")).toEqual(["Lithium"]);
  });
  it("singability and browse values", () => {
    expect(ids("sing:fast")).toEqual(["Waterloo", "Lose Yourself"]);
    expect(ids("sing:slow")).toEqual(["Africa", "Lithium"]);
    expect(ids("sing:short")).toEqual(["Waterloo"]);
    expect(ids("decade:1980")).toEqual(["Africa", "99 Luftballons"]);
    expect(ids("genre:rock")).toEqual(["Africa", "99 Luftballons"]);
    expect(ids("lang:de")).toEqual(["99 Luftballons"]);
    expect(ids("artist:abba")).toEqual(["Waterloo"]);
    expect(categoryFilter("c:4", ctx)).toBeNull();
  });
  it("lists browse values with counts, case-folded", () => {
    expect(facets(all, "decade").map((f) => `${f.label} ${f.count}`)).toEqual(["1970s 1", "1980s 2", "1990s 1", "2000s 1"]);
    expect(facets(all, "genre").find((f) => f.id === "genre:rock")?.count).toBe(2);
    expect(facets(all, "lang").map((f) => f.label)).toEqual(["English", "German"]);
    expect(decadeOf(1999)).toBe(1990);
    expect(decadeOf(null)).toBeNull();
  });
});

describe("group by", () => {
  it("orders groups, keeps row order inside, unknowns last", () => {
    const { rows, labelOf } = groupRows(all, "decade", ctx);
    expect(rows.map(labelOf)).toEqual(["1970s", "1980s", "1980s", "1990s", "2000s", "Unknown year"]);
    expect(rows.slice(1, 3).map((s) => s.title)).toEqual(["Africa", "99 Luftballons"]);
  });
  it("merges differently-cased genres under one header", () => {
    const { rows, labelOf } = groupRows(all, "genre", ctx);
    expect(rows.filter((s) => labelOf(s) === "Rock").map((s) => s.title)).toEqual(["Africa", "99 Luftballons"]);
  });
  it("pace groups run slow to fast", () => {
    const { rows, labelOf } = groupRows(all, "pace", ctx);
    expect([...new Set(rows.map(labelOf))]).toEqual(["Easy sing-alongs", "Moderate pace", "Fast lyrics", "Pace not measured"]);
  });
  it("none leaves rows alone", () => {
    expect(groupRows(all, "none", ctx).rows).toBe(all);
  });
});

describe("search", () => {
  const find = (q: string) => searchSongs(all, q, ctx).map((s) => s.title);
  it("still finds title and artist text", () => {
    expect(find("water")).toEqual(["Waterloo"]);
    expect(find("lose your")).toEqual(["Lose Yourself"]);
  });
  it("understands decades, genres, language, pace and history", () => {
    expect(find("80s")).toEqual(["Africa", "99 Luftballons"]);
    expect(find("1980s rock")).toEqual(["Africa", "99 Luftballons"]);
    expect(find("grunge")).toEqual(["Lithium"]);
    expect(find("german")).toEqual(["99 Luftballons"]);
    expect(find("fast lyrics")).toEqual(["Waterloo", "Lose Yourself"]);
    expect(find("never sung rock")).toEqual(["Africa", "Lithium", "99 Luftballons"]);
    expect(find("recently added")).toEqual(["Lithium"]);
    expect(find("abba 70s")).toEqual(["Waterloo"]);
  });
  it("empty search keeps everything", () => {
    expect(searchSongs(all, "  ", ctx)).toBe(all);
  });
});
