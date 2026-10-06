// Player Themes — the stage-theme editor, as a display-properties-style
// dialog (DESIGN.md Player Themes).
//
// A monitor preview runs the stage's own CSS (win98/stage.css) with a looping
// demo wipe and synthetic visualizer levels; the theme list sits beside it;
// the controls are three tabs. Edits go to a draft — OK / Apply write it
// (merged with pins the stage made meanwhile), Cancel drops it.
//
// Guardrails live here, not in the player: built-ins are immutable
// (duplicate to customize), text sizes are not knobs (couch-readable is a
// floor), and each text colour shows its contrast against the background.

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readThemeImage, themeImportImage } from "../api";
import { wipeFraction } from "../playerView";
import { publishPrefs } from "../prefsSync";
import {
  allThemes,
  backgroundProbeColor,
  contrastRatio,
  DEFAULT_THEME,
  deleteTheme,
  duplicateTheme,
  loadThemeStore,
  mergeThemeDraft,
  saveThemeStore,
  THEME_STORE_KEY,
  themeById,
  themeCssVars,
  updateTheme,
  type ThemeSpec,
  type ThemeStore,
  type VisualizerMode,
} from "../themes";
import { drawVisualizerFrame } from "../visualizer";
import {
  Button,
  Checkbox,
  Dialog,
  DialogButtons,
  Icon,
  ListView,
  RadioGroup,
  Tabs,
  TextField,
  Trackbar,
  useMessageBox,
  usePrompt,
} from "../win98";
import "../win98/stage.css";

// Demo line the preview wipes through, looped (seconds into the loop).
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

function Contrast(props: { label: string; fg: string; bg: string }) {
  const ratio = contrastRatio(props.fg, props.bg);
  if (ratio == null) return null;
  // lyric text is large (≥24 px) — AA for large text is 3:1
  const ok = ratio >= 3;
  return (
    <span
      style={{ display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}
      title={`${props.label} vs background: ${ratio.toFixed(1)}:1 (${ok ? "clears" : "below"} the WCAG AA floor of 3:1 for large text)`}
    >
      <Icon name={ok ? "ready" : "warn"} />
      {ok ? "AA" : "Low"} {ratio.toFixed(1)}:1
    </span>
  );
}

function ColorField(props: { value: string; onChange: (v: string) => void; label: string; disabled?: boolean }) {
  return (
    <input
      type="color"
      className="w-field"
      style={{ width: 52, height: 24, padding: 2, cursor: props.disabled ? "default" : "pointer" }}
      value={props.value}
      disabled={props.disabled}
      aria-label={props.label}
      onChange={(e) => props.onChange(e.target.value)}
    />
  );
}

export default function PlayerThemes(props: { open: boolean; onClose: () => void }) {
  const ask = useMessageBox();
  const prompt = usePrompt();
  const [draft, setDraft] = useState<ThemeStore>(loadThemeStore);
  const [dirty, setDirty] = useState(false);
  const [selId, setSelId] = useState<string>(() => loadThemeStore().defaultId);
  const [tab, setTab] = useState<"background" | "lyrics" | "effects">("background");
  const [imgError, setImgError] = useState<string | null>(null);

  // fresh draft every time the dialog opens
  useEffect(() => {
    if (!props.open) return;
    const s = loadThemeStore();
    setDraft(s);
    setDirty(false);
    setSelId(s.defaultId);
    setImgError(null);
  }, [props.open]);

  const theme = themeById(draft, selId) ?? DEFAULT_THEME;
  const editable = !theme.builtin;
  const edit = (next: ThemeStore) => {
    setDraft(next);
    setDirty(true);
  };
  const patch = (changes: Partial<ThemeSpec>) => {
    if (editable) edit(updateTheme(draft, { ...theme, ...changes }));
  };
  const apply = () => {
    const merged = mergeThemeDraft(loadThemeStore(), draft);
    saveThemeStore(merged);
    publishPrefs(THEME_STORE_KEY, JSON.stringify(merged));
    setDraft(merged);
    setDirty(false);
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

  // ---- the demo loop: real stage CSS, fake clock ----
  const wordEls = useRef<(HTMLSpanElement | null)[]>([]);
  const visRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (!props.open) return;
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
        if (ctx) drawVisualizerFrame(ctx, c.width, c.height, visMode, DEMO_PEAKS, 100, (now - t0) / 1000, visColor);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [props.open, theme.visualizer, theme.accent]);

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

  const duplicate = () => {
    const next = duplicateTheme(draft, theme.id);
    if (!next) return;
    edit(next);
    setSelId(next.themes[next.themes.length - 1].id);
  };
  const rename = async () => {
    if (!editable) return;
    const name = await prompt({ title: "Rename Theme", label: "Theme &name:", value: theme.name, okLabel: "Rename" });
    if (name) patch({ name });
  };
  const remove = async () => {
    if (!editable) return;
    const r = await ask({
      kind: "question",
      title: "Delete theme",
      message: (
        <>
          Delete the theme <b>{theme.name}</b>?
        </>
      ),
      detail: "Songs pinned to it go back to the default theme.",
      buttons: [
        { id: "delete", label: "&Delete" },
        { id: "keep", label: "&Keep it", isDefault: true, cancel: true },
      ],
    });
    if (r !== "delete") return;
    const next = deleteTheme(draft, theme.id);
    edit(next);
    setSelId(next.defaultId);
  };

  const bg = theme.background;
  const probe = backgroundProbeColor(bg);
  const bgFilter = bg.kind === "color" ? undefined : `blur(${bg.blurPx}px) brightness(${Math.max(0, 1 - bg.dim).toFixed(2)})`;
  const themes = allThemes(draft);

  return (
    <Dialog open={props.open} onClose={props.onClose} title="Player Themes" width={760}>
      <div className="w-dialog-body" style={{ gap: 12 }}>
        <div style={{ display: "flex", gap: 14 }}>
          {/* ---- the monitor: the stage's own CSS at half size ---- */}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 }}>
            <div className="w-raised" style={{ padding: "14px 14px 22px", position: "relative" }}>
              <div className="w-sunken" style={{ width: 344, height: 212, padding: 2, background: "#000" }}>
                <div style={{ width: 340, height: 208, overflow: "hidden", position: "relative" }}>
                  <div style={{ width: 680, height: 416, transform: "scale(0.5)", transformOrigin: "0 0", position: "relative" }}>
                    <div className="player-stage" style={themeCssVars(theme) as CSSProperties} aria-label="Theme preview">
                      {bg.kind === "color" ? (
                        <div className="pk-backdrop flat" style={{ backgroundColor: bg.color }} aria-hidden />
                      ) : bg.kind === "image" && bgUrl ? (
                        <div className="pk-backdrop" style={{ backgroundImage: `url(${bgUrl})`, filter: bgFilter }} aria-hidden />
                      ) : (
                        // cover kind: no song here — a stand-in wearing the theme's blur/dim
                        <div
                          className="pk-backdrop"
                          style={{ background: "linear-gradient(135deg, #7a2f8f, #0f5c7a 60%, #c07020)", filter: bgFilter }}
                          aria-hidden
                        />
                      )}
                      <div className="pk-scrim" aria-hidden />
                      {theme.visualizer !== "off" && <canvas className="pk-vis" ref={visRef} aria-hidden />}
                      <div style={{ position: "relative", zIndex: 1, margin: "auto 0", display: "flex", flexDirection: "column", gap: 6, padding: "0 24px" }}>
                        <div className="pk-line" style={{ fontSize: 44 }}>
                          {["You", "bring", "the", "music"].map((w) => (
                            <span key={w} className="k-word sung">
                              {w}
                            </span>
                          ))}
                        </div>
                        <div className="pk-line current" style={{ fontSize: 44 }}>
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
                        <div className="pk-line next" style={{ fontSize: 44 }}>
                          {["any", "song", "you", "own"].map((w) => (
                            <span key={w} className="k-word">
                              {w}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <i style={{ position: "absolute", right: 20, bottom: 8, width: 6, height: 4, background: "#00c000" }} />
            </div>
            <div className="w-raised" style={{ width: 70, height: 12 }} />
            <div className="w-raised" style={{ width: 150, height: 10 }} />
          </div>

          {/* ---- the theme list ---- */}
          <div style={{ flexGrow: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            <label htmlFor="pt-list">
              <span className="w-ak">T</span>hemes:
            </label>
            <ListView<ThemeSpec>
              ariaLabel="Themes"
              rows={themes}
              rowKey={(t) => t.id}
              selected={selId}
              onSelect={(k) => setSelId(String(k))}
              style={{ flexGrow: 1, minHeight: 160 }}
              columns={[
                {
                  key: "name",
                  label: "Name",
                  width: "minmax(0, 1fr)",
                  render: (t) => (
                    <>
                      <span style={{ display: "inline-flex", boxShadow: "inset 0 0 0 1px #000", padding: 1, flexShrink: 0 }} aria-hidden>
                        <i style={{ width: 8, height: 12, background: backgroundProbeColor(t.background) }} />
                        <i style={{ width: 8, height: 12, background: t.sung }} />
                        <i style={{ width: 8, height: 12, background: t.accent }} />
                      </span>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{t.name}</span>
                      {t.id === draft.defaultId && <span>(default)</span>}
                    </>
                  ),
                },
              ]}
            />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 6 }}>
              <Button onClick={duplicate}>D&uplicate</Button>
              <Button onClick={() => void rename()} disabled={!editable}>
                Rena&me…
              </Button>
              <Button onClick={() => void remove()} disabled={!editable}>
                &Delete…
              </Button>
              <Button onClick={() => edit({ ...draft, defaultId: theme.id })} disabled={draft.defaultId === theme.id}>
                Set as de&fault
              </Button>
            </div>
          </div>
        </div>

        <Tabs
          ariaLabel="Theme settings"
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "background", label: "Background" },
            { value: "lyrics", label: "Lyric colours" },
            { value: "effects", label: "Effects" },
          ]}
          panelStyle={{ minHeight: 118, display: "flex", flexDirection: "column", gap: 10 }}
        >
          {!editable && (
            <div style={{ display: "flex", gap: 8, alignItems: "center", lineHeight: "16px" }}>
              <Icon name="info" />
              Built-in theme — Duplicate it to customize.
            </div>
          )}
          {tab === "background" && (
            <>
              <RadioGroup
                ariaLabel="Background"
                value={bg.kind}
                disabled={!editable}
                onChange={(k) => {
                  if (k === "cover") patch({ background: { kind: "cover", blurPx: 48, dim: 0.78 } });
                  else if (k === "color") patch({ background: { kind: "color", color: bg.kind === "color" ? bg.color : "#000010" } });
                  else void pickImage();
                }}
                options={[
                  { value: "cover", label: "The song's &cover art" },
                  { value: "color", label: "A &flat colour" },
                  { value: "image", label: "A &picture…" },
                ]}
              />
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                {bg.kind === "color" ? (
                  <>
                    <span>Colour</span>
                    <ColorField value={bg.color} label="Background colour" disabled={!editable} onChange={(c) => patch({ background: { kind: "color", color: c } })} />
                  </>
                ) : (
                  <>
                    <span>Blur</span>
                    <Trackbar value={bg.blurPx} min={0} max={64} step={4} ticks={5} width={150} ariaLabel="Background blur" disabled={!editable} onChange={(v) => patch({ background: { ...bg, blurPx: v } })} />
                    <span>Dim</span>
                    <Trackbar value={Math.round(bg.dim * 100)} min={0} max={95} step={5} ticks={5} width={150} ariaLabel="Background dim" disabled={!editable} onChange={(v) => patch({ background: { ...bg, dim: v / 100 } })} />
                    {bg.kind === "image" && (
                      <Button slim onClick={() => void pickImage()} disabled={!editable}>
                        Change picture…
                      </Button>
                    )}
                  </>
                )}
              </div>
              {imgError && (
                <div style={{ display: "flex", gap: 8, alignItems: "center" }} role="alert">
                  <Icon name="error" />
                  {imgError}
                </div>
              )}
            </>
          )}
          {tab === "lyrics" && (
            <div style={{ display: "grid", gridTemplateColumns: "150px 60px minmax(0, 1fr)", gap: "8px 10px", alignItems: "center" }}>
              <span title="Words not yet sung">Resting words</span>
              <ColorField value={theme.resting} label="Resting text colour" disabled={!editable} onChange={(c) => patch({ resting: c })} />
              <Contrast label="Resting text" fg={theme.resting} bg={probe} />
              <span title="Sung words, the wipe fill, and the glow">Sung words</span>
              <ColorField value={theme.sung} label="Sung text colour" disabled={!editable} onChange={(c) => patch({ sung: c })} />
              <Contrast label="Sung text" fg={theme.sung} bg={probe} />
              <span title="Countdown pips, wait meter, visualizer">Accent</span>
              <ColorField value={theme.accent} label="Accent colour" disabled={!editable} onChange={(c) => patch({ accent: c })} />
              <span className="w-muted">Countdown pips, wait meter, visualizer</span>
            </div>
          )}
          {tab === "effects" && (
            <div style={{ display: "grid", gridTemplateColumns: "150px minmax(0, 1fr)", gap: "8px 10px", alignItems: "center" }}>
              <span>Glow</span>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Trackbar value={Math.round(theme.glow * 100)} min={0} max={150} step={10} ticks={4} width={170} ariaLabel="Glow strength" disabled={!editable} onChange={(v) => patch({ glow: v / 100 })} />
                <span>{Math.round(theme.glow * 100)}%</span>
              </div>
              <span>Visualizer</span>
              <RadioGroup
                ariaLabel="Visualizer"
                value={theme.visualizer}
                disabled={!editable}
                onChange={(v) => patch({ visualizer: v as VisualizerMode })}
                options={[
                  { value: "off", label: "Off" },
                  { value: "pulse", label: "Pulse" },
                  { value: "bars", label: "Bars" },
                ]}
              />
              <span />
              <Checkbox checked={theme.pips} disabled={!editable} onChange={(v) => patch({ pips: v })} label="Lead-in countdown pips" />
              <span />
              <Checkbox checked={theme.leadBar !== false} disabled={!editable} onChange={(v) => patch({ leadBar: v })} label="Lead-in bar" />
              <label htmlFor="pt-font">Lyric font</label>
              <TextField
                id="pt-font"
                placeholder="Barlow (the app's own)"
                value={theme.font ?? ""}
                disabled={!editable}
                title="Any font installed on this computer, by name — unknown names fall back to Barlow"
                onChange={(e) => patch({ font: e.target.value.trim() === "" ? null : e.target.value })}
              />
            </div>
          )}
        </Tabs>
      </div>
      <DialogButtons>
        <Button
          isDefault
          onClick={() => {
            if (dirty) apply();
            props.onClose();
          }}
        >
          OK
        </Button>
        <Button onClick={props.onClose}>Cancel</Button>
        <Button onClick={apply} disabled={!dirty}>
          &Apply
        </Button>
      </DialogButtons>
    </Dialog>
  );
}
