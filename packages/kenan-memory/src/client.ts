import { MEMORY_DEFAULT_PORT, MEMORY_TOKEN_HEADER, type MemoryClient, type MemoryRequest, type MemoryResult, type MemoryValue } from "./contract.js";
export function memoryClient(options: { url?: string; token?: string; fetch?: typeof fetch } = {}): MemoryClient {
  const url = options.url ?? process.env.PI_KENAN_MEMORY_URL ?? `http://127.0.0.1:${MEMORY_DEFAULT_PORT}`;
  return {
    async request<T = MemoryValue>(request: MemoryRequest): Promise<MemoryResult<T>> {
      try {
        const response = await (options.fetch ?? fetch)(`${url}/v1/memory`, {
          method: "POST", headers: { "content-type": "application/json", ...(options.token ? { [MEMORY_TOKEN_HEADER]: options.token } : {}) },
          body: JSON.stringify(request), signal: AbortSignal.timeout(5000),
        });
        return await response.json() as MemoryResult<T>;
      } catch { return { ok: false, error: "unavailable", message: "Kenan's memory service is unavailable" }; }
    },
  };
}
