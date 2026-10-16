#!/usr/local/bin/bun
import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { KenanKeys, type CustodyResult } from "./one-kenan-keys";
import { oneKenanConfig } from "./one-kenan";
import { listPersons, type Person } from "./persons";

export async function verifyOwnedCustodyKey(path: string, people: Person[], input: unknown): Promise<CustodyResult> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, status: 400, error: "Expected custody key verification" };
  const body = input as Record<string, unknown>;
  if (Object.keys(body).length !== 2 || typeof body.user !== "string" || !/^[a-z_][a-z0-9_-]{0,31}$/.test(body.user) || typeof body.key !== "string") return { ok: false, status: 400, error: "Expected person and key" };
  if (process.getuid?.() !== 0 || !path.startsWith("/")) return { ok: false, status: 503, error: "Custody verification requires its root authority" };
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadata = fstatSync(fd);
    if (!metadata.isFile() || metadata.uid !== 0 || metadata.mode & 0o077 || metadata.nlink !== 1 || metadata.size < 1 || metadata.size > 1024 * 1024) return { ok: false, status: 503, error: "Custody key store has invalid ownership" };
    // The descriptor stays open through the constructor to bind its read to this exact inode.
    const keys = new KenanKeys(`/proc/self/fd/${fd}`, people, async () => ({ ok: false, status: 503, error: "Verification cannot mount folders" }));
    return await keys.verify(body.user, body.key);
  } catch { return { ok: false, status: 503, error: "Custody key store is unavailable" }; }
  finally { if (fd !== undefined) closeSync(fd); }
}

if (import.meta.main) {
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  let result: CustodyResult = { ok: false, status: 503, error: "Custody verification is unconfigured" };
  try {
    const reader = Bun.stdin.stream().getReader();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 8192) { await reader.cancel(); throw new Error("Oversized input"); }
      chunks.push(chunk.value);
    }
    const config = oneKenanConfig();
    if (config?.keyStore) result = await verifyOwnedCustodyKey(config.keyStore, listPersons(), JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch { result = { ok: false, status: 503, error: "Custody verification could not complete" }; }
  finally { for (const chunk of chunks) chunk.fill(0); }
  console.log(JSON.stringify(result));
}
