import { readFileSync } from "node:fs";
import { liveDevInstructions } from "../skills";

export type MeetingThreadRole = "root" | "worker";

export function meetingRootPolicy(): string {
  return readFileSync(new URL("./root-thread-policy.md", import.meta.url), "utf8").trim();
}

export const MEETING_WORKER_NOTE = `## Meeting worker

You are a worker for a live meeting. Do the assigned work and return the finding in one or two speakable sentences, with changed artifacts or a needed decision when relevant. The meeting dispatcher relays your result. Kenan's external camera always shows only the Liminal logo. Share a screen only on an explicit meeting request, using the isolated shared browser; work and progress are not permission to share. Respect the scope of an already-requested shared browser and coordinate concurrent edits with its owner.`;

/** Instructions for a Pi thread attached to a meeting. The root thread must stay free for Voice handoffs; workers do the work. */
export function meetingThreadInstructions(role: MeetingThreadRole): string {
  return [liveDevInstructions(), role === "root" ? meetingRootPolicy() : MEETING_WORKER_NOTE].join("\n\n");
}
