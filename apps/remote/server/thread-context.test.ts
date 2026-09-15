import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import threadContext from "./thread-context";
import { threadStateInstructions } from "./thread-context-state";

describe("thread lifecycle context", () => {
  test("describes new and continuing threads without a naming tool", () => {
    const fresh = threadStateInstructions({ name: "83", prompt: "Fix it", fileTag: "pi-file", home: "/home/a" });
    expect(fresh).toContain("starting a new thread");
    expect(fresh).not.toContain("initialize_thread");

    const existing = threadStateInstructions({ name: "Fix Runtime", prompt: "Fix it", fileTag: "pi-file", home: "/home/a" });
    expect(existing).toContain("continuing \"Fix Runtime\"");
    expect(existing).not.toContain("initialize_thread");
    expect(existing).toContain('<pi-file src="/home/a/path/to/file" />');
    expect(existing).toContain("download link");
  });

  test("marks an interrupted prompt as the same unfinished task", () => {
    const instructions = threadStateInstructions({
      name: "Fix Runtime",
      prompt: "The previous agent operation was interrupted. Continue its unfinished work.",
      fileTag: "pi-file",
      home: "/home/a",
    });
    expect(instructions).toContain("resumes an interrupted operation in the same task");
    expect(instructions).toContain("without repeating setup or completed actions");
  });

  test.each([false, true])("indexes alerts on the first request and never consumes them, remote=%s", async (remote) => {
    const inbox = mkdtempSync(join(tmpdir(), "pi-remote-alerts-"));
    const alert = join(inbox, "disk.txt");
    const environment = {
      PI_REMOTE_ALERTS_INBOX: inbox,
      PI_REMOTE_SESSION_ID: remote ? "test-session" : undefined,
      PI_REMOTE_SERVER_URL: remote ? "http://remote.test" : undefined,
      PI_REMOTE_MEETING_ID: undefined,
      PI_SUBAGENT_MODEL: undefined,
    };
    const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
    writeFileSync(alert, "Disk needs attention\n");
    const handlers = new Map<string, (...args: any[]) => Promise<any>>();
    const tools: string[] = [];
    const network = spyOn(globalThis, "fetch").mockImplementation(Object.assign(
      async () => Response.json({ instructions: "Thread instructions" }),
      { preconnect: globalThis.fetch.preconnect },
    ));
    const pi = {
      getSessionName: () => "Already named before its first prompt",
      registerTool: (tool: { name: string }) => tools.push(tool.name),
      on: (name: string, handler: (...args: any[]) => Promise<any>) => handlers.set(name, handler),
    };
    try {
      for (const [key, value] of Object.entries(environment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      threadContext(pi as any);
      expect(tools).toEqual([]);
      const result = await handlers.get("before_agent_start")!(
        { prompt: "Help", systemPrompt: "System" },
        { sessionManager: { getBranch: () => [{ type: "session_info", name: "83" }] } },
      );
      expect(result.message).toMatchObject({ customType: "pi-remote-machine-alerts", display: true });
      expect(result.message.content).toContain("disk.txt");
      expect(result.message.content).toContain(inbox);
      expect(result.message.content).not.toContain("Disk needs attention");
      expect(network).toHaveBeenCalledTimes(remote ? 1 : 0);
      if (remote) {
        expect(result.systemPrompt).toContain("Thread instructions");
        expect(result.systemPrompt).toContain("<pi-remote-image");
      } else {
        expect(result.systemPrompt).not.toContain("<pi-remote-image");
      }
      expect(existsSync(alert)).toBe(true);
      expect(handlers.has("agent_start")).toBe(false);
      for (const prior of [
        { type: "message", message: { role: "user" } },
        { type: "custom_message", customType: "pi-remote-machine-alerts" },
        { type: "branch_summary" },
        { type: "compaction" },
      ]) {
        const followup = await handlers.get("before_agent_start")!(
          { prompt: "Hard-steer follow-up", systemPrompt: "System" },
          { sessionManager: { getBranch: () => [prior] } },
        );
        expect(followup.message).toBeUndefined();
      }
      expect(existsSync(alert)).toBe(true);

      for (let i = 0; i < 200; i++) writeFileSync(join(inbox, `failure-${i}.txt`), "large alert".repeat(1000));
      const backlog = await handlers.get("before_agent_start")!(
        { prompt: "Fresh prompt", systemPrompt: "System" },
        { sessionManager: { getBranch: () => [] } },
      );
      expect(backlog.message.content).toContain("201 machine alerts");
      expect(backlog.message.content).toContain("191 more files");
      expect(Buffer.byteLength(backlog.message.content)).toBeLessThan(8192);
      expect(backlog.message.content).not.toContain("large alert");
    } finally {
      network.mockRestore();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(inbox, { recursive: true, force: true });
    }
  });
});
