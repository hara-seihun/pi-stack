// A message the runtime has accepted is not yet in the agent's context: Pi
// holds a steer until the current tool call ends. The queue keeps showing it
// as "Sent to agent" until a context capture contains it as a user message.
//
// Most of a turn's context reaches the supervisor as patches rather than full
// captures, so landing is checked on both paths. `LandedWork` keeps that cheap:
// it reads the context only when something is still waiting on it.

export interface LandingCandidate { id: string; text: string }

export interface LandingCandidate { id: string; text: string }

function userTexts(context: { messages?: unknown[] }): string[] {
  const texts: string[] = [];
  for (const message of context.messages ?? []) {
    if (!message || typeof message !== "object" || (message as { role?: string }).role !== "user") continue;
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") texts.push(content);
    else if (Array.isArray(content)) texts.push(content.map(block => block && typeof block === "object" && (block as { type?: string }).type === "text" ? String((block as { text?: string }).text ?? "") : "").join("\n"));
  }
  return texts;
}

/** Work ids whose message text, or agent-message id marker, appears in a
 * user message of the captured context. */
export function landedWorkIds(context: { messages?: unknown[] }, candidates: LandingCandidate[]): Set<string> {
  const landed = new Set<string>();
  if (!candidates.length) return landed;
  const texts = userTexts(context);
  for (const candidate of candidates) {
    const marker = `"messageId":${JSON.stringify(candidate.id)}`;
    const text = candidate.text.trim();
    if (texts.some(user => user.includes(marker) || (text && user.includes(text)))) landed.add(candidate.id);
  }
  return landed;
}

/** Per-thread record of delivered work the agent's context now contains. */
export class LandedWork {
  private readonly landed = new Map<string, Set<string>>();

  /** Records any candidate the context holds. `readContext` runs only when a
   * candidate is still unaccounted for, so a patch need not be parsed. */
  mark(id: string, candidates: LandingCandidate[], readContext: () => { messages?: unknown[] }) {
    const known = this.landed.get(id);
    const waiting = known ? candidates.filter(candidate => !known.has(candidate.id)) : candidates;
    if (!waiting.length) return;
    const found = landedWorkIds(readContext(), waiting);
    if (!found.size) return;
    const record = known ?? new Set<string>();
    for (const workId of found) record.add(workId);
    this.landed.set(id, record);
  }

  has(id: string, workId: string) {
    return this.landed.get(id)?.has(workId) ?? false;
  }

  forget(id: string) {
    this.landed.delete(id);
  }
}
