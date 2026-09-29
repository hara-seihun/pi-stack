import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptHook, transcriptHookPath } from "./transcript-hook";

test("a room's turns reach the hook in order, with the meeting thread in its environment", async () => {
  const directory = mkdtempSync(join(tmpdir(), "meet-hook-"));
  const hook = join(directory, "hook");
  const record = join(directory, "record");
  writeFileSync(hook, `#!/usr/bin/env bash\nread -r line\nsleep 0.$((RANDOM % 3))\necho "$PI_REMOTE_SESSION_ID $PI_MEET_ROOM_ID $line" >> ${record}\necho '{"handled":false}'\n`);
  chmodSync(hook, 0o755);
  const logged: string[] = [];
  const delivery = new TranscriptHook(() => hook, (line) => logged.push(line));
  const turn = (id: string, text: string) => ({ roomId: "room", sessionId: "thread", id, speaker: "Client", speakerId: "recall:1", text, startedAt: 1 });
  await Promise.all([delivery.deliver(turn("a", "next slide")), delivery.deliver(turn("b", "next slide again"))]);
  const lines = readFileSync(record, "utf8").trim().split("\n");
  expect(lines.map((line) => line.split(" ").slice(0, 2).join(" "))).toEqual(["thread room", "thread room"]);
  expect(lines.map((line) => JSON.parse(line.slice("thread room ".length)).id)).toEqual(["a", "b"]);
  expect(logged).toEqual([]);
});

test("a failing hook is logged and does not throw", async () => {
  const logged: string[] = [];
  const directory = mkdtempSync(join(tmpdir(), "meet-hook-"));
  const hook = join(directory, "hook");
  writeFileSync(hook, "#!/usr/bin/env bash\nexit 1\n");
  chmodSync(hook, 0o755);
  const delivery = new TranscriptHook(() => hook, (line) => logged.push(line));
  await delivery.deliver({ roomId: "room", sessionId: "thread", id: "a", speaker: "Client", speakerId: "recall:1", text: "pause", startedAt: 1 });
  expect(JSON.parse(logged[0]!)).toMatchObject({ event: "meet_transcript_hook", code: 1 });
});

test("tests never pick up a host's installed hook", () => {
  expect(transcriptHookPath({ NODE_ENV: "test", HOME: "/nonexistent" })).toBeNull();
  const directory = mkdtempSync(join(tmpdir(), "meet-hook-"));
  const hook = join(directory, "hook");
  writeFileSync(hook, "#!/usr/bin/env bash\n");
  chmodSync(hook, 0o755);
  expect(transcriptHookPath({ NODE_ENV: "test", PI_MEET_TRANSCRIPT_HOOK: hook })).toBe(hook);
});
