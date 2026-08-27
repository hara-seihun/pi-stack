import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export const COMPACT_THRESHOLD_TOKENS = 250_000;
export const CONTINUATION_MESSAGE = "Your context was compacted, you now have tons of room to continue what you were doing ^-^";
export const RETAINED_SKILLS_TYPE = "state-compactor-skills";

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function resolvedPath(path, cwd) {
  const expanded = path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

function sameText(left, right) {
  return left.replace(/\r\n/g, "\n").trimEnd() === right.replace(/\r\n/g, "\n").trimEnd();
}

/**
 * Reconstruct every skill whose read crossed the latest compaction boundary.
 * The session branch retains the original tool traffic after Pi removes it
 * from the provider context, so this can validate paged reads against the
 * current file and put the exact skill back without teaching the compaction
 * summary to paraphrase instructions.
 */
export function retainedSkillContext({ branch, skills, cwd, readCurrent = (path) => readFileSync(path, "utf8") }) {
  let compactedThrough = -1;
  for (let index = 0; index < branch.length; index++) {
    if (branch[index]?.type === "compaction") compactedThrough = index;
  }
  if (compactedThrough < 0 || skills.length === 0) return null;

  const available = new Map(skills.map((skill) => [resolvedPath(skill.filePath, cwd), skill]));
  const calls = new Map();
  const loaded = new Map();
  const crossed = new Set();

  for (let index = 0; index < branch.length; index++) {
    const entry = branch[index];
    if (entry?.type !== "message" || !entry.message) continue;
    const message = entry.message;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!part || typeof part !== "object" || part.type !== "toolCall" || part.name !== "read") continue;
        const callId = String(part.id ?? "");
        const path = part.arguments?.path;
        if (!callId || typeof path !== "string") continue;
        const skill = available.get(resolvedPath(path, cwd));
        if (!skill) continue;
        const offset = Number.isInteger(part.arguments?.offset) && part.arguments.offset > 0 ? part.arguments.offset : 1;
        const limit = Number.isInteger(part.arguments?.limit) && part.arguments.limit > 0 ? part.arguments.limit : undefined;
        calls.set(callId, { skill, offset, limit, beforeCompaction: index < compactedThrough });
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
    if (call.beforeCompaction && index < compactedThrough) crossed.add(call.skill.name);
  }

  const retained = [];
  const refresh = [];
  let retainedTimestamp = 0;
  for (const [name, records] of loaded) {
    if (!crossed.has(name)) continue;
    const skill = records[0]?.skill;
    if (!skill) continue;
    let current;
    try {
      current = readCurrent(skill.filePath);
    } catch {
      refresh.push({ skill, timestamp: Math.max(...records.map((record) => record.timestamp)) });
      continue;
    }
    const lines = current.split("\n");
    const covered = new Array(lines.length).fill(false);
    const currentRecords = [];
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
    if (!complete) {
      const missing = covered.findIndex((value) => !value);
      refresh.push({ skill, offset: changed || missing < 0 ? undefined : missing + 1, timestamp });
      continue;
    }
    retainedTimestamp = Math.max(retainedTimestamp, timestamp);
    retained.push({ skill, text: current.trimEnd() });
  }

  if (refresh.length > 0) {
    return {
      role: "user",
      customType: RETAINED_SKILLS_TYPE,
      content: [{
        type: "text",
        text: [
          "# Skill refresh required",
          "This is durable session context, not a new user request. Finish restoring these skills before continuing:",
          ...refresh.map(({ skill, offset }) => offset
            ? `- ${skill.name}: continue ${skill.filePath} with offset=${offset}`
            : `- ${skill.name}: reread ${skill.filePath}; it changed or became unavailable after the earlier read`),
        ].join("\n\n"),
      }],
      timestamp: Math.max(...refresh.map(({ timestamp }) => timestamp)),
    };
  }
  if (retained.length === 0) return null;

  return {
    role: "user",
    customType: RETAINED_SKILLS_TYPE,
    content: [{
      type: "text",
      text: [
        "# Retained skill context",
        "This is exact durable context from earlier in this Pi session, not a new user request. Every skill below was loaded before compaction and remains in force. Do not reread it unless its file changes or the user asks for a refresh.",
        ...retained.map(({ skill, text }) => [
          `## ${skill.name}`,
          `Source: ${skill.filePath}`,
          `<skill-content name=${JSON.stringify(skill.name)}>`,
          text,
          "</skill-content>",
        ].join("\n")),
      ].join("\n\n"),
    }],
    timestamp: retainedTimestamp || Date.now(),
  };
}

export default function stateCompactor(pi) {
  let compacting = false;
  let availableSkills = [];

  pi.on("before_agent_start", (event) => {
    availableSkills = event.systemPromptOptions?.skills ?? [];
  });

  pi.on("context", (event, ctx) => {
    const retained = retainedSkillContext({
      branch: ctx.sessionManager.getBranch(),
      skills: availableSkills,
      cwd: ctx.cwd,
    });
    if (!retained) return;
    const messages = event.messages.filter((message) => message?.customType !== RETAINED_SKILLS_TYPE);
    return { messages: [retained, ...messages] };
  });

  pi.on("before_provider_request", (_event, ctx) => {
    const tokens = ctx.getContextUsage()?.tokens;
    if (compacting || tokens === null || tokens === undefined || tokens < COMPACT_THRESHOLD_TOKENS) return;

    compacting = true;
    const finished = () => {
      compacting = false;
    };
    ctx.compact({
      onComplete: () => {
        finished();
        pi.sendMessage(
          {
            customType: "state-compactor",
            content: CONTINUATION_MESSAGE,
            display: false,
          },
          { triggerTurn: true },
        );
      },
      onError: finished,
    });
  });
}
