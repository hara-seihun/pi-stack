import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { Store } from "../packages/orchestrator/src/store";
import { catalogModel } from "../packages/orchestrator/src/catalog";
import { createModelBroker } from "../packages/orchestrator/src/model-broker";
import { ModelAvailabilityStore, modelAvailabilityPath } from "../packages/orchestrator/src/threads/model-availability";
import { chooseInteractiveAccount } from "../packages/orchestrator/src/auth/account-selection";
import { defaultSharedAuthPath, providerOAuth } from "../packages/orchestrator/src/auth/shared-oauth";

/** The fixture ledger carries account/quota metadata only. Actual credentials remain with the existing provider resolver. */
export async function fixtureBroker(root: string, port = 19888) {
  const ownerLedger = process.env.PI_ORCHESTRATOR_LEDGER ?? join(homedir(), ".local/share/pi-orchestrator/ledger.sqlite3");
  const owner = Store.open(ownerLedger), ledgerPath = join(root, "fixture-provider-ledger.sqlite3");
  const fixture = Store.open(ledgerPath);
  const authPath = defaultSharedAuthPath(ownerLedger);
  const accounts: string[] = [], models: string[] = [], leases: string[] = [];
  const runId = `one-kenan-fixture:${randomUUID()}`;
  let broker: ReturnType<typeof createModelBroker> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    try {
      await broker?.close();
      const usage = fixture.db.prepare("SELECT account_id,hour,model,component,SUM(tokens) AS tokens FROM usage_hour GROUP BY account_id,hour,model,component").all() as any[];
      for (const row of usage) owner.recordUsage({ accountId: row.account_id, hour: row.hour, model: row.model, component: row.component, tokens: row.tokens, source: "interactive", runId });
    } finally {
      for (const lease of leases) owner.endLease(lease);
      fixture.close(); owner.close();
    }
  }
  try {
    for (const id of ["sol", "opus"] as const) {
      const specification = catalogModel(id)!;
      const family = builtinProviders().find(provider => provider.id === specification.provider)!;
      const auth = providerOAuth(family, authPath);
      const account = chooseInteractiveAccount(owner, auth, family.id, new Set(), { model: specification.model });
      if (!account) throw new Error(`No eligible pooled ${id} account for fixture root acceptance`);
      fixture.upsertAccount({ id: account.id, provider: account.provider, enabled: account.enabled, label: "fixture selected pool", concurrency: account.concurrency });
      for (const meter of owner.latestMeters(account.id)) fixture.recordMeter(account.id, meter.meter_id, meter.used_percent, meter.reset_at ?? undefined, meter.observed_at);
      accounts.push(account.id); models.push(`${specification.provider}/${specification.model}`);
      const lease = `${runId}:${id}`;
      owner.createLease(lease, account.id, "interactive"); leases.push(lease);
    }
    heartbeat = setInterval(() => { for (const lease of leases) owner.heartbeatLease(lease); }, 15_000);
    broker = createModelBroker({ ledgerPath, authPath, grantOwner: "fixture-root", listeners: [{ principal: "fixture-root", port, accounts, models, maxInFlight: 8 }] }, new ModelAvailabilityStore(modelAvailabilityPath()));
    await broker.listen();
    return { url: `http://127.0.0.1:${port}`, close };
  } catch (error) { await close(); throw error; }
}
