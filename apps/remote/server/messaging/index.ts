import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { API } from "../api";
import { API_CORS_HEADERS } from "../cors";
import { MessagingService, messagingConfig, type MessagingActionStore } from "./service";
import type { MessagingResult, MessagingSnapshot } from "./protocol";
import type { MessageReaction } from "../message-protocol";

export interface MessagingEndpoint {
  snapshot(): MessagingResult<MessagingSnapshot>;
  handle(req: Request): Promise<Response | null>;
  react(messageId: string, emoji: string, remove: boolean, requestId: string): Promise<MessagingResult<MessageReaction[]>>;
  close(): Promise<void>;
}

export function messagingRoot(data: string, privateDir: string, encrypted: boolean): string {
  if (!encrypted) throw new Error("Messaging requires an encrypted PiStack account. Unlock an encrypted account to configure its messaging profiles.");
  const privatePath = realpathSync(privateDir);
  const dataPath = realpathSync(data);
  const within = (path: string) => { const suffix = relative(privatePath, path); return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith("../")); };
  if (!within(dataPath)) throw new Error("Messaging data must be inside this account's encrypted folder");
  const root = join(dataPath, "messaging");
  if (existsSync(root) && !within(realpathSync(root))) throw new Error("Messaging profiles cannot point outside this account's encrypted folder");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const child of ["profiles.json", "messages.sqlite3", "messages.sqlite3-wal", "messages.sqlite3-shm", "backends", "attachments", "action-journal"]) {
    const path = join(root, child);
    if (existsSync(path) && !within(realpathSync(path))) throw new Error(`Messaging ${child} cannot point outside this account's encrypted folder`);
  }
  return root;
}

export function createMessagingService(data: string, privateDir: string, encrypted: boolean, onToolUse?: (operation: string) => void, actionStore?: MessagingActionStore): MessagingEndpoint {
  try {
    const root = messagingRoot(data, privateDir, encrypted);
    const configPath = join(root, "profiles.json");
    if (!existsSync(configPath)) writeFileSync(configPath, JSON.stringify({ version: 1, profiles: messagingConfig(undefined) }, null, 2) + "\n", { mode: 0o600 });
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    if (config?.version !== 1 || !Array.isArray(config.profiles)) throw new Error("Messaging profiles.json must contain version 1 and a profiles array");
    const actionDir = join(realpathSync(privateDir), ".kenan-actions");
    if (existsSync(actionDir) && realpathSync(actionDir) !== actionDir) throw new Error("Action authority cannot escape the encrypted account through a symlink");
    if (!actionStore) throw new Error("Action authority unavailable; the trusted supervisor must inject this owner's canonical authority");
    const service = new MessagingService(root, messagingConfig(JSON.stringify(config.profiles)), undefined, undefined, undefined, undefined, actionStore);
    void service.start();
    return {
      snapshot: () => ({ ok: true, value: service.snapshot() }),
      handle: async req => {
        const response = await service.handle(req);
        if (response?.ok && onToolUse) {
          const path = new URL(req.url).pathname;
          const operation = Object.entries(API).find(([key, route]) => key.startsWith("messaging") && route.match(req.method, path));
          if (operation) onToolUse(operation[0]);
        }
        return response;
      },
      react: (messageId, emoji, remove, requestId) => service.react(messageId, emoji, remove, requestId),
      close: () => service.close(),
    };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return {
      snapshot() { return { ok: false, error: { code: "signal_unavailable", message: detail } }; },
      async handle(req) {
        const path = new URL(req.url).pathname;
        if (path !== "/v1/agent-signal" && !path.startsWith("/v1/agent-signal/")) return null;
        return Response.json({ error: detail, code: "signal_unavailable" }, { status: 503, headers: { ...API_CORS_HEADERS, "cache-control": "no-store" } });
      },
      async react() { return { ok: false, error: { code: "signal_unavailable", message: detail } }; },
      async close() {},
    };
  }
}
