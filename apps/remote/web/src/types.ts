export type {
  Activity, Bootstrap, Dashboard, Governor, GovernorControls,
  MachineActionState, PlanCard, QueuedMessage, Session, SlashCommand, StreamEvent, StreamSubscription, SupervisorState,
  ResponseMetrics, ThreadSettings, ThreadStart, ThreadStartContext, TranscriptItemBody, TranscriptItemHead, TranscriptPage,
} from "../../server/protocol";

/** One rendered row of the model context, derived from a transcript item. */
export interface ContextEntry {
  key: string;
  signature: string;
  kind: string;
  label?: string;
  /** Inline text: user, assistant and notice items carry it with the head. */
  text?: string;
  /** Collapsed-row text for lazy kinds until their body arrives. */
  preview?: string;
  /** Content hash of the item, and the key its body is fetched and cached by. */
  itemId?: string;
  /** Bytes of the complete body. */
  size?: number;
  bodyLoaded?: boolean;
  argumentsTruncated?: boolean;
  messageTimestamp?: number;
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
