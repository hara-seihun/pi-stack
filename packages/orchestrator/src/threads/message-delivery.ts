import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentSession, SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { readPersonTimezone, type PersonTimezone } from "../person-settings.js";

export const MESSAGE_DELIVERY_RECEIPT = "model_message_delivery_v1";
export type DeliveryTimezone = { state: "configured"; zone: string } | { state: "unconfigured" };
export type DeliveryError = { code: "invalid" | "unavailable"; message: string };
export type DeliveryResult<T> = { ok: true; value: T } | { ok: false; error: DeliveryError };
export type MessageDeliveryReceipt = { key: string; originalTimestamp: number; deliveredAt: number; timezone: PersonTimezone | null; prefix: string };
type DeliveryManager = Pick<SessionManager, "getBranch" | "appendCustomEntry">;
const stamped = Symbol("model-message-delivery");
type StampedMessage = AgentMessage & { [stamped]?: true };
const deliveryScope = new AsyncLocalStorage<"preview">();

export function previewMessageDelivery<T>(operation: () => Promise<T>): Promise<T> {
  return deliveryScope.run("preview", operation);
}

export function deliveryPrefix(at: number, timezone: DeliveryTimezone): DeliveryResult<string> {
  if (!Number.isFinite(at) || Number.isNaN(new Date(at).getTime())) return { ok: false, error: { code: "invalid", message: "Invalid model delivery time" } };
  if (timezone.state === "unconfigured") return { ok: true, value: `[Model delivery: ${new Date(at).toISOString()} (UTC +00:00; timezone-unconfigured)]\n` };
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone.zone, calendar: "iso8601", numberingSystem: "latn",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
      fractionalSecondDigits: 3, hourCycle: "h23", timeZoneName: "longOffset" }).formatToParts(at);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    const offset = values.timeZoneName === "GMT" ? "+00:00" : values.timeZoneName.replace(/^GMT/, "");
    return { ok: true, value: `[Model delivery: ${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}.${values.fractionalSecond} ${offset} (${timezone.zone})]\n` };
  } catch (error) { return { ok: false, error: { code: "invalid", message: `Invalid user timezone: ${error instanceof Error ? error.message : String(error)}` } }; }
}

function prefixMessage(message: AgentMessage, prefix: string): DeliveryResult<AgentMessage> {
  if (message.role === "assistant" || (message as StampedMessage)[stamped]) return { ok: true, value: message };
  switch (message.role) {
    case "system": case "user": case "toolResult": case "custom": {
      const content = typeof message.content === "string" ? prefix + message.content : [{ type: "text" as const, text: prefix }, ...message.content];
      return { ok: true, value: { ...message, content, [stamped]: true } as StampedMessage };
    }
    case "compactionSummary": case "branchSummary": return { ok: true, value: { ...message, summary: prefix + message.summary, [stamped]: true } as StampedMessage };
    case "bashExecution": return { ok: true, value: { ...message, output: prefix + message.output, [stamped]: true } as StampedMessage };
  }
  return { ok: false, error: { code: "invalid", message: `Unsupported incoming model-message role: ${(message as { role: string }).role}` } };
}

function sourceKeys(branch: SessionEntry[]): Map<string, string[]> {
  const sources = new Map<string, string[]>();
  const add = (role: string, timestamp: number, id: string) => {
    const provenance = `${role}:${timestamp}`;
    sources.set(provenance, [...(sources.get(provenance) ?? []), id]);
  };
  for (const entry of branch) {
    switch (entry.type) {
      case "message": {
        add(entry.message.role, entry.message.timestamp, entry.id);
        if (entry.message.role === "custom" || entry.message.role === "bashExecution") add("user", entry.message.timestamp, entry.id);
        break;
      }
      case "custom_message": add("custom", Date.parse(entry.timestamp), entry.id); add("user", Date.parse(entry.timestamp), entry.id); break;
      case "compaction": {
        add("compactionSummary", Date.parse(entry.timestamp), entry.id);
        add("user", Date.parse(entry.timestamp), entry.id);
        if (entry.systemMessage) add("system", entry.systemMessage.timestamp, `${entry.id}:system`);
        break;
      }
      case "branch_summary": add("branchSummary", Date.parse(entry.timestamp), entry.id); add("user", Date.parse(entry.timestamp), entry.id); break;
    }
  }
  return sources;
}

export function createMessageDeliveryProjection(manager: DeliveryManager, env: NodeJS.ProcessEnv,
  now: () => number = Date.now): (messages: AgentMessage[]) => DeliveryResult<AgentMessage[]> {
  return messages => {
    const branch = manager.getBranch();
    const receipts = new Map<string, MessageDeliveryReceipt>();
    for (const entry of branch) if (entry.type === "custom" && entry.customType === MESSAGE_DELIVERY_RECEIPT) {
      const data = entry.data as { receipts?: MessageDeliveryReceipt[] } | undefined;
      if (!data || !Array.isArray(data.receipts) || data.receipts.some(receipt => typeof receipt?.key !== "string" || typeof receipt.prefix !== "string" || !Number.isFinite(receipt.originalTimestamp) || !Number.isFinite(receipt.deliveredAt))) {
        return { ok: false, error: { code: "invalid", message: "Invalid model message delivery receipt" } };
      }
      for (const receipt of data.receipts) receipts.set(receipt.key, receipt);
    }
    let delivery: { at: number; timezone: PersonTimezone | null; prefix: string } | null = null;
    if (deliveryScope.getStore() !== "preview") {
      const settingsData = env.PI_PERSON_SETTINGS_DATA ?? env.PI_REMOTE_DATA;
      const timezone = settingsData ? readPersonTimezone(settingsData) : { ok: true as const, value: null };
      if (!timezone.ok) return { ok: false, error: { code: "unavailable", message: `Cannot resolve owner timezone: ${timezone.error.message}` } };
      const at = now();
      const prefix = deliveryPrefix(at, timezone.value ? { state: "configured", zone: timezone.value.zone } : { state: "unconfigured" });
      if (!prefix.ok) return prefix;
      delivery = { at, timezone: timezone.value, prefix: prefix.value };
    }
    const sources = sourceKeys(branch), occurrences = new Map<string, number>();
    const pending: MessageDeliveryReceipt[] = [], projected: AgentMessage[] = [];
    for (const message of messages) {
      if (message.role === "assistant" || (message as StampedMessage)[stamped]) { projected.push(message); continue; }
      const provenance = `${message.role}:${message.timestamp}`;
      const occurrence = occurrences.get(provenance) ?? 0;
      occurrences.set(provenance, occurrence + 1);
      const sourceId = sources.get(provenance)?.[occurrence];
      const key = sourceId ? `entry:${sourceId}:${message.role}` : `generated:${provenance}:${occurrence}`;
      if (!Number.isFinite(message.timestamp)) return { ok: false, error: { code: "invalid", message: "Incoming model message is missing timestamp provenance" } };
      let receipt = receipts.get(key);
      if (!receipt) {
        if (delivery === null) { projected.push(message); continue; }
        receipt = { key, originalTimestamp: message.timestamp, deliveredAt: delivery.at, timezone: delivery.timezone, prefix: delivery.prefix };
        pending.push(receipt);
      }
      const result = prefixMessage(message, receipt.prefix);
      if (!result.ok) return result;
      projected.push(result.value);
    }
    if (pending.length) {
      try { manager.appendCustomEntry(MESSAGE_DELIVERY_RECEIPT, { receipts: pending }); }
      catch (error) { return { ok: false, error: { code: "unavailable", message: `Cannot record model delivery: ${error instanceof Error ? error.message : String(error)}` } }; }
    }
    return { ok: true, value: projected };
  };
}

const installed = new WeakSet<object>();

export function installMessageDelivery(session: Pick<AgentSession, "agent" | "sessionManager">, env: NodeJS.ProcessEnv): void {
  if (installed.has(session.agent)) return;
  installed.add(session.agent);
  const original = session.agent.convertToLlm.bind(session.agent);
  const project = createMessageDeliveryProjection(session.sessionManager, env);
  session.agent.convertToLlm = async messages => {
    const result = project(await original(messages));
    if (!result.ok) throw new Error(`Context rejected: ${result.error.code}: ${result.error.message}`);
    return result.value as Message[];
  };
}

