import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MachineActions, type MachineAction } from "./machine-actions";
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "settings-action-")); directories.push(directory);
  const state = join(directory, "enabled"), calls = join(directory, "calls");
  const action: MachineAction = { id: "example", label: "Example", icon: "example", status: ["test", "-f", state], on: ["sh", "-c", 'touch "$1"; printf on >> "$2"', "action", state, calls], off: ["rm", "-f", state] };
  return { service: new MachineActions([action]), action, calls };
}
test("setting an action reconciles requested state, confirms it and is idempotent", async () => {
  const { service, action, calls } = fixture();
  expect((await service.set(action, true)).active).toBe(true);
  expect((await service.set(action, true)).active).toBe(true);
  expect(readFileSync(calls, "utf8")).toBe("on");
  expect((await service.set(action, false)).active).toBe(false);
});
test("concurrent desired states serialize and an owner that fails to reach the target rejects", async () => {
  const { service, action } = fixture();
  const results = await Promise.all([service.set(action, true), service.set(action, false), service.set(action, true)]);
  expect(results.map(result => result.active)).toEqual([true, false, true]);
  const broken = { ...action, on: ["true"] };
  await service.set(action, false);
  await expect(service.set(broken, true)).rejects.toThrow("did not reach its requested state");
});
