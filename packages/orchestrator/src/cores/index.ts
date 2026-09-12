import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { argument, isCoreId, type CoreCommand, type CoreId, type CoreOutput, type CoreSession, type CoreSessionOptions, type OpenCoreSession, type PortableConversation } from "./contracts.js";
import { CoreJournal, readPortableConversation } from "./journal.js";
export { CORE_IDS, isCoreId } from "./contracts.js";
export type { CoreId, CoreAgent, CoreCommand, CoreOutput, CoreSession, CoreSessionOptions, OpenCoreSession, PortableConversation } from "./contracts.js";
export { CoreJournal, readPortableConversation, writeCoreState } from "./journal.js";

export function configuredCore(value: unknown = process.env.PI_STACK_DEFAULT_CORE): CoreId {
  if (value === undefined || value === "") return "pi";
  if (!isCoreId(value)) throw new Error(`Unknown agent core: ${String(value)}`);
  return value;
}

export async function openCoreSession(options: CoreSessionOptions, output: (event: CoreOutput) => void, exit: (code?: number) => void,
  factory?: OpenCoreSession): Promise<CoreSession> {
  const core = configuredCore(options.env.PI_STACK_CORE);
  const transferPath = join(options.stateDir, "transfer.json");
  const transfer = options.transfer ?? (existsSync(transferPath) ? JSON.parse(readFileSync(transferPath, "utf8")) as PortableConversation : undefined);
  const journal = new CoreJournal(options.stateDir, core, options.sessionId, options.cwd, transfer);
  let nativePath = argument(options.args, "--session");
  let adapter: CoreSession;
  let closed = false;
  const publish = (event: CoreOutput): void => {
    if (closed) return;
    journal.record(event);
    if (event.type === "response" && event.command === "get_state" && event.success) {
      const path = (event.data as {sessionFile?: string})?.sessionFile;
      if (core === "pi" && nativePath && path && path !== nativePath && existsSync(path)) {
        journal.replace(readPortableConversation(path, core).messages);
      }
      nativePath = path ?? nativePath;
      output({ ...event, data: { ...(event.data as object), core, coreStateDir: options.stateDir, portableFile: journal.portableFile } });
    } else output(event);
  };
  try {
    if (!journal.conversation().messages.length && core === "pi" && nativePath && existsSync(nativePath)) {
      journal.seed(readPortableConversation(nativePath, core).messages);
    }
    const open = factory ?? (core === "pi" ? (await import("./pi.js")).openPiSession : (await import("./codex.js")).openCodexSession);
    adapter = await open({ ...options, transfer }, publish, code => { if (!closed) { closed = true; journal.close(); } exit(code); });
  } catch (error) { journal.close(); throw error; }
  return {
    async command(command: CoreCommand) {
      if (closed) throw new Error("Agent core is closed");
      if (command.type === "get_portable_conversation") {
        output({ type: "response", command: command.type, id: command.id, success: true, data: journal.conversation() });
        return;
      }
      await adapter.command(command);
    },
    async close() {
      if (closed) return;
      try { await adapter.close(); }
      finally { if (!closed) { closed = true; journal.close(); } }
    },
  };
}
