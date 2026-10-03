import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { admissionFor, type CallerResolver, type ThreadCaller } from "../src/threads/caller.js";
import { threadHttp } from "../src/threads/http.js";
import type { ThreadApi } from "../src/threads/contracts.js";

const cleanups: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of cleanups.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(enabled?: boolean) {
  const root = mkdtempSync(join(tmpdir(), "trace-access-")); cleanups.push(root);
  mkdirSync(join(root, "persons"));
  writeFileSync(join(root, "host.json"), JSON.stringify(enabled === undefined ? {} : { oneKenan: enabled }));
  writeFileSync(join(root, "persons", "admin.json"), JSON.stringify({ user: "admin", machineAdministrator: true }));
  vi.stubEnv("PI_STACK_HOST_CONFIG", join(root, "host.json"));
  vi.stubEnv("PI_REMOTE_PERSONS_DIR", join(root, "persons"));
}
function resolver(caller: ThreadCaller): CallerResolver {
  return { resolve: () => caller, admit: async (_operation, input) => ({ ok: true, input }) };
}
function boundary(caller: ThreadCaller, user = "ordinary") {
  const raw = vi.fn(async () => ({ ok: true, value: { raw: "PRIVATE_THINK", tool: "RESULT_SECRET" } }));
  const api = { read: raw, inspect: raw, command: raw } as unknown as ThreadApi;
  return { raw, call: async (operation: string, body: object = {}) => {
    const request = new Request(`http://owner/v1/threads/${operation}`, { method: "POST", headers: { "x-pi-remote-user": user }, body: JSON.stringify(body) });
    return (await threadHttp(api, request, "/v1/threads", admissionFor(resolver(caller), { headers: request.headers })))!;
  } };
}
describe("raw trace/execution API access", () => {
  it("denies raw work context, native history and export commands to ordinary person clients", async () => {
    fixture(true);
    const person = boundary({ kind: "person", via: "router" });
    for (const operation of ["inspect", "read", "command"]) {
      const response = await person.call(operation, { threadId: "s", command: { type: "export_html" } });
      expect(response.status).toBe(403);
      const wire = await response.text();
      expect(wire).not.toContain("PRIVATE_THINK"); expect(wire).not.toContain("RESULT_SECRET");
      expect(wire).toContain("confidence");
    }
    expect(person.raw).not.toHaveBeenCalled();
  });
  it("a forged administrator header from a local process grants no raw access", async () => {
    fixture(true);
    const process = boundary({ kind: "process", uid: 1234 }, "admin");
    expect((await process.call("inspect")).status).toBe(403);
    expect(process.raw).not.toHaveBeenCalled();
  });
  it("verified administrator and Kenan's internal execution keep raw access", async () => {
    fixture(true);
    for (const [caller, user] of [[{ kind: "person", via: "router" }, "admin"], [{ kind: "thread", threadId: "s" }, "ordinary"], [{ kind: "service", pid: 1 }, "ordinary"]] as [ThreadCaller, string][]) {
      const client = boundary(caller, user);
      expect((await client.call("inspect")).status).toBe(200);
      expect(client.raw).toHaveBeenCalledOnce();
    }
  });
  it("absent flag leaves existing raw reads untouched", async () => {
    fixture();
    const person = boundary({ kind: "person", via: "router" });
    expect((await person.call("read")).status).toBe(200);
    expect(person.raw).toHaveBeenCalledOnce();
  });
});
