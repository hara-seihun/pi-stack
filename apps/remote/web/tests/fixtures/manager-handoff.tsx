import { useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConversationView } from "../../src/ConversationView";
import { Transcript } from "../../src/features/conversation/Transcript";
import "../../src/features/conversation/conversation.css";
import type { ContextEntry } from "../../src/types";
import type { ChatDrawing } from "../../src/chat-drawing";

const drawing = { isOpen: false, editors: null } as ChatDrawing;
const initial: ContextEntry[] = Array.from({ length: 50 }, (_, index) => ({ key: `history:${index}`, signature: `history:${index}`, kind: index % 2 ? "assistant" : "user", inputOrigin: "human", text: `History ${index}\n\n` + "A variable-height message. ".repeat(5 + index % 9) }));
function Fixture() {
  const [entries, setEntries] = useState(initial);
  const [working, setWorking] = useState(false);
  const sequence = useRef(0);
  const [token, setToken] = useState(0);
  const generate = (silent: boolean) => {
    const id = ++sequence.current;
    const user: ContextEntry = { key: `human:${id}`, signature: `human:${id}`, kind: "user", inputOrigin: "human", text: `Request ${id}` };
    const work: ContextEntry = { key: `work:${id}`, signature: `work:${id}`, kind: "notice", text: "Producing a reply" };
    setEntries(value => [...value, user, work]);
    setWorking(true);
    let chunk = 0;
    const interval = setInterval(() => {
      setToken(++chunk);
      if (chunk < 25) return;
      clearInterval(interval);
      // Native live-clear arrives before the durable transcript. It has no
      // timeline content to remove, so the browser cannot clamp up in this gap.
      setToken(0);
      setTimeout(() => {
        const text = silent ? "<silent/>" : "A complete reply arrives at once.\n\n".repeat(40);
        setEntries(value => [...value, { key: `answer:${id}`, signature: `answer:${id}`, kind: "assistant", text, messageTimestamp: id, ...(silent ? { monoVisibility: "hidden" as const } : {}) }]);
        setWorking(false);
      }, 160);
    }, 20);
  };
  useLayoutEffect(() => {
    const scroller = document.querySelector<HTMLElement>(".scrollback")!;
    Object.assign(window, { managerFixture: {
      generate,
      metrics: () => ({ top: scroller.scrollTop, height: scroller.scrollHeight, client: scroller.clientHeight,
        typing: scroller.querySelectorAll(".typing-dots").length,
        replies: scroller.querySelectorAll('article[aria-label="Message from Kenan"]').length,
        live: scroller.querySelectorAll(".live-answer").length }),
    } });
    return () => { Reflect.deleteProperty(window, "managerFixture"); };
  }, []);
  return <>
    <nav><button onClick={() => generate(false)} disabled={working}>Generate complete reply</button><button onClick={() => generate(true)} disabled={working}>Generate silent turn</button></nav>
    <div className="conversation-screen manager-conversation" data-token={token}>
      <ConversationView active label="Manager handoff fixture" drawing={drawing} transcript={<Transcript entries={entries} mono messenger working={working} liveThinking="" thinkingActive={false} sessionId="fixture" home="/" images={null} earlierAvailable={false} loadingEarlier={false} earlierError="" onShowEarlier={() => {}} onEdit={() => {}} onReply={() => {}} />} />
    </div>
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
