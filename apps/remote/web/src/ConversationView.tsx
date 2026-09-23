import { Component, useLayoutEffect, useRef, useState, type ReactNode, type RefObject, type SyntheticEvent } from "react";
import { drawingImage } from "./drawing-drafts";
import { isReadingEarlier, ReadingAnchor, type ReadingSnapshot } from "./scroll-position";
import type { ChatDrawing } from "./chat-drawing";

type ScrollContentProps = { active: boolean; transcript: ReactNode; scrollback: RefObject<HTMLDivElement | null>; anchor: ReadingAnchor };

class ScrollContent extends Component<ScrollContentProps> {
  getSnapshotBeforeUpdate(): ReadingSnapshot | null {
    return this.props.active ? this.props.anchor.beforeUpdate(this.props.scrollback.current) : null;
  }

  componentDidUpdate(_previous: Readonly<ScrollContentProps>, _state: Readonly<{}>, snapshot: ReadingSnapshot | null) {
    if (this.props.active) this.props.anchor.afterUpdate(this.props.scrollback.current, snapshot);
  }

  render() { return <div className="scroll-content">{this.props.transcript}</div>; }
}

export function ConversationView({ active, label, drawing, editImages = true, transcript, children }: {
  active: boolean;
  label: string;
  drawing: ChatDrawing;
  editImages?: boolean;
  transcript: ReactNode;
  children?: ReactNode;
}) {
  const scrollback = useRef<HTMLDivElement>(null);
  const anchor = useRef<ReadingAnchor | null>(null);
  anchor.current ??= new ReadingAnchor();
  const [away, setAway] = useState(false);
  useLayoutEffect(() => {
    const scroller = scrollback.current;
    if (!scroller) return;
    anchor.current?.setReading(scroller, active && away);
    if (active && !away) scroller.scrollTop = 0;
  }, [active]);
  useLayoutEffect(() => {
    const scroller = scrollback.current;
    if (!scroller || !anchor.current?.needsFallback) return;
    const observer = new ResizeObserver(() => anchor.current?.afterResize(scroller));
    observer.observe(scroller.querySelector(".scroll-content")!);
    return () => observer.disconnect();
  }, []);
  const editImage = (event: SyntheticEvent) => {
    if (!editImages || !active) return;
    const image = drawingImage(event.target);
    if (!image) return;
    event.preventDefault();
    event.stopPropagation();
    drawing.editImage(image);
  };
  const jump = () => {
    if (scrollback.current) {
      anchor.current?.setReading(scrollback.current, false);
      scrollback.current.scrollTop = 0;
    }
    setAway(false);
  };
  return <section hidden={!active} className={`conversation${drawing.isOpen ? " is-drawing" : ""}`} aria-label={label}>
    <div className="scrollback-frame">
    <div className={`scrollback${away ? " is-reading" : ""}`} ref={scrollback} onScroll={event => {
      if (!active) return;
      const reading = isReadingEarlier(event.currentTarget.scrollTop);
      anchor.current?.setReading(event.currentTarget, reading);
      setAway(reading);
    }} onClickCapture={editImage} onKeyDownCapture={event => { if (event.key === "Enter" || event.key === " ") editImage(event); }}>
      <ScrollContent active={active} transcript={transcript} scrollback={scrollback} anchor={anchor.current} />
    </div>
    {away && !drawing.isOpen && <button type="button" className="jump-latest" aria-label="Jump to latest" onClick={jump}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14m-6-6 6 6 6-6" /></svg></button>}
    </div>
    {drawing.editors}
    {children}
  </section>;
}
