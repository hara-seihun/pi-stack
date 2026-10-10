import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ConversationView } from "../../src/ConversationView";
import { Transcript } from "../../src/features/conversation/Transcript";
import { ThreadDirectoryProvider, type ThreadDirectory } from "../../src/features/conversation/thread-chips";
import type { ContextEntry } from "../../src/types";
import type { ChatDrawing } from "../../src/chat-drawing";

const drawing = { isOpen: false, editors: null } as ChatDrawing;
const noAction = () => {};
const peers = Array.from({ length: 7 }, (_, n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
const directory: ThreadDirectory = { name: id => `Child ${peers.indexOf(id) + 1}`, busy: () => false, discover: noAction, lookupError: () => null, open: noAction };
const entry = (key: string, kind: ContextEntry["kind"], fields: Partial<ContextEntry>): ContextEntry => ({ key, kind, signature: key, ...fields });
const initial = Array.from({ length: 100 }, (_, n) => [
  entry(`human-${n}`, "user", { text: `Human request ${n}`, seq: n * 8 }),
  entry(`thinking-${n}`, "thinking", { text: `Thinking detail ${n}`, seq: n * 8 + 1 }),
  entry(`send-${n}`, "toolCall", { seq: n * 8 + 2, toolCall: { name: "thread_send", arguments: { threadId: "worker", text: `Assignment ${n}` } }, toolResult: { isError: false } }),
  entry(`incoming-${n}`, "user", { text: `Worker report ${n}`, agentSender: { threadId: "worker", name: "Worker" }, seq: n * 8 + 3 }),
  entry(`reply-${n}`, "assistant", { text: `Visible reply ${n}`, seq: n * 8 + 4 }),
  entry(`notice-${n}`, "notice", { text: `Settlement notice ${n}`, seq: n * 8 + 5 }),
  entry(`wait-${n}`, "toolCall", { seq: n * 8 + 6, argumentsTruncated: true, toolCall: { name: "thread_wait", arguments: { action: "set", kind: "agents", threadIds: peers.slice(0, 5), threadCount: 7 } }, toolResult: { isError: false, preview: '{"ok":true,"value":{"waitingOnAgents":{}}}', size: 500 } }),
  entry(`bash-${n}`, "toolCall", { seq: n * 8 + 7, toolCall: { name: "bash", arguments: { command: "printf fixture" } }, toolResult: { isError: false, preview: "fixture", size: 7 } }),
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
      <ThreadDirectoryProvider value={directory}><Transcript mono entries={entries} liveThinking={thinking ? "Streaming thought" : ""} thinkingActive={thinking} sessionId="manager" home="/work" images={null} onEdit={noAction} onReply={noAction} /></ThreadDirectoryProvider>
    </div>} />
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
