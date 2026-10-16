import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { PiSessionOptions } from "./contracts.js";
import { RunnerOwnershipError, type NativeRunnerOwner } from "./runner-ownership.js";

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
export const factoryIdentity = Type.Object({
  entryPath: Type.String({ minLength: 1 }), entrySha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  sdkDirectory: Type.String({ minLength: 1 }), sourceCommit: Type.Union([Type.String({ pattern: "^[a-f0-9]{40}$" }), Type.Null()]),
});
const factoryStatus = Type.Object({ ok: Type.Literal(true), factoryProtocol: Type.Literal("native-future-factory-v1"), futureFactory: factoryIdentity });
export function requireFactoryStatus(value: unknown): Static<typeof factoryStatus> {
  if (!Check(factoryStatus, value)) throw new Error("Native status does not identify its future-factory contract");
  return value;
}
const ownerIdentity = Type.Object({
  version: Type.Literal(1), dataDir: Type.String(), uid: sequence, control: Type.String(), pid: sequence, startTicks: Type.String({ pattern: "^[0-9]+$" }),
});
const ownedFactoryStatus = Type.Intersect([factoryStatus, Type.Object({ pid: sequence, nativeOwner: ownerIdentity })]);
export function requireOwnedFactoryStatus(value: unknown, owner: NativeRunnerOwner): Static<typeof ownedFactoryStatus> {
  if (!Check(ownedFactoryStatus, value)) throw new RunnerOwnershipError("ownership-uncertain", "Native factory status lacks exact process/storage ownership");
  if (value.pid !== owner.pid || Object.keys(ownerIdentity.properties).some(key => value.nativeOwner[key as keyof NativeRunnerOwner] !== owner[key as keyof NativeRunnerOwner]))
    throw new RunnerOwnershipError("ownership-conflict", "Native factory status belongs to a different process/storage owner");
  return value;
}
const control = Type.Union([
  Type.Object({ type: Type.Literal("upgrade_factory"), protocol: Type.Literal("native-future-factory-v1"),
    owner: ownerIdentity, expected: factoryIdentity, candidate: factoryIdentity }),
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
