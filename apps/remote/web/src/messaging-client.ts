import { API } from "../../server/api";
import type { MessagingAttachment, MessagingCall, MessagingConversation, MessagingHistory, MessagingLink, MessagingLinkPreview, MessagingMessage, MessagingResult, MessagingSend } from "../../server/messaging/protocol";
import { piFetch } from "./client";
import { PreviewQueue } from "./preview-queue";

const previewQueue = new PreviewQueue();

async function request<T>(path: string, init: RequestInit, signal: AbortSignal): Promise<MessagingResult<T>> {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  if (signal.aborted) cancel();
  else signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Messaging request timed out")), 20_000);
  try {
    const response = await piFetch(path, { ...init, signal: controller.signal, cache: "no-store" });
    const result = await response.json();
    if (!response.ok) return { ok: false, error: { code: String(response.status), message: typeof result.error === "string" ? result.error : result.error?.message || `HTTP ${response.status}` } };
    return { ok: true, value: result as T };
  } catch (error) {
    return { ok: false, error: { code: controller.signal.aborted ? "aborted" : "network", message: error instanceof Error ? error.message : String(error) } };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
}

const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
export const messagingClient = {
  open: (backendId: string, target: string, signal: AbortSignal) => request<{ conversation: MessagingConversation }>(API.messagingOpen.path(), json({ backendId, target }), signal),
  history: (conversationId: string, signal: AbortSignal, before?: number) => request<MessagingHistory>(API.messagingHistory.path({ conversationId }, { limit: 50, ...(before === undefined ? {} : { before }) }), {}, signal),
  linkPreviews: async (messageId: string, signal: AbortSignal): Promise<MessagingResult<{ previews: MessagingLinkPreview[] }>> => {
    const release = await previewQueue.acquire(signal);
    if (!release) return { ok: false, error: { code: "aborted", message: "Preview request cancelled" } };
    try { return await request<{ previews: MessagingLinkPreview[] }>(API.messagingLinkPreviews.path({ messageId }), {}, signal); }
    finally { release(); }
  },
  send: (conversationId: string, body: MessagingSend, signal: AbortSignal) => request<{ message: MessagingMessage }>(API.messagingSend.path({ conversationId }), json(body), signal),
  read: (conversationId: string, signal: AbortSignal) => request<{ ok: true }>(API.messagingRead.path({ conversationId }), json({}), signal),
  upload: (conversationId: string, file: File, signal: AbortSignal) => request<{ attachment: MessagingAttachment }>(API.messagingUpload.path({ conversationId }, { name: file.name }), { method: "POST", headers: { "content-type": file.type || "application/octet-stream" }, body: file }, signal),
  remove: (attachmentId: string, signal: AbortSignal) => request<{ ok: true }>(API.messagingRemoveAttachment.path({ attachmentId }), { method: "DELETE" }, signal),
  link: (backendId: string, deviceName: string, signal: AbortSignal) => request<{ link: MessagingLink }>(API.messagingLink.path({ backendId }), json({ deviceName }), signal),
  cancelLink: (backendId: string, signal: AbortSignal) => request<{ link: MessagingLink }>(API.messagingCancelLink.path({ backendId }), { method: "DELETE" }, signal),
  placeCall: (backendId: string, conversationId: string, requestId: string, signal: AbortSignal) => request<{ call: MessagingCall }>(`/v1/messaging/backends/${encodeURIComponent(backendId)}/calls`, json({ conversationId, requestId }), signal),
  acceptCall: (callId: string, signal: AbortSignal) => request<{ call: MessagingCall }>(`/v1/messaging/calls/${encodeURIComponent(callId)}/accept`, json({}), signal),
  hangupCall: (callId: string, signal: AbortSignal) => request<{ call: MessagingCall }>(`/v1/messaging/calls/${encodeURIComponent(callId)}/hangup`, json({}), signal),
  muteCall: (callId: string, muted: boolean, signal: AbortSignal) => request<{ call: MessagingCall }>(`/v1/messaging/calls/${encodeURIComponent(callId)}/mute`, json({ muted }), signal),
};
