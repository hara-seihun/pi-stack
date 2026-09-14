import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { catalogModel } from "../catalog.js";
import type { CwdAdmission } from "../workspace-admission.js";
import { piCwdAdmission, requirePiCwd } from "./pi-cwd.js";
import { argument, type CoreAgent, type CoreCommand, type CoreOutput, type CoreSession,
  type CoreSessionOptions, type OpenCoreSession } from "./contracts.js";
import { openPiNative } from "./pi-native.js";
import { PiTreeStore } from "./pi-store.js";
import { assertPiSessionFile } from "./pi-session-file.js";
import { heartbeatPiWorkspace, planPiWorkspace, preparePiWorkspace } from "./pi-workspace.js";
import type { OpenPiNative, PiDelegate, PiNative, PiNode, PiToolsHost } from "./pi-types.js";

const textError = (error: unknown) => error instanceof Error ? error.message : String(error);
const publicAgent = (node: PiNode): CoreAgent => ({ id: node.id, parentId: node.parentId, name: node.name,
  state: node.state, model: node.model, nativeSessionId: node.nativeSessionId });

export class PiCoreSession implements CoreSession, PiToolsHost {
  private readonly store: PiTreeStore;
  private readonly admission: CwdAdmission;
  private readonly native = new Map<string, PiNative>();
  private readonly opening = new Map<string, Promise<PiNative>>();
  private readonly settling = new Map<string, CoreOutput>();
  private readonly injecting = new Set<string>();
  private readonly injectingRuns = new Set<string>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly stopping = new Set<string>();
  private readonly failing = new Set<string>();
  private readonly replies = new Map<string, { event?: CoreOutput }>();
  private readonly dispatchRequests = new Map<string, string>();
  private exitCode = 0;
  private closed = false;
  private started = false;
  private closePromise?: Promise<void>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private tickQueued = false;

  constructor(private readonly options: CoreSessionOptions, private readonly output: (event: CoreOutput) => void,
    private readonly exit: (code?: number) => void, private readonly openNative: OpenPiNative = openPiNative) {
    this.admission = piCwdAdmission(options.env.PI_REMOTE_WORKSPACES);
    this.options = { ...options, cwd: requirePiCwd(this.admission, options.cwd, "options.cwd") };
    this.store = new PiTreeStore(options.stateDir, options.sessionId);
  }

  private validateNode(node: PiNode): void {
    requirePiCwd(this.admission, node.cwd, `nodes[${node.id}].cwd`);
    planPiWorkspace(node, this.admission);
    if (existsSync(node.sessionFile)) {
      requirePiCwd(this.admission, assertPiSessionFile(node.sessionFile).cwd, `${node.sessionFile} header.cwd`);
    }
  }

  async open(): Promise<this> {
    // Validate the entire restored tree before any engine opens or saved state changes.
    for (const node of this.store.nodes.values()) this.validateNode(node);
    let root = this.store.nodes.get(this.options.sessionId);
    const transferHash = this.options.transfer ? createHash("sha256").update(JSON.stringify(this.options.transfer)).digest("hex") : undefined;
    if (transferHash && root && transferHash !== this.store.transferHash) throw new Error("A different portable transfer requires a new Pi state directory");
    if (!root) this.store.transferHash = transferHash;
    if (!root) {
      root = { id: this.options.sessionId, parentId: null, name: argument(this.options.args, "--name") ?? "Pi",
        cwd: this.options.cwd, sessionFile: this.options.transfer ? join(this.options.stateDir, "root.jsonl")
          : argument(this.options.args, "--session") ?? join(this.options.stateDir, "root.jsonl"),
        state: "idle", busy: false, provider: argument(this.options.args, "--provider"),
        model: argument(this.options.args, "--model"), thinkingLevel: argument(this.options.args, "--thinking") };
      this.validateNode(root);
      this.store.nodes.set(root.id, root);
      this.store.save();
    }
    root.provider = argument(this.options.args, "--provider") ?? root.provider;
    root.model = argument(this.options.args, "--model") ?? root.model;
    root.thinkingLevel = argument(this.options.args, "--thinking") ?? root.thinkingLevel;
    root.name = argument(this.options.args, "--name") ?? root.name;
    this.started = true;
    await this.ensure(root.id);
    for (const node of this.store.nodes.values()) {
      this.observe(node);
      if (node.work?.status === "running" || node.busy) {
        const engine = await this.ensure(node.id);
        node.busy = false;
        const pendingChildren = this.children(node.id).some(child => child.work?.status === "running" || child.work && !child.work.delivered);
        if (!pendingChildren) this.inject(node, engine, "core_recovery", { agentId: node.id,
          workId: node.work?.id, task: node.work?.task, status: "interrupted" });
        else this.settling.set(node.id, { type: "agent_settled" });
      }
    }
    for (const receipt of this.store.dispatches.values()) if (receipt.state === "pending") receipt.state = "accepted";
    this.store.save();
    this.heartbeat = setInterval(() => {
      for (const node of this.store.nodes.values()) if ((node.busy || node.work?.status === "running") && node.workspace) {
        this.track(heartbeatPiWorkspace(node, this.admission), node);
      }
    }, 60_000);
    this.heartbeat.unref();
    this.schedule();
    return this;
  }

  private node(id: string): PiNode {
    const node = this.store.nodes.get(id);
    if (!node) throw new Error(`Unknown Pi agent: ${id}`);
    return node;
  }
  private children(id: string): PiNode[] { return [...this.store.nodes.values()].filter(node => node.parentId === id); }
  private observe(node: PiNode): void {
    this.output({ type: "core_agent", core: "pi", rootId: this.options.sessionId, agent: publicAgent(node),
      nativeSessionFile: node.sessionFile, cwd: node.cwd, workId: node.work?.id });
  }
  private refresh(node: PiNode): void {
    const snapshot = this.native.get(node.id)?.snapshot();
    if (snapshot) Object.assign(node, { name: snapshot.name ?? node.name, nativeSessionId: snapshot.nativeSessionId, sessionFile: snapshot.sessionFile,
      cwd: requirePiCwd(this.admission, snapshot.cwd, `nodes[${node.id}].runtime.cwd`),
      model: snapshot.model, provider: snapshot.provider, thinkingLevel: snapshot.thinkingLevel });
  }
  private async ensure(id: string): Promise<PiNative> {
    const node = this.node(id);
    this.validateNode(node);
    const existing = this.native.get(id);
    if (existing) return existing;
    const pending = this.opening.get(id);
    if (pending) return pending;
    const operation = (async () => {
      await preparePiWorkspace(node, this.admission);
      this.store.save();
      const engine = await this.openNative(this.options, node, this, event => this.event(node, event), code => {
        if (this.closed || this.stopping.has(id)) return;
        this.native.delete(id);
        if (node.parentId) this.fail(node, new Error(`Native Pi session exited (${code ?? 0})`));
        else {
          this.exitCode = code ?? 0;
          void this.close().catch(error => this.output({ type: "core_error", error: textError(error) }));
        }
      }, this.admission);
      try { requirePiCwd(this.admission, engine.snapshot().cwd, `nodes[${node.id}].runtime.cwd`); }
      catch (error) { await engine.close(); throw error; }
      this.native.set(id, engine);
      this.refresh(node);
      this.store.save();
      this.observe(node);
      return engine;
    })();
    this.opening.set(id, operation);
    try { return await operation; } finally { this.opening.delete(id); }
  }

  private activity(id: string, state: Record<string, unknown> = {}) {
    const node = this.node(id);
    const local = this.native.get(id)?.snapshot();
    const descendants = this.subtree(id).slice(1);
    const snapshots = descendants.map(child => this.native.get(child.id)?.snapshot());
    const pendingChildren = descendants.filter(child => child.busy || child.work && !child.work.delivered).length;
    const nativeIsStreaming = Boolean(state.isStreaming ?? local?.isStreaming ?? node.busy);
    const isStreaming = nativeIsStreaming || node.busy || pendingChildren > 0;
    const isCompacting = Boolean(state.isCompacting ?? local?.isCompacting) || snapshots.some(snapshot => snapshot?.isCompacting);
    const pendingMessageCount = Number(state.pendingMessageCount ?? local?.pendingMessageCount ?? 0)
      + snapshots.reduce((count, snapshot) => count + (snapshot?.pendingMessageCount ?? 0), 0) + pendingChildren;
    const internalBusy = [node, ...descendants].some(agent => this.opening.has(agent.id)
      || this.injectingRuns.has(agent.id) || this.failing.has(agent.id) || this.settling.has(agent.id) || this.stopping.has(agent.id));
    const coreBusy = isStreaming || isCompacting || pendingMessageCount > 0 || internalBusy;
    return { nativeIsStreaming, isStreaming, isCompacting, pendingMessageCount, coreBusy, treeComplete: !coreBusy };
  }

  private event(node: PiNode, event: CoreOutput): void {
    if (event.type === "response" && typeof event.id === "string") {
      const reply = this.replies.get(event.id);
      if (reply) reply.event = event;
      const workId = this.dispatchRequests.get(event.id);
      const receipt = workId && this.store.dispatches.get(workId);
      if (receipt) {
        receipt.state = event.success === false ? "rejected" : "accepted";
        if (event.success === false) {
          receipt.error = String(event.error ?? "Pi rejected the dispatch");
          if (node.work?.id === workId) { node.work.status = "complete"; node.work.result = receipt.error; }
          node.busy = Boolean(this.native.get(node.id)?.snapshot().isStreaming);
          if (!node.busy) node.state = "failed";
        }
        this.store.save();
      }
    }
    if (event.type === "core_native_session") {
      node.busy = false; node.state = "idle";
      if (node.work?.status === "running") {
        node.work.status = "complete"; node.work.result = "Native session replaced"; node.state = "cancelled";
      }
      this.settling.set(node.id, { type: "agent_settled" });
      this.refresh(node); this.store.save(); this.observe(node); this.schedule(); return;
    }
    if (event.type === "response" && event.command === "get_state" && event.success) {
      const snapshot = this.native.get(node.id)?.snapshot();
      const lastAssistantMessage = snapshot && [...snapshot.messages].reverse().find(message => message.role === "assistant");
      event = { ...event, data: { ...(event.data as object), core: "pi", coreAgents: this.list(),
        nativeSessionId: snapshot?.nativeSessionId ?? node.nativeSessionId,
        messageCount: snapshot?.messages.length ?? 0, lastAssistantMessage, context: snapshot?.context, terminalError: node.error,
        ...this.activity(node.id, event.data as Record<string, unknown>) } };
    }
    if (node.parentId) this.output({ type: "core_child_event", core: "pi", rootId: this.options.sessionId,
      agentId: node.id, parentId: node.parentId, event });
    else if (event.type !== "agent_settled") this.output(event);
    if (event.type === "agent_start") {
      node.busy = true; node.state = "running"; node.error = undefined; this.settling.delete(node.id);
    } else if (event.type === "agent_settled") {
      node.busy = false;
      this.settling.set(node.id, event);
      this.refresh(node);
    } else if (event.type === "response" && event.success === false && event.id === node.work?.id) {
      this.fail(node, new Error(String(event.error)));
      return;
    }
    if (event.type === "message_end") {
      const message = event.message as Record<string, unknown> | undefined;
      const details = message?.details as Record<string, unknown> | undefined;
      if (message?.customType === "core_child_result" && details?.workId) {
        const child = this.children(node.id).find(child => child.work?.id === details.workId);
        if (child?.work) child.work.delivered = true;
      }
    }
    if (event.type === "queue_update") this.schedule();
    if (["agent_start", "agent_settled", "message_end"].includes(event.type)) {
      this.store.save(); this.observe(node); this.schedule();
    }
  }

  private track(task: Promise<void>, node: PiNode): void {
    const owned = task.catch(error => this.fail(node, error)).finally(() => {
      this.tasks.delete(owned); this.schedule();
    });
    this.tasks.add(owned);
  }
  private inject(node: PiNode, engine: PiNative, kind: string, data: Record<string, unknown>): void {
    node.busy = true; node.state = "running";
    this.settling.delete(node.id);
    this.store.save(); this.observe(node);
    this.injectingRuns.add(node.id);
    this.track(engine.inject(kind, data).finally(() => this.injectingRuns.delete(node.id)), node);
  }
  private fail(node: PiNode, error: unknown): void {
    if (this.closed || this.failing.has(node.id)) return;
    this.failing.add(node.id);
    node.busy = true;
    const finish = (failure: string) => {
      for (const child of this.children(node.id)) if (child.work) child.work.delivered = true;
      node.busy = false; node.state = "failed"; node.error = failure;
      if (node.work) { node.work.status = "complete"; node.work.result = failure; }
      const event = { type: "core_error", error: failure };
      this.output(node.parentId ? { type: "core_child_event", core: "pi", rootId: this.options.sessionId,
        agentId: node.id, parentId: node.parentId, event } : event);
      this.settling.set(node.id, { type: "agent_settled" });
      this.failing.delete(node.id);
      this.store.save(); this.observe(node); this.schedule();
    };
    const children = this.children(node.id);
    if (!children.length) { finish(textError(error)); return; }
    const cleanup = Promise.all(children.map(child => this.abortTree(child.id)))
      .then(() => finish(textError(error)), cleanupError => finish(`${textError(error)}; subtree abort: ${textError(cleanupError)}`))
      .finally(() => this.tasks.delete(cleanup));
    this.tasks.add(cleanup);
  }
  private schedule(): void {
    if (this.closed || this.tickQueued) return;
    this.tickQueued = true;
    queueMicrotask(() => { this.tickQueued = false; this.reconcile(); });
  }
  private reconcile(): void {
    if (this.closed) return;
    for (const node of this.store.nodes.values()) {
      if (node.busy || this.stopping.has(node.id) || this.failing.has(node.id) || this.injectingRuns.has(node.id)) continue;
      const local = this.native.get(node.id)?.snapshot();
      if (local?.isStreaming || local?.isCompacting) continue;
      const children = this.children(node.id);
      const ready = node.state === "failed" ? undefined : children.find(child => child.work?.status === "complete" && !child.work.delivered && !this.injecting.has(child.work.id));
      if (ready?.work) {
        const work = ready.work;
        this.injecting.add(work.id);
        this.track((async () => {
          const engine = await this.ensure(node.id);
          if (this.closed || this.stopping.has(node.id)) return;
          const received = engine.snapshot().entries.some(entry => entry.customType === "core_child_result"
            && (entry.details as { workId?: string } | undefined)?.workId === work.id);
          if (received) {
            work.delivered = true;
            this.store.save();
            this.inject(node, engine, "core_recovery", { workId: work.id, status: "result_received" });
          } else this.inject(node, engine, "core_child_result", { agentId: ready.id, workId: work.id,
            state: ready.state, result: work.result ?? "", nativeSessionId: ready.nativeSessionId, sessionFile: ready.sessionFile });
        })().finally(() => this.injecting.delete(work.id)), node);
        continue;
      }
      if (children.some(child => child.work?.status === "running" || child.work && !child.work.delivered)) continue;
      if (local?.pendingMessageCount) continue;
      const settled = this.settling.get(node.id);
      if (!settled) continue;
      this.settling.delete(node.id);
      if (node.state === "running") node.state = "idle";
      if (node.work?.status === "running") {
        const messages = this.native.get(node.id)?.snapshot().messages ?? [];
        const assistant = [...messages].reverse().find(message => message.role === "assistant");
        if (assistant?.stopReason === "error") node.state = "failed";
        if (assistant?.stopReason === "aborted") node.state = "cancelled";
        const content = assistant?.content;
        node.work.result = assistant?.errorMessage ? String(assistant.errorMessage) : typeof content === "string" ? content
          : Array.isArray(content) ? content.filter(part => part.type === "text").map(part => part.text).join("\n") : "";
        node.work.status = "complete";
      }
      this.store.save(); this.observe(node);
      if (!node.parentId) this.output(settled);
      this.schedule();
    }
  }

  list(parentId?: string): CoreAgent[] {
    return [...this.store.nodes.values()].filter(node => parentId === undefined || node.parentId === parentId).map(publicAgent);
  }
  async read(id: string, offset = 0, limit = 20): Promise<unknown> {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid Pi read page");
    const engine = await this.ensure(id);
    const entries = engine.snapshot().entries.filter(entry => entry.type === "message" || entry.type === "custom_message");
    const page = entries.slice(offset, offset + limit);
    return { agent: publicAgent(this.node(id)), entries: page, nextOffset: offset + page.length < entries.length ? offset + page.length : undefined };
  }

  async delegate(parentId: string, requestId: string, request: PiDelegate): Promise<unknown> {
    if (this.closed || this.stopping.has(parentId)) throw new Error("Pi tree is stopping");
    const parent = this.node(parentId);
    this.validateNode(parent);
    const requestedCwd = request.cwd === undefined ? undefined
      : requirePiCwd(this.admission, request.cwd, "delegation.cwd");
    if (request.workspace) planPiWorkspace({ ...parent, workspace: request.workspace }, this.admission);
    const key = `${parentId}:${requestId}`;
    const previous = this.store.requests.get(key);
    if (previous) {
      this.validateNode(this.node(previous));
      return { agent: publicAgent(this.node(previous)), workId: requestId, reused: true };
    }
    if (!request.task.trim()) throw new Error("A child task is required");
    let child = request.threadId ? this.node(request.threadId) : !request.newThread
      ? this.children(parentId).find(node => !node.busy && node.work?.delivered && !request.workspace && !request.cwd
        && (!request.model || node.model === (catalogModel(request.model)?.model ?? request.model.split("/").slice(1).join("/")))) : undefined;
    const reused = !!child;
    if (child) this.validateNode(child);
    if (child && child.parentId !== parentId) throw new Error("Only a direct child can be continued");
    if (child && (child.busy || child.work && !child.work.delivered)) throw new Error("Child still owns unfinished work");
    if (!child) {
      const model = catalogModel(request.model ?? "astra");
      const [provider, ...modelParts] = (request.model ?? "").split("/");
      if (!model && (!provider || !modelParts.length)) throw new Error(`Unknown child model: ${request.model}`);
      const hash = createHash("sha256").update(key).digest("hex");
      const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
      child = { id, parentId, name: `Pi child ${id.slice(0, 8)}`, cwd: requestedCwd ?? parent.cwd,
        sessionFile: join(this.options.stateDir, "children", `${id}.jsonl`), state: "running", busy: true,
        provider: model?.provider ?? provider, model: model?.model ?? modelParts.join("/"),
        thinkingLevel: request.thinkingLevel ?? "high", workspace: request.workspace };
      this.validateNode(child);
      this.store.nodes.set(id, child);
    }
    child.work = { id: requestId, task: request.task, status: "running" };
    child.busy = true; child.state = "running";
    this.store.requests.set(key, child.id); this.store.save(); this.observe(child);
    const target = child;
    this.track((async () => {
      if (this.native.has(target.id)) await preparePiWorkspace(target, this.admission);
      const engine = await this.ensure(target.id);
      if (this.closed || this.stopping.has(target.id)) return;
      await engine.command({ type: "prompt", id: requestId, message: request.task });
    })(), target);
    return { agent: publicAgent(child), workId: requestId, reused };
  }

  private subtree(id: string): PiNode[] {
    return [this.node(id), ...this.children(id).flatMap(child => this.subtree(child.id))];
  }
  private async abortTree(id: string): Promise<void> {
    const nodes = this.subtree(id);
    for (const node of nodes) this.stopping.add(node.id);
    try {
      await Promise.all(nodes.map(async node => {
        const engine = this.native.get(node.id) ?? await this.opening.get(node.id);
        if (engine) {
          await engine.command({ type: "clear_queue" });
          await engine.command({ type: "abort" });
        }
        node.busy = false; node.state = "cancelled";
        if (node.work) { node.work.status = "complete"; node.work.result = "Aborted"; node.work.delivered = node.id !== id; }
        this.settling.delete(node.id); this.observe(node);
      }));
      this.store.save();
    } finally { for (const node of nodes) this.stopping.delete(node.id); }
    this.schedule();
  }
  async beforeReplace(id: string): Promise<void> {
    this.stopping.add(id);
    try {
      await Promise.all(this.children(id).map(child => this.abortTree(child.id)));
      for (const child of this.children(id)) if (child.work) child.work.delivered = true;
      this.store.save();
    } finally { this.stopping.delete(id); }
  }
  async control(id: string, command: CoreCommand, callerId?: string): Promise<void> {
    if (this.closed) throw new Error("Pi core is closed");
    if (callerId && (id === callerId || !this.subtree(callerId).some(node => node.id === id))) {
      throw new Error("An agent can control only its descendants; PiStack can control the whole tree");
    }
    if (command.type === "abort") { await this.abortTree(id); return; }
    const node = this.node(id);
    if (["steer","follow_up"].includes(command.type) && !this.activity(id).coreBusy) command = {...command,type:"prompt"};
    if (node.parentId && command.type === "prompt") {
      await this.delegate(node.parentId, command.id ?? randomUUID(), { threadId: id, task: String(command.message ?? "") });
      return;
    }
    const engine = await this.ensure(id);
    const requestId = randomUUID();
    const reply: { event?: CoreOutput } = {};
    this.replies.set(requestId, reply);
    try {
      await engine.command({ ...command, id: requestId });
      if (reply.event?.success === false) throw new Error(String(reply.event.error));
      if (!reply.event && command.type !== "extension_ui_response") throw new Error(`Pi command did not acknowledge: ${command.type}`);
      this.refresh(node); this.store.save();
    } finally { this.replies.delete(requestId); }
  }
  async command(command: CoreCommand): Promise<void> {
    const respond = (data?: unknown, error?: string) => this.output({ type: "response", id: command.id,
      command: command.type, success: error === undefined, ...(error ? { error } : { data }) });
    try {
      switch (command.type) {
        case "core_agents": respond({ agents: this.list(command.parentId as string | undefined) }); return;
        case "core_agent_read": {
          const id = String(command.agentId);
          const engine = await this.ensure(id);
          const { messages, entries, ...nativeState } = engine.snapshot();
          respond({ agent: publicAgent(this.node(id)), messages, entries,
            state: { ...nativeState, activity: this.node(id).state, ...this.activity(id) } }); return;
        }
        case "core_agent_command": {
          const { agentId, action, id: _id, type: _type, ...parameters } = command;
          await this.control(String(agentId), { ...parameters, type: String(action) }); respond(); return;
        }
        case "abort": await this.abortTree(this.options.sessionId); respond(); this.output({ type: "agent_settled" }); return;
        case "close": await this.close(); return;
        default: {
          if (this.closed) throw new Error("Pi core is closed");
          const node = this.node(this.options.sessionId);
          const engine = await this.ensure(node.id);
          const workId = typeof command.workId === "string" && ["prompt","steer","follow_up"].includes(command.type) ? command.workId : undefined;
          if (workId) {
            const hash = createHash("sha256").update(JSON.stringify({type:command.type,message:command.message,images:command.images ?? []})).digest("hex");
            const previous = this.store.dispatches.get(workId);
            if (previous) {
              if (previous.hash !== hash) throw new Error("Pi dispatch ID was reused with different content");
              if (previous.state === "rejected") throw new Error(previous.error);
              respond({accepted:true,reconciled:true}); return;
            }
            this.store.dispatches.set(workId,{hash,state:"pending"});
            node.work = {id:workId,task:String(command.message ?? ""),status:"running"};
            node.busy = true; node.state = "running";
            this.store.save(); this.observe(node);
            if (command.resume === true) {
              this.store.dispatches.get(workId)!.state = "accepted";
              const last = engine.snapshot().messages.at(-1);
              if (last?.role === "assistant" && last.stopReason === "stop") {
                node.work.status = "complete"; node.busy = false; node.state = "idle";
                this.store.save(); this.observe(node);
              } else this.inject(node,engine,"core_recovery",{agentId:node.id,workId,task:node.work.task,status:"interrupted"});
              respond({accepted:true,reconciled:true}); return;
            }
          }
          const id = command.id ?? randomUUID();
          if (workId) this.dispatchRequests.set(id,workId);
          try { await engine.command({...command,id}); }
          catch (error) { if (workId) this.fail(node,error); throw error; }
          finally { this.dispatchRequests.delete(id); }
          this.refresh(node); this.store.save();
        }
      }
    } catch (error) { respond(undefined, textError(error)); }
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.closePromise = (async () => {
      if (!this.started) { this.exit(1); return; }
      const failures: unknown[] = [];
      const results = await Promise.allSettled(this.opening.values());
      for (const result of results) if (result.status === "rejected") failures.push(result.reason);
      for (const node of this.store.nodes.values()) {
        this.stopping.add(node.id);
        if (node.busy || node.state === "running") { node.busy = false; node.state = "cancelled"; }
        if (node.work?.status === "running") { node.work.status = "complete"; node.work.result = "Closed"; node.work.delivered = true; }
        this.observe(node);
      }
      this.store.save();
      const closed = await Promise.allSettled([...this.native.values()].map(engine => engine.close()));
      for (const result of closed) if (result.status === "rejected") failures.push(result.reason);
      await Promise.all(this.tasks);
      this.native.clear(); this.exit(failures.length ? 1 : this.exitCode);
      if (failures.length) throw new AggregateError(failures, "Pi tree close failed");
    })();
    return this.closePromise;
  }
}

export const openPiSession: OpenCoreSession = async (options, output, exit) => {
  const core = new PiCoreSession(options, output, exit);
  try { return await core.open(); } catch (error) { await core.close(); throw error; }
};
