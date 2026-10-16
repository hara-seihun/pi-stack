import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, renameSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export class RunnerOwnershipError extends Error {
  constructor(readonly code: "ownership-uncertain" | "ownership-conflict", message: string) { super(message); this.name = "RunnerOwnershipError"; }
}
export interface NativeRunnerOwner { version: 1; dataDir: string; uid: number; control: string; pid: number; startTicks: string }
export function nativeRunnerLock(dataDir: string, uid: number): string {
  if (!isAbsolute(dataDir) || !Number.isSafeInteger(uid) || uid < 0) throw new RunnerOwnershipError("ownership-uncertain", "Native storage requires an absolute registered directory and UID");
  return join("/run/pi-stack/native-runner-locks", String(uid), `${createHash("sha256").update(resolve(dataDir)).digest("hex")}.lock`);
}
export function validateNativeRunnerDirectory(path: string, uid: number): void {
  const directory = dirname(path), value = lstatSync(directory);
  if (!value.isDirectory() || realpathSync(directory) !== directory || value.uid !== uid || (value.mode & 0o777) !== 0o700 || statfsSync(directory).type !== 0x01021994) {
    throw new RunnerOwnershipError("ownership-uncertain", "Native ownership requires its registered UID-owned 0700 host tmpfs directory");
  }
}
export function nativeProcessBirth(pid: number): string {
  const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/);
  if (!/^\d+$/.test(fields[19] ?? "")) throw new RunnerOwnershipError("ownership-uncertain", "Native process birth is unavailable");
  return fields[19]!;
}
export function nativeLockHolders(path: string): number[] {
  let info;
  try { info = lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  if (!info.isFile()) throw new RunnerOwnershipError("ownership-uncertain", "Native ownership lock is not a regular file");
  const dev = BigInt(info.dev), major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n), minor = (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n);
  return readFileSync("/proc/locks", "utf8").split("\n").flatMap(line => {
    const fields = line.trim().split(/\s+/), identity = fields[5]?.split(":");
    if (fields[1] !== "FLOCK" || fields[3] !== "WRITE" || identity?.length !== 3) return [];
    return BigInt(`0x${identity[0]}`) === major && BigInt(`0x${identity[1]}`) === minor && BigInt(identity[2]!) === BigInt(info.ino) ? [Number(fields[4])] : [];
  });
}
export function nativeStorageOwner(dataDir: string, uid: number): NativeRunnerOwner | null {
  const path = nativeRunnerLock(dataDir, uid);
  validateNativeRunnerDirectory(path, uid);
  if (!nativeLockHolders(path).length) {
    try {
      const prior = JSON.parse(readFileSync(path.replace(/\.lock$/, ".owner.json"), "utf8"));
      if (prior.version !== 1 || prior.dataDir !== resolve(dataDir) || prior.uid !== uid || !Number.isSafeInteger(prior.pid) || prior.pid <= 0 || typeof prior.startTicks !== "string") throw new Error("Invalid native ownership metadata");
      if (nativeProcessBirth(prior.pid) === prior.startTicks) throw new RunnerOwnershipError("ownership-uncertain", "Recorded native owner remains alive without its physical lease");
    } catch (error) {
      if (error instanceof RunnerOwnershipError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ESRCH") throw new RunnerOwnershipError("ownership-uncertain", "Native ownership metadata cannot establish absence");
    }
    return null;
  }
  let owner: NativeRunnerOwner;
  try {
    const metadata = path.replace(/\.lock$/, ".owner.json"), info = lstatSync(metadata);
    if (!info.isFile() || ![0, uid].includes(info.uid) || (info.mode & 0o022)) throw new Error("Unsafe native owner metadata");
    owner = JSON.parse(readFileSync(metadata, "utf8"));
    if (owner.version !== 1 || owner.dataDir !== resolve(dataDir) || owner.uid !== uid || !isAbsolute(owner.control) || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.startTicks !== "string" || nativeProcessBirth(owner.pid) !== owner.startTicks) throw new Error("Native owner identity differs");
  } catch (error) { throw new RunnerOwnershipError("ownership-uncertain", `Native storage is held without a proven reachable owner: ${error instanceof Error ? error.message : String(error)}`); }
  return owner;
}
export function publishNativeStorageOwner(dataDir: string, uid: number, control: string): NativeRunnerOwner {
  const path = nativeRunnerLock(dataDir, uid);
  validateNativeRunnerDirectory(path, uid);
  if (!nativeLockHolders(path).includes(process.pid)) throw new RunnerOwnershipError("ownership-conflict", "Runner must hold host-global storage ownership before touching native sockets");
  const owner: NativeRunnerOwner = { version: 1, dataDir: resolve(dataDir), uid, control: resolve(control), pid: process.pid, startTicks: nativeProcessBirth(process.pid) };
  const metadata = path.replace(/\.lock$/, ".owner.json"), temporary = `${metadata}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
  renameSync(temporary, metadata);
  return owner;
}
export function assertNativeStorageOwner(owner: NativeRunnerOwner): void {
  const actual = nativeStorageOwner(owner.dataDir, owner.uid);
  if (!actual || actual.pid !== owner.pid || actual.startTicks !== owner.startTicks || actual.control !== owner.control || !nativeLockHolders(nativeRunnerLock(owner.dataDir, owner.uid)).includes(process.pid)) throw new RunnerOwnershipError("ownership-conflict", "Native storage ownership changed; refusing socket or session mutation");
}
