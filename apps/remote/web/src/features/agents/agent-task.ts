import type { Session } from "../../types";
import { threadStatus } from "../status/thread-status";

/** Task context comes from the execution owner, never a generated interpretation of its transcript. */
export function agentActivity(agent: Session): { label: string; detail: string | null } {
  const status = threadStatus(agent);
  const detail = agent.waitingOnAgents?.reason ?? (status.attention ? status.title : null);
  return { label: status.label, detail: detail && detail !== status.label ? detail : null };
}
