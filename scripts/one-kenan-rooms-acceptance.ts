import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { StagingStack } from "./one-kenan-staging";
import { fixtureBroker } from "./one-kenan-fixture-broker";
import { MemoryStore } from "../packages/kenan-memory/src/store";
import { memoryService } from "../packages/kenan-memory/src/service";
import { oneKenanEnabled } from "../packages/kenan-memory/src/config";
import { rootService } from "../packages/kenan-root/src/service";
import { createRootExecutor } from "../packages/kenan-root/src/root-runtime";
import { roomAudienceResolver } from "../apps/remote/server/room-audience.mjs";
import { catalogModel } from "../packages/orchestrator/src/catalog";

const stack = new StagingStack(undefined, 19880, true);
stack.routerAsRoot = true;
stack.initialize();
const root = stack.root, home = join(root, "pi-rooms"), roster = join(root, "roster/rooms.sqlite3"), publicCode = join(root, "public-code");
const baseEnvironment = stack.environment.bind(stack);
stack.environment = person => ({ ...baseEnvironment(person), PI_REMOTE_ROOMS_DB: roster, PI_REMOTE_ROOMS_OWNER_URL: "http://127.0.0.1:19884" });
const checks: string[] = [];
const check = (value: unknown, message: string) => { if (!value) throw new Error(message); checks.push(message); };
const enabled = () => oneKenanEnabled({ PI_STACK_HOST_CONFIG: stack.hostFile });
const roomToken = randomBytes(32).toString("hex"), rootToken = randomBytes(32).toString("hex"), adminCapability = randomBytes(32).toString("hex");
const auth = { supervisors: [{ person: "pi-rooms", token: roomToken }], uidPersons: { "65534": "pi-rooms" }, rootToken };
const store = new MemoryStore(join(root, "memory.sqlite3"));
store.write("alice", { text: "Kenan emailed Gaétane for Alice and Bob. The engineer visit is Thursday.", about: ["alice", "bob"], source: { actedFor: "alice", action: "email", externalId: "fixture-room-action" }, setting: { person: "alice" }, obviouslyPrivate: false });
const memory = memoryService({ store, auth, enabled, roomAudience: (person, threadId) => roomAudienceResolver(roster)(person, threadId) });
memory.listen(19883, "127.0.0.1"); await once(memory, "listening");
let broker: Awaited<ReturnType<typeof fixtureBroker>> | undefined;
let owner: ReturnType<typeof Bun.spawn> | undefined;
let rootServer: ReturnType<typeof Bun.serve> | undefined;
async function fixtureCommand(args: string[]) { const child = Bun.spawn(["sudo", "-n", ...args], { stdout: "pipe", stderr: "pipe" }); const error = await new Response(child.stderr).text(); if (await child.exited !== 0) throw new Error(error); }
try {
  mkdirSync(join(root, "roster"), { mode: 0o700 });
  await fixtureCommand(["setfacl", "-m", `d:u:${process.getuid!()}:r-x`, join(root, "roster")]);
  await stack.start();
  const pid = stack.children.find(child => child.name === "router")!.child.pid;
  broker = await fixtureBroker(root);
  for (const directory of [home, join(home, "agent"), join(home, "remote"), join(root, "root-workspace"), join(root, "root-agent"), join(root, "root-sessions")]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "agent/settings.json"), JSON.stringify({ packages: [] }));
  writeFileSync(join(home, "supervisor-token"), roomToken, { mode: 0o600 });
  const configPath = join(home, "config.json");
  writeFileSync(configPath, JSON.stringify({ version: 1, user: "pi-rooms", displayName: "Kenan rooms", environment: {} }));
  writeFileSync(join(root, "one-kenan.json"), JSON.stringify({ version: 1, executionUser: "fixture-root", custodySocket: join(root, "custody.sock"), rootPort: 19886 }));
  writeFileSync(stack.hostFile, JSON.stringify({ ...JSON.parse(readFileSync(stack.hostFile, "utf8")), oneKenan: true }));
  await fixtureCommand(["chown", "-R", "65534:65534", home]);
  await fixtureCommand(["setfacl", "-m", "u:65534:--x", root]);
  mkdirSync(publicCode, { mode: 0o755 });
  chmodSync(publicCode, 0o755);
  const copy = Bun.spawn(["rsync", "-a", "--chmod=D755,Fu=rwX,Fgo=rX", "apps", "packages", "config", "tools", "vendor", "node_modules", "package.json", "package-lock.json", `${publicCode}/`], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const copyError = await new Response(copy.stderr).text();
  check(await copy.exited === 0, `public release sources copied without changing private checkout ACLs: ${copyError}`);
  const env = { PATH: process.env.PATH!, HOME: home, USER: "nobody", LANG: "C.UTF-8", PI_REMOTE_CONFIG: configPath,
    PI_STACK_HOST_CONFIG: stack.hostFile, PI_STACK_HOST_FILE: stack.hostFile, PI_KENAN_CONFIG: join(root, "one-kenan.json"),
    PI_REMOTE_DATA: join(home, "remote"), PI_REMOTE_PORT: "19884", PI_REMOTE_ENVIRONMENT_ID: "staging", PI_REMOTE_ENVIRONMENT_NAME: "Fixture staging",
    PI_AGENT_DIR: join(home, "agent"), PI_REMOTE_ORCHESTRATOR_DB: join(home, "ledger.sqlite3"), PI_REMOTE_WATCH_ENABLED: "0",
    PI_MODEL_BROKER_URL: broker.url, PI_KENAN_MEMORY_URL: "http://127.0.0.1:19883", PI_KENAN_ROOT_URL: "http://127.0.0.1:19886",
    PI_KENAN_MEMORY_SUPERVISOR_TOKEN_FILE: join(home, "supervisor-token"), PI_REMOTE_ROOMS_MODEL: "sol", PI_REMOTE_ROOMS_MODELS: "sol" };
  const log = Bun.file(join(root, "logs/rooms.log"));
  owner = Bun.spawn(["sudo", "-n", "setpriv", "--reuid=65534", "--regid=65534", "--clear-groups", "env", "-i", ...Object.entries(env).map(([key, value]) => `${key}=${value}`), process.execPath, join(publicCode, "apps/remote/server/rooms-main.ts")], { cwd: publicCode, stdout: log, stderr: log });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && owner.exitCode === null) { try { if ((await fetch("http://127.0.0.1:19884/v1/health")).ok) break; } catch {} await Bun.sleep(20); }
  check(owner.exitCode === null && (await fetch("http://127.0.0.1:19884/v1/health")).ok, `actual unprivileged room owner ready: ${readFileSync(join(root, "logs/rooms.log"), "utf8").slice(-4000)}`);
  const specification = catalogModel("sol")!;
  const config = { version: 1 as const, provider: specification.provider, model: specification.model, thinkingLevel: "low" as const, cwd: join(root, "root-workspace"), agentDir: join(root, "root-agent"), sessionsDir: join(root, "root-sessions"), promptFile: join(import.meta.dir, "../packages/kenan-root/instructions.md"), brokerUrl: `${broker.url}/` };
  rootServer = Bun.serve({ hostname: "127.0.0.1", port: 19886, idleTimeout: 255, fetch: rootService({ enabled, memoryUrl: "http://127.0.0.1:19883", memoryRootToken: rootToken, adminCapability, sessionsDir: config.sessionsDir, executor: createRootExecutor(config, { env: { PI_STACK_HOST_CONFIG: stack.hostFile, PI_STACK_HOST_FILE: stack.hostFile, PI_KENAN_MEMORY_URL: "http://127.0.0.1:19883" } }) }) });
  for (const person of ["alice", "bob", "admin"] as const) check((await stack.unlock(person)).status === 200, `${person} personal entry still works`);
  const id = randomUUID();
  const created = await stack.request("alice", "/v1/rooms", { requestId: id, title: "Fixture House", members: ["bob"] });
  check(created.status === 201, `real room creation routed to dedicated owner: ${await created.text()}`);
  for (const person of ["alice", "bob"] as const) check((await (await stack.request(person, "/v1/rooms")).json()).rooms.some((room: any) => room.id === id), `${person} discovers shared room`);
  check((await stack.request("admin", `/v1/rooms/${id}`)).status === 404, "nonmember cannot inspect room");
  check((await stack.request("bob", `/v1/room-owner/${id}`)).status === 403, "browser cannot proxy internal room owner API");
  const sent = await stack.request("bob", `/v1/rooms/${id}/prompt`, { requestId: randomUUID(), text: "Please use ask_kenan to ask whether Kenan emailed Gaétane for Alice and Bob and when the engineer visit is. Then tell both of us the answer." });
  check(sent.status === 202, `Bob message accepted: ${await sent.text()}`);
  let snapshot: any;
  const finished = Date.now() + 120_000;
  while (Date.now() < finished) {
    snapshot = await (await stack.request("alice", `/v1/rooms/${id}`)).json();
    if (snapshot.state === "idle" && snapshot.messages?.some((message: any) => message.sender.user === "assistant")) break;
    if (owner.exitCode !== null) throw new Error(readFileSync(join(root, "logs/rooms.log"), "utf8").slice(-6000));
    await Bun.sleep(100);
  }
  check(snapshot.state === "idle" && snapshot.messages.some((message: any) => message.sender.user === "assistant" && /Thursday/i.test(message.text)), `native room/root turn complete: ${JSON.stringify(snapshot).slice(-8000)}`);
  const bobSnapshot = await (await stack.request("bob", `/v1/rooms/${id}`)).json();
  check(JSON.stringify(snapshot.messages) === JSON.stringify(bobSnapshot.messages), "Alice and Bob see identical native room conversation");
  check(snapshot.work.some((work: any) => work.kind === "toolCall" && work.name === "ask_kenan") && snapshot.work.some((work: any) => work.kind === "toolResult"), "room shows complete ask request and chosen root reply tool bodies");
  const context = snapshot.context?.context ?? snapshot.context;
  const tools = context?.tools?.map((tool: any) => tool.name).sort();
  check(JSON.stringify(tools) === JSON.stringify(["ask_kenan", "request_user_input_async"].sort()), `actual SDK room initialized exact toolset: ${JSON.stringify(tools)}`);
  const disclosure = store.disclosures("alice", { threadId: "proof", turnId: "proof" }, 100, "root", "alice").value.find(entry => entry.kind === "root-reply");
  check(disclosure && JSON.stringify(disclosure.to.sort()) === JSON.stringify(["alice", "bob"]), "root boundary uses full authenticated room roster, not speaker only");
  writeFileSync(stack.hostFile, JSON.stringify({ version: 1, environments: [{ id: "staging", name: "Fixture staging", icon: "home" }] }));
  check((await stack.request("bob", "/v1/sessions")).ok && stack.children.find(child => child.name === "router")!.child.pid === pid, "room rollback leaves original Bob supervisor/router running");
  writeFileSync(join(root, "rooms-proof.json"), JSON.stringify({ root, checks, snapshot }, null, 2));
  console.log(`Native rooms acceptance passed: ${join(root, "rooms-proof.json")}`);
} finally {
  if (owner?.exitCode === null) { owner.kill("SIGTERM"); await owner.exited; }
  rootServer?.stop(true); await broker?.close(); await stack.stop();
  await new Promise<void>(resolve => memory.close(() => resolve())); store.close();
}
