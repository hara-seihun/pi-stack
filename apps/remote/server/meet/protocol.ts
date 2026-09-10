export type MeetTrackKind = "camera" | "screen" | "pi-camera" | "pi-screen";
export interface MeetParticipant { id: string; name: string; host: boolean }
export interface MeetSignal {
  description?: { type: "offer" | "answer"; sdp: string };
  candidate?: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null; usernameFragment?: string | null };
  streams?: Record<string, MeetTrackKind>;
}
export interface MeetEnvelope { seq: number; from: string; signal: MeetSignal }
export interface MeetIceServer { urls: string[]; username: string; credential: string }
export interface MeetSnapshot {
  id: string;
  sessionId: string;
  apiUrl: string;
  iceServers: MeetIceServer[];
  participants: MeetParticipant[];
  browser: { endpoint: string; url: string } | null;
}
export interface MeetJoined { room: MeetSnapshot; participant: MeetParticipant }
export interface MeetPoll extends MeetSnapshot { messages: MeetEnvelope[] }
export type MeetResult<T> = { ok: true; value: T } | { ok: false; error: string };
export const meetPath = (roomId = "", suffix = "") => `/v1/meet${roomId ? `/${encodeURIComponent(roomId)}` : ""}${suffix}`;
