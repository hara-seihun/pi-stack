// The + button belongs to the first paint of the inbox; the picker behind it
// does not. Archived search, the messaging directory, account linking and its
// QR code are a screen of their own, and most inbox visits never open it.

import { forwardRef, lazy, Suspense, useCallback, useImperativeHandle, useRef, useState } from "react";
import type { ChatPickerEntry, ChatPickerHandle, ChatPickerProps } from "./thread-start-menu";
import "./chat-picker-trigger.css";

const RealChatPicker = lazy(() => import("./thread-start-menu").then(module => ({ default: module.ChatPicker })));

export const LazyChatPicker = forwardRef<ChatPickerHandle, ChatPickerProps>(function LazyChatPicker(props, ref) {
  const [wanted, setWanted] = useState(false);
  const [entry, setEntry] = useState<ChatPickerEntry>({ kind: "root" });
  const picker = useRef<ChatPickerHandle>(null);
  const open = useCallback((next: ChatPickerEntry = { kind: "root" }) => {
    setEntry(next);
    if (picker.current) picker.current.open(next);
    else setWanted(true);
  }, []);
  useImperativeHandle(ref, () => ({ open }), [open]);
  if (wanted) return <Suspense fallback={<Placeholder busy />}><RealChatPicker {...props} ref={picker} initialEntry={entry} /></Suspense>;
  return <Placeholder onWant={() => open()} />;
});

function Placeholder({ busy = false, onWant }: { busy?: boolean; onWant?(): void }) {
  return <div className="chat-picker">
    <button type="button" className="icon-button chat-picker-trigger" aria-label="New or open chat" title="New or open chat" aria-expanded={false} aria-haspopup="dialog" aria-busy={busy || undefined} onClick={onWant}>+</button>
  </div>;
}
