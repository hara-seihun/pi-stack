import type { ThreadState } from "pi-orchestrator/api";
import type { Activity, Session } from "../protocol";

export interface MeetParticipant { id: string; name: string; host: boolean }
export interface MeetThreadState extends Pick<Session, "lifecycle">, Partial<Pick<Session, "activitySince" | "lastActivityAt" | "activityDetail" | "executionError" | "waitingOnAgents">> {
  id: string;
  name: string;
  state: ThreadState;
  /** Halted with cancellation confirmed, holding its pending messages. */
  held: boolean;
  /** A meeting worker that finished its task and was archived. It reads as Done, never as Stopped. */
  finished?: boolean;
  /** The same live activity the inbox shows, so the panel reads alike. */
  activity: Activity;
  tools: string[];
  output: string;
  events: Array<{ id: number; kind: string; name: string; text: string }>;
}
export interface MeetVoiceControl { muted: boolean; revision: number }
export function meetVoiceControl(value: unknown): MeetVoiceControl | null {
  if (!value || typeof value !== "object") return null;
  const state = value as MeetVoiceControl;
  return typeof state.muted === "boolean" && Number.isSafeInteger(state.revision) && state.revision >= 0 ? state : null;
}
/** The latest platform transcript line that said Kenan's name. The host opens Voice for it and, if Voice was not listening, hands the line to Pi. */
export interface MeetVoiceWake { revision: number; turnId: string; speaker: string; text: string; at: number }
export interface MeetSnapshot {
  voiceMuted: boolean;
  voiceRevision: number;
  voiceWake: MeetVoiceWake | null;
  transcriptFlushRevision: number;
  /** Speaker-labelled turns arrive from the meeting platform; the host does not upload mixed audio for recognition. */
  platformTranscript: boolean;
  threads: MeetThreadState[];
  id: string;
  sessionId: string;
  apiUrl: string;
  participants: MeetParticipant[];
  browser: { endpoint: string; url: string; error: string | null; watchPath: string | null; watchError: string | null } | null;
}
export interface MeetJoined { room: MeetSnapshot; participant: MeetParticipant }
export interface MeetTranscriptTurn {
  id: string; speakerId: string; speaker: string; startedAt: number; text: string; final: boolean;
  status: "queued" | "processing" | "partial" | "done" | "failed"; error: string | null;
}
export type MeetResult<T> = { ok: true; value: T } | { ok: false; error: string };
export const meetPath = (roomId = "", suffix = "") => `/v1/meet${roomId ? `/${encodeURIComponent(roomId)}` : ""}${suffix}`;
