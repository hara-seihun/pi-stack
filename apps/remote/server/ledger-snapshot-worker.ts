import { Database } from "bun:sqlite";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";

self.onmessage = (event: MessageEvent<{ source: string; target: string }>) => {
  const { source, target } = event.data;
  const staging = `${target}.writing`;
  let db: Database | undefined;
  try {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    rmSync(staging, { force: true });
    db = new Database(source, { readonly: true });
    db.query("PRAGMA busy_timeout=5000").run();
    db.query("VACUUM INTO ?").run(staging);
    renameSync(staging, target);
    self.postMessage({ ok: true });
  } catch (error) {
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    db?.close();
    rmSync(staging, { force: true });
    self.close();
  }
};
