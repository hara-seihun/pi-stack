import type { MeetJoined, MeetPoll, MeetSignal, MeetTrackKind } from "../../../server/meet/protocol";

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const revision = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const nullableText = (value: unknown) => value === null || typeof value === "string";
const kinds: MeetTrackKind[] = ["camera", "screen", "pi-camera", "pi-screen"];

function validSignal(value: unknown): value is MeetSignal {
  if (!record(value) || !(value.description || value.candidate || value.streams)) return false;
  if (value.description !== undefined && (!record(value.description) || !["offer", "answer"].includes(String(value.description.type))
    || typeof value.description.sdp !== "string" || !value.description.sdp.startsWith("v=0"))) return false;
  if (value.candidate !== undefined) {
    const candidate = value.candidate;
    if (!record(candidate) || typeof candidate.candidate !== "string") return false;
    if (candidate.sdpMid !== undefined && !nullableText(candidate.sdpMid)) return false;
    if (candidate.usernameFragment !== undefined && !nullableText(candidate.usernameFragment)) return false;
    if (candidate.sdpMLineIndex !== undefined && candidate.sdpMLineIndex !== null && !revision(candidate.sdpMLineIndex)) return false;
  }
  return value.streams === undefined || (record(value.streams)
    && Object.entries(value.streams).every(([id, kind]) => text(id) && id.length <= 128 && kinds.includes(kind as MeetTrackKind)));
}

export function parsePoll(value: unknown, joined: MeetJoined): MeetPoll {
  if (!record(value) || value.id !== joined.room.id || value.sessionId !== joined.room.sessionId || typeof value.apiUrl !== "string"
    || typeof value.voiceMuted !== "boolean" || !revision(value.voiceRevision) || !revision(value.transcriptFlushRevision)
    || typeof value.platformTranscript !== "boolean" || !Array.isArray(value.threads) || !value.threads.every(record)
    || !Array.isArray(value.iceServers) || !value.iceServers.every((ice) => record(ice) && Array.isArray(ice.urls)
      && ice.urls.every(text) && typeof ice.username === "string" && typeof ice.credential === "string")
    || !Array.isArray(value.participants) || !value.participants.every((person) => record(person) && text(person.id) && text(person.name) && typeof person.host === "boolean")
    || !Array.isArray(value.messages) || !value.messages.every((message) => record(message) && revision(message.seq) && message.seq !== 0 && text(message.from) && validSignal(message.signal))) {
    throw new Error("Meet returned an invalid poll response");
  }
  const poll = value as unknown as MeetPoll;
  const ids = poll.participants.map((person) => person.id);
  if (new Set(ids).size !== ids.length || !ids.includes(joined.participant.id)
    || poll.messages.some((message, index) => index > 0 && message.seq <= poll.messages[index - 1]!.seq)) {
    throw new Error("Meet returned invalid participant identities or signaling order");
  }
  if (poll.browser !== null && (!record(poll.browser) || !text(poll.browser.endpoint) || !text(poll.browser.url)
    || !nullableText(poll.browser.error) || !nullableText(poll.browser.watchPath) || !nullableText(poll.browser.watchError))) {
    throw new Error("Meet returned an invalid browser state");
  }
  if (poll.voiceWake !== null && (!record(poll.voiceWake) || !revision(poll.voiceWake.revision) || !text(poll.voiceWake.turnId)
    || !text(poll.voiceWake.speaker) || !text(poll.voiceWake.text) || !Number.isFinite(poll.voiceWake.at))) {
    throw new Error("Meet returned an invalid voice state");
  }
  return poll;
}
