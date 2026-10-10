import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Compile } from "typebox/compile";
import type { TSchema } from "typebox";
import { createCodingTools, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { normalizeContext } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { memoryExtension } from "../../kenan-memory/src/tools.js";
import { anthropicToolSchema } from "../../runtime/anthropic-tool-schema.js";
import { convergeTools } from "../src/threads/converge.js";
import { threadTools } from "../src/threads/pi-tools.js";

interface AdvertisedTool { name: string; description: string; parameters: TSchema }
interface WireSchema extends TSchema {
  type?: string;
  properties?: Record<string, unknown>;
  anyOf?: WireSchema[];
  allOf?: WireSchema[];
  oneOf?: WireSchema[];
}
const zeroArgumentTools = new Set(["watch_list", "manager_questions_list"]);
const affectedFields = {
  thread_wake: ["action", "reason", "cadenceMs", "nextDueAt"],
  thread_control: ["action", "threadId", "threadIds", "settings", "messageId", "delivery"],
  converge: ["action", "cwd", "command", "timeout", "path", "offset", "limit", "content", "edits"],
  life_write: ["operation", "target", "expectedRevision", "id", "entity", "reason", "coverage", "source", "fingerprint", "entries"],
  life_policy: ["operation", "target", "includeHistory", "expectedRevision", "policy"],
  life_steering: ["operation", "target", "limit", "expectedRevision", "id", "steering"],
};
const tools = new Map<string, AdvertisedTool>();
let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "agent-tool-schemas-"));
  const hostConfig = join(root, "host.json");
  writeFileSync(hostConfig, JSON.stringify({ oneKenan: true }));
  const env = { PI_STACK_HOST_CONFIG: hostConfig, PI_THREAD_ID: "schema-fixture", PI_REMOTE_SENDER_ID: "kenan", PI_KENAN_MEMORY_ROLE: "person", PI_THREAD_CAN_SPAWN: "1" };
  const registerTool = (tool: AdvertisedTool) => {
    expect(tools.has(tool.name), `duplicate registration: ${tool.name}`).toBe(false);
    tools.set(tool.name, tool);
  };
  for (const tool of [...createCodingTools(root), ...threadTools({ threadId: "schema-fixture", cwd: root, sessionFile: "unused", args: [], env }), ...convergeTools(env)]) registerTool(tool);
  memoryExtension({ env, ask: async () => { throw new Error("Schema collection must not execute tools"); } })({ registerTool, on() {} } as unknown as ExtensionAPI);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function rootFields(schema: WireSchema): string[] {
  return [...new Set([
    ...Object.keys(schema.properties ?? {}),
    ...[schema.anyOf, schema.allOf, schema.oneOf].flatMap(branches => branches?.flatMap(rootFields) ?? []),
  ])].sort();
}
function wireSchema(name: string): WireSchema {
  const tool = tools.get(name);
  expect(tool, `missing actual registration: ${name}`).toBeDefined();
  return JSON.parse(JSON.stringify(anthropicToolSchema(tool!.parameters)));
}

it("registered agent tools advertise usable wire parameters; only named zero-argument tools may have none", () => {
  expect([...tools.keys()]).toEqual(expect.arrayContaining(["read", "bash", "edit", "write", "thread_spawn", "thread_wait", "ask_kenan", "memory_write", "life_read", "converge"]));
  const empty: string[] = [];
  for (const name of tools.keys()) {
    const schema = wireSchema(name);
    expect(schema.type, name).toBe("object");
    for (const keyword of ["anyOf", "oneOf", "allOf"]) expect(Object.hasOwn(schema, keyword), `${name}: forbidden root ${keyword}`).toBe(false);
    const fields = rootFields(schema);
    if (fields.length === 0) empty.push(name);
    expect(fields.length === 0, name).toBe(zeroArgumentTools.has(name));
  }
  expect(empty.sort()).toEqual([...zeroArgumentTools].sort());
});

it("the actual Anthropic provider advertises every registered schema without erasing operation branches", async () => {
  const provider = builtinProviders().find(provider => provider.id === "anthropic")!;
  const selected = provider.getModels()[0]!;
  const model = { ...selected, compat: { ...selected.compat, supportsStrictTools: false } };
  let payload: { tools: { name: string; input_schema: WireSchema }[] } | undefined;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    payload = await new Request(input, init).json();
    return Response.json({ error: { message: "Synthetic payload capture; no model request" } }, { status: 400 });
  }) as typeof fetch;
  await provider.stream(model, normalizeContext({ messages: [{ role: "user", content: "fixture", timestamp: 0 }], tools: [...tools.values()] }), { apiKey: "fixture", fetch: fetcher, maxRetries: 0 }).result();
  expect(payload).toBeDefined();
  const registered = payload!.tools.filter(tool => tool.name !== "__pi_deferred_placeholder__");
  expect(registered).toHaveLength(tools.size);
  for (const tool of registered) expect(tool.input_schema, tool.name).toEqual(wireSchema(tool.name));
});

it.each(Object.entries(affectedFields))("%s retains advertised fields and original branch constraints on the Anthropic wire", (name, fields) => {
  const original = JSON.parse(JSON.stringify(tools.get(name)!.parameters));
  const wire = wireSchema(name);
  expect(rootFields(wire)).toEqual([...fields].sort());
  expect(wire.not, `${name} exact operation contract`).toEqual({ not: original });
  expect(Compile(wire).Check({}), `${name} must not accept an empty request`).toBe(false);
});

const target = { scope: "self" };
const provenance = {
  factClass: "stated", confidence: null,
  source: { actor: "kenan", locator: "schema-fixture", observedAt: "2026-10-09T00:00:00Z" },
  evidence: [], counterevidence: [], validFrom: null, validUntil: null,
};
const entity = {
  title: "Schema regression", provenance, kind: "goal", state: "active", outcome: "Preserve tool contracts",
  horizon: null, tradeoffs: [], commitments: [],
};
const policy = {
  status: "active", domains: [], delegation: "Direct instructions only", financialDiscretion: null,
  steering: { mode: "off", instruction: null }, exclusions: [], disclosure: "Keep private",
  consent: { thirdParty: "Requires consent", immediateOverride: null }, protectedSkills: [], reviewAt: null, provenance,
};
const steering = {
  policyRevision: 1, goalIds: [], preferenceIds: [], evidence: [], action: "Compile schemas", rationale: "Preserve branch constraints",
  visibility: "visible", state: "succeeded", outcome: null, receipt: null, compensation: null,
};
const cases = [
  {
    name: "thread_wake",
    valid: [{ action: "set", reason: "Recover deployment", cadenceMs: 60000 }, { action: "set", reason: "Recover deployment", cadenceMs: 60000, nextDueAt: 0 }, { action: "list" }, { action: "cancel" }, { action: "list", cadenceMs: "permissive extra field" }],
    invalid: [{ action: "set" }, { action: "set", reason: "Recover deployment", cadenceMs: 59999 }, { action: "set", reason: "", cadenceMs: 60000 }, { action: "set", reason: "Recover deployment", cadenceMs: 60000, nextDueAt: -1 }, { action: "unknown" }],
  },
  {
    name: "thread_control",
    valid: [{ action: "close", threadId: "peer" }, { action: "reopen" }, { action: "cancel" }, { action: "dependencies", threadIds: [] }, { action: "settings", settings: { thinkingLevel: "high", speed: "standard" } }, { action: "retryWaiting" }, { action: "cancelMessage", messageId: "pending" }, { action: "promoteMessage", messageId: "pending", delivery: "hardSteer" }, { action: "close", settings: "permissive extra field" }],
    invalid: [{ action: "dependencies" }, { action: "dependencies", threadIds: ["peer", "peer"] }, { action: "settings" }, { action: "settings", settings: { thinkingLevel: "unknown" } }, { action: "cancelMessage" }, { action: "promoteMessage", messageId: "pending" }, { action: "promoteMessage", messageId: "pending", delivery: "unknown" }, { action: "unknown" }],
  },
  {
    name: "converge",
    valid: [{ action: "bash", command: "pwd", cwd: "/work", timeout: 55 }, { action: "read", path: "README.md", offset: 1, limit: 2000 }, { action: "write", path: "empty.txt", content: "" }, { action: "edit", path: "README.md", edits: [{ oldText: "before", newText: "after" }] }, { action: "read", path: "README.md", command: 123 }],
    invalid: [{ action: "bash" }, { action: "bash", command: "pwd", cwd: "relative" }, { action: "bash", command: "pwd", timeout: 0 }, { action: "read" }, { action: "read", path: "README.md", offset: 0 }, { action: "write", path: "empty.txt" }, { action: "edit", path: "README.md", edits: [] }, { action: "edit", path: "README.md", edits: [{ newText: "after" }] }, { action: "unknown" }],
  },
  {
    name: "life_write",
    valid: [
      { operation: "put-entity", target, expectedRevision: 0, id: "goal", entity },
      { operation: "retract-entity", target, expectedRevision: 1, id: "goal", reason: "Corrected" },
      { operation: "coverage-write", target, expectedRevision: 0, coverage: { source: "fixture", state: "partial", checkedAt: "2026-10-09T00:00:00Z", reconciledAt: null, freshUntil: null, detail: null, error: null, evidence: [] } },
      { operation: "import-entities", target, source: "fixture", fingerprint: "a".repeat(64), entries: [{ id: "goal", entity }] },
    ],
    invalid: [
      { operation: "put-entity", target, expectedRevision: 0, id: "goal" },
      { operation: "put-entity", target, expectedRevision: 0, id: "goal", entity: { ...entity, state: "completed" } },
      { operation: "retract-entity", target, expectedRevision: -1, id: "goal", reason: "Corrected" },
      { operation: "retract-entity", target: { scope: "person" }, expectedRevision: 1, id: "goal", reason: "Corrected" },
      { operation: "retract-entity", target, expectedRevision: 1, id: "goal", reason: "Corrected", entity },
      { operation: "coverage-write", target, expectedRevision: 0, coverage: {} },
      { operation: "import-entities", target, source: "fixture", fingerprint: "invalid", entries: [] },
      { operation: "unknown", target },
    ],
  },
  {
    name: "life_policy",
    valid: [{ operation: "policy-read", target, includeHistory: false }, { operation: "policy-write", target, expectedRevision: 0, policy }],
    invalid: [{ operation: "policy-read", target }, { operation: "policy-read", target, includeHistory: false, policy }, { operation: "policy-write", target, expectedRevision: 0 }, { operation: "policy-write", target, expectedRevision: 0, policy: { ...policy, steering: { mode: "unknown", instruction: null } } }, { operation: "unknown", target }],
  },
  {
    name: "life_steering",
    valid: [{ operation: "steering-read", target, limit: 100 }, { operation: "steering-write", target, expectedRevision: 0, id: "effect", steering }],
    invalid: [{ operation: "steering-read", target, limit: 101 }, { operation: "steering-read", target, limit: 1, id: "effect" }, { operation: "steering-write", target, expectedRevision: 0, id: "effect" }, { operation: "steering-write", target, expectedRevision: 0, id: "effect", steering: { ...steering, policyRevision: 0 } }, { operation: "unknown", target }],
  },
];

describe.each(cases)("$name wire validation", ({ name, valid, invalid }) => {
  it("accepts each operation branch, preserving permissive branch extras", () => {
    const validator = Compile(wireSchema(name));
    for (const input of valid) expect(validator.Check(input), JSON.stringify(input)).toBe(true);
  });
  it("rejects missing branch fields, invalid values and cross-branch fields on closed contracts", () => {
    const validator = Compile(wireSchema(name));
    for (const input of invalid) expect(validator.Check(input), JSON.stringify(input)).toBe(false);
  });
});
