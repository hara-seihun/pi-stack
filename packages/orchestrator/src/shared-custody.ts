import * as custodyFs from "node:fs";
import { dirname as custodyDirname, resolve as custodyResolve } from "node:path";

export function sharedOwner(env = process.env, uid = process.getuid?.()): { uid: number; gid: number } | undefined {
  const ownerUid = env.PI_ORCHESTRATOR_OWNER_UID;
  const ownerGid = env.PI_ORCHESTRATOR_OWNER_GID;
  if (ownerUid === undefined && ownerGid === undefined) return undefined;
  const valid = (value: string | undefined): value is string => typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) && Number(value) < 0xffffffff;
  if (!valid(ownerUid) || !valid(ownerGid) || Number(ownerUid) === 0) {
    throw new Error("Shared filesystem custody requires a non-root PI_ORCHESTRATOR_OWNER_UID and PI_ORCHESTRATOR_OWNER_GID");
  }
  // A tool may deliberately drop privilege. It already creates files as its user.
  return uid === 0 ? { uid: Number(ownerUid), gid: Number(ownerGid) } : undefined;
}

export function shareFile(target: number | string): void {
  const owner = sharedOwner();
  if (!owner) return;
  if (typeof target === "number") custodyFs.fchownSync(target, owner.uid, owner.gid);
  else custodyFs.chownSync(target, owner.uid, owner.gid);
}

export function custodyMkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): string | undefined {
  const owner = sharedOwner();
  const created = custodyFs.mkdirSync(path, options);
  if (owner) {
    const stop = custodyResolve(created ?? path);
    let current = custodyResolve(path);
    // recursive mkdir returns its first created directory, so every new ancestor
    // receives custody without changing unrelated existing parents.
    for (;;) {
      custodyFs.chownSync(current, owner.uid, owner.gid);
      if (current === stop) break;
      const parent = custodyDirname(current);
      if (parent === current) throw new Error("Shared directory is outside its creation boundary");
      current = parent;
    }
  }
  return created;
}

export function custodyOpenSync(path: string, flags: string | number, mode?: number): number {
  const fd = custodyFs.openSync(path, flags, mode);
  try {
    if (typeof flags === "number" ? (flags & (custodyFs.constants.O_WRONLY | custodyFs.constants.O_RDWR)) !== 0 : /[wa+]/.test(flags)) shareFile(fd);
    return fd;
  } catch (error) {
    custodyFs.closeSync(fd);
    throw error;
  }
}

export function custodyWriteFileSync(path: string | number, data: string, options?: custodyFs.WriteFileOptions): void {
  custodyFs.writeFileSync(path, data, options);
  shareFile(path);
}

export function custodyReplaceFileSync(path: string, data: string): void {
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = custodyOpenSync(temporary, "wx", 0o600);
    try { custodyFs.writeFileSync(fd, data); custodyFs.fsyncSync(fd); }
    finally { custodyFs.closeSync(fd); }
    custodyFs.renameSync(temporary, path);
    const directory = custodyFs.openSync(custodyDirname(path), "r");
    try { custodyFs.fsyncSync(directory); }
    finally { custodyFs.closeSync(directory); }
  } finally { custodyFs.rmSync(temporary, { force: true }); }
}

// proper-lockfile accepts an fs implementation. Transfer each lock directory
// before its acquisition callback, including its synchronous lock path.
export const custodyLockFs = {
  ...custodyFs,
  mkdirSync: custodyMkdirSync,
  mkdir(path: string, callback: custodyFs.NoParamCallback) {
    custodyFs.mkdir(path, error => {
      if (error) return callback(error);
      try { shareFile(path); }
      catch (failure) { callback(failure as NodeJS.ErrnoException); return; }
      callback(null);
    });
  },
};
