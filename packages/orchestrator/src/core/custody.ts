import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { createSharedPiSessionOpener } from "../threads/runner-transport.js";
import type { CoreResult } from "./config.js";
import type { CoreScope } from "./contracts.js";
import { CustodyResources } from "./custody-resources.js";
import { createCoreInProcessRuntime, type CoreInProcessRuntime } from "./native-session.js";

export type CoreRuntime = (ReturnType<typeof createSharedPiSessionOpener> | CoreInProcessRuntime) & { path(logicalPath: string): string };
export type CoreRuntimeFactory = (scope: CoreScope) => Promise<CoreResult<CoreRuntime>>;
export const createCoreCustodyRuntime: CoreRuntimeFactory = scope => createCoreCustodyFactory(null)(scope);

export function createCoreCustodyFactory(consultationScopeIds: string | readonly string[] | null): CoreRuntimeFactory {
  const privateScopes = new Set(typeof consultationScopeIds === "string" ? [consultationScopeIds] : consultationScopeIds ?? []);
  return async scope => {
    let resources: CustodyResources | undefined;
    try {
      resources = new CustodyResources(scope.custody);
      const exact = new Set(Object.values(scope.storage));
      if (scope.environment.PI_CORE_TOKEN_FILE !== undefined) exact.add(scope.environment.PI_CORE_TOKEN_FILE);
      const directories = scope.resources.filter(item => item.kind === "directory").map(item => item.path);
      for (const entry of scope.resources) if (entry.kind === "file") exact.add(entry.path);
      const pinned = resources;
      const sameView = (logical: string) => {
        const visible = statSync(logical, { bigint: true });
        const registered = statSync(pinned.directory(logical), { bigint: true });
        if (visible.dev !== registered.dev || visible.ino !== registered.ino)
          throw new Error(`Shared namespace does not expose the exact registered resource: ${logical}`);
      };
      for (const logical of Object.values(scope.storage)) sameView(logical);
      for (const directory of directories) {
        sameView(directory);
        if (!statSync(directory).isDirectory()) throw new Error("Registered resource directory is not a directory");
      }
      const path = (logical: string) => {
        pinned.assert();
        if (!isAbsolute(logical) || resolve(logical) !== logical || logical.includes("\0")) throw new Error("Noncanonical core resource path");
        const root = directories.find(directory => logical === directory || logical.startsWith(directory + sep));
        if (!exact.has(logical) && root === undefined) throw new Error("Unregistered core resource path");
        let existing = logical;
        while (!existsSync(existing)) {
          const parent = dirname(existing);
          if (parent === existing) throw new Error("Core resource has no existing ancestor");
          existing = parent;
        }
        sameView(existing);
        if (root !== undefined) {
          const realRoot = realpathSync(root), actual = realpathSync(existing);
          if (actual !== realRoot && !actual.startsWith(realRoot + sep)) throw new Error("Core resource symlink escapes its registered directory");
        }
        return logical;
      };
      for (const logical of exact) path(logical);
      const runtime = privateScopes.has(scope.id) ? createCoreInProcessRuntime()
        : createSharedPiSessionOpener({ dataDir: scope.custody.dataDir, durable: true, custody: scope.custody, resources });
      return { ok: true, value: { ...runtime, path,
        detach() {
          runtime.detach();
          if ("register" in runtime) void (runtime as CoreInProcessRuntime).drain().then(() => pinned.close());
        },
      } };
    } catch (cause) {
      resources?.close();
      return { ok: false, error: { code: "unavailable", message: `Core custody cannot adopt scope ${scope.id}: ${String(cause)}` } };
    }
  };
}
