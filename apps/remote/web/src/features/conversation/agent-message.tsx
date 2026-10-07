import { agentMessagePresentation, agentSenderLabel } from "pi-orchestrator/message-format";
import type { ContextEntry } from "../../types";

/** Old cached heads and new server projections share the same human presentation. */
export function presentAgentMessage(entry: ContextEntry): ContextEntry {
  if (entry.kind !== "user") return entry;
  const envelope = entry.agentSender || entry.text === undefined ? null : agentMessagePresentation(entry.text);
  const sender = entry.agentSender ?? envelope?.sender;
  if (!sender) return entry;
  const label = agentSenderLabel(sender);
  const text = envelope ? envelope.text : entry.text;
  if (entry.agentSender && entry.label === label && entry.text === text) return entry;
  return { ...entry, label, text, agentSender: sender, signature: `${entry.signature}:agent:${JSON.stringify(sender)}:${label}` };
}
