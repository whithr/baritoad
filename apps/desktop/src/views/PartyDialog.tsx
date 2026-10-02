// Party › Start party… (docs/PARTY.md): opens a party and shows it — the join
// link and code, who's here (Kick), and plainly what's shared while it's
// open. Modeless: the Library stays usable, and closing it doesn't end the
// party (Party › End party does).

import { useState } from "react";
import { partyKick, partyNewCode, partyStart, partyStop, type PartyStatus } from "../api";
import QrCode from "../party/QrCode";
import ToadIcon from "../party/ToadIcon";
import { Button, Dialog, DialogButtons, GroupBox, Icon, useMessageBox } from "../win98";

export default function PartyDialog(props: { open: boolean; onClose: () => void; status: PartyStatus }) {
  const s = props.status;
  const ask = useMessageBox();
  const [problem, setProblem] = useState<string | null>(null);
  const run = (p: Promise<unknown>) => p.then(() => setProblem(null)).catch((e) => setProblem(String(e)));
  const relay = s.relay || "the party relay";

  const kick = async (id: string, name: string) => {
    const r = await ask({
      kind: "question",
      title: "Party",
      message: `Take ${name} out of the party?`,
      detail: "Their songs that are still waiting come out of Up next. They can't join again with this code.",
      buttons: [
        { id: "kick", label: "&Take them out", isDefault: true },
        { id: "no", label: "Cancel", cancel: true },
      ],
    });
    if (r !== "kick") return;
    await run(partyKick(id));
    // A kicked guest could rejoin with the old link; a new code stops that.
    await run(partyNewCode());
  };

  const shared = (
    <GroupBox label="What's shared">
      <div style={{ display: "flex", flexDirection: "column", gap: 6, lineHeight: "16px" }}>
        <span>While the party is open, baritoad sends to {relay}:</span>
        <span>• your song list: titles, artists, lengths and collections, for songs with timings</span>
        <span>• Up next: each song, and the name and toad of the guest who picked it</span>
        <span>Never your music, lyrics or files. The relay forgets it all when the party ends.</span>
      </div>
    </GroupBox>
  );

  return (
    <Dialog open={props.open} onClose={props.onClose} title="Party" width={520} modeless>
      <div className="w-dialog-body" style={{ gap: 10 }}>
        {s.phase === "off" && (
          <>
            <span style={{ lineHeight: "18px" }}>
              Guests scan a code on the TV and pick songs from their phones. No app and no sign-in for anyone.
            </span>
            {shared}
          </>
        )}
        {s.phase === "connecting" && <span>Opening the party…</span>}
        {s.phase === "ended" && (
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start", lineHeight: "16px" }} role="alert">
            <Icon name="info" />
            <span>{s.message ?? "The party ended."}</span>
          </div>
        )}
        {(s.phase === "open" || s.phase === "reconnecting") && (
          <>
            {s.phase === "reconnecting" && (
              <div style={{ display: "flex", gap: 8, alignItems: "flex-start", lineHeight: "16px" }} role="status">
                <Icon name="warn" />
                <span>Reconnecting… guests keep their spots. {s.message ? `(${s.message})` : ""}</span>
              </div>
            )}
            <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
              {s.qr && <QrCode qr={s.qr} px={150} />}
              <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0, lineHeight: "16px" }}>
                <b>Guests join at</b>
                <span className="w-field" style={{ padding: "3px 6px", userSelect: "text", wordBreak: "break-all" }}>
                  {s.join_url ?? "…"}
                </span>
                <span className="w-muted">The Stage shows this code between songs.</span>
                <div>
                  <Button onClick={() => void run(partyNewCode())}>&New code</Button>
                </div>
              </div>
            </div>
            <GroupBox label={`Guests (${s.guests.length})`}>
              {s.guests.length === 0 ? (
                <span className="w-muted">Nobody yet.</span>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 180, overflow: "auto" }}>
                  {s.guests.map((g) => (
                    <div key={g.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <ToadIcon toad={g.toad} />
                      <span style={{ flexGrow: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{g.name}</span>
                      <Button slim onClick={() => void kick(g.id, g.name)}>
                        Kick
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </GroupBox>
            {shared}
          </>
        )}
        {problem && (
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }} role="alert">
            <Icon name="error" />
            <span>{problem}</span>
          </div>
        )}
      </div>
      <DialogButtons>
        {s.phase === "off" || s.phase === "ended" ? (
          <Button isDefault onClick={() => void run(partyStart())}>
            &Start party
          </Button>
        ) : (
          <Button onClick={() => void run(partyStop())}>&End party</Button>
        )}
        <Button isDefault={s.phase !== "off" && s.phase !== "ended"} onClick={props.onClose}>
          Close
        </Button>
      </DialogButtons>
    </Dialog>
  );
}
