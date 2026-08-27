import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger/ledger.js";
import { loadTaskManifest, reconcileTaskManifest } from "../src/task-manifest.js";

function fixture(): { dir: string; ledger: Ledger; manifest: string } {
  const dir = mkdtempSync(join(tmpdir(), "po-task-manifest-"));
  return {
    dir,
    ledger: Ledger.open(join(dir, "ledger.sqlite3")),
    manifest: join(dir, "tasks.json"),
  };
}

describe("task manifests", () => {
  it("resolves authored files and atomically replaces task definitions", () => {
    const { dir, ledger, manifest } = fixture();
    writeFileSync(join(dir, "demand.sh"), "printf '2\\n'\n");
    writeFileSync(join(dir, "prompt.md"), "Work the queue.\n");
    writeFileSync(join(dir, "opening.md"), "Take a look first.\n");
    writeFileSync(manifest, JSON.stringify({
      version: 1,
      tasks: [{
        id: "queue",
        demandCommandFile: "demand.sh",
        tiers: ["standard", { tier: "light", weight: 3 }],
        share: 4,
        promptFile: "prompt.md",
        openingFiles: ["opening.md"],
        exitWhenDrained: true,
        selfPaced: false,
      }],
    }));
    ledger.upsertTask({ id: "queue", demandConstant: 1, tiers: [{ tier: "standard", weight: 1 }] });
    ledger.setTaskPaused("queue", true);
    ledger.upsertTask({ id: "obsolete", demandConstant: 1, tiers: [{ tier: "standard", weight: 1 }] });

    expect(reconcileTaskManifest(ledger, manifest)).toEqual({ upserted: 1, deleted: ["obsolete"] });
    expect(ledger.tasks()).toEqual([{
      id: "queue",
      demandCommand: "printf '2\\n'\n",
      demandConstant: undefined,
      gate: undefined,
      tiers: [{ tier: "standard", weight: 1 }, { tier: "light", weight: 3 }],
      share: 4,
      prompt: "Work the queue.\n",
      cwd: undefined,
      exitWhenDrained: true,
      doctrineUrl: undefined,
      opening: ["Take a look first.\n"],
      openingProbe: undefined,
      selfPaced: false,
      team: undefined,
    }]);
    expect(ledger.taskPaused("queue")).toBe(true);
    ledger.close();
  });

  it("loads one whole-programme team with a shared worker prompt", () => {
    const { dir, manifest } = fixture();
    writeFileSync(join(dir, "workers.md"), "Work on the whole theorem.\n");
    writeFileSync(join(dir, "supervisor.md"), "Keep the whole theorem in view.\n");
    writeFileSync(manifest, JSON.stringify({
      version: 1,
      tasks: [{
        id: "cayley-ci-team",
        demandConstant: 1,
        tiers: ["standard"],
        cwd: "/work/cayley-ci",
        promptFile: "workers.md",
        team: {
          workers: 4,
          supervisorPromptFile: "supervisor.md",
          watchFor: ["constant ladders", "large censuses replacing theory"],
        },
      }],
    }));
    expect(loadTaskManifest(manifest)[0]?.team).toEqual({
      workers: 4,
      supervisorPrompt: "Keep the whole theorem in view.\n",
      watchFor: ["constant ladders", "large censuses replacing theory"],
    });
  });

  it("rejects misspelled fields and leaves the ledger unchanged on invalid tasks", () => {
    const { ledger, manifest } = fixture();
    ledger.upsertTask({ id: "kept", demandConstant: 1, tiers: [{ tier: "standard", weight: 1 }] });
    writeFileSync(manifest, JSON.stringify({
      version: 1,
      tasks: [{ id: "broken", demandConstant: 1, tiers: ["standard"], promptFiel: "typo.md" }],
    }));
    expect(() => loadTaskManifest(manifest)).toThrow(/unknown field promptFiel/);

    writeFileSync(manifest, JSON.stringify({
      version: 1,
      tasks: [
        { id: "replacement", demandConstant: 1, tiers: ["standard"] },
        { id: "invalid", demandConstant: 1, tiers: [] },
      ],
    }));
    expect(() => reconcileTaskManifest(ledger, manifest)).toThrow(/non-empty/);
    expect(ledger.tasks().map((task) => task.id)).toEqual(["kept"]);
    ledger.close();
  });
});
