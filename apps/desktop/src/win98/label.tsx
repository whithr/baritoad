// Access-key labels: "&File" renders F̲ile and reports "f" as its key, the
// way 98-era menus, buttons and field labels spell their Alt shortcuts.
// "&&" is a literal ampersand.

import type { ReactNode } from "react";

export function accessKeyOf(label: string): string | null {
  const m = /&([^&])/.exec(label.replace(/&&/g, ""));
  return m ? m[1].toLowerCase() : null;
}

export function stripAccess(label: string): string {
  return label.replace(/&(&?)/g, "$1");
}

export function AccessLabel(props: { text: string }): ReactNode {
  const { text } = props;
  const parts: ReactNode[] = [];
  let buf = "";
  let marked = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "&" && i + 1 < text.length) {
      const n = text[i + 1];
      if (n === "&") {
        buf += "&";
        i++;
        continue;
      }
      if (!marked) {
        if (buf) parts.push(buf);
        buf = "";
        parts.push(
          <span key={i} className="w-ak">
            {n}
          </span>,
        );
        marked = true;
        i++;
        continue;
      }
    }
    buf += c;
  }
  if (buf) parts.push(buf);
  // one span, so a flex parent's `gap` doesn't split the word at the mark
  return <span>{parts}</span>;
}

/** Children that are plain strings get access-key rendering; anything else passes through. */
export function renderLabel(children: ReactNode): ReactNode {
  return typeof children === "string" && children.includes("&") ? <AccessLabel text={children} /> : children;
}
