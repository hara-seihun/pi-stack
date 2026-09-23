import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireReservation, EngineReservedError, leaseCommand, parseEngineReservation } from "./engine-reservation";
import { ensureLocalEngine, loadLocalEngine, localNamingCompletion, withLocalEngine } from "./local-naming";

/** Stand in for the benchmark: hold the engine's lock exclusively, exactly as `flock -x` in a shell does. */
function holdExclusive(lock: string): Promise<() => Promise<void>> {
  return new Promise((resolve, reject) => {
    const child = spawn("flock", ["--exclusive", "--nonblock", "--conflict-exit-code", "75", lock, "sh", "-c", "printf held\\n; exec cat"], { stdio: ["pipe", "pipe", "ignore"] });
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`maintenance holder could not take ${lock} (exit ${code})`)));
    child.stdout!.once("data", () => resolve(() => new Promise((done) => {
      child.removeAllListeners("exit");
      child.on("exit", () => done());
      child.stdin!.end();
    })));
  });
}

/** Try to take the lock the way a benchmark wrapper does, and report its exit code. */
function tryExclusive(lock: string, waitSeconds: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn("flock", ["--exclusive", "--timeout", String(waitSeconds), "--conflict-exit-code", "75", lock, "true"], { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });
}

/** A temporary agent directory whose manifest holds one engine, built from the directory's own paths. */
async function agentDir(engine: (dir: string) => Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "local-naming-"));
  await writeFile(join(dir, "local-models.json"), JSON.stringify({ version: 1, engines: [engine(dir)] }));
  return dir;
}

describe("local engine maintenance reservation", () => {
  it("defers naming while a maintenance holder has the engine, and never starts it", async () => {
    const dir = await agentDir((home) => ({ id: "halo", baseUrl: "http://127.0.0.1:9/v1", reservation: { lock: join(home, "engine.lock") },
      start: { unit: "must-not-start", command: ["false"], readySeconds: 1 } }));
    try {
      const lock = join(dir, "engine.lock");
      const engine = await loadLocalEngine(dir, "halo");
      expect(engine.reservation).toEqual({ lock, waitSeconds: 0 });

      const releaseMaintenance = await holdExclusive(lock);
      let started = false;
      try {
        const attempt = withLocalEngine(engine, 0, async () => { started = true; await ensureLocalEngine(engine); return "named"; });
        await expect(attempt).rejects.toThrow(EngineReservedError);
        await attempt.catch((error: EngineReservedError) => {
          expect(error).toBeInstanceOf(EngineReservedError);
          expect(error.engineId).toBe("halo");
          expect(error.message).toContain(lock);
        });
        expect(started).toBe(false);
      } finally { await releaseMaintenance(); }

      // Once the lease ends the same call reaches the engine again.
      expect(await withLocalEngine(engine, 0, async () => "reached")).toBe("reached");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("holds the reservation across the whole naming request, so maintenance waits instead of racing it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "local-naming-race-"));
    const engineServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        if (new URL(request.url).pathname.endsWith("/models")) return Response.json({ data: [{ id: "bonsai-2-27b" }] });
        await Bun.sleep(400);
        return Response.json({ choices: [{ message: { content: "Ternary Batch Compare" } }] });
      },
    });
    try {
      const lock = join(dir, "engine.lock");
      await writeFile(join(dir, "local-models.json"), JSON.stringify({ version: 1, engines: [
        { id: "halo", baseUrl: `http://127.0.0.1:${engineServer.port}/v1`, reservation: { lock } },
      ] }));
      const engine = await loadLocalEngine(dir, "halo");
      const naming = withLocalEngine(engine, 0, async () => {
        await ensureLocalEngine(engine);
        return localNamingCompletion(engine, { model: "bonsai-2-27b", systemPrompt: "title it", prompt: "User: hi", reasoningEffort: "none", maxTokens: 16 });
      });
      await Bun.sleep(150);
      expect(await tryExclusive(lock, 0.2)).toBe(75);
      expect(await naming).toBe("Ternary Batch Compare");
      expect(await tryExclusive(lock, 1)).toBe(0);
    } finally { engineServer.stop(true); await rm(dir, { recursive: true, force: true }); }
  });

  it("refuses rather than ignores a reservation it cannot evaluate, and leaves unreserved engines alone", async () => {
    const dir = await agentDir(() => ({ id: "halo", baseUrl: "http://127.0.0.1:9/v1" }));
    try {
      const engine = await loadLocalEngine(dir, "halo");
      expect(engine.reservation).toBeUndefined();
      expect(await withLocalEngine(engine, 0, async () => "ran")).toBe("ran");

      const missingFlock = (() => { throw new Error("flock is missing"); }) as unknown as typeof spawn;
      const unusable = await acquireReservation({ lock: "/tmp/absent.lock", waitSeconds: 0 }, 0, missingFlock);
      expect(unusable).toEqual({ ok: false, reserved: false, detail: "cannot run flock for /tmp/absent.lock: flock is missing" });
      await expect(withLocalEngine({ ...engine, reservation: { lock: "/tmp/absent.lock", waitSeconds: 0 } }, 0, async () => "ran", missingFlock))
        .rejects.toThrow(/cannot run flock/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("keeps the manifest contract the Pi runtime extension implements", () => {
    expect(parseEngineReservation(undefined, "halo")).toBeUndefined();
    expect(parseEngineReservation({ lock: "/tmp/a.lock" }, "halo")).toEqual({ lock: "/tmp/a.lock", waitSeconds: 0 });
    expect(parseEngineReservation({ lock: "/tmp/a.lock", waitSeconds: 20 }, "halo")).toEqual({ lock: "/tmp/a.lock", waitSeconds: 20 });
    expect(() => parseEngineReservation({ lock: "relative" }, "halo")).toThrow(/absolute path/);
    expect(() => parseEngineReservation({ lock: "/tmp/a.lock", waitSeconds: -1 }, "halo")).toThrow(/waitSeconds/);
    expect(leaseCommand({ lock: "/tmp/a.lock", waitSeconds: 0 }, 0)).toEqual(["flock", ["--shared", "--nonblock", "--conflict-exit-code", "75", "/tmp/a.lock", "sh", "-c", "printf 'held\\n'; exec cat"]]);
    expect(leaseCommand({ lock: "/tmp/a.lock", waitSeconds: 20 }, 20)[1].slice(0, 3)).toEqual(["--shared", "--timeout", "20"]);
  });
});
