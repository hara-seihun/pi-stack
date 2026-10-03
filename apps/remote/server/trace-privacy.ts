import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { MEMORY_READ_DETAIL, type MemoryReadReport } from "../../../packages/kenan-memory/src/contract";
import type { TracePerson } from "../../../packages/orchestrator/src/threads/trace-access";

export const TRACE_WITHHELD = "Traces withheld because they could reveal information Kenan holds in confidence.";
export const TRACE_PENDING = "Traces appear after this turn finishes, once Kenan can check what they would reveal.";
export interface TraceState { privateSince?: number; turnStartedAt?: number }
export interface TraceScope { room?: boolean; running?: boolean; cwd?: string }
export interface TraceOptions {
  enabled: boolean;
  viewer: string;
  persons: readonly TracePerson[];
  load(sessionId: string): TraceState | undefined;
  save(sessionId: string, state: TraceState): void;
}

export function canonicalTracePath(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync(absolute); }
  catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    const parent = dirname(absolute);
    return parent === absolute ? absolute : resolve(canonicalTracePath(parent), absolute.slice(parent.length + 1));
  }
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep);
}

function personRoots(person: TracePerson): string[] {
  const roots = [person.unlock?.mountpoint, person.unlock?.cipherDir, `/home/${person.user}`];
  const environment = person.environment ?? {};
  for (const key of ["HOME", "PI_REMOTE_DATA", "PI_CODING_AGENT_DIR"]) {
    if (typeof environment[key] === "string") roots.push(environment[key] as string);
  }
  return roots.filter((root): root is string => Boolean(root)).map(canonicalTracePath);
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(strings);
}

function groups(messages: any[]): any[][] {
  const result: any[][] = [];
  for (const message of messages) {
    if (message?.role === "user" || !result.length) result.push([]);
    result.at(-1)!.push(message);
  }
  return result;
}
const groupStart = (group: any[]): number => Number(group[0]?.timestamp) || 1;
const reportOf = (message: any): MemoryReadReport | undefined => message?.details?.[MEMORY_READ_DETAIL];

export class TracePrivacy {
  private readonly states = new Map<string, TraceState>();
  private readonly roots: Array<{ person: string; root: string }>;
  constructor(readonly options: TraceOptions) {
    this.roots = options.enabled ? options.persons.flatMap(person => personRoots(person).map(root => ({ person: person.user, root })))
      .sort((a, b) => b.root.length - a.root.length) : [];
  }
  get enabled() { return this.options.enabled; }
  state(sessionId: string): TraceState {
    if (!this.states.has(sessionId)) this.states.set(sessionId, this.options.load(sessionId) ?? {});
    return this.states.get(sessionId)!;
  }
  private save(sessionId: string, state: TraceState) {
    this.states.set(sessionId, state);
    this.options.save(sessionId, state);
  }
  private taint(sessionId: string, start: number) {
    const state = this.state(sessionId);
    const privateSince = Math.min(state.privateSince ?? Infinity, start);
    if (privateSince !== state.privateSince) this.save(sessionId, { ...state, privateSince });
  }
  pathTouchesOther(path: string, cwd = "/"): boolean {
    if (!this.enabled) return false;
    const normalized = canonicalTracePath(resolve(cwd, path));
    const owner = this.roots.find(({ root }) => within(normalized, root));
    return Boolean(owner && owner.person !== this.options.viewer);
  }
  callTouchesOther(name: string, args: any, cwd?: string): boolean {
    const tool = name.replace(/^functions\./, "");
    const paths = strings(args).flatMap(value => value.match(/\/(?:[^\s'"`<>;|]*)/g) ?? []);
    if (paths.some(path => this.pathTouchesOther(path, cwd))) return true;
    if (["read", "write", "edit"].includes(tool)) {
      const path = args?.path ?? args?.file_path;
      return typeof path !== "string" || !cwd && !isAbsolute(path) || this.pathTouchesOther(path, cwd);
    }
    // Shell code, browser sessions, delegated context and arbitrary plugins can
    // access files indirectly; string matching cannot certify them own-only.
    if (tool.startsWith("memory_") && Array.isArray(args?.about) && args.about.some((person: string) => person !== this.options.viewer)) return true;
    return !["memory_search", "memory_read", "memory_disclosures", "memory_write",
      "memory_forget", "memory_log_disclosure", "message_react"].includes(tool);
  }
  reportTouchesOther(report: MemoryReadReport | undefined): boolean {
    return Boolean(report && (report.roomId || report.touchedOtherPeople || !Array.isArray(report.about)
      || report.about.some(person => person !== this.options.viewer)));
  }
  observeContext(sessionId: string, context: any, scope: TraceScope): void {
    if (!this.enabled) return;
    for (const group of groups(context?.messages ?? [])) {
      const foreign = scope.room || group.some(message => this.reportTouchesOther(reportOf(message))
        || message?.role === "assistant" && Array.isArray(message.content)
        && message.content.some((block: any) => {
          if (block?.type !== "toolCall") return false;
          if (this.callTouchesOther(String(block.name), block.arguments, scope.cwd)) return true;
          if (!["memory_search", "memory_read", "memory_disclosures"].includes(String(block.name).replace(/^functions\./, ""))) return false;
          const result = group.find(candidate => candidate?.role === "toolResult" && candidate.toolCallId === block.id);
          return result ? !reportOf(result) : !scope.running;
        }));
      if (foreign) this.taint(sessionId, groupStart(group));
    }
  }
  observeEvent(sessionId: string, event: any, scope: TraceScope, context?: any): void {
    if (!this.enabled) return;
    if (event.type === "agent_start" || event.type === "thread_message_inserted") {
      const last = groups(context?.messages ?? []).at(-1);
      this.save(sessionId, { ...this.state(sessionId), turnStartedAt: last ? groupStart(last) : Number(event.emittedAt) || Date.now() });
    }
    if (scope.room || event.type === "tool_execution_start" && this.callTouchesOther(String(event.toolName), event.args, scope.cwd)
      || event.type === "tool_execution_end" && this.reportTouchesOther(reportOf(event.result))) {
      this.taint(sessionId, this.state(sessionId).turnStartedAt ?? 1);
    }
  }
  context(sessionId: string, context: any, scope: TraceScope): any {
    if (!this.enabled || !context) return context;
    this.observeContext(sessionId, context, scope);
    const privateSince = this.state(sessionId).privateSince;
    const turns = groups(context.messages ?? []);
    let withheld = false;
    const messages = turns.flatMap((group, index) => {
      const confidential = Boolean(scope.room || privateSince !== undefined && (!group[0]?.timestamp || groupStart(group) >= privateSince));
      const pending = Boolean(scope.running && index === turns.length - 1);
      if (!confidential && !pending) return group;
      withheld = true;
      // Redact on the server: thinking, tool bodies, arguments, images and
      // provider metadata can leak information Kenan holds in confidence.
      const visible = group.filter(message => ["user", "assistant"].includes(message?.role)).map(message => {
        const content = Array.isArray(message.content) ? message.content.filter((block: any) => ["text", "image"].includes(block?.type)).map((block: any) =>
          block.type === "text" ? { type: "text", text: String(block.text ?? "") } : { type: "image", mimeType: block.mimeType,
            ...(typeof block.src === "string" ? { src: block.src } : {}), ...(typeof block.data === "string" ? { data: block.data } : {}) }) : message.content;
        return { role: message.role, timestamp: message.timestamp, content,
          ...(message.identity ? { identity: message.identity } : {}), ...(message.reactions ? { reactions: message.reactions } : {}),
          ...(message.reply ? { reply: message.reply } : {}), ...(message.responseMetrics ? { responseMetrics: message.responseMetrics } : {}) };
      });
      visible.push({ role: "traceWithheld", timestamp: groupStart(group), content: confidential ? TRACE_WITHHELD : TRACE_PENDING });
      return visible;
    });
    return withheld ? { systemPrompt: TRACE_WITHHELD, tools: [], messages } : { ...context, messages };
  }
  events<T extends { type: string; time?: string; seq?: number; [key: string]: unknown }>(sessionId: string, events: T[], scope: TraceScope): T[] {
    if (!this.enabled) return events;
    const state = this.state(sessionId);
    return events.map(event => {
      const at = Date.parse(event.time ?? "") || Infinity;
      const confidential = scope.room || state.privateSince !== undefined && at >= state.privateSince;
      const pending = scope.running && at >= (state.turnStartedAt ?? 0);
      if ((!confidential && !pending) || !["tool_start", "tool_end", "thinking", "voice", "notice"].includes(event.type)) return event;
      return { seq: event.seq, time: event.time, type: "notice", text: confidential ? TRACE_WITHHELD : TRACE_PENDING } as unknown as T;
    });
  }
  liveThinking(sessionId: string, thinking: string, scope: TraceScope): string {
    return this.enabled && (scope.room || scope.running || this.state(sessionId).privateSince !== undefined) ? "" : thinking;
  }
  notifications<T extends { notifications: Array<{ sessionId: string; seq: number; name: string; time: string; kind?: string; body?: string }> }>(feed: T): T {
    if (!this.enabled) return feed;
    return { ...feed, notifications: feed.notifications.map(({ seq, sessionId, name, time, kind, body }) => ({ seq, sessionId, name, time, kind, body })) } as T;
  }
  rawFileAllowed(path: string, traceRoots: string[]): boolean {
    if (!this.enabled) return true;
    const canonical = canonicalTracePath(path);
    if (traceRoots.some(root => within(canonical, canonicalTracePath(root)))) return false;
    // Native JSONL and HTML exports retain raw traces, even when copied out of
    // the thread directory or renamed. Their file delivery is not a redaction.
    try {
      if (!statSync(canonical).isFile()) return true;
      const fd = openSync(canonical, "r");
      try {
        const buffer = Buffer.alloc(4096);
        const prefix = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8");
        return !(/<title>Session Export<\/title>/.test(prefix)
          || /^\s*\{[^\n]*"type"\s*:\s*"session"/.test(prefix));
      } finally { closeSync(fd); }
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return true;
      throw error;
    }
  }
}
