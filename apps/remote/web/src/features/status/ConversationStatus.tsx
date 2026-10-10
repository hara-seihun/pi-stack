import { StatusPill } from "./StatusPill";
import type { ThreadStatus } from "./thread-status";
import "./status.css";

export type ConversationConnection =
  | { kind: "connected" }
  | { kind: "syncing" }
  | { kind: "disconnected"; reason: string };

export function ConversationStatus({ status, connection }: { status: ThreadStatus; connection: ConversationConnection }) {
  return <span className="conversation-state" role="status">
    <span className="conversation-execution">
      {connection.kind === "disconnected" && <span className="conversation-last-known">Last known:</span>}
      <StatusPill status={status} />
    </span>
    {connection.kind === "syncing" && <span className="conversation-connection" data-connection="syncing">Syncing conversation</span>}
    {connection.kind === "disconnected" && <span className="conversation-connection" data-connection="disconnected">Disconnected — {connection.reason}</span>}
  </span>;
}
