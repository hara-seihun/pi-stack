import { timingSafeEqual } from "node:crypto";

export type CallFragment = { role: "callee" | "kenan"; text: string };

export function sameToken(a: string | null, b: string): boolean {
  const x = Buffer.from(a ?? ""), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
