export type BashWorkerReceipt = { exitCode: number | null; cancelled: boolean; timedOut: boolean; cleanupError: string | null };
export function parseBashWorkerReceipt(source: string): { ok: true; value: BashWorkerReceipt } | { ok: false; error: string } {
  let value: unknown;
  try { value = JSON.parse(source); } catch (error) { return { ok: false, error: `Invalid Bash worker JSON: ${String(error)}` }; }
  if (!value || typeof value !== "object") return { ok: false, error: "Bash worker receipt requires an object" };
  const receipt = value as BashWorkerReceipt;
  if (receipt.exitCode !== null && !Number.isInteger(receipt.exitCode) || typeof receipt.cancelled !== "boolean"
    || typeof receipt.timedOut !== "boolean" || receipt.cleanupError !== null && typeof receipt.cleanupError !== "string"
    || receipt.cancelled && receipt.timedOut || receipt.exitCode === null && !receipt.cancelled && !receipt.timedOut && !receipt.cleanupError) {
    return { ok: false, error: "Invalid Bash worker outcome" };
  }
  return { ok: true, value: receipt };
}
