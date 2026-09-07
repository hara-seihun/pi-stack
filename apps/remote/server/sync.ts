import { createHash } from "node:crypto";
import type { ContextSplice } from "./protocol";

export type { ContextSplice };

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export class DocumentHistory {
  private entries = new Map<string, { namespace: string; document: string; bytes: number }>();
  private bytes = 0;
  constructor(private maximumBytes = 32 * 1024 * 1024, private maximumEntries = 128) {}

  remember(namespace: string, document: string): string {
    const hash = sha256(document);
    const key = `${namespace}\0${hash}`;
    if (!this.entries.has(key)) {
      const bytes = Buffer.byteLength(document);
      if (bytes > this.maximumBytes) return hash;
      this.entries.set(key, { namespace, document, bytes });
      this.bytes += bytes;
      const versions = [...this.entries].filter(([, entry]) => entry.namespace === namespace);
      for (const [expired] of versions.slice(0, Math.max(0, versions.length - 12))) this.remove(expired);
      while (this.bytes > this.maximumBytes || this.entries.size > this.maximumEntries) this.remove(this.entries.keys().next().value!);
    }
    return hash;
  }

  get(namespace: string, hash: string): string | undefined {
    return this.entries.get(`${namespace}\0${hash}`)?.document;
  }

  delete(namespace: string) {
    for (const [key, entry] of this.entries) if (entry.namespace === namespace) this.remove(key);
  }

  private remove(key: string) {
    this.bytes -= this.entries.get(key)!.bytes;
    this.entries.delete(key);
  }
}

export function messageFinalizationKey(message: any): string {
  return sha256(JSON.stringify({
    role: message?.role ?? null,
    timestamp: message?.timestamp ?? null,
    content: message?.content ?? null,
  }));
}

export function contextSplice(base: string, target: string): ContextSplice {
  const left = Buffer.from(base);
  const right = Buffer.from(target);
  let prefix = 0;
  const shared = Math.min(left.length, right.length);
  const block = 64 * 1024;
  while (prefix + block <= shared && left.subarray(prefix, prefix + block).equals(right.subarray(prefix, prefix + block))) prefix += block;
  while (prefix < shared && left[prefix] === right[prefix]) prefix++;
  let suffix = 0;
  while (suffix + block <= shared - prefix && left.subarray(left.length - suffix - block, left.length - suffix)
    .equals(right.subarray(right.length - suffix - block, right.length - suffix))) suffix += block;
  while (suffix < shared - prefix
    && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix++;
  return {
    baseHash: sha256(left),
    targetHash: sha256(right),
    prefixBytes: prefix,
    deleteBytes: left.length - prefix - suffix,
    insertBase64: right.subarray(prefix, right.length - suffix).toString("base64"),
  };
}

export function applyContextSplice(base: string, splice: ContextSplice): string {
  const source = Buffer.from(base);
  if (sha256(source) !== splice.baseHash) throw new Error("Context splice base hash does not match");
  if (!Number.isSafeInteger(splice.prefixBytes) || !Number.isSafeInteger(splice.deleteBytes)
    || splice.prefixBytes < 0 || splice.deleteBytes < 0
    || splice.prefixBytes + splice.deleteBytes > source.length) throw new Error("Context splice range is invalid");
  const insert = Buffer.from(splice.insertBase64, "base64");
  const result = Buffer.concat([
    source.subarray(0, splice.prefixBytes),
    insert,
    source.subarray(splice.prefixBytes + splice.deleteBytes),
  ]);
  if (sha256(result) !== splice.targetHash) throw new Error("Context splice target hash does not match");
  return result.toString("utf8");
}

export function restoreContextSplices(base: string, splices: ContextSplice[]):
  { ok: true; document: string; hash: string } | { ok: false; error: string } {
  let parts: Buffer[] = [Buffer.from(base)];
  let length = parts[0].length;
  let hash = sha256(parts[0]);
  if (!splices.length) return { ok: true, document: base, hash };
  for (const splice of splices) {
    if (splice.baseHash !== hash) return { ok: false, error: "Context splice base hash does not match" };
    if (!Number.isSafeInteger(splice.prefixBytes) || !Number.isSafeInteger(splice.deleteBytes)
      || splice.prefixBytes < 0 || splice.deleteBytes < 0
      || splice.prefixBytes + splice.deleteBytes > length) return { ok: false, error: "Context splice range is invalid" };
    const insert = Buffer.from(splice.insertBase64, "base64");
    const next: Buffer[] = [];
    let offset = 0;
    for (const part of parts) {
      if (offset < splice.prefixBytes) next.push(part.subarray(0, Math.min(part.length, splice.prefixBytes - offset)));
      offset += part.length;
    }
    next.push(insert);
    const end = splice.prefixBytes + splice.deleteBytes;
    offset = 0;
    for (const part of parts) {
      if (offset + part.length > end) next.push(part.subarray(Math.max(0, end - offset)));
      offset += part.length;
    }
    parts = next.filter((part) => part.length > 0);
    length += insert.length - splice.deleteBytes;
    hash = splice.targetHash;
  }
  // Each patch was verified before commit. Rebuild the current document once,
  // rather than copying and hashing its unchanged images for every journal row.
  const result = Buffer.concat(parts, length);
  if (sha256(result) !== hash) return { ok: false, error: "Context splice target hash does not match" };
  return { ok: true, document: result.toString("utf8"), hash };
}
