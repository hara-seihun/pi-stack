import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export interface SkillMetadata {
  name: string;
  description: string;
  filePath: string;
}

export interface AgentMessage {
  role?: string;
  content?: unknown;
  toolCallId?: string;
  isError?: boolean;
  timestamp?: number;
  stateCompactor?: { pin: true; id: string; replacesToolCallIds: string[] };
}

export interface SessionEntry {
  type?: string;
  id?: string;
  customType?: string;
  data?: { firstKeptEntryId?: string | null };
  message?: AgentMessage;
}

export const INITIAL_TITLE = /^\d+$/;
const PERSISTENT_SKILL = /\bmandatory\b|\bmust always\b/i;
const INTERRUPTED_CONTINUATION = /previous agent operation was interrupted|continue its unfinished work|<interrupted_user_request>/i;

export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: string; text: string } => Boolean(part && typeof part === "object" && (part as any).type === "text" && typeof (part as any).text === "string"))
    .map((part) => part.text)
    .join("\n");
}

function resolvedPath(path: string, cwd: string): string {
  const expanded = path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

function sameText(left: string, right: string): boolean {
  return left.replace(/\r\n/g, "\n").trimEnd() === right.replace(/\r\n/g, "\n").trimEnd();
}

export function surfacedInAssistantReply(messages: AgentMessage[], expected: string): boolean {
  return messages
    .filter((message) => message.role === "assistant")
    .some((message) => contentText(message.content).includes(expected));
}

export function threadStateInstructions(options: {
  name?: string;
  prompt: string;
  imageTag: string;
  fileTag: string;
  home: string;
}): string {
  const image = `Pi Remote image presentation: To show a local image, include <${options.imageTag} src="${options.home}/path/to/image.png" /> on its own line. Use an absolute path to an existing image.`;
  const file = `Pi Remote file delivery: To give the user a file, include <${options.fileTag} src="${options.home}/path/to/file" /> on its own line. Use an absolute path to an existing file. The client turns the tag into a download link.`;
  if (options.name && INITIAL_TITLE.test(options.name)) {
    return [
      `Pi Remote thread state: This is a new, uninitialized thread with numeric title ${options.name}.`,
      "As your first action, call initialize_thread once with a concise descriptive title of two or three words based on the user's first message. Do not ask permission or narrate initialization. Continue with the user's task immediately afterward. Surface every machine alert returned by initialize_thread prominently and verbatim.",
      image,
      file,
    ].join("\n\n");
  }

  const name = options.name ? JSON.stringify(options.name) : "an existing named thread";
  const continuation = INTERRUPTED_CONTINUATION.test(options.prompt)
    ? " This prompt resumes an interrupted operation in the same task. Continue from the recorded state without repeating setup or completed actions."
    : "";
  return [
    `Pi Remote thread state: You are continuing ${name}. The Pi session and conversation context survive process restarts, account routing, and model changes. Do not call initialize_thread.${continuation}`,
    image,
    file,
  ].join("\n\n");
}

export function retainedSkillContext(options: {
  branch: SessionEntry[];
  skills: SkillMetadata[];
  cwd: string;
  readCurrent: (path: string) => string;
}): AgentMessage | null {
  const persistent = new Map<string, SkillMetadata>();
  for (const skill of options.skills) {
    if (!PERSISTENT_SKILL.test(skill.description)) continue;
    persistent.set(resolvedPath(skill.filePath, options.cwd), skill);
  }
  if (persistent.size === 0) return null;

  type SkillCall = { skill: SkillMetadata; offset: number; limit?: number };
  type SkillResult = SkillCall & { callId: string; text: string; timestamp: number };
  const calls = new Map<string, SkillCall>();
  const loaded = new Map<string, SkillResult[]>();
  for (const entry of options.branch) {
    if (entry.type !== "message" || !entry.message) continue;
    const message = entry.message;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!part || typeof part !== "object" || (part as any).type !== "toolCall" || (part as any).name !== "read") continue;
        const callId = String((part as any).id ?? "");
        const args = (part as any).arguments;
        const path = args?.path;
        if (!callId || typeof path !== "string") continue;
        const skill = persistent.get(resolvedPath(path, options.cwd));
        if (!skill) continue;
        const offset = Number.isInteger(args?.offset) && args.offset > 0 ? args.offset : 1;
        const limit = Number.isInteger(args?.limit) && args.limit > 0 ? args.limit : undefined;
        calls.set(callId, { skill, offset, limit });
      }
      continue;
    }
    if (message.role !== "toolResult" || message.isError === true || !message.toolCallId) continue;
    const call = calls.get(message.toolCallId);
    if (!call) continue;
    const text = contentText(message.content);
    if (!text) continue;
    const records = loaded.get(call.skill.name) ?? [];
    records.push({ ...call, callId: message.toolCallId, text, timestamp: message.timestamp ?? Date.now() });
    loaded.set(call.skill.name, records);
  }

  const retained: Array<{ callIds: string[]; skill: SkillMetadata; text: string }> = [];
  const refresh: Array<{ skill: SkillMetadata; offset?: number; timestamp: number }> = [];
  let retainedTimestamp = 0;
  for (const records of loaded.values()) {
    const skill = records[0]?.skill;
    if (!skill) continue;
    let current: string;
    try {
      current = options.readCurrent(skill.filePath);
    } catch {
      continue;
    }
    const lines = current.split("\n");
    const covered = new Array(lines.length).fill(false);
    const currentRecords: SkillResult[] = [];
    let changed = false;
    let complete = false;
    for (const record of [...records].reverse()) {
      const notice = /\n\n\[(?:Showing lines \d+-\d+ of \d+(?: \([^\]]+\))?|\d+ more lines in file)\. Use offset=(\d+) to continue\.\]$/.exec(record.text);
      const visible = notice ? record.text.slice(0, notice.index) : record.text;
      const start = record.offset - 1;
      const end = notice
        ? Number(notice[1]) - 1
        : Math.min(lines.length, record.limit === undefined ? lines.length : start + record.limit);
      const expected = lines.slice(start, end).join("\n");
      if (start < 0 || start >= lines.length || end <= start || !sameText(expected, visible)) {
        changed = true;
        break;
      }
      currentRecords.push(record);
      for (let index = start; index < end; index++) covered[index] = true;
      if (covered.every(Boolean)) {
        complete = true;
        break;
      }
    }
    const timestamp = Math.max(...records.map((record) => record.timestamp));
    const missing = covered.findIndex((value) => !value);
    if (!complete) {
      refresh.push({ skill, offset: changed ? undefined : missing + 1, timestamp });
      continue;
    }
    retainedTimestamp = Math.max(retainedTimestamp, timestamp);
    retained.push({ callIds: currentRecords.reverse().map((record) => record.callId), skill, text: current.trimEnd() });
  }
  if (refresh.length > 0) {
    return {
      role: "user",
      content: [{
        type: "text",
        text: [
          "# Mandatory skill refresh required",
          "This is durable Pi session context, not a new user request. Finish loading the following mandatory skills before continuing:",
          ...refresh.map(({ skill, offset }) => offset
            ? `- ${skill.name}: continue ${skill.filePath} with offset=${offset}`
            : `- ${skill.name}: reread ${skill.filePath}; it changed after the earlier read`),
        ].join("\n\n"),
      }],
      timestamp: Math.max(...refresh.map(({ timestamp }) => timestamp)),
      stateCompactor: { pin: true, id: "pi-remote.mandatory-skill-refresh", replacesToolCallIds: [] },
    };
  }
  if (retained.length === 0) return null;

  const sections = retained.map(({ skill, text }) => [
    `## ${skill.name}`,
    `Source: ${skill.filePath}`,
    "The exact file content loaded earlier follows.",
    `<skill-content name=${JSON.stringify(skill.name)}>`,
    text,
    "</skill-content>",
  ].join("\n"));
  return {
    role: "user",
    content: [{
      type: "text",
      text: [
        "# Retained skill context",
        "This is durable context from earlier in the same Pi session, not a new user request. These mandatory skills were already loaded and remain in force. Do not reread them unless their files change or the user asks for a refresh.",
        ...sections,
      ].join("\n\n"),
    }],
    timestamp: retainedTimestamp || Date.now(),
    stateCompactor: {
      pin: true,
      id: "pi-remote.mandatory-skills",
      replacesToolCallIds: retained.flatMap(({ callIds }) => callIds),
    },
  } as AgentMessage;
}
