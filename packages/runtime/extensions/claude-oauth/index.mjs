import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import client from "./client.json" with { type: "json" };

const require = createRequire(realpathSync(fileURLToPath(import.meta.url)));
const entry = require.resolve("@pi-plugins/claude-oauth");
if (!readFileSync(entry, "utf8").includes(`const CLAUDE_CODE_VERSION = "${client.claudeCodeVersion}";`)) {
  throw new Error(`Claude OAuth dependency needs the release-owned Claude Code ${client.claudeCodeVersion} patch`);
}

export default async function claudeOauth(pi) {
  const { default: initialize } = await import(pathToFileURL(entry).href);
  return initialize(pi);
}
