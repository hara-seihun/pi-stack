import { custodyMkdirSync as mkdirSync } from "../shared-custody.js";
import { rmSync, statSync, utimesSync } from "node:fs";

const LOCK_STALE_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Uses the same `<target>.lock` directory and heartbeat convention as proper-lockfile. */
export async function acquireDirectoryLock(
  targetPath: string,
  signal: AbortSignal,
  timeoutMessage: string,
): Promise<() => void> {
  const lockPath = `${targetPath}.lock`;
  const deadline = Date.now() + LOCK_STALE_MS;
  while (true) {
    signal.throwIfAborted();
    try {
      mkdirSync(lockPath, { mode: 0o770 });
      const heartbeat = setInterval(() => {
        try {
          const time = new Date();
          utimesSync(lockPath, time, time);
        } catch {}
      }, 10_000);
      return () => {
        clearInterval(heartbeat);
        try {
          rmSync(lockPath, { recursive: true, force: true });
        } catch {}
      };
    } catch (cause: any) {
      if (cause?.code !== "EEXIST") throw cause;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {}
      if (Date.now() >= deadline) throw new Error(timeoutMessage);
      await sleep(25 + Math.floor(Math.random() * 75));
    }
  }
}
