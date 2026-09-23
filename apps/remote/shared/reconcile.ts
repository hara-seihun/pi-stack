import { hash } from "fast-sha256";
import { ResourceCache } from "./resource-cache.js";

export type Revision = string;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Patch =
  | { op: "replace"; value: Json }
  | { op: "string"; start: number; deleteCount: number; insert: string }
  | { op: "object"; set: Record<string, Json>; remove: string[]; edit: Record<string, Patch> }
  | { op: "array"; start: number; deleteCount: number; insert: Json[]; edit: Record<string, Patch> }
  | { op: "keyed"; keyField: "seq" | "id"; order?: string[]; set: Record<string, Json>; edit: Record<string, Patch> };

export type ReconcileFrame =
  | { resource: string; revision: Revision; base: null; kind: "full"; value: unknown }
  | { resource: string; revision: Revision; base: Revision; kind: "patch"; patch: Patch };

export interface ReconcileOptions {
  maxEntries?: number;
  maxBytes?: number;
  maxValueBytes?: number;
  maxHistoryPerResource?: number;
}

const defaults = { maxEntries: 256, maxBytes: 128 * 1024 * 1024, maxValueBytes: 32 * 1024 * 1024, maxHistoryPerResource: 4 };
const maxDepth = 80;
const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
const record = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;
const put = <T>(object: Record<string, T>, key: string, value: T): void => {
  Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
};
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function options(input: ReconcileOptions): Required<ReconcileOptions> {
  const result = { ...defaults, ...input, maxValueBytes: input.maxValueBytes ?? Math.min(defaults.maxValueBytes, input.maxBytes ?? defaults.maxBytes) };
  for (const value of Object.values(result)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("Reconcile limits must be positive integers");
  }
  if (result.maxValueBytes > result.maxBytes) throw new RangeError("maxValueBytes exceeds maxBytes");
  return result;
}

// JSON normalization follows JSON.stringify, including toJSON, omitted object fields and null array slots.
// Sorting keys is only for identity; the values exposed to callers are ordinary JSON clones.
function encode(value: unknown, limit: number): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || serialized.length * 2 > limit) throw new RangeError("Value is not bounded JSON");
  const normalized: unknown = JSON.parse(serialized);
  const canonical = (entry: unknown, depth: number): string => {
    if (depth > maxDepth) throw new RangeError("JSON depth exceeded");
    if (Array.isArray(entry)) return `[${entry.map(item => canonical(item, depth + 1)).join(",")}]`;
    if (object(entry)) return `{${Object.keys(entry).sort().map(key => `${JSON.stringify(key)}:${canonical(entry[key], depth + 1)}`).join(",")}}`;
    return JSON.stringify(entry);
  };
  const result = canonical(normalized, 0);
  if (result.length * 2 > limit) throw new RangeError("Value exceeds JSON limit");
  return result;
}

function revision(text: string): Revision {
  return Array.from(hash(new TextEncoder().encode(text)), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** A receipt for exactly the JSON held locally, including a persisted snapshot. */
export function revisionOf(value: unknown): Revision {
  return revision(encode(value, defaults.maxValueBytes));
}

function itemKey(item: unknown, field: "seq" | "id"): string | undefined {
  if (!object(item) || !own(item, field)) return undefined;
  const id = item[field];
  if (typeof id === "string") return `s:${id}`;
  if (typeof id === "number" && Number.isFinite(id)) return `n:${id}`;
  return undefined;
}

function keyed(items: Json[], field: "seq" | "id"): Map<string, Json> | undefined {
  const result = new Map<string, Json>();
  for (const item of items) {
    const key = itemKey(item, field);
    if (key === undefined || result.has(key)) return undefined;
    result.set(key, item);
  }
  return result;
}

function keyedDiff(before: Json[], after: Json[], depth: number): Patch | undefined {
  for (const keyField of ["seq", "id"] as const) {
    const oldItems = keyed(before, keyField);
    const newItems = keyed(after, keyField);
    if (!oldItems || !newItems) continue;
    const set = record<Json>();
    const edit = record<Patch>();
    for (const [key, item] of newItems) {
      if (!oldItems.has(key)) put(set, key, item);
      else {
        const change = diff(oldItems.get(key)!, item, depth + 1);
        if (change) put(edit, key, change);
      }
    }
    const order = [...newItems.keys()];
    const oldOrder = [...oldItems.keys()];
    const sameOrder = order.length === oldOrder.length && order.every((key, index) => key === oldOrder[index]);
    if (sameOrder && !Object.keys(set).length && !Object.keys(edit).length) return undefined;
    return { op: "keyed", keyField, ...(sameOrder ? {} : { order }), set, edit };
  }
  return undefined;
}

function diff(before: Json, after: Json, depth = 0): Patch | null {
  if (before === after) return null;
  if (depth > maxDepth) return { op: "replace", value: after };
  if (typeof before === "string" && typeof after === "string") {
    let start = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start++;
    let end = 0;
    while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
    return { op: "string", start, deleteCount: before.length - start - end, insert: after.slice(start, after.length - end) };
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const keyedChange = keyedDiff(before, after, depth);
    if (keyedChange) return keyedChange;
    let start = 0;
    while (start < before.length && start < after.length && JSON.stringify(before[start]) === JSON.stringify(after[start])) start++;
    let end = 0;
    while (end < before.length - start && end < after.length - start &&
      JSON.stringify(before[before.length - 1 - end]) === JSON.stringify(after[after.length - 1 - end])) end++;
    const oldCount = before.length - start - end;
    const newCount = after.length - start - end;
    const edit = record<Patch>();
    if (oldCount === newCount) {
      for (let i = start; i < before.length - end; i++) {
        const change = diff(before[i], after[i], depth + 1);
        if (change) put(edit, String(i), change);
      }
      return Object.keys(edit).length ? { op: "array", start, deleteCount: 0, insert: [], edit } : null;
    }
    return { op: "array", start, deleteCount: oldCount, insert: after.slice(start, after.length - end), edit };
  }
  if (object(before) && object(after)) {
    const set = record<Json>();
    const edit = record<Patch>();
    const remove: string[] = [];
    for (const key of Object.keys(before)) if (!own(after, key)) remove.push(key);
    for (const key of Object.keys(after)) {
      if (!own(before, key)) put(set, key, after[key] as Json);
      else {
        const change = diff(before[key] as Json, after[key] as Json, depth + 1);
        if (change) put(edit, key, change);
      }
    }
    return Object.keys(set).length || remove.length || Object.keys(edit).length ?
      { op: "object", set, remove, edit } : null;
  }
  return { op: "replace", value: after };
}

function patchValue(before: Json, patch: Patch, depth = 0): Json {
  if (depth > maxDepth || !object(patch)) throw new Error("Invalid patch depth or shape");
  if (patch.op === "replace") return patch.value;
  if (patch.op === "string") {
    if (typeof before !== "string" || typeof patch.insert !== "string" || !index(patch.start, before.length) ||
      !index(patch.deleteCount, before.length - patch.start)) throw new Error("Invalid string patch");
    return before.slice(0, patch.start) + patch.insert + before.slice(patch.start + patch.deleteCount);
  }
  if (patch.op === "keyed") {
    if (!Array.isArray(before) || (patch.keyField !== "seq" && patch.keyField !== "id") ||
      (patch.order !== undefined && !Array.isArray(patch.order)) || !object(patch.set) || !object(patch.edit)) throw new Error("Invalid keyed patch");
    const previous = keyed(before, patch.keyField);
    if (!previous) throw new Error("Non-unique base keys");
    const remaining = new Set(Object.keys(patch.set));
    const edits = new Set(Object.keys(patch.edit));
    const seen = new Set<string>();
    const next: Json[] = [];
    for (const key of patch.order ?? previous.keys()) {
      if (typeof key !== "string" || seen.has(key)) throw new Error("Duplicate or invalid keyed order");
      seen.add(key);
      const old = previous.get(key);
      if (old !== undefined) {
        if (remaining.has(key)) throw new Error("Existing keyed item replaced as new");
        const change = edits.has(key) ? patchValue(old, patch.edit[key], depth + 1) : old;
        edits.delete(key);
        if (itemKey(change, patch.keyField) !== key) throw new Error("Edited keyed identity changed");
        next.push(change);
      } else {
        if (!remaining.has(key) || itemKey(patch.set[key], patch.keyField) !== key) throw new Error("Invalid inserted keyed item");
        next.push(patch.set[key]);
        remaining.delete(key);
      }
    }
    if (remaining.size || edits.size) throw new Error("Unused keyed edits");
    return next;
  }
  if (patch.op === "array") {
    if (!Array.isArray(before) || !Array.isArray(patch.insert) || !object(patch.edit) ||
      !index(patch.start, before.length) || !index(patch.deleteCount, before.length - patch.start)) throw new Error("Invalid array patch");
    const next = before.slice();
    const merged = next.slice(0, patch.start).concat(patch.insert, next.slice(patch.start + patch.deleteCount));
    for (const key of Object.keys(patch.edit)) {
      const at = Number(key);
      if (String(at) !== key || !index(at, merged.length - 1)) throw new Error("Invalid array index");
      merged[at] = patchValue(merged[at], patch.edit[key], depth + 1);
    }
    return merged;
  }
  if (patch.op === "object") {
    if (!object(before) || !object(patch.set) || !object(patch.edit) || !Array.isArray(patch.remove)) throw new Error("Invalid object patch");
    const next = Object.assign(record<Json>(), before);
    for (const key of patch.remove) {
      if (typeof key !== "string" || !own(next, key)) throw new Error("Invalid removed field");
      delete next[key];
    }
    for (const key of Object.keys(patch.set)) put(next, key, patch.set[key]);
    for (const key of Object.keys(patch.edit)) {
      if (!own(next, key) || own(patch.set, key)) throw new Error("Invalid edited field");
      put(next, key, patchValue(next[key], patch.edit[key], depth + 1));
    }
    return next;
  }
  throw new Error("Unknown patch operation");
}
const index = (n: number, upper: number) => Number.isSafeInteger(n) && n >= 0 && n <= upper;

type Snapshot = { revision: Revision; text: string };
type Published = { current: Snapshot; history: Snapshot[] };

export class ReconcilePublisher {
  private readonly limits: Required<ReconcileOptions>;
  private readonly resources: ResourceCache<Published>;
  constructor(input: ReconcileOptions = {}) {
    this.limits = options(input);
    this.resources = new ResourceCache({ entries: this.limits.maxEntries, bytes: this.limits.maxBytes });
  }

  publish(resource: string, value: unknown): Revision {
    if (!resource) throw new RangeError("Resource must be nonempty");
    const text = encode(value, this.limits.maxValueBytes);
    const previous = this.resources.get(resource);
    if (previous?.current.text === text) return previous.current.revision;
    const next = { text, revision: revision(text) };
    const history = previous ? [previous.current, ...previous.history].slice(0, this.limits.maxHistoryPerResource) : [];
    while (history.length && (history.length + 1 > this.limits.maxEntries ||
      history.reduce((size, snapshot) => size + snapshot.text.length * 2, text.length * 2) > this.limits.maxBytes)) history.pop();
    this.resources.set(resource, { current: next, history },
      text.length * 2 + history.reduce((size, snapshot) => size + snapshot.text.length * 2, 0), history.length + 1);
    return next.revision;
  }

  reconcile(resource: string, have: Revision | null): ReconcileFrame | null {
    const state = this.resources.get(resource);
    if (!state || have === state.current.revision) return null;
    const full: ReconcileFrame = { resource, revision: state.current.revision, base: null, kind: "full", value: JSON.parse(state.current.text) };
    const base = have && [state.current, ...state.history].find(snapshot => snapshot.revision === have);
    if (!base) return full;
    const change = diff(JSON.parse(base.text), JSON.parse(state.current.text));
    if (!change) return full;
    const frame: ReconcileFrame = { resource, revision: state.current.revision, base: have, kind: "patch", patch: change };
    return JSON.stringify(frame).length < JSON.stringify(full).length ? frame : full;
  }

  forget(resource: string): void { this.resources.delete(resource); }
}

export class ReconcileReplica {
  private readonly limits: Required<ReconcileOptions>;
  private readonly resources: ResourceCache<Snapshot>;
  constructor(input: ReconcileOptions = {}) {
    this.limits = options(input);
    this.resources = new ResourceCache({ entries: this.limits.maxEntries, bytes: this.limits.maxBytes });
  }

  apply(frame: ReconcileFrame): { ok: true; value: unknown } | { ok: false; reason: string } {
    if (!object(frame) || typeof frame.resource !== "string" || !frame.resource ||
      typeof frame.revision !== "string" || !frame.revision) return { ok: false, reason: "Invalid frame identity" };
    const old = this.resources.get(frame.resource);
    if (frame.kind === "patch" && (typeof frame.base !== "string" || !old || old.revision !== frame.base))
      return { ok: false, reason: "Base revision mismatch" };
    if (frame.kind !== "patch" && (frame.kind !== "full" || frame.base !== null))
      return { ok: false, reason: "Invalid frame kind or base" };
    try {
      const value = frame.kind === "full" ? frame.value : patchValue(JSON.parse(old!.text), frame.patch);
      const text = encode(value, this.limits.maxValueBytes);
      if (revision(text) !== frame.revision) return { ok: false, reason: "Result revision mismatch" };
      this.resources.set(frame.resource, { revision: frame.revision, text }, text.length * 2);
      return { ok: true, value: JSON.parse(text) };
    } catch {
      return { ok: false, reason: "Invalid or oversized JSON frame" };
    }
  }

  get(resource: string): { revision: Revision; value: unknown } | undefined {
    const state = this.resources.get(resource);
    return state && { revision: state.revision, value: JSON.parse(state.text) };
  }

  have(): Record<string, Revision> {
    const result = record<Revision>();
    for (const [resource, snapshot] of this.resources.pairs()) put(result, resource, snapshot.revision);
    return result;
  }

  seed(resource: string, expectedRevision: Revision, value: unknown): void {
    const text = encode(value, this.limits.maxValueBytes);
    if (!resource || revision(text) !== expectedRevision) throw new RangeError("Seed revision mismatch");
    this.resources.set(resource, { revision: expectedRevision, text }, text.length * 2);
  }
  forget(resource: string): void { this.resources.delete(resource); }
  clear(): void { this.resources.clear(); }
}

/** Validate a client-provided resource to revision map before reconciling it. */
export function readReconcileHave(value: unknown): Record<string, Revision> | undefined {
  if (!object(value) || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return undefined;
  const keys = Object.keys(value);
  if (keys.length > 256) return undefined;
  const result = record<Revision>();
  let bytes = 0;
  for (const key of keys) {
    const rev = value[key];
    if (!key || key.length > 512 || typeof rev !== "string" || !rev || rev.length > 128) return undefined;
    bytes += key.length + rev.length;
    if (bytes > 32_768) return undefined;
    put(result, key, rev);
  }
  return result;
}
