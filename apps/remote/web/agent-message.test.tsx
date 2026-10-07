import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { formatThreadMessage } from "../../../packages/orchestrator/src/threads/message-format";
import { presentAgentMessage } from "./src/features/conversation/agent-message";
import { entryFromHead, entriesFromHeads } from "./src/features/conversation/transcript-entries";
import { Transcript } from "./src/features/conversation/Transcript";
import { deriveTranscriptItems } from "../server/transcript-items";
import type { ThreadMessage } from "../../../packages/orchestrator/src/threads/contracts";
import type { ContextEntry } from "./src/types";

globalThis.location ??= new URL("https://router.test/") as unknown as Location;
const sender = "7c925d87-bc2b-4293-933a-f9ffee9b3592";
const recipient = "303efcde-ee6c-43f5-b3ed-522aa9f34ca4";
const message: ThreadMessage = { id: "one", threadId: recipient, senderId: sender, senderName: "Kelana", text: "Full existing message **content**", images: [], delivery: "steer", source: "explicit", state: "done", createdAt: 1, insertedAt: 1, landedAt: 1 };
const text = formatThreadMessage(message, message.text);
const entry = (text: string): ContextEntry => ({ kind: "user", key: "one", signature: "one", text });

test("new incoming agent words render under the immutable sender name, without a disclosure or wrapper", () => {
  const context = { messages: [
    { role: "user", timestamp: 1, content: "Human message" },
    { role: "user", timestamp: 2, content: text, identity: { id: "incoming", timestamp: 2, sender: { id: "person", name: "User" } } },
    { role: "assistant", timestamp: 3, content: "Kenan user-facing reply", identity: { id: "own", timestamp: 3, sender: { id: recipient, name: "Nebulani worker name" } } },
  ] };
  const native = JSON.stringify(context);
  const items = deriveTranscriptItems(context);
  const entries = entriesFromHeads(items.map(item => item.head));
  const incoming = entries.find(entry => entry.agentSender)!;
  expect(incoming).toMatchObject({ kind: "user", label: "Kelana", text: message.text, agentSender: { threadId: sender, name: "Kelana" } });
  expect(JSON.parse(items[2].body)).toEqual({ kind: "user", text: message.text });
  expect(items[3].head).toMatchObject({ kind: "assistant", label: "Kenan" });
  expect(incoming.identity?.id).toBe("incoming");
  for (const autoCollapse of [true, false]) {
    const html = renderToStaticMarkup(<Transcript entries={entries} sessionId={recipient} home="/" images={null} autoCollapse={autoCollapse} onEdit={() => {}} onReply={() => {}} />);
    expect(html).toContain('class="message-label">KELANA</span>');
    expect(html).toContain('class="message-label">KENAN</span>');
    expect(html).not.toContain("Agent message");
    expect(html).not.toContain("agent-message-step");
    expect(html).not.toContain("agent_message");
    expect(html.indexOf('data-transcript-seq="1"')).toBeLessThan(html.indexOf("KELANA"));
    expect(html.indexOf("KELANA")).toBeLessThan(html.indexOf('data-transcript-seq="3"'));
  }
  expect(JSON.stringify(context)).toBe(native);
});

test("old cached heads, new streamed heads and attachments share the body projection", () => {
  const attachment = "\n\n![Context image](/v1/sessions/example/image)";
  const cached = entryFromHead({ kind: "user", seq: 1, id: "old", size: text.length, text: text + attachment });
  const streamed = entryFromHead({ kind: "user", seq: 1, id: "new", size: 10, text: message.text + attachment, agentSender: { threadId: sender, name: "Kelana" } });
  expect(cached.text).toBe(streamed.text);
  expect(cached.label).toBe(streamed.label);
  const native = { messages: [{ role: "user", content: [{ type: "text", text }, { type: "image", src: "/v1/sessions/example/image" }] }] };
  const projected = entriesFromHeads(deriveTranscriptItems(native).map(item => item.head)).at(-1)!;
  expect(projected.text).toBe(streamed.text);
  expect(projected.agentSender).toEqual(streamed.agentSender);
});

test("historical senders resolve to their known name, or an explicitly unidentified agent, never title or User", () => {
  const historical = formatThreadMessage({ ...message, senderName: undefined }, message.text);
  const context = { messages: [{ role: "user", content: historical }] };
  const known = entriesFromHeads(deriveTranscriptItems(context, id => id === sender ? "Renian" : undefined).map(item => item.head)).at(-1)!;
  const unknown = entriesFromHeads(deriveTranscriptItems(context).map(item => item.head)).at(-1)!;
  expect(known.label).toBe("Renian");
  expect(unknown.label).toBe("Agent · 7c925d87");
  expect(presentAgentMessage(entry(historical)).label).toBe(unknown.label);
  expect(unknown.text).toBe(message.text);
});

test("scheduled senders and recipients render by name just like UUID threads", () => {
  const scheduled = { ...message, senderId: "schedule:digest:100000", threadId: "schedule:followup:100001" };
  const incoming = entriesFromHeads(deriveTranscriptItems({ messages: [{ role: "user", content: formatThreadMessage(scheduled, scheduled.text) }] }).map(item => item.head)).at(-1)!;
  expect(incoming).toMatchObject({ label: "Kelana", text: scheduled.text, agentSender: { threadId: scheduled.senderId, name: "Kelana" } });
  expect(presentAgentMessage(entry(formatThreadMessage(scheduled, scheduled.text))).text).toBe(scheduled.text);
});

test("completion reports hide both transport and thread_idle JSON, retaining final words, errors and attachments", () => {
  const notice = { ...message, source: "notification" as const, text: '{"type":"thread_idle","outcome":"failed","finalText":"Here is the result.","error":"publish failed"}' };
  const incoming = presentAgentMessage(entry(formatThreadMessage(notice, notice.text) + "\n\n![Context image](/image)"));
  expect(incoming.label).toBe("Kelana");
  expect(incoming.text).toBe("Here is the result.\n\npublish failed\n\n![Context image](/image)");
});

test("ordinary human text, quoted examples and malformed envelopes are not relabelled or stripped", () => {
  for (const human of ["Hello", "Please explain <agent_message>", "```\n" + text + "\n```", "> " + text, text.replace(sender, " "), text.replace('"source":"explicit"', '"source":"unknown"'), text.replace("</agent_message>", ""), text.replace('"senderThreadId"', '"sender"'), text.replace('{"senderThreadId"', '{oops"senderThreadId"'), text.replace('"senderName":"Kelana"', '"senderName":3')]) {
    const original = entry(human);
    expect(presentAgentMessage(original)).toBe(original);
  }
  for (const kind of ["assistant", "thinking"] as const) {
    const original = { ...entry(text), kind };
    expect(presentAgentMessage(original)).toBe(original);
  }
});

test("projection strips exactly the transport, never a quoted envelope in the agent's message body", () => {
  const nested = formatThreadMessage(message, text);
  const context = { messages: [{ role: "user", content: nested }] };
  const projected = entriesFromHeads(deriveTranscriptItems(context).map(item => item.head)).at(-1)!;
  const cached = entryFromHead({ kind: "user", seq: 1, id: "cached", size: nested.length, text: nested });
  for (const presented of [projected, cached]) {
    expect(presented.text).toBe(text);
    expect(presentAgentMessage(presented)).toBe(presented);
  }
});

test("changing a head's sender label invalidates memoized message presentation", () => {
  const original = { kind: "user" as const, seq: 1, id: "same-body", size: 10, text: "Words", agentSender: { threadId: sender } };
  const unnamed = entryFromHead(original);
  const named = entryFromHead({ ...original, agentSender: { threadId: sender, name: "Kelana" } });
  expect(named.signature).not.toBe(unnamed.signature);
});
