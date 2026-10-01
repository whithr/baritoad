// baritoad Properties — the app-wide preferences as a tabbed property sheet
// (OK / Cancel / Apply over a draft), plus the About box. Player stage themes
// (including which one is the default) have their own dialog
// (PlayerThemes.tsx), reachable from the Player tab. The Bench's view and
// nudge scope aren't here: the Bench remembers whatever you last used.

import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { gameStatus, type GameStatus } from "../api";
import { useSettings } from "../App";
import type { Settings } from "../settings";
import { loadDisplay, saveDisplay } from "../stage";
import { Button, Checkbox, Dialog, DialogButtons, GroupBox, ListView, RadioGroup, Select, Tabs } from "../win98";

type Tab = "appearance" | "player" | "processing";

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
  const [display, setDisplay] = useState(() => loadDisplay());
  const [dirty, setDirty] = useState(false);
  const [game, setGame] = useState<GameStatus | null>(null);

  // Gaming mode's live verdict, while the Processing tab is showing.
  useEffect(() => {
    if (!props.open || tab !== "processing") return;
    let alive = true;
    const poll = () =>
      gameStatus()
        .then((s) => alive && setGame(s))
        .catch(() => undefined);
    void poll();
    const t = window.setInterval(poll, 2000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [props.open, tab]);

  useEffect(() => {
    if (!props.open) return;
    setDraft(settings);
    setDisplay(loadDisplay());
    setDirty(false);
  }, [props.open]); // eslint-disable-line react-hooks/exhaustive-deps

  const change = (patch: Partial<Settings>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setDirty(true);
  };
  const apply = () => {
    update(draft);
    saveDisplay(display);
    setDirty(false);
  };

  return (
    <Dialog open={props.open} onClose={props.onClose} title="baritoad Properties" width={500}>
      <div className="w-dialog-body">
        <Tabs
          ariaLabel="Properties"
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "appearance", label: "Appearance" },
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
                    { value: "classic", label: "baritoad 98 (Teal)" },
                    { value: "night", label: "baritoad 98 Night" },
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
          {tab === "player" && (
            <>
              <GroupBox label="Stage theme">
                <div>
                  <Button onClick={props.onPlayerThemes}>Player &Themes…</Button>
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
              <GroupBox label="While a game is using the graphics card">
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <RadioGroup
                    ariaLabel="While a game is using the graphics card"
                    column
                    disabled={draft.importOn === "cpu"}
                    value={draft.whileGaming}
                    onChange={(v) => change({ whileGaming: v })}
                    options={[
                      { value: "cpu", label: "Switch to the p&rocessor — slower, the game stays smooth" },
                      { value: "pause", label: "Pa&use importing until the game closes" },
                      { value: "gpu", label: "&Keep using the graphics card" },
                    ]}
                  />
                  <div className="w-muted" style={{ lineHeight: "16px" }}>
                    {draft.importOn === "cpu"
                      ? "Imports already run on the processor."
                      : !game
                        ? "Checking…"
                        : !game.supported
                          ? "This computer doesn't say what's using the graphics card."
                          : game.gaming
                            ? `Right now: ${game.app ?? "a game"} is using the graphics card${game.gpu_percent != null ? ` (${Math.round(game.gpu_percent)}%)` : ""}.`
                            : "Right now: no game is using the graphics card."}
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
  ["yt-dlp (separate program)", "Unlicense; its builds GPLv3+"],
  ["Deno (separate program)", "MIT"],
  ["ureq, native-tls (web requests)", "MIT or Apache-2.0"],
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
    <Dialog open={props.open} onClose={props.onClose} title="About baritoad" width={440}>
      <div className="w-dialog-body" style={{ gap: 12 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <b>baritoad</b>
          <span>Version {version ?? "—"}</span>
          <span>Free, open-source software (GPL-3.0).</span>
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
