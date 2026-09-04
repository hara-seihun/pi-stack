import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { outputLimitContinuation } from "../host/continuations.js";

/** A provider output ceiling interrupts a turn; it does not settle it. Queueing
 * from agent_end lets Pi continue inside the same run before agent_settled. */
export default function outputLimitContinuationExtension(pi: ExtensionAPI): void {
  pi.on("agent_end", (event) => {
    const prompt = outputLimitContinuation(event.messages);
    if (prompt) pi.sendUserMessage(prompt, { deliverAs: "followUp" });
  });
}
