import { credential, oneKenanEnabled } from "./config.js";
import { validateResult } from "./validation.js";
import { MEMORY_DEFAULT_PORT, MEMORY_TOKEN_HEADER, type MemoryResult, type MemorySession } from "./contract.js";
export async function prepareMemoryEnvironment(env: NodeJS.ProcessEnv, threadId: string): Promise<MemoryResult<MemorySession>> {
  if (!oneKenanEnabled(env)) return { ok: false, error: "disabled", message: "One Kenan is disabled on this host" };
  try {
    const token = credential(env);
    const url = env.PI_KENAN_MEMORY_URL ?? `http://127.0.0.1:${MEMORY_DEFAULT_PORT}`;
    const response = await fetch(`${url}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { [MEMORY_TOKEN_HEADER]: token } : {}) },
      body: JSON.stringify({ threadId }), signal: AbortSignal.timeout(5000) });
    const result = validateResult<MemorySession>(await response.json());
    if (!result) return { ok: false, error: "unauthenticated", message: "The memory service returned an invalid session response" };
    if (!result.ok) return result;
    if (!response.ok || !result.value || typeof result.value !== "object" || result.value.threadId !== threadId ||
        typeof result.value.person !== "string" || !result.value.person || typeof result.value.token !== "string" || !result.value.token || result.value.role !== "person")
      return { ok: false, error: "unauthenticated", message: "The memory service did not issue a verified person session" };
    env.PI_KENAN_MEMORY_ROLE = result.value.role;
    env.PI_KENAN_MEMORY_PERSON = result.value.person;
    env.PI_KENAN_MEMORY_TOKEN = result.value.token;
    env.PI_KENAN_MEMORY_URL = url;
    return result;
  } catch {
    return { ok: false, error: "unavailable", message: "Kenan's memory is unavailable; ordinary work can continue, but memory and cross-person requests cannot" };
  }
}
