import { useEffect, useRef, type MouseEvent, type PointerEvent } from "react";

export const LONG_PRESS_MS = 600;

export class LongPressGesture {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private origin: { id: number; x: number; y: number } | null = null;
  private consumed = false;

  constructor(private readonly fire: () => void) {}

  start(id: number, x: number, y: number) {
    this.cancel();
    this.consumed = false;
    this.origin = { id, x, y };
    this.timer = setTimeout(() => {
      this.timer = null;
      this.consumed = true;
      this.fire();
    }, LONG_PRESS_MS);
  }

  move(id: number, x: number, y: number) {
    if (this.origin?.id === id && Math.hypot(x - this.origin.x, y - this.origin.y) > 10) this.cancel();
  }

  cancel() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.origin = null;
  }

  takeClick(): boolean {
    const consumed = this.consumed;
    this.consumed = false;
    return consumed;
  }
}

export function useLongPress(onLongPress?: () => void) {
  const callback = useRef(onLongPress);
  callback.current = onLongPress;
  const gesture = useRef<LongPressGesture | null>(null);
  gesture.current ??= new LongPressGesture(() => callback.current?.());
  useEffect(() => () => gesture.current?.cancel(), []);
  return {
    onPointerDown(event: PointerEvent<HTMLElement>) {
      if (!callback.current || event.button !== 0 || !event.isPrimary) return;
      const control = (event.target as Element).closest("button, a, input, textarea, select");
      if (control && control !== event.currentTarget) return;
      gesture.current!.start(event.pointerId, event.clientX, event.clientY);
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    onPointerMove(event: PointerEvent<HTMLElement>) { gesture.current!.move(event.pointerId, event.clientX, event.clientY); },
    onPointerUp() { gesture.current!.cancel(); },
    onPointerCancel() { gesture.current!.cancel(); },
    onLostPointerCapture() { gesture.current!.cancel(); },
    onClickCapture(event: MouseEvent<HTMLElement>) {
      if (gesture.current!.takeClick()) { event.preventDefault(); event.stopPropagation(); }
    },
    onContextMenu(event: MouseEvent<HTMLElement>) { if (callback.current) event.preventDefault(); },
  };
}
