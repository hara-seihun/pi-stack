import { sha256 } from "./sync";

interface StoredContext { capturedAt: number; document: string; hash: string }
interface QuestionAnswerOwner {
  get(id: string): { updatedAt: number; metadata?: Record<string, unknown> } | null;
  projectQuestionAnswers(id: string, messages: Record<string, any>[]): Record<string, any>[];
}

export function questionAnswerContext(owner: QuestionAnswerOwner, sessionId: string, stored: StoredContext | null): StoredContext | null {
  const thread = owner.get(sessionId);
  if (thread?.metadata?.rootConsent !== true) return stored;
  const context = stored ? JSON.parse(stored.document) : { systemPrompt: "", tools: [], messages: [] };
  const messages = owner.projectQuestionAnswers(sessionId, context.messages ?? []);
  if (!stored && !messages.length) return null;
  const document = JSON.stringify({ ...context, messages });
  return { capturedAt: Math.max(stored?.capturedAt ?? 0, thread.updatedAt), document, hash: sha256(document) };
}
