import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);

export function openSqlite(path: string, readOnly = false): DatabaseSync {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    const { Database } = require("bun:sqlite") as {
      Database: new (path: string, options?: { readonly: true }) => DatabaseSync;
    };
    return new Database(path, readOnly ? { readonly: true } : undefined);
  }
  const { DatabaseSync: Database } = require("node:sqlite") as typeof import("node:sqlite");
  return new Database(path, { readOnly });
}
