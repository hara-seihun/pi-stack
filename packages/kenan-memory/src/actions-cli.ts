#!/usr/bin/env bun
import { actionRequest, openActionStore, type ActionResult } from "./actions.js";

let result: ActionResult<unknown>;
let store: ReturnType<typeof openActionStore> | undefined;
try {
  const command = process.argv[2];
  if (command === "--help") {
    console.log("Action authority: submit | inspect | list | claim | dispatch | finish | reconcile | recover | retry | followup | hold-recipient | release-recipient. JSON stdin, typed JSON result. Uses the authenticated canonical owner supervisor/router, never a second SQLite mount. Submit reserves; owned transport adapters claim/dispatch. Inflight/uncertain never replay.");
    process.exit(0);
  }
  const source = await Bun.stdin.text();
  if (source.length > 2_100_000) throw new Error("Input exceeds action request limit");
  const input = source.trim() ? JSON.parse(source) : {};
  store = openActionStore();
  result = actionRequest(store, command ?? "", input);
} catch (cause) {
  result = { ok: false, error: "unavailable", message: `Action authority unavailable; no dispatch permitted: ${String(cause)}` };
} finally { store?.close(); }
console.log(JSON.stringify(result));
process.exitCode = 0;
