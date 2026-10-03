import { readFileSync } from "node:fs";
import { MEMORY_DEFAULT_PORT } from "./contract.js";
import { oneKenanEnabled } from "./config.js";
import { memoryService, type MemoryAuth } from "./service.js";
import { MemoryStore } from "./store.js";
import { awaitPrivateMount } from "./private-store.js";

if (!oneKenanEnabled()) {
  console.log("One Kenan is disabled; memory service not started");
} else {
  const auth: MemoryAuth = JSON.parse(readFileSync(process.env.PI_KENAN_MEMORY_AUTH_FILE ?? "/etc/pi-stack/kenan-memory-auth.json", "utf8"));
  if (!Array.isArray(auth.supervisors) || auth.supervisors.some(entry => typeof entry.person !== "string" || !entry.person || typeof entry.token !== "string" || entry.token.length < 32))
    throw new Error("Invalid Kenan memory authorization configuration");
  const tokens = [...auth.supervisors.map(entry => entry.token), auth.publisherToken, auth.rootToken].filter(token => token !== undefined);
  if (tokens.some(token => typeof token !== "string" || token.length < 32) || new Set(tokens).size !== tokens.length)
    throw new Error("Kenan memory credentials must be distinct random strings");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGTERM", cancel); process.once("SIGINT", cancel);
  const privateDir = process.env.PI_KENAN_PRIVATE_DIR ?? (process.env.PI_KENAN_MEMORY_STORE ? undefined : "/var/lib/pi-kenan/private");
  const mounted = !privateDir || await awaitPrivateMount(privateDir, controller.signal);
  if (mounted && !controller.signal.aborted && oneKenanEnabled()) {
    const store = new MemoryStore(process.env.PI_KENAN_MEMORY_STORE ?? `${privateDir}/memory/memory.sqlite3`);
    const roomModule = process.env.PI_KENAN_ROOM_AUDIENCE_MODULE;
    const roomAudience = roomModule ? (await import(roomModule)).roomAudienceResolver(process.env.PI_REMOTE_ROOMS_DB, "pi-rooms") : undefined;
    const service = memoryService({ store, auth, enabled: () => oneKenanEnabled(), roomAudience });
    service.listen(Number(process.env.PI_KENAN_MEMORY_PORT ?? MEMORY_DEFAULT_PORT), "127.0.0.1");
    const stop = () => service.close(() => { store.close(); });
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
  }
}
