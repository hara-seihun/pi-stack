import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { openPiSession } from "../src/threads/pi-session.js";
import { seedPiSession } from "../src/threads/pi-session-file.js";
import type { PiCommand, PiEvent, PiSessionOptions } from "../src/threads/contracts.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "pi-native-cwd-")));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const cwd = join(directory, "allowed");
  const outside = join(directory, "outside");
  mkdirSync(cwd); mkdirSync(outside);
  const options: PiSessionOptions = { cwd, args: [], threadId: "root", sessionFile: join(directory, "root.jsonl"),
    env: { PI_OFFLINE: "1", PI_CODING_AGENT_DIR: join(directory, "agent"),
      PI_REMOTE_WORKSPACES: JSON.stringify([{ id: "home", name: "Home", path: cwd }]) } };
  return { directory, cwd, outside, options };
}

function transcript(path: string, admittedCwd: string, headerCwd: string) {
  seedPiSession(path, admittedCwd);
  const lines = readFileSync(path, "utf8").split("\n");
  lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), cwd: headerCwd });
  const source = lines.join("\n");
  writeFileSync(path, source);
  return source;
}

test("resume rejects a literal relative native header before creating a tree or changing history", async () => {
  const { directory, cwd, options } = fixture();
  const path = join(directory, "resumed.jsonl");
  const source = transcript(path, cwd, "sibyl");
  options.sessionFile = path;
  await expect(openPiSession(options, () => {}, () => {})).rejects.toThrow("header.cwd: relative_cwd");
  expect(readFileSync(path, "utf8")).toBe(source);
  expect(existsSync(join(directory, "root.jsonl"))).toBe(false);
});

test("native session switches reject raw relative and escaping headers before replacing the current conversation", async () => {
  const { directory, cwd, outside, options } = fixture();
  const output: PiEvent[] = [];
  const core = await openPiSession(options, event => output.push(event), () => {});
  cleanups.push(() => core.close());
  const request = async (command: PiCommand) => {
    const id = `request-${output.length}`;
    await core.command({ ...command, id });
    return [...output].reverse().find(event => event.type === "response" && event.id === id)!;
  };
  const initial = (await request({ type: "get_state" })).data as { sessionFile: string };
  const initialHistory = readFileSync(initial.sessionFile, "utf8");
  const escape = join(cwd, "escape");
  symlinkSync(outside, escape);
  for (const [index, badCwd] of ["sibyl", outside, escape].entries()) {
    const path = join(directory, `rejected-${index}.jsonl`);
    const source = transcript(path, cwd, badCwd);
    const response = await request({ type: "switch_session", sessionPath: path });
    expect(response).toMatchObject({ success: false });
    expect(String(response.error)).toContain("Pi cwd admission");
    expect((await request({ type: "get_state" })).data).toMatchObject({ sessionFile: initial.sessionFile });
    expect(readFileSync(initial.sessionFile, "utf8").startsWith(initialHistory)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(source);
  }
  const nested = join(cwd, "nested");
  mkdirSync(nested);
  const accepted = join(directory, "accepted.jsonl");
  transcript(accepted, cwd, nested);
  expect(await request({ type: "switch_session", sessionPath: accepted })).toMatchObject({ success: true });
  expect((await request({ type: "get_state" })).data).toMatchObject({ sessionFile: accepted });
  expect(output.filter(event => event.type === "session_changed").at(-1)).toMatchObject({ cwd: nested });
});
