import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { observeSourceJob } from "./source-job.mjs";

const invalid = (code, message) => ({ state: "observation-error", jobKind: null, error: { code, message } });
export const jobObserveCommand = jobId => `agent-workspace job-status --job-id ${jobId} --json`;

function directoryExists(directory) {
  try { return lstatSync(directory).isDirectory(); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

export function observeWorkspaceJob(statePath, jobId, expectedKind = null) {
  if (!/^[0-9a-f]{64}$/u.test(jobId)) return invalid("invalid-job-id", "--job-id must be a full job SHA256");
  try {
    const root = path.dirname(statePath);
    const matches = [];
    const source = path.join(root, "source-preparations", "jobs", jobId);
    if (directoryExists(source)) matches.push({ jobKind: "source", directory: source });
    const checkoutRoot = path.join(root, "checkout-jobs");
    if (directoryExists(checkoutRoot)) {
      const owners = readdirSync(checkoutRoot, { withFileTypes: true });
      if (owners.length > 4096) return invalid("job-lookup-limit", "checkout job lookup exceeds 4096 workspace entries");
      for (const owner of owners) {
        if (!owner.isDirectory()) continue;
        const directory = path.join(checkoutRoot, owner.name, jobId);
        if (directoryExists(directory)) matches.push({ jobKind: "checkout", workspaceId: owner.name, directory });
      }
    }
    if (matches.length === 0) return invalid("job-not-found", "no source or checkout job with this identity is retained");
    if (matches.length !== 1) return invalid("job-identity-ambiguous", "multiple retained jobs share this identity");
    const { jobKind, workspaceId, directory } = matches[0];
    const observeCommand = jobObserveCommand(jobId);
    if (expectedKind !== null && expectedKind !== jobKind) return {
      state: "observation-error", jobKind, observeCommand,
      error: { code: "job-kind-mismatch", message: `this is a ${jobKind} job; use ${observeCommand} for read-only observation` },
    };
    return { jobKind, ...(workspaceId === undefined ? {} : { workspaceId }),
      ...observeSourceJob(directory), observeCommand };
  } catch (error) {
    return invalid("job-lookup-io", `job lookup failed (${error.code ?? "invalid-state"}); no work was submitted`);
  }
}
