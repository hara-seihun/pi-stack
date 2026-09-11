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
  files: route("GET", "/v1/files"), fileDownload: route("GET", "/v1/files/download"), fileDownloadHead: route("HEAD", "/v1/files/download"),
  voice: route("GET", "/v1/voice"), voiceOffer: route("POST", "/v1/voice/offer"), voiceSessionUpdate: route("PATCH", "/v1/sessions/:sessionId/voice/:voiceId"), voiceSessionClose: route("DELETE", "/v1/sessions/:sessionId/voice/:voiceId"),
  governorToggle: route("POST", "/v1/governor-controls/:provider/toggle"),
  actions: route("GET", "/v1/actions"), actionToggle: route("POST", "/v1/actions/:id/toggle"), uploadInit: route("POST", "/v1/uploads/init"), upload: route("PUT", "/v1/uploads/:id"), uploadComplete: route("POST", "/v1/uploads/:id/complete"), uploads: route("POST", "/v1/uploads"), removeUploads: route("DELETE", "/v1/uploads"),
  agentRuns: route("GET", "/v1/agents/runs"), agentEvents: route("GET", "/v1/agents/runs/:runId/events"), workspaces: route("GET", "/v1/workspaces"), sync: route("POST", "/v1/sync"), sessions: route("GET", "/v1/sessions"), createSession: route("POST", "/v1/sessions"), reorderSessions: route("PUT", "/v1/sessions/order"), archivedSessions: route("GET", "/v1/sessions/archived"),
  session: route("GET", "/v1/sessions/:sessionId"), archiveSession: route("DELETE", "/v1/sessions/:sessionId"), rejectSessionEdit: route("PUT", "/v1/sessions/:sessionId"), sessionFiles: route("GET", "/v1/sessions/:sessionId/files"), sessionFilesHead: route("HEAD", "/v1/sessions/:sessionId/files"), unarchiveSession: route("POST", "/v1/sessions/:sessionId/unarchive"),
  sessionMeeting: route("GET", "/v1/sessions/:sessionId/meeting"),
  sessionMeetingVoice: route("POST", "/v1/sessions/:sessionId/meeting/voice"),
  sessionMeetingShare: route("POST", "/v1/sessions/:sessionId/meeting/browser"),
  sessionMeetingStop: route("DELETE", "/v1/sessions/:sessionId/meeting/browser"),
  sessionMeetingFrame: route("GET", "/v1/sessions/:sessionId/meeting/frame"),
  sessionInstructions: route("GET", "/v1/sessions/:sessionId/instructions"),
  sessionImage: route("GET", "/v1/sessions/:sessionId/images/:hash"),
  sessionImages: route("GET", "/v1/sessions/:sessionId/images"),
  sessionPrompt: route("POST", "/v1/sessions/:sessionId/prompt"), sessionFork: route("POST", "/v1/sessions/:sessionId/fork"), sessionAbort: route("POST", "/v1/sessions/:sessionId/abort"), sessionEvents: route("GET", "/v1/sessions/:sessionId/events"), sessionContext: route("GET", "/v1/sessions/:sessionId/context"), replaceSessionContext: route("PUT", "/v1/sessions/:sessionId/context"), patchSessionContext: route("PATCH", "/v1/sessions/:sessionId/context"),
  sessionSettings: route("GET", "/v1/sessions/:sessionId/settings"), updateSessionSettings: route("PUT", "/v1/sessions/:sessionId/settings"), sessionCommands: route("GET", "/v1/sessions/:sessionId/commands"), sessionCommand: route("POST", "/v1/sessions/:sessionId/command"),
  queueItem: route("DELETE", "/v1/sessions/:sessionId/queue/:workId"), queueSteer: route("POST", "/v1/sessions/:sessionId/queue/:workId/steer"), queueHardSteer: route("POST", "/v1/sessions/:sessionId/queue/:workId/hard-steer"),
});
