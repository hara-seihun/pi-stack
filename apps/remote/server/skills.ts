import { readFileSync } from "node:fs";

export function liveDevInstructions(): string {
  return readFileSync(new URL("../skills/livedev/SKILL.md", import.meta.url), "utf8")
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
}
