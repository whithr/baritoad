// Dash controls — Base UI primitives (behavior, keyboard, a11y) skinned in
// the Digital Dash world (styles.css). Base UI is unstyled by design; every
// visible pixel here comes from our CSS. §6 row: @base-ui/react (MIT).
//
// Full keyboard operation is a PRODUCT.md commitment — these replace the
// hand-rolled menu/select/slider widgets that couldn't honor it.

import { Menu } from "@base-ui/react/menu";
import { Select } from "@base-ui/react/select";
import { Slider } from "@base-ui/react/slider";
import { type ReactNode } from "react";
import { IconCheck } from "./icons";

// ---------------------------------------------------------------------------
// Select — a membrane key that opens a bezel popup.
// ---------------------------------------------------------------------------

export function DashSelect<T extends string>(props: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Select.Root
      value={props.value}
      onValueChange={(v) => v != null && props.onChange(v as T)}
      disabled={props.disabled}
    >
      <Select.Trigger
        className={`dash-select${props.className ? ` ${props.className}` : ""}`}
        aria-label={props.ariaLabel}
      >
        <Select.Value>
          {(v) => props.options.find((o) => o.value === v)?.label ?? String(v ?? "")}
        </Select.Value>
        <span className="dash-select-caret" aria-hidden />
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner className="dash-popup-positioner" sideOffset={6}>
          <Select.Popup className="dash-popup">
            {props.options.map((o) => (
              <Select.Item key={o.value} value={o.value} className="dash-item">
                <Select.ItemIndicator className="dash-item-lamp" />
                <Select.ItemText>{o.label}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

// ---------------------------------------------------------------------------
// Menu — trigger + bezel popup; items are plain actions or checkable rows.
// ---------------------------------------------------------------------------

export function DashMenu(props: {
  trigger: ReactNode;
  triggerClassName?: string;
  triggerTitle?: string;
  children: ReactNode;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Menu.Root onOpenChange={props.onOpenChange}>
      <Menu.Trigger className={props.triggerClassName} title={props.triggerTitle}>
        {props.trigger}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="dash-popup-positioner" sideOffset={4} align="end">
          <Menu.Popup className="dash-popup">{props.children}</Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

export function DashMenuItem(props: {
  onClick: () => void;
  children: ReactNode;
  danger?: boolean;
}) {
  return (
    <Menu.Item
      className={`dash-item${props.danger ? " danger" : ""}`}
      onClick={props.onClick}
    >
      {props.children}
    </Menu.Item>
  );
}

export function DashMenuCheckItem(props: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Menu.CheckboxItem
      className="dash-item"
      checked={props.checked}
      onCheckedChange={props.onCheckedChange}
      closeOnClick={false}
    >
      <Menu.CheckboxItemIndicator className="dash-item-lamp lit">
        <IconCheck size={10} />
      </Menu.CheckboxItemIndicator>
      {props.children}
    </Menu.CheckboxItem>
  );
}

export function DashMenuLabel(props: { children: ReactNode }) {
  return <Menu.GroupLabel className="dash-popup-label">{props.children}</Menu.GroupLabel>;
}

export function DashMenuSeparator() {
  return <Menu.Separator className="dash-popup-sep" />;
}

export { Menu as BaseMenu };

// ---------------------------------------------------------------------------
// SegText — a DSEG readout with the VFD's signature unlit-segment ghost
// ("8" shapes glowing faintly behind the lit digits). Static DOM, no
// per-frame cost — never use inside the player's rAF-mutated spans.
// ---------------------------------------------------------------------------

export function SegText(props: { value: string; className?: string }) {
  return (
    <span className={`seg-wrap${props.className ? ` ${props.className}` : ""}`}>
      <span className="seg seg-ghost" aria-hidden>
        {props.value.replace(/\d/g, "8")}
      </span>
      <span className="seg">{props.value}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// ConfirmStrip — in-world destructive confirm: a red annunciator strip with
// its own keys, replacing window.confirm system dialogs.
// ---------------------------------------------------------------------------

export function ConfirmStrip(props: {
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="error-banner confirm-strip"
      role="alertdialog"
      aria-label={props.message}
      onKeyDown={(e) => e.key === "Escape" && props.onCancel()}
    >
      <span className="confirm-msg">{props.message}</span>
      <button className="danger-key" onClick={props.onConfirm}>
        {props.confirmLabel}
      </button>
      {/* APG alertdialog: initial focus on the least destructive action */}
      <button onClick={props.onCancel} autoFocus>
        Cancel
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Slider — the segmented fader (vocal guide).
// ---------------------------------------------------------------------------

export function DashSlider(props: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  ariaLabel: string;
  disabled?: boolean;
}) {
  return (
    <Slider.Root
      className="dash-fader"
      value={props.value}
      min={props.min}
      max={props.max}
      step={props.step}
      disabled={props.disabled}
      onValueChange={(v) => props.onChange(v as number)}
      aria-label={props.ariaLabel}
    >
      <Slider.Control className="dash-fader-control">
        <Slider.Track className="dash-fader-track">
          <Slider.Indicator className="dash-fader-fill" />
          <Slider.Thumb className="dash-fader-thumb" aria-label={props.ariaLabel} />
        </Slider.Track>
      </Slider.Control>
    </Slider.Root>
  );
}
