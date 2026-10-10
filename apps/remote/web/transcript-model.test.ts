import { describe, expect, test } from "bun:test";
import { appendLiveThinking, buildStableTranscript, buildTranscript } from "./src/features/conversation/transcript-model";
import { formatThreadMessage } from "../../../packages/orchestrator/src/threads/message-format";
import type { ContextEntry } from "./src/types";

const entry = (key: string, kind: ContextEntry["kind"], fields: Partial<ContextEntry> = {}): ContextEntry => ({
  key,
  kind,
  signature: `${key}:${kind}`,
  text: key,
  ...fields,
});

const call = (key: string, name: string, args: Record<string, unknown>, result?: any, time = 100): ContextEntry => entry(key, "toolCall", {
  time,
  toolCall: { id: key, name, arguments: args },
  toolResult: result,
});

describe("buildTranscript", () => {
  test("keeps a system-and-schema-only context as one lossless work group", () => {
    const entries = [entry("system", "system"), entry("read-schema", "tool"), entry("bash-schema", "tool")];
    const transcript = buildTranscript(entries);

    expect(transcript).toHaveLength(1);
    expect(transcript[0]?.kind).toBe("work");
    if (transcript[0]?.kind !== "work") throw new Error("expected work");
    expect(transcript[0].entries).toEqual(entries);
    expect(transcript[0].latest).toBe(entries[2]);
    expect(transcript[0].summary).toMatchObject({ toolCalls: 0, thinkingBlocks: 0, files: [], commands: 0, hasErrors: false });
  });

  test("marks a tool without a result as running and previews it", () => {
    const running = call("running", "bash", { command: "npm test" }, undefined, 1_000);
    const transcript = buildTranscript([entry("user", "user"), running]);
    const work = transcript[1];

    expect(work?.kind).toBe("work");
    if (work?.kind !== "work") throw new Error("expected work");
    expect(work.running).toBe(true);
    expect(work.latest).toBe(running);
    expect(work.summary).toMatchObject({ toolCalls: 1, commands: 1, startedAt: 1_000 });
    expect(work.summary.endedAt).toBeUndefined();
  });

  test("groups mixed work between visible messages without changing its order", () => {
    const workEntries = [
      entry("thinking", "thinking"),
      call("read", "read", { path: "/work/a.ts" }, { timestamp: 200, content: "ok" }, 100),
      entry("schema", "tool"),
    ];
    const transcript = buildTranscript([
      entry("system", "system"),
      entry("user", "user"),
      ...workEntries,
      entry("assistant", "assistant"),
    ]);

    expect(transcript.map(item => item.kind)).toEqual(["work", "user", "work", "assistant"]);
    const work = transcript[2];
    expect(work?.kind === "work" && work.entries).toEqual(workEntries);
    expect(work?.kind === "work" && work.latest.key).toBe("read");
  });

  test("one human-keyed group retains agent traffic and work after visible replies", () => {
    const human = entry("human", "user");
    const reply = entry("reply", "assistant");
    const early = entry("early", "thinking");
    const incoming = entry("incoming", "user", { agentSender: { threadId: "worker" }, text: "Worker report" });
    const outgoing = call("send", "thread_send", { threadId: "worker", text: "Assignment" }, { timestamp: 200, content: "Accepted" });
    const late = entry("late", "notice");
    const questionAnswer = entry("question-answer", "user", { text: "Use the second option" });
    const later = call("later", "read", { path: "/work/b.ts" });
    const transcript = buildTranscript([human, early, reply, incoming, outgoing, late, entry("final", "assistant"), questionAnswer, later], undefined, undefined, true);
    expect(transcript.map(item => item.kind)).toEqual(["user", "work", "assistant", "assistant", "user", "work"]);
    const work = transcript[1];
    expect(work?.kind === "work" && work.key).toBe("work-after:human");
    expect(work?.kind === "work" && work.entries).toEqual([early, incoming, outgoing, late]);
    const next = transcript[5];
    expect(next?.kind === "work" && next.key).toBe("work-after:question-answer");
    expect(next?.kind === "work" && next.entries).toEqual([later]);
  });

  test("cached native envelopes are work, while literal human quotes remain human turns", () => {
    const raw = formatThreadMessage({ id: "message", threadId: "parent", senderId: "worker", senderName: "Worker", text: "Update", images: [], delivery: "steer", source: "explicit", state: "done", createdAt: 1, insertedAt: 1, landedAt: 1 }, "Update");
    const human = entry("human", "user");
    const envelope = entry("cached", "user", { text: raw });
    const quoted = entry("quoted", "user", { text: "```\n" + raw + "\n```" });
    const quiet = entry("wake", "user", { monoVisibility: "hidden" });
    const transcript = buildTranscript([human, envelope, quiet, entry("reply", "assistant"), quoted], undefined, undefined, true);
    expect(transcript.map(item => item.kind)).toEqual(["user", "work", "assistant", "user"]);
    expect(transcript[1]?.kind === "work" && transcript[1].entries).toEqual([envelope, quiet]);
  });

  test("reply revisions and post-reply live thinking reuse the human group key and settled entries", () => {
    const human = entry("human", "user");
    const tool = call("read", "read", { path: "/work/a.ts" }, { timestamp: 200, content: "ok" });
    const reply = entry("reply", "assistant");
    const stable = buildStableTranscript([human, tool, reply], true);
    const live = appendLiveThinking(stable, "Continuing", true, true);
    expect(live.map(item => item.kind)).toEqual(["user", "work", "assistant"]);
    expect(live[0]).toBe(stable[0]);
    expect(live[2]).toBe(stable[2]);
    if (stable[1]?.kind !== "work" || live[1]?.kind !== "work") throw new Error("expected work");
    expect(live[1].entries).toBe(stable[1].entries);
    expect(live[1].key).toBe("work-after:human");
    expect(live[1].live?.text).toBe("Continuing");
    const changed = buildTranscript([human, tool, { ...reply, signature: "reply:revision" }, entry("tail", "notice")], undefined, undefined, true);
    expect(changed[1]?.kind === "work" && changed[1].key).toBe(live[1].key);
    const nextHuman = entry("next", "user");
    const next = buildTranscript([human, tool, reply, nextHuman], "Next thought", true, true);
    expect(next.map(item => item.kind)).toEqual(["user", "work", "assistant", "user", "work"]);
    expect(next[4]?.kind === "work" && next[4].key).toBe("work-after:next");
    expect(next[4]?.kind === "work" && next[4].entries).toEqual([]);
  });

  test("selects active work before the latest completed tool and live thinking before both", () => {
    const completed = call("completed", "read", { path: "/work/a" }, { timestamp: 200, content: "ok" }, 100);
    const running = call("running", "edit", { path: "/work/a", edits: [] }, undefined, 300);
    const entries = [completed, running, entry("tail", "notice")];

    const withoutThinking = buildTranscript(entries)[0];
    expect(withoutThinking?.kind === "work" && withoutThinking.latest).toBe(running);

    const withThinking = buildTranscript(entries, "Still working")[0];
    expect(withThinking?.kind === "work" && withThinking.latest.key).toBe("live-thinking");
    expect(withThinking?.kind === "work" && withThinking.running).toBe(true);
  });

  test("counts distinct touched files, commands, thinking, errors, and tool timestamps", () => {
    const transcript = buildTranscript([
      entry("think-a", "thinking"),
      entry("think-b", "thinking"),
      call("read-a", "read", { path: "/work/a.ts" }, { timestamp: 150, content: "a" }, 100),
      call("edit-a", "edit", { path: "/work/a.ts", edits: [] }, { timestamp: 260, content: "edited" }, 200),
      call("write-b", "write", { path: "/work/b.ts", content: "b" }, { timestamp: 360, content: "written" }, 300),
      call("bash", "bash", { command: "npm test" }, { timestamp: 460, content: "failed", isError: true }, 400),
      call("exec", "exec_command", { cmd: "npm run build" }, { timestamp: 550, content: "ok" }, 500),
    ]);
    const work = transcript[0];

    if (work?.kind !== "work") throw new Error("expected work");
    expect(work.summary).toEqual({
      toolCalls: 5,
      thinkingBlocks: 2,
      files: ["/work/a.ts", "/work/b.ts"],
      commands: 2,
      hasErrors: true,
      startedAt: 100,
      endedAt: 550,
    });
  });
});
