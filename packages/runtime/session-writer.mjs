import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, fchownSync, fstatSync, openSync, realpathSync, statfsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export class SessionWriterError extends Error {
  constructor(code, message, cause) {
    super(message, { cause });
    this.name = "SessionWriterError";
    this.code = code;
  }
}
const failure = (code, message, cause) => ({ ok: false, error: new SessionWriterError(code, message, cause) });
const localFilesystems = new Set([0xef53, 0x58465342, 0x9123683e, 0x01021994, 0x794c7630]);
const configurationKey = Symbol.for("pi.stack.session-writer.configuration");
const configuration = globalThis[configurationKey] ??= new AsyncLocalStorage();
export function withSessionWriterConfiguration(config, callback) {
  return configuration.run(Object.freeze({ directory: config.directory, scope: config.scope }), callback);
}
export function sessionWriterConfiguration() {
  const explicit = configuration.getStore();
  if (explicit) return explicit;
  const environment = globalThis[Symbol.for("pi-stack.session-environment")]?.getStore() ?? process.env;
  return Object.freeze({ directory: environment.PI_SESSION_WRITER_DIRECTORY, scope: environment.PI_SESSION_WRITER_SCOPE });
}
const trackingKey = Symbol.for("pi.stack.session-writer.pending");
const tracking = globalThis[trackingKey] ??= new AsyncLocalStorage();
export function trackSessionWriter(manager) { tracking.getStore()?.add(manager); }
export async function withSessionWriterScope(callback, retain) {
  const pending = new Set();
  return tracking.run(pending, async () => {
    try { return await callback(); }
    finally { for (const manager of pending) if (!retain(manager)) manager.dispose(); }
  });
}

/** A kernel flock on shared physical custody, never the encrypted session inode. */
export function acquireSessionWriter({ directory, scope, identity }) {
  if (typeof directory !== "string" || !isAbsolute(directory) || typeof scope !== "string" || !scope.trim() || typeof identity !== "string" || !identity.trim()) {
    return failure("SESSION_WRITER_CONFIGURATION", "Session writer requires an absolute physical directory, explicit source scope and canonical identity");
  }
  if (process.platform !== "linux") return failure("SESSION_WRITER_PLATFORM", "Session writer custody requires Linux flock");
  let fd;
  try {
    const physical = realpathSync(directory);
    if (!statSync(physical).isDirectory() || !localFilesystems.has(statfsSync(physical).type)) {
      return failure("SESSION_WRITER_DIRECTORY", "Session writer directory must be a precreated local physical filesystem directory outside FUSE");
    }
    const key = createHash("sha256").update(JSON.stringify([scope, identity])).digest("hex");
    const path = join(physical, `${key}.lock`);
    fd = openSync(path, "a+", 0o600);
    if (!fstatSync(fd).isFile()) {
      closeSync(fd);
      fd = undefined;
      return failure("SESSION_WRITER_DIRECTORY", "Session writer lock must be a regular physical file");
    }
    const owner = process.env.PI_ORCHESTRATOR_OWNER_UID;
    const group = process.env.PI_ORCHESTRATOR_OWNER_GID;
    if (owner !== undefined || group !== undefined) {
      if (!/^\d+$/.test(owner ?? "") || !/^\d+$/.test(group ?? "")) throw new SessionWriterError("SESSION_WRITER_CONFIGURATION", "Session writer custody UID/GID must both be explicit integers");
      if (process.getuid() === 0) fchownSync(fd, Number(owner), Number(group));
    }
    // flock locks the inherited open-file description; the parent keeps it alive.
    const result = spawnSync("/usr/bin/flock", ["--exclusive", "--nonblock", "--conflict-exit-code", "73", "3"], { stdio: ["ignore", "pipe", "pipe", fd], timeout: 2_000 });
    if (result.status !== 0) {
      closeSync(fd);
      fd = undefined;
      return result.status === 73 ? failure("SESSION_WRITER_BUSY", "Canonical session already has a writer")
        : failure("SESSION_WRITER_LOCK", "Kernel session writer lock could not be acquired", result.error ?? result.stderr?.toString());
    }
    let state = "owned";
    let poison;
    const heldFd = fd;
    fd = undefined;
    return { ok: true, value: {
      assertOwned() {
        return state === "owned" ? { ok: true, value: undefined }
          : failure(state === "released" ? "SESSION_WRITER_RELEASED" : "SESSION_WRITER_POISONED", state === "released" ? "Session writer has been released" : "Session write failed; reopen requires inspection", poison);
      },
      poison(cause) { if (state === "owned") { state = "poisoned"; poison = cause; } },
      release() {
        if (state === "released") return { ok: true, value: undefined };
        try { closeSync(heldFd); state = "released"; return { ok: true, value: undefined }; }
        catch (cause) { return failure("SESSION_WRITER_RELEASE", "Could not release canonical session writer", cause); }
      },
    } };
  } catch (cause) {
    if (fd !== undefined) closeSync(fd);
    return failure(cause instanceof SessionWriterError ? cause.code : "SESSION_WRITER_DIRECTORY", "Session writer physical custody is unavailable", cause);
  }
}

export function requireSessionWriter(result) {
  if (!result.ok) throw result.error;
  return result.value;
}

export function writeSessionBytes(fd, data, io) {
  const bytes = Buffer.from(data, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    let written;
    try { written = io.write(fd, bytes, offset, bytes.length - offset); }
    catch (cause) { if (cause?.code === "EINTR") continue; throw cause; }
    if (!Number.isInteger(written) || written <= 0 || written > bytes.length - offset) {
      throw new SessionWriterError("SESSION_WRITER_SHORT_WRITE", "Session writer made no valid forward progress");
    }
    offset += written;
  }
  io.sync(fd);
}
