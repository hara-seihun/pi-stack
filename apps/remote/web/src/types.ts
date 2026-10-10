export type {
  Activity, Bootstrap, Dashboard,
  MachineActionState, PlanCard, QueuedMessage, Session, SlashCommand, StreamEvent, StreamSubscription, SupervisorState,
  ResponseMetrics, ThreadSettings, ThreadStart, ThreadStartContext, TranscriptItemBody, TranscriptItemHead, TranscriptPage,
} from "../../server/protocol";

/** One rendered row of the model context, derived from a transcript item. */
export interface ContextEntry {
  agentSender?: { threadId: string; name?: string };
  /** Quiet native records remain available in classic, but never appear in mono. */
  monoVisibility?: "hidden" | "visible";
  inputOrigin?: "human" | "machine";
  key: string;
  signature: string;
  kind: import("../../server/protocol").TranscriptItemKind;
  label?: string;
  /** Inline text: user, assistant and notice items carry it with the head. */
  text?: string;
  /** Inline text is a preview; exact words belong to the item body. */
  textTruncated?: true;
  /** Collapsed-row text for lazy kinds until their body arrives. */
  preview?: string;
  /** Content hash of the item, and the key its body is fetched and cached by. */
  itemId?: string;
  /** Authoritative head position; live text has no sequence yet. */
  seq?: number;
  /** Bytes of the complete body. */
  size?: number;
  bodyLoaded?: boolean;
  argumentsTruncated?: boolean;
  messageTimestamp?: number;
  inputId?: string;
  inputState?: import("../../../../packages/orchestrator/src/threads/contracts").ThreadInputState;
  identity?: import("../../server/message-protocol").MessageIdentity;
  reactions?: import("../../server/message-protocol").MessageReaction[];
  reply?: import("../../server/message-protocol").MessageReply;
  responseMetrics?: import("../../server/protocol").ResponseMetrics;
  toolCall?: any;
  toolResult?: any;
  time?: number;
  streaming?: boolean;
  /** The live thinking step, which has no item until the capture lands. */
  live?: boolean;
}

export interface Attachment {
  localId: string;
  name: string;
  path: string | null;
  storedName: string | null;
  sessionId: string;
  uploading: boolean;
  environment?: string;
}
