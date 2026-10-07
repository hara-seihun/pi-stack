import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, expect, it, vi } from "vitest";
import type { PiEvent } from "../src/threads/contracts.js";
import { createSharedPiSessionOpener } from "../src/threads/runner-transport.js";

vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(),
  spawn: vi.fn(() => { throw new Error("Attach must not launch a runner"); }) }));
vi.mock("../src/threads/runner-memory.js", () => ({ underMemoryPressure: () => { throw new Error("Attach must not request admission"); } }));
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  expect(spawn).not.toHaveBeenCalled();
  vi.clearAllMocks();
});
function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "runner-attach-"));
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const opener = createSharedPiSessionOpener({ dataDir });
  cleanups.push(() => opener.detach());
  return { dataDir, opener, reference: { control: join(dataDir, "thread-runners/group.sock"), socketPath: join(dataDir, "thread-sockets/group.thread.sock") } };
}
async function listen(path: string, receive: (value: any, socket: Socket) => void) {
  mkdirSync(dirname(path), { recursive: true });
  const clients = new Set<Socket>();
  const server = createServer(socket => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => {});
    createInterface({ input: socket }).on("line", line => receive(JSON.parse(line), socket));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  cleanups.push(async () => { for (const socket of clients) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
}

function recoveryReference(dataDir: string, threadId: string, generation = "a".repeat(16)) {
  const threadHash = createHash("sha256").update(threadId).digest("hex").slice(0, 16);
  return { control: join(dataDir, "thread-runners", `${generation}.sock`), socketPath: join(dataDir, "thread-sockets", `${generation}.${threadHash}.sock`) };
}

it("recovers a lost reference without reopening or closing active native work", async () => {
  const { opener, dataDir } = fixture(), threadId = "active-thread", reference = recoveryReference(dataDir, threadId);
  const requests: unknown[] = [], events: PiEvent[] = [];
  await listen(reference.control, (value, socket) => {
    requests.push(value);
    socket.end(`${JSON.stringify({ ok: true, threadIds: [threadId], activeSessions: 1 })}\n`);
  });
  await listen(reference.socketPath, (_value, socket) => socket.write('{"type":"attached"}\n'));
  const session = await opener.recoverSession(threadId, event => events.push(event), () => {});
  expect(session).not.toBeNull();
  expect(requests).toEqual([{ type: "status" }]);
  expect(events).toEqual([{ type: "runner_attached", ...reference }]);
});

it("serially fences a queued open despite status omitting the thread", async () => {
  const { opener, dataDir } = fixture(), reference = recoveryReference(dataDir, "queued-thread"), requests: unknown[] = [];
  let acknowledge!: () => void;
  let fenced!: () => void;
  const reachedFence = new Promise<void>(resolve => { fenced = resolve; });
  await listen(reference.control, (value, socket) => {
    requests.push(value);
    if (value.type === "status") socket.end('{"ok":true,"threadIds":[]}\n');
    if (value.type === "close") { acknowledge = () => socket.end('{"ok":true}\n'); fenced(); }
  });
  let settled = false;
  const recovering = opener.recoverSession("queued-thread", () => {}, () => {}).then(value => { settled = true; return value; });
  await reachedFence;
  expect(settled).toBe(false);
  acknowledge();
  expect(await recovering).toBeNull();
  expect(requests).toEqual([{ type: "status" }, { type: "close", socketPath: reference.socketPath }]);
});

it("retains uncertainty when a missing-reference absence fence is refused", async () => {
  const { opener, dataDir } = fixture(), reference = recoveryReference(dataDir, "unknown-thread");
  await listen(reference.control, (value, socket) => socket.end(value.type === "close" ? '{"error":"Native work still active"}\n' : '{"ok":true,"threadIds":[]}\n'));
  await expect(opener.recoverSession("unknown-thread", () => {}, () => {})).rejects.toThrow("Native work still active");
});

it("does not close known native ownership whose session socket is not yet listening", async () => {
  const { opener, dataDir } = fixture(), threadId = "initializing", reference = recoveryReference(dataDir, threadId), requests: unknown[] = [];
  await listen(reference.control, (value, socket) => { requests.push(value); socket.end(`${JSON.stringify({ ok: true, threadIds: [threadId] })}\n`); });
  await expect(opener.recoverSession(threadId, () => {}, () => {})).rejects.toMatchObject({ code: "ownership-uncertain" });
  expect(requests).toEqual([{ type: "status" }]);
});

it("detects competing native generations before replacing any session client", async () => {
  const { opener, dataDir } = fixture(), threadId = "conflicted", attached = vi.fn();
  for (const generation of ["a".repeat(16), "b".repeat(16)]) {
    const reference = recoveryReference(dataDir, threadId, generation);
    await listen(reference.control, (_value, socket) => socket.end(`${JSON.stringify({ ok: true, threadIds: [threadId] })}\n`));
    await listen(reference.socketPath, attached);
  }
  await expect(opener.recoverSession(threadId, () => {}, () => {})).rejects.toMatchObject({ code: "ownership-conflict" });
  expect(attached).not.toHaveBeenCalled();
});

it("distinguishes a process-lifetime lock from an unlocked artifact when control is absent", async () => {
  const { opener, dataDir } = fixture(), reference = recoveryReference(dataDir, "locked-thread");
  mkdirSync(dirname(reference.control), { recursive: true });
  writeFileSync(`${reference.control}.lock`, "");
  expect(await opener.recoverSession("locked-thread", () => {}, () => {})).toBeNull();
  const owner = execFile("flock", ["--no-fork", `${reference.control}.lock`, "node", "-e", "process.stdout.write('locked');process.stdin.resume()"]);
  const exited = new Promise<void>(resolve => owner.once("exit", () => resolve()));
  cleanups.push(async () => { owner.kill(); await exited; });
  await new Promise<void>((resolve, reject) => { owner.once("error", reject); owner.stdout!.once("data", () => resolve()); });
  await expect(opener.recoverSession("locked-thread", () => {}, () => {})).rejects.toMatchObject({ code: "ownership-uncertain" });
});

it("returns positive absence for an empty boundary and rejects unidentifiable generations", async () => {
  const { opener, dataDir } = fixture();
  expect(await opener.recoverSession("absent", () => {}, () => {})).toBeNull();
  mkdirSync(join(dataDir, "thread-runners"));
  writeFileSync(join(dataDir, "thread-runners", "unknown.sock.lock"), "");
  await expect(opener.recoverSession("absent", () => {}, () => {})).rejects.toMatchObject({ code: "ownership-uncertain" });
});

it("records native attachment before a replayed immediate exit", async () => {
  const { opener, reference } = fixture(), observed: string[] = [];
  await listen(reference.control, (_value, socket) => socket.end('{"ok":true}\n'));
  await listen(reference.socketPath, (_value, socket) => socket.write('{"type":"attached"}\n{"type":"exit","code":0}\n'));
  expect(await opener.attachSession(reference, event => observed.push(event.type), () => observed.push("exit"))).not.toBeNull();
  expect(observed).toEqual(["runner_attached", "exit"]);
});

it("returns absent without a reference or a listening control socket and never launches", async () => {
  const { opener, reference } = fixture();
  const output = vi.fn(), exit = vi.fn();
  expect(await opener.attachSession(undefined, output, exit)).toBeNull();
  expect(await opener.attachSession(reference, output, exit)).toBeNull();
  expect(output).not.toHaveBeenCalled();
  expect(exit).not.toHaveBeenCalled();
});

it("fences any delayed native open before declaring an absent session socket", async () => {
  const { opener, reference } = fixture(), requests: unknown[] = [];
  await listen(reference.control, (value, socket) => { requests.push(value); socket.end('{"ok":true,"sessions":1}\n'); });
  expect(await opener.attachSession(reference, () => {}, () => {})).toBeNull();
  expect(requests).toEqual([{ type: "status" }, { type: "close", socketPath: reference.socketPath }]);
});

it("retains uncertain custody when native close cannot fence a missing session socket", async () => {
  const { opener, reference } = fixture(), requests: unknown[] = [];
  await listen(reference.control, (value, socket) => {
    requests.push(value);
    socket.end(value.type === "close" ? '{"error":"Cannot close active native custody"}\n' : '{"ok":true,"sessions":1}\n');
  });
  await expect(opener.attachSession(reference, () => {}, () => {})).rejects.toThrow("Cannot close active native custody");
  expect(requests).toEqual([{ type: "status" }, { type: "close", socketPath: reference.socketPath }]);
});

it.each(["control", "socketPath"] as const)("returns absent for a refused %s socket left on disk", async key => {
  const { opener, reference } = fixture();
  if (key === "socketPath") await listen(reference.control, (_value, socket) => socket.end('{"ok":true}\n'));
  const path = reference[key], temporary = `${path}.listening`;
  mkdirSync(dirname(path), { recursive: true });
  const server = createServer();
  await new Promise<void>(resolve => server.listen(temporary, resolve));
  renameSync(temporary, path);
  await new Promise<void>(resolve => server.close(() => resolve()));
  expect(await opener.attachSession(reference, () => {}, () => {})).toBeNull();
});

it.each(["control", "socketPath"] as const)("rejects an out-of-owner %s before contacting it", async key => {
  const { opener, reference, dataDir } = fixture();
  await expect(opener.attachSession({ ...reference, [key]: join(dataDir, "..", "other.sock") }, () => {}, () => {})).rejects.toThrow("outside this execution boundary");
  await expect(opener.attachSession({ ...reference, [key]: `${dirname(reference[key])}/../other.sock` }, () => {}, () => {})).rejects.toThrow("outside this execution boundary");
});

it.each(["control", "socketPath"] as const)("does not treat a premature %s disconnect as absence", async key => {
  const { opener, reference } = fixture();
  await listen(reference.control, (_value, socket) => key === "control" ? socket.end() : socket.end('{"ok":true}\n'));
  if (key === "socketPath") await listen(reference.socketPath, (_value, socket) => socket.end());
  await expect(opener.attachSession(reference, () => {}, () => {})).rejects.toThrow(/closed/i);
});

it.each(['{"error":"Runner is stopping"}\n', '{"sessions":0}\n', 'not json\n'])("keeps uncertain control responses as failures: %s", async response => {
  const { opener, reference } = fixture();
  await listen(reference.control, (_value, socket) => socket.end(response));
  await expect(opener.attachSession(reference, () => {}, () => {})).rejects.toThrow();
});

it.each(["control", "socketPath"] as const)("throws on a %s timeout rather than claiming absence", async key => {
  const { opener, reference } = fixture();
  let requested!: () => void;
  const request = new Promise<void>(resolve => { requested = resolve; });
  if (key === "socketPath") await listen(reference.control, (_value, socket) => socket.end('{"ok":true}\n'));
  await listen(reference[key], () => requested());
  vi.useFakeTimers();
  const failure = expect(opener.attachSession(reference, () => {}, () => {})).rejects.toThrow("timed out");
  await request;
  await vi.advanceTimersByTimeAsync(5000);
  await failure;
});

it("attaches, forwards commands and owns detach/close without needing a cwd or an open request", async () => {
  const { opener, reference, dataDir } = fixture(), requests: unknown[] = [], events: PiEvent[] = [];
  const cwd = join(dataDir, "reclaimed-checkout");
  mkdirSync(cwd);
  rmSync(cwd, { recursive: true });
  const exit = vi.fn();
  await listen(reference.control, (value, socket) => { requests.push(value); socket.end('{"ok":true}\n'); });
  let delivered!: () => void;
  const delivery = new Promise<void>(resolve => { delivered = resolve; });
  await listen(reference.socketPath, (value, socket) => {
    if (value.type === "attach") socket.write('{"type":"attached"}\n');
    if (value.type === "command") {
      const line = JSON.stringify({ type: "response", id: value.value.id, success: true, data: { cwd } });
      socket.write(`${JSON.stringify({ type: "output", sequence: 1, line })}\n`);
    }
  });
  const session = await opener.attachSession(reference, event => { events.push(event); if (event.type === "response") delivered(); }, exit);
  expect(session).not.toBeNull();
  expect(events).toEqual([{ type: "runner_attached", ...reference }]);
  await session!.command({ type: "get_state", id: "state" });
  await delivery;
  expect(events.at(-1)).toMatchObject({ type: "response", id: "state", data: { cwd } });
  await session!.close();
  await expect(session!.command({ type: "get_state" })).rejects.toThrow("detached");
  expect(requests).toEqual([{ type: "status" }, { type: "close", socketPath: reference.socketPath }]);
  expect(exit).not.toHaveBeenCalled();

  const attachedAgain = await opener.attachSession(reference, () => {}, exit);
  opener.detach();
  await expect(attachedAgain!.command({ type: "get_state" })).rejects.toThrow("detached");
  expect(requests).toHaveLength(3);
});

it("rejects an unknown attach frame rather than hanging for a known variant", async () => {
  const { opener, reference } = fixture();
  await listen(reference.control, (_value, socket) => socket.end('{"ok":true}\n'));
  await listen(reference.socketPath, (_value, socket) => socket.write('{"type":"new_frame"}\n'));
  await expect(opener.attachSession(reference, () => {}, () => {})).rejects.toThrow("Invalid runner output frame");
});

it("fails an attached execution with a protocol diagnostic instead of acknowledging an unknown event", async () => {
  const { opener, reference } = fixture(), events: PiEvent[] = [], acknowledgements: unknown[] = [];
  await listen(reference.control, (_value, socket) => socket.end('{"ok":true}\n'));
  let finished!: () => void;
  const failed = new Promise<void>(resolve => { finished = resolve; });
  const exit = vi.fn(() => finished());
  await listen(reference.socketPath, (value, socket) => {
    if (value.type === "attach") socket.write('{"type":"attached"}\n');
    if (value.type === "ack") acknowledgements.push(value);
    if (value.type === "command") socket.write(`${JSON.stringify({ type: "output", sequence: 1, line: '{"type":"new_sdk_event"}' })}\n`);
  });
  const session = await opener.attachSession(reference, event => events.push(event), exit);
  await session!.command({ type: "get_state" });
  await failed;
  expect(events.at(-1)).toMatchObject({ type: "thread_error", error: expect.stringContaining("Unknown runtime event type") });
  expect(exit).toHaveBeenCalledWith(1);
  expect(acknowledgements).toEqual([]);
  await expect(session!.command({ type: "get_state" })).rejects.toThrow("detached");
});

it("delivers multi-megabyte and multi-line output across arbitrary chunk boundaries with linear scan work", async () => {
  const { opener, reference } = fixture(), events: PiEvent[] = [];
  await listen(reference.control, (_value, socket) => socket.end('{"ok":true}\n'));
  // 24 MiB of text in 64 KiB writes. Quadratic rescanning grows with the square of the line.
  const big = "é".repeat(12 * 1024 * 1024) + "✓";
  const lines = [
    { type: "output", sequence: 1, line: JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta" }, text: big }) },
    { type: "output", sequence: 2, at: 1_790_000_000_123, line: JSON.stringify({ type: "agent_end" }) },
    { type: "output", sequence: 3, line: JSON.stringify({ type: "turn_end" }) },
  ].map(value => `${JSON.stringify(value)}\n`).join("");
  const bytes = Buffer.from(lines);
  let done!: () => void;
  const received = new Promise<void>(resolve => { done = resolve; });
  await listen(reference.socketPath, (value, socket) => {
    if (value.type !== "attach") return;
    socket.write('{"type":"attached"}\n');
    // Odd-sized writes split UTF-8 sequences and put several lines in one chunk.
    for (let offset = 0; offset < bytes.length; offset += 65_521) socket.write(bytes.subarray(offset, offset + 65_521));
  });
  // Count the newline search range, not wall time shared with other publication
  // checks. A spy would retain every growing input in the quadratic regression.
  const indexOf = String.prototype.indexOf;
  let scanned = 0;
  String.prototype.indexOf = function (search, position = 0) {
    const end = indexOf.call(this, search, position);
    if (search === "\n") scanned += Math.max(0, (end < 0 ? this.length : end + 1) - position);
    return end;
  };
  try {
    const connection = await opener.attachSession(reference, event => { if (event.type === "runner_attached") return; events.push(event); if (events.length === 3) done(); }, () => {});
    expect(connection).not.toBeNull();
    await received;
  } finally {
    String.prototype.indexOf = indexOf;
  }
  // Each output character is scanned once, plus the small control/attach frames.
  expect(scanned).toBeGreaterThanOrEqual(lines.length);
  expect(scanned).toBeLessThanOrEqual(lines.length + 1024);
  expect((events[0] as { text?: string }).text).toBe(big);
  expect(events.slice(1).map(event => event.type)).toEqual(["agent_end", "turn_end"]);
  expect(events[1]!.emittedAt).toBe(1_790_000_000_123);
});
