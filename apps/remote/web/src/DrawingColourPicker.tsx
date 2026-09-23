import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import "./drawing-colour-picker.css";

export interface DrawingColourPickerProps {
  color: string;
  onChange(color: string): void;
  disabled?: boolean;
}

type Hsv = { hue: number; saturation: number; value: number };

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function hsvToHex({ hue, saturation, value }: Hsv) {
  const chroma = value * saturation;
  const segment = ((hue % 360) + 360) % 360 / 60;
  const intermediate = chroma * (1 - Math.abs(segment % 2 - 1));
  const [red, green, blue] = segment < 1 ? [chroma, intermediate, 0]
    : segment < 2 ? [intermediate, chroma, 0]
    : segment < 3 ? [0, chroma, intermediate]
    : segment < 4 ? [0, intermediate, chroma]
    : segment < 5 ? [intermediate, 0, chroma]
    : [chroma, 0, intermediate];
  const offset = value - chroma;
  return `#${[red, green, blue].map(channel => Math.round((channel + offset) * 255).toString(16).padStart(2, "0")).join("")}`;
}

function parseHex(color: string): Hsv | null {
  const match = color.trim().match(/^#([\da-f]{3}|[\da-f]{6})$/i);
  if (!match) return null;
  const digits = match[1].length === 3 ? [...match[1]].map(digit => digit + digit).join("") : match[1];
  const red = Number.parseInt(digits.slice(0, 2), 16) / 255;
  const green = Number.parseInt(digits.slice(2, 4), 16) / 255;
  const blue = Number.parseInt(digits.slice(4, 6), 16) / 255;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const chroma = maximum - minimum;
  let hue = 0;
  if (chroma && maximum === red) hue = 60 * (((green - blue) / chroma + 6) % 6);
  else if (chroma && maximum === green) hue = 60 * ((blue - red) / chroma + 2);
  else if (chroma) hue = 60 * ((red - green) / chroma + 4);
  return { hue, saturation: maximum ? chroma / maximum : 0, value: maximum };
}

function initialSelection(color: string): Hsv {
  return parseHex(color) ?? { hue: 0, saturation: 1, value: 0 };
}

export function DrawingColourPicker({ color, onChange, disabled = false }: DrawingColourPickerProps) {
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<Hsv>(() => initialSelection(color));
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const wheelRef = useRef<HTMLDivElement>(null);
  const lastEmittedRef = useRef<string | null>(null);
  const popoverId = useId();
  const selectedColor = hsvToHex(selection);

  useEffect(() => {
    const parsed = parseHex(color);
    if (!parsed) return;
    const normalized = hsvToHex(parsed);
    if (normalized === lastEmittedRef.current) return;
    setSelection(current => ({
      hue: parsed.saturation === 0 ? current.hue : parsed.hue,
      saturation: parsed.saturation,
      value: parsed.value,
    }));
  }, [color]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useLayoutEffect(() => {
    if (!open) return;
    const button = buttonRef.current;
    const popover = popoverRef.current;
    if (!button || !popover) return;

    const position = () => {
      const buttonBounds = button.getBoundingClientRect();
      const popoverBounds = popover.getBoundingClientRect();
      const gap = 8;
      const margin = 8;
      const left = clamp(buttonBounds.left, margin, window.innerWidth - popoverBounds.width - margin);
      const fitsBelow = buttonBounds.bottom + gap + popoverBounds.height <= window.innerHeight - margin;
      const top = fitsBelow
        ? buttonBounds.bottom + gap
        : Math.max(margin, buttonBounds.top - gap - popoverBounds.height);
      popover.style.left = `${left}px`;
      popover.style.top = `${top}px`;
    };

    const frame = requestAnimationFrame(() => {
      position();
      wheelRef.current?.focus();
    });
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const change = (next: Hsv) => {
    const bounded = {
      hue: ((next.hue % 360) + 360) % 360,
      saturation: clamp(next.saturation, 0, 1),
      value: clamp(next.value, 0, 1),
    };
    const nextColor = hsvToHex(bounded);
    lastEmittedRef.current = nextColor;
    setSelection(bounded);
    onChange(nextColor);
  };

  const chooseFromWheel = (clientX: number, clientY: number) => {
    const bounds = wheelRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const x = clientX - bounds.left - bounds.width / 2;
    const y = clientY - bounds.top - bounds.height / 2;
    change({
      ...selection,
      hue: (Math.atan2(y, x) * 180 / Math.PI + 360) % 360,
      saturation: clamp(Math.hypot(x, y) / (Math.min(bounds.width, bounds.height) / 2), 0, 1),
    });
  };

  const onWheelPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "touch" && event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    chooseFromWheel(event.clientX, event.clientY);
  };

  const onWheelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 10 : 2;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      change({ ...selection, hue: selection.hue + (event.key === "ArrowLeft" ? -step : step) });
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      change({ ...selection, saturation: selection.saturation + (event.key === "ArrowUp" ? step : -step) / 100 });
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      change({ ...selection, hue: event.key === "Home" ? 0 : 359 });
    }
  };

  const style = {
    "--drawing-picker-color": selectedColor,
    "--drawing-picker-bright-color": hsvToHex({ ...selection, value: 1 }),
    "--drawing-picker-darkness": String(1 - selection.value),
    "--drawing-picker-x": `${50 + Math.cos(selection.hue * Math.PI / 180) * selection.saturation * 46}%`,
    "--drawing-picker-y": `${50 + Math.sin(selection.hue * Math.PI / 180) * selection.saturation * 46}%`,
  } as CSSProperties;

  return <div className="drawing-colour-picker" style={style}>
    <button
      ref={buttonRef}
      className="drawing-colour-picker-button"
      type="button"
      aria-label={open ? "Close colour picker" : "Choose drawing colour"}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? popoverId : undefined}
      disabled={disabled}
      onClick={() => setOpen(current => !current)}
    >{open ? <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" stroke="#374151" strokeWidth="2" /></svg> : <span aria-hidden="true" />}</button>
    {open && <><div className="drawing-colour-picker-backdrop" aria-hidden="true" onPointerDown={event => {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    }} /><div ref={popoverRef} id={popoverId} className="drawing-colour-picker-popover" role="dialog" aria-label="Drawing colour picker">
      <div
        ref={wheelRef}
        className="drawing-colour-picker-wheel"
        role="slider"
        tabIndex={0}
        aria-label="Hue and saturation"
        aria-valuemin={0}
        aria-valuemax={359}
        aria-valuenow={Math.round(selection.hue) % 360}
        aria-valuetext={`${selectedColor}, ${Math.round(selection.saturation * 100)}% saturation`}
        onPointerDown={onWheelPointerDown}
        onPointerMove={event => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) chooseFromWheel(event.clientX, event.clientY);
        }}
        onKeyDown={onWheelKeyDown}
      ><span className="drawing-colour-picker-marker" /></div>
      <label className="drawing-colour-picker-brightness">
        <span>Brightness</span>
        <output>{Math.round(selection.value * 100)}%</output>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={selection.value}
          aria-label="Brightness"
          onChange={event => change({ ...selection, value: Number(event.target.value) })}
        />
      </label>
    </div></>}
  </div>;
}
