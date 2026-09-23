import { closeSync, existsSync, fsyncSync, readSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { custodyMkdirSync, custodyOpenSync } from "../shared-custody.js";

export function writePiSessionFile(path: string, value: string): void {
  custodyMkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.next`;
  const fd = custodyOpenSync(temp, "w", 0o600);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  const directory = custodyOpenSync(dirname(path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

export function seedPiSession(path: string, cwd: string): void {
  const manager = SessionManager.inMemory(cwd);
  writePiSessionFile(path, `${JSON.stringify(manager.getHeader())}\n`);
}

export function preparePiSession(manager: SessionManager): void {
  const path = manager.getSessionFile();
  if (!path) throw new Error("Thread sessions must be durable");
  if (!existsSync(path)) {
    writePiSessionFile(path, [manager.getHeader(), ...manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n");
    manager.setSessionFile(path);
  }
}

export function checkpointPiSession(manager: SessionManager): void {
  const path = manager.getSessionFile();
  if (!path) throw new Error("Thread sessions must be durable");
  const fd = custodyOpenSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function assertPiSessionFile(path: string): Record<string, unknown> {
  const fd = custodyOpenSync(path, "r");
  let header: Record<string, unknown> | undefined;
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    const source = buffer.toString("utf8", 0, size);
    const end = source.indexOf("\n");
    if (end >= 0 || size < buffer.length) {
      try { header = JSON.parse(end < 0 ? source : source.slice(0, end)); } catch { /* Report the native format error below. */ }
    }
  } finally { closeSync(fd); }
  if (!header || header.type !== "session" || typeof header.id !== "string" || !Number.isInteger(header.version)
    || header.representation !== undefined || header.core !== undefined && header.core !== "pi") {
    throw new Error(`Not a native Pi session: ${path}. Import history through the thread import API.`);
  }
  return header;
}

export function argument(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}
