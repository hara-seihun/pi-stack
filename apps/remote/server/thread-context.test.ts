import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import threadContext from "./thread-context";
import { threadStateInstructions } from "./thread-context-state";
import { registerThreadTools } from "./thread-tools";

describe("thread lifecycle context", () => {
  test("subagents keep thinking control but cannot register delegation", () => {
    const previous = process.env.PI_SUBAGENT_MODEL;
    try {
      for (const model of ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
        process.env.PI_SUBAGENT_MODEL = model;
        const tools: string[] = [];
        registerThreadTools({ registerTool: (tool: { name: string }) => tools.push(tool.name) } as any);
        expect(tools).toEqual(["thread_thinking"]);
      }
    } finally {
      if (previous === undefined) delete process.env.PI_SUBAGENT_MODEL;
      else process.env.PI_SUBAGENT_MODEL = previous;
    }
  });
  test("describes new and continuing threads without a naming tool", () => {
    const fresh = threadStateInstructions({ name: "83", prompt: "Fix it", fileTag: "pi-file", home: "/home/a" });
    expect(fresh).toContain("starting a new thread");
    expect(fresh).not.toContain("initialize_thread");

    const existing = threadStateInstructions({ name: "Fix Runtime", prompt: "Fix it", fileTag: "pi-file", home: "/home/a" });
    expect(existing).toContain("continuing \"Fix Runtime\"");
    expect(existing).not.toContain("initialize_thread");
    expect(existing).toContain('<pi-file src="/home/a/path/to/file" />');
    expect(existing).toContain("download link");
    expect(existing).toContain("`read-thread --list`");
    expect(existing).toContain("without model calls");
    expect(existing).toContain("instead of `read-condensed-session`");
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

  test.each([false, true])("injects machine alerts into the first request with remote tools enabled=%s", async (remote) => {
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
    const network = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ instructions: "Thread instructions" }));
    const pi = {
      getSessionName: () => "83",
      registerTool: (tool: { name: string }) => tools.push(tool.name),
      on: (name: string, handler: (...args: any[]) => Promise<any>) => handlers.set(name, handler),
    };
    try {
      for (const [key, value] of Object.entries(environment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      threadContext(pi as any);
      expect(tools).toEqual(remote ? ["thread_thinking", "thread_delegate"] : []);
      const result = await handlers.get("before_agent_start")!(
        { prompt: "Help", systemPrompt: "System" },
        { sessionManager: { getBranch: () => [{ type: "message", message: { role: "user" } }] } },
      );
      expect(result.message).toMatchObject({ customType: "pi-remote-machine-alerts", display: true });
      expect(result.message.content).toContain("Disk needs attention");
      expect(network).toHaveBeenCalledTimes(remote ? 1 : 0);
      if (remote) {
        expect(result.systemPrompt).toContain("Thread instructions");
        expect(result.systemPrompt).toContain("<pi-remote-image");
      } else {
        expect(result.systemPrompt).not.toContain("<pi-remote-image");
      }
      expect(existsSync(alert)).toBe(true);
      await handlers.get("agent_start")!();
      expect(existsSync(alert)).toBe(false);
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
