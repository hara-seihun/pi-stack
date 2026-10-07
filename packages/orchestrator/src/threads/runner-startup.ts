export class RunnerStartupError extends Error {
  readonly nativeNotReady = true;
}
export function isPooledStartupWait(message: string): boolean {
  return /^(?:Error: )*(?:No eligible pooled account for \S+(?: advertising ultrafast)?\.?(?: Earliest cooldown ends at \d{4}-\d{2}-\d{2}T[\d:.]+Z\.)?|(?:Saved|Pinned) model \S+ has no (?:eligible pooled|available) account)$/.test(message);
}
