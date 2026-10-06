import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const entry = realpathSync(fileURLToPath(import.meta.url));
const require = createRequire(entry);
const browserPackage = require.resolve("agent-browser/package.json");
const bin = realpathSync(join(dirname(dirname(browserPackage)), ".bin"));
const nativeEntry = require.resolve("pi-agent-browser-native/dist/extensions/agent-browser/index.js");

export default async function browser(pi) {
  const scoped = process.platform === "linux" && process.env.PI_THREAD_RESOURCE_BOUNDARY;
  const front = scoped ? join(dirname(entry), "bin") : bin;
  if (scoped) process.env.PI_STACK_BROWSER_EXECUTABLE = realpathSync(join(bin, "agent-browser"));
  process.env.PATH = [...new Set([front, bin, ...(process.env.PATH ?? "").split(delimiter).filter(Boolean)])].join(delimiter);
  const { default: initialize } = await import(pathToFileURL(nativeEntry).href);
  return initialize(pi);
}
