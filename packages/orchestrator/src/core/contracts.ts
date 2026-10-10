import type { PiEvent, Thread, ThreadInputState, ThreadMessage, ThreadSettlement } from "../threads/contracts.js";
import type { PermissionPolicy, Principal, Resource } from "../permissions.js";
import type { CoreProviderConfig } from "./provider.js";
import type { CoreRootConfig } from "./root.js";
import type { CoreCallbackConfig } from "./callback-transports.js";
import type { GatewayBinding, GatewayTransportConfig } from "./gateway.js";
import type { CoreImagesConfig } from "./images.js";
import type { CoreMemoryConfig } from "./memory.js";
import type { CoreDutiesConfig } from "./duties-runtime.js";

export type CustodyNamespace = { kind: "host" } | {
  kind: "process";
  pid: number;
  startTicks: string;
  mountNamespaceInode: string;
} | { kind: "pinned"; path: string; mountNamespaceInode: string };
export type CoreCustody = {
  uid: number;
  gid: number;
  namespace: CustodyNamespace;
  retainedRunnerNamespace: CustodyNamespace;
  dataDir: string;
  socketDir: string;
};
export type CoreManager = {
  kind: "existing";
  threadId: string;
} | { kind: "none" };
export type CoreScope = {
  id: string;
  principalId: string;
  availability: { kind: "adopt" } | { kind: "unavailable"; reason: "locked" | "inactive" };
  resource: Resource;
  storage: {
    databasePath: string;
    sessionsDir: string;
    capabilityKeyPath: string;
    adoptionReceiptPath: string;
  };
  custody: CoreCustody;
  resources: { path: string; kind: "file" | "directory" }[];
  environment: Record<string, string>;
  manager: CoreManager;
};
export type CoreCredential = { sha256: string; principalId: string; scopeIds: string[]; purpose: "person" | "service" };
export type CoreConfig = {
  version: 1;
  host: "127.0.0.1" | "::1";
  port: number;
  statePath: string;
  principals: Principal[];
  credentials: CoreCredential[];
  policy: PermissionPolicy;
  scopes: CoreScope[];
  broker: CoreProviderConfig;
  root: CoreRootConfig;
  callbacks: CoreCallbackConfig;
  gatewayTransport: GatewayTransportConfig;
  gatewayBindings: GatewayBinding[];
  images: CoreImagesConfig;
  memory: CoreMemoryConfig;
  duties: CoreDutiesConfig;
  releaseCommit: string;
};
export type CoreProjection = {
  cursor: number;
  threads: Thread[];
  archivedTotal: number;
  pending: Record<string, ThreadMessage[]>;
  inputs: Record<string, ThreadInputState[]>;
  settlements: Record<string, ThreadSettlement>;
  live: Record<string, Record<string, unknown>>;
  managerThreadId: string | null;
};
export type CoreChange = { type: "thread"; threadId: string } | { type: "event"; threadId: string; event: PiEvent } | { type: "resync" };
export type CoreEvent = { cursor: number; change: CoreChange };
export type CoreAdoptionReceipt = {
  version: 1;
  scopeId: string;
  databasePath: string;
  sessionsDir: string;
  databaseIdentity: { dev: string; ino: string };
  previousOwner: { identity: string; detachedAt: string };
  state: "detached";
};
