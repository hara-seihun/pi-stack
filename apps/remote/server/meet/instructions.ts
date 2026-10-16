import { readFileSync } from "node:fs";
import { liveDevInstructions } from "../skills";

export type MeetingThreadRole = "root" | "worker";

export function meetingRootPolicy(): string {
  return readFileSync(new URL("./root-thread-policy.md", import.meta.url), "utf8").trim();
}

export const MEETING_WORKER_NOTE = `## Meeting worker

You are a worker thread for a live meeting. The meeting thread handed you this work so it can keep listening to the room, and it relays your result when you finish. Do the work here, including its longer tool runs. People are watching while you work: when you own canvas slots, put each finding on the canvas as soon as you have it rather than saving everything for the end, and stay within the slots you were given so parallel workers do not overwrite each other. Your final reply is spoken to the room by the meeting thread, so lead with the finding in a sentence or two, then list what changed and where. If you are stuck or need a decision from the people in the room, say exactly what you need and end your turn; the meeting thread will bring it to them.`;

/** Instructions for a Pi thread attached to a meeting. The root thread must stay free for Voice handoffs; workers do the work. */
export function meetingThreadInstructions(role: MeetingThreadRole): string {
  return [liveDevInstructions(), role === "root" ? meetingRootPolicy() : MEETING_WORKER_NOTE].join("\n\n");
}
