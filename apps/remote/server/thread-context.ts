import { readFileSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  INITIAL_TITLE,
  retainedSkillContext,
  surfacedInAssistantReply,
  threadStateInstructions,
  type AgentMessage,
  type SessionEntry,
  type SkillMetadata,
} from "./thread-context-state";

function readAlerts(directory: string | undefined): Array<{ file: string; path?: string; text: string; error?: string }> {
  if (!directory) return [];
  const alerts: Array<{ file: string; path?: string; text: string; error?: string }> = [];
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile()).sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    return [{ file: directory, text: "", error: error instanceof Error ? error.message : String(error) }];
  }
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    try {
      const text = readFileSync(path, "utf8");
      alerts.push({ file: entry.name, path, text });
    } catch (error) {
      alerts.push({ file: entry.name, text: "", error: error instanceof Error ? error.message : String(error) });
    }
  }
  return alerts;
}

export default function threadContext(pi: ExtensionAPI) {
  let availableSkills: SkillMetadata[] = [];
  let supportsContextPins = false;
  const pendingAlerts = new Map<string, { expected: string; text: string }>();

  pi.registerTool({
    name: "initialize_thread",
    label: "Initialize thread",
    description: "Give a new numeric Pi Remote thread its permanent descriptive title and consume local machine alerts",
    parameters: Type.Object({ title: Type.String({ description: "Concise two- or three-word title" }) }),
    async execute(_id, { title }) {
      const sessionId = process.env.PI_REMOTE_SESSION_ID;
      const server = process.env.PI_REMOTE_SERVER_URL;
      if (!sessionId || !server) throw new Error("Pi Remote thread control plane is unavailable");
      const response = await fetch(`${server}/v1/sessions/${sessionId}/name`, { method: "PUT", body: title });
      const text = await response.text();
      if (!response.ok) throw new Error(text || `Thread initialization failed (${response.status})`);
      const details = JSON.parse(text) as object;
      pi.setActiveTools(pi.getActiveTools().filter((tool) => tool !== "initialize_thread"));
      const alerts = process.env.PI_REMOTE_EXECUTION_TARGET === "local"
        ? readAlerts(process.env.PI_REMOTE_ALERTS_INBOX)
        : [];
      for (const alert of alerts) {
        if (alert.path && !alert.error) pendingAlerts.set(alert.path, {
          expected: alert.text.trimEnd() || "[empty alert]",
          text: alert.text,
        });
      }
      const alertText = alerts.length === 0
        ? "No machine alerts were waiting."
        : alerts.map((alert) => alert.error
          ? `## ${alert.file}\nAlert could not be consumed: ${alert.error}`
          : `## ${alert.file}\n${alert.text.trimEnd() || "[empty alert]"}`).join("\n\n");
      return {
        content: [{ type: "text", text: `Thread initialized as ${JSON.stringify(title)}.\n\n${alertText}` }],
        details: { ...details, alerts: alerts.map(({ file, text, error }) => ({ file, text, error })) },
      };
    },
  });

  pi.on("before_agent_start", async (event) => {
    availableSkills = (event.systemPromptOptions.skills ?? []) as SkillMetadata[];
    supportsContextPins = pi.getAllTools().some((tool) => tool.name === "state_recall");
    const name = pi.getSessionName();
    const active = pi.getActiveTools();
    const hasInitialize = active.includes("initialize_thread");
    const needsInitialize = Boolean(name && INITIAL_TITLE.test(name));
    if (needsInitialize && !hasInitialize) pi.setActiveTools([...active, "initialize_thread"]);
    if (!needsInitialize && hasInitialize) pi.setActiveTools(active.filter((tool) => tool !== "initialize_thread"));
    const instructions = threadStateInstructions({
      name,
      prompt: event.prompt,
      imageTag: process.env.PI_REMOTE_IMAGE_TAG ?? "pi-remote-image",
      home: process.env.HOME ?? homedir(),
    });
    return { systemPrompt: `${event.systemPrompt}\n\n${instructions}` };
  });

  pi.on("agent_end", async (event) => {
    for (const [path, alert] of pendingAlerts) {
      if (!surfacedInAssistantReply(event.messages as AgentMessage[], alert.expected)) continue;
      try {
        if (readFileSync(path, "utf8") === alert.text) unlinkSync(path);
      } catch (error: any) {
        if (error?.code !== "ENOENT") console.error(`Pi Remote could not consume machine alert ${path}: ${error?.message ?? error}`);
      }
    }
    pendingAlerts.clear();
  });

  pi.on("context", async (event, ctx) => {
    if (!supportsContextPins) return;
    const retained = retainedSkillContext({
      branch: ctx.sessionManager.getBranch() as SessionEntry[],
      skills: availableSkills,
      cwd: ctx.cwd,
      readCurrent: (path) => readFileSync(path, "utf8"),
    });
    if (!retained) return;
    const messages = [...event.messages] as AgentMessage[];
    const latestUser = messages.findLastIndex((message) => message.role === "user");
    messages.splice(latestUser < 0 ? messages.length : latestUser, 0, retained);
    return { messages: messages as any };
  });
}
