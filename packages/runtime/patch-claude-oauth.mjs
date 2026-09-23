import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import client from "./extensions/claude-oauth/client.json" with { type: "json" };

export function patchClaudeOauthSource(source) {
  const before = `const CLAUDE_CODE_VERSION = "${client.upstreamClaudeCodeVersion}";`;
  const after = `const CLAUDE_CODE_VERSION = "${client.claudeCodeVersion}";`;
  if (source.split(after).length === 2 && !source.includes(before)) return source;
  if (source.split(before).length !== 2) throw new Error("Pinned Claude OAuth client version changed; review the upstream adapter");
  return source.replace(before, after);
}

export function patchClaudeOauth(nodeModules) {
  const root = join(nodeModules, "@pi-plugins/claude-oauth");
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (manifest.version !== client.pluginVersion) throw new Error(`Expected Claude OAuth ${client.pluginVersion}, found ${manifest.version}`);
  const path = join(root, "dist/index.mjs");
  const source = readFileSync(path, "utf8");
  const patched = patchClaudeOauthSource(source);
  if (patched !== source) writeFileSync(path, patched);
  const mapPath = `${path}.map`;
  const map = JSON.parse(readFileSync(mapPath, "utf8"));
  map.sourcesContent = map.sourcesContent.map(source => source?.replace(
    `CLAUDE_CODE_VERSION = '${client.upstreamClaudeCodeVersion}'`,
    `CLAUDE_CODE_VERSION = '${client.claudeCodeVersion}'`,
  ));
  writeFileSync(mapPath, JSON.stringify(map));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Usage: node patch-claude-oauth.mjs NODE_MODULES");
  patchClaudeOauth(resolve(process.argv[2]));
}
