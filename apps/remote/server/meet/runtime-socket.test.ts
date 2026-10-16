import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readlinkSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeetSocketOwner } from "./runtime-socket";

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "meet-owner-"));
  const data = join(root, "data"), host = join(root, "host");
  mkdirSync(data, { mode: 0o700 }); mkdirSync(host, { mode: 0o700 });
  return { root, socket: join(data, "meet-runtime.sock"), callback: join(host, "callback.sock") };
};
const acquire = (socket: string, callback: string) => {
  const result = MeetSocketOwner.acquire(socket, callback, process.getuid!());
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

test("host lifetime ownership excludes sibling contenders without touching accepted requests", async () => {
  const f = fixture(), owner = acquire(f.socket, f.callback);
  let finish!: () => void;
  const server = Bun.serve({ unix: owner.endpoint, fetch: async () => { await new Promise<void>(resolve => { finish = resolve; }); return new Response("accepted"); } });
  owner.captureBoundEndpoint();
  expect((await owner.publish()).ok).toBe(true);
  const accepted = fetch("http://meet/room", { unix: f.socket });
  const deadline = Date.now() + 2000;
  while (!finish && Date.now() < deadline) await Bun.sleep(1);
  if (!finish) throw new Error("Accepted Meet request did not enter its handler");
  expect(MeetSocketOwner.acquire(f.socket, f.callback, process.getuid!())).toMatchObject({ ok: false, kind: "occupied" });
  expect(readlinkSync(f.socket)).toBe(owner.endpoint);
  finish();
  expect(await (await accepted).text()).toBe("accepted");
  await server.stop(true); owner.close(); rmSync(f.root, { recursive: true, force: true });
});

test("delayed prior generation close cannot unlink a successor alias or bound endpoint", async () => {
  const f = fixture();
  const old = acquire(f.socket, f.callback);
  const first = Bun.serve({ unix: old.endpoint, fetch: () => new Response("old") });
  old.captureBoundEndpoint(); expect((await old.publish()).ok).toBe(true);
  // Alias disappearance models an old-generation sibling FUSE cleanup. Lifetime
  // ownership deliberately prevents another new generation until old releases.
  unlinkSync(f.socket);
  const successorPath = join(f.root, "successor.sock");
  const second = Bun.serve({ unix: successorPath, fetch: () => new Response("new") });
  const { symlinkSync } = await import("node:fs"); symlinkSync(successorPath, f.socket);
  await first.stop(true); old.close();
  expect(await (await fetch("http://meet/status", { unix: f.socket })).text()).toBe("new");
  await second.stop(true); rmSync(f.root, { recursive: true, force: true });
});

test("failed publication and failed acquisition preserve the existing live owner", async () => {
  const f = fixture();
  const existing = Bun.serve({ unix: f.socket, fetch: () => new Response("existing") });
  const owner = acquire(f.socket, f.callback);
  const contender = Bun.serve({ unix: owner.endpoint, fetch: () => new Response("contender") });
  owner.captureBoundEndpoint();
  expect(await owner.publish()).toMatchObject({ ok: false, kind: "occupied" });
  await contender.stop(true); owner.close();
  expect(await (await fetch("http://meet/status", { unix: f.socket })).text()).toBe("existing");
  writeFileSync(join(f.root, "unsafe"), "not an owned directory");
  expect(MeetSocketOwner.acquire(f.socket, join(f.root, "unsafe", "callback.sock"), process.getuid!()).ok).toBe(false);
  expect(await (await fetch("http://meet/status", { unix: f.socket })).text()).toBe("existing");
  await existing.stop(true); rmSync(f.root, { recursive: true, force: true });
});
