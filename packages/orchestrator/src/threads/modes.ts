import type { Admission, SettingsOverrides, ThreadSettings } from "./contracts.js";
import { requestedSpeedError, type Speed } from "./speed.js";
import { KENAZNIA_TOOLS } from "./roles.js";

/**
 * Thread modes are declared here, once, and every owner derives admission, settings and tools from
 * the mode a thread carries in `metadata.mode`. Children inherit their parent's mode.
 *
 * `live` is live consulting: a conversation with people waiting on the other end, such as a meeting.
 * Its conversation thread only dispatches, so it stays free to answer; its workers do the work.
 * The conversation runs Sol at low thinking and priority speed; its workers also run at priority.
 * Both request urgent account spending; the global execution cap still applies identically.
 * Nothing else gets these speeds by default, so extra spend is bounded by live conversations.
 */
export interface ThreadMode {
  readonly admission: Admission;
  readonly conversation: {
    readonly settings: Required<SettingsOverrides>;
    /** Tools the conversation keeps; everything else is switched off before each turn. */
    readonly tools: readonly string[];
    /** Required by native launch metadata; dispatch roles expose no shell tool. */
    readonly bashTimeoutSeconds: number;
  };
  /** Defaults for workers the conversation spawns; explicit model or thinking overrides still apply. */
  readonly worker: { readonly settings: Required<SettingsOverrides> };
}

export const THREAD_MODES = {
  live: {
    admission: "live",
    conversation: {
      settings: { model: "sol", thinkingLevel: "low", speed: "priority" },
      tools: KENAZNIA_TOOLS,
      bashTimeoutSeconds: 1,
    },
    worker: { settings: { model: "luna", thinkingLevel: "medium", speed: "priority" } },
  },
} as const satisfies Record<string, ThreadMode>;

export type ThreadModeName = keyof typeof THREAD_MODES;

export function threadMode(value: unknown): ThreadMode | undefined {
  return typeof value === "string" && Object.hasOwn(THREAD_MODES, value) ? THREAD_MODES[value as ThreadModeName] : undefined;
}

export function conversationModeSpeed(mode: ThreadModeName, settings: ThreadSettings): Speed | undefined {
  const speed = THREAD_MODES[mode].conversation.settings.speed;
  const [provider, id] = settings.model.split("/");
  return settings.speed !== speed && !requestedSpeedError({ provider, id: id ?? "" }, speed) ? speed : undefined;
}

export function isThreadModeName(value: unknown): value is ThreadModeName {
  return threadMode(value) !== undefined;
}
