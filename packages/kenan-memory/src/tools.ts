import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { memoryClient } from "./client.js";
import { oneKenanEnabled } from "./config.js";
import { MEMORY_READ_DETAIL, type MemoryClient, type MemoryRead, type MemoryRequest, type MemoryResult, type ReadContext } from "./contract.js";
export const MEMORY_TOOL_NAMES = ["memory_search", "memory_read", "memory_write", "memory_forget", "memory_disclosures", "memory_log_disclosure"];
const strings = Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 100 });
const optionalTime = Type.Optional(Type.String());
export interface MemoryToolOptions {
  env: NodeJS.ProcessEnv;
  client?: MemoryClient;
  ask: (id: string, question: string, suggestions: string[]) => Promise<unknown>;
}
export function memoryExtension(options: MemoryToolOptions) {
  return (pi: ExtensionAPI) => {
    if (!oneKenanEnabled(options.env)) return;
    const person = options.env.PI_KENAN_MEMORY_PERSON;
    const threadId = options.env.PI_THREAD_ID;
    if (!person || !threadId) throw new Error("One Kenan memory requires a verified person and thread session");
    const client = options.client ?? memoryClient({ url: options.env.PI_KENAN_MEMORY_URL, token: options.env.PI_KENAN_MEMORY_TOKEN });
    let turnId = randomUUID();
    let finalReply = "";
    const readTurns = new Map<string, ReadContext>();
    pi.on("turn_start", () => { turnId = randomUUID(); });
    pi.on("message_end", event => {
      if (event.message.role === "assistant") finalReply = event.message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
    });
    pi.on("agent_settled", async () => {
      for (const readContext of readTurns.values()) {
        const result = await client.request({ operation: "finalize-turn", context: readContext, reply: finalReply });
        if (!result.ok) throw new Error(`Cannot finalize Kenan's disclosure account: ${result.message}`);
        readTurns.delete(readContext.turnId);
      }
      finalReply = "";
    });
    const roomId = options.env.PI_REMOTE_ROOM_ID ?? options.env.PI_KENAN_MEMORY_ROOM_ID;
    const context = (): ReadContext => ({ threadId, turnId, ...(roomId ? { roomId } : {}) });
    const setting = () => ({ person, threadId, ...(roomId ? { roomId } : {}) });
    const request = async (input: MemoryRequest): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown>; isError: boolean }> => {
      const result: MemoryResult<any> = await client.request(input);
      const report = result.ok && result.value && "readReport" in result.value ? (result.value as MemoryRead<unknown>).readReport : undefined;
      if (report?.touchedOtherPeople) readTurns.set(report.turnId, { threadId: report.threadId, turnId: report.turnId, ...(report.roomId ? { roomId: report.roomId } : {}) });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: { memoryResult: result, ...(report ? { [MEMORY_READ_DETAIL]: report } : {}) }, isError: !result.ok };
    };
    pi.registerTool(defineTool({ name: "memory_search", label: "Search Kenan's memory",
      description: "Search shared host memory with ranked, tolerant natural-language terms. Use registered person IDs, not display names, for the optional about filter; omit it to search everyone. An empty query lists recent items. Results are for Kenan's discretion, not automatic disclosure. Stopped items are excluded.",
      parameters: Type.Object({ query: Type.String(), about: Type.Optional(strings), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
      execute: async (_id, input) => request({ operation: "search", ...input, context: context() }),
    }));
    pi.registerTool(defineTool({ name: "memory_read", label: "Read Kenan's memory",
      description: "Read memory items by ID for Kenan's judgment; do not repeat private contents merely because you read them.", parameters: Type.Object({ ids: strings }),
      execute: async (_id, input) => request({ operation: "read", ...input, context: context() }),
    }));
    pi.registerTool(defineTool({ name: "memory_write", label: "Remember",
      description: "Record a durable memory, its subjects, provenance and privacy. This connection supplies the verified setting and person.",
      parameters: Type.Object({ text: Type.String(), about: strings, obviouslyPrivate: Type.Boolean(), occurredAt: optionalTime,
        source: Type.Object({ saidBy: Type.Optional(Type.String()), actedFor: Type.Optional(Type.String()), action: Type.Optional(Type.String()), externalId: Type.Optional(Type.String()) }) }),
      execute: async (_id, input) => request({ operation: "write", item: { ...input, setting: setting() } }),
    }));
    pi.registerTool(defineTool({ name: "memory_forget", label: "Forget",
      description: "Delete stored items or stop using them. Omit mode if the person has not specified which: the tool asks and makes no change.",
      parameters: Type.Object({ ids: strings, mode: Type.Optional(Type.Union([Type.Literal("delete"), Type.Literal("stop-using")])) }),
      execute: async (id, input) => {
        if (!input.mode) {
          const question = "When you say forget, do you mean delete the stored memory, or keep it but stop using it?";
          const asked = await options.ask(id, question, ["Delete it", "Stop using it"]);
          return { content: [{ type: "text" as const, text: JSON.stringify({ clarificationRequired: true, question, asked }) }], details: { clarificationRequired: true } };
        }
        return request({ operation: "forget", ids: input.ids, mode: input.mode });
      },
    }));
    pi.registerTool(defineTool({ name: "memory_disclosures", label: "What Kenan told people about me",
      description: "Read the disclosure log about the verified asking person. Answer from this record, preserving other people's confidences.",
      parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
      execute: async (_id, input) => request({ operation: "disclosures", ...input, context: context() }),
    }));
    pi.registerTool(defineTool({ name: "memory_log_disclosure", label: "Record a disclosure",
      description: "Log exactly what Kenan told whom about whom, including acknowledgements and refusals about private information.",
      parameters: Type.Object({ text: Type.String(), about: strings, to: strings, memoryIds: Type.Optional(strings), occurredAt: optionalTime }),
      execute: async (_id, input) => request({ operation: "log-disclosure", disclosure: { ...input, setting: setting() } }),
    }));
    const discretion = readFileSync(new URL("../discretion.md", import.meta.url), "utf8");
    pi.on("before_agent_start", event => ({ systemPrompt: `${event.systemPrompt}\n\n${discretion}` }));
  };
}
