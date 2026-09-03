// Themes — the player-theme editor (PLAN.md §3 player-themes amendment).
//
// Left: the theme rack (built-ins + your copies). Right: a live preview
// stage — literally the player's own CSS (the preview root carries
// .player-stage, un-fixed by .theme-preview) with a looping demo wipe and
// the visualizer drawing synthetic levels — above the knobs.
//
// Guardrails live here, not in the player: built-ins are immutable
// (duplicate to customize), text sizes are not knobs (couch-readable is a
// floor), unsung italics are untouched, and the contrast readout warns
// when a text color drops below WCAG AA against the background.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readThemeImage, themeImportImage } from "../api";
import {
  allThemes,
  backgroundProbeColor,
  contrastRatio,
  deleteTheme,
  duplicateTheme,
  loadThemeStore,
  saveThemeStore,
  themeById,
  themeCssVars,
  updateTheme,
  DIGITAL_DASH,
  type ThemeSpec,
  type ThemeStore,
  type VisualizerMode,
} from "../themes";
import { drawVisualizerFrame } from "../visualizer";
import { wipeFraction } from "../playerView";
import { ConfirmStrip, DashSlider } from "../ui";

// Demo line the preview wipes through, looped. Times are seconds into the
// loop; the trailing rest lets the "sung" state read before the reset.
const DEMO_WORDS: { word: string; start: number; end: number }[] = [
  { word: "We", start: 0.4, end: 0.85 },
  { word: "light", start: 0.95, end: 1.4 },
  { word: "the", start: 1.5, end: 1.8 },
  { word: "words", start: 1.9, end: 2.9 },
];
const DEMO_LOOP_S = 3.8;

// Synthetic envelope for the visualizer preview (100 bins/s, values ≤ 255).
const DEMO_PEAKS = Array.from({ length: 100 * 60 }, (_, i) =>
  Math.round(70 + 110 * Math.abs(Math.sin(i / 24)) + 55 * Math.abs(Math.sin(i / 7.3))),
);

function ContrastBadge(props: { label: string; fg: string; bg: string; large?: boolean }) {
  const ratio = contrastRatio(props.fg, props.bg);
  const floor = props.large ? 3 : 4.5;
  if (ratio == null) return null;
  const ok = ratio >= floor;
  return (
    <span
      className={`badge ${ok ? "fresh" : "bad"}`}
      title={`${props.label} vs background: ${ratio.toFixed(1)}:1 (${ok ? "clears" : "below"} the WCAG AA floor of ${floor}:1 at this size)`}
    >
      {ok ? `AA ${ratio.toFixed(1)}:1` : `low ${ratio.toFixed(1)}:1`}
    </span>
  );
}

export default function ThemesView() {
  const [store, setStore] = useState<ThemeStore>(loadThemeStore);
  const [selId, setSelId] = useState<string>(() => loadThemeStore().defaultId);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [imgError, setImgError] = useState<string | null>(null);
  const theme = themeById(store, selId) ?? DIGITAL_DASH;
  const editable = !theme.builtin;

  const commit = useCallback((next: ThemeStore) => {
    setStore(next);
    saveThemeStore(next);
  }, []);
  const patch = (changes: Partial<ThemeSpec>) => {
    if (!editable) return;
    commit(updateTheme(store, { ...theme, ...changes }));
  };

  // ---- preview background (image kind loads its data URL) ----
  const [bgUrl, setBgUrl] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    if (theme.background.kind === "image") {
      readThemeImage(theme.background.path)
        .then((u) => !disposed && setBgUrl(u))
        .catch(() => !disposed && setBgUrl(null));
    } else {
      setBgUrl(null);
    }
    return () => {
      disposed = true;
    };
  }, [theme.background]);

  // ---- the demo loop: real player CSS, fake clock ----
  const wordEls = useRef<(HTMLSpanElement | null)[]>([]);
  const visRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    let raf = 0;
    const t0 = performance.now();
    const visMode = theme.visualizer;
    const visColor = theme.accent;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const t = ((now - t0) / 1000) % DEMO_LOOP_S;
      DEMO_WORDS.forEach((w, i) => {
        const el = wordEls.current[i];
        if (!el) return;
        let cls = "k-word";
        if (t >= w.start && t < w.end) {
          cls += " active wipe";
          const f = wipeFraction(w, t);
          el.style.setProperty("--wipe", `${(f * 100).toFixed(1)}%`);
          el.style.setProperty("--wipe-n", (f * 100).toFixed(1));
          el.style.setProperty("--glow-in", "1");
        } else if (t >= w.end) {
          cls += " sung";
        }
        el.className = cls;
      });
      const c = visRef.current;
      if (c && visMode !== "off") {
        if (c.width !== c.clientWidth || c.height !== c.clientHeight) {
          c.width = c.clientWidth;
          c.height = c.clientHeight;
        }
        const ctx = c.getContext("2d");
        if (ctx) {
          drawVisualizerFrame(ctx, c.width, c.height, visMode, DEMO_PEAKS, 100, (now - t0) / 1000, visColor);
        }
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [theme.visualizer, theme.accent]);

  const pickImage = async () => {
    setImgError(null);
    const picked = await open({
      multiple: false,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "bmp", "webp"] }],
    });
    if (typeof picked !== "string") return;
    try {
      const stored = await themeImportImage(picked);
      patch({ background: { kind: "image", path: stored, blurPx: 0, dim: 0.55 } });
    } catch (e) {
      setImgError(String(e));
    }
  };

  const bg = theme.background;
  const probe = backgroundProbeColor(bg);
  const bgFilter =
    bg.kind === "color"
      ? undefined
      : `blur(${bg.blurPx}px) brightness(${Math.max(0, 1 - bg.dim).toFixed(2)})`;

  return (
    <div className="page page-wide themes-page">
      <h1>Themes</h1>
      <p className="muted">
        How the karaoke player looks — backgrounds, lyric colors, effects. The default applies to
        every song; any song can pin its own from the player&apos;s advanced panel.
      </p>

      <div className="themes-layout">
        {/* ---- the rack ---- */}
        <div className="theme-rack" role="listbox" aria-label="Themes">
          {allThemes(store).map((t) => (
            <button
              key={t.id}
              role="option"
              aria-selected={t.id === selId}
              className={`theme-row${t.id === selId ? " selected" : ""}`}
              onClick={() => setSelId(t.id)}
            >
              <span className="theme-chip" aria-hidden>
                <i style={{ background: backgroundProbeColor(t.background) }} />
                <i style={{ background: t.sung }} />
                <i style={{ background: t.accent }} />
              </span>
              <span className="theme-name">{t.name}</span>
              {t.id === store.defaultId && <span className="badge fresh">default</span>}
            </button>
          ))}
        </div>

        <div className="theme-main">
          {/* ---- live preview: the player's own CSS, un-fixed ---- */}
          <div
            className="player-stage theme-preview"
            style={themeCssVars(theme) as CSSProperties}
            aria-label="Theme preview"
          >
            {bg.kind === "color" ? (
              <div className="pk-backdrop flat" style={{ backgroundColor: bg.color }} aria-hidden />
            ) : bg.kind === "image" && bgUrl ? (
              <div
                className="pk-backdrop"
                style={{ backgroundImage: `url(${bgUrl})`, filter: bgFilter }}
                aria-hidden
              />
            ) : (
              // cover kind: no song here — a stand-in gradient wearing the
              // theme's blur/dim so the treatment still reads
              <div className="pk-backdrop theme-cover-standin" style={{ filter: bgFilter }} aria-hidden />
            )}
            <div className="pk-scrim" aria-hidden />
            {theme.visualizer !== "off" && <canvas className="pk-vis" ref={visRef} aria-hidden />}
            <div className="theme-preview-lines">
              <div className="pk-line">
                {["You", "bring", "the", "music"].map((w) => (
                  <span key={w} className="k-word sung">
                    {w}
                  </span>
                ))}
              </div>
              <div className="pk-line current">
                {theme.pips && (
                  <span className="pk-cue" data-lit="2" aria-hidden>
                    <span className="pk-cue-pips">
                      <i />
                      <i />
                      <i />
                    </span>
                  </span>
                )}
                {DEMO_WORDS.map((w, i) => (
                  <span
                    key={w.word}
                    className="k-word"
                    data-w={w.word}
                    ref={(el) => {
                      wordEls.current[i] = el;
                    }}
                  >
                    {w.word}
                  </span>
                ))}
              </div>
              <div className="pk-line">
                {["any", "song", "you", "own"].map((w) => (
                  <span key={w} className="k-word unsung">
                    {w}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* ---- actions ---- */}
          <div className="theme-actions">
            <button
              className={store.defaultId === theme.id ? "" : "primary"}
              disabled={store.defaultId === theme.id}
              onClick={() => commit({ ...store, defaultId: theme.id })}
            >
              {store.defaultId === theme.id ? "Default theme" : "Set as default"}
            </button>
            <button
              onClick={() => {
                const next = duplicateTheme(store, theme.id);
                if (next) {
                  commit(next);
                  setSelId(next.themes[next.themes.length - 1].id);
                }
              }}
              title="Copy this theme into an editable one"
            >
              Duplicate
            </button>
            {editable && (
              <input
                className="theme-rename"
                value={theme.name}
                aria-label="Theme name"
                onChange={(e) => patch({ name: e.target.value })}
              />
            )}
            {editable && (
              <button onClick={() => setConfirmDelete(true)}>Delete</button>
            )}
          </div>
          {confirmDelete && (
            <ConfirmStrip
              message={`Delete the theme "${theme.name}"? Songs pinned to it fall back to the default.`}
              confirmLabel="Delete"
              onConfirm={() => {
                setConfirmDelete(false);
                const next = deleteTheme(store, theme.id);
                commit(next);
                setSelId(next.defaultId);
              }}
              onCancel={() => setConfirmDelete(false)}
            />
          )}

          {!editable && (
            <p className="muted small">
              Built-in theme — <strong>Duplicate</strong> it to customize. Unsung words always stay
              italic and dimmed, so the sung/unsung read never relies on color alone.
            </p>
          )}

          {/* ---- knobs ---- */}
          <div className={`theme-knobs${editable ? "" : " disabled"}`}>
            <div className="knob-row">
              <span className="label">Background</span>
              <div className="scope-toggle" role="group" aria-label="Background kind">
                <button
                  className={bg.kind === "cover" ? "active" : ""}
                  disabled={!editable}
                  onClick={() => patch({ background: { kind: "cover", blurPx: 48, dim: 0.78 } })}
                  title="The song's own cover art, blurred"
                >
                  Cover art
                </button>
                <button
                  className={bg.kind === "color" ? "active" : ""}
                  disabled={!editable}
                  onClick={() =>
                    patch({
                      background: { kind: "color", color: bg.kind === "color" ? bg.color : "#0b0d10" },
                    })
                  }
                >
                  Color
                </button>
                <button
                  className={bg.kind === "image" ? "active" : ""}
                  disabled={!editable}
                  onClick={pickImage}
                  title="Pick a picture — it's copied into the app, the original can move"
                >
                  {bg.kind === "image" ? "Image…" : "Image…"}
                </button>
              </div>
              {bg.kind === "color" && (
                <input
                  type="color"
                  className="color-key"
                  value={bg.color}
                  disabled={!editable}
                  aria-label="Background color"
                  onChange={(e) => patch({ background: { kind: "color", color: e.target.value } })}
                />
              )}
              {bg.kind !== "color" && (
                <>
                  <span className="label">Blur</span>
                  <DashSlider
                    ariaLabel="Background blur"
                    min={0}
                    max={64}
                    step={4}
                    value={bg.blurPx}
                    disabled={!editable}
                    onChange={(v) => patch({ background: { ...bg, blurPx: v } })}
                  />
                  <span className="label">Dim</span>
                  <DashSlider
                    ariaLabel="Background dim"
                    min={0}
                    max={95}
                    step={5}
                    value={Math.round(bg.dim * 100)}
                    disabled={!editable}
                    onChange={(v) => patch({ background: { ...bg, dim: v / 100 } })}
                  />
                </>
              )}
            </div>
            {imgError && <div className="error-banner">{imgError}</div>}

            <div className="knob-row">
              <span className="label">Lyrics</span>
              <input
                type="color"
                className="color-key"
                value={theme.resting}
                disabled={!editable}
                aria-label="Resting text color"
                title="Words not yet sung"
                onChange={(e) => patch({ resting: e.target.value })}
              />
              <ContrastBadge label="Resting text" fg={theme.resting} bg={probe} large />
              <span className="label">Sung</span>
              <input
                type="color"
                className="color-key"
                value={theme.sung}
                disabled={!editable}
                aria-label="Sung text color"
                title="Sung words, the wipe fill, and the glow"
                onChange={(e) => patch({ sung: e.target.value })}
              />
              <ContrastBadge label="Sung text" fg={theme.sung} bg={probe} large />
              <span className="label">Accent</span>
              <input
                type="color"
                className="color-key"
                value={theme.accent}
                disabled={!editable}
                aria-label="Accent color"
                title="Countdown pips, wait meter, visualizer"
                onChange={(e) => patch({ accent: e.target.value })}
              />
            </div>

            <div className="knob-row">
              <span className="label">Glow</span>
              <DashSlider
                ariaLabel="Glow strength"
                min={0}
                max={150}
                step={10}
                value={Math.round(theme.glow * 100)}
                disabled={!editable}
                onChange={(v) => patch({ glow: v / 100 })}
              />
              <span className="label">Pips</span>
              <div className="scope-toggle" role="group" aria-label="Lead-in countdown pips">
                <button
                  className={theme.pips ? "active" : ""}
                  disabled={!editable}
                  onClick={() => patch({ pips: true })}
                >
                  On
                </button>
                <button
                  className={!theme.pips ? "active" : ""}
                  disabled={!editable}
                  onClick={() => patch({ pips: false })}
                >
                  Off
                </button>
              </div>
              <span className="label">Visualizer</span>
              <div className="scope-toggle" role="group" aria-label="Visualizer">
                {(["off", "pulse", "bars"] as VisualizerMode[]).map((m) => (
                  <button
                    key={m}
                    className={theme.visualizer === m ? "active" : ""}
                    disabled={!editable}
                    onClick={() => patch({ visualizer: m })}
                  >
                    {m === "off" ? "Off" : m === "pulse" ? "Pulse" : "Bars"}
                  </button>
                ))}
              </div>
            </div>

            <div className="knob-row">
              <span className="label">Font</span>
              <input
                className="theme-font"
                placeholder="Barlow (app default)"
                value={theme.font ?? ""}
                disabled={!editable}
                aria-label="Lyric font family"
                title="Any font installed on this machine, by name — unknown names fall back to Barlow"
                onChange={(e) => patch({ font: e.target.value.trim() === "" ? null : e.target.value })}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
