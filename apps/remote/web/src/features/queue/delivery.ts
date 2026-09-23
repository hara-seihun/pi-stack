// How a message reaches a running thread. The composer's delivery menu and the
// queue sheet name the choices the same way, and the composer is on the first
// paint of a conversation while the sheet is not, so the words live apart from
// the sheet's markup.

export type QueueAction = "edit" | "steer" | "hardSteer" | "cancel";

export const DELIVERY_LABELS: Record<string, { label: string; detail: string }> = {
  queue: { label: "Queued", detail: "Sent after the current work finishes" },
  steer: { label: "Steer", detail: "Sent after the current tool call, before the agent continues" },
  hardSteer: { label: "Hard steer", detail: "Stops the current work, then sent first" },
};
