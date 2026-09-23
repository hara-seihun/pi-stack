import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Includes sibling sessions' browsers and every constrained ancestor, not
// merely this Node process's heap. Unsupported hosts retain RSS/residency caps.
export function underMemoryPressure(read: (path: string) => string = path => readFileSync(path, 'utf8')) {
  try {
    const path = read('/proc/self/cgroup').split('\n').find(line => line.startsWith('0::'))?.slice(3);
    if (!path) return false;
    let directory = join('/sys/fs/cgroup', path);
    while (directory.startsWith('/sys/fs/cgroup')) {
      const max = Number(read(join(directory, 'memory.max')).trim());
      let inactiveFile = 0;
      try { inactiveFile = Number(read(join(directory, 'memory.stat')).match(/^inactive_file\s+(\d+)$/m)?.[1] || 0); } catch {}
      // The kernel reclaims inactive file cache at the cgroup boundary. Counting
      // a large source-tree scan as resident agent memory would stall admission
      // indefinitely even after all its processes finished.
      const workingSet = Math.max(0, Number(read(join(directory, 'memory.current'))) - inactiveFile);
      if (Number.isFinite(max) && max > 0 && workingSet >= max * 0.8) return true;
      if (directory === '/sys/fs/cgroup') break;
      directory = dirname(directory);
    }
  } catch { /* no cgroup v2 memory controller on this host */ }
  return false;
}
