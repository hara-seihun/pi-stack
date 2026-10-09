import type { MeetJoined, MeetSnapshot } from "../../../server/meet/protocol";

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const revision = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const nullableText = (value: unknown) => value === null || typeof value === "string";

export function parsePoll(value: unknown, joined: MeetJoined): MeetSnapshot {
  if (!record(value) || value.id !== joined.room.id || value.sessionId !== joined.room.sessionId || typeof value.apiUrl !== "string"
    || typeof value.voiceMuted !== "boolean" || !revision(value.voiceRevision) || !revision(value.transcriptFlushRevision)
    || typeof value.platformTranscript !== "boolean" || !Array.isArray(value.threads) || !value.threads.every(record)
    || !Array.isArray(value.participants) || !value.participants.every((person) => record(person) && text(person.id) && text(person.name) && typeof person.host === "boolean")) {
    throw new Error("Meet returned an invalid poll response");
  }
  const poll = value as unknown as MeetSnapshot;
  const ids = poll.participants.map((person) => person.id);
  if (new Set(ids).size !== ids.length || !ids.includes(joined.participant.id)
    || poll.participants.filter(person => person.host).length !== 1
    || !poll.participants.some(person => person.id === joined.participant.id && person.host === joined.participant.host)) {
    throw new Error("Meet returned invalid external participant identities");
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
