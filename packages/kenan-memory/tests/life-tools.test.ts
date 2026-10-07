import { expect, test } from "bun:test";
import { registerLifeTools } from "../src/life-tools.js";
import { conservativeLifePolicy } from "../src/life-policy.js";
import type { LifeClient, LifeRequest, LifeResult, LifePolicyView } from "../src/life-contract.js";

function setup(env: NodeJS.ProcessEnv, root: boolean, outcome: (request: LifeRequest) => unknown) {
  const tools: any[] = [], requests: LifeRequest[] = [];
  const client: LifeClient = { request: async <T>(request: LifeRequest) => { requests.push(request); return outcome(request) as LifeResult<T>; } };
  const refresh = registerLifeTools({ registerTool: (tool: unknown) => tools.push(tool) } as any, { env, root, client, ensureSession: async () => ({ ok: true, value: undefined }) });
  return { tools, requests, refresh };
}
const policyView = (subject: string, revision: number): LifePolicyView => ({ subject, history: [], current: { id: "authority", revision, recordedAt: "2026-10-01T00:00:00Z", recordedBy: "system", threadId: null, value: conservativeLifePolicy(subject, "2026-10-01T00:00:00Z") } });

test("every policy refresh reads verified scope anew instead of retaining authority across revocation", async () => {
  let revision = 1;
  const { refresh, requests, tools } = setup({ PI_KENAN_MEMORY_PERSON: "alice" }, false, () => ({ ok: true, value: policyView("alice", revision) }));
  expect(await refresh()).toContain('"revision":1');
  revision = 2;
  expect(await refresh()).toContain('"revision":2');
  expect(requests).toEqual([{ operation: "policy-read", target: { scope: "self" }, includeHistory: false }, { operation: "policy-read", target: { scope: "self" }, includeHistory: false }]);
  expect(tools.map(tool => tool.name)).toEqual(["life_read", "life_write", "life_policy", "life_steering"]);
});

test("root authority and requester authority remain explicitly distinct; room root does not invent pi-rooms life", async () => {
  const own = setup({ PI_KENAN_MEMORY_PERSON: "alice" }, true, request => ({ ok: true, value: policyView(request.target.scope === "root" ? "root:kenan" : "alice", 1) }));
  expect(await own.refresh()).toContain('"subject":"root:kenan"');
  expect(own.requests.map(request => request.target)).toEqual([{ scope: "root" }, { scope: "person", person: "alice" }]);
  const room = setup({ PI_KENAN_MEMORY_PERSON: "pi-rooms" }, true, () => ({ ok: false, error: "unavailable", message: "Test unavailable" }));
  const prompt = await room.refresh();
  expect(room.requests.map(request => request.target)).toEqual([{ scope: "root" }]);
  expect(prompt).toContain('"unavailable":"unavailable"'); expect(prompt).toContain("no expanded standing grant");
});
