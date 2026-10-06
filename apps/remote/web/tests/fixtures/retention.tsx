import { useState } from "react";
import { createRoot } from "react-dom/client";
import { VirtualTranscript } from "../../src/features/conversation/VirtualTranscript";
import { StatusPill } from "../../src/features/status/StatusPill";

const messageIds = (value: number) => [`m${value}`];
const started = Date.now() - 1_000;
const status = { key: "thinking" as const, label: "Thinking", short: "Thinking", busy: true, attention: false, since: started };
function Fixture() {
  const [count, setCount] = useState(600);
  const [hidden, setHidden] = useState(false);
  return <>
    <button onClick={() => setCount(value => value + 10_000)}>Append 10000</button>
    <button onClick={() => setHidden(value => !value)}>Toggle hidden pane</button>
    <span id="visible-clock"><StatusPill status={status} /></span>
    <div hidden={hidden} id="pane-clock"><StatusPill status={status} /></div>
    <div className="scrollback" style={{ height: 360, display: "flex", flexDirection: "column-reverse", overflow: "auto", overflowAnchor: "auto" }}>
      <div className="scroll-content transcript" style={{ flex: "none" }}><VirtualTranscript messageIds={messageIds} items={Array.from({ length: count }, (_, n) => n)} itemKey={String} render={value => <p style={{ height: 50, margin: 0 }} data-row={value} data-message-id={`m${value}`}>Row {value}</p>} /></div>
    </div>
    <div style={{ height: 10_000 }} />
    <span id="offscreen-clock"><StatusPill status={status} /></span>
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
