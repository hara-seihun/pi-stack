import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readlinkSync, renameSync, statfsSync, symlinkSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, isAbsolute, join } from "node:path";

export type SocketResult<T> = { ok: true; value: T } | { ok: false; kind: "occupied" | "invalid"; error: string };
const failure = (kind: "occupied" | "invalid", error: string): SocketResult<never> => ({ ok: false, kind, error });
const missing = (cause: unknown) => (cause as NodeJS.ErrnoException).code === "ENOENT";

export async function proveSocketAbsent(path: string): Promise<SocketResult<void>> {
  return new Promise(resolve => {
    const probe = createConnection(path);
    const finish = (result: SocketResult<void>) => { clearTimeout(timer); probe.destroy(); resolve(result); };
    const timer = setTimeout(() => finish(failure("occupied", "Meet listener absence is uncertain")), 1000);
    probe.once("connect", () => finish(failure("occupied", "Meet listener is still accepting work")));
    probe.once("error", cause => {
      const code = (cause as NodeJS.ErrnoException).code;
      finish(code === "ECONNREFUSED" || code === "ENOENT" ? { ok: true, value: undefined } : failure("invalid", `Meet listener absence could not be proved: ${cause}`));
    });
  });
}

export function validRuntimeSocketName(name: string, instance: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(instance) && name === `meet-${instance}.sock`;
}
export function runtimeHostDirectory(): string {
  const callback = process.env.PI_CORE_CALLBACK_SOCKET;
  if (!callback || !isAbsolute(callback)) throw new Error("Meet requires its explicit registered host callback socket");
  return dirname(callback);
}

export class MeetSocketOwner {
  readonly instance = crypto.randomUUID();
  readonly endpoint: string;
  readonly name: string;
  private identity: { dev: number; ino: number } | null = null;
  private published = false;
  private closed = false;
  private constructor(readonly socket: string, private readonly fd: number, hostDirectory: string) {
    this.name = `meet-${this.instance}.sock`;
    this.endpoint = join(hostDirectory, this.name);
  }

  static acquire(socket: string, callbackSocket: string | undefined, uid: number): SocketResult<MeetSocketOwner> {
    if (!callbackSocket || !isAbsolute(callbackSocket) || dirname(callbackSocket) === dirname(socket)) return failure("invalid", "Meet requires its registered host callback socket outside the encrypted data view");
    let fd: number | undefined;
    try {
      const directory = dirname(callbackSocket), stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.uid !== uid || stat.mode & 0o022 || statfsSync(directory).type === 0x65735546) return failure("invalid", "Meet host socket directory is not its protected non-FUSE owner namespace");
      const lock = join(directory, "meet-runtime.owner.lock");
      fd = openSync(lock, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      const identity = fstatSync(fd), named = lstatSync(lock);
      if (!identity.isFile() || identity.uid !== uid || (identity.mode & 0o777) !== 0o600 || named.dev !== identity.dev || named.ino !== identity.ino) throw new Error("Meet owner lock is outside its registered custody");
      const locked = spawnSync("/usr/bin/flock", ["--exclusive", "--nonblock", "3"], { stdio: ["ignore", "pipe", "pipe", fd], timeout: 1000 });
      if (locked.status === 1 && !locked.error) { closeSync(fd); return failure("occupied", "Meet runtime has another host-namespace lifetime owner"); }
      if (locked.status !== 0 || locked.error) throw new Error("Meet owner lock acquisition failed");
      return { ok: true, value: new MeetSocketOwner(socket, fd, directory) };
    } catch (cause) { if (fd !== undefined) closeSync(fd); return failure("invalid", `Meet socket ownership failed: ${cause}`); }
  }

  captureBoundEndpoint(): void {
    chmodSync(this.endpoint, 0o600);
    const stat = lstatSync(this.endpoint);
    if (!stat.isSocket() || (stat.mode & 0o777) !== 0o600) throw new Error("Meet bound endpoint is not its private generation socket");
    this.identity = { dev: stat.dev, ino: stat.ino };
  }

  async publish(): Promise<SocketResult<void>> {
    if (!this.identity || this.closed) return failure("invalid", "Meet generation has no owned bound endpoint");
    const absent = await proveSocketAbsent(this.socket);
    if (!absent.ok) return absent;
    const temporary = `${this.socket}.${this.instance}`;
    try {
      symlinkSync(this.endpoint, temporary);
      renameSync(temporary, this.socket);
      this.published = true;
      return { ok: true, value: undefined };
    } catch (cause) {
      try { if (readlinkSync(temporary) === this.endpoint) unlinkSync(temporary); } catch (error) { if (!missing(error)) return failure("invalid", `Meet failed publication cleanup: ${error}`); }
      return failure("invalid", `Meet generation publication failed: ${cause}`);
    }
  }

  // The endpoint is unique and Bun binds only it. Its stop cannot unlink the shared name.
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.published) {
        try { if (readlinkSync(this.socket) === this.endpoint) unlinkSync(this.socket); }
        catch (cause) { if (!missing(cause) && (cause as NodeJS.ErrnoException).code !== "EINVAL") throw cause; }
      }
      if (this.identity && existsSync(this.endpoint)) {
        const stat = lstatSync(this.endpoint);
        if (stat.isSocket() && stat.dev === this.identity.dev && stat.ino === this.identity.ino) unlinkSync(this.endpoint);
      }
    } finally { closeSync(this.fd); }
  }
}
