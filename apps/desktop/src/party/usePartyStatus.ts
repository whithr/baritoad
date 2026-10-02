// Follow party mode's status (party.rs `karaoke://party`) from any window.

import { useEffect, useState } from "react";
import { onPartyEvent, partyStatus, type PartyStatus } from "../api";

export const PARTY_OFF: PartyStatus = { phase: "off", guests: [], relay: "" };

export function usePartyStatus(): PartyStatus {
  const [status, setStatus] = useState<PartyStatus>(PARTY_OFF);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    partyStatus()
      .then((s) => !disposed && setStatus(s))
      .catch(() => undefined);
    onPartyEvent((s) => !disposed && setStatus(s))
      .then((u) => (disposed ? u() : (unlisten = u)))
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  return status;
}

/** Open: guests can join (or are about to, while it reconnects). */
export const partyLive = (s: PartyStatus) => s.phase === "open" || s.phase === "reconnecting";
