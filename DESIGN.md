---
name: Karascape
description: The karaoke machine as an 80s digital dashboard — every state a glowing instrument on smoked glass.
colors:
  ground: "#0b0d10"
  well: "#07090c"
  panel: "#10141a"
  panel-raised: "#161c24"
  panel-pressed: "#0d1116"
  line: "#232b36"
  line-strong: "#33404f"
  text: "#e9edf3"
  text-dim: "#96a1b4"
  text-faint: "#7e899c"
  cyan: "#45e0d8"
  cyan-dim: "#1d5f5c"
  cyan-bright: "#8ff2ec"
  cyan-wash: "rgba(69, 224, 216, 0.10)"
  cyan-glow: "rgba(69, 224, 216, 0.35)"
  amber: "#f2a33c"
  amber-dim: "#7a5220"
  amber-bright: "#ffc36b"
  amber-wash: "rgba(242, 163, 60, 0.12)"
  amber-glow: "rgba(242, 163, 60, 0.35)"
  green: "#49e57d"
  green-dim: "#1d5f38"
  green-bright: "#8df2ae"
  green-wash: "rgba(73, 229, 125, 0.10)"
  green-glow: "rgba(73, 229, 125, 0.35)"
  magenta: "#ee7fdb"
  magenta-dim: "#75285e"
  magenta-bright: "#f9b0e5"
  magenta-wash: "rgba(238, 127, 219, 0.10)"
  magenta-glow: "rgba(238, 127, 219, 0.35)"
  red: "#e8654f"
  red-dim: "#6e2418"
  red-deep: "#e8452c"
  red-wash: "rgba(232, 69, 44, 0.12)"
  red-glow: "rgba(232, 69, 44, 0.35)"
  ink: "#131007"
typography:
  display:
    fontFamily: "Barlow, Segoe UI, system-ui, sans-serif"
    fontSize: "clamp(34px, 4.6vw, 62px)"
    fontWeight: 700
    lineHeight: 1.25
  lyric-resting:
    fontFamily: "Barlow, Segoe UI, system-ui, sans-serif"
    fontSize: "clamp(22px, 2.6vw, 34px)"
    fontWeight: 600
  lyric-preview:
    fontFamily: "Barlow, Segoe UI, system-ui, sans-serif"
    fontSize: "30px"
    fontWeight: 700
  lyric-preview-next:
    fontFamily: "Barlow, Segoe UI, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 500
  celebrate:
    fontFamily: "Barlow, Segoe UI, system-ui, sans-serif"
    fontSize: "34px"
    fontWeight: 700
  cover-initials:
    fontFamily: "Barlow, Segoe UI, system-ui, sans-serif"
    fontSize: "38px"
    fontWeight: 700
  title:
    fontFamily: "Barlow, Segoe UI, system-ui, sans-serif"
    fontSize: "19px"
    fontWeight: 700
    letterSpacing: "0.14em"
  brand:
    fontFamily: "Barlow, Segoe UI, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 700
    letterSpacing: "0.14em"
  body:
    fontFamily: "Barlow, Segoe UI, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
  body-strong:
    fontFamily: "Barlow, Segoe UI, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 500
  body-secondary:
    fontFamily: "Barlow, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 500
  control:
    fontFamily: "Barlow, Segoe UI, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    letterSpacing: "0.05em"
  meta:
    fontFamily: "Barlow, Segoe UI, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
  label:
    fontFamily: "Barlow, Segoe UI, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    letterSpacing: "0.09em"
  micro:
    fontFamily: "Barlow, Segoe UI, system-ui, sans-serif"
    fontSize: "10px"
    fontWeight: 600
    letterSpacing: "0.05em"
  seg:
    fontFamily: "DSEG7, Barlow, sans-serif"
    fontWeight: 400
    letterSpacing: "0.06em"
rounded:
  lamp: "1px"
  micro: "2px"
  r: "3px"
  r-lg: "6px"
spacing:
  s1: "4px"
  s2: "8px"
  s3: "12px"
  s4: "16px"
  s5: "24px"
  s6: "32px"
  s7: "48px"
components:
  button-key:
    backgroundColor: "{colors.panel-raised}"
    textColor: "{colors.text}"
    typography: "{typography.control}"
    rounded: "{rounded.r}"
    padding: "9px 16px"
  button-key-hover:
    backgroundColor: "#1b2330"
    textColor: "{colors.text}"
  button-key-active:
    backgroundColor: "{colors.panel-pressed}"
  button-primary:
    backgroundColor: "{colors.amber}"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.r}"
    padding: "9px 16px"
  button-primary-hover:
    backgroundColor: "{colors.amber-bright}"
    textColor: "{colors.ink}"
  danger-key:
    backgroundColor: "{colors.red-deep}"
    textColor: "#ffffff"
    typography: "{typography.control}"
    rounded: "{rounded.r}"
    padding: "9px 16px"
  input-well:
    backgroundColor: "{colors.well}"
    textColor: "{colors.text}"
    rounded: "{rounded.r}"
    padding: "10px 12px"
  dash-popup:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.r}"
    padding: "5px"
  song-card:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.r}"
---

# Design System: Karascape

## Overview

**Creative North Star: "The Digital Dash"**

Karascape's UI is an 80s digital instrument cluster on smoked glass — the
karaoke machine as a night-mode cockpit, not a streaming app. It refuses the
streaming-app defaults (nav rail, cover grid, one decorative accent) and
replaces them with instrument grammar: silk-screened labels on bezel panels,
membrane keys with real travel, indicator lamps, segmented bar-graph meters,
recessed display wells, and VFD-style segment readouts. Every state in the
app is expressed as a glowing instrument: a lit lamp, a filled meter, a
readout. The whole cabin boots with a brief power-on flash (480ms
brightness/saturation settle), suppressed under `prefers-reduced-motion`.

Density is moderate and honest: real chrome (borders, inset shadows, seams)
rather than flat washes, but a strictly rationed light budget. Color is never
decoration — five glow families each carry one meaning, on a near-black
ground. Contrast is tuned for a TV at 3 meters (PRODUCT.md accessibility
commitments): every text step clears WCAG AA at its size, and the core
sung/unsung lyric mechanic never relies on hue alone.

**Key Characteristics:**
- Smoked-glass near-black ground (#0b0d10) with layered bezel panels and recessed wells
- Five-glow discipline: cyan = information, amber = live, green = done, magenta = celebrate, red = redline only
- Instrument chrome: lamps, segmented meters, faders, DSEG segment readouts
- Silk-screen typography: uppercase, tracked Barlow labels on the panel
- Angular, machined geometry — 3px corners, chamfered notches, square-capped icons
- Measured performance: the player's per-frame DOM contract is load-bearing (60fps spike)

**First viewport:** selector pod left with lamped nav; library display center —
silk-screened title, search well, cover grid; the primary action is the
amber-lit key.

**Provenance:** the Digital Dash direction is a user-steered re-roll of grounded
candidate 3 (Component Deck), seed `fe5a66cf`, locked 2026-08-05. Amplification
pass (five-glow palette, bar-graph-note brand mark, dashboard chrome pass)
approved by the owner 2026-08-05.

## Colors

A near-black smoked-glass neutral stack lit by five glow families, each with
a fixed meaning; washes and glows are the translucent halo steps of each
family. (Ratios below are standard WCAG 2.1 relative luminance.)

### Primary
- **VFD Cyan** (#45e0d8, 12.0:1 on ground): the information voice — selection
  states, links, focus rings, checked lamps, sung lyrics, clock/duration
  readouts. `cyan-bright` (#8ff2ec) is highlighted-item
  text; `cyan-dim` (#1d5f5c) is borders and quiet marks; `cyan-wash` is the
  selected-row fill; `cyan-glow` is the lamp/focus halo.

### Secondary
- **Live Amber** (#f2a33c, 9.3:1 on ground as text): whatever is live *right
  now* — the primary action key, the active nav lamp, the running stage,
  the active lyric word's wipe, playhead fills, the player clock. As a fill
  it takes dark ink (#131007), never light text. `amber-bright` (#ffc36b) is
  the hover step; `amber-dim`/`amber-wash`/`amber-glow` follow the family
  pattern.

### Tertiary
- **Signal Red** (#e8452c as `red-deep`): redline only — errors, destructive
  actions, failed jobs, clipping. `red-deep` is for fills and lamps, never
  body text; the readable text step is `red` (#e8654f, 5.9:1 on ground).

### Quaternary
- **VFD Green** (#49e57d, 11.9:1 on ground — luminance-matched to cyan so
  adjacent lamps and meter segments read evenly): done and success —
  completed stages and jobs, ready badges, the low range of any future
  green→amber→red meter ladder, and collection accents (the active
  collection is *your* named shelf). `green-bright` (#8df2ae) is highlighted
  text, `green-dim` (#1d5f38) borders and quiet marks; wash/glow follow the
  family pattern. Green states never ride hue alone — always paired with a
  label, lamp, or filled bar (deutan-safe next to cyan).

### Quinary
- **Magenta** (#ee7fdb, 8.1:1 on ground): celebrate and personality — the
  song-finished moment, the one-shot job-completion flare, the brand mark's
  voice, and the generated cover-art palette. The rarest glow in the cabin:
  it marks moments, never persistent state. `magenta-bright` (#f9b0e5),
  `magenta-dim` (#75285e), wash/glow follow the family pattern. Never white
  text on a magenta fill (2.4:1) — magenta fills take ink.

### Neutral
- **Ground** (#0b0d10): the cabin at night; the app background.
- **Well** (#07090c): recessed display wells — inputs, dropzone, preview stage, meters, the player stage.
- **Panel** (#10141a) / **Panel Raised** (#161c24) / **Panel Pressed** (#0d1116): bezel panels, raised keys and hover ground, key travel.
- **Line** (#232b36) / **Line Strong** (#33404f): panel seams; focused seams and hover edges.
- **Text** (#e9edf3, 15.9:1) / **Text Dim** (#96a1b4, 6.6:1) / **Text Faint** (#7e899c, 4.6:1 — AA at any size): the three text steps on ground.
- **Ink** (#131007): dark ink on amber fills.

### Named Rules
**The Five-Glow Rule.** Cyan carries information, amber carries what is live
right now, green carries done/success, magenta carries celebrate/personality,
red is redline only. A glow is never used outside its meaning — no decorative
accents, no sixth color. Green and magenta are additive and job-bound; the
original three meanings are untouched.

**The Dark-Ink Rule.** Every lit fill — amber, green, magenta — takes dark
ink (#131007); the family color as text sits only on the dark ground. Only
`red-deep` takes white. Never light text on an amber (2.6:1), green (1.6:1),
or magenta (2.4:1) fill.

**The Redline-Text Rule.** `red-deep` (#e8452c) is for lamps and fills;
running text in the red family uses `red` (#e8654f), the step that clears
contrast on ground.

## Typography

**UI/Lyric Font:** Barlow (with Segoe UI, system-ui fallback) — SIL OFL 1.1, self-hosted (latin + latin-ext), weights 400/500/600/700 + 400 italic.
**Instrument Font:** DSEG7 Classic / DSEG14 Classic — SIL OFL 1.1, self-hosted; digits and `: . -` readouts only (DSEG14 for alphanumeric readouts).

**Character:** Barlow is the silk-screen and the lyric voice — a plain-spoken
grotesque that turns industrial when uppercased and tracked. DSEG is the
machine's own voice: italic, tabular, segment-display numerals used strictly
as instrument chrome.

### Hierarchy
- **Display** (700, clamp(34px, 4.6vw, 62px), 1.25): the player's current
  lyric line — sized for couch distance. Resting lines are clamp(22px,
  2.6vw, 34px) at 600; review-preview lines are 30px/700.
- **Title** (700, 19px, 0.14em, uppercase): module titles (h1) silk-screened
  onto the panel with a seam rule below; the brand wordmark (17px) shares
  this voice.
- **Body** (400–500, 13–16px): default text is 16px; most component copy runs
  13–14px at weight 500–600. `.small` is 13px.
- **Control** (600, 13px, 0.05em, uppercase): the key voice — every button
  label, job headline, stage-pill label.
- **Label** (600, 11px, 0.09em, uppercase, text-dim): the silk-screened
  control label — field labels, popup group labels, sidebar footer.
- **Seg** (DSEG7 italic, tabular-nums, 0.06em): clocks, durations, queue
  positions, key/tempo readouts. Sized in context (10–15px observed).
- **Seg14** (DSEG14 upright, 0.08em): 4-character annunciator mnemonics
  only (STBY/RUN/RDY/ERR/OFF, PLAY/PAUS), 12–13px, voiced in the status
  family. Celebrate moments (34px/700 Barlow) voice in magenta.

### Named Rules
**The Instrument-Chrome Rule.** DSEG faces render digits, `: . -`, and
4-character machine mnemonics (SegWord annunciators) only — never lyric,
body, or label type. Real words belong to Barlow.

**The Silk-Screen Rule.** Anything printed "on the panel" (labels, module
titles, key caps, nav) is uppercase Barlow with tracking (0.05–0.14em);
conversational text (body copy, lyrics, song titles) keeps normal case.

## Layout

A fixed cockpit shell: a 232px selector pod (sidebar) on panel background
with a right seam, and a scrolling content panel. Pages center at max-width
880px (1140px for wide pages like the editor) with 32px top / 40px side /
64px bottom padding. The library adds a second 208px collection rail inside
the content area. Song cards form a `repeat(auto-fill, minmax(164px, 1fr))`
grid.

Spacing follows the 4px-based rhythm `4 / 8 / 12 / 16 / 24 / 32 / 48`
(`--s1`–`--s7`); component gaps sit at 8–16px, section gaps at 24–32px. The
full-screen player is a `position: fixed` overlay (z-index 100) with header /
lyric viewport / control console stacked vertically; the viewport is
vertically masked (transparent → solid 12%–82% → transparent) and lyric type
scales with the viewport via clamp.

Motion is quick and mechanical: 120ms (`--t-fast`) for key/lamp state, 240ms
(`--t-med`) reserved, 200–300ms for player line growth and chrome fades, all
on `cubic-bezier(0.16, 1, 0.3, 1)`. `prefers-reduced-motion` collapses every
transition and animation to 0.01ms.

## Elevation & Depth

Depth is physical, not tonal: real shadows with offset and blur carry the
bezel-and-well construction. Panels sit *up* (`0 2px 10px rgba(0,0,0,0.45)`),
popups pop (`0 10px 28px rgba(0,0,0,0.6), 0 2px 8px rgba(0,0,0,0.45)`), and
display wells sink *in* (`inset 0 2px 6px rgba(0,0,0,0.55)`). Pressed keys
travel with an inset shadow. Glows (`0 0 6–22px` in a family's glow color)
are **light, not elevation** — they mark a lit lamp, a focused well, an
active word, never height.

### Shadow Vocabulary
- **shadow-panel** (`0 2px 10px rgba(0, 0, 0, 0.45)`): resting bezel panels — sidebar, job cards.
- **shadow-pop** (`0 10px 28px rgba(0, 0, 0, 0.6), 0 2px 8px rgba(0, 0, 0, 0.45)`): floating chrome — dash popups, the player's advanced panel.
- **inset-well** (`inset 0 2px 6px rgba(0, 0, 0, 0.55)`): every recessed well — inputs, dropzone, fader track, seek bar, line tracks, preview stage.
- **key travel** (`inset 0 2px 4px rgba(0, 0, 0, 0.5)`): `button:active` press-in.
- **lamp/focus glow** (`0 0 6–12px var(--*-glow)`): lit lamps, focused inputs, selected chips — always in the meaning-correct family.

### Named Rules
**The Light-Is-Not-Height Rule.** Black shadows carry depth; colored glows
carry state. Never use a colored glow to fake elevation or a black shadow to
mark state.

## Shapes

Angular and machined. The world's corner is 3px (`--r`); outer bezels only
get 6px (`--r-lg`); micro-chrome (lamps, chips, fader parts, badges,
timebars) tightens to 2px or 1px. Nothing is a circle and nothing is a pill —
even indicator lamps are 7–8px *squares* at 1px radius. Chamfers are the
signature cut: the song-card cover clips a 14px corner notch
(`polygon(0 0, calc(100% - 14px) 0, 100% 14px, 100% 100%, 0 100%)` — the
cartridge notch), and a 10px two-corner chamfer polygon exists as the
`--chamfer` token for bezel use. Seams are 1px `line` borders; hover and
focus strengthen the seam (`line-strong`) before anything glows. Meters and
timebars are rectangles with segment gaps cut by repeating gradients.

## Components

### Keys (buttons)
- **Character:** membrane keys on the panel — they depress, they don't bounce.
- **Shape:** machined corner (3px); control voice (13px/600 uppercase, 0.05em).
- **Default key:** raised panel (#161c24) with a 1px line seam, 9px 16px padding. Hover strengthens seam and lightens to #1b2330; active presses in (#0d1116 + inset shadow). Disabled is 0.45 opacity.
- **Primary key (amber-lit):** amber fill, dark ink, soft amber shadow (`0 2px 10px rgba(242,163,60,0.25)`); hover steps to amber-bright. One per surface — it is the "what happens next" key (FIRST VIEWPORT contract).
- **Big key:** 15px/12px 26px for golden-path moments.
- **Danger key:** red-deep fill, white text — only inside a redline context (confirm strip).
- **Linkish:** underlined, normal-case text-dim text; hover to cyan. For de-emphasized escape hatches.

### Indicator Lamps
- **Style:** 7–8px squares (1px radius), unlit = well fill + line border; lit = family fill + family border + `0 0 6–8px` family glow.
- **Meaning:** amber lamp = the active source (nav) or running stage; cyan lamp = selected/checked; green lamp = done/success (completed stages); red lamp = the annunciator dot on error banners; magenta = the one-shot celebrate flare, never a steady lamp. Lamps are the app's state language — nav rows, menu items, select options, stage pills, and banners all carry one. On boot the nav lamps sweep amber once, top to bottom, with the power-on flash.

### Inputs / Fields
- **Style:** recessed wells — well fill, 1px line seam, 3px corner, `inset-well` shadow; placeholder in text-faint; labels are silk-screen labels above.
- **Focus:** cyan seam + `0 0 0 1px` cyan ring + 12px cyan glow (information family — you are pointing at it).
- **Checkboxes:** `accent-color: cyan`.

### Dash Popups (Select / Menu)
- **Style:** panel bezel with strong seam, 3px corner, `shadow-pop`, 5px padding; items are 13px rows with a lamp slot; highlighted = cyan wash + cyan-bright text; danger items = red text + red wash.
- **Select trigger:** a membrane key showing its value in cyan (normal case) with a solid triangle caret. Built on Base UI (MIT, §6 row) — behavior and keyboard from the primitive, every visible pixel from this system.

### Fader (slider)
- **Style:** the vocal-guide control — a 10px recessed track with amber fill, segment gaps cut by a repeating gradient (7px on / 2px gap), and a 10×22px rectangular fader cap with an amber grip line. 150px wide, 24px hit area.

### Segmented Meters
- **Style:** every progress readout is a segmented bar-graph: ground/well track, amber fill, and a repeating-gradient overlay cutting 2px gaps every 6–8px. Stage bars animate via `transform` scale (300ms); the player timebar fill mutates `width` directly. Completed states re-voice to green.

### SegText Readout
- **Style:** the VFD readout — DSEG7 italic digits with the signature unlit-segment ghost: a stacked `8`-shapes layer at 0.22 opacity behind the lit digits (inline-grid, both layers in the same cell). Used for the editor clock, queue positions, cover durations, and the library's odometer song count (green, leading zeros).
- **Constraint:** static DOM only — never inside the player's rAF-mutated spans (the ghost doubles DOM per digit).

### SegWord Annunciator
- **Style:** the 14-segment word readout (DSEG14, upright) with the same `~` all-segments ghost — short status words only: `STBY`/`RUN`/`RDY`/`ERR`/`OFF` on job cards, `PLAY`/`PAUS` in the player console, voiced in the status's glow family. Status is always triple-coded (word + family color + Barlow headline), never hue alone.
- **Constraint:** instrument chrome, not copy — the Instrument-Chrome Rule still gives every real word to Barlow; SegWord is capped at 4-character machine mnemonics. Same static-DOM rule as SegText.

### Song Cards (cartridges)
- **Style:** panel fill, line seam, 3px corner; square cover with the 14px chamfered cartridge notch (top-right); title 14px/600, artist 13px dim; duration as a cyan mini-readout on the cover. Generated fallback covers are deterministic hash gradients with a wide hue spread (+70°) at cassette-sleeve saturation — covers are **content** (the album-art zone) and exempt from the five-glow discipline.
- **Hover (openable):** cyan seam + `0 0 0 1px cyan-dim` ring + drop shadow.
- **Play key:** the amber-lit key rests visible on every ready card (bottom-left, amber icon on dark, amber-dim seam); hover/focus lights the seam and glow; direct hover fills solid amber with ink. The card menu key (top-right) appears on hover/focus only.
- **Processing cards:** a bottom gradient overlay with an amber processing headline and a live segmented meter.

### Annunciator Strips (banners / confirm)
- **Style:** wash-filled strips with a family lamp dot: red wash + red-dim seam for errors, cyan wash + cyan-dim seam for notices.
- **Confirm strip:** destructive confirms are an in-world red annunciator with its own keys (danger key + cancel), `role="alertdialog"`, Escape to cancel, initial focus on Cancel — replacing system dialogs.

### Icons
- **Grammar:** one grammar for the whole dash — 16×16 grid, 1.75 stroke, square caps, miter joins; angular instrument pictograms, not rounded consumer glyphs. Fill is reserved for the solid transport marks (play/pause), small square dot-clusters (dots, grip, queue lamps, jobs meters), and the brand mark; everything else is stroked. `currentColor` throughout.

### Brand Mark (the bar-graph note)
- **Mark:** an eighth note whose body is ascending VU segments — two segmented bars rising into a full-height solid stem carrying an angular flag. Reads as a note at a glance, as one of the app's own segmented meters up close. Solid fill, two variants: 16-grid (`IconBrandNote`, brand slot at 18px) and 32-grid (`IconBrandNoteLarge`, large renders like the 56px empty state — the 16-grid's 0.8px gaps blur upscaled).
- **Voice:** magenta with the family glow in the brand slot (personality is magenta's job); flares brighter once on boot. The mark is unique to the brand — nav and empty states that aren't the brand use their own icons (New Song is the cartridge-plus).

### Timeline Editor (the main editor)
- **Character:** the enthusiast's bench — one recessed track well per lyric
  line, each word a chip whose position and width are its true original-song
  timing. Timing truth is never distorted: a 60 ms word stays a narrow chip.
  Unreviewed songs open straight here (golden path step 4). Each row's time
  window is the line's extent padded 0.6 s and snapped outward to a
  whole-second grid (`lineWindow`), so dragging or nudging a line's edge
  words never re-maps the row under the pointer. Exactly one row shows the
  cyan playhead — the line being sung (the upcoming line during a gap);
  neighboring rows' overlapping windows never sweep parallel playheads.
- **Chips:** raised-panel chips on the well; selected = cyan seam ring +
  glow; unsung = amber wash; low-confidence = dashed seam; ad-lib = italic
  label. Drag moves the word, the right-edge handle (≤7px, shrinking with
  the chip so a draggable body always remains) stretches its end.
- **Overflow labels (DAW-style):** a chip never truncates its word — the
  label paints past the chip's right edge over the track, carrying a black
  legibility halo (`text-shadow` 0 1px 3px rgba(0,0,0,0.9) + 0 0 6px
  rgba(0,0,0,0.7) — legibility chrome, not elevation; Light-Is-Not-Height
  holds). Hover/drag lifts a chip (and its label) above its neighbors;
  selection lifts highest.
- **Text editing:** click = select + seek; double-click / Enter = inline
  retype in place (Tab commits and hops to the next word); Del removes
  (selection advances, so Del chains) and Alt+click erases any word
  outright; "+ Word" inserts into the gap after the selection. A whole
  line edits as one sentence via the row's hover EDIT key, Shift+Enter,
  or double-click on the track background — the sentence input fills the
  track well (lineEdit.ts LCS retiming).
- **Drag rewrap:** pulling a chip a row's height up/down turns the drag
  into a line-break move — up takes the chip and the words before it in
  its line onto the row above; down takes the chip and the rest of its
  line below (grabbing the last/first word merges whole rows). Timing is
  untouched; only line links move, renumbered canonically, one undo entry.
  While the gesture is vertical the chip ghosts (0.45, dashed) and the
  target row lights amber (amber-dim seam, amber wash, amber glow — the
  turn-signal voice: where the action goes live); returning to the home
  row resumes the time drag.
- **Timing tools:** arrows nudge ±10 ms (Shift ±100 ms); Ctrl+←/→ hops the
  selection word by word and Ctrl+↑/↓ line by line (anchored at the
  playhead when nothing is selected); clicking a track's background seeks
  to that time (play a line from just before its first word); per-line
  checkboxes select a contiguous range for "Re-align selection" (CTC
  re-pass spliced back as one undo entry); "Loop line" loops the selected
  word's line.
- **Console (sticky):** the toolbar (transport, source, Preview, undo/redo,
  Re-align, Save), global seek bar, and the editing key row — word keys
  (Retype / + Word / Remove), line keys (Edit line / Break here / Join up /
  Reflow lines), and exports with freshness badges — pin to the top of the
  scrollport on solid ground with a seam + panel shadow; the line tracks
  scroll beneath. Error/busy/confirm strips render inside the console so
  they are always visible.
- **Flow:** Save is the primary key (saving marks reviewed; Ctrl+S);
  "Preview" hops to the Review Bench for a karaoke-style check, saving
  first; dirty exits are guarded by a ConfirmStrip.

### Review Bench (karaoke preview + lyric console)
- **Character:** the playback check — words on the display glass are live
  instruments; the controls live on the console below, never floating on
  the glass. Big current line with prev/next context lines, couch-readable
  type. Reached from the Timeline Editor's "Preview" key or the detail
  page; fixes made while listening stay first-class.
- **Word states:** sung = cyan; active = the amber wipe (same fill-edge
  mechanic as the player); selected = cyan seam ring (information voice);
  low-confidence timing = dashed amber-dim underline ("look here first");
  unsung stays 0.55 italic. Click = select + seek to onset; double-click /
  Enter = inline retype (a well-styled input swapped in place, Tab commits
  and hops to the next word).
- **Cue puck:** an 8px amber square (1px radius — never a circle) riding
  above the lyric lines: rests on the word being sung, arcs (sine hop,
  0.18–0.6 s flight) to land exactly on the next onset — the "bouncing
  ball" that makes mistimed words visible. When the gap to the next onset
  is tighter than the minimum, the puck departs early through the previous
  word's tail rather than teleporting; rapid-fire chains cap the flight at
  the onset-to-onset interval (continuous motion). DOM-positioned per
  frame via transform/opacity only; hidden when paused.
- **Console bench row:** the Shift module (scope keys WORD | LINE |
  FROM HERE, chevron nudge keys ±10 ms / shift ±100 ms, DSEG offset
  readout showing the net shift since selection), word keys (Retype /
  + Word / Remove / Undo / Redo), line keys (Edit line / Break here /
  Join up / Reflow lines), and the edit-flow selector (LOOP LINE |
  PAUSE | ROLL — what playback does while typing; sticky preference).
- **Line editing:** "Edit line" (Shift+Enter) opens the whole line as one
  sentence input — LCS-matched words keep their timing and flags, a
  same-count replacement inherits the replaced words' timings 1:1, and
  changed runs divide their old span evenly. "Reflow lines" rebuilds every
  break from the song's own pauses (>0.8 s), terminal punctuation, and an
  8-word cap — the poetic karaoke line shape — and gives structure to maps
  that never had lines. All line ops renumber canonically (validator-safe)
  and take one undo entry.
- **Flow:** "Looks good" (the one amber key, chamfered) saves fixes +
  marks reviewed; "Timeline editor" is the linkish hop back to the main
  editor; dirty exits are guarded by a ConfirmStrip. Full keyboard: Space,
  arrows, Enter, Del, Ctrl+Z/Y.

### Full-Screen Player (signature)
- **Character:** the night-mode cockpit — a fixed overlay on the well, with the song cover blurred to a dim backdrop (blur 48px, brightness 0.22) under a radial scrim.
- **Lyrics:** centered lines in a masked viewport; current line grows to display size (clamp 34–62px); sung words glow cyan (`0 0 22px cyan-glow`), the active word carries an amber **wipe** — a `background-clip: text` gradient whose fill edge (`--wipe`) tracks the beat — and unsung words are 0.5 opacity italic. Position of the fill edge, luminance, and italics carry the state; hue never carries it alone.
- **Console:** a bottom gradient console with the segmented amber timebar, transport key, amber DSEG-voiced clock (with glow), the vocal-guide fader, and key/tempo stepper readouts (cyan value in a bezel). Chrome auto-hides (opacity fade + `cursor: none`); everything is keyboard-operable.
- **Named Rule — The Four-Hook Rule.** The player's per-frame mutation contract is load-bearing and measured (60fps spike): each frame may touch only (1) `transform` on `.pk-scroller`, (2) the `--wipe` CSS var on the active word, (3) `width` on `.pk-timebar-fill`, and (4) direct classNames on `.k-word`/`.pk-line`. No CSS transitions on those properties and no React renders may be added to those hooks.

### Deferred (open items, not yet built — do not treat absence as a rule)
- Live stem VU meters await level data from the audio engine (the natural home of the full green→amber→red ladder).
- App icon: `src-tauri/icons/*` is still an off-brand pink circle (`bundle.active: false`) — regenerate from `IconBrandNoteLarge` (magenta on ground, chamfered-square tile, no circle) when bundling turns on.
- Media-key handling in the player is deferred (PRODUCT.md commits to it).

## Do's and Don'ts

### Do:
- **Do** keep the Five-Glow Rule absolute: cyan = information/selection/sung, amber = live/active-now/primary action, green = done/success/collections, magenta = celebrate moments and brand personality, red = redline (errors, destructive) only.
- **Do** express state as instrument chrome — a lamp, a meter, a readout — before reaching for text or toasts; every meter gets segment gaps.
- **Do** put dark ink (#131007) on every lit fill — amber, green, magenta — and use `red` (#e8654f) not `red-deep` for red running text.
- **Do** keep exactly one amber-lit primary key per surface; secondary actions stay membrane-gray.
- **Do** keep the cyan `:focus-visible` outline (2px, offset 2px) and full keyboard operation on every new control; destructive confirms use the ConfirmStrip pattern, not `window.confirm`.
- **Do** carry sung/unsung lyric state through luminance, fill-edge position, and italics — never hue alone (`--text-faint` #7e899c is the AA floor for tertiary text).
- **Do** honor `prefers-reduced-motion`, keep state transitions at 120ms on the world's ease-out, and vendor any new font with its OFL text.

### Don't:
- **Don't** set words in DSEG — segment faces are instrument chrome for digits, `: . -`, and 4-character annunciator mnemonics only; lyrics, labels, and body copy are Barlow.
- **Don't** touch the player's per-frame path: no transitions, no React renders, and no new per-frame mutations beyond the Four-Hook contract; never place SegText (the ghost readout) inside the rAF-mutated spans.
- **Don't** introduce circles, pills, or corner radii beyond 6px — the world is angular (2–3px, 6px bezels, chamfered notches); icons keep square caps and miter joins.
- **Don't** glow decoratively, add a sixth accent family, or use a colored glow to imply elevation — black offset shadows carry depth. Green and magenta stay job-bound: green is done/success, magenta is celebrate/personality — neither ever restates cyan/amber/red's jobs.
- **Don't** add an npm package or font without its PLAN.md §6 licensing row; no CDN assets — everything ships self-hosted.
- **Don't** describe the product as "open source" in any UI copy — it is source-available (binding, PRODUCT.md).
