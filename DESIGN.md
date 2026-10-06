---
name: baritoad 98
description: The karaoke machine as a late-90s desktop program — bevelled silver chrome, navy title bars, menus for everything, and lyrics that stay big and smooth.
colors:
  face: "#c0c0c0"
  light: "#dfdfdf"
  highlight: "#ffffff"
  shadow: "#808080"
  dark: "#0a0a0a"
  window: "#ffffff"
  text: "#000000"
  text-disabled: "#808080"
  title: "#000080"
  title-fade: "#1084d0"
  title-inactive: "#808080"
  title-inactive-fade: "#b5b5b5"
  selection: "#000080"
  selection-text: "#ffffff"
  desktop: "#008080"
  tooltip: "#ffffe1"
  lcd: "#000000"
  lcd-ink: "#00ff40"
  lcd-ghost: "#0a2a12"
  ok: "#008000"
  check: "#ffff00"
  error: "#ff0000"
  wave: "#808080"
  wave-active: "#000080"
  playhead: "#ff0000"
  stage: "#000010"
  sung: "#00ffff"
typography:
  ui:
    fontFamily: "Pixel Operator, Tahoma, Microsoft Sans Serif, Barlow, sans-serif"
    fontSize: "16px"
    fontWeight: 400
  ui-bold:
    fontFamily: "Pixel Operator, Tahoma, Microsoft Sans Serif, Barlow, sans-serif"
    fontSize: "16px"
    fontWeight: 700
  lyric-stage:
    fontFamily: "Barlow, Segoe UI, system-ui, sans-serif"
    fontSize: "clamp(34px, 4.6vw, 62px)"
    fontWeight: 700
  lyric-editor:
    fontFamily: "Barlow, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 600
  lcd:
    fontFamily: "DSEG7 Classic, monospace"
    fontWeight: 400
rounded:
  none: "0px"
spacing:
  s1: "2px"
  s2: "4px"
  s3: "6px"
  s4: "8px"
  s5: "12px"
  s6: "16px"
components:
  button:
    backgroundColor: "{colors.face}"
    textColor: "{colors.text}"
    typography: "{typography.ui}"
    rounded: "{rounded.none}"
    padding: "0 10px"
  button-default:
    backgroundColor: "{colors.face}"
    textColor: "{colors.text}"
    typography: "{typography.ui}"
    rounded: "{rounded.none}"
    padding: "0 10px"
  field:
    backgroundColor: "{colors.window}"
    textColor: "{colors.text}"
    rounded: "{rounded.none}"
    padding: "3px 5px"
  title-bar:
    backgroundColor: "{colors.title}"
    textColor: "{colors.selection-text}"
    typography: "{typography.ui-bold}"
    rounded: "{rounded.none}"
    padding: "0 3px 0 4px"
  selection:
    backgroundColor: "{colors.selection}"
    textColor: "{colors.selection-text}"
  tooltip:
    backgroundColor: "{colors.tooltip}"
    textColor: "{colors.text}"
    padding: "2px 5px"
---

# Design System: baritoad 98

## Overview

**Creative North Star: "baritoad 98"**

baritoad looks and behaves like a well-made desktop program from 1998: a
silver window with a navy title bar, a menu bar that lists everything the
program can do, a flat toolbar for the common jobs, a tree and a list view for
the library, tabbed property sheets, wizards for multi-step jobs, message boxes
for the moments that need an answer, and a status bar that always says what's
going on. The joke is the costume; the craft is that it's a *good* 98 program —
keyboard-complete, discoverable through its menus, and honest about state.

The costume stops at the lyrics. Every place a singer reads words — the TV
stage, the Bench word chips, the Text view — uses big, smooth Barlow, never
the pixel face (lyrics must be legible from the couch, ~3 m).

Direction locked by the owner 2026-09-29 from the "Karascape 98" concept
canvas (the app was named Karascape until 2026-10-01); it replaces the Digital Dash (2026-08-05) and the hardware-panel chrome
(2026-09-03) in full.

**Key characteristics:**
- Silver `face` chrome with 2-px bevels made of stacked inset box-shadows — no images.
- Navy→blue title bars on active windows, grey on inactive ones; teal `desktop` only behind dialogs in previews.
- Pixel Operator for chrome; Barlow for lyrics; DSEG7 for time/key/tempo readouts in black LCD wells.
- Zero corner radius, zero transitions in chrome.
- In-house 16-px pixel icons; no Microsoft icons, logos, fonts, or the word "Windows" in UI copy.
- Two schemes: **Classic** (teal/silver) and **Night** (charcoal chrome, same geometry).

## Colors

The chrome palette is the classic 3-D face ramp plus a handful of job-bound
signals. Every colour below is a token in `apps/desktop/src/win98/tokens.css`;
Night overrides the same names under `:root[data-scheme="night"]`.

- **Face ramp** (`face`, `light`, `highlight`, `shadow`, `dark`): raised things are
  lit top-left (`highlight`/`light`) and shaded bottom-right (`shadow`/`dark`);
  sunken things invert it. Never flatten a control to a single border.
- **Title** (`title`→`title-fade`): the active window's caption. Inactive
  windows use the grey pair. Nothing else uses the title gradient.
- **Selection** (`selection` + `selection-text`): the one "chosen" colour —
  selected list rows, tree nodes, word chips, menu highlight. Keyboard focus is
  the dotted focus rectangle, never colour alone.
- **Signals**: `ok` green check (Ready), `check` yellow marker (Needs checking),
  `error` red (failures, destructive icons), `playhead` red.
  Each always pairs with an icon or text, never hue alone.
- **LCD**: black well, green ink, dim ghost `88:88` segments behind.
- **Stage** (`stage`, `sung`): the default TV theme — near-black with cyan
  sung words. Stage colours are user content (see Player Themes).

## Typography

- **Pixel Operator** (CC0, vendored) at its native 16-px grid for all chrome:
  menus, buttons, labels, lists, dialogs, status bars. Bold for title bars,
  default buttons and headings. The **Pixel font** setting swaps to the smooth
  stack (Tahoma → Microsoft Sans Serif → Barlow) for fractional-DPI screens
  where 1-px glyphs blur.
- **Barlow** (OFL) for every lyric surface. Every lyric word renders the same;
  there is no per-word confidence or "unsung" styling.
- **DSEG7 Classic** (OFL) for numeric readouts only (clock, key, tempo, wait
  seconds) — never words.
- Access keys are underlined in menus, buttons and labels (`&File`). In a dialog, Alt+letter — or the bare letter while one of its buttons has focus — presses that button, checkbox or label (win98/accessKeys.ts); the menu bar stands aside while the keyboard is in a dialog.

## Layout

- Every screen is a window: title bar → menu bar → toolbar → client area →
  status bar. The main window swaps its client area between **Library** and
  **Bench**; the **Stage** (TV player) is its own window.
- Controls sit on a 4-px rhythm; default button height 24 px (tool buttons 28 px).
- Dialogs: OK / Cancel / Apply bottom-right; wizards: < Back / Next > / Cancel.
- Group boxes (etched frame + caption) gather related controls; don't nest cards.

## Elevation & Depth

Depth is the bevel, nothing else: `--w-raised` (buttons, panels, headers),
`--w-sunken` (fields, lists, wells), `--w-pressed` (pushed/toggled buttons,
toggled state also gets the 2-px dither), `--w-etched` (group boxes,
separators), `--w-default` (the extra dark ring on the default button). No
drop shadows except the tooltip's 2-px offset.

## Shapes

Rectangles. Radius 0 everywhere except radio buttons (circles) and tab tops
(3 px). Icons are 16-px pixel art drawn as crisp SVG rects, shown at 1× or 2×.

## Components

All live in `apps/desktop/src/win98/`, behaviour from `@base-ui/react`
primitives, look from `base.css`:
AppFrame/TitleBar · MenuBar · ContextMenu · Toolbar/ToolButton · Button ·
GroupBox · TextField/TextArea · Select · Checkbox · RadioGroup · Trackbar ·
Spinner · ProgressBlocks · Tabs · ListView · TreeView · StatusBar · Tooltip ·
Dialog/PropertySheet · Wizard · MessageBox (`useMessageBox`) · Lcd · Well ·
Separator · icons.

- **Command tables**: each view lists its commands once (label with access key,
  accelerator, run, enabled/checked); menus, toolbar tooltips and status-bar
  hints read from it.
- **Show each command once.** The menu bar holds everything; the toolbar holds
  only a view's few frequent jobs; right-click menus and keys reach the rest.
  A work surface never repeats a menu item as a button, a side panel never
  restates the status-bar hints, and modes (nudge scope, save/check state)
  live in the status bar. Explanatory copy is said once, where it's needed
  — not on every screen (the "nothing is uploaded" promise lives in the
  Library status bar and About).
- **Message boxes** replace `window.confirm` and inline confirm strips:
  info/question/error icon, one sentence of what happened, one of what to do.

## Screens

- **Library** — tree (Library › All songs, collections; the **Most sung /
  Never sung / Recently added** shelves; **Browse** › Artists, Decades,
  Genres, Languages, Singability — collapsible branches with the [+]/[-] box
  on the dotted line, starting closed; Needs checking) + sortable list view
  (Title, Artist, Length, Status, Added, Last sung) — **View › Group by**
  (Artist / Decade / Genre / Language / Pace) splits it under bold, etched
  group headers with counts; picking a Browse branch lists every song grouped
  by it. Categories are derived from the rows (tags, UltraStar headers, play
  history, our own timings — never looked up); Singability's Easy sing-alongs
  / Fast lyrics are the slowest / fastest thirds of *this* library by words a
  minute while singing. The Find box also understands "80s", "rock", "german",
  "never sung", "fast lyrics". **Song › Properties…** (Alt+Enter) edits
  title, artist, year, genre and language and shows the measured facts. Up
  next group (Sing next + Remove; move/clear on its right-click menu) + status
  bar. Toolbar: Add song… | Sing · Up next · Check timing, then Find.
  Enter / double-click is the song's next step: Sing when Ready, Check timing
  when it needs checking, **Process again…** when it failed or needs lyrics
  (Song menu + right-click, and the failure message box — no toolbar button):
  the Add Song wizard reopened on the song's file with its details and last
  lyrics filled in, resuming in its job folder so the row updates in place.
  The "Add a song" drop box shows only while the
  library is empty; otherwise a dragged file gets a dithered "Let go" overlay.
  **Import Folder…** (File menu, Ctrl+Shift+O, the empty-library box, or a
  folder / several files dropped on the window) scans for songs, pairs each
  with its lyrics (`Song.txt`, `Song.lrc`, or an UltraStar file whose
  hand-made timings are kept and land checked), names collections after
  folders, and shows one review list (checkbox column, lyrics source,
  collection, already-in-library) before queueing. The queue survives a
  restart; the Processing dialog follows the batch (Skip this song / Cancel
  all), and one message box reports at the end — never one per song.
  Add Song is a two-page wizard (details → lyrics + Finish); processing is a
  modeless dialog with the step list and block progress bar.
- **Bench** — toolbar with Library, Save, LCD clock, transport, Loop,
  Vocal-guide trackbar, **Sing on TV** (default button); Text/Lanes tabs
  (the selected lane opens up for fine work and carries the one Hear button;
  there is no separate Focus view). Lanes are sunken tracks with waveform +
  raised Barlow word chips (selected = navy; no per-word confidence markers —
  pasted lyrics align cleanly and the markers read as noise; play state — now
  / sung — is colour only, every chip keeps the one raised frame, so rows
  don't appear to resize as the head passes). The Text view is just the
  lines, full width; verses are separated by a plain gap. Save stays lit
  while a song is unchecked — saving with no edits marks it checked. Status
  bar carries line/word timing, contextual key hints (F1 for all), the nudge
  scope (1 2 3) and save/check state.
- **Stage (TV player)** — separate window; full-bleed stage; chrome is a
  floating tool-window dock (auto-hides; no key-hint strip on the TV — keys
  are F1 and tooltips) plus "Now singing"/"Up next" captions. When the dock
  hides, the seek bar hides with it: only the lyrics stay on screen (owner
  decision 2026-10-05). Player Options holds the song's theme and the display;
  stretch quality and diagnostics are dev builds only.
- **Between songs** — when a song ends the Stage shows one centered card at
  couch size (pixel font at 3× for the title, 2× for the rest): who's next,
  their cover, and a DSEG countdown (Properties › Player: on by default, 10 s)
  with Sing now · Wait · Sing it again · Done (Enter · Space · — · Esc).
  Nothing queued: the same card says "That's the song!" until a song is
  queued, which starts a countdown. It belongs to the Stage, never a message
  box (a box would outlive the song). Party mode's join code will sit beside
  the card. A new song starts at key 0 and tempo 1; the vocal guide carries.
  Media keys work here (the OS media controls, media_keys.rs): Play/Pause,
  Next = the next song in Up next (Sing now between songs), Previous = start
  over; the OS "now playing" panel shows the song.
- **Up next** — Rust owns it and every change reaches both windows. The song
  on the Stage stays listed with ▶ until it's sung (then it leaves), so a
  restart mid-song still has it first. Songs drag in from the song list (a
  2-px insert line shows where); entries drag to reorder; Q and Alt+↑/↓ do
  the same from the keyboard. Collection › Add all / Shuffle into Up next
  queue a whole collection, skipping songs that aren't ready.
- **Properties** — tabbed property sheet (Appearance, Player, Processing). The
  Bench remembers its last view and nudge scope, so they aren't settings.
- **Player Themes** — display-properties-style dialog with a monitor preview.
- **Download the models** (first run) — the app waits behind it: no close
  box, Esc and clicks outside do nothing. "baritoad needs these models to
  work. They run on this computer and download once, 2.0 GB in all." Then the
  four models by name and maker (Demucs v4 · Meta, wav2vec 2.0 · Meta,
  Whisper small · OpenAI, Demucs v4, fine-tuned · Meta), each with what it
  does and its size. Download fetches them one at a time: the current one
  carries its own progress bar, the rest say Waiting, the button becomes
  Cancel. When all four are checked, Start lets you in. A failed download
  says why and Download picks up where it stopped.
- **Party** (Party › Start party…, docs/PARTY.md) — modeless: the join QR
  (crisp squares, quiet zone) and link with New code; the guests, each with
  their toad and Kick (asks first; kicking also changes the code); and a
  "What's shared" box saying plainly what goes to the relay and that music,
  lyrics and files never do. While a party is open the status bar says
  "Party open — sharing your song list and Up next" instead of "Local only".
  Up next gains a Singer column: the guest's toad (16-px face) and name.
  Between songs, the Stage puts a **Join the party** card beside the Up next
  card: the QR big enough to scan across the room, "Scan to join", the short
  link, and the next five with toads at 2× and names. The next singer's toad
  and name also show on the Up next card.
- **Models** (Tools › Models…) — modeless, the same list with each model's
  state (Downloaded / Older version, still works / Not downloaded), one line
  saying where they come from, Download or Update only when something needs
  it, and Close.

### Full-Screen Player (signature)
- **Lyrics:** centered lines in a masked viewport; every line lays out — and renders — at one constant size/weight/width, the display size (`clamp(35.2px, min(4.6vw, 8.2vh), 220px)`, 700, full width — it grows with the screen: ~59 px in a 720p window, ~88 px at 1080p, ~177 px on a 4K TV; owner, 2026-10-04). **Line state is luminance and color only — lines never transform.** **One row per lyric line:** lines never flex-wrap — a line wider than the viewport shrinks its layout size by a static per-line `--fit` factor (PlayerView `fitLines` → `lineFit`, computed at mount/resize, never per-frame); a rare line past the 0.55 fit floor keeps the floor size and wraps (`data-overlong`). Never animate font-size. Sung words take the theme's sung colour with its glow; the active word carries the **wipe** — a `background-clip: text` gradient whose fill edge (`--wipe`) tracks the beat. Position of the fill edge and luminance carry the state; hue never carries it alone. During a pause the finished word holds through the 0.25s grace, then the upcoming word's glow eases in (`--glow-in`) across the last 0.6s before its onset.
- **Karaoke pages** (owner, 2026-10-04 — replaced the smooth scroll): the stage shows up to **three lines** at a time, centered at ~45% height; the rest of the song's rows keep their layout but hide (`.pk-line.off`). A page turns — the scroller jumps, at once, no glide — when its last line is sung and the next line is ≤2 s away (`lineIndexAt`'s pre-roll); a wait row always starts a new page. Lines on the page: sung ones dim, the current one full, the coming ones 0.8. Logic in playerView.ts (`pagesOf`/`pageViewAt`).
- **Wait cues and lead-ins:** gaps ≥5 s get a wait row — a draining block meter and a whole-second DSEG7 readout in the theme accent — shown only while it counts, over the page it leads into; the line after one carries three square **lead-in pips** counting 3-2-1. A line after a shorter pause (≥1.5 s) gets the **lead-in bar** instead (owner, 2026-10-04 — a bouncing ball was tried and dropped): a cap-height bar in the theme accent with its glow that runs in from the left at the line's own singing pace (its words' width over their time) for up to 2 s, never longer than the pause, and meets the first word exactly as it starts — the meeting is the beat, and the wipe carries on from there (theme `leadBar`, on unless a theme turns it off). Logic in playerView.ts (`gapCues`/`leadInKinds`/`pipsLitAt`/`leadBarAt`). Every led-in line keeps a px gutter on both sides (clamp 48–128 px) and is fitted into what's inside it, so the pips and the bar's run stay on screen however wide the line (`.pk-line[data-cue]`; below 900 px wide the pips shrink to 12 px). Couch-sized (read from ~3 m): the wait word in the pixel font at an exact 2× (32 px), the readout 30 px, the meter 24 px tall — all doubled again (explicit sizes, never `zoom`, which skews the measured offsets) on a stage ≥2400 px wide, next to the bigger lyrics. The pips are sized in em (0.355 em squares, 22 px at 62 px text), so they grow with the lyrics. The Now singing / Up next captions stay 1× at every size (owner, 2026-10-04: they were too big at 2×).
- **Reduced motion** (`prefers-reduced-motion`): line and wait-row changes land at once (pages always turn at once), the approach glow doesn't fade in, the visualizer is off. The wipe and the lead-in bar stay — they are the timing.
- **Named Rule — The Four-Hook Rule.** The player's per-frame mutation contract is load-bearing and measured (60fps spike): each frame may touch only (1) `transform` on `.pk-scroller`, (2) the `--wipe`/`--wipe-n` CSS vars on the active word — or, in a pause when that hook is idle, `--glow-in` on the single word being approached — (3) `width` on `.pk-timebar-fill`, and (4) direct classNames on `.k-word`/`.pk-line`. No CSS transitions on those properties and no React renders may be added to those hooks. *Amended 2026-08-07 for the wait cues:* (5) `width` + whole-second `textContent` on the counting gap row's meter/readout and its `counting` class at gap boundaries, and (6) `data-lit` on the upcoming line's pip anchor, mutated only on count change. *Amended 2026-10-04 for karaoke pages:* hook (1) now changes only when a page turns, hook (4) re-classes only the lines of the page leaving and the page arriving, and (7) `transform` on `.pk-leadbar` — one write per frame while a lead-in runs — with its `data-on` and height set only when a run starts or ends. Any restyle of the stage must re-run the player measurement harness and report song length, hardware and frame-time numbers.

### Player Themes (user content zone)
- **Model:** a theme is data (src/themes.ts) — background spec (cover blur / flat color / imported image with blur+dim), lyric colors (resting / sung / accent), glow strength, font, pips toggle, lead-in bar toggle, visualizer mode — applied to the player stage as CSS vars (`--th-*`) plus a static background layer. Resolution: song pin → app default → built-in fallback. Stored in one localStorage blob; built-in presets are code. Background images are imported into `%LOCALAPPDATA%\baritoad\themes` and served as data URLs (CSP allows `data:` only).
- **Content exemption:** theme colors are user CONTENT inside the stage. The chrome around it (dock, captions, dialogs) stays baritoad 98.
- **Guardrails (code, not knobs):** text sizes are not themable; the editor shows a live WCAG AA contrast badge per text color.
- **Visualizer (Off | Pulse | Bars):** a canvas layer behind the lyrics driven by the instrumental's precomputed peak envelope sampled through the player clock. Off under `prefers-reduced-motion`. One bounded canvas draw per frame joins the hook set.

### Deferred
- Live stem VU meters await level data from the audio engine.
- ~~App icon (`src-tauri/icons/*`) regenerated from the pixel brand mark.~~ Done 2026-10-01: `pnpm icons` draws every size from the 16-px toad (`app` in win98/icons.tsx) at whole-pixel multiples, never smoothed.
- The toad appears only at 16 px — title bars and the Library root. Never scaled up: About, the wizard art, and message boxes don't carry it, and there is no full-body mascot in the app (owner, 2026-10-01). Party-mode exception (owner, 2026-10-01; docs/PARTY.md): guests' toads — the site's toad family, same 16×20 grid and palette — sit beside guest names on the Stage and in Up next, drawn at whole-pixel multiples, crisp, never smoothed, and never without the name.

## Do's and Don'ts

### Do:
- **Do** put every command in a menu, with its accelerator shown; toolbars and context menus are shortcuts to menu items, not the only way in.
- **Do** keep full keyboard operation: Alt/F10 menus, access keys, Tab order, Shift+F10 context menus, Esc closes dialogs, Enter hits the default button.
- **Do** use the dotted focus rectangle on every focusable control.
- **Do** pair every signal colour with an icon or text.
- **Do** use a message box when the user must answer; use the status bar for everything else.
- **Do** vendor any new font with its license text and add its row to docs/DEPENDENCIES.md in the same change.

### Don't:
- **Don't** set lyrics in the pixel font or in DSEG.
- **Don't** touch the player's per-frame path beyond the Four-Hook contract.
- **Don't** add corner radii, gradients (other than title bars), glows, or transitions to chrome.
- **Don't** use Microsoft's icons, logo, fonts, or the word "Windows" in UI copy — the look is an homage, drawn in-house.
- **Do** write the name **baritoad** in lowercase, everywhere — titles, menus, and the start of a sentence. Prefer wording where it doesn't open a sentence ("*Song* couldn't be finished.", not "baritoad couldn't finish *Song*.").
- **Do** call the app open source (GPL-3.0), and be plain that it's free with no account — party mode too, though it goes through our relay.
