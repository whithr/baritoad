// The guest page (docs/PARTY.md): make your toad → pick a song → you're in
// line. Talks only to this relay, over the socket at /g/ROOM/KEY; it never
// sees the host's files, audio or lyrics. Song titles and other guests' names
// come from other people, so every bit of text goes in with textContent.

import { COLOURS, COLOUR_HEX, DEFAULT_TOAD, FACES, HATS, isToad, toadSvg, type Toad } from "../../../../apps/desktop/src/party/toads";
import type { GuestDown, GuestEntry, GuestUp, ListedSong, RefuseCode } from "../shared";

const NAME_MAX = 14;
const [, , room, key] = location.pathname.split("/");
const STORE = `baritoad-guest:${room}`;

type View = "toad" | "songs" | "line" | "bye";
const S = {
  view: "toad" as View,
  guest: undefined as string | undefined,
  name: "",
  toad: { ...DEFAULT_TOAD } as Toad,
  songs: [] as ListedSong[],
  entries: [] as GuestEntry[],
  nowPlaying: undefined as string | undefined,
  hostHere: true,
  connected: false,
  joined: false,
  query: "",
  collection: "",
  chosen: null as string | null,
  notice: null as string | null,
  bye: null as Extract<GuestDown, { t: "bye" }>["why"] | null,
};

// ---------------------------------------------------------------- storage

try {
  const saved = JSON.parse(localStorage.getItem(STORE) ?? "null");
  if (saved && typeof saved.name === "string") S.name = saved.name.slice(0, NAME_MAX);
  if (saved && isToad(saved.toad)) S.toad = saved.toad;
  if (saved && typeof saved.guest === "string") S.guest = saved.guest;
} catch {
  // private mode: start fresh
}
const remember = () => {
  try {
    localStorage.setItem(STORE, JSON.stringify({ guest: S.guest, name: S.name, toad: S.toad }));
  } catch {
    // private mode
  }
};

// ---------------------------------------------------------------- socket

let ws: WebSocket | null = null;
let retry = 0;
function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/g/${room}/${key}`);
  ws.onopen = () => {
    retry = 0;
    S.connected = true;
    // Back after a reload or a dropped connection: rejoin as the same guest.
    if (S.joined || S.guest) send({ t: "join", name: S.name, toad: S.toad, guest: S.guest });
    render();
  };
  ws.onmessage = (e) => {
    let m: GuestDown;
    try {
      m = JSON.parse(String(e.data));
    } catch {
      return;
    }
    receive(m);
  };
  ws.onclose = () => {
    S.connected = false;
    if (S.bye) return;
    render();
    retry = Math.min(retry + 1, 6);
    setTimeout(connect, 500 * 2 ** retry);
  };
}
const send = (m: GuestUp) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));

const REFUSED: Record<RefuseCode, string> = {
  limit: "you've got two songs waiting already — sing one first.",
  unknown_song: "that song isn't in the list any more.",
  not_ready: "that song can't be sung right now.",
  host_away: "the host's computer is away — try again in a moment.",
  not_joined: "make your toad first.",
};

function receive(m: GuestDown) {
  switch (m.t) {
    case "welcome":
      S.guest = m.guest;
      S.name = m.name;
      S.toad = m.toad;
      S.songs = m.songs;
      S.entries = m.entries;
      S.nowPlaying = m.nowPlaying;
      S.hostHere = m.hostHere;
      S.joined = true;
      remember();
      if (S.view === "toad") S.view = mine().length ? "line" : "songs";
      break;
    case "listing":
      S.songs = m.songs;
      break;
    case "queue":
      S.entries = m.entries;
      S.nowPlaying = m.nowPlaying;
      break;
    case "picked":
      if (m.ok) {
        S.view = "line";
        S.chosen = null;
        S.notice = null;
      } else {
        S.notice = REFUSED[m.code ?? "unknown_song"] ?? "that didn't work.";
      }
      break;
    case "host":
      S.hostHere = m.here;
      break;
    case "bye":
      S.bye = m.why;
      S.view = "bye";
      if (m.why === "invalid") {
        S.bye = null;
        S.view = "toad";
        S.notice = "pick a name and a toad first.";
      }
      break;
  }
  render();
}

// ---------------------------------------------------------------- helpers

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") el.className = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of kids) if (c != null && c !== false) el.append(typeof c === "string" ? document.createTextNode(c) : c);
  return el;
}
/** A toad from the fixed grids (no outside text), as an SVG element. */
function toadEl(t: Toad, scale: number, full = true): Element {
  const box = document.createElement("span");
  box.innerHTML = toadSvg(t, scale, full);
  const svg = box.firstElementChild!;
  svg.setAttribute("aria-hidden", "true");
  return svg;
}
const fmt = (s?: number) => (s == null ? "" : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);
const songOf = (id: string) => S.songs.find((s) => s.id === id);
const waiting = () => S.entries.filter((e) => e.id !== S.nowPlaying);
const mine = () => S.entries.filter((e) => e.mine);
const app = document.getElementById("app")!;

// ---------------------------------------------------------------- views

function render() {
  const bar = document.getElementById("bar-toad");
  bar?.replaceChildren(toadEl(S.toad, 1, false));
  const focused = document.activeElement?.id;
  const caret = (document.activeElement as HTMLInputElement | null)?.selectionStart ?? null;
  app.replaceChildren(...view().filter((c): c is Node | string => c != null && c !== false));
  if (focused) {
    const el = document.getElementById(focused) as HTMLInputElement | null;
    el?.focus();
    if (el && caret != null && "setSelectionRange" in el) el.setSelectionRange(caret, caret);
  }
}

function status(): Child {
  if (!S.connected) return h("div", { class: "note", role: "status" }, "reconnecting…");
  if (!S.hostHere) return h("div", { class: "note", role: "status" }, "the host's computer is away. hang on — your spot is saved.");
  return null;
}

function view(): Child[] {
  if (S.view === "bye") return bye();
  if (S.view === "toad") return toadView();
  if (S.view === "songs") return songsView();
  return lineView();
}

function toadView(): Child[] {
  const ready = S.name.trim().length > 0;
  const pickRow = <T extends string>(label: string, items: readonly T[], current: T, show: (v: T) => Child, set: (v: T) => void) =>
    h(
      "div",
      {},
      h("label", { id: `l-${label}` }, label),
      h(
        "div",
        { class: "picker", role: "radiogroup", "aria-labelledby": `l-${label}` },
        ...items.map((v) =>
          h(
            "button",
            {
              type: "button",
              role: "radio",
              "aria-checked": String(v === current),
              "aria-label": v,
              onclick: () => {
                set(v);
                render();
              },
            },
            show(v),
          ),
        ),
      ),
    );
  return [
    h("h1", {}, "make your toad"),
    status(),
    h("div", { class: "preview" }, toadEl(S.toad, 6), h("span", { class: "tag" }, S.name.trim() || "you")),
    h(
      "div",
      {},
      h("label", { for: "name" }, "your name"),
      h("input", {
        id: "name",
        class: "field",
        maxlength: NAME_MAX,
        autocomplete: "nickname",
        enterkeyhint: "next",
        value: S.name,
        oninput: (e: Event) => {
          S.name = (e.target as HTMLInputElement).value.slice(0, NAME_MAX);
          render();
        },
      }),
    ),
    pickRow("face", FACES, S.toad.face, (f) => toadEl({ ...S.toad, face: f, hat: "none" }, 2, false), (f) => (S.toad = { ...S.toad, face: f })),
    pickRow(
      "colour",
      COLOURS,
      S.toad.colour,
      (c) => h("span", { class: "swatch", style: `background:${COLOUR_HEX[c][0]}` }),
      (c) => (S.toad = { ...S.toad, colour: c }),
    ),
    pickRow(
      "hat",
      HATS,
      S.toad.hat,
      (x) => (x === "none" ? "none" : toadEl({ ...S.toad, face: "smile", hat: x }, 2)),
      (x) => (S.toad = { ...S.toad, hat: x }),
    ),
    S.notice && h("div", { class: "note", role: "alert" }, S.notice),
    h(
      "div",
      { class: "row end" },
      h(
        "button",
        {
          type: "button",
          class: "primary",
          disabled: !ready || !S.connected,
          onclick: () => {
            S.notice = null;
            remember();
            send({ t: "join", name: S.name, toad: S.toad, guest: S.guest });
          },
        },
        S.joined ? "done →" : "pick a song →",
      ),
    ),
  ];
}

function songsView(): Child[] {
  const q = S.query.trim().toLowerCase();
  const collections = [...new Set(S.songs.flatMap((s) => s.collections))].sort((a, b) => a.localeCompare(b));
  const shown = S.songs.filter(
    (s) =>
      (!S.collection || s.collections.includes(S.collection)) &&
      (!q || s.title.toLowerCase().includes(q) || (s.artist ?? "").toLowerCase().includes(q)),
  );
  const full = mine().length >= 2;
  return [
    h("h1", {}, "pick a song"),
    status(),
    full && h("div", { class: "note" }, "you've got two songs waiting — pick another after you sing."),
    h("input", {
      id: "search",
      class: "field",
      type: "search",
      placeholder: "search songs or artists",
      "aria-label": "search songs or artists",
      value: S.query,
      oninput: (e: Event) => {
        S.query = (e.target as HTMLInputElement).value;
        render();
      },
    }),
    collections.length > 0 &&
      h(
        "div",
        { class: "chips", role: "group", "aria-label": "collections" },
        h("button", { type: "button", "aria-pressed": String(!S.collection), onclick: () => ((S.collection = ""), render()) }, "all songs"),
        ...collections.map((c) =>
          h("button", { type: "button", "aria-pressed": String(S.collection === c), onclick: () => ((S.collection = S.collection === c ? "" : c), render()) }, c),
        ),
      ),
    h(
      "div",
      { class: "sunken" },
      shown.length === 0
        ? h("p", { class: "muted", style: "padding:8px" }, S.songs.length ? "nothing matches." : "the host's song list is on its way…")
        : h(
            "ul",
            { class: "list", "aria-label": "songs" },
            ...shown.map((s) =>
              h(
                "li",
                {
                  class: S.chosen === s.id ? "pick on" : "pick",
                  role: "button",
                  tabindex: 0,
                  "aria-pressed": String(S.chosen === s.id),
                  onclick: () => {
                    S.chosen = S.chosen === s.id ? null : s.id;
                    S.notice = null;
                    render();
                  },
                },
                h("div", { class: "grow" }, h("div", { class: "t" }, s.title), h("div", { class: "a muted" }, s.artist ?? "")),
                h("span", { class: "muted" }, fmt(s.duration)),
              ),
            ),
          ),
    ),
    S.notice && h("div", { class: "note", role: "alert" }, S.notice),
    h(
      "div",
      { class: "row end" },
      mine().length > 0 && h("button", { type: "button", onclick: () => ((S.view = "line"), (S.chosen = null), render()) }, "← back"),
      h("button", { type: "button", onclick: () => ((S.view = "toad"), render()) }, "my toad"),
      h(
        "button",
        {
          type: "button",
          class: "primary",
          disabled: !S.chosen || full || !S.connected,
          onclick: () => S.chosen && send({ t: "pick", song: S.chosen }),
        },
        "sing it",
      ),
    ),
  ];
}

function lineView(): Child[] {
  const list = waiting();
  const firstMine = list.findIndex((e) => e.mine);
  const nowEntry = S.entries.find((e) => e.id === S.nowPlaying);
  const now = nowEntry ? songOf(nowEntry.song) : undefined;
  return [
    h("h1", {}, mine().length ? "you're in line!" : "you're not in line"),
    status(),
    mine().length > 0 &&
      h(
        "div",
        { class: "row" },
        h("span", { class: "big" }, nowEntry?.mine ? "now" : `#${firstMine + 1}`),
        h("p", {}, nowEntry?.mine ? "it's your turn — look at the tv." : "look at the tv."),
      ),
    now && h("p", { class: "muted" }, "now singing: ", h("b", {}, now.title), nowEntry?.singer ? ` — ${nowEntry.singer}` : ""),
    h(
      "div",
      { class: "sunken" },
      list.length === 0
        ? h("p", { class: "muted", style: "padding:8px" }, "nobody's waiting.")
        : h(
            "ol",
            { class: "list", "aria-label": "up next" },
            ...list.map((e, i) => {
              const s = songOf(e.song);
              return h(
                "li",
                { class: e.mine ? "on" : "" },
                h("span", { class: "num" }, String(i + 1)),
                e.toad ? toadEl(e.toad, 2, false) : h("span", { style: "width:32px" }),
                h(
                  "div",
                  { class: "grow" },
                  h("div", { class: "t" }, s?.title ?? "a song"),
                  h("div", { class: "a muted" }, e.singer ? e.singer : "the host"),
                ),
                e.mine && h("button", { type: "button", onclick: () => send({ t: "withdraw", entry: e.id }) }, "take back"),
              );
            }),
          ),
    ),
    h(
      "div",
      { class: "row end" },
      h(
        "button",
        {
          type: "button",
          onclick: () => {
            for (const e of mine()) send({ t: "withdraw", entry: e.id });
            S.view = "toad";
            render();
          },
        },
        "start over",
      ),
      h("button", { type: "button", class: "primary", disabled: mine().length >= 2, onclick: () => ((S.view = "songs"), render()) }, "pick a song"),
    ),
  ];
}

function bye(): Child[] {
  const text: Record<string, [string, string]> = {
    closed: ["the party's over", "thanks for singing!"],
    kicked: ["you're out of this party", "the host took you off the list."],
    gone: ["this party link doesn't work", "the party ended, or the host made a new code. ask them for the new one."],
    full: ["this party is full", "ask the host to make room."],
  };
  const [title, body] = text[S.bye ?? "gone"] ?? text.gone;
  return [h("h1", {}, title), toadEl({ ...S.toad, face: S.bye === "closed" ? "sleepy" : "sad" }, 4), h("p", {}, body)];
}

render();
connect();
