// Karascape 98 controls. Behaviour (focus, keyboard, ARIA) comes from Base UI
// primitives where one exists; every visible pixel comes from base.css.
// §6 row: @base-ui/react (MIT).

import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import { NumberField } from "@base-ui/react/number-field";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup as BaseRadioGroup } from "@base-ui/react/radio-group";
import { Select as BaseSelect } from "@base-ui/react/select";
import { Slider } from "@base-ui/react/slider";
import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import { Tooltip } from "@base-ui/react/tooltip";
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import { Glyph, ThumbArt } from "./icons";
import { AccessLabel, renderLabel } from "./label";

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

// ---------------------------------------------------------------- tooltip

export function TipProvider(props: { children: ReactNode }) {
  return (
    <Tooltip.Provider delay={600} closeDelay={0}>
      {props.children}
    </Tooltip.Provider>
  );
}

/** Wrap a single focusable element with a 98 tooltip. */
export function Tip(props: { tip?: ReactNode; children: React.ReactElement }) {
  if (!props.tip) return props.children;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={props.children} />
      <Tooltip.Portal>
        <Tooltip.Positioner side="bottom" align="start" sideOffset={6} alignOffset={10}>
          <Tooltip.Popup className="w-popup w-tip">{props.tip}</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

// ---------------------------------------------------------------- buttons

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** The dialog's default button (thick ring, Enter). */
  isDefault?: boolean;
  /** Latched toggle (pressed + dither). */
  on?: boolean;
  size?: "sq" | "sm" | "tall";
  slim?: boolean;
  icon?: ReactNode;
  tip?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { isDefault, on, size, slim, icon, tip, className, children, type, ...rest },
  ref,
) {
  const btn = (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cx("w-btn", isDefault && "default", size, slim && "slim", className)}
      aria-pressed={on === undefined ? undefined : on}
      {...rest}
    >
      {icon}
      {renderLabel(children)}
    </button>
  );
  return tip ? <Tip tip={tip}>{btn}</Tip> : btn;
});

export interface ToolButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: ReactNode;
  on?: boolean;
  tip?: ReactNode;
}

export const ToolButton = forwardRef<HTMLButtonElement, ToolButtonProps>(function ToolButton(
  { icon, on, tip, className, children, ...rest },
  ref,
) {
  const btn = (
    <button
      ref={ref}
      type="button"
      className={cx("w-tool", className)}
      aria-pressed={on === undefined ? undefined : on}
      {...rest}
    >
      {icon}
      {renderLabel(children)}
    </button>
  );
  return tip ? <Tip tip={tip}>{btn}</Tip> : btn;
});

export function Toolbar(props: { children: ReactNode; label: string; className?: string; style?: CSSProperties }) {
  return (
    <div className={cx("w-toolbar", props.className)} role="toolbar" aria-label={props.label} style={props.style}>
      {props.children}
    </div>
  );
}

export function Hr(props: { style?: CSSProperties }) {
  return <div className="w-hr" role="separator" style={props.style} />;
}

export function Vr(props: { style?: CSSProperties }) {
  return <div className="w-vr" role="separator" aria-orientation="vertical" style={props.style} />;
}

// ---------------------------------------------------------------- group box

export function GroupBox(props: {
  label: string;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={cx("w-group", props.className)} role="group" aria-label={props.label.replace(/&/g, "")} style={props.style}>
      <span className="w-group-label" aria-hidden>
        <AccessLabel text={props.label} />
      </span>
      {props.children}
    </div>
  );
}

// ------------------------------------------------------------------ fields

export const TextField = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextField(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} className={cx("w-field", className)} spellCheck={false} {...rest} />;
});

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { lyric?: boolean }>(
  function TextArea({ className, lyric, ...rest }, ref) {
    return <textarea ref={ref} className={cx("w-field", lyric && "lyric", className)} {...rest} />;
  },
);

/** A field label with its access key underlined. */
export function FieldLabel(props: { htmlFor?: string; text: string; style?: CSSProperties }) {
  return (
    <label className="w-label" htmlFor={props.htmlFor} style={props.style}>
      <AccessLabel text={props.text} />
    </label>
  );
}

// ------------------------------------------------------------------ select

export function Select<T extends string>(props: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  ariaLabel?: string;
  id?: string;
  disabled?: boolean;
  style?: CSSProperties;
}) {
  return (
    <BaseSelect.Root
      value={props.value}
      onValueChange={(v) => v != null && props.onChange(v as T)}
      disabled={props.disabled}
    >
      <BaseSelect.Trigger className="w-select" aria-label={props.ariaLabel} id={props.id} style={props.style}>
        <BaseSelect.Value className="w-select-value">
          {(v) => props.options.find((o) => o.value === v)?.label ?? String(v ?? "")}
        </BaseSelect.Value>
        <span className="w-select-btn" aria-hidden>
          <Glyph name="down" />
        </span>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner alignItemWithTrigger={false} sideOffset={0} style={{ zIndex: 1000 }}>
          <BaseSelect.Popup className="w-popup w-listbox">
            {props.options.map((o) => (
              <BaseSelect.Item key={o.value} value={o.value} className="w-option">
                <BaseSelect.ItemText>{o.label}</BaseSelect.ItemText>
              </BaseSelect.Item>
            ))}
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}

// -------------------------------------------------------- checkbox + radio

export function Checkbox(props: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label className="w-choice" data-disabled={props.disabled || undefined}>
      <BaseCheckbox.Root
        className="w-checkbox"
        checked={props.checked}
        onCheckedChange={(v) => props.onChange(v)}
        disabled={props.disabled}
      >
        <BaseCheckbox.Indicator>
          <Glyph name="check" />
        </BaseCheckbox.Indicator>
      </BaseCheckbox.Root>
      <span className="w-choice-label">
        <AccessLabel text={props.label} />
      </span>
    </label>
  );
}

export function RadioGroup<T extends string>(props: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; disabled?: boolean }[];
  ariaLabel: string;
  column?: boolean;
  disabled?: boolean;
}) {
  return (
    <BaseRadioGroup
      className={cx("w-radiogroup", props.column && "column")}
      value={props.value}
      onValueChange={(v) => props.onChange(v as T)}
      aria-label={props.ariaLabel}
      disabled={props.disabled}
    >
      {props.options.map((o) => (
        <label key={o.value} className="w-choice" data-disabled={o.disabled || props.disabled || undefined}>
          <Radio.Root className="w-radio" value={o.value} disabled={o.disabled}>
            <Radio.Indicator className="w-radio-dot" />
          </Radio.Root>
          <span className="w-choice-label">
            <AccessLabel text={o.label} />
          </span>
        </label>
      ))}
    </BaseRadioGroup>
  );
}

// ---------------------------------------------------------------- trackbar

export function Trackbar(props: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  ariaLabel: string;
  ticks?: number;
  /** Fill the groove up to the thumb (a seek bar's played region). */
  fill?: boolean;
  disabled?: boolean;
  width?: number | string;
  onCommit?: (v: number) => void;
  valueText?: string;
}) {
  const ticks = props.ticks ?? 0;
  return (
    <Slider.Root
      className="w-slider"
      value={props.value}
      min={props.min}
      max={props.max}
      step={props.step}
      disabled={props.disabled}
      onValueChange={(v) => props.onChange(v as number)}
      onValueCommitted={props.onCommit ? (v) => props.onCommit!(v as number) : undefined}
      style={{ width: props.width ?? 150 }}
      // Arrow keys belong to the trackbar while it has focus — the views'
      // window-level shortcut handlers must not also seek/nudge.
      onKeyDown={(e) => e.stopPropagation()}
    >
      <Slider.Control className="w-slider-control">
        <Slider.Track className="w-slider-track">
          <Slider.Indicator className={cx("w-slider-fill", props.fill && "lit")} />
          <Slider.Thumb className="w-slider-thumb" aria-label={props.ariaLabel} getAriaValueText={props.valueText ? () => props.valueText! : undefined}>
            <ThumbArt />
          </Slider.Thumb>
        </Slider.Track>
        {ticks > 1 && (
          <div className="w-slider-ticks" aria-hidden>
            {Array.from({ length: ticks }, (_, i) => (
              <i key={i} />
            ))}
          </div>
        )}
      </Slider.Control>
    </Slider.Root>
  );
}

// ----------------------------------------------------------------- spinner

export function Spinner(props: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  ariaLabel: string;
  id?: string;
  format?: Intl.NumberFormatOptions;
  width?: number;
  disabled?: boolean;
}) {
  return (
    <NumberField.Root
      value={props.value}
      min={props.min}
      max={props.max}
      step={props.step}
      format={props.format}
      disabled={props.disabled}
      onValueChange={(v) => v != null && props.onChange(v)}
    >
      <NumberField.Group className="w-spin" style={{ width: props.width ?? 72 }}>
        <NumberField.Input className="w-spin-input" aria-label={props.ariaLabel} id={props.id} style={{ width: "100%" }} />
        <span className="w-spin-btns">
          <NumberField.Increment className="w-spin-btn" aria-label={`${props.ariaLabel} up`}>
            <Glyph name="up" />
          </NumberField.Increment>
          <NumberField.Decrement className="w-spin-btn" aria-label={`${props.ariaLabel} down`}>
            <Glyph name="down" />
          </NumberField.Decrement>
        </span>
      </NumberField.Group>
    </NumberField.Root>
  );
}

// ---------------------------------------------------------------- progress

/** Block progress bar. `value` 0..1, or null for an indeterminate marquee. */
export function ProgressBar(props: { value: number | null; small?: boolean; label?: string; style?: CSSProperties }) {
  const pct = props.value == null ? null : Math.round(Math.max(0, Math.min(1, props.value)) * 100);
  return (
    <div
      className={cx("w-progress", props.small && "small", pct == null && "indeterminate")}
      role="progressbar"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct ?? undefined}
      style={props.style}
    >
      <div className="w-progress-fill" style={{ width: `${pct ?? 30}%` }} />
    </div>
  );
}

// -------------------------------------------------------------------- tabs

export function Tabs<T extends string>(props: {
  value: T;
  onChange: (v: T) => void;
  tabs: { value: T; label: string }[];
  ariaLabel: string;
  /** Extra content on the tab strip's right (e.g. the Bench scope controls). */
  aside?: ReactNode;
  children?: ReactNode;
  className?: string;
  panelClassName?: string;
  panelStyle?: CSSProperties;
}) {
  return (
    <BaseTabs.Root
      className={cx("w-tabs", props.className)}
      value={props.value}
      onValueChange={(v) => props.onChange(v as T)}
    >
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 8 }}>
        <BaseTabs.List className="w-tablist" aria-label={props.ariaLabel}>
          {props.tabs.map((t) => (
            <BaseTabs.Tab key={t.value} value={t.value} className="w-tab">
              <AccessLabel text={t.label} />
            </BaseTabs.Tab>
          ))}
        </BaseTabs.List>
        {props.aside}
      </div>
      <BaseTabs.Panel value={props.value} className={cx("w-tabpanel", props.panelClassName)} style={props.panelStyle} keepMounted>
        {props.children}
      </BaseTabs.Panel>
    </BaseTabs.Root>
  );
}

// --------------------------------------------------------------------- LCD

/** One lit readout with its unlit "8" ghost behind it. */
export function LcdText(props: { value: string; size?: number; dim?: boolean }) {
  return (
    <span className="w-lcd-seg" style={{ fontSize: props.size ?? 20, color: props.dim ? "var(--w-lcd-ink-dim)" : undefined }}>
      <span className="w-lcd-ghost" aria-hidden>
        {props.value.replace(/\d/g, "8")}
      </span>
      <span className="w-lcd-lit">{props.value}</span>
    </span>
  );
}

export function Lcd(props: { children: ReactNode; label?: string; style?: CSSProperties; title?: string }) {
  return (
    <span className="w-lcd" role={props.label ? "timer" : undefined} aria-label={props.label} style={props.style} title={props.title}>
      {props.children}
    </span>
  );
}

// -------------------------------------------------------------- status bar

export function StatusBar(props: { children: ReactNode }) {
  return (
    <div className="w-status" role="status">
      {props.children}
    </div>
  );
}

export function StatusPane(props: { children: ReactNode; width?: number; grow?: boolean; title?: string }) {
  return (
    <div
      className="w-status-pane"
      style={{ width: props.width, flexGrow: props.grow ? 1 : 0, flexShrink: props.grow ? 1 : 0 }}
      title={props.title}
    >
      {props.children}
    </div>
  );
}
