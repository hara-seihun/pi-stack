import { readFileSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { threadStateInstructions } from "./thread-context-state";
import { API } from "./api";
import { registerMeetTools } from "./meet/tools";
import { registerThreadTools } from "./thread-tools";

type Alert = { file: string; path?: string; text: string; error?: string };

function readAlerts(directory: string | undefined): Alert[] {
  if (!directory) return [];
  const alerts: Alert[] = [];
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile()).sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    return [{ file: directory, text: "", error: error instanceof Error ? error.message : String(error) }];
  }
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    try {
      alerts.push({ file: entry.name, path, text: readFileSync(path, "utf8") });
    } catch (error) {
      alerts.push({ file: entry.name, text: "", error: error instanceof Error ? error.message : String(error) });
    }
  }
  return alerts;
}

function alertText(alerts: Alert[]): string {
  return alerts.map((alert) => alert.error
    ? `## ${alert.file}\nAlert could not be consumed: ${alert.error}`
    : `## ${alert.file}\n${alert.text.trimEnd() || "[empty alert]"}`).join("\n\n");
}

export default function threadContext(pi: ExtensionAPI) {
  if (process.env.PI_REMOTE_SESSION_ID && process.env.PI_REMOTE_SERVER_URL) registerThreadTools(pi);
  if (process.env.PI_REMOTE_MEETING_ID) registerMeetTools(pi);
  const pendingAlerts = new Map<string, string>();

  pi.on("before_agent_start", async (event, ctx) => {
    let meetingInstructions = "";
    if (process.env.PI_REMOTE_SERVER_URL && process.env.PI_REMOTE_SESSION_ID) {
      const url = new URL(API.sessionInstructions.path({ sessionId: process.env.PI_REMOTE_SESSION_ID }), process.env.PI_REMOTE_SERVER_URL);
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error(`Thread instructions failed: HTTP ${response.status}`);
      meetingInstructions = ((await response.json()) as { instructions: string }).instructions;
    }
    const instructions = threadStateInstructions({
      name: pi.getSessionName(),
      prompt: event.prompt,
      fileTag: process.env.PI_REMOTE_FILE_TAG ?? "pi-remote-file",
      home: process.env.HOME || homedir(),
      inlineImages: !!(process.env.PI_REMOTE_SESSION_ID && process.env.PI_REMOTE_SERVER_URL),
    }) + (meetingInstructions ? `\n\n${meetingInstructions}` : "");
    const userMessages = ctx.sessionManager.getBranch().filter((entry: any) => entry?.type === "message" && entry.message?.role === "user").length;
    if (userMessages !== 1 || !/^\d+$/.test(pi.getSessionName() ?? "")) {
      return { systemPrompt: `${event.systemPrompt}\n\n${instructions}` };
    }

    const alerts = readAlerts(process.env.PI_REMOTE_ALERTS_INBOX);
    for (const alert of alerts) {
      if (alert.path && !alert.error) pendingAlerts.set(alert.path, alert.text);
    }
    return {
      systemPrompt: `${event.systemPrompt}\n\n${instructions}`,
      ...(alerts.length ? {
        message: {
          customType: "pi-remote-machine-alerts",
          content: alertText(alerts),
          display: true,
        },
      } : {}),
    };
  });

  pi.on("agent_start", async () => {
    for (const [path, text] of pendingAlerts) {
      try {
        if (readFileSync(path, "utf8") === text) unlinkSync(path);
      } catch (error: any) {
        if (error?.code !== "ENOENT") console.error(`Pi Remote could not consume machine alert ${path}: ${error?.message ?? error}`);
      }
    }
    pendingAlerts.clear();
  });
}
