import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ReaderContract = { historyMarker: string; version: number; command: "read-thread"; [key: string]: unknown };

export function sessionHistoryMetadata(contract: ReaderContract, sessionFile: string | undefined): string {
  const { historyMarker, version, ...reader } = contract;
  return JSON.stringify({
    type: historyMarker,
    version,
    sessionFile: sessionFile ?? null,
    reader,
  });
}

export function registerSessionHistory(pi: ExtensionAPI): void {
  let contract: ReaderContract | undefined;
  pi.on("before_agent_start", async (event, ctx) => {
    if (!contract) {
      const result = await pi.exec("read-thread", ["--contract"], { timeout: 5_000, signal: ctx.signal });
      if (result.code !== 0 || result.killed) throw new Error(`read-thread contract failed: ${result.stderr || result.stdout || result.code}`);
      const parsed = JSON.parse(result.stdout);
      if (!parsed || parsed.command !== "read-thread" || typeof parsed.historyMarker !== "string" || parsed.version !== 1) {
        throw new Error("read-thread returned an invalid history contract");
      }
      contract = parsed as ReaderContract;
    }
    return {
      systemPrompt: `${event.systemPrompt}\n\n${sessionHistoryMetadata(contract, ctx.sessionManager.getSessionFile())}`,
    };
  });
}
