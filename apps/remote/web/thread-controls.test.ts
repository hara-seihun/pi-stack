import { describe, expect, test } from "bun:test";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChildThreadList } from "./src/thread-views";
import { requestStop, StopChoices, submitThreadControl } from "./src/thread-controls";
import { activityColor, conversationThreads, orchestratorThreads, working } from "./src/thread-state";
import type { Session } from "./src/types";

const session = (id: string, extra: Partial<Session> = {}): Session => ({
  id, parentId: null, hasChildren: false, origin: "person", model: "astra", name: id, cwd: "/home", workspaceName: "Home", environment: "home", state: "idle", activity: "idle",
  activeTool: null, provider: "openai", createdAt: "", updatedAt: "", revision: 1, idleUnread: false, lastError: null,
  steeringQueued: 0, followUpQueued: 0, queuedMessages: [], archivedAt: null, ...extra,
});

function buttons(node: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!isValidElement<Record<string, any>>(node)) return [];
  return [...(node.type === "button" ? [node] : []), ...buttons(node.props.children)];
}

async function withThreadClient(fetcher: typeof fetch, run: () => Promise<void>) {
  const names = ["window", "fetch"] as const;
  const descriptors = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  try {
    Object.defineProperties(globalThis, {
      window: { configurable: true, writable: true, value: { PiRemotePerson: { session: () => "thread-control-session" } } },
      fetch: { configurable: true, writable: true, value: fetcher },
    });
    await run();
  } finally {
    for (const name of names) {
      const descriptor = descriptors.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}

describe("thread controls", () => {
  test("main conversations and Orchestrator workers have disjoint drawer membership", () => {
    const rows = [session("root"), session("existing-worker", { parentId: "root" }), session("fleet-worker", { parentId: "root", origin: "fleet" }), session("lane", { origin: "fleet" })];
    expect(conversationThreads(rows).map(row => row.id)).toEqual(["root"]);
    expect(orchestratorThreads(rows).map(row => row.id)).toEqual(["existing-worker", "fleet-worker", "lane"]);
  });
  test("keeps active children outside the collapsed inactive section", () => {
    const html = renderToStaticMarkup(createElement(ChildThreadList, { children: [
      session("active-child", { parentId: "parent", state: "running", activity: "running" }),
      session("idle-child", { parentId: "parent", state: "idle" }),
    ], loading: false, error: "", onOpen() {} }));
    expect(html.indexOf("active-child")).toBeLessThan(html.indexOf("<details"));
    expect(html.indexOf("idle-child")).toBeGreaterThan(html.indexOf("<details"));
    expect(html).not.toContain("<details open");
  });
  test("resume exposes an empty-queue error instead of reporting success", async () => {
    await withThreadClient((async (url, init) => {
      expect(url).toBe("/v1/sessions/stopped/resume");
      expect(init?.method).toBe("POST");
      return Response.json({ error: "no_pending_messages" }, { status: 409 });
    }) as typeof fetch, async () => {
      await expect(submitThreadControl({ threadId: "stopped", action: "resume" })).rejects.toThrow("no_pending_messages");
    });
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
    const child = session("child", { parentId: parent.id, state: "running", activity: "thinking" });
    expect(working(parent)).toBe(false);
    expect(working(child)).toBe(true);
    expect(activityColor(parent.activity, parent.idleUnread)).toBe("var(--success)");
    expect(working({ ...child, state: "stopped" })).toBe(false);
  });

  test("stop requests always carry scope", async () => {
    const requests: unknown[] = [];
    await withThreadClient((async (url, init) => {
      requests.push({ url, method: init?.method, body: JSON.parse(String(init?.body)) });
      return Response.json({ ok: true });
    }) as typeof fetch, async () => {
      await submitThreadControl({ threadId: "parent/1", action: "stop", descendants: true });
      await submitThreadControl({ threadId: "child", action: "stop", descendants: false });
      expect(requests).toEqual([
        { url: "/v1/sessions/parent%2F1/abort", method: "POST", body: { descendants: true } },
        { url: "/v1/sessions/child/abort", method: "POST", body: { descendants: false } },
      ]);
    });
  });
});
