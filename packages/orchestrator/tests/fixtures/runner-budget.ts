import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PiEvent } from "../../src/threads/contracts.js";
import { runnerSlices } from "../../src/threads/runner-resources.js";

type Control = (...args: string[]) => string;
const control: Control = (...args) => execFileSync("systemctl", ["--user", ...args], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });

export class RunnerBudgetFixture {
  readonly compiled: string;
  readonly root: string;
  private readonly ids = new Set<string>();

  constructor(repo: string, prefix: string, private readonly ctl: Control = control) {
    const cache = join(repo, "node_modules/.cache");
    mkdirSync(cache, { recursive: true });
    this.compiled = mkdtempSync(join(cache, prefix));
    try { this.root = mkdtempSync(join(tmpdir(), prefix)); }
    catch (error) { rmSync(this.compiled, { recursive: true, force: true }); throw error; }
  }

  // openSession emits this before launching, including when startup never returns a session.
  track(event: PiEvent) {
    if (event.type !== "runner_attached") return;
    if (typeof event.control !== "string") throw new Error("Runner fixture received an invalid control reference");
    this.ids.add(createHash("sha256").update(event.control).digest("hex").slice(0, 16));
  }

  cleanup(detach: () => void) {
    const errors: unknown[] = [];
    const attempt = (effect: () => unknown) => { try { effect(); } catch (error) { errors.push(error); } };
    for (const id of this.ids) {
      const slices = runnerSlices(id);
      // Every launch of this boundary owns a distinct controller unit name.
      let runners: string[] = [];
      attempt(() => {
        runners = this.ctl("list-units", "--all", "--plain", "--no-legend", `pi-thread-runner-${id}-*.service`)
          .split("\n").map(line => line.trim().split(/\s+/)[0]!).filter(Boolean);
      });
      for (const unit of [...runners, slices.tools, slices.boundary]) {
        attempt(() => {
          if (this.ctl("show", unit, "--property=LoadState", "--value").trim() === "not-found") return;
          if (unit.endsWith(".service")) {
            const state = () => this.ctl("show", unit, "--property=ActiveState", "--value").trim();
            if (!["inactive", "failed"].includes(state())) {
              try { this.ctl("kill", "--signal=SIGKILL", unit); }
              catch (error) { if (!["inactive", "failed"].includes(state())) throw error; }
            }
          }
          try { this.ctl("stop", unit); }
          catch (error) {
            if (this.ctl("show", unit, "--property=LoadState", "--value").trim() !== "not-found") throw error;
          }
        });
      }
      for (const slice of [slices.tools, slices.boundary]) attempt(() => this.ctl("revert", slice));
    }
    attempt(detach);
    for (const path of [this.root, this.compiled]) attempt(() => rmSync(path, { recursive: true, force: true }));
    if (errors.length) throw new AggregateError(errors, "Runner budget fixture cleanup failed");
  }
}
