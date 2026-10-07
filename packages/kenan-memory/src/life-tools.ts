import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { lifeClient } from "./life-client.js";
import { LifeReadRequestSchema, LifeWriteRequestSchema, LifePolicyRequestSchema, LifeSteeringRequestSchema, type LifeClient, type LifePolicyView, type LifeRequest, type LifeResult, type LifeTarget } from "./life-contract.js";
import type { MemoryResult } from "./contract.js";

export function registerLifeTools(pi: ExtensionAPI, options: {
  env: NodeJS.ProcessEnv; root: boolean;
  ensureSession: () => Promise<MemoryResult<unknown>>;
  client?: LifeClient;
}): () => Promise<string> {
  const client = () => options.client ?? lifeClient({ url: options.env.PI_KENAN_MEMORY_URL, token: options.env.PI_KENAN_MEMORY_TOKEN });
  const request = async (input: LifeRequest) => {
    const session = await options.ensureSession();
    const result: LifeResult = session.ok ? await client().request(input) : session;
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: { lifeResult: result }, isError: !result.ok };
  };
  const scope = options.root ? "Select root for household/machine state or person with an explicit registered person ID. Self is forbidden for root. Private access is not permission to disclose." : "Use target self. Other-person and root life state belongs to ask_kenan.";
  const provenance = "Keep evidence, counterevidence, unknowns and validity explicit. Never index or infer from sources excluded by current policy. A predicted or adopted preference never enlarges authority.";
  pi.registerTool(defineTool({ name: "life_read", label: "Read life state", description: `Read current goals, commitments, needs-you, preferences and source coverage. Reading never records a reconciliation. ${scope}`, parameters: Type.Omit(LifeReadRequestSchema, ["operation"]), execute: async (_id, input) => request({ operation: "read", ...input }) }));
  pi.registerTool(defineTool({ name: "life_write", label: "Update life state", description: `Closed operations for versioned entity replacement/retraction, actual reconciliation coverage and one-time source imports. expectedRevision 0 creates; stale revision returns conflict. Preserve corrections and provenance. ${scope} ${provenance}`, parameters: LifeWriteRequestSchema, execute: async (_id, input) => request(input) }));
  pi.registerTool(defineTool({ name: "life_policy", label: "Life authority policy", description: `Read current/history or CAS-replace delegation, steering, exclusions, disclosure and consent policy. Record actual grants, never inferred permission. Active conservative initial policy grants no expanded standing authority. Revoked/unavailable policy grants none. ${scope}`, parameters: LifePolicyRequestSchema, execute: async (_id, input) => request(input) }));
  pi.registerTool(defineTool({ name: "life_steering", label: "Life steering log", description: `Read or record a steering effect with its current policy revision, linked goals/preferences, evidence, rationale, action, visibility, outcome and receipt. Uncertain effects are inspected, never replayed. ${scope}`, parameters: LifeSteeringRequestSchema, execute: async (_id, input) => request(input) }));
  return async () => {
    const session = await options.ensureSession();
    if (!session.ok) return "Current life authority is unavailable. No expanded standing discretion may be inferred; existing direct instructions and tool permissions still apply.";
    const person = options.env.PI_KENAN_MEMORY_PERSON;
    const targets: LifeTarget[] = options.root ? [{ scope: "root" }, ...(person && person !== "pi-rooms" ? [{ scope: "person" as const, person }] : [])] : [{ scope: "self" }];
    const policies = await Promise.all(targets.map(async target => {
      const result = await client().request<LifePolicyView>({ operation: "policy-read", target, includeHistory: false });
      return result.ok ? { target, subject: result.value.subject, policy: result.value.current } : { target, unavailable: result.error };
    }));
    return `Authenticated current life authority (refreshed this turn):\n${JSON.stringify(policies)}\nApply each policy only in its owner's scope. A null, revoked, future-dated, expired or unavailable policy supplies no expanded standing grant. Policy validity dates are binding. Exclusions apply before capture, indexing and inference. Preferences never enlarge grants. Follow third-party consent and tool contracts. Log steering under the current authority revision. Source coverage records actual reconciliation, never a read.`;
  };
}
