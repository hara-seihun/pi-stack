import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { formatThreadMessage } from "../../../packages/orchestrator/src/threads/message-format";
import { copyOutgoingMessage, outgoingAgentMessage, presentAgentMessage } from "./src/features/conversation/agent-message";
import { entryFromHead, entriesFromHeads } from "./src/features/conversation/transcript-entries";
import { Transcript } from "./src/features/conversation/Transcript";
import { deriveTranscriptItems } from "../server/transcript-items";
import type { ThreadMessage } from "../../../packages/orchestrator/src/threads/contracts";
import type { ContextEntry } from "./src/types";
import type { BodyCache } from "./src/client-cache";
import { ItemBodies, ItemBodiesContext } from "./src/features/conversation/item-bodies";

globalThis.location ??= new URL("https://router.test/") as unknown as Location;
const sender = "7c925d87-bc2b-4293-933a-f9ffee9b3592";
const recipient = "303efcde-ee6c-43f5-b3ed-522aa9f34ca4";
const message: ThreadMessage = { id: "one", threadId: recipient, senderId: sender, senderName: "Kelana", text: "Full existing message **content**", images: [], delivery: "steer", source: "explicit", state: "done", createdAt: 1, insertedAt: 1, landedAt: 1 };
const text = formatThreadMessage(message, message.text);
const entry = (text: string): ContextEntry => ({ kind: "user", key: "one", signature: "one", text });

test("new incoming agent words retain immutable sender routes in toggle-controlled disclosures", () => {
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
    expect(html).toMatch(/<span class="agent-route incoming"><span class="agent-route-name">Kelana<\/span><svg[^>]*aria-label="to".*?<span class="agent-route-name self">Kenan<\/span>/);
    expect(html).toContain('class="message-label">KENAN</span>');
    expect(html).toContain("Agent message");
    const disclosures = html.match(/<details class="conversation-step agent-message-step"[^>]*>/g) ?? [];
    expect(disclosures).toHaveLength(1);
    expect(disclosures[0]!.includes('open=""')).toBe(!autoCollapse);
    expect(html).not.toContain("agent_message");
    expect(html.indexOf('data-transcript-seq="1"')).toBeLessThan(html.indexOf("agent-route incoming"));
    expect(html.indexOf("agent-route incoming")).toBeLessThan(html.indexOf('data-transcript-seq="3"'));
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

test("sends and spawns read as this agent's own messages, routed to their recipient, and replace the tool step", () => {
  const words = "Please **review** this.\n\n" + "Details. ".repeat(40);
  const spawned = { ok: true, value: { id: sender, agentName: "Kelana Tazatozaten", title: "Review" } };
  const context = { messages: [
    { role: "assistant", timestamp: 1, content: [
      { type: "toolCall", id: "send", name: "thread_send", arguments: { threadId: sender, text: words } },
      { type: "toolCall", id: "spawn", name: "thread_spawn", arguments: { title: "Review", message: words } },
      { type: "toolCall", id: "refused", name: "thread_send", arguments: { threadId: sender, text: "Closed?" } },
    ] },
    { role: "toolResult", toolCallId: "send", content: [{ type: "text", text: '{"ok":true}' }] },
    { role: "toolResult", toolCallId: "spawn", content: [{ type: "text", text: JSON.stringify(spawned) }] },
    { role: "toolResult", toolCallId: "refused", isError: true, content: [{ type: "text", text: "Thread is closed" }] },
  ] };
  const entries = entriesFromHeads(deriveTranscriptItems(context).map(item => item.head));
  const html = renderToStaticMarkup(<Transcript entries={entries} sessionId={recipient} home="/" images={null} onEdit={() => {}} onReply={() => {}} />);
  expect(html.match(/class="message assistant agent-outgoing"/g)).toHaveLength(3);
  expect(entries.filter(entry => entry.kind === "toolCall").map(entry => outgoingAgentMessage(entry)?.text)).toEqual([words.slice(0, 120) + "…", words.slice(0, 120) + "…", "Closed?"]);
  expect(html.match(/Load full message/g)).toHaveLength(2);
  expect(html).toMatch(/<span class="agent-route outgoing"><span class="agent-route-name self">Kenan<\/span><svg[^>]*><path[^>]*><\/path><\/svg><span class="agent-route-name">Thread 7c925d87<\/span>/);
  expect(html).toContain('class="agent-route-name new" title="Review">New agent</span>');
  expect(html).toContain('class="message-status failed">failed · Thread is closed</footer>');
  expect(html).not.toContain("tool-step");
  expect(html).not.toContain("thread_send");
});

test("truncated outgoing words stay a preview until opened and copy resolves the exact send or spawn body", async () => {
  const words = "Exact native words **λ**. ".repeat(20_000);
  const preview = words.slice(0, 120) + "…";
  for (const tool of ["thread_send", "thread_spawn"] as const) {
    const args = tool === "thread_send" ? { threadId: sender, text: words } : { title: "Review", message: words };
    const context = { messages: [{ role: "assistant", content: [{ type: "toolCall", id: tool, name: tool, arguments: args }] }] };
    const item = deriveTranscriptItems(context).at(-1)!;
    const outgoing = entryFromHead(item.head);
    const full = JSON.parse(item.body);
    expect(outgoing.argumentsTruncated).toBe(true);
    expect(outgoingAgentMessage(outgoing)?.text).toBe(preview);
    expect(outgoingAgentMessage(outgoing, full)?.text).toBe(words);
    let loads = 0;
    const known = new Map([[item.head.id, full]]);
    const cache: BodyCache = {
      retainBody: () => () => {}, getBody: id => known.get(id), acceptBody: (id, body) => { known.set(id, body); },
      loadBody: (_id, _size, fetcher) => fetcher(),
    };
    const bodies = new ItemBodies(recipient, async () => { loads++; return full; }, cache);
    const html = renderToStaticMarkup(<ItemBodiesContext.Provider value={bodies}><Transcript entries={[outgoing]} sessionId={recipient} home="/" images={null} onEdit={() => {}} onReply={() => {}} /></ItemBodiesContext.Provider>);
    expect(html).toContain("Load full message");
    expect(html).toContain('aria-label="Copy full message"');
    expect(html).not.toContain(words);
    expect(loads).toBe(0);
    let copies = 0;
    expect(await copyOutgoingMessage(outgoing, async () => { copies++; return full; })).toBe(words);
    expect(copies).toBe(1);
    await expect(copyOutgoingMessage(outgoing, async () => undefined)).rejects.toThrow("could not be loaded");
  }
});

test("copying untruncated outgoing words needs no body load", async () => {
  const outgoing: ContextEntry = { kind: "toolCall", key: "send", signature: "send", toolCall: { name: "thread_send", arguments: { threadId: sender, text: "Exact short message" } } };
  expect(await copyOutgoingMessage(outgoing, async () => { throw new Error("No load is needed"); })).toBe("Exact short message");
});

test("all three native user-role envelopes collapse without requiring explicit source metadata", () => {
  const prefix = "<agent_message>\nThis is an agent-to-agent message, not a user message.\n";
  const envelopes = [
    { metadata: { senderThreadId: sender, senderName: "Kelana", recipientThreadId: recipient, messageId: "explicit", source: "explicit" }, words: "Explicit full update", label: "Kelana" },
    { metadata: { senderThreadId: sender, senderName: "Kelana" }, words: '{"type":"thread_idle","outcome":"completed","finalText":"Completion full report"}', label: "Kelana" },
    { metadata: { senderThreadId: "kenan-root" }, words: "Root full reply", label: "Agent · kenan-ro" },
  ];
  for (const { metadata, words, label } of envelopes) {
    const raw = prefix + JSON.stringify(metadata) + "\n\n" + words + "\n</agent_message>";
    const native = { messages: [{ role: "user", content: raw }] };
    const projected = entriesFromHeads(deriveTranscriptItems(native).map(item => item.head)).at(-1)!;
    const historical = entryFromHead({ kind: "user", seq: 0, id: "old", size: raw.length, text: raw });
    for (const incoming of [projected, historical]) {
      expect(incoming.agentSender?.threadId).toBe(metadata.senderThreadId);
      expect(incoming.label).toBe(label);
      expect(incoming.text).toBe(words.startsWith('{"type"') ? "Completion full report" : words);
      for (const autoCollapse of [true, false]) {
        const html = renderToStaticMarkup(<Transcript entries={[incoming]} sessionId={recipient} home="/" images={null} autoCollapse={autoCollapse} onEdit={() => {}} onReply={() => {}} />);
        const opening = html.match(/<details class="conversation-step agent-message-step"[^>]*>/)?.[0];
        expect(opening).toBeDefined();
        expect(opening!.includes('open=""')).toBe(!autoCollapse);
        expect(html).toContain(`agent-route-name">${label}</span>`);
        expect(html).not.toContain("work-card");
      }
    }
    expect(native.messages[0]!.content).toBe(raw);
  }
});

test("send and spawn disclosures honor both toggle states in historical and streamed delivery states", () => {
  for (const name of ["thread_send", "thread_spawn"]) for (const completed of [false, true]) {
    const args = name === "thread_send" ? { threadId: sender, text: "Exact outgoing update" } : { title: "Topic-only title", message: "Exact outgoing task" };
    const outgoing: ContextEntry = { kind: "toolCall", key: name, signature: `${name}:${completed}`, toolCall: { name, arguments: args }, ...(completed ? { toolResult: { preview: "Accepted", size: 8, isError: false } } : {}) };
    for (const autoCollapse of [true, false]) {
      const html = renderToStaticMarkup(<Transcript entries={[outgoing]} sessionId={recipient} home="/" images={null} autoCollapse={autoCollapse} onEdit={() => {}} onReply={() => {}} />);
      const opening = html.match(/<details class="conversation-step agent-message-step"[^>]*>/)?.[0];
      expect(opening).toBeDefined();
      expect(opening!.includes('open=""')).toBe(!autoCollapse);
      expect(html).toContain("agent-route outgoing");
      expect(html).not.toContain("work-card");
    }
  }
});
