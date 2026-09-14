import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiCoreSession } from "../src/cores/pi.js";
import type { CoreCommand, CoreOutput, CoreSessionOptions } from "../src/cores/contracts.js";
import type { OpenPiNative, PiNative, PiNode, PiSnapshot } from "../src/cores/pi-types.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

class NativeFixture implements PiNative {
  readonly commands: CoreCommand[] = [];
  readonly state: PiSnapshot;

  constructor(readonly node: PiNode, private readonly output: (event: CoreOutput) => void) {
    this.state = {
      nativeSessionId: `native-${node.id}`,
      sessionFile: node.sessionFile,
      cwd: node.cwd,
      model: node.model,
      provider: node.provider,
      messages: [],
      entries: [],
    };
  }

  snapshot(): PiSnapshot { return this.state; }

  async command(command: CoreCommand): Promise<void> {
    this.commands.push(command);
    this.output({ type: "response", id: command.id, command: command.type, success: true });
  }

  async inject(customType: string, data: Record<string, unknown>): Promise<void> {
    this.state.entries.push({ type: "custom_message", customType, details: data });
    this.output({ type: "message_end", message: { role: "custom", customType, details: data } });
  }

  async close(): Promise<void> {}
}

function options(cwd: string, stateDir: string, env: CoreSessionOptions["env"]): CoreSessionOptions {
  return {
    cwd,
    stateDir,
    env,
    sessionId: "root",
    args: ["--provider", "fixture", "--model", "root", "--thinking", "low"],
  };
}

function configured(root: string): CoreSessionOptions["env"] {
  return {
    PI_REMOTE_WORKSPACES: JSON.stringify([
      { id: "sibyl", name: "Sibyl", path: root },
    ]),
  };
}

function nativeRecorder(opened: string[], fixtures = new Map<string, NativeFixture>()): OpenPiNative {
  return async (_options, node, _tools, output) => {
    opened.push(node.id);
    const fixture = new NativeFixture(node, output);
    fixtures.set(node.id, fixture);
    return fixture;
  };
}

async function openCore(sessionOptions: CoreSessionOptions, opened: string[] = [], fixtures = new Map<string, NativeFixture>()) {
  const output: CoreOutput[] = [];
  const core = await Promise.resolve()
    .then(() => new PiCoreSession(sessionOptions, event => output.push(event), () => {}, nativeRecorder(opened, fixtures)))
    .then(session => session.open());
  cleanups.push(() => core.close());
  return { core, output, opened, fixtures };
}

async function openingFailure(sessionOptions: CoreSessionOptions, opened: string[]) {
  return Promise.resolve()
    .then(() => new PiCoreSession(sessionOptions, () => {}, () => {}, nativeRecorder(opened)))
    .then(session => session.open());
}

function tree(root: PiNode, children: PiNode[] = [], requests: Array<[string, string]> = []): string {
  return JSON.stringify({
    version: 1,
    rootId: root.id,
    nodes: [root, ...children],
    requests,
    dispatches: [],
  });
}

function persistedNode(id: string, cwd: string, stateDir: string, parentId: string | null = null): PiNode {
  return {
    id,
    parentId,
    name: id === "root" ? "Pi" : `Pi child ${id}`,
    cwd,
    sessionFile: join(stateDir, id === "root" ? "root.jsonl" : "children", `${id}.jsonl`),
    state: "idle",
    busy: false,
    provider: "fixture",
    model: "root",
    thinkingLevel: "low",
  };
}

function temporaryLayout() {
  const base = mkdtempSync(join(tmpdir(), "pi-cwd-admission-"));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const allowed = join(base, "allowed");
  const project = join(allowed, "project");
  const outside = join(base, "outside");
  const stateDir = join(base, "state");
  mkdirSync(project, { recursive: true });
  mkdirSync(outside);
  mkdirSync(stateDir);
  return { base, allowed, project, outside, stateDir };
}

async function usefulFailure(promise: Promise<unknown>, input: string): Promise<void> {
  await expect(promise).rejects.toThrow();
  try {
    await promise;
  } catch (error) {
    expect(String(error)).toContain(input);
  }
}

describe("Pi native cwd admission", () => {
  it("rejects configured relative, outside, and symlink-escaping root cwd values", async () => {
    const { allowed, outside, stateDir } = temporaryLayout();
    const escape = join(allowed, "escape");
    symlinkSync(outside, escape);

    for (const [index, cwd] of ["sibyl", outside, escape].entries()) {
      const opened: string[] = [];
      const attempt = openingFailure(options(cwd, join(stateDir, String(index)), configured(allowed)), opened);
      await usefulFailure(attempt, cwd === escape ? outside : cwd);
      expect(opened).toEqual([]);
      expect(existsSync(join(stateDir, String(index), "pi-tree.json"))).toBe(false);
    }
  });

  it("rejects malformed configured-workspace JSON before opening or saving", async () => {
    const { project, stateDir } = temporaryLayout();
    const opened: string[] = [];
    const attempt = openingFailure(options(project, stateDir, { PI_REMOTE_WORKSPACES: "not-json" }), opened);
    await expect(attempt).rejects.toThrow(/PI_REMOTE_WORKSPACES|workspace/i);
    expect(opened).toEqual([]);
    expect(existsSync(join(stateDir, "pi-tree.json"))).toBe(false);
  });

  it("allows any existing absolute directory without workspace configuration but still rejects relative cwd", async () => {
    const { outside, stateDir } = temporaryLayout();
    const opened: string[] = [];
    const { core } = await openCore(options(outside, stateDir, {}), opened);
    expect(opened).toEqual(["root"]);
    await core.close();

    const relativeState = join(stateDir, "relative");
    mkdirSync(relativeState);
    const relativeOpened: string[] = [];
    await usefulFailure(openingFailure(options("sibyl", relativeState, {}), relativeOpened), "sibyl");
    expect(relativeOpened).toEqual([]);
  });

  it("validates every restored node, including idle children, before any engine opens or state is saved", async () => {
    const { allowed, project, outside, stateDir } = temporaryLayout();
    const root = persistedNode("root", project, stateDir);
    const validChild = persistedNode("valid-child", allowed, stateDir, "root");
    const invalidIdleChild = persistedNode("idle-child", outside, stateDir, "root");
    const saved = tree(root, [validChild, invalidIdleChild]);
    const statePath = join(stateDir, "pi-tree.json");
    writeFileSync(statePath, saved);
    const opened: string[] = [];

    await usefulFailure(openingFailure(options(project, stateDir, configured(allowed)), opened), outside);

    expect(opened).toEqual([]);
    expect(readFileSync(statePath, "utf8")).toBe(saved);
  });

  it("admits existing absolute cwd values and resumes a restored idle child", async () => {
    const { allowed, project, stateDir } = temporaryLayout();
    const childCwd = join(allowed, "child");
    mkdirSync(childCwd);
    const root = persistedNode("root", project, stateDir);
    const child = persistedNode("child", childCwd, stateDir, "root");
    child.work = { id: "finished", task: "previous", status: "complete", result: "done", delivered: true };
    writeFileSync(join(stateDir, "pi-tree.json"), tree(root, [child]));
    const opened: string[] = [];
    const fixtures = new Map<string, NativeFixture>();
    const { core } = await openCore(options(project, stateDir, configured(allowed)), opened, fixtures);

    expect(opened).toEqual(["root"]);
    await expect(core.delegate("root", "continued", { threadId: "child", task: "continue", cwd: childCwd }))
      .resolves.toMatchObject({ agent: { id: "child" }, reused: true });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(opened).toEqual(["root", "child"]);
    expect(fixtures.get("child")?.commands).toContainEqual({ type: "prompt", id: "continued", message: "continue" });
  });

  it("validates new, duplicate, and reused delegation paths without changing the tree", async () => {
    const { allowed, project, outside, stateDir } = temporaryLayout();
    const escape = join(allowed, "escape");
    symlinkSync(outside, escape);
    const root = persistedNode("root", project, stateDir);
    const child = persistedNode("child", project, stateDir, "root");
    child.work = { id: "old", task: "done", status: "complete", result: "done", delivered: true };
    writeFileSync(join(stateDir, "pi-tree.json"), tree(root, [child], [["root:duplicate", "child"]]));
    const opened: string[] = [];
    const { core } = await openCore(options(project, stateDir, configured(allowed)), opened);
    await new Promise<void>(resolve => setImmediate(resolve));
    const statePath = join(stateDir, "pi-tree.json");
    const unchanged = readFileSync(statePath, "utf8");

    const rejected = [
      core.delegate("root", "new-relative", { task: "new", cwd: "sibyl" }),
      core.delegate("root", "new-outside", { task: "new", cwd: outside }),
      core.delegate("root", "new-escape", { task: "new", cwd: escape }),
      core.delegate("root", "duplicate", { task: "ignored duplicate", cwd: outside }),
      core.delegate("root", "reuse", { threadId: "child", task: "reuse", workspace: { repo: "repo", root: outside } }),
    ];

    for (const attempt of rejected) await expect(attempt).rejects.toThrow();
    expect(core.list().map(agent => agent.id)).toEqual(["root", "child"]);
    expect(opened).toEqual(["root"]);
    expect(readFileSync(statePath, "utf8")).toBe(unchanged);
  });
});
