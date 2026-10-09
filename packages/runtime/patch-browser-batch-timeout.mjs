#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const patches = [
  {
    target: 'dist/extensions/agent-browser/lib/process.js',
    originalHash: 'd1250a0a2edd6144fba3d657aaede484d1fcd80442b23aeaba72c938d447cc7b',
    patchedHash: '52b0a54c445f286adf6284adb54c111d209a77bcb0d39c54c9c59efa2364239a',
    changes: [
      [
        `    child.kill(signal);
}`,
        `    if (processPlatform !== "win32" && child.pid) {
        try {
            process.kill(-child.pid, "SIGKILL");
        } catch (error) {
            if (error.code !== "ESRCH")
                child.emit("error", error);
        }
        return;
    }
    child.kill(signal);
}`,
      ],
      [
        `            stdio: ["pipe", "pipe", "pipe"],
        });`,
        `            stdio: ["pipe", "pipe", "pipe"],
            detached: processPlatform !== "win32",
        });`,
      ],
    ],
  },
  {
    target: 'dist/extensions/agent-browser/lib/orchestration/browser-run/diagnostics.js',
    originalHash: '9a31e6f7acf83fcc7312320571f6eb6f9a602f58ee5e56344d33f2a9262e1ca7',
    patchedHash: '262763979e2b24d3ad5bfd53d83fd4430cd96b123233c3578eab8df3a2c2f1e2',
    changes: [
      [
        `    for (const step of progressSteps) {
        if (step.status === "completed")
            continue;
        if (!retryStep) {
            const retry = getTimeoutStepRetry(step);
            retryStep = {
                ...step,
                reason: step.reason ?? (retry ? "Likely active when the wrapper watchdog fired." : "Likely active when the wrapper watchdog fired; executable retry omitted because this step may have already mutated page state."),
                retry,
                status: "failed",
            };
            Object.assign(step, retryStep);
            continue;
        }
        step.status = "pending";
        step.reason = step.reason ?? \`Pending behind timed-out step \${retryStep.index}.\`;
    }`,
        `    for (const step of progressSteps) {
        if (step.status !== "completed") {
            step.status = "unknown";
            step.reason = "No step receipt was returned. This step may have completed, be in flight, or remain undispatched; inspect current state before repeating mutations.";
        }
    }`,
      ],
      [
        `    const retrySummary = stepProgress.retryStep ? \` Retry step \${stepProgress.retryStep.index} is the first incomplete step.\` : "";`,
        `    const retrySummary = stepProgress.steps.some(step => step.status === "unknown") ? " Unobserved step outcomes are unknown, not failed or pending. A dispatched mutation may still settle after timeout." : "";`,
      ],
    ],
  },
];
const digest = source => createHash('sha256').update(source).digest('hex');
export function patchBrowserBatchTimeout(root) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (manifest.name !== 'pi-agent-browser-native' || manifest.version !== '0.6.6') throw new Error('Unsupported native browser wrapper for batch timeout repair');
  const candidates = patches.map(patch => {
    const target = join(root, patch.target);
    const original = readFileSync(target, 'utf8');
    const hash = digest(original);
    if (hash === patch.patchedHash) return { target, source: original };
    if (hash !== patch.originalHash) throw new Error(`Native batch timeout source differs from pinned v0.6.6: ${patch.target}`);
    let source = original;
    for (const [before, after] of patch.changes) {
      if (source.split(before).length !== 2) throw new Error(`Native batch timeout anchor changed: ${patch.target}`);
      source = source.replace(before, after);
    }
    if (digest(source) !== patch.patchedHash) throw new Error(`Native batch timeout output differs from compiled source: ${patch.target}`);
    return { target, source };
  });
  for (const { target, source } of candidates) writeFileSync(target, source);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw new Error('usage: patch-browser-batch-timeout.mjs NATIVE_PACKAGE_ROOT');
  patchBrowserBatchTimeout(process.argv[2]);
}
