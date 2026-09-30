// Dev-only parts bin (#/kit): every Karascape 98 control in one window, for
// eyeballing against the concept boards and checking both schemes.

import { useState } from "react";
import { useSettings } from "../App";
import {
  AppFrame,
  Button,
  Checkbox,
  GroupBox,
  Icon,
  Lcd,
  LcdText,
  ListView,
  MenuBar,
  ProgressBar,
  RadioGroup,
  Select,
  Spinner,
  StatusBar,
  StatusPane,
  Tabs,
  TextField,
  ToolButton,
  Toolbar,
  Trackbar,
  TreeView,
  Vr,
  useMessageBox,
  type IconName,
} from "../win98";

const ICONS: IconName[] = ["app", "disc", "folder", "tv", "queue", "timing", "floppy", "gear", "mic", "ready", "working", "warn", "failed", "lock", "trash", "palette"];

interface Row {
  id: number;
  title: string;
  artist: string;
  len: string;
  status: string;
}

const ROWS: Row[] = [
  { id: 1, title: "Night Drive", artist: "The Static Hearts", len: "3:41", status: "Needs checking" },
  { id: 2, title: "Cassette Summer", artist: "Pip Avenue", len: "3:21", status: "Ready" },
  { id: 3, title: "Paper Moon Motel", artist: "Juniper Kings", len: "4:12", status: "Separating vocals" },
];

export default function KitView() {
  const { settings, update } = useSettings();
  const ask = useMessageBox();
  const [text, setText] = useState("Night Drive");
  const [key, setKey] = useState(2);
  const [tempo, setTempo] = useState(1);
  const [guide, setGuide] = useState(0.4);
  const [scope, setScope] = useState<"word" | "line" | "tail">("line");
  const [check, setCheck] = useState(true);
  const [tab, setTab] = useState<"text" | "lanes" | "focus">("lanes");
  const [sel, setSel] = useState<string | number | null>(1);
  const [node, setNode] = useState("all");
  const [loop, setLoop] = useState(true);

  return (
    <AppFrame title="Karascape 98 - Parts bin" icon={<Icon name="app" />}>
      <MenuBar
        menus={[
          {
            label: "&File",
            items: [
              { label: "&Add Song…", accel: "Ctrl+O", run: () => undefined },
              { label: "&Export", items: [{ label: "&LRC", run: () => undefined }, { label: "&ASS subtitles", run: () => undefined }] },
              "-",
              { label: "E&xit", run: () => undefined },
            ],
          },
          {
            label: "&View",
            items: [
              { label: "&Classic scheme", checked: settings.scheme === "classic", radio: true, run: () => update({ scheme: "classic" }) },
              { label: "&Night scheme", checked: settings.scheme === "night", radio: true, run: () => update({ scheme: "night" }) },
              "-",
              { label: "&Pixel font", checked: settings.pixelFont, run: () => update({ pixelFont: !settings.pixelFont }) },
              { label: "&Large text", checked: settings.uiScale === "large", run: () => update({ uiScale: settings.uiScale === "large" ? "normal" : "large" }) },
              { label: "&Disabled item", disabled: true, accel: "F9" },
            ],
          },
          {
            label: "&Help",
            items: [
              {
                label: "&Message box…",
                run: () =>
                  void ask({
                    kind: "question",
                    message: (
                      <>
                        Remove <b>Harbor Lane</b> from your library?
                      </>
                    ),
                    detail: "Your original audio file stays where it is.",
                    buttons: [
                      { id: "remove", label: "&Remove" },
                      { id: "keep", label: "&Keep it", isDefault: true, cancel: true },
                    ],
                  }),
              },
            ],
          },
        ]}
      />
      <div className="w-hr" />
      <Toolbar label="Parts">
        <ToolButton icon={<Icon name="disc" />} tip="Add a song (Ctrl+O)">
          &Add song…
        </ToolButton>
        <ToolButton icon={<Icon name="tv" />}>Sing</ToolButton>
        <Vr />
        <ToolButton icon={<Icon name="floppy" />} disabled>
          Export
        </ToolButton>
        <ToolButton icon={<Icon name="queue" />} on>
          Up next
        </ToolButton>
      </Toolbar>
      <div className="w-hr" />
      <div style={{ flexGrow: 1, minHeight: 0, overflow: "auto", padding: 10, display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 14, alignContent: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <GroupBox label="&Buttons">
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <Button isDefault>OK</Button>
              <Button>Cancel</Button>
              <Button on={loop} onClick={() => setLoop((v) => !v)}>
                &Loop
              </Button>
              <Button disabled>&Apply</Button>
            </div>
          </GroupBox>
          <GroupBox label="&Fields">
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <TextField value={text} onChange={(e) => setText(e.target.value)} aria-label="Title" />
              <Select
                ariaLabel="Scheme"
                value={settings.scheme}
                onChange={(v) => update({ scheme: v })}
                options={[
                  { value: "classic", label: "Karascape 98 (Teal)" },
                  { value: "night", label: "Karascape 98 Night" },
                ]}
              />
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                Key <Spinner value={key} onChange={setKey} min={-6} max={6} step={1} ariaLabel="Key" format={{ signDisplay: "exceptZero" }} />
                Tempo <Spinner value={tempo} onChange={setTempo} min={0.8} max={1.2} step={0.05} ariaLabel="Tempo" format={{ minimumFractionDigits: 2 }} />
              </div>
              <Checkbox checked={check} onChange={setCheck} label="&High-quality separation" />
              <RadioGroup
                ariaLabel="Shift scope"
                value={scope}
                onChange={setScope}
                options={[
                  { value: "word", label: "&Word" },
                  { value: "line", label: "L&ine" },
                  { value: "tail", label: "From &here on" },
                ]}
              />
            </div>
          </GroupBox>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <GroupBox label="&Meters">
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                Vocal guide
                <Trackbar value={guide} onChange={setGuide} min={0} max={1} step={0.05} ariaLabel="Vocal guide" ticks={6} />
                {Math.round(guide * 100)}%
              </div>
              <ProgressBar value={0.62} label="Separating" />
              <ProgressBar value={null} small label="Working" />
              <Lcd label="Time">
                <LcdText value="00:14.32" size={21} />
                <span className="w-lcd-sep">/</span>
                <LcdText value="03:41" size={14} dim />
              </Lcd>
            </div>
          </GroupBox>
          <Tabs
            ariaLabel="View"
            value={tab}
            onChange={setTab}
            tabs={[
              { value: "text", label: "&Text" },
              { value: "lanes", label: "L&anes" },
              { value: "focus", label: "F&ocus" },
            ]}
          >
            <div style={{ height: 60 }}>Tab page: {tab}</div>
          </Tabs>
          <div className="w-lyric" style={{ fontSize: 34, fontWeight: 700 }}>
            Lyrics stay <span style={{ color: "var(--w-sel)" }}>smooth</span>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <TreeView
            ariaLabel="Library"
            selected={node}
            onSelect={setNode}
            style={{ height: 130 }}
            nodes={[
              {
                id: "lib",
                label: "Library",
                icon: <Icon name="app" />,
                children: [
                  { id: "all", label: "All songs (3)", icon: <Icon name="folder" /> },
                  { id: "c1", label: "Cassie's hits (2)", icon: <Icon name="folder" /> },
                ],
              },
              { id: "q", label: "Up next (1)", icon: <Icon name="queue" />, gap: true },
            ]}
          />
          <ListView<Row>
            ariaLabel="Songs"
            style={{ height: 120 }}
            rows={ROWS}
            rowKey={(r) => r.id}
            selected={sel}
            onSelect={(k) => setSel(k)}
            columns={[
              { key: "title", label: "Title", width: "minmax(0, 1.4fr)", render: (r) => r.title },
              { key: "len", label: "Length", width: "64px", render: (r) => r.len },
              { key: "status", label: "Status", width: "minmax(0, 1.4fr)", render: (r) => r.status },
            ]}
            contextMenu={[{ label: "&Open", accel: "Enter", run: () => undefined }, "-", { label: "&Remove…", accel: "Del" }]}
          />
          <GroupBox label="Icons">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(8, minmax(0, 1fr))", gap: 8 }}>
              {ICONS.map((n) => (
                <span key={n} title={n} style={{ display: "flex", justifyContent: "center" }}>
                  <Icon name={n} size={32} />
                </span>
              ))}
            </div>
          </GroupBox>
        </div>
      </div>
      <StatusBar>
        <StatusPane grow>Every bevel is stacked inset box-shadows.</StatusPane>
        <StatusPane width={160}>Scheme: {settings.scheme}</StatusPane>
      </StatusBar>
    </AppFrame>
  );
}
