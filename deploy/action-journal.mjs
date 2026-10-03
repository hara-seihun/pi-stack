import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

export function publicationJournalEnabled() {
  const path = process.env.PI_STACK_HOST_CONFIG ?? process.env.PI_STACK_HOST_FILE ?? "/etc/pi-stack/host.json";
  return existsSync(path) && JSON.parse(readFileSync(path, "utf8")).oneKenan === true;
}
function invoke(command, payload) {
  const cli = process.env.PI_KENAN_ACTION_JOURNAL_CLI ?? "/srv/pi/runtime/node_modules/kenan-memory/src/journal-cli.ts";
  const result = spawnSync("bun", [cli, command], { input: JSON.stringify(payload), encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0) throw new Error(`Action journal ${command}: ${result.stderr || result.stdout || result.error?.message}`);
  return JSON.parse(result.stdout);
}
export function beginPublication(request, targets) {
  if (!publicationJournalEnabled()) return null;
  return invoke("begin", { action: "pi-stack.publication", actedFor: request.actionPerson ?? "kenan", threadId: request.reporter?.sessionId,
    recipients: targets.map(target => target.id), summary: `Publish PiStack source ${request.sourceSha}`, externalId: request.requestId });
}
export function finishPublication(request) {
  if (!request.actionJournal) return;
  try {
    const result = invoke("finish", { ticket: request.actionJournal, outcome: "confirmed", detail: `Published ${request.integrationSha} on configured hosts at ${request.publishedAt}; receipt ${request.requestId}` });
    if (!result.ok) request.journalWarning = result.error;
    else delete request.journalWarning;
  } catch (cause) { request.journalWarning = `Publication succeeded, but outcome journal pending. Do not republish. ${String(cause)}`; }
}
