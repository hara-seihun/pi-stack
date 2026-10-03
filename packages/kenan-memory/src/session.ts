import { credential, oneKenanEnabled } from "./config.js";
import { MEMORY_DEFAULT_PORT, MEMORY_TOKEN_HEADER, type MemoryResult, type MemorySession } from "./contract.js";
export async function prepareMemoryEnvironment(env: NodeJS.ProcessEnv, threadId: string): Promise<void> {
  if (!oneKenanEnabled(env)) return;
  const token = credential(env);
  const url = env.PI_KENAN_MEMORY_URL ?? `http://127.0.0.1:${MEMORY_DEFAULT_PORT}`;
  const response = await fetch(`${url}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { [MEMORY_TOKEN_HEADER]: token } : {}) },
    body: JSON.stringify({ threadId }), signal: AbortSignal.timeout(5000) });
  const result = await response.json() as MemoryResult<MemorySession>;
  if (!result.ok) throw new Error(`Cannot open Kenan memory session: ${result.message}`);
  if (result.value.threadId !== threadId || !result.value.person || !result.value.token) throw new Error("Invalid Kenan memory session response");
  env.PI_KENAN_MEMORY_PERSON = result.value.person;
  env.PI_KENAN_MEMORY_TOKEN = result.value.token;
  env.PI_KENAN_MEMORY_URL = url;
}
