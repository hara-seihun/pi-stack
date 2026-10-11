import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiCommandReceipts } from "../src/threads/pi-command-receipts.js";
import { seedPiSession } from "../src/threads/pi-session-file.js";
import { coreSessionEnvironment } from "../src/core/native-session.js";

it("reacquires released source custody and preserves completed replacement receipts in both native files", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-command-"));
  try { coreSessionEnvironment.run({ ...process.env, PI_SESSION_WRITER_DIRECTORY: cwd, PI_SESSION_WRITER_SCOPE: "command-test" }, () => {
    const sourcePath = join(cwd, "source.jsonl"), targetPath = join(cwd, "target.jsonl");
    seedPiSession(sourcePath, cwd); seedPiSession(targetPath, cwd);
    const source = SessionManager.open(sourcePath), target = SessionManager.open(targetPath);
    try {
      const commands = new PiCommandReceipts(), command = { id: "fork-once", type: "fork", entryId: "input" };
      expect(commands.begin(command, source)).toEqual({ kind: "execute" });
      source.dispose();
      const interrupted = SessionManager.open(sourcePath);
      try { expect(new PiCommandReceipts().begin(command, interrupted)).toMatchObject({ kind: "error", message: expect.stringContaining("unconfirmed outcome") }); }
      finally { interrupted.dispose(); }
      expect(commands.attach(target)).toMatchObject({ ok: true });
      expect(new PiCommandReceipts().begin(command, target)).toMatchObject({ kind: "error" });
      const response = { type: "response", id: command.id, command: command.type, success: true, data: { text: "input", cancelled: false } };
      expect(commands.finish(response, target)).toEqual({ ok: true, value: response });
      target.dispose();
      for (const file of [sourcePath, targetPath]) {
        const reader = SessionManager.open(file);
        try {
          expect(new PiCommandReceipts().begin(command, reader)).toEqual({ kind: "replay", response, sessionFile: targetPath });
          expect(new PiCommandReceipts().begin({ ...command, entryId: "different" }, reader)).toMatchObject({ kind: "error", message: expect.stringContaining("different input") });
        } finally { reader.dispose(); }
      }
    } finally { source.dispose(); target.dispose(); }
  }); } finally { rmSync(cwd, { recursive: true, force: true }); }
});

it.each(["busy", "missing", "changed"])("reports %s source custody without disturbing the replacement or permitting replay", kind => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-command-conflict-"));
  try { coreSessionEnvironment.run({ ...process.env, PI_SESSION_WRITER_DIRECTORY: cwd, PI_SESSION_WRITER_SCOPE: "command-test" }, () => {
    const sourcePath = join(cwd, "source.jsonl"), targetPath = join(cwd, "target.jsonl");
    seedPiSession(sourcePath, cwd); seedPiSession(targetPath, cwd);
    const source = SessionManager.open(sourcePath), target = SessionManager.open(targetPath);
    try {
      const commands = new PiCommandReceipts(), command = { id: "replace-once", type: "new_session" };
      expect(commands.begin(command, source)).toEqual({ kind: "execute" });
      if (kind !== "busy") { source.dispose(); unlinkSync(sourcePath); if (kind === "changed") seedPiSession(sourcePath, cwd); }
      expect(commands.attach(target)).toMatchObject({ ok: false, error: { code: "command-receipt-unconfirmed", sourceSessionFile: sourcePath, sessionFile: targetPath } });
      const response = { type: "response", id: command.id, command: command.type, success: true };
      expect(commands.finish(response, target)).toMatchObject({ ok: false, error: { code: "command-receipt-unconfirmed" } });
      expect(new PiCommandReceipts().begin(command, source)).toMatchObject({ kind: "error" });
      expect(new PiCommandReceipts().begin(command, target)).toEqual({ kind: "replay", response, sessionFile: targetPath });
      expect(existsSync(sourcePath)).toBe(kind !== "missing");
    } finally { source.dispose(); target.dispose(); }
  }); } finally { rmSync(cwd, { recursive: true, force: true }); }
});
