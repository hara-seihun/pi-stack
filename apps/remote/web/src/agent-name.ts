import { agentFirstName } from "pi-orchestrator/message-format";
import type { Session } from "./types";

/** The name a person sees for an agent thread, or null for threads the service never named. */
export function agentName(session: Pick<Session, "agentName">): string | null {
  return session.agentName ? agentFirstName(session.agentName) : null;
}
