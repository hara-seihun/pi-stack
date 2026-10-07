import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { REVEAL_VIRTUAL_MESSAGE } from "../../virtual-message-navigation";

export const TRANSCRIPT_DOM_BUDGET = 60;
export function transcriptRange(offsets: readonly number[], top: number, height: number) {
  const count = offsets.length - 1;
  let low = 0, high = count;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (offsets[mid + 1] < top) low = mid + 1;
    else high = mid;
  }
  const start = Math.max(0, low - 3);
  let end = low;
  while (end < count && offsets[end] < top + height) end++;
  return { start, end: Math.min(count, start + TRANSCRIPT_DOM_BUDGET, Math.max(end + 3, start + 1)) };
}

/** Coordinates come from rectangles, not scrollTop: conversation scrollers use reverse flex. */
export function VirtualTranscript<T>({ items, itemKey, render, reverseDom = false, messageIds }: { items: readonly T[]; itemKey(item: T): string; render(item: T, index: number): ReactNode; reverseDom?: boolean; messageIds?(item: T): readonly string[] }) {
  const root = useRef<HTMLDivElement>(null);
  const sizes = useRef(new Map<string, number>());
  const [measurement, measured] = useState(0);
  const [viewport, setViewport] = useState<{ top: number; height: number } | null>(null);
  const current = useRef({ items, offsets: [] as number[] });
  const keys = items.map(itemKey);
  const identity = keys.join("\n");
  const offsets = useMemo(() => {
    const offsets = [0];
    for (const key of keys) offsets.push(offsets.at(-1)! + (sizes.current.get(key) ?? 160));
    return offsets;
  }, [identity, measurement]);
  current.current = { items, offsets };
  useLayoutEffect(() => {
    const node = root.current;
    const transcript = node?.closest(".transcript");
    const scroller = node?.closest<HTMLElement>(".scrollback");
    if (!node || !transcript || !scroller || !messageIds) return;
    const reveal = (event: Event) => {
      const index = current.current.items.findIndex(item => messageIds(item).includes((event as CustomEvent<string>).detail));
      if (index < 0) return;
      event.preventDefault();
      const top = current.current.offsets[index] - scroller.clientHeight / 2;
      const heldTop = scroller.getBoundingClientRect().top - node.getBoundingClientRect().top;
      scroller.scrollTop += top - heldTop;
      setViewport({ top, height: scroller.clientHeight });
    };
    transcript.addEventListener(REVEAL_VIRTUAL_MESSAGE, reveal);
    return () => transcript.removeEventListener(REVEAL_VIRTUAL_MESSAGE, reveal);
  }, [messageIds]);
  const range = items.length <= TRANSCRIPT_DOM_BUDGET
    ? { start: 0, end: items.length }
    : viewport ? transcriptRange(offsets, viewport.top, viewport.height) : { start: Math.max(0, items.length - TRANSCRIPT_DOM_BUDGET), end: items.length };

  useLayoutEffect(() => {
    const node = root.current;
    const scroller = node?.closest<HTMLElement>(".scrollback");
    if (!node || !scroller) return;
    const update = () => {
      const top = scroller.getBoundingClientRect().top - node.getBoundingClientRect().top;
      setViewport(previous => previous?.top === top && previous.height === scroller.clientHeight ? previous : { top, height: scroller.clientHeight });
    };
    const observer = new ResizeObserver(update);
    observer.observe(scroller);
    observer.observe(node);
    scroller.addEventListener("scroll", update, { passive: true });
    update();
    return () => { observer.disconnect(); scroller.removeEventListener("scroll", update); };
  }, []);
  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    const held = new Set(keys);
    for (const key of sizes.current.keys()) if (!held.has(key)) sizes.current.delete(key);
    const observer = new ResizeObserver(entries => {
      let changed = false;
      for (const entry of entries) {
        const key = (entry.target as HTMLElement).dataset.virtualKey!;
        const height = entry.target.getBoundingClientRect().height;
        if (height > 0 && sizes.current.get(key) !== height) { sizes.current.set(key, height); changed = true; }
      }
      if (changed) measured(value => value + 1);
    });
    for (const child of node.querySelectorAll<HTMLElement>(":scope > [data-virtual-key]")) observer.observe(child);
    return () => observer.disconnect();
  }, [identity, range.start, range.end]);
  const rows = items.slice(range.start, range.end).map((item, index) => <div key={itemKey(item)} data-virtual-key={itemKey(item)} style={{ display: "flow-root", flex: "none" }}>{render(item, range.start + index)}</div>);
  const top = <div key="top" aria-hidden="true" style={{ height: offsets[range.start], flex: "none" }} />;
  const bottom = <div key="bottom" aria-hidden="true" style={{ height: offsets.at(-1)! - offsets[range.end], flex: "none" }} />;
  return <div ref={root} className="virtual-transcript" style={reverseDom ? { display: "flex", flexDirection: "column-reverse" } : undefined}>
    {reverseDom ? [bottom, ...rows.reverse(), top] : [top, ...rows, bottom]}
  </div>;
}
