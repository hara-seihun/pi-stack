import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { KENAN_REQUEST_HEADER, MEMORY_TOKEN_HEADER, type RootAdmission } from "../src/contract.js";
import { rootRequestResponse } from "../src/root-transport.js";
import { rootService } from "../../kenan-root/src/service.js";
import { RootRequestStore } from "../../kenan-root/src/requests.js";

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => resolve = done); return { promise, resolve }; };

test("Root reconnects across refusal, old-owner 503 and lost body using the original durable receipt ID", async () => {
  const directory = mkdtempSync(join(tmpdir(), "root-client-handoff-")), store = new RootRequestStore(join(directory, "requests.sqlite3"));
  const id = randomUUID(), model = deferred();
  let admissions = 0, executions = 0, attempts = 0;
  const admission: RootAdmission = { person: "alice", threadId: "thread", recipients: ["alice"], subjects: [], rootSessionId: randomUUID(), memoryToken: "private" };
  const handle = rootService({ enabled: () => true, memoryUrl: "http://memory", memoryRootToken: "secret", adminCapability: "a".repeat(64), sessionsDir: directory, requestStore: store, report() {},
    executor: async (_admission, _request, executing) => { executions++; executing?.(); await model.promise; return { ok: true, value: { reply: "Chosen reply", subjects: [] } }; },
    transport: (async url => {
      if (String(url).endsWith("admit")) { admissions++; return Response.json({ ok: true, value: admission }); }
      return Response.json({ ok: true });
    }) as typeof fetch });
  const init: RequestInit = { method: "POST", headers: { [MEMORY_TOKEN_HEADER]: "person-token", [KENAN_REQUEST_HEADER]: id }, body: '{"request":"original request"}' };
  const transport = (async (url, options) => {
    attempts++;
    expect(options!.body).toBe(init.body);
    expect(new Headers(options!.headers).get(KENAN_REQUEST_HEADER)).toBe(id);
    if (attempts === 1) throw new TypeError("connection refused");
    if (attempts === 2) return new Response("Old Root is swapping", { status: 503 });
    const response = await handle(new Request(String(url), options));
    if (attempts === 3) {
      expect(store.get(id)?.state).toBe("executing");
      await response.body?.cancel();
      return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("body connection lost")); } }), { status: 202 });
    }
    return response;
  }) as typeof fetch;
  try {
    expect(await rootRequestResponse("http://root/v1/ask", init, AbortSignal.timeout(1_000), transport, 1)).toEqual({ ok: true, status: 202, body: { requestId: id, status: "pending" } });
    expect(attempts).toBe(4); expect(admissions).toBe(1); expect(executions).toBe(1);
    model.resolve(); await handle.settled();
    const lookup = await rootRequestResponse(`http://root/v1/ask/${id}`, { headers: { [MEMORY_TOKEN_HEADER]: "person-token" } }, AbortSignal.timeout(1_000), (async (url, options) => handle(new Request(String(url), options))) as typeof fetch, 1);
    expect(lookup).toEqual({ ok: true, status: 200, body: { reply: "Chosen reply" } });
    expect(executions).toBe(1);
  } finally { model.resolve(); await handle.settled(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("Root retries never manufacture acceptance and stop at cancellation or a definitive denial", async () => {
  let attempts = 0;
  const transport = (async () => { attempts++; return new Response("Replacing", { status: 503 }); }) as typeof fetch;
  expect(await rootRequestResponse("http://root/v1/ask", {}, AbortSignal.timeout(15), transport, 1)).toEqual({ ok: false, error: "aborted" });
  expect(attempts).toBeGreaterThan(0);
  const before = attempts;
  const cancelled = new AbortController(); cancelled.abort();
  expect(await rootRequestResponse("http://root/v1/ask", {}, cancelled.signal, transport, 1)).toEqual({ ok: false, error: "aborted" });
  expect(attempts).toBe(before);
  expect(await rootRequestResponse("http://root/v1/ask", {}, AbortSignal.timeout(1_000), (async () => { attempts++; return new Response("Denied", { status: 403 }); }) as typeof fetch, 1)).toEqual({ ok: false, error: "http", status: 403 });
  expect(attempts).toBe(before + 1);
});
