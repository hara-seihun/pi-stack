import type { Session } from "../../types";

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const exact = new Intl.NumberFormat("en", { maximumFractionDigits: 0 });
const percentage = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });

export function formatContextUsage(usage: Session["contextUsage"]): { label: string; detail: string } {
  if (!usage) return { label: "Context —", detail: "Context token usage unavailable" };
  const window = usage.contextWindow > 0 ? `${exact.format(usage.contextWindow)} token context window` : "context window unavailable";
  if (usage.tokens === null) return {
    label: "Context …",
    detail: `Context token usage recalculating after compaction; available after the next model response; ${window}`,
  };
  const percent = usage.percent === null ? "" : `; ${percentage.format(usage.percent)}% used`;
  return {
    label: `~${compact.format(usage.tokens)} tok`,
    detail: `Estimated current context: ${exact.format(usage.tokens)} tokens; ${window}${percent}`,
  };
}

export function ContextTokens({ usage }: { usage: Session["contextUsage"] }) {
  const { label, detail } = formatContextUsage(usage);
  return <span className="context-tokens" title={detail}>
    <span aria-hidden="true">{label}</span>
    <span className="context-tokens-detail">{detail}</span>
  </span>;
}

export function ConversationModelMeta({ session }: { session: Pick<Session, "model" | "contextUsage"> }) {
  const modelShort = session.model.split("/").at(-1) || session.model;
  return <span className="conversation-agent-meta">
    <span className="conversation-meta conversation-agent-model" title={session.model}>{modelShort}</span>
    <ContextTokens usage={session.contextUsage} />
  </span>;
}
