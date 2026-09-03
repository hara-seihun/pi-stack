export type {
  Activity, AgentHostStatus, AgentRun, AgentRunEvent, Dashboard, DocumentUpdate, Governor, GovernorControls,
  MachineActionState, PlanCard, QueuedMessage, Session, SlashCommand, SupervisorState, SyncRequest, SyncResponse,
  ThreadSettings, ThreadStart,
} from "../../server/protocol";

export interface ContextEntry {
  key: string;
  signature: string;
  kind: string;
  label?: string;
  text?: string;
  messageTimestamp?: number;
  toolCall?: any;
  toolResult?: any;
  time?: number;
  streaming?: boolean;
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
