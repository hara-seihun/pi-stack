import { useLayoutEffect, useRef } from "react";
import type { VisibleTranscriptRange } from "./transcript-store";

export function useVisibleHeads(version: unknown, onChange?: (range: VisibleTranscriptRange | null) => void) {
  const ref = useRef<HTMLDivElement>(null);
  const previous = useRef<VisibleTranscriptRange | null>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    const scroller = root?.closest<HTMLElement>(".scrollback");
    if (!root || !scroller || !onChange) return;
    const update = () => {
      const viewport = scroller.getBoundingClientRect();
      const seqs = [...root.querySelectorAll<HTMLElement>("[data-transcript-seq]")].filter(node => {
        const rect = node.getBoundingClientRect();
        return rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom;
      }).map(node => Number(node.dataset.transcriptSeq));
      const next = seqs.length ? { from: Math.min(...seqs), to: Math.max(...seqs) } : null;
      if (next?.from === previous.current?.from && next?.to === previous.current?.to) return;
      previous.current = next;
      onChange(next);
    };
    const observer = new ResizeObserver(update);
    observer.observe(root);
    const mutations = new MutationObserver(update);
    mutations.observe(root, { childList: true, subtree: true });
    scroller.addEventListener("scroll", update, { passive: true });
    root.addEventListener("toggle", update, true);
    update();
    return () => { observer.disconnect(); mutations.disconnect(); scroller.removeEventListener("scroll", update); root.removeEventListener("toggle", update, true); };
  }, [version, onChange]);
  return ref;
}
