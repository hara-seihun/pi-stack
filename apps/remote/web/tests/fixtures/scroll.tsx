import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConversationView } from "../../src/ConversationView";
import { VirtualTranscript } from "../../src/features/conversation/VirtualTranscript";
import type { ChatDrawing } from "../../src/chat-drawing";

const drawing = { isOpen: false, editors: null } as ChatDrawing;
const initial = Array.from({ length: 240 }, (_, index) => ({ id: String(index), height: 45 + index % 7 * 23 }));
function Fixture() {
  const [items, setItems] = useState(initial);
  const [live, setLive] = useState(0);
  const [above, setAbove] = useState(0);
  const [streaming, setStreaming] = useState(false);
  const [revision, setRevision] = useState(0);
  const currentLive = useRef(live);
  currentLive.current = live;
  useEffect(() => {
    if (!streaming) return;
    const interval = setInterval(() => setLive(value => value + 12), 50);
    return () => clearInterval(interval);
  }, [streaming]);
  useLayoutEffect(() => {
    const scroller = document.querySelector<HTMLElement>(".scrollback")!;
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
    const writes: { from: number; to: number; at: number }[] = [];
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get() { return descriptor.get!.call(this); },
      set(value) { writes.push({ from: descriptor.get!.call(this), to: value, at: performance.now() }); descriptor.set!.call(this, value); },
    });
    Object.assign(window, { scrollFixture: {
      grow: () => setLive(value => value + 100),
      above: (height: number) => setAbove(height),
      finalize: () => { setItems(value => [...value, { id: `final-${value.length}`, height: currentLive.current }]); setLive(0); },
      clearWrites: () => { writes.length = 0; },
      metrics: () => {
        const viewport = scroller.getBoundingClientRect();
        const visible = [...scroller.querySelectorAll<HTMLElement>("[data-message-id]")].find(node => {
          const rect = node.getBoundingClientRect(); return rect.top >= viewport.top && rect.top < viewport.bottom;
        });
        return { top: scroller.scrollTop, height: scroller.scrollHeight, client: scroller.clientHeight,
          anchor: visible?.dataset.messageId, anchorTop: visible?.getBoundingClientRect().top,
          rows: scroller.querySelectorAll("[data-virtual-key]").length, writes: [...writes] };
      },
    } });
    return () => { Reflect.deleteProperty(scroller, "scrollTop"); Reflect.deleteProperty(window, "scrollFixture"); };
  }, []);
  return <>
    <button onClick={() => setLive(value => value + 100)}>Grow live answer</button>
    <button onClick={() => { setItems(value => [...value, { id: `final-${value.length}`, height: live }]); setLive(0); }}>Finalize</button>
    <button onClick={() => setStreaming(value => !value)}>{streaming ? "Stop streaming" : "Start streaming"}</button>
    <button onClick={() => setAbove(value => value ? 0 : 400)}>Toggle content above viewport</button>
    <button onClick={() => setRevision(value => value + 1)}>Rerender</button>
    <ConversationView active label="Scroll fixture" drawing={drawing} transcript={<>
      <div className="transcript" data-revision={revision}><div style={{ height: above }} />
        <VirtualTranscript items={items} itemKey={item => item.id} render={item => <div className="message" data-message-id={item.id} style={{ height: item.height }}>Message {item.id}</div>} />
      </div>
      <div className="live-answer" style={{ height: live }}>Live answer</div>
    </>} />
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
