import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installBrowserEffectFence } from "./effects.mjs";
import { installPrivateCredentialMode } from "./private-credential.mjs";

const entry = realpathSync(fileURLToPath(import.meta.url));
const require = createRequire(entry);
const browserPackage = require.resolve("agent-browser/package.json");
const bin = realpathSync(join(dirname(dirname(browserPackage)), ".bin"));
const nativeEntry = require.resolve("pi-agent-browser-native/dist/extensions/agent-browser/index.js");

export function browserEffectEnvironment() {
  return globalThis[Symbol.for("pi-stack.session-environment")]?.getStore() ?? process.env;
}

export default async function browser(pi) {
  const effectEnvironment = browserEffectEnvironment();
  const scoped = process.platform === "linux" && process.env.PI_THREAD_RESOURCE_BOUNDARY;
  const front = scoped ? join(dirname(entry), "bin") : bin;
  if (scoped) process.env.PI_STACK_BROWSER_EXECUTABLE = realpathSync(join(bin, "agent-browser"));
  process.env.PATH = [...new Set([front, bin, ...(process.env.PATH ?? "").split(delimiter).filter(Boolean)])].join(delimiter);
  const { default: initialize } = await import(pathToFileURL(nativeEntry).href);
  let contract;
  const loadContract = () => contract ??= Promise.all([
    import(pathToFileURL(join(dirname(nativeEntry), "lib/argv-descriptor.js")).href),
    import(pathToFileURL(join(dirname(nativeEntry), "lib/orchestration/batch-stdin.js")).href),
    import(pathToFileURL(join(dirname(nativeEntry), "lib/input-modes/semantic-action.js")).href),
    import(pathToFileURL(join(dirname(nativeEntry), "lib/input-modes/job.js")).href),
  ]).then(parts => Object.assign({}, ...parts));
  const createAuthority = async () => {
    const { ActionHttpClient } = await import("kenan-memory/action-http-client");
    return new ActionHttpClient(effectEnvironment);
  };
  return initialize(new Proxy(pi, {
    get(target, key) {
      if (key !== "registerTool") return Reflect.get(target, key);
      return tool => {
        if (tool.name === "agent_browser") {
          installBrowserEffectFence(tool, { loadContract, createAuthority, env: effectEnvironment });
          installPrivateCredentialMode(tool);
        }
        return target.registerTool(tool);
      };
    },
  }));
}
