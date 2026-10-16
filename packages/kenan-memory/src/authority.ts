export type AuthorityHead = { format: "markdown-authority-v1"; subject: string; source: string; revision: number; policy: Record<string, unknown> };
export type AuthorityState = { state: "active"; head: AuthorityHead } | { state: "unset" | "revoked" | "not-current" | "invalid"; message: string };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export function authorityHead(text: string): AuthorityHead | null {
  const matches = [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
  if (matches.length !== 1) return null;
  try {
    const value: unknown = JSON.parse(matches[0]![1]!);
    return object(value) && value.format === "markdown-authority-v1" && typeof value.subject === "string" && !!value.subject && typeof value.source === "string" && !!value.source && Number.isSafeInteger(value.revision) && Number(value.revision) > 0 && object(value.policy) ? value as AuthorityHead : null;
  } catch { return null; }
}
export function authorityState(text: string | null, now: number): AuthorityState {
  if (text === null) return { state: "unset", message: "Expanded standing authority is unset" };
  const head = authorityHead(text);
  if (!head) return { state: "invalid", message: "Current authority head is invalid; historical records do not grant authority" };
  if (head.policy.status === "revoked") return { state: "revoked", message: "Standing authority is revoked" };
  if (head.policy.status !== "active" || !object(head.policy.provenance)) return { state: "invalid", message: "Current authority must state active status and explicit validity" };
  const provenance = head.policy.provenance;
  for (const key of ["validFrom", "validUntil"]) if (!(provenance[key] === null || typeof provenance[key] === "string" && Number.isFinite(Date.parse(provenance[key] as string)))) return { state: "invalid", message: "Authority validity is unset or invalid" };
  if (typeof provenance.validFrom === "string" && Date.parse(provenance.validFrom) > now || typeof provenance.validUntil === "string" && Date.parse(provenance.validUntil) <= now) return { state: "not-current", message: "Standing authority is future-dated or expired" };
  return { state: "active", head };
}
export function renderAuthority(head: AuthorityHead): string {
  return `# Authority\n\nThis is the actual adopted current head for ${JSON.stringify(head.subject)}, not a historical version or a new grant. Apply its validity, revocations, exclusions and third-party consent. The operational permission contract remains independently enforced.\n\n\`\`\`json\n${JSON.stringify(head, null, 2)}\n\`\`\`\n`;
}
