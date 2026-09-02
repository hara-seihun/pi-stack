export type Activity = "IDLE" | "FAILED" | "STARTING" | "ABORTING" | "RUNNING" | "WORKING" | "THINKING" | "COMPACTING" | "RETRYING" | "QUEUED" | "WAITING_ON_TOOL" | string;

export interface Session {
  id: string;
  name: string;
  cwd: string;
  workspaceName?: string;
  environment?: string;
  provider?: string;
  state: string;
  activity: Activity;
  activeTool?: string;
  revision: number;
  steeringQueued?: number;
  followUpQueued?: number;
  queuedMessages?: QueuedMessage[];
  archivedAt?: string | null;
}

export interface QueuedMessage {
  id: string;
  text: string;
  status?: string;
  canSteer?: boolean;
  canHardSteer?: boolean;
  canCancel?: boolean;
}

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
}

export interface AgentRun {
  id: string;
  host?: string;
  hostName?: string;
  label: string;
  taskId: string;
  status: string;
  activity?: Activity;
  activeTool?: string;
  elapsedMs?: number;
  provider?: string;
  model?: string;
  thinking?: string;
  observable?: boolean;
  teamRole?: "supervisor" | "worker";
  teamSlot?: number;
  startedAt?: string;
}

export interface AgentHost {
  key: string;
  name?: string;
  label?: string;
  running?: number;
  error?: string | null;
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

export interface ThreadStart {
  id: string;
  label: string;
  icon: string;
  accent?: string;
  models?: Array<{ id: string; label: string; icon: string; accent?: string }>;
}

export interface PlanCard {
  icon: string;
  label: string;
  metrics?: Array<{ model: string; modelLabel: string; text: string; description: string }>;
}

export interface MachineAction {
  id: string;
  label: string;
  icon: string;
  active: boolean;
}

export interface Governor {
  state?: "off" | "green" | "blue" | "red";
  boosted?: boolean;
  boostedMultiplier?: number;
}

export interface Settings {
  models?: Array<{ id: string; name?: string; provider: string; common?: boolean }>;
  model?: { id: string; provider: string };
  thinkingLevels?: string[];
  thinkingLevel?: string;
  speedModes?: string[];
  speedMode?: string;
}
