import type { MessagingBackendConfig, MessagingCallState, MessagingCapabilities, MessagingLink, MessagingResult } from "./protocol";

/** A picture file the backend keeps for a contact or group; the service serves it and reads its type from the bytes. */
export interface BackendAvatar {
  path: string;
  updatedAt: number;
}
export interface BackendConversation {
  id: string;
  title: string;
  kind: "direct" | "group";
  /** `null` removes a picture the service knew; absent leaves it unchanged. */
  avatar?: BackendAvatar | null;
}
export interface BackendSender {
  id: string;
  aliases: string[];
  name: string | null;
  avatar?: BackendAvatar | null;
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
export interface BackendCall {
  /** Backend call id. Signal call ids are unsigned 64-bit decimal strings. */
  externalId: string;
  peer: string;
  direction: "incoming" | "outgoing";
  state: MessagingCallState;
  reason: string | null;
}
export interface BackendCallAudio {
  /** 48 kHz mono Int16LE from the remote party, framed in 20 ms blocks. */
  onRemote(handler: (frame: Uint8Array) => void): void;
  /** Microphone audio to the remote party. */
  write(frame: Uint8Array): void;
  close(): Promise<void>;
}
export interface MessagingCallSupport {
  start(peer: string): Promise<MessagingResult<BackendCall>>;
  accept(externalId: string): Promise<MessagingResult<BackendCall>>;
  hangup(externalId: string): Promise<MessagingResult<void>>;
  /** Open PCM transport for a call that has reached `connecting`. */
  audio(externalId: string): Promise<MessagingResult<BackendCallAudio>>;
}
export interface MessagingPluginContext {
  dataDir: string;
  conversation(value: BackendConversation): void;
  sender(value: BackendSender): void;
  /** The linked account's stable address, used for local sends before their sync arrives. */
  self(id: string): void;
  message(value: BackendMessage): Promise<void>;
  reaction(value: BackendReaction): Promise<void>;
  /** Report unsolicited call state, including incoming calls and remote hangups. */
  call(value: BackendCall): void;
  status(status: "ready" | "unconfigured" | "connecting" | "error", detail: string): void;
  /** Record an operational line where the host's service log can see it. */
  log(message: string): void;
  /** Report device-link progress. A `linked` state asks the service to restart this backend. */
  link(value: MessagingLink): void;
}
export interface MessagingPlugin {
  readonly icon: string;
  readonly capabilities: MessagingCapabilities;
  readonly calls?: MessagingCallSupport;
  /** The account owner can link this backend from the app. */
  readonly linkable?: boolean;
  /** Begin a device link and return as soon as the code is ready to display. */
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
