export interface PresentedBatchInput {
  role: "user";
  inputId: string;
  inputOrigin?: "human" | "machine";
  timestamp?: unknown;
  content: Array<Record<string, unknown>>;
}
export function inputBatchPresentation(message: unknown): { ok: true; value: PresentedBatchInput[] | null } | { ok: false; error: string };
