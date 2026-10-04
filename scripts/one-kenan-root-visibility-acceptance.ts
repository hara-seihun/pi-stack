import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { StagingStack } from "./one-kenan-staging";
import { rootAdminAdmission } from "../packages/kenan-root/src/visibility";

// Real identity router, with a fixture root owner to exercise the HTTP admission boundary.
const stack = new StagingStack(undefined, 19880, true);
const capability = randomBytes(32).toString("hex"), rootSession = randomUUID();
const roots: ReturnType<typeof Bun.serve>[] = [];
const checks: string[] = [];
function check(value: unknown, message: string) { if (!value) throw new Error(message); checks.push(message); }
function owner(port: number) {
  const server = Bun.serve({ hostname: "127.0.0.1", port, fetch(request) {
    const admission = rootAdminAdmission(request, capability);
    if (!admission.ok) return admission.response;
    return Response.json(admission.route.kind === "list"
      ? { sessions: [{ id: rootSession, title: `root fixture ${port}` }] }
      : { sessionId: rootSession, privateThinking: "ROOT_CONFIDENTIAL_TRACE_SENTINEL" }, { headers: { "cache-control": "no-store" } });
  } });
  roots.push(server);
}
try {
  stack.initialize();
  const capabilityFile = join(stack.root, "root-admin-capability");
  writeFileSync(capabilityFile, capability, { mode: 0o600 });
  const configFile = join(stack.root, "one-kenan.json");
  writeFileSync(configFile, JSON.stringify({ rootPort: 19886, rootAdminCapabilityFile: capabilityFile }));
  owner(19886); owner(19889);
  await stack.start();
  for (const person of stack.people) check((await stack.unlock(person)).status === 200, `${person} authenticated to original fixture supervisor`);
  const routerPid = stack.children.find(item => item.name === "router")!.child.pid;
  check((await stack.request("admin", "/v1/admin/root-sessions")).status === 404, "flag-off root debug absent");
  const host = JSON.parse(readFileSync(stack.hostFile, "utf8"));
  writeFileSync(stack.hostFile, JSON.stringify({ ...host, oneKenan: true }));
  for (const person of ["alice", "bob"] as const) {
    for (const path of ["/v1/admin/root-sessions", `/v1/admin/root-sessions/${rootSession}/transcript`, `/v1/sessions/${rootSession}`])
      check((await stack.request(person, path)).status === 404, `${person} cannot access ${path}`);
    const inbox = JSON.stringify(await (await stack.request(person, "/v1/sessions")).json());
    check(!inbox.includes(rootSession) && !inbox.includes("ROOT_CONFIDENTIAL"), `${person} inbox contains no root session`);
  }
  const admin = await stack.request("admin", `/v1/admin/root-sessions/${rootSession}/transcript`);
  check(admin.ok && (await admin.text()).includes("ROOT_CONFIDENTIAL_TRACE_SENTINEL"), "marked authenticated admin can inspect explicit root transcript");
  check(admin.headers.get("cache-control") === "no-store", "root transcript not cached");
  writeFileSync(configFile, JSON.stringify({ rootPort: 19889, rootAdminCapabilityFile: capabilityFile }));
  check((await (await stack.request("admin", "/v1/admin/root-sessions")).text()).includes("19889"), "existing router re-reads root endpoint after config change");
  const registryFile = join(stack.root, "persons", "admin.json");
  const registry = JSON.parse(readFileSync(registryFile, "utf8"));
  delete registry.machineAdministrator;
  writeFileSync(registryFile, JSON.stringify(registry));
  check((await stack.request("admin", "/v1/admin/root-sessions")).status === 404, "removing registry mark revokes cached admin authority immediately");
  writeFileSync(registryFile, JSON.stringify({ ...registry, machineAdministrator: true }));
  check((await stack.request("admin", "/v1/admin/root-sessions")).ok, "restored registry mark re-enables explicit admin debug without router restart");
  writeFileSync(stack.hostFile, JSON.stringify(host));
  check((await stack.request("admin", "/v1/admin/root-sessions")).status === 404, "rollback flag disables root debugging");
  check(stack.children.find(item => item.name === "router")!.child.pid === routerPid, "cutover and rollback kept original router process");
  for (const person of stack.people) check((await stack.request(person, "/v1/sessions")).ok, `${person} original path still usable after rollback`);
  const proof = { at: new Date().toISOString(), root: stack.root, phase: "root-visibility-http-fixture", checks };
  writeFileSync(join(stack.root, "root-visibility-proof.json"), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof));
} finally {
  await stack.stop();
  for (const root of roots) root.stop(true);
}
