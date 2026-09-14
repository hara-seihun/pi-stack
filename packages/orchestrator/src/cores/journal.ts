import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ConversationSource, CoreAgent, CoreId, CoreOutput, PortableConversation } from "./contracts.js";

export function writeCoreState(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

export function readCoreRecords(path: string): Record<string, any>[] {
  if (!existsSync(path)) return [];
  const source = readFileSync(path, "utf8");
  const lines = source.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new Error(`Invalid durable core record at ${path}:${index + 1}`); }
  });
}

export function portableMessage(message: Record<string, unknown>): Record<string, unknown> {
  const fields = ["id", "role", "timestamp", "toolCallId", "toolName", "isError", "stopReason", "errorMessage", "model", "provider", "usage", "command", "output", "exitCode", "customType", "details"];
  const result = Object.fromEntries(fields.filter(key => message[key] !== undefined).map(key => [key, message[key]]));
  result.content = Array.isArray(message.content) ? message.content.map(block => {
    if (!block || typeof block !== "object") return block;
    const { thinkingSignature, textSignature, encrypted_content, encryptedContent, thoughtSignature, ...content } = block;
    return content;
  }) : message.content;
  return result;
}

export function readPortableConversation(path: string, core: ConversationSource): PortableConversation {
  const records = readCoreRecords(path);
  const byId = new Map(records.filter(record => typeof record.id === "string").map(record => [record.id, record]));
  const last = [...records].reverse().find(record => typeof record.id === "string" && record.type !== "session");
  let branch = records;
  if (last && "parentId" in last) {
    branch = [];
    const visited = new Set<string>();
    for (let entry: Record<string, any> | undefined = last; entry; entry = byId.get(entry.parentId)) {
      if (visited.has(entry.id)) throw new Error(`Cyclic conversation branch in ${path}`);
      visited.add(entry.id); branch.push(entry);
    }
    branch.reverse();
  }
  return { version: 1, sourceCore: core,
    messages: branch.filter(record => record.type === "message" || record.type === "custom_message").map(record => portableMessage(record.type === "message" ? record.message : {
      role: "custom", content: record.content, customType: record.customType, details: record.details, timestamp: Date.parse(record.timestamp),
    })), agents: [] };
}

export class CoreJournal {
  readonly portableFile: string;
  readonly eventsFile: string;
  private readonly messages: Record<string, unknown>[];
  private readonly messageKeys = new Set<string>();
  private readonly agents = new Map<string, CoreAgent>();
  private readonly children = new Map<string, CoreJournal>();
  private readonly eventFd: number;
  private readonly messageFd: number;
  private leaf: string | null = null;
  private closed = false;
  constructor(readonly directory: string, readonly core: CoreId, readonly sessionId: string, readonly cwd: string, transfer?: PortableConversation) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.portableFile = join(directory, "conversation.jsonl");
    this.eventsFile = join(directory, "activity.jsonl");
    const records = readCoreRecords(this.portableFile);
    this.messages = readPortableConversation(this.portableFile, core).messages;
    for (const message of this.messages) this.messageKeys.add(this.messageKey(message));
    for (const record of records) {
      if (record.type !== "session" && record.id) this.leaf = record.id;
    }
    const statePath = join(directory, "agents.json");
    if (existsSync(statePath)) for (const agent of JSON.parse(readFileSync(statePath, "utf8")) as CoreAgent[]) this.agents.set(agent.id, agent);
    this.eventFd = openSync(this.eventsFile, "a", 0o600);
    this.messageFd = openSync(this.portableFile, "a", 0o600);
    if (!records.length) {
      this.append(this.messageFd, { type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd, core, representation: "portable-activity" });
      for (const message of transfer?.messages ?? []) this.recordMessage(message);
      for (const agent of transfer?.agents ?? []) this.agents.set(agent.id, agent);
    }
  }
  private append(fd: number, value: unknown): void {
    if (this.closed) throw new Error("Core journal is closed");
    const bytes = Buffer.from(JSON.stringify(value) + "\n");
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
  }
  private messageKey(message: Record<string, unknown>): string {
    if (typeof message.id === "string") return `message:${message.id}`;
    if (message.role === "toolResult" && typeof message.toolCallId === "string") return `tool:${message.toolCallId}`;
    return typeof message.timestamp === "number" ? createHash("sha256").update(JSON.stringify(message)).digest("hex") : "";
  }
  private recordMessage(source: Record<string, unknown>): void {
    const message = portableMessage(source);
    const key = this.messageKey(message);
    if (key && this.messageKeys.has(key)) return;
    const id = randomUUID();
    this.append(this.messageFd, { type: "message", id, parentId: this.leaf, timestamp: new Date().toISOString(), message });
    this.leaf = id;
    this.messageKeys.add(key);
    this.messages.push(message);
  }
  record(event: CoreOutput): void {
    if (event.type === "response") return;
    if (event.type === "conversation_replaced" && Array.isArray(event.messages)) this.replace(event.messages as Record<string, unknown>[]);
    if (event.type === "core_child_event") {
      const agentId = String(event.agentId ?? "");
      if (!agentId || !event.event || typeof event.event !== "object") throw new Error("Invalid child event");
      let child = this.children.get(agentId);
      if (!child) {
        child = new CoreJournal(join(this.directory, "children", createHash("sha256").update(agentId).digest("hex")), this.core, agentId, this.cwd);
        this.children.set(agentId, child);
      }
      child.record(event.event as CoreOutput);
      return;
    }
    if (event.type === "message_end" && event.message && typeof event.message === "object") this.recordMessage(event.message as Record<string, unknown>);
    if (event.type === "core_agent") {
      const agent = event.agent as CoreAgent;
      if (!agent || !agent.id) throw new Error("Invalid core agent event");
      this.agents.set(agent.id, agent);
      writeCoreState(join(this.directory, "agents.json"), [...this.agents.values()]);
    }
    // Context is a projection of messages already retained here. Token deltas
    // stay live; complete messages and operation boundaries are the durable log.
    if (!["message_update", "context_update"].includes(event.type)) this.append(this.eventFd, { timestamp: Date.now(), ...event });
  }
  conversation(): PortableConversation {
    return { version: 1, sourceCore: this.core, messages: structuredClone(this.messages), agents: [...this.agents.values()] };
  }
  seed(messages: Record<string, unknown>[]): void { for (const message of messages) this.recordMessage(message); }
  replace(messages: Record<string, unknown>[]): void {
    const id = randomUUID();
    this.append(this.messageFd, { type: "core_branch", id, parentId: null, timestamp: new Date().toISOString() });
    this.leaf = id;
    this.messages.length = 0;
    this.messageKeys.clear();
    this.seed(messages);
  }
  close(): void {
    if (this.closed) return;
    for (const child of this.children.values()) child.close();
    this.closed = true;
    closeSync(this.messageFd); closeSync(this.eventFd);
  }
}
