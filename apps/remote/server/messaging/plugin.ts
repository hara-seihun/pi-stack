import type { MessagingBackendConfig, MessagingCapabilities, MessagingLink, MessagingResult } from "./protocol";

export interface BackendConversation {
  id: string;
  title: string;
  kind: "direct" | "group";
}
export interface BackendSender {
  id: string;
  aliases: string[];
  name: string | null;
}
export interface BackendAttachment {
  path: string;
  name: string;
  mimeType: string;
  size: number;
}
export interface BackendReply {
  author: string;
  timestamp: number;
  text: string;
}
export interface BackendMessage {
  id: string;
  conversation: BackendConversation;
  direction: "incoming" | "outgoing";
  sender: string;
  text: string;
  timestamp: number;
  attachments: BackendAttachment[];
  reply?: BackendReply;
}
export interface BackendReaction {
  conversation: BackendConversation;
  target: { author: string; timestamp: number };
  /** The linked account's address, for distinguishing its outgoing messages. */
  account: string;
  sender: string;
  emoji: string;
  remove: boolean;
  timestamp: number;
}
export interface MessagingPluginContext {
  dataDir: string;
  conversation(value: BackendConversation): void;
  sender(value: BackendSender): void;
  /** The linked account's stable address, used for local sends before their sync arrives. */
  self(id: string): void;
  message(value: BackendMessage): Promise<void>;
  reaction(value: BackendReaction): Promise<void>;
  status(status: "ready" | "unconfigured" | "connecting" | "error", detail: string): void;
  /** Record an operational line where the host's service log can see it. */
  log(message: string): void;
  /** Report device-link progress. A `linked` state asks the service to restart this backend. */
  link(value: MessagingLink): void;
}
export interface MessagingPlugin {
  readonly icon: string;
  readonly capabilities: MessagingCapabilities;
  /** Agents can provision this backend through account linking. */
  readonly linkable?: boolean;
  /** Begin a device link and return as soon as its URI is ready. */
  startLink?(deviceName: string): Promise<MessagingResult<MessagingLink>>;
  /** Abandon a link attempt that is waiting to be scanned. */
  cancelLink?(): Promise<MessagingLink>;
  start(context: MessagingPluginContext): Promise<MessagingResult<void>>;
  openConversation(target: string): Promise<MessagingResult<BackendConversation>>;
  send(conversation: BackendConversation, message: { requestId: string; text: string; attachments: BackendAttachment[]; reply?: BackendReply }): Promise<MessagingResult<{ externalId: string; timestamp: number }>>;
  react?(conversation: BackendConversation, target: { author: string; timestamp: number }, emoji: string, remove: boolean): Promise<MessagingResult<{ timestamp: number; sender: string }>>;
  close(): Promise<void>;
}
export type MessagingPluginFactory = (config: MessagingBackendConfig) => MessagingPlugin;
