import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, statfsSync, statSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CoreCustody } from "./contracts.js";
import { custodySocket } from "./custody-socket.js";

export class CustodyResourceError extends Error {
  constructor(readonly code: "namespace-changed" | "resource-unavailable" | "outside-boundary", message: string) {
    super(message); this.name = "CustodyResourceError";
  }
}
function namespacePath(custody: CoreCustody): string {
  const namespace = custody.namespace;
  return namespace.kind === "host" ? "/proc/1/ns/mnt"
    : namespace.kind === "pinned" ? `/proc/1/root${namespace.path}` : `/proc/${namespace.pid}/ns/mnt`;
}
export function assertCustodyNamespace(custody: CoreCustody): void {
  const namespace = custody.namespace;
  if (namespace.kind === "host") return;
  try {
    if (namespace.kind === "pinned") {
      const path = namespacePath(custody), parent = statSync(dirname(path));
      if (!isAbsolute(namespace.path) || resolve(namespace.path) !== namespace.path
        || dirname(namespace.path) !== "/run/pi-stack/namespaces" || !/^[a-zA-Z0-9_.-]+$/.test(namespace.path.slice(namespace.path.lastIndexOf("/") + 1))
        || parent.uid !== 0 || parent.mode & 0o022 || lstatSync(dirname(path)).isSymbolicLink() || lstatSync(path).isSymbolicLink()
        || statfsSync(path).type !== 0x6e736673
        || statSync(path, { bigint: true }).ino.toString() !== namespace.mountNamespaceInode)
        throw new CustodyResourceError("namespace-changed", "Pinned namespace handle is not its registered trusted inode");
      return;
    }
    const processStat = readFileSync(`/proc/${namespace.pid}/stat`, "utf8");
    const fields = processStat.slice(processStat.lastIndexOf(")") + 2).split(/\s+/);
    if (fields[19] !== namespace.startTicks || statSync(`/proc/${namespace.pid}/ns/mnt`, { bigint: true }).ino.toString() !== namespace.mountNamespaceInode)
      throw new CustodyResourceError("namespace-changed", "Registered custody process birth or mount namespace changed");
  } catch (error) {
    if (error instanceof CustodyResourceError) throw error;
    throw new CustodyResourceError("resource-unavailable", `Registered custody namespace is unavailable: ${String(error)}`);
  }
}
const bridge = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./custody-bridge.py" : "../../src/core/custody-bridge.py", import.meta.url));
type Identity = { dev: string; ino: string; mode: number };

/** Resource handles and UID/namespace IO only; no controller, store or model loop. */
export class CustodyResources {
  private namespaceFd: number;
  private directories = new Map<string, number>();
  private closed = false;
  constructor(readonly custody: CoreCustody) {
    assertCustodyNamespace(custody);
    this.namespaceFd = openSync(namespacePath(custody), constants.O_RDONLY);
    if (custody.namespace.kind !== "host" && fstatSync(this.namespaceFd, { bigint: true }).ino.toString() !== custody.namespace.mountNamespaceInode) {
      closeSync(this.namespaceFd);
      throw new CustodyResourceError("namespace-changed", "Registered namespace changed during acquisition");
    }
  }
  assert(): void {
    if (this.closed) throw new CustodyResourceError("resource-unavailable", "Custody resources are detached");
    assertCustodyNamespace(this.custody);
  }
  private current(): boolean { return fstatSync(this.namespaceFd, { bigint: true }).ino === statSync("/proc/self/ns/mnt", { bigint: true }).ino; }
  private proxy(): boolean { return !this.current() || process.getuid?.() !== this.custody.uid; }
  private canonical(logical: string): void {
    if (!isAbsolute(logical) || resolve(logical) !== logical || logical.includes("\0")) throw new CustodyResourceError("outside-boundary", "Custody paths must be canonical absolute paths");
  }
  private native(logical: string, directory = false): void {
    this.canonical(logical);
    const root = directory ? logical : dirname(logical);
    if (![join(this.custody.socketDir, "thread-runners"), join(this.custody.socketDir, "thread-sockets")].includes(root))
      throw new CustodyResourceError("outside-boundary", "Native resource is outside its registered directory");
  }
  directory(logical: string): string {
    this.assert(); this.canonical(logical);
    if (this.current()) return logical;
    const namespace = this.custody.namespace;
    if (namespace.kind === "pinned") throw new CustodyResourceError("resource-unavailable", "Shared data namespace has not been joined at core launch");
    return `/proc/${namespace.kind === "host" ? 1 : namespace.pid}/root${logical}`;
  }
  private metadata<T>(operation: "stat" | "entries", logical: string): T {
    this.assert(); this.native(logical, operation === "entries");
    const command = this.launch(["/usr/bin/python3", bridge, operation, logical]);
    return JSON.parse(execFileSync(command[0]!, command.slice(1), { encoding: "utf8", env: { PATH: "/usr/bin:/bin", LANG: "C" }, timeout: 5000, maxBuffer: 1024 * 1024 })) as T;
  }
  identity(logical: string): Identity | null {
    this.assert(); this.native(logical);
    if (this.proxy()) return this.metadata<Identity | null>("stat", logical);
    try {
      const value = lstatSync(logical, { bigint: true });
      if (value.isSymbolicLink()) throw new CustodyResourceError("outside-boundary", "Native resource cannot redirect to another boundary");
      return { dev: value.dev.toString(), ino: value.ino.toString(), mode: Number(value.mode) };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  exists(logical: string): boolean { return this.identity(logical) !== null; }
  entries(logical: string): string[] {
    this.assert(); this.native(logical, true);
    if (this.proxy()) return this.metadata<string[]>("entries", logical);
    try { return readdirSync(logical); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  socket(logical: string): string {
    this.assert(); this.native(logical);
    const directory = dirname(logical), path = this.directory(directory);
    try { if (lstatSync(`${path}/${logical.slice(directory.length + 1)}`).isSymbolicLink()) throw new CustodyResourceError("outside-boundary", "Native socket cannot redirect to another boundary"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (this.current()) return logical;
    let fd = this.directories.get(directory);
    if (fd === undefined) { fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY); this.directories.set(directory, fd); }
    const pinned = fstatSync(fd, { bigint: true }), current = statSync(path, { bigint: true });
    if (pinned.dev !== current.dev || pinned.ino !== current.ino) throw new CustodyResourceError("namespace-changed", "Registered native socket directory was replaced");
    return `/proc/self/fd/${fd}/${logical.slice(directory.length + 1)}`;
  }
  connection(logical: string): Socket {
    this.assert(); this.native(logical);
    return this.proxy() ? custodySocket(this.launch(["/usr/bin/python3", bridge, "socket", logical])) : createConnection(this.socket(logical));
  }
  launch(command: string[]): string[] {
    this.assert();
    const sameUid = process.getuid?.() === this.custody.uid && process.getgid?.() === this.custody.gid;
    if (sameUid && this.current()) return command;
    return [...(process.getuid?.() === 0 ? [] : ["/usr/bin/sudo", "-n"]),
      ...(this.current() ? [] : ["/usr/bin/nsenter", `--mount=/proc/${process.pid}/fd/${this.namespaceFd}`, "--"]),
      "/usr/bin/setpriv", `--reuid=${this.custody.uid}`, `--regid=${this.custody.gid}`, "--clear-groups", "--", ...command];
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const fd of this.directories.values()) closeSync(fd);
    this.directories.clear(); closeSync(this.namespaceFd);
  }
}
