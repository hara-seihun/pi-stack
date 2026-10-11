import type { AsyncLocalStorage } from "node:async_hooks";
import type { Server, Socket } from "node:net";
import { bindRunnerEnvironments, RunnerFutureFactory, RUNNER_FACTORY_PROTOCOL, type FactoryResult, type RunnerFactoryBinding, type RunnerFactoryIdentity, type loadRunnerFactory } from "./runner-factory.js";
import { requireRunnerControlRequest } from "./runner-protocol.js";
import type { NativeRunnerOwner } from "./runner-ownership.js";

export type BootstrapResidentFact = { threadId: string } & (
  | { kind: "identified"; factory: RunnerFactoryIdentity; evidence: { kind: "adapter-function-location"; sourcePath: string; sourceSha256: string; line: number; column: number } | { kind: "captured-open-binding" } }
  | { kind: "unresolved"; error: string });
export interface RunnerFactoryBootstrapOptions {
  server: Server;
  owner: NativeRunnerOwner;
  leaseEvidence: Readonly<Record<string, unknown>>;
  assertLease(): void;
  serial<T>(action: () => Promise<T>): Promise<T>;
  initial: RunnerFactoryBinding;
  initialEnvironmentScope: AsyncLocalStorage<NodeJS.ProcessEnv>;
  residentFacts(): readonly BootstrapResidentFact[];
  load: typeof loadRunnerFactory;
  bindFutureOpen(bootstrap: RunnerFactoryBootstrap): FactoryResult<{ rollback(): void }>;
}
export interface RunnerFactoryBootstrap {
  futureFactory: RunnerFutureFactory;
  initialEnvironmentScope: AsyncLocalStorage<NodeJS.ProcessEnv>;
  assertLease(): void;
  bindRunnerEnvironments: typeof bindRunnerEnvironments;
  status(): { factoryProtocol: typeof RUNNER_FACTORY_PROTOCOL; futureFactory: RunnerFactoryIdentity; nativeOwner: NativeRunnerOwner;
    residentFactories: readonly BootstrapResidentFact[]; bootstrapLeaseEvidence: Readonly<Record<string, unknown>> };
}
const installed = Symbol.for("pi-stack.native-factory-bootstrap-v1");

export function installRunnerFactoryBootstrap(options: RunnerFactoryBootstrapOptions): FactoryResult<RunnerFactoryBootstrap> {
  try { options.assertLease(); }
  catch (cause) { return { ok: false, error: { code: "ownership-conflict", message: String(cause) } }; }
  const server = options.server as Server & { [installed]?: RunnerFactoryBootstrap };
  if (server[installed]) return { ok: false, error: { code: "factory-conflict", message: "Original control already has a source-owned factory bootstrap" } };
  if (server.address() !== options.owner.control || options.owner.pid !== process.pid)
    return { ok: false, error: { code: "ownership-conflict", message: "Bootstrap server is not the exact original process/control" } };
  const owner: NativeRunnerOwner = Object.freeze({ version: options.owner.version, dataDir: options.owner.dataDir, uid: options.owner.uid,
    control: options.owner.control, pid: options.owner.pid, startTicks: options.owner.startTicks });
  const futureFactory = new RunnerFutureFactory(options.initial, options.assertLease, options.load);
  const bootstrap: RunnerFactoryBootstrap = {
    futureFactory, initialEnvironmentScope: options.initialEnvironmentScope, assertLease: options.assertLease, bindRunnerEnvironments,
    status: () => ({ factoryProtocol: RUNNER_FACTORY_PROTOCOL, futureFactory: futureFactory.snapshot().identity, nativeOwner: owner,
      residentFactories: options.residentFacts(), bootstrapLeaseEvidence: options.leaseEvidence }),
  };
  const connection = (socket: Socket) => {
    const emit = socket.emit;
    const write = socket.write;
    let pending = Buffer.alloc(0), observingStatus = false;
    socket.write = function (...args: Parameters<Socket["write"]>): boolean {
      if (observingStatus) {
        const raw = args[0];
        if (typeof raw === "string" || Buffer.isBuffer(raw)) {
          let value: any;
          try { value = JSON.parse(raw.toString()); }
          catch { return write.apply(socket, args); }
          if (value.ok === true && value.pid === owner.pid) {
            try { args[0] = `${JSON.stringify({ ...value, ...bootstrap.status() })}\n`; }
            catch (cause) { args[0] = `${JSON.stringify({ ok: false, error: String(cause), errorCode: "factory-unavailable" })}\n`; }
          }
        }
      }
      return write.apply(socket, args);
    } as Socket["write"];
    const failure = (message: string, errorCode: string) => write.call(socket, `${JSON.stringify({ ok: false, error: message, errorCode })}\n`);
    const line = (raw: Buffer): boolean => {
      let input: unknown;
      try { input = JSON.parse(raw.toString()); }
      catch { return emit.call(socket, "data", raw); }
      const type = (input as { type?: unknown } | null)?.type;
      if (type !== "upgrade_factory") {
        observingStatus = type === "status";
        try { return emit.call(socket, "data", raw); }
        finally { observingStatus = false; }
      }
      let request;
      try { request = requireRunnerControlRequest(input); }
      catch (cause) { failure(String(cause), "factory-contract-invalid"); return true; }
      if (request.type !== "upgrade_factory") { failure("Bootstrap request is not an upgrade", "factory-contract-invalid"); return true; }
      const upgrade = request;
      void options.serial(async () => {
        if (Object.keys(owner).some(key => owner[key as keyof NativeRunnerOwner] !== upgrade.owner[key as keyof NativeRunnerOwner])) {
          failure("Original native process/storage identity changed", "ownership-conflict"); return;
        }
        const result = await futureFactory.upgrade(upgrade.expected, upgrade.candidate);
        write.call(socket, `${JSON.stringify(result.ok ? { ok: true, pid: owner.pid, protocol: RUNNER_FACTORY_PROTOCOL, ...result.value,
          residentFactories: options.residentFacts() } : { ok: false, error: result.error.message, errorCode: result.error.code })}\n`);
      }).catch(cause => failure(String(cause), "factory-unavailable"));
      return true;
    };
    socket.emit = function (event: string | symbol, ...args: any[]): boolean {
      if (event === "data" && Buffer.isBuffer(args[0])) {
        pending = Buffer.concat([pending, args[0]]);
        let end: number;
        while ((end = pending.indexOf(10)) >= 0) {
          const raw = pending.subarray(0, end + 1);
          pending = pending.subarray(end + 1);
          line(raw);
        }
        return true;
      }
      if (event === "end" && pending.length) { emit.call(socket, "data", pending); pending = Buffer.alloc(0); }
      return emit.call(socket, event, ...args);
    };
  };
  let bound: FactoryResult<{ rollback(): void }>;
  try { bound = options.bindFutureOpen(bootstrap); }
  catch (cause) { return { ok: false, error: { code: "factory-contract-invalid", message: String(cause) } }; }
  if (!bound.ok) return bound;
  try {
    options.assertLease();
    server.prependListener("connection", connection);
    server[installed] = bootstrap;
    return { ok: true, value: bootstrap };
  } catch (cause) {
    server.removeListener("connection", connection);
    bound.value.rollback();
    return { ok: false, error: { code: "ownership-conflict", message: String(cause) } };
  }
}
