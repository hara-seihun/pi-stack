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
  network: route("GET", "/v1/network"),
  featureUsage: route("GET", "/v1/feature-usage"), recordFeatureUsage: route("POST", "/v1/feature-usage"),
  notifications: route("GET", "/v1/notifications"),
  needsYou: route("GET", "/v1/needs-you"),
  dismissNeed: route("POST", "/v1/needs-you/dismiss"),
  phones: route("GET", "/v1/phones"), phoneConnect: route("GET", "/v1/phones/connect"), phoneCommands: route("GET", "/v1/phones/commands"), phoneCommand: route("POST", "/v1/phones/:phoneId/commands"),
  messageReaction: route("POST", "/v1/messages/reactions"),
  sessionReaction: route("POST", "/v1/sessions/:sessionId/reactions"),
  messaging: route("GET", "/v1/agent-signal"),
  messagingOpen: route("POST", "/v1/agent-signal/conversations"),
  messagingHistory: route("GET", "/v1/agent-signal/conversations/:conversationId/messages"),
  messagingSend: route("POST", "/v1/agent-signal/conversations/:conversationId/messages"),
  messagingReact: route("POST", "/v1/agent-signal/messages/:messageId/reactions"),
  messagingUpload: route("POST", "/v1/agent-signal/conversations/:conversationId/attachments"),
  messagingAttachment: route("GET", "/v1/agent-signal/attachments/:attachmentId"),
  messagingRemoveAttachment: route("DELETE", "/v1/agent-signal/attachments/:attachmentId"),
  messagingLink: route("POST", "/v1/agent-signal/backends/:backendId/link"),
  messagingCancelLink: route("DELETE", "/v1/agent-signal/backends/:backendId/link"),
  fileInfo: route("GET", "/v1/files/info"),
  fileEdit: route("GET", "/v1/files/edit"), fileSave: route("PUT", "/v1/files/edit"),
  files: route("GET", "/v1/files"), fileDownload: route("GET", "/v1/files/download"), fileDownloadHead: route("HEAD", "/v1/files/download"),
  speech: route("GET", "/v1/speech"), speechVoices: route("GET", "/v1/speech/engines/:engineId/voices"), speechUtterances: route("POST", "/v1/speech/utterances"), speechUtterance: route("GET", "/v1/speech/utterances/:utteranceId"), speechAudio: route("GET", "/v1/speech/utterances/:utteranceId/audio"),
  voice: route("GET", "/v1/voice"), voiceOffer: route("POST", "/v1/voice/offer"), voiceSessionUpdate: route("PATCH", "/v1/sessions/:sessionId/voice/:voiceId"), voiceSessionClose: route("DELETE", "/v1/sessions/:sessionId/voice/:voiceId"),
  setModelAvailability: route("PUT", "/v1/models/:id/availability"),
  actions: route("GET", "/v1/actions"), actionToggle: route("POST", "/v1/actions/:id/toggle"), uploadInit: route("POST", "/v1/uploads/init"), upload: route("PUT", "/v1/uploads/:id"), uploadComplete: route("POST", "/v1/uploads/:id/complete"), uploads: route("POST", "/v1/uploads"), removeUploads: route("DELETE", "/v1/uploads"),
  dismissError: route("POST", "/v1/errors/:errorId/dismiss"),
  /** Sample the supervisor's main thread for `seconds` (default 10, at most 60) and report the hottest functions; `format=text` for a readable report. */
  profile: route("POST", "/v1/diagnostics/profile"),
  requestTimings: route("POST", "/v1/diagnostics/requests"),
  requestTimingsRead: route("GET", "/v1/diagnostics/requests"),
  /** Measure timer lateness for `seconds`: how long requests wait behind synchronous work. */
  loopLag: route("GET", "/v1/diagnostics/loop-lag"),
  workspaces: route("GET", "/v1/workspaces"), reconcile: route("POST", "/v1/reconcile"), stream: route("POST", "/v1/stream"), streamUpdate: route("POST", "/v1/stream/:streamId"), sessions: route("GET", "/v1/sessions"), createSession: route("POST", "/v1/sessions"), archivedSessions: route("GET", "/v1/sessions/archived"),
  session: route("GET", "/v1/sessions/:sessionId"), archiveSession: route("DELETE", "/v1/sessions/:sessionId"), rejectSessionEdit: route("PUT", "/v1/sessions/:sessionId"), sessionColor: route("PUT", "/v1/sessions/:sessionId/color"), sessionFiles: route("GET", "/v1/sessions/:sessionId/files"), sessionFilesHead: route("HEAD", "/v1/sessions/:sessionId/files"), unarchiveSession: route("POST", "/v1/sessions/:sessionId/unarchive"),
  sessionPlacement: route("PUT", "/v1/sessions/:sessionId/placement"),
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
  sessionQuestions: route("GET", "/v1/sessions/:sessionId/questions"),
  sessionQuestionAnswer: route("POST", "/v1/sessions/:sessionId/questions/:questionId/answer"),
  sessionPrompt: route("POST", "/v1/sessions/:sessionId/prompt"), sessionFork: route("POST", "/v1/sessions/:sessionId/fork"), sessionAbort: route("POST", "/v1/sessions/:sessionId/abort"), sessionResume: route("POST", "/v1/sessions/:sessionId/resume"), sessionEvents: route("GET", "/v1/sessions/:sessionId/events"), sessionContext: route("GET", "/v1/sessions/:sessionId/context"), replaceSessionContext: route("PUT", "/v1/sessions/:sessionId/context"), patchSessionContext: route("PATCH", "/v1/sessions/:sessionId/context"),
  sessionAdmission: route("PUT", "/v1/sessions/:sessionId/admission"),
  sessionSettings: route("GET", "/v1/sessions/:sessionId/settings"), updateSessionSettings: route("PUT", "/v1/sessions/:sessionId/settings"), sessionCommands: route("GET", "/v1/sessions/:sessionId/commands"), sessionCommand: route("POST", "/v1/sessions/:sessionId/command"),
  queueItem: route("DELETE", "/v1/sessions/:sessionId/queue/:workId"), queueSteer: route("POST", "/v1/sessions/:sessionId/queue/:workId/steer"), queueHardSteer: route("POST", "/v1/sessions/:sessionId/queue/:workId/hard-steer"),
});
