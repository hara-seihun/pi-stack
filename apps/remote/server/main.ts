import { applyLocalConfig } from "./config";

// The launcher forwards a release handoff as SIGUSR2 the moment a deployment
// asks for one, which can land before this module has finished loading. An
// unhandled SIGUSR2 ends the process, and a supervisor that dies here takes
// the person's front door with it. Hold the request until the server has
// installed its own handler, then replay it.
let handoffRequested = false;
const holdHandoff = () => { handoffRequested = true; };
process.on("SIGUSR2", holdHandoff);
process.on("SIGHUP", holdHandoff);

applyLocalConfig();
await import("./server");

process.off("SIGUSR2", holdHandoff);
process.off("SIGHUP", holdHandoff);
if (handoffRequested) process.emit("SIGUSR2", "SIGUSR2");
if (process.env.PI_REMOTE_DEV_NOTIFY === "1") {
  const result = Bun.spawnSync(["systemd-notify", "--ready"]);
  if (result.exitCode !== 0) throw new Error("Could not notify the live supervisor's service owner");
}
