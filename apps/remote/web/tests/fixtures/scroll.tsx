import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ConversationView } from "../../src/ConversationView";
import { VirtualTranscript } from "../../src/features/conversation/VirtualTranscript";
import type { ChatDrawing } from "../../src/chat-drawing";

const drawing = { isOpen: false, editors: null } as ChatDrawing;
const initial = Array.from({ length: 240 }, (_, index) => ({ id: String(index), height: 45 + index % 7 * 23 }));
function Fixture() {
  const [items, setItems] = useState(initial);
  const [live, setLive] = useState(0);
  return <>
    <button onClick={() => setLive(value => value + 100)}>Grow live answer</button>
    <button onClick={() => { setItems(value => [...value, { id: `final-${value.length}`, height: live }]); setLive(0); }}>Finalize</button>
    <ConversationView active label="Scroll fixture" drawing={drawing} transcript={<>
      <div className="transcript"><VirtualTranscript items={items} itemKey={item => item.id} render={item => <div className="message" data-message-id={item.id} style={{ height: item.height }}>Message {item.id}</div>} /></div>
      <div className="live-answer" style={{ height: live }}>Live answer</div>
    </>} />
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
