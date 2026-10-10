import { expect, it } from "vitest";
import { Value } from "typebox/value";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { normalizeContext } from "@earendil-works/pi-ai";
import { threadTools } from "../src/threads/pi-tools.js";
import { threadWaitParameters, parseRunnerWaitDependency } from "../src/threads/wait-contract.js";

const inputs = [
  { action: "set", kind: "agents", threadIds: ["child"], after: { child: 0 } },
  { action: "set", kind: "job", jobId: "job-123" },
  { action: "set", kind: "deployment", publicationId: "PUB-123" },
  { action: "set", kind: "message", fromThreadId: "colleague" },
  { action: "clear" },
];
const invalid = [
  { action: "set" },
  { action: "set", threadIds: [] },
  { action: "set", kind: "agents", threadIds: [] },
  { action: "set", kind: "job" },
  { action: "set", kind: "job", jobId: "job", threadIds: ["child"] },
];
it("generated discriminated schema and typed wire parser agree on named dependencies", () => {
  for (const input of inputs) {
    expect(Value.Check(threadWaitParameters, input)).toBe(true);
    if (input.action === "set") expect(parseRunnerWaitDependency(input).ok).toBe(true);
  }
  for (const input of invalid) {
    expect(Value.Check(threadWaitParameters, input)).toBe(false);
    expect(parseRunnerWaitDependency(input).ok).toBe(false);
  }
  expect(parseRunnerWaitDependency({ action: "set", reason: "old runner", threadIds: ["child"] })).toEqual({ ok: true, value: { kind: "agents", threadIds: ["child"], after: {} } });
});

it.each(["anthropic-messages", "openai-responses", "openai-completions"])("%s provider payload advertises every dependency field instead of losing the root union", async api => {
  const providers = builtinProviders();
  const provider = providers.find(provider => provider.getModels().some(model => model.api === api))!;
  const model = provider.getModels().find(model => model.api === api)!;
  const wait = threadTools({ threadId: "self", cwd: "/tmp", sessionFile: "none", args: [], env: {} }).find(tool => tool.name === "thread_wait")!;
  let payload: any;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    payload = await new Request(input, init).json();
    return Response.json({ error: { message: "Synthetic payload capture; no model request" } }, { status: 400 });
  }) as typeof fetch;
  await provider.stream(model, normalizeContext({ messages: [{ role: "user", content: "fixture", timestamp: 0 }], tools: [wait] }), { apiKey: "fixture", fetch: fetcher, maxRetries: 0 }).result();
  expect(payload).toBeDefined();
  const tool = payload.tools[0];
  const projected = tool.input_schema ?? tool.parameters ?? tool.function.parameters;
  expect(projected.type).toBe("object");
  expect(Object.keys(projected.properties).sort()).toEqual(["action", "kind", "threadIds", "after", "jobId", "publicationId", "fromThreadId"].sort());
  expect(JSON.stringify(projected)).toContain("deployment");
  if (api === "anthropic-messages") {
    for (const keyword of ["anyOf", "oneOf", "allOf"]) expect(Object.hasOwn(projected, keyword)).toBe(false);
  }
  for (const input of inputs) expect(Value.Check(projected, input)).toBe(true);
  for (const input of invalid) expect(Value.Check(projected, input)).toBe(false);
});
