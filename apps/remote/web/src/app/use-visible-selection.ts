import { useLayoutEffect, useRef } from "react";

export function useVisibleSelection(selector: string, version: unknown, onChange?: (visible: boolean) => void) {
  const root = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (!onChange) return;
    const selected = root.current?.querySelector(selector);
    if (!selected) { onChange(false); return; }
    const observer = new IntersectionObserver(([entry]) => {
      onChange(Boolean(entry?.isIntersecting && entry.intersectionRatio >= 0.99));
    }, { threshold: [0, 0.99, 1] });
    observer.observe(selected);
    return () => observer.disconnect();
  }, [selector, version, onChange]);
  return root;
}
