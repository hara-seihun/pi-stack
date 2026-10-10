import { createThreadClient, validateManagerWorkSummary } from "pi-orchestrator/api";

export function managerRelayClient(baseUrl: string, environmentId?: string, transport: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch) {
  const bridge = (url: string | URL | Request, init?: RequestInit) => transport(url, { ...init,
    body: JSON.stringify({ input: JSON.parse(String(init?.body)),
      ...(environmentId && new URL(String(url)).pathname.split("/").at(-1) !== "managerWorkSummary" ? { environmentId } : {}) }) });
  const client = createThreadClient(baseUrl, bridge);
  const summaryClient = createThreadClient(baseUrl, bridge, { timeoutMs: 5_000 });
  client.managerWorkSummary = async () => {
    const result = await summaryClient.managerWorkSummary();
    if (!result.ok) return result;
    return validateManagerWorkSummary(result.value) ? { ok: true, value: result.value }
      : { ok: false, error: { code: "unavailable", message: "Manager relay returned an invalid work summary" } };
  };
  const readPolicy = client.managerNotificationPolicy;
  client.managerNotificationPolicy = async () => {
    const result = await readPolicy();
    if (!result.ok) return result;
    const value: unknown = result.value;
    if (value && typeof value === "object" && !Array.isArray(value) && "view" in value) {
      if (value.view === "classic" && Object.keys(value).length === 1) return { ok: true, value: { view: "classic" } };
      if (value.view === "mono" && "managerThreadId" in value && typeof value.managerThreadId === "string" && value.managerThreadId.trim()
        && Object.keys(value).every(key => key === "view" || key === "managerThreadId")) return { ok: true, value: { view: "mono", managerThreadId: value.managerThreadId } };
    }
    return { ok: false, error: { code: "unavailable", message: "Canonical manager returned an invalid notification policy" } };
  };
  return client;
}
