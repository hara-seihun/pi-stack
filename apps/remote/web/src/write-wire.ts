import { requireState } from "../../shared/explicit-state";
import { stateObject, stateString } from "../../shared/state-validation";

export type RewriteResult = { status: "applied" | "unchanged" | "guarded" | "unavailable"; reason: string | null };
export type WriteFrame =
  | { type: "partial"; committed: string; tail: string }
  | { type: "final"; text: string; rewrite: RewriteResult | null }
  | { type: "error"; message: string };

export function parseWriteFrame(input: string): WriteFrame {
  const value = stateObject(JSON.parse(input), "Write frame");
  const type = requireState(value.type, { partial: true, final: true, error: true } satisfies Record<WriteFrame["type"], true>, "Write frame type");
  switch (type) {
    case "partial": return { type, committed: stateString(value.committed, "Committed dictation"), tail: stateString(value.tail, "Dictation tail") };
    case "error": return { type, message: stateString(value.message, "Write error") };
    case "final": {
      let rewrite: RewriteResult | null = null;
      if (value.rewrite !== null && value.rewrite !== undefined) {
        const result = stateObject(value.rewrite, "Write rewrite");
        const status = requireState(result.status, { applied: true, unchanged: true, guarded: true, unavailable: true } satisfies Record<RewriteResult["status"], true>, "Write rewrite status");
        if (result.reason !== null && typeof result.reason !== "string") throw new Error("Write rewrite reason: expected string or null");
        rewrite = { status, reason: result.reason as string | null };
      }
      return { type, text: stateString(value.text, "Final dictation"), rewrite };
    }
  }
}
