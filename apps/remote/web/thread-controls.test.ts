import { describe, expect, test } from "bun:test";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChildThreadList } from "./src/thread-views";
import { requestStop, StopChoices, submitThreadControl } from "./src/thread-controls";
import { activityColor, working } from "./src/thread-state";
import type { Session } from "./src/types";

const session = (id: string, extra: Partial<Session> = {}): Session => ({
  id, parentId: null, hasChildren: false, origin: "person", model: "astra", name: id, cwd: "/home", workspaceName: "Home", environment: "home", state: "IDLE", activity: "IDLE",
  activeTool: null, provider: "openai", createdAt: "", updatedAt: "", revision: 1, idleUnread: false, lastError: null,
  steeringQueued: 0, followUpQueued: 0, queuedMessages: [], archivedAt: null, ...extra,
});

function buttons(node: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!isValidElement<Record<string, any>>(node)) return [];
  return [...(node.type === "button" ? [node] : []), ...buttons(node.props.children)];
}

describe("thread controls", () => {
  test("keeps active children outside the collapsed inactive section", () => {
    const html = renderToStaticMarkup(createElement(ChildThreadList, { children: [
      session("active-child", { parentId: "parent", state: "RUNNING", activity: "WORKING" }),
      session("idle-child", { parentId: "parent", state: "IDLE" }),
    ], loading: false, error: "", onOpen() {} }));
    expect(html.indexOf("active-child")).toBeLessThan(html.indexOf("<details"));
    expect(html.indexOf("idle-child")).toBeGreaterThan(html.indexOf("<details"));
    expect(html).not.toContain("<details open");
  });
  test("resume exposes an empty-queue error instead of reporting success", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      expect(url).toBe("/v1/sessions/stopped/resume");
      expect(init?.method).toBe("POST");
      return Response.json({ error: "no_pending_messages" }, { status: 409 });
    }) as typeof fetch;
    try {
      await expect(submitThreadControl({ threadId: "stopped", action: "resume" })).rejects.toThrow("no_pending_messages");
    } finally { globalThis.fetch = original; }
  });

  test("stops a childless thread directly and asks for scope when children exist", () => {
    const stopped: unknown[] = [], choices: Session[] = [];
    const stop = (id: string, descendants: boolean) => stopped.push({ id, descendants });
    requestStop(session("leaf"), stop, thread => choices.push(thread));
    const parent = session("parent", { hasChildren: true });
    requestStop(parent, stop, thread => choices.push(thread));
    expect(stopped).toEqual([{ id: "leaf", descendants: false }]);
    expect(choices).toEqual([parent]);
    const controls = buttons(StopChoices({ pending: false, onStop: descendants => stop(parent.id, descendants) }));
    for (const control of controls) control.props.onClick();
    expect(stopped.slice(1)).toEqual([{ id: "parent", descendants: true }, { id: "parent", descendants: false }]);
    expect(buttons(StopChoices({ pending: true, onStop() {} })).every(button => button.props.disabled)).toBe(true);
  });

  test("an idle parent stays idle while its child is working", () => {
    const parent = session("parent", { hasChildren: true, idleUnread: true });
    const child = session("child", { parentId: parent.id, state: "RUNNING", activity: "THINKING" });
    expect(working(parent)).toBe(false);
    expect(working(child)).toBe(true);
    expect(activityColor(parent.activity, parent.idleUnread)).toBe("var(--success)");
    expect(working({ ...child, state: "STOPPED" })).toBe(false);
  });

  test("stop requests always carry scope", async () => {
    const original = globalThis.fetch;
    const requests: unknown[] = [];
    globalThis.fetch = (async (url, init) => {
      requests.push({ url, method: init?.method, body: JSON.parse(String(init?.body)) });
      return Response.json({ ok: true });
    }) as typeof fetch;
    try {
      await submitThreadControl({ threadId: "parent/1", action: "stop", descendants: true });
      await submitThreadControl({ threadId: "child", action: "stop", descendants: false });
      expect(requests).toEqual([
        { url: "/v1/sessions/parent%2F1/abort", method: "POST", body: { descendants: true } },
        { url: "/v1/sessions/child/abort", method: "POST", body: { descendants: false } },
      ]);
    } finally { globalThis.fetch = original; }
  });
});
