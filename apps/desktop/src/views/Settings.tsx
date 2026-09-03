// Settings: the handful of app-wide preferences. Player stage themes live
// in their own editor (ThemesView) reached from here.

import type { Route } from "../App";
import { useSettings } from "../App";
import { Key, Label, Seg } from "../hw/ui";

export default function SettingsView(props: { go: (r: Route) => void }) {
  const { settings, update } = useSettings();
  return (
    <>
      <div className="hw-topbar">
        <Key icon="back" onClick={() => props.go({ view: "home" })} aria-label="Back" />
        <span className="hw-title">Settings</span>
      </div>
      <div className="settings">
        <div className="hw-card">
          <div className="settings-row">
            <div className="desc">
              <span className="hw-card-title">Appearance</span>
              <p>Light or dark chrome for the bench and library. The TV player is always dark.</p>
            </div>
            <Seg
              ariaLabel="Theme"
              value={settings.theme}
              onChange={(v) => update({ theme: v })}
              options={[
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ]}
            />
          </div>
        </div>

        <div className="hw-card">
          <div className="settings-row">
            <div className="desc">
              <span className="hw-card-title">Bench opens in</span>
              <p>The view a song lands on. Text for a read-through, Lanes to work through it, Focus for one line at a time.</p>
            </div>
            <Seg
              ariaLabel="Bench view"
              value={settings.benchView}
              onChange={(v) => update({ benchView: v })}
              options={[
                { value: "text", label: "Text" },
                { value: "lanes", label: "Lanes" },
                { value: "focus", label: "Focus" },
              ]}
            />
          </div>
        </div>

        <div className="hw-card">
          <div className="settings-row">
            <div className="desc">
              <span className="hw-card-title">Player themes</span>
              <p>Backgrounds, colours and the visualizer for the TV player, per song or as the default.</p>
            </div>
            <Key onClick={() => props.go({ view: "themes" })}>Open themes</Key>
          </div>
        </div>

        <div className="hw-card">
          <div className="settings-row">
            <div className="desc">
              <span className="hw-card-title">Processing</span>
              <p>
                Everything runs on this machine. Separation uses DirectML when it passes the parity
                check, otherwise CPU; alignment always runs on CPU.
              </p>
            </div>
            <Label>Local only</Label>
          </div>
        </div>
      </div>
    </>
  );
}
