import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiInputStatus } from "../src/threads/pi-input-status.js";
import { seedPiSession } from "../src/threads/pi-session-file.js";

it("retains accepted and rejected native input identities after acknowledgement loss and restart", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-input-status-"));
  try {
    const file = join(cwd, "source.jsonl"); seedPiSession(file, cwd);
    const manager = SessionManager.open(file), inputs = new PiInputStatus(manager);
    expect(inputs.query("absent", "absent-work").state).toBe("never_accepted");
    expect(inputs.begin("accepted", "accepted-work")).toBeUndefined();
    expect(inputs.query("accepted", "accepted-work").state).toBe("in_flight");
    inputs.finish({ type: "response", id: "accepted", success: true });
    inputs.begin("rejected", "rejected-work");
    inputs.finish({ type: "response", id: "rejected", success: false, error: "preflight refusal" });
    inputs.begin("uncertain", "uncertain-work");
    const recovered = new PiInputStatus(SessionManager.open(file));
    expect(recovered.query("accepted", "accepted-work").state).toBe("accepted");
    expect(recovered.query("rejected", "rejected-work")).toMatchObject({ state: "rejected", error: "preflight refusal" });
    expect(recovered.query("uncertain", "uncertain-work").state).toBe("in_flight");
    expect(recovered.begin("accepted", "accepted-work")).toMatchObject({ state: "accepted" });
    expect(() => recovered.query("accepted", "different-work")).toThrow("identity mismatch");
    expect(() => recovered.begin("accepted", "different-work")).toThrow("different work");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
