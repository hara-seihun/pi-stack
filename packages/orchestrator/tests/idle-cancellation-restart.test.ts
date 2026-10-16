import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ThreadService } from "../src/threads/service.js";
import type { PiCommand, PiEvent, PiRunnerReference, PiSession, Result } from "../src/threads/contracts.js";

const roots: string[] = [], services: ThreadService[] = [];
const unwrap = <T>(result: Result<T>): T => { if (!result.ok) throw new Error(result.error.message); return result.value; };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
afterEach(async () => {
  for (const service of services.splice(0)) await service.detach();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each([
  { action: "close" as const, retained: true },
  { action: "cancel" as const, retained: true },
  { action: "close" as const, retained: false },
  { action: "cancel" as const, retained: false },
])("recovers an idle $action intent after owner restart (retained=$retained) without another instruction", async ({ action, retained }) => {
  const root = mkdtempSync(join(tmpdir(), "idle-cancellation-restart-")); roots.push(root);
  const commands: { generation: number; command: PiCommand }[] = [];
  let generation = 1;
  const dispose = vi.fn(async () => {});
  const attachSession = vi.fn(async (_reference: PiRunnerReference | undefined, output: (event: PiEvent) => void): Promise<PiSession | null> => {
    const attachedGeneration = generation;
    if (attachedGeneration > 1 && !retained) return null; // Positive absence, not an attachment timeout.
    return {
      async command(command) {
        commands.push({ generation: attachedGeneration, command });
        // The old controller loses its acknowledgement during Core handoff.
        if (attachedGeneration === 1 && command.type === "abort") return;
        output({ type: "response", id: command.id, command: command.type, success: true,
          data: command.type === "get_state" ? { nativeProtocolVersion: "batch-operations-v1", isStreaming: false,
            pendingMessageCount: 0, backgroundOperationCount: 0, acceptedWorkIds: [], landedWorkIds: [], completedWorkIds: [] } : {} });
      },
      close: dispose,
    };
  });
  const openSession = vi.fn(async () => { throw new Error("Cancellation must never open a native session"); });
  const options = { capacity: { mode: "unmanaged" as const }, databasePath: join(root, "threads.sqlite3"), sessionsDir: root, openSession, attachSession };
  const original = new ThreadService(options); services.push(original);
  const thread = unwrap(await original.spawn({ requestId: "create-target", title: "Settled round six worker", cwd: root }));
  const untouched = unwrap(await original.spawn({ requestId: "create-unrelated", title: "Other idle conversation", cwd: root }));
  const owner = original as any;
  owner.sql("UPDATE thread SET metadata=json_set(metadata,'$.runnerReference',json(?)) WHERE id=?")
    .run(JSON.stringify({ control: join(root, "control.sock"), socketPath: join(root, "session.sock") }), thread.id);

  const closing = original.control({ threadId: thread.id, action });
  for (let i = 0; i < 100 && !commands.some(item => item.command.type === "abort"); i++) await tick();
  expect(commands.some(item => item.command.type === "abort")).toBe(true);
  original.suspend();
  expect(await closing).toMatchObject({ ok: false, error: { code: "cancellation_failed", message: "Thread controller suspended; execution remains with its runner" } });
  expect(original.get(thread.id)).toMatchObject({ state: "idle", held: true, pendingMessages: 0, metadata: { cancellationRequest: action } });
  expect(owner.execution(thread.id)).toBeUndefined();
  await original.detach();

  generation = 2;
  const restored = new ThreadService(options); services.push(restored);
  // start/reconcile must discover the existing intent without control(close/cancel), send, or new work.
  unwrap(await restored.start());
  for (let i = 0; i < 100 && restored.get(thread.id)?.held; i++) await tick();
  const settled = restored.get(thread.id)!;
  expect(settled.held).toBe(false);
  expect(settled.state).toBe("idle");
  expect(settled.metadata?.cancellationRequest).toBeUndefined();
  expect(settled.metadata?.runnerReference).toBeUndefined();
  expect(settled.lifecycle.kind).toBe(action === "close" ? "archived" : "idle");
  expect(restored.pending(thread.id)).toEqual([]);
  expect(restored.inputStates(thread.id)).toEqual([]);
  expect(restored.get(untouched.id)).toMatchObject({ state: "idle", held: false, lifecycle: { kind: "idle" } });
  expect(attachSession).toHaveBeenCalledTimes(2);
  expect(openSession).not.toHaveBeenCalled();
  expect(commands.filter(item => item.generation === 2).map(item => item.command.type))
    .toEqual(retained ? ["get_state", "abort", "get_state"] : []);
  expect(dispose).toHaveBeenCalledTimes(retained ? 1 : 0);
  expect(commands.some(item => ["input_batch", "prompt", "steer", "recover_final_result", "resume_pending"].includes(item.command.type))).toBe(false);

  // The consumed intent is not reissued on a second restoration.
  await restored.detach();
  const settledOwner = new ThreadService(options); services.push(settledOwner);
  unwrap(await settledOwner.start());
  await tick();
  expect(attachSession).toHaveBeenCalledTimes(2);
  expect(settledOwner.get(thread.id)?.lifecycle.kind).toBe(action === "close" ? "archived" : "idle");
});
