import { credential } from "./config.js";
import { MEMORY_DEFAULT_PORT, MEMORY_TOKEN_HEADER } from "./contract.js";
import type { LifeClient, LifeRequest, LifeResult, LifeValue } from "./life-contract.js";
import { validateLifeResponse } from "./life-validation.js";

export function lifeClient(options: { url?: string; token?: string | null; fetch?: typeof fetch } = {}): LifeClient {
  const url = options.url ?? process.env.PI_KENAN_MEMORY_URL ?? `http://127.0.0.1:${MEMORY_DEFAULT_PORT}`;
  return {
    async request<T = LifeValue>(request: LifeRequest): Promise<LifeResult<T>> {
      try {
        const token = options.token === null ? undefined : options.token ?? credential();
        const response = await (options.fetch ?? fetch)(`${url}/v1/life`, {
          method: "POST", headers: { "content-type": "application/json", ...(token ? { [MEMORY_TOKEN_HEADER]: token } : {}) },
          body: JSON.stringify(request), signal: AbortSignal.timeout(5000),
        });
        const result = validateLifeResponse<T>(await response.json(), request);
        if (!result || !response.ok && result.ok) return { ok: false, error: "unavailable", message: "Life service returned an invalid response" };
        return result;
      } catch { return { ok: false, error: "unavailable", message: "Life service is unavailable" }; }
    },
  };
}
