// Dialogs: modal windows (property sheets, wizards) and message boxes.
// 98 modals don't dim the app behind them — the parent just stops taking
// input — so the backdrop is transparent. Message boxes are promise-based
// (`await ask({...})`) and replace window.confirm and inline confirm strips.

import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Button } from "./controls";
import { CaptionButton, TitleBar } from "./frame";
import { Icon } from "./icons";

// ------------------------------------------------------------------ dialog

export function Dialog(props: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  width?: number | string;
  style?: CSSProperties;
  initialFocus?: React.RefObject<HTMLElement | null>;
  /** Non-modal (e.g. the Processing dialog): the app stays usable behind it. */
  modeless?: boolean;
}) {
  return (
    <BaseDialog.Root
      open={props.open}
      modal={props.modeless ? false : true}
      onOpenChange={(o) => {
        if (!o) props.onClose();
      }}
    >
      <BaseDialog.Portal>
        {!props.modeless && <BaseDialog.Backdrop className="w-backdrop" />}
        <BaseDialog.Popup
          className="w98 w-popup w-window w-dialog"
          style={{ width: props.width, zIndex: 900, ...props.style }}
          initialFocus={props.initialFocus}
        >
          <TitleBar title={props.title} titleAs={(t) => <BaseDialog.Title render={<span />}>{t}</BaseDialog.Title>}>
            <CaptionButton glyph="close" label="Close" onClick={props.onClose} />
          </TitleBar>
          {props.children}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

/** OK / Cancel / Apply row for property sheets. */
export function DialogButtons(props: { children: ReactNode; align?: "end" | "center"; style?: CSSProperties }) {
  return (
    <div className="w-dialog-buttons" style={{ justifyContent: props.align === "center" ? "center" : undefined, ...props.style }}>
      {props.children}
    </div>
  );
}

// ------------------------------------------------------------------ wizard

/** The wizard shell: art panel left, page right, < Back / Next > / Cancel. */
export function Wizard(props: {
  open: boolean;
  title: string;
  art: ReactNode;
  children: ReactNode;
  onBack?: () => void;
  onNext: () => void;
  onCancel: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  backDisabled?: boolean;
  busy?: boolean;
  width?: number;
}) {
  return (
    <Dialog open={props.open} onClose={props.onCancel} title={props.title} width={props.width ?? 640}>
      <div style={{ display: "flex", gap: 14, padding: 12, minHeight: 360 }}>
        <div
          className="w-sunken"
          style={{ width: 150, flexShrink: 0, background: "var(--w-desktop)", position: "relative", overflow: "hidden" }}
          aria-hidden
        >
          {props.art}
        </div>
        <div style={{ flexGrow: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
          {props.children}
        </div>
      </div>
      <div className="w-hr" style={{ margin: "0 12px" }} />
      <div className="w-dialog-buttons" style={{ paddingTop: 10 }}>
        <Button onClick={props.onBack} disabled={!props.onBack || props.backDisabled || props.busy}>
          {"< &Back"}
        </Button>
        <Button isDefault onClick={props.onNext} disabled={props.nextDisabled || props.busy}>
          {props.nextLabel ?? "&Next >"}
        </Button>
        <Button onClick={props.onCancel} style={{ marginLeft: 6 }}>
          Cancel
        </Button>
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------- message box

export type MessageKind = "info" | "question" | "warning" | "error";

export interface MessageButton {
  id: string;
  label: string;
  isDefault?: boolean;
  /** Returned when the box is dismissed with Esc or the close button. */
  cancel?: boolean;
}

export interface MessageOptions {
  title?: string;
  kind: MessageKind;
  message: ReactNode;
  detail?: ReactNode;
  buttons?: MessageButton[];
}

type Ask = (o: MessageOptions) => Promise<string>;

const MessageContext = createContext<Ask>(async () => "cancel");

export const useMessageBox = () => useContext(MessageContext);

const KIND_ICON = { info: "info", question: "question", warning: "warn", error: "error" } as const;

export function MessageBoxProvider(props: { children: ReactNode; appName?: string }) {
  const [queue, setQueue] = useState<{ o: MessageOptions; resolve: (id: string) => void }[]>([]);
  const defaultRef = useRef<HTMLButtonElement | null>(null);

  const ask = useCallback<Ask>(
    (o) => new Promise<string>((resolve) => setQueue((q) => [...q, { o, resolve }])),
    [],
  );

  const current = queue[0];
  const buttons = current?.o.buttons ?? [{ id: "ok", label: "OK", isDefault: true, cancel: true }];
  const finish = (id: string) => {
    if (!current) return;
    current.resolve(id);
    setQueue((q) => q.slice(1));
  };
  const cancelId = (buttons.find((b) => b.cancel) ?? buttons[buttons.length - 1]).id;

  const value = useMemo(() => ask, [ask]);
  return (
    <MessageContext.Provider value={value}>
      {props.children}
      <AlertDialog.Root
        open={!!current}
        onOpenChange={(o) => {
          if (!o) finish(cancelId);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className="w-backdrop" />
          <AlertDialog.Popup className="w98 w-popup w-window w-dialog" style={{ zIndex: 950, minWidth: 320 }} initialFocus={defaultRef}>
            {current && (
              <>
                <TitleBar
                  title={current.o.title ?? props.appName ?? "Karascape"}
                  titleAs={(t) => <AlertDialog.Title render={<span />}>{t}</AlertDialog.Title>}
                >
                  <CaptionButton glyph="close" label="Close" onClick={() => finish(cancelId)} />
                </TitleBar>
                <div className="w-msg">
                  <Icon name={KIND_ICON[current.o.kind]} size={32} />
                  <div className="w-msg-text">
                    <AlertDialog.Description render={<div />}>{current.o.message}</AlertDialog.Description>
                    {current.o.detail && <div>{current.o.detail}</div>}
                  </div>
                </div>
                <div className="w-msg-buttons">
                  {buttons.map((b) => (
                    <Button
                      key={b.id}
                      isDefault={b.isDefault}
                      ref={b.isDefault ? defaultRef : undefined}
                      onClick={() => finish(b.id)}
                    >
                      {b.label}
                    </Button>
                  ))}
                </div>
              </>
            )}
          </AlertDialog.Popup>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </MessageContext.Provider>
  );
}
