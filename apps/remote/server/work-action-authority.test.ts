import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionStore } from "kenan-memory/actions";
import { workActionsEndpoint } from "./work-action-authority";

const capability = "synthetic-only-capability-value-1234567890";
const config = { state: "ready" as const, config: { routes: {}, grants: [{ capabilitySha256: createHash("sha256").update(capability).digest("hex"), owner: "synthetic-owner", scope: "company", sourceEnvironment: "work" }] } };
const request = (operation: string, input: unknown, key = capability) => new Request("http://localhost/v1/work-external-actions", { method: "POST", headers: { "content-type": "application/json", "x-pi-work-action-capability": key }, body: JSON.stringify({ operation, input }) });
test("trusted work capability binds owner and scope, cannot expose general personal authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "work-authority-http-")), store = new ActionStore(root, "synthetic-owner");
  try {
    const input = { intentKey: "synthetic-work", recipients: ["synthetic@example.test"], transport: "browser", payload: { synthetic: true }, requestId: crypto.randomUUID(), threadId: "synthetic-thread" };
    expect((await workActionsEndpoint(request("submit", input, "wrong"), store, store.owner, config)).status).toBe(403);
    expect((await workActionsEndpoint(request("submit", input), store, "wrong-owner", config)).status).toBe(403);
    const created: any = await (await workActionsEndpoint(request("submit", input), store, store.owner, config)).json(); expect(created.ok).toBe(true);
    const inspected: any = await (await workActionsEndpoint(request("inspect", { id: created.value.action.id }), store, store.owner, config)).json(); expect(inspected.ok).toBe(true);
    const listed: any = await (await workActionsEndpoint(request("list", {}), store, store.owner, config)).json(); expect(listed).toMatchObject({ ok: false, error: "fenced" });
    const forged: any = await (await workActionsEndpoint(request("submit", { ...input, owner: "forged" }), store, store.owner, config)).json(); expect(forged.ok).toBe(false);
    expect((await workActionsEndpoint(request("inspect", {}), null, store.owner, config)).status).toBe(403);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
