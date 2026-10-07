import { readFileSync, mkdirSync } from "node:fs";
import { userInfo } from "node:os";
import { join, isAbsolute } from "node:path";
import { oneKenanEnabled } from "kenan-memory/config";
import { applyLocalConfig } from "./config";
import { ROOM_CUSTODIAN } from "./rooms";

if (!oneKenanEnabled()) throw new Error("Room runtime requires the oneKenan host flag");
if (process.getuid?.() === 0 || userInfo().username === "kenan") throw new Error("Room runtime must run under its unprivileged service account, never root or the administrator");
const configPath = process.env.PI_REMOTE_CONFIG ?? "/etc/pi-stack/rooms.json";
const config = JSON.parse(readFileSync(configPath, "utf8"));
if (config.user !== ROOM_CUSTODIAN) throw new Error("Room configuration must bind the fixed pi-rooms custodian");
process.env.PI_REMOTE_CONFIG = configPath;
applyLocalConfig(configPath);
const data = process.env.PI_REMOTE_DATA ?? "/var/lib/pi-rooms";
if (!isAbsolute(data)) throw new Error("Room state must be an absolute directory");
const workspace = join(data, "workspace");
mkdirSync(workspace, { recursive: true, mode: 0o700 });
Object.assign(process.env, {
  PI_REMOTE_ROOMS_RUNTIME: "1", PI_REMOTE_SENDER_ID: ROOM_CUSTODIAN, PI_REMOTE_SENDER_NAME: "Kenan rooms",
  PI_REMOTE_DATA: data, PI_REMOTE_HOST: "127.0.0.1", PI_REMOTE_PORT: process.env.PI_REMOTE_PORT ?? "18822",
  PI_REMOTE_REQUIRES_UNLOCK: "false", PI_REMOTE_DESTINATIONS: "home", PI_REMOTE_AUTO_ARCHIVE_AFTER_MS: "0",
  PI_REMOTE_PRIVATE_DIR: join(data, "private-unused"),
  PI_REMOTE_WORKSPACES: JSON.stringify([{ id: "rooms", name: "Rooms", path: workspace }]),
  PI_REMOTE_THREAD_DESTINATIONS: JSON.stringify([{ id: "home", label: "ROOM", icon: "cloud", accent: "#f5f5f5", workspaceId: "rooms",
    models: (process.env.PI_REMOTE_ROOMS_MODELS ?? "astra,sol,luna,fable,opus").split(","), defaultModel: process.env.PI_REMOTE_ROOMS_MODEL ?? "sol", thinkingLevel: "high" }]),
});
await import("./main");
