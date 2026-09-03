import { describe, expect, test } from "bun:test";
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

  test("injects machine alerts into the first request without registering a tool", async () => {
    const inbox = mkdtempSync(join(tmpdir(), "pi-remote-alerts-"));
    const alert = join(inbox, "disk.txt");
    const previousInbox = process.env.PI_REMOTE_ALERTS_INBOX;
    writeFileSync(alert, "Disk needs attention\n");
    process.env.PI_REMOTE_ALERTS_INBOX = inbox;
    const handlers = new Map<string, (...args: any[]) => Promise<any>>();
    const pi = {
      getSessionName: () => "83",
      on: (name: string, handler: (...args: any[]) => Promise<any>) => handlers.set(name, handler),
    };
    try {
      threadContext(pi as any);
      expect((pi as any).registerTool).toBeUndefined();
      const result = await handlers.get("before_agent_start")!(
        { prompt: "Help", systemPrompt: "System" },
        { sessionManager: { getBranch: () => [{ type: "message", message: { role: "user" } }] } },
      );
      expect(result.message).toMatchObject({ customType: "pi-remote-machine-alerts", display: true });
      expect(result.message.content).toContain("Disk needs attention");
      await handlers.get("agent_start")!();
      expect(existsSync(alert)).toBe(false);
    } finally {
      if (previousInbox === undefined) delete process.env.PI_REMOTE_ALERTS_INBOX;
      else process.env.PI_REMOTE_ALERTS_INBOX = previousInbox;
      rmSync(inbox, { recursive: true, force: true });
    }
  });
});
