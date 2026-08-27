import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONDENSED_SESSION_COMMAND,
  teamContinuation,
  teamSystemPrompt,
  teamWorkspaceExtension,
} from "../src/host/team.js";

function extension(root: string, role: "worker" | "supervisor" = "worker") {
  const handlers = new Map<string, Array<(event: any) => unknown>>();
  teamWorkspaceExtension(root, role)({
    on(event: string, handler: (event: any) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  });
  const call = async (event: string, payload: any) => {
    let result: unknown;
    for (const handler of handlers.get(event) ?? []) result = await handler(payload);
    return result as any;
  };
  return { call };
}

function changedFile(root: string, name: string): string {
  const path = join(root, name);
  writeFileSync(path, "new mathematics\n");
  const future = new Date(Date.now() + 2_000);
  utimesSync(path, future, future);
  return path;
}

describe("team workspace awareness", () => {
  it("refuses a worker write until current teammate changes have been read", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-team-"));
    const live = extension(root);
    const changed = changedFile(root, "theorem.md");

    const blocked = await live.call("tool_call", { toolName: "edit", input: { path: "notes.md" } });
    expect(blocked.block).toBe(true);
    expect(blocked.reason).toContain("theorem.md");

    await live.call("tool_execution_end", {
      toolName: "read",
      args: { path: changed },
      isError: false,
    });
    expect(await live.call("tool_call", { toolName: "write", input: { path: "notes.md" } }))
      .toBeUndefined();
    writeFileSync(join(root, "notes.md"), "notes\n");
    await live.call("tool_execution_end", {
      toolName: "write",
      args: { path: "notes.md" },
      isError: false,
    });
  });

  it("serializes writes to one shared path across workers", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-team-"));
    const path = join(root, "shared.md");
    writeFileSync(path, "current\n");
    const first = extension(root);
    const second = extension(root);

    expect(await first.call("tool_call", { toolName: "edit", input: { path } })).toBeUndefined();
    const blocked = await second.call("tool_call", { toolName: "edit", input: { path } });
    expect(blocked.block).toBe(true);
    expect(blocked.reason).toContain("writing this shared file right now");

    writeFileSync(path, "first worker\n");
    await first.call("tool_execution_end", {
      toolName: "edit",
      args: { path },
      isError: false,
    });
  });

  it("keeps a teammate write that lands during this worker's edit in the next change window", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-team-"));
    const own = join(root, "notes.md");
    writeFileSync(own, "old notes\n");
    const live = extension(root);

    expect(await live.call("tool_call", { toolName: "edit", input: { path: own } }))
      .toBeUndefined();
    changedFile(root, "friend-during-edit.md");
    writeFileSync(own, "new notes\n");
    await live.call("tool_execution_end", {
      toolName: "edit",
      args: { path: own },
      isError: false,
    });

    const update = await live.call("context", { messages: [] });
    expect(update.messages[0].content[0].text).toContain("friend-during-edit.md");
    expect(update.messages[0].content[0].text).not.toContain("notes.md");
  });

  it("places live workspace changes immediately after retained skills", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-team-"));
    const live = extension(root);
    changedFile(root, "friend.md");
    const retained = { role: "user", customType: "state-compactor-skills", content: [] };
    const summary = { role: "summary", summary: "compacted work" };
    const result = await live.call("context", { messages: [retained, summary] });
    expect(result.messages[0]).toBe(retained);
    expect(result.messages[1].customType).toBe("team-workspace-updates");
    expect(result.messages[2]).toBe(summary);
  });

  it("frames the supervisor as a peer observer, never a task allocator", () => {
    const prompt = teamSystemPrompt(
      { role: "supervisor", slot: 0, workers: 4, watchFor: ["a ladder of bounded cases"] },
      "/work/cayley-ci",
    );
    expect(prompt).toContain("room of geniuses, not a task queue");
    expect(prompt).toContain("Never allocate tasks");
    expect(prompt).toContain("Observe far more often than you intervene");
    expect(prompt).toContain("a ladder of bounded cases");
    expect(teamContinuation("supervisor")).toContain("don't turn the programme into assignments");
  });

  it("uses the deployed command entry point rather than its containing directory", () => {
    expect(CONDENSED_SESSION_COMMAND).toBe("/srv/pi/tools/read-condensed-session/main");
  });
});
