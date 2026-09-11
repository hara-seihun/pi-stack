import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Includes sibling sessions' browsers and every constrained ancestor, not
// merely this Node process's heap. Unsupported hosts retain RSS/residency caps.
export function underMemoryPressure(read = path => readFileSync(path, 'utf8')) {
  try {
    const path = read('/proc/self/cgroup').split('\n').find(line => line.startsWith('0::'))?.slice(3);
    if (!path) return false;
    let directory = join('/sys/fs/cgroup', path);
    while (directory.startsWith('/sys/fs/cgroup')) {
      const max = Number(read(join(directory, 'memory.max')).trim());
      if (Number.isFinite(max) && max > 0 && Number(read(join(directory, 'memory.current'))) >= max * 0.8) return true;
      if (directory === '/sys/fs/cgroup') break;
      directory = dirname(directory);
    }
  } catch { /* no cgroup v2 memory controller on this host */ }
  return false;
}
