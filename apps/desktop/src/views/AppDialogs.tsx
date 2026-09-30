// The app-wide dialogs every main-window view can open from its Tools and
// Help menus: Properties, Player Themes, About.

import { useState } from "react";
import PlayerThemes from "./PlayerThemes";
import Properties, { AboutDialog } from "./Properties";

export type AppDialog = "properties" | "themes" | "about";

export function useAppDialogs() {
  const [which, setWhich] = useState<AppDialog | null>(null);
  const close = () => setWhich(null);
  const element = (
    <>
      <Properties open={which === "properties"} onClose={close} onPlayerThemes={() => setWhich("themes")} />
      <PlayerThemes open={which === "themes"} onClose={close} />
      <AboutDialog open={which === "about"} onClose={close} />
    </>
  );
  return { open: setWhich, element };
}
