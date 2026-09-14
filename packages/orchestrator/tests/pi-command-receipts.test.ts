import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiCommandReceipts } from "../src/threads/pi-command-receipts.js";
import { seedPiSession } from "../src/threads/pi-session-file.js";

it("never repeats an interrupted mutation and preserves completed replacement custody in both native files", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-command-"));
  try {
    const sourcePath = join(cwd, "source.jsonl"), targetPath = join(cwd, "target.jsonl");
    seedPiSession(sourcePath, cwd); seedPiSession(targetPath, cwd);
    const source = SessionManager.open(sourcePath), target = SessionManager.open(targetPath);
    const commands = new PiCommandReceipts(), command = { id: "fork-once", type: "fork", entryId: "input" };
    expect(commands.begin(command, source)).toEqual({ kind: "execute" });
    expect(new PiCommandReceipts().begin(command, SessionManager.open(sourcePath))).toMatchObject({ kind: "error", message: expect.stringContaining("unconfirmed outcome") });
    commands.attach(target);
    expect(new PiCommandReceipts().begin(command, SessionManager.open(targetPath))).toMatchObject({ kind: "error" });
    const response = { type: "response", id: command.id, command: command.type, success: true, data: { text: "input", cancelled: false } };
    commands.finish(response, target);
    for (const file of [sourcePath, targetPath]) {
      expect(new PiCommandReceipts().begin(command, SessionManager.open(file))).toEqual({ kind: "replay", response, sessionFile: targetPath });
      expect(new PiCommandReceipts().begin({ ...command, entryId: "different" }, SessionManager.open(file))).toMatchObject({ kind: "error", message: expect.stringContaining("different input") });
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
