import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ConversationView } from "../../src/ConversationView";
import { Transcript } from "../../src/features/conversation/Transcript";
import type { ContextEntry } from "../../src/types";
import type { ChatDrawing } from "../../src/chat-drawing";

const drawing = { isOpen: false, editors: null } as ChatDrawing;
const noAction = () => {};
const entry = (key: string, kind: ContextEntry["kind"], fields: Partial<ContextEntry>): ContextEntry => ({ key, kind, signature: key, ...fields });
const initial = Array.from({ length: 100 }, (_, n) => [
  entry(`human-${n}`, "user", { text: `Human request ${n}`, seq: n * 6 }),
  entry(`thinking-${n}`, "thinking", { text: `Thinking detail ${n}`, seq: n * 6 + 1 }),
  entry(`send-${n}`, "toolCall", { seq: n * 6 + 2, toolCall: { name: "thread_send", arguments: { threadId: "worker", text: `Assignment ${n}` } }, toolResult: { isError: false } }),
  entry(`incoming-${n}`, "user", { text: `Worker report ${n}`, agentSender: { threadId: "worker", name: "Worker" }, seq: n * 6 + 3 }),
  entry(`reply-${n}`, "assistant", { text: `Visible reply ${n}`, seq: n * 6 + 4 }),
  entry(`notice-${n}`, "notice", { text: `Settlement notice ${n}`, seq: n * 6 + 5 }),
]).flat();
function Fixture() {
  const [entries, setEntries] = useState(initial);
  const [thinking, setThinking] = useState(false);
  const [revision, setRevision] = useState(0);
  return <>
    <button onClick={() => setEntries(value => [...value, entry(`late-${value.length}`, "notice", { text: "Late notice", seq: value.length })])}>Append activity</button>
    <button onClick={() => setThinking(value => !value)}>Toggle live thinking</button>
    <button onClick={() => setRevision(value => value + 1)}>Rerender manager</button>
    <ConversationView active label="Manager fixture" drawing={drawing} transcript={<div data-revision={revision}>
      <Transcript mono entries={entries} liveThinking={thinking ? "Streaming thought" : ""} thinkingActive={thinking} sessionId="manager" home="/work" images={null} onEdit={noAction} onReply={noAction} />
    </div>} />
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
