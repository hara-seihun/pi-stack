import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DELEGATION_POLICY } from "../delegation-policy.js";
import { SUBAGENT_MODEL_DESCRIPTIONS } from "../catalog.js";
import type { PiToolsHost } from "./pi-types.js";

const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value });

export function piChildTools(host: PiToolsHost, agentId: string) {
  return [
    defineTool({
      name: "core_delegate", label: "Delegate to a Pi child",
      description: `${DELEGATION_POLICY}\n\nDelegate work to a Pi core child. Reuses the previous suitable worker by default, including for follow-ups. Set threadId to continue a particular worker; set newThread only when a separate concurrent worker is needed. Returns immediately and brings the result back here.`,
      parameters: Type.Object({
        task: Type.String({ minLength: 1 }),
        threadId: Type.Optional(Type.String({ description: "An existing worker to continue." })),
        newThread: Type.Optional(Type.Boolean({ description: "Create a separate worker instead of reusing one. Defaults to false." })),
        model: Type.Optional(Type.String({ description: `Optional model constraint, such as astra, sol, terra or luna, or provider/model. Existing workers keep their model; a new worker defaults to astra. ${SUBAGENT_MODEL_DESCRIPTIONS}` })),
        thinkingLevel: Type.Optional(Type.Union(["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(level => Type.Literal(level)))),
        cwd: Type.Optional(Type.String({ description: "Worker's working directory. Defaults to the parent's." })),
        workspace: Type.Optional(Type.Object({
          repo: Type.String({ description: "Repository URL or local checkout for an owned agent-workspace." }),
          root: Type.String({ description: "Absolute workspace pool directory." }),
        })),
      }),
      execute: async (id, request) => result(await host.delegate(agentId, id, request)),
    }),
    defineTool({
      name: "core_read", label: "Read a Pi agent",
      description: "Read another agent's conversation and actions without a model call. Accepts an agent ID, including settled agents. Results contain messages and tool activity only. Offset and limit page native session entries.",
      parameters: Type.Object({ agentId: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
      execute: async (_id, p) => result(await host.read(p.agentId, p.offset, p.limit)),
    }),
    defineTool({
      name: "core_list", label: "List Pi agents",
      description: "List a Pi agent's direct subagents, including settled children with their native session IDs. Defaults to this agent.",
      parameters: Type.Object({ parentId: Type.Optional(Type.String()) }),
      execute: async (_id, p) => result(host.list(p.parentId ?? agentId)),
    }),
    defineTool({
      name: "core_control", label: "Control a Pi child",
      description: "Send a message or stop a Pi child. Steer changes its current work; follow_up queues another message. Abort stops the child's whole subtree.",
      parameters: Type.Object({ agentId: Type.String(), action: Type.Union(["steer", "follow_up", "abort"].map(value => Type.Literal(value))), message: Type.Optional(Type.String()) }),
      execute: async (_id, p) => {
        if (p.agentId === agentId) throw new Error("Use the current turn to control this agent; core_control targets another agent.");
        if (p.action !== "abort" && !p.message) throw new Error("message is required");
        await host.control(p.agentId, { type: p.action, message: p.message }, agentId);
        return result({ agentId: p.agentId, action: p.action });
      },
    }),
  ];
}
