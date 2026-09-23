import type { ThreadState } from "pi-orchestrator/api";
import type { Activity } from "../protocol";

export type MeetTrackKind = "camera" | "screen" | "pi-camera" | "pi-screen";
export interface MeetParticipant { id: string; name: string; host: boolean }
export interface MeetSignal {
  description?: { type: "offer" | "answer"; sdp: string };
  candidate?: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null; usernameFragment?: string | null };
  streams?: Record<string, MeetTrackKind>;
}
export interface MeetEnvelope { seq: number; from: string; signal: MeetSignal }
export interface MeetIceServer { urls: string[]; username: string; credential: string }
export interface MeetThreadState {
  id: string;
  name: string;
  state: ThreadState;
  /** Halted with cancellation confirmed, holding its pending messages. */
  held: boolean;
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
export interface MeetSnapshot {
  voiceMuted: boolean;
  voiceRevision: number;
  transcriptFlushRevision: number;
  threads: MeetThreadState[];
  id: string;
  sessionId: string;
  apiUrl: string;
  iceServers: MeetIceServer[];
  participants: MeetParticipant[];
  browser: { endpoint: string; url: string; error: string | null; watchPath: string | null; watchError: string | null } | null;
}
export interface MeetJoined { room: MeetSnapshot; participant: MeetParticipant }
export interface MeetPoll extends MeetSnapshot { messages: MeetEnvelope[] }
export interface MeetTranscriptTurn {
  id: string; speakerId: string; speaker: string; startedAt: number; text: string; final: boolean;
  status: "queued" | "processing" | "partial" | "done" | "failed"; error: string | null;
}
export type MeetResult<T> = { ok: true; value: T } | { ok: false; error: string };
export const meetPath = (roomId = "", suffix = "") => `/v1/meet${roomId ? `/${encodeURIComponent(roomId)}` : ""}${suffix}`;
