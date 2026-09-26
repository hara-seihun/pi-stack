import { useEffect, useRef, useState, type RefObject } from "react";

const listeners = new WeakMap<Element, () => void>();
let observer: IntersectionObserver | undefined;

function viewportObserver(): IntersectionObserver {
  return observer ??= new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer?.unobserve(entry.target);
      const listener = listeners.get(entry.target);
      listeners.delete(entry.target);
      listener?.();
    }
  }, { rootMargin: "600px" });
}

/** A resource only enters the browser's loading queue when its owner approaches the viewport. */
export function useNearViewport<T extends HTMLElement>(): { ref: RefObject<T | null>; near: boolean } {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (near) return;
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const shared = viewportObserver();
    listeners.set(node, () => setNear(true));
    shared.observe(node);
    return () => { listeners.delete(node); shared.unobserve(node); };
  }, [near]);
  return { ref, near };
}
