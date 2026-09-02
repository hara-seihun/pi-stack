import { createHash } from "node:crypto";

export type ContextSplice = {
  baseHash: string;
  targetHash: string;
  prefixBytes: number;
  deleteBytes: number;
  insertBase64: string;
};

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
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
  while (prefix < shared && left[prefix] === right[prefix]) prefix++;
  let suffix = 0;
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
