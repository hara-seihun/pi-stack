import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { providerOAuth } from "./auth/shared-oauth.js";
import { readCodexCapabilities, refreshCodexCapabilities } from "./auth/codex-capabilities.js";
import { accountCapacity } from "./policy.js";
import type { ProviderController } from "./provider-controller.js";

/** Core must authenticate and authorize the provider resource before invoking this adapter. */
export async function providerHttp(controller: ProviderController, request: Request, prefix = "/v1/providers"): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${prefix}/`)) return undefined;
  const path = url.pathname.slice(prefix.length), method = request.method;
  const store = controller.store;
  const fail = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status });
  const objectInput = async (): Promise<Record<string, unknown>> => {
    const input = await request.json();
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new SyntaxError("Expected an input object");
    return input as Record<string, unknown>;
  };
  try {
    if (method === "GET" && path === "/health") return Response.json({ ok: true });
    if (method === "GET" && path === "/plans") return Response.json({ accounts: store.accounts(), meters: store.meters(), leases: store.activeLeases() });
    if (method === "GET" && path === "/status") return Response.json({
      accounts: store.accounts(), leases: store.activeLeases(), codexCapabilities: readCodexCapabilities(store),
      capacity: store.accounts().map(account => ({ accountId: account.id, ...accountCapacity(store, account.id, "force", controller.config) })),
      meterErrors: store.accounts().flatMap(account => { const value = store.control(`meter-error:${account.id}`); return value ? JSON.parse(value) : []; }),
      launches: store.control("launches"), ordinaryLaunches: store.control("ordinary-launches"),
    });
    if (method === "POST" && path === "/control") {
      const input = await objectInput();
      if (!["launches", "ordinary-launches"].includes(String(input.key)) || !["paused", "enabled"].includes(String(input.value)) || Object.keys(input).some(key => key !== "key" && key !== "value")) return fail(400, "invalid-request", "Expected an exact launch control and paused/enabled state");
      store.setControl(input.key as string, input.value as string);
      return Response.json({ ok: true });
    }
    if (method === "POST" && path === "/accounts/capabilities") {
      const input = await objectInput();
      if (Object.keys(input).some(key => key !== "accountId") || input.accountId !== undefined && (typeof input.accountId !== "string" || !input.accountId)) return fail(400, "invalid-request", "Expected an optional accountId");
      if (input.accountId && store.account(input.accountId as string)?.provider !== "openai-codex") return fail(404, "not-found", "Codex account not found");
      const capabilities = await refreshCodexCapabilities(store, providerOAuth(openaiCodexProvider(), controller.config.authPath), input.accountId as string | undefined, AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]));
      return Response.json({ codexCapabilities: capabilities });
    }
    if (method === "POST" && path === "/accounts") {
      const input = await objectInput();
      if (Object.keys(input).some(key => !["id", "provider", "label"].includes(key)) || typeof input.id !== "string" || !input.id || !["anthropic", "openai-codex"].includes(String(input.provider)) || input.label !== undefined && typeof input.label !== "string") return fail(400, "invalid-request", "Expected account id, provider and optional label");
      store.upsertAccount({ id: input.id, provider: input.provider as "anthropic" | "openai-codex", label: input.label as string | undefined, enabled: true });
      return Response.json({ ok: true }, { status: 201 });
    }
    const account = /^\/accounts\/([^/]+)(\/(?:enabled|use))?$/.exec(path);
    if (account) {
      const id = decodeURIComponent(account[1]!);
      if (!store.account(id)) return fail(404, "not-found", "Account not found");
      if (method === "DELETE" && !account[2]) { store.setAccountEnabled(id, false); return Response.json({ ok: true }); }
      if (method === "PUT" && account[2] === "/enabled") {
        const input = await objectInput();
        if (typeof input.enabled !== "boolean" || Object.keys(input).some(key => key !== "enabled")) return fail(400, "invalid-request", "Expected enabled boolean");
        store.setAccountEnabled(id, input.enabled);
        return Response.json({ account: store.account(id) });
      }
      if (method === "PUT" && account[2] === "/use") {
        const input = await objectInput();
        if (!["shared", "voice"].includes(String(input.use)) || Object.keys(input).some(key => key !== "use")) return fail(400, "invalid-request", "Expected shared or voice account use");
        if (input.use === "voice" && store.account(id)!.provider !== "openai-codex") return fail(400, "invalid-request", "Live calling requires a Codex account");
        store.setControl(`account-use:${id}`, input.use as string);
        return Response.json({ account: store.account(id) });
      }
    }
    return fail(404, "not-found", "Provider operation not found");
  } catch (cause) {
    if (cause instanceof SyntaxError || cause instanceof URIError) return fail(400, "invalid-request", "Invalid provider request encoding");
    return fail(503, "unavailable", "Provider custody operation failed; inspect its retained state before retrying");
  }
}
