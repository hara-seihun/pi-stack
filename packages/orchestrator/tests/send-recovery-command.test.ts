import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { dispatch } from "../src/commands.js";
import { ThreadService } from "../src/threads/service.js";
import { threadTools } from "../src/threads/pi-tools.js";
import { threadHttp } from "../src/threads/http.js";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it("CLI recovery sends the exact supplied identity and original caller/payload, including failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "send-recovery-")); roots.push(root);
  const token = join(root, "token"); writeFileSync(token, "fixture-token");
  vi.stubEnv("PI_CORE_URL", "http://127.0.0.1:19181"); vi.stubEnv("PI_CORE_TOKEN_FILE", token);
  vi.stubEnv("PI_THREAD_API_URL", "http://127.0.0.1:19181/v1/threads"); vi.stubEnv("PI_THREAD_ID", "original-caller");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: false, error: { code: "conflict", message: "Payload differs" } }));
  await dispatch(["send", "recipient", "--prompt", "unchanged original", "--request-id", "original-cli-uuid"]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ requestId: "original-cli-uuid", threadId: "recipient", senderId: "original-caller", text: "unchanged original", delivery: "pending" });
  expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({ ok: false, error: { requestId: "original-cli-uuid", code: "conflict" } });
  expect(process.exitCode).toBe(1);
  await expect(dispatch(["send", "recipient", "--prompt", "text", "--request-id", " "])).rejects.toThrow("exact original identity");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("selected CLI reconciles an unchanged retained native tool send through the same durable digest", async () => {
  const root = mkdtempSync(join(tmpdir(), "retained-tool-cli-")); roots.push(root);
  const token = join(root, "token"); writeFileSync(token, "fixture-token");
  vi.stubEnv("PI_CORE_URL", "http://127.0.0.1:19181"); vi.stubEnv("PI_CORE_TOKEN_FILE", token);
  vi.stubEnv("PI_THREAD_API_URL", "http://127.0.0.1:19181/v1/threads"); vi.stubEnv("PI_THREAD_ID", "sender"); vi.stubEnv("PI_THREAD_TOKEN", "fixture-thread-token");
  const options = { capacity: { mode: "unmanaged" as const }, databasePath: join(root, "threads.sqlite"), sessionsDir: root,
    openSession: async () => { throw new Error("No native execution in reconciliation proof"); } };
  let owner = new ThreadService(options);
  try {
    for (const id of ["sender", "recipient", "other"]) expect(await owner.spawn({ requestId: `create:${id}`, id, title: id, cwd: root })).toMatchObject({ ok: true });
    const tool = threadTools({ threadId: "sender", cwd: root, sessionFile: join(root, "sender.jsonl"), args: [], env: {}, threads: owner }).find(tool => tool.name === "thread_send")!;
    expect((await tool.execute("retained-call", { threadId: "recipient", text: "original" }, undefined, undefined, {} as never)).details).toMatchObject({ ok: true });
    await owner.detach(); owner = new ThreadService(options);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => (await threadHttp(owner, new Request("http://owner/v1/threads/send", init)))!);
    const argv = ["send", "recipient", "--prompt", "original", "--request-id", "sender:retained-call", "--source", "explicit"];
    await dispatch(argv);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ ok: true, value: { id: "sender:retained-call" } });
    expect(owner.pending("recipient")).toHaveLength(1);
    await dispatch(argv.map(value => value === "recipient" ? "other" : value));
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ ok: false, error: { code: "conflict", requestId: "sender:retained-call" } });
    expect(owner.pending("other")).toHaveLength(0);
    await expect(dispatch(argv.map(value => value === "sender:retained-call" ? "foreign:retained-call" : value))).rejects.toThrow("this caller's original");
    expect(fetcher).toHaveBeenCalledTimes(2);
    const waitTool = threadTools({ threadId: "sender", cwd: root, sessionFile: join(root, "sender.jsonl"), args: [], env: {}, threads: owner }).find(tool => tool.name === "thread_wait")!;
    const waitInput = { action: "set" as const, kind: "message" as const, fromThreadId: "recipient" };
    expect((await waitTool.execute("old-wait", waitInput, undefined, undefined, {} as never)).details).toMatchObject({ ok: true });
    fetcher.mockImplementation(async (_url, init) => (await threadHttp(owner, new Request("http://owner/v1/threads/agentWait", init)))!);
    await dispatch(["wait-recover", "--request-id", "sender:old-wait", "--input", JSON.stringify(waitInput)]);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ ok: true, value: { waitRegistration: { status: "registered" } } });
    await dispatch(["wait-recover", "--request-id", "sender:old-wait", "--input", JSON.stringify({ ...waitInput, fromThreadId: "other" })]);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(owner.get("sender")?.metadata?.agentWait?.fromThreadId).toBe("recipient");
    expect(fetcher).toHaveBeenCalledTimes(4);
  } finally { await owner.detach(); }
});
