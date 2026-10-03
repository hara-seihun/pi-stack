import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { KenanKeys } from "./one-kenan-keys";
import { KenanMounts } from "./one-kenan-mounts";
import { listPersons } from "./persons";
import { oneKenanConfig } from "./one-kenan";

const config = oneKenanConfig();
if (!config) throw new Error("One Kenan custody is disabled by the host flag");
const socket = config.custodySocket;
mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
if (existsSync(socket)) {
  try {
    await fetch("http://custody/status", { unix: socket, signal: AbortSignal.timeout(500) } as RequestInit);
    throw new Error("A custody service already owns the socket");
  } catch (cause) {
    if (cause instanceof Error && cause.message === "A custody service already owns the socket") throw cause;
    unlinkSync(socket);
  }
}
const identity = (flag: string) => {
  const result = Bun.spawnSync(["id", flag, config.executionUser], { stdout: "pipe", stderr: "pipe" });
  const value = Number(result.stdout.toString().trim());
  if (result.exitCode !== 0 || !Number.isInteger(value) || value <= 0) throw new Error("Kenan execution account is not prepared");
  return value;
};
const mounts = new KenanMounts({ userFor: person => person.user === "_kenan_store" ? config.executionUser : person.user,
  forceOwner: { uid: identity("-u"), gid: identity("-g") } });
const privateDir = process.env.PI_KENAN_PRIVATE_DIR ?? "/var/lib/pi-kenan/private";
const sharedCipher = process.env.PI_KENAN_SHARED_CIPHER ?? "/var/lib/pi-kenan/.private.crypt";
const keys = new KenanKeys(process.env.PI_KENAN_KEY_STORE ?? "/var/lib/pi-kenan/custody/keys.json", listPersons(), (person, key) => mounts.mount(person, key), async master => {
  const password = master.toString("hex");
  if (!existsSync(join(sharedCipher, "gocryptfs.conf"))) {
    mkdirSync(sharedCipher, { recursive: true, mode: 0o700 });
    const init = Bun.spawn(["runuser", "-u", config.executionUser, "--", "gocryptfs", "-q", "-nosyslog", "-init", "--", sharedCipher], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
    init.stdin.write(`${password}\n`); init.stdin.end();
    const errors = new Response(init.stderr).text();
    const code = await init.exited; await errors;
    if (code !== 0) return { ok: false, status: 503, error: "Kenan's encrypted shared storage could not initialize" };
  }
  return mounts.mount({ version: 1, user: "_kenan_store", displayName: "Kenan storage", port: 1,
    unlock: { cipherDir: sharedCipher, mountpoint: privateDir }, environment: {} }, password);
});
const provider = process.env.PI_KENAN_MASTER_CREDENTIAL;
if (provider) {
  const master = readFileSync(provider);
  const opened = await keys.unlockFromProvider(master);
  master.fill(0);
  if (!opened.ok) throw new Error(opened.error);
}
const service = Bun.serve({ unix: socket, async fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === "/status" && req.method === "GET") return Response.json(keys.status());
  const match = /^\/authenticate\/([a-z_][a-z0-9_-]{0,31})$/.exec(path);
  if (!match || req.method !== "POST") return new Response("Not found", { status: 404 });
  if (Number(req.headers.get("content-length")) > 8192) return new Response("Key too large", { status: 413 });
  const text = await req.text();
  if (Buffer.byteLength(text) > 8192) return new Response("Key too large", { status: 413 });
  const body = (() => { try { return JSON.parse(text); } catch { return null; } })();
  if (typeof body?.key !== "string") return Response.json({ ok: false, error: "Key required" }, { status: 400 });
  const result = await keys.authenticate(match[1]!, body.key);
  return Response.json(result, { status: result.ok ? 200 : result.status });
} });
chmodSync(socket, 0o600);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await service.stop(true);
  await mounts.close();
  if (existsSync(socket)) unlinkSync(socket);
  process.exit(0);
}
process.on("SIGTERM", close);
process.on("SIGINT", close);
console.log("Kenan custody ready; first enrolled login opens folders after reboot");
