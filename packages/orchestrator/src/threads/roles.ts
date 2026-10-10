export const THREAD_ROLES = ["kenaznia", "kena", "kenatia"] as const;
export type ThreadRole = typeof THREAD_ROLES[number];
export const isThreadRole = (value: unknown): value is ThreadRole => THREAD_ROLES.some(role => role === value);

export function threadRole(metadata: Record<string, unknown>, parentRole?: ThreadRole): ThreadRole {
  if (metadata.role !== undefined) {
    if (!isThreadRole(metadata.role)) throw new Error(`Invalid recorded thread role: ${String(metadata.role)}`);
    return metadata.role;
  }
  if (metadata.manager === true) return "kenaznia";
  return parentRole === "kena" || parentRole === "kenatia" ? "kenatia" : "kena";
}

export const canSpawnRole = (role: ThreadRole): boolean => role !== "kenatia";
export const childRole = (role: ThreadRole): "kena" | "kenatia" | null => role === "kenaznia" ? "kena" : role === "kena" ? "kenatia" : null;

export const KENAZNIA_TOOLS = [
  "thread_spawn", "thread_send", "thread_list", "thread_read", "thread_control", "thread_title", "thread_wait", "thread_wake", "thread_attention",
  "request_user_input_async", "manager_questions_list", "manager_questions_answer", "manager_questions_forward", "message_react",
] as const;

export function roleTools(role: ThreadRole, available: readonly string[]): string[] {
  return available.filter(name => role === "kenaznia" ? (KENAZNIA_TOOLS as readonly string[]).includes(name)
    : name !== "thread_wake" && (role !== "kenatia" || name !== "thread_spawn"));
}

export function roleInstruction(role: ThreadRole): string {
  switch (role) {
    case "kenaznia": return "You are Kenaznia, the person's dispatch-only managing conversation. Use agents for all file, shell and operational work. Decide when open work next needs action using the person's day, date, timezone, business hours and holidays; dispatch only useful work. You own the open-work digest. Thread titles describe their tasks; agents have no generated personal names.";
    case "kena": return "You are a kena. You can talk to any authorized agent and launch kenatian for bounded subtasks. When active work ends, write the state and next action to the owning Markdown notes and finish. Kenaznia decides when to pick it up again; do not park on recurring wakes. Only an explicit Close archives this thread.";
    case "kenatia": return "You are a kenatia. You can list and talk to any authorized agent with the same permissions as a kena, but cannot launch agents. When active work ends, write the state and next action to the owning Markdown notes and finish. Kenaznia decides when to pick it up again; do not park on recurring wakes. Only an explicit Close archives this thread.";
  }
}
