import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrchestratorClient } from "pi-orchestrator/api";
import { Ledger } from "../../../packages/orchestrator/src/ledger/ledger";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Orchestrator's Bun read model", () => {
  it("reports an account with no meter reading as unavailable", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-orchestrator-client-"));
    temporaryDirectories.push(directory);
    const ledgerPath = join(directory, "ledger.sqlite3");
    const ledger = Ledger.open(ledgerPath);
    ledger.upsertAccount({ id: "codex-empty", provider: "openai-codex" });
    ledger.close();

    const client = new OrchestratorClient({ ledgerPath, runsRoot: join(directory, "runs") });
    expect(client.plans().plans.openai).toMatchObject({
      state: "unavailable",
      planCount: 1,
      checkedCount: 0,
    });
    client.close();
  });
});
