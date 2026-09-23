import { readdirSync, readFileSync, statfsSync } from "node:fs";
import { cpus, freemem, homedir, platform, totalmem } from "node:os";

type CpuTotals = { idle: number; total: number };
type CpuSample = { at: number; totals: CpuTotals };

const CPU_SAMPLE_INTERVAL_MS = 1_000;
const CPU_WINDOW_MS = 10_000;
const DRM_CLASS_PATH = "/sys/class/drm";
const LINUX_MEMINFO_PATH = "/proc/meminfo";

// DRM card numbering is enumeration order, not identity: a driver
// unbind/rebind renumbers the card (card0 -> card1). Resolve the current
// card exposing the AMD busy counter, and re-resolve after any failure.
let gpuBusyPercentPath: string | null = null;

function findGpuBusyPercentPath(): string | null {
  try {
    for (const entry of readdirSync(DRM_CLASS_PATH)) {
      if (!/^card\d+$/.test(entry)) continue;
      const candidate = `${DRM_CLASS_PATH}/${entry}/device/gpu_busy_percent`;
      try {
        readFileSync(candidate, "utf8");
        return candidate;
      } catch {}
    }
  } catch {}
  return null;
}

import type { MachineUsage } from "./protocol";

export type MachineUsageSnapshot = MachineUsage;

function percent(used: number, total: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((used / total) * 100)));
}

function cpuTotals(): CpuTotals {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total };
}

export function calculateCpuPercent(before: CpuTotals, after: CpuTotals): number | null {
  const total = after.total - before.total;
  const idle = after.idle - before.idle;
  if (total <= 0) return null;
  return percent(total - idle, total);
}

export class CpuUsageWindow {
  private samples: CpuSample[];
  private value: number | null = null;

  constructor(
    private readonly readTotals: () => CpuTotals = cpuTotals,
    initialAt = performance.now(),
  ) {
    this.samples = [{ at: initialAt, totals: readTotals() }];
  }

  read(at = performance.now()): number | null {
    const latest = this.samples[this.samples.length - 1]!;
    if (at < latest.at) {
      this.samples = [{ at, totals: this.readTotals() }];
      this.value = null;
      return this.value;
    }
    const elapsed = at - latest.at;
    if (elapsed < CPU_SAMPLE_INTERVAL_MS) return this.value;

    const totals = this.readTotals();
    if (elapsed > CPU_WINDOW_MS || totals.total < latest.totals.total || totals.idle < latest.totals.idle) {
      this.samples = [{ at, totals }];
      this.value = null;
      return this.value;
    }

    this.samples.push({ at, totals });
    const cutoff = at - CPU_WINDOW_MS;
    while (this.samples.length > 1 && this.samples[1]!.at <= cutoff) this.samples.shift();
    this.value = calculateCpuPercent(this.samples[0]!.totals, totals);
    return this.value;
  }
}

const cpuUsage = new CpuUsageWindow();
const cpuSampler = setInterval(() => cpuUsage.read(), CPU_SAMPLE_INTERVAL_MS);
cpuSampler.unref();

export function parseGpuPercent(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function readGpuPercent(): number | null {
  gpuBusyPercentPath ??= findGpuBusyPercentPath();
  if (!gpuBusyPercentPath) return null;
  try {
    // AMD's kernel-reported engine busy time, not allocated VRAM.
    return parseGpuPercent(readFileSync(gpuBusyPercentPath, "utf8"));
  } catch {
    gpuBusyPercentPath = null;
    return null;
  }
}

export function parseLinuxAvailableMemoryBytes(meminfo: string): number | null {
  const kibibytes = /^MemAvailable:\s+(\d+)\s+kB$/mu.exec(meminfo)?.[1];
  if (!kibibytes) return null;
  const bytes = Number(kibibytes) * 1_024;
  return Number.isSafeInteger(bytes) ? bytes : null;
}

function readAvailableMemoryBytes(): number {
  if (platform() !== "linux") return freemem();
  const available = parseLinuxAvailableMemoryBytes(readFileSync(LINUX_MEMINFO_PATH, "utf8"));
  if (available === null) throw new Error(`${LINUX_MEMINFO_PATH} does not report MemAvailable`);
  return available;
}

export function readMachineUsage(): MachineUsageSnapshot {
  const cpuPercent = cpuUsage.read();
  const gpuPercent = readGpuPercent();
  const memoryTotal = totalmem();
  const memoryUsed = Math.max(0, memoryTotal - readAvailableMemoryBytes());
  let disk: MachineUsageSnapshot["disk"] = null;
  try {
    const stats = statfsSync(homedir());
    const totalBytes = stats.blocks * stats.bsize;
    const availableBytes = stats.bavail * stats.bsize;
    const usedBytes = Math.max(0, totalBytes - availableBytes);
    disk = { usedBytes, totalBytes, availableBytes, percentUsed: percent(usedBytes, totalBytes) };
  } catch {}

  return {
    cpuPercent,
    gpuPercent,
    memory: { usedBytes: memoryUsed, totalBytes: memoryTotal, percentUsed: percent(memoryUsed, memoryTotal) },
    disk,
  };
}
