// A CPU profile of the live supervisor, on request. The supervisor cannot be
// restarted with --cpu-prof without ending every running turn, so this uses
// JavaScriptCore's in-process sampling profiler instead: start it, let the
// window pass, read the stack traces it collected, and fold them into the
// hottest functions by self time and by inclusive time. The report is what an
// agent needs to answer "what is the event loop doing" without a debugger.

export interface ProfileFrame { name: string; sourceURL?: string; line: number; category: string }
export interface ProfileTrace { timestamp: number; frames: ProfileFrame[] }
export interface ProfileInput { interval: number; traces: ProfileTrace[] }

export interface ProfileEntry {
  /** `name (file:line)`; native and runtime frames have no file. */
  where: string;
  samples: number;
  /** Share of all samples, 0–100. */
  percent: number;
}
export interface ProfileReport {
  /** How long the window ran, in milliseconds. */
  windowMs: number;
  /** Sampling interval in milliseconds. */
  intervalMs: number;
  samples: number;
  /** Fraction of the window the main thread spent running JavaScript or native work under it, 0–100. */
  busyPercent: number;
  /** Frames at the top of the stack: where the time itself was spent. */
  self: ProfileEntry[];
  /** Frames anywhere on the stack: what was responsible for the time. */
  inclusive: ProfileEntry[];
  /** The most common whole stacks, root first, for the top self entries. */
  stacks: Array<{ samples: number; frames: string[] }>;
}

const location = (frame: ProfileFrame): string => {
  const file = frame.sourceURL ? frame.sourceURL.replace(/^.*\/pi-remote\//, "").replace(/^.*\/apps\//, "apps/") : "";
  if (!file) return frame.name || "(anonymous)";
  return `${frame.name || "(anonymous)"} (${file}:${frame.line})`;
};

/** Frames the profiler emits for its own bookkeeping and the loop's idle wait; they say nothing about the work. */
const idle = (frames: ProfileFrame[]): boolean => frames.length === 0 || frames.every(frame => frame.category === "Unknown Executable" && !frame.sourceURL);

export function summarizeProfile(input: ProfileInput, windowMs: number, limit = 40): ProfileReport {
  const self = new Map<string, number>();
  const inclusive = new Map<string, number>();
  const stacks = new Map<string, number>();
  let counted = 0;
  for (const trace of input.traces) {
    if (idle(trace.frames)) continue;
    counted++;
    const top = trace.frames[0]!;
    self.set(location(top), (self.get(location(top)) ?? 0) + 1);
    const seen = new Set<string>();
    for (const frame of trace.frames) {
      const key = location(frame);
      if (seen.has(key)) continue;
      seen.add(key);
      inclusive.set(key, (inclusive.get(key) ?? 0) + 1);
    }
    // Root first, so the same call path folds together whatever it was doing at the leaf.
    const path = [...trace.frames].reverse().filter(frame => frame.sourceURL).map(location).join(" > ");
    stacks.set(path, (stacks.get(path) ?? 0) + 1);
  }
  const rank = (map: Map<string, number>): ProfileEntry[] => [...map]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([where, samples]) => ({ where, samples, percent: counted ? Math.round(samples / counted * 1000) / 10 : 0 }));
  const intervalMs = input.interval * 1000;
  return {
    windowMs,
    intervalMs,
    samples: counted,
    busyPercent: windowMs > 0 ? Math.min(100, Math.round(counted * intervalMs / windowMs * 1000) / 10) : 0,
    self: rank(self),
    inclusive: rank(inclusive),
    stacks: [...stacks].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([path, samples]) => ({ samples, frames: path.split(" > ") })),
  };
}

export function formatProfile(report: ProfileReport): string {
  const lines = [
    `CPU profile: ${report.samples} samples over ${Math.round(report.windowMs)} ms at ${report.intervalMs} ms; main thread busy ${report.busyPercent}%`,
    "",
    "Self time (where the time was spent):",
    ...report.self.map(entry => `  ${String(entry.percent).padStart(5)}%  ${String(entry.samples).padStart(6)}  ${entry.where}`),
    "",
    "Inclusive time (what was responsible):",
    ...report.inclusive.map(entry => `  ${String(entry.percent).padStart(5)}%  ${String(entry.samples).padStart(6)}  ${entry.where}`),
    "",
    "Hottest stacks (root first):",
    ...report.stacks.flatMap(stack => [`  ${stack.samples} samples`, ...stack.frames.map(frame => `      ${frame}`)]),
    "",
  ];
  return lines.join("\n");
}

let started = false;
/**
 * Sample the main thread for `ms` and return the folded report. The profiler
 * stays on once started; reading its traces releases them, so each call sees
 * only its own window.
 */
export async function profileMainThread(ms: number, intervalUs = 1000): Promise<ProfileReport> {
  // bun-types omits samplingProfilerStackTraces; Bun 1.3 exports it and releases the traces it returns.
  const jsc = await import("bun:jsc") as unknown as { startSamplingProfiler(directory?: string, intervalUs?: number): void; samplingProfilerStackTraces(): ProfileInput };
  if (!started) { jsc.startSamplingProfiler(undefined, intervalUs); started = true; }
  else jsc.samplingProfilerStackTraces();
  const startedAt = performance.now();
  await new Promise(resolve => setTimeout(resolve, ms));
  const windowMs = performance.now() - startedAt;
  return summarizeProfile(jsc.samplingProfilerStackTraces(), windowMs);
}

/**
 * How late timers run. A loop that is never blocked reports a few
 * milliseconds; one stalled by synchronous work reports the stall.
 */
export async function measureLoopLag(ms: number, tickMs = 10): Promise<{ samples: number; p50Ms: number; p90Ms: number; maxMs: number }> {
  const lags: number[] = [];
  const end = performance.now() + ms;
  while (performance.now() < end) {
    const expected = performance.now() + tickMs;
    await new Promise(resolve => setTimeout(resolve, tickMs));
    lags.push(Math.max(0, performance.now() - expected));
  }
  lags.sort((a, b) => a - b);
  const at = (q: number) => Math.round((lags[Math.min(lags.length - 1, Math.floor(lags.length * q))] ?? 0) * 10) / 10;
  return { samples: lags.length, p50Ms: at(0.5), p90Ms: at(0.9), maxMs: at(1) };
}
