import { existsSync } from "node:fs";
const installed = new URL("./capacity/native-session.js", import.meta.url);
const owner = await import(process.env.PI_STACK_NATIVE_SESSION_MODULE ?? (existsSync(installed) ? installed.href : "pi-orchestrator/api"));
if (typeof owner.createManagedAgentSession !== "function") throw new Error("The selected runtime has no managed native ThreadService owner");
export const { createManagedAgentSession, recoverNativeSessionOwners } = owner;
