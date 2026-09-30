#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const root = new URL("../../", import.meta.url);
const path = new URL("package-lock.json", root);
const lock = JSON.parse(await readFile(path, "utf8"));
for (const [name, item] of Object.entries(lock.packages)) {
  if (!item.resolved?.startsWith("file:vendor/pi/")) continue;
  const bytes = await readFile(new URL(item.resolved.slice(5), root));
  item.integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  console.log(`${name}: ${item.integrity}`);
}
await writeFile(path, `${JSON.stringify(lock, null, 2)}\n`);
