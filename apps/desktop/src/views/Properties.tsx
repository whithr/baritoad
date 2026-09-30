// Karascape Properties — the app-wide preferences as a tabbed property sheet
// (OK / Cancel / Apply over a draft), plus the About box. Player stage themes
// have their own dialog (PlayerThemes.tsx), reachable from the Player tab.

import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { useSettings } from "../App";
import { publishPrefs } from "../prefsSync";
import type { Settings } from "../settings";
import { loadDisplay, saveDisplay } from "../stage";
import { allThemes, loadThemeStore, saveThemeStore, THEME_STORE_KEY } from "../themes";
import { Button, Checkbox, Dialog, DialogButtons, GroupBox, Icon, ListView, RadioGroup, Select, Tabs } from "../win98";

type Tab = "appearance" | "bench" | "player" | "processing";

/** A tiny drawing of the app in a scheme, for the Appearance tab's monitor. */
function SchemePreview(props: { scheme: Settings["scheme"] }) {
  const night = props.scheme === "night";
  const face = night ? "#34343f" : "#c0c0c0";
  const title = night ? "linear-gradient(90deg, #1e1e5a, #4a4aa8)" : "linear-gradient(90deg, #000080, #1084d0)";
  const well = night ? "#16161c" : "#ffffff";
  const ink = night ? "#e6e6f0" : "#000000";
  const sel = night ? "#4a4aa8" : "#000080";
  return (
    <div style={{ width: "100%", height: "100%", background: night ? "#0a2a2a" : "#008080", position: "relative" }}>
      <div style={{ position: "absolute", left: 16, top: 12, width: 150, height: 96, background: face, padding: 2, boxShadow: "inset -1px -1px #000, inset 1px 1px #fff" }}>
        <div style={{ height: 8, background: title }} />
        <div style={{ display: "flex", gap: 2, marginTop: 3, height: 78 }}>
          <div style={{ width: 30, background: well }} />
          <div style={{ flexGrow: 1, background: well, padding: 3, display: "flex", flexDirection: "column", gap: 3 }}>
            <div style={{ height: 5, background: sel }} />
            <div style={{ height: 3, width: "80%", background: ink, opacity: 0.35 }} />
            <div style={{ height: 3, width: "62%", background: ink, opacity: 0.35 }} />
            <div style={{ height: 3, width: "70%", background: ink, opacity: 0.35 }} />
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Properties(props: { open: boolean; onClose: () => void; onPlayerThemes: () => void }) {
  const { settings, update } = useSettings();
  const [tab, setTab] = useState<Tab>("appearance");
  const [draft, setDraft] = useState<Settings>(settings);
  const [defaultTheme, setDefaultTheme] = useState(() => loadThemeStore().defaultId);
  const [display, setDisplay] = useState(() => loadDisplay());
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!props.open) return;
    setDraft(settings);
    setDefaultTheme(loadThemeStore().defaultId);
    setDisplay(loadDisplay());
    setDirty(false);
  }, [props.open]); // eslint-disable-line react-hooks/exhaustive-deps

  const change = (patch: Partial<Settings>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setDirty(true);
  };
  const apply = () => {
    update(draft);
    const store = loadThemeStore();
    if (store.defaultId !== defaultTheme) {
      const next = { ...store, defaultId: defaultTheme };
      saveThemeStore(next);
      publishPrefs(THEME_STORE_KEY, JSON.stringify(next));
    }
    saveDisplay(display);
    setDirty(false);
  };

  return (
    <Dialog open={props.open} onClose={props.onClose} title="Karascape Properties" width={500}>
      <div className="w-dialog-body">
        <Tabs
          ariaLabel="Properties"
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "appearance", label: "Appearance" },
            { value: "bench", label: "Bench" },
            { value: "player", label: "Player" },
            { value: "processing", label: "Processing" },
          ]}
          panelStyle={{ minHeight: 380, display: "flex", flexDirection: "column", gap: 10, padding: 14 }}
        >
          {tab === "appearance" && (
            <>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                <div className="w-raised" style={{ width: 214, height: 158, padding: "14px 14px 20px", position: "relative" }}>
                  <div className="w-sunken" style={{ width: "100%", height: "100%", padding: 2 }}>
                    <SchemePreview scheme={draft.scheme} />
                  </div>
                  <i style={{ position: "absolute", right: 18, bottom: 7, width: 6, height: 4, background: "#00c000" }} />
                </div>
                <div className="w-raised" style={{ width: 60, height: 12 }} />
                <div className="w-raised" style={{ width: 130, height: 10 }} />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <label htmlFor="pr-scheme" style={{ width: 64 }}>
                  <span className="w-ak">S</span>cheme:
                </label>
                <Select
                  id="pr-scheme"
                  value={draft.scheme}
                  onChange={(v) => change({ scheme: v })}
                  options={[
                    { value: "classic", label: "Karascape 98 (Teal)" },
                    { value: "night", label: "Karascape 98 Night" },
                  ]}
                  style={{ flexGrow: 1 }}
                />
              </div>
              <GroupBox label="Text size">
                <RadioGroup
                  ariaLabel="Text size"
                  value={draft.uiScale}
                  onChange={(v) => change({ uiScale: v })}
                  options={[
                    { value: "normal", label: "&Normal" },
                    { value: "large", label: "&Large (125%)" },
                  ]}
                />
              </GroupBox>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <Checkbox checked={draft.pixelFont} onChange={(v) => change({ pixelFont: v })} label="&Pixel font in menus and dialogs" />
                <div className="w-muted" style={{ paddingLeft: 19, lineHeight: "16px" }}>
                  Turn off on screens scaled to 125% or 150% if the chrome looks soft. Lyrics always use a large, smooth typeface.
                </div>
              </div>
            </>
          )}
          {tab === "bench" && (
            <>
              <GroupBox label="Open songs in">
                <RadioGroup
                  ariaLabel="Bench opens in"
                  column
                  value={draft.benchView}
                  onChange={(v) => change({ benchView: v })}
                  options={[
                    { value: "text", label: "&Text — read through the lines" },
                    { value: "lanes", label: "L&anes — every line on the waveform" },
                    { value: "focus", label: "F&ocus — one line at a time, big" },
                  ]}
                />
              </GroupBox>
              <GroupBox label="Arrow keys shift">
                <RadioGroup
                  ariaLabel="Default shift scope"
                  column
                  value={draft.shiftScope}
                  onChange={(v) => change({ shiftScope: v })}
                  options={[
                    { value: "word", label: "The &word" },
                    { value: "line", label: "The &line" },
                    { value: "tail", label: "Everything from &here on" },
                  ]}
                />
              </GroupBox>
            </>
          )}
          {tab === "player" && (
            <>
              <GroupBox label="Stage theme">
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <label htmlFor="pr-theme" style={{ width: 64 }}>
                      Default:
                    </label>
                    <Select
                      id="pr-theme"
                      value={defaultTheme}
                      onChange={(v) => {
                        setDefaultTheme(v);
                        setDirty(true);
                      }}
                      options={allThemes(loadThemeStore()).map((t) => ({ value: t.id, label: t.name }))}
                      style={{ flexGrow: 1 }}
                    />
                  </div>
                  <div className="w-muted" style={{ lineHeight: "16px" }}>
                    Any song can pin its own theme from the player's Options.
                  </div>
                  <div>
                    <Button onClick={props.onPlayerThemes}>Player &Themes…</Button>
                  </div>
                </div>
              </GroupBox>
              <GroupBox label="TV display">
                <div style={{ display: "flex", flexDirection: "column", gap: 10, lineHeight: "16px" }}>
                  <div>
                    {display
                      ? `The stage opens on ${display.name ?? "a saved display"}${display.fullscreen ? ", full screen" : ""}.`
                      : "The stage opens where you last left it. Choose a display from the stage's Options › Show on."}
                  </div>
                  <div>
                    <Button
                      onClick={() => {
                        setDisplay(null);
                        setDirty(true);
                      }}
                      disabled={!display}
                    >
                      &Forget display
                    </Button>
                  </div>
                </div>
              </GroupBox>
            </>
          )}
          {tab === "processing" && (
            <>
              <GroupBox label="Import songs on">
                <RadioGroup
                  ariaLabel="Import songs on"
                  column
                  value={draft.importOn}
                  onChange={(v) => change({ importOn: v })}
                  options={[
                    { value: "gpu", label: "&Graphics card — fastest" },
                    { value: "cpu", label: "&Processor only — slower, keeps the graphics card free" },
                  ]}
                />
              </GroupBox>
              <GroupBox label="On this computer">
                <div style={{ display: "flex", gap: 12, lineHeight: "18px" }}>
                  <Icon name="lock" size={32} />
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <div>Vocal separation and word timing run on this computer. Karascape never uploads your audio.</div>
                    <div>
                      On the graphics card, vocal separation and word timing use DirectML when each passes a quality check, otherwise the
                      processor. Imports run at low priority so the rest of the computer stays responsive.
                    </div>
                  </div>
                </div>
              </GroupBox>
            </>
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

// ------------------------------------------------------------------- about

const NOTICES: [string, string][] = [
  ["Tauri (tao: Apache-2.0)", "Apache-2.0 or MIT"],
  ["React", "MIT"],
  ["Base UI", "MIT"],
  ["ONNX Runtime", "MIT"],
  ["HTDemucs models", "MIT"],
  ["Whisper", "MIT"],
  ["wav2vec2-base-960h weights", "Apache-2.0"],
  ["Signalsmith Stretch", "MIT"],
  ["Symphonia", "MPL-2.0"],
  ["SQLite", "Public domain"],
  ["ffmpeg (separate program)", "LGPL-2.1"],
  ["98.css (bevel recipes)", "MIT"],
  ["Barlow, DSEG7 fonts", "SIL OFL 1.1"],
  ["Pixel Operator font", "CC0 1.0"],
];

export function AboutDialog(props: { open: boolean; onClose: () => void }) {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    if (!props.open) return;
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(null));
  }, [props.open]);
  return (
    <Dialog open={props.open} onClose={props.onClose} title="About Karascape" width={440}>
      <div className="w-dialog-body" style={{ gap: 12 }}>
        <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
          <Icon name="app" size={48} />
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <b>Karascape</b>
            <span>Version {version ?? "—"}</span>
            <span>Source-available software.</span>
          </div>
        </div>
        <div style={{ lineHeight: "18px" }}>
          Karaoke from the songs you already own. Vocal separation and word timing run on this computer; nothing is uploaded.
        </div>
        <div>Includes:</div>
        <ListView<[string, string]>
          ariaLabel="Third-party components"
          rows={NOTICES}
          rowKey={(r) => r[0]}
          selected={null}
          onSelect={() => undefined}
          style={{ height: 180 }}
          columns={[
            { key: "c", label: "Component", width: "minmax(0, 1.4fr)", render: (r) => r[0] },
            { key: "l", label: "License", width: "minmax(0, 1fr)", render: (r) => r[1] },
          ]}
        />
      </div>
      <DialogButtons>
        <Button isDefault onClick={props.onClose}>
          OK
        </Button>
      </DialogButtons>
    </Dialog>
  );
}
