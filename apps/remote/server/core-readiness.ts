export const CORE_PERSON_ACTIVATION = "/srv/pi/pi-orchestrator/host/core-person-activate";
export type CorePrepared = { protocol: "pi-core-person-activation-v1"; user: string; scopeId: string; state: "prepared" };
export type CoreReadinessResult = { ok: true; value: CorePrepared } | { ok: false; error: string; status: 503 };
export type ActivationExecution = { code: number; stdout: string };
export type ActivationRunner = (argv: readonly string[]) => Promise<ActivationExecution>;

async function runActivation(argv: readonly string[]): Promise<ActivationExecution> {
  const process = Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 45_000 });
  const [code, stdout] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
  return { code, stdout };
}

export async function activatePersonalCore(user: string, run: ActivationRunner = runActivation): Promise<CoreReadinessResult> {
  const failed = (): CoreReadinessResult => ({ ok: false, status: 503, error: "Core activation was not confirmed. Your opened folder is retained; retry unlocking with the same account." });
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) return failed();
  try {
    const execution = await run([CORE_PERSON_ACTIVATION, user]);
    if (execution.code !== 0) return failed();
    const result = JSON.parse(execution.stdout);
    if (result?.ok !== true || result.value?.protocol !== "pi-core-person-activation-v1" || result.value.user !== user || result.value.state !== "prepared" || typeof result.value.scopeId !== "string" || !/^[a-zA-Z0-9_.:-]+$/.test(result.value.scopeId) || [".", ".."].includes(result.value.scopeId)) return failed();
    return { ok: true, value: { protocol: result.value.protocol, user, scopeId: result.value.scopeId, state: "prepared" } };
  } catch { return failed(); }
}

export function preparedSupervisorHealth(value: unknown, scopeId: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const health = value as { ok?: unknown; core?: { scopeId?: unknown; error?: unknown } };
  return health.ok === true && health.core?.scopeId === scopeId && health.core.error === null;
}
