import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function managedCliSource(source) {
  const eager = 'import { createManagedAgentSession } from "../../../../managed-agent.mjs"; // PiStack native ThreadService owner\n';
  const lazy = 'const { createManagedAgentSession } = await import("../../../../managed-agent.mjs"); // PiStack native ThreadService owner';
  if (source.includes(lazy)) return source;
  const replace = (before, after) => {
    if (source.split(before).length !== 2) throw new Error(`Managed CLI patch no longer matches Pi: ${before}`);
    source = source.replace(before, after);
  };
  if (source.includes(eager)) {
    replace(eager, "");
    replace("const created = await createManagedAgentSession(", `${lazy}\n        const created = await createManagedAgentSession(`);
  } else {
    replace("const created = await createAgentSessionFromServices({", `${lazy}\n        const created = await createManagedAgentSession(() => createAgentSessionFromServices({`);
    replace("            customTools: sessionOptions.customTools,\n        });", "            customTools: sessionOptions.customTools,\n        }), { cwd });");
  }
  return source;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dist = join(process.argv[2], "@earendil-works/pi-coding-agent/dist");
  const path = join(dist, "main.js");
  const source = readFileSync(path, "utf8"), next = managedCliSource(source);
  if (source !== next) writeFileSync(path, next);
  const runtime = join(dist, "core/agent-session-runtime.js");
  const previous = readFileSync(runtime, "utf8");
  writeFileSync(runtime, previous.replaceAll("        this.session.dispose();", "        await this.session.dispose();"));
}
