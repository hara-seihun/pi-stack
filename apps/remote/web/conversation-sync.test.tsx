import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session } from "../server/protocol";
import { ConversationScreen } from "./src/features/conversation/ConversationScreen";
import { threadStatus } from "./src/features/status/thread-status";

// Artwork paths derive from the page address; there is no page here.
globalThis.location ??= new URL("https://router.test/") as unknown as Location;

const session: Session = {
  id: "thread", parentId: null, hasChildren: false, origin: "person", model: "model", name: "Thread",
  cwd: "/", workspaceName: "", environment: "local", state: "idle", lifecycle: { kind: "idle" }, held: false, activity: "idle", activeTools: [],
  provider: "openai", createdAt: "", updatedAt: "2026-01-01T00:00:00Z", revision: 1, idleUnread: false,
  queuedMessages: [], archivedAt: null,
};

const props: Parameters<typeof ConversationScreen>[0] = {
  session, ancestors: [], entries: [
    { kind: "user", key: "cached-message", signature: "cached-message", text: "Earlier message" },
    { kind: "notice", key: "cached-note", signature: "cached-note", text: "Cached conversation text" },
  ],
  liveText: "", liveThinking: "", thinkingActive: false, images: null, offline: "", pending: false,
  home: "/", prompt: "", attachments: [], slashCommands: [],
  drawing: { isOpen: false, open() {}, editImage() {}, editors: null },
  uploadError: "", controlError: "", earlierAvailable: false, loadingEarlier: false, earlierError: "",
  onShowEarlier() {}, onThinkingOpen() {}, onBack() {}, onOpenInspector() {}, onOpenAncestor() {}, onOpenQueue() {},
  questions: [], onQuestionAccepted() {}, onEdit() {}, reply: null, onReply() {}, onCancelReply() {},
  onPrompt() {}, onSend() {}, onStop() {}, onResume() {}, onReconnect() {}, onRemoveAttachment() {},
  onUpload() {}, onPaste() {}, onDraw() {}, onDismissControlError() {}, showBack: true,
};

function render(patch: Partial<typeof props> = {}) {
  return renderToStaticMarkup(<ConversationScreen {...props} {...patch} />);
}

function header(html: string) {
  return html.match(/<header class="conversation-header[^"]*"[^>]*>.*?<\/header>/s)?.[0] ?? "";
}

test("mono keeps the shared composer and message view, suppresses live wake work, and acknowledges its first-use hint", () => {
  const mono = { hintSeen: false, saving: false, onClassic() {}, onHintSeen() {} };
  const html = render({ mono, liveThinking: "Silent manager wake thinking", thinkingActive: true });
  expect(html).toContain('title="Long-press to return to classic view"');
  expect(html).toContain('class="conversation-title-text">Kenan</span>');
  expect(html).toContain('placeholder="Message Kenan"');
  expect(html).toContain('id="prompt"');
  expect(html).toContain('aria-label="Dismiss mono view hint"');
  expect(html).not.toContain('aria-label="Back"');
  expect(html).not.toContain("Silent manager wake thinking");
  expect(html).not.toContain("Context —");
  expect(render({ mono: { ...mono, hintSeen: true } })).not.toContain('class="mono-hint"');
});

test("mono preserves execution and queue state without exposing orchestration details", () => {
  const mono = { hintSeen: true, saving: false, onClassic() {}, onHintSeen() {} };
  const waiting: Session = { ...session, hasChildren: true, state: "waiting", activity: "awaiting", lifecycle: { kind: "waiting", target: "agents", reason: "Internal dependency", since: 1 },
    waitingOnAgents: { kind: "agents", threadIds: ["worker"], after: {}, reason: "Internal dependency", since: 1 },
    queuedMessages: [{ id: "queued", text: "Internal routed input", delivery: "steer", state: "queued", canSteer: true, canHardSteer: true, canCancel: true, createdAt: "2026-10-09T23:00:00Z" }] };
  const before = JSON.stringify(waiting);
  const html = render({ mono, session: waiting, ancestors: [session], prompt: "New instruction" });
  expect(html).toContain('id="prompt"');
  expect(html).toContain('class="status-label">Waiting for agent results</span>');
  expect(html).not.toContain("Internal dependency");
  expect(html).not.toContain("Thread details");
  expect(html).toContain('aria-label="1 queued. Open the queue"');
  expect(html).not.toContain('aria-label="Launched by"');
  expect(html).not.toContain("Change delivery");
  expect(html).toContain('data-glyph="waiting"');
  expect(JSON.stringify(waiting)).toBe(before);
  const classic = render({ session: waiting, ancestors: [session], prompt: "New instruction" });
  expect(classic).toContain("Thread details");
  expect(classic).toContain('class="header-chip"');
  expect(classic).toContain('aria-label="Launched by"');
  expect(classic).toContain('data-glyph="waiting"');
  const active = render({ mono, session: { ...session, state: "running", lifecycle: { kind: "working", phase: "waiting_on_tool", since: 1, detail: "Running thread spawn" }, activity: "waiting_on_tool", activeTools: ["thread_spawn"] }, prompt: "New instruction" });
  expect(active).not.toContain("Change delivery");
  expect(active).not.toContain("thread spawn");
  expect(render({ mono, session: waiting })).toContain('aria-label="Cancel request"');
  expect(render({ session: waiting })).toContain('aria-label="Cancel wait"');
  const typing = render({ mono, session: { ...session, lifecycle: { kind: "working", phase: "responding", since: 1, detail: "Internal output phase" } }, liveText: "Visible reply", liveThinking: "Private reasoning", thinkingActive: true });
  expect(typing).toContain('aria-label="Typing"');
  expect(typing).toContain('class="live-answer"');
  expect(typing).not.toContain("Private reasoning");
  expect(typing).not.toContain("Internal output phase");
});

test("manager token updates leave the bubble timeline unchanged, then a durable reply lands once", () => {
  const active: Session = { ...session, manager: true, state: "running", activity: "responding", lifecycle: { kind: "working", phase: "responding", since: 1 } };
  const first = render({ session: active, liveText: "First token" });
  const long = render({ session: active, liveText: "A long partial answer\n".repeat(100) });
  expect(long).toBe(first);
  expect(first).toContain('class="typing-dots"');
  expect(first).not.toContain('class="live-answer"');
  const committed = { kind: "assistant" as const, key: "answer", signature: "answer", text: "Complete final answer" };
  const finished = render({ session: { ...session, manager: true }, entries: [...props.entries, committed] });
  expect(finished.match(/aria-label="Message from Kenan"/g)).toHaveLength(1);
  expect(finished).not.toContain('class="typing-dots"');
  expect(finished).toContain('aria-label="Show work for this reply"');
});

test("a silent manager turn leaves no typing bubble or work affordance after settling", () => {
  const html = render({ session: { ...session, manager: true }, entries: [...props.entries,
    { kind: "assistant", key: "silent", signature: "silent", text: "<silent/>", monoVisibility: "hidden" }] });
  expect(html).not.toContain('class="typing-dots"');
  expect(html).not.toContain('class="work-card');
  expect(html).not.toContain("&lt;silent/&gt;");
});

test("connection synchronization never replaces canonical execution state or the cached transcript", () => {
  const updating = render({ syncing: true });
  expect(header(updating)).toContain('data-connection="syncing">Syncing conversation</span>');
  expect(header(updating)).toContain('class="status-label">Idle</span>');
  expect(header(updating)).not.toContain('data-glyph="working"');
  expect(updating).toContain('class="message user"');
  expect(updating).toContain("Cached conversation text");

  const ready = render({ syncing: false });
  expect(header(ready)).toContain('data-status="idle"');
  expect(header(ready)).toContain('aria-label="Idle"');
  expect(header(ready)).not.toContain("Syncing conversation");
  expect(ready).toContain("Cached conversation text");
});

test("classic and mono show canonical execution text during sync, including queued, waiting, cancellation and failure", () => {
  const lifecycles: Session["lifecycle"][] = [
    { kind: "idle" },
    { kind: "working", phase: "thinking", since: Date.now() },
    { kind: "working", phase: "responding", since: Date.now() },
    { kind: "waiting", target: "dispatch", since: Date.now() },
    { kind: "waiting", target: "capacity", reason: "No model capacity", since: Date.now() },
    { kind: "waiting", target: "deployment", since: Date.now() },
    { kind: "cancelling" },
    { kind: "failed", reason: "Runner exited unexpectedly", control: "none" },
  ];
  for (const lifecycle of lifecycles) {
    const observed = { ...session, lifecycle, state: "idle" as const, activity: "idle" as const };
    const expected = threadStatus(observed);
    for (const mono of [undefined, { hintSeen: true, saving: false, onClassic() {}, onHintSeen() {} }]) {
      const html = header(render({ session: observed, syncing: true, mono }));
      expect(html).toContain(`data-status="${expected.key}"`);
      expect(html).toContain(`class="status-label">${expected.label}</span>`);
      expect(html).toContain('data-connection="syncing"');
      if (lifecycle.kind === "failed") expect(html).toContain(`class="status-error-detail">${lifecycle.reason}</span>`);
    }
  }
});

test("chat header consumes context usage and replaces a count with recalculating or unavailable", () => {
  const measured = { ...session, contextUsage: { tokens: 12_345, contextWindow: 200_000, percent: 6.1725 } };
  expect(header(render({ session: measured }))).toContain("~12.3K tok");
  const recalculating = header(render({ session: { ...measured, contextUsage: { ...measured.contextUsage, tokens: null, percent: null } } }));
  expect(recalculating).toContain("Context …");
  expect(recalculating).not.toContain("~12.3K tok");
  expect(header(render())).toContain("Context —");
});

test("a running conversation defaults to steer rather than waiting for the turn to finish", () => {
  const html = render({ session: { ...session, state: "running", lifecycle: { kind: "working", phase: "thinking", since: 1 } }, prompt: "Adjust the work" });
  expect(html).toContain('aria-label="Change delivery. Current: Steer"');
  expect(html).not.toContain('aria-label="Change delivery. Current: Queued"');
});

test("questions replace messaging, expose only the next answer, and preserve stop", () => {
  const originalWindow = globalThis.window;
  const originalStorage = globalThis.localStorage;
  Object.assign(globalThis, { window: { PiRemotePerson: { get: () => "person" } }, localStorage: { getItem: () => null } });
  try {
    const html = render({ session: { ...session, state: "running", lifecycle: { kind: "working", phase: "thinking", since: 1 } }, prompt: "Unsent message", questions: [
      { id: "q1", threadId: "thread", question: "Which option?", createdAt: 1, suggestions: [{ id: "a", text: "Choice A" }], recommendedSuggestionId: "a" },
      { id: "q2", threadId: "thread", question: "Second question", createdAt: 2, suggestions: [] },
    ] });
    expect(html).not.toContain('id="prompt"');
    expect(html).not.toContain("Unsent message");
    expect(html).toContain('aria-label="Submit answer"');
    expect(html).toContain("Dismiss question");
    expect(html).toContain("Cancel work");
    expect(html).toContain("Recommended");
    expect(html).not.toContain("Second question");
    expect(html).not.toContain('checked=""');
    expect(render({ prompt: "Unsent message" })).toContain("Unsent message");
  } finally { Object.assign(globalThis, { window: originalWindow, localStorage: originalStorage }); }
});

test("question loading leaves the composer layout unchanged instead of flashing a banner", () => {
  const ready = render({ prompt: "Unsent message", questionsResource: { state: "ready", questions: [] } });
  const loading = render({ prompt: "Unsent message", questionsResource: { state: "loading", questions: [] } });
  expect(loading).toBe(ready);
  expect(loading).toContain('id="prompt"');
  expect(loading).toContain("Unsent message");
});

test("question resource failure never marks chat offline and a ready resource clears its own error", () => {
  const failed = render({ questionsResource: { state: "failed", questions: [], error: "Question owner unavailable" } });
  expect(failed).toContain("Could not load questions");
  expect(failed).toContain("Retry questions");
  expect(failed).toContain('id="prompt"');
  expect(header(failed)).toContain('data-status="idle"');
  expect(header(failed)).not.toContain("Offline");
  const ready = render({ questionsResource: { state: "ready", questions: [] } });
  expect(ready).not.toContain("Question owner unavailable");
});

test("disconnect preserves last observed execution state instead of manufacturing idle or completion", () => {
  const working = { ...session, lifecycle: { kind: "working", phase: "thinking", since: 1 } as const };
  const offline = render({ session: working, syncing: true, offline: "Connection lost. Reconnecting…" });
  expect(header(offline)).toContain('data-status="working"');
  expect(header(offline)).toContain('class="status-label">Working</span>');
  expect(header(offline)).toContain("Last known:");
  expect(header(offline)).toContain('data-connection="disconnected"');
  expect(header(offline)).toContain("Connection lost. Reconnecting…");
  expect(header(offline)).toContain("Reconnect");
  expect(header(offline)).not.toContain("Syncing conversation");
  expect(header(offline)).not.toContain('data-status="idle"');
  expect(offline).toContain("Cached conversation text");
});


test("manager chat sides follow sender identity without reordering canonical messages or worker layout", () => {
  const entries = [
    { kind: "user" as const, key: "native-human:0", signature: "human", text: "First instruction" },
    { kind: "assistant" as const, key: "native-agent:0", signature: "agent", text: "Second reply" },
  ];
  const html = render({ session: { ...session, manager: true }, entries });
  expect(html).toContain("manager-conversation");
  expect(html).toContain('class="transcript-message-human"');
  expect(html).toContain('class="transcript-message-agent"');
  expect(html).toContain('data-transcript-source="native-human:0"');
  expect(html).toContain('data-transcript-source="native-agent:0"');
  expect(html.indexOf('data-transcript-source="native-human:0"')).toBeLessThan(html.indexOf('data-transcript-source="native-agent:0"'));
  expect(render({ entries })).not.toContain("manager-conversation");
});

test("manager has one contact header with avatar and state, without automatic context UI", () => {
  const automatic = { ...session, manager: true, contextSelection: { mode: "all" as const, files: ["AGENTS.md", "notes.md"] } };
  for (const contextSelection of [automatic.contextSelection, undefined, { mode: "manual" as const, files: [] }]) {
    const html = render({ session: { ...automatic, contextSelection } });
    expect(html).not.toContain("All context");
    expect(html).not.toContain("AGENTS.md");
    expect(html).not.toContain("Selected automatically");
    expect(header(html)).toContain('class="conversation-avatar"');
    expect(header(html)).toContain('class="status-label">Idle</span>');
    expect(header(html).indexOf('</div>')).toBeLessThan(header(html).indexOf('class="conversation-status"'));
  }
});

test("manager partial text stays outside the timeline while ordinary workers retain streaming", () => {
  for (const liveText of ["<", "<s", "<silent/>", "The token is <silent/>."])  {
    expect(render({ session: { ...session, manager: true }, liveText })).not.toContain('class="live-answer"');
  }
  expect(render({ liveText: "<silent/>" })).toContain('class="live-answer"');
  const html = render({ session: { ...session, manager: true }, entries: [
    { key: "machine", signature: "machine", kind: "user", inputOrigin: "machine", text: "A worker settled" },
    { key: "quiet", signature: "quiet", kind: "assistant", text: "<silent/>" },
  ] });
  expect(html).not.toContain("chat-bubble");
  expect(html).not.toContain("A worker settled");
});

test("canonical manager always has Send, never a stop control, while ordinary worker controls remain unchanged", () => {
  for (const phase of ["thinking", "responding", "waiting_on_tool"] as const) {
    const working: Session = { ...session, manager: true, state: "running", activity: phase, lifecycle: { kind: "working", phase, since: 1 } };
    for (const prompt of ["", "New instruction"]) for (const mono of [undefined, { hintSeen: true, saving: false, onClassic() {}, onHintSeen() {} }]) {
      const html = render({ session: working, prompt, mono });
      expect(html).toContain('aria-label="Send message"');
      expect(html).not.toContain('aria-label="Cancel current work"');
      expect(html).not.toContain('aria-label="Cancel request"');
      expect(html).not.toContain("Change delivery");
      expect(html).toContain('id="prompt"');
    }
    expect(render({ session: { ...working, manager: false } })).toContain('aria-label="Cancel current work"');
  }
});

test("conversation headers use only the mutable topic title, leaving stable agent identity unchanged", () => {
  for (const [name, agentName] of [["Thread titles", "Saihiramei Teheitain"], ["Nebulani reference", "Nozanoshinei Lomekein"]]) {
    const named = { ...session, name, agentName };
    const before = JSON.stringify(named);
    const html = header(render({ session: named }));
    expect(html).toContain(`class="conversation-title-text">${name}</span>`);
    expect(html).not.toContain(agentName.split(" ")[0]!);
    expect(html).not.toContain('class="conversation-subtitle"');
    expect(JSON.stringify(named)).toBe(before);
    const renamed = header(render({ session: { ...named, name: "Changed topic" } }));
    expect(renamed).toContain('class="conversation-title-text">Changed topic</span>');
    expect(renamed).not.toContain(agentName.split(" ")[0]!);
  }
});
