import { execFile } from "node:child_process";
import iamcalShortcodes from "emojibase-data/en/shortcodes/iamcal.json";
import type { MessageReaction, MessageTarget } from "./message-protocol";
import type { MessagingResult } from "./messaging/protocol";

type SlackTarget = Extract<MessageTarget, { transport: "slack" }>;
type SlackRoute = { workspace: string; command: string[]; senderId?: string; senderName?: string };
type SlackReply = { alreadyPresent?: unknown; reacted?: unknown; dryRun?: unknown; channel?: unknown; timestamp?: unknown; emoji?: unknown };

const fail = (code: string, message: string): MessagingResult<never> => ({ ok: false, error: { code, message } });
const channelId = /^[CDG][A-Z0-9]+$/u;
const slackTs = /^\d+\.\d{1,6}$/u;
const emojiName = /^(?:[a-z0-9][a-z0-9_+-]*|[+-]1)$/u;
const shortcodes = iamcalShortcodes as Record<string, string | string[]>;

function routesFromEnvironment(raw: string | undefined): SlackRoute[] {
  if (raw === undefined || raw.trim() === "") return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("PI_REMOTE_SLACK_REACTIONS must be a JSON route array"); }
  if (!Array.isArray(parsed)) throw new Error("PI_REMOTE_SLACK_REACTIONS must be a JSON route array");
  const routes: SlackRoute[] = [];
  const seen = new Set<string>();
  for (const route of parsed) {
    if (route === null || typeof route !== "object" || Array.isArray(route)
      || typeof route.workspace !== "string" || !/^T[A-Z0-9]+$/u.test(route.workspace)
      || !Array.isArray(route.command) || route.command.length === 0
      || route.command.some((item: unknown) => typeof item !== "string" || item.length === 0)
      || (route.senderId !== undefined && (typeof route.senderId !== "string" || !/^U[A-Z0-9]+$/u.test(route.senderId)))
      || (route.senderName !== undefined && (typeof route.senderName !== "string" || !route.senderName.trim()))) {
      throw new Error("PI_REMOTE_SLACK_REACTIONS has an invalid route");
    }
    if (seen.has(route.workspace)) throw new Error(`PI_REMOTE_SLACK_REACTIONS has duplicate workspace ${route.workspace}`);
    seen.add(route.workspace);
    routes.push(route as SlackRoute);
  }
  return routes;
}

export function slackEmojiName(input: string): string | null {
  const value = input.trim();
  if (value.length === 0) return null;
  const explicit = value.startsWith(":") && value.endsWith(":") ? value.slice(1, -1) : value;
  if (explicit.length <= 100 && emojiName.test(explicit)) return explicit;
  const hex = [...value].map(char => char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")).join("-");
  const names = shortcodes[hex] ?? shortcodes[hex.replace(/-FE0[EF]/gu, "")];
  const name = Array.isArray(names) ? names[0] : names;
  return typeof name === "string" && name.length <= 100 && emojiName.test(name) ? name : null;
}

function runReaction(command: string[], args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command[0]!, [...command.slice(1), ...args], {
      timeout: 50_000,
      maxBuffer: 32 * 1024,
      encoding: "utf8",
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve({ stdout, stderr });
    });
  });
}

export class SlackReactions {
  private readonly routes: SlackRoute[];

  constructor(raw = process.env.PI_REMOTE_SLACK_REACTIONS) {
    this.routes = routesFromEnvironment(raw);
  }

  instructions(): string {
    if (!this.routes.length) return "";
    return `Slack reaction workspaces available here: ${JSON.stringify(this.routes.map(route => route.workspace))}. To react to a source Slack message, call message_react with messageId slack/WORKSPACE_ID/CHANNEL_ID/MESSAGE_TS, using the channel and exact message timestamp from the Slack context. For a reply, pass its root timestamp as threadTs. The local pi/... ID of a copied Slack prompt is not the source Slack message. Slack supports adding reactions only, subject to the owning command's permissions.`;
  }

  async react(target: SlackTarget, emoji: string, remove: boolean): Promise<MessagingResult<MessageReaction[]>> {
    const route = this.routes.find(item => item.workspace === target.workspace);
    if (!route) return fail("unconfigured", `No Slack reaction route for workspace ${target.workspace}`);
    if (!channelId.test(target.channel) || !slackTs.test(target.messageId)
      || (target.threadTs !== undefined && !slackTs.test(target.threadTs))) {
      return fail("invalid_target", "Slack reaction needs a resolved channel ID and exact message and thread timestamps");
    }
    const name = slackEmojiName(emoji);
    if (!name) return fail("invalid_emoji", "Use a Unicode emoji with a known Slack name or an explicit Slack emoji name");
    if (remove) return fail("unsupported", "Kenan's guarded Slack command supports adding reactions only; removal is not available");

    const args = ["--channel", target.channel, "--timestamp", target.messageId, "--emoji", name,
      ...(target.threadTs === undefined ? [] : ["--thread-ts", target.threadTs]), "--json"];
    let stdout: string;
    try { ({ stdout } = await runReaction(route.command, args)); }
    catch (error) { return fail("slack_reaction", error instanceof Error ? error.message : String(error)); }
    let reply: SlackReply;
    try { reply = JSON.parse(stdout) as SlackReply; }
    catch { return fail("slack_reaction", "Slack command returned invalid JSON"); }
    if (!reply || reply.dryRun !== false || reply.reacted !== true
      || typeof reply.alreadyPresent !== "boolean" || reply.channel !== target.channel
      || reply.timestamp !== target.messageId || reply.emoji !== name) {
      return fail("slack_reaction", "Slack command did not confirm the requested reaction");
    }
    return { ok: true, value: [{ emoji, sender: { id: route.senderId ?? "self", ...(route.senderName ? { name: route.senderName } : {}) }, timestamp: Date.now(), own: true }] };
  }
}
