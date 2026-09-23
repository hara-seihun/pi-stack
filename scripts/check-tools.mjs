import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const manifest = JSON.parse(await readFile(join(root, "config/tools.json"), "utf8"));
if (manifest.version !== 2) throw new Error("Unknown tools manifest version");
const ids = new Set();
const commands = new Set();

function help(entry) {
  return new Promise((resolve, reject) => {
    const child = spawn(entry, ["--help"], { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${entry} --help exceeded eight seconds`));
    }, 8_000);
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${entry} --help failed${signal ? ` with ${signal}` : ` with exit ${code}`}`));
    });
  });
}

for (const tool of manifest.tools) {
  if (!/^[a-z0-9-]+$/.test(tool.id) || ids.has(tool.id)) throw new Error(`invalid or repeated tool id: ${tool.id}`);
  ids.add(tool.id);
  await access(join(root, "tools", tool.id, "README.md"), constants.R_OK);
  for (const command of tool.commands) {
    if (!/^[a-z0-9-]+$/.test(command.name) || commands.has(command.name))
      throw new Error(`invalid or repeated command: ${command.name}`);
    commands.add(command.name);
    const entry = join(root, "tools", tool.id, command.entry);
    await access(entry, constants.R_OK | constants.X_OK);
    await help(entry);
  }
}

console.log(`checked ${ids.size} Pi tools and ${commands.size} commands`);
