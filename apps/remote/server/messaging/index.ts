import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { API } from "../api";
import { API_CORS_HEADERS } from "../cors";
import { MessagingService, messagingConfig, type CallAudioSocket } from "./service";
import type { MessagingResult, MessagingSnapshot } from "./protocol";
import type { MessageReaction } from "../message-protocol";
import { SIGNAL_ICON } from "./signal";

export type { CallAudioSocket } from "./service";

let activeService: MessagingService | null = null;

export function openCallAudio(callId: string): CallAudioSocket | null {
  return activeService?.openCallAudio(callId) ?? null;
}

export interface MessagingEndpoint {
  snapshot(): MessagingSnapshot;
  handle(req: Request): Promise<Response | null>;
  react(messageId: string, emoji: string, remove: boolean): Promise<MessagingResult<MessageReaction[]>>;
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
  for (const child of ["profiles.json", "messages.sqlite3", "messages.sqlite3-wal", "messages.sqlite3-shm", "backends", "attachments", "preview-images"]) {
    const path = join(root, child);
    if (existsSync(path) && !within(realpathSync(path))) throw new Error(`Messaging ${child} cannot point outside this account's encrypted folder`);
  }
  return root;
}

export function createMessagingService(data: string, privateDir: string, encrypted: boolean, onChange?: () => void): MessagingEndpoint {
  try {
    const root = messagingRoot(data, privateDir, encrypted);
    const configPath = join(root, "profiles.json");
    if (!existsSync(configPath)) writeFileSync(configPath, JSON.stringify({ version: 1, profiles: messagingConfig(undefined) }, null, 2) + "\n", { mode: 0o600 });
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    if (config?.version !== 1 || !Array.isArray(config.profiles)) throw new Error("Messaging profiles.json must contain version 1 and a profiles array");
    const service = new MessagingService(root, messagingConfig(JSON.stringify(config.profiles)), undefined, onChange);
    activeService = service;
    void service.start();
    return {
      snapshot: () => service.snapshot(),
      handle: req => service.handle(req),
      react: (messageId, emoji, remove) => service.react(messageId, emoji, remove),
      close: async () => {
        if (activeService === service) activeService = null;
        await service.close();
      },
    };
  } catch (cause) {
    activeService = null;
    const detail = cause instanceof Error ? cause.message : String(cause);
    return {
      snapshot() {
        return { version: 1, backends: [{ id: "signal", plugin: "signal", icon: SIGNAL_ICON, label: "Signal", capabilities: { attachments: true, groups: true, calls: false }, status: "unconfigured", detail, linkable: false, link: null }], conversations: [], calls: [] };
      },
      async handle(req) {
        const path = new URL(req.url).pathname;
        if (!path.startsWith("/v1/messaging")) return null;
        return Response.json(API.messaging.match(req.method, path)
          ? this.snapshot()
          : { error: detail }, { status: API.messaging.match(req.method, path) ? 200 : 503, headers: { ...API_CORS_HEADERS, "cache-control": "no-store" } });
      },
      async react() { return { ok: false, error: { code: "messaging_unavailable", message: detail } }; },
      async close() {},
    };
  }
}
