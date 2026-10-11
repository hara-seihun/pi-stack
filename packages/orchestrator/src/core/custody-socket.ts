import { spawn } from "node:child_process";
import { Duplex } from "node:stream";
import type { Socket } from "node:net";

/** A namespace/UID helper owns only a Unix connection, never native execution. */
export function custodySocket(command: string[]): Socket {
  const child = spawn(command[0]!, command.slice(1), { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", LANG: "C" } });
  let connected = false, prefix = Buffer.alloc(0), errorText = "";
  const stream = new Duplex({
    read() { child.stdout.resume(); },
    write(chunk, encoding, callback) { child.stdin.write(chunk, encoding, callback); },
    final(callback) { child.stdin.end(callback); },
    destroy(error, callback) { child.kill("SIGTERM"); child.stdin.destroy(); child.stdout.destroy(); callback(error); },
  });
  Object.assign(stream, { setNoDelay() { return stream; } });
  child.stderr.on("data", chunk => { if (errorText.length < 4096) errorText += chunk.toString(); });
  child.stdout.on("data", chunk => {
    if (!connected) {
      prefix = Buffer.concat([prefix, chunk]);
      const end = prefix.indexOf(10);
      if (end < 0) { if (prefix.length > 1024) stream.destroy(new Error("Invalid custody socket handshake")); return; }
      try {
        if (JSON.parse(prefix.subarray(0, end).toString()).connected !== true) throw new Error("Custody socket did not connect");
      } catch (error) { stream.destroy(error instanceof Error ? error : new Error(String(error))); return; }
      connected = true;
      stream.emit("connect");
      const remainder = prefix.subarray(end + 1);
      prefix = Buffer.alloc(0);
      if (remainder.length && !stream.push(remainder)) child.stdout.pause();
    } else if (!stream.push(chunk)) child.stdout.pause();
  });
  child.on("error", error => stream.destroy(error));
  child.on("close", code => {
    if (!connected || code !== 0 && !stream.destroyed) {
      let error = new Error(errorText.trim() || `Custody socket bridge exited ${code}`);
      try { const detail = JSON.parse(errorText); error = Object.assign(new Error(detail.error), { code: detail.code, syscall: "connect" }); } catch {}
      stream.destroy(error);
    } else { stream.push(null); stream.destroy(); }
  });
  child.stdin.on("error", error => { if (!stream.destroyed) stream.destroy(error); });
  return stream as unknown as Socket;
}
