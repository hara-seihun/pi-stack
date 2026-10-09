import { createHash } from "node:crypto";

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
