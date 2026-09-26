import type { RequestTiming } from "../../server/request-timings";

// Transport reports progress at page level. It must never change a control:
// pointerdown can start a prefetch before that control receives its click.

export const ACTIVATION_WINDOW_MS = 2_000;
export const SLOW_REQUEST_MS = 1_000;
export const TIMING_HISTORY_LIMIT = 100;

export type { RequestTiming };

/** The control a person last pressed, and when. */
export interface Activation { element: Element; at: number }
export interface InFlightRequest { id: number; method: string; path: string; origin: Element | null; startedAt: number }

const listeners = new Set<() => void>();
const requests = new Map<number, InFlightRequest>();
const sections = new Map<number, string>();
const timings: RequestTiming[] = [];
let timingReporter: ((timing: RequestTiming) => void) | null = null;
let nextId = 1;
let activation: Activation | null = null;

const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const TOP_LEVEL_READ = /^\/v1\/(?:sessions(?:\/archived)?|workspaces|messaging|files|environments|actions)$/;
const BACKGROUND_WRITE = /^\/v1\/(?:stream(?:\/[^/]+)?|messaging\/conversations\/[^/]+\/read|speech\/utterances)$/;
const NATIVE_ACTION = /^native:(?:installAppUpdate|checkAppUpdate|notifications)$/;

/** Native bridge calls are not API reads; only explicit native actions can show progress. */
export const NATIVE_METHOD = "NATIVE";

export function requestVisibility(method: string, pathname: string, activationAgeMs: number | null): "shown" | "background" {
  const route = pathname.replace(/^.*(?=\/v1\/)/, "");
  if (/^\/v1\/(?:stream(?:\/|$)|diagnostics\/requests$)/.test(route)) return "background";
  if (method === NATIVE_METHOD) return NATIVE_ACTION.test(pathname) && activationAgeMs !== null && activationAgeMs >= 0 && activationAgeMs <= ACTIVATION_WINDOW_MS ? "shown" : "background";
  if (WRITES.has(method)) return BACKGROUND_WRITE.test(route) ? "background" : "shown";
  return method === "GET" && TOP_LEVEL_READ.test(route) && activationAgeMs !== null && activationAgeMs >= 0 && activationAgeMs <= ACTIVATION_WINDOW_MS ? "shown" : "background";
}

/** A screen owns readiness; descendant fetches never extend its lifetime. */
export function beginSectionLoad(name: string): () => void {
  const id = nextId++;
  sections.set(id, name);
  notify();
  let settled = false;
  return () => {
    if (settled) return;
    settled = true;
    sections.delete(id);
    notify();
  };
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

/** The reporter is optional. Timing collection remains local when the network is unavailable. */
export function setRequestTimingReporter(reporter: ((timing: RequestTiming) => void) | null): void {
  timingReporter = reporter;
}

function emitTiming(request: InFlightRequest, startedAt: number, state: RequestTiming["state"]): void {
  const timing: RequestTiming = {
    id: request.id, method: request.method, path: request.path, startedAt,
    durationMs: Math.max(SLOW_REQUEST_MS, Math.round(performance.now() - request.startedAt)), state,
  };
  timings.push(timing);
  if (timings.length > TIMING_HISTORY_LIMIT) timings.shift();
  try { timingReporter?.(timing); } catch { /* Diagnostics must not change the request result. */ }
}

/** Keep latency diagnostics independent of whether a request owns global progress. */
export function beginRequest(method: string, pathname: string, now = performance.now()): () => void {
  const path = pathname.split(/[?#]/, 1)[0]!;
  const normalizedMethod = method.toUpperCase();
  const age = activation ? now - activation.at : null;
  const shown = requestVisibility(normalizedMethod, path, age) === "shown";
  if (/\/v1\/(?:stream(?:\/|$)|diagnostics\/requests$)/.test(path) || normalizedMethod === NATIVE_METHOD && !shown) return () => {};
  const origin = attributedOrigin(activation, now);
  const request: InFlightRequest = { id: nextId++, method: normalizedMethod, path, origin, startedAt: now };
  const startedAt = Date.now();
  if (shown) { requests.set(request.id, request); notify(); }
  let settled = false;
  let slow = false;
  const pending = () => {
    if (settled) return;
    slow = true;
    emitTiming(request, startedAt, "pending");
  };
  const timer = setTimeout(pending, SLOW_REQUEST_MS);
  return () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (!slow && performance.now() - now >= SLOW_REQUEST_MS) {
      slow = true;
      emitTiming(request, startedAt, "pending");
    }
    if (slow) emitTiming(request, startedAt, "settled");
    if (shown) { requests.delete(request.id); notify(); }
  };
}

function notify(): void { for (const listener of listeners) listener(); }

export const inFlight = {
  subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
  count(): number { return requests.size + sections.size; },
  list(): InFlightRequest[] { return [...requests.values()]; },
  sections(): string[] { return [...sections.values()]; },
  timings(): RequestTiming[] { return [...timings]; },
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
