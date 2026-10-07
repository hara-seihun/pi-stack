import { useEffect, useRef, useState, useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
const foregroundListeners = new Set<() => void>();
const visibilityListeners = new WeakMap<Element, (visible: boolean) => void>();
let observer: IntersectionObserver | undefined;
let clock = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const snapshot = () => clock;
const foreground = () => typeof document !== "undefined" && document.visibilityState === "visible";
const foregroundChanged = () => { for (const notify of foregroundListeners) notify(); };
const subscribeForeground = (listener: () => void) => {
  if (!foregroundListeners.size) document.addEventListener("visibilitychange", foregroundChanged);
  foregroundListeners.add(listener);
  return () => {
    foregroundListeners.delete(listener);
    if (!foregroundListeners.size) document.removeEventListener("visibilitychange", foregroundChanged);
  };
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (!timer) {
    clock = Date.now();
    timer = setInterval(() => {
      if (!foreground()) return;
      clock = Date.now();
      for (const notify of listeners) notify();
    }, 1_000);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { clearInterval(timer); timer = undefined; }
  };
};
const noClock = () => () => {};
const notForeground = () => false;

export function useVisualClock<T extends HTMLElement>(running: boolean) {
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(false);
  const active = useSyncExternalStore(subscribeForeground, foreground, notForeground);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    observer ??= new IntersectionObserver(entries => {
      for (const entry of entries) visibilityListeners.get(entry.target)?.(entry.isIntersecting);
    });
    visibilityListeners.set(node, setVisible);
    observer.observe(node);
    return () => { observer?.unobserve(node); visibilityListeners.delete(node); };
  }, []);
  const now = useSyncExternalStore(running && visible && active ? subscribe : noClock, snapshot, Date.now);
  return { ref, now: running && visible && active ? now : Date.now() };
}
