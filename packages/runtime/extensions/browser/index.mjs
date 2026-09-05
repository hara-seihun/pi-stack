import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(realpathSync(fileURLToPath(import.meta.url)));
const browserPackage = require.resolve("agent-browser/package.json");
const bin = realpathSync(join(dirname(dirname(browserPackage)), ".bin"));
const nativeEntry = require.resolve("pi-agent-browser-native/dist/extensions/agent-browser/index.js");

export default async function browser(pi) {
  process.env.PATH = [bin, ...(process.env.PATH ?? "").split(delimiter).filter((path) => path && path !== bin)].join(delimiter);
  const { default: initialize } = await import(pathToFileURL(nativeEntry).href);
  return initialize(pi);
}
