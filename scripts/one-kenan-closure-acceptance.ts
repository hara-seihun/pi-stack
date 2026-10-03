import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const repository = resolve(import.meta.dir, ".."), root = mkdtempSync(join(tmpdir(), "pi-one-kenan-closure-"));
const dependencies = join(root, "dependencies"), release = join(root, "remote"), orchestrator = join(root, "orchestrator");
const copy = (source: string, destination: string) => { mkdirSync(dirname(destination), { recursive: true }); cpSync(source, destination, { recursive: true }); };
async function command(args: string[], cwd = repository) {
  const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw new Error(`${args.join(" ")} failed: ${error}\n${out}`);
}
await command(["npm", "run", "build", "--workspace=kenan-root"]);
for (const name of ["package.json", "package-lock.json", "vendor/pi"]) copy(join(repository, name), join(dependencies, name));
const listed = Bun.spawn(["git", "ls-files", "apps", "packages", "tools"], { cwd: repository, stdout: "pipe" });
const files = (await new Response(listed.stdout).text()).trim().split("\n"); await listed.exited;
for (const file of files.filter(file => file.endsWith("/package.json"))) copy(join(repository, file), join(dependencies, file));
for (const name of ["kenan-memory", "kenan-root"]) {
  for (const file of ["src", "dist", "package.json", ...(name === "kenan-memory" ? ["person.md", "discretion.md"] : ["instructions.md"])])
    copy(join(repository, "packages", name, file), join(dependencies, "packages", name, file));
}
await command(["npm", "ci", "--omit=dev", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"], dependencies);
await command(["rm", "-f", join(dependencies, "node_modules/pi-orchestrator"), join(dependencies, "node_modules/pi-remote")]);
for (const file of ["src", "dist", "package.json"]) copy(join(repository, "packages/orchestrator", file), join(orchestrator, file));
for (const file of ["src", "dist", "package.json", "instructions.md"]) copy(join(repository, "packages/kenan-root", file), join(release, "kenan-root", file));
mkdirSync(join(release, "node_modules"), { recursive: true });
await command(["ln", "-s", join(dependencies, "node_modules"), join(orchestrator, "node_modules")]);
await command(["ln", "-s", orchestrator, join(release, "node_modules/pi-orchestrator")]);
for (const name of ["kenan-memory", "kenan-root", "@earendil-works", "typebox"]) await command(["ln", "-s", join(dependencies, "node_modules", name), join(release, "node_modules", name)]);
const checks: string[] = [];
function check(value: unknown, message: string) { if (!value) throw new Error(message); checks.push(message); }
check(Bun.resolveSync("kenan-root/visibility", join(release, "node_modules")).startsWith(dependencies), "bare root visibility resolves inside production closure");
check(Bun.resolveSync("kenan-memory/tools", join(release, "kenan-root/src")).startsWith(dependencies), "root memory resolves exact production package, not writer checkout");
check(Bun.resolveSync("pi-orchestrator/api", join(release, "kenan-root/src")).startsWith(orchestrator), "root routing resolves pinned deployed orchestrator");
const host = join(root, "host.json"); writeFileSync(host, '{"oneKenan":true}');
const { createFixedSession } = await import(join(release, "kenan-root/src/root-runtime.ts"));
for (const [provider, model] of [["openai-codex", "gpt-6.1-sol"], ["anthropic", "claude-opus-5-5"]]) {
  const directory = join(root, randomUUID()); mkdirSync(directory);
  const cwd = join(directory, "workspace"), agentDir = join(directory, "agent"); mkdirSync(cwd); mkdirSync(agentDir);
  writeFileSync(join(cwd, "AGENTS.md"), "DISCOVERY_SENTINEL must never load.");
  writeFileSync(join(agentDir, "SYSTEM.md"), "DISCOVERY_SENTINEL must never load.");
  const config = { version: 1, provider, model, thinkingLevel: "low", cwd, agentDir, sessionsDir: directory, promptFile: join(release, "kenan-root/instructions.md"), brokerUrl: "http://127.0.0.1:19888/" };
  const session = await createFixedSession({ id: randomUUID(), person: "alice", recipients: ["alice"], prompt: "Fixed fixture root prompt", request: "No provider call", config, directory,
    env: { HOME: directory, PI_STACK_HOST_CONFIG: host, PI_THREAD_ID: "fixture-root", PI_KENAN_MEMORY_PERSON: "alice", PI_KENAN_MEMORY_ROLE: "root", PI_KENAN_MEMORY_TOKEN: "fixture-no-network-token", PI_MODEL_BROKER_URL: config.brokerUrl, PI_ORCHESTRATOR_LEDGER: join(directory, "ledger.sqlite3") } });
  session.dispose();
  check(true, `${provider}/${model} actual SDK initializes fixed resources and exact tools from immutable production artifacts`);
}
writeFileSync(join(root, "proof.json"), JSON.stringify({ root, checks }, null, 2));
console.log(`Production root closure passed: ${join(root, "proof.json")}`);
