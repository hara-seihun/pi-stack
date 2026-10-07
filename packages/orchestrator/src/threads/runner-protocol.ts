import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { PiSessionOptions } from "./contracts.js";

const sequence = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const frame = Type.Union([
  Type.Object({ type: Type.Literal("attached"), pid: Type.Optional(sequence), sequence: Type.Optional(sequence) }),
  Type.Object({ type: Type.Literal("output"), sequence, line: Type.String(), at: Type.Optional(Type.Number()) }),
  Type.Object({ type: Type.Literal("exit"), code: sequence }),
]);
export type RunnerFrame = Static<typeof frame>;
export function requireRunnerFrame(value: unknown): RunnerFrame {
  if (!Check(frame, value)) throw new Error(`Invalid runner output frame: ${String((value as { type?: unknown } | null)?.type)}`);
  return value;
}

const channel = Type.Union([
  Type.Object({ type: Type.Literal("attach"), after: Type.Optional(sequence) }),
  Type.Object({ type: Type.Literal("ack"), sequence }),
  Type.Object({ type: Type.Literal("command"), value: Type.Object({ type: Type.String(), id: Type.Optional(Type.String()) }) }),
]);
export type RunnerChannelRequest = Static<typeof channel>;
export function requireRunnerChannelRequest(value: unknown): RunnerChannelRequest {
  if (!Check(channel, value)) throw new Error(`Invalid runner channel request: ${String((value as { type?: unknown } | null)?.type)}`);
  return value;
}

const options = Type.Object({
  threadId: Type.String(), cwd: Type.String(), sessionFile: Type.String(), socketPath: Type.String(),
  args: Type.Array(Type.String()), env: Type.Record(Type.String(), Type.String()), priority: Type.Optional(Type.Boolean()),
});
const control = Type.Union([
  Type.Object({ type: Type.Literal("open"), options }),
  Type.Object({ type: Type.Literal("close"), socketPath: Type.String() }),
  Type.Object({ type: Type.Literal("activity"), socketPath: Type.String(), active: Type.Boolean() }),
  Type.Object({ type: Type.Literal("retain") }), Type.Object({ type: Type.Literal("drain") }), Type.Object({ type: Type.Literal("status") }),
]);
export type RunnerControlRequest = Static<typeof control>;
// Keeps the control schema honest against the application session options.
const optionsMatch: Static<typeof options> extends PiSessionOptions ? true : never = true;
void optionsMatch;
export function requireRunnerControlRequest(value: unknown): RunnerControlRequest {
  if (!Check(control, value)) throw new Error(`Invalid runner control request: ${String((value as { type?: unknown } | null)?.type)}`);
  return value;
}
