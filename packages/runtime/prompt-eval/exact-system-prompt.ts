import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function exactSystemPrompt(pi: ExtensionAPI): Promise<void> {
  const promptPath = process.env.PROMPT_EVAL_SYSTEM_PROMPT;
  if (!promptPath) throw new Error("PROMPT_EVAL_SYSTEM_PROMPT is not set");
  const systemPrompt = await readFile(promptPath, "utf8");
  pi.on("before_agent_start", () => ({ systemPrompt }));
}
