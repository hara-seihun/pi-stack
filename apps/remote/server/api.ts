export interface Route {
  method: string;
  template: string;
  path(params?: Record<string, string | number>, query?: Record<string, string | number | boolean | null | undefined>): string;
  match(method: string, pathname: string): Record<string, string> | null;
}

function route(method: string, template: string): Route {
  const names = [...template.matchAll(/:([A-Za-z][A-Za-z0-9_]*)/g)].map((match) => match[1]);
  const pattern = new RegExp(`^${template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:([A-Za-z][A-Za-z0-9_]*)/g, "([^/]+)")}$`, "i");
  return Object.freeze({
    method,
    template,
    path(params: Record<string, string | number> = {}, query: Record<string, string | number | boolean | null | undefined> = {}) {
      const pathname = template.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, (_token, name: string) => {
        const value = params[name];
        if (value === undefined) throw new Error(`Missing API path parameter ${name}`);
        return encodeURIComponent(String(value));
      });
      const search = new URLSearchParams();
      for (const [name, value] of Object.entries(query)) if (value !== undefined && value !== null) search.set(name, String(value));
      const suffix = search.toString();
      return suffix ? `${pathname}?${suffix}` : pathname;
    },
    match(candidateMethod: string, pathname: string) {
      if (candidateMethod !== method) return null;
      const found = pattern.exec(pathname);
      return found ? Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(found[index + 1])])) : null;
    },
  });
}

export const API = Object.freeze({
  unlock: route("POST", "/v1/unlock"), health: route("GET", "/v1/health"), environment: route("GET", "/v1/environment"), environments: route("GET", "/v1/environments"),
  notifications: route("GET", "/v1/notifications"),
  messageReaction: route("POST", "/v1/messages/reactions"),
  sessionReaction: route("POST", "/v1/sessions/:sessionId/reactions"),
  messaging: route("GET", "/v1/messaging"),
  messagingOpen: route("POST", "/v1/messaging/conversations"),
  messagingClose: route("DELETE", "/v1/messaging/conversations/:conversationId"),
  messagingHistory: route("GET", "/v1/messaging/conversations/:conversationId/messages"),
  messagingLinkPreviews: route("GET", "/v1/messaging/messages/:messageId/link-previews"),
  messagingSend: route("POST", "/v1/messaging/conversations/:conversationId/messages"),
  messagingRead: route("POST", "/v1/messaging/conversations/:conversationId/read"),
  messagingUpload: route("POST", "/v1/messaging/conversations/:conversationId/attachments"),
  messagingAttachment: route("GET", "/v1/messaging/attachments/:attachmentId"),
  messagingRemoveAttachment: route("DELETE", "/v1/messaging/attachments/:attachmentId"),
  /** A contact's, sender's or group's picture by its backend identity (a conversation's `externalId` or a message's `sender`). */
  messagingAvatar: route("GET", "/v1/messaging/backends/:backendId/avatars/:avatarId"),
  messagingLink: route("POST", "/v1/messaging/backends/:backendId/link"),
  messagingCancelLink: route("DELETE", "/v1/messaging/backends/:backendId/link"),
  messagingCalls: route("GET", "/v1/messaging/calls"),
  messagingStartCall: route("POST", "/v1/messaging/backends/:backendId/calls"),
  messagingAcceptCall: route("POST", "/v1/messaging/calls/:callId/accept"),
  messagingHangupCall: route("POST", "/v1/messaging/calls/:callId/hangup"),
  messagingMuteCall: route("POST", "/v1/messaging/calls/:callId/mute"),
  messagingCallAudio: route("GET", "/v1/messaging/calls/:callId/audio"),
  fileInfo: route("GET", "/v1/files/info"),
  files: route("GET", "/v1/files"), fileDownload: route("GET", "/v1/files/download"), fileDownloadHead: route("HEAD", "/v1/files/download"),
  speech: route("GET", "/v1/speech"), speechVoices: route("GET", "/v1/speech/engines/:engineId/voices"), speechUtterances: route("POST", "/v1/speech/utterances"), speechUtterance: route("GET", "/v1/speech/utterances/:utteranceId"), speechAudio: route("GET", "/v1/speech/utterances/:utteranceId/audio"),
  voice: route("GET", "/v1/voice"), voiceOffer: route("POST", "/v1/voice/offer"), voiceSessionUpdate: route("PATCH", "/v1/sessions/:sessionId/voice/:voiceId"), voiceSessionClose: route("DELETE", "/v1/sessions/:sessionId/voice/:voiceId"),
  governorToggle: route("POST", "/v1/governor-controls/:provider/toggle"),
  actions: route("GET", "/v1/actions"), actionToggle: route("POST", "/v1/actions/:id/toggle"), uploadInit: route("POST", "/v1/uploads/init"), upload: route("PUT", "/v1/uploads/:id"), uploadComplete: route("POST", "/v1/uploads/:id/complete"), uploads: route("POST", "/v1/uploads"), removeUploads: route("DELETE", "/v1/uploads"),
  dismissError: route("POST", "/v1/errors/:errorId/dismiss"),
  /** Sample the supervisor's main thread for `seconds` (default 10, at most 60) and report the hottest functions; `format=text` for a readable report. */
  profile: route("POST", "/v1/diagnostics/profile"),
  requestTimings: route("POST", "/v1/diagnostics/requests"),
  requestTimingsRead: route("GET", "/v1/diagnostics/requests"),
  /** Measure timer lateness for `seconds`: how long requests wait behind synchronous work. */
  loopLag: route("GET", "/v1/diagnostics/loop-lag"),
  workspaces: route("GET", "/v1/workspaces"), stream: route("POST", "/v1/stream"), streamUpdate: route("POST", "/v1/stream/:streamId"), sessions: route("GET", "/v1/sessions"), createSession: route("POST", "/v1/sessions"), archivedSessions: route("GET", "/v1/sessions/archived"),
  session: route("GET", "/v1/sessions/:sessionId"), archiveSession: route("DELETE", "/v1/sessions/:sessionId"), rejectSessionEdit: route("PUT", "/v1/sessions/:sessionId"), sessionColor: route("PUT", "/v1/sessions/:sessionId/color"), sessionFiles: route("GET", "/v1/sessions/:sessionId/files"), sessionFilesHead: route("HEAD", "/v1/sessions/:sessionId/files"), unarchiveSession: route("POST", "/v1/sessions/:sessionId/unarchive"),
  sessionMeeting: route("GET", "/v1/sessions/:sessionId/meeting"),
  sessionMeetingVoice: route("POST", "/v1/sessions/:sessionId/meeting/voice"),
  sessionMeetingShare: route("POST", "/v1/sessions/:sessionId/meeting/browser"),
  sessionMeetingStop: route("DELETE", "/v1/sessions/:sessionId/meeting/browser"),
  sessionMeetingFrame: route("GET", "/v1/sessions/:sessionId/meeting/frame"),
  sessionInstructions: route("GET", "/v1/sessions/:sessionId/instructions"),
  sessionImage: route("GET", "/v1/sessions/:sessionId/images/:hash"),
  sessionImages: route("GET", "/v1/sessions/:sessionId/images"),
  sessionTranscript: route("GET", "/v1/sessions/:sessionId/transcript"), sessionItem: route("GET", "/v1/sessions/:sessionId/items/:itemId"),
  sessionChildren: route("GET", "/v1/sessions/:sessionId/children"),
  sessionPrompt: route("POST", "/v1/sessions/:sessionId/prompt"), sessionFork: route("POST", "/v1/sessions/:sessionId/fork"), sessionAbort: route("POST", "/v1/sessions/:sessionId/abort"), sessionResume: route("POST", "/v1/sessions/:sessionId/resume"), sessionEvents: route("GET", "/v1/sessions/:sessionId/events"), sessionContext: route("GET", "/v1/sessions/:sessionId/context"), replaceSessionContext: route("PUT", "/v1/sessions/:sessionId/context"), patchSessionContext: route("PATCH", "/v1/sessions/:sessionId/context"),
  sessionAdmission: route("PUT", "/v1/sessions/:sessionId/admission"),
  sessionSettings: route("GET", "/v1/sessions/:sessionId/settings"), updateSessionSettings: route("PUT", "/v1/sessions/:sessionId/settings"), sessionCommands: route("GET", "/v1/sessions/:sessionId/commands"), sessionCommand: route("POST", "/v1/sessions/:sessionId/command"),
  queueItem: route("DELETE", "/v1/sessions/:sessionId/queue/:workId"), queueSteer: route("POST", "/v1/sessions/:sessionId/queue/:workId/steer"), queueHardSteer: route("POST", "/v1/sessions/:sessionId/queue/:workId/hard-steer"),
});
