import { existsSync, unlinkSync } from "node:fs";
import { createServer, type Socket } from "node:net";

const [socketPath, cwd, encodedArgs] = process.argv.slice(2);
if (!socketPath || !cwd || !encodedArgs) throw new Error("runtime-host requires socket path, cwd, and command arguments");
const args = JSON.parse(Buffer.from(encodedArgs, "base64url").toString("utf8")) as string[];
if (!Array.isArray(args) || args.length === 0 || args.some((value) => typeof value !== "string")) {
  throw new Error("runtime-host received invalid command arguments");
}

if (existsSync(socketPath)) throw new Error(`runtime host socket already exists: ${socketPath}`);
let client: Socket | null = null;
let input = "";
let sequence = 0;
let acknowledged = 0;
let stopping = false;
type Output = { type: "output"; sequence: number; line: string };
const buffered: Output[] = [];

function send(value: unknown) {
  if (client?.writable) client.write(`${JSON.stringify(value)}\n`);
}

function publish(line: string) {
  const output: Output = { type: "output", sequence: ++sequence, line };
  buffered.push(output);
  send(output);
}

async function consume(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    while (true) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      let line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line) onLine(line);
    }
  }
  pending += decoder.decode();
  if (pending) onLine(pending.endsWith("\r") ? pending.slice(0, -1) : pending);
}

const child = Bun.spawn(args, {
  cwd,
  detached: true,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
  env: process.env,
});

function childGroupAlive() {
  try { process.kill(-child.pid, 0); return true; }
  catch { return false; }
}

async function stopChild() {
  if (stopping) return;
  stopping = true;
  try { process.kill(-child.pid, "SIGTERM"); }
  catch { try { child.kill("SIGTERM"); } catch {} }
  const deadline = Date.now() + 2_000;
  while (childGroupAlive() && Date.now() < deadline) await Bun.sleep(50);
  if (childGroupAlive()) {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  }
}

function handle(value: any) {
  if (value?.type === "attach") {
    send({ type: "attached", pid: child.pid, sequence });
    setTimeout(() => {
      for (const output of buffered) if (output.sequence > Number(value.after ?? 0)) send(output);
    }, 0);
    return;
  }
  if (value?.type === "ack") {
    acknowledged = Math.max(acknowledged, Number(value.sequence ?? 0));
    while (buffered[0]?.sequence <= acknowledged) buffered.shift();
    return;
  }
  if (value?.type === "command") {
    child.stdin.write(`${JSON.stringify(value.value)}\n`);
    child.stdin.flush();
    return;
  }
  if (value?.type === "terminate") void stopChild();
}

const server = createServer((socket) => {
  client?.destroy();
  client = socket;
  input = "";
  socket.setNoDelay(true);
  socket.on("data", (chunk) => {
    input += chunk.toString("utf8");
    while (true) {
      const newline = input.indexOf("\n");
      if (newline < 0) break;
      let line = input.slice(0, newline);
      input = input.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) continue;
      try { handle(JSON.parse(line)); }
      catch (cause) { send({ type: "host_error", error: cause instanceof Error ? cause.message : String(cause) }); }
    }
  });
  socket.on("close", () => { if (client === socket) client = null; });
  socket.on("error", () => {});
});
server.listen(socketPath);

void consume(child.stdout, publish);
void consume(child.stderr, (line) => console.error(line));

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void stopChild());
}

const exitCode = await child.exited;
send({ type: "exit", code: exitCode });
server.close();
try { unlinkSync(socketPath); } catch {}
setTimeout(() => process.exit(0), 100).unref();
