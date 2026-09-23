// Transport reports progress at page level. It must never change a control:
// pointerdown can start a prefetch before that control receives its click.

export const ACTIVATION_WINDOW_MS = 2_000;

/** The control a person last pressed, and when. */
export interface Activation { element: Element; at: number }
export interface InFlightRequest { id: number; method: string; path: string; origin: Element | null; startedAt: number }

const listeners = new Set<() => void>();
const requests = new Map<number, InFlightRequest>();
let nextId = 1;
let activation: Activation | null = null;

const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Native bridge calls report with this method; they show like reads, when a press is behind them. */
export const NATIVE_METHOD = "NATIVE";

export function requestVisibility(method: string, pathname: string, activationAgeMs: number | null): "shown" | "background" {
  if (/\/v1\/stream$/.test(pathname) || pathname === "native:haptic") return "background";
  if (WRITES.has(method)) return "shown";
  return activationAgeMs !== null && activationAgeMs >= 0 && activationAgeMs <= ACTIVATION_WINDOW_MS ? "shown" : "background";
}

/** The control a request should be attributed to, given the last press. */
export function attributedOrigin(last: Activation | null, now: number): Element | null {
  if (!last || now - last.at > ACTIVATION_WINDOW_MS) return null;
  return last.element;
}

const CONTROL = "button, [role='button'], a[href], input, select, textarea, summary, form, [role='menuitem'], [role='option'], [role='tab']";

const isElement = (target: unknown): target is Element => !!target && typeof (target as Element).setAttribute === "function";

export function noteActivation(target: EventTarget | null, now = performance.now()): void {
  if (!isElement(target)) return;
  const element = target.closest?.(CONTROL) ?? target;
  activation = { element, at: now };
}

/**
 * Record a request that just started. Returns the function to call when it
 * settles, success or failure. A background request returns a no-op so the
 * transport does not have to decide.
 */
export function beginRequest(method: string, pathname: string, now = performance.now()): () => void {
  const age = activation ? now - activation.at : null;
  if (requestVisibility(method.toUpperCase(), pathname, age) === "background") return () => {};
  const origin = attributedOrigin(activation, now);
  const request: InFlightRequest = { id: nextId++, method: method.toUpperCase(), path: pathname, origin, startedAt: now };
  requests.set(request.id, request);
  notify();
  let settled = false;
  return () => {
    if (settled) return;
    settled = true;
    requests.delete(request.id);
    notify();
  };
}

function notify(): void { for (const listener of listeners) listener(); }

export const inFlight = {
  subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
  count(): number { return requests.size; },
  list(): InFlightRequest[] { return [...requests.values()]; },
  /** The control currently attributed to new requests; for tests and diagnostics. */
  activation(): Activation | null { return activation; },
};

/** Watch the document for presses so requests can be attributed to their control. */
export function installActivationTracking(root: Document = document): () => void {
  const note = (event: Event) => noteActivation(event.target);
  const keys = (event: KeyboardEvent) => { if (event.key === "Enter" || event.key === " ") noteActivation(event.target); };
  const types = ["pointerdown", "click", "submit", "change"] as const;
  for (const type of types) root.addEventListener(type, note, true);
  root.addEventListener("keydown", keys, true);
  return () => {
    for (const type of types) root.removeEventListener(type, note, true);
    root.removeEventListener("keydown", keys, true);
  };
}

if (typeof document !== "undefined") installActivationTracking();

/** Wrap a native bridge so each call it makes is reported like a request. */
export function reportingBridge<T extends object>(bridge: T): T {
  return new Proxy(bridge, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const settle = beginRequest(NATIVE_METHOD, `native:${String(key)}`);
        try {
          const result = value.apply(target, args);
          if (result && typeof (result as Promise<unknown>).then === "function") return (result as Promise<unknown>).finally(settle);
          settle(); return result;
        } catch (error) { settle(); throw error; }
      };
    },
  });
}
