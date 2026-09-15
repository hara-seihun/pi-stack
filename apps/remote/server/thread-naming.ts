export const THREAD_NAMING_INSTRUCTION = "This is a thread. Please make a title for this thread that, in one to three words, summarises what the thread is about";
export const THREAD_NAMING_INTERVAL = 20;
export const THREAD_NAMING_HISTORY = 12;

export function threadNamingModel(value: string | undefined): string {
  const selection = value?.trim() ?? "";
  if (!/^(?:openai|openai-codex)(?:-\d+)?\/[^/:\s]+:(?:off|minimal|low|medium|high|xhigh|max)$/.test(selection)) {
    throw new Error("PI_REMOTE_THREAD_NAMING_MODEL must name an OpenAI model as openai/MODEL:THINKING or openai-codex/MODEL:THINKING (numbered account aliases are supported)");
  }
  return selection;
}

export function shouldNameThread(name: string, messageCount: number, namedAtMessageCount: number): boolean {
  if (messageCount < 1) return false;
  if (/^\d+$/.test(name) || /^Thread [0-9a-f]{8}$/i.test(name)) return true;
  const latestInterval = Math.floor(messageCount / THREAD_NAMING_INTERVAL) * THREAD_NAMING_INTERVAL;
  return latestInterval >= THREAD_NAMING_INTERVAL && namedAtMessageCount < latestInterval;
}

function titleFromLine(line: string): string | null {
  const name = line
    .trim()
    .replace(/^#{1,6}\s*/, "")
    .replace(/^(?:title|name)\s*:\s*/i, "")
    .replace(/^[`"']+|[`"'.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return name.length >= 3 && name.length <= 60 && !name.endsWith(":")
    && !/^\d+$/.test(name) && !/[\u0000-\u001f\u007f]/.test(name) ? name : null;
}

export function generatedThreadName(output: string): string {
  for (const line of output.split(/\r?\n/)) {
    const name = titleFromLine(line);
    if (name) return name;
  }
  throw new Error("Thread naming model returned an invalid title");
}
