#!/usr/bin/env node
import fs from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function cleanShellSpills(directory) {
  let removed = 0;
  // Read names only: unrelated /tmp mounts may not even support stat.
  for (const name of fs.readdirSync(directory)) {
    if (!name.startsWith("pi-bash-") || !name.endsWith(".log")) continue;
    const path = join(directory, name);
    try {
      if (!fs.lstatSync(path).isFile()) continue;
      fs.unlinkSync(path);
      removed++;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return removed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(cleanShellSpills(process.argv[2] ?? "/tmp"));
}
