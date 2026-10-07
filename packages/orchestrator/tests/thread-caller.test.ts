import { createServer, request as httpRequest, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { admissionFor, callerResolver, loopbackPeer, peerCaller, piProcessRole, threadCapability, THREAD_TOKEN_HEADER, UPSTREAM_CREDENTIAL_HEADER,
  type ThreadCaller } from "../src/threads/caller.js";
import { threadHttp } from "../src/threads/http.js";
import { ThreadService } from "../src/threads/service.js";
import { createHash } from "node:crypto";
import type { PiCommand, PiEvent, PiSession, PiSessionOptions } from "../src/threads/contracts.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const temp = (prefix: string) => { const root = mkdtempSync(join(tmpdir(), prefix)); cleanups.push(() => rmSync(root, { recursive: true, force: true })); return root; };

class IdleSession implements PiSession {
  isStreaming = false; pendingMessageCount = 0; closed = false;
  constructor(readonly options: PiSessionOptions, private readonly output: (event: PiEvent) => void) {}
  async command(command: PiCommand): Promise<void> {
    this.output({ type: "response", id: command.id, command: command.type, success: true,
      data: command.type === "get_state" ? { isStreaming: false, pendingMessageCount: 0, sessionFile: this.options.sessionFile, acceptedWorkIds: [], completedWorkIds: [] } : {} });
  }
  async close(): Promise<void> { this.closed = true; }
}

function owner() {
  const root = temp("thread-caller-");
  const capability = threadCapability(join(root, "state", "thread-capability.key"));
  const sessions: IdleSession[] = [];
  const service = new ThreadService({ capacity: { mode: "unmanaged" }, databasePath: join(root, "threads.sqlite3"), sessionsDir: root, capability,
    openSession: async (options, output) => { const session = new IdleSession(options, output); sessions.push(session); return session; } });
  cleanups.push(async () => { await service.close(); });
  return { root, capability, service, sessions };
}

/** Calls the thread HTTP boundary as a given caller. */
function as(harness: ReturnType<typeof owner>, caller: ThreadCaller | "socket", headers: Record<string, string> = {}, attest?: (pid: number) => Promise<unknown>) {
  const resolver = callerResolver({ capability: harness.capability, peer: () => caller as ThreadCaller, attest,
    host: { upstreamCredentials: [createHash("sha256").update("upstream-secret").digest("hex")] } });
  return async (operation: string, body: unknown) => {
    const request = new Request(`http://owner/v1/threads/${operation}`, { method: "POST", headers, body: JSON.stringify(body) });
    const response = (await threadHttp(harness.service, request, "/v1/threads",
      admissionFor(resolver, { headers: request.headers, socket: { address: "127.0.0.1", port: 1, localAddress: "127.0.0.1", localPort: 2 } })))!;
    return { status: response.status, body: await response.json() as any };
  };
}

describe("thread capability", () => {
  it("issues a verifiable per-thread token from a private per-user key", () => {
    const root = temp("thread-capability-"), path = join(root, "state", "key");
    const capability = threadCapability(path);
    const token = capability.issue("thread-a");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(capability.verify(token)).toBe("thread-a");
    expect(threadCapability(path).verify(token)).toBe("thread-a");
    expect(capability.verify(token.replace("thread-a", "thread-b"))).toBeUndefined();
    expect(capability.verify(`${token.slice(0, -2)}xx`)).toBeUndefined();
    expect(threadCapability(join(root, "other")).verify(token)).toBeUndefined();
  });

  it("puts each session's own token in its environment", async () => {
    const harness = owner();
    await harness.service.start();
    expect((await harness.service.spawn({ requestId: "a", id: "thread-a", cwd: harness.root, message: "go" })).ok).toBe(true);
    for (let attempt = 0; attempt < 50 && !harness.sessions.length; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(harness.capability.verify(harness.sessions[0]!.options.env.PI_THREAD_TOKEN!)).toBe("thread-a");
  });
});

describe("thread API admission", () => {
  it("accepts idle human and service view controls through the HTTP boundary", async () => {
    const harness = owner();
    const spawned = await harness.service.spawn({ requestId: "view", id: "view", cwd: harness.root });
    expect(spawned.ok).toBe(true);
    const before = harness.service.get("view")!;
    for (const caller of [{ kind: "person", via: "router" }, { kind: "service", pid: 10 }] as const) {
      const response = await as(harness, caller)("control", { threadId: "view", action: "view" });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ ok: true, value: { updatedAt: before.updatedAt, revision: before.revision,
        metadata: { autoArchiveViewedAt: expect.any(Number) } } });
      expect(response.body.value.metadata.autoArchiveViewedAt).toBeGreaterThanOrEqual(before.updatedAt);
    }
    const forged = await as(harness, { kind: "service", pid: 10 })("control", { threadId: "view", action: "view", timestamp: 1 });
    expect(forged.body).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(harness.sessions).toHaveLength(0);
  });

  it("refuses a local process that names a parent and stamps its roots as process-created", async () => {
    const harness = owner();
    expect((await harness.service.spawn({ requestId: "parent", id: "parent", cwd: harness.root })).ok).toBe(true);
    const local = as(harness, { kind: "process", uid: 1000, pid: 4242, command: "curl" }, {}, async pid => ({ mode: "restricted", pid }));
    const forged = await local("spawn", { requestId: "forged", cwd: harness.root, parentId: "parent" });
    expect(forged.status).toBe(403);
    expect(harness.service.get("forged")).toBeFalsy();
    const root = await local("spawn", { requestId: "root", id: "root", cwd: harness.root,
      createdBy: { kind: "person", via: "router" }, metadata: { createdBy: { kind: "person", via: "router" } } });
    expect(root.status).toBe(200);
    expect(harness.service.get("root")!.metadata!.createdBy).toEqual({ kind: "process", uid: 1000, pid: 4242, command: "curl", attestation: { mode: "restricted", pid: 4242 } });
  });

  it("lets a thread create only its own children and records it as the creator", async () => {
    const harness = owner();
    for (const id of ["parent", "other"]) expect((await harness.service.spawn({ requestId: id, id, cwd: harness.root })).ok).toBe(true);
    const thread = as(harness, "socket", { [THREAD_TOKEN_HEADER]: harness.capability.issue("parent") });
    expect((await thread("spawn", { requestId: "stolen", cwd: harness.root, parentId: "other" })).status).toBe(403);
    const child = await thread("spawn", { requestId: "child", id: "child", cwd: harness.root, parentId: "parent" });
    expect(child.status).toBe(200);
    expect(harness.service.get("child")).toMatchObject({ parentId: "parent", metadata: { createdBy: { kind: "thread", threadId: "parent" } } });
    const root = await thread("spawn", { requestId: "detached", id: "detached", cwd: harness.root });
    expect(harness.service.get("detached")!.metadata!.createdBy).toEqual({ kind: "thread", threadId: "parent" });
    expect(root.status).toBe(200);
    const forgedToken = as(harness, "socket", { [THREAD_TOKEN_HEADER]: "pit1.parent.not-a-mac" });
    expect((await forgedToken("spawn", { requestId: "bad", cwd: harness.root })).status).toBe(401);
  });

  it("requires a sender's own capability, and never lets a thread speak as a person", async () => {
    const harness = owner();
    for (const id of ["sender", "recipient"]) expect((await harness.service.spawn({ requestId: id, id, cwd: harness.root })).ok).toBe(true);
    const message = { threadId: "recipient", senderId: "sender", text: "push it", delivery: "steer" };
    expect((await as(harness, { kind: "process", uid: 1000, pid: 7 })("send", { ...message, requestId: "m1" })).status).toBe(403);
    expect((await as(harness, "socket", { [THREAD_TOKEN_HEADER]: harness.capability.issue("recipient") })("send", { ...message, requestId: "m3" })).status).toBe(403);
    const own = as(harness, "socket", { [THREAD_TOKEN_HEADER]: harness.capability.issue("sender") });
    expect((await own("send", { threadId: "recipient", text: "as a human", requestId: "m4" })).status).toBe(403);
    expect((await own("send", { ...message, requestId: "m5" })).body.ok).toBe(true);
    expect((await as(harness, { kind: "runtime", pid: 9 })("send", { ...message, requestId: "m6" })).body.ok).toBe(true);
    expect((await as(harness, { kind: "process", uid: 1000, pid: 7 })("send", { threadId: "recipient", text: "human queue", requestId: "m7" })).body.ok).toBe(true);
  });

  it("trusts the Pi runtime's parent claim, a service's forwarded creator, and a trusted upstream router", async () => {
    const harness = owner();
    expect((await harness.service.spawn({ requestId: "parent", id: "parent", cwd: harness.root })).ok).toBe(true);
    expect((await as(harness, { kind: "runtime", pid: 9 })("spawn", { requestId: "r", id: "r", cwd: harness.root, parentId: "parent" })).status).toBe(200);
    expect(harness.service.get("r")!.metadata!.createdBy).toEqual({ kind: "thread", threadId: "parent" });
    const forwarded = { kind: "process", uid: 1000, pid: 5, command: "curl" };
    expect((await as(harness, { kind: "service", pid: 10 })("spawn", { requestId: "s", id: "s", cwd: harness.root, createdBy: forwarded })).status).toBe(200);
    expect(harness.service.get("s")!.metadata!.createdBy).toEqual(forwarded);
    const upstream = as(harness, "socket", { [UPSTREAM_CREDENTIAL_HEADER]: "upstream-secret" });
    expect((await upstream("spawn", { requestId: "u", id: "u", cwd: harness.root })).status).toBe(200);
    expect(harness.service.get("u")!.metadata!.createdBy).toEqual({ kind: "person", via: "upstream" });
    expect((await as(harness, "socket", { [UPSTREAM_CREDENTIAL_HEADER]: "guess" })("spawn", { requestId: "g", cwd: harness.root })).status).toBe(401);
  });

  it("keeps a retried spawn's receipt identity when only the verified creator differs", async () => {
    const harness = owner();
    const body = { requestId: "retry", id: "retry", cwd: harness.root };
    expect((await as(harness, { kind: "process", uid: 1000, pid: 1 }, {}, async () => ({ mode: "interactive" }))("spawn", body)).status).toBe(200);
    const again = await as(harness, { kind: "process", uid: 1000, pid: 1 }, {}, async () => ({ mode: "restricted" }))("spawn", body);
    expect(again.body).toMatchObject({ ok: true, value: { id: "retry" } });
    expect(harness.service.get("retry")!.metadata!.createdBy).toMatchObject({ attestation: { mode: "interactive" } });
  });
});

describe("loopback peer identity", () => {
  it("names Pi Stack runners and owner services", () => {
    expect(piProcessRole(["node", "--max-old-space-size=8192", "/srv/pi/.pi-stack-releases/orchestrator/abc/dist/threads/runner-host.js", "/x.sock"])).toBe("runtime");
    expect(piProcessRole(["bun", "/srv/pi/pi-remote/server/main.ts"])).toBe("service");
    expect(piProcessRole(["node", "/srv/pi/pi-orchestrator/dist/cli.js", "daemon"])).toBe("service");
    expect(piProcessRole(["node", "/srv/pi/pi-orchestrator/dist/cli.js", "run", "--prompt", "x"])).toBeUndefined();
    expect(piProcessRole(["curl", "http://127.0.0.1:2460/v1/threads/spawn"])).toBeUndefined();
  });

  it("does not lend a runner's trust to one a thread's tools started", () => {
    const proc = temp("fake-proc-");
    const process = (pid: number, ppid: number, argv: string[]) => {
      mkdirSync(join(proc, String(pid)));
      writeFileSync(join(proc, String(pid), "cmdline"), `${argv.join("\0")}\0`);
      writeFileSync(join(proc, String(pid), "status"), `Name:\tx\nPPid:\t${ppid}\n`);
    };
    const runner = ["node", "/srv/pi/.pi-stack-releases/orchestrator/abc/dist/threads/runner-host.js", "/x.sock"];
    process(10, 1, runner); process(11, 10, ["bash", "-c", "node runner-host.js"]); process(12, 11, runner);
    expect(peerCaller({ uid: 1000, pid: 10 }, { selfUid: 1000, proc })).toEqual({ kind: "runtime", pid: 10 });
    expect(peerCaller({ uid: 1000, pid: 12 }, { selfUid: 1000, proc })).toMatchObject({ kind: "process", pid: 12 });
    expect(peerCaller({ uid: 0 }, { selfUid: 1000, proc })).toEqual({ kind: "person", via: "router" });
    expect(peerCaller({ uid: 1000 }, { selfUid: 1000, proc })).toEqual({ kind: "process", uid: 1000 });
  });

  it.skipIf(!existsSync("/proc/net/tcp"))("finds the uid and pid behind a loopback connection", async () => {
    let seen: ReturnType<typeof loopbackPeer>;
    const server: Server = createServer((req, res) => {
      seen = loopbackPeer({ address: req.socket.remoteAddress!, port: req.socket.remotePort!, localAddress: req.socket.localAddress!, localPort: req.socket.localPort! });
      res.end("ok");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => httpRequest({ host: "127.0.0.1", port, path: "/" }, res => { res.resume(); res.on("end", resolve); }).on("error", reject).end());
    expect(seen!).toEqual({ uid: process.getuid!(), pid: process.pid });
  });
});
