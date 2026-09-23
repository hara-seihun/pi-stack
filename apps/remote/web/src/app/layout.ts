import { useEffect, useState } from "react";

/** phone: one pane and a bottom tab bar. desktop: rail + list + detail.
 * wide: desktop plus a persistent inspector column. */
export type Layout = "phone" | "desktop" | "wide";

const DESKTOP = "(min-width: 900px)";
const WIDE = "(min-width: 1440px)";

export function currentLayout(): Layout {
  if (matchMedia(WIDE).matches) return "wide";
  if (matchMedia(DESKTOP).matches) return "desktop";
  return "phone";
}

export function useLayout(): Layout {
  const [layout, setLayout] = useState(currentLayout);
  useEffect(() => {
    const queries = [matchMedia(DESKTOP), matchMedia(WIDE)];
    const update = () => setLayout(currentLayout());
    for (const query of queries) query.addEventListener("change", update);
    return () => { for (const query of queries) query.removeEventListener("change", update); };
  }, []);
  return layout;
}

export const coarsePointer = () => matchMedia("(hover: none) and (pointer: coarse)").matches;
