import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { threadStateInstructions } from "./thread-context-state";
import { API } from "./api";
import { registerMeetTools } from "./meet/tools";
import { sessionEnvironment } from "./session-environment";

function alertNotice(directory: string | undefined): string | undefined {
  if (!directory) return;
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile()).sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
    return `Machine alerts inbox could not be listed: ${JSON.stringify(directory)} (${code}).`;
  }
  if (!entries.length) return;
  const lines = [
    `${entries.length} machine alerts await attention in ${JSON.stringify(directory)}.`,
    "This is an index, not the alert contents. Files remain in the inbox until their owning repair resolves them.",
  ];
  for (const entry of entries.slice(0, 10)) lines.push(`- ${JSON.stringify(entry.name)}`);
  if (entries.length > 10) lines.push(`${entries.length - 10} more files are in the inbox.`);
  return lines.join("\n");
}

export default function threadContext(pi: ExtensionAPI) {
  const environment = sessionEnvironment();
  if (environment.PI_REMOTE_MEETING_ID) registerMeetTools(pi);

  pi.on("before_agent_start", async (event, ctx) => {
    let meetingInstructions = "";
    if (environment.PI_REMOTE_SERVER_URL && environment.PI_REMOTE_SESSION_ID) {
      const url = new URL(API.sessionInstructions.path({ sessionId: environment.PI_REMOTE_SESSION_ID }), environment.PI_REMOTE_SERVER_URL);
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error(`Thread instructions failed: HTTP ${response.status}`);
      meetingInstructions = ((await response.json()) as { instructions: string }).instructions;
    }
    const instructions = threadStateInstructions({
      name: pi.getSessionName(),
      prompt: event.prompt,
      fileTag: environment.PI_REMOTE_FILE_TAG ?? "pi-remote-file",
      home: environment.HOME || homedir(),
      inlineImages: !!(environment.PI_REMOTE_SESSION_ID && environment.PI_REMOTE_SERVER_URL),
    }) + (meetingInstructions ? `\n\n${meetingInstructions}` : "");
    // Pi persists the incoming user message after before_agent_start.
    const hasConversation = ctx.sessionManager.getBranch().some((entry) =>
      entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary" || entry.type === "compaction");
    if (hasConversation) {
      return { systemPrompt: `${event.systemPrompt}\n\n${instructions}` };
    }

    const notice = alertNotice(environment.PI_REMOTE_ALERTS_INBOX);
    return {
      systemPrompt: `${event.systemPrompt}\n\n${instructions}`,
      ...(notice ? {
        message: {
          customType: "pi-remote-machine-alerts",
          content: notice,
          display: true,
        },
      } : {}),
    };
  });

}
