function compactJson(value: unknown, spacing?: number) {
  try {
    return JSON.stringify(value ?? {}, null, spacing);
  } catch {
    return String(value ?? "");
  }
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function head(value: unknown, length = 60) {
  const source = text(value);
  return source.length > length ? `${source.slice(0, length - 1)}…` : source;
}

export function shortPath(path: string, home: string) {
  return path === home ? "~" : home && path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

export function duration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** How many changes an `edit` call makes: the head carries `editCount`, the body the edits. */
function editCount(args: any): number {
  const counted = Number(args?.editCount);
  if (Number.isFinite(counted) && counted > 0) return counted;
  return Array.isArray(args?.edits) ? args.edits.length : 0;
}

function pathArgument(args: any) {
  return text(args?.path) || text(args?.file_path) || text(args?.cwd) || text(args?.directory);
}

function browserSubject(args: any) {
  const directUrl = text(args?.url);
  if (directUrl) return directUrl;
  if (Array.isArray(args?.args)) {
    const url = args.args.find((value: unknown) => typeof value === "string" && /^(https?:|file:|about:)/i.test(value));
    if (url) return String(url);
    const first = args.args.find((value: unknown) => typeof value === "string" && value.trim());
    if (first) return String(first);
  }
  return text(args?.selector) || text(args?.name) || head(args?.script);
}

function threadSubject(args: any) {
  return text(args?.title)
    || text(args?.name)
    || text(args?.threadId)
    || text(args?.thread_id)
    || (Array.isArray(args?.threadIds) ? text(args.threadIds[0]) : "")
    || head(args?.task);
}

export function managerToolSummary(name: string, args: any, home: string, running: boolean, completeArguments: boolean): string {
  const tool = String(name).toLowerCase().replace(/^functions\./, "");
  const path = pathArgument(args);
  const shownPath = path ? ` ${shortPath(path, home)}` : "";
  const agentCount = Number.isInteger(args?.threadCount) && args.threadCount >= 0 ? args.threadCount
    : completeArguments && Array.isArray(args?.threadIds) ? args.threadIds.length : null;
  const agents = agentCount === null ? "agents" : `${agentCount} ${agentCount === 1 ? "agent" : "agents"}`;
  switch (tool) {
    case "bash": case "exec_command": return `${running ? "Running" : "Ran"} bash`;
    case "read": return `${running ? "Reading" : "Read"}${shownPath}`;
    case "edit": return `${running ? "Editing" : "Edited"}${shownPath}`;
    case "write": return `${running ? "Writing" : "Wrote"}${shownPath}`;
    case "thread_wait":
      if (args?.action === "clear") return running ? "Clearing the dependency wait" : "Cleared the dependency wait";
      if (args?.kind === "agents") return `${running ? "Waiting" : "Waited"} for ${agents}`;
      return `${running ? "Waiting" : "Waited"} for ${args?.kind === "message" ? "an agent message" : args?.kind === "job" ? "a job" : args?.kind === "deployment" ? "a deployment" : "a dependency"}`;
    case "thread_await": return `${running ? "Waiting" : "Waited"} for ${agents}`;
    case "thread_spawn": return running ? "Starting an agent" : "Started an agent";
    case "thread_send": return running ? "Sending an agent message" : "Sent an agent message";
    case "thread_read": return running ? "Reading an agent conversation" : "Read an agent conversation";
    case "thread_control": return running ? "Updating an agent" : "Updated an agent";
    case "thread_title": return running ? "Naming this conversation" : "Named this conversation";
    case "thread_attention": return running ? "Sending a notification" : "Sent a notification";
    case "image_generation": return running ? "Generating an image" : "Generated an image";
    case "agent_browser": return running ? "Browsing" : "Browsed";
    case "grep": case "find": return `${running ? "Searching" : "Searched"}${shownPath}`;
    case "ls": return `${running ? "Listing" : "Listed"}${shownPath}`;
  }
  return `Tool: ${tool.replaceAll("_", " ")}`;
}

export function toolSummary(name: string, args: any = {}, home = "") {
  const originalName = String(name || "tool");
  const tool = originalName.toLowerCase();
  const path = pathArgument(args);
  const shownPath = path ? shortPath(path, home) : "";

  if (tool === "bash" || tool === "exec_command") {
    const command = text(args?.command) || text(args?.cmd);
    return command ? `$ ${command}` : tool;
  }
  if (tool === "read") {
    const start = args?.offset ?? 1;
    const range = args?.offset !== undefined || args?.limit !== undefined
      ? `:${start}${args?.limit !== undefined ? `-${Number(start) + Number(args.limit) - 1}` : ""}`
      : "";
    return `read${shownPath ? ` ${shownPath}${range}` : ""}`;
  }
  if (tool === "edit") {
    const count = editCount(args);
    return `edit${shownPath ? ` ${shownPath}` : ""}${count > 1 ? ` · ${count} changes` : ""}`;
  }
  if (tool === "write") return `write${shownPath ? ` ${shownPath}` : ""}`;
  if (tool === "agent_browser") {
    const subject = browserSubject(args);
    return `agent_browser${subject ? ` ${head(subject)}` : ""}`;
  }
  if (["thread_spawn", "thread_send", "thread_read", "thread_await", "thread_control"].includes(tool)) {
    const subject = threadSubject(args);
    return `${tool}${subject ? ` ${head(subject)}` : ""}`;
  }
  if (tool === "image_generation") {
    const prompt = head(args?.prompt);
    return `image_generation${prompt ? ` ${prompt}` : ""}`;
  }
  if (tool === "grep") {
    const pattern = text(args?.pattern) || text(args?.query);
    return `grep${pattern ? ` ${head(pattern)}` : ""}${shownPath ? ` · ${shownPath}` : ""}`;
  }
  if (tool === "find") {
    const pattern = text(args?.pattern) || text(args?.name);
    return `find${shownPath ? ` ${shownPath}` : ""}${pattern ? ` · ${head(pattern)}` : ""}`;
  }
  if (tool === "ls") return `ls${shownPath ? ` ${shownPath}` : ""}`;

  const json = compactJson(args).slice(0, 60);
  return `${originalName}${json && json !== "{}" ? ` ${json}` : ""}`;
}
