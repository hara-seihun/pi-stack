import { THREAD_MODES, conversationModeSpeed, type Thread, type ThreadApi } from "pi-orchestrator/api";

export const MEETING_MODE = "live";
export const MEETING_SETTINGS = THREAD_MODES[MEETING_MODE].conversation.settings;

type MeetingThreadOwner = {
  existing: (id: string) => { meetingId: string | null; archived: boolean } | undefined;
  get: (id: string) => Thread | null | undefined;
  control: ThreadApi["control"];
  create: (id: string, meetingId: string, name: string, settings: typeof MEETING_SETTINGS, mode: typeof MEETING_MODE) => Promise<void>;
  warn: (message: string) => void;
};

export async function ensureExternalMeetingThread(sessionId: string, meetingId: string, name: string, owner: MeetingThreadOwner): Promise<void> {
  const existing = owner.existing(sessionId);
  if (!existing) {
    await owner.create(sessionId, meetingId, name, MEETING_SETTINGS, MEETING_MODE);
    return;
  }
  if (existing.meetingId !== meetingId) throw new Error("The external meeting's thread is unavailable");
  if (existing.archived) {
    const reopened = await owner.control({ threadId: sessionId, action: "update", archived: false });
    if (!reopened.ok) throw new Error(`The external meeting's thread could not be reopened: ${reopened.error.message}`);
  }
  const thread = owner.get(sessionId);
  if (!thread) return;
  if (thread.metadata?.mode !== MEETING_MODE || thread.metadata?.liveDispatcher !== true) {
    const moded = await owner.control({ threadId: sessionId, action: "update", metadata: { mode: MEETING_MODE, liveDispatcher: true } });
    if (!moded.ok) throw new Error(`The external meeting's thread could not become live: ${moded.error.message}`);
  }
  const speed = conversationModeSpeed(MEETING_MODE, thread.settings);
  if (speed) {
    const fast = await owner.control({ threadId: sessionId, action: "settings", settings: { speed } });
    if (!fast.ok) owner.warn(`[meet] external meeting thread ${sessionId} kept ${thread.settings.speed} speed: ${fast.error.message}`);
  }
}
