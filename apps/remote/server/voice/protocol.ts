export const LIVE_MODEL = "gpt-live-1";
export const LIVE_VOICE = "meridian";

export type VoiceResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };
export type VoiceConnection = { session: { id: string }; transport: { type: "webrtc"; sdp: string } };
export type VoiceUsage = { seconds: number };
export const voiceServiceUrl = () => process.env.PI_STACK_VOICE_URL ?? "http://127.0.0.1:8796";
